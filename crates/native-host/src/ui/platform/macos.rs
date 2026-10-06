//! macOS 原生薄层（AppKit）：主窗/设置/图层编辑器/查看器、`NSStatusItem` 托盘、
//! Carbon 全局快捷键、帧计时器与呼出/收回动画。
//!
//! 做法照 W0 探针的 macOS 窗口原型（`crates/ui-probe`，已随迁移完成删除；该原型
//! **实机跑通过**，是参考不是产品代码）；与原型的有意差异都就地注明：
//! - **设置/编辑器/查看器一律独立顶层窗**，不用 `addChildWindow`（协调者裁定，
//!   见原生宿主迁移过程记录 §9.4 第 18 条：为已 orderOut 的主窗添加子窗会把主窗带回屏幕）；
//! - 主窗类覆盖 `canBecomeKeyWindow`（无边框窗默认不能成为 key window，键盘与中文
//!   IME 收不到；原型 A 实测踩到，见 原生宿主迁移过程记录 §9.4 第 17 条）；
//! - 逐帧更新一律包在关闭隐式动画的 `CATransaction` 里（原生宿主迁移过程记录 §9.4 第 17 条）；
//! - 快捷键注册等待 Node 推送（`configure_global_shortcut`），收到前不注册任何键。
//!
//! 线程纪律：本文件的平台对象只允许在 UI 主线程触碰。跨线程调用方先经
//! `MainThreadQueue`（经 `dispatch2` 投递到主队列唤醒）派发；调用点若不在主线程，
//! 入口一律如实报错而不是静默崩溃。

use std::cell::{Cell, OnceCell, RefCell};
use std::ffi::c_void;
use std::sync::Arc;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadOnly, Message};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
    NSApplicationDelegate, NSBackingStoreType, NSColor, NSImage, NSMenu, NSMenuDelegate,
    NSMenuItem, NSRunningApplication, NSScreen, NSStatusBar, NSStatusItem,
    NSVariableStatusItemLength, NSWindow, NSWindowDelegate, NSWindowStyleMask, NSWorkspace,
};
use objc2_core_foundation::{CGAffineTransform, CGPoint, CGRect};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSData, NSNotification, NSObject, NSObjectProtocol, NSPoint,
    NSRect, NSSize, NSString, NSTimer,
};
use objc2_quartz_core::CATransaction;

use crate::audio::AudioCue;
use crate::error::{AppError, AppResult};
use crate::host::{WindowId, WindowLevel, WindowPort, WindowVisibility};
use crate::ui::geometry_writeback::AppliedSize;
use crate::ui::shortcut::PlatformShortcut;
use crate::ui::state::{
    clamp_window_origin, popup_auto_show, transform_origin, CommittedAssistantTracker, FrameVisual,
    PlacementMode, ScreenRect, ShowHideMachine, Stage, Tick,
};
use crate::ui::{HostExitHook, MainThreadQueue, ServiceRequest};
use crate::{rust_debug, rust_error, rust_info, rust_warn};

use super::super::MainThreadPort;
use super::{macos_editor, macos_main, macos_settings, macos_widgets, now_ms};

/// 帧计时器间隔：60fps（与原型一致；只在动画进行中挂载，hidden 期必须停表）。
const FRAME_INTERVAL: f64 = 1.0 / 60.0;

/// A3：窗口拖动结束的写回去抖窗口（秒）。拖动期间 `windowDidMove` 高频到达，
/// 每次重布一次性定时器，静置这么久才提交一次 `set_popup_geometry`。
const GEOMETRY_WRITEBACK_DEBOUNCE: f64 = 0.45;

// ==========================================
// Carbon 全局快捷键 FFI（系统公开 API；无需辅助功能权限，原型 A 实测）
// ==========================================

type OSStatus = i32;
type EventTargetRef = *mut c_void;
type EventRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHotKeyRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

const K_EVENT_CLASS_KEYBOARD: u32 = 0x6B657962; // 'keyb'
const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
const K_EVENT_PARAM_DIRECT_OBJECT: u32 = 0x2D2D2D2D; // '----'
const TYPE_EVENT_HOTKEY_ID: u32 = 0x686B6964; // 'hkid'
const HOTKEY_SIGNATURE: u32 = 0x44505742; // 'DPWB'（DeskPet Window Bindings）
const HOTKEY_ID: u32 = 1;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: Option<extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> OSStatus>,
        num_types: usize,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
        in_hot_key_code: u32,
        in_hot_key_modifiers: u32,
        in_hot_key_id: EventHotKeyID,
        in_target: EventTargetRef,
        in_options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(in_hot_key_ref: EventHotKeyRef) -> OSStatus;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        out_actual_type: *mut u32,
        buffer_size: usize,
        out_actual_size: *mut usize,
        data: *mut c_void,
    ) -> OSStatus;
}

// ==========================================
// 主线程唤醒：libdispatch 主队列（dispatch2 正规绑定）
// ==========================================
//
// 为什么不用手写 `extern "C"` 声明 dispatch_get_main_queue / dispatch_async_f：
// 该写法让本 crate 在链接期以 `Undefined symbols: _dispatch_get_main_queue` 失败
// （cargo check 通过，但产不出二进制；另加 `#[link(name = "System")]` 或
// `#[link(name = "dispatch")]` 均不解决——系统上没有可链的 libdispatch.dylib）。
// dispatch2 提供同一组 libdispatch API 的正规绑定（主队列取 `_dispatch_main_q`
// 数据符号），并自带 `#[link(name = "System", kind = "dylib")]`；实机验证可链接、
// 可运行。它是 objc2 家族（objc2-core-foundation 等）的既有传递依赖，提升为直接
// 依赖不引入新生态。

/// 主队列上的冒泡回调：清空积压的主线程任务。
///
/// `context` 是 [`Arc::into_raw`] 出来的 `Arc<MainThreadQueue>`（唤醒闭包每次唤醒
/// 克隆一份）：回调消费这一个引用计数后归零，与 into_raw 配对。
///
/// 所有权/释放时机在换用 dispatch2 后不变：`DispatchQueue::main().exec_async_f`
/// 与手写的 `dispatch_async_f` 是同一个 C 函数（dispatch2 只补绑定与链接属性），
/// context 仍由 dispatch 持有到主队列执行；回调内 `Arc::from_raw` 消费这一份克隆，
/// 引用计数精确归零——不提前释放、也不泄漏。
extern "C" fn drain_main_jobs(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let queue = unsafe { Arc::from_raw(context as *const MainThreadQueue) };
    let drained = queue.drain();
    if drained > 0 {
        rust_debug!("主线程任务队列清空 {drained} 条");
    }
    drop(queue);
}

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<UiController>>> = const { RefCell::new(None) };
}

pub(crate) fn with_controller<R>(f: impl FnOnce(&UiController) -> R) -> AppResult<R> {
    CONTROLLER.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|controller| f(controller))
            .ok_or_else(|| {
                AppError::Other("原生 UI 未在此线程初始化（窗口操作只能在 UI 主线程）".into())
            })
    })
}

/// 主窗句柄（跨模块用：独立聊天窗在前移主窗时取它）。
pub(crate) fn main_window_handle() -> Option<Retained<DeskPetWindow>> {
    with_controller(|controller| controller.main_window())
        .ok()
        .flatten()
}

/// 任意 ObjC 对象 → `&AnyObject`（target/action 等弱类型接口）。
pub(crate) fn as_any<T: Message>(obj: &T) -> &AnyObject {
    unsafe { &*(obj as *const T as *const AnyObject) }
}

/// 激活本应用（键盘/IME 焦点的必要一步）。
///
/// Accessory 激活策略下，窗口经 `makeKeyAndOrderFront` 只能成为本应用内的 key
/// window；应用本身不被激活就拿不到键盘与输入法焦点（用户报的「呼出后没有输入
/// 焦点」回归即此）。这与 `window/platform.rs::present_macos_window` 的激活调用
/// 同一语义；本文件内是唯一实现点，呼出（reveal）、窗口聚焦（window_focus）与
/// 聊天窗前移（macos_chat）共用，避免第三份复制。
pub(crate) fn activate_app() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // 沿用既有口径的 `activateIgnoringOtherApps:`（macOS 14 起改为协同激活模型，
    // 但旧调用仍被尊重且兼容旧系统）；新 `activate:` 只在 macOS 14+ 可用。
    let _: () = unsafe { msg_send![&*app, activateIgnoringOtherApps: true] };
}

/// 托盘模板图：用户素材的黑剪影（44px = 22pt @2x），编译期嵌入。
///
/// 不走资源根装配：为一张小图加一条分发链不划算（与主题噪声「能算就别打包」
/// 同口径的极简版）。模板图（template）由系统按菜单栏明暗模式自动染色。
fn tray_template_image() -> Option<Retained<NSImage>> {
    let data = NSData::with_bytes(include_bytes!("../../../../../resources/icons/mascot-tray-44.png"));
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    image.setSize(NSSize::new(22.0, 22.0));
    image.setTemplate(true);
    Some(image)
}

/// 关闭隐式动画后改 CALayer 属性（逐帧更新必须，原生宿主迁移过程记录 §9.4 第 17 条）。
fn without_implicit_animation<F: FnOnce()>(f: F) {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    f();
    CATransaction::commit();
}

/// 主显示器高度（AppKit 逻辑点，底左原点）；web 坐标→Cocoa 只差这一个常量。
pub(crate) fn primary_height(mtm: MainThreadMarker) -> f64 {
    let screens = NSScreen::screens(mtm);
    let first: Option<Retained<NSScreen>> = screens.firstObject();
    first.map(|s| s.frame().size.height).unwrap_or(0.0)
}

/// web 坐标（左上原点）→ AppKit（底左原点）的窗口 frame。
fn web_frame_to_cocoa(mtm: MainThreadMarker, x: f64, y: f64, w: f64, h: f64) -> NSRect {
    let y_cocoa = primary_height(mtm) - y - h;
    NSRect::new(NSPoint::new(x, y_cocoa), NSSize::new(w, h))
}

// ==========================================
// 窗口类：无边框窗必须覆盖 canBecomeKeyWindow
// ==========================================

define_class!(
    /// 产品窗口。唯一目的：覆盖 `canBecomeKeyWindow` —— 无边框 `NSWindow` 默认不能
    /// 成为 key window，键盘与中文 IME 会收不到（原型 A 实测，原生宿主迁移过程记录 §9.4 第 17 条）。
    ///
    /// `pub(crate)`：W8a 的聊天窗（`platform/macos_chat.rs`）复用本窗口类与
    /// [`new_window`]，不复制第二份 `canBecomeKeyWindow` 覆盖。
    #[unsafe(super(NSWindow))]
    #[thread_kind = MainThreadOnly]
    pub(crate) struct DeskPetWindow;

    unsafe impl NSObjectProtocol for DeskPetWindow {}

    impl DeskPetWindow {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }
    }
);

/// 创建产品窗口（透明的由调用方按需设置）。W8a 聊天窗同用（见模块内转发）。
pub(crate) unsafe fn new_window(
    mtm: MainThreadMarker,
    rect: NSRect,
    style: NSWindowStyleMask,
) -> Retained<DeskPetWindow> {
    let allocated = DeskPetWindow::alloc(mtm);
    msg_send![
        allocated,
        initWithContentRect: rect,
        styleMask: style,
        backing: NSBackingStoreType::Buffered,
        defer: false
    ]
}

// ==========================================
// 控制器（主线程唯一实例）
// ==========================================

pub(crate) struct UiIvars {
    main: RefCell<Option<Retained<DeskPetWindow>>>,
    settings: RefCell<Option<Retained<DeskPetWindow>>>,
    layer_editor: RefCell<Option<Retained<DeskPetWindow>>>,
    viewer: RefCell<Option<Retained<DeskPetWindow>>>,
    status_item: OnceCell<Retained<NSStatusItem>>,
    /// 托盘菜单「聊天」项：标题在菜单打开时现读状态刷新（见 NSMenuDelegate 实现）。
    tray_chat_item: OnceCell<Retained<NSMenuItem>>,
    timer: RefCell<Option<Retained<NSTimer>>>,
    /// 主窗一体布局（舞台 + 聊天列；W9a）。
    main_layout: RefCell<Option<macos_main::MainLayout>>,
    /// 可见期光标/几何跟踪计时器（60Hz；隐藏期必须停表）。
    track_timer: RefCell<Option<Retained<NSTimer>>>,
    /// 编辑器关闭确认期间的一次性放行（避免 windowShouldClose 重入拦截）。
    allow_editor_close: Cell<bool>,
    machine: RefCell<ShowHideMachine>,
    /// 自动呼出（`general.popup.autoPopupOnMessage`）的「新提交助手条目」判定器
    /// （纯逻辑在 `ui/state.rs`；这里只是每实例一份的主线程持有位）。
    auto_popup: RefCell<CommittedAssistantTracker>,
    hotkey_ref: Cell<usize>,
    placement: Cell<PlacementMode>,
    /// 呼出前的前台应用（收起动画结束后交还激活；`None` = 无可交还目标）。
    /// 只在「呼出时本应用不在前台」时记录，见 [`UiController::note_previous_frontmost`]。
    prev_frontmost: RefCell<Option<Retained<NSRunningApplication>>>,
    queue: OnceCell<Arc<MainThreadQueue>>,
    exit_hook: OnceCell<Arc<dyn HostExitHook>>,
    audio: RefCell<Option<Arc<dyn crate::audio::AudioPort>>>,
    ready_hook: RefCell<Option<Box<dyn FnOnce() + Send>>>,
    exiting: Cell<bool>,
    audio_unwired_reported: Cell<bool>,
    /// A3：窗口拖动结束的去抖一次性定时器（拖动中反复重布；到点做几何写回）。
    geometry_timer: RefCell<Option<Retained<NSTimer>>>,
    /// 最近一次由代码摆放的主窗原点（web 坐标；区分用户拖动与程序摆放，避免误写回）。
    last_placed_origin: Cell<Option<(f64, f64)>>,
    /// A3：最近一次由 Node 推送应用的弹窗尺寸（`set_popup_size`；写回边沿按它
    /// 跳过程序应用，防「应用 → 写回 → 再应用」回路，见 `geometry_writeback::AppliedSize`）。
    applied_size: Cell<AppliedSize>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = UiIvars]
    pub(crate) struct UiController;

    unsafe impl NSObjectProtocol for UiController {}

    /// 托盘菜单开合前刷新：「聊天」项标题 = 当前状态的下一步动作（可见 → 隐藏聊天；
    /// 隐藏 → 显示聊天）。菜单每次打开都现读状态，聊天列经其它路径（投影同步等）
    /// 变化后标签也不会发霉。
    unsafe impl NSMenuDelegate for UiController {
        #[unsafe(method(menuNeedsUpdate:))]
        fn menu_needs_update(&self, _menu: &NSMenu) {
            let visible = self
                .with_main_layout(|layout| macos_main::chat_visible(layout))
                .unwrap_or(false);
            if let Some(item) = self.ivars().tray_chat_item.get() {
                item.setTitle(&NSString::from_str(if visible { "隐藏聊天" } else { "显示聊天" }));
            }
        }
    }

    unsafe impl NSApplicationDelegate for UiController {
        #[unsafe(method(applicationDidFinishLaunching:))]
        fn did_finish_launching(&self, _notification: &NSNotification) {
            self.build_ui();
        }

        /// 关掉最后一个窗口不退出（产品有托盘，退出只认托盘菜单/系统终止）。
        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn should_terminate_after_last_window_closed(&self, _sender: &NSApplication) -> bool {
            false
        }

        /// 任何终止路径（含登出/关机）都先走一次退出序列 —— 退出序列的唯一钩子
        /// 位置（MCP/Bash 子进程回收与 Node flush 都由钩子完成）。
        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _notification: &NSNotification) {
            self.run_exit_once();
        }
    }

    unsafe impl NSWindowDelegate for UiController {
        /// 主窗关闭请求（⌘W/系统关闭）一律收起，不销毁窗口、不退出应用
        /// （关闭 → hide 语义）。附属窗允许关闭（关闭即销毁）；
        /// 编辑器有未保存改动时先弹确认（保存并关闭 / 放弃修改 / 取消）。
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, sender: &NSWindow) -> bool {
            let is_main = self
                .ivars()
                .main
                .borrow()
                .as_ref()
                .map(|main| Retained::as_ptr(main) as *const NSWindow == sender as *const NSWindow)
                .unwrap_or(false);
            if is_main {
                rust_info!("主窗口关闭请求 → 收起（不销毁、不退出）");
                self.begin_toggle();
                return false.into();
            }
            let is_editor = self
                .ivars()
                .layer_editor
                .borrow()
                .as_ref()
                .map(|editor| {
                    Retained::as_ptr(editor) as *const NSWindow == sender as *const NSWindow
                })
                .unwrap_or(false);
            if is_editor && !self.ivars().allow_editor_close.get() && macos_editor::is_dirty() {
                // 关闭前确认：保存并关闭 / 放弃修改 / 取消（三者都在 alert 回调里收口）。
                macos_editor::prompt_close_with_unsaved_changes();
                return false.into();
            }
            true
        }

        /// 窗口尺寸变化：主窗重排一体布局（含舞台几何与聊天列）。
        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, notification: &NSNotification) {
            // NSNotification.object 是 AnyObject：按窗口类型下钻（非窗口通知直接跳过）。
            let window: Option<Retained<NSWindow>> = notification
                .object()
                .and_then(|object| object.downcast::<NSWindow>().ok());
            let Some(window) = window else { return };
            let is_main = self
                .ivars()
                .main
                .borrow()
                .as_ref()
                .map(|main| Retained::as_ptr(main) as *const NSWindow == Retained::as_ptr(&window))
                .unwrap_or(false);
            if !is_main {
                return;
            }
            // 尺寸变化后舞台几何与聊天列都要重排；窗口拖动期间高频到达，重排是纯
            // 帧计算（不重建消息视图，除非聊天列宽度真的变了）。
            if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                macos_main::on_window_resized(layout, &window);
            }
        }

        /// 主窗移动（A3）：重布写回去抖定时器；到点只提交一次（拖动高频，不逐帧写盘）。
        ///
        /// 程序摆放（呼出时的 setFrameDisplay）也会到达这里：提交前以
        /// `last_placed_origin` 复核，且只固定位置模式才写（见 commit_position_writeback）。
        #[unsafe(method(windowDidMove:))]
        fn window_did_move(&self, notification: &NSNotification) {
            let window: Option<Retained<NSWindow>> = notification
                .object()
                .and_then(|object| object.downcast::<NSWindow>().ok());
            let Some(window) = window else { return };
            let is_main = self
                .ivars()
                .main
                .borrow()
                .as_ref()
                .map(|main| Retained::as_ptr(main) as *const NSWindow == Retained::as_ptr(&window))
                .unwrap_or(false);
            if !is_main {
                return;
            }
            self.schedule_geometry_writeback();
        }

        /// 用户缩放结束（A3）：边沿触发（天然去抖），提交新尺寸写回。
        #[unsafe(method(windowDidEndLiveResize:))]
        fn window_did_end_live_resize(&self, _notification: &NSNotification) {
            self.commit_size_writeback();
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, notification: &NSNotification) {
            let closing: Option<Retained<AnyObject>> = notification.object();
            let Some(closing) = closing else { return };
            let closing_ptr = Retained::as_ptr(&closing) as *const NSWindow;
            for (window, slot) in [
                (WindowId::Settings, &self.ivars().settings),
                (WindowId::LayerEditor, &self.ivars().layer_editor),
                (WindowId::Viewer, &self.ivars().viewer),
            ] {
                let matched = slot
                    .borrow()
                    .as_ref()
                    .map(|win| Retained::as_ptr(win) as *const NSWindow == closing_ptr)
                    .unwrap_or(false);
                if matched {
                    // 置 None 即释放：窗口对象与全部资源随引用计数归零销毁，
                    // 之后可再次创建（与原型「关闭释放、可重开」同一做法）。
                    *slot.borrow_mut() = None;
                    rust_info!("附属窗口已关闭并释放，可再次创建");
                    match window {
                        WindowId::Viewer => {
                            // W8a：查看器内容视图与预览 owner 一并收口（§5.3 的释放点）。
                            super::macos_chat::note_viewer_window_closed();
                        }
                        WindowId::Settings => {
                            // W9a：设置窗控件随窗口释放；草稿丢弃、字体预览回滚。
                            macos_settings::on_window_closed();
                        }
                        WindowId::LayerEditor => {
                            // W9a：编辑器预览表面与控件随窗口释放；主窗舞台退出预览。
                            self.ivars().allow_editor_close.set(false);
                            macos_editor::on_window_closed();
                            if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                                macos_main::clear_editor_preview(layout);
                            }
                        }
                        _ => {}
                    }
                    break;
                }
            }
        }
    }

    impl UiController {
        /// 帧回调：可见期推进动画；隐藏后不应再有回调（防御性停表并留痕）。
        #[unsafe(method(tick:))]
        fn tick(&self, _timer: &NSTimer) {
            let now = now_ms();
            let outcome = self.ivars().machine.borrow_mut().tick(now);
            match outcome {
                Tick::Idle => {
                    // 非动画态出现帧回调 = 驱动侧失误：停表收口（hidden 零帧）。
                    self.stop_frame_timer();
                    rust_debug!("帧回调落在非动画态，已防御性停表");
                }
                Tick::Frame(visual) => self.apply_visual(visual),
                Tick::RetractFinished => {
                    self.stop_frame_timer();
                    if let Some(win) = self.main_window() {
                        win.orderOut(None);
                    }
                    self.apply_visual(FrameVisual { scale: 1.0, opacity: 1.0 });
                    // 舞台彻底停帧（可见性边沿）与内容释放：隐藏期零帧、零绘制。
                    if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                        macos_main::set_stage_visible(layout, false);
                    }
                    super::macos_chat::set_main_pane_visible(false);
                    // 收起完成：交还激活（焦点回到呼出前的应用；见方法注释）。
                    self.hand_back_activation();
                    self.play_cue(AudioCue::Retract);
                    rust_info!("收起动画结束 → orderOut + 帧回调停止（hidden 零帧）");
                }
                Tick::RevealFinished => {
                    self.stop_frame_timer();
                    self.apply_visual(FrameVisual { scale: 1.0, opacity: 1.0 });
                    self.play_cue(AudioCue::Popup);
                    rust_info!("呼出动画结束 → 帧回调停止");
                }
            }
        }

        /// 可见期跟踪：全局光标 → 舞台渲染器（灵动输入）。
        #[unsafe(method(mainTrack:))]
        fn main_track(&self, _timer: &NSTimer) {
            self.with_main_layout(macos_main::track);
        }

        /// 拖动去抖到点（A3 一次性定时器回调）：完成位置写回并收起定时器。
        #[unsafe(method(geometryCommitFired:))]
        fn geometry_commit_fired(&self, _timer: &NSTimer) {
            *self.ivars().geometry_timer.borrow_mut() = None;
            self.commit_position_writeback();
        }

        /// 托盘「聊天」：开合主窗聊天列。
        #[unsafe(method(toggleChat:))]
        fn toggle_chat_action(&self, _sender: Option<&AnyObject>) {
            self.toggle_chat_panel();
        }

        /// 托盘「设置」：打开独立设置顶层窗（不 addChildWindow，原生宿主迁移过程记录 §9.4 第 18 条）。
        ///
        /// 经 `SettingsUi::open_window`（而不是直接 `open_aux`）：建窗的同时设置
        /// 「窗口已打开」门禁与后台拉取，界面才有数据刷新通道。
        #[unsafe(method(openSettings:))]
        fn open_settings_action(&self, _sender: Option<&AnyObject>) {
            crate::ui::settings::settings_ui().open_window();
        }

        /// 托盘「图层编辑器」：打开编辑器顶层窗（同样经 EditorUi 的门禁与载入）。
        #[unsafe(method(openLayerEditor:))]
        fn open_layer_editor_action(&self, _sender: Option<&AnyObject>) {
            crate::ui::editor::editor_ui().open_window();
        }

        #[unsafe(method(showMain:))]
        fn show_main_action(&self, _sender: Option<&AnyObject>) {
            self.show_main();
        }

        #[unsafe(method(quitApp:))]
        fn quit_app_action(&self, _sender: Option<&AnyObject>) {
            self.quit();
        }
    }
);

impl UiController {
    fn new(mtm: MainThreadMarker, request: ServiceRequest) -> Retained<Self> {
        let ServiceRequest {
            queue,
            exit_hook,
            audio,
            e2e: _,
            on_ui_ready,
        } = request;
        let this = Self::alloc(mtm).set_ivars(UiIvars {
            main: RefCell::new(None),
            settings: RefCell::new(None),
            layer_editor: RefCell::new(None),
            viewer: RefCell::new(None),
            status_item: OnceCell::new(),
            tray_chat_item: OnceCell::new(),
            timer: RefCell::new(None),
            main_layout: RefCell::new(None),
            track_timer: RefCell::new(None),
            allow_editor_close: Cell::new(false),
            machine: RefCell::new(ShowHideMachine::new()),
            auto_popup: RefCell::new(CommittedAssistantTracker::new()),
            hotkey_ref: Cell::new(0),
            placement: Cell::new(PlacementMode::Cursor),
            prev_frontmost: RefCell::new(None),
            queue: {
                let cell = OnceCell::new();
                let _ = cell.set(queue);
                cell
            },
            exit_hook: {
                let cell = OnceCell::new();
                let _ = cell.set(exit_hook);
                cell
            },
            audio: RefCell::new(audio),
            ready_hook: RefCell::new(on_ui_ready),
            exiting: Cell::new(false),
            audio_unwired_reported: Cell::new(false),
            geometry_timer: RefCell::new(None),
            last_placed_origin: Cell::new(None),
            applied_size: Cell::new(AppliedSize::default()),
        });
        unsafe { msg_send![super(this), init] }
    }

    // ── 构建 ──

    fn build_ui(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("build_ui 不在主线程，跳过（不应发生）");
            return;
        };
        // 主线程队列：安装唤醒器（`DispatchQueue::main().exec_async_f` 异步投递到
        // libdispatch 主队列，不阻塞调用方；队列实例经裸指针传进回调，避免任何
        // 「回调先于登记」的竞态）。不写裸 extern 的理由见上方「主线程唤醒」小节。
        if let Some(queue) = self.ivars().queue.get() {
            let queue_for_waker = queue.clone();
            queue.install_waker(Arc::new(move || {
                let context = Arc::into_raw(queue_for_waker.clone()) as *mut c_void;
                unsafe { DispatchQueue::main().exec_async_f(context, drain_main_jobs) };
            }));
        }

        match self.create_main_window(mtm) {
            Ok(window) => {
                *self.ivars().main.borrow_mut() = Some(window);
            }
            Err(error) => {
                // 主窗创建失败不中止宿主：托盘与快捷键仍应可用，错误如实留痕。
                rust_warn!("主窗口创建失败: {error}");
            }
        }
        self.install_status_item(mtm);
        self.install_hotkey_handler();
        self.play_cue(AudioCue::Welcome);
        rust_info!("原生 UI 已就绪（主窗/托盘/快捷键等待 Node 推送）");

        // 收尾接线（拉起 Node）放在窗口与托盘之后：执行契约 §4.3 第 1 步的顺序。
        if let Some(hook) = self.ivars().ready_hook.borrow_mut().take() {
            std::thread::Builder::new()
                .name("deskpet-node-start".into())
                .spawn(hook)
                .map_err(|error| rust_warn!("Node 启动线程创建失败: {error}"))
                .ok();
        }
    }

    /// 主窗：透明、无边框、always-on-top、collectionBehavior 六位组合、阴影、
    /// 730×450（min 448×272，创建后由窗口自身约束）、居中。
    ///
    /// A3：`Resizable` 提供「拖边缘改窗口尺寸」能力 —— 用户改尺寸后由
    /// `windowDidEndLiveResize` 写回 `general.popup.defaultSize`
    /// （`windowDidResize` 已有，只负责重排）。
    fn create_main_window(&self, mtm: MainThreadMarker) -> AppResult<Retained<DeskPetWindow>> {
        let width = crate::window::MAIN_WINDOW_WIDTH;
        let height = crate::window::MAIN_WINDOW_HEIGHT;
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let window = unsafe {
            new_window(
                mtm,
                rect,
                NSWindowStyleMask::Borderless | NSWindowStyleMask::Resizable,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setOpaque(false);
        window.setBackgroundColor(Some(&NSColor::clearColor()));
        window.setHasShadow(true);
        window.setMovableByWindowBackground(true);
        // 最小尺寸（既定口径）。
        window.setContentMinSize(NSSize::new(
            crate::window::MAIN_WINDOW_MIN_WIDTH,
            crate::window::MAIN_WINDOW_MIN_HEIGHT,
        ));
        window.setDelegate(Some(ProtocolObject::from_ref(self)));
        // 居中到主屏可见区域。
        if let Some(screen) = NSScreen::mainScreen(mtm) {
            let sf = screen.visibleFrame();
            let origin = NSPoint::new(
                sf.origin.x + (sf.size.width - width) / 2.0,
                sf.origin.y + (sf.size.height - height) / 2.0,
            );
            window.setFrame_display(NSRect::new(origin, NSSize::new(width, height)), true);
        }
        if let Some(view) = window.contentView() {
            view.setWantsLayer(true);
        }
        // 层级 + 呈现：单一实现在 window/platform.rs（collectionBehavior 六位组合与
        // 「1<<17 → 1<<18」决策注释一字不动）；这里只调用，不复制常量。
        let ns_window = Retained::as_ptr(&window) as *const c_void as *mut c_void;
        unsafe {
            crate::window::platform::apply_macos_window_level(ns_window, WindowLevel::Main);
            crate::window::platform::present_macos_window(ns_window, WindowId::Main);
        }
        // W9a 一体布局：角色舞台（W6a 渲染器）+ 主窗内聊天列（§6.3）。
        match macos_main::install(&window) {
            Ok(layout) => {
                *self.ivars().main_layout.borrow_mut() = Some(layout);
                if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                    macos_main::set_stage_visible(layout, true);
                }
                self.start_track_timer();
            }
            Err(error) => {
                // 布局失败不中止宿主：窗口仍可显示（仅无舞台/聊天列），错误如实留痕。
                rust_warn!("主窗一体布局建立失败（窗口仍可用）: {error}");
            }
        }
        window.makeKeyAndOrderFront(None);
        rust_info!(
            "主窗口已创建（{width}×{height}，透明/无边框/置顶，label={}）",
            WindowId::Main.label()
        );
        Ok(window)
    }

    /// 可见期跟踪计时器：60Hz 把全局光标喂给舞台渲染器（灵动图层输入）。
    ///
    /// 只在主窗可见期运行；收起动画开始即停表（内容由 contentView 的 CALayer
    /// 变换承担缩放淡出），呼出时重启 —— 与「隐藏不绘制」同一条纪律。
    fn start_track_timer(&self) {
        self.stop_track_timer();
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                FRAME_INTERVAL,
                as_any(self),
                sel!(mainTrack:),
                None,
                true,
            )
        };
        *self.ivars().track_timer.borrow_mut() = Some(timer);
    }

    fn stop_track_timer(&self) -> bool {
        let timer = self.ivars().track_timer.borrow_mut().take();
        match timer {
            Some(timer) => {
                timer.invalidate();
                true
            }
            None => false,
        }
    }

    // ── A3：窗口几何写回（用户拖动/缩放 → CONFIG；提交走 ui::geometry_writeback） ──

    /// 重布拖动去抖定时器（每次移动都推迟；到点只提交一次，静置窗口不逐帧写盘）。
    fn schedule_geometry_writeback(&self) {
        if let Some(timer) = self.ivars().geometry_timer.borrow_mut().take() {
            timer.invalidate();
        }
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                GEOMETRY_WRITEBACK_DEBOUNCE,
                as_any(self),
                sel!(geometryCommitFired:),
                None,
                false,
            )
        };
        *self.ivars().geometry_timer.borrow_mut() = Some(timer);
    }

    /// 拖动到点：固定位置模式下把窗口原点写回 `general.popup.fixedPosition`。
    ///
    /// 与程序摆放区分：`last_placed_origin` 记录呼出/推送时由代码摆放的原点；
    /// 相同即视为程序摆放，不写回（避免展示性移动污染用户配置）。
    fn commit_position_writeback(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = self.main_window() else {
            return;
        };
        if !self.ivars().placement.get().is_fixed() {
            return; // 跟随光标模式的落点由光标决定，不写回
        }
        let frame = window.frame();
        let origin = (
            frame.origin.x,
            primary_height(mtm) - frame.origin.y - frame.size.height,
        );
        if self.ivars().last_placed_origin.get() == Some(origin) {
            return;
        }
        crate::ui::geometry_writeback::request_position_writeback(origin.0, origin.1);
        // 用户刚拖到的位置就是固定位置：同步宿主自己的摆放快照 —— Node 持久化后
        // 不会把新坐标回推，不同步则下一次呼出会按旧坐标摆回去（并把旧坐标再次写回
        // CONFIG，用户设的固定位置看起来「改了不生效」）。
        self.ivars().placement.set(PlacementMode::Fixed {
            x: origin.0,
            y: origin.1,
        });
    }

    /// 用户缩放结束：把新尺寸写回 `general.popup.defaultSize`（逻辑点即逻辑像素）。
    ///
    /// 程序应用（`set_popup_size` 推送）若触发本回调（AppKit 对程序性 `setFrame`
    /// 通常不发 `windowDidEndLiveResize`，但边缘情况不可依赖），与刚应用值一致的观测
    /// 不算用户新操作：跳过写回，防「应用 → 写回 → 再应用」回路与反复写盘。
    fn commit_size_writeback(&self) {
        let Some(window) = self.main_window() else {
            return;
        };
        let size = window.frame().size;
        if self
            .ivars()
            .applied_size
            .get()
            .suppresses(size.width, size.height)
        {
            rust_debug!("程序应用的尺寸不写回（与最近推送值一致）");
            return;
        }
        crate::ui::geometry_writeback::request_size_writeback(size.width, size.height);
    }

    /// 固定位置模式的落点：坐标经 `clamp_window_origin` clamp 回光标所在屏
    /// （`reveal` 与 `set_popup_placement` 共用，不复制屏幕矩形拼装）。
    fn fixed_placement_origin(&self, x: f64, y: f64, size: (f64, f64)) -> (f64, f64) {
        let screen = crate::commands::cursor::get_cursor_position()
            .ok()
            .map(|c| ScreenRect {
                x: c.screen_x as f64,
                y: c.screen_y as f64,
                w: c.screen_w as f64,
                h: c.screen_h as f64,
            });
        match screen {
            Some(screen) => clamp_window_origin((x, y), size, screen),
            None => (x, y),
        }
    }

    /// 把主窗**立即**摆到固定位置（`set_popup_placement` 的 `Fixed` 分支）。
    ///
    /// 先记 `last_placed_origin` 再 `setFrame`：`windowDidMove` 的去抖写回据此
    /// 跳过 —— 程序应用位置不会触发 `set_popup_geometry` 位置写回（防回路）。
    fn place_fixed_now(&self, x: f64, y: f64) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = self.main_window() else {
            rust_warn!("固定位置模式：主窗口不存在，暂不摆位（下次呼出按坐标落位）");
            return;
        };
        let frame = window.frame();
        let size = (frame.size.width, frame.size.height);
        let origin = self.fixed_placement_origin(x, y, size);
        self.ivars().last_placed_origin.set(Some(origin));
        window.setFrame_display(
            web_frame_to_cocoa(mtm, origin.0, origin.1, size.0, size.1),
            true,
        );
        rust_info!(
            "固定位置模式：主窗立即摆到 ({:.0},{:.0})",
            origin.0,
            origin.1
        );
    }

    /// 舞台 + 聊天列的主窗布局可变访问（跨模块用）。
    pub(crate) fn with_main_layout<R>(
        &self,
        f: impl FnOnce(&mut macos_main::MainLayout) -> R,
    ) -> Option<R> {
        self.ivars().main_layout.borrow_mut().as_mut().map(f)
    }

    /// 分隔条拖动（macos_main 的分隔条视图回调）。
    pub(crate) fn drag_chat_divider(&self, dx: f64) {
        let window = self.main_window();
        if let Some(window) = window {
            self.with_main_layout(|layout| macos_main::drag_divider(layout, &window, dx));
        }
    }

    /// 当前聊天列宽度（分隔条拖动结束时的诊断值）。
    pub(crate) fn chat_width_px(&self) -> f64 {
        self.with_main_layout(|layout| macos_main::chat_width(layout))
            .unwrap_or(0.0)
    }

    /// 托盘「聊天」：开合主窗聊天列（明确入口；不自动弹窗）。
    fn toggle_chat_panel(&self) {
        let window = self.main_window();
        if let Some(window) = window {
            self.with_main_layout(|layout| {
                let target = !macos_main::chat_visible(layout);
                macos_main::set_chat_visible(layout, &window, target);
            });
        }
    }

    /// 全局字体快照：刷新全部原生窗口的控件字体（主窗/设置/编辑器/聊天面）。
    fn apply_font(&self, snapshot: crate::ui::font::FontSnapshot) -> AppResult<()> {
        let applied = crate::ui::font::store(snapshot);
        super::macos_chat::apply_chat_font();
        macos_settings::apply_font();
        macos_editor::apply_font();
        // 全窗宽顶栏（macos_main）：状态位与按钮按新快照重设（品牌字固定粗体，不随全局字体）。
        self.with_main_layout(macos_main::apply_titlebar_font);
        rust_info!(
            "全局字体已应用（family={:?}，size={:?}）",
            applied.family,
            applied.size
        );
        Ok(())
    }

    /// 界面主题切换：按新 token 重建/重绘所有消费主题的外观。
    ///
    /// - 聊天面（独立窗 + 主窗聊天列）：面板底/纹理/气泡/按钮等既有构建期写入
    ///   layer 的部分必须重建，见 `macos_chat::apply_theme`；
    /// - 主窗：舞台兜底背景、分隔线、全窗宽顶栏按新 token 重绘，见
    ///   `macos_main::apply_theme`；
    /// - 设置窗与编辑器窗：窗口底 + 外观极性 + 文字/分隔线/主按钮色重设，见
    ///   `macos_settings::apply_theme` / `macos_editor::apply_theme`（窗口未打开时
    ///   是空操作，下次构建直接按新 token 取色）。
    fn apply_theme(&self, id: crate::ui::theme::ThemeId) -> AppResult<()> {
        super::macos_chat::apply_theme();
        self.with_main_layout(macos_main::apply_theme);
        macos_settings::apply_theme();
        macos_editor::apply_theme();
        rust_info!("界面主题已应用（{}）", id.as_str());
        Ok(())
    }

    /// 托盘：`NSStatusItem` + 菜单「显示 / 退出」。
    fn install_status_item(&self, mtm: MainThreadMarker) {
        let bar = NSStatusBar::systemStatusBar();
        let item = bar.statusItemWithLength(NSVariableStatusItemLength);
        if let Some(button) = item.button(mtm) {
            // 托盘图 = 用户素材（黑剪影模板图，见 [`tray_template_image`]）；素材缺失
            // 时回落文字「DP」，托盘仍可被找到。
            match tray_template_image() {
                Some(image) => button.setImage(Some(&image)),
                None => button.setTitle(ns_string!("DP")),
            }
        }
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("Desk-Pet"));
        // W9a：托盘是主窗聊天列与设置窗的明确入口（不自动弹窗改变产品行为）。
        let entries: [(&str, objc2::runtime::Sel, &str); 5] = [
            ("显示", sel!(showMain:), ""),
            ("聊天", sel!(toggleChat:), ""),
            ("设置", sel!(openSettings:), ","),
            ("图层编辑器", sel!(openLayerEditor:), ""),
            ("退出", sel!(quitApp:), "q"),
        ];
        for (title, action, key) in entries {
            let menu_item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &NSString::from_str(title),
                    Some(action),
                    &NSString::from_str(key),
                )
            };
            unsafe { menu_item.setTarget(Some(as_any(self))) };
            menu.addItem(&menu_item);
            if action == sel!(toggleChat:) {
                let _ = self.ivars().tray_chat_item.set(menu_item);
            }
        }
        // 菜单打开前刷新「聊天」项标题（menuNeedsUpdate）：从菜单就能看出聊天列当前
        // 是开还是关（2026-10-06 用户；静态标题看不出状态）。
        menu.setDelegate(Some(ProtocolObject::from_ref(self)));
        item.setMenu(Some(&menu));
        let _ = self.ivars().status_item.set(item);
        rust_info!("托盘已创建（NSStatusItem，菜单：显示 / 聊天 / 设置 / 图层编辑器 / 退出）");
    }

    /// Carbon 事件处理器只装一次；注册/注销在 `apply_shortcut` 里按推送替换。
    fn install_hotkey_handler(&self) {
        let target = unsafe { GetApplicationEventTarget() };
        let spec = EventTypeSpec {
            event_class: K_EVENT_CLASS_KEYBOARD,
            event_kind: K_EVENT_HOT_KEY_PRESSED,
        };
        let mut handler_ref: EventHandlerRef = std::ptr::null_mut();
        let status = unsafe {
            InstallEventHandler(
                target,
                Some(hotkey_handler),
                1,
                &spec,
                std::ptr::null_mut(),
                &mut handler_ref,
            )
        };
        if status != 0 {
            // 处理器装不上 = 快捷键整体不可用：如实记 error，不假装已就绪。
            crate::rust_error!(
                "Carbon InstallEventHandler 失败（status={status}），全局快捷键不可用"
            );
        } else {
            rust_info!("Carbon 快捷键事件处理器已安装（等待 Node 推送组合）");
        }
    }

    // ── 呼出 / 收回 ──

    /// 呼出/收回总入口（快捷键、托盘、关闭请求共用；护栏在状态机内）。
    fn begin_toggle(&self) {
        let now = now_ms();
        // **先把阶段读出来再 match**：写成 `match self.ivars().machine.borrow().stage() { … }`
        // 会让那个只读借用在 match 的**整个作用域**内保持存活（match 头部的临时值），
        // 于是 `Stage::Visible` 分支里的 `borrow_mut()` 立刻 panic「RefCell already borrowed」。
        // 快捷键、托盘「显示」与主窗关闭请求共用本入口 —— 一用必崩，不是偶发。
        let stage = self.ivars().machine.borrow().stage();
        match stage {
            Stage::Visible => {
                let accepted = self.ivars().machine.borrow_mut().begin_retract(now);
                if accepted {
                    self.start_retract();
                } else {
                    rust_debug!("收起被重复按键护栏忽略");
                }
            }
            Stage::Hidden => self.reveal(),
            Stage::Retracting | Stage::Revealing => {
                rust_debug!("呼出/收回在动画中由重复按键护栏忽略");
            }
        }
    }

    fn start_retract(&self) {
        // W8a：收起主窗 = 取消查看器解码/动画并释放 CPU 图（§5.3 的释放点之一）。
        crate::ui::chat::on_main_retracted();
        // W9a：收起动画由 contentView 的 CALayer 变换承担（缩放+淡出）。
        // 舞台继续绘制到动画结束；Tick::RetractFinished 才停帧，避免角色在淡出期间冻结。
        self.stop_track_timer();
        // transform origin：光标相对窗口左上角（旧 handleShortcutToggle 同一语义）。
        if let Some(window) = self.main_window() {
            if let Ok(cursor) = crate::commands::cursor::get_cursor_position() {
                let mtm = MainThreadMarker::new();
                if let Some(mtm) = mtm {
                    let frame = window.frame();
                    let origin_web = (
                        frame.origin.x,
                        primary_height(mtm) - frame.origin.y - frame.size.height,
                    );
                    let origin = transform_origin(origin_web, (cursor.x as f64, cursor.y as f64));
                    self.ivars().machine.borrow_mut().set_origin(origin);
                    self.set_transform_origin(origin);
                }
            }
        } else {
            rust_warn!("收起失败：主窗口不存在");
            return;
        }
        self.start_frame_timer();
        rust_info!("开始收起（0.25s 缩放淡出）");
    }

    fn reveal(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = self.main_window() else {
            rust_warn!("呼出失败：主窗口不存在");
            return;
        };
        let now = now_ms();
        // **状态机先于任何窗口显示副作用**（本函数的顺序不变量）：下面的
        // `compute_popup_position` 复用 cursor.rs 的「主窗增强/聚焦」，其中 `present` 的
        // `orderFrontRegardless` 与 `focus` 的 `makeKeyAndOrderFront` 对已 orderOut 的
        // 窗口是**直接显示**且不可撤回（`window/platform.rs` 内没有任何「还需要就显示」
        // 的判定）。若把这些副作用放在护栏判定之前，被释放尾巴（或动画中）拒绝的呼出
        // 会把窗口直接置于屏上：scale/opacity 停在收起完成复位的 1.0、又没有帧回调，
        // 用户看到的就是「飞快连按 → 窗口直接出来、弹出动画消失」。
        // 所以在触达窗口之前先问状态机：拒绝 = 本次呼出整体不产生任何窗口副作用。
        if !self.ivars().machine.borrow().can_toggle(now) {
            rust_debug!("呼出被重复按键护栏忽略（动画中或释放尾巴内），未触达窗口显示");
            return;
        }
        // 记录呼出前的前台应用：下面的 compute_popup_position 会「增强/聚焦」主窗
        // （内含激活请求），必须在抢走焦点之前采样（与 Windows 侧 capture 同一口径）。
        self.note_previous_frontmost();
        let frame = window.frame();
        let (width, height) = (frame.size.width, frame.size.height);
        // 摆位复用 commands/cursor.rs::compute_popup_position：含主窗增强/聚焦、
        // 光标与屏幕采样（Cocoa→web Y 翻转）与 clamp 到屏幕内。
        let pos = match crate::commands::cursor::compute_popup_position(
            &MainThreadPort,
            width.round() as i32,
            height.round() as i32,
        ) {
            Ok(pos) => pos,
            Err(error) => {
                rust_warn!("呼出失败：弹窗定位不可用: {error}");
                return;
            }
        };
        let (target, focus_point) = match self.ivars().placement.get() {
            // 过渡态（fixed 但还没有坐标）与跟随光标同路：呼出按光标落位。
            PlacementMode::Cursor | PlacementMode::FixedAtCurrent => (
                (pos.win_x as f64, pos.win_y as f64),
                (pos.cursor_x as f64, pos.cursor_y as f64),
            ),
            PlacementMode::Fixed { x, y } => {
                // 固定位置模式：越界时 clamp 回屏幕内（复用落点 helper；纯函数跨屏边界有单测）。
                let origin = self.fixed_placement_origin(x, y, (width, height));
                (origin, (origin.0 + width / 2.0, origin.1 + height / 2.0))
            }
        };
        let origin = transform_origin(target, focus_point);
        // 与函数开头的 can_toggle 同一 `now`：两次判定之间没有任何让步点（同一主线程
        // 调用、定位过程不嵌套事件循环），因此这里必然获批、是唯一的提交点。
        // 若真被拒，说明有别处并发改写了状态机 —— 那时定位副作用可能已显示窗口，
        // 如实报错留痕，不静默当作「什么都没发生」（用户可见行为要如实）。
        if !self.ivars().machine.borrow_mut().begin_reveal(now, origin) {
            rust_error!("呼出准入在定位后被状态机拒绝（状态被并发改写），本次呼出中止");
            return;
        }
        // 尺寸（保持当前尺寸；popupSize/Profile 驱动的尺寸接线在设置域）→ 位置 → 视觉初值 → 显示。
        window.setFrame_display(
            web_frame_to_cocoa(mtm, target.0, target.1, width, height),
            true,
        );
        // A3：记录本次程序摆放的原点（windowDidMove 的写回据此区分用户拖动）。
        self.ivars().last_placed_origin.set(Some(target));
        self.set_transform_origin(origin);
        self.apply_visual(FrameVisual {
            scale: 0.0,
            opacity: 0.0,
        });
        if window.isMiniaturized() {
            window.deminiaturize(None);
        }
        // 呼出即取焦点：窗口成为 key window 并激活应用本身 —— 缺激活一步时窗口虽是
        // key 也拿不到键盘/IME 焦点（旧壳同一序列：activateIgnoringOtherApps + set_focus）。
        window.makeKeyAndOrderFront(None);
        activate_app();
        // W9a：舞台恢复可见（重启帧循环 + 立即出一帧）与光标跟踪；聊天列按状态重建。
        let chat_visible = if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
            macos_main::on_window_resized(layout, &window);
            macos_main::set_stage_visible(layout, true);
            macos_main::chat_visible(layout)
        } else {
            false
        };
        super::macos_chat::set_main_pane_visible(true);
        // 呼出后聚焦聊天输入框（对齐旧壳 handleDockPopup 的 focusInput）。只在聊天列
        // 展开时做：桌宠形态（列收起）不把面板拉出来，也不聚焦不可见的输入框。
        if chat_visible {
            super::macos_chat::focus_main_pane_input();
        }
        self.start_track_timer();
        self.start_frame_timer();
        rust_info!(
            "开始呼出（0.35s 弹性放大）：target=({:.0},{:.0}) origin=({:.0},{:.0})",
            target.0,
            target.1,
            origin.0,
            origin.1
        );
    }

    /// 呼出瞬间记录前台应用（收起完成时交还激活）。
    ///
    /// 只在本应用**不在前台**时记录：呼出可能发生在设置窗聚焦时，也可能由本应用
    /// 自身的入口触发（自动呼出等），那种情况收起后保持现状才是「之前的状态」。
    /// 这时记为 `None` 并在收起时不做动作 —— 既不能把自己激活回去（无意义，等同
    /// 死循环），也不能随手激活别的应用（那是抢走别处的焦点）。
    ///
    /// 采样结果还须排除「采到自身」：激活请求与 `isActive` 的翻转是异步的
    /// （实测呼出路径里二者会短暂不一致），`frontmostApplication` 可能已返回本
    /// 应用而 `isActive` 仍为 false。比较用 `isEqual:` 而不是 pid ——
    /// NSRunningApplication 的文档明说 pid 不能用于进程比较。
    fn note_previous_frontmost(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let previous = if app.isActive() {
            None
        } else {
            match NSWorkspace::sharedWorkspace().frontmostApplication() {
                Some(frontmost) => {
                    let me = NSRunningApplication::currentApplication();
                    if frontmost.isEqual(Some(as_any(&*me))) {
                        rust_debug!("呼出前台应用采样到自身：收起时无可交还目标");
                        None
                    } else {
                        Some(frontmost)
                    }
                }
                None => {
                    rust_debug!("呼出前台应用采样为空：收起时无可交还目标");
                    None
                }
            }
        };
        *self.ivars().prev_frontmost.borrow_mut() = previous;
    }

    /// 收起完成：把激活交还呼出前的前台应用（期望行为：收回 → 焦点回到之前的状态）。
    ///
    /// 为什么不用 `NSApp.hide:`：它会连设置/编辑器等**全部**窗口一起隐藏，副作用
    /// 超出主窗（其余窗口会随下次激活被 unhide，但消失本身就是干扰）；为什么不用
    /// `deactivate`：它只辞去本应用激活态，不会把下一个应用带回来 —— 会留下「无
    /// 激活应用」的空档。所以显式记录目标并请它取回激活：macOS 14+ 走协同激活序列
    /// （先 `yieldActivationToApplication` 再 `activateFromApplication`，见 Apple
    /// 《Passing control from one app to another with cooperative activation》）；
    /// 旧系统上这两个选择器不存在，回落 `activateWithOptions`（本应用此刻仍是前台，
    /// 经典前台锁放行）。`respondsToSelector` 是必需护栏：直接调不存在的选择器会崩。
    ///
    /// 只在仍是本应用持有激活时交还：呼出期间用户可能已切到别处工作（快捷键全局
    /// 可用），此时收起不得抢走用户当前应用的焦点。
    fn hand_back_activation(&self) {
        let Some(previous) = self.ivars().prev_frontmost.borrow_mut().take() else {
            return;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        if !app.isActive() {
            rust_debug!("收起交还激活跳过：本应用已不在前台（用户在别处工作）");
            return;
        }
        if previous.isTerminated() {
            // 目标已退出：不猜替身；系统会在本应用无关键窗口时自然接管激活。
            rust_warn!(
                "收起交还激活失败：呼出前的应用已退出（pid={}）",
                previous.processIdentifier()
            );
            return;
        }
        let ok = if app.respondsToSelector(sel!(yieldActivationToApplication:))
            && previous.respondsToSelector(sel!(activateFromApplication:options:))
        {
            // macOS 14+ 协同激活：先让出给目标，再由目标名义取回（from = 本应用）。
            // 这里是「IgnoringOtherApps 位」在现代系统的替代 —— 该位自 macOS 14
            // 起被系统忽略（objc2 绑定已标 deprecated），协同序列才是 Apple 文档
            // 给出的等价路径；实机验证可把焦点还给呼出前的应用。
            app.yieldActivationToApplication(&previous);
            let me = NSRunningApplication::currentApplication();
            previous.activateFromApplication_options(&me, NSApplicationActivationOptions::empty())
        } else {
            // 旧系统（<14）回落：IgnoringOtherApps 位仍然有效，保留经典语义。
            #[allow(deprecated)] // 只在旧系统分支执行；14+ 由上面的协同序列替代
            let legacy = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
            previous.activateWithOptions(legacy)
        };
        if ok {
            rust_info!("收起已交还前台激活（pid={}）", previous.processIdentifier());
        } else {
            rust_warn!(
                "收起交还前台激活被系统拒绝（pid={}）",
                previous.processIdentifier()
            );
        }
    }

    fn show_main(&self) {
        // 先把阶段读出来再 match（与 begin_toggle 同一纪律）：写成
        // `match …machine.borrow().stage()` 时只读借用会活到整个 match 作用域，
        // Hidden 分支里的 begin_toggle → borrow_mut 必 panic「RefCell already borrowed」
        // （2026-10-06 实机事故：收起后点托盘「显示」整程崩溃；守门测试见本文件 tests）。
        let stage = self.ivars().machine.borrow().stage();
        match stage {
            Stage::Hidden => self.begin_toggle(),
            Stage::Visible => {
                if let Some(window) = self.main_window() {
                    if window.isMiniaturized() {
                        window.deminiaturize(None);
                    }
                    window.makeKeyAndOrderFront(None);
                    rust_debug!("托盘「显示」：主窗前移并取焦点");
                }
            }
            Stage::Retracting | Stage::Revealing => {
                rust_debug!("托盘「显示」在动画中忽略（重复按键护栏）");
            }
        }
    }

    /// 自动呼出检查：投影落帧 / 顶栏文本刷新时调用（两处都只做同一次幂等检查）。
    ///
    /// 口径（对齐旧壳 `ChatPanel` 的 `chatHistory` 监听 + `App.vue` 的 `onRequestPopup`）：
    /// - 只在**同一会话内出现新提交的助手条目**时触发（判定见
    ///   [`CommittedAssistantTracker`]；首帧历史填充与会话切换只建基线、不呼出）；
    /// - 开关（`general.popup.autoPopupOnMessage`）在推送到达前按 false（fail-closed）；
    /// - 用户主动收起后随即到来的新回复**照弹**（旧壳对「刚收起」没有额外抑制），
    ///   但动画中与 500ms 释放尾巴内由状态机护栏忽略（旧壳 `isRetracted &&
    ///   !isAnimating` 同义）——与托盘/快捷键触发共用同一口径；
    /// - 主窗已可见时不做任何事（旧壳 `!isRetracted` 直接返回）。
    fn maybe_auto_popup_on_committed(&self) {
        let snapshot = crate::ui::chat::snapshot();
        let tail = snapshot
            .messages
            .last()
            .filter(|message| message.role == crate::ui::chat::Role::Assistant)
            .map(|message| message.id.as_str());
        let fresh = self.ivars().auto_popup.borrow_mut().observe(
            snapshot.active_session.as_deref(),
            tail,
            !snapshot.messages.is_empty(),
        );
        if !fresh {
            return;
        }
        if !popup_auto_show() {
            rust_debug!("新提交的助手条目到达，但自动呼出开关未开（宿主缺省 false）");
            return;
        }
        let stage = self.ivars().machine.borrow().stage();
        match stage {
            Stage::Hidden => {
                rust_info!("自动呼出：收到新提交的助手条目（autoPopupOnMessage）");
                self.begin_toggle();
            }
            Stage::Visible => rust_debug!("自动呼出无需动作：主窗已可见"),
            Stage::Retracting | Stage::Revealing => {
                rust_debug!("自动呼出被重复按键护栏忽略（动画中或释放尾巴内）")
            }
        }
    }

    // ── 视觉 / 帧表 ──

    fn apply_visual(&self, visual: FrameVisual) {
        let Some(window) = self.main_window() else {
            return;
        };
        let Some(view) = window.contentView() else {
            return;
        };
        let Some(layer) = view.layer() else { return };
        without_implicit_animation(|| {
            layer.setOpacity(visual.opacity as f32);
            layer.setAffineTransform(CGAffineTransform {
                a: visual.scale,
                b: 0.0,
                c: 0.0,
                d: visual.scale,
                tx: 0.0,
                ty: 0.0,
            });
        });
    }

    /// 设置缩放中心：web 坐标（左上原点）→ CALayer anchorPoint（底左原点）。
    /// anchorPoint 改完必须重设 position，否则层会平移。
    fn set_transform_origin(&self, origin: (f64, f64)) {
        let Some(window) = self.main_window() else {
            return;
        };
        let Some(view) = window.contentView() else {
            return;
        };
        let Some(layer) = view.layer() else { return };
        let bounds = view.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        let anchor = CGPoint::new(
            (origin.0 / width).clamp(0.0, 1.0),
            ((height - origin.1) / height).clamp(0.0, 1.0),
        );
        without_implicit_animation(|| {
            let frame: CGRect = layer.frame();
            layer.setAnchorPoint(anchor);
            layer.setPosition(CGPoint::new(
                frame.origin.x + anchor.x * frame.size.width,
                frame.origin.y + anchor.y * frame.size.height,
            ));
        });
    }

    fn start_frame_timer(&self) {
        self.stop_frame_timer();
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                FRAME_INTERVAL,
                as_any(self),
                sel!(tick:),
                None,
                true,
            )
        };
        *self.ivars().timer.borrow_mut() = Some(timer);
    }

    fn stop_frame_timer(&self) -> bool {
        let timer = self.ivars().timer.borrow_mut().take();
        match timer {
            Some(timer) => {
                timer.invalidate();
                true
            }
            None => false,
        }
    }

    fn play_cue(&self, cue: AudioCue) {
        let audio = self.ivars().audio.borrow().clone();
        match audio {
            Some(port) => {
                if let Err(error) = port.play(cue) {
                    rust_warn!("提示音 {cue:?} 播放失败: {error}");
                }
            }
            None => {
                // 未接线只报一次（「失败要能看见」判据；不伪装播放成功）。
                if !self.ivars().audio_unwired_reported.replace(true) {
                    rust_info!("宿主音效未接线（W5 只保留接口与平台实现位）：{cue:?} 已跳过");
                }
            }
        }
    }

    // ── 窗口查询 / 操作 ──

    fn main_window(&self) -> Option<Retained<DeskPetWindow>> {
        self.ivars().main.borrow().clone()
    }

    fn aux_window(&self, window: WindowId) -> Option<Retained<DeskPetWindow>> {
        match window {
            WindowId::Settings => self.ivars().settings.borrow().clone(),
            WindowId::LayerEditor => self.ivars().layer_editor.borrow().clone(),
            WindowId::Viewer => self.ivars().viewer.borrow().clone(),
            _ => None,
        }
    }

    fn window(&self, window: WindowId) -> Option<Retained<DeskPetWindow>> {
        if window == WindowId::Main {
            self.main_window()
        } else {
            self.aux_window(window)
        }
    }

    fn window_show(&self, window: WindowId, focus: bool) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        if win.isMiniaturized() {
            win.deminiaturize(None);
        }
        if focus {
            win.makeKeyAndOrderFront(None);
        } else {
            win.orderFrontRegardless();
        }
        if window == WindowId::Main {
            // 主窗重新显示：舞台恢复可见 + 光标跟踪重启（与呼出路径同一边沿）。
            if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                macos_main::on_window_resized(layout, &win);
                macos_main::set_stage_visible(layout, true);
            }
            super::macos_chat::set_main_pane_visible(true);
            self.start_track_timer();
        }
        Ok(())
    }

    fn window_hide(&self, window: WindowId) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        win.orderOut(None);
        if window == WindowId::Main {
            // 隐藏边沿：停光标跟踪与舞台帧循环、释放聊天消息视图（隐藏不绘制）。
            self.stop_track_timer();
            if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
                macos_main::set_stage_visible(layout, false);
            }
            super::macos_chat::set_main_pane_visible(false);
        }
        Ok(())
    }

    fn window_focus(&self, window: WindowId) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        win.makeKeyAndOrderFront(None);
        // 激活应用本身（键盘/IME 焦点；序列与呼出共用同一实现点）。
        activate_app();
        Ok(())
    }

    fn window_set_level(&self, window: WindowId, level: WindowLevel) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        let ns_window = Retained::as_ptr(&win) as *const c_void as *mut c_void;
        unsafe { crate::window::platform::apply_macos_window_level(ns_window, level) };
        Ok(())
    }

    fn window_present(&self, window: WindowId) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        let ns_window = Retained::as_ptr(&win) as *const c_void as *mut c_void;
        unsafe { crate::window::platform::present_macos_window(ns_window, window) };
        Ok(())
    }

    fn window_visibility(&self, window: WindowId) -> AppResult<WindowVisibility> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        Ok(WindowVisibility {
            visible: win.isVisible(),
            focused: win.isKeyWindow(),
            minimized: win.isMiniaturized(),
        })
    }

    fn window_set_position(&self, window: WindowId, x: i32, y: i32) -> AppResult<()> {
        let win = self
            .window(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| AppError::Other("窗口定位必须在 UI 主线程".into()))?;
        let frame = win.frame();
        let rect = web_frame_to_cocoa(mtm, x as f64, y as f64, frame.size.width, frame.size.height);
        win.setFrame_display(rect, true);
        Ok(())
    }

    fn open_aux(&self, window: WindowId) -> AppResult<()> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| AppError::Other("窗口创建必须在 UI 主线程".into()))?;
        // 聊天：产品形态在主窗内（W9a）；[`WindowId::Chat`] 保留独立聊天窗能力
        // （W8a 的 `ui/chat::open_window`，窗口归聊天域自管）。
        if window == WindowId::Chat {
            super::macos_chat::open_chat_window();
            return Ok(());
        }
        let (title, width, height) = match window {
            WindowId::Settings => ("设置 - 虚拟桌宠", 540.0, 640.0),
            WindowId::LayerEditor => ("图层编辑器 - 虚拟桌宠", 860.0, 620.0),
            WindowId::Viewer => ("图片查看器 - 虚拟桌宠", 640.0, 480.0),
            other => {
                return Err(AppError::Other(format!(
                    "{} 不是可创建的附属窗口",
                    other.label()
                )))
            }
        };
        if let Some(existing) = self.aux_window(window) {
            existing.makeKeyAndOrderFront(None);
            return Ok(());
        }
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let style = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::Miniaturizable;
        let win = unsafe { new_window(mtm, rect, style) };
        unsafe { win.setReleasedWhenClosed(false) };
        win.setTitle(&NSString::from_str(title));
        win.setDelegate(Some(ProtocolObject::from_ref(self)));
        win.center();
        // **独立顶层窗**（原生宿主迁移过程记录 §9.4 第 18 条）：刻意不用 addChildWindow ——
        // 为已 orderOut 的主窗添加可见子窗会把主窗一起带回屏幕。
        //
        // 先登记再增强：增强命令（enhance_* / set_level / present）经端口按 id 查窗口，
        // 未登记时会如实报「窗口不存在」而静默落空。
        match window {
            WindowId::Settings => *self.ivars().settings.borrow_mut() = Some(win.clone()),
            WindowId::LayerEditor => *self.ivars().layer_editor.borrow_mut() = Some(win.clone()),
            WindowId::Viewer => *self.ivars().viewer.borrow_mut() = Some(win.clone()),
            _ => {}
        }
        let port = MainThreadPort;
        match window {
            WindowId::Settings => {
                let _ = crate::window::settings::enhance_settings_window(&port);
                // W9a：设置窗内容（Tab/控件）随窗口创建，关闭随窗口销毁（§6.4）。
                macos_settings::install_settings_content(&win);
            }
            WindowId::LayerEditor => {
                let _ = crate::window::settings::enhance_layer_editor_window(&port);
                // W9a：编辑器内容 + 第二个渲染器（预览表面）随窗口创建，关闭销毁。
                macos_editor::install_editor_content(&win);
            }
            WindowId::Viewer => {
                let _ = port.set_level(window, crate::ui::creation_level(window));
                let _ = port.present(window);
                // W8a：查看器内容（NSImageView）由聊天域挂载，帧来自 PreviewManager。
                super::macos_chat::install_viewer_content(&win);
            }
            _ => {}
        }
        win.makeKeyAndOrderFront(None);
        rust_info!(
            "附属窗口已创建（独立顶层窗，label={}，{width}×{height}）",
            window.label()
        );
        Ok(())
    }

    fn close_aux(&self, window: WindowId) -> AppResult<()> {
        match window {
            WindowId::Main => Err(AppError::Other(
                "主窗口只收起不销毁（关闭请求 → 托盘）".into(),
            )),
            WindowId::Settings | WindowId::LayerEditor | WindowId::Viewer => {
                let slot = match window {
                    WindowId::Settings => &self.ivars().settings,
                    WindowId::LayerEditor => &self.ivars().layer_editor,
                    _ => &self.ivars().viewer,
                };
                let win = slot.borrow_mut().take();
                match win {
                    Some(win) => {
                        win.close();
                        rust_info!("附属窗口 {} 已关闭并释放", window.label());
                        Ok(())
                    }
                    None => Err(AppError::Other(format!("窗口 {} 未打开", window.label()))),
                }
            }
            WindowId::E2e => Err(AppError::Other("E2E 窗口不在原生薄层窗口管理范围".into())),
            WindowId::Chat => {
                // 产品形态的聊天区在主窗内、随主窗生命周期（主窗收起即隐藏聊天列）；
                // 这里只关闭「独立聊天窗」这一能力（未打开时是 no-op）。
                super::macos_chat::close_chat_window();
                Ok(())
            }
        }
    }

    // ── 快捷键 ──

    /// 应用 Node 推送的组合：先注销旧注册，再注册新的（修改快捷键 = 重新推送）。
    ///
    /// 注册失败如实返回错误（Node 能拿到结构化失败），不静默维持旧键。
    fn apply_shortcut(&self, shortcut: PlatformShortcut) -> AppResult<()> {
        let target = unsafe { GetApplicationEventTarget() };
        let previous = self.ivars().hotkey_ref.replace(0);
        if previous != 0 {
            unsafe { UnregisterEventHotKey(previous as EventHotKeyRef) };
        }
        let mut hotkey_ref: EventHotKeyRef = std::ptr::null_mut();
        let status = unsafe {
            RegisterEventHotKey(
                shortcut.key_code,
                shortcut.modifiers,
                EventHotKeyID {
                    signature: HOTKEY_SIGNATURE,
                    id: HOTKEY_ID,
                },
                target,
                0,
                &mut hotkey_ref,
            )
        };
        if status != 0 || hotkey_ref.is_null() {
            return Err(AppError::Config(format!(
                "RegisterEventHotKey 失败（status={status}），快捷键未注册"
            )));
        }
        self.ivars().hotkey_ref.set(hotkey_ref as usize);
        rust_info!(
            "全局快捷键已注册（keyCode={:#x}，modifiers={:#x}）",
            shortcut.key_code,
            shortcut.modifiers
        );
        Ok(())
    }

    fn on_hotkey(&self) {
        rust_debug!("收到 Carbon 全局快捷键");
        self.begin_toggle();
    }

    // ── 退出 ──

    /// 托盘「退出」：先跑退出序列（子进程回收 + Node flush/停机），再终止应用循环。
    fn quit(&self) {
        self.run_exit_once();
        self.stop_frame_timer();
        self.stop_track_timer();
        if let Some(layout) = self.ivars().main_layout.borrow_mut().as_mut() {
            macos_main::teardown(layout);
        }
        if let Some(item) = self.ivars().status_item.get() {
            NSStatusBar::systemStatusBar().removeStatusItem(item);
        }
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).terminate(None);
        }
    }

    /// 退出序列只跑一次（托盘与 applicationWillTerminate 可能先后到达）。
    fn run_exit_once(&self) {
        if self.ivars().exiting.replace(true) {
            return;
        }
        // A3：拖动去抖定时器随退出收口（不让写回悬在退出序列之后）。
        if let Some(timer) = self.ivars().geometry_timer.borrow_mut().take() {
            timer.invalidate();
        }
        rust_info!("退出序列开始");
        // W8a：先释放聊天域持有的预览/解码资源（本地资源，不依赖 Node 收尾）。
        crate::ui::chat::on_host_exit();
        if let Some(hook) = self.ivars().exit_hook.get() {
            hook.run();
        }
    }
}

/// Carbon 事件回调（主线程、应用事件循环内触发）。
extern "C" fn hotkey_handler(
    _call_ref: *mut c_void,
    event: *mut c_void,
    _user_data: *mut c_void,
) -> OSStatus {
    let mut hotkey = EventHotKeyID::default();
    let mut actual_size: usize = 0;
    let status = unsafe {
        GetEventParameter(
            event,
            K_EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>(),
            &mut actual_size,
            &mut hotkey as *mut EventHotKeyID as *mut c_void,
        )
    };
    if status == 0 && hotkey.signature == HOTKEY_SIGNATURE && hotkey.id == HOTKEY_ID {
        if let Ok(()) = with_controller(|ctl| ctl.on_hotkey()) {
            // 已派发
        }
    }
    0
}

// ==========================================
// 平台入口（`ui/platform/mod.rs` 按目标平台转发到这里）
// ==========================================

pub fn run_service(request: ServiceRequest) -> AppResult<i32> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err(AppError::Other("原生 UI 必须在主线程启动".into()));
    };
    // W8a/W9a：聊天/设置/编辑器三个域的渲染调度都需要同一份主线程队列
    // （数据来自 IPC 线程时经它回主线程）。
    crate::ui::chat::install_main_queue(request.queue.clone());
    crate::ui::settings::install_main_queue(request.queue.clone());
    crate::ui::editor::install_main_queue(request.queue.clone());
    let app = NSApplication::sharedApplication(mtm);
    // ActivationPolicy 必须在创建窗口之前设置。
    //
    // 产品是桌宠，不该占 Dock —— Accessory 无 Dock 图标、不进 Cmd+Tab、无应用菜单。
    // 但 **E2E 宿主窗口是给人看的开发者工具**：Accessory 下它一旦被最小化就再也
    // 找不回来（三种入口全都没有），窗口被判定为遮挡后页面 JS 会冻结，整轮测试
    // 静默停摆。E2E 用 Regular：出现在 Dock 与 Cmd+Tab，随时能唤回。
    // （这段理由原样保留，见原生宿主迁移过程记录 §9.4。）
    let policy = if request.e2e {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Accessory
    };
    app.setActivationPolicy(policy);
    rust_info!(
        "macOS: ActivationPolicy::{} 已设置",
        if request.e2e { "Regular" } else { "Accessory" }
    );

    let controller = UiController::new(mtm, request);
    CONTROLLER.with(|cell| *cell.borrow_mut() = Some(controller.clone()));
    app.setDelegate(Some(ProtocolObject::from_ref(&*controller)));

    app.run();
    rust_info!("原生事件循环结束");
    Ok(0)
}

// ── 跨线程句柄（UiHandle / MainThreadPort）落到本平台的操作 ──

pub fn window_show(window: WindowId, focus: bool) -> AppResult<()> {
    with_controller(|ctl| ctl.window_show(window, focus))?
}

pub fn window_hide(window: WindowId) -> AppResult<()> {
    with_controller(|ctl| ctl.window_hide(window))?
}

pub fn window_focus(window: WindowId) -> AppResult<()> {
    with_controller(|ctl| ctl.window_focus(window))?
}

pub fn window_set_level(window: WindowId, level: WindowLevel) -> AppResult<()> {
    with_controller(|ctl| ctl.window_set_level(window, level))?
}

pub fn window_present(window: WindowId) -> AppResult<()> {
    with_controller(|ctl| ctl.window_present(window))?
}

pub fn window_visibility(window: WindowId) -> AppResult<WindowVisibility> {
    with_controller(|ctl| ctl.window_visibility(window))?
}

pub fn window_set_position(window: WindowId, x: i32, y: i32) -> AppResult<()> {
    with_controller(|ctl| ctl.window_set_position(window, x, y))?
}

pub fn window_open_devtools(_window: WindowId) -> AppResult<()> {
    // 原生宿主没有 WebView，也就没有开发者工具可开。如实报错，不返回假成功
    // （F3 的判据：静默成功是误导信号）。
    Err(AppError::Other(
        "原生宿主没有开发者工具（WebView 已从产品形态移除）".into(),
    ))
}

pub fn open_aux_window(window: WindowId) -> AppResult<()> {
    with_controller(|ctl| ctl.open_aux(window))?
}

pub fn close_window(window: WindowId) -> AppResult<()> {
    with_controller(|ctl| ctl.close_aux(window))?
}

pub fn set_popup_placement(mode: PlacementMode) -> AppResult<()> {
    with_controller(|ctl| {
        ctl.ivars().placement.set(mode);
        // 带坐标的固定位置：立即摆位（切过去/坐标更新都马上生效，不必等下一次呼出）。
        // 跟随光标与过渡态（fixed 但还没有坐标）：不动窗口，下一次呼出按光标落位；
        // 过渡态下用户拖动结束的写回照常落坐标（`is_fixed` 语义）。
        if let Some((x, y)) = mode.immediate_placement() {
            ctl.place_fixed_now(x, y);
        }
        rust_info!("弹窗摆位模式已更新: {mode:?}");
    })
}

/// 应用 Node 推送的弹窗默认尺寸（`general.popup.defaultSize`；A3 运行时闭环）。
///
/// 保持左上角不动、立即改尺寸；先记录 `applied_size` 再 `setFrame` —— 程序性改
/// 尺寸若触发 `windowDidEndLiveResize` 边沿，`commit_size_writeback` 据此跳过
/// （防「应用 → 写回 → 再应用」回路，见 `geometry_writeback::AppliedSize`）。
pub fn set_popup_size(width: f64, height: f64) -> AppResult<()> {
    with_controller(|ctl| {
        let Some(window) = ctl.main_window() else {
            return Err(AppError::Other("主窗口不存在".into()));
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return Err(AppError::Other("弹窗尺寸只允许在 UI 主线程应用".into()));
        };
        let mut applied = ctl.ivars().applied_size.get();
        applied.record(width, height);
        ctl.ivars().applied_size.set(applied);
        let frame = window.frame();
        // 保持「左上角」不动：位置口径是 web 坐标（左上原点，`fixedPosition` 与
        // `last_placed_origin` 同一系），Cocoa 的 origin 是底左 —— 钉住顶边，
        // 尺寸变化才表现为向下/向右生长。先记录再 setFrame（程序摆放原点 =
        // 不变的 web 左上角），尺寸应用引发的 windowDidMove 去抖写回据此跳过。
        let top = frame.origin.y + frame.size.height;
        ctl.ivars()
            .last_placed_origin
            .set(Some((frame.origin.x, primary_height(mtm) - top)));
        window.setFrame_display(
            NSRect::new(
                NSPoint::new(frame.origin.x, top - height),
                NSSize::new(width, height),
            ),
            true,
        );
        rust_info!("弹窗尺寸已应用（{width}×{height}，左上角保持）");
        Ok(())
    })?
}

pub fn apply_global_shortcut(shortcut: PlatformShortcut) -> AppResult<()> {
    with_controller(|ctl| ctl.apply_shortcut(shortcut))?
}

// ── W9a：主窗一体布局 / 字体 / 设置窗 / 编辑器窗的平台入口 ──

/// 应用全局字体快照到所有原生窗口控件（主窗标签、聊天面、设置/编辑器控件）。
pub fn apply_font_snapshot(snapshot: crate::ui::font::FontSnapshot) -> AppResult<()> {
    with_controller(|ctl| ctl.apply_font(snapshot))?
}

/// 应用界面主题：让所有受影响的原生窗口按新 token 重建/重绘外观。
///
/// 调用前提：`UiHandle::apply_theme` 已先做过 `store` 与 `warm_up`（主题快照与
/// 纹理都就绪），所以平台层直接读 `crate::ui::theme::tokens()` 拿到新值。
pub fn apply_theme(id: crate::ui::theme::ThemeId) -> AppResult<()> {
    with_controller(|ctl| ctl.apply_theme(id))?
}

/// 应用主窗舞台快照（Node 推送的 Profile + appearance 投影）。
pub fn apply_stage_profile(profile: crate::ui::stage::StageProfile) -> AppResult<()> {
    with_controller(|ctl| {
        if let Some(layout) = ctl.ivars().main_layout.borrow_mut().as_mut() {
            macos_main::apply_stage_profile(layout, profile);
            Ok(())
        } else {
            Err(AppError::Other("主窗布局未建立，舞台快照暂存失败".into()))
        }
    })?
}

/// 主窗聊天列开合与宽度（`general.popup.chatWidth` 推送入口）。
///
/// `open = None` 只应用宽度、保持当前开合（设置保存后的推送走这条；见
/// `UiHandle::set_chat_panel`）。
pub fn set_chat_panel(open: Option<bool>, width: Option<f64>) -> AppResult<()> {
    with_controller(|ctl| {
        let window = ctl.main_window();
        let Some(window) = window else {
            return Err(AppError::Other("主窗口不存在".into()));
        };
        ctl.with_main_layout(|layout| {
            if let Some(width) = width {
                macos_main::set_chat_width(layout, &window, Some(width));
            }
            if let Some(open) = open {
                macos_main::set_chat_visible(layout, &window, open);
            }
        });
        Ok(())
    })?
}

/// 打开设置窗（设置域的入口；先建窗显示现状，再拉取数据）。
pub fn open_settings_window() -> AppResult<()> {
    with_controller(|ctl| ctl.open_aux(WindowId::Settings))?
}

// ── A1：顶栏（主窗聊天列顶部的标题条）──

/// 顶栏「关闭」：收起主窗（不退出、不销毁；与 `windowShouldClose` 同一归宿）。
///
/// 只在可见态接受（隐藏/动画中按护栏忽略，与呼出收回状态机一致）。
pub fn retract_main_window() -> AppResult<()> {
    with_controller(|ctl| {
        if ctl.ivars().machine.borrow().stage() != Stage::Visible {
            rust_debug!("顶栏收起请求在隐藏/动画中被忽略");
            return;
        }
        let accepted = ctl.ivars().machine.borrow_mut().begin_retract(now_ms());
        if accepted {
            ctl.start_retract();
        } else {
            rust_debug!("顶栏收起被重复按键护栏忽略");
        }
    })
}

/// 顶栏状态位文本刷新（[`crate::ui::titlebar`] 的文本已由 `UiHandle` 存入）。
pub fn refresh_titlebar(text: String) -> AppResult<()> {
    // 全窗宽顶栏是状态位的唯一展示副本（`macos_main`；旧聊天列顶栏副本已随旧实现
    // 删除）；文本唯一真值仍是 `ui/titlebar.rs`。
    super::macos_main::set_titlebar_text(&text);
    // 顶栏文本变化常与「回复已提交、typing owner 释放」同步到达：这是自动呼出的
    // 第二个触发点（第一个在 `apply_chat_projection` 的落帧处）。两处都只做幂等
    // 检查（判定器按会话内条目 id 去重），先到先算、重复到达无害。
    note_auto_popup_check();
    Ok(())
}

/// 自动呼出检查入口（`apply_chat_projection` 落帧后与顶栏文本刷新时调用）。
///
/// 已由调用方经 `UiHandle::run_on_main` 投递到 UI 主线程（IPC 分派层）；本函数不
/// 再自行跨线程。原生 UI 未启动（无控制器，如无窗口宿主/E2E 隔离宿主）时无窗口
/// 可呼出：按无操作跳过并留痕 —— 呼出检查是派生效果，不是调用方需要感知的失败
/// （正文投影本身已经应用）。
pub(crate) fn note_auto_popup_check() {
    if let Err(error) = with_controller(|controller| controller.maybe_auto_popup_on_committed()) {
        rust_debug!("自动呼出检查跳过：原生 UI 未初始化（无窗口可呼出）: {error}");
    }
}

/// 设置窗内容刷新（数据到达/保存回执）。
pub fn settings_refresh() -> AppResult<()> {
    macos_settings::refresh_ui();
    Ok(())
}

/// 单行文本输入弹窗（模态；取消返回 None）。设置窗「重命名 Profile」等入口共用。
pub fn prompt_text(title: &str, label: &str, initial: &str) -> AppResult<Option<String>> {
    macos_widgets::prompt_text(title, label, initial)
}

/// 打开图层编辑器窗。
pub fn open_editor_window() -> AppResult<()> {
    with_controller(|ctl| ctl.open_aux(WindowId::LayerEditor))?
}

/// 编辑器界面刷新（草稿/保存状态变化）。
pub fn editor_refresh() -> AppResult<()> {
    macos_editor::refresh_ui();
    Ok(())
}

/// 关闭编辑器窗（保存并关闭路径；带一次性放行标记绕过未保存确认）。
pub fn close_editor_window() -> AppResult<()> {
    with_controller(|ctl| {
        ctl.ivars().allow_editor_close.set(true);
        let window = ctl.ivars().layer_editor.borrow().clone();
        match window {
            Some(window) => {
                window.close();
                Ok(())
            }
            None => Err(AppError::Other("编辑器窗口未打开".into())),
        }
    })?
}

/// 编辑器预览同步到主窗舞台（W9a：主窗/预览一致的唯一落点）。
///
/// `promote` = 编辑器刚保存成功：把当前预览提升为舞台的权威基线，避免 Node
/// 尚未重推时舞台回退到旧 Profile。
pub(crate) fn apply_editor_preview_to_stage(
    layers: Vec<crate::render::LayerSpec>,
    intensity: f64,
    promote: bool,
) -> AppResult<()> {
    with_controller(|ctl| {
        ctl.with_main_layout(|layout| macos_main::editor_preview(layout, layers, intensity));
        if promote {
            ctl.with_main_layout(macos_main::promote_editor_preview);
        }
        Ok(())
    })?
}

#[cfg(test)]
mod tests {
    /// 生产段源码（截到测试段之前）：守门断言不扫自己的断言文本。
    fn production_source() -> &'static str {
        let src = include_str!("macos.rs");
        let end = src.find("#[cfg(test)]").expect("必须有测试段");
        &src[..end]
    }

    /// 源码级守门：`machine` 的只读借用不得写进 `match` 头。
    ///
    /// `match self.ivars().machine.borrow().stage() { … }` 的临时只读借用会活到整个
    /// match 作用域（Rust 的 match 头部临时值规则），`Stage::Hidden` 分支里的
    /// begin_toggle → `borrow_mut()` 立刻 panic「RefCell already borrowed」。
    /// 2026-10-06 实机事故：收起主窗后点托盘「显示」整程崩溃（show_main 漏改；
    /// begin_toggle / maybe_auto_popup_on_committed 已按纪律写对）。正确写法：
    /// 先 `let stage = …borrow().stage();` 再 match。注释行不参与扫描。
    #[test]
    fn 状态机只读借用不进入match头() {
        for (index, line) in production_source().lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("match") && code.contains("machine.borrow()") {
                panic!(
                    "macos.rs:{} 把 machine 的只读借用写进了 match 头（借用会活到整个 match，分支内 borrow_mut 必 panic）：{}",
                    index + 1,
                    line.trim()
                );
            }
        }
    }
}
