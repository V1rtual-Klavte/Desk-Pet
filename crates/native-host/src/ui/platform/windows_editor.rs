//! 图层编辑器窗内容（W9a，Windows）：五层编辑 + 第二个渲染器预览。
//!
//! 与 macOS 同语义：预览 = 第二个 `Renderer`，只绑定独立的分层子窗口。
//! 顶层窗口用常规 GDI 绘制，属性控件和预览是互不覆盖的兄弟窗口。
//! 预览层列表经**线索投影**（`editor::cue_specs`：选中 1.0 / 启用 0.6 / 禁用 0.15，
//! 五层恒渲染），草稿（不含线索）同步投给主窗舞台（主窗/预览一致），
//! 保存走 `EditorUi::save`。
//!
//! 与 macOS 的已登记差异：
//! - 强度/灵敏度/缩放用滑杆，位置 X/Y 用数字输入框，与 macOS 同形；
//!   预览区域按左键拖动；**位置输入不设范围**（任意有限值都接受）—— 两边共享同一条
//!   领域规则：偏移可拖到任意位置，框外部分由取景框裁掉
//!   （`ui/editor/mod.rs::EditorDraft::set_offset` 不夹取，2026-10-05 用户裁决）。
//!   数值解析/显示与提交后的单轴保留走共享纯函数（`parse_number_input` /
//!   `op_set_offset_input`），两平台不各写一份。
//! - 素材列表用 `COMBOBOX`（`CBS_DROPDOWNLIST`，macOS 侧是 `NSPopUpButton`）；
//! - 未保存改动的关闭确认用 `MessageBoxW`（是 = 保存并关闭 / 否 = 放弃 / 取消 = 留下）；
//!   「没有素材？」素材提示词面板用**非模态**的自建 owned window（`MessageBoxW`
//!   装不下「可滚动正文 + 复制按钮」，而帮助内容也不该锁窗；与 macOS 的 transient
//!   NSPopover 对称）。
//! 本文件全部代码只在 UI 主线程运行。
//!
//! ## 主题接线（范围 c：图层编辑器）
//!
//! 口径与设置窗同（`WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN` 字色、ownerdraw 主按钮、
//! [paint_background] 自绘窗底），差异是编辑器的画布语义：
//! - 左列控件区与底部按钮条用 `tokens().field_bg`（工作台面色）；
//! - **预览区（左列右侧）用 `tokens().stage_bg`** —— 预览是角色图层落在舞台底上的
//!   合成，与主窗舞台同一底色语义；
//! - 两区之间与底部按钮条上沿用 `rule` 分隔线。
//!
//! 预览背板、中心线和尺寸标记和角色提交到同一张位图，避免普通 GDI 绘制被 ULW 帧覆盖。

use std::cell::{Cell, RefCell};

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    ClientToScreen, CreateFontW, DeleteObject, DrawTextW, InvalidateRect, ScreenToClient,
    SelectObject, SetBkColor, SetBkMode, SetTextColor, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DT_BOTTOM, DT_RIGHT, DT_SINGLELINE, FW_BOLD, FW_NORMAL, HDC, HFONT, OUT_DEFAULT_PRECIS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    InitCommonControlsEx, ICC_BAR_CLASSES, INITCOMMONCONTROLSEX, ODS_DISABLED, ODS_GRAYED,
    ODS_SELECTED, ODT_BUTTON, TBM_SETPOS, TBM_SETRANGEMAX, TBM_SETRANGEMIN, TBS_HORZ, TBS_NOTICKS,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, IsWindowEnabled, SetCapture, SetFocus, VK_ESCAPE,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetParent,
    GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    IsIconic, IsWindowVisible, MessageBoxW, MoveWindow, RegisterClassW, SendMessageW,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowTextW, ShowWindow, BS_DEFPUSHBUTTON,
    BS_OWNERDRAW, CBN_SELENDOK, CBS_DROPDOWNLIST, CB_ADDSTRING, CB_GETCURSEL, CB_RESETCONTENT,
    CB_SETCURSEL, CS_HREDRAW, CS_VREDRAW, ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, GWL_STYLE,
    IDCANCEL, IDNO, IDOK, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNOCANCEL, SM_CXSCREEN,
    SM_CYSCREEN, SW_SHOW, WM_CLOSE, WM_COMMAND, WM_CTLCOLORSTATIC, WM_DESTROY, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_MOUSEWHEEL, WM_SETFONT, WNDCLASSW, WS_BORDER, WS_CAPTION,
    WS_CHILD, WS_CLIPSIBLINGS, WS_EX_CLIENTEDGE, WS_EX_LAYERED, WS_EX_TOPMOST, WS_POPUP,
    WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

use crate::render::geometry::WindowGeometry;
use crate::render::win::WinLayerSurface;
use crate::render::Renderer;
use crate::ui::editor::{
    asset_help_bottom_offset, editor_ui, ASSET_HELP_BUTTON, ASSET_HELP_BUTTON_H, ASSET_HELP_CLOSE,
    ASSET_HELP_COPIED, ASSET_HELP_COPY, ASSET_HELP_FONT_SIZE, ASSET_HELP_INTRO, ASSET_HELP_TITLE,
    ASSET_PROMPT,
};
use crate::ui::theme;
use crate::ui::theme::paint_win::{self, ButtonRole, TextRole};
use crate::window::DPI_BASELINE;
use crate::{rust_debug, rust_info, rust_warn};

use super::windows_chat::DrawItemStruct;

/// 层 tab 控件 ID：2000 + 层号（点击即选中该层；与 macOS 的顶部 tab 栏同构）。
const TAB_BASE: i32 = 2000;
/// 参数输入框 ID：3000 + 序号。
const EDIT_BASE: i32 = 3000;
const EDIT_SCALE: i32 = 0;
const EDIT_SENSITIVITY: i32 = 1;
const EDIT_OFFSET_X: i32 = 2;
const EDIT_OFFSET_Y: i32 = 3;
const EDIT_INTENSITY: i32 = 4;
const SLIDER_BASE: i32 = 3200;
const SLIDER_STEPS: i32 = 1000;
/// Windows SDK commctrl.h: TBM_GETPOS = WM_USER；windows-sys 0.52 未导出该常量。
const TBM_GETPOS: u32 = 0x0400;
const PREVIEW_CLASS: &str = "DeskPetEditorPreview";
const PICK_ID: i32 = 3100;
const REVERT_ID: i32 = 3101;
const SAVE_ID: i32 = 3102;
const CLOSE_ID: i32 = 3103;
const STATUS_ID: i32 = 3104;
/// 素材区控件：下拉列表（应用内素材）+ 移除/刷新。
const ASSET_COMBO_ID: i32 = 3105;
const ASSET_REMOVE_ID: i32 = 3106;
const ASSET_REFRESH_ID: i32 = 3107;
/// 单层复位（参数回默认）与位置归零：与「放弃改动」是不同操作。
const RESET_LAYER_ID: i32 = 3108;
const RESET_OFFSET_ID: i32 = 3109;
/// 顶部动作：锁定 / 可见（作用于当前选中层；旧壳 le-actions 的「解锁/可见」）。
const TOGGLE_LOCK_ID: i32 = 3110;
const TOGGLE_ENABLE_ID: i32 = 3111;
/// 右栏最下方「没有素材？」（打开素材提示词面板）。
const ASSET_HELP_ID: i32 = 3112;

/// 右侧属性面板宽度（旧壳 `#le-panel`；与 macOS 的 PANEL_W 同口径）。
const PANEL_W: i32 = 264;
const MARGIN: i32 = 12;
const PANEL_GAP: i32 = 8;
const PARAM_H: i32 = 30;
/// 顶部层 tab 栏高度（层 tab + 动作按钮）与底部状态行高度。
const TABS_H: i32 = 38;
const BOTTOM_H: i32 = 30;
/// 层 tab 固定宽度（标题超长由按钮文字截断）与顶部动作按钮尺寸。
const TAB_W: i32 = 78;
const TOP_BUTTON_W: i32 = 76;
const TOP_BUTTON_H: i32 = 26;

/// `SetBkMode` 的 TRANSPARENT：windows-sys 里 `Gdi::TRANSPARENT` 是 u32，该 API 要 i32
/// （与 `windows_chat.rs` 同款就地定义）。
const TRANSPARENT: i32 = 1;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn dpi_scale(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE);
    f64::from(dpi) / f64::from(DPI_BASELINE)
}

fn scaled(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale).round() as i32
}

/// 和 macOS 相同的左侧取景框；布局、绘制与拖动归一都取这个矩形。
fn preview_rect(width: i32, height: i32, scale: f64) -> paint_win::Rect {
    paint_win::Rect::new(
        scaled(MARGIN, scale),
        scaled(TABS_H + MARGIN, scale),
        (width - scaled(MARGIN * 2 + PANEL_W + PANEL_GAP, scale)).max(0),
        (height - scaled(TABS_H + BOTTOM_H + MARGIN * 2, scale)).max(0),
    )
}

fn slider_range(index: i32) -> Option<(f64, f64)> {
    use crate::ui::editor::{
        INTENSITY_MAX, INTENSITY_MIN, SCALE_MAX, SCALE_MIN, SENSITIVITY_MAX, SENSITIVITY_MIN,
    };
    match index {
        EDIT_SCALE => Some((SCALE_MIN, SCALE_MAX)),
        EDIT_SENSITIVITY => Some((SENSITIVITY_MIN, SENSITIVITY_MAX)),
        EDIT_INTENSITY => Some((INTENSITY_MIN, INTENSITY_MAX)),
        _ => None,
    }
}

fn slider_position(value: f64, min: f64, max: f64) -> i32 {
    (((value - min) / (max - min)).clamp(0.0, 1.0) * f64::from(SLIDER_STEPS)).round() as i32
}

/// 预览子窗口只承接绘制和鼠标；拖动捕获仍由编辑器父窗持有。
unsafe extern "system" fn preview_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let parent = unsafe { GetParent(hwnd) };
    match message {
        WM_LBUTTONDOWN => {
            let mut point = POINT {
                x: (lparam & 0xffff) as i16 as i32,
                y: ((lparam >> 16) & 0xffff) as i16 as i32,
            };
            unsafe {
                ClientToScreen(hwnd, &mut point);
                ScreenToClient(parent, &mut point);
            }
            if on_lbutton_down(parent, point.x, point.y) {
                unsafe { SetCapture(parent) };
            }
            0
        }
        WM_MOUSEWHEEL => {
            on_mouse_wheel(parent, wparam);
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn create_preview(hwnd: HWND) -> Option<HWND> {
    let class = wide(PREVIEW_CLASS);
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(preview_wndproc);
        wc.hInstance = instance;
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
    }
    let child = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED,
            class.as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            1,
            1,
            hwnd,
            0,
            instance,
            std::ptr::null(),
        )
    };
    if child == 0 {
        rust_warn!(
            "编辑器预览子窗口创建失败：Win32 错误码 {}",
            unsafe { GetLastError() }
        );
        None
    } else {
        Some(child)
    }
}

fn paint_preview_overlay(hwnd: HWND, hdc: HDC, width: i32, height: i32) {
    let tokens = theme::tokens();
    let scale = dpi_scale(hwnd);
    let line = scaled(1, scale).max(1);
    for rect in [
        paint_win::Rect::new(0, 0, width, line),
        paint_win::Rect::new(0, height - line, width, line),
        paint_win::Rect::new(0, 0, line, height),
        paint_win::Rect::new(width - line, 0, line, height),
    ] {
        paint_win::fill_color(hdc, rect, tokens.outline);
    }
    let dash = scaled(4, scale).max(1);
    let period = scaled(7, scale).max(1);
    for x in (0..width).step_by(period as usize) {
        paint_win::fill_color(
            hdc,
            paint_win::Rect::new(x, height / 2, dash.min(width - x), line),
            tokens.outline,
        );
    }
    for y in (0..height).step_by(period as usize) {
        paint_win::fill_color(
            hdc,
            paint_win::Rect::new(width / 2, y, line, dash.min(height - y)),
            tokens.outline,
        );
    }
    if let Some((w, h)) = PREVIEW_POPUP_SIZE.with(Cell::get) {
        let label = wide(&format!("{} × {}", w.round() as i64, h.round() as i64));
        let font = make_font(scale, 9, false);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: width - scaled(6, scale),
            bottom: height - scaled(3, scale),
        };
        unsafe {
            let old = SelectObject(hdc, font);
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, paint_win::colorref(tokens.dim));
            DrawTextW(
                hdc,
                label.as_ptr(),
                -1,
                &mut rect,
                DT_RIGHT | DT_BOTTOM | DT_SINGLELINE,
            );
            SelectObject(hdc, old);
            DeleteObject(font);
        }
    }
}

// ==========================================
// 主题判定（纯逻辑：无 Win32 调用，可单测；表见文件末的测试小节）
// ==========================================

/// 编辑器窗里显式创建的按钮（按动作语义分类，不按 ID）。
///
/// 顶部层 tab 根据选中态取 TabOn/TabOff，素材下拉使用原生控件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditorButton {
    /// 「保存」—— 唯一提交类主操作。
    Save,
    /// 「上传本地图」。
    Pick,
    /// 「本层复位」。
    ResetLayer,
    /// 「位置复位」。
    ResetOffset,
    /// 「放弃改动」。
    Revert,
    /// 「关闭」。
    Close,
    /// 「移除素材」。
    AssetRemove,
    /// 「刷新列表」。
    AssetRefresh,
    /// 顶部「解锁/已锁」（作用于选中层）。
    ToggleLock,
    /// 顶部「可见/隐藏」（作用于选中层）。
    ToggleEnable,
    /// 右栏「没有素材？」。
    AssetHelp,
}

/// 按钮语义 → ownerdraw 角色，全部取共享主题，保存突出为主操作。
///
/// 只给「保存」贴 `primary_*` 面（提交语义，与设置窗同一口径）；
/// 「放弃改动」取普通按钮面，避免撤销动作被主色放大。
fn button_role(button: EditorButton) -> Option<ButtonRole> {
    match button {
        EditorButton::Save => Some(ButtonRole::Primary),
        EditorButton::Pick
        | EditorButton::ResetLayer
        | EditorButton::ResetOffset
        | EditorButton::Revert
        | EditorButton::Close
        | EditorButton::AssetRemove
        | EditorButton::AssetRefresh
        | EditorButton::ToggleLock
        | EditorButton::ToggleEnable
        | EditorButton::AssetHelp => Some(ButtonRole::Normal),
    }
}

/// 给控件记录语义字色（`WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN` 按控件读回）。
fn stamp_text(hwnd: HWND, role: TextRole) {
    if hwnd != 0 {
        paint_win::set_text_color(hwnd, paint_win::text_color(theme::tokens(), role));
    }
}

/// 主操作按钮转 ownerdraw（`primary_*` 面 + 悬浮/圆角子类；角色写进控件，`WM_DRAWITEM` 读回）。
unsafe fn make_themed_button(hwnd: HWND, role: ButtonRole, scale: f64) {
    if hwnd == 0 {
        return;
    }
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, style | (BS_OWNERDRAW as isize)) };
    paint_win::set_role(hwnd, role);
    paint_win::install_button(
        hwnd,
        scaled(theme::tokens().radii.btn.round() as i32, scale),
    );
}

/// 按语义表给全部操作按钮上主题。
fn style_button(button: EditorButton, hwnd: HWND, scale: f64) {
    if let Some(role) = button_role(button) {
        unsafe { make_themed_button(hwnd, role, scale) };
    }
}

/// 顶部层 tab（BUTTON 子窗口；标题带「锁/关/缺」角标，点击即选中该层）。
struct LayerTab {
    button: HWND,
}

struct EditorState {
    hwnd: HWND,
    preview_hwnd: HWND,
    renderer: Renderer,
    /// 顶部层 tab（按层数重建；标题/选中态走 `refresh_ui`）。
    tabs: Vec<LayerTab>,
    edits: Vec<(HWND, i32)>,
    sliders: Vec<(HWND, i32)>,
    labels: Vec<HWND>,
    status: HWND,
    fonts: Vec<HFONT>,
    applied_profile: String,
    /// 素材下拉（应用内列表；含本层引用与跨层复制两类项）。
    asset_combo: HWND,
    /// 素材下拉的重建键（列表代次 + 选中层 + 该层当前素材名）。
    assets_key: String,
    /// 拖动中：上一鼠标位置（物理像素，窗口客户区坐标）。
    drag_last: Option<(i32, i32)>,
    /// 固定按钮句柄（8 颗；主题广播按它们逐个失效重绘）。
    buttons: Vec<HWND>,
    /// 已应用的窗口标题（带 Profile 名；只在变化时 SetWindowTextW）。
    applied_title: String,
}

thread_local! {
    static STATE: RefCell<Option<EditorState>> = const { RefCell::new(None) };
    /// 只供ULW回调绘制尺寸徽标的快照，更新源是主窗尺寸；回调不重借UI状态。
    static PREVIEW_POPUP_SIZE: Cell<Option<(f64, f64)>> = const { Cell::new(None) };
    /// `with_state` 被重入跳过的累计次数（只用于告警限流）。
    static EDITOR_REENTRY_COUNT: Cell<u32> = const { Cell::new(0) };
}

/// 借用编辑器状态执行 `f`；窗口未建立（STATE 为 None）时返回 `None`。
///
/// **不得在另一个 `with_state` 借用里调用**（含间接：闭包里调用的 helper 自己又借
/// STATE，如 [`layout`]）。窗口过程会在持借用时同步收到消息（绘制/命令），所以这里用
/// `try_borrow_mut()` 兜底：重入时不 panic —— panic 落在 `extern "system"` 回调里无法
/// unwind，Rust 直接 abort（Windows 上进程静默消失，与 `windows.rs::with_ui` 同一族），
/// 而是按「这一次没有状态可用」返回 `None` 并留一条限流告警。**丢的那次内容不会自己
/// 回来**，正确写法仍是「先在借用里取出值，出借用再调用」（源码级守门测试盯着直接嵌套）。
fn with_state<R>(f: impl FnOnce(&mut EditorState) -> R) -> Option<R> {
    STATE.with(|cell| match cell.try_borrow_mut() {
        Ok(mut borrowed) => borrowed.as_mut().map(|state| f(state)),
        Err(_) => {
            EDITOR_REENTRY_COUNT.with(|count| {
                let times = count.get() + 1;
                count.set(times);
                if times <= 5 || times % 100 == 0 {
                    rust_warn!("with_state 重入被跳过（外层借用未释放），累计 {times} 次");
                }
            });
            None
        }
    })
}

fn make_font(scale: f64, base: i32, bold: bool) -> HFONT {
    let snapshot = crate::ui::font::snapshot();
    let logical = snapshot.scaled_size(f64::from(base), 13.5).round() as i32;
    let face = snapshot
        .family
        .clone()
        .unwrap_or_else(|| "Microsoft YaHei UI".to_string());
    unsafe {
        CreateFontW(
            -scaled(logical, scale),
            0,
            0,
            0,
            if bold {
                FW_BOLD as i32
            } else {
                FW_NORMAL as i32
            },
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            0,
            0,
            wide(&face).as_ptr(),
        )
    }
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect: windows_sys::Win32::Foundation::RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left, rect.bottom - rect.top)
}

// ==========================================
// 主题绘制（窗底 / 预览区背板 / 分隔线 / 字色 / ownerdraw 按钮 / 主题广播）
// ==========================================

/// 窗底 + 预览区背板 + `rule` 分隔线（WM_ERASEBKGND 与 WM_PAINT 共用；物理像素）。
///
/// 右侧属性面板与底部状态条取 `tokens().field_bg`；预览区（左侧大区：顶部 tab 栏
/// 之下、右侧面板之外）取 `tokens().stage_bg` —— 预览与主窗舞台同一底色语义。
/// 分隔线两条：预览与面板之间的竖线、底部条上沿的横线。
///
pub(crate) fn paint_background(hwnd: HWND, hdc: HDC) {
    let (width, height) = client_size(hwnd);
    if width <= 0 || height <= 0 {
        return;
    }
    let tokens = theme::tokens();
    let scale = dpi_scale(hwnd);
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, width, height),
        &tokens.field_bg,
    );
    let bottom_y = (height - scaled(BOTTOM_H, scale)).max(0);
    // 预览区 = 左侧大区（顶部 tab 栏之下、底部状态行之上、右侧属性面板之外），
    // 与 macOS 的版面同构；分隔线在面板左缘左侧。
    let preview = preview_rect(width, height, scale);
    if !preview.is_empty() {
        paint_win::fill_rect(hdc, preview, &tokens.stage_bg);
    }
    let divider_x = width - scaled(PANEL_W + MARGIN, scale);
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(
            divider_x,
            scaled(TABS_H, scale),
            1,
            (bottom_y - scaled(TABS_H, scale)).max(0),
        ),
        tokens.rule,
    );
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(0, bottom_y, width, 1),
        tokens.rule,
    );
}

/// `WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN`：字色按控件记录的角色取（未记录 → `ink`；
/// 禁用控件统一降为 `dim`），文字底透明、控件底回 `field_bg`（左列工作面色）。
///
/// 可编辑 `EDIT` 走 `edit_ctlcolor`；禁用输入框经本出口取说明色。
pub(crate) fn on_ctlcolor(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    let enabled = unsafe { IsWindowEnabled(control) } != 0;
    let color = paint_win::text_color_of(control)
        .map(|color| if enabled { color } else { tokens.dim })
        .unwrap_or(if enabled { tokens.ink } else { tokens.dim });
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(color));
    }
    paint_win::solid_brush(tokens.field_bg.base_color()) as LRESULT
}

/// 输入框和下拉列表用统一主题的实底；GDI/原生控件不支持编辑框渐变。
pub(crate) fn edit_ctlcolor(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let tokens = theme::tokens();
    let background = tokens.field_bg.base_color();
    let enabled = unsafe { IsWindowEnabled(lparam as HWND) } != 0;
    unsafe {
        SetTextColor(
            hdc,
            paint_win::colorref(if enabled { tokens.ink } else { tokens.dim }),
        );
        SetBkColor(hdc, paint_win::colorref(background));
    }
    paint_win::solid_brush(background) as LRESULT
}

/// `WM_DRAWITEM`：ownerdraw 按钮绘制（角色/悬浮/按下从控件自身读，与聊天窗同款）。
/// 返回是否已处理（`false` = 不是 ownerdraw 按钮，交回 DefWindowProc）。
pub(crate) fn on_drawitem(lparam: LPARAM) -> bool {
    if lparam == 0 {
        return false;
    }
    let item = unsafe { &*(lparam as *const DrawItemStruct) };
    if item.CtlType != ODT_BUTTON {
        return false;
    }
    let tokens = theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & ODS_SELECTED != 0;
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    let face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = window_text(item.hwndItem);
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    // 底走编辑器窗**真实像素**重放（与聊天/设置窗同一口径）：token 近似色在
    // 预览区（`stage_bg`）与右侧面板（`field_bg`）两种底上必差色，按钮四角会
    // 出现异色矩形（用户 2026-10-07 实拍「按钮后面一块矩形底」的同族症状）。
    let parent = unsafe { GetParent(item.hwndItem) };
    unsafe {
        paint_win::draw_button_on_backdrop(
            item.hDC,
            item.hwndItem,
            parent,
            rect,
            &face,
            &label,
            pressed,
            disabled,
            |hdc| paint_background(parent, hdc),
        )
    };
    true
}

/// 主题广播（`windows.rs::apply_theme` 调用）。
///
/// 顺序不变量：调用方已先 `paint_win::release_theme_resources()`（旧主题的画刷/纹理
/// 都在那里 `DeleteObject`），本函数只做「按新 token 重刷字色 + 强制重绘」；
/// 本文件自己不持有任何 GDI 对象（字体不随主题变化），没有需要在这里释放的句柄。
///
/// 不在这里调 `refresh_ui()` 的理由：它经 `apply_preview → apply_editor_preview_to_stage`
/// 回到 `windows.rs` 的 `with_ui`，而广播本身就持有该 `WinUi` 的可变借用 —— 重入
/// `RefCell` 必 panic。这里直接读编辑器域的视图重刷字色，不触碰窗口层。
pub(crate) fn apply_theme() {
    let exists = with_state(|_| ()).is_some();
    if !exists {
        rust_debug!("编辑器未打开，主题广播跳过");
        return;
    }
    let view = editor_ui().view();
    with_state(|state| {
        let scale = dpi_scale(state.hwnd);
        // 层 tab：按新 token 重贴选中/未选中面（ownerdraw 构建期取色）并失效重绘。
        for (index, tab) in state.tabs.iter().enumerate() {
            let role = if index == view.selected {
                ButtonRole::TabOn
            } else {
                ButtonRole::TabOff
            };
            unsafe { make_themed_button(tab.button, role, scale) };
            unsafe { InvalidateRect(tab.button, std::ptr::null(), 1) };
        }
        for (edit, _) in state.edits.iter() {
            unsafe { InvalidateRect(*edit, std::ptr::null(), 1) };
        }
        for label in &state.labels {
            stamp_text(*label, TextRole::Body);
        }
        for (edit, index) in &state.edits {
            stamp_text(
                *edit,
                if slider_range(*index).is_some() {
                    TextRole::Hint
                } else {
                    TextRole::Body
                },
            );
        }
        for (slider, _) in &state.sliders {
            unsafe {
                InvalidateRect(*slider, std::ptr::null(), 1);
            }
        }
        for button in state.buttons.iter() {
            paint_win::install_button(
                *button,
                scaled(theme::tokens().radii.btn.round() as i32, scale),
            );
            unsafe { InvalidateRect(*button, std::ptr::null(), 1) };
        }
        unsafe {
            InvalidateRect(state.status, std::ptr::null(), 1);
            InvalidateRect(state.asset_combo, std::ptr::null(), 1);
            InvalidateRect(state.hwnd, std::ptr::null(), 1);
        }
        stamp_text(state.status, TextRole::Hint);
        if unsafe { IsWindowVisible(state.hwnd) != 0 && IsIconic(state.hwnd) == 0 } {
            if let Err(error) = state.renderer.render_now() {
                rust_warn!("编辑器主题预览重绘失败: {error}");
            }
        }
    });
    rust_info!("编辑器窗已按新主题重刷并重绘（Windows）");
}

/// 编辑器窗建立后挂载内容；只有独立预览子窗口带 WS_EX_LAYERED。
pub(crate) fn install_editor_content(hwnd: HWND) {
    let Some(preview_hwnd) = create_preview(hwnd) else {
        return;
    };
    let mut surface = match unsafe { WinLayerSurface::new(preview_hwnd) } {
        Ok(surface) => surface,
        Err(error) => {
            rust_warn!("编辑器初始化失败（预览表面未建立）: {error}");
            unsafe {
                DestroyWindow(preview_hwnd);
            }
            return;
        }
    };
    surface.set_decoration(
        |hdc, w, h| {
            paint_win::fill_rect(
                hdc,
                paint_win::Rect::new(0, 0, w, h),
                &theme::tokens().stage_bg,
            )
        },
        move |hdc, w, h| paint_preview_overlay(preview_hwnd, hdc, w, h),
    );
    let mut renderer = Renderer::new(surface);
    renderer.set_enabled(true);

    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = dpi_scale(hwnd);
    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let fonts = vec![body, small];

    let controls = INITCOMMONCONTROLSEX {
        dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_BAR_CLASSES,
    };
    if unsafe { InitCommonControlsEx(&controls) } == 0 {
        rust_warn!(
            "编辑器滑杆控件初始化失败：Win32 错误码 {}",
            unsafe { GetLastError() }
        );
    }

    // 同 macOS：强度/Y/X/灵敏度/缩放；三条滑杆旁边是只读数值，两轴是输入框。
    let mut edits = Vec::new();
    let mut sliders = Vec::new();
    let mut labels = Vec::new();
    for (label, index) in [
        ("强度", EDIT_INTENSITY),
        ("位置 Y %", EDIT_OFFSET_Y),
        ("位置 X %", EDIT_OFFSET_X),
        ("灵敏度", EDIT_SENSITIVITY),
        ("缩放", EDIT_SCALE),
    ] {
        let label_hwnd = unsafe {
            CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide(label).as_ptr(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                68,
                18,
                hwnd,
                0,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe {
            SendMessageW(label_hwnd, WM_SETFONT, body as WPARAM, 1);
        }
        stamp_text(label_hwnd, TextRole::Body);
        labels.push(label_hwnd);
        let is_slider = slider_range(index).is_some();
        if is_slider {
            let slider = unsafe {
                CreateWindowExW(
                    0,
                    wide("msctls_trackbar32").as_ptr(),
                    wide("").as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | TBS_HORZ | TBS_NOTICKS,
                    0,
                    0,
                    120,
                    24,
                    hwnd,
                    (SLIDER_BASE + index) as isize,
                    hinstance,
                    std::ptr::null(),
                )
            };
            unsafe {
                SendMessageW(slider, TBM_SETRANGEMIN, 0, 0);
                SendMessageW(slider, TBM_SETRANGEMAX, 1, SLIDER_STEPS as LPARAM);
            }
            sliders.push((slider, index));
        }
        let edit = unsafe {
            CreateWindowExW(
                0,
                wide(if is_slider { "STATIC" } else { "EDIT" }).as_ptr(),
                wide("").as_ptr(),
                WS_CHILD | WS_VISIBLE | if is_slider { 0 } else { WS_TABSTOP | WS_BORDER },
                0,
                0,
                80,
                scaled(22, scale),
                hwnd,
                (EDIT_BASE + index) as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe { SendMessageW(edit, WM_SETFONT, body as WPARAM, 1) };
        stamp_text(
            edit,
            if is_slider {
                TextRole::Hint
            } else {
                TextRole::Body
            },
        );
        edits.push((edit, index));
    }
    let asset_label = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("素材").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            120,
            18,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SendMessageW(asset_label, WM_SETFONT, body as WPARAM, 1);
    }
    stamp_text(asset_label, TextRole::Body);
    labels.push(asset_label);
    let status = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            200,
            scaled(18, scale),
            hwnd,
            STATUS_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { SendMessageW(status, WM_SETFONT, small as WPARAM, 1) };
    // 状态行是信息通道（进展 + 保存状态 + 素材错误共用），取说明色。
    stamp_text(status, TextRole::Hint);
    // 素材下拉：CBS_DROPDOWNLIST（列表只读，选择即动作；高度含下拉清单）。
    let asset_combo = unsafe {
        CreateWindowExW(
            0,
            wide("COMBOBOX").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST as u32,
            0,
            0,
            // 初始宽度即右栏面板宽（与 macOS `asset_popup` 的 PANEL_W 同口径）；
            // 展开后的最终尺寸由 relayout 的 MoveWindow 再按 PANEL_W 定。
            scaled(PANEL_W, scale),
            scaled(200, scale),
            hwnd,
            ASSET_COMBO_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { SendMessageW(asset_combo, WM_SETFONT, body as WPARAM, 1) };
    let mut buttons = Vec::new();
    for (id, text, kind) in [
        (PICK_ID, "上传本地图", EditorButton::Pick),
        (RESET_LAYER_ID, "本层复位", EditorButton::ResetLayer),
        (RESET_OFFSET_ID, "位置复位", EditorButton::ResetOffset),
        (REVERT_ID, "放弃改动", EditorButton::Revert),
        (SAVE_ID, "保存", EditorButton::Save),
        (CLOSE_ID, "关闭", EditorButton::Close),
        (ASSET_REMOVE_ID, "移除素材", EditorButton::AssetRemove),
        (ASSET_REFRESH_ID, "刷新列表", EditorButton::AssetRefresh),
        // 顶部动作（作用于选中层；标题随选中层状态在 refresh_ui 里重写）。
        (TOGGLE_LOCK_ID, "解锁", EditorButton::ToggleLock),
        (TOGGLE_ENABLE_ID, "可见", EditorButton::ToggleEnable),
        // 右栏最下方（文案来自平台无关模块，两平台同一份）。
        (ASSET_HELP_ID, ASSET_HELP_BUTTON, EditorButton::AssetHelp),
    ] {
        let button = unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                0,
                0,
                scaled(88, scale),
                scaled(26, scale),
                hwnd,
                id as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe { SendMessageW(button, WM_SETFONT, body as WPARAM, 1) };
        style_button(kind, button, scale);
        buttons.push(button);
    }

    STATE.with(|cell| {
        *cell.borrow_mut() = Some(EditorState {
            hwnd,
            preview_hwnd,
            renderer,
            tabs: Vec::new(),
            edits,
            sliders,
            labels,
            status,
            fonts,
            applied_profile: String::new(),
            asset_combo,
            assets_key: String::new(),
            drag_last: None,
            buttons,
            applied_title: String::new(),
        });
    });
    rebuild_tabs();
    layout(hwnd);
    refresh_ui();
    rust_info!("编辑器窗内容已建立（Windows：独立预览子窗口、属性滑杆与图层控件）");
}

/// 按当前层数重建顶部层 tab（标题带「锁/关/缺」角标；点击即选中该层）。
fn rebuild_tabs() {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let layer_count = editor_ui().view().layers.len();
    with_state(|state| {
        for tab in state.tabs.drain(..) {
            unsafe { DestroyWindow(tab.button) };
        }
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        let body = *state.fonts.first().unwrap_or(&0);
        let mut tabs = Vec::new();
        for index in 0..layer_count {
            let button = unsafe {
                CreateWindowExW(
                    0,
                    wide("BUTTON").as_ptr(),
                    wide("").as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                    0,
                    0,
                    scaled(TAB_W, scale),
                    scaled(TOP_BUTTON_H, scale),
                    hwnd,
                    (TAB_BASE + index as i32) as isize,
                    hinstance,
                    std::ptr::null(),
                )
            };
            unsafe { SendMessageW(button, WM_SETFONT, body as WPARAM, 1) };
            tabs.push(LayerTab { button });
        }
        state.tabs = tabs;
    });
}

/// 摆放控件（顶部层 tab 栏 + 左侧预览大区 + 右侧属性面板 + 底部状态行；
/// 与 macOS 的版面同构）。
///
/// **自己借 STATE**：调用方不得在 `with_state` 借用里调它（嵌套即丢内容，理由见
/// [`with_state`] 的说明）—— 先 `with_state(|state| state.hwnd)` 取句柄、出借用再调。
fn layout(hwnd: HWND) {
    with_state(|state| {
        let scale = dpi_scale(hwnd);
        let (width, height) = client_size(hwnd);
        // 顶部：层 tab 栏（左，自 MARGIN 起）+ 动作按钮（右到左：关闭 / 保存 /
        // 本层复位 / 可见 / 锁定 —— 作用于当前选中层）。
        let preview = preview_rect(width, height, scale);
        unsafe {
            MoveWindow(
                state.preview_hwnd,
                preview.x,
                preview.y,
                preview.w.max(1),
                preview.h.max(1),
                1,
            );
        }
        let top_y = scaled((TABS_H - TOP_BUTTON_H) / 2, scale);
        let actions_left = width - scaled(MARGIN + 5 * TOP_BUTTON_W + 4 * 6, scale);
        let tab_w = if state.tabs.is_empty() {
            scaled(TAB_W, scale)
        } else {
            ((actions_left - scaled(MARGIN + 8, scale)) / state.tabs.len() as i32
                - scaled(4, scale))
            .clamp(scaled(24, scale), scaled(TAB_W, scale))
        };
        let mut x = scaled(MARGIN, scale);
        for tab in state.tabs.iter() {
            unsafe { MoveWindow(tab.button, x, top_y, tab_w, scaled(TOP_BUTTON_H, scale), 1) };
            x += tab_w + scaled(4, scale);
        }
        let mut bx = width - scaled(MARGIN, scale);
        for id in [
            CLOSE_ID,
            SAVE_ID,
            RESET_LAYER_ID,
            TOGGLE_ENABLE_ID,
            TOGGLE_LOCK_ID,
        ] {
            let hwnd_button =
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, id) };
            if hwnd_button != 0 {
                bx -= scaled(TOP_BUTTON_W, scale);
                unsafe {
                    MoveWindow(
                        hwnd_button,
                        bx.max(0),
                        top_y,
                        scaled(TOP_BUTTON_W, scale),
                        scaled(TOP_BUTTON_H, scale),
                        1,
                    )
                };
                bx -= scaled(6, scale);
            }
        }
        // 右侧属性面板（x = width - PANEL_W - MARGIN）：参数输入框自上而下、
        // 素材区（下拉 + 上传/移除/刷新）、单层操作（位置复位 / 放弃改动）。
        let panel_x = width - scaled(PANEL_W + MARGIN, scale);
        let mut py = scaled(TABS_H + MARGIN, scale);
        for (row, (edit, index)) in state.edits.iter().enumerate() {
            let is_slider = slider_range(*index).is_some();
            unsafe {
                MoveWindow(
                    state.labels[row],
                    panel_x,
                    py + scaled(5, scale),
                    scaled(68, scale),
                    scaled(18, scale),
                    1,
                );
                MoveWindow(
                    *edit,
                    panel_x + scaled(if is_slider { PANEL_W - 46 } else { 68 }, scale),
                    py + scaled(if is_slider { 4 } else { 0 }, scale),
                    scaled(if is_slider { 46 } else { PANEL_W - 68 }, scale),
                    scaled(if is_slider { 18 } else { 24 }, scale),
                    1,
                )
            };
            if let Some((slider, _)) = state
                .sliders
                .iter()
                .find(|(_, slider_index)| slider_index == index)
            {
                unsafe {
                    MoveWindow(
                        *slider,
                        panel_x + scaled(68, scale),
                        py,
                        scaled(PANEL_W - 68 - 46 - 8, scale),
                        scaled(24, scale),
                        1,
                    );
                }
            }
            py += scaled(PARAM_H, scale);
        }
        py += scaled(12, scale);
        unsafe {
            MoveWindow(
                *state.labels.last().unwrap_or(&0),
                panel_x,
                py,
                scaled(PANEL_W, scale),
                scaled(18, scale),
                1,
            );
        }
        py += scaled(22, scale);
        if state.asset_combo != 0 {
            unsafe {
                MoveWindow(
                    state.asset_combo,
                    panel_x,
                    py,
                    scaled(PANEL_W, scale),
                    scaled(200, scale),
                    1,
                )
            };
        }
        py += scaled(30, scale);
        let small_w = (scaled(PANEL_W, scale) - scaled(12, scale)) / 3;
        for (slot, id) in [PICK_ID, ASSET_REMOVE_ID, ASSET_REFRESH_ID]
            .iter()
            .enumerate()
        {
            let hwnd_button =
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, *id) };
            if hwnd_button != 0 {
                unsafe {
                    MoveWindow(
                        hwnd_button,
                        panel_x + slot as i32 * (small_w + scaled(6, scale)),
                        py,
                        small_w,
                        scaled(24, scale),
                        1,
                    )
                };
            }
        }
        py += scaled(34, scale);
        let half_w = (scaled(PANEL_W, scale) - scaled(6, scale)) / 2;
        for (slot, id) in [RESET_OFFSET_ID, REVERT_ID].iter().enumerate() {
            let hwnd_button =
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, *id) };
            if hwnd_button != 0 {
                unsafe {
                    MoveWindow(
                        hwnd_button,
                        panel_x + slot as i32 * (half_w + scaled(6, scale)),
                        py,
                        half_w,
                        scaled(24, scale),
                        1,
                    )
                };
            }
        }
        // 右栏最下方「没有素材？」：贴栏底（与 macOS 同一「距底」口径与共享夹取
        // 纯函数），窗口被压矮时上移到单层操作行上沿 + 最小间距。
        // 共享函数吃逻辑点的距底距离（两端同口径），DPR 换算只在这里做一次。
        let help_button =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, ASSET_HELP_ID) };
        if help_button != 0 {
            let bottom_line_logical = f64::from(BOTTOM_H + MARGIN);
            let layer_ops_bottom_logical = f64::from(height - py - scaled(24, scale)) / scale;
            let layer_ops_top_logical = f64::from(height - py) / scale;
            let offset = asset_help_bottom_offset(
                0.0,
                layer_ops_bottom_logical - bottom_line_logical,
                layer_ops_top_logical - bottom_line_logical,
            );
            let help_h = scaled(ASSET_HELP_BUTTON_H.round() as i32, scale);
            let help_y = height
                - scaled(BOTTOM_H + MARGIN, scale)
                - scaled(offset.round() as i32, scale)
                - help_h;
            unsafe {
                MoveWindow(
                    help_button,
                    panel_x,
                    help_y,
                    scaled(PANEL_W, scale),
                    help_h,
                    1,
                )
            };
        }
        // 底部：状态行（顶部动作已移入 tab 栏，底部只剩状态文本）。
        if state.status != 0 {
            unsafe {
                MoveWindow(
                    state.status,
                    scaled(MARGIN, scale),
                    height - scaled(26, scale),
                    (width - scaled(MARGIN * 2, scale)).max(80),
                    scaled(18, scale),
                    1,
                )
            };
        }
    });
    // 重排后整窗失效一次：附属窗类刷留空（`windows.rs` 类注册的 `hbrBackground = 0`），
    // 系统不自动擦除背景 —— 不显式失效，被销毁/移走的旧控件像素会永久留在窗上
    // （与设置窗同一根因，2026-10-07 实机：控件重排后旧像素残留）。`WS_CLIPCHILDREN`
    // 下这次重画只覆盖控件之间的空隙。
    unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
}

/// WM_COMMAND：层 tab / 参数输入 / 按钮。
pub(crate) fn on_command(hwnd: HWND, wparam: WPARAM) -> bool {
    let id = (wparam & 0xFFFF) as i32;
    let code = ((wparam >> 16) & 0xFFFF) as u32;
    match id {
        PICK_ID => {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_swap_asset(selected) {
                editor_ui().set_notice(Some(format!("换素材未启动：{error}")));
            }
            return true;
        }
        ASSET_COMBO_ID => {
            // 只认 SELENDOK（用户选定）：SELCHANGE 在键盘游走时也发，动作会重复触发。
            if code != CBN_SELENDOK {
                return false;
            }
            let combo = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, ASSET_COMBO_ID)
            };
            let index = unsafe { SendMessageW(combo, CB_GETCURSEL, 0, 0) } as isize;
            // 复位到占位项：下拉语义是「动作」，不是持久选中值。
            unsafe { SendMessageW(combo, CB_SETCURSEL, 0, 0) };
            if index < 1 {
                return true;
            }
            let view = editor_ui().view();
            let count = view.assets.len() as isize;
            let selected = view.selected;
            if index <= count {
                if let Err(error) = editor_ui().op_use_asset(selected, (index - 1) as usize) {
                    editor_ui().set_notice(Some(format!("换素材失败：{error}")));
                }
            } else {
                if let Err(error) = editor_ui().op_swap_asset(selected) {
                    editor_ui().set_notice(Some(format!("换素材未启动：{error}")));
                }
            }
            refresh_ui();
            return true;
        }
        ASSET_REMOVE_ID => {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_remove_asset(selected) {
                editor_ui().set_notice(Some(format!("移除素材失败：{error}")));
            }
            refresh_ui();
            return true;
        }
        ASSET_REFRESH_ID => {
            editor_ui().schedule_assets();
            return true;
        }
        ASSET_HELP_ID => {
            // 「没有素材？」：模态面板（说明 + 可滚动提示词 + 复制到剪贴板）。
            open_asset_help_dialog(hwnd);
            return true;
        }
        RESET_LAYER_ID => {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_reset_layer(selected) {
                editor_ui().set_notice(Some(format!("本层复位失败：{error}")));
            }
            refresh_ui();
            return true;
        }
        RESET_OFFSET_ID => {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_reset_offset(selected) {
                editor_ui().set_notice(Some(format!("位置复位失败：{error}")));
            }
            refresh_ui();
            return true;
        }
        TOGGLE_LOCK_ID => {
            let selected = editor_ui().view().selected;
            editor_ui().op_toggle_locked(selected);
            refresh_ui();
            return true;
        }
        TOGGLE_ENABLE_ID => {
            let selected = editor_ui().view().selected;
            editor_ui().op_toggle_enabled(selected);
            refresh_ui();
            return true;
        }
        REVERT_ID => {
            editor_ui().revert();
            refresh_ui();
            return true;
        }
        SAVE_ID => {
            if let Err(error) = editor_ui().save() {
                editor_ui().set_notice(Some(format!("保存未启动：{error}")));
            }
            refresh_ui();
            return true;
        }
        CLOSE_ID => {
            if !confirm_close(hwnd) {
                return true;
            }
            let _ = super::windows::close_editor_window();
            return true;
        }
        STATUS_ID => return false,
        _ if (TAB_BASE..TAB_BASE + 100).contains(&id) => {
            // 顶部层 tab：点击即选中该层（标题角标与选中态由 refresh_ui 重写）。
            editor_ui().op_select((id - TAB_BASE) as usize);
            refresh_ui();
            return true;
        }
        _ if (EDIT_BASE..EDIT_BASE + 10).contains(&id) => {
            // EN_KILLFOCUS(512) 提交；其它通知忽略（避免输入过程中逐字符提交）。
            if code != 512 {
                return false;
            }
            let index = id - EDIT_BASE;
            let text = window_text(unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(hwnd, id)
            });
            let selected = editor_ui().view().selected;
            // 位置两轴：文本 = 我们写入的规范显示 = 没编辑过 —— 不提交（显示是
            // 四舍五入到两位小数的，提交会把拖动得到的多位小数悄悄收成两位；
            // 与 macOS 共用 `offset_input_unchanged`）。
            if let Some(axis) = match index {
                EDIT_OFFSET_X => Some(crate::ui::editor::OffsetAxis::X),
                EDIT_OFFSET_Y => Some(crate::ui::editor::OffsetAxis::Y),
                _ => None,
            } {
                let current = editor_ui()
                    .view()
                    .layers
                    .get(selected)
                    .map(|layer| match axis {
                        crate::ui::editor::OffsetAxis::X => layer.offset_x_percent,
                        crate::ui::editor::OffsetAxis::Y => layer.offset_y_percent,
                    })
                    .unwrap_or(0.0);
                if crate::ui::editor::offset_input_unchanged(&text, current) {
                    return true;
                }
            }
            // 解析口径与 macOS 共用一份（`parse_number_input`）：空串/非数/非有限
            // 都拒绝，并在状态行如实报错后刷新（回显当前真值）。
            let value = match crate::ui::editor::parse_number_input(&text) {
                Ok(value) => value,
                Err(error) => {
                    editor_ui().set_notice(Some(format!("输入无效：{error}")));
                    refresh_ui();
                    return true;
                }
            };
            let result = match index {
                EDIT_SCALE => editor_ui().op_set_scale(selected, value),
                EDIT_SENSITIVITY => editor_ui().op_set_sensitivity(selected, value),
                // 位置两轴提交走共享的单轴入口（另一轴原样保留；锁定/越界语义同源）。
                EDIT_OFFSET_X => editor_ui().op_set_offset_input(
                    selected,
                    crate::ui::editor::OffsetAxis::X,
                    &text,
                ),
                EDIT_OFFSET_Y => editor_ui().op_set_offset_input(
                    selected,
                    crate::ui::editor::OffsetAxis::Y,
                    &text,
                ),
                EDIT_INTENSITY => {
                    editor_ui().op_set_intensity(value);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                editor_ui().set_notice(Some(format!("该图层已锁定或参数无效：{error}")));
            }
            refresh_ui();
            return true;
        }
        _ => {}
    }
    let _ = hwnd;
    false
}

/// 原生滑杆变化；位置取 TBM_GETPOS，避免 WM_HSCROLL 的16位载荷精度限制。
pub(crate) fn on_hscroll(_hwnd: HWND, lparam: LPARAM) {
    let slider = lparam as HWND;
    let index = with_state(|state| {
        state
            .sliders
            .iter()
            .find(|(handle, _)| *handle == slider)
            .map(|(_, index)| *index)
    })
    .flatten();
    let Some(index) = index else {
        return;
    };
    let Some((min, max)) = slider_range(index) else {
        return;
    };
    let position = unsafe { SendMessageW(slider, TBM_GETPOS, 0, 0) };
    let value = min + (max - min) * position as f64 / f64::from(SLIDER_STEPS);
    let selected = editor_ui().view().selected;
    let result = match index {
        EDIT_SCALE => editor_ui().op_set_scale(selected, value),
        EDIT_SENSITIVITY => editor_ui().op_set_sensitivity(selected, value),
        EDIT_INTENSITY => {
            editor_ui().op_set_intensity(value);
            Ok(())
        }
        _ => return,
    };
    if let Err(error) = result {
        editor_ui().set_notice(Some(format!("参数更新失败：{error}")));
    }
    refresh_ui();
}

/// WM_SIZE：重排 + 预览几何更新。
///
/// 与 macOS 对称：`macos_editor.rs::relayout`（窗口 resize 通知 → 同一份
/// `editor_layout` 重摆 + 背板重画 + `apply_preview`）。Windows 的窗口过程把
/// WM_SIZE 直接分发到这里（`windows.rs::aux_wndproc`，code == 2 分支），
/// `layout` 用 `MoveWindow` 重摆全部子控件（tab / 顶栏按钮 / 参数输入 / 素材区 /
/// 状态行），窗底与预览区分界线由 `paint_background` 按新客户区尺寸重画；
/// 预览合成目标只覆盖左侧取景框，窗体控件由普通 GDI 路径绘制。
pub(crate) fn on_size(hwnd: HWND) {
    layout(hwnd);
    apply_preview();
}

/// 拖动：左键按下（预览区）开始，移动改位置，抬起结束。
pub(crate) fn on_lbutton_down(_hwnd: HWND, x: i32, y: i32) -> bool {
    with_state(|state| {
        // 只接受预览区（左侧大区：顶部 tab 栏之下、右侧属性面板之外）的拖动 ——
        // 与窗底绘制的预览区几何同一口径。
        let scale = dpi_scale(state.hwnd);
        let (width, height) = client_size(state.hwnd);
        let preview = preview_rect(width, height, scale);
        if x >= preview.x && x < preview.right() && y >= preview.y && y < preview.bottom() {
            state.drag_last = Some((x, y));
        }
    });
    with_state(|state| state.drag_last.is_some()).unwrap_or(false)
}

pub(crate) fn on_mouse_move(hwnd: HWND, x: i32, y: i32) -> bool {
    let dragged = with_state(|state| {
        let Some((last_x, last_y)) = state.drag_last else {
            return false;
        };
        let (dx, dy) = (x - last_x, y - last_y);
        state.drag_last = Some((x, y));
        let scale = dpi_scale(hwnd);
        // 拖动比例按预览区尺寸归一（预览区 = 顶部 tab 栏之下、右侧属性面板之外、
        // 底部状态行之上）。
        let (client_w, client_h) = client_size(hwnd);
        let preview = preview_rect(client_w, client_h, scale);
        let width = f64::from(preview.w.max(1));
        let height = f64::from(preview.h.max(1));
        let selected = editor_ui().view().selected;
        if let Err(error) =
            editor_ui().op_drag(selected, f64::from(dx), f64::from(dy), width, height)
        {
            rust_debug!("拖动被拒绝（{error}）");
        }
        true
    });
    if dragged.unwrap_or(false) {
        refresh_ui();
        // 拖动期间状态行显示实时数值（旧壳 dragHint 同文案；两平台共用文案函数）；
        // 抬起时 on_lbutton_up 触发 refresh_ui 恢复常规文案。
        let view = editor_ui().view();
        let selected = view.selected;
        if let Some(layer) = view.layers.get(selected) {
            let hint = crate::ui::editor::drag_hint(
                selected,
                &layer.name,
                layer.offset_x_percent,
                layer.offset_y_percent,
            );
            with_state(|state| {
                if state.status != 0 {
                    unsafe { SetWindowTextW(state.status, wide(&hint).as_ptr()) };
                }
            });
        }
    }
    dragged.unwrap_or(false)
}

pub(crate) fn on_lbutton_up() {
    // `with_state` 在 UI 状态缺失时返回 None：没有状态同样意味着没在拖动。
    let was_dragging = with_state(|state| state.drag_last.take().is_some()).unwrap_or(false);
    if was_dragging {
        // 拖动结束：恢复常规状态行（拖动期间显示实时数值）。
        refresh_ui();
    }
}

/// WM_MOUSEWHEEL：滚轮缩放选中层（与 macOS `scrollWheel:` 同口径）。
///
/// wParam 高 16 位是有符号轮增量（一格 = WHEEL_DELTA=120，与 web 的 ~100/格同一
/// 数量级），按「正 = 向下滚 = 缩小」归一后交领域层；换算仍走 `onWheel` 的
/// 0.001/单位，与 macOS 触控板路径共用同一条规则。
///
/// 接线点：`windows.rs` 的 `aux_wndproc`（编辑器窗口 code == 2 分支）转发
/// `WM_MOUSEWHEEL` 到这里。
pub(crate) fn on_mouse_wheel(_hwnd: HWND, wparam: WPARAM) {
    let z_delta = ((wparam >> 16) & 0xFFFF) as i16 as f64;
    let selected = editor_ui().view().selected;
    if let Err(error) = editor_ui().op_zoom(selected, -z_delta) {
        editor_ui().set_notice(Some(format!("该图层已锁定或参数无效：{error}")));
    }
    refresh_ui();
}

/// 关闭前确认：未保存改动时问「保存并关闭 / 放弃 / 取消」。返回是否放行关闭。
///
/// 无需 macOS 的「模态降层」包裹：MessageBoxW 以编辑器 hwnd 为 owner，系统把它
/// 提升到 owner 之上，不受 WS_EX_TOPMOST 分层影响（macOS 的假死根因是 AppKit 把
/// 模态弹窗固定在 level 8、被 level 1500 的编辑器窗盖住）。文件对话框（
/// `native_ports` 的通用对话框，owner 固定主窗）是否需要同样处理见交付报告
/// （Windows 侧未实机验证）。
pub(crate) fn confirm_close(hwnd: HWND) -> bool {
    if !editor_ui().is_dirty() {
        return true;
    }
    let response = unsafe {
        MessageBoxW(
            hwnd,
            wide("有未保存的改动。\n是：保存并关闭；否：放弃修改；取消：继续编辑。").as_ptr(),
            wide("图层编辑器").as_ptr(),
            MB_YESNOCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    };
    if response == IDYES {
        if let Err(error) = editor_ui().save_then_close() {
            editor_ui().set_notice(Some(format!("保存未启动：{error}")));
        }
        // 保存成功后由后台线程发起关闭（见 `save_then_close`）。
        false
    } else if response == IDNO {
        editor_ui().revert();
        true
    } else if response == IDCANCEL {
        false
    } else {
        false
    }
}

// ==========================================
// 「没有素材？」素材提示词面板（非模态自建窗）
// ==========================================
//
// 为什么不用 MessageBoxW：本面板要「可滚动只读提示词 + 复制到剪贴板」，MessageBox
// 只能给系统固定按钮（与 `windows_chat.rs` 的通用提示对话框同一判断）。
//
// **非模态**（与 macOS 的 transient NSPopover 对称）：内容是只读说明 + 提示词 +
// 复制，没有「必须先回答」的语义；模态（禁用属主 + 嵌套消息循环）会把整个应用
// 锁住 —— 实机复现过同类问题，帮助/说明类面板一律不锁窗。窗口是编辑器窗的
// **owned window**：跟随属主最小化/销毁、恒在属主之上，但不禁用属主。
// 剪贴板走共享层 `ui::clipboard`（OpenClipboard + CF_UNICODETEXT），不拉子进程、
// 不经 Node 的 IPC 命令面。
// Esc 关窗由「窗口过程 + 正文 EDIT 的子类」两处接（子类把 Esc 转成 WM_CLOSE）；
// 点外部不关（有意差异：Windows 没有不装钩子就能做的 transient 语义，如实登记）。
//
// 与 macOS 的关系：承载不同（macOS 是 NSPopover），文案与版面数值同源
// （`ui::editor` 的 `ASSET_HELP_*`）。**未在 Windows 实机验证**（见模块头）。

/// 弹窗窗口类名（与编辑器主窗、聊天窗的类名并列注册）。
const ASSET_HELP_DIALOG_CLASS: &str = "DeskPetEditorAssetHelpDialog";
/// 「复制」按钮控件 ID（「关闭」走系统 IDOK/IDCANCEL）。
const ASSET_HELP_COPY_ID: i32 = 3201;

/// 打开中的面板状态（同一时刻至多一个；只在 UI 主线程读写）。
struct AssetHelpDialog {
    hwnd: HWND,
    /// 提示词正文 EDIT（再次打开时聚焦它，键盘立即可用）。
    prompt: HWND,
    copy_button: HWND,
    /// 本窗使用的字体（窗口销毁时释放；不借用编辑器窗的字体，避免两次销毁）。
    fonts: Vec<HFONT>,
}

thread_local! {
    static ASSET_HELP_DIALOG: RefCell<Option<AssetHelpDialog>> = const { RefCell::new(None) };
    /// 弹窗窗口类是否已注册（进程内一次；失败在打开时如实报出）。
    static ASSET_HELP_CLASS_READY: Cell<bool> = const { Cell::new(false) };
}

/// 打开素材提示词面板（UI 主线程；失败如实留痕，不静默）。
///
/// 非模态：已在显示就把它带到前台，不再开第二个（不改编辑器窗状态、不禁用属主）。
fn open_asset_help_dialog(owner: HWND) {
    if let Some(dialog) = ASSET_HELP_DIALOG.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|dialog| (dialog.hwnd, dialog.prompt))
    }) {
        unsafe {
            ShowWindow(dialog.0, SW_SHOW);
            SetForegroundWindow(dialog.0);
            SetFocus(dialog.1);
        }
        return;
    }
    if let Err(error) = run_asset_help_dialog(owner) {
        rust_warn!("素材提示词面板打开失败：{error}");
    }
}

/// 注册弹窗窗口类（幂等）。
fn ensure_asset_help_class() -> Result<(), String> {
    if ASSET_HELP_CLASS_READY.with(Cell::get) {
        return Ok(());
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 类名缓冲先绑定再取指针（临时 Vec 会立刻析构，指针悬垂；与聊天窗同规）。
    let class_name = wide(ASSET_HELP_DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = Some(asset_help_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类刷留空：底色由 WM_ERASEBKGND 按主题画（换主题不必重注册窗口类）。
    wc.hbrBackground = 0;
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err("RegisterClassW（素材提示词面板）失败".into());
    }
    ASSET_HELP_CLASS_READY.with(|ready| ready.set(true));
    Ok(())
}

fn run_asset_help_dialog(owner: HWND) -> Result<(), String> {
    ensure_asset_help_class()?;
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = if owner != 0 {
        dpi_scale(owner)
    } else {
        // 无属主（前台没有本线程窗口）：GetDpiForWindow(0) 无意义，退回系统 DPI。
        f64::from(unsafe { GetDpiForSystem() }.max(DPI_BASELINE)) / f64::from(DPI_BASELINE)
    };
    // 排版表来自平台无关模块（逻辑点，本机可测）；DPR 换算只在这里做一次。
    let panel = crate::ui::editor::asset_help_panel_layout();
    let margin = scaled(panel.margin, scale);
    let title_y = scaled(panel.title_y, scale);
    let title_h = scaled(panel.title_h, scale);
    let message_y = scaled(panel.message_y, scale);
    let message_h = scaled(panel.message_h, scale);
    let text_y = scaled(panel.text_y, scale);
    let text_w = scaled(panel.text_w, scale);
    let text_h = scaled(panel.text_h, scale);
    let button_y = scaled(panel.button_y, scale);
    let button_w = scaled(panel.button_w, scale);
    let button_h = scaled(panel.button_h, scale);
    let copy_x = scaled(panel.copy_x, scale);
    let close_x = scaled(panel.close_x, scale);
    let client_w = scaled(panel.width, scale);
    let client_h = scaled(panel.height, scale);

    // 客户区 → 外框尺寸；属主存在时居中于属主，否则居中于主屏。
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU;
    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: client_w,
        bottom: client_h,
    };
    unsafe { AdjustWindowRectEx(&mut window_rect, style, 0, 0) };
    let window_w = window_rect.right - window_rect.left;
    let window_h = window_rect.bottom - window_rect.top;
    let mut owner_rect: RECT = unsafe { std::mem::zeroed() };
    let (x, y) = if owner != 0 && unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (
            (unsafe { GetSystemMetrics(SM_CXSCREEN) } - window_w) / 2,
            (unsafe { GetSystemMetrics(SM_CYSCREEN) } - window_h) / 2,
        )
    };

    let hwnd = unsafe {
        CreateWindowExW(
            // 编辑器窗是 WS_EX_TOPMOST（层级 1500）：帮助窗不同样 topmost 的话会被
            // 属主整面盖住（owned 只在同层内保证高于属主）。
            WS_EX_TOPMOST,
            wide(ASSET_HELP_DIALOG_CLASS).as_ptr(),
            wide(ASSET_HELP_TITLE).as_ptr(),
            style,
            x,
            y,
            window_w,
            window_h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        return Err("素材提示词面板 CreateWindowExW 失败".into());
    }

    // 字体：正文/标题走全局字体快照（弹窗不成为第二个字体定义点），提示词用等宽
    // 小号字（长文本可读性；字号与 macOS 的 `ASSET_HELP_FONT_SIZE` 同源）。
    let body = make_font(scale, 13, false);
    let bold = make_font(scale, 13, true);
    let mono = unsafe {
        let face = wide("Consolas");
        let size = crate::ui::font::snapshot()
            .scaled_size(ASSET_HELP_FONT_SIZE, 13.5)
            .round() as i32;
        CreateFontW(
            -scaled(size, scale),
            0,
            0,
            0,
            FW_NORMAL as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            0,
            0,
            face.as_ptr(),
        )
    };

    // ── 子控件（自上而下：标题 / 说明 / 提示词正文 / 按钮行）──
    let title = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(ASSET_HELP_TITLE).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            title_y,
            client_w - margin * 2,
            title_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 说明文字：STATIC 默认左对齐 + 自动换行（SS_LEFT=0）。
    let message = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(ASSET_HELP_INTRO).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            message_y,
            client_w - margin * 2,
            message_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 提示词正文：只读多行 EDIT + 竖向滚动条（正文 300+ 行，必须能滚、能选中）。
    let prompt = unsafe {
        CreateWindowExW(
            WS_EX_CLIENTEDGE,
            wide("EDIT").as_ptr(),
            wide(ASSET_PROMPT).as_ptr(),
            WS_CHILD
                | WS_VISIBLE
                | WS_VSCROLL
                | WS_TABSTOP
                | ES_MULTILINE as u32
                | ES_READONLY as u32
                | ES_AUTOVSCROLL as u32,
            margin,
            text_y,
            text_w,
            text_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 按钮行（右起：关闭是默认按钮；复制在左）。
    let close = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(ASSET_HELP_CLOSE).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
            close_x,
            button_y,
            button_w,
            button_h,
            hwnd,
            IDOK as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    let copy_button = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(ASSET_HELP_COPY).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            copy_x,
            button_y,
            button_w,
            button_h,
            hwnd,
            ASSET_HELP_COPY_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SendMessageW(title, WM_SETFONT, bold as WPARAM, 1);
        SendMessageW(message, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(prompt, WM_SETFONT, mono as WPARAM, 1);
        SendMessageW(close, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(copy_button, WM_SETFONT, body as WPARAM, 1);
        // 子类只做一件事：把 Esc 转成 WM_CLOSE（非模态窗没有 IsDialogMessage 的
        // Esc→IDCANCEL 通路；焦点落在 EDIT 或按钮上时按键都不会冒泡到窗口）。
        SetWindowSubclass(prompt, Some(asset_help_prompt_subclass), 1, 0);
        SetWindowSubclass(close, Some(asset_help_prompt_subclass), 2, 0);
        SetWindowSubclass(copy_button, Some(asset_help_prompt_subclass), 3, 0);
    }

    // ── 非模态显示：不收属主、不跑嵌套循环（帮助内容不该锁住任何窗口）──
    ASSET_HELP_DIALOG.with(|cell| {
        *cell.borrow_mut() = Some(AssetHelpDialog {
            hwnd,
            prompt,
            copy_button,
            fonts: vec![body, bold, mono],
        });
    });
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(prompt);
    }
    Ok(())
}

/// 「没有素材？」面板正文子类：Esc → 请求关窗（其余全部交还默认处理）。
unsafe extern "system" fn asset_help_prompt_subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _refdata: usize,
) -> LRESULT {
    if msg == WM_KEYDOWN && wparam == VK_ESCAPE as WPARAM {
        unsafe { SendMessageW(GetParent(hwnd), WM_CLOSE, 0, 0) };
        return 0;
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn asset_help_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            if id == ASSET_HELP_COPY_ID {
                let copy_button = ASSET_HELP_DIALOG.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|dialog| dialog.copy_button)
                        .unwrap_or(0)
                });
                // 共享层是安全函数（unsafe 收在 `ui::clipboard` 内部），不要再包 unsafe。
                if crate::ui::clipboard::write_text(hwnd, ASSET_PROMPT) {
                    // 就地反馈：不关窗，可继续看/再复制（与 macOS 侧同语义）。
                    unsafe { SetWindowTextW(copy_button, wide(ASSET_HELP_COPIED).as_ptr()) };
                } else {
                    rust_warn!("复制素材提示词到剪贴板失败");
                }
                0
            } else if id == IDOK || id == IDCANCEL {
                // 关闭按钮（IDOK）与 Esc 落到窗口自己身上时的 IDCANCEL 同一出口。
                unsafe { DestroyWindow(hwnd) };
                0
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_KEYDOWN if wparam == VK_ESCAPE as WPARAM => {
            // 焦点在窗口本身（不在正文 EDIT）时按 Esc：同一出口关窗。
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            // 摘状态并释放本窗字体（用户点关闭、Esc、或随属主窗一起销毁都走这里）。
            if let Some(dialog) = ASSET_HELP_DIALOG.with(|cell| cell.borrow_mut().take()) {
                unsafe {
                    for font in dialog.fonts {
                        if font != 0 {
                            DeleteObject(font);
                        }
                    }
                }
            }
            0
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as HDC;
            let tokens = theme::tokens();
            unsafe {
                SetBkMode(hdc, TRANSPARENT);
                SetTextColor(hdc, paint_win::colorref(tokens.ink));
            }
            paint_win::solid_brush(tokens.panel_bg.base_color()) as LRESULT
        }
        WM_ERASEBKGND => {
            // 弹窗底：面板底色（与聊天窗的提示对话框同源）。
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                paint_win::Rect::new(
                    client.left,
                    client.top,
                    client.right - client.left,
                    client.bottom - client.top,
                ),
                &theme::tokens().panel_bg,
            );
            1
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 编辑器窗销毁：释放预览渲染器（Drop 会停表并摘层）、控件与字体。
pub(crate) fn on_destroy() {
    // 素材提示词面板（若还开着）：先显式销毁并释放它的字体 —— 属主销毁虽然会
    // 连带销毁 owned window，但这里先收一次，字体释放与状态摘除的路径才唯一。
    if let Some(dialog) = ASSET_HELP_DIALOG.with(|cell| cell.borrow_mut().take()) {
        unsafe {
            DestroyWindow(dialog.hwnd);
            for font in dialog.fonts {
                if font != 0 {
                    DeleteObject(font);
                }
            }
        }
    }
    STATE.with(|cell| {
        if let Some(state) = cell.borrow_mut().take() {
            for font in state.fonts {
                if font != 0 {
                    unsafe { DeleteObject(font) };
                }
            }
            // 渲染器随 state 释放（WinLayerSurface::drop 停表、消息窗销毁）。
            drop(state.renderer);
        }
    });
    editor_ui().note_window_closed();
    rust_info!("编辑器窗已关闭：预览表面与控件释放");
}

/// 界面刷新（草稿/保存状态/预览同步）。
pub(crate) fn refresh_ui() {
    let view = editor_ui().view();
    let profile_changed = with_state(|state| {
        if !view.profile_id.is_empty() && state.applied_profile != view.profile_id {
            state.applied_profile = view.profile_id.clone();
            true
        } else {
            false
        }
    });
    if profile_changed.unwrap_or(false) {
        rebuild_tabs();
        // 句柄先在借用里取出、排布在借用外调：`layout` 自己还要借 STATE（见其顶部），
        // 在借用里调它会**嵌套**同一个 RefCell（裸借用时是 abort 级故障）。
        if let Some(hwnd) = with_state(|state| state.hwnd) {
            layout(hwnd);
        }
    }
    with_state(|state| {
        // 窗口标题跟随 Profile 名（与 macOS 同一文案来源；载入完成前保持建窗文案）。
        let title = crate::ui::editor::editor_window_title(&view.profile_name);
        if state.applied_title != title {
            unsafe { SetWindowTextW(state.hwnd, wide(&title).as_ptr()) };
            state.applied_title = title;
        }
        // 层 tab（标题角标 + 选中态；与 macOS 的 sync_tabs 同语义、同文案函数）。
        let scale = dpi_scale(state.hwnd);
        for (index, tab) in state.tabs.iter().enumerate() {
            let Some(layer) = view.layers.get(index) else {
                continue;
            };
            let title = crate::ui::editor::layer_tab_title(
                index,
                &layer.name,
                layer.enabled,
                layer.locked,
                layer.asset_missing(),
            );
            unsafe { SetWindowTextW(tab.button, wide(&title).as_ptr()) };
            // 选中标签贴 `tab_on_*` 族、未选中 `tab_off`（按钮转 ownerdraw 贴面；
            // `SetWindowSubclass` 同 id 重复调用幂等，逐次刷新重贴安全）。
            let role = if index == view.selected {
                ButtonRole::TabOn
            } else {
                ButtonRole::TabOff
            };
            unsafe { make_themed_button(tab.button, role, scale) };
        }
        // 顶部动作标题随选中层状态（旧壳 le-actions 的「已锁/解锁」「可见/隐藏」文案；
        // 标题记录的是**当前状态**，与 macOS 同口径）。
        if let Some(layer) = view.layers.get(view.selected) {
            let lock = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(state.hwnd, TOGGLE_LOCK_ID)
            };
            if lock != 0 {
                unsafe {
                    SetWindowTextW(
                        lock,
                        wide(if layer.locked { "已锁" } else { "解锁" }).as_ptr(),
                    )
                };
            }
            let enable = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(
                    state.hwnd,
                    TOGGLE_ENABLE_ID,
                )
            };
            if enable != 0 {
                unsafe {
                    SetWindowTextW(
                        enable,
                        wide(if layer.enabled { "可见" } else { "隐藏" }).as_ptr(),
                    )
                };
            }
        }
        // 素材下拉：重建键 = 列表代次 + 选中层 + 该层当前素材名。
        // 占位项（0）不带动作；1..=n 为素材项；末项为本地文件直选。
        let selected_name = view
            .layers
            .get(view.selected)
            .map(|layer| layer.name.clone())
            .unwrap_or_default();
        let assets_key = format!(
            "{}|{}|{}|{}",
            view.assets_generation, view.assets_loading, view.selected, selected_name
        );
        if state.asset_combo != 0 && state.assets_key != assets_key {
            state.assets_key = assets_key;
            unsafe {
                SendMessageW(state.asset_combo, CB_RESETCONTENT, 0, 0);
                // 首次载入（列表还空着）显示「载入中」；已有列表的刷新保留旧项。
                let placeholder = if view.assets_loading && view.assets.is_empty() {
                    "素材列表载入中…".to_string()
                } else if selected_name.is_empty() {
                    "素材：未设置".to_string()
                } else {
                    format!("素材：{selected_name}")
                };
                SendMessageW(
                    state.asset_combo,
                    CB_ADDSTRING,
                    0,
                    wide(&placeholder).as_ptr() as isize,
                );
                for asset in &view.assets {
                    let title = if asset.layer == view.selected {
                        format!("L{} · {}", asset.layer + 1, asset.name)
                    } else {
                        format!("L{} · {}（复制到本层）", asset.layer + 1, asset.name)
                    };
                    SendMessageW(
                        state.asset_combo,
                        CB_ADDSTRING,
                        0,
                        wide(&title).as_ptr() as isize,
                    );
                }
                SendMessageW(
                    state.asset_combo,
                    CB_ADDSTRING,
                    0,
                    wide("选择本地文件…").as_ptr() as isize,
                );
                SendMessageW(state.asset_combo, CB_SETCURSEL, 0, 0);
            }
        }
        // 「移除素材」只在选中层确有素材时可用。
        let remove_button = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(state.hwnd, ASSET_REMOVE_ID)
        };
        if remove_button != 0 {
            let has_asset = view
                .layers
                .get(view.selected)
                .map(|layer| !layer.wire_path.is_empty())
                .unwrap_or(false);
            unsafe { EnableWindow(remove_button, if has_asset { 1 } else { 0 }) };
        }
        // 参数输入框（未聚焦时才回写）。
        let selected = view.layers.get(view.selected);
        let locked = selected.map(|layer| layer.locked).unwrap_or(false);
        for (edit, index) in state.edits.iter() {
            // 位置两轴即旧壳偏移行的数字输入：锁定层禁用（旧壳 `:disabled` 同义）；
            // 显示走共享的去尾零口径（与 macOS 输入框、与提交解析同一份函数）。
            let is_offset = matches!(*index, EDIT_OFFSET_X | EDIT_OFFSET_Y);
            if is_offset {
                unsafe { EnableWindow(*edit, if locked { 0 } else { 1 }) };
            }
            let focused =
                unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus() == *edit };
            if focused {
                continue;
            }
            let value = match index {
                &EDIT_SCALE => selected.map(|l| l.scale).unwrap_or(1.0),
                &EDIT_SENSITIVITY => selected.map(|l| l.sensitivity).unwrap_or(0.8),
                &EDIT_OFFSET_X => selected.map(|l| l.offset_x_percent).unwrap_or(0.0),
                &EDIT_OFFSET_Y => selected.map(|l| l.offset_y_percent).unwrap_or(0.0),
                &EDIT_INTENSITY => view.intensity,
                _ => 0.0,
            };
            let text = if is_offset {
                crate::ui::editor::format_number_input(value)
            } else {
                format!("{value:.2}")
            };
            unsafe { SetWindowTextW(*edit, wide(&text).as_ptr()) };
        }
        for (slider, index) in &state.sliders {
            let value = match *index {
                EDIT_SCALE => selected.map(|layer| layer.scale).unwrap_or(1.0),
                EDIT_SENSITIVITY => selected.map(|layer| layer.sensitivity).unwrap_or(0.8),
                EDIT_INTENSITY => view.intensity,
                _ => continue,
            };
            if let Some((min, max)) = slider_range(*index) {
                unsafe {
                    EnableWindow(*slider, i32::from(*index == EDIT_INTENSITY || !locked));
                    SendMessageW(
                        *slider,
                        TBM_SETPOS,
                        1,
                        slider_position(value, min, max) as LPARAM,
                    );
                }
            }
        }
        // 状态行（素材列表失败不阻断编辑：错误如实展示，本地文件直选仍可用）。
        let status_text = if let Some(notice) = &view.notice {
            notice.clone()
        } else if view.profile_id.is_empty() {
            "Profile 未载入（Node Profile I/O 端口就绪后自动载入）".to_string()
        } else {
            let dirty = if view.dirty {
                " · 有未保存改动"
            } else {
                ""
            };
            let saving = if view.saving {
                " · 正在保存…"
            } else {
                ""
            };
            let assets = view
                .assets_error
                .as_ref()
                .map(|error| format!(" · {error}"))
                .unwrap_or_default();
            format!("Profile: {}{dirty}{saving}{assets}", view.profile_id)
        };
        if state.status != 0 {
            unsafe { SetWindowTextW(state.status, wide(&status_text).as_ptr()) };
            stamp_text(state.status, TextRole::Hint);
        }
        // 保存按钮启用状态。
        let save =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDlgItem(state.hwnd, SAVE_ID) };
        if save != 0 {
            let enabled = view.dirty && view.connected && !view.saving;
            unsafe { EnableWindow(save, if enabled { 1 } else { 0 }) };
        }
    });
    apply_preview();
}

/// 草稿 → 编辑器预览渲染器（线索投影）+ 主窗舞台（原 specs，不含线索）。
fn apply_preview() {
    let preview = editor_ui().preview();
    let popup_size = super::windows::popup_reference_size();
    PREVIEW_POPUP_SIZE.with(|value| value.set(popup_size));
    with_state(|state| {
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        if let Some((popup_width, _)) = popup_size {
            state.renderer.set_popup_width(popup_width);
        }
        state.renderer.set_intensity(preview.intensity);
        state.renderer.set_enabled(preview.effect_enabled);
        // 预览渲染器用线索投影（选中 1.0 / 启用 0.6 / 禁用 0.15，五层恒渲染）；
        // 主窗舞台在下方用 `preview.layers` 原 specs —— 线索只回预览。
        let report = state.renderer.set_layers(preview.cue_layers());
        if !report.failures.is_empty() {
            rust_warn!("预览层收敛有 {} 个失败项", report.failures.len());
        }
        state.renderer.set_cursor(None);
        // 几何取独立预览子窗口，铺满左区并在其客户区裁剪（macOS 同口径）。
        let (client_w, client_h) = client_size(state.preview_hwnd);
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe {
            GetWindowRect(state.preview_hwnd, &mut rect);
        }
        state.renderer.set_window_geometry(WindowGeometry {
            x: f64::from(rect.left) / scale,
            y: f64::from(rect.top) / scale,
            width: f64::from(client_w) / scale,
            height: f64::from(client_h) / scale,
        });
        // 隐藏期不得调 render_now（§6.2）。
        let visible = unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 };
        if visible {
            if let Err(error) = state.renderer.render_now() {
                rust_warn!("编辑器预览重绘失败: {error}");
            }
        }
    });
    // 主窗舞台：同一份草稿的**原 specs**（不含线索：桌宠本体不得被调暗）。
    let promote = editor_ui().take_promote();
    if let Err(error) =
        super::windows::apply_editor_preview_to_stage(preview.layers, preview.intensity, promote)
    {
        rust_warn!("主窗舞台预览同步失败: {error}");
    }
}

/// 全局字体变化：重建字体并下发。
pub(crate) fn apply_font() {
    with_state(|state| {
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        for font in state.fonts.drain(..) {
            if font != 0 {
                unsafe { DeleteObject(font) };
            }
        }
        let body = make_font(scale, 13, false);
        let small = make_font(scale, 11, false);
        state.fonts = vec![body, small];
        for label in &state.labels {
            unsafe {
                SendMessageW(*label, WM_SETFONT, body as WPARAM, 1);
            }
        }
        for tab in state.tabs.iter() {
            unsafe { SendMessageW(tab.button, WM_SETFONT, body as WPARAM, 1) };
        }
        for (edit, _) in state.edits.iter() {
            unsafe { SendMessageW(*edit, WM_SETFONT, body as WPARAM, 1) };
        }
        if state.status != 0 {
            unsafe { SendMessageW(state.status, WM_SETFONT, small as WPARAM, 1) };
        }
        if state.asset_combo != 0 {
            unsafe { SendMessageW(state.asset_combo, WM_SETFONT, body as WPARAM, 1) };
        }
        for button in &state.buttons {
            unsafe { SendMessageW(*button, WM_SETFONT, body as WPARAM, 1) };
            paint_win::install_button(
                *button,
                scaled(theme::tokens().radii.btn.round() as i32, scale),
            );
        }
        for tab in &state.tabs {
            paint_win::install_button(
                tab.button,
                scaled(theme::tokens().radii.btn.round() as i32, scale),
            );
        }
    });
    rust_debug!("编辑器字体已按全局快照刷新");
}

fn window_text(hwnd: HWND) -> String {
    if hwnd == 0 {
        return String::new();
    }
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; (len + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..read as usize])
}

// ==========================================
// 纯逻辑单测（无 Win32 调用；本模块只在 Windows 编译，macOS 上跑不到 —— 见 AGENTS §2。
// 同表在 macOS 可跑的部分：`paint_win` 的 `文字角色映射到各自_token` 与
// `主按钮面全套取_primary_族`；本文件用例由 CI 的 verify (windows-latest) 执行。）
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 源码级守门：`with_state` 的闭包里不得再借 STATE（与 `windows_settings.rs` 同款，
    /// 扫描器共用 [`crate::ui::platform::windows::source_guard`]）。
    ///
    /// 2026-10-07 修掉的一处真实缺陷就是这个形状（切 Profile 后的重排在借用里调了
    /// [`layout`]）—— 嵌套时 `try_borrow_mut` 落回 `None`：不再 abort，但那一次排布丢。
    /// **间接嵌套扫不出来**，靠「先取 hwnd、出借用再 layout」的形状约束 + [`layout`] 顶部说明。
    #[test]
    fn with_state_不得在借用里再借_state() {
        let source = include_str!("windows_editor.rs");
        // 拆开拼接，避免断言文本命中自身。
        let needle = concat!("with_", "state(");
        assert!(
            source.matches(needle).count() > 1,
            "扫描前提：本文件确实在使用 with_state",
        );
        let nested = crate::ui::platform::windows::source_guard::nested_call_sites(source, needle);
        assert!(
            nested.is_empty(),
            "with_state 闭包里又借了一次 STATE（外层行, 内层行）：{nested:?} —— 拆成「先取值、出借用再调」",
        );
        assert_eq!(
            source
                .matches(concat!("|state| layout(", "state.hwnd)"))
                .count(),
            0,
            "[layout] 自己借 STATE：必须在借用里先取 hwnd、出借用再调",
        );
    }

    #[test]
    fn 编辑器保存贴主按钮面其余取普通主题按钮面() {
        assert_eq!(
            button_role(EditorButton::Save),
            Some(ButtonRole::Primary),
            "保存是提交类动作"
        );
        for kind in [
            EditorButton::Pick,
            EditorButton::ResetLayer,
            EditorButton::ResetOffset,
            EditorButton::Revert,
            EditorButton::Close,
            EditorButton::AssetRemove,
            EditorButton::AssetRefresh,
            EditorButton::ToggleLock,
            EditorButton::ToggleEnable,
            EditorButton::AssetHelp,
        ] {
            assert_eq!(
                button_role(kind),
                Some(ButtonRole::Normal),
                "{kind:?} 应取普通主题按钮面"
            );
        }
    }

    #[test]
    fn 编辑器取景框与属性栏状态行不重叠且按dpi缩放() {
        assert_eq!(
            preview_rect(860, 620, 1.0),
            paint_win::Rect::new(12, 50, 564, 528)
        );
        for scale in [1.0, 1.5, 2.0] {
            let width = scaled(860, scale);
            let height = scaled(620, scale);
            let preview = preview_rect(width, height, scale);
            assert_eq!(preview.x, scaled(12, scale));
            assert_eq!(preview.y, scaled(50, scale));
            assert_eq!(
                preview.right() + scaled(PANEL_GAP, scale),
                width - scaled(PANEL_W + MARGIN, scale)
            );
            assert_eq!(preview.bottom(), height - scaled(BOTTOM_H + MARGIN, scale));
        }
        assert!(preview_rect(100, 100, 1.0).w == 0);
        assert!(preview_rect(860, 20, 1.0).h == 0);
    }

    #[test]
    fn 编辑器滑杆端点映射到领域范围() {
        for index in [EDIT_INTENSITY, EDIT_SENSITIVITY, EDIT_SCALE] {
            let (min, max) = slider_range(index).expect("三条滑杆有领域范围");
            assert_eq!(slider_position(min, min, max), 0);
            assert_eq!(slider_position(max, min, max), SLIDER_STEPS);
            assert_eq!(
                slider_position((min + max) / 2.0, min, max),
                SLIDER_STEPS / 2
            );
        }
        assert_eq!(slider_range(EDIT_OFFSET_X), None);
        assert_eq!(slider_range(EDIT_OFFSET_Y), None);
    }

    /// 源码级守门：素材提示词面板必须保持**非模态**（不得再出现「禁用属主 +
    /// 嵌套消息循环」的自建模态窗写法）—— 帮助内容没有「必须先回答」的语义，
    /// 锁住整个应用属回归（实机复现过同类问题）。把面板改回模态时本用例必须红。
    #[test]
    fn 素材提示词面板保持非模态_源码守门() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/windows_editor.rs"
        ));
        let start = src
            .find("「没有素材？」素材提示词面板（非模态")
            .expect("面板小节标记");
        let end = src.find("/// 编辑器窗销毁").expect("编辑器销毁函数标记");
        let section = &src[start..end];
        assert!(
            !section.contains("EnableWindow(owner"),
            "帮助面板不得禁用属主窗（非模态）"
        );
        assert!(
            !section.contains("GetMessageW"),
            "帮助面板不得自跑嵌套消息循环（非模态）"
        );
        assert!(
            section.contains("SetFocus(prompt)"),
            "非模态窗打开时把键盘焦点交给正文（Esc 子类才有落点）"
        );
    }

    /// 素材提示词弹窗：排版表来自平台无关模块（`ui::editor`，几何断言在本机
    /// 单测里跑）；这里只钉 DPR 换算——逻辑点乘 DPI 缩放后仍落在按钮行内。
    #[test]
    fn 素材提示词弹窗按DPI缩放() {
        let panel = crate::ui::editor::asset_help_panel_layout();
        for scale in [1.0, 1.5, 2.0] {
            let client_w = scaled(panel.width, scale);
            let close_right = scaled(panel.close_x, scale) + scaled(panel.button_w, scale);
            assert_eq!(
                close_right,
                client_w - scaled(panel.margin, scale),
                "scale={scale}：关闭按钮贴右缘"
            );
            let copy_right = scaled(panel.copy_x, scale) + scaled(panel.button_w, scale);
            assert!(
                copy_right <= scaled(panel.close_x, scale),
                "scale={scale}：复制按钮不压关闭按钮"
            );
            assert!(scaled(panel.text_y, scale) > scaled(panel.message_y, scale));
        }
    }
}
