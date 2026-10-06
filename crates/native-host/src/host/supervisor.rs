// ==========================================
// Node 监督器：拉起、握手、崩溃/代际轮换、关停序列
// ==========================================
//
// 一个应用只有一个 Harness Node：本模块负责它的完整生命周期（执行契约 §4.3）：
//
// - 拉起随包 Node（路径来自 [`LaunchInfo`]），经环境变量 `DESKPET_HOST_LAUNCH`
//   传入端点与一次性握手值（唯一真相源，见 `ipc/mod.rs`）。
// - 校验协议版本、Node 版本（ABI 由版本完全一致蕴含）与一次性握手值；握手超时
//   即杀进程并报错，不留下半开连接。
// - stdout/stderr **只作日志采集**（逐行进统一日志），永不承载 RPC。
// - 崩溃：`node_epoch` +1，旧权限/owner/确认与 blob 句柄全部失效（注册表按 epoch
//   回收），按策略自动重启；是否允许重启由 [`CrashRecovery`] 钩子裁定，
//   **不自动驱动有未知副作用的操作**（恢复只把待处置状态交还新 Node）。
//   终态（重启耗尽/被拒/被禁用，不再有新代际）与新一代际握手成功经
//   [`ServiceAvailabilityHook`] 推给装配处（出口只是通知，不是第二个状态位）。
// - 关停序列（§4.3 第 5 条）：封新 admission → 请求 Node flush → 等已准入写队列
//   的真实 flush 报告 → 收子进程 → 停 Node → 退出。超时**如实记中断**，不伪报
//   flush 成功。
// - 不留孤儿：正常路径 kill + wait；Windows 进程加入 `KILL_ON_JOB_CLOSE` Job
//   Object（句柄在本进程关闭即杀），macOS/Windows 都靠「宿主死亡 → 端点连接断开
//   → Node 侧读到控制连接关闭即退出」兜底。
//
// 线程模型：监督器自持一个 2 线程 Tokio 运行时（不借用宿主主线程）。同步方法
// （start / wait_exit / shutdown）**阻塞调用线程**，宿主必须在工作线程调用，
// 不得从 UI 主循环直接调用。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::Duration;

use tokio::io::AsyncBufReadExt;

use crate::error::{AppError, AppResult};
use crate::ipc::blob::BlobRegistry;
use crate::ipc::bridge::{
    accept_control_handshake, BridgeConfig, CommandDispatcher, FlushReport, HelloExpectations,
    HostBridge,
};
use crate::ipc::protocol::{LaunchInfo, RuntimeMode};
use crate::ipc::transport::{self, Endpoint};
use crate::{rust_debug, rust_info, rust_warn};

/// 监督器配置。由宿主装配（端点/入口/版本来自打包元数据与 AppPaths 环境）。
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub launch: LaunchInfo,
    pub app_version: String,
    /// 宿主进程实例身份（宿主启动时生成；重启即换）。
    pub app_epoch: String,
    /// 随包 Node 的锁定版本（`packaging/node-runtime.json`）。版本不一致即拒绝握手。
    pub expected_node_version: String,
    pub runtime_mode: RuntimeMode,
    pub handshake_timeout: Duration,
    /// Node 退出前的 flush 期限（写入 `shutdown` 控制帧）。
    pub flush_deadline: Duration,
    /// 等 Node 退出本身的宽限（收到 flush 报告之后）。
    pub shutdown_grace: Duration,
    pub restart: RestartPolicy,
    pub bridge: BridgeConfig,
}

impl SupervisorConfig {
    /// 常规默认：握手 10s、flush 5s、退出宽限 5s、崩溃自动重启（≤5 次，退避 2s）。
    pub fn new(
        launch: LaunchInfo,
        app_version: impl Into<String>,
        app_epoch: impl Into<String>,
        expected_node_version: impl Into<String>,
    ) -> Self {
        Self {
            launch,
            app_version: app_version.into(),
            app_epoch: app_epoch.into(),
            expected_node_version: expected_node_version.into(),
            runtime_mode: current_runtime_mode(),
            handshake_timeout: Duration::from_secs(10),
            flush_deadline: Duration::from_secs(5),
            shutdown_grace: Duration::from_secs(5),
            restart: RestartPolicy::default(),
            bridge: BridgeConfig::default(),
        }
    }
}

/// 由构建模式判定运行模式（宿主判定，Node 只从 welcome 取）。
fn current_runtime_mode() -> RuntimeMode {
    if cfg!(debug_assertions) {
        RuntimeMode::Development
    } else {
        RuntimeMode::Production
    }
}

/// 崩溃重启策略。
#[derive(Debug, Clone)]
pub struct RestartPolicy {
    pub enabled: bool,
    /// 连续失败上限（握手成功即清零）。
    pub max_attempts: u32,
    pub backoff: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_attempts: 5,
            backoff: Duration::from_secs(2),
        }
    }
}

/// 崩溃恢复钩子（W3/W4 接入会话恢复）。
///
/// 契约（执行契约 §4.3 第 6 条）：崩溃后新 Node 必须换代际，由新代际**按 JSONL
/// 恢复待处置状态**；恢复过程不得由宿主重放工具调用、不得自动驱动有未知副作用的
/// 操作。钩子只应记录/准备恢复所需的信息并裁定是否允许自动重启。
pub trait CrashRecovery: Send + Sync + 'static {
    fn on_node_crash(&self, context: &CrashContext) -> RestartDecision;
}

/// 崩溃上下文。
#[derive(Debug, Clone)]
pub struct CrashContext {
    pub app_epoch: String,
    pub old_node_epoch: u64,
    pub new_node_epoch: u64,
    pub exit_detail: String,
    pub attempt: u32,
    /// 本次崩溃时被回收的 blob 句柄数（旧 owner 失效的证据）。
    pub revoked_blobs: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    Restart,
    Stop,
}

/// 无恢复钩子时的默认裁定：允许重启（Node 崩溃自愈是常规路径）。
pub struct DefaultRecovery;

impl CrashRecovery for DefaultRecovery {
    fn on_node_crash(&self, context: &CrashContext) -> RestartDecision {
        rust_warn!(
            "Node 崩溃（app={} node {} → {}）：{}；按默认策略自动重启（W3 接入会话恢复后由钩子接手）",
            context.app_epoch,
            context.old_node_epoch,
            context.new_node_epoch,
            context.exit_detail
        );
        RestartDecision::Restart
    }
}

/// 服务可用性事件：监督器只在两个**可确知**的时机产生（见 [`ServiceAvailabilityHook`]）。
///
/// 这是通知出口，不是第二个状态位 —— 当前状态仍以 [`NodeStatus`] 为唯一真相源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceAvailability {
    /// 服务不可用且不会再自动恢复（崩溃重启耗尽 / 恢复钩子拒绝重启 / 自动重启被
    /// 禁用）：终态 Crashed。`node_epoch` 是崩溃的那一代（与 [`NodeStatus::Crashed`]
    /// 同口径）；`detail` 是本次判定可确知的原因说明（供日志/诊断原样保留）。
    Unavailable { node_epoch: u64, detail: String },
    /// 新一代际握手成功（含首次启动）：服务可用。`node_epoch` 是刚就绪的代际。
    Available { node_epoch: u64 },
}

/// 服务可用性出口：宿主装配处订阅（例如把终态推到顶栏提示）。
///
/// 只推「终态不可用」与「恢复可用」两个时机，**不推中间态**：崩溃后的重启等待
/// 窗口不是终态，「正在自动重启」也不构成「服务已不可恢复」这一可确知事实。
/// 未订阅时为无操作（不 panic、不留日志）。出口在监督器运行时线程上**同步**调用，
/// 实现应尽快返回（阻塞会占住该线程）。
pub trait ServiceAvailabilityHook: Send + Sync + 'static {
    fn on_service_availability(&self, availability: &ServiceAvailability);
}

/// 一次成功握手的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeInfo {
    pub app_epoch: String,
    pub node_epoch: u64,
    pub app_version: String,
    pub node_version: String,
    pub pid: Option<u32>,
    pub limits: crate::ipc::protocol::TransportLimits,
}

/// 子进程退出报告（供宿主观察窗/诊断）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeExitReport {
    pub node_epoch: u64,
    pub pid: Option<u32>,
    /// 退出说明（退出码/信号，向日志与原样保留）。
    pub detail: String,
    /// 是否为非预期退出（崩溃）。
    pub crash: bool,
}

/// 关停报告。**超时如实记中断**：`interrupted=true` 时 `node_flush` 缺失或为 false。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownReport {
    /// Node 的 flush 真实报告；期限内没等到就是 `None`（不伪报成功）。
    pub node_flush: Option<FlushReport>,
    /// 是否走过了强杀路径。
    pub forced_kill: bool,
    /// 是否有未按合同完成的步骤（flush 缺失 / 强杀后仍未退出等）。
    pub interrupted: bool,
    pub detail: String,
}

/// 当前状态快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeStatus {
    Stopped,
    Handshaking {
        node_epoch: u64,
    },
    Running {
        node_epoch: u64,
        pid: Option<u32>,
        node_version: String,
    },
    Crashed {
        node_epoch: u64,
        detail: String,
    },
}

/// 代际轮换结果（崩溃路径与测试共用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationReport {
    pub old_node_epoch: u64,
    pub new_node_epoch: u64,
    pub revoked_blobs: usize,
}

// ==========================================
// 共享状态
// ==========================================

struct ExitWatch {
    waiters: StdMutex<Vec<std::sync::mpsc::Sender<NodeExitReport>>>,
    last: StdMutex<Option<NodeExitReport>>,
}

impl ExitWatch {
    fn new() -> Self {
        Self {
            waiters: StdMutex::new(Vec::new()),
            last: StdMutex::new(None),
        }
    }

    fn publish(&self, report: NodeExitReport) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(report.clone());
        let waiters = std::mem::take(&mut *self.waiters.lock().unwrap_or_else(|e| e.into_inner()));
        for waiter in waiters {
            let _ = waiter.send(report.clone());
        }
    }

    /// 等到「下一次」退出或超时。已发生的退出不会自动满足下一次等待（轮换后清空）。
    fn wait(&self, timeout: Duration) -> Option<NodeExitReport> {
        if let Some(report) = self.last.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Some(report);
        }
        let (tx, rx) = std::sync::mpsc::channel();
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        rx.recv_timeout(timeout).ok()
    }

    fn reset(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

struct Shared {
    app_epoch: String,
    node_epoch: AtomicU64,
    /// 崩溃自动重启所需的配置（代际启动共用；不经 Shared 就无从重启）。
    restart_config: StdMutex<Option<SupervisorConfig>>,
    blobs: Arc<BlobRegistry>,
    bridge: RwLock<Option<HostBridge>>,
    /// 引导命令分派器（W2）。在每代 HostBridge 建立时**先于 I/O 任务**注入，
    /// 保证 Node 握手后的第一条引导请求（如 `get_runtime_paths`）不会撞上
    /// 默认的 `UnavailableDispatcher`；崩溃重启的后续代际沿用同一个。
    bootstrap_dispatcher: RwLock<Option<Arc<dyn CommandDispatcher>>>,
    endpoint: StdMutex<Option<Endpoint>>,
    status: StdMutex<NodeStatus>,
    shutting_down: AtomicBool,
    restart_attempts: AtomicU32,
    recovery: RwLock<Option<Arc<dyn CrashRecovery>>>,
    /// 服务可用性出口（宿主装配处订阅；未订阅时为空 → 无操作）。
    availability_hook: RwLock<Option<Arc<dyn ServiceAvailabilityHook>>>,
    exit_watch: Arc<ExitWatch>,
    /// 当前代际的强杀信号（oneshot；watcher 任务在 wait/kill 之间选择）。
    kill_tx: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
    runtime: tokio::runtime::Handle,
    #[cfg(windows)]
    job: StdMutex<Option<WindowsJob>>,
}

impl Shared {
    fn status_snapshot(&self) -> NodeStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set_status(&self, status: NodeStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    /// 推一次服务可用性事件（未订阅时无操作）。先取出订阅者再调用，不在持锁期间
    /// 执行订阅方代码（订阅方可能回询本结构的状态）。
    fn notify_availability(&self, availability: ServiceAvailability) {
        let hook = self
            .availability_hook
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook.on_service_availability(&availability);
        }
    }

    fn current_bridge(&self) -> Option<HostBridge> {
        self.bridge
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 代际轮换：`node_epoch` +1、回收旧代际 blob 句柄、清空当前桥引用。
    /// 旧权限/owner/确认随旧 scope（appEpoch+nodeEpoch）与旧桥一起失效。
    fn rotate_epoch(&self, reason: &str) -> RotationReport {
        let old = self.node_epoch.load(Ordering::SeqCst);
        let new = old + 1;
        self.node_epoch.store(new, Ordering::SeqCst);
        let revoked = self.blobs.revoke_before_epoch(&self.app_epoch, new);
        // 旧桥引用丢弃：其 I/O 任务随连接关闭结束；pending 请求随通道路径失败。
        self.bridge
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        rust_info!("Node 代际轮换: {old} → {new}（{reason}；回收 blob 句柄 {revoked} 个）");
        RotationReport {
            old_node_epoch: old,
            new_node_epoch: new,
            revoked_blobs: revoked,
        }
    }
}

// ==========================================
// 监督器
// ==========================================

pub struct NodeSupervisor {
    runtime: tokio::runtime::Runtime,
    shared: Arc<Shared>,
    config: SupervisorConfig,
}

impl NodeSupervisor {
    /// 建立监督器与专用运行时（尚未拉起 Node）。必须在非 async 上下文中调用。
    pub fn new(config: SupervisorConfig) -> AppResult<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("deskpet-node-sup")
            .enable_all()
            .build()
            .map_err(|e| AppError::Other(format!("监督器运行时创建失败: {e}")))?;
        let shared = Arc::new(Shared {
            app_epoch: config.app_epoch.clone(),
            node_epoch: AtomicU64::new(0),
            restart_config: StdMutex::new(Some(config.clone())),
            blobs: Arc::new(BlobRegistry::new()),
            bridge: RwLock::new(None),
            bootstrap_dispatcher: RwLock::new(None),
            endpoint: StdMutex::new(None),
            status: StdMutex::new(NodeStatus::Stopped),
            shutting_down: AtomicBool::new(false),
            restart_attempts: AtomicU32::new(0),
            recovery: RwLock::new(Some(Arc::new(DefaultRecovery))),
            availability_hook: RwLock::new(None),
            exit_watch: Arc::new(ExitWatch::new()),
            kill_tx: StdMutex::new(None),
            runtime: runtime.handle().clone(),
            #[cfg(windows)]
            job: StdMutex::new(None),
        });
        Ok(Self {
            runtime,
            shared,
            config,
        })
    }

    /// 设置崩溃恢复钩子（替换默认裁定）。
    pub fn set_recovery(&self, recovery: Arc<dyn CrashRecovery>) {
        *self
            .shared
            .recovery
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(recovery);
    }

    /// 订阅服务可用性出口（宿主装配处调用；建议在 `start()` 前设置，重复设置即替换）。
    ///
    /// 出口只在终态不可用（崩溃重启耗尽等）与新一代际握手成功两个时机被调用；
    /// 不改变重启策略与状态机语义（见 [`ServiceAvailabilityHook`]）。
    pub fn set_availability_hook(&self, hook: Arc<dyn ServiceAvailabilityHook>) {
        *self
            .shared
            .availability_hook
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    /// 设置引导分派器（必须在 `start()` 前调用；此后每代 Node 沿用同一个）。
    ///
    /// 用途：宿主 bootstrap 必须在 Node 第一条请求（`get_runtime_paths`）到达前
    /// 就能应答。W4 接完整命令矩阵后由它替换引导期最小分派器。
    pub fn set_bootstrap_dispatcher(&self, dispatcher: Arc<dyn CommandDispatcher>) {
        *self
            .shared
            .bootstrap_dispatcher
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(dispatcher);
    }

    pub fn status(&self) -> NodeStatus {
        self.shared.status_snapshot()
    }

    pub fn current_bridge(&self) -> Option<HostBridge> {
        self.shared.current_bridge()
    }

    pub fn blobs(&self) -> Arc<BlobRegistry> {
        self.shared.blobs.clone()
    }

    pub fn app_epoch(&self) -> &str {
        &self.shared.app_epoch
    }

    pub fn node_epoch(&self) -> u64 {
        self.shared.node_epoch.load(Ordering::SeqCst)
    }

    /// 拉起 Node 并完成握手。阻塞当前线程至多 `handshake_timeout`：
    /// 超时即杀进程、清端点并报错（不留半开连接/孤儿进程）。
    pub fn start(&self) -> AppResult<HandshakeInfo> {
        let (tx, rx) = std::sync::mpsc::channel();
        let shared = self.shared.clone();
        let config = self.config.clone();
        self.runtime.spawn(async move {
            let result = launch_generation(shared, config).await;
            let _ = tx.send(result);
        });
        match rx.recv_timeout(self.config.handshake_timeout + Duration::from_secs(1)) {
            Ok(Ok(info)) => Ok(info),
            Ok(Err(err)) => Err(err),
            Err(_) => {
                self.kill_now("Node 握手超时");
                Err(AppError::Timeout)
            }
        }
    }

    /// 等待下一次 Node 退出（含崩溃），供宿主观察/诊断；超时返回 `None`。
    pub fn wait_exit(&self, timeout: Duration) -> Option<NodeExitReport> {
        self.shared.exit_watch.wait(timeout)
    }

    /// 关停序列（§4.3 第 5 条）。同步阻塞，必须从工作线程调用。
    ///
    /// 1. 封新 admission（新请求立刻被拒）；
    /// 2. 请求 Node 停止收新工作并在 `flush_deadline` 内 flush；
    /// 3. 等 Node 的 flush **真实报告**（没等到就是中断，不伪报）；
    /// 4. 等子进程在 `shutdown_grace` 内退出；超时 → 强杀 + 等 2s；
    /// 5. 关闭本地桥与端点。
    pub fn shutdown(&self) -> ShutdownReport {
        self.shared.shutting_down.store(true, Ordering::SeqCst);
        let bridge = self.shared.current_bridge();
        let mut detail = String::new();
        let mut node_flush = None;
        if let Some(bridge) = &bridge {
            bridge.close_admission();
            let reason = "宿主退出";
            let request = bridge.request_shutdown(reason, self.config.flush_deadline);
            if let Err(err) = self.runtime.block_on(request) {
                detail.push_str(&format!("shutdown 控制帧发送失败: {err}；"));
            }
            node_flush = self
                .runtime
                .block_on(bridge.wait_flush_report(self.config.flush_deadline));
            if node_flush.is_none() {
                detail.push_str(&format!(
                    "Node 未在 {:?} 内回报 flush（如实记中断）；",
                    self.config.flush_deadline
                ));
            }
        } else {
            detail.push_str("没有活动桥（Node 未运行或已退出）；");
        }

        let mut forced_kill = false;
        let has_live_child = matches!(
            self.shared.status_snapshot(),
            NodeStatus::Running { .. } | NodeStatus::Handshaking { .. }
        );
        if has_live_child {
            let exited = self.shared.exit_watch.wait(self.config.shutdown_grace);
            if exited.is_none() {
                forced_kill = true;
                self.kill_now("关停超时");
                if self
                    .shared
                    .exit_watch
                    .wait(Duration::from_secs(2))
                    .is_none()
                {
                    detail.push_str("强杀后 2s 内仍未收到退出（进程可能已脱离管辖）；");
                }
            }
        }

        if let Some(bridge) = &bridge {
            bridge.close_local("宿主关停");
        }
        if let Some(endpoint) = self
            .shared
            .endpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            endpoint.close();
        }
        let interrupted = node_flush
            .as_ref()
            .map(|report| !report.flushed)
            .unwrap_or(true)
            || forced_kill;
        if detail.is_empty() {
            detail.push_str("关停完成");
        }
        self.shared.set_status(NodeStatus::Stopped);
        ShutdownReport {
            node_flush,
            forced_kill,
            interrupted,
            detail,
        }
    }

    /// 立即强杀当前 Node 代际（不做 flush；诊断/兜底路径）。
    pub fn force_kill(&self, reason: &str) {
        self.kill_now(reason);
    }

    fn kill_now(&self, reason: &str) {
        request_kill(&self.shared, reason);
    }
}

/// 向当前代际发强杀信号（watcher 任务执行 start_kill + wait）。
fn request_kill(shared: &Shared, reason: &str) {
    let sender = shared
        .kill_tx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(sender) = sender {
        rust_warn!("强杀 Node 进程：{reason}");
        let _ = sender.send(());
    }
}

impl Drop for NodeSupervisor {
    fn drop(&mut self) {
        self.shared.shutting_down.store(true, Ordering::SeqCst);
        self.kill_now("监督器释放");
        let _ = self.shared.exit_watch.wait(Duration::from_secs(2));
    }
}

// ==========================================
// 一次代际的启动流程
// ==========================================

async fn launch_generation(
    shared: Arc<Shared>,
    config: SupervisorConfig,
) -> AppResult<HandshakeInfo> {
    let node_epoch = shared.node_epoch.load(Ordering::SeqCst);
    shared.set_status(NodeStatus::Handshaking { node_epoch });
    let outcome = launch_generation_inner(&shared, &config, node_epoch).await;
    if let Err(err) = &outcome {
        // 握手失败等启动期错误：子进程可能还活着，必须杀干净（不留孤儿）。
        request_kill(&shared, "启动期失败清理");
        rust_warn!("Node 代际 {node_epoch} 启动失败: {err}");
        shared.set_status(NodeStatus::Crashed {
            node_epoch,
            detail: err.to_string(),
        });
    }
    outcome
}

async fn launch_generation_inner(
    shared: &Arc<Shared>,
    config: &SupervisorConfig,
    node_epoch: u64,
) -> AppResult<HandshakeInfo> {
    // 端点由宿主创建；一代一个新端点 + 一次新握手值。
    let endpoint = Endpoint::create()?;
    let address = endpoint.address().to_string();
    let handshake_token = transport::random_hex(24)?;

    let launch_env = serde_json::json!({
        "endpoint": address,
        "handshake": handshake_token,
        "entry": config.launch.entry.to_string_lossy(),
        "nodeBinary": config.launch.node_binary.to_string_lossy(),
    });
    let entry = config.launch.entry.to_string_lossy().to_string();

    let mut command = tokio::process::Command::new(&config.launch.node_binary);
    command
        .arg(&config.launch.entry)
        .env("DESKPET_HOST_LAUNCH", launch_env.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| {
        AppError::Other(format!(
            "随包 Node 拉起失败（{}）: {e}",
            config.launch.node_binary.display()
        ))
    })?;
    let pid = child.id();

    #[cfg(windows)]
    {
        // Windows：进程加入 KILL_ON_JOB_CLOSE 作业对象 —— 句柄随本进程关闭即杀整棵进程树。
        match WindowsJob::attach(&child) {
            Ok(job) => *shared.job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job),
            Err(err) => {
                // kill_on_drop 只覆盖 Node 本身，不覆盖它启动的插件/MCP 子进程。
                // 无法建立进程树所有权时拒绝进入 Running，避免把「无孤儿」降级成猜测。
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(AppError::Other(format!(
                    "Windows Node Job Object 绑定失败，已停止启动以避免遗留子进程: {err}"
                )));
            }
        }
    }

    rust_info!(
        "Node 已拉起: pid={:?} entry={entry} nodeEpoch={node_epoch}",
        pid
    );

    // stdout/stderr：只作日志采集，逐行进统一日志。
    if let Some(stdout) = child.stdout.take() {
        spawn_stdio_collector(stdout, "Node", crate::logger::LEVEL_INFO);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_stdio_collector(stderr, "Node:err", crate::logger::LEVEL_WARN);
    }

    // 退出 watcher：拥有 Child（强杀经 oneshot 在内部执行），退出后走崩溃/轮换路径。
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel();
    *shared.kill_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(kill_tx);
    let watcher_shared = shared.clone();
    tokio::spawn(async move {
        let (status, forced) = tokio::select! {
            status = child.wait() => (status.ok(), false),
            _ = kill_rx => {
                let _ = child.start_kill();
                (child.wait().await.ok(), true)
            }
        };
        let detail = describe_exit(status.as_ref());
        let crash = !forced && !watcher_shared.shutting_down.load(Ordering::SeqCst);
        let report = NodeExitReport {
            node_epoch,
            pid,
            detail: if forced {
                format!("{detail}（受控强杀）")
            } else {
                detail
            },
            crash,
        };
        rust_info!(
            "Node 进程退出: nodeEpoch={node_epoch} crash={crash} {}",
            report.detail
        );
        on_child_exit(&watcher_shared, &report);
        watcher_shared.exit_watch.publish(report);
    });

    // 控制连接 + hello/welcome（超时即失败，由外层 start 的时限兜底）。
    let expect = HelloExpectations {
        app_version: config.app_version.clone(),
        expected_node_version: config.expected_node_version.clone(),
        handshake_token: handshake_token.clone(),
        runtime_mode: config.runtime_mode,
    };
    let limits = config.bridge.limits();
    let accept = async {
        let mut control = endpoint.accept_control().await?;
        let hello =
            accept_control_handshake(&mut control, &expect, limits, &shared.app_epoch, node_epoch)
                .await
                .map_err(|err| AppError::Other(format!("Node 握手被拒: {err}")))?;
        let binary = endpoint.accept_binary(&handshake_token).await?;
        Ok::<_, AppError>((control, binary, hello))
    };
    let (control, binary, hello) =
        match tokio::time::timeout(config.handshake_timeout, accept).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(err)) => {
                // 端点随作用域释放（socket 文件清理），子进程由调用方路径杀掉。
                return Err(err);
            }
            Err(_) => return Err(AppError::Timeout),
        };

    // 引导分派器（若已设置）在 I/O 任务启动前注入：第一条请求即可被正确应答。
    let bootstrap_dispatcher = shared
        .bootstrap_dispatcher
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let bridge = match bootstrap_dispatcher {
        Some(dispatcher) => HostBridge::start_with_dispatcher(
            control,
            binary,
            config.bridge.clone(),
            shared.app_epoch.clone(),
            node_epoch,
            shared.blobs.clone(),
            dispatcher,
        ),
        None => HostBridge::start(
            control,
            binary,
            config.bridge.clone(),
            shared.app_epoch.clone(),
            node_epoch,
            shared.blobs.clone(),
        ),
    };
    // 新代际：清掉旧退出记录，避免 wait_exit 立刻返回上一代结果。
    shared.exit_watch.reset();
    *shared.endpoint.lock().unwrap_or_else(|e| e.into_inner()) = Some(endpoint);
    *shared.bridge.write().unwrap_or_else(|e| e.into_inner()) = Some(bridge);
    shared.restart_attempts.store(0, Ordering::SeqCst);
    shared.set_status(NodeStatus::Running {
        node_epoch,
        pid,
        node_version: hello.node_version.clone(),
    });
    rust_info!(
        "Node 握手完成: nodeEpoch={node_epoch} node={} pid={pid:?}",
        hello.node_version
    );
    // 服务可用（首次启动或崩溃重启后的新一代际）：订阅方据此把宿主自推的服务
    // 提示清回缺省；Node 此后推送的最终文本照常整体覆盖。
    shared.notify_availability(ServiceAvailability::Available { node_epoch });

    Ok(HandshakeInfo {
        app_epoch: shared.app_epoch.clone(),
        node_epoch,
        app_version: config.app_version.clone(),
        node_version: hello.node_version,
        pid,
        limits,
    })
}

/// 崩溃/退出处理：轮换代际、回收旧句柄、按策略决定是否自动重启。
fn on_child_exit(shared: &Arc<Shared>, report: &NodeExitReport) {
    if shared.shutting_down.load(Ordering::SeqCst) || !report.crash {
        return;
    }
    let rotation = shared.rotate_epoch("Node 意外退出");
    let attempt = shared.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
    shared.set_status(NodeStatus::Crashed {
        node_epoch: rotation.old_node_epoch,
        detail: report.detail.clone(),
    });
    let context = CrashContext {
        app_epoch: shared.app_epoch.clone(),
        old_node_epoch: rotation.old_node_epoch,
        new_node_epoch: rotation.new_node_epoch,
        exit_detail: report.detail.clone(),
        attempt,
        revoked_blobs: rotation.revoked_blobs,
    };
    let decision = shared
        .recovery
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|hook| hook.on_node_crash(&context))
        .unwrap_or(RestartDecision::Restart);
    let config = shared
        .restart_config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    // 以下四条 return 都是**终态**（不会再自动恢复）：推服务可用性出口，供装配处
    // （如顶栏提示）知道「服务已不可恢复」这一可确知事实。中间态（重启等待窗口）
    // 不推 —— 重启策略与状态机语义不变，这里只加出口。
    let Some(config) = config else {
        shared.notify_availability(ServiceAvailability::Unavailable {
            node_epoch: rotation.old_node_epoch,
            detail: format!(
                "监督器没有重启配置，无法自动重启（attempt={attempt}）：{}",
                report.detail
            ),
        });
        return;
    };
    if decision == RestartDecision::Stop {
        rust_warn!("恢复钩子拒绝自动重启（attempt={attempt}）");
        shared.notify_availability(ServiceAvailability::Unavailable {
            node_epoch: rotation.old_node_epoch,
            detail: format!(
                "恢复钩子拒绝自动重启（attempt={attempt}）：{}",
                report.detail
            ),
        });
        return;
    }
    if !config.restart.enabled {
        rust_debug!("自动重启已禁用");
        shared.notify_availability(ServiceAvailability::Unavailable {
            node_epoch: rotation.old_node_epoch,
            detail: format!("自动重启已禁用（attempt={attempt}）：{}", report.detail),
        });
        return;
    }
    if attempt > config.restart.max_attempts {
        rust_warn!(
            "Node 连续崩溃超过上限（{} 次），停止自动重启",
            config.restart.max_attempts
        );
        shared.notify_availability(ServiceAvailability::Unavailable {
            node_epoch: rotation.old_node_epoch,
            detail: format!(
                "连续崩溃 {attempt} 次，超过自动重启上限 {}：{}",
                config.restart.max_attempts, report.detail
            ),
        });
        return;
    }
    let shared = shared.clone();
    shared.runtime.clone().spawn(async move {
        tokio::time::sleep(config.restart.backoff).await;
        if shared.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        rust_info!(
            "按崩溃策略重启 Node（attempt={attempt}/{}，nodeEpoch={}）",
            config.restart.max_attempts,
            shared.node_epoch.load(Ordering::SeqCst)
        );
        if let Err(err) = launch_generation(shared.clone(), config.clone()).await {
            // 重启失败也要继续按策略递增尝试（launch_generation 已记录状态）。
            rust_warn!("Node 重启失败: {err}");
            let failed = NodeExitReport {
                node_epoch: shared.node_epoch.load(Ordering::SeqCst),
                pid: None,
                detail: format!("重启失败: {err}"),
                crash: true,
            };
            on_child_exit(&shared, &failed);
        }
    });
}

fn describe_exit(status: Option<&std::process::ExitStatus>) -> String {
    match status {
        Some(status) => match status.code() {
            Some(code) => format!("退出码 {code}"),
            #[cfg(unix)]
            None => {
                use std::os::unix::process::ExitStatusExt;
                format!("信号 {:?}", status.signal())
            }
            #[cfg(not(unix))]
            None => "无退出码".to_string(),
        },
        None => "等待退出失败".to_string(),
    }
}

fn spawn_stdio_collector<R>(reader: R, tag: &'static str, level: u8)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    crate::logger::emit(level, format_args!("[{tag}] {line}"));
                }
                Ok(None) => break,
                Err(err) => {
                    rust_debug!("[{tag}] 日志采集结束: {err}");
                    break;
                }
            }
        }
    });
}

// ==========================================
// Windows：KILL_ON_JOB_CLOSE 作业对象
// ==========================================

#[cfg(windows)]
pub(crate) struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsJob {
    /// 把刚拉起的子进程加入「句柄关闭即杀」的作业对象。返回的句柄必须存活到
    /// 进程结束（本结构 Drop 时关闭句柄 → 内核回收整棵进程树）。
    fn attach(child: &tokio::process::Child) -> Result<Self, String> {
        use std::ffi::c_void;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = child
            .raw_handle()
            .ok_or_else(|| "拿不到子进程句柄".to_string())?;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 {
                return Err(format!(
                    "CreateJobObjectW 失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(job);
                return Err(format!(
                    "SetInformationJobObject 失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let ok =
                AssignProcessToJobObject(job, handle as windows_sys::Win32::Foundation::HANDLE);
            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(job);
                return Err(format!(
                    "AssignProcessToJobObject 失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self { handle: job })
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

// ==========================================
// 单元测试
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::RunScope;

    fn supervisor_config(
        node_binary: std::path::PathBuf,
        entry: std::path::PathBuf,
    ) -> SupervisorConfig {
        let mut config = SupervisorConfig::new(
            LaunchInfo {
                endpoint: String::new(), // 真实端点由监督器创建，这里占位
                handshake: String::new(),
                node_binary,
                entry,
            },
            "0.16.0",
            "boot-test",
            "22.22.3",
        );
        config.handshake_timeout = Duration::from_millis(400);
        config.shutdown_grace = Duration::from_secs(2);
        config.flush_deadline = Duration::from_millis(200);
        config.restart.enabled = false;
        config
    }

    /// 代际轮换的纯逻辑：epoch +1、旧句柄全部回收、旧桥引用清空。
    #[test]
    fn 代际轮换使旧句柄失效() {
        let config = supervisor_config("/bin/echo".into(), "/dev/null".into());
        let supervisor = NodeSupervisor::new(config).unwrap();
        let shared = supervisor.shared.clone();

        let old_scope = RunScope {
            app_epoch: shared.app_epoch.clone(),
            node_epoch: 0,
            session_id: Some("s-1".into()),
            ..Default::default()
        };
        let blob = shared
            .blobs
            .issue_host_blob(old_scope.clone(), vec![1, 2, 3], None)
            .unwrap();
        assert_eq!(shared.blobs.len(), 1);

        let report = shared.rotate_epoch("测试");
        assert_eq!(report.old_node_epoch, 0);
        assert_eq!(report.new_node_epoch, 1);
        assert_eq!(report.revoked_blobs, 1, "轮换必须回收旧代际句柄");
        assert!(shared.blobs.is_empty());
        // 新代际的 scope 读旧句柄：无论如何都失败（句柄已回收）
        let mut new_scope = old_scope.clone();
        new_scope.node_epoch = 1;
        assert!(shared.blobs.open_read(&blob.id, &new_scope).is_err());
    }

    /// 握手超时：随包 Node（这里用 `/bin/sleep 30` 冒充：安静、不交握手）→ start
    /// 报错、子进程被杀、不留孤儿；关停序列如实记中断而非伪报 flush。
    #[test]
    #[cfg(unix)]
    fn 握手超时杀进程且关停如实记中断() {
        let config = supervisor_config("/bin/sleep".into(), "30".into());
        let supervisor = NodeSupervisor::new(config).unwrap();
        let err = supervisor.start().unwrap_err();
        assert_eq!(err.code().as_ref(), "TIMEOUT", "{err}");

        // 等强杀后的退出记录（start 超时已发 kill）。
        let exit = supervisor.wait_exit(Duration::from_secs(5));
        assert!(exit.is_some(), "超时必须已经杀掉随包 Node 进程");

        let report = supervisor.shutdown();
        assert!(
            report.node_flush.is_none(),
            "未握手就关停：不许伪报 flush 成功"
        );
        assert!(report.interrupted, "关停报告必须如实标记中断");
        assert_eq!(supervisor.status(), NodeStatus::Stopped);
    }

    /// 强杀路径与状态：没有活动 Node 时关停是干净的空操作（但如实说明）。
    #[test]
    fn 无节点时关停是如实空操作() {
        let config = supervisor_config("/bin/echo".into(), "/dev/null".into());
        let supervisor = NodeSupervisor::new(config).unwrap();
        let report = supervisor.shutdown();
        assert!(report.node_flush.is_none());
        assert!(report.interrupted, "没有 flush 报告就不是成功关停");
        assert!(!report.forced_kill);
        assert!(report.detail.contains("没有活动桥"), "{}", report.detail);
    }

    /// 假 Node：启动一个会说 hello 的假进程不可行（需要 JS），这里用直接构造的
    /// 共享状态验证“崩溃 → 钩子 → 决策”的裁定链。
    #[test]
    fn 崩溃钩子可以拒绝自动重启() {
        struct StopHook;
        impl CrashRecovery for StopHook {
            fn on_node_crash(&self, _context: &CrashContext) -> RestartDecision {
                RestartDecision::Stop
            }
        }
        let config = supervisor_config("/bin/echo".into(), "/dev/null".into());
        let supervisor = NodeSupervisor::new(config).unwrap();
        supervisor.set_recovery(Arc::new(StopHook));
        let recorder = Arc::new(AvailabilityRecorder::default());
        supervisor.set_availability_hook(recorder.clone());
        let shared = supervisor.shared.clone();
        // 直接触发崩溃路径：恢复钩子裁定 Stop → 不派发重启任务（不会拉起真进程）。
        let report = NodeExitReport {
            node_epoch: 0,
            pid: None,
            detail: "测试崩溃".into(),
            crash: true,
        };
        on_child_exit(&shared, &report);
        assert_eq!(
            shared.node_epoch.load(Ordering::SeqCst),
            1,
            "崩溃必须轮换代际"
        );
        match shared.status_snapshot() {
            NodeStatus::Crashed { node_epoch, .. } => assert_eq!(node_epoch, 0),
            other => panic!("期望 Crashed，得到 {other:?}"),
        }
        // 被拒重启也是终态（不会再有自动恢复）：出口如实推 Unavailable。
        let events = recorder.take();
        assert_eq!(events.len(), 1, "终态只推一次出口: {events:?}");
        match &events[0] {
            ServiceAvailability::Unavailable { node_epoch, detail } => {
                assert_eq!(*node_epoch, 0);
                assert!(detail.contains("恢复钩子拒绝自动重启"), "{detail}");
            }
            other => panic!("期望 Unavailable，得到 {other:?}"),
        }
    }

    /// 出口记录器（测试用）：记录每次服务可用性事件。
    #[derive(Default)]
    struct AvailabilityRecorder {
        events: StdMutex<Vec<ServiceAvailability>>,
    }

    impl ServiceAvailabilityHook for AvailabilityRecorder {
        fn on_service_availability(&self, availability: &ServiceAvailability) {
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(availability.clone());
        }
    }

    impl AvailabilityRecorder {
        fn take(&self) -> Vec<ServiceAvailability> {
            std::mem::take(&mut *self.events.lock().unwrap_or_else(|e| e.into_inner()))
        }
    }

    /// 崩溃重启耗尽：出口以终态 Unavailable 被调用一次；重启策略与状态机语义不变。
    #[test]
    fn 重启耗尽触发服务不可用出口() {
        let mut config = supervisor_config("/bin/echo".into(), "/dev/null".into());
        config.restart.enabled = true;
        // 上限 0：首次崩溃（attempt=1）即判耗尽，不派发真重启任务（假 Node 无法
        // 真握手，派发只会拉起一个真进程），纯粹验证终态出口。
        config.restart.max_attempts = 0;
        let supervisor = NodeSupervisor::new(config).unwrap();
        let recorder = Arc::new(AvailabilityRecorder::default());
        supervisor.set_availability_hook(recorder.clone());
        let shared = supervisor.shared.clone();

        on_child_exit(
            &shared,
            &NodeExitReport {
                node_epoch: 0,
                pid: None,
                detail: "测试崩溃".into(),
                crash: true,
            },
        );

        let events = recorder.take();
        assert_eq!(events.len(), 1, "终态只推一次出口: {events:?}");
        match &events[0] {
            ServiceAvailability::Unavailable { node_epoch, detail } => {
                assert_eq!(
                    *node_epoch, 0,
                    "代际口径与 NodeStatus::Crashed 一致（崩溃的那一代）"
                );
                assert!(detail.contains("超过自动重启上限"), "{detail}");
            }
            other => panic!("期望 Unavailable，得到 {other:?}"),
        }
        // 既有语义不变：耗尽也轮换代际、状态位停在 Crashed。
        assert_eq!(
            shared.node_epoch.load(Ordering::SeqCst),
            1,
            "耗尽也要换代际"
        );
        match shared.status_snapshot() {
            NodeStatus::Crashed { node_epoch, .. } => assert_eq!(node_epoch, 0),
            other => panic!("期望 Crashed，得到 {other:?}"),
        }
    }

    /// 出口未订阅：终态路径照常走完（无操作、不 panic），状态机语义不变。
    #[test]
    fn 未订阅服务出口时终态不panic() {
        let mut config = supervisor_config("/bin/echo".into(), "/dev/null".into());
        config.restart.enabled = true;
        config.restart.max_attempts = 0;
        let supervisor = NodeSupervisor::new(config).unwrap();
        let shared = supervisor.shared.clone();
        on_child_exit(
            &shared,
            &NodeExitReport {
                node_epoch: 0,
                pid: None,
                detail: "测试崩溃".into(),
                crash: true,
            },
        );
        assert_eq!(shared.node_epoch.load(Ordering::SeqCst), 1);
        assert!(matches!(
            shared.status_snapshot(),
            NodeStatus::Crashed { .. }
        ));
    }
}
