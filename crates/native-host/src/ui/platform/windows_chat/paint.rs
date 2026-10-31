//! 绘制：矩形 helper、主题/浮层绘制、RTF 调色板、气泡渲染与 RTF 生成。

use super::*;
use super::input::{message_menu_subclass_proc, scroll_at_bottom};
use super::layout::{
    ctlcolor_static, handle_arrow_up, handle_status_dot_visible, handle_status_label,
    paint_button_shadows, rect_contains, register_band_surface, rtf_body_font_family,
};
use super::transcript::{apply_scroll, chat_apply};
use crate::{rust_debug, rust_warn};

pub(super) fn rect_is_empty(rect: &RECT) -> bool {
    rect.right <= rect.left || rect.bottom <= rect.top
}

pub(super) fn rect_eq(a: &RECT, b: &RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

pub(super) fn rect_w(rect: &RECT) -> i32 {
    (rect.right - rect.left).max(0)
}

pub(super) fn rect_h(rect: &RECT) -> i32 {
    (rect.bottom - rect.top).max(0)
}

// ==========================================
// 主题接线（颜色只从 `crate::ui::theme` 取；本文件不留第二份定义）
// ==========================================

/// 主题按钮：切换成 ownerdraw（自绘替代系统主题按钮）+ 写角色 + 装悬浮/圆角子类。
///
/// 创建后立即调用；半径取 `radii.btn` 的 DPI 值。用 `GWL_STYLE` 追加 `BS_OWNERDRAW`
/// 而不是在每处 `CreateWindowExW` 写样式：调用点只有「这是主题按钮」这一个事实，
/// 样式位（i32/u32 的符号差异）留在本函数一处处理。
///
/// **贴皮时机与 macOS 的对照（就地注明）**：Windows 按钮不存在「贴皮只盖旧尺寸」
/// 一类问题 —— 面/边/字在每次 `WM_DRAWITEM` 按控件**当前**矩形（`rcItem`）立即
/// 绘制；持久化的只有 `SetWindowRgn` 的圆角区域，由 `paint_win` 的按钮子类在
/// `WM_SIZE` 重贴（`apply_round_region`，创建后改尺寸的调用点因此天然安全）。
/// macOS 侧是 CALayer 子层按贴皮当时的 bounds 建、帧变化不跟随（本轮实机根因），
/// 平台手法不同，结果口径一致即可，不要照搬 macOS 的补贴守卫。
pub(super) unsafe fn make_themed_button(hwnd: HWND, role: ButtonRole, scale: f64) {
    unsafe { make_themed_button_r(hwnd, role, scale, theme::tokens().radii.btn) };
}

/// 同上，半径显式给（chip 类小件用 `radii.sm`；0 = 不裁圆角）。
pub(super) unsafe fn make_themed_button_r(hwnd: HWND, role: ButtonRole, scale: f64, radius: f32) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style | (BS_OWNERDRAW as isize));
    }
    paint_win::set_role(hwnd, role);
    paint_win::install_button(hwnd, scaled(radius.round() as i32, scale));
}

/// 给 STATIC 记录字色（`WM_CTLCOLORSTATIC` 按控件读回；见 paint_win 的存储约定）。
pub(super) fn stamp_ink(hwnd: HWND, color: crate::ui::theme::Rgba) {
    paint_win::set_text_color(hwnd, color);
}

/// token 填充的代表色（渐变取 base）与面板底合成后的实色（sRGB 近似，见
/// paint_win 模块头的取舍）。**单一来源**：承载控件的 `EM_SETBKGNDCOLOR`
/// （[`rich_bg`]）与画布上的卡片/气泡填充用同一个值，控件与画布的接缝不可见。
pub(super) fn flat_over_panel(fill: &crate::ui::theme::Fill) -> crate::ui::theme::Rgba {
    paint_win::composite_over(fill_mid(fill), theme::tokens().panel_bg.base_color())
}

/// 渐变 token 在「只能吃单色」的出口（RichEdit 底、`WM_CTLCOLOR` 画刷）上的代表色：
/// 取**渐变中点**而不是首档。
///
/// 首档（[`crate::ui::theme::Fill::base_color`]）是渐变的顶部色，拿它当代表色会系统性
/// 偏亮 —— 2026-10-07 实拍：Chrome 输入框 `--fbg` 首档是纯白，RichEdit 直接吃成
/// (255,255,255) 的方白块，而 mac 侧同一控件是 `#FFFFFF→#E7EFF7` 的竖向渐变
/// （录制实测均值 ≈(237,243,248)，`test/.tmp/win-ui-align/ref/theme-1/frame-0101.png`）。
/// 取中点后单色块与 mac 的观感对齐；气泡同族（`--aibg` 等）走同一口径。
fn fill_mid(fill: &crate::ui::theme::Fill) -> crate::ui::theme::Rgba {
    use crate::ui::theme::{Fill, Rgba};
    fn sample(stops: &[(f32, Rgba)], t: f32) -> Rgba {
        let Some(&(_, first)) = stops.first() else {
            return Rgba::black_alpha(1.0);
        };
        if stops.len() == 1 {
            return first;
        }
        let mut prev = (0.0_f32, first);
        for &(pos, color) in &stops[1..] {
            if t <= pos {
                let span = (pos - prev.0).max(f32::EPSILON);
                let k = ((t - prev.0) / span).clamp(0.0, 1.0);
                return Rgba::rgba(
                    prev.1.r + (color.r - prev.1.r) * k,
                    prev.1.g + (color.g - prev.1.g) * k,
                    prev.1.b + (color.b - prev.1.b) * k,
                    prev.1.a + (color.a - prev.1.a) * k,
                );
            }
            prev = (pos, color);
        }
        prev.1
    }
    match fill {
        Fill::Solid(color) => *color,
        Fill::Linear(stops) | Fill::Striped { stops, .. } => sample(stops, 0.5),
        // 径向渐变的兜底色沿用 `base_color` 的口径（末档），与 GDI 端的实色兜底一致。
        Fill::Radial { .. } => fill.base_color(),
    }
}

/// RichEdit 底色 = token 的代表色与面板底合成（RichEdit 不能透明，渐变只能取
/// 代表色；见 [`flat_over_panel`]）。
pub(super) fn rich_bg(fill: &crate::ui::theme::Fill) -> u32 {
    paint_win::colorref(flat_over_panel(fill))
}

/// `RECT`（windows-sys）→ [`paint_win::Rect`]。
pub(super) fn win_rect_of(rect: &RECT) -> paint_win::Rect {
    paint_win::Rect::new(rect.left, rect.top, rect_w(rect), rect_h(rect))
}

/// 中性提示底：把 `color` 以 `alpha` 叠到面板底上（RichEdit 无 alpha，先合成实色）。
pub(super) fn rich_bg_alpha(color: crate::ui::theme::Rgba, alpha: f32) -> u32 {
    let panel = theme::tokens().panel_bg.base_color();
    paint_win::colorref(paint_win::composite_over(color.with_alpha(alpha), panel))
}

/// 遮罩色（浮层打开时压住消息流）：token 表没有 `--scrimc`（设计稿注明它是页面级
/// 扩展变量、只服务设计稿页面），按设计稿两版口径从 `tokens.dark` 分档派生 ——
/// 深色近黑、浅色近白。色值只此一处（两个常量带设计稿出处）。
pub(super) fn scrim_color(tokens: &'static theme::Tokens) -> theme::Rgba {
    if tokens.dark {
        theme::Rgba::black_alpha(INSPECTOR_SCRIM_ALPHA_DARK)
    } else {
        theme::Rgba::white_alpha(INSPECTOR_SCRIM_ALPHA_LIGHT)
    }
}

/// 遮罩的实色（GDI 子窗口之间没有 alpha 合成通路；与面板底预合成后整面填实色，
/// 就地注明的近似 —— 消息流被压暗/提亮而不是像 macOS 那样隐约透出）。
pub(super) fn scrim_flat(tokens: &'static theme::Tokens) -> theme::Rgba {
    paint_win::composite_over(scrim_color(tokens), tokens.panel_bg.base_color())
}

/// 当前主题的 RTF 颜色表（`{\colortbl;...}`；索引见 `RTF_*` 常量）。
struct RtfPalette {
    table: String,
}

fn rtf_palette() -> RtfPalette {
    let t = theme::tokens();
    let entry = |c: crate::ui::theme::Rgba| {
        format!(
            "\\red{}\\green{}\\blue{};",
            (c.r.clamp(0.0, 1.0) * 255.0).round() as u32,
            (c.g.clamp(0.0, 1.0) * 255.0).round() as u32,
            (c.b.clamp(0.0, 1.0) * 255.0).round() as u32,
        )
    };
    let code_bg = paint_win::composite_over(t.field_bg.base_color(), t.panel_bg.base_color());
    RtfPalette {
        table: format!(
            "{{\\colortbl;{}{}{}{}{}{}{}}}",
            entry(t.accent),
            entry(t.dim),
            entry(t.ink),
            entry(t.bubble_user_ink),
            entry(t.warn),
            entry(t.tool_ink),
            entry(code_bg),
        ),
    }
}

/// 聊天窗底：面板底 + 纹理层 + 细颗粒 + 各条区（子控件随后覆盖）。
///
/// **未在 Windows 实机验证**（同模块头约定）。
pub(super) unsafe fn paint_shell(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.hwnd, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    // 先影后物：面板投影先画（`elevation_bands` 是外扩矩形），面板底填覆盖其内侧；
    // 层序与 macOS `paint_backdrop` 一致（影 → 底 → 纹理 → 颗粒 → 描边/立体线）。
    paint_win::draw_elevation(hdc, full, &t.panel_shadow);
    paint_win::fill_rect(hdc, full, &t.panel_bg);
    if let Some(sheen) = t.panel_tex {
        paint_win::draw_sheen(hdc, full, &sheen);
    }
    if let Some(alpha) = t.panel_grain {
        paint_win::draw_texture(hdc, full, ThemeTex::Grain, alpha);
    }
    unsafe {
        let scale = dpi_scale(state.hwnd);
        // 顶栏带（本窗这份 = 投影承载面 + 带底衬）+ 标签条（仅主窗面板模式；
        // 独立聊天窗保留系统 chrome）。
        // 标签条先画：顶栏投影（下一条）的露头 1px 要落在它上面（先物后影）。
        if !rect_is_empty(&state.paint.tabs) {
            let tabs = win_rect_of(&state.paint.tabs);
            paint_win::fill_color(hdc, tabs, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(tabs.x, tabs.bottom() - 1, tabs.w, 1),
                t.bar_edge,
            );
            // 条区自绘按钮的「所在面」实色 = 条区**实际画出来的**像素（含 sheen/颗粒
            // 与 `strip_bg` 叠加）。不采样就只能拿 `panel_bg` 猜 —— 它比条区暗 ~35
            // 灰阶，ownerdraw 按钮的圆角补角会在四角留下深色方块（用户 2026-10-07
            // 实拍「按钮黑色方角」）。同一函数里刚画完，取到的就是最终可见色。
            unsafe {
                // 探针取**条区中部**：`tabs.x + 2` 落在聊天列左缘的描边/立体线上，
                // 采到的是比条底亮 ~5 灰阶的边线色 —— 自绘按钮的圆角补角用它就会
                // 在药丸四周露出一个浅色矩形（用户 2026-10-07 实拍「新会话后面有
                // 矩形灰底」）。
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (tabs.x + tabs.w / 2, tabs.y + tabs.h / 2),
                    &[state.nav_new, state.nav_history],
                );
                let tab_hwnds: Vec<HWND> = state.tab_children.iter().map(|c| c.hwnd).collect();
                // 同一探针口径：条区中部（`tabs.x + 2` 会采到左缘描边色，见上）。
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (tabs.x + tabs.w / 2, tabs.y + tabs.h / 2),
                    &tab_hwnds,
                );
            }
        }
        if !rect_is_empty(&state.paint.bar) {
            let bar = win_rect_of(&state.paint.bar);
            // 顶栏外投影（`--barsh` 的非 inset 部分；只有铜绿有声明的 `var(--contact)`）。
            // **画在这里而不是顶栏自己的窗口**：顶栏子窗口不能把 GDI 像素画到客户区外，
            // 而聊天窗 DC 向下延伸到标签条 —— 投影带落在条下 1px 处、叠在标签条上可见
            //（先物后影：上面已先画过标签条）。
            // 条底/立体线/下边线/圆点与投影同为这条带的主题绘制（2026-10-06 接线）：
            // 顶栏子窗口在最上另画一份同带内容（它盖住本窗这 26px），本窗这份是
            // 投影的承载面与带底衬；几何/取值都来自 `ui::titlebar` 与主题 token，
            // 不落第二份定义。
            // 舞台列那一半（分层渲染表面，不参与 GDI 主题绘制）没有对应画点，如实登记差异。
            paint_win::draw_elevation(hdc, bar, &t.bar_shadow);
            paint_win::fill_rect(hdc, bar, &t.bar_bg);
            paint_win::draw_bevel(hdc, bar, &t.bar_bevel);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(bar.x, bar.bottom() - 1, bar.w, 1),
                t.bar_edge,
            );
            // 状态位前的强调圆点（`--acc`；设计稿 `.status i` 在状态文字左侧）。
            // 起点与状态位锚点同源（`ui::titlebar::status_x`）。
            paint_win::draw_dot(
                hdc,
                scaled_f(crate::ui::titlebar::status_x(), scale) - scaled(10, scale),
                bar.y + bar.h / 2,
                scaled_f(crate::ui::titlebar::DOT_SIZE / 2.0, scale),
                t.accent,
                t.bar_bg.base_color(),
            );
        }
        if !rect_is_empty(&state.paint.panels) {
            let panels = win_rect_of(&state.paint.panels);
            paint_win::fill_color(hdc, panels, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(panels.x, panels.y, panels.w, 1),
                t.bar_edge,
            );
        }
        // composer 的整块面（`--ibg`）先铺：macOS 侧它覆盖**待发送条 + 把手带 +
        // 输入行**（`macos_chat/content/view.rs::relayout_panes` 的 `composer_top_from_bands`），
        // 把手带不再是独立的一条灰带 —— 它就是 composer 的上部（用户 2026-10-07
        // 实拍「输入框上面那个和 mac 根本不一样」）。条区内其它元素（待发送条、
        // 把手状态、箭头）都画在这块面之上，顺序不能反。
        if !rect_is_empty(&state.paint.input_bar) {
            let input_bar = win_rect_of(&state.paint.input_bar);
            paint_win::fill_rect(hdc, input_bar, &t.input_bar_bg);
            // 输入行按钮的所在面同理：按**输入行中心那一行**的实色采样（composer 是
            // 竖向渐变，按钮四角跨十几像素，取按钮中心行最接近）。
            let row_h = scaled(INPUT_HEIGHT, scale);
            let row_y = input_bar.bottom() - row_h + row_h / 2;
            unsafe {
                register_band_surface(
                    hdc,
                    state.hwnd,
                    (input_bar.x + 2, row_y),
                    &[state.stop, state.pick_images, state.send],
                );
            }
        }
        if !rect_is_empty(&state.paint.pending) {
            // 待发送条（设计稿 `.pend`：`--fbg2` 底 + **底边** `--bare` 与输入行分隔）；
            // 它是 composer 的顶块（composer 面已在上面铺过）—— 顶边线用 `--iedge`
            //（设计稿 `.composer` 的 `border-top`），底边线与「无待发送条时」画在
            // 输入条顶的那条线同源。
            let pending = win_rect_of(&state.paint.pending);
            paint_win::fill_color(hdc, pending, t.strip_bg);
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(pending.x, pending.y, pending.w, 1),
                t.input_bar_edge,
            );
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(pending.x, pending.bottom() - 1, pending.w, 1),
                t.bar_edge,
            );
            // 横向滚动指示（2026-10-06「多张截图不能滚动」的可见性提示）：只在内容
            // 超宽时画 —— 条底极细的 track + 按滚动比例的 thumb，**画在既有条高之内**
            //（不新增布局高度，输入区不会因它跳动）。Windows 没有 macOS 的 overlay
            // 滚动条，这条细指示是「右边还有、可以滚」的用户可见信号。
            if state.pending_content_w > pending.w {
                let thickness = scaled(PENDING_SCROLLBAR_THICKNESS, scale).max(1);
                let track_y = pending.bottom() - thickness - scaled(1, scale);
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(pending.x, track_y, pending.w, thickness),
                    t.bar_edge,
                );
                let ratio = f64::from(pending.w) / f64::from(state.pending_content_w);
                // 下限兜底：thumb 不小于 4 倍厚度，但不允许超过条宽（极窄条不 panic）。
                let min_thumb = (thickness * 4).min(pending.w).max(thickness);
                let thumb_w =
                    ((f64::from(pending.w) * ratio).round() as i32).clamp(min_thumb, pending.w);
                let max_scroll = (state.pending_content_w - pending.w).max(1);
                let progress =
                    (f64::from(state.pending_scroll_x) / f64::from(max_scroll)).clamp(0.0, 1.0);
                let travel = (pending.w - thumb_w).max(0);
                let thumb_x = pending.x + (f64::from(travel) * progress).round() as i32;
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(thumb_x, track_y, thumb_w, thickness),
                    t.dim,
                );
            }
        }
        if !rect_is_empty(&state.paint.input_bar) {
            let input_bar = win_rect_of(&state.paint.input_bar);
            // composer 上边线（设计稿 `.rail{border-top:1px solid var(--bare)}`）：
            // macOS 用**亮边** `bar_edge` 贴住 composer 上沿（`macos_chat/` 的
            // `apply_line(Top, bar_edge)`，用户规则「这个白边应该贴着下面」）。
            // 旧实现画的是 `input_bar_edge`（同主题下明显更深的灰蓝），实机上就是
            // 输入框上方那道扎眼的分隔线。
            paint_win::fill_color(
                hdc,
                paint_win::Rect::new(input_bar.x, input_bar.y, input_bar.w, 1),
                t.bar_edge,
            );
        }
        // 把手带（composer 上部那条行）：**不画底、不画线**，只画左侧状态点与
        // 状态文字、中置上拉箭头 —— 与 macOS「把手带只是「状态文字 + 箭头 +
        // 整条可点」的行」同口径。三件全部**单面绘制**：子控件（STATIC/按钮）
        // 是不透明表面，各自会把自己那块铺成异色板（2026-10-07 实机：「灰板 +
        // 白方块 + 竖条箭头」）。带区仍有独立命中区（开合浮层），只是不着色。
        // 带坐在 composer 顶段（渐变首档附近）：圆点边缘的预合成底与箭头的
        // 半透明 ink 都按这个实色近似（GDI 画刷没有 alpha，与 mac 的
        // `ink.with_alpha(0.72)` / CALayer 合成同口径的实色等价）。
        let composer_flat = t.input_bar_bg.base_color();
        if !rect_is_empty(&state.paint.handle) {
            let handle = win_rect_of(&state.paint.handle);
            // 圆点与文字同生共死（与 macOS `update_status` 的 `setHidden` 同口径）：
            // 没有通知时不亮一个看起来像「在线」的常亮点。
            if handle_status_dot_visible(&state.handle_status_label) {
                paint_win::draw_dot(
                    hdc,
                    scaled(HANDLE_STATUS_PAD_X + HANDLE_STATUS_DOT_RADIUS, scale),
                    handle.y + handle.h / 2,
                    scaled(HANDLE_STATUS_DOT_RADIUS, scale),
                    t.accent,
                    composer_flat,
                );
            }
            // 状态文字：只显示中性通知（[`handle_status_label`]），左对齐在
            // 圆点之后；字体与字色复用静态文字的小号/`dim` 口径。
            if !state.handle_status_label.is_empty() && !rect_is_empty(&state.paint.handle_status) {
                let font = state.fonts.get(1).copied().unwrap_or(0);
                let old = if font != 0 {
                    unsafe { SelectObject(hdc, font) }
                } else {
                    0
                };
                let text = wide(&state.handle_status_label);
                // `DrawTextW` 收 windows-sys 的 `RECT`（不是 `paint_win::Rect`）。
                let mut rect = {
                    let r = win_rect_of(&state.paint.handle_status);
                    RECT {
                        left: r.x,
                        top: r.y,
                        right: r.right(),
                        bottom: r.bottom(),
                    }
                };
                unsafe {
                    SetBkMode(hdc, TRANSPARENT);
                    SetTextColor(hdc, paint_win::colorref(t.dim));
                    DrawTextW(hdc, text.as_ptr(), -1, &mut rect, STATUS_TEXT_FLAGS);
                    if old != 0 {
                        SelectObject(hdc, old);
                    }
                }
            }
        }
        // 与 macOS 同用 ▴/▾ 字形。符号单独取 Segoe UI Symbol，避免正文字体缺字。
        if !rect_is_empty(&state.paint.handle_arrow) {
            let font = state.fonts.get(4).copied().unwrap_or(0);
            let old = SelectObject(hdc, font);
            let mut rect = state.paint.handle_arrow;
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, paint_win::colorref(t.dim));
            let glyph = if handle_arrow_up(state.inspector_open) { "▴" } else { "▾" };
            DrawTextW(hdc, wide(glyph).as_ptr(), -1, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            SelectObject(hdc, old);
        }
        if !rect_is_empty(&state.paint.input_field) {
            let field = win_rect_of(&state.paint.input_field);
            // 圆角取 `radii.sm`（设计稿 `.inp .ph` 的 `--r1`，2026-10-05 用户规则
            // 「圆角一律取 radii」）；承载 RichEdit 与占位 STATIC 贴同半径区域，
            // 直角不会盖住圆弧描边（见 `apply_input_round_regions`）。
            // 承载控件已按 2px 内缩（布局里做），描边与立体线在环形区露出来。
            paint_round_input_field(hdc, field, scaled_f(f64::from(t.radii.sm), scale));
        }
        // 面板外描边（中性 `outline`，同 macOS：设计稿 `.chat` 的边界是 `--outline`）
        // + 内立体线（`panel_bevel`）；画在最后 = macOS CALayer border 的最外层。
        // 条内按钮的投影（`paint_button_shadows`）先于描边：它只落在条面上，
        // 不压面板描边。
        let mut shadow_targets: Vec<HWND> = vec![state.nav_new, state.nav_history];
        shadow_targets.extend(state.tab_children.iter().map(|child| child.hwnd));
        shadow_targets.extend([state.stop, state.pick_images, state.send]);
        shadow_targets.extend(state.pending_children.iter().map(|child| child.hwnd));
        paint_button_shadows(hdc, state.hwnd, &shadow_targets);
        paint_win::draw_frame(hdc, full, t.outline, &t.panel_bevel);
    }
}

/// 正文画布底：面板底 + 纹理 + 消息流内阴影 + 卡片框（内容坐标按 `scroll_y` 偏移）。
pub(super) unsafe fn paint_canvas_shell(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.canvas, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    paint_win::fill_rect(hdc, full, &t.panel_bg);
    if let Some(sheen) = t.panel_tex {
        paint_win::draw_sheen(hdc, full, &sheen);
    }
    if let Some(alpha) = t.panel_grain {
        paint_win::draw_texture(hdc, full, ThemeTex::Grain, alpha);
    }
    if let Some(inset) = t.log_inset {
        paint_win::draw_inset(hdc, full, &inset, true);
    }
    // 聊天列的左右外描边（`--outline`）：画布从聊天窗客户区 x=0 起、横跨整列，
    // `paint_shell` 末尾 `draw_frame(full, …)` 的左右两列被它盖住 —— 于是
    // **舞台列与聊天列之间那条分界线**（mac 侧由 `DIVIDER_WIDTH` 分隔条右缘
    // 的 1px `outline` 承担，见 `macos_main::paint_divider`）与右窗沿都会丢
    //（用户 2026-10-07 实拍「细分割线没了」）。这里按同一 token 补回，不另造常量。
    paint_win::fill_color(hdc, paint_win::Rect::new(0, 0, 1, full.h), t.outline);
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(full.w - 1, 0, 1, full.h),
        t.outline,
    );
    for frame in &state.card_frames {
        let rect = paint_win::Rect::new(
            frame.rect.left,
            frame.rect.top - state.scroll_y,
            rect_w(&frame.rect),
            rect_h(&frame.rect),
        );
        if rect.is_empty() || rect.bottom() < 0 || rect.y > full.h {
            continue;
        }
        match frame.kind {
            CardKind::UserBubble => {
                paint_win::draw_elevation(hdc, rect, &t.bubble_user_shadow);
                // 泡底由画布填（泡内留白区不再被承载控件盖住，见 `create_rtf_control`
                // 的 inset）：与控件底同值，接缝不可见。
                let rounded = unsafe {
                    with_round_box(
                        hdc,
                        rect,
                        scaled_f(f64::from(t.radii.md), dpi_scale(state.canvas)),
                        t.bubble_user_edge,
                        || {
                    paint_win::fill_color(hdc, rect, flat_over_panel(&t.bubble_user_bg));
                    paint_win::draw_bevel(hdc, rect.deflate(1), &t.bubble_user_bevel);
                        },
                    )
                };
                if !rounded {
                    // 绘制期逐控件回落（保留方角描边）：静默——降噪 2026-10-08 用户裁定
                    // （稳态留痕会随重绘刷屏）；绘制端回落由实机像素取证覆盖。
                    paint_win::draw_frame(hdc, rect, t.bubble_user_edge, &t.bubble_user_bevel);
                }
            }
            CardKind::AssistantBubble => {
                // 轻气泡：无投影、无立体线（`Bevel::NONE`），只有底 + 描边。
                let rounded = unsafe {
                    with_round_box(
                        hdc,
                        rect,
                        scaled_f(f64::from(t.radii.md), dpi_scale(state.canvas)),
                        t.bubble_ai_edge,
                        || {
                    paint_win::fill_color(hdc, rect, flat_over_panel(&t.bubble_ai_bg));
                        },
                    )
                };
                if !rounded {
                    // 绘制期逐控件回落（保留方角描边）：静默——降噪 2026-10-08 用户裁定
                    // （稳态留痕会随重绘刷屏）；绘制端回落由实机像素取证覆盖。
                    paint_win::draw_frame(hdc, rect, t.bubble_ai_edge, &Bevel::NONE);
                }
            }
        }
    }
    // 「↓ 新消息」按钮（聊天窗的子窗，悬在画布之上）的接触影：它下方可见的表面
    // 就是这条画布，母通道按同一口径补（同 `paint_button_shadows` 的 why）。
    paint_button_shadows(hdc, state.canvas, &[state.jump]);
}

// ==========================================
// 浮层 Inspector：绘制与窗口过程（几何/派发的纯逻辑见下方「纯函数」段）
// ==========================================

/// 浮层窗口绘制：先整面遮罩、再（投影 + 圆角浮层盒）。
///
/// **未在 Windows 实机验证**（同模块头约定）。两处 GDI 近似就地注明：
/// - 遮罩是**实色**（子窗口之间没有 alpha 合成通路；颜色 = `--scrimc` 口径色
///   与面板底预合成，见 [`scrim_flat`]）；
/// - 盒的投影先按方角矩形画，再用遮罩色把盒矩形整个抹一遍、最后补圆角盒 ——
///   不然投影的方角会从圆角外侧的缺口露出来（盒外沿以方角矩形为界，与设计稿
///   「阴影只在盒外」一致；多一次实色填充，代价可忽略）。
unsafe fn paint_inspector_layer(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.inspector_layer, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    let scrim = scrim_flat(t);
    let scale = dpi_scale(state.hwnd);
    unsafe {
        // 1) 遮罩：整个消息流区域压一层实色。
        paint_win::fill_color(hdc, full, scrim);
        let panel_box = state.inspector_box;
        if panel_box.is_empty() {
            return;
        }
        // 2) 投影 + 抹掉盒矩形（先影后物；理由见函数注释）。
        paint_win::draw_elevation(hdc, panel_box, &t.panel_shadow);
        paint_win::fill_color(hdc, panel_box, scrim);
        // 3) 圆角盒（底 + 标题行 + 内立体线 + 沿轮廓的 1px 描边）。
        // 圆角取 `radii.md`（设计稿 `.insp{border-radius:var(--r2)}` 的「大件」档）。
        paint_inspector_box(
            hdc,
            panel_box,
            scaled_f(f64::from(t.radii.md), scale),
            scaled(INSPECTOR_HEADER_HEIGHT, scale),
        );
        // 浮层内自绘按钮的接触影：按钮自己的 DC 画不出窗口外（见
        // `paint_button_shadows`），由层窗这条父通道补。
        let mut targets: Vec<HWND> = vec![state.inspector_close];
        targets.extend(state.inspector_children.iter().map(|child| child.hwnd));
        paint_button_shadows(hdc, state.inspector_layer, &targets);
    }
}

/// 会话历史弹层绘制：与浮层同款（整面遮罩 + 圆角盒），只是盒**没有标题行**
/// （标题由面板内容自己给：「会话历史」是视图的第一行）且锚在层顶。
/// 手法与近似同 [`paint_inspector_layer`]（实色遮罩、方角投影先画后抹）。
unsafe fn paint_history_layer(state: &ChatWinState, hdc: HDC) {
    let t = theme::tokens();
    let mut client: RECT = std::mem::zeroed();
    unsafe { GetClientRect(state.history_layer, &mut client) };
    let full = paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client));
    if full.is_empty() {
        return;
    }
    let scrim = scrim_flat(t);
    let scale = dpi_scale(state.hwnd);
    unsafe {
        paint_win::fill_color(hdc, full, scrim);
        let panel_box = state.history_box;
        if panel_box.is_empty() {
            return;
        }
        paint_win::draw_elevation(hdc, panel_box, &t.panel_shadow);
        paint_win::fill_color(hdc, panel_box, scrim);
        // header_h = 0：不画标题行（内容自带标题行）。
        paint_inspector_box(hdc, panel_box, scaled_f(f64::from(t.radii.md), scale), 0);
        // 弹层内自绘按钮的接触影（父通道；同 `paint_inspector_layer`）。
        let targets: Vec<HWND> = state
            .history_children
            .iter()
            .map(|child| child.hwnd)
            .collect();
        paint_button_shadows(hdc, state.history_layer, &targets);
    }
}

/// 圆角浮层盒：GDI 没有圆角填充原语，用 `CreateRoundRectRgn` + `SelectClipRgn`
/// 裁剪后走既有 `paint_win` 原语（渐变/alpha 通路不变），描边走 `FrameRgn`
/// （区域轮廓自带四角圆弧段）——与 ownerdraw 按钮的 `SetWindowRgn` 同属「区域裁剪」
/// 这一族，不引入新依赖。区域建失败退化为方角绘制（留痕不静默）。
///
/// **实机核验点**（本机无 Windows 工具链）：`AlphaBlend`/`GradientFill` 是否遵守
/// DC 的圆角裁剪区 —— GDI 绘制原语统一受裁剪约束，预期成立；若不成立，症状是
/// 盒底/标题行在四角溢出一圈方角。**不赌裁剪行为**：绘制后由
/// [`corner_notch_over_scrim`] 把「方角内、圆弧外」的缺口刷回遮罩色。
///
/// 与 macOS 的对照（就地注明）：macOS 实机见过的「浮层左上角灰色矩形」根因是
/// 绘制子层按贴皮当时的 bounds 建、之后只改 frame 不重贴；Windows 是立即模式
/// 逐帧重画（每次 WM_PAINT 按当前盒几何重铺遮罩 + 盒），没有可残留的子层 ——
/// 同形不同源，这里的净化只针对上面那条裁剪核验点。
pub(super) unsafe fn paint_inspector_box(hdc: HDC, panel_box: paint_win::Rect, radius: i32, header_h: i32) {
    let t = theme::tokens();
    if panel_box.is_empty() {
        return;
    }
    let ok = unsafe {
        with_round_box(hdc, panel_box, radius, t.outline, || {
            // 盒底（`--pbg`，Fill 的渐变/条纹通路与面板其余部分一致）。
            paint_win::fill_rect(hdc, panel_box, &t.panel_bg);
            // 标题行（设计稿 `.insph`：`--bar` 底 + `--bare` 底线 + `--barsh` 内立体线）。
            let head_h = header_h.clamp(0, panel_box.h);
            if head_h > 0 {
                let head = paint_win::Rect::new(panel_box.x, panel_box.y, panel_box.w, head_h);
                paint_win::fill_rect(hdc, head, &t.bar_bg);
                paint_win::draw_bevel(hdc, head, &t.bar_bevel);
                paint_win::fill_color(
                    hdc,
                    paint_win::Rect::new(head.x, head.bottom() - 1, head.w, 1),
                    t.bar_edge,
                );
            }
            // 盒内立体线（`--pshadow` 的 inset 段，与面板同一份 `panel_bevel`）。
            paint_win::draw_bevel(hdc, panel_box.deflate(1), &t.panel_bevel);
        })
    };
    if !ok {
        // 绘制期逐帧回落（退化为方角绘制）：静默——降噪 2026-10-08 用户裁定
        // （稳态留痕会随每次重绘刷屏）；绘制端回落由实机像素取证覆盖。
        unsafe { paint_win::draw_frame(hdc, panel_box, t.outline, &Bevel::NONE) };
        return;
    }
    // 四角净化（见函数注释）：圆弧外侧露出的方角缺口统一刷回遮罩色。
    unsafe { corner_notch_over_scrim(hdc, panel_box, radius) };
}

/// 圆角盒的「四角净化」：把**方角矩形内、圆角区域外**的四个缺口重刷成遮罩色。
///
/// 为什么需要：盒体绘制里含**渐变填充**（标题行 `bar_bg`）与 **alpha 立体线**，
/// 它们是否严格遵守 `SelectClipRgn` 的圆角裁剪是本文件登记的实机核验点（本机无
/// Windows 工具链）；圆弧外侧的缺口本来应是「盒外的遮罩色」（方角抹除步骤留下的），
/// 但若上述原语不受裁剪，方角就会从圆弧外侧露出来（用户报告「弹层左上角矩形
/// 残影」的形态）。这里不赌行为：按「方角 − 圆角」的差集把缺口再刷一遍 ——
/// 与盒外同色，圆弧外侧无论裁剪是否生效都只会是遮罩色。
///
/// 区域建不出去/差集失败（极罕见，内存压力）时跳过本帧、保持绘制顺序原样：
/// 这是纯加固步骤，不吞内容也不改盒体本身的绘制；逐帧绘制路径不刷 warn 级，
/// 留痕走统一的 `rust_debug!`（同族的盒体绘制 `with_round_box` 的建失败回落
/// 自 2026-10-08 起也已静默降噪，见那里的注释）。
pub(super) unsafe fn corner_notch_over_scrim(hdc: HDC, rect: paint_win::Rect, radius: i32) {
    unsafe {
        // 区域边界与 `with_round_box` 同口径（右/下各 +1：GDI 区域不含右/下边界，
        // 两形取差集得到的正是四个角缺口）。
        let square = CreateRectRgn(rect.x, rect.y, rect.right() + 1, rect.bottom() + 1);
        let round = CreateRoundRectRgn(
            rect.x,
            rect.y,
            rect.right() + 1,
            rect.bottom() + 1,
            (radius * 2).max(1),
            (radius * 2).max(1),
        );
        // 差集的目标区域先给一个占位（CombineRgn 会整体替换它）。
        let notch = CreateRectRgn(0, 0, 1, 1);
        if square == 0 || round == 0 || notch == 0 {
            rust_debug!("浮层四角净化区域创建失败，本帧跳过（框体保持既有裁剪行为）");
        } else if CombineRgn(notch, square, round, RGN_DIFF) != 0 {
            // 非 0 = 有效结果（NULLREGION / SIMPLEREGION / COMPLEXREGION 都可用；
            // 0 = ERROR，此时区域未更新，不刷）。
            FillRgn(
                hdc,
                notch,
                paint_win::solid_brush(scrim_flat(theme::tokens())),
            );
        } else {
            rust_debug!("浮层四角净化差集失败（CombineRgn = ERROR），本帧跳过");
        }
        for region in [square, round, notch] {
            if region != 0 {
                DeleteObject(region);
            }
        }
    }
}

/// 圆角盒的两段式绘制（GDI 没有圆角填充原语）：`CreateRoundRectRgn` + `SelectClipRgn`
/// 后在裁剪内执行 `draw_inside`（既有 `paint_win` 填充原语，渐变/alpha 通路不变）；
/// 撤裁剪后用 `FrameRgn` 沿区域轮廓描 1px `edge`（四角圆弧段由区域自带）。
///
/// 返回是否成功建区；区域创建失败（极罕见）时 `draw_inside` 照常执行（方角绘制，
/// 不静默丢内容），由调用方补方角描边。
/// **实机核验点**（本机无 Windows 工具链）：`AlphaBlend`/`GradientFill` 是否遵守
/// DC 的圆角裁剪区 —— GDI 绘制原语统一受裁剪约束，预期成立；若不成立，症状是
/// 内容在四角溢出一圈方角（兜底：改 `FillRgn` + 实色的平铺口径）。
pub(super) unsafe fn with_round_box(
    hdc: HDC,
    rect: paint_win::Rect,
    radius: i32,
    edge: crate::ui::theme::Rgba,
    draw_inside: impl FnOnce(),
) -> bool {
    if rect.is_empty() {
        return false;
    }
    let region = unsafe {
        CreateRoundRectRgn(
            rect.x,
            rect.y,
            rect.right() + 1,
            rect.bottom() + 1,
            (radius * 2).max(1),
            (radius * 2).max(1),
        )
    };
    if region != 0 {
        unsafe { SelectClipRgn(hdc, region) };
    }
    draw_inside();
    if region != 0 {
        // 撤裁剪再补轮廓描边；随后释放区域（此时已不参与任何绘制，可安全删除）。
        unsafe {
            SelectClipRgn(hdc, 0);
            let brush = paint_win::solid_brush(edge);
            FrameRgn(hdc, region, brush, 1, 1);
            DeleteObject(region);
        }
        true
    } else {
        false
    }
}

/// 输入框槽的圆角绘制（底 + 描边 + 内立体线；设计稿 `.inp .ph` 的 `--r1`）。
/// 圆角手法同 [`with_round_box`]；**未在 Windows 实机验证**（同模块头约定）。
unsafe fn paint_round_input_field(hdc: HDC, rect: paint_win::Rect, radius: i32) {
    let t = theme::tokens();
    let ok = unsafe {
        with_round_box(hdc, rect, radius, t.field_edge, || {
            paint_win::fill_rect(hdc, rect, &t.field_bg);
            paint_win::draw_bevel(hdc, rect.deflate(1), &t.field_bevel);
        })
    };
    if !ok {
        unsafe { paint_win::draw_frame(hdc, rect, t.field_edge, &t.field_bevel) };
    }
}

/// 给承载控件贴圆角窗口区域（`SetWindowRgn`；半径物理像素，0/失败不动）。
///
/// 与 `paint_win::install_button` 的区域装配同一份所有权约定（成功时区域归系统、
/// 失败时自释放）；那边服务 ownerdraw 按钮、这里服务输入区与只读正文，不复制
/// 其整段子类装配。尺寸没变的重复调用是幂等的，但会触发一次重绘 —— 调用点只在
/// 几何/主题变化时进（见 `layout_panes_for` 的 `strips_changed` 分支与 `apply_theme`）。
unsafe fn set_round_region(hwnd: HWND, radius_px: i32) {
    unsafe {
        if hwnd == 0 || radius_px <= 0 {
            return;
        }
        // 用**窗口矩形**而不是客户区：区域坐标是窗口坐标系，输入框带
        // `WS_EX_CLIENTEDGE`（客户区比窗口小 2px×2），按客户区尺寸会裁掉右/下边。
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        if w <= 0 || h <= 0 {
            return;
        }
        let r = radius_px.min(w / 2).min(h / 2).max(1);
        let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, r * 2, r * 2);
        if region == 0 {
            return;
        }
        if SetWindowRgn(hwnd, region, 1) == 0 {
            DeleteObject(region);
        }
    }
}

/// 输入框与占位标签的圆角区域（`radii.sm`）——与 `paint_round_input_field` 的圆角
/// 同半径；不贴区域时 RichEdit 的直角会盖住父窗口画的圆弧描边。
///
/// 推翻旧口径的依据（就地注明）：`paint_win` 模块头曾说「RichEdit 承载件不做圆角」
/// （区域裁剪怕与滚动条/IME 候选窗互相干扰）；2026-10-05 用户规则要求输入区与设计稿
/// 一致、圆角一律取 radii —— 输入框是 40pt 单行槽，被裁掉的只有四角（滚动条在右缘，
/// 角落裁掉的是它自己的底，无交互面损失）；IME 候选窗是独立弹出窗，不受控件区域
/// 裁剪。**实机核验点**：输入框右缘滚动条四角、以及光标贴角时的观感。
pub(super) unsafe fn apply_input_round_regions(state: &ChatWinState, scale: f64) {
    let radius = scaled((theme::tokens().radii.sm.round() as i32).max(1), scale).max(1);
    unsafe {
        set_round_region(state.input, radius);
        // 占位标签盖在输入框上；不裁它的直角会从圆角外补出一小块方角底。
        set_round_region(state.input_placeholder, radius);
    }
}

/// 悬浮层窗口过程（浮层 Inspector 与会话历史弹层**共用** `LAYER_CLASS`，
/// 按窗口句柄分派到各自的绘制与关闭路径）：
/// 遮罩点击（盒外）关闭 + 承载控件的通知转发回聊天窗。
///
/// 内容子控件（标题/✕/面板元素/历史条目）的父窗口是这里，`WM_COMMAND`/
/// `WM_DRAWITEM`/`WM_NOTIFY` 按既有消息路由转回 `chat_wndproc`（✕ 的 id 段与
/// 面板按钮的 `PANEL_BASE`/`PANEL_SELECT_BASE` 段都在那里统一分派）。
/// **未在 Windows 实机验证**（同模块头约定）。
pub(super) unsafe extern "system" fn overlay_layer_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底全部由 WM_PAINT 画（遮罩是整面实色）；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| {
                    if hwnd == state.history_layer {
                        paint_history_layer(state, hdc);
                    } else {
                        paint_inspector_layer(state, hdc);
                    }
                });
            }
            0
        }
        WM_APP_REPAINT => {
            repaint_deferred(hwnd);
            0
        }
        WM_NCDESTROY => {
            discard_deferred_paint(hwnd);
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        // 编辑类控件（可编辑框/下拉清单）的主题配色：`WM_CTLCOLOREDIT` /
        // `WM_CTLCOLORLISTBOX` 的消费者是**控件的父窗口**（组合框的展开清单也由
        // 承载它的父窗接，不随 `WM_COMMAND` 的转发链上走）—— 三处承载容器（流内 =
        // 聊天窗、浮层 = 滚动裁剪窗、历史 = 本层窗）各接各的，缺一处，对应容器里的
        // 下拉/输入框就回落系统经典外观。配色统一转给 `windows_settings` 的
        // `edit_ctlcolor`（唯一实现点，不在本文件另开第二份）；只接这两条消息，
        // 其余 CTLCOLOR 种类仍走默认处理。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            super::super::windows_settings::edit_ctlcolor(wparam, lparam)
        }
        WM_COMMAND => {
            unsafe { SendMessageW(GetParent(hwnd), WM_COMMAND, wparam, lparam) };
            0
        }
        WM_DRAWITEM => {
            unsafe { SendMessageW(GetParent(hwnd), WM_DRAWITEM, wparam, lparam) };
            0
        }
        WM_NOTIFY => {
            unsafe { SendMessageW(GetParent(hwnd), WM_NOTIFY, wparam, lparam) };
            0
        }
        // 点盒之外的遮罩区 = 收起（遮罩只罩消息流；哪一层收到点，就收哪一层）。
        WM_LBUTTONDOWN => {
            let x = i32::from((lparam & 0xFFFF) as u16 as i16);
            let y = i32::from(((lparam >> 16) & 0xFFFF) as u16 as i16);
            // (是不是历史层, 是否点在盒外) 一次借用取齐；窗口不在时按不关处理。
            let (history, closes) = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| {
                        if hwnd == state.history_layer {
                            (true, !rect_contains(state.history_box, x, y))
                        } else {
                            (false, !rect_contains(state.inspector_box, x, y))
                        }
                    })
                    .unwrap_or((false, false))
            });
            if closes {
                unsafe {
                    if history {
                        close_history_ui();
                    } else {
                        close_inspector_ui();
                    }
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 把手上拉箭头点击：把翻转交给模型（语义在 `ChatModel::toggle_inspector` 一处），
/// 再按**动作后的新快照**整帧重建 —— 平台层不翻转任何本地状态
/// （`ChatSnapshot::inspector_open` 就是开合的唯一输入，见字段注释）。
/// 模型随后排的刷新因版本号未变会被丢弃，这里的立即重建才是当帧生效点。
///
/// 入口只有一个：整条把手带的 `WM_LBUTTONDOWN`（箭头是同一块面上的绘制，
/// 不再有子按钮 —— 两个入口曾在同一次点击里开完又关，见 `build_children` 注释）。
pub(super) unsafe fn toggle_inspector_ui() {
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::ToggleInspector) {
        // 纯显示动作在共享层提前返回、正常到不了这里；失败如实留痕（不重建，
        // 界面保持与模型一致）。
        rust_warn!("浮层开合动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 收起浮层（✕ / 点遮罩；同入口再点走 [`toggle_inspector_ui`]）。
pub(super) unsafe fn close_inspector_ui() {
    let open = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|state| state.inspector_open)
            .unwrap_or(false)
    });
    if !open {
        return; // 已经收着：空操作（与共享层 `close_inspector` 同义）
    }
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseInspector) {
        rust_warn!("浮层收起动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 收起会话历史弹层（点盒外；「历史」按钮再点由既有 `ToggleSessionHistory` 收起，
/// 面板里的「关闭」按钮发 `CloseSessionHistory`）。
unsafe fn close_history_ui() {
    let open = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|state| state.history_height > 0)
            .unwrap_or(false)
    });
    if !open {
        return; // 已经收着：空操作
    }
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseSessionHistory) {
        rust_warn!("会话历史收起动作未送达共享层: {error}");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 散文段是否有可渲染的文本（只有空段落的段不成泡 —— 例如含代码块 part 的
/// 尾随换行解析出的空行；空泡会画出一个只有空行的空白气泡框。macOS 的尾随
/// 空行并进同一条气泡，Windows 的代码块是独立控件，这类尾随空段落单独成段，
/// 就地注明这一平台差异）。
pub(super) fn segment_has_text(blocks: &[Block]) -> bool {
    blocks.iter().any(|block| match block {
        Block::Paragraph(spans) | Block::ListItem { spans, .. } | Block::Quote(spans) => {
            spans.iter().any(|span| !span.text.is_empty())
        }
        Block::Table { rows } => rows.iter().any(|row| !row.cells.is_empty()),
        Block::CodeBlock { .. } => true,
    })
}

/// 散文段自然宽粗估（逻辑单位，逐行取最大）。
///
/// Windows 侧没有 macOS `prose_used_width`（TextKit 排版量测）的等价通路 ——
/// RichEdit 没有「已排版内容宽度」的直接查询。这里用共享口径
/// [`estimated_text_width`]（CJK 1.0×字号、其余 0.6×字号）逐行估算后取最大；
/// 量测手段不同，结果只用于「贴合内容」的泡宽，不参与视觉断言。
pub(super) fn prose_estimated_width(blocks: &[Block], base_size: f64) -> f64 {
    let mut widest = 0.0_f64;
    for block in blocks {
        let line = match block {
            Block::Paragraph(spans) => spans_text(spans),
            Block::ListItem {
                ordered,
                number,
                depth,
                spans,
            } => {
                let marker = if *ordered {
                    format!("{number}. ")
                } else {
                    "• ".to_string()
                };
                let indent = "  ".repeat(usize::from(*depth));
                format!("{indent}{marker}{}", spans_text(spans))
            }
            Block::Quote(spans) => format!("> {}", spans_text(spans)),
            Block::Table { rows } => {
                for row in rows {
                    let cells: Vec<String> =
                        row.cells.iter().map(|cell| spans_text(cell)).collect();
                    widest = widest.max(estimated_text_width(&cells.join(" | "), base_size));
                }
                continue;
            }
            // 代码块不进散文量测（含代码块时泡宽直接取上限，见 `bubble_content_width`）。
            Block::CodeBlock { .. } => continue,
        };
        widest = widest.max(estimated_text_width(&line, base_size));
    }
    widest
}

/// 跨度文本拼接（估宽用；不解析格式，粗估足够）。
fn spans_text(spans: &[Span]) -> String {
    let mut text = String::new();
    for span in spans {
        text.push_str(&span.text);
    }
    text
}

/// 纯文本的自然宽粗估（逻辑单位，逐行取最大）——流式尾巴等未分块的文本用。
pub(super) fn estimated_natural_width(text: &str, base_size: f64) -> f64 {
    text.split('\n')
        .map(|line| estimated_text_width(line, base_size))
        .fold(0.0_f64, f64::max)
}

/// 创建画布子控件并登记（返回句柄；同时写入 children 表）。
#[allow(clippy::too_many_arguments)]
pub(super) unsafe fn create_child(
    state: &mut ChatWinState,
    class: &str,
    title: &str,
    control_id: i32,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(title).as_ptr(),
            style,
            x,
            y,
            width,
            height,
            state.canvas,
            control_id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        if hwnd != 0 {
            state.children.push(ChildEntry {
                hwnd,
                x,
                y,
                w: width,
                h: height,
            });
        }
        hwnd
    }
}

pub(super) fn send_font(state: &ChatWinState, hwnd: HWND, font_index: usize) {
    if hwnd == 0 {
        return;
    }
    if let Some(font) = state.fonts.get(font_index) {
        unsafe {
            SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
        }
    }
}

/// 一个散文段（RTF）控件。
///
/// 它计入外框（气泡）高度：有外框时返回「控件高 + 上下内缩」作为气泡高，
/// 没有外框（系统/失败条目）时就是控件自身的高度。
///
/// `remember` = 该条消息的「记住这条」事件身份（仅用户消息有）：有值时给控件挂
/// [`message_menu_subclass_proc`] 并登记右键菜单目标表；无值（助手/系统/流式
/// 尾巴）不挂 —— 右键照走 RichEdit 自带菜单。
#[allow(clippy::too_many_arguments)]
pub(super) unsafe fn create_rtf_control(
    state: &mut ChatWinState,
    rtf: &str,
    x: i32,
    y: i32,
    width: i32,
    background: u32,
    card: Option<CardKind>,
    remember: Option<&str>,
    scale: f64,
    code: bool,
) -> (HWND, i32) {
    unsafe {
        // 卡片（用户/助手气泡）：承载控件内缩，外圈留给画布的 `draw_frame`
        // （1px 描边 + 1px 内侧立体线；RichEdit 不能透明，只能让出边界）。
        // 气泡再让出 `BUBBLE_PAD_X/PAD_Y`（与 macOS 同源的泡内边距）—— 留白区由
        // 画布的气泡填充遮住（与控件底同色），不再露出面板底。
        let (inset_x, inset_y) = match card {
            // 纵向内缩 = 边框留白 2 + **平台补偿后的泡内边距**：mac 侧的
            // `BUBBLE_PAD_Y`（7）量的是**无行距余量的文本 extent**，而 Windows 的
            // RichEdit 行盒自带 ~4px 行距余量（13px DengXian 行距 18、墨迹 12）——
            // 直接复用 7 会让两行泡高到 62px（mac 46px，用户实拍「气泡太大」）。
            // 7 - 4 = 3 才能与 mac 的泡高对齐（36 + 2×(2+3) = 46）。
            Some(CardKind::UserBubble) | Some(CardKind::AssistantBubble) => (
                scaled_f(2.0 + BUBBLE_PAD_X, scale),
                scaled_f(2.0 + BUBBLE_PAD_Y - 4.0, scale),
            ),
            None => (0, 0),
        };
        let inner_w = (width - inset_x * 2).max(scaled(20, scale));
        let mut style = WS_CHILD | WS_VISIBLE | ES_MULTILINE as u32 | ES_READONLY as u32;
        if code {
            style |= WS_HSCROLL | WS_VSCROLL | ES_AUTOHSCROLL as u32 | ES_AUTOVSCROLL as u32;
        }
        let control = create_child(
            state,
            "RICHEDIT50W",
            "",
            0,
            style,
            x + inset_x,
            y + inset_y,
            inner_w,
            scaled(28, scale),
        );
        if control == 0 {
            return (0, scaled(28, scale));
        }
        if let Some(event_id) = remember {
            // 有事件身份的消息 RichEdit 挂右键子类（子类 id = 3，与输入区 1、
            // 命中穿透 2 同族；每个控件各自登记——同一消息的多个控件共用身份）。
            SetWindowSubclass(control, Some(message_menu_subclass_proc), 3, 0);
            state
                .message_menu_targets
                .insert(control, event_id.to_string());
        }
        send_font(state, control, if code { 3 } else { 0 });
        SendMessageW(control, EM_SETBKGNDCOLOR, 0, background as LPARAM);
        if code {
            // 关闭折行（RichEdit 官方做法：wParam=0、lParam=1），再装内容。
            SendMessageW(control, EM_SETTARGETDEVICE, 0, 1);
        }
        stream_rtf(control, rtf);
        let height = rich_edit_height(control, scale);
        if card.is_some() && !code {
            // 正文按完整高度落位后才贴圆角区域；没有内部滚动条，滚动/选择由
            // RichEdit 与外层 canvas 保持原生语义。输入框的 IME 路径不经过这里。
            MoveWindow(control, x + inset_x, y + inset_y, inner_w, height, 0);
            set_round_region(
                control,
                scaled_f(f64::from(theme::tokens().radii.md), scale),
            );
        }
        if let Some(entry) = state
            .children
            .iter_mut()
            .find(|entry| entry.hwnd == control)
        {
            entry.h = height;
        }
        if let Some(kind) = card {
            // 外框槽位 = 承载控件矩形外扩 inset（内容坐标，绘制按 scroll_y 偏移）。
            state.card_frames.push(CardFrame {
                rect: RECT {
                    left: x,
                    top: y,
                    right: x + width,
                    bottom: y + inset_y + height + inset_y,
                },
                kind,
            });
            return (control, height + inset_y * 2);
        }
        (control, height)
    }
}

/// 代码块控件（等宽、不折行、独立横向滚动）。
pub(super) unsafe fn create_code_control(
    state: &mut ChatWinState,
    lang: &Option<String>,
    lines: &[String],
    x: i32,
    y: i32,
    width: i32,
    remember: Option<&str>,
    scale: f64,
) -> (HWND, i32) {
    let mut text = String::new();
    if let Some(lang) = lang {
        text.push_str(&format!("[{lang}]\n"));
    }
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    let palette = rtf_palette();
    let rtf = format!(
        "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f1\\fmodern Consolas;}}}}{}\\pard\\f1\\fs{}\\cf{RTF_TOOL_INK} {}\\par}}",
        palette.table,
        RTF_BODY_HALF_POINTS,
        rtf_escape(&text)
    );
    let (control, measured) = unsafe {
        create_rtf_control(
            state,
            &rtf,
            x,
            y,
            width,
            rich_bg(&theme::tokens().field_bg),
            None,
            remember,
            scale,
            true,
        )
    };
    if control == 0 {
        return (0, measured);
    }
    // 高度按行数（不折行）并封顶；超出部分由控件自身纵向滚动（WS_VSCROLL 未开，
    // 超长代码块以横向滚动为主，纵向截断属已知未验证项）。
    let line_height = scaled(LINE_HEIGHT as i32, scale);
    let height = ((lines.len().max(1) as i32 + 1) * line_height + scaled(8, scale))
        .min(scaled(CODE_BLOCK_MAX_HEIGHT, scale));
    if let Some(entry) = state
        .children
        .iter_mut()
        .find(|entry| entry.hwnd == control)
    {
        entry.h = height;
    }
    (control, height)
}

/// RichEdit 高度：行数 × 行高 + 内边距（RichEdit 没有直接的“内容高度”查询，
/// 这是 Windows 端的近似口径；未实机验证，见模块头注释）。
///
/// **尾随换行的坑（2026-10-05，与 macOS 对齐）**：`EM_GETLINECOUNT` 把文本末尾
/// 的孤立段落标记算成一条空行（RichEdit 的已知行为；macOS 的
/// `usedRectForTextContainer` 同坑 —— TextKit 的「额外行片段」，修法见
/// `macos_chat::text_layout_extent`）。本端的口径是**生成端保证不额外追加**
/// （`prose_to_rtf_colored` 的块间 `\par` 连接、流式尾巴同款）：
/// 生成后的文本行数与 macOS 的「逐块一行」模型逐行对应（空段落 = 一条空行，
/// 尾随换行的空行与 macOS 一样算 k-1 条），因此这里用 `EM_GETLINECOUNT` 的
/// 原始计数即可，不需要“末行为空再减一”的绕法。**新增 RTF 生成点时不要让
/// 正文以追加的 `\par` 收尾**，否则气泡底部会多一条空行。
unsafe fn rich_edit_height(control: HWND, scale: f64) -> i32 {
    // 观测计数（dev A/B）：一次 RichEdit 行数查询 = 本平台的「强制文本排版」
    // （与 macOS `text_layout_extent` 的计数对称）。
    crate::ui::chat::stream_metrics::note_text_layout();
    let lines: i32 = unsafe { SendMessageW(control, EM_GETLINECOUNT, 0, 0) } as i32;
    let line_height = scaled(LINE_HEIGHT as i32, scale);
    // 余量从 8 收到 2：`EM_GETLINECOUNT × 行距` 已经覆盖了默认行距下的最后一行
    // （含降部），8px 的旧余量在气泡里表现为「文字下面空一大截」（用户实拍
    // 「气泡太大」）。2px 只兜住四舍五入误差。
    (lines.max(1) * line_height) + scaled(2, scale)
}

/// 流式尾巴（说话人标签 + 一个 RichEdit，末尾补竖线光标）。
///
/// 与助手条目同构：轻气泡（`BubbleTheme::for_message(Assistant)` 同语义），
/// 泡宽贴合内容（含末尾竖线光标一起量）；说话人无角色名时不摆空标签。
pub(super) unsafe fn build_tail_controls(
    state: &mut ChatWinState,
    text: &str,
    canvas_width: i32,
    y: i32,
    scale: f64,
) -> i32 {
    unsafe {
        let speaker = state.speaker.clone();
        let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
        let mut y = y;
        if let Some(label_text) = role_label_text(Role::Assistant, &speaker, false) {
            let label = create_child(
                state,
                "STATIC",
                &label_text,
                0,
                WS_CHILD | WS_VISIBLE,
                margin,
                y,
                canvas_width - scaled_f(BUBBLE_SIDE_MARGIN * 2.0, scale),
                scaled(LABEL_HEIGHT, scale),
            );
            send_font(state, label, 1);
            stamp_ink(label, theme::tokens().dim);
            y += scaled(LABEL_HEIGHT, scale) + 3;
        }
        let tail_text = format!("{text}▍");
        let cap = scaled_f(bubble_cap(f64::from(canvas_width) / scale), scale);
        let used = estimated_natural_width(&tail_text, RTF_BODY_LOGICAL_SIZE);
        // 尾巴同样是 AssistantBubble 卡片：补 RichEdit 边框让位的 2px（同 flush_prose）。
        let bubble_w = (scaled_f(
            bubble_content_width(used, false, 0.0, f64::from(cap) / scale),
            scale,
        ) + scaled(2, scale))
        .min(cap);
        let palette = rtf_palette();
        // 末行后不追加 `\par`（同 `prose_to_rtf_colored` 的口径：尾随段落标记
        // 会被 `EM_GETLINECOUNT` 多算一行）；尾巴文本自带的光标 `▍` 落在末行上。
        let rtf = format!(
            "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f0\\fnil\\fcharset134 {};}}}}{}\\pard\\f0\\fs{}\\cf{RTF_INK} {}}}",
            rtf_body_font_family(),
            palette.table,
            RTF_BODY_HALF_POINTS,
            rtf_escape(&tail_text)
        );
        let (control, height) = create_rtf_control(
            state,
            &rtf,
            margin,
            y,
            bubble_w,
            rich_bg(&theme::tokens().bubble_ai_bg),
            Some(CardKind::AssistantBubble),
            // 流式尾巴不是已提交的消息，没有事件身份：不挂右键菜单。
            None,
            scale,
            false,
        );
        state.tail = if control != 0 { Some(control) } else { None };
        y + height
    }
}

/// 增量更新流式尾巴（`StreamOnly`）：只重建尾巴区的控件。
pub(super) unsafe fn update_tail(state: &mut ChatWinState, text: Option<&str>) {
    unsafe {
        // 观测计数（dev A/B）：一次尾巴重建（与 macOS `update_tail` 对称）。
        crate::ui::chat::stream_metrics::note_tail_rebuild();
        let previous_content = state.content_height;
        let was_at_bottom =
            scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
        let base = state.base_height;
        // 尾巴区的旧控件（y ≥ base）先销毁；消息区控件保持不动。
        let mut kept: Vec<ChildEntry> = Vec::new();
        for child in state.children.drain(..) {
            if child.y >= base {
                DestroyWindow(child.hwnd);
            } else {
                kept.push(child);
            }
        }
        state.children = kept;
        state.tail = None;
        // 尾巴也是卡片（助手轻气泡）：旧帧随旧控件一起清掉（帧的 top 落在尾巴区）。
        state.card_frames.retain(|frame| frame.rect.top < base);

        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut client);
        let canvas_width = (client.right - client.left).max(scaled(200, scale));
        let y = match text {
            Some(text) if !text.trim().is_empty() => {
                build_tail_controls(state, text, canvas_width, base, scale)
            }
            _ => base,
        };
        state.content_height = y + scaled(8, scale);
        // 流式尾巴变长也算「有新内容」（用户上翻时视口外的生长同样值得一个入口）。
        if !was_at_bottom && state.content_height > previous_content {
            state.jump_unread = true;
        }
        if was_at_bottom {
            state.scroll_y = (state.content_height - state.viewport_height).max(0);
        }
        apply_scroll(state);
    }
}

/// 把手带状态行：**只显示中性系统回执 `notice`**（文案口径见 [`handle_status_label`]）；
/// 圆点、文字与箭头都画在聊天窗底面上（单面绘制），文案或圆点可见性变化时补一次
/// 把手带重绘。
pub(super) fn update_status(state: &mut ChatWinState, status: &StatusSnapshot) {
    let text = handle_status_label(status);
    let dot_was = handle_status_dot_visible(&state.handle_status_label);
    let dot_now = handle_status_dot_visible(&text);
    let text_changed = text != state.handle_status_label;
    unsafe {
        // 主按钮槽按运行态换内容（2026-10-05 用户规则「与 demo 一致」）：运行中
        // 显示「停止」、收起「发送」（同一槽位；运行中仍可经 Enter 发送）。
        ShowWindow(state.stop, if status.running { SW_SHOW } else { SW_HIDE });
        ShowWindow(state.send, if status.running { SW_HIDE } else { SW_SHOW });
        if (dot_was != dot_now || text_changed) && !rect_is_empty(&state.paint.handle) {
            InvalidateRect(state.hwnd, &state.paint.handle, 0);
        }
    }
    state.handle_status_label = text;
}

// ==========================================
// RTF 生成（受控块 → RTF；所有内容经转义，不执行任何宏）
// ==========================================

/// 受控块 → RTF（散文段）。返回 (rtf, 链接表[(显示文本, URL)])。
///
/// 固定表头：f0 = 微软雅黑 UI（正文）、f1 = Consolas（行内代码/代码块）；
/// 颜色表由 `rtf_palette` 按当前主题生成，索引见 `RTF_*` 常量。
/// `default_color` 是整段的默认前景色索引（段首显式下发，引用块收尾也回到它
/// 而不是重置为黑；块内显式颜色如链接 `\cf{RTF_ACCENT}` 不受影响）。
///
/// **块之间以 `\par` 连接，末块之后不再追加**（2026-10-05，与 macOS 的行数口径
/// 对齐）：`EM_GETLINECOUNT` 会把文本末尾的孤立段落标记算成一条空行（Windows
/// 上的已知行为；macOS 的 `usedRectForTextContainer` 同坑 —— 「额外行片段」，
/// 见 `macos_chat::text_layout_extent`）。旧实现每块都追加 `\par`，于是**每个
/// 气泡**的估算行数都比实际多一行（底部多一条空行）；连接式生成后控件文本的
/// 行数与 macOS 的「逐块一行」模型逐行对应（空段落 = 一条空行）。**新增生成
/// 点时不要让正文以 `\par` 收尾**，否则 `rich_edit_height` 会重新多算一行。
///
/// 正文行距**没有**写 `\sl`：RichEdit 会把 `\sl` 夹到「字体自然行高」以上
/// （2026-10-07 实机：`\sl260\slmult0`(13pt) 对 10pt 正文毫无效果，`\sl1200`
/// 立刻生效 ⇒ 小值被夹住）。要做成 mac 那样更紧的行距只能换字体族，
/// 见 `docs`/报告里的登记；这里保持默认口径。
pub(super) fn prose_to_rtf_colored(blocks: &[Block], default_color: u32) -> (String, Vec<(String, String)>) {
    let mut links = Vec::new();
    let mut chunks: Vec<String> = Vec::new();
    for block in blocks {
        let mut chunk = String::new();
        match block {
            Block::Paragraph(spans) => {
                chunk.push_str(&format!("\\pard\\f0\\fs{} ", RTF_BODY_HALF_POINTS));
                chunk.push_str(&format!("\\cf{default_color} "));
                push_spans_rtf(&mut chunk, spans, &mut links);
            }
            Block::ListItem {
                ordered,
                number,
                depth,
                spans,
            } => {
                let indent = 360 * (i32::from(*depth) + 1);
                let marker = if *ordered {
                    format!("{number}.")
                } else {
                    "·".to_string()
                };
                chunk.push_str(&format!("\\pard\\fi-360\\li{indent} "));
                chunk.push_str(&format!("\\cf{default_color} "));
                chunk.push_str(&rtf_escape(&marker));
                chunk.push_str("\\tab ");
                push_spans_rtf(&mut chunk, spans, &mut links);
            }
            Block::Quote(spans) => {
                chunk.push_str(&format!("\\pard\\li720\\ri360\\cf{RTF_DIM} "));
                push_spans_rtf(&mut chunk, spans, &mut links);
                chunk.push_str(&format!("\\cf{default_color}"));
            }
            Block::Table { rows } => {
                push_table_rtf(&mut chunk, rows, &mut links);
            }
            Block::CodeBlock { .. } => {}
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
    }
    let body = chunks.join("\\par ");
    let palette = rtf_palette();
    let rtf = format!(
        "{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f0\\fnil\\fcharset134 {};}}{{\\f1\\fmodern Consolas;}}}}{}{body}}}",
        rtf_body_font_family(),
        palette.table
    );
    (rtf, links)
}

fn push_spans_rtf(out: &mut String, spans: &[Span], links: &mut Vec<(String, String)>) {
    for span in spans {
        if span.code {
            // 行内代码：等宽 + 主题代码底纹（索引随颜色表定）。
            out.push_str(&format!("\\f1\\highlight{RTF_CODE_BG} "));
            out.push_str(&rtf_escape(&span.text));
            out.push_str("\\highlight0\\f0 ");
            continue;
        }
        if let Some(link) = &span.link {
            let url = link.replace('\\', "\\\\").replace('"', "\\\"");
            out.push_str(&format!(
                "{{\\field{{\\*\\fldinst{{HYPERLINK \"{url}\"}}}}{{\\fldrslt{{\\ul\\cf{RTF_ACCENT} {}}}}}}}",
                rtf_escape(&span.text)
            ));
            links.push((span.text.clone(), link.clone()));
            continue;
        }
        if span.bold {
            out.push_str("\\b ");
        }
        if span.italic {
            out.push_str("\\i ");
        }
        out.push_str(&rtf_escape(&span.text));
        if span.bold {
            out.push_str("\\b0 ");
        }
        if span.italic {
            out.push_str("\\i0 ");
        }
    }
}

fn push_table_rtf(out: &mut String, rows: &[TableRow], links: &mut Vec<(String, String)>) {
    let columns = rows.iter().map(|row| row.cells.len()).max().unwrap_or(0);
    if columns == 0 {
        return;
    }
    let column_width = 3000;
    for row in rows {
        out.push_str("\\trowd\\trgaph108\\trleft-108");
        for index in 0..columns {
            out.push_str(&format!("\\cellx{}", column_width * (index as i32 + 1)));
        }
        for column in 0..columns {
            let empty: Vec<Span> = Vec::new();
            let spans = row.cells.get(column).unwrap_or(&empty);
            out.push_str("\\intbl ");
            if row.header {
                out.push_str("\\b ");
            }
            push_spans_rtf(out, spans, links);
            if row.header {
                out.push_str("\\b0 ");
            }
            out.push_str("\\cell ");
        }
        out.push_str("\\row ");
    }
}

/// RTF 文本转义：控制字转义、换行成段、非 ASCII 走 `\uN?`（UTF-16 码元，带符号）。
pub(super) fn rtf_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for unit in text.encode_utf16() {
        match unit {
            0x5C => out.push_str("\\\\"),
            0x7B => out.push_str("\\{"),
            0x7D => out.push_str("\\}"),
            0x0A => out.push_str("\\par "),
            0x0D => {}
            0x09 => out.push_str("\\tab "),
            unit if (0x20..0x7F).contains(&unit) => out.push(unit as u8 as char),
            unit => out.push_str(&format!("\\u{}?", unit as i16 as i32)),
        }
    }
    out
}

pub(super) struct RtfStream<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) position: usize,
}

/// EM_STREAMIN 在 SendMessageW 返回前同步读完 cookie，局部缓冲与游标覆盖
/// 整个回调生命周期。这里不能回借 CHAT：调用者正在重建消息并持有其可变借用。
pub(super) unsafe fn stream_rtf(control: HWND, rtf: &str) {
    let mut source = RtfStream {
        bytes: rtf.as_bytes(),
        position: 0,
    };
    let mut stream = EDITSTREAM {
        dw_cookie: &mut source as *mut RtfStream<'_> as usize,
        dw_error: 0,
        callback: Some(rtf_stream_callback),
    };
    unsafe {
        SendMessageW(
            control,
            EM_STREAMIN,
            SF_RTF,
            &mut stream as *mut EDITSTREAM as LPARAM,
        );
    }
    let error = stream.dw_error;
    if error != 0 {
        rust_warn!("RichEdit RTF 装载返回错误码 {error}");
    }
}

pub(super) unsafe extern "system" fn rtf_stream_callback(
    cookie: usize,
    buffer: *mut u8,
    capacity: i32,
    written: *mut i32,
) -> u32 {
    if cookie == 0 || written.is_null() || capacity < 0 || (capacity > 0 && buffer.is_null()) {
        return 1;
    }
    let source = unsafe { &mut *(cookie as *mut RtfStream<'_>) };
    let remaining = source.bytes.len().saturating_sub(source.position);
    let count = remaining.min(capacity as usize);
    if count > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(source.bytes.as_ptr().add(source.position), buffer, count)
        };
        source.position += count;
    }
    unsafe { *written = count as i32 };
    0
}
