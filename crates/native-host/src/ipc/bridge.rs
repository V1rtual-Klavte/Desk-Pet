// ==========================================
// HostBridge：请求/响应配对、事件派发、控制优先队列与背压
// ==========================================
//
// 一个 `HostBridge` 绑定一代 Node（一次握手的两条连接）。职责：
//
// - **请求/响应配对**：Node → 宿主的业务命令（`method/args` 透传，按 requestId 回
//   Response；失败是结构化 `WireError`，不退化成字符串）；宿主 → Node 的 `call` 同理。
// - **事件派发**：Node → 宿主的事件进广播出口，带 producer epoch（scope）与单调 seq；
//   宿主 → Node 的事件经 [`HostBridge::publish_event`]（`EventSink` 实现的落点）。
// - **控制通道优先队列**：`cancel`/`shutdown`/owner 失效等控制帧走独立优先队列，
//   写循环用 biased select 先取优先队列 —— 图片/大 JSON 在二进制通道或普通队列里排队，
//   取消**不会**排在大数据后面（见 `run_control_writer`）。
// - **背压**：二进制通道按 `STREAM_CREDIT_BYTES` 记账，额度不足时等待（`CreditLedger`），
//   永不静默丢弃；控制队列有界，满了发送方等待。
// - **blob**：句柄由 `BlobRegistry` 校验 owner/scope；结果里超长字符串自动编码为 blob，
//   Node 侧物化回完整原值（应用层结果类型不缩水）；Node 上传的参数大字段在这里物化。
//
// 传输级方法（不走业务分派器）：`blob_read`、`blob_release`。
// 业务命令经 [`CommandDispatcher`] 分派；W2 未接线时如实回 `HOST_DISPATCH_UNAVAILABLE`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch, Mutex as AsyncMutex};

use super::blob::{self, BlobRegistry, WireBlobKind};
use super::protocol::{
    ClientHello, HostPlatform, RunScope, RuntimeMode, ServerWelcome, TransportLimits, WireError,
    BLOB_CHUNK_MAX_BYTES, CONTROL_FRAME_MAX_BYTES, STREAM_CREDIT_BYTES,
};
use super::transport::{
    self, BinaryChunk, ControlFrame, ControlPayload, CreditDirection, CreditLedger, FramePayload,
    FrameReadError, PeerStream,
};
use crate::error::{AppError, AppResult};

/// 桥的限额与队列配置。默认值直接取自 `protocol.rs` 的常量（不复制数字）。
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub control_frame_max_bytes: usize,
    pub blob_chunk_max_bytes: usize,
    pub stream_credit_bytes: usize,
    /// 控制通道普通队列容量（有界；满则发送方等待，不丢弃）。
    pub queue_capacity: usize,
    /// 二进制发送队列容量（块级）。
    pub binary_queue_capacity: usize,
    /// 宿主侧事件广播容量（慢消费者滞后时的事件在此之外由提交读模型兜底，见 W4）。
    pub event_broadcast_capacity: usize,
    /// 结果里超过该字节数的字符串自动编码为 blob（留出 JSON 信封余量）。
    pub inline_text_max_bytes: usize,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            control_frame_max_bytes: CONTROL_FRAME_MAX_BYTES,
            blob_chunk_max_bytes: BLOB_CHUNK_MAX_BYTES,
            stream_credit_bytes: STREAM_CREDIT_BYTES,
            queue_capacity: 1024,
            binary_queue_capacity: 32,
            event_broadcast_capacity: 4096,
            inline_text_max_bytes: CONTROL_FRAME_MAX_BYTES / 2,
        }
    }
}

impl BridgeConfig {
    /// 握手披露给 Node 的限额。
    pub fn limits(&self) -> TransportLimits {
        transport::limits_from_config(
            self.control_frame_max_bytes,
            self.blob_chunk_max_bytes,
            self.stream_credit_bytes,
        )
    }
}

// ==========================================
// 业务分派器
// ==========================================

/// 分派上下文。取消语义：**取消不回滚已提交写入**；分派器可轮询 `is_cancelled()`
/// 提前退出，桥对已取消请求立即回 `CANCELLED`，执行完的迟到结果被丢弃。
pub struct DispatchContext {
    pub request_id: u64,
    pub scope: RunScope,
    pub method: String,
    pub blobs: Arc<BlobRegistry>,
    cancelled: Arc<AtomicBool>,
}

impl DispatchContext {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 宿主命令分派器。在阻塞线程池上执行（SQLite/文件/to线程等待不阻塞 IPC 运行时）。
pub trait CommandDispatcher: Send + Sync + 'static {
    fn dispatch(&self, ctx: &DispatchContext, args: Value) -> AppResult<Value>;

    /// 是否已接线。未接线时桥统一回 `HOST_DISPATCH_UNAVAILABLE`，不伪造成功。
    fn is_wired(&self) -> bool {
        true
    }
}

/// W2 默认分派器：109 条命令由 W4 接入，这里如实报未接线。
pub struct UnavailableDispatcher;

impl CommandDispatcher for UnavailableDispatcher {
    fn dispatch(&self, _ctx: &DispatchContext, _args: Value) -> AppResult<Value> {
        Err(AppError::Other("宿主命令分派尚未接线（W4）".into()))
    }

    fn is_wired(&self) -> bool {
        false
    }
}

// ==========================================
// 事件与关停报告
// ==========================================

/// 收到的事件（Node → 宿主），带归属 scope 与生产者单调序号。
#[derive(Debug, Clone, PartialEq)]
pub struct EventEnvelope {
    pub event: String,
    pub seq: u64,
    pub payload: Value,
    pub scope: RunScope,
}

/// Node 对 `shutdown` 的 flush 真实报告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushReport {
    pub flushed: bool,
    pub pending: u64,
    pub detail: Option<String>,
}

// ==========================================
// 握手
// ==========================================

/// 握手时宿主对 Node 的期望。
#[derive(Debug, Clone)]
pub struct HelloExpectations {
    pub app_version: String,
    /// 随包 Node 的锁定版本（packaging/node-runtime.json）；不匹配即拒绝。
    /// 原生扩展 ABI 由「版本完全一致」蕴含（同一版本才有同一 NODE_MODULE_VERSION）。
    pub expected_node_version: String,
    /// 本次启动生成的一次性握手值。只经受控启动信息传入，不写日志。
    pub handshake_token: String,
    pub runtime_mode: RuntimeMode,
}

/// 在控制连接上完成 hello/welcome 握手。
///
/// 失败一律「尽力回 ProtocolError 帧后断开」，返回值只携带面向日志的说明
/// （**不含握手值**）。
pub async fn accept_control_handshake(
    control: &mut PeerStream,
    expect: &HelloExpectations,
    limits: TransportLimits,
    app_epoch: &str,
    node_epoch: u64,
) -> Result<ClientHello, HelloError> {
    let frame = transport::read_control_frame(control, limits.control_frame_max_bytes as usize)
        .await
        .map_err(|err| HelloError::new("HANDSHAKE_READ_FAILED", err.to_string()))?;
    let hello = match frame.payload {
        FramePayload::Control(ControlPayload::Hello { hello }) => hello,
        other => {
            return Err(HelloError::new(
                "HANDSHAKE_UNEXPECTED_FRAME",
                format!("第一条控制帧不是 hello：{other:?}"),
            ))
        }
    };
    if hello.protocol_version != super::protocol::PROTOCOL_VERSION {
        return Err(HelloError::new(
            "PROTOCOL_VERSION_MISMATCH",
            format!(
                "协议版本不一致：Node {}，宿主 {}",
                hello.protocol_version,
                super::protocol::PROTOCOL_VERSION
            ),
        ));
    }
    if !constant_time_eq(
        hello.handshake.as_bytes(),
        expect.handshake_token.as_bytes(),
    ) {
        return Err(HelloError::new("HANDSHAKE_REJECTED", "一次性握手值不匹配"));
    }
    if hello.node_version != expect.expected_node_version {
        return Err(HelloError::new(
            "NODE_VERSION_MISMATCH",
            format!(
                "Node 版本 {} 与随包锁定版本 {} 不一致（ABI 以版本一致为前提）",
                hello.node_version, expect.expected_node_version
            ),
        ));
    }

    let welcome = ServerWelcome {
        protocol_version: super::protocol::PROTOCOL_VERSION,
        app_epoch: app_epoch.to_string(),
        node_epoch,
        app_version: expect.app_version.clone(),
        runtime_mode: expect.runtime_mode,
        platform: HostPlatform::CURRENT,
        limits,
    };
    let welcome_frame = ControlFrame::control(ControlPayload::Welcome { welcome });
    if let Err(err) = transport::write_control_frame(
        control,
        &welcome_frame,
        limits.control_frame_max_bytes as usize,
    )
    .await
    {
        return Err(HelloError::new("WELCOME_WRITE_FAILED", err.to_string()));
    }
    Ok(hello)
}

/// 握手失败：带稳定错误码的说明（不含任何秘密值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloError {
    pub code: &'static str,
    pub message: String,
}

impl HelloError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HelloError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ==========================================
// HostBridge
// ==========================================

/// 桥的公开句柄（可克隆）。
#[derive(Clone)]
pub struct HostBridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    config: BridgeConfig,
    app_epoch: String,
    node_epoch: u64,
    blobs: Arc<BlobRegistry>,
    dispatcher: RwLock<Arc<dyn CommandDispatcher>>,
    control_tx: mpsc::Sender<Vec<u8>>,
    normal_tx: mpsc::Sender<Vec<u8>>,
    binary_tx: mpsc::Sender<BinaryJob>,
    pending: StdMutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, WireError>>>>,
    dispatches: StdMutex<HashMap<u64, Arc<AtomicBool>>>,
    next_request_id: AtomicU64,
    events: broadcast::Sender<EventEnvelope>,
    event_seq: AtomicU64,
    /// 关停闸门：false 时拒绝新请求（封新 admission）。
    admission_open: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    closed_tx: watch::Sender<bool>,
    closed_rx: watch::Receiver<bool>,
    credit_host_to_node: Arc<CreditLedger>,
    credit_node_to_host: Arc<CreditLedger>,
    /// 二进制发送串行化：每条方向同时只有一个传输在跑。
    blob_stream_lock: AsyncMutex<()>,
    upload: AsyncMutex<Option<UploadState>>,
    flush_report: StdMutex<Option<FlushReport>>,
    flush_notify: tokio::sync::Notify,
}

struct BinaryJob {
    offset: u64,
    last: bool,
    data: Vec<u8>,
}

struct UploadState {
    blob_id: String,
    declared: u64,
    received: u64,
    kind: WireBlobKind,
    scope: RunScope,
    buf: Vec<u8>,
}

impl HostBridge {
    /// 两条连接都已完成角色手续（控制已握手、二进制已鉴权）后建立桥。
    /// 必须在 Tokio runtime 上下文内调用（内部 spawn I/O 任务）。
    ///
    /// 分派器初始为 [`UnavailableDispatcher`]（未接线如实报错）。引导命令需要在
    /// Node 第一条请求到达前就绪的场景（宿主 bootstrap 的 `get_runtime_paths`）
    /// 用 [`HostBridge::start_with_dispatcher`]，避免请求与接线竞态。
    pub fn start(
        control: PeerStream,
        binary: PeerStream,
        config: BridgeConfig,
        app_epoch: String,
        node_epoch: u64,
        blobs: Arc<BlobRegistry>,
    ) -> HostBridge {
        Self::start_with_dispatcher(
            control,
            binary,
            config,
            app_epoch,
            node_epoch,
            blobs,
            Arc::new(UnavailableDispatcher),
        )
    }

    /// 同 [`HostBridge::start`]，但在 I/O 任务 spawn **之前**注入分派器：
    /// 桥一开始可服务，Node 握手后的第一条引导请求就不会撞上未接线默认值。
    pub fn start_with_dispatcher(
        control: PeerStream,
        binary: PeerStream,
        config: BridgeConfig,
        app_epoch: String,
        node_epoch: u64,
        blobs: Arc<BlobRegistry>,
        dispatcher: Arc<dyn CommandDispatcher>,
    ) -> HostBridge {
        let (control_read, control_write) = tokio::io::split(control);
        let (binary_read, binary_write) = tokio::io::split(binary);
        let (control_tx, control_rx) = mpsc::channel(config.queue_capacity);
        let (normal_tx, normal_rx) = mpsc::channel(config.queue_capacity);
        let (binary_tx, binary_rx) = mpsc::channel(config.binary_queue_capacity);
        let (events, _) = broadcast::channel(config.event_broadcast_capacity);
        let (closed_tx, closed_rx) = watch::channel(false);

        let inner = Arc::new(BridgeInner {
            config: config.clone(),
            app_epoch,
            node_epoch,
            blobs,
            dispatcher: RwLock::new(dispatcher),
            control_tx,
            normal_tx,
            binary_tx,
            pending: StdMutex::new(HashMap::new()),
            dispatches: StdMutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            events,
            event_seq: AtomicU64::new(0),
            admission_open: Arc::new(AtomicBool::new(true)),
            closed: Arc::new(AtomicBool::new(false)),
            closed_tx,
            closed_rx,
            credit_host_to_node: Arc::new(CreditLedger::new(config.stream_credit_bytes as u64)),
            credit_node_to_host: Arc::new(CreditLedger::new(config.stream_credit_bytes as u64)),
            blob_stream_lock: AsyncMutex::new(()),
            upload: AsyncMutex::new(None),
            flush_report: StdMutex::new(None),
            flush_notify: tokio::sync::Notify::new(),
        });

        // Node → 宿主事件路由：订阅本代际的事件广播（`subscribe_events` 的进程内
        // 消费者 —— W2 建通道时留下的空位）。订阅先于 I/O 任务启动，首个事件不漏。
        let bridge = HostBridge {
            inner: Arc::clone(&inner),
        };
        let router_events = bridge.subscribe_events();

        let weak = Arc::downgrade(&inner);
        let closed_for_writer = inner.closed_rx.clone();
        tokio::spawn(run_control_writer(
            control_write,
            control_rx,
            normal_rx,
            closed_for_writer,
        ));
        tokio::spawn(run_control_reader(control_read, weak.clone()));
        tokio::spawn(run_event_router(router_events));
        let closed_for_binary = inner.closed_rx.clone();
        tokio::spawn(run_binary_writer(
            binary_write,
            binary_rx,
            inner.credit_host_to_node.clone(),
            closed_for_binary,
            config.blob_chunk_max_bytes,
        ));
        tokio::spawn(run_binary_reader(
            binary_read,
            weak,
            config.blob_chunk_max_bytes,
        ));

        bridge
    }

    pub fn app_epoch(&self) -> &str {
        &self.inner.app_epoch
    }

    pub fn node_epoch(&self) -> u64 {
        self.inner.node_epoch
    }

    pub fn config(&self) -> &BridgeConfig {
        &self.inner.config
    }

    pub fn blobs(&self) -> &Arc<BlobRegistry> {
        &self.inner.blobs
    }

    pub fn default_scope(&self) -> RunScope {
        RunScope {
            app_epoch: self.inner.app_epoch.clone(),
            node_epoch: self.inner.node_epoch,
            ..Default::default()
        }
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    pub fn closed(&self) -> watch::Receiver<bool> {
        self.inner.closed_rx.clone()
    }

    /// 接线业务分派器（W4）。
    pub fn set_dispatcher(&self, dispatcher: Arc<dyn CommandDispatcher>) {
        *self
            .inner
            .dispatcher
            .write()
            .unwrap_or_else(|e| e.into_inner()) = dispatcher;
    }

    /// 封新 admission（关停序列第 1 步）：新请求一律回 `SHUTTING_DOWN`。
    pub fn close_admission(&self) {
        self.inner.admission_open.store(false, Ordering::SeqCst);
    }

    pub fn admission_open(&self) -> bool {
        self.inner.admission_open.load(Ordering::SeqCst)
    }

    /// 宿主 → Node 的请求。`deadline` 到点即发 cancel 并回 `TIMEOUT`（不静默等待）。
    pub async fn call(
        &self,
        method: &str,
        args: Value,
        scope: Option<RunScope>,
        deadline: Option<Duration>,
    ) -> AppResult<Value> {
        if self.is_closed() {
            return Err(AppError::Other("HostBridge 已断开".into()));
        }
        if !self.admission_open() {
            return Err(AppError::Other("宿主正在关停，拒绝新请求".into()));
        }
        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, tx);
        let frame = ControlFrame::request(request_id, scope, method, args);
        if let Err(err) = self.inner.send_normal_frame(frame).await {
            self.inner
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            return Err(err);
        }
        let wait = async {
            match rx.await {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(wire)) => Err(AppError::Remote {
                    code: wire.code,
                    message: wire.message,
                }),
                Err(_recv) => Err(AppError::Other("HostBridge 已断开".into())),
            }
        };
        match deadline {
            Some(limit) => match tokio::time::timeout(limit, wait).await {
                Ok(result) => result,
                Err(_) => {
                    self.inner
                        .pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&request_id);
                    // 取消同样走控制优先队列。
                    let _ = self
                        .inner
                        .send_control_frame(ControlFrame::control(ControlPayload::Cancel {
                            request_id,
                        }))
                        .await;
                    Err(AppError::Timeout)
                }
            },
            None => wait.await,
        }
    }

    /// 宿主 → Node 的事件（`EventSink` 的落点）。同步投递：优先保证不阻塞调用线程
    /// （光标 60fps）；普通队列满时返回错误由调用方留痕，绝不静默丢还在假装成功。
    pub fn publish_event(&self, event: &str, payload: Value, scope: RunScope) -> AppResult<()> {
        if self.is_closed() {
            return Err(AppError::Other("HostBridge 已断开".into()));
        }
        let seq = self.inner.event_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = ControlFrame::event(scope, event, seq, payload);
        let bytes =
            transport::encode_control_frame(&frame, self.inner.config.control_frame_max_bytes)?;
        match self.inner.normal_tx.try_send(bytes) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                Err(AppError::Other("控制通道写队列已满，事件未投递".into()))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(AppError::Other("HostBridge 已断开".into()))
            }
        }
    }

    /// 订阅 Node → 宿主的事件（含旧代际丢弃后的存活事件）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.events.subscribe()
    }

    /// 关停序列：请求 Node 停止收新工作并在期限内 flush 后退出。
    pub async fn request_shutdown(&self, reason: &str, flush_deadline: Duration) -> AppResult<()> {
        self.close_admission();
        self.inner
            .send_control_frame(ControlFrame::control(ControlPayload::Shutdown {
                reason: reason.to_string(),
                flush_deadline_ms: flush_deadline.as_millis() as u64,
            }))
            .await
    }

    /// 等 Node 的 flush 报告（loud 超时：返回 None 表示期限内没有报告）。
    pub async fn wait_flush_report(&self, deadline: Duration) -> Option<FlushReport> {
        if let Some(report) = self
            .inner
            .flush_report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Some(report);
        }
        let mut closed = self.inner.closed_rx.clone();
        if *closed.borrow() {
            return None;
        }
        tokio::select! {
            _ = tokio::time::timeout(deadline, self.inner.flush_notify.notified()) => {}
            _ = closed.changed() => {}
        }
        self.inner
            .flush_report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 本地关闭（不等待对端）：唤醒等待者、失败 pending、让写端关闭 socket。
    pub fn close_local(&self, reason: &str) {
        self.inner.close_local(reason);
    }
}

impl BridgeInner {
    async fn send_normal_frame(&self, frame: ControlFrame) -> AppResult<()> {
        let bytes = transport::encode_control_frame(&frame, self.config.control_frame_max_bytes)?;
        self.normal_tx
            .send(bytes)
            .await
            .map_err(|_| AppError::Other("控制通道已关闭".into()))
    }

    async fn send_control_frame(&self, frame: ControlFrame) -> AppResult<()> {
        let bytes = transport::encode_control_frame(&frame, self.config.control_frame_max_bytes)?;
        self.control_tx
            .send(bytes)
            .await
            .map_err(|_| AppError::Other("控制通道已关闭".into()))
    }

    fn close_local(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        crate::rust_warn!("HostBridge 本地关闭: {reason}");
        let _ = self.closed_tx.send(true);
        self.credit_host_to_node.wake_all();
        self.credit_node_to_host.wake_all();
        let pending: Vec<_> = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in pending {
            let _ = tx.send(Err(WireError {
                code: "DISCONNECTED".into(),
                message: "HostBridge 已关闭".into(),
            }));
        }
    }

    fn on_disconnect(&self, reason: String, clean: bool) {
        if clean {
            crate::rust_info!("HostBridge 控制连接关闭: {reason}");
        } else {
            crate::rust_warn!("HostBridge 控制连接异常: {reason}");
        }
        self.close_local(&reason);
    }

    fn scope_current(&self, scope: &RunScope) -> bool {
        scope.app_epoch == self.app_epoch && scope.node_epoch == self.node_epoch
    }

    fn is_request_cancelled(&self, request_id: u64) -> bool {
        match self
            .dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&request_id)
        {
            None => true,
            Some(flag) => flag.load(Ordering::SeqCst),
        }
    }

    async fn respond_ok(&self, request_id: u64, result: Value) {
        let frame = ControlFrame::ok(request_id, result);
        match transport::encode_control_frame(&frame, self.config.control_frame_max_bytes) {
            Ok(bytes) => {
                let _ = self.normal_tx.send(bytes).await;
            }
            Err(err) => {
                // 只可能是超长/序列化失败：如实回结构化错误，绝不截断或沉默。
                self.respond_wire(
                    request_id,
                    WireError {
                        code: "RESULT_TOO_LARGE".into(),
                        message: err.to_string(),
                    },
                )
                .await;
            }
        }
    }

    async fn respond_err(&self, request_id: u64, code: &str, message: impl Into<String>) {
        self.respond_wire(
            request_id,
            WireError {
                code: code.to_string(),
                message: message.into(),
            },
        )
        .await;
    }

    async fn respond_app_err(&self, request_id: u64, err: &AppError) {
        self.respond_wire(
            request_id,
            WireError {
                code: err.code().to_string(),
                message: err.to_string(),
            },
        )
        .await;
    }

    async fn respond_wire(&self, request_id: u64, error: WireError) {
        let frame = ControlFrame::err(request_id, error);
        if let Ok(bytes) =
            transport::encode_control_frame(&frame, self.config.control_frame_max_bytes)
        {
            let _ = self.normal_tx.send(bytes).await;
        }
    }

    async fn protocol_error(&self, message: impl Into<String>) {
        let message = message.into();
        crate::rust_warn!("协议违规: {message}");
        let _ = self
            .send_control_frame(ControlFrame::control(ControlPayload::ProtocolError {
                error: WireError {
                    code: "PROTOCOL_VIOLATION".into(),
                    message,
                },
            }))
            .await;
        self.close_local("协议违规");
    }

    // ── 帧总入口 ──

    async fn handle_frame(self: &Arc<Self>, frame: ControlFrame) {
        let request_id = frame.header.request_id;
        let scope = frame.header.scope.clone();
        match frame.payload {
            FramePayload::Request(request) => match request_id {
                Some(id) => self.handle_request(id, scope, request).await,
                None => self.protocol_error("Request 帧缺少 requestId").await,
            },
            FramePayload::Response(response) => match request_id {
                Some(id) => self.complete_pending(id, response),
                None => self.protocol_error("Response 帧缺少 requestId").await,
            },
            FramePayload::Event(event) => {
                let scope = scope.unwrap_or_else(|| self.default_scope());
                self.dispatch_event(scope, event);
            }
            FramePayload::Control(payload) => self.handle_control(scope, payload).await,
        }
    }

    fn complete_pending(&self, request_id: u64, response: super::transport::ResponsePayload) {
        let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request_id)
        else {
            crate::rust_warn!("收到无对应请求的响应: requestId={request_id}");
            return;
        };
        let outcome = if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response.error.unwrap_or(WireError {
                code: "UNKNOWN".into(),
                message: "对端返回了无错误说明的失败".into(),
            }))
        };
        let _ = tx.send(outcome);
    }

    fn dispatch_event(&self, scope: RunScope, event: super::transport::EventPayload) {
        if !self.scope_current(&scope) {
            crate::rust_debug!(
                "丢弃旧代际事件: {} app={} node={}",
                event.event,
                scope.app_epoch,
                scope.node_epoch
            );
            return;
        }
        let envelope = EventEnvelope {
            event: event.event,
            seq: event.seq,
            payload: event.payload,
            scope,
        };
        // 消费侧是 `run_event_router`（本代际随桥启动，路由进聊天域）；广播失败
        // （无接收者）不再是正常态，但不阻断事件读取循环 —— 留 debug 便于排查。
        if self.events.send(envelope).is_err() {
            crate::rust_debug!("事件广播无接收者（路由任务未就绪或已退出）");
        }
    }

    // ── 请求处理 ──

    async fn handle_request(
        self: &Arc<Self>,
        request_id: u64,
        scope: Option<RunScope>,
        request: super::transport::RequestPayload,
    ) {
        let scope = scope.unwrap_or_else(|| self.default_scope());
        if !self.scope_current(&scope) {
            self.respond_err(
                request_id,
                "SCOPE_STALE",
                format!(
                    "请求归属与当前代际不一致（请求 app={} node={}，当前 node={}）",
                    scope.app_epoch, scope.node_epoch, self.node_epoch
                ),
            )
            .await;
            return;
        }
        if !self.admission_open.load(Ordering::SeqCst) {
            self.respond_err(request_id, "SHUTTING_DOWN", "宿主正在关停，拒绝新请求")
                .await;
            return;
        }
        match request.method.as_str() {
            // 传输级方法：不进业务分派器。
            "blob_read" => self.handle_blob_read(request_id, scope, request.args).await,
            "blob_release" => {
                let released = request
                    .args
                    .get("blobId")
                    .and_then(|v| v.as_str())
                    .map(|id| self.blobs.release(id))
                    .unwrap_or(false);
                self.respond_ok(request_id, json!({ "released": released }))
                    .await;
            }
            _ => {
                self.handle_dispatch(request_id, scope, request.method, request.args)
                    .await
            }
        }
    }

    async fn handle_dispatch(
        self: &Arc<Self>,
        request_id: u64,
        scope: RunScope,
        method: String,
        args: Value,
    ) {
        let dispatcher = self
            .dispatcher
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !dispatcher.is_wired() {
            self.respond_err(
                request_id,
                "HOST_DISPATCH_UNAVAILABLE",
                format!("宿主命令分派尚未接线（W4）：{method}"),
            )
            .await;
            return;
        }
        let args = match self.materialize_args(&scope, args) {
            Ok(args) => args,
            Err(err) => {
                self.respond_app_err(request_id, &err).await;
                return;
            }
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        self.dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, cancelled.clone());
        let ctx = DispatchContext {
            request_id,
            scope: scope.clone(),
            method,
            blobs: self.blobs.clone(),
            cancelled,
        };
        // 分派在独立任务里等待完成：控制读循环必须继续消费 cancel/shutdown。
        let inner = self.clone();
        tokio::spawn(async move {
            let joined = tokio::task::spawn_blocking(move || dispatcher.dispatch(&ctx, args)).await;
            // 取消时取消处理器已回 CANCELLED 并移除了登记；此处无登记表示结果应丢弃。
            let still_tracked = inner
                .dispatches
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id)
                .is_some();
            if !still_tracked {
                return;
            }
            match joined {
                Ok(Ok(value)) => match inner.encode_result_for_wire(&scope, value) {
                    Ok(encoded) => inner.respond_ok(request_id, encoded).await,
                    Err(err) => inner.respond_app_err(request_id, &err).await,
                },
                Ok(Err(err)) => inner.respond_app_err(request_id, &err).await,
                Err(join_err) => {
                    inner
                        .respond_err(
                            request_id,
                            "DISPATCH_TASK_FAILED",
                            format!("分派任务失败: {join_err}"),
                        )
                        .await
                }
            }
        });
    }

    /// 参数物化：把 `$wireBlob` 标记还原成完整原值（文本→字符串，字节→数字数组）。
    /// 上传句柄一次性取走。
    fn materialize_args(&self, scope: &RunScope, value: Value) -> AppResult<Value> {
        if let Some(marker) = blob::parse_upload_marker(&value) {
            let (bytes, kind) = self.blobs.take_upload(&marker.id, scope)?;
            return match kind {
                WireBlobKind::Text => String::from_utf8(bytes.to_vec())
                    .map(Value::String)
                    .map_err(|_| AppError::Other("文本上传不是合法 UTF-8".into())),
                WireBlobKind::Bytes => Ok(Value::Array(
                    bytes.iter().map(|b| Value::from(*b)).collect(),
                )),
            };
        }
        match value {
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.materialize_args(scope, item)?);
                }
                Ok(Value::Array(out))
            }
            Value::Object(map) => {
                let mut out = serde_json::Map::with_capacity(map.len());
                for (key, item) in map {
                    out.insert(key, self.materialize_args(scope, item)?);
                }
                Ok(Value::Object(out))
            }
            other => Ok(other),
        }
    }

    /// 结果编码：超长字符串登记为 blob，Node 侧物化回原值（result 类型不缩水）。
    fn encode_result_for_wire(&self, scope: &RunScope, value: Value) -> AppResult<Value> {
        match value {
            Value::String(text) if text.len() > self.config.inline_text_max_bytes => {
                let blob = self
                    .blobs
                    .issue_host_blob(scope.clone(), text.into_bytes(), None)?;
                Ok(blob::host_text_blob_marker(&blob))
            }
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.encode_result_for_wire(scope, item)?);
                }
                Ok(Value::Array(out))
            }
            Value::Object(map) => {
                let mut out = serde_json::Map::with_capacity(map.len());
                for (key, item) in map {
                    out.insert(key, self.encode_result_for_wire(scope, item)?);
                }
                Ok(Value::Object(out))
            }
            other => Ok(other),
        }
    }

    // ── blob 读取（宿主 → Node）──

    async fn handle_blob_read(self: &Arc<Self>, request_id: u64, scope: RunScope, args: Value) {
        let Some(blob_id) = args
            .get("blobId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            self.respond_err(request_id, "BLOB_ARGS_INVALID", "blob_read 缺少 blobId")
                .await;
            return;
        };
        let data = match self.blobs.open_read(&blob_id, &scope) {
            Ok(data) => data,
            Err(err) => {
                // 句柄不存在/scope 失效：按业务错误码回，句柄已在注册表侧归还。
                self.respond_err(request_id, err.code().as_ref(), err.to_string())
                    .await;
                return;
            }
        };
        // 先确认长度，再流块；中途失败用 BlobAbort 通知（Node 据此拒绝本次读取）。
        self.respond_ok(request_id, json!({ "bytes": data.len() }))
            .await;

        let cancelled = Arc::new(AtomicBool::new(false));
        self.dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, cancelled);
        let inner = self.clone();
        tokio::spawn(async move {
            // 一次只跑一个 blob 传输（每条方向）；Node 侧也串行发起 readBlob。
            let _serial = inner.blob_stream_lock.lock().await;
            let chunk_max = inner.config.blob_chunk_max_bytes;
            let mut offset = 0usize;
            loop {
                let end = (offset + chunk_max).min(data.len());
                let last = end == data.len();
                let slice = &data[offset..end];
                // 信用只在唯一的写循环（run_binary_writer）里记一次账：生产侧只做
                // 取消检查，超出信用的部分由有界 binary_tx 队列阻住生产。
                if inner.is_request_cancelled(request_id) || inner.closed.load(Ordering::SeqCst) {
                    let _ = inner
                        .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                            blob_id: blob_id.clone(),
                            error: WireError {
                                code: "CANCELLED".into(),
                                message: "读取已取消".into(),
                            },
                        }))
                        .await;
                    inner.blobs.release(&blob_id);
                    inner
                        .dispatches
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&request_id);
                    return;
                }
                let job = BinaryJob {
                    offset: offset as u64,
                    last,
                    data: slice.to_vec(),
                };
                if inner.binary_tx.send(job).await.is_err() {
                    break;
                }
                offset = end;
                if last {
                    break;
                }
            }
            inner
                .dispatches
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
        });
    }

    // ── 控制帧 ──

    async fn handle_control(self: &Arc<Self>, scope: Option<RunScope>, payload: ControlPayload) {
        match payload {
            ControlPayload::Hello { .. } => self.protocol_error("握手中的 hello 重复出现").await,
            ControlPayload::Welcome { .. } => {
                crate::rust_warn!("收到不应由 Node 发送的 welcome");
            }
            ControlPayload::Cancel { request_id } => {
                // 取消先于迟到结果：移除登记并立刻回 CANCELLED。
                let cancelled = self
                    .dispatches
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&request_id);
                if let Some(flag) = cancelled {
                    flag.store(true, Ordering::SeqCst);
                    self.respond_err(request_id, "CANCELLED", "调用方已取消")
                        .await;
                }
            }
            ControlPayload::Credit { direction, bytes } => match direction {
                CreditDirection::HostToNode => self.credit_host_to_node.grant(bytes),
                CreditDirection::NodeToHost => self.credit_node_to_host.grant(bytes),
            },
            ControlPayload::BlobOpen {
                blob_id,
                bytes,
                kind,
            } => self.handle_blob_open(scope, blob_id, bytes, kind).await,
            ControlPayload::BlobReady { .. }
            | ControlPayload::BlobCommitted { .. }
            | ControlPayload::BlobAbort { .. } => {
                crate::rust_warn!("收到只应发往 Node 的 blob 控制帧");
            }
            ControlPayload::Shutdown { .. } => {
                // 宿主不是被监督方：如实回一份「未 flush」报告，不假装已被关停。
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::ShutdownFlush {
                        flushed: false,
                        pending: 0,
                        detail: Some("宿主不接受被 Node 关停".into()),
                    }))
                    .await;
            }
            ControlPayload::ShutdownFlush {
                flushed,
                pending,
                detail,
            } => {
                *self.flush_report.lock().unwrap_or_else(|e| e.into_inner()) = Some(FlushReport {
                    flushed,
                    pending,
                    detail,
                });
                self.flush_notify.notify_waiters();
            }
            ControlPayload::ScopeRevoked { .. } => {
                crate::rust_warn!("收到只应发往 Node 的 scopeRevoked");
            }
            ControlPayload::Ping => {
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::Pong))
                    .await;
            }
            ControlPayload::Pong => {}
            ControlPayload::ProtocolError { error } => {
                crate::rust_warn!("Node 报告协议错误: {} {}", error.code, error.message);
                self.close_local("对端协议错误");
            }
        }
    }

    async fn handle_blob_open(
        self: &Arc<Self>,
        scope: Option<RunScope>,
        blob_id: String,
        bytes: u64,
        kind: super::transport::BlobKind,
    ) {
        let scope = scope.unwrap_or_else(|| self.default_scope());
        let reject = |code: &str, message: String| ControlPayload::BlobAbort {
            blob_id: blob_id.clone(),
            error: WireError {
                code: code.into(),
                message,
            },
        };
        if !self.scope_current(&scope) {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "SCOPE_STALE",
                    "上传归属与当前代际不一致".into(),
                )))
                .await;
            return;
        }
        if !self.admission_open.load(Ordering::SeqCst) {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "SHUTTING_DOWN",
                    "宿主正在关停".into(),
                )))
                .await;
            return;
        }
        if bytes > blob::BLOB_MAX_BYTES {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "BLOB_TOO_LARGE",
                    format!("上传 {bytes} 字节超过单句柄上限 {}", blob::BLOB_MAX_BYTES),
                )))
                .await;
            return;
        }
        let mut upload = self.upload.lock().await;
        if upload.is_some() {
            drop(upload);
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "BLOB_BUSY",
                    "已有上传在进行".into(),
                )))
                .await;
            return;
        }
        *upload = Some(UploadState {
            blob_id: blob_id.clone(),
            declared: bytes,
            received: 0,
            kind: match kind {
                super::transport::BlobKind::Text => WireBlobKind::Text,
                super::transport::BlobKind::Bytes => WireBlobKind::Bytes,
            },
            scope,
            buf: Vec::with_capacity(bytes.min(4 * 1024 * 1024) as usize),
        });
        drop(upload);
        let _ = self
            .send_control_frame(ControlFrame::control(ControlPayload::BlobReady { blob_id }))
            .await;
    }

    /// 二进制通道收到的块：只可能是上传数据。归还信用后校验并累积。
    async fn handle_binary_chunk(self: &Arc<Self>, chunk: BinaryChunk) {
        // 收方消费即归还信用（等待而非丢弃的另一半）。
        let _ = self
            .send_control_frame(ControlFrame::control(ControlPayload::Credit {
                direction: CreditDirection::NodeToHost,
                bytes: chunk.data.len().max(1) as u64,
            }))
            .await;

        let mut upload = self.upload.lock().await;
        let Some(state) = upload.as_mut() else {
            drop(upload);
            self.protocol_error("收到无 blobOpen 公告的二进制块").await;
            return;
        };
        let mut abort: Option<WireError> = None;
        if chunk.offset != state.received {
            abort = Some(WireError {
                code: "BLOB_OFFSET_MISMATCH".into(),
                message: format!(
                    "块 offset {} 与已收 {} 不连续",
                    chunk.offset, state.received
                ),
            });
        } else if state.received + chunk.data.len() as u64 > state.declared {
            abort = Some(WireError {
                code: "BLOB_LENGTH_MISMATCH".into(),
                message: "块数据超过公告长度".into(),
            });
        } else {
            state.buf.extend_from_slice(&chunk.data);
            state.received += chunk.data.len() as u64;
        }
        let finished = abort.is_none() && chunk.last;
        if !finished {
            if let Some(error) = abort {
                let blob_id = state.blob_id.clone();
                *upload = None;
                drop(upload);
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                        blob_id,
                        error,
                    }))
                    .await;
            }
            return;
        }
        let state = upload.take().expect("上面已确认存在");
        drop(upload);
        if state.received != state.declared {
            let _ = self
                .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                    blob_id: state.blob_id,
                    error: WireError {
                        code: "BLOB_LENGTH_MISMATCH".into(),
                        message: format!("声明 {} 字节，实收 {}", state.declared, state.received),
                    },
                }))
                .await;
            return;
        }
        match self
            .blobs
            .register_upload(&state.blob_id, state.scope, state.buf, state.kind)
        {
            Ok(()) => {
                // 只有收到 committed，Node 才允许发引用该 id 的请求
                //（控制通道与二进制通道是两个任务，不保证跨通道先后）。
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobCommitted {
                        blob_id: state.blob_id,
                    }))
                    .await;
            }
            Err(err) => {
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                        blob_id: state.blob_id,
                        error: WireError {
                            code: "BLOB_REJECTED".into(),
                            message: err.to_string(),
                        },
                    }))
                    .await;
            }
        }
    }

    fn default_scope(&self) -> RunScope {
        RunScope {
            app_epoch: self.app_epoch.clone(),
            node_epoch: self.node_epoch,
            ..Default::default()
        }
    }
}

// ==========================================
// I/O 任务
// ==========================================

/// 控制通道写循环。**biased select 先取优先队列**：取消/关停/owner 失效不会被
/// 积压的普通帧（大 JSON 结果等）挡住；图片字节根本不在这个通道上。
async fn run_control_writer<W: AsyncWrite + Unpin>(
    mut out: W,
    mut control_rx: mpsc::Receiver<Vec<u8>>,
    mut normal_rx: mpsc::Receiver<Vec<u8>>,
    mut closed: watch::Receiver<bool>,
) {
    let mut control_done = false;
    let mut normal_done = false;
    loop {
        if *closed.borrow() {
            break;
        }
        tokio::select! {
            biased;
            message = control_rx.recv(), if !control_done => match message {
                Some(bytes) => { if out.write_all(&bytes).await.is_err() { break; } }
                None => control_done = true,
            },
            message = normal_rx.recv(), if !normal_done => match message {
                Some(bytes) => { if out.write_all(&bytes).await.is_err() { break; } }
                None => normal_done = true,
            },
            _ = closed.changed() => {},
            else => break,
        }
        if control_done && normal_done {
            break;
        }
    }
    let _ = out.shutdown().await;
}

async fn run_control_reader<R: AsyncRead + Unpin>(mut input: R, weak: Weak<BridgeInner>) {
    loop {
        let Some(inner) = weak.upgrade() else { break };
        match transport::read_control_frame(&mut input, inner.config.control_frame_max_bytes).await
        {
            Ok(frame) => inner.handle_frame(frame).await,
            Err(err) => {
                if err.is_disconnect() {
                    inner.on_disconnect(err.to_string(), matches!(err, FrameReadError::Closed));
                } else {
                    // 超长/坏帧：明确报错并关闭，不截断、不猜测。
                    inner
                        .protocol_error(format!("{}: {}", err.code(), err))
                        .await;
                }
                break;
            }
        }
    }
}

async fn run_binary_writer<W: AsyncWrite + Unpin>(
    mut out: W,
    mut rx: mpsc::Receiver<BinaryJob>,
    credit: Arc<CreditLedger>,
    closed: watch::Receiver<bool>,
    chunk_max: usize,
) {
    while let Some(job) = rx.recv().await {
        if *closed.borrow() {
            break;
        }
        if !credit
            .acquire_or_closed(job.data.len() as u64, &closed)
            .await
        {
            break;
        }
        if transport::write_binary_chunk(&mut out, job.offset, job.last, &job.data, chunk_max)
            .await
            .is_err()
        {
            break;
        }
    }
    let _ = out.shutdown().await;
}

async fn run_binary_reader<R: AsyncRead + Unpin>(
    mut input: R,
    weak: Weak<BridgeInner>,
    chunk_max: usize,
) {
    loop {
        let Some(inner) = weak.upgrade() else { break };
        match transport::read_binary_chunk(&mut input, chunk_max).await {
            Ok(chunk) => inner.handle_binary_chunk(chunk).await,
            Err(err) => {
                if !err.is_disconnect() {
                    crate::rust_warn!("二进制通道协议错误: {}", err);
                }
                break;
            }
        }
    }
}

/// Node → 宿主事件的广播消费侧（`HostBridge::subscribe_events` 的进程内订阅者）。
///
/// 每个桥代际一个任务：订阅事件广播（`dispatch_event` 已按 scope 丢弃旧代际事件，
/// 这里只会收到当前代际的），按事件名路由进聊天域
/// （[`crate::ui::chat::ChatUi::route_wire_event`]：`ChatEvent::from_wire` →
/// `apply_event` —— 断链 D 的 `deskpet-reveal-progress` 与其余聊天事件共用这一条路）。
///
/// 任务只持广播接收端：桥释放 → 广播关闭 → 任务随 `Closed` 退出，不延长桥的生命周期。
/// 接收滞后（`Lagged`）如实留痕 —— 被丢掉多少条必须可见，不静默。
async fn run_event_router(mut events: broadcast::Receiver<EventEnvelope>) {
    loop {
        match events.recv().await {
            Ok(envelope) => {
                match crate::ui::chat::chat_ui()
                    .route_wire_event(&envelope.event, &envelope.payload)
                {
                    Ok(true) => {}
                    // 不属于聊天窗消费子集：Node → 宿主方向当前没有其它消费者
                    // （HostEventMap 与 NodeUiEventName 的差集只有宿主自己的生产事件），
                    // 不在此建空路由，只留调试线索。
                    Ok(false) => {
                        crate::rust_debug!("Node → 宿主事件没有消费子集: {}", envelope.event)
                    }
                    Err(error) => {
                        crate::rust_warn!("Node → 宿主事件路由失败: {}（{error}）", envelope.event)
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                crate::rust_warn!(
                    "Node → 宿主事件路由滞后，丢弃了 {skipped} 条事件（事件通道容量不足）"
                );
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

// ==========================================
// EventSink 实现：宿主事件 → Node
// ==========================================

/// `window-observed` 的线载荷：camelCase，未知身份为 null；这里是唯一定义点。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowObservedWire {
    app_id: Option<String>,
    app: Option<String>,
    title: Option<String>,
    observed_at: i64,
    sample_mono_ms: i64,
    monitor_generation: u64,
    sequence: u64,
    observation_state: String,
    idle_for_ms: Option<i64>,
    is_pet_visible: bool,
    is_pet_foreground: bool,
}

/// 把宿主事件经桥推给 Node（`subscribe` 的另一端）。
pub struct BridgeEventSink {
    bridge: HostBridge,
    scope: RunScope,
}

impl BridgeEventSink {
    pub fn new(bridge: HostBridge, scope: RunScope) -> Self {
        Self { bridge, scope }
    }
}

impl crate::host::EventSink for BridgeEventSink {
    fn emit(&self, event: crate::host::HostEvent) {
        let (name, payload) = match event {
            crate::host::HostEvent::CursorMoved(position) => (
                "deskpet-cursor-move",
                serde_json::to_value(position).unwrap_or(Value::Null),
            ),
            crate::host::HostEvent::WindowObserved(observation) => {
                let payload = WindowObservedWire {
                    app_id: unknown_to_null(observation.app_id),
                    app: unknown_to_null(observation.app),
                    title: unknown_to_null(observation.title),
                    observed_at: observation.observed_at,
                    sample_mono_ms: observation.sample_mono_ms,
                    monitor_generation: observation.monitor_generation,
                    sequence: observation.sequence,
                    observation_state: observation.observation_state,
                    idle_for_ms: observation.idle_for_ms,
                    is_pet_visible: observation.is_pet_visible,
                    is_pet_foreground: observation.is_pet_foreground,
                };
                (
                    "window-observed",
                    serde_json::to_value(payload).unwrap_or(Value::Null),
                )
            }
        };
        if let Err(err) = self.bridge.publish_event(name, payload, self.scope.clone()) {
            crate::rust_warn!("{name} 事件投递失败: {err}");
        }
    }
}

fn unknown_to_null(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

// ==========================================
// 测试
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::{HostBlobRef, RuntimeMode, PROTOCOL_VERSION};
    use crate::ipc::transport::test_peer;

    struct VecWriter(Arc<StdMutex<Vec<u8>>>, Arc<tokio::sync::Notify>);

    impl AsyncWrite for VecWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend_from_slice(buf);
            self.1.notify_waiters();
            std::task::Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn 控制帧优先于积压的普通帧() {
        let (control_tx, control_rx) = mpsc::channel(4);
        let (normal_tx, normal_rx) = mpsc::channel(8);
        for _ in 0..8 {
            normal_tx.send(vec![b'N']).await.unwrap();
        }
        control_tx.send(vec![b'C']).await.unwrap();

        let captured = Arc::new(StdMutex::new(Vec::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (_closed_tx, closed_rx) = watch::channel(false);
        let writer = VecWriter(captured.clone(), notify.clone());
        tokio::spawn(run_control_writer(writer, control_rx, normal_rx, closed_rx));

        // 等 9 个字节全部写出。
        loop {
            if captured.lock().unwrap_or_else(|e| e.into_inner()).len() >= 9 {
                break;
            }
            let waiter = notify.notified();
            tokio::time::timeout(Duration::from_secs(2), waiter)
                .await
                .ok();
            if captured.lock().unwrap_or_else(|e| e.into_inner()).len() >= 9 {
                break;
            }
        }
        let out = captured.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert_eq!(out.len(), 9);
        assert_eq!(out[0], b'C', "控制帧必须先写出（biased 优先队列）");
        assert!(out[1..].iter().all(|b| *b == b'N'));
    }

    /// 端到端：真实端点 + 假 Node 客户端 + 真桥。
    struct Harness {
        endpoint: Arc<transport::Endpoint>,
        bridge: HostBridge,
        expect: HelloExpectations,
        control: PeerStream,
        binary: PeerStream,
    }

    async fn setup(
        app_epoch: &str,
        node_epoch: u64,
        dispatcher: Arc<dyn CommandDispatcher>,
    ) -> Harness {
        let endpoint = Arc::new(transport::Endpoint::create().unwrap());
        let address = endpoint.address().to_string();
        let expect = HelloExpectations {
            app_version: "0.16.0".into(),
            expected_node_version: "22.22.3".into(),
            handshake_token: "tok".into(),
            runtime_mode: RuntimeMode::Development,
        };

        // 客户端控制连接 + hello
        let mut control_client = test_peer::connect_control(&address).await.unwrap();
        let hello = ClientHello {
            protocol_version: PROTOCOL_VERSION,
            handshake: "tok".into(),
            node_version: "22.22.3".into(),
        };
        transport::write_control_frame(
            &mut control_client,
            &ControlFrame::control(ControlPayload::Hello { hello }),
            64 * 1024,
        )
        .await
        .unwrap();

        let mut control_server = endpoint.accept_control().await.unwrap();
        let _hello = accept_control_handshake(
            &mut control_server,
            &expect,
            BridgeConfig::default().limits(),
            app_epoch,
            node_epoch,
        )
        .await
        .unwrap();

        // 二进制连接
        let acceptor = endpoint.clone();
        let token = "tok".to_string();
        let accept_task = tokio::spawn(async move { acceptor.accept_binary(&token).await });
        let (binary_client, status) = test_peer::connect_binary(&address, "tok").await.unwrap();
        assert_eq!(status, transport::HANDSHAKE_OK);
        let binary_server = accept_task.await.unwrap().unwrap();

        let bridge = HostBridge::start(
            control_server,
            binary_server,
            BridgeConfig::default(),
            app_epoch.to_string(),
            node_epoch,
            Arc::new(BlobRegistry::new()),
        );
        bridge.set_dispatcher(dispatcher);

        // 客户端读 welcome（握手完成的凭据）
        let welcome = transport::read_control_frame(&mut control_client, 64 * 1024)
            .await
            .unwrap();
        match welcome.payload {
            FramePayload::Control(ControlPayload::Welcome { welcome }) => {
                assert_eq!(welcome.app_epoch, app_epoch);
                assert_eq!(welcome.node_epoch, node_epoch);
            }
            other => panic!("期望 welcome，得到 {other:?}"),
        }

        Harness {
            endpoint,
            bridge,
            expect,
            control: control_client,
            binary: binary_client,
        }
    }

    async fn request(
        control: &mut PeerStream,
        request_id: u64,
        scope: Option<RunScope>,
        method: &str,
        args: Value,
    ) {
        transport::write_control_frame(
            control,
            &ControlFrame::request(request_id, scope, method, args),
            64 * 1024,
        )
        .await
        .unwrap();
    }

    async fn read_response(control: &mut PeerStream) -> super::super::transport::ResponsePayload {
        loop {
            let frame = transport::read_control_frame(control, 64 * 1024)
                .await
                .unwrap();
            if let FramePayload::Response(response) = frame.payload {
                return response;
            }
        }
    }

    struct EchoDispatcher;

    impl CommandDispatcher for EchoDispatcher {
        fn dispatch(&self, _ctx: &DispatchContext, args: Value) -> AppResult<Value> {
            Ok(args)
        }
    }

    struct BigTextDispatcher;

    impl CommandDispatcher for BigTextDispatcher {
        fn dispatch(&self, _ctx: &DispatchContext, _args: Value) -> AppResult<Value> {
            Ok(json!({ "content": "长".repeat(200 * 1024 / 3 + 10) }))
        }
    }

    struct SlowDispatcher;

    impl CommandDispatcher for SlowDispatcher {
        fn dispatch(&self, ctx: &DispatchContext, _args: Value) -> AppResult<Value> {
            for _ in 0..200 {
                if ctx.is_cancelled() {
                    return Err(AppError::Cancelled);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(json!({"done": true}))
        }
    }

    #[tokio::test]
    async fn 请求响应往返与未接线命令如实报错() {
        let mut h = setup("boot-1", 0, Arc::new(UnavailableDispatcher)).await;
        request(&mut h.control, 1, None, "get_runtime_paths", json!({})).await;
        let response = read_response(&mut h.control).await;
        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().unwrap().code,
            "HOST_DISPATCH_UNAVAILABLE"
        );

        // 旧代际请求被拒（错误码稳定，供 Node 侧丢弃/重试判断）
        let stale = RunScope {
            app_epoch: "boot-1".into(),
            node_epoch: 99,
            ..Default::default()
        };
        request(
            &mut h.control,
            2,
            Some(stale),
            "get_runtime_paths",
            json!({}),
        )
        .await;
        let response = read_response(&mut h.control).await;
        assert_eq!(response.error.as_ref().unwrap().code, "SCOPE_STALE");

        // 接线后的回显
        h.bridge.set_dispatcher(Arc::new(EchoDispatcher));
        request(&mut h.control, 3, None, "echo", json!({"a": 1})).await;
        let response = read_response(&mut h.control).await;
        assert!(response.ok);
        assert_eq!(response.result.unwrap(), json!({"a": 1}));
        let _ = h.expect;
        let _ = (&h.endpoint, &h.binary);
    }

    #[tokio::test]
    async fn 超长结果自动编码为blob并经二进制通道读回() {
        let mut h = setup("boot-1", 0, Arc::new(BigTextDispatcher)).await;
        request(&mut h.control, 1, None, "read_runtime_config", json!({})).await;
        let response = read_response(&mut h.control).await;
        assert!(response.ok, "{response:?}");
        let result = response.result.unwrap();
        let marker = result.get("content").expect("content 字段");
        let blob_ref: HostBlobRef = blob::parse_host_blob_marker(marker).expect("自动 blob 标记");
        assert!(blob_ref.bytes > 64 * 1024, "超长字符串必须被编码为 blob");

        // Node 侧物化：blob_read → ok(bytes) → 二进制块（account credit 归还）
        request(
            &mut h.control,
            2,
            None,
            "blob_read",
            json!({"blobId": blob_ref.id}),
        )
        .await;
        let response = read_response(&mut h.control).await;
        assert!(response.ok, "{response:?}");
        assert_eq!(response.result.unwrap()["bytes"], blob_ref.bytes);

        let mut collected: Vec<u8> = Vec::new();
        loop {
            let chunk = transport::read_binary_chunk(&mut h.binary, 64 * 1024)
                .await
                .unwrap();
            assert_eq!(chunk.offset, collected.len() as u64, "offset 连续");
            collected.extend_from_slice(&chunk.data);
            // 归还信用（等价于 Node 侧消费后 grant）
            h.credit_grant(chunk.data.len() as u64).await;
            if chunk.last {
                break;
            }
        }
        assert_eq!(collected.len() as u64, blob_ref.bytes);
        let text = String::from_utf8(collected).unwrap();
        assert!(text.starts_with('长'));

        // release 后句柄不可再读
        request(
            &mut h.control,
            3,
            None,
            "blob_release",
            json!({"blobId": blob_ref.id}),
        )
        .await;
        let _ = read_response(&mut h.control).await;
        request(
            &mut h.control,
            4,
            None,
            "blob_read",
            json!({"blobId": blob_ref.id}),
        )
        .await;
        let response = read_response(&mut h.control).await;
        assert!(!response.ok, "已归还的句柄不得再读");
    }

    impl Harness {
        async fn credit_grant(&mut self, bytes: u64) {
            transport::write_control_frame(
                &mut self.control,
                &ControlFrame::control(ControlPayload::Credit {
                    direction: CreditDirection::HostToNode,
                    bytes,
                }),
                64 * 1024,
            )
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn 上传标记在分派前被物化为完整原值() {
        let mut h = setup("boot-1", 0, Arc::new(EchoDispatcher)).await;
        // 公告 → 等 ready → 发块 → 请求引用
        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::control(ControlPayload::BlobOpen {
                blob_id: "up-1".into(),
                bytes: 5,
                kind: super::super::transport::BlobKind::Text,
            }),
            64 * 1024,
        )
        .await
        .unwrap();
        // 等 BlobReady（控制帧可能与其他帧交错）
        loop {
            let frame = transport::read_control_frame(&mut h.control, 64 * 1024)
                .await
                .unwrap();
            if let FramePayload::Control(ControlPayload::BlobReady { .. }) = frame.payload {
                break;
            }
        }
        transport::write_binary_chunk(&mut h.binary, 0, true, b"hello", 64 * 1024)
            .await
            .unwrap();
        // 归还信用帧会回来（NodeToHost），读走它们
        let marker = blob::upload_marker("up-1", WireBlobKind::Text);
        request(
            &mut h.control,
            1,
            None,
            "file_write",
            json!({"content": marker}),
        )
        .await;
        let response = read_response(&mut h.control).await;
        assert!(response.ok, "{response:?}");
        assert_eq!(
            response.result.unwrap()["content"],
            "hello",
            "上传必须物化回原字符串"
        );
    }

    #[tokio::test]
    async fn 取消先于迟到结果且不等在数据后面() {
        let mut h = setup("boot-1", 0, Arc::new(SlowDispatcher)).await;
        request(&mut h.control, 1, None, "bash_exec", json!({})).await;
        // 稍等分派开始后取消
        tokio::time::sleep(Duration::from_millis(30)).await;
        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::control(ControlPayload::Cancel { request_id: 1 }),
            64 * 1024,
        )
        .await
        .unwrap();
        let response = tokio::time::timeout(Duration::from_secs(1), read_response(&mut h.control))
            .await
            .expect("取消响应不得等待分派跑完");
        assert_eq!(response.error.as_ref().unwrap().code, "CANCELLED");
    }

    #[tokio::test]
    async fn 事件帧进广播且旧代际被丢弃() {
        let mut h = setup("boot-1", 0, Arc::new(EchoDispatcher)).await;
        // 订阅方 = 路由任务的同一入口（事件路由从这条广播消费）。
        let mut events = h.bridge.subscribe_events();

        // 当前代际事件：送达广播（名字、序号与载荷原样）。
        let scope = h.bridge.default_scope();
        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::event(
                scope,
                "tool-executing",
                7,
                json!({"toolId": "t1", "toolName": "bash"}),
            ),
            64 * 1024,
        )
        .await
        .unwrap();
        let envelope = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("期限内应收到事件")
            .expect("广播未关闭");
        assert_eq!(envelope.event, "tool-executing");
        assert_eq!(envelope.seq, 7);
        assert_eq!(
            envelope.payload,
            json!({"toolId": "t1", "toolName": "bash"})
        );

        // 旧代际事件：在 `dispatch_event` 按 scope 丢弃（契约 §4.1，旧 Node 的事件
        // 不得写新状态），不进入广播。
        let stale = RunScope {
            app_epoch: "boot-1".into(),
            node_epoch: 99,
            ..Default::default()
        };
        transport::write_control_frame(
            &mut h.control,
            &ControlFrame::event(stale, "tool-executing", 8, json!({})),
            64 * 1024,
        )
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), events.recv())
                .await
                .is_err(),
            "旧代际事件不得进广播"
        );
    }
}
