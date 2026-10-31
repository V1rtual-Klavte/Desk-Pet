//! 桥句柄与准入/队列/控制/请求分派：`HostBridge` 的公开方法、控制读循环与优先写循环。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch, Mutex as AsyncMutex};

use super::binary::{run_binary_reader, run_binary_writer};
use super::events::run_event_router;
use super::{
    Admission, BridgeConfig, BridgeInner, CommandDispatcher, DispatchContext, EventEnvelope,
    FlushReport, HostBridge, NormalFrame, UnavailableDispatcher,
};
use crate::error::{AppError, AppResult};
use crate::ipc::blob::{self, BlobRegistry};
use crate::ipc::protocol::{RunScope, WireError};
use crate::ipc::transport::{
    self, ControlFrame, ControlPayload, CreditDirection, CreditLedger, FramePayload,
    FrameReadError, PeerStream,
};

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
            admission: StdMutex::new(Admission::Open),
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

    /// 完全封闭 admission；Node 排空报告返回后不再接收任何新 RPC。
    pub fn close_admission(&self) {
        *self
            .inner
            .admission
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Admission::Closed;
    }

    pub fn admission_open(&self) -> bool {
        self.inner.admission_state() == Admission::Open
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
        if let Err(err) = self.inner.send_host_request_frame(frame).await {
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
        // 与关停边沿共用锁：已准入事件必须在排空屏障之前入队。
        let admission = self
            .inner
            .admission
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *admission != Admission::Open {
            return Err(AppError::Other("宿主正在关停，拒绝新事件".into()));
        }
        let seq = self.inner.event_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = ControlFrame::event(scope, event, seq, payload);
        let bytes =
            transport::encode_control_frame(&frame, self.inner.config.control_frame_max_bytes)?;
        match self.inner.normal_tx.try_send(NormalFrame::Bytes(bytes)) {
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
        {
            let mut admission = self
                .inner
                .admission
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match *admission {
                Admission::Open => *admission = Admission::Draining,
                Admission::Draining => return Ok(()),
                Admission::Closed => return Err(AppError::Other("宿主 admission 已关闭".into())),
            }
        }
        // 先交付普通队列中已准入请求，Node 才能将其纳入 handler drain。
        // 写端阻塞沿用 flush_deadline，超时如实失败，不跳过已准入工作。
        tokio::time::timeout(flush_deadline, self.inner.flush_normal_queue())
            .await
            .map_err(|_| AppError::Timeout)??;
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
    pub(super) fn admission_state(&self) -> Admission {
        *self.admission.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn send_host_request_frame(&self, frame: ControlFrame) -> AppResult<()> {
        let bytes = transport::encode_control_frame(&frame, self.config.control_frame_max_bytes)?;
        let permit = self
            .normal_tx
            .reserve()
            .await
            .map_err(|_| AppError::Other("控制通道已关闭".into()))?;
        let admission = self.admission.lock().unwrap_or_else(|e| e.into_inner());
        if *admission != Admission::Open {
            return Err(AppError::Other("宿主正在关停，拒绝新请求".into()));
        }
        permit.send(NormalFrame::Bytes(bytes));
        Ok(())
    }

    async fn flush_normal_queue(&self) -> AppResult<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.normal_tx
            .send(NormalFrame::Flush(tx))
            .await
            .map_err(|_| AppError::Other("控制通道已关闭".into()))?;
        rx.await
            .map_err(|_| AppError::Other("控制通道排空中断".into()))
    }

    pub(super) async fn send_control_frame(&self, frame: ControlFrame) -> AppResult<()> {
        let bytes = transport::encode_control_frame(&frame, self.config.control_frame_max_bytes)?;
        self.control_tx
            .send(bytes)
            .await
            .map_err(|_| AppError::Other("控制通道已关闭".into()))
    }

    fn close_local(&self, reason: &str) {
        *self.admission.lock().unwrap_or_else(|e| e.into_inner()) = Admission::Closed;
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

    pub(super) fn scope_current(&self, scope: &RunScope) -> bool {
        scope.app_epoch == self.app_epoch && scope.node_epoch == self.node_epoch
    }

    pub(super) fn is_request_cancelled(&self, request_id: u64) -> bool {
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

    pub(super) async fn respond_ok(&self, request_id: u64, result: Value) {
        let frame = ControlFrame::ok(request_id, result);
        match transport::encode_control_frame(&frame, self.config.control_frame_max_bytes) {
            Ok(bytes) => {
                let _ = self.normal_tx.send(NormalFrame::Bytes(bytes)).await;
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

    pub(super) async fn respond_err(
        &self,
        request_id: u64,
        code: &str,
        message: impl Into<String>,
    ) {
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
            let _ = self.normal_tx.send(NormalFrame::Bytes(bytes)).await;
        }
    }

    pub(super) async fn protocol_error(&self, message: impl Into<String>) {
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
        if self.admission_state() == Admission::Closed {
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
                Ok(Ok(value)) => match inner.encode_result_for_wire(request_id, &scope, value) {
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

    /// 结果编码：先按实际完整 response frame 判断；聚合结果超限时整包 JSON 经 blob 传输。
    /// 仅在原响应可装入控制帧时才尝试逐字段编码，避免聚合失败留下无用句柄。
    pub(super) fn encode_result_for_wire(
        &self,
        request_id: u64,
        scope: &RunScope,
        value: Value,
    ) -> AppResult<Value> {
        let original_fits = transport::encode_control_frame(
            &ControlFrame::ok(request_id, value.clone()),
            self.config.control_frame_max_bytes,
        )
        .is_ok();
        if !original_fits {
            return self.issue_json_result(request_id, scope, value);
        }

        let (encoded, issued) =
            self.encode_inline_fields_transactional(scope, value.clone(), |blob_scope, text| {
                self.blobs
                    .issue_host_blob(blob_scope.clone(), text.into_bytes(), None)
            })?;
        if transport::encode_control_frame(
            &ControlFrame::ok(request_id, encoded.clone()),
            self.config.control_frame_max_bytes,
        )
        .is_ok()
        {
            return Ok(encoded);
        }
        for id in issued {
            self.blobs.release(&id);
        }
        self.issue_json_result(request_id, scope, value)
    }

    fn issue_json_result(
        &self,
        request_id: u64,
        scope: &RunScope,
        value: Value,
    ) -> AppResult<Value> {
        let bytes = serde_json::to_vec(&value)
            .map_err(|e| AppError::Other(format!("结果 JSON 序列化失败: {e}")))?;
        let blob = self.blobs.issue_host_blob(scope.clone(), bytes, None)?;
        let marker = blob::host_json_blob_marker(&blob);
        if transport::encode_control_frame(
            &ControlFrame::ok(request_id, marker.clone()),
            self.config.control_frame_max_bytes,
        )
        .is_ok()
        {
            return Ok(marker);
        }
        self.blobs.release(&blob.id);
        Err(AppError::Other(
            "JSON blob 引用无法装入完整 response frame".into(),
        ))
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
                *self.admission.lock().unwrap_or_else(|e| e.into_inner()) = Admission::Closed;
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
    pub(super) fn default_scope(&self) -> RunScope {
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
pub(super) async fn run_control_writer<W: AsyncWrite + Unpin>(
    mut out: W,
    mut control_rx: mpsc::Receiver<Vec<u8>>,
    mut normal_rx: mpsc::Receiver<NormalFrame>,
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
                Some(NormalFrame::Bytes(bytes)) => { if out.write_all(&bytes).await.is_err() { break; } }
                Some(NormalFrame::Flush(done)) => {
                    if out.flush().await.is_err() { break; }
                    let _ = done.send(());
                }
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
