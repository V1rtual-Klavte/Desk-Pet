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
use std::sync::{Arc, Mutex as StdMutex, RwLock};

use serde_json::Value;
use tokio::sync::{broadcast, mpsc, watch, Mutex as AsyncMutex};

use super::blob::BlobRegistry;
use super::protocol::{
    ClientHello, HostPlatform, RunScope, RuntimeMode, ServerWelcome, TransportLimits, WireError,
    BLOB_CHUNK_MAX_BYTES, CONTROL_FRAME_MAX_BYTES, STREAM_CREDIT_BYTES,
};
use super::transport::{
    self, ControlFrame, ControlPayload, CreditLedger, FramePayload, PeerStream,
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

/// 关停分两阶段：停止宿主入口后，Node 仍须经原分派器完成已准入请求与持久化。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Admission {
    Open,
    Draining,
    Closed,
}

enum NormalFrame {
    Bytes(Vec<u8>),
    /// 关停前交付已准入普通帧；不改变取消等控制帧的优先级。
    Flush(tokio::sync::oneshot::Sender<()>),
}

struct BridgeInner {
    config: BridgeConfig,
    app_epoch: String,
    node_epoch: u64,
    blobs: Arc<BlobRegistry>,
    dispatcher: RwLock<Arc<dyn CommandDispatcher>>,
    control_tx: mpsc::Sender<Vec<u8>>,
    normal_tx: mpsc::Sender<NormalFrame>,
    binary_tx: mpsc::Sender<BinaryJob>,
    pending: StdMutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, WireError>>>>,
    dispatches: StdMutex<HashMap<u64, Arc<AtomicBool>>>,
    next_request_id: AtomicU64,
    events: broadcast::Sender<EventEnvelope>,
    event_seq: AtomicU64,
    /// 唯一 admission 状态；Draining 只保留 Node 收尾所需的入站 RPC。
    admission: StdMutex<Admission>,
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

mod binary;
mod events;
mod host;
#[cfg(test)]
mod tests;

use binary::{BinaryJob, UploadState};
pub use events::{BridgeEventSink, EventEnvelope};
