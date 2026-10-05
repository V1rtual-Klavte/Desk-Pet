//! Windows 原生薄层（Win32）：主窗/设置/图层编辑器/查看器、`Shell_NotifyIcon` 托盘、
//! `RegisterHotKey` 全局快捷键、帧计时器与呼出/收回动画。
//!
//! 做法照 W0 探针的 Windows 窗口原型（`crates/ui-probe`，已随迁移完成删除）搬；
//! 该原型在本机只做过离线类型检查、**未实机运行**。与原型的有意差异都就地注明：
//! - **设置/编辑器/查看器用独立顶层窗**（父窗句柄传 0），不用 owner 语义绑定主窗
//!   （原生宿主迁移过程记录 §9.4 第 18 条：主窗收起时开设置不能把桌宠带回来）；
//! - 快捷键注册等待 Node 推送，收到前不注册任何键；
//! - 帧计时器只在动画进行中挂载，动画终点 `KillTimer` + 隐藏（hidden 零帧）。
//!
//! **本文件的 Windows 分支在本机（macOS）只做离线类型核对，未在 Windows 编译/运行**
//! （bundled SQLite 需要 msvc C 工具链，见原生宿主迁移过程记录 §9.4 第 19 条）。类型面的依据
//! 是 `windows-sys 0.52` 的注册表源码与既有 `commands/cursor.rs` 的同版本用法。

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Arc;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint, GetDC,
    InvalidateRect, ReleaseDC, ScreenToClient, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, PAINTSTRUCT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, ReleaseCapture, SetCapture, UnregisterHotKey,
};
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetCursorPos, GetForegroundWindow, GetMessageW, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer,
    LoadCursorW, LoadIconW, PostMessageW, PostQuitMessage, RegisterClassW, SetCursor,
    SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow, TrackPopupMenu,
    TranslateMessage, UpdateLayeredWindow, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HTCAPTION,
    HTCLIENT, HWND_TOPMOST, IDC_SIZEWE, IDI_APPLICATION, MF_SEPARATOR, MF_STRING, MSG, SM_CXSCREEN,
    SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOW,
    TPM_RIGHTBUTTON, ULW_ALPHA, WM_APP, WM_CLOSE, WM_COMMAND, WM_CTLCOLORBTN, WM_CTLCOLORSTATIC,
    WM_DESTROY, WM_DRAWITEM, WM_ERASEBKGND, WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_HOTKEY,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCCALCSIZE, WM_NCHITTEST,
    WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR, WM_SIZE, WM_TIMER, WM_VSCROLL, WNDCLASSW,
    WS_CLIPCHILDREN, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP,
    WS_THICKFRAME, WS_VISIBLE, WS_VSCROLL,
};

use crate::audio::AudioCue;
use crate::error::{AppError, AppResult};
use crate::host::{WindowId, WindowLevel, WindowVisibility};
use crate::ui::shortcut::PlatformShortcut;
use crate::ui::state::{
    clamp_window_origin, popup_auto_show, transform_origin, CommittedAssistantTracker, FrameVisual,
    PlacementMode, ScreenRect, ShowHideMachine, Stage, Tick,
};
use crate::ui::{HostExitHook, MainThreadQueue, ServiceRequest};
use crate::{rust_debug, rust_error, rust_info, rust_warn};

use super::super::MainThreadPort;
use super::now_ms;
use crate::window::{
    DPI_BASELINE, MAIN_WINDOW_HEIGHT, MAIN_WINDOW_MIN_HEIGHT, MAIN_WINDOW_MIN_WIDTH,
    MAIN_WINDOW_WIDTH,
};

const MAIN_CLASS: &str = "DeskPetMainWindow";

/// `MINMAXINFO`（windows-sys 0.52 未登记；只用 minTrackSize；本地定义与
/// `windows_chat.rs` 的同名结构各自守住自己的约束，不跨模块共享私有 FFI 形状）。
#[repr(C)]
struct MainMinMaxInfo {
    pt_reserved: POINT,
    pt_max_size: POINT,
    pt_max_position: POINT,
    pt_min_track_size: POINT,
    pt_max_track_size: POINT,
}
const AUX_CLASS: &str = "DeskPetAuxWindow";
const HOTKEY_ID: i32 = 0x4450; // 'DP'
const TIMER_FRAME: usize = 1;
/// 主线程任务队列的唤醒消息（`PostMessageW`）。
const WM_APP_DRAIN: u32 = WM_APP + 1;
/// 托盘回调消息。
const WM_TRAY: u32 = WM_APP + 2;
const TRAY_ID: u32 = 1;
const CMD_SHOW: usize = 1001;
const CMD_QUIT: usize = 1002;
/// W9a：托盘「聊天」（开合主窗聊天列）、「设置」与「图层编辑器」入口。
const CMD_CHAT: usize = 1003;
const CMD_SETTINGS: usize = 1004;
const CMD_EDITOR: usize = 1005;
/// W9a：可见期光标跟踪计时器（60Hz，与帧动画计时器分开）。
const TIMER_TRACK: usize = 2;

/// Rust 字符串 → UTF-16（含 NUL 结尾）。
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 窗口 label → `GWLP_USERDATA` 里的判别值（附属窗 wndproc 用）。
fn window_id_code(window: WindowId) -> usize {
    match window {
        WindowId::Main => 0,
        WindowId::Settings => 1,
        WindowId::LayerEditor => 2,
        WindowId::Viewer => 3,
        // 4 = 独立聊天窗（能力保留；产品形态的聊天列在主窗内，不占窗口身份）。
        WindowId::Chat => 4,
        WindowId::E2e => 9,
    }
}

fn window_id_from_code(code: usize) -> Option<WindowId> {
    match code {
        1 => Some(WindowId::Settings),
        2 => Some(WindowId::LayerEditor),
        3 => Some(WindowId::Viewer),
        4 => Some(WindowId::Chat),
        _ => None,
    }
}

// ==========================================
// DIB（UpdateLayeredWindow 的 32bpp 位图源）
// ==========================================

struct Dib {
    hdc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    width: i32,
    height: i32,
    /// 像素基址（顶朝下 32bpp）；主窗底色重画前要整块清零。
    bits: *mut u8,
}

impl Dib {
    /// 创建全透明（全零）的顶朝下 32bpp DIB。
    fn new(width: i32, height: i32) -> Option<Dib> {
        unsafe {
            let hdc = CreateCompatibleDC(0);
            if hdc == 0 {
                return None;
            }
            // windows-sys 0.52 的 BITMAPINFO/HEADER 没有 Default：先清零再写显式字段。
            let mut header: BITMAPINFO = std::mem::zeroed();
            header.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负数 = 顶朝下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(hdc, &header, DIB_RGB_COLORS, &mut bits, 0, 0);
            if bitmap == 0 {
                DeleteDC(hdc);
                return None;
            }
            let old = SelectObject(hdc, bitmap);
            // 清零 = 全透明（W6 渲染器接入后再画内容）。
            std::ptr::write_bytes(bits as *mut u8, 0, (width as usize) * (height as usize) * 4);
            Some(Dib {
                hdc,
                bitmap,
                old,
                width,
                height,
                bits: bits as *mut u8,
            })
        }
    }
}

impl Dib {
    /// 整块清零（底色重画前清掉上一次的主题产物）。
    fn clear(&mut self) {
        unsafe {
            std::ptr::write_bytes(self.bits, 0, self.width as usize * self.height as usize * 4);
        }
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old);
            DeleteObject(self.bitmap);
            DeleteDC(self.hdc);
        }
    }
}

/// 主窗 ULW 底色的重画键：这些量任一变化就要重新把底色画进 DIB。
type BackdropKey = (u64, i32, i32, i32, i32, bool);

// ==========================================
// 主线程状态
// ==========================================

struct WinUi {
    main: HWND,
    aux: HashMap<WindowId, HWND>,
    machine: ShowHideMachine,
    /// 自动呼出（`general.popup.autoPopupOnMessage`）的「新提交助手条目」判定器
    /// （纯逻辑在 `ui/state.rs`；这里只是每实例一份的主线程持有位）。
    auto_popup: CommittedAssistantTracker,
    placement: PlacementMode,
    /// 呼出前的前台窗口（收起动画结束后交还前台；`0` = 无可交还目标）。
    /// 只在「呼出时前台不属于本进程」时记录，见 [`capture_previous_foreground`]。
    prev_foreground: HWND,
    timer_active: bool,
    hotkey_registered: bool,
    tray_nid: Option<NOTIFYICONDATAW>,
    queue: Arc<MainThreadQueue>,
    exit_hook: Arc<dyn HostExitHook>,
    audio: Option<Arc<dyn crate::audio::AudioPort>>,
    audio_unwired_reported: bool,
    exiting: bool,
    dib: Option<Dib>,
    /// 主窗 ULW 底色的重画键（主题代际 + 尺寸 + 分隔条几何 + 聊天列可见性）。
    backdrop_key: Option<BackdropKey>,
    /// W9a：主窗一体布局（舞台子窗口 + 聊天列）。
    main_layout: Option<super::windows_main::MainLayout>,
    /// 可见期光标跟踪计时器是否在跑（收起/隐藏必须停）。
    track_timer_active: bool,
    /// 编辑器「保存并关闭」的一次性放行（跳过未保存确认）。
    allow_editor_close: bool,
    /// A3：最近一次由 Node 推送应用的弹窗尺寸（`set_popup_size`；写回边沿按它
    /// 跳过程序应用，防「应用 → 写回 → 再应用」回路，见 `geometry_writeback::AppliedSize`）。
    applied_size: crate::ui::geometry_writeback::AppliedSize,
}

thread_local! {
    static UI: RefCell<Option<WinUi>> = const { RefCell::new(None) };
}

fn with_ui<R>(f: impl FnOnce(&mut WinUi) -> R) -> AppResult<R> {
    UI.with(|cell| match cell.borrow_mut().as_mut() {
        Some(ui) => Ok(f(ui)),
        None => Err(AppError::Other(
            "原生 UI 未在此线程初始化（窗口操作只能在 UI 主线程）".into(),
        )),
    })
}

/// 记录呼出前的前台窗口（`0` = 没有可交还的目标）。
///
/// 前台是本进程自己的窗口（设置窗等）时不记录：收起后本进程仍在前台，保持现状
/// 就是「呼出前的状态」，没有交还可言（与 macOS `note_previous_frontmost` 对称）。
fn capture_previous_foreground() -> HWND {
    unsafe {
        let previous = GetForegroundWindow();
        if previous == 0 {
            return 0;
        }
        let mut owner_pid = 0u32;
        GetWindowThreadProcessId(previous, &mut owner_pid);
        if owner_pid == GetCurrentProcessId() {
            0
        } else {
            previous
        }
    }
}

/// 收起时把前台交还呼出前记录的应用（期望行为：收回 → 焦点回到之前的状态）。
///
/// 为什么不能只靠 `SW_HIDE`：它确实会「激活另一个窗口」，但目标是系统在 z 序里
/// 任选的一个，不保证是用户呼出前的应用；显式交还才有确定语义。守卫与 macOS
/// 对称：只在主窗仍是前台窗口（用户没有中途切走）且目标窗口仍存在时交还。
/// 交还发生在 `SW_HIDE` **之前**：此刻本进程还是前台进程，`SetForegroundWindow`
/// 不会被前台锁拒绝；等隐藏后再调用可能只剩任务栏闪烁。
fn hand_back_foreground(ui: &WinUi) {
    unsafe {
        if GetForegroundWindow() != ui.main
            || ui.prev_foreground == 0
            || IsWindow(ui.prev_foreground) == 0
        {
            return;
        }
        if SetForegroundWindow(ui.prev_foreground) != 0 {
            rust_info!("收起已交还前台（hwnd={}）", ui.prev_foreground);
        } else {
            rust_warn!("收起交还前台被系统拒绝（hwnd={}）", ui.prev_foreground);
        }
    }
}

impl WinUi {
    fn hwnd(&self, window: WindowId) -> Option<HWND> {
        if window == WindowId::Main {
            Some(self.main)
        } else {
            self.aux.get(&window).copied()
        }
    }

    /// 窗口物理尺寸。
    fn physical_size(&self, hwnd: HWND) -> (i32, i32) {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(hwnd, &mut rect) };
        (rect.right - rect.left, rect.bottom - rect.top)
    }

    fn dpi_scale(&self, hwnd: HWND) -> f64 {
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE);
        f64::from(dpi) / f64::from(DPI_BASELINE)
    }

    fn ensure_dib(&mut self, width: i32, height: i32) -> bool {
        let needs_recreate = self
            .dib
            .as_ref()
            .map(|dib| dib.width != width || dib.height != height)
            .unwrap_or(true);
        if needs_recreate {
            self.dib = Dib::new(width, height);
        }
        self.dib.is_some()
    }

    /// 主窗自身 ULW 表面的底色（舞台兜底 + 舞台颗粒 + 分隔线）：键变化时才重画。
    ///
    /// 分层子窗口（舞台）的透明像素与聊天列左侧的分隔带都透到这一层；
    /// 重画几何来自 `windows_main::relayout` 写入的 `MainLayout`。
    fn ensure_backdrop(&mut self, width: i32, height: i32) {
        let layout = self.main_layout.as_ref();
        let key: BackdropKey = (
            crate::ui::theme::generation(),
            width,
            height,
            layout.map(|l| l.divider_x).unwrap_or(0),
            layout.map(|l| l.divider_w).unwrap_or(0),
            layout.map(|l| l.chat_visible).unwrap_or(false),
        );
        if self.backdrop_key == Some(key) {
            return;
        }
        let Some(dib) = self.dib.as_mut() else { return };
        dib.clear();
        super::windows_main::paint_backdrop(dib.hdc, width, height, layout);
        self.backdrop_key = Some(key);
    }

    /// 一帧提交：常量 alpha 淡出（缩放由 W6 渲染器在内容层承担；W5 无内容，
    /// 原型同样只做常量 alpha）。
    fn submit_frame(&mut self, alpha: f64) {
        let hwnd = self.main;
        let (width, height) = self.physical_size(hwnd);
        if !self.ensure_dib(width, height) {
            return;
        }
        self.ensure_backdrop(width, height);
        let Some(dib) = self.dib.as_ref() else { return };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: (alpha.clamp(0.0, 1.0) * 255.0) as u8,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(hwnd, &mut rect) };
        let dst = POINT {
            x: rect.left,
            y: rect.top,
        };
        let size = SIZE {
            cx: width,
            cy: height,
        };
        let src = POINT { x: 0, y: 0 };
        unsafe {
            let hdc = GetDC(0);
            UpdateLayeredWindow(hwnd, hdc, &dst, &size, dib.hdc, &src, 0, &blend, ULW_ALPHA);
            ReleaseDC(0, hdc);
        }
    }

    /// W9a：舞台可见性边沿（隐藏零帧；与主窗显隐、收起动画终点对齐）。
    fn set_stage_visible(&mut self, visible: bool) {
        if let Some(layout) = self.main_layout.as_mut() {
            super::windows_main::set_stage_visible(layout, visible);
        }
        if visible {
            if !self.track_timer_active {
                unsafe { SetTimer(self.main, TIMER_TRACK, 16, None) };
                self.track_timer_active = true;
            }
        } else {
            self.stop_track_timer();
        }
    }

    fn stop_track_timer(&mut self) {
        if self.track_timer_active {
            unsafe { KillTimer(self.main, TIMER_TRACK) };
            self.track_timer_active = false;
        }
    }

    /// 主窗尺寸变化：重排一体布局（舞台子窗口 + 聊天列）。
    fn relayout_main(&mut self) {
        if let Some(layout) = self.main_layout.as_mut() {
            super::windows_main::relayout(layout, self.main);
        }
    }

    fn toggle_chat_panel(&mut self) {
        let main = self.main;
        if let Some(layout) = self.main_layout.as_mut() {
            let target = !super::windows_main::chat_visible(layout);
            super::windows_main::set_chat_visible(layout, main, target);
        }
    }

    /// 主题切换：释放主题 GDI 缓存 → 各窗口按新 token 重绘（见 [`UiHandle::apply_theme`]）。
    ///
    /// `theme::store` 已在调用方先跑，这里直接读 `theme::tokens()` 即新值。
    /// 顺序不变量：`release_theme_resources()` 必须排在所有窗口广播之前 ——
    /// 旧主题的画刷/纹理 DIB 在这里被 `DeleteObject`，各窗口随后只按新 token 懒重建
    /// （设置/编辑器窗自己不持有 GDI 对象，只重刷控件字色）。
    fn apply_theme(&mut self, id: crate::ui::theme::ThemeId) {
        // 先释放主题 GDI 缓存（画刷/纹理 DIB/渐变条都是旧主题的产物；GDI 对象不释放就是泄漏）。
        // 幂等说明：缓存代际按主题代际记账，这里释放后，下一个 WM_CTLCOLOR*/WM_PAINT
        // 会按新 token 重新建账（见 paint_win 的 with_cache）。
        crate::ui::theme::paint_win::release_theme_resources();
        // 聊天窗：整帧重建（RTF 颜色表/按钮面/静态字色在创建时固化）+ 重画窗底。
        super::windows_chat::apply_theme();
        // 主窗顶栏（全窗宽顶栏 + 关闭键）。
        super::windows_main::apply_theme();
        // 设置窗 / 编辑器窗：重刷控件字色（按语义角色取新 token）+ 强制重绘
        // （窗底/分隔线在各自的 WM_ERASEBKGND/WM_PAINT 按新 token 自绘）。
        super::windows_settings::apply_theme();
        super::windows_editor::apply_theme();
        // 主窗 ULW 底色（舞台兜底 + 分隔线）：清键，等下一次提交按新 token 重画。
        self.backdrop_key = None;
        if self.machine.stage() == Stage::Visible {
            self.submit_frame(1.0);
        }
        rust_info!("界面主题已应用（Windows）：{}", id.as_str());
    }

    /// 全局字体快照：刷新各窗口控件字体（主窗舞台不受字体影响）。
    fn apply_font(&self, snapshot: crate::ui::font::FontSnapshot) {
        let applied = crate::ui::font::store(snapshot);
        super::windows_chat::apply_chat_font();
        super::windows_settings::apply_font();
        super::windows_editor::apply_font();
        // 全窗宽顶栏（windows_main）：状态位与按钮按新快照重设字体。
        super::windows_main::apply_titlebar_font();
        rust_info!(
            "全局字体已应用（family={:?}，size={:?}）",
            applied.family,
            applied.size
        );
    }

    fn play_cue(&mut self, cue: AudioCue) {
        match self.audio.clone() {
            Some(port) => {
                if let Err(error) = port.play(cue) {
                    rust_warn!("提示音 {cue:?} 播放失败: {error}");
                }
            }
            None => {
                if !self.audio_unwired_reported {
                    self.audio_unwired_reported = true;
                    rust_info!("宿主音效未接线（W5 只保留接口与平台实现位）：{cue:?} 已跳过");
                }
            }
        }
    }

    // ── 呼出 / 收回 ──

    fn begin_toggle(&mut self) {
        let now = now_ms();
        match self.machine.stage() {
            Stage::Visible => {
                if self.machine.begin_retract(now) {
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

    fn start_retract(&mut self) {
        // W8a：收起主窗 = 取消查看器解码/动画并释放 CPU 图（§5.3 的释放点之一）。
        crate::ui::chat::on_main_retracted();
        // 收起期间舞台仍随外层动画绘制；帧循环在 RetractFinished 收尾处停止，
        // 避免角色在淡出动画期间冻结。跟踪只需固定收起起点的光标位置，因此立即停止。
        self.stop_track_timer();
        // transform origin：光标相对窗口左上角（旧 handleShortcutToggle 同一语义）。
        if let (Ok(cursor), Ok((wx, wy))) = (
            crate::commands::cursor::get_cursor_position(),
            self.main_origin_web(),
        ) {
            let origin = transform_origin((wx, wy), (f64::from(cursor.x), f64::from(cursor.y)));
            self.machine.set_origin(origin);
        }
        self.start_frame_timer();
        rust_info!("开始收起（0.25s 缩放淡出；Windows 侧为常量 alpha 淡出）");
    }

    /// 主窗左上角（web 坐标）：Windows 的窗口矩形本来就是左上原点；
    /// 但要经 DPI 换算到逻辑像素（与 `commands/cursor.rs` 的口径一致）。
    fn main_origin_web(&self) -> AppResult<(f64, f64)> {
        let hwnd = self.main;
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(hwnd, &mut rect) };
        let scale = self.dpi_scale(hwnd);
        Ok((f64::from(rect.left) / scale, f64::from(rect.top) / scale))
    }

    /// 固定位置模式的落点（clamp 到光标所在屏；`reveal` 与 `set_popup_placement` 共用，
    /// 不复制屏幕矩形拼装）。**未在 Windows 实机验证**（同 W9a 约定）。
    fn fixed_origin(&self, x: f64, y: f64, size_log: (f64, f64)) -> (f64, f64) {
        let screen = crate::commands::cursor::get_cursor_position()
            .ok()
            .map(|c| ScreenRect {
                x: f64::from(c.screen_x),
                y: f64::from(c.screen_y),
                w: f64::from(c.screen_w),
                h: f64::from(c.screen_h),
            });
        match screen {
            Some(screen) => clamp_window_origin((x, y), size_log, screen),
            None => (x, y),
        }
    }

    fn reveal(&mut self) {
        let hwnd = self.main;
        let now = now_ms();
        // **状态机先于任何窗口显示副作用**（与 macOS 同一顺序不变量）：下面的
        // `compute_popup_position` 会「增强/聚焦」主窗（present 的 SetWindowPos 与
        // focus 的 SetForegroundWindow）。这两个调用当前不会显示已隐藏的窗口，
        // 但顺序仍是唯一防线 —— 一旦呈现实现补上显示语义（如 macOS 的
        // orderFrontRegardless、或给 SetWindowPos 加 SWP_SHOWWINDOW），在护栏之前
        // 触达窗口就会让被拒的呼出把窗口直接置于屏上（无动画）。
        if !self.machine.can_toggle(now) {
            rust_debug!("呼出被重复按键护栏忽略（动画中或释放尾巴内），未触达窗口显示");
            return;
        }
        // 记住当前前台窗口（不含本进程自身）：下面的 compute_popup_position 会
        // 「增强/聚焦」主窗（内含 SetForegroundWindow），必须在抢走前台之前采样
        //（与 macOS 的采样位置同一口径）。
        self.prev_foreground = capture_previous_foreground();
        let (width_phys, height_phys) = self.physical_size(hwnd);
        let scale = self.dpi_scale(hwnd);
        let (width_log, height_log) = (
            (f64::from(width_phys) / scale).round() as i32,
            (f64::from(height_phys) / scale).round() as i32,
        );
        // 摆位复用 commands/cursor.rs::compute_popup_position（含主窗增强/聚焦、
        // 光标与屏幕采样、Windows 物理→逻辑换算与 clamp）。
        let pos = match crate::commands::cursor::compute_popup_position(
            &MainThreadPort,
            width_log,
            height_log,
        ) {
            Ok(pos) => pos,
            Err(error) => {
                rust_warn!("呼出失败：弹窗定位不可用: {error}");
                return;
            }
        };
        let (target_logical, focus_point) = match self.placement {
            // 过渡态（fixed 但还没有坐标）与跟随光标同路：呼出按光标落位。
            PlacementMode::Cursor | PlacementMode::FixedAtCurrent => (
                (f64::from(pos.win_x), f64::from(pos.win_y)),
                (f64::from(pos.cursor_x), f64::from(pos.cursor_y)),
            ),
            PlacementMode::Fixed { x, y } => {
                // 固定位置模式：越界时 clamp 回屏幕内（复用落点 helper）。
                let origin = self.fixed_origin(x, y, (f64::from(width_log), f64::from(height_log)));
                (
                    origin,
                    (
                        origin.0 + f64::from(width_log) / 2.0,
                        origin.1 + f64::from(height_log) / 2.0,
                    ),
                )
            }
        };
        let origin = transform_origin(target_logical, focus_point);
        // 与函数开头的 can_toggle 同一 `now`：两次判定之间没有让步点（同一 UI 线程
        // 调用、定位过程不嵌套消息循环），这里必然获批、是唯一的提交点。
        // 若真被拒，说明有别处并发改写了状态机，如实报错留痕（用户可见行为要如实）。
        if !self.machine.begin_reveal(now, origin) {
            rust_error!("呼出准入在定位后被状态机拒绝（状态被并发改写），本次呼出中止");
            return;
        }
        // 逻辑 → 物理：用光标所在屏的 scale（compute_popup_position 返回；跨屏正确）。
        let x_phys = (target_logical.0 * pos.scale_x).round() as i32;
        let y_phys = (target_logical.1 * pos.scale_y).round() as i32;
        // W9a：舞台恢复可见（重启帧循环 + 立即出一帧）与光标跟踪。
        self.relayout_main();
        self.set_stage_visible(true);
        // 初始帧全透明（先以 opacity=0 提交一帧再显示），随后显示并取焦点。
        self.submit_frame(0.0);
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                x_phys,
                y_phys,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            );
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        }
        super::windows_chat::main_window_visibility_changed(true);
        self.start_frame_timer();
        // 呼出后聚焦聊天输入框（对齐 macOS 与旧壳 handleDockPopup 的 focusInput）；
        // 只在聊天列展开时做，桌宠形态不把面板拉出来。
        let chat_visible = self
            .main_layout
            .as_ref()
            .map(super::windows_main::chat_visible)
            .unwrap_or(false);
        if chat_visible {
            super::windows_chat::focus_main_pane_input();
        }
        rust_info!(
            "开始呼出：target=({:.0},{:.0})（逻辑） origin=({:.0},{:.0})",
            target_logical.0,
            target_logical.1,
            origin.0,
            origin.1
        );
    }

    fn show_main(&mut self) {
        match self.machine.stage() {
            Stage::Hidden => self.begin_toggle(),
            Stage::Visible => {
                unsafe {
                    ShowWindow(self.main, SW_SHOW);
                    SetForegroundWindow(self.main);
                }
                rust_debug!("托盘「显示」：主窗显示并置于前台");
            }
            Stage::Retracting | Stage::Revealing => {
                rust_debug!("托盘「显示」在动画中忽略（重复按键护栏）");
            }
        }
    }

    /// 自动呼出检查：投影落帧 / 顶栏文本刷新时调用（两处都只做同一次幂等检查）。
    ///
    /// 口径与 macOS 对称（对齐旧壳 `ChatPanel` 的 `chatHistory` 监听 + `App.vue` 的
    /// `onRequestPopup`）：只在同一会话内出现新提交的助手条目时触发；开关推送前按
    /// false（fail-closed）；用户主动收起后随即到来的新回复照弹（旧壳无额外抑制），
    /// 动画中与 500ms 释放尾巴内由状态机护栏忽略；主窗已可见时不做任何事。
    fn maybe_auto_popup_on_committed(&mut self) {
        let snapshot = crate::ui::chat::snapshot();
        let tail = snapshot
            .messages
            .last()
            .filter(|message| message.role == crate::ui::chat::Role::Assistant)
            .map(|message| message.id.as_str());
        let fresh = self.auto_popup.observe(
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
        match self.machine.stage() {
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

    // ── 帧表 ──

    fn start_frame_timer(&mut self) {
        self.stop_frame_timer();
        unsafe { SetTimer(self.main, TIMER_FRAME, 16, None) };
        self.timer_active = true;
    }

    fn stop_frame_timer(&mut self) -> bool {
        if !self.timer_active {
            return false;
        }
        unsafe { KillTimer(self.main, TIMER_FRAME) };
        self.timer_active = false;
        true
    }

    // ── 附属窗口 ──

    fn open_aux(&mut self, window: WindowId) -> AppResult<()> {
        // 聊天：产品形态在主窗内（W9a）；独立聊天窗能力由聊天域自管。
        if window == WindowId::Chat {
            super::windows_chat::open_chat_window();
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
        if let Some(existing) = self.aux.get(&window).copied() {
            unsafe { SetForegroundWindow(existing) };
            return Ok(());
        }
        let scale =
            f64::from(unsafe { GetDpiForSystem() }.max(DPI_BASELINE)) / f64::from(DPI_BASELINE);
        let width_phys = (width * scale).round() as i32;
        let height_phys = (height * scale).round() as i32;
        let x = (unsafe { GetSystemMetrics(SM_CXSCREEN) } - width_phys) / 2;
        let y = (unsafe { GetSystemMetrics(SM_CYSCREEN) } - height_phys) / 2;
        let class = wide(AUX_CLASS);
        let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
        // W9a：编辑器窗口同时是第二个渲染器的合成目标，需要 WS_EX_LAYERED；
        // 其余附属窗保持原样（独立顶层窗：父窗句柄传 0，原生宿主迁移过程记录 §9.4 第 18 条）。
        let ex_style = if window == WindowId::LayerEditor {
            WS_EX_TOPMOST | WS_EX_LAYERED
        } else {
            WS_EX_TOPMOST
        };
        // 设置窗内容可能高于窗口：带上 WS_VSCROLL，滚动由 `windows_settings::on_vscroll`
        // 按行位移处理（W9a；其它附属窗不加）。
        // WS_CLIPCHILDREN：设置/编辑器窗自绘主题窗底（WM_ERASEBKGND/WM_PAINT），
        // 必须把子控件区域排除在父窗绘制之外，否则整块填充会盖住控件（系统不会替我们重绘）。
        let style = if window == WindowId::Settings {
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPCHILDREN | WS_VSCROLL
        } else {
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPCHILDREN
        };
        let hwnd = unsafe {
            CreateWindowExW(
                ex_style,
                class.as_ptr(),
                wide(title).as_ptr(),
                style,
                x,
                y,
                width_phys,
                height_phys,
                0,
                0,
                hinstance,
                std::ptr::null(),
            )
        };
        if hwnd == 0 {
            return Err(AppError::Other(format!(
                "附属窗口创建失败（{}）",
                window.label()
            )));
        }
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, window_id_code(window) as isize) };
        // 先登记再增强：enhance_* 经端口按 id 查窗口，未登记时会静默落空。
        self.aux.insert(window, hwnd);
        // 层级/呈现走既有平台函数（单一层级数值真值）。
        let level = crate::ui::creation_level(window);
        unsafe { crate::window::platform::apply_windows_window_level(hwnd, level) };
        if window == WindowId::Settings {
            let _ = crate::window::settings::enhance_settings_window(&MainThreadPort);
            // W9a：设置窗内容随窗口创建，关闭随窗口销毁（§6.4）。
            super::windows_settings::install_settings_content(hwnd);
        } else if window == WindowId::LayerEditor {
            let _ = crate::window::settings::enhance_layer_editor_window(&MainThreadPort);
            // W9a：编辑器内容 + 第二个渲染器（预览表面）随窗口创建，关闭销毁。
            super::windows_editor::install_editor_content(hwnd);
        } else if window == WindowId::Viewer {
            // W8a：查看器内容（帧由 PreviewManager 经 chat_apply 推送）挂载点。
            crate::ui::platform::windows_chat::install_viewer_content(hwnd);
        }
        unsafe { SetForegroundWindow(hwnd) };
        rust_info!(
            "附属窗口已创建（独立顶层窗，label={}，{}×{}）",
            window.label(),
            width,
            height
        );
        Ok(())
    }

    fn close_aux(&mut self, window: WindowId) -> AppResult<()> {
        match window {
            WindowId::Main => Err(AppError::Other(
                "主窗口只收起不销毁（关闭请求 → 托盘）".into(),
            )),
            WindowId::Settings | WindowId::LayerEditor | WindowId::Viewer => {
                match self.aux.remove(&window) {
                    Some(hwnd) => {
                        unsafe { DestroyWindow(hwnd) };
                        rust_info!("附属窗口 {} 已关闭并释放", window.label());
                        Ok(())
                    }
                    None => Err(AppError::Other(format!("窗口 {} 未打开", window.label()))),
                }
            }
            WindowId::E2e => Err(AppError::Other("E2E 窗口不在原生薄层窗口管理范围".into())),
            WindowId::Chat => {
                // 产品形态的聊天区在主窗内（主窗收起即隐藏聊天列）；这里只关闭
                // 「独立聊天窗」这一能力（未打开时是 no-op）。
                super::windows_chat::close_chat_window();
                Ok(())
            }
        }
    }

    // ── 快捷键 ──

    fn apply_shortcut(&mut self, shortcut: PlatformShortcut) -> AppResult<()> {
        if self.hotkey_registered {
            unsafe { UnregisterHotKey(self.main, HOTKEY_ID) };
            self.hotkey_registered = false;
        }
        let ok =
            unsafe { RegisterHotKey(self.main, HOTKEY_ID, shortcut.modifiers, shortcut.key_code) }
                != 0;
        if !ok {
            return Err(AppError::Config(
                "RegisterHotKey 失败（组合可能被其他应用占用），快捷键未注册".into(),
            ));
        }
        self.hotkey_registered = true;
        rust_info!(
            "全局快捷键已注册（VK={:#x}，modifiers={:#x}）",
            shortcut.key_code,
            shortcut.modifiers
        );
        Ok(())
    }

    // ── 退出 ──

    fn quit(&mut self) {
        self.run_exit_once();
        self.stop_frame_timer();
        if self.track_timer_active {
            unsafe { KillTimer(self.main, TIMER_TRACK) };
            self.track_timer_active = false;
        }
        if let Some(layout) = self.main_layout.as_mut() {
            super::windows_main::teardown(layout);
        }
        if let Some(nid) = &self.tray_nid {
            unsafe { Shell_NotifyIconW(NIM_DELETE, nid) };
        }
        unsafe { DestroyWindow(self.main) };
    }

    fn run_exit_once(&mut self) {
        if self.exiting {
            return;
        }
        self.exiting = true;
        rust_info!("退出序列开始");
        // W8a：先释放聊天域持有的预览/解码资源（本地资源，不依赖 Node 收尾）。
        crate::ui::chat::on_host_exit();
        self.exit_hook.run();
    }
}

// ==========================================
// 窗口过程
// ==========================================

unsafe extern "system" fn main_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            if wparam == TIMER_FRAME {
                frame_tick();
            } else if wparam == TIMER_TRACK {
                track_tick();
            }
            0
        }
        WM_HOTKEY => {
            rust_debug!("收到 WM_HOTKEY 全局快捷键");
            let _ = with_ui(|ui| ui.begin_toggle());
            0
        }
        WM_APP_DRAIN => {
            // 跨线程任务（UiHandle / 快捷键注册）在主线程执行。
            if let Some(queue) = UI.with(|cell| cell.borrow().as_ref().map(|ui| ui.queue.clone())) {
                queue.drain();
            }
            0
        }
        WM_SIZE => {
            // W9a：主窗尺寸变化 → 舞台子窗口与聊天列同步重排。
            let _ = with_ui(|ui| {
                ui.relayout_main();
                ui.submit_frame(1.0);
            });
            0
        }
        WM_NCCALCSIZE => {
            // A3：无边框可缩放窗口的标准做法 —— 取消非客户区，
            // 客户区 = 整窗；缩放边框由 DefWindowProc 的默认命中测试提供
            // （见 WM_NCHITTEST 的兜底分支）。
            if wparam != 0 {
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_GETMINMAXINFO => {
            // A3：可缩放主窗的最小尺寸（WS_THICKFRAME 生效后必须自行约束）。
            let info = unsafe { &mut *(lparam as *mut MainMinMaxInfo) };
            let scale = f64::from(unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE))
                / f64::from(DPI_BASELINE);
            info.pt_min_track_size = POINT {
                x: (MAIN_WINDOW_MIN_WIDTH * scale).round() as i32,
                y: (MAIN_WINDOW_MIN_HEIGHT * scale).round() as i32,
            };
            0
        }
        WM_EXITSIZEMOVE => {
            // A3：交互式移动/缩放结束（边沿触发，天然去抖）→ 几何写回。
            commit_window_geometry_writeback(hwnd);
            0
        }
        WM_LBUTTONDOWN => {
            // W9a：命中分隔条区域 → 进入拖动改聊天列宽度。
            let x = (lparam & 0xFFFF) as i16 as i32;
            let _ = with_ui(|ui| {
                if let Some(layout) = ui.main_layout.as_mut() {
                    let main = ui.main;
                    if super::windows_main::begin_divider_drag(layout, main, x) {
                        unsafe {
                            SetCapture(main);
                        }
                    }
                }
            });
            0
        }
        WM_MOUSEMOVE => {
            let x = (lparam & 0xFFFF) as i16 as i32;
            let _ = with_ui(|ui| {
                if let Some(layout) = ui.main_layout.as_mut() {
                    let main = ui.main;
                    super::windows_main::drag_divider_to(layout, main, x);
                }
            });
            0
        }
        WM_SETCURSOR => {
            // 悬停在分隔条热区 → 列宽调整光标（与 macOS 的 `columnResizeCursor`
            // 对称；命中口径与按下进入拖动共用 `divider_hit_test`，不会漂移）。
            // 只在客户区（HTCLIENT）处理，缩放边框等其它区域的默认光标不变。
            let hit_code = (lparam & 0xFFFF) as u32;
            if hit_code == HTCLIENT {
                let mut pt = POINT { x: 0, y: 0 };
                unsafe {
                    GetCursorPos(&mut pt);
                    ScreenToClient(hwnd, &mut pt);
                }
                let over_divider = with_ui(|ui| {
                    ui.main_layout.as_ref().is_some_and(|layout| {
                        super::windows_main::divider_hit_test(layout, ui.main, pt.x)
                    })
                })
                .unwrap_or(false);
                if over_divider {
                    // windows-sys 0.52 的 HINSTANCE 是 isize（不是指针），空实例句柄写 0；
                    // IDC_SIZEWE 本身就是 PCWSTR 常量，不用再转。
                    unsafe { SetCursor(LoadCursorW(0, IDC_SIZEWE)) };
                    return 1;
                }
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_LBUTTONUP => {
            let _ = with_ui(|ui| {
                if let Some(layout) = ui.main_layout.as_mut() {
                    super::windows_main::end_divider_drag(layout);
                }
                unsafe {
                    ReleaseCapture();
                }
            });
            0
        }
        WM_COMMAND => {
            match (wparam & 0xFFFF) as usize {
                CMD_SHOW => {
                    let _ = with_ui(|ui| ui.show_main());
                }
                CMD_CHAT => {
                    let _ = with_ui(|ui| ui.toggle_chat_panel());
                }
                CMD_SETTINGS => {
                    // 经 SettingsUi 门禁（同 macOS：建窗 + 拉取 + 刷新通道）。
                    crate::ui::settings::settings_ui().open_window();
                }
                CMD_EDITOR => {
                    crate::ui::editor::editor_ui().open_window();
                }
                CMD_QUIT => {
                    let _ = with_ui(|ui| ui.quit());
                }
                _ => {}
            }
            0
        }
        WM_TRAY => {
            match lparam as u32 {
                WM_LBUTTONUP => {
                    let _ = with_ui(|ui| ui.show_main());
                }
                WM_RBUTTONUP => {
                    // 右键弹菜单：显示 / 退出。
                    unsafe {
                        let menu = CreatePopupMenu();
                        AppendMenuW(menu, MF_STRING, CMD_SHOW, wide("显示").as_ptr());
                        // W9a：聊天列与设置窗的明确入口（不自动弹窗）。
                        AppendMenuW(menu, MF_STRING, CMD_CHAT, wide("聊天").as_ptr());
                        AppendMenuW(menu, MF_STRING, CMD_SETTINGS, wide("设置").as_ptr());
                        AppendMenuW(menu, MF_STRING, CMD_EDITOR, wide("图层编辑器").as_ptr());
                        AppendMenuW(menu, MF_SEPARATOR, 0, wide("").as_ptr());
                        AppendMenuW(menu, MF_STRING, CMD_QUIT, wide("退出").as_ptr());
                        let mut pt = POINT { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        // 先置前台再弹菜单，保证点击别处菜单能收起。
                        SetForegroundWindow(hwnd);
                        TrackPopupMenu(
                            menu,
                            TPM_RIGHTBUTTON,
                            pt.x,
                            pt.y,
                            0,
                            hwnd,
                            std::ptr::null(),
                        );
                    }
                }
                _ => {}
            }
            0
        }
        WM_NCHITTEST => {
            // A1：聊天列顶栏条 → 标题区（系统拖动主窗）；其余点走默认判定，
            // 分隔条拖动（WM_LBUTTONDOWN 路径）不受影响。
            let sx = (lparam & 0xFFFF) as u16 as i16 as i32;
            let sy = ((lparam >> 16) & 0xFFFF) as u16 as i16 as i32;
            if super::windows_chat::pane_titlebar_screen_hit(sx, sy) {
                return HTCAPTION as LRESULT;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            // 主窗关闭请求 = 收起（不销毁、不退出）。
            let _ = with_ui(|ui| ui.begin_toggle());
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// A3：交互式移动/缩放结束后的几何写回（尺寸恒写；固定位置模式才写位置）。
///
/// 只读窗口矩形与 DPI（不依赖控件状态）；提交走 `ui::geometry_writeback` 的
/// 单向请求面 —— CONFIG 的唯一写入者仍是 Node（`setOverride` + `flushConfig`）。
/// 程序应用（Node 推送的 `set_popup_size`）若触发本边沿（正常路径不会：程序性
/// `SetWindowPos` 不产生 `WM_EXITSIZEMOVE`），与刚应用值一致的观测跳过写回
/// （防「应用 → 写回 → 再应用」回路，见 `geometry_writeback::AppliedSize`）。
fn commit_window_geometry_writeback(hwnd: HWND) {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(hwnd, &mut rect) };
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE);
    let scale = f64::from(dpi) / f64::from(DPI_BASELINE);
    let width = f64::from(rect.right - rect.left) / scale;
    let height = f64::from(rect.bottom - rect.top) / scale;
    let applied = UI.with(|cell| cell.borrow().as_ref().map(|ui| ui.applied_size));
    if applied.map_or(false, |applied| applied.suppresses(width, height)) {
        rust_debug!("程序应用的尺寸不写回（与最近推送值一致）");
    } else {
        crate::ui::geometry_writeback::request_size_writeback(width, height);
    }
    // 位置：固定语义（含「固定但还没有坐标」的过渡态）才把左上角（逻辑像素，
    // 左上原点）写回 `fixedPosition` —— 第一次拖动就把坐标落下，固定模式才有第一份位置。
    let placement = UI.with(|cell| cell.borrow().as_ref().map(|ui| ui.placement));
    if placement.map_or(false, |placement| placement.is_fixed()) {
        let x = f64::from(rect.left) / scale;
        let y = f64::from(rect.top) / scale;
        crate::ui::geometry_writeback::request_position_writeback(x, y);
        // 用户刚拖到的位置就是固定位置：同步宿主摆放快照（Node 持久化后不回推），
        // 否则下一次呼出会按旧坐标摆回并把旧坐标再次写回 CONFIG。
        UI.with(|cell| {
            if let Some(ui) = cell.borrow_mut().as_mut() {
                ui.placement = PlacementMode::Fixed { x, y };
            }
        });
    }
}

unsafe extern "system" fn aux_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let code = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as usize;
    match msg {
        WM_CLOSE => {
            // W9a：编辑器有未保存改动时先确认（保存并关闭 / 放弃 / 取消）。
            if code == 2 && !super::windows_editor::confirm_close(hwnd) {
                return 0;
            }
            DestroyWindow(hwnd);
            0
        }
        // ── 主题：字色/ownerdraw/窗底（设置窗 code 1、编辑器窗 code 2；查看器不自绘主题）──
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => {
            if code == 1 {
                return super::windows_settings::on_ctlcolor(wparam, lparam);
            }
            if code == 2 {
                return super::windows_editor::on_ctlcolor(wparam, lparam);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_DRAWITEM => {
            // ownerdraw 主按钮（保存类；角色存在控件自身，绘制逻辑在各自模块）。
            if lparam != 0 {
                if code == 1 && super::windows_settings::on_drawitem(lparam) {
                    return 1;
                }
                if code == 2 && super::windows_editor::on_drawitem(lparam) {
                    return 1;
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_ERASEBKGND => {
            // 类刷留空（见 run_service 的附属窗类注册），窗底在这里按主题画；
            // 返回 1 = 已擦除，避免系统再抹一遍。WS_CLIPCHILDREN 保证不画到子控件上。
            if code == 1 {
                super::windows_settings::paint_background(hwnd, wparam as HDC);
                return 1;
            }
            if code == 2 {
                super::windows_editor::paint_background(hwnd, wparam as HDC);
                return 1;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_COMMAND => {
            if code == 1 {
                super::windows_settings::on_command(hwnd, wparam);
            } else if code == 2 {
                super::windows_editor::on_command(hwnd, wparam);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_VSCROLL => {
            if code == 1 {
                super::windows_settings::on_vscroll(hwnd, wparam);
                return 0;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_LBUTTONDOWN => {
            if code == 2 {
                let x = (lparam & 0xFFFF) as i16 as i32;
                let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                if super::windows_editor::on_lbutton_down(hwnd, x, y) {
                    unsafe {
                        SetCapture(hwnd);
                    }
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_MOUSEMOVE => {
            if code == 2 {
                let x = (lparam & 0xFFFF) as i16 as i32;
                let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                super::windows_editor::on_mouse_move(hwnd, x, y);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        // 编辑器滚轮缩放（与 macOS `scrollWheel:` 同口径）。设置窗（code == 1）用
        // WM_VSCROLL 滚自己的列表，不吃滚轮，所以这里只认 code == 2。
        WM_MOUSEWHEEL => {
            if code == 2 {
                super::windows_editor::on_mouse_wheel(hwnd, wparam);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_LBUTTONUP => {
            if code == 2 {
                super::windows_editor::on_lbutton_up();
                unsafe {
                    ReleaseCapture();
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_PAINT => {
            // W8a：查看器窗口的帧绘制（聊天窗有自己的窗口过程，不走这里）。
            // 设置窗 / 编辑器窗：自绘主题窗底（WM_ERASEBKGND 之外的兜底路径 ——
            // 无擦除标记的失效、换主题后的强制重绘都只走 WM_PAINT）。
            if code == 3 {
                crate::ui::platform::windows_chat::paint_viewer(hwnd);
                return 0;
            }
            if code == 1 || code == 2 {
                unsafe {
                    let mut ps: PAINTSTRUCT = std::mem::zeroed();
                    let hdc = BeginPaint(hwnd, &mut ps);
                    if code == 1 {
                        super::windows_settings::paint_background(hwnd, hdc);
                    } else {
                        super::windows_editor::paint_background(hwnd, hdc);
                    }
                    EndPaint(hwnd, &ps);
                }
                return 0;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_SIZE => {
            if code == 3 {
                // 查看器内容随窗口缩放重绘。
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            } else if code == 1 {
                super::windows_settings::on_size(hwnd);
            } else if code == 2 {
                super::windows_editor::on_size(hwnd);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_DESTROY => {
            if let Some(window) = window_id_from_code(code) {
                let _ = with_ui(|ui| {
                    ui.aux.remove(&window);
                    rust_info!("附属窗口 {} 已关闭并释放", window.label());
                });
                match window {
                    WindowId::Viewer => {
                        // W8a：查看器帧与预览 owner 一并收口（§5.3 的释放点）。
                        crate::ui::platform::windows_chat::note_viewer_destroyed();
                    }
                    WindowId::Settings => {
                        // W9a：控件与字体随窗口释放；草稿丢弃、字体预览回滚。
                        super::windows_settings::on_destroy();
                    }
                    WindowId::LayerEditor => {
                        // W9a：预览渲染器与控件随窗口释放；主窗舞台退出预览。
                        super::windows_editor::on_destroy();
                        let _ = with_ui(|ui| {
                            if let Some(layout) = ui.main_layout.as_mut() {
                                super::windows_main::clear_editor_preview(layout);
                            }
                        });
                    }
                    _ => {}
                }
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 帧回调：可见期推进动画；隐藏后不应再有回调（防御性停表并留痕）。
/// 可见期跟踪：全局光标喂给舞台渲染器（W9a；隐藏期计时器已停）。
fn track_tick() {
    with_ui(|ui| {
        if let Some(layout) = ui.main_layout.as_mut() {
            super::windows_main::track(layout);
        }
    })
    .ok();
}

fn frame_tick() {
    let now = now_ms();
    let outcome = with_ui(|ui| ui.machine.tick(now));
    match outcome {
        Ok(Tick::Idle) => {
            let _ = with_ui(|ui| ui.stop_frame_timer());
            rust_debug!("帧回调落在非动画态，已防御性停表");
        }
        Ok(Tick::Frame(visual)) => {
            let _ = with_ui(|ui| ui.submit_frame(visual.opacity));
        }
        Ok(Tick::RetractFinished) => {
            let _ = with_ui(|ui| {
                ui.stop_frame_timer();
                ui.set_stage_visible(false);
                super::windows_chat::main_window_visibility_changed(false);
                // 收起完成：交还前台（焦点回到呼出前的应用；须在 SW_HIDE 之前，
                // 理由见函数注释），随后隐藏主窗并清掉记录。
                hand_back_foreground(ui);
                unsafe { ShowWindow(ui.main, SW_HIDE) };
                ui.prev_foreground = 0;
                ui.play_cue(AudioCue::Retract);
            });
            rust_info!("收起动画结束 → KillTimer + SW_HIDE（hidden 零帧）");
        }
        Ok(Tick::RevealFinished) => {
            let _ = with_ui(|ui| {
                ui.stop_frame_timer();
                ui.submit_frame(1.0);
                ui.play_cue(AudioCue::Popup);
            });
            rust_info!("呼出动画结束 → KillTimer");
        }
        Err(_) => {}
    }
}

// ==========================================
// 平台入口（`ui/platform/mod.rs` 按目标平台转发到这里）
// ==========================================

pub fn run_service(request: ServiceRequest) -> AppResult<i32> {
    // DPI 感知：打包清单（W10）之外的运行时兜底；失败（已设置或旧系统）忽略。
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };

    let ServiceRequest {
        queue,
        exit_hook,
        audio,
        e2e: _,
        mut on_ui_ready,
    } = request;

    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = Some(main_wndproc);
        wc.hInstance = hinstance;
        let main_class = wide(MAIN_CLASS);
        wc.lpszClassName = main_class.as_ptr();
        if RegisterClassW(&wc) == 0 {
            return Err(AppError::Other("RegisterClassW（主窗）失败".into()));
        }
        let mut wc_aux: WNDCLASSW = std::mem::zeroed();
        wc_aux.style = CS_HREDRAW | CS_VREDRAW;
        wc_aux.lpfnWndProc = Some(aux_wndproc);
        wc_aux.hInstance = hinstance;
        let aux_class = wide(AUX_CLASS);
        wc_aux.lpszClassName = aux_class.as_ptr();
        // 类刷留空：设置窗 / 编辑器窗的窗底由各自内容的 WM_ERASEBKGND/WM_PAINT
        // 按主题画（换主题不必重注册窗口类；与提示对话框同一做法）。
        wc_aux.hbrBackground = 0;
        if RegisterClassW(&wc_aux) == 0 {
            return Err(AppError::Other("RegisterClassW（附属窗）失败".into()));
        }
    }

    let scale = f64::from(unsafe { GetDpiForSystem() }.max(DPI_BASELINE)) / f64::from(DPI_BASELINE);
    let width = (MAIN_WINDOW_WIDTH * scale).round() as i32;
    let height = (MAIN_WINDOW_HEIGHT * scale).round() as i32;
    let x = (unsafe { GetSystemMetrics(SM_CXSCREEN) } - width) / 2;
    let y = (unsafe { GetSystemMetrics(SM_CYSCREEN) } - height) / 2;
    let main_class = wide(MAIN_CLASS);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            main_class.as_ptr(),
            wide("Desk-Pet").as_ptr(),
            // A3：WS_THICKFRAME 提供「拖边缘改窗口尺寸」能力（无边框 + 可缩放的
            // 标准组合）；配合 WM_NCCALCSIZE 取消非客户区保持客户区 = 整窗。
            // 用户改尺寸后由 WM_EXITSIZEMOVE 写回 general.popup.defaultSize。
            WS_POPUP | WS_THICKFRAME | WS_VISIBLE,
            x,
            y,
            width,
            height,
            0,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        return Err(AppError::Other("主窗口创建失败（CreateWindowExW）".into()));
    }

    // 主线程队列唤醒器：PostMessageW 到主窗消息循环（跨线程投递不阻塞）。
    let hwnd_for_wake: isize = hwnd;
    queue.install_waker(Arc::new(move || unsafe {
        PostMessageW(hwnd_for_wake, WM_APP_DRAIN, 0, 0);
    }));
    // W8a/W9a：聊天/设置/编辑器三个域的渲染调度共用同一份主线程队列
    // （数据来自 IPC 线程时经它回主线程）。
    crate::ui::chat::install_main_queue(queue.clone());
    crate::ui::settings::install_main_queue(queue.clone());
    crate::ui::editor::install_main_queue(queue.clone());

    // 托盘（Shell_NotifyIconW）。
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = TRAY_ID;
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = unsafe { LoadIconW(0, IDI_APPLICATION) };
    let tip = wide("Desk-Pet");
    for (index, unit) in tip.iter().take(127).enumerate() {
        nid.szTip[index] = *unit;
    }
    let tray_ok = unsafe { Shell_NotifyIconW(NIM_ADD, &nid) } != 0;
    if tray_ok {
        rust_info!("托盘已创建（Shell_NotifyIcon，菜单：显示 / 退出）");
    } else {
        rust_warn!("托盘创建失败（Shell_NotifyIconW NIM_ADD 返回 0）；窗口与快捷键仍可用");
    }

    // W9a：主窗一体布局（舞台子窗口 + 聊天列；失败不中止宿主，如实留痕）。
    let main_layout = match super::windows_main::install(hwnd) {
        Ok(mut layout) => {
            super::windows_main::set_stage_visible(&mut layout, true);
            Some(layout)
        }
        Err(error) => {
            rust_warn!("主窗一体布局建立失败（窗口仍可用）: {error}");
            None
        }
    };
    UI.with(|cell| {
        *cell.borrow_mut() = Some(WinUi {
            main: hwnd,
            aux: HashMap::new(),
            machine: ShowHideMachine::new(),
            auto_popup: CommittedAssistantTracker::new(),
            placement: PlacementMode::Cursor,
            prev_foreground: 0,
            timer_active: false,
            hotkey_registered: false,
            tray_nid: if tray_ok { Some(nid) } else { None },
            queue,
            exit_hook,
            audio,
            audio_unwired_reported: false,
            exiting: false,
            dib: None,
            backdrop_key: None,
            main_layout,
            track_timer_active: false,
            allow_editor_close: false,
            applied_size: crate::ui::geometry_writeback::AppliedSize::default(),
        });
    });
    // 可见期光标跟踪（灵动图层的输入；隐藏/收起时停表）。
    unsafe { SetTimer(hwnd, TIMER_TRACK, 16, None) };
    with_ui(|ui| ui.track_timer_active = true).ok();
    rust_info!("原生 UI 已就绪（主窗/托盘/快捷键等待 Node 推送）");

    // 收尾接线（拉起 Node）放在窗口与托盘之后（执行契约 §4.3 第 1 步的顺序）。
    if let Some(hook) = on_ui_ready.take() {
        std::thread::Builder::new()
            .name("deskpet-node-start".into())
            .spawn(hook)
            .map_err(|error| rust_warn!("Node 启动线程创建失败: {error}"))
            .ok();
    }

    // 消息循环。
    let mut message: MSG = unsafe { std::mem::zeroed() };
    unsafe {
        while GetMessageW(&mut message, 0, 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    UI.with(|cell| *cell.borrow_mut() = None);
    rust_info!("原生消息循环结束");
    Ok(0)
}

// ── 跨线程句柄（UiHandle / MainThreadPort）落到本平台的操作 ──

pub fn window_show(window: WindowId, focus: bool) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        unsafe { ShowWindow(hwnd, SW_SHOW) };
        if focus {
            unsafe { SetForegroundWindow(hwnd) };
        }
        if window == WindowId::Main {
            // W9a：主窗重新显示 → 布局重排 + 舞台恢复（帧循环与光标跟踪）。
            ui.relayout_main();
            ui.set_stage_visible(true);
        }
        Ok(())
    })?
}

pub fn window_hide(window: WindowId) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        unsafe { ShowWindow(hwnd, SW_HIDE) };
        if window == WindowId::Main {
            // W9a：隐藏边沿 → 舞台停帧、光标跟踪停表（隐藏不绘制）。
            ui.set_stage_visible(false);
            super::windows_chat::set_main_pane_visible(hwnd, false);
        }
        Ok(())
    })?
}

pub fn window_focus(window: WindowId) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        unsafe { SetForegroundWindow(hwnd) };
        Ok(())
    })?
}

pub fn window_set_level(window: WindowId, level: WindowLevel) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        unsafe { crate::window::platform::apply_windows_window_level(hwnd, level) };
        Ok(())
    })?
}

pub fn window_present(window: WindowId) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        unsafe { crate::window::platform::present_windows_window(hwnd, window) };
        Ok(())
    })?
}

pub fn window_visibility(window: WindowId) -> AppResult<WindowVisibility> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        Ok(WindowVisibility {
            visible: unsafe { IsWindowVisible(hwnd) } != 0,
            focused: unsafe { GetForegroundWindow() } == hwnd,
            minimized: unsafe { IsIconic(hwnd) } != 0,
        })
    })?
}

pub fn window_set_position(window: WindowId, x: i32, y: i32) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui
            .hwnd(window)
            .ok_or_else(|| AppError::Other(format!("窗口 {} 不存在", window.label())))?;
        // WindowPort 的口径是逻辑像素；用**窗口当前所在监视器**的 DPI 换算
        // （跨屏且两屏 DPI 不同的移动会先落一格旧 DPI，W11 实机核对该边界）。
        let scale = ui.dpi_scale(hwnd);
        let x_phys = (f64::from(x) * scale).round() as i32;
        let y_phys = (f64::from(y) * scale).round() as i32;
        unsafe {
            SetWindowPos(
                hwnd,
                0,
                x_phys,
                y_phys,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        Ok(())
    })?
}

pub fn window_open_devtools(_window: WindowId) -> AppResult<()> {
    // 原生宿主没有 WebView，也就没有开发者工具可开；如实报错（F3 判据）。
    Err(AppError::Other(
        "原生宿主没有开发者工具（WebView 已从产品形态移除）".into(),
    ))
}

pub fn open_aux_window(window: WindowId) -> AppResult<()> {
    with_ui(|ui| ui.open_aux(window))?
}

pub fn close_window(window: WindowId) -> AppResult<()> {
    with_ui(|ui| ui.close_aux(window))?
}

pub fn set_popup_placement(mode: PlacementMode) -> AppResult<()> {
    with_ui(|ui| {
        ui.placement = mode;
        // 带坐标的固定位置：立即摆位（切过去/坐标更新都马上生效，不必等下一次呼出）。
        // 跟随光标与过渡态（fixed 但还没有坐标）：不动窗口，下一次呼出按光标落位；
        // 过渡态下拖动结束的写回照常落坐标（`is_fixed` 语义）。
        // **未在 Windows 实机验证**（同 W9a 约定，本机只做离线类型核对）。
        if let Some((x, y)) = mode.immediate_placement() {
            let hwnd = ui.main;
            let scale = ui.dpi_scale(hwnd);
            let (width_phys, height_phys) = ui.physical_size(hwnd);
            let size_log = (
                f64::from(width_phys) / scale,
                f64::from(height_phys) / scale,
            );
            let origin = ui.fixed_origin(x, y, size_log);
            let x_phys = (origin.0 * scale).round() as i32;
            let y_phys = (origin.1 * scale).round() as i32;
            unsafe {
                SetWindowPos(
                    hwnd,
                    0,
                    x_phys,
                    y_phys,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            rust_info!(
                "固定位置模式：主窗立即摆到 ({:.0},{:.0})",
                origin.0,
                origin.1
            );
        }
        rust_info!("弹窗摆位模式已更新: {mode:?}");
    })
}

/// 应用 Node 推送的弹窗默认尺寸（`general.popup.defaultSize`；A3 运行时闭环）。
///
/// 保持左上角不动、立即改尺寸；先记录 `applied_size` 再 `SetWindowPos` —— 程序性
/// 改尺寸若触发写回边沿（正常路径不会），按记录跳过（防「应用 → 写回 → 再应用」
/// 回路，见 `geometry_writeback::AppliedSize`）。
/// **未在 Windows 实机验证**（同 W9a 约定）。
pub fn set_popup_size(width: f64, height: f64) -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui.main;
        let scale = ui.dpi_scale(hwnd);
        ui.applied_size.record(width, height);
        let w_phys = (width * scale).round() as i32;
        let h_phys = (height * scale).round() as i32;
        unsafe {
            SetWindowPos(
                hwnd,
                0,
                0,
                0,
                w_phys,
                h_phys,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        // 尺寸变化 → 一体布局重排与重绘（与 WM_SIZE 处理同体；隐藏期同样执行）。
        ui.relayout_main();
        ui.submit_frame(1.0);
        rust_info!("弹窗尺寸已应用（{width}×{height}，左上角保持）");
        Ok(())
    })?
}

// ── W9a：主窗一体布局 / 字体 / 设置窗 / 编辑器窗的平台入口 ──

/// 应用全局字体快照到所有原生窗口控件（主窗阶段不受字体影响）。
pub fn apply_font_snapshot(snapshot: crate::ui::font::FontSnapshot) -> AppResult<()> {
    with_ui(|ui| ui.apply_font(snapshot))
}

/// 应用界面主题到所有原生窗口（`appearance.theme` 的 Native 投影，见 [`crate::ui::theme`]）。
///
/// `UiHandle::apply_theme` 已先做 `normalize → store → warm_up`；这里只做平台侧广播与重绘。
pub fn apply_theme(id: crate::ui::theme::ThemeId) -> AppResult<()> {
    with_ui(|ui| ui.apply_theme(id))
}

/// 应用主窗舞台快照（Node 推送的 Profile + appearance 投影）。
pub fn apply_stage_profile(profile: crate::ui::stage::StageProfile) -> AppResult<()> {
    with_ui(|ui| match ui.main_layout.as_mut() {
        Some(layout) => {
            super::windows_main::apply_stage_profile(layout, profile);
            Ok(())
        }
        None => Err(AppError::Other("主窗布局未建立，舞台快照暂存失败".into())),
    })?
}

/// 主窗聊天列开合与宽度（`general.popup.chatWidth` 推送入口）。
///
/// `open = None` 只应用宽度、保持当前开合（设置保存后的推送走这条；见
/// `UiHandle::set_chat_panel`）。
pub fn set_chat_panel(open: Option<bool>, width: Option<f64>) -> AppResult<()> {
    with_ui(|ui| {
        let main = ui.main;
        let Some(layout) = ui.main_layout.as_mut() else {
            return Err(AppError::Other("主窗布局未建立".into()));
        };
        if let Some(width) = width {
            super::windows_main::set_chat_width(layout, main, Some(width));
        }
        if let Some(open) = open {
            super::windows_main::set_chat_visible(layout, main, open);
        }
        Ok(())
    })?
}

/// 打开设置窗（设置域的入口）。
pub fn open_settings_window() -> AppResult<()> {
    with_ui(|ui| ui.open_aux(WindowId::Settings))?
}

// ── A1：顶栏（主窗聊天列顶部的标题条）──

/// 顶栏「关闭」：收起主窗（不退出、不销毁；与主窗关闭请求同一归宿）。
///
/// 只在可见态接受（隐藏/动画中按护栏忽略，与呼出收回状态机一致）。
/// **未在 Windows 实机验证**（本机只做离线核对，同 W9a 的既有约定）。
pub fn retract_main_window() -> AppResult<()> {
    with_ui(|ui| {
        if ui.machine.stage() != Stage::Visible {
            rust_debug!("顶栏收起请求在隐藏/动画中被忽略");
            return;
        }
        let accepted = ui.machine.begin_retract(now_ms());
        if accepted {
            ui.start_retract();
        } else {
            rust_debug!("顶栏收起被重复按键护栏忽略");
        }
    })
}

/// 顶栏状态位文本刷新（[`crate::ui::titlebar`] 的文本已由 `UiHandle` 存入）。
pub fn refresh_titlebar(text: String) -> AppResult<()> {
    // 全窗宽顶栏（`windows_main`）与聊天列内旧顶栏（`windows_chat`，本批被全窗宽
    // 顶栏覆盖）都持同一份快照的展示副本；文本唯一真值仍是 `ui/titlebar.rs`。
    super::windows_main::set_titlebar_text(&text);
    super::windows_chat::apply_titlebar_text(&text);
    // 顶栏文本变化常与「回复已提交、typing owner 释放」同步到达：这是自动呼出的
    // 第二个触发点（第一个在 `apply_chat_projection` 的落帧处）。两处都只做幂等
    // 检查（判定器按会话内条目 id 去重），先到先算、重复到达无害。
    note_auto_popup_check();
    Ok(())
}

/// 自动呼出检查入口（`apply_chat_projection` 落帧后与顶栏文本刷新时调用）。
///
/// 已由调用方经 `UiHandle::run_on_main` 投递到 UI 主线程（IPC 分派层）；本函数不
/// 再自行跨线程。原生 UI 未启动（无窗口宿主/E2E 隔离宿主）时无窗口可呼出：按
/// 无操作跳过并留痕 —— 呼出检查是派生效果，不是调用方需要感知的失败（正文投影
/// 本身已经应用）。
pub(crate) fn note_auto_popup_check() {
    if let Err(error) = with_ui(|ui| ui.maybe_auto_popup_on_committed()) {
        rust_debug!("自动呼出检查跳过：原生 UI 未初始化（无窗口可呼出）: {error}");
    }
}

/// 设置窗内容刷新（数据到达/保存回执）。
pub fn settings_refresh() -> AppResult<()> {
    super::windows_settings::refresh_ui();
    Ok(())
}

/// 单行文本输入弹窗（模态；取消返回 None）。设置窗「重命名 Profile」等入口共用。
pub fn prompt_text(title: &str, label: &str, initial: &str) -> AppResult<Option<String>> {
    super::windows_settings::prompt_text(title, label, initial)
}

/// 打开图层编辑器窗。
pub fn open_editor_window() -> AppResult<()> {
    with_ui(|ui| ui.open_aux(WindowId::LayerEditor))?
}

/// 编辑器界面刷新（草稿/保存状态变化）。
pub fn editor_refresh() -> AppResult<()> {
    super::windows_editor::refresh_ui();
    Ok(())
}

/// 关闭编辑器窗（保存并关闭路径；跳过未保存确认）。
pub fn close_editor_window() -> AppResult<()> {
    with_ui(|ui| {
        let hwnd = ui.aux.remove(&WindowId::LayerEditor);
        match hwnd {
            Some(hwnd) => {
                unsafe { DestroyWindow(hwnd) };
                Ok(())
            }
            None => Err(AppError::Other("编辑器窗口未打开".into())),
        }
    })?
}

/// 编辑器预览同步到主窗舞台（主窗/预览一致的唯一落点）。
pub(crate) fn apply_editor_preview_to_stage(
    layers: Vec<crate::render::LayerSpec>,
    intensity: f64,
    promote: bool,
) -> AppResult<()> {
    with_ui(|ui| match ui.main_layout.as_mut() {
        Some(layout) => {
            super::windows_main::editor_preview(layout, layers, intensity);
            if promote {
                super::windows_main::promote_editor_preview(layout);
            }
            Ok(())
        }
        None => Err(AppError::Other("主窗布局未建立".into())),
    })?
}

pub fn apply_global_shortcut(shortcut: PlatformShortcut) -> AppResult<()> {
    with_ui(|ui| ui.apply_shortcut(shortcut))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 窗口判别值往返一致() {
        for window in [WindowId::Settings, WindowId::LayerEditor, WindowId::Viewer] {
            assert_eq!(window_id_from_code(window_id_code(window)), Some(window));
        }
        assert_eq!(window_id_from_code(window_id_code(WindowId::Main)), None);
    }

    #[test]
    fn 新建样式与层级的映射来自单一真值() {
        assert_eq!(
            crate::ui::creation_level(WindowId::Settings),
            WindowLevel::Settings
        );
        assert_eq!(
            crate::ui::creation_level(WindowId::Viewer).macos_level(),
            1200
        );
    }
}
