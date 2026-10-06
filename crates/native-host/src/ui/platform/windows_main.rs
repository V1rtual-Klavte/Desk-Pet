//! 主窗一体布局（W9a，Windows）：角色舞台 + 聊天列同窗合成；顶部为全窗宽顶栏（W9c）。
//!
//! **未在 Windows 实机验证**（本机只做离线类型核对，bundled SQLite 需要 msvc 工具链，
//! 见原生宿主迁移过程记录 §9.4 第 19 条）。结构上与 macOS 同语义：
//! - 舞台是主窗客户区内的**子窗口**（`WS_CHILD | WS_EX_LAYERED`），W6a 的
//!   `WinLayerSurface` 以它为合成目标（Windows 8 起 `WS_EX_LAYERED` 支持子窗口）；
//!   `render/win.rs` 的文档把目标写作「顶层窗口」是 W6a 的保守表述 —— **本处是
//!   经协调者登记的能力偏差**，Windows 实机验证（W11）必须确认子窗口 `UpdateLayeredWindow`
//!   的行为；若不成立，降级方案是「整窗合成 + 聊天列覆盖」，记为已知布局缺口。
//! - 聊天面板由 `windows_chat::mount_main_pane` 挂进主窗（同一份控件栈）；
//! - 分隔条拖动由主窗过程转发鼠标事件（`WM_LBUTTONDOWN` 命中分隔条区域时进入拖动）；
//! - **全窗宽顶栏（W9c）**：主窗层的一条整窗宽 26px 子窗口顶栏（品牌/状态位/
//!   关闭「×」+ 拖动；设置/图层入口在托盘菜单，不在条内）。创建顺序在聊天面板
//!   之后 = 兄弟 z 序在上，覆盖聊天列顶部的同一 26px 带；舞台子窗口从带下方开始
//!   （顶部布局预留）。条高、品牌槽与状态位坐标等几何的唯一来源是
//!   `ui/titlebar.rs`（旧聊天列顶栏副本已随旧实现删除）；文本唯一真值同样在那里。
//!
//! 未验证项（交付报告同步登记）：舞台子窗口的分层合成、收起/呼出动画对角色内容的
//! 作用（W5 的常量 alpha 只作用于主窗自身位图，子窗口内容不随 alpha 淡出）、
//! 顶栏子窗口的 `WM_NCHITTEST → HTCAPTION` 拖动与覆盖效果。

use std::cell::RefCell;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, DeleteObject, EndPaint, InvalidateRect, SetBkMode, SetTextColor,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, FW_NORMAL, HDC, HFONT, OUT_DEFAULT_PRECIS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::ODT_BUTTON;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetWindowRect, MoveWindow, RegisterClassW,
    SendMessageW, SetWindowPos, SetWindowTextW, BS_OWNERDRAW, CS_HREDRAW, CS_VREDRAW, HMENU,
    HTCAPTION, HWND_TOP, SWP_NOACTIVATE, SWP_NOZORDER, WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC,
    WM_DESTROY, WM_DRAWITEM, WM_ERASEBKGND, WM_NCHITTEST, WM_PAINT, WM_SETFONT, WM_SIZE, WNDCLASSW,
    WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_VISIBLE,
};

use crate::error::{AppError, AppResult};
use crate::render::geometry::WindowGeometry;
use crate::render::win::WinLayerSurface;
use crate::ui::stage::Stage;
use crate::ui::theme::paint_win::{self, ButtonRole};
use crate::ui::titlebar;
use crate::{rust_debug, rust_info, rust_warn};

use super::windows_chat::{self, DrawItemStruct};
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
/// 关闭「×」按钮宽度（本侧条内只余它一枚按钮）。
const NAV_CLOSE_WIDTH: i32 = 22;
/// 右侧按钮保留宽度（条内只余关闭按钮，故比 macOS 的 46 窄）。
const TITLEBAR_RIGHT_RESERVE: i32 = 30;
/// 顶栏按钮 ID（只在本顶栏窗口的子控件里使用，与 `windows_chat.rs` 的 ID 命名
/// 空间天然隔离 —— WM_COMMAND 只到达控件直接父窗口）。
/// 只保留关闭「×」：Windows 的设置/图层入口在托盘菜单（与 macOS 只保留
/// 设置/图层、去掉「×」的裁定互为镜像）。
const BAR_BTN_HIDE_ID: i32 = 2003;
/// `SetBkMode` 的 TRANSPARENT（1）：windows-sys 的 `Gdi::TRANSPARENT` 类型是 u32，
/// 该 API 要 i32，按 `windows_chat.rs` 同款就地定义（避免类型不匹配）。
const TRANSPARENT: i32 = 1;

/// 全窗宽顶栏的控件句柄（主线程唯一；随主窗销毁清空）。
struct TitlebarUi {
    bar: HWND,
    brand: HWND,
    status: HWND,
    hide: HWND,
    /// 顶栏字体（随全局字体快照刷新时整只替换）。
    font: HFONT,
}

thread_local! {
    static TITLEBAR: RefCell<Option<TitlebarUi>> = const { RefCell::new(None) };
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
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
    // 以下三项由 windows.rs 的 ULW 底色读取（BackdropKey + paint_backdrop 入参），
    // 是跨 windows_main / windows 两个模块的共享布局状态，故对 crate 可见。
    pub(crate) chat_visible: bool,
    /// 聊天列宽度（逻辑像素）；`None` = 未收到 CONFIG 推送（用兜底）。
    chat_width: Option<f64>,
    /// 分隔条拖动：按下时的鼠标 x（物理）与当时的列宽（逻辑）。
    divider_drag: Option<(i32, f64)>,
    // ── 主窗 ULW 底色的重画几何（`relayout` 每轮写入；`windows.rs` 读）──
    /// 分隔带左缘（物理像素）与带宽；`chat_visible=false` 时无意义。
    pub(crate) divider_x: i32,
    pub(crate) divider_w: i32,
}

/// 建立主窗布局：舞台子窗口 + 聊天面板挂载。
pub(crate) fn install(main: HWND) -> AppResult<MainLayout> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(STAGE_CLASS);
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(stage_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&wc);
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
        return Err(AppError::Other("舞台子窗口创建失败".into()));
    }
    let surface = unsafe { WinLayerSurface::new(stage_hwnd)? };
    let stage = Stage::new(surface);

    // 聊天面板：同一份控件实现挂进主窗（产品形态在主窗内）。
    windows_chat::mount_main_pane(main);

    // 全窗宽顶栏：必须在聊天面板之后创建 —— 兄弟 z 序在上，正好盖住其 26px 顶栏带。
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
            unsafe { MoveWindow(titlebar, 0, 0, width, band, 1) };
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

/// 可见期跟踪：全局光标喂给舞台（60Hz，由 W5 的跟踪计时器调用）。
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
    // 顶栏随主窗销毁（子窗口），这里只清掉线程内的句柄快照，防陈旧 HWND 被复用。
    TITLEBAR.with(|cell| *cell.borrow_mut() = None);
}

// ==========================================
// 主窗 ULW 底色（stage_bg + 颗粒 + 分隔线）
// ==========================================

/// 画主窗自身 ULW 表面的底色（`windows.rs::submit_frame` 在提交前调用）。
///
/// 为什么画在这里：主窗是 `WS_EX_LAYERED`（`UpdateLayeredWindow` 提交），它自己不
/// 走 GDI 绘制；而舞台子窗口是**分层子窗口** —— 子窗口透明像素处透出的正是父窗口
/// 的 ULW 内容，聊天列左边的分隔带也落在这一层。所以「舞台兜底 + 分隔线」必须进
/// 主窗的 DIB，而不是某个子窗口的 `WM_PAINT`。
///
/// **未在 Windows 实机验证**（分层子窗口与父 ULW 内容的合成行为，同模块头约定）。
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
            // = 设计稿 `.chat` 的 `border-left` 位置）。热区本身不涂色：整窗 ULW 底
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

/// 创建全窗宽顶栏子窗口（主窗内的兄弟窗口；创建顺序在聊天面板之后 = z 序在上）。
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
        // （换主题不必重注册窗口类；STATIC 标签经 WM_CTLCOLORSTATIC 取主题字色）。
        wc.hbrBackground = 0;
        // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&wc);
        let bar = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
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
        // 状态位前的强调圆点（`--acc`；x 与状态位锚点同源，圆点画在锚点左侧 ——
        // Windows 的渲染口径与 macOS 不同：那边圆点坐在锚点上、文字右移）。
        let scale = dpi_scale(bar);
        paint_win::draw_dot(
            hdc,
            scaled_f(titlebar::status_x(), scale) - scaled(10, scale),
            height / 2,
            scaled_f(titlebar::DOT_SIZE / 2.0, scale),
            t.accent,
            t.bar_bg.base_color(),
        );
    }
}

/// 主题切换：顶栏底与「×」按钮重绘（其余窗口由 `windows.rs` 的广播逐一处理）。
pub(crate) fn apply_theme() {
    let handles = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| (ui.bar, ui.hide)));
    if let Some((bar, hide)) = handles {
        unsafe {
            InvalidateRect(bar, std::ptr::null(), 1);
            InvalidateRect(hide, std::ptr::null(), 1);
        }
    }
    rust_info!("主窗顶栏已按新主题重绘（Windows）");
}

/// 顶栏子控件（WM_CREATE 时建立；品牌/状态位 STATIC + 关闭「×」按钮）。
unsafe fn build_titlebar_children(bar: HWND) {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    unsafe {
        let brand = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(titlebar::BRAND_TEXT).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            10,
            10,
            bar,
            0,
            hinstance,
            std::ptr::null(),
        );
        // 状态位（agent 状态文案，缺省「就绪」）：唯一真值在 Node 的 services/titlebar，
        // 这里只持展示副本，初值取 `crate::ui::titlebar::current()`
        // （刷新走 windows.rs::refresh_titlebar）。
        let status = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(&crate::ui::titlebar::current()).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            10,
            10,
            bar,
            0,
            hinstance,
            std::ptr::null(),
        );
        let make_button = |text: &str, id: i32| unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | BS_OWNERDRAW as u32,
                0,
                0,
                10,
                10,
                bar,
                id as HMENU,
                hinstance,
                std::ptr::null(),
            )
        };
        // 只建「×」（收起）：设置/图层入口在托盘菜单，Windows 顶栏不重复放。
        let hide = make_button("×", BAR_BTN_HIDE_ID);
        // 关闭键：主题按钮（btn_bg 族 + dim 字；悬浮换 danger，见 paint_win::button_face）。
        paint_win::set_role(hide, ButtonRole::Close);
        paint_win::install_button(
            hide,
            scaled(
                crate::ui::theme::tokens().radii.btn.round() as i32,
                dpi_scale(bar),
            ),
        );
        // 字体：全局快照族名 + 小号字（刷新见 apply_titlebar_font）。
        let font = create_titlebar_font(bar);
        for control in [brand, status, hide] {
            SendMessageW(control, WM_SETFONT, font as WPARAM, 1);
        }
        TITLEBAR.with(|cell| {
            *cell.borrow_mut() = Some(TitlebarUi {
                bar,
                brand,
                status,
                hide,
                font,
            });
        });
        layout_titlebar_children(bar);
    }
}

/// 顶栏条内控件的摆放（WM_SIZE 驱动；几何算式来自 `ui::titlebar`，本侧只做 DPI 缩放）。
unsafe fn layout_titlebar_children(bar: HWND) {
    let ui = TITLEBAR.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|ui| (ui.brand, ui.status, ui.hide))
    });
    let Some((brand, status, hide)) = ui else {
        return;
    };
    let (width, height) = client_size(bar);
    if width <= 0 || height <= 0 {
        return;
    }
    let scale = dpi_scale(bar);
    let nav_h = scaled_f(titlebar::CONTROL_HEIGHT, scale);
    let y = scaled_f(titlebar::centered_y(titlebar::CONTROL_HEIGHT), scale);
    unsafe {
        MoveWindow(
            brand,
            scaled_f(titlebar::BRAND_X, scale),
            y,
            scaled_f(titlebar::brand_width(), scale),
            nav_h,
            1,
        );
        let status_x = scaled_f(titlebar::status_x(), scale);
        MoveWindow(
            status,
            status_x,
            y,
            scaled_f(
                titlebar::status_slot_width(
                    f64::from(width) / scale,
                    f64::from(TITLEBAR_RIGHT_RESERVE),
                ),
                scale,
            ),
            nav_h,
            1,
        );
        // 右侧按钮右对齐：仅「×」（设置/图层入口在托盘菜单，Windows 只保留关闭）。
        let hide_w = scaled(NAV_CLOSE_WIDTH, scale);
        let hide_x = scaled_f(
            titlebar::right_button_x(f64::from(width) / scale, &[f64::from(NAV_CLOSE_WIDTH)])[0],
            scale,
        );
        MoveWindow(hide, hide_x, y, hide_w, nav_h, 1);
    }
}

/// 顶栏字体（全局快照族名 + 小号字；族名缺省回落既有中文 UI 字体）。
fn create_titlebar_font(bar: HWND) -> HFONT {
    let scale = dpi_scale(bar);
    let snapshot = crate::ui::font::snapshot();
    let face = snapshot
        .family
        .clone()
        .unwrap_or_else(|| "Microsoft YaHei UI".to_string());
    let size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    unsafe {
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
            wide(&face).as_ptr(),
        )
    }
}

/// 顶栏状态位文本刷新（`windows.rs::refresh_titlebar` 调用；顶栏是状态位的唯一
/// 展示副本 —— 旧聊天列顶栏的副本已随旧实现删除）。
pub(crate) fn set_titlebar_text(text: &str) {
    let status = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.status));
    match status {
        // 分号让该臂取 ()：与另一臂同型，丢弃 SetWindowTextW 的 BOOL 返回值。
        Some(status) => {
            unsafe { SetWindowTextW(status, wide(text).as_ptr()) };
        }
        None => {
            // 顶栏未建立（创建失败/已销毁）：展示副本无处可写，留痕即可 ——
            // 推送命令的成功语义不因此改变（与 macOS 侧同一口径）。
            rust_debug!("全窗宽顶栏文本刷新跳过：顶栏未建立");
        }
    }
}

/// 全局字体快照变化：顶栏控件按新快照重设字体（整只替换并释放旧字体）。
pub(crate) fn apply_titlebar_font() {
    let bar = TITLEBAR.with(|cell| cell.borrow().as_ref().map(|ui| ui.bar));
    let Some(bar) = bar else { return };
    let font = create_titlebar_font(bar);
    if font == 0 {
        rust_warn!("顶栏字体创建失败，保留旧字体");
        return;
    }
    TITLEBAR.with(|cell| {
        if let Some(ui) = cell.borrow_mut().as_mut() {
            if ui.font != 0 {
                unsafe { DeleteObject(ui.font) };
            }
            ui.font = font;
            for control in [ui.brand, ui.status, ui.hide] {
                unsafe { SendMessageW(control, WM_SETFONT, font as WPARAM, 1) };
            }
        }
    });
}

/// 顶栏「×」按钮的主题绘制（标签直接取自控件文本，避免第二处字面量）。
unsafe fn draw_titlebar_button(item: &DrawItemStruct) {
    let tokens = crate::ui::theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & windows_sys::Win32::UI::Controls::ODS_SELECTED != 0;
    let disabled = item.itemState
        & (windows_sys::Win32::UI::Controls::ODS_DISABLED
            | windows_sys::Win32::UI::Controls::ODS_GRAYED)
        != 0;
    let face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = unsafe { super::windows_chat::read_window_text(item.hwndItem) };
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    unsafe {
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            &label,
            pressed,
            disabled,
        )
    };
}

/// 顶栏窗口过程：控件拖动/点击与覆盖都在这里收口。
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
        WM_CTLCOLORSTATIC => {
            // 静态标签（品牌/状态位）：透明底 + `dim` 字（叠在 bar_bg 上）。
            unsafe {
                let hdc = wparam as HDC;
                SetBkMode(hdc, TRANSPARENT);
                SetTextColor(hdc, paint_win::colorref(crate::ui::theme::tokens().dim));
            }
            paint_win::solid_brush(crate::ui::theme::tokens().bar_bg.base_color()) as LRESULT
        }
        WM_DRAWITEM => {
            if lparam != 0 {
                let item = unsafe { &*(lparam as *const DrawItemStruct) };
                if item.CtlType == ODT_BUTTON {
                    unsafe { draw_titlebar_button(item) };
                    return 1;
                }
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CREATE => {
            unsafe { build_titlebar_children(hwnd) };
            0
        }
        WM_SIZE => {
            unsafe { layout_titlebar_children(hwnd) };
            0
        }
        WM_NCHITTEST => {
            // 非按钮区域 → 标题区：系统拖动主窗（按钮有自己的命中；STATIC 默认对
            // 鼠标透明，命中落到本窗口）。拖动的几何写回仍走主窗既有的
            // WM_EXITSIZEMOVE → `commit_window_geometry_writeback`，不新增第二条路径。
            // **未在 Windows 实机验证**（本机无法编译 Windows 目标）。
            HTCAPTION as LRESULT
        }
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            match id {
                // 「收起」= 与主窗关闭请求同一归宿（不退出、不销毁）。
                BAR_BTN_HIDE_ID => {
                    if let Err(error) = crate::ui::platform::windows::retract_main_window() {
                        rust_warn!("顶栏收起主窗失败: {error}");
                    }
                }
                _ => return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
            }
            0
        }
        WM_DESTROY => {
            TITLEBAR.with(|cell| *cell.borrow_mut() = None);
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
    /// 容得下仅剩的关闭「×」（设置/图层入口在托盘菜单，条内不重复放）。
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
            TITLEBAR_RIGHT_RESERVE >= NAV_CLOSE_WIDTH,
            "右侧保留区容不下关闭按钮"
        );
    }
}
