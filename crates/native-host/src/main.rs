// ==========================================
// 原生宿主最小可执行入口（W0/W2 打包试验）
// ==========================================
//
// 本文件是 `crates/native-host` 的 bin 入口（cargo 默认 target `native-host`）。
// 目标只有一个：把「空 Native + 随包 Node」的最小装配跑通，作为两平台打包与更新
// helper 的原型底座（执行契约 §8「W0/W2 同时做空 Native+Node 的两平台打包和更新
// helper 原型，不把最小打包试验拖到最后」）。
//
// 对照执行契约 §4.3 的生命周期（本波做到的打 ✔，其余标注所属波次）：
//
// 1. ✔ 建路径与日志（AppPaths + 文件 sink）、建产品主窗/托盘/原生事件循环（W5 的
//    `ui::start_service`）、建监督器并拉起随包 Node；记忆库由分派器**惰性打开**
//    （首条记忆命令才打库；`--smoke` 不触库）。
// 2. ✔（部分）应用版本/协议版本/Node 版本由监督器握手校验；Node 的领域初始化
//    （人格/会话/工具/主动）由 W4 的命令矩阵承接。
// 3. ✔（W5）Node 忙碌/未就绪/崩溃时，快捷键与窗口显隐由原生 UI 在 Rust 主线程
//    本地完成（`ui` 域），不经 Node。
// 4. ✔（W5）关闭主窗只收起（`windowShouldClose`/`WM_CLOSE` → 状态机收起，
//    不销毁、不退出）；设置/编辑器/查看器关闭即销毁该窗口资源。
// 5. ✔ 关停序列（`--smoke` 与监督器 `shutdown()`）：封 admission → 请求 flush →
//    等真实 flush 报告 → 收子进程 → 停 Node；超时如实记中断，不伪报成功。
//    托盘「退出」/系统终止/命令侧 `app_restart` 经同一个只跑一次的
//    `HostExitHook` 走同一序列（先回收 MCP/Bash 子进程）。
// 6. 部分：Node 崩溃沿用监督器默认策略（换代际、回收旧句柄、按上限自动重启）；
//    本波没有会话恢复钩子（W3/W4 接入），不驱动任何有副作用的操作。
//
// 命令面（W4）：完整 `HostCommandMap`（118 条）由 `host/dispatch.rs` 的
// `NativeDispatcher` 承接；本文件的 `BootstrapDispatcher` 只多一层 `--smoke`
// 试验信号（首次应答 `get_runtime_paths`），E2E 的 `E2eDispatcher` 只截
// `e2e_options` / `e2e_trace` / `e2e_complete` 三条宿主级测试协议，其余全部委托 ——
// 任何一条矩阵命令都没有「未接线」静默分支。
//
// 宿主端口实现（W4）：资源授权 / 文件对话框 / 生命周期在 `host/native_ports.rs`。
//
// 运行方式：
// - `native-host`        常驻运行：先建路径与日志，再建主窗/托盘（快捷键等待 Node
//                        推送），然后拉起 Node 并进入原生事件循环；托盘「退出」走
//                        完整退出序列。Ctrl-C/SIGTERM 直接结束进程（Node 经端点
//                        断开自行退出，不留孤儿）。
// - `native-host --smoke` 试验模式：**不建任何窗口**（保持本模式既有的无 UI 语义），
//                        等首次 `get_runtime_paths` 被应答后走完整关停序列并打印
//                        报告后退出。退出码：0 = 引导链路全通且关停干净；1 = 未
//                        观察到引导请求；2 = 引导通但关停未干净。
//                        供 W11 的 test/host/native 驱动使用，不进入产品行为。
// - E2E 隔离模式（仅 debug 构建）：`DESKPET_E2E=1` 且 `DESKPET_E2E_CHANNEL` 指向
//   私有测试通道文件时，宿主在初始化前接收启动器写定的隔离 root / 合成 CONFIG /
//   trial 身份 / attestation，用通道里的 Node 与入口拉起 test/e2e Scene runner；
//   完成协议是「结果文件 + 进程退出码」（见本文件 E2E 节）。release 构建不编译
//   该模式与 e2e_options / e2e_complete / e2e_trace —— 测试命令不进入产品能力。

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use native_host::commands::mcp_bridge::McpPool;
use native_host::commands::tool_exec::BashPool;
use native_host::commands::tool_permit::ToolPermitPool;
use native_host::error::{AppError, AppResult};
use native_host::host::dispatch::{NativeDispatcher, NativeDispatcherDeps};
use native_host::host::events::HostEventRouter;
use native_host::host::native_ports::{
    ExitOnceHook, NativeAssetScope, NativeFileDialog, NativeLifecycle,
};
use native_host::host::supervisor::{NodeSupervisor, ShutdownReport, SupervisorConfig};
use native_host::host::{AssetScopePort, EventSink, FileDialogPort, WindowId, WindowPort};
use native_host::ipc::bridge::{CommandDispatcher, DispatchContext};
use native_host::ipc::protocol::LaunchInfo;
use native_host::logger;
use native_host::monitor::MonitorState;
use native_host::paths::{AppPaths, HostEnvironment};
use native_host::ui::{self, HostExitHook, MainThreadQueue, ServiceRequest, UiHandle};
use native_host::{rust_error, rust_info, rust_warn};

#[cfg(debug_assertions)]
use native_host::e2e_trace::{self, TraceChunk};
#[cfg(debug_assertions)]
use native_host::host::supervisor::NodeStatus;

/// 随包 Node 的版本锁定文件（编译期嵌入，避免第二定义点；唯一真相源仍是
/// `packaging/node-runtime.json`）。W10 打包时改为随更新元数据核对。
const NODE_RUNTIME_LOCK: &str = include_str!("../../../packaging/node-runtime.json");

/// 首次生产启动写入 `settings/CONFIG.yaml` 的模板（仓根 `CONFIG.yaml` 编译期嵌入）。
const CONFIG_TEMPLATE: &str = include_str!("../../../CONFIG.yaml");

/// 应用标识：沿用现有 `com.v1rtual.deskpet`（release 数据根由它派生）。
const APP_IDENTIFIER: &str = "com.v1rtual.deskpet";

/// 开发随包资源目录（debug 构建优先使用）：工作区内与打包闭包同形的暂存树
/// （`node/`、`harness/`、`defaults/`，见 `packaging/desktop.json` 的 resources 清单）。
/// `packaging/dist` 已被 gitignore；其中 `defaults` 是指回 `resources/defaults` 的
/// 符号链接，由 `pnpm run dev:prepare`（scripts/dev-prepare.mjs）幂等创建 —— 打包
/// 不从 `packaging/dist/defaults` 取种子（desktop.json 直接取 `../resources/defaults`），
/// 链接不影响产物。
const DEV_RESOURCE_SUBDIR: &str = "packaging/dist";

/// `--smoke` 等待首次引导请求的期限（含 Node 启动与握手时间）。
const SMOKE_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(30);

/// `--smoke` 在观察到引导分派后、发起 shutdown 前的沉降时间。
///
/// 分派完成信号来自宿主侧分派器，此时响应可能尚未写回、Node 也尚未走完
/// `bootstrapHarnessContext`（flush 处理器在那里注册）。本波没有 Node 侧
/// 就绪事件可观测，用固定沉降换稳定；W11 测试驱动应改为真实观测。
const SMOKE_SETTLE: Duration = Duration::from_secs(1);

enum Mode {
    Service,
    Smoke,
}

fn main() {
    logger::init_from_env();
    #[cfg(debug_assertions)]
    {
        // E2E 隔离模式：启动器经私有测试通道驱动（DESKPET_E2E=1 + DESKPET_E2E_CHANNEL）。
        // release 构建不编译本分支，也不编译 run_e2e 及其命令面。
        if native_host::paths::is_e2e() {
            let code = match run_e2e() {
                Ok(code) => code,
                Err(error) => {
                    rust_error!("E2E 宿主启动失败 [{}] {}", error.code(), error);
                    70
                }
            };
            std::process::exit(code);
        }
    }
    let mode = if std::env::args().any(|arg| arg == "--smoke") {
        Mode::Smoke
    } else {
        Mode::Service
    };
    let code = match run(mode) {
        Ok(code) => code,
        Err(error) => {
            rust_error!("原生宿主启动失败 [{}] {}", error.code(), error);
            70
        }
    };
    std::process::exit(code);
}

fn run(mode: Mode) -> AppResult<i32> {
    // §4.3 第 1 步：路径与日志。AppPaths 是数据根唯一决定点；debug/release 分支
    // 都在 paths 模块里，这里只提供宿主环境（解析见下方各函数）。
    let env = host_environment()?;
    let resource_dir = env.resource_dir.clone();
    let paths = AppPaths::init(env)?;
    logger::init_file_sink(&paths.logs);
    rust_info!(
        "原生宿主启动（{}，pid={}，data={}）",
        paths.runtime_mode,
        std::process::id(),
        paths.data_root.display()
    );

    // W10b 更新域装配（幂等）：解析嵌入的更新元数据、推导安装布局、执行启动恢复
    // （把上次中断的替换收口：回滚到上一完整版本 / 补记完成）。失败只留痕、不阻断
    // 宿主启动；命令面与退出序列随后会如实报「未初始化」而不是静默降级。
    native_host::update::init(&paths);

    // 随包 Node 与 Harness 产物：缺失即失败，不静默落到系统 Node。
    let node_binary = node_binary_path(&resource_dir);
    let harness_entry = harness_entry_path(&resource_dir);
    ensure_runtime_files(&node_binary, &harness_entry)?;
    rust_info!("随包 Node: {}", node_binary.display());
    rust_info!("Harness 入口: {}", harness_entry.display());

    // 引导分派器必须在 start() 前交给监督器：它会在桥的 I/O 任务启动前注入，
    // Node 握手后的第一条请求不会是「未接线」。
    let (paths_answered_tx, paths_answered_rx) = std_mpsc::sync_channel::<()>(1);
    // 主线程 UI 任务队列与句柄（W5）：Service 模式由 `ui::start_service` 安装唤醒器；
    // `--smoke` 不建窗口，推送全局快捷键会如实报「原生 UI 尚未启动」。
    let ui_queue = MainThreadQueue::new();
    let ui_handle = UiHandle::new(ui_queue.clone());
    let audio = native_host::audio::native_audio(ui_handle.clone());
    // W9b：宿主 → Node 请求面（设置/编辑器端口与拖动写回共用同一实例）。
    let host_link = Arc::new(native_host::ui::ports::HostLink::new());
    // 端口实现需要 profiles 根（数据根唯一决定点；paths 随后移入分派器）。
    let profiles_root = paths.profiles.clone();

    // W4：宿主管理的子进程池与许可所有者。退出序（ServiceExitHook）与命令分派器
    // **共享同一批实例** —— Bash/MCP 命令跑在分派器持有的池上，退出钩子回收的
    // 必须就是它们（否则回收的是空池，留下孤儿进程）。
    // data_dir 供 MCP 托管直启的管理目录（`<data_root>/mcp/npm/…`）：与 AppPaths 同源。
    let mcp_pool = Arc::new(
        McpPool::with_node_runtime(
            native_host::commands::runtime_command::NodeRuntimePaths::from_resource_dir(
                &resource_dir,
            ),
        )
        .with_data_dir(paths.data_root.clone()),
    );
    let bash_pool = Arc::new(BashPool::default());
    let permit_pool = Arc::new(ToolPermitPool::default());

    let launch = LaunchInfo {
        // 端点与一次性握手值由监督器按代创建，这里只携带 Node 与入口路径。
        endpoint: String::new(),
        handshake: String::new(),
        node_binary,
        entry: harness_entry,
    };
    let config = SupervisorConfig::new(
        launch,
        env!("CARGO_PKG_VERSION"),
        random_hex(16)?,
        locked_node_version()?,
    );
    let supervisor = Arc::new(NodeSupervisor::new(config)?);

    // 统一退出序列（执行契约 §4.3 第 5 条）：托盘/系统终止经 UI 的 HostExitHook，
    // 命令侧 `app_restart` 经 LifecyclePort —— 两条路径都到这里，只收尾一次。
    let exit_once = Arc::new(ExitOnceHook::new(Arc::new(ServiceExitHook {
        supervisor: supervisor.clone(),
        mcp: mcp_pool.clone(),
        bash: bash_pool.clone(),
    })));

    // W4 端口实现：资源授权表（启动时把 profiles 根整目录授权）、
    // 原生文件对话框（macOS 主线程 / Windows 专用线程）、生命周期。
    let assets = Arc::new(NativeAssetScope::new());
    assets
        .allow_directory(&profiles_root, true)
        .map_err(|error| AppError::Other(format!("profiles 资源目录授权失败: {error}")))?;
    // 粘贴落盘的进程级端口（数据根 + 预览授权表）：聊天输入框的粘贴入口
    // （`ui/chat/paste.rs` 的 `add_pasted_image`）经它取用。授权表与上面
    // `assets` 是同一个实例，落盘后的预览授权与截图走同一张表。
    // E2E / `--smoke` 宿主不建原生 UI、粘贴不可达，故只在服务模式装配。
    native_host::ui::chat::paste::install_paste_ports(native_host::ui::chat::paste::PastePorts {
        data_root: paths.data_root.clone(),
        assets: assets.clone(),
    });
    let dialogs = Arc::new(NativeFileDialog::new(ui_handle.clone()));
    let lifecycle = Arc::new(NativeLifecycle::new(ui_handle.clone(), exit_once.clone()));
    native_host::ui::settings::updates::install(ui_handle.clone(), lifecycle.clone());
    let windows: Arc<dyn WindowPort> = Arc::new(ui_handle.clone());
    // 观察总闸的唯一实例：命令面（set_monitor_enabled / 观察资格）与 monitor 工作线程
    // 共享同一份状态 —— 此前只有分派器持有一份、没有任何线程消费它（W4 缺口）。
    let monitor = Arc::new(MonitorState::default());

    // 完整命令矩阵分派器（W4）：产品宿主 principal = main。
    let native = Arc::new(NativeDispatcher::new(NativeDispatcherDeps {
        paths,
        caller: WindowId::Main,
        ui: ui_handle.clone(),
        windows: windows.clone(),
        monitor: monitor.clone(),
        mcp: mcp_pool,
        bash: bash_pool,
        permits: permit_pool,
        dialogs: dialogs.clone(),
        assets,
        lifecycle,
        host_link: host_link.clone(),
        audio: audio.clone(),
    }));

    let dispatcher: Arc<dyn CommandDispatcher> = Arc::new(BootstrapDispatcher {
        native,
        paths_answered: paths_answered_tx,
    });
    supervisor.set_bootstrap_dispatcher(dispatcher);

    match mode {
        Mode::Smoke => {
            // 试验模式保持无 UI 的最小语义（不建任何窗口），退出码契约不变。
            let handshake = supervisor.start()?;
            rust_info!(
                "Node 握手完成: node={} nodeEpoch={} appEpoch={} pid={:?}",
                handshake.node_version,
                handshake.node_epoch,
                handshake.app_epoch,
                handshake.pid
            );
            run_smoke(&supervisor, paths_answered_rx)
        }
        Mode::Service => run_service_mode(
            supervisor,
            ui_queue,
            host_link,
            profiles_root,
            exit_once,
            monitor,
            windows,
            dialogs,
            audio,
        ),
    }
}

/// 服务模式（W5）：原生 UI 先行（建主窗 → 托盘 → 快捷键等待 Node 推送），
/// UI 就绪后再由后台线程拉起 Node 并常驻观察退出；托盘「退出」走统一退出序列。
///
/// Node 的握手不再是启动条件：UI 与 Node 解耦（契约 §4.3 第 3 条 —— Node 忙碌/
/// 未就绪时快捷键与窗口显隐仍由 Rust 本地完成）。启动顺序按契约 §4.3 第 1 步：
/// 路径 → 窗口/托盘 → Node。
#[allow(clippy::too_many_arguments)]
fn run_service_mode(
    supervisor: Arc<NodeSupervisor>,
    ui_queue: Arc<MainThreadQueue>,
    host_link: Arc<native_host::ui::ports::HostLink>,
    profiles_root: PathBuf,
    exit_once: Arc<ExitOnceHook>,
    monitor: Arc<MonitorState>,
    windows: Arc<dyn WindowPort>,
    dialogs: Arc<dyn FileDialogPort>,
    audio: Arc<dyn native_host::audio::AudioPort>,
) -> AppResult<i32> {
    // W10b 自动入口（§4.5）：启动延迟的自动检查，与手动入口（设置页）共用同一
    // UpdatePort（`update::handle_command("update_check")`）；只调度、不阻塞启动，
    // 检查结果只留痕 —— 用户确认/下载安装的交互属 W10c（见 update/mod.rs）。
    // `--smoke` 与 E2E 不经过本函数：试验/测试模式保持无网络行为语义。
    native_host::ui::settings::updates::schedule_startup();

    let supervisor_for_worker = supervisor.clone();
    // 首次拉起失败时由宿主直接写顶栏「服务未连接」（Err 分支；理由见该处注释）。
    // `ui_queue` 稍后要移进 `ServiceRequest`，这里先克隆一份给 hook。
    let ui_queue_for_worker = ui_queue.clone();
    let on_ui_ready: Box<dyn FnOnce() + Send> = Box::new(move || {
        match supervisor_for_worker.start() {
            Ok(handshake) => rust_info!(
                "Node 握手完成: node={} nodeEpoch={} appEpoch={} pid={:?}",
                handshake.node_version,
                handshake.node_epoch,
                handshake.app_epoch,
                handshake.pid
            ),
            Err(error) => {
                rust_error!("Node 启动失败: {error}");
                // 首次拉起失败：Node 不在则没有推送者，顶栏会停在缺省「就绪」而实际
                // 服务不可用（本轮排查发现的可见性缺口），由宿主直接写一条中性文案
                // （`SERVICE_UNAVAILABLE_TEXT`：只陈述「本进程没拉起 Node」这一可确知
                // 的事实，非角色口吻、不谎报在线）。
                //
                // 本 hook 跑在 `deskpet-node-start` 专用线程（`platform/macos.rs` /
                // `platform/windows.rs` 的 `ready_hook` spawn）；`build_ui` 早期已安装
                // 主线程队列唤醒器，故 `run_on_main` 可用（UiHandle 只持队列、可跨线程）。
                // 写入失败只留痕，不影响启动流程与下方的常驻退出观察。
                // 此后 Node 一旦推送，其最终文本（唯一真值点仍在 Node 的
                // `services/titlebar`）会照常整体覆盖这条宿主自推文本。
                // 本轮只覆盖「首次拉起失败」；崩溃重启耗尽后的提示另案登记。
                let handle = UiHandle::new(ui_queue_for_worker);
                if let Err(error) = handle
                    .apply_titlebar_status(Some(ui::titlebar::SERVICE_UNAVAILABLE_TEXT.to_string()))
                {
                    rust_warn!("顶栏「服务未连接」文案写入失败: {error}");
                }
            }
        }
        // 常驻观察退出/重启事件（崩溃重启由监督器按策略接管）；退出序列由 UI 侧
        // 的 `ServiceExitHook` 调 `shutdown()`，本线程随进程退出结束。
        loop {
            if let Some(report) = supervisor_for_worker.wait_exit(Duration::from_secs(60 * 60)) {
                rust_warn!("Node 退出（crash={}）：{}", report.crash, report.detail);
                // wait_exit 返回的是已发生的退出记录；给自动重启留出代际轮换时间，
                // 避免在记录被新代际清空前忙等。
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    });

    // W9b：宿主 ↔ Node 端口接线（在 UI 启动前完成 —— 设置/编辑器窗打开时端口已就位）。
    {
        let supervisor_for_link = supervisor.clone();
        host_link.install_sender(Arc::new(move |event: &str, payload: Value| {
            let bridge = supervisor_for_link
                .current_bridge()
                .ok_or_else(|| AppError::Other("Node 尚未连接：宿主 → Node 请求无法投递".into()))?;
            let scope = bridge.default_scope();
            bridge.publish_event(event, payload, scope)
        }));
    }
    native_host::ui::ports::install_host_link(host_link.clone());
    native_host::ui::settings::install_port(Arc::new(
        native_host::ui::ports::SettingsPortImpl::new(host_link.clone()),
    ));
    native_host::ui::editor::install_port(Arc::new(native_host::ui::ports::EditorPortImpl::new(
        host_link,
        profiles_root,
        dialogs,
    )));

    // W4 缺口：宿主事件生产者。两条线程共用唯一事件出口（`EventSink`）：
    // - monitor：`set_monitor_enabled` 的开闸/关闸现在真的驱动这条线程（同一
    //   `MonitorState`）；平台事件源注册必须在 UI 主线程（macOS 的 NSWorkspace
    //   通知只在主线程投递），本函数在 `ui::start_service` 之前仍在主线程上执行；
    // - cursor：16ms 轮询、仅坐标变化时派发（含首帧）的既有语义原样保留。
    // 出口按 原生宿主迁移过程记录 §9.4 路由：光标只直投原生 UI（不进 Node），窗口观察双投
    // （原生 UI + 当前代际 Node）。
    let events: Arc<dyn EventSink> = Arc::new(HostEventRouter::new(
        supervisor.clone(),
        Arc::new(native_host::ui::stage::StageNativeEvents),
    ));
    native_host::monitor::spawn_monitor_thread(events.clone(), windows, monitor);
    native_host::commands::cursor::spawn_cursor_tracker(events);

    let request = ServiceRequest {
        queue: ui_queue,
        // 与命令侧 `app_restart` 共用同一份只跑一次的退出钩子（W4）。
        exit_hook: exit_once,
        audio: Some(audio),
        e2e: cfg!(debug_assertions) && native_host::paths::is_e2e(),
        on_ui_ready: Some(on_ui_ready),
    };
    ui::start_service(request)
}

/// 退出序列（执行契约 §4.3 第 5 条）：托盘「退出」与系统终止共用的钩子。
/// 托盘退出不经过任何前端钩子 —— 只靠前端会留下一批常驻的 npx / node；
/// 子进程回收必须由宿主在退出路径上完成。
struct ServiceExitHook {
    supervisor: Arc<NodeSupervisor>,
    mcp: Arc<McpPool>,
    bash: Arc<BashPool>,
}

impl HostExitHook for ServiceExitHook {
    fn run(&self) {
        // ① 宿主管理的子进程先回收：MCP 与 Bash 池（执行契约 §4.3 第 5 条）。
        // Bash 池的 `kill_all` 自带「先封新执行、再杀」竞态策略（见 bash.rs）：
        // 封闸后到达的执行请求被拒绝，不会在 Node 停机期间产生孤儿；封闸前已登记的
        // 运行要么被当场终止，要么在 spawn 回填点自取消。两个 kill_all 都幂等，
        // 满足 `HostExitHook` 多次到达的约束。
        self.mcp.kill_all();
        self.bash.kill_all();
        // ② Node：封 admission → 请求 flush → 等真实报告 → 停 Node；超时如实记中断。
        let report = self.supervisor.shutdown();
        log_shutdown_report(&report);
        // ③ W10b 更新安装的落位：到这里 Node/插件/MCP 已全部回收，若本次会话把更新
        // staging 完成（phase=staged），由 helper 在整套进程退出后替换安装目录并重启。
        // 没有 staged 更新时是 no-op；helper 拉起失败只留痕、不替换任何文件。
        native_host::update::on_host_exit();
    }
}

/// `--smoke`：等首次 `get_runtime_paths` 被应答 → 完整关停序列 → 报告与退出码。
fn run_smoke(
    supervisor: &NodeSupervisor,
    paths_answered: std_mpsc::Receiver<()>,
) -> AppResult<i32> {
    let bootstrap_seen = paths_answered.recv_timeout(SMOKE_BOOTSTRAP_TIMEOUT).is_ok();
    if bootstrap_seen {
        rust_info!("--smoke：get_runtime_paths 已被分派并应答");
        std::thread::sleep(SMOKE_SETTLE);
    } else {
        rust_error!(
            "--smoke：{:?} 内未观察到 get_runtime_paths",
            SMOKE_BOOTSTRAP_TIMEOUT
        );
    }
    let report = supervisor.shutdown();
    log_shutdown_report(&report);
    let flushed = report
        .node_flush
        .as_ref()
        .map(|flush| flush.flushed)
        .unwrap_or(false);
    let clean = bootstrap_seen && flushed && !report.interrupted;
    rust_info!(
        "--smoke 汇总：bootstrap={bootstrap_seen} flushed={flushed} interrupted={}",
        report.interrupted
    );
    Ok(if clean {
        0
    } else if bootstrap_seen {
        2
    } else {
        1
    })
}

fn log_shutdown_report(report: &ShutdownReport) {
    match &report.node_flush {
        Some(flush) => rust_info!(
            "关停 flush 报告: flushed={} pending={} {}",
            flush.flushed,
            flush.pending,
            flush.detail.as_deref().unwrap_or("")
        ),
        None => rust_error!("关停未收到 flush 报告（如实记中断）"),
    }
    if report.forced_kill {
        rust_warn!("关停走了强杀路径");
    }
    rust_info!(
        "关停结果: interrupted={} {}",
        report.interrupted,
        report.detail
    );
}

// ==========================================
// 引导分派器（W4：完整命令矩阵 + 引导应答信号）
// ==========================================

/// 引导分派器：W4 的完整命令矩阵（[`NativeDispatcher`]）加一层引导期职责 ——
/// 首次应答 `get_runtime_paths` 时向 `--smoke` 发试验信号（响应内容与 Node 侧
/// `RuntimePathsPayload` 逐字段同形，唯一构造点在 `host/dispatch.rs`）。
///
/// 除该信号外不存在任何分派特例：引导子集与「未接线」分支已随 W4 收敛，
/// 未覆盖命令一律由 [`NativeDispatcher`] 如实报出（不静默忽略）。
struct BootstrapDispatcher {
    native: Arc<NativeDispatcher>,
    /// 首次应答成功的试验信号（`--smoke` 用；满了即丢，不阻塞分派线程）。
    paths_answered: std_mpsc::SyncSender<()>,
}

impl CommandDispatcher for BootstrapDispatcher {
    fn dispatch(
        &self,
        ctx: &DispatchContext,
        args: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        if ctx.method == "get_runtime_paths" {
            let value = self.native.runtime_paths();
            let _ = self.paths_answered.try_send(());
            return Ok(value);
        }
        self.native.dispatch(ctx, args)
    }
}

// ==========================================
// 宿主环境解析（宿主侧平台解析）
// ==========================================

/// 解析宿主环境。`AppPaths` 只消费结果，不询问任何 UI 框架（契约 §3）。
fn host_environment() -> AppResult<HostEnvironment> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Config(format!("解析可执行文件路径失败: {e}")))?;
    let resource_dir = if cfg!(debug_assertions) {
        // 开发期优先用工作区内的随包资源（仅 debug 构建走此分支；不复制默认值）。
        let dev = workspace_root().join(DEV_RESOURCE_SUBDIR);
        if dev.exists() {
            dev
        } else {
            packaged_resource_dir(&exe)
        }
    } else {
        packaged_resource_dir(&exe)
    };
    Ok(HostEnvironment {
        app_data_dir: app_local_data_dir()?,
        resource_dir,
        workspace_root: if cfg!(debug_assertions) {
            Some(workspace_root())
        } else {
            None
        },
        config_template: CONFIG_TEMPLATE,
    })
}

/// 开发工作区根。仅 debug 构建使用：本 crate 位于 `<root>/crates/native-host`。
///
/// 职责：从 `env!("CARGO_MANIFEST_DIR")` 推出仓库根（该值指本 crate，
/// 上两级即仓库根）；release 路径不经过它。
fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or(manifest)
}

/// 打包布局下的随包资源根：
/// - macOS `.app`：可执行文件在 `Contents/MacOS/`，资源在 `Contents/Resources/`；
/// - Windows（NSIS 安装目录）：资源与可执行文件同目录。
fn packaged_resource_dir(exe: &Path) -> PathBuf {
    let exe_dir = exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        if exe_dir.file_name().and_then(|name| name.to_str()) == Some("MacOS") {
            if let Some(contents) = exe_dir.parent() {
                let resources = contents.join("Resources");
                if resources.is_dir() {
                    return resources;
                }
            }
        }
    }
    exe_dir
}

/// 应用本地数据根（release）：与 Tauri `app_local_data_dir()` 同口径 ——
/// `{用户数据目录}/{应用标识}`。debug 构建不使用本值（AppPaths 走工作区内开发根）。
///
/// W5/W10 换成平台 API（NSSearchPathForDirectoriesInDomains /
/// SHGetKnownFolderPath）后，本函数删除。
fn app_local_data_dir() -> AppResult<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or(AppError::NoHomeDir)?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| AppError::Config("缺少 LOCALAPPDATA 环境变量".into()))?;
        Ok(PathBuf::from(base).join(APP_IDENTIFIER))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(AppError::Config("原生宿主只支持 macOS 与 Windows".into()))
    }
}

/// 随包 Node 可执行文件（发行闭包布局与官方分发包一致）：
/// - macOS（tar 布局）：`node/bin/node`；
/// - Windows（zip 布局）：`node/node.exe`。
fn node_binary_path(resource_dir: &Path) -> PathBuf {
    let node = resource_dir.join("node");
    if cfg!(target_os = "windows") {
        node.join("node.exe")
    } else {
        node.join("bin").join("node")
    }
}

/// 唯一 Harness 入口（`src/harness/main.ts` 的 esbuild 产物 `main.mjs`）。
/// 资源落位见 `packaging/desktop.json` 的 resources 清单。
fn harness_entry_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("harness").join("main.mjs")
}

fn ensure_runtime_files(node_binary: &Path, harness_entry: &Path) -> AppResult<()> {
    if !node_binary.is_file() {
        return Err(AppError::Config(format!(
            "随包 Node 缺失：{}（发行闭包应含 node 可执行文件与 npm/npx CLI，见 packaging/node-runtime.json）",
            node_binary.display()
        )));
    }
    if !harness_entry.is_file() {
        return Err(AppError::Config(format!(
            "Harness 产物缺失：{}（先运行 pnpm run build:harness，资源清单见 packaging/desktop.json）",
            harness_entry.display()
        )));
    }
    Ok(())
}

// ==========================================
// E2E 私有测试通道（仅 debug 构建；见文件头「运行方式」）
// ==========================================
//
// 执行契约 §8 W11：`scripts/e2e-test.mjs` 作为命令入口，由启动器经私有测试通道
// 驱动宿主（见下）；不经任何前端页面。
//
// - 启动器在初始化前把隔离 root、合成 CONFIG、trial 身份与 attestation 写进私有
//   通道文件（`test/host/native/channel.mjs` 是写入侧与 schema 说明；本文件是宿主
//   读取侧，两者只共享一个 schemaVersion + 字段形状）。
// - 宿主在 `AppPaths::init` 之前读通道，启动后校验「通道 ↔ 实际加载环境」一致：
//   dataRoot 是隔离根、configPath 就是 AppPaths 选定的合成 CONFIG、结果/入口/Node
//   都在通道声明的位置。
// - Node 侧 test/e2e Scene runner 经 `e2e_options` 命令拿到同一批地址与过滤参数
//   （唯一中转方是宿主，测试命令不经产品命令面）。
// - 完成协议 = 「结果文件 + 进程退出码」：`e2e_complete` 先写 `e2e-result.txt` 再
//   回包，主线程收信号后走完整关停序列，退出码 0/1/3/2 见 `run_e2e`；启动器要求
//   两者同时成立才判通过（丢结果、超时、关停不干净都不得标通过）。
//
// release 构建不编译本节的任何符号；`e2e_trace` 另有 debug + is_e2e 双闸。

/// 私有测试通道文件路径的环境变量（节点由启动器注入；Node 不直接读取通道文件）。
#[cfg(debug_assertions)]
const E2E_CHANNEL_ENV: &str = "DESKPET_E2E_CHANNEL";

/// 通道 schema 版本。与 `test/host/native/channel.mjs` 的 `SCHEMA_VERSION` 同步。
#[cfg(debug_assertions)]
const E2E_CHANNEL_SCHEMA_VERSION: u32 = 1;

/// 私有测试通道。字段形状是启动器（写入）与宿主（读取）之间的一份 schema：
/// 新增字段同时改 `test/host/native/channel.mjs` 与 `E2eChannel`，并保持 camelCase。
#[cfg(debug_assertions)]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct E2eChannel {
    schema_version: u32,
    /// 本次运行（trial 集合）的唯一身份；写进结果与日志，报告据此绑定归属。
    trial_id: String,
    data_root: PathBuf,
    /// 合成 CONFIG 的绝对路径（必须等于 AppPaths 在 E2E 模式选定的 config_file）。
    config_path: PathBuf,
    /// 结果文件（`<dataRoot>/e2e-result.txt`；宿主在 e2e_complete 时写入）。
    result_path: PathBuf,
    /// 唯一 Node 的入口：test/e2e Scene runner 的 esbuild 产物。
    harness_entry: PathBuf,
    /// 随包 Node 可执行文件（版本由监督器按 node-runtime.json 校验）。
    node_binary: PathBuf,
    /// 过滤参数与测试侧模型覆盖（键清单由启动器按 test/e2e/cli.ts 写全，宿主原样转交）。
    #[serde(default)]
    options: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    attestation: E2eAttestation,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct E2eAttestation {
    commit: Option<String>,
    source_hashes: Option<String>,
    seed_hash: Option<String>,
}

#[cfg(debug_assertions)]
impl E2eChannel {
    /// `e2e_options` 的应答载荷：启动器写定的选项原样转交，附上通道身份与 attestation。
    /// 宿主不维护键清单（唯一清单在启动器与 `test/e2e/cli.ts`），也不改写任何值。
    fn options_payload(&self) -> serde_json::Value {
        let mut out = self.options.clone();
        if let Some(commit) = &self.attestation.commit {
            out.insert("commit".into(), serde_json::Value::String(commit.clone()));
        }
        if let Some(hashes) = &self.attestation.source_hashes {
            out.insert(
                "sourceHashes".into(),
                serde_json::Value::String(hashes.clone()),
            );
        }
        if let Some(seed) = &self.attestation.seed_hash {
            out.insert("seedHash".into(), serde_json::Value::String(seed.clone()));
        }
        out.insert(
            "trialId".into(),
            serde_json::Value::String(self.trial_id.clone()),
        );
        serde_json::Value::Object(out)
    }
}

/// E2E 引导分派器：E2E 私有测试协议 + W4 完整命令矩阵委托。
///
/// 只截三条宿主级测试协议（`e2e_options` / `e2e_trace` / `e2e_complete`，
/// 它们需要本文件持有的私有测试通道）；其余命令（含 `get_runtime_paths`、配置、
/// 日志、会话 UI 状态与全部产品命令）委托给 [`NativeDispatcher`]（principal = e2e），
/// **不在这里复制第二份实现**。
#[cfg(debug_assertions)]
struct E2eDispatcher {
    channel: E2eChannel,
    completion: std_mpsc::Sender<bool>,
    /// 完成信号只接受一次：重复 e2e_complete 按错误如实报，不覆盖已完成结论。
    completed: std::sync::atomic::AtomicBool,
    /// W4：完整产品命令矩阵（caller = E2e）；e2e_trace 的路径也从它取（同一决定点）。
    native: Arc<NativeDispatcher>,
}

#[cfg(debug_assertions)]
impl CommandDispatcher for E2eDispatcher {
    fn dispatch(
        &self,
        ctx: &DispatchContext,
        args: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        match ctx.method.as_str() {
            "e2e_options" => Ok(self.channel.options_payload()),
            "e2e_trace" => {
                let chunk = args
                    .get("chunk")
                    .cloned()
                    .ok_or_else(|| AppError::Config("e2e_trace 缺少 chunk 参数".into()))?;
                let chunk: TraceChunk = serde_json::from_value(chunk).map_err(|error| {
                    AppError::Tool(format!("e2e_trace chunk 解析失败: {error}"))
                })?;
                let ack = e2e_trace::e2e_trace(self.native.paths(), chunk)?;
                serde_json::to_value(ack)
                    .map_err(|error| AppError::Other(format!("e2e_trace ACK 序列化失败: {error}")))
            }
            "e2e_complete" => self.complete(args),
            _ => self.native.dispatch(ctx, args),
        }
    }
}

#[cfg(debug_assertions)]
impl E2eDispatcher {
    /// 完成协议：结果先落盘、后回包、最后通知主线程走关停。
    fn complete(&self, args: serde_json::Value) -> AppResult<serde_json::Value> {
        let passed = args
            .get("passed")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| AppError::Config("e2e_complete 缺少 passed".into()))?;
        let report = args
            .get("report")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Config("e2e_complete 缺少 report".into()))?;
        if self
            .completed
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(AppError::Other(
                "e2e_complete 重复调用；已完成结论不覆盖".into(),
            ));
        }
        // 结果文件格式固定为「首行 PASS/FAIL + 报告正文」：启动器按它 + 退出码判通过。
        let content = format!("{}\n{}", if passed { "PASS" } else { "FAIL" }, report);
        std::fs::write(&self.channel.result_path, content).map_err(|error| {
            AppError::Io(format!(
                "写入 E2E 结果文件失败 {:?}: {error}",
                self.channel.result_path
            ))
        })?;
        // 报告同时进宿主日志：结果文件由启动器留存，日志留终端现场。
        logger::emit_frontend(&format!(
            "[E2E] completed passed={passed} trial={}\n{report}",
            self.channel.trial_id
        ));
        self.completion
            .send(passed)
            .map_err(|_| AppError::Other("E2E 完成信号无法送达主线程".into()))?;
        Ok(serde_json::Value::Null)
    }
}

/// E2E 主流程：初始化前收通道 → 校验 → 拉起 Scene runner → 等完成 → 关停 → 退出码。
///
/// 退出码协议（对启动器）：0 = 完成且关停干净；1 = 报告失败；2 = Node 在完成前
/// 退出（崩溃）；3 = 报告通过但关停未干净（结果可能不完整）；70 = 启动失败。
#[cfg(debug_assertions)]
fn run_e2e() -> AppResult<i32> {
    let channel = load_e2e_channel()?;
    let env = host_environment()?;
    let resource_dir = env.resource_dir.clone();
    let paths = AppPaths::init(env)?;
    logger::init_file_sink(&paths.logs);
    validate_e2e_channel(&channel, &paths)?;
    rust_info!(
        "E2E 原生宿主启动：trial={} pid={} data={}",
        channel.trial_id,
        std::process::id(),
        paths.data_root.display()
    );
    rust_info!(
        "E2E 合成 CONFIG: {}；Scene runner 入口: {}；随包 Node: {}",
        channel.config_path.display(),
        channel.harness_entry.display(),
        channel.node_binary.display()
    );

    let (completion_tx, completion_rx) = std_mpsc::channel::<bool>();

    let launch = LaunchInfo {
        // 端点与一次性握手值由监督器按代创建，这里只携带 Node 与入口路径。
        endpoint: String::new(),
        handshake: String::new(),
        node_binary: channel.node_binary.clone(),
        entry: channel.harness_entry.clone(),
    };
    let mut config = SupervisorConfig::new(
        launch,
        env!("CARGO_PKG_VERSION"),
        random_hex(16)?,
        locked_node_version()?,
    );
    // E2E 崩溃即失败：自动重启会重跑整套场景并污染结果文件与 trace，必须关掉。
    config.restart.enabled = false;
    let supervisor = Arc::new(NodeSupervisor::new(config)?);

    // W4：E2E 宿主也接完整命令矩阵（caller = e2e；截图/许可/memory actor
    // 门禁按 e2e principal 终裁）。不建原生 UI，
    // UiHandle 没有唤醒器 —— 触达窗口的命令会如实报「原生 UI 尚未启动」。
    let ui_queue = MainThreadQueue::new();
    let ui_handle = UiHandle::new(ui_queue);
    let windows: Arc<dyn WindowPort> = Arc::new(ui_handle.clone());
    // data_dir 供 MCP 托管直启的管理目录（`<data_root>/mcp/npm/…`）：与 AppPaths 同源。
    let mcp_pool = Arc::new(
        McpPool::with_node_runtime(
            native_host::commands::runtime_command::NodeRuntimePaths::from_resource_dir(
                &resource_dir,
            ),
        )
        .with_data_dir(paths.data_root.clone()),
    );
    let bash_pool = Arc::new(BashPool::default());
    let exit_once = Arc::new(ExitOnceHook::new(Arc::new(ServiceExitHook {
        supervisor: supervisor.clone(),
        mcp: mcp_pool.clone(),
        bash: bash_pool.clone(),
    })));
    let assets = Arc::new(NativeAssetScope::new());
    assets
        .allow_directory(&paths.profiles, true)
        .map_err(|error| AppError::Other(format!("profiles 资源目录授权失败: {error}")))?;
    let native = Arc::new(NativeDispatcher::new(NativeDispatcherDeps {
        paths,
        caller: WindowId::E2e,
        ui: ui_handle.clone(),
        windows,
        monitor: Arc::new(MonitorState::default()),
        mcp: mcp_pool,
        bash: bash_pool,
        permits: Arc::new(ToolPermitPool::default()),
        dialogs: Arc::new(NativeFileDialog::new(ui_handle.clone())),
        assets,
        lifecycle: Arc::new(NativeLifecycle::new(ui_handle.clone(), exit_once)),
        host_link: Arc::new(native_host::ui::ports::HostLink::new()),
        audio: native_host::audio::native_audio(ui_handle),
    }));

    let dispatcher: Arc<dyn CommandDispatcher> = Arc::new(E2eDispatcher {
        channel: channel.clone(),
        completion: completion_tx,
        completed: std::sync::atomic::AtomicBool::new(false),
        native,
    });
    supervisor.set_bootstrap_dispatcher(dispatcher);

    let handshake = supervisor.start()?;
    rust_info!(
        "E2E Node 握手完成：node={} nodeEpoch={} appEpoch={} pid={:?}",
        handshake.node_version,
        handshake.node_epoch,
        handshake.app_epoch,
        handshake.pid
    );

    let mut completion: Option<bool> = None;
    loop {
        match completion_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(passed) => {
                completion = Some(passed);
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if matches!(
                    supervisor.status(),
                    NodeStatus::Stopped | NodeStatus::Crashed { .. }
                ) {
                    rust_error!(
                        "E2E Node 在完成协议前退出（status={:?}）：本次运行按失败处理",
                        supervisor.status()
                    );
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let shutdown = supervisor.shutdown();
    log_shutdown_report(&shutdown);
    let clean = !shutdown.interrupted
        && shutdown
            .node_flush
            .as_ref()
            .map(|flush| flush.flushed)
            .unwrap_or(false);
    let code = match completion {
        Some(true) if clean => 0,
        Some(true) => {
            rust_error!("E2E 报告通过但关停未干净（flush 中断/未回报），按失败退出");
            3
        }
        Some(false) => 1,
        None => 2,
    };
    rust_info!("E2E 宿主退出：passed={completion:?} clean={clean} exitCode={code}");
    Ok(code)
}

/// 初始化前读取私有测试通道。缺失/损坏/版本不符都**直接失败**：
/// 静默降级为「普通开发宿主」会让 E2E 落到真实开发根与真实 CONFIG 上。
#[cfg(debug_assertions)]
fn load_e2e_channel() -> AppResult<E2eChannel> {
    let path = std::env::var(E2E_CHANNEL_ENV)
        .map_err(|_| AppError::Config(format!("E2E 运行缺少私有测试通道（{E2E_CHANNEL_ENV}）")))?;
    let text = std::fs::read_to_string(&path)
        .map_err(|error| AppError::Config(format!("读取 E2E 测试通道失败 {path}: {error}")))?;
    let channel: E2eChannel = serde_json::from_str(&text)
        .map_err(|error| AppError::Config(format!("E2E 测试通道解析失败: {error}")))?;
    if channel.schema_version != E2E_CHANNEL_SCHEMA_VERSION {
        return Err(AppError::Config(format!(
            "E2E 测试通道 schemaVersion={} 不受支持（期望 {E2E_CHANNEL_SCHEMA_VERSION}）",
            channel.schema_version
        )));
    }
    if channel.trial_id.trim().is_empty() {
        return Err(AppError::Config("E2E 测试通道缺少 trialId".into()));
    }
    Ok(channel)
}

/// 校验「通道声明 ↔ 实际加载环境」一致：通道不得指向别处，隔离 root 与合成 CONFIG
/// 必须就是 AppPaths 正在使用的这一份（错配会在写结果/拉起 Node 前暴露）。
#[cfg(debug_assertions)]
fn validate_e2e_channel(channel: &E2eChannel, paths: &AppPaths) -> AppResult<()> {
    let root = paths
        .data_root
        .canonicalize()
        .map_err(|error| AppError::Config(format!("解析 E2E 隔离根失败: {error}")))?;
    let channel_root = channel
        .data_root
        .canonicalize()
        .map_err(|error| AppError::Config(format!("通道 dataRoot 不可解析: {error}")))?;
    if channel_root != root {
        return Err(AppError::Config(
            "E2E 通道 dataRoot 与环境隔离根（DESKPET_E2E_DATA_ROOT）不一致".into(),
        ));
    }
    let channel_path = std::env::var(E2E_CHANNEL_ENV)
        .map_err(|_| AppError::Config("E2E 运行缺少私有测试通道".into()))?;
    let channel_parent = Path::new(&channel_path)
        .parent()
        .ok_or_else(|| AppError::Config("E2E 测试通道文件没有父目录".into()))?
        .canonicalize()
        .map_err(|error| AppError::Config(format!("解析通道文件目录失败: {error}")))?;
    if channel_parent != root {
        return Err(AppError::Config("E2E 测试通道文件必须位于隔离根内".into()));
    }

    let config = paths
        .config_file
        .canonicalize()
        .map_err(|error| AppError::Config(format!("E2E 合成 CONFIG 不存在: {error}")))?;
    let channel_config = channel
        .config_path
        .canonicalize()
        .map_err(|error| AppError::Config(format!("通道 configPath 不可解析: {error}")))?;
    if channel_config != config {
        return Err(AppError::Config(
            "通道 configPath 与 AppPaths 实际加载的合成 CONFIG 不一致".into(),
        ));
    }

    if channel
        .result_path
        .file_name()
        .and_then(|name| name.to_str())
        != Some("e2e-result.txt")
    {
        return Err(AppError::Config(
            "E2E 结果文件名必须是 e2e-result.txt".into(),
        ));
    }
    let result_parent = channel
        .result_path
        .parent()
        .ok_or_else(|| AppError::Config("E2E 结果文件没有父目录".into()))?
        .canonicalize()
        .map_err(|error| AppError::Config(format!("解析结果文件目录失败: {error}")))?;
    if result_parent != root {
        return Err(AppError::Config("E2E 结果文件必须落在隔离根内".into()));
    }

    if !channel.harness_entry.is_file() {
        return Err(AppError::Config(format!(
            "E2E Scene runner 入口不存在: {}",
            channel.harness_entry.display()
        )));
    }
    if !channel.node_binary.is_file() {
        return Err(AppError::Config(format!(
            "E2E 随包 Node 不存在: {}",
            channel.node_binary.display()
        )));
    }
    Ok(())
}

// ==========================================
// 小工具
// ==========================================

fn locked_node_version() -> AppResult<String> {
    let parsed: serde_json::Value = serde_json::from_str(NODE_RUNTIME_LOCK)
        .map_err(|e| AppError::Config(format!("node-runtime.json 解析失败: {e}")))?;
    parsed
        .get("nodeVersion")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Config("node-runtime.json 缺少 nodeVersion".into()))
}

/// 宿主进程实例身份（appEpoch）的随机十六进制。
/// 与 `ipc::transport::random_hex` 同族，但那是 `pub(crate)` 的库内工具，
/// bin 目标是独立 crate 不可见；随机源同用系统熵源。
fn random_hex(byte_len: usize) -> AppResult<String> {
    let mut bytes = vec![0u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Other(format!("系统熵源不可用: {e}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
