//! 原生 UI 域（W5）：原生主窗/设置/图层编辑器/图片查看器、托盘、全局快捷键、
//! 呼出/收回状态机与音效接口。
//!
//! 路线已冻结为平台原生薄层（AppKit + Win32，见原生宿主迁移过程记录 §9.4 第 7/16–20/25 条），
//! 实机做法照 W0 探针（`crates/ui-probe`，**已随迁移完成删除**）搬 —— 原型只是参考
//! （它是唯一真跑过原生平台代码的东西，实机证据留在 `test/.tmp/ui-probe/`），
//! 产品实现全在本域；探针的冻结决定与实机结果见
//! `docs/history/implementation/原生宿主迁移过程记录-2026-10-04基线.md`。
//!
//! 组成：
//! - [`state`]：呼出/收回状态机、动画曲线、弹窗摆位 —— 纯逻辑，可在测试里直接驱动；
//! - [`shortcut`]：`configure_global_shortcut` 的组合解析与平台键码编译 —— 纯逻辑；
//! - [`chat`]：W8a 原生聊天域（受控富文本/输入 IME/消息列表/流式/图片占位）。
//!   **W9a 起聊天区在主窗内**（与角色层同窗合成），独立聊天窗只作为能力保留；
//! - [`stage`]：W9a 主窗角色舞台（W6a `Renderer` 的接入点 + 编辑器预览覆盖）；
//! - [`font`]：W9a 全局字体快照（`appearance.font` 的 Native 应用点，各窗口同源）；
//! - [`settings`]：W9a 原生设置窗域（表单 schema + 草稿/提交 + Node 设置端口）；
//! - [`editor`]：W9a 图层编辑器域（五层编辑草稿 + Profile I/O 端口）；
//! - [`platform`]：AppKit / Win32 真实现（窗口创建、托盘、Carbon/Win32 快捷键、
//!   帧计时器、主线程派发、聊天窗与查看器内容、设置/编辑器控件）。
//!
//! 线程纪律：**窗口与托盘只在 UI 主线程操作**。非主线程（IPC 分派线程、观察线程）
//! 一律经 [`UiHandle::run_on_main`] 投递到主线程执行并等待回执；AppKit 从后台线程
//! 直接调用会静默崩溃（原型 A 的教训，见原生宿主迁移过程记录 §9.4 第 17 条）。
//!
//! Node 侧不进本域：窗口显隐/层级由原生 UI 自己驱动，Node 经命令面推送运行期状态
//! （快捷键、字体、舞台、聊天列、弹窗摆位/尺寸等；执行契约 §6.2，命令登记在
//! `src/services/host/types.ts`）。

/// W8a 原生聊天域（富文本/输入 IME/消息列表/流式/图片占位）。
pub mod chat;
/// 系统剪贴板写入（UI 用户动作；macOS NSPasteboard / Windows 剪贴板 API 分段）。
pub mod clipboard;
/// W9a 图层编辑器域（五层编辑草稿 + Profile I/O 端口）。
pub mod editor;
/// W9a 全局字体快照（各窗口应用同一份 `appearance.font` 投影）。
pub mod font;
/// A3 窗口几何写回（用户改窗口尺寸/位置 → CONFIG；与 W9b 分隔条宽度写回同一请求面）。
pub mod geometry_writeback;
pub mod platform;
/// W9b 宿主 ↔ Node 桥接端口（设置/编辑器实现、宿主请求面与拖动写回）。
pub mod ports;
/// W9a 原生设置窗域（schema/草稿/提交 + 设置端口）。
pub mod settings;
pub mod shortcut;
/// W9a 主窗角色舞台（W6a 渲染器的接入点与预览覆盖）。
pub mod stage;
pub mod state;
pub mod theme;
/// A1 顶栏状态位（agent 状态文案；缺省「就绪」；窗口运行时状态，唯一真值仍在 Node 的 `services/titlebar`）。
pub mod titlebar;

use std::collections::VecDeque;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;
use std::time::Duration;

use crate::audio::AudioPort;
use crate::error::{AppError, AppResult};
use crate::host::{WindowId, WindowLevel, WindowPort, WindowVisibility};
use crate::rust_warn;

/// 非主线程经 [`UiHandle::run_on_main`] 等待回执的期限。
///
/// UI 主循环不转（启动前 / 关停中）时不能无限等待调用方（观察线程每秒都在取
/// 可见性）；超时如实回 `TIMEOUT`，不静默返回假值。
pub const MAIN_THREAD_JOB_TIMEOUT: Duration = Duration::from_secs(5);

/// 退出序列钩子：托盘「退出」与系统终止路径共用的唯一出口。
///
/// 实现必须自己保证幂等（多条退出路径可能先后到达）。执行顺序按执行契约 §4.3
/// 第 5 条：先回收宿主管理的子进程，再由监督器 flush 并停 Node，超时如实记中断。
pub trait HostExitHook: Send + Sync {
    fn run(&self);
}

/// UI 主线程任务队列。
///
/// 跨线程调用方把闭包推入队列并唤起主线程（平台唤醒器: macOS `dispatch_async_f`
/// 到主队列 / Windows `PostMessageW`）；主线程的冒泡回调调用 [`Self::drain`]。
/// 队列本身与平台无关，测试用假唤醒器直接验证顺序与唤醒次数。
pub struct MainThreadQueue {
    main_thread: ThreadId,
    jobs: Mutex<VecDeque<Box<dyn FnOnce() + Send>>>,
    waker: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl MainThreadQueue {
    /// 必须在 UI 主线程上创建（记录主线程身份，供 [`UiHandle`] 判定「是否已在
    /// 主线程」）。
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            main_thread: std::thread::current().id(),
            jobs: Mutex::new(VecDeque::new()),
            waker: Mutex::new(None),
        })
    }

    pub fn main_thread(&self) -> ThreadId {
        self.main_thread
    }

    /// 安装平台唤醒器（UI 启动时一次；此前投递的任务只入队不唤醒）。
    pub fn install_waker(&self, waker: Arc<dyn Fn() + Send + Sync>) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(waker);
    }

    pub fn has_waker(&self) -> bool {
        self.waker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 入队并唤起主线程。主线程自己调用时直接执行（避免自我等待）。
    pub fn push(&self, job: Box<dyn FnOnce() + Send>) {
        if std::thread::current().id() == self.main_thread {
            job();
            return;
        }
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(job);
        let waker = self.waker.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(waker) = waker {
            waker();
        }
    }

    /// 主线程执行全部积压任务。返回执行条数。
    pub fn drain(&self) -> usize {
        let mut count = 0;
        loop {
            let job = self
                .jobs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front();
            match job {
                Some(job) => {
                    job();
                    count += 1;
                }
                None => break,
            }
        }
        count
    }
}

/// 跨线程 UI 句柄。
///
/// 这是业务域（如观察线程）能拿到的唯一 UI 入口：所有窗口查询/操作都经主线程队列；
/// Node 侧推来的快捷键配置经 [`UiHandle::apply_global_shortcut`] 在主线程注册。
#[derive(Clone)]
pub struct UiHandle {
    queue: Arc<MainThreadQueue>,
}

impl UiHandle {
    pub fn new(queue: Arc<MainThreadQueue>) -> Self {
        Self { queue }
    }

    pub fn queue(&self) -> &Arc<MainThreadQueue> {
        &self.queue
    }

    /// 当前调用是否已在 UI 主线程。
    pub fn is_main_thread(&self) -> bool {
        std::thread::current().id() == self.queue.main_thread()
    }

    /// 在 UI 主线程执行任务并等待结果。
    ///
    /// 已在主线程时直接执行；否则入队 + 唤起 + 等回执（[`MAIN_THREAD_JOB_TIMEOUT`]）。
    /// UI 未启动（无唤醒器）时如实报错，不静默丢弃。
    pub fn run_on_main<T, F>(&self, job: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        if self.is_main_thread() {
            return Ok(job());
        }
        if !self.queue.has_waker() {
            return Err(AppError::Other(
                "原生 UI 尚未启动，无法派发主线程任务".into(),
            ));
        }
        let (tx, rx) = std_mpsc::sync_channel(1);
        self.queue.push(Box::new(move || {
            let _ = tx.send(job());
        }));
        rx.recv_timeout(MAIN_THREAD_JOB_TIMEOUT)
            .map_err(|_| AppError::Timeout)
    }

    /// 应用 Node 推送的全局快捷键（先注销旧注册再注册新的；重复调用即「修改快捷键」）。
    pub fn apply_global_shortcut(&self, shortcut: shortcut::PlatformShortcut) -> AppResult<()> {
        self.run_on_main(move || platform::imp::apply_global_shortcut(shortcut))?
    }

    /// 打开/前移一个附属窗口（设置/图层编辑器/查看器；不存在即创建）。
    pub fn open_window(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::open_aux_window(window))?
    }

    /// 关闭一个附属窗口（关闭即销毁并释放资源）。
    pub fn close_window(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::close_window(window))?
    }

    /// 设置弹窗摆位模式（跟随光标 / 固定位置；`set_popup_placement` 命令）。
    ///
    /// 数据来源是 CONFIG 的 `general.popup.mode` / `fixedPosition`；Rust 不读 CONFIG、
    /// 不复制默认值，由 Node 在启动握手后与设置保存后推送（`pushNativeUiState`）。
    /// `Fixed`（带坐标）下平台层**立即**把主窗摆到该坐标（越界 clamp 回屏幕内），
    /// 并把该次程序摆放记入写回抑制点 —— 应用位置不会触发 `set_popup_geometry` 的
    /// 位置写回；`Cursor` 与过渡态 `FixedAtCurrent`（配置里还没有坐标）只更新模式，
    /// 下一次呼出才按光标落位，用户随后拖动结束的写回照常落第一份坐标。
    /// 未推送前保持创建默认「跟随光标」。
    pub fn set_popup_placement(&self, mode: state::PlacementMode) -> AppResult<()> {
        self.run_on_main(move || platform::imp::set_popup_placement(mode))?
    }

    /// 应用弹窗默认尺寸（`general.popup.defaultSize`；`set_popup_size` 命令）。
    ///
    /// - 值来自 Node 的既有 getter（不复制默认值）；这里只挡无效值并约束到主窗
    ///   最小尺寸（与创建时的 min 约束同一常量 `window::MAIN_WINDOW_MIN_*`），
    ///   不复制设置 schema 的值域；
    /// - 平台层立即把主窗改为该尺寸（保持左上角不动），并把这次程序应用记入
    ///   写回抑制点：应用引起的 resize 边沿不会被当成用户拖动写回
    ///   `general.popup.defaultSize`（防「应用 → 写回 → 再应用」回路）。
    pub fn set_popup_size(&self, width: f64, height: f64) -> AppResult<()> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err(AppError::Config(format!(
                "弹窗尺寸无效（{width}×{height}）"
            )));
        }
        let width = width.max(crate::window::MAIN_WINDOW_MIN_WIDTH);
        let height = height.max(crate::window::MAIN_WINDOW_MIN_HEIGHT);
        self.run_on_main(move || platform::imp::set_popup_size(width, height))?
    }

    /// 应用全局字体快照（`appearance.font` 的 Native 投影，见 [`font`]）。
    ///
    /// 数据来源是 CONFIG；Rust 不读 CONFIG、不复制默认值，由 Node 侧接线推送。
    /// 各窗口（主窗/设置/编辑器/查看器/独立聊天窗）共享同一份快照；
    /// 族名缺失或查不到时用系统 fallback。
    pub fn apply_font_snapshot(&self, snapshot: font::FontSnapshot) -> AppResult<()> {
        self.run_on_main(move || platform::imp::apply_font_snapshot(snapshot))?
    }

    /// 应用界面主题（`appearance.theme` 的 Native 投影，见 [`theme`]）。
    ///
    /// 数据来源是 CONFIG；Rust 不读 CONFIG、不复制默认值，由 Node 侧接线推送。
    /// 非法值在 [`theme::normalize`] 收拢为默认（不写盘、不建旧值映射）。
    /// 同一主题重复推送不改代际、不触发重建；真正切换时才让平台层重绘，
    /// 并释放不属于新主题的纹理（「只加载选中的主题」，见 [`theme::release_unused_textures`]）。
    pub fn apply_theme(&self, raw: String) -> AppResult<()> {
        let id = theme::normalize(&raw);
        let switched = theme::store(id);
        if !switched {
            return Ok(());
        }
        theme::warm_up();
        self.run_on_main(move || platform::imp::apply_theme(id))?
    }

    /// 应用主窗舞台快照（当前 Profile 的五层 + 灵动参数；见 [`stage`]）。
    ///
    /// 数据来源是 Profile 与 `appearance`；由 Node 侧接线推送（W4/设置域）。
    pub fn apply_stage_profile(&self, profile: stage::StageProfile) -> AppResult<()> {
        self.run_on_main(move || platform::imp::apply_stage_profile(profile))?
    }

    /// 应用顶栏状态位文本（见 [`titlebar`]；`None` = 回到缺省「就绪」）。
    ///
    /// 数据来源是 Node 的 `src/services/titlebar.ts`（唯一真值点；Node 在
    /// `renderOwner()` 处推最终文本）。Rust 不重实现 owner/优先级仲裁、不读 CONFIG、
    /// 不落盘；未收到推送时保持缺省，重启归缺省。
    pub fn apply_titlebar_status(&self, text: Option<String>) -> AppResult<()> {
        let applied = titlebar::store(text);
        self.run_on_main(move || platform::imp::refresh_titlebar(applied))?
    }

    /// 主窗聊天列开合与宽度（`general.popup.chatWidth`；`None` = 未推送/不改变）。
    ///
    /// `open: Some(..)` 才改开合 —— 开合是窗口运行时状态（托盘/拖动），设置保存后
    /// 的宽度推送传 `None`，不会把用户刚收起的聊天列重新弹开。
    pub fn set_chat_panel(&self, open: Option<bool>, width: Option<f64>) -> AppResult<()> {
        self.run_on_main(move || platform::imp::set_chat_panel(open, width))?
    }
}

impl WindowPort for UiHandle {
    fn show(&self, window: WindowId, focus: bool) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_show(window, focus))?
    }

    fn hide(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_hide(window))?
    }

    fn focus(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_focus(window))?
    }

    fn set_level(&self, window: WindowId, level: WindowLevel) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_set_level(window, level))?
    }

    fn present(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_present(window))?
    }

    fn visibility(&self, window: WindowId) -> AppResult<WindowVisibility> {
        self.run_on_main(move || platform::imp::window_visibility(window))?
    }

    fn set_position(&self, window: WindowId, x: i32, y: i32) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_set_position(window, x, y))?
    }

    fn open_devtools(&self, window: WindowId) -> AppResult<()> {
        self.run_on_main(move || platform::imp::window_open_devtools(window))?
    }
}

/// UI 主线程内的同步端口：给必须在主线程执行的消费者用（如呼出路径里的
/// `commands::cursor::compute_popup_position`，它需要 `&dyn WindowPort` 做窗口增强）。
///
/// **只能在 UI 主线程调用**：平台实现会核对主线程身份，不在主线程时如实返回错误
/// （不会静默崩溃）。
pub(crate) struct MainThreadPort;

impl WindowPort for MainThreadPort {
    fn show(&self, window: WindowId, focus: bool) -> AppResult<()> {
        platform::imp::window_show(window, focus)
    }
    fn hide(&self, window: WindowId) -> AppResult<()> {
        platform::imp::window_hide(window)
    }
    fn focus(&self, window: WindowId) -> AppResult<()> {
        platform::imp::window_focus(window)
    }
    fn set_level(&self, window: WindowId, level: WindowLevel) -> AppResult<()> {
        platform::imp::window_set_level(window, level)
    }
    fn present(&self, window: WindowId) -> AppResult<()> {
        platform::imp::window_present(window)
    }
    fn visibility(&self, window: WindowId) -> AppResult<WindowVisibility> {
        platform::imp::window_visibility(window)
    }
    fn set_position(&self, window: WindowId, x: i32, y: i32) -> AppResult<()> {
        platform::imp::window_set_position(window, x, y)
    }
    fn open_devtools(&self, window: WindowId) -> AppResult<()> {
        platform::imp::window_open_devtools(window)
    }
}

/// 窗口创建时的层级（激活「设置/编辑器高于主窗、查看器高于主窗」的既有口径）。
///
/// 层级的唯一数值真值仍是 [`WindowLevel::macos_level`]；这里只做「哪个窗口用哪档」的
/// 映射。查看器目前与设置同档（高于主窗、不压过设置/编辑器），W7 定案查看器语义后
/// 若需单列再扩展 `WindowLevel`。
pub const fn creation_level(window: WindowId) -> WindowLevel {
    match window {
        WindowId::Main => WindowLevel::Main,
        // 聊天：产品形态在主窗内（主窗层级）；独立聊天窗能力沿用 W8a 的 Settings 档
        // （主窗之上、图层编辑器之下）。
        WindowId::Chat => WindowLevel::Settings,
        WindowId::Settings => WindowLevel::Settings,
        WindowId::LayerEditor => WindowLevel::LayerEditor,
        WindowId::Viewer => WindowLevel::Settings,
        WindowId::E2e => WindowLevel::Main,
    }
}

/// 服务模式启动参数（由 `main.rs` 装配；UI 在此之前不注册任何快捷键）。
pub struct ServiceRequest {
    /// UI 主线程任务队列（`main.rs` 在主线程创建；UI 启动时安装平台唤醒器）。
    pub queue: Arc<MainThreadQueue>,
    /// 退出序列钩子（托盘「退出」/系统终止时调用一次）。
    pub exit_hook: Arc<dyn HostExitHook>,
    /// 宿主侧提示音接口；`None` = 未接线（只留接口与平台实现位，见 `crate::audio`）。
    pub audio: Option<Arc<dyn AudioPort>>,
    /// E2E 宿主标志（macOS 激活策略 Regular；产品形态是 Accessory，见平台文件注释）。
    pub e2e: bool,
    /// UI 建好（窗口/托盘就绪）后立即执行的收尾（拉起 Node 的接线放这里，
    /// 保证「建主窗 → 托盘 → 快捷键待推送 → 拉起 Node」的顺序）。
    pub on_ui_ready: Option<Box<dyn FnOnce() + Send>>,
}

/// 启动产品形态的原生 UI 并进入事件循环（返回即退出，值即进程退出码）。
pub fn start_service(request: ServiceRequest) -> AppResult<i32> {
    // A2 接收端接线：聊天会话意图端口经进程级 HostLink 收发。HostLink 由 bootstrap
    // 在 `start_service` 之前安装（main.rs 的 `ports::install_host_link`）；尚未安装
    // 时保持未接线端口（首派发如实报错，不静默吞）。
    match ports::host_link() {
        Some(link) => chat::install_host_link_intent_port(link.clone()),
        None => rust_warn!("HostLink 未安装：聊天意图端口保持未接线（派发会如实报错）"),
    }
    platform::imp::run_service(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn 层级映射与既定窗口常量一致() {
        assert_eq!(creation_level(WindowId::Main), WindowLevel::Main);
        assert_eq!(creation_level(WindowId::Chat), WindowLevel::Settings);
        assert_eq!(creation_level(WindowId::Settings), WindowLevel::Settings);
        assert_eq!(
            creation_level(WindowId::LayerEditor),
            WindowLevel::LayerEditor
        );
        assert_eq!(creation_level(WindowId::Viewer), WindowLevel::Settings);
        // 数值唯一真值在 host::WindowLevel::macos_level。
        assert_eq!(creation_level(WindowId::Main).macos_level(), 1000);
        assert_eq!(creation_level(WindowId::Viewer).macos_level(), 1200);
    }

    #[test]
    fn 主线程队列按入队顺序执行并唤醒() {
        let queue = MainThreadQueue::new();
        let wakes = Arc::new(AtomicUsize::new(0));
        let wakes2 = wakes.clone();
        queue.install_waker(Arc::new(move || {
            wakes2.fetch_add(1, Ordering::SeqCst);
        }));

        let order = Arc::new(Mutex::new(Vec::new()));
        for i in 0..3u8 {
            let order = order.clone();
            queue.push(Box::new(move || {
                order.lock().unwrap_or_else(|e| e.into_inner()).push(i);
            }));
        }
        // 测试线程就是创建队列的「主线程」：push 直接执行，不唤醒。
        assert_eq!(
            *order.lock().unwrap_or_else(|e| e.into_inner()),
            vec![0, 1, 2]
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 0, "同线程 push 不应自我唤醒");

        // 从别的线程投递：入队 + 唤醒；drain 后按序执行。
        let queue2 = queue.clone();
        let order2 = order.clone();
        std::thread::spawn(move || {
            for i in 3..5u8 {
                let order = order2.clone();
                queue2.push(Box::new(move || {
                    order.lock().unwrap_or_else(|e| e.into_inner()).push(i);
                }));
            }
        })
        .join()
        .unwrap();
        assert_eq!(wakes.load(Ordering::SeqCst), 2, "跨线程 push 每次都要唤起");
        let drained = queue.drain();
        assert_eq!(drained, 2);
        assert_eq!(
            *order.lock().unwrap_or_else(|e| e.into_inner()),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn 跨线程句柄在未有唤醒器时如实报错() {
        let queue = MainThreadQueue::new();
        let handle = UiHandle::new(queue);
        // 本线程就是创建队列的「主线程」：直接执行，不走队列。
        assert!(handle.is_main_thread());
        assert_eq!(handle.run_on_main(|| 42).unwrap(), 42);

        // 另一线程在 UI 未启动（无唤醒器）时调用：必须如实报错而不是静默挂起。
        let worker = std::thread::spawn(move || handle.run_on_main(|| 7).is_err());
        assert!(worker.join().unwrap(), "无唤醒器时跨线程调用必须报错");
    }
}
