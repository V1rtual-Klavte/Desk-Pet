//! 主窗一体布局（W9a，Windows）：角色舞台 + 聊天列同窗合成；顶部为全窗宽顶栏（W9c）。
//!
//! 结构上与 macOS 同语义；Windows 专有的合成、焦点与 DPI 行为需实机验收：
//! - 舞台是主窗客户区内的**子窗口**（`WS_CHILD | WS_EX_LAYERED`），W6a 的
//!   `WinLayerSurface` 以它为合成目标（Windows 8 起 `WS_EX_LAYERED` 支持子窗口）；
//!   `render/win.rs` 的文档把目标写作「顶层窗口」是 W6a 的保守表述 —— **本处是
//!   经协调者登记的能力偏差**，Windows 实机验证（W11）必须确认子窗口 `UpdateLayeredWindow`
//!   的行为；若不成立，降级方案是「整窗合成 + 聊天列覆盖」，记为已知布局缺口。
//! - 聊天面板由 `windows_chat::mount_main_pane` 挂进主窗（同一份控件栈）；
//! - 分隔条拖动由主窗过程转发鼠标事件（`WM_LBUTTONDOWN` 命中分隔条区域时进入拖动）；
//! - **全窗宽顶栏（W9c）**：主窗层的一条整窗宽 26px 子窗口顶栏（品牌/状态位/
//!   关闭「×」/设置 + 拖动）。布局时显式提升到兄弟 z 序最上，覆盖聊天列顶部
//!   的同一 26px 带；舞台子窗口从带下方开始
//!   （顶部布局预留）。条高、品牌槽与状态位坐标等几何的唯一来源是
//!   `ui/titlebar.rs`（旧聊天列顶栏副本已随旧实现删除）；文本唯一真值同样在那里。
//! - **条内是单面绘制**（2026-10-07）：品牌/状态位/设置/× 不再落子控件 —— 子窗口
//!   是不透明表面，条底渐变透不过来（实机症状：STATIC 白板 + 按钮深色方板）；
//!   全部内容画在顶栏自己的 `WM_PAINT` 里，命中/悬停/按压在窗口过程里记账，
//!   绘制与命中**共用同一份矩形**（`layout_titlebar` 存进 `TITLEBAR`）。
//!
//! 未验证项（交付报告同步登记）：舞台子窗口的分层合成、收起/呼出动画对角色内容的
//! 作用（W5 的常量 alpha 只作用于主窗自身位图，子窗口内容不随 alpha 淡出）、
//! 顶栏的 `WM_NCHITTEST → HTCAPTION` 拖动与条内入口的悬停/按压/点击
//! （单面绘制路径本身待实机验收）。

use std::cell::RefCell;

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, DeleteObject, DrawTextW, EndPaint, InvalidateRect, ScreenToClient, SelectObject,
    SetBkMode, SetTextColor, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
    FW_BOLD, FW_NORMAL, HDC, HFONT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
// `WM_MOUSELEAVE` 在本版本的 windows-sys 里登记在 Controls 子模块（与
// `paint_win.rs` 的按钮子类同款取法）。
use windows_sys::Win32::UI::Controls::WM_MOUSELEAVE;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetParent, GetWindowRect, RegisterClassW,
    SendMessageW, SetWindowPos, CS_HREDRAW, CS_VREDRAW, HTCAPTION, HTCLIENT, HWND_TOP,
    SWP_NOACTIVATE, SWP_NOZORDER, WM_CAPTURECHANGED, WM_CREATE, WM_DESTROY, WM_ERASEBKGND,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_PAINT, WM_SIZE,
    WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_VISIBLE,
};

use crate::error::{AppError, AppResult};
use crate::render::geometry::WindowGeometry;
use crate::render::win::WinLayerSurface;
use crate::ui::stage::Stage;
use crate::ui::theme::paint_win::{self, ButtonRole};
use crate::ui::titlebar;
use crate::{rust_debug, rust_info, rust_warn};

use super::windows_chat;
use crate::window::DPI_BASELINE;

/// 舞台子窗口类名。
const STAGE_CLASS: &str = "DeskPetStageHost";
/// 分隔条宽度（物理像素基准；随 DPI 缩放）。
///
/// 这是**热区**宽度、不是视觉线宽：视觉只有右缘 1px 的 `outline` 分界线
/// （设计稿 `.chat` 的 `border-left` 口径）。与 macOS 侧同值加宽（旧 6 命中过窄）。
const DIVIDER_WIDTH: f64 = 10.0;
/// 聊天列最小宽度（逻辑像素，与 macOS 同口径）。
const CHAT_MIN_WIDTH: f64 = 120.0;
/// 舞台最小宽度（逻辑像素）。
const STAGE_MIN_WIDTH: f64 = 200.0;
/// 未收到 CONFIG 推送时的布局兜底：窗口宽的 1/3（布局规则，不是配置默认值）。
const CHAT_FALLBACK_WIDTH_RATIO: f64 = 1.0 / 3.0;

// ── 全窗宽顶栏（顶部 26px 带，条内几何来自 `ui::titlebar`）──

/// 顶栏窗口类名。
const TITLEBAR_CLASS: &str = "DeskPetMainTitlebar";
/// 关闭「×」入口宽度。
const NAV_CLOSE_WIDTH: i32 = 22;
const NAV_SETTINGS_WIDTH: i32 = 34;
/// 与 macOS 一致：「×」+「设置」+ 间距与内边距。
const TITLEBAR_RIGHT_RESERVE: i32 = 72;
/// `SetBkMode` 的 TRANSPARENT（1）：windows-sys 的 `Gdi::TRANSPARENT` 类型是 u32，
/// 该 API 要 i32，按 `windows_chat.rs` 同款就地定义（避免类型不匹配）。
const TRANSPARENT: i32 = 1;

/// 全窗宽顶栏的展示状态（主线程唯一；随主窗销毁清空）。
///
/// 顶栏**不持有任何子控件**：品牌/状态位/设置/× 全部由 `paint_titlebar` 直接画
/// 在条面上（子窗口是不透明表面 —— 实机曾出现 STATIC 白板与按钮深色方板，
/// 2026-10-07）。命中/悬停/按压在这里记账；条内矩形由 `layout_titlebar` 写入，
/// **绘制与命中共用同一份**。
struct TitlebarUi {
    bar: HWND,
    /// 顶栏常规字体（状态位与「设置 / ×」；随全局字体快照刷新时整只替换）。
    font: HFONT,
    /// 品牌字字体（**粗体**，对齐 macOS `boldSystemFontOfSize(11)`；见
    /// [`create_titlebar_font`] 的 `bold` 参数）。
    brand_font: HFONT,
    /// 条内矩形（客户区物理像素；`WM_SIZE` 时重算）。
    brand: paint_win::Rect,
    status: paint_win::Rect,
    hide: paint_win::Rect,
    settings: paint_win::Rect,
    /// 状态位文本（展示副本；唯一真值在 `ui/titlebar.rs`）。
    status_text: String,
    /// 悬停/按下的条内入口（同一时刻至多一个）。
    hover: BarHit,
    pressed: BarHit,
}

/// 条内可命中入口（设置 / 收起「×」；空白区不可命中 = 拖动区）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BarHit {
    None,
    Settings,
    Hide,
}

/// `paint_titlebar` 的一次性快照（绘制期间不持有 `TITLEBAR` 借用的拷贝）。
struct TitlebarPaint {
    font: HFONT,
    brand_font: HFONT,
    brand: paint_win::Rect,
    status: paint_win::Rect,
    hide: paint_win::Rect,
    settings: paint_win::Rect,
    status_text: String,
    hover: BarHit,
    pressed: BarHit,
}

thread_local! {
    static TITLEBAR: RefCell<Option<TitlebarUi>> = const { RefCell::new(None) };
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 鼠标/命中消息里的 16 位有符号坐标（与 `GET_X_LPARAM` / `GET_Y_LPARAM` 同款）。
fn lo_word(value: LPARAM) -> i32 {
    ((value as usize) & 0xFFFF) as u16 as i16 as i32
}

fn hi_word(value: LPARAM) -> i32 {
    (((value as usize) >> 16) & 0xFFFF) as u16 as i16 as i32
}

fn dpi_scale(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(DPI_BASELINE);
    f64::from(dpi) / f64::from(DPI_BASELINE)
}

/// 逻辑像素 → 物理像素（与 `windows_chat.rs` 同口径的取整）。
fn scaled(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale).round() as i32
}

/// 逻辑像素（f64，品牌/状态位这类估算值）→ 物理像素（同 `windows_chat.rs::scaled_f`）。
fn scaled_f(value: f64, scale: f64) -> i32 {
    (value * scale).round() as i32
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left, rect.bottom - rect.top)
}

/// 主窗一体布局状态。
pub(crate) struct MainLayout {
    stage: Stage,
    stage_hwnd: HWND,
    // 以下三项由 windows.rs 的背景绘制读取（paint_backdrop 入参），
    // 是跨 windows_main / windows 两个模块的共享布局状态，故对 crate 可见。
    pub(crate) chat_visible: bool,
    /// 聊天列宽度（逻辑像素）；`None` = 未收到 CONFIG 推送（用兜底）。
    chat_width: Option<f64>,
    /// 分隔条拖动：按下时的鼠标 x（物理）与当时的列宽（逻辑）。
    divider_drag: Option<(i32, f64)>,
    // ── 主窗底色的重画几何（`relayout` 每轮写入；`windows.rs` 读）──
    /// 分隔带左缘（物理像素）与带宽；`chat_visible=false` 时无意义。
    pub(crate) divider_x: i32,
    pub(crate) divider_w: i32,
}

/// 建立主窗布局：舞台子窗口 + 聊天面板挂载。
pub(crate) fn install(main: HWND) -> AppResult<MainLayout> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(STAGE_CLASS);
    let mut class_error = 0u32;
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(stage_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        // 类已存在时 RegisterClassW 返回 0（多实例/多次 install 都正常）；真实结论由
        // CreateWindowExW 给出。但失败时错误码必须留下 —— 只报「创建失败」无从定位
        // （2026-10-07 Windows 实机：舞台子窗口建不出来、只剩蓝色空框）。
        if RegisterClassW(&wc) == 0 {
            class_error = GetLastError();
        }
    }
    let (width, height) = client_size(main);
    let stage_hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED,
            class_name.as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            width,
            height,
            main,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if stage_hwnd == 0 {
        // 两个错误码都带上：CreateWindowExW 的失败原因，以及 RegisterClassW 是否也失败了
        // （类名冲突、hInstance 不匹配等都从这两处区分）。
        let create_error = unsafe { GetLastError() };
        return Err(AppError::Other(format!(
            "舞台子窗口创建失败（CreateWindowExW 错误码 {create_error}，RegisterClassW 错误码 {class_error}）"
        )));
    }
    let mut surface = unsafe { WinLayerSurface::new(stage_hwnd)? };
    // 光标采样与帧同拍：帧回调先取一次全局光标再合成，视差图层因此每帧推进一次，
    // 不再受「采样计时器与帧计时器各自量化、互相错拍」影响（用户实机反馈
    // 「光标跟踪图层动的卡卡的」；`render/win.rs` 的 `pre_tick` 有完整因由）。
    // 主窗的 `TIMER_TRACK` 保留为兜底（帧循环停摆时仍能看到光标）。
    surface.set_pre_tick(Box::new(|| {
        super::windows::track_tick();
    }));
    let stage = Stage::new(surface);

    // 聊天面板：同一份控件实现挂进主窗（产品形态在主窗内）。
    windows_chat::mount_main_pane(main);

    // 全窗宽顶栏：relayout 显式抬到最上，盖住聊天面板的顶部预留带。
    create_titlebar(main);

    let mut layout = MainLayout {
        stage,
        stage_hwnd,
        chat_visible: true,
        chat_width: None,
        divider_drag: None,
        divider_x: 0,
        divider_w: 0,
    };
    relayout(&mut layout, main);
    rust_info!(
        "主窗一体布局已建立（Windows：舞台子窗口 {width}×{height} 物理像素，全窗宽顶栏 {:.0}px，聊天列默认展开）",
        titlebar::HEIGHT
    );
    Ok(layout)
}

/// 计算并应用舞台/聊天列的矩形，并同步舞台几何。
pub(crate) fn relayout(layout: &mut MainLayout, main: HWND) {
    let (width, height) = client_size(main);
    if width <= 0 || height <= 0 {
        return;
    }
    let scale = dpi_scale(main);
    let (chat_phys, divider_phys) = if layout.chat_visible {
        let max_chat_logical =
            ((f64::from(width) / scale) - STAGE_MIN_WIDTH - DIVIDER_WIDTH).max(CHAT_MIN_WIDTH);
        let desired = layout
            .chat_width
            .unwrap_or(f64::from(width) / scale * CHAT_FALLBACK_WIDTH_RATIO);
        let chat_logical = desired.clamp(CHAT_MIN_WIDTH, max_chat_logical);
        (
            (chat_logical * scale).round() as i32,
            (DIVIDER_WIDTH * scale).round() as i32,
        )
    } else {
        (0, 0)
    };
    let stage_w = (width - chat_phys - divider_phys).max(1);
    // 顶部布局预留：舞台子窗口从全窗宽顶栏下方开始（26px 带归顶栏）。
    let band = scaled_f(titlebar::HEIGHT, scale);
    let content_height = (height - band).max(1);
    // 舞台子窗口铺满整个舞台区域（2026-10-05 用户规则：与 macOS
    // `macos_main.rs::relayout` 对称，与图层编辑器预览同口径——预览视图=整个
    // 左区，渲染器几何直接取视图 frame，无宽高比方框）。旧几何「按弹窗宽高比
    // 居中 aspect-fit」（旧壳 `#parallax-stage` 的 `aspect-ratio` 不变量）随该
    // 规则退役：它让素材只铺满左区里的小方框、与编辑器所见不一致（用户报
    // 「左边老是占不满、编辑器显示是满的」）。素材缩放仍由
    // `render/compose.rs::layer_draw` 按喂入 frame 的高度适配，数学不变。
    // 渲染表面**延伸到分隔条右缘**（与 macOS 同口径）：角色铺到聊天面板边，
    // 分隔线叠加其上；只铺到 stage_w 会在分隔条处露出一条「缝」（2026-10-05 用户实拍）。
    let stage_pw = (stage_w + divider_phys).max(1);
    let stage_ph = content_height.max(1);
    let stage_px = 0;
    let stage_py = band;

    layout.divider_x = stage_w;
    layout.divider_w = divider_phys;
    unsafe {
        SetWindowPos(
            layout.stage_hwnd,
            HWND_TOP,
            stage_px,
            stage_py,
            stage_pw,
            stage_ph,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        if layout.chat_visible {
            // 聊天列面板保持满高：面板内部按「容器顶部 26px 归顶栏」布局（标签条接
            // 在其下方），顶部那一段由全窗宽顶栏占据；把面板改矮会让面板的顶部预留
            // 与顶栏错位。
            windows_chat::layout_main_pane(main, stage_w + divider_phys, 0, chat_phys, height);
        }
    }
    // 全窗宽顶栏：整窗宽 × 26px（DPI 缩放），保持在兄弟 z 序最上（MoveWindow 不改 z 序）。
    let titlebar = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.bar));
    if let Some(titlebar) = titlebar {
        if titlebar != 0 {
            unsafe { SetWindowPos(titlebar, HWND_TOP, 0, 0, width, band, SWP_NOACTIVATE) };
        }
    }

    // 舞台几何（逻辑像素；渲染器几何与光标同坐标系）。
    let mut stage_rect: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(layout.stage_hwnd, &mut stage_rect) };
    layout.stage.set_window_geometry(WindowGeometry {
        x: f64::from(stage_rect.left) / scale,
        y: f64::from(stage_rect.top) / scale,
        width: f64::from(stage_rect.right - stage_rect.left) / scale,
        height: f64::from(stage_rect.bottom - stage_rect.top) / scale,
    });
    if layout.stage.frames_running() {
        layout.stage.refresh();
    }
}

/// 可见期跟踪：全局光标喂给舞台（每帧一次，见 `install` 的 `pre_tick` 接线；
/// 主窗 `TIMER_TRACK` 计时器是同函数的兜底调用点）。
pub(crate) fn track(layout: &mut MainLayout) {
    let cursor = match crate::commands::cursor::get_cursor_position() {
        Ok(cursor) => Some(crate::render::geometry::CursorPosition {
            x: f64::from(cursor.x),
            y: f64::from(cursor.y),
        }),
        Err(_) => None,
    };
    layout.stage.set_cursor(cursor);
}

pub(crate) fn set_stage_visible(layout: &mut MainLayout, visible: bool) {
    layout.stage.set_visible(visible);
}

pub(crate) fn apply_stage_profile(
    layout: &mut MainLayout,
    profile: crate::ui::stage::StageProfile,
) {
    layout.stage.apply_profile(profile);
    if layout.stage.frames_running() {
        layout.stage.refresh();
    }
}

pub(crate) fn editor_preview(
    layout: &mut MainLayout,
    layers: Vec<crate::render::LayerSpec>,
    intensity: f64,
) {
    layout.stage.apply_preview(layers, intensity);
}

pub(crate) fn clear_editor_preview(layout: &mut MainLayout) {
    layout.stage.clear_preview();
}

pub(crate) fn promote_editor_preview(layout: &mut MainLayout) {
    layout.stage.promote_preview();
}

/// 聊天列开合（托盘入口 / `UiHandle::set_chat_panel`）。
pub(crate) fn set_chat_visible(layout: &mut MainLayout, main: HWND, visible: bool) {
    if layout.chat_visible == visible {
        return;
    }
    layout.chat_visible = visible;
    windows_chat::set_main_pane_visible(main, visible);
    relayout(layout, main);
    rust_info!("主窗聊天列{}", if visible { "展开" } else { "收起" });
}

pub(crate) fn chat_visible(layout: &MainLayout) -> bool {
    layout.chat_visible
}

pub(crate) fn chat_width(layout: &MainLayout) -> f64 {
    layout.chat_width.unwrap_or(0.0)
}

pub(crate) fn set_chat_width(layout: &mut MainLayout, main: HWND, width: Option<f64>) {
    layout.chat_width = width;
    relayout(layout, main);
}

/// 命中判定：x（客户区物理像素）是否落在分隔条热区上。
///
/// 命中范围以分隔带左缘为中心、向两侧各扩 `max(带宽, 4)` —— 留一点宽容，拖动
/// 不要求像素级对准。`WM_SETCURSOR`（悬停光标）与 [`begin_divider_drag`]（按下
/// 进入拖动）共用同一判定，两处不会漂移。
pub(crate) fn divider_hit_test(layout: &MainLayout, main: HWND, x: i32) -> bool {
    if !layout.chat_visible {
        return false;
    }
    let (width, _) = client_size(main);
    let scale = dpi_scale(main);
    let divider_phys = (DIVIDER_WIDTH * scale).round() as i32;
    let chat_phys = layout
        .chat_width
        .map(|logical| (logical * scale).round() as i32)
        .unwrap_or_else(|| {
            (f64::from(width) / scale * CHAT_FALLBACK_WIDTH_RATIO * scale).round() as i32
        });
    let divider_x = width - chat_phys - divider_phys;
    (x - divider_x).abs() <= divider_phys.max(4)
}

/// 主窗左键按下：命中分隔条区域则进入拖动（返回是否开始拖动）。
pub(crate) fn begin_divider_drag(layout: &mut MainLayout, main: HWND, x: i32) -> bool {
    if !divider_hit_test(layout, main, x) {
        return false;
    }
    let (width, _) = client_size(main);
    let scale = dpi_scale(main);
    let current = layout
        .chat_width
        .unwrap_or(f64::from(width) / scale * CHAT_FALLBACK_WIDTH_RATIO);
    layout.divider_drag = Some((x, current));
    true
}

/// 拖动中：按位移更新聊天列宽度（向左拖 = 变宽）。
pub(crate) fn drag_divider_to(layout: &mut MainLayout, main: HWND, x: i32) -> bool {
    let Some((start_x, start_width)) = layout.divider_drag else {
        return false;
    };
    let scale = dpi_scale(main);
    let delta = f64::from(start_x - x) / scale;
    layout.chat_width = Some(start_width + delta);
    relayout(layout, main);
    true
}

pub(crate) fn end_divider_drag(layout: &mut MainLayout) {
    if layout.divider_drag.take().is_some() {
        // W9b：拖动结束把运行时宽度写回 `general.popup.chatWidth`（宿主请求面 →
        // Node 的既有 CONFIG 保存路径）。单向、非阻塞；结果由 ports 侧留痕。
        if let Some(width) = layout.chat_width {
            crate::ui::ports::request_chat_width_writeback(width);
        }
        rust_debug!("分隔条拖动结束（宽度已提交写回）");
    }
}

/// 主窗销毁/退出：停帧并释放舞台表面。
pub(crate) fn teardown(layout: &mut MainLayout) {
    layout.stage.detach();
    if layout.stage_hwnd != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(layout.stage_hwnd);
        }
        layout.stage_hwnd = 0;
    }
    // 顶栏随主窗销毁（子窗口）；这里对状态快照兜底清理（顶栏字体整只释放），
    // 防陈旧 HWND/字体句柄被复用。正常路径下顶栏自己的 WM_DESTROY 已先行清理。
    let fonts = TITLEBAR.with(|cell| cell.borrow_mut().take().map(|ui| (ui.font, ui.brand_font)));
    if let Some(fonts) = fonts {
        for handle in [fonts.0, fonts.1] {
            if handle != 0 {
                unsafe { DeleteObject(handle) };
            }
        }
    }
}

// ==========================================
// 主窗 GDI 底色（stage_bg + 颗粒 + 分隔线）
// ==========================================

/// 主窗 WM_PAINT 的背景。主窗用整体 alpha 配合 GDI 承载控件；仅舞台子窗口
/// 使用 UpdateLayeredWindow，透明像素透出这里的舞台底色。
pub(crate) fn paint_backdrop(hdc: HDC, width: i32, height: i32, layout: Option<&MainLayout>) {
    if width <= 0 || height <= 0 {
        return;
    }
    let t = crate::ui::theme::tokens();
    let full = paint_win::Rect::new(0, 0, width, height);
    // 舞台兜底底（`Fill::Radial` 在 GDI 下退化为末档实色，见 paint_win 模块头）。
    paint_win::fill_rect(hdc, full, &t.stage_bg);
    // 舞台纹理（verdigris 的氧化斑块；另两套主题为 None）——与 macOS
    // `macos_main.rs::paint_stage_backdrop` 的层序一致（底 → 纹理 → 颗粒）。
    if let Some(sheen) = t.stage_tex {
        paint_win::draw_sheen(hdc, full, &sheen);
    }
    if let Some(alpha) = t.stage_grain {
        paint_win::draw_texture(hdc, full, crate::ui::theme::Tex::Grain, alpha);
    }
    if let Some(layout) = layout {
        if layout.chat_visible && layout.divider_w > 0 {
            // 分隔线：`outline` 色的 1px 竖线，落在分隔带**右缘**（紧贴聊天列左缘，
            // = 设计稿 `.chat` 的 `border-left` 位置）。热区本身不涂色：整窗背景
            // （上面的 `stage_bg`）在带下方承担底色 —— 与 macOS
            // `macos_main.rs::paint_divider` 对称（右缘 1px 叠舞台底）。
            let x = layout.divider_x + layout.divider_w - 1;
            paint_win::fill_color(hdc, paint_win::Rect::new(x, 0, 1, height), t.outline);
        }
    }
}

// ==========================================
// 全窗宽顶栏（顶部 26px 带，条内几何来自 `ui::titlebar`）
// ==========================================

/// 创建全窗宽顶栏子窗口（主窗内的兄弟窗口；z 序由 relayout 显式维护）。
fn create_titlebar(main: HWND) {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(TITLEBAR_CLASS);
    let (width, _) = client_size(main);
    let band = scaled_f(titlebar::HEIGHT, dpi_scale(main));
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = Some(titlebar_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        // 类刷留空：整带底色由 WM_PAINT 的 paint_titlebar 按主题画
        // （换主题不必重注册窗口类；品牌/状态位/入口都是单面绘制的一部分）。
        wc.hbrBackground = 0;
        // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&wc);
        let bar = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            width,
            band,
            main,
            0,
            hinstance,
            std::ptr::null(),
        );
        if bar == 0 {
            // 顶栏失败不中止宿主：主窗仍可用，但顶部 26px 带露出窗口自身底色
            //（不回落第二份顶栏实现 —— 旧聊天列顶栏已删除）。
            rust_warn!("全窗宽顶栏创建失败（主窗仍可用，顶部 26px 带将无顶栏绘制）");
            return;
        }
    }
}

/// 顶栏底：`bar_bg` + 内立体线 + 下边线（`bar_edge`）。
///
/// **顶栏外投影（`--barsh` 的非 inset 部分）不在这里画**：本窗是顶栏自身的子窗口，
/// GDI 画不出客户区之外的像素；能承载该投影的是下方的聊天列 DC 与舞台表面，实际
/// 画点取设计稿 `.bar` 的原位 —— `windows_chat.rs::paint_shell` 在聊天列 DC 上画
/// 投影带（条下 1px 露头在标签条上可见）。舞台列是分层渲染表面、不参与 GDI 主题
/// 绘制，这一半没有画点（平台差异，如实登记）。
unsafe fn paint_titlebar(bar: HWND, hdc: HDC) {
    let t = crate::ui::theme::tokens();
    let (width, height) = client_size(bar);
    if width <= 0 || height <= 0 {
        return;
    }
    let full = paint_win::Rect::new(0, 0, width, height);
    unsafe {
        paint_win::fill_rect(hdc, full, &t.bar_bg);
        paint_win::draw_bevel(hdc, full, &t.bar_bevel);
        paint_win::fill_color(
            hdc,
            paint_win::Rect::new(0, height - 1, width, 1),
            t.bar_edge,
        );
        // 状态位前的强调圆点（`--acc`）：与 macOS 同口径 —— 圆点坐在锚点
        // `titlebar::status_x()` 上（`centered_y(DOT_SIZE)`，直径 6），状态文字
        // 右移到锚点 + `DOT_SIZE + DOT_GAP`（见 [`layout_titlebar`]）。
        let scale = dpi_scale(bar);
        paint_win::draw_dot(
            hdc,
            scaled_f(titlebar::status_x(), scale) + scaled_f(titlebar::DOT_SIZE / 2.0, scale),
            scaled_f(titlebar::centered_y(titlebar::DOT_SIZE), scale)
                + scaled_f(titlebar::DOT_SIZE / 2.0, scale),
            scaled_f(titlebar::DOT_SIZE / 2.0, scale),
            t.accent,
            t.bar_bg.base_color(),
        );
    }
    // 条内内容（品牌/状态位/设置/×）：取一次快照后整段绘制 —— 绘制期间不持有
    // `TITLEBAR` 借用（窗口过程里的重入约束见 native-host AGENTS §5.1 同族规则）。
    let snap = TITLEBAR.with(|cell| {
        cell.borrow().as_ref().map(|ui| TitlebarPaint {
            font: ui.font,
            brand_font: ui.brand_font,
            brand: ui.brand,
            status: ui.status,
            hide: ui.hide,
            settings: ui.settings,
            status_text: ui.status_text.clone(),
            hover: ui.hover,
            pressed: ui.pressed,
        })
    });
    let Some(snap) = snap else { return };
    unsafe {
        // 品牌字 `ink` + 粗体（macOS：`boldSystemFontOfSize(11)`、色取 `tokens.ink`）；
        // 状态位 `dim` + 常规字重（macOS：`resolve_font(HELP_BASE_SIZE)`）。
        draw_bar_text(hdc, snap.brand, titlebar::BRAND_TEXT, t.ink, snap.brand_font);
        draw_bar_text(hdc, snap.status, &snap.status_text, t.dim, snap.font);
    }
    let radius = scaled(t.radii.btn.round() as i32, dpi_scale(bar));
    for (hit, rect, role, label) in [
        // 两个入口与 macOS 同形：`Face::Normal` 的 `btn_bg` 实面 + 描边 + 投影
        //（那边 `paint_chrome` 对两个导航按钮都调 `style_button(Face::Normal)`）。
        (BarHit::Settings, snap.settings, ButtonRole::Normal, "设置"),
        (BarHit::Hide, snap.hide, ButtonRole::Close, "×"),
    ] {
        let face = paint_win::button_face(t, role, snap.hover == hit, snap.pressed == hit);
        unsafe {
            paint_win::draw_bar_entry(
                hdc,
                rect,
                &face,
                label,
                snap.font,
                snap.pressed == hit,
                radius,
            )
        };
    }
}

/// 条面文字（品牌/状态位）：透明底直接画在条面上 —— 与 macOS 同一结构；
/// 旧实现是 STATIC 子控件，实机在条底渐变上露出白板（2026-10-07）。
unsafe fn draw_bar_text(
    hdc: HDC,
    rect: paint_win::Rect,
    text: &str,
    color: crate::ui::theme::tokens::Rgba,
    font: HFONT,
) {
    if rect.is_empty() {
        return;
    }
    let old = if font != 0 {
        unsafe { SelectObject(hdc, font) }
    } else {
        0
    };
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(color));
        let mut r = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.right(),
            bottom: rect.bottom(),
        };
        let text = wide(text);
        DrawTextW(
            hdc,
            text.as_ptr(),
            -1,
            &mut r,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
        if old != 0 {
            SelectObject(hdc, old);
        }
    }
}

/// 主题切换：顶栏整条按新主题重绘（其余窗口由 `windows.rs` 的广播逐一处理）。
pub(crate) fn apply_theme() {
    let bar = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.bar));
    if let Some(bar) = bar {
        // 单面绘制：条底与「设置/×」都按 tokens 现画，失效重绘即完成换肤
        //（旧实现在这里重记子控件表面色 —— 子控件路径已删，不再有残留色板）。
        unsafe { InvalidateRect(bar, std::ptr::null(), 1) };
    }
    rust_info!("主窗顶栏已按新主题重绘（Windows）");
}

/// 顶栏 `WM_CREATE`：建字体并把展示状态存进 `TITLEBAR`（**不建子控件** —— 单面绘制）。
unsafe fn init_titlebar(bar: HWND) {
    let font = create_titlebar_font(bar, false);
    let brand_font = create_titlebar_font(bar, true);
    if font == 0 || brand_font == 0 {
        rust_warn!("顶栏字体创建失败（品牌/常规任一为空，顶栏文字回退系统缺省字体）");
    }
    TITLEBAR.with(|cell| {
        *cell.borrow_mut() = Some(TitlebarUi {
            bar,
            font,
            brand_font,
            brand: paint_win::Rect::default(),
            status: paint_win::Rect::default(),
            hide: paint_win::Rect::default(),
            settings: paint_win::Rect::default(),
            status_text: crate::ui::titlebar::current(),
            hover: BarHit::None,
            pressed: BarHit::None,
        });
    });
    unsafe { layout_titlebar(bar) };
}

/// 顶栏条内几何（`WM_SIZE` 驱动；算式来自 `ui::titlebar`，本侧只做 DPI 缩放）。
///
/// 结果写进 `TITLEBAR` —— **绘制与命中共用同一份矩形**（这里与
/// `paint_titlebar` 的取用是这一份数据的读写两端）。
unsafe fn layout_titlebar(bar: HWND) {
    let (width, _) = client_size(bar);
    if width <= 0 {
        return;
    }
    let scale = dpi_scale(bar);
    let nav_h = scaled_f(titlebar::CONTROL_HEIGHT, scale);
    let y = scaled_f(titlebar::centered_y(titlebar::CONTROL_HEIGHT), scale);
    let brand = paint_win::Rect::new(
        scaled_f(titlebar::BRAND_X, scale),
        y,
        scaled_f(titlebar::brand_width(), scale),
        nav_h,
    );
    // 状态位锚点坐圆点，文字右移到 `DOT_SIZE + DOT_GAP` 之后（与 macOS
    // `macos_main.rs::relayout` 的 `status_x` 算式同源）。
    let status = paint_win::Rect::new(
        scaled_f(
            titlebar::status_x() + titlebar::DOT_SIZE + titlebar::DOT_GAP,
            scale,
        ),
        y,
        (scaled_f(
            titlebar::status_slot_width(
                f64::from(width) / scale,
                f64::from(TITLEBAR_RIGHT_RESERVE),
            ) - titlebar::DOT_SIZE
                - titlebar::DOT_GAP,
            scale,
        ))
        .max(0),
        nav_h,
    );
    // 右侧入口从右到左：×、设置（与 macOS 同序）。
    let positions = titlebar::right_button_x(
        f64::from(width) / scale,
        &[f64::from(NAV_CLOSE_WIDTH), f64::from(NAV_SETTINGS_WIDTH)],
    );
    let hide = paint_win::Rect::new(
        scaled_f(positions[0], scale),
        y,
        scaled(NAV_CLOSE_WIDTH, scale),
        nav_h,
    );
    let settings = paint_win::Rect::new(
        scaled_f(positions[1], scale),
        y,
        scaled(NAV_SETTINGS_WIDTH, scale),
        nav_h,
    );
    TITLEBAR.with(|cell| {
        if let Some(ui) = cell.borrow_mut().as_mut() {
            ui.brand = brand;
            ui.status = status;
            ui.hide = hide;
            ui.settings = settings;
        }
    });
}

/// 命中的条内入口（客户区坐标）。入口之外的区域归拖动（`HTCAPTION`）。
fn titlebar_hit(x: i32, y: i32) -> BarHit {
    TITLEBAR.with(|cell| {
        let ui_state = cell.borrow();
        let Some(ui) = ui_state.as_ref() else {
            return BarHit::None;
        };
        if ui.settings.contains(x, y) {
            BarHit::Settings
        } else if ui.hide.contains(x, y) {
            BarHit::Hide
        } else {
            BarHit::None
        }
    })
}

/// 顶栏字体（全局快照族名 + 小号字；族名缺省回落既有中文 UI 字体）。
///
/// `bold = true` 只用于品牌字：macOS 的品牌字是 `boldSystemFontOfSize(11)`，
/// 状态位与右侧入口走常规字重（`resolve_font(HELP_BASE_SIZE)`）。
fn create_titlebar_font(bar: HWND, bold: bool) -> HFONT {
    let scale = dpi_scale(bar);
    let snapshot = crate::ui::font::snapshot();
    let face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    let size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    // 统一走 `paint_win::create_ui_font`（灰度抗锯齿）：条面文字与 macOS 的
    // 灰度 AA 同口径，避免 ClearType 的彩色次像素在浅底圆角按钮上读成脏边。
    paint_win::create_ui_font(
        -scaled(size, scale),
        if bold { FW_BOLD as i32 } else { FW_NORMAL as i32 },
        &face,
    )
}

/// 顶栏状态位文本刷新（`windows.rs::refresh_titlebar` 调用；顶栏是状态位的唯一
/// 展示副本 —— 旧聊天列顶栏的副本已随旧实现删除）。
pub(crate) fn set_titlebar_text(text: &str) {
    let changed = TITLEBAR.with(|cell| {
        cell.borrow_mut().as_mut().map(|ui| {
            if ui.status_text == text {
                return false;
            }
            ui.status_text = text.to_string();
            true
        })
    });
    match changed {
        Some(true) => {
            let bar = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.bar));
            if let Some(bar) = bar {
                unsafe { InvalidateRect(bar, std::ptr::null(), 1) };
            }
        }
        Some(false) => {}
        None => {
            // 顶栏未建立（创建失败/已销毁）：展示副本无处可写，留痕即可 ——
            // 推送命令的成功语义不因此改变（与 macOS 侧同一口径）。
            rust_debug!("全窗宽顶栏文本刷新跳过：顶栏未建立");
        }
    }
}

/// 全局字体快照变化：顶栏字体整只替换（旧只释放）并重绘。
pub(crate) fn apply_titlebar_font() {
    let bar = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.bar));
    let Some(bar) = bar else { return };
    let font = create_titlebar_font(bar, false);
    let brand_font = create_titlebar_font(bar, true);
    if font == 0 || brand_font == 0 {
        rust_warn!("顶栏字体创建失败，保留旧字体");
        return;
    }
    let old = TITLEBAR.with(|cell| {
        cell.borrow_mut().as_mut().map(|ui| {
            let old = (ui.font, ui.brand_font);
            ui.font = font;
            ui.brand_font = brand_font;
            old
        })
    });
    match old {
        Some(old) => {
            for handle in [old.0, old.1] {
                if handle != 0 {
                    unsafe { DeleteObject(handle) };
                }
            }
            unsafe { InvalidateRect(bar, std::ptr::null(), 1) };
        }
        None => {
            for handle in [font, brand_font] {
                if handle != 0 {
                    unsafe { DeleteObject(handle) };
                }
            }
        }
    }
}

/// 顶栏窗口过程：单面绘制的内容入口（设置/×）的悬停、按压与拖动都在这里收口。
unsafe extern "system" fn titlebar_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底由 WM_PAINT 统一画（类刷为空刷）；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                paint_titlebar(hwnd, hdc);
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_CREATE => {
            unsafe { init_titlebar(hwnd) };
            0
        }
        WM_SIZE => {
            unsafe { layout_titlebar(hwnd) };
            0
        }
        WM_MOUSEMOVE => {
            let hit = titlebar_hit(lo_word(lparam), hi_word(lparam));
            let changed = TITLEBAR.with(|cell| {
                cell.borrow_mut()
                    .as_mut()
                    .map(|ui| {
                        if ui.hover == hit {
                            return false;
                        }
                        ui.hover = hit;
                        true
                    })
                    .unwrap_or(false)
            });
            if changed {
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            }
            // `TrackMouseEvent` 是一次性的：每次移动都重新登记离开通知
            //（与 `paint_win.rs` 的按钮子类同款）。
            let mut track = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            unsafe { TrackMouseEvent(&mut track) };
            0
        }
        WM_MOUSELEAVE => {
            let changed = TITLEBAR.with(|cell| {
                cell.borrow_mut()
                    .as_mut()
                    .map(|ui| {
                        if ui.hover == BarHit::None {
                            return false;
                        }
                        ui.hover = BarHit::None;
                        true
                    })
                    .unwrap_or(false)
            });
            if changed {
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            }
            0
        }
        WM_LBUTTONDOWN => {
            let hit = titlebar_hit(lo_word(lparam), hi_word(lparam));
            if hit != BarHit::None {
                TITLEBAR.with(|cell| {
                    if let Some(ui) = cell.borrow_mut().as_mut() {
                        ui.pressed = hit;
                        ui.hover = hit;
                    }
                });
                // 捕获鼠标：移出条外松开也不丢「松开」消息（与系统按钮同语义）。
                unsafe { SetCapture(hwnd) };
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            }
            0
        }
        WM_LBUTTONUP => {
            let hit = titlebar_hit(lo_word(lparam), hi_word(lparam));
            let pressed = TITLEBAR.with(|cell| {
                cell.borrow_mut()
                    .as_mut()
                    .map(|ui| {
                        let pressed = ui.pressed;
                        ui.pressed = BarHit::None;
                        ui.hover = hit;
                        pressed
                    })
                    .unwrap_or(BarHit::None)
            });
            // 松开时仍在原入口上才算激活（移出再松开 = 取消，与系统按钮同语义）。
            let activate = pressed != BarHit::None && pressed == hit;
            if pressed != BarHit::None {
                unsafe { ReleaseCapture() };
            }
            if activate {
                match pressed {
                    BarHit::Settings => crate::ui::settings::settings_ui().open_window(),
                    // 「收起」= 与主窗关闭请求同一归宿（不退出、不销毁）。
                    BarHit::Hide => {
                        if let Err(error) = crate::ui::platform::windows::retract_main_window() {
                            rust_warn!("顶栏收起主窗失败: {error}");
                        }
                    }
                    BarHit::None => {}
                }
            }
            unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            0
        }
        WM_CAPTURECHANGED => {
            let changed = TITLEBAR.with(|cell| {
                cell.borrow_mut()
                    .as_mut()
                    .map(|ui| {
                        if ui.pressed == BarHit::None {
                            return false;
                        }
                        ui.pressed = BarHit::None;
                        true
                    })
                    .unwrap_or(false)
            });
            if changed {
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
            }
            0
        }
        WM_NCHITTEST => {
            // 屏幕坐标 → 客户区：条内入口归客户区（点击走 WM_LBUTTON*，悬停/按压
            // 在上面记账）；其余区域归标题区拖动（转发见下一条）。这段在实机
            // 生效前，入口点按会退化成拖窗 —— 属待实机验收项。
            let mut pt = POINT {
                x: lo_word(lparam),
                y: hi_word(lparam),
            };
            let hit = {
                unsafe { ScreenToClient(hwnd, &mut pt) };
                titlebar_hit(pt.x, pt.y)
            };
            if hit == BarHit::None {
                HTCAPTION as LRESULT
            } else {
                HTCLIENT as LRESULT
            }
        }
        WM_NCLBUTTONDOWN if wparam == HTCAPTION as WPARAM => {
            // 标题带是子窗口，默认处理会移动子窗口本身；拖动必须转给主窗
            //（入口区域在上面已归客户区，走不到这一臂）。拖动的几何写回仍走主窗
            // 既有的 WM_EXITSIZEMOVE → `commit_window_geometry_writeback`，不新增
            // 第二条路径。
            unsafe { SendMessageW(GetParent(hwnd), WM_NCLBUTTONDOWN, wparam, lparam) };
            0
        }
        WM_DESTROY => {
            // 字体不随窗口销毁自动回收：整只释放（换字体路径也是整只替换旧只）。
            let fonts =
                TITLEBAR.with(|cell| cell.borrow_mut().take().map(|ui| (ui.font, ui.brand_font)));
            if let Some(fonts) = fonts {
                for handle in [fonts.0, fonts.1] {
                    if handle != 0 {
                        unsafe { DeleteObject(handle) };
                    }
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 舞台子窗口过程：只有 ULW 合成，不需要额外消息处理。
unsafe extern "system" fn stage_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    windows_sys::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生产代码段（`#[cfg(test)]` 之前）——源码级守门断言都在这段上做，
    /// 否则会命中测试自己的字面量（那种断言永远为真、等于没写）。
    fn production_source() -> &'static str {
        let src = include_str!("windows_main.rs");
        let end = src.find("#[cfg(test)]").expect("必须有测试段");
        &src[..end]
    }

    /// 条内几何收口到共享模块：本文件不得再落第二份条高/品牌槽/状态位起点定义
    /// （旧实现曾在 `windows_chat.rs` 与这里各持一份镜像常量），且必须消费共享面。
    /// 与 macOS `macos_main.rs` 的同名守卫对称 —— 本文件在 macOS 上不参与编译，
    /// 由 CI 的 windows job 执行（本机只做离线核对，见模块头）。
    #[test]
    fn 顶栏几何收口共享模块() {
        let source = production_source();
        for (name, needle) in [
            ("条高常量", concat!("const TITLEBAR", "_HEIGHT")),
            ("品牌文案常量", concat!("const TITLEBAR", "_BRAND_TEXT")),
            ("品牌槽宽算式", concat!("fn titlebar_brand", "_width")),
            ("状态位起点算式", concat!("fn titlebar_status", "_x")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "顶栏几何镜像回潮「{name}」：{needle}"
            );
        }
        for (name, needle) in [
            ("条高", concat!("titlebar::", "HEIGHT")),
            ("品牌槽宽", concat!("titlebar::brand", "_width")),
            ("状态位锚点", concat!("titlebar::status", "_x")),
            ("垂直居中", concat!("titlebar::centered", "_y")),
        ] {
            assert!(
                source.contains(needle),
                "顶栏几何未消费共享「{name}」：{needle}"
            );
        }
    }

    /// 最短窗宽（`MAIN_WINDOW_MIN_WIDTH`）下：状态文字仍有可读宽度；右侧保留区
    /// 容得下关闭「×」与「设置」。
    #[test]
    fn 最短窗宽下状态位与关闭按钮几何相容() {
        let slot = titlebar::status_slot_width(
            crate::window::MAIN_WINDOW_MIN_WIDTH,
            f64::from(TITLEBAR_RIGHT_RESERVE),
        );
        assert!(
            slot >= titlebar::MIN_STATUS_WIDTH,
            "状态位文字在最短窗宽下被压没（槽 {slot}）"
        );
        assert!(
            f64::from(TITLEBAR_RIGHT_RESERVE)
                >= f64::from(NAV_CLOSE_WIDTH + NAV_SETTINGS_WIDTH)
                    + titlebar::BUTTON_GAP
                    + titlebar::RIGHT_MARGIN,
            "右侧保留区容不下关闭与设置按钮"
        );
    }
}
