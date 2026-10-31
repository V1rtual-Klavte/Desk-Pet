//! 布局：底部条区几何、控制区摆放与 `layout_panes_for` 全窗布局。

use super::*;
use super::input::read_window_text;
use super::paint::{
    apply_input_round_regions, flat_over_panel, paint_canvas_shell, paint_shell, rect_eq, rect_h,
    rect_w, rich_bg, with_round_box,
};
use super::panels::{layout_history_layer, layout_tabs};

// ==========================================
// 把手带与悬浮层的纯函数（几何 / 区间 / 文案；Win32 调用不在这段）
// ==========================================

/// 底部锚定的条区几何（物理像素；输入都已按 DPI 换算）。
///
/// **浮层的开合不在这份几何里**：浮层是消息流区域上的独立子窗口，条区链
/// （轨 → 输入行 → 待发送条 → 面板 → 画布）只由窗口尺寸与各条高度决定 ——
/// 这是验收硬指标「浮层开合前后消息流 y 不变」在结构上的保证（平台层不把
/// `inspector_open` 喂进这里；源码级守门测试钉住）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BottomStack {
    /// 输入行上缘（**贴客户区底**：2026-10-05 第二次改版后输入框是最底一条）。
    pub(super) input_y: i32,
    /// 把手带上缘（输入行正上方那个横条）。
    pub(super) handle_y: i32,
    /// 待发送条上缘（`pending_h == 0` 时 = 把手带上方一个间距，不画）。
    pub(super) pending_y: i32,
    /// 功能面板区下缘。
    pub(super) panel_bottom: i32,
    /// 功能面板区上缘。
    pub(super) panel_top: i32,
    /// 正文画布下缘。
    pub(super) canvas_bottom: i32,
}

pub(super) fn bottom_stack(
    height: i32,
    input_h: i32,
    handle_h: i32,
    pending_h: i32,
    panel_h: i32,
    gap: i32,
) -> BottomStack {
    // 自下而上：输入行（贴底）→ 把手带 → 待发送条 → 功能面板 → 正文。
    let input_y = height - input_h;
    let handle_y = input_y - handle_h;
    let pending_y = handle_y - gap - pending_h;
    let panel_bottom = if pending_h > 0 {
        pending_y - gap
    } else {
        pending_y
    };
    let panel_top = panel_bottom - panel_h;
    // 正文下沿与 mac `chat_bands` 的 `scroll_y` 逐档对齐：
    // - 有流内面板 → 面板上沿之上留一个 `PANE_GAP`；
    // - 有待发送条 → 直接贴条的上沿（条在 composer 面里，不另留缝）；
    // - 都没有 → **贴把手带上沿**（旧实现贴 `pending_y` = 把手带上方 8px，
    //   实机就是「上拉条上方那条灰线与 composer 之间空一截」，用户 2026-10-07 实拍）。
    let canvas_bottom = if panel_h > 0 {
        panel_top - gap
    } else if pending_h > 0 {
        pending_y
    } else {
        handle_y
    };
    BottomStack {
        input_y,
        handle_y,
        pending_y,
        panel_bottom,
        panel_top,
        canvas_bottom,
    }
}

/// 把条内自绘按钮的投影**画在父窗通道里**（按钮自己的 DC 画不出窗口矩形之外）。
///
/// mac 侧投影是 CALayer 的层外扩散（药丸「浮」在面上）；Windows 的子窗口只能把
/// 投影画进自己矩形内，外沿那圈被裁掉、内侧又贴着药丸边 —— 实机读成一条贴边硬环
/// （用户 2026-10-07 实拍）。父窗先画一遍同口径投影：落在按钮矩形**之外**的部分
/// 才是可见增量（矩形内会被按钮自己的面盖住），与 mac 的层外软晕同观感。
///
/// 每个按钮的角色/圆角都从它自己的登记取（`role_of` / `button_radius_of`），不落
/// 第二份角色表；投影先画、按钮后画（子窗永远在父窗之上），顺序天然正确。
pub(super) unsafe fn paint_button_shadows(hdc: HDC, owner: HWND, controls: &[HWND]) {
    let t = theme::tokens();
    for &control in controls {
        if control == 0 {
            continue;
        }
        // 隐藏的控件不画投影：隐藏窗口照样有矩形（`GetWindowRect` 有效），不判可见
        // 就会在它原来的位置上留一枚**没有按钮的灰药丸** —— 实机症状就是用户
        // 2026-10-07 实拍的「上拉条上面一个莫名其妙的灰色气泡」（画布给隐藏的
        // 「新消息」跳转按钮一直补接触影，按钮本身已 SW_HIDE）。
        if unsafe { IsWindowVisible(control) } == 0 {
            continue;
        }
        let role = paint_win::role_of(control);
        let face = paint_win::button_face(t, role, false, false);
        if face.shadow.contact.is_none() && face.shadow.ambient.is_none() {
            continue; // 无投影角色（TabOff/Link/Pending…）不画
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(control, &mut rect) } == 0 {
            continue;
        }
        let mut top_left = POINT {
            x: rect.left,
            y: rect.top,
        };
        unsafe { ScreenToClient(owner, &mut top_left) };
        let target = paint_win::Rect::new(
            top_left.x,
            top_left.y,
            rect.right - rect.left,
            rect.bottom - rect.top,
        );
        if target.is_empty() {
            continue;
        }
        let radius = paint_win::button_radius_of(control);
        // 单层接触影（见 `draw_contact_shadow` 的 why）：按钮的投影在 mac 是层外
        // 扩散，分层版在这里会四周压出硬环。
        if let Some(contact) = face.shadow.contact {
            unsafe { paint_win::draw_contact_shadow(hdc, target, radius, &contact) };
        }
    }
}

/// RTF `\fonttbl` 里的正文字体族（与控件字体同源）：RTF 文本的字体族由 fonttbl
/// 决定，`WM_SETFONT` 管不到它 —— 两处若各写一份族名，就会「控件换了族、正文还
/// 停在旧族」（行距/字形不一致）。
pub(super) fn rtf_body_font_family() -> String {
    let snapshot = crate::ui::font::snapshot();
    snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family)
}

/// `GetPixel` 取 DC 上一点的实色（COLORREF → `Rgba`）；越界/裁剪外返回 `None`。
unsafe fn sample_dc_color(hdc: HDC, x: i32, y: i32) -> Option<theme::Rgba> {
    let value = unsafe { GetPixel(hdc, x, y) };
    (value != u32::MAX).then(|| paint_win::rgba_from_colorref(value))
}

/// 采样条区实色并登记给条上的自绘按钮（圆角补角用「它们实际坐的面」）。
///
/// ownerdraw 按钮的圆角是**画出来的**（窗口区域 `SetWindowRgn` 实机不生效，见
/// `paint_win::apply_round_region`），四角那块 `矩形 − 圆角矩形` 由
/// `paint_win::draw_button` 补底色 —— 补错色就是四角深色方块（`panel_bg` 比条区
/// 实际色暗 ~35 灰阶，用户 2026-10-07 实拍「按钮黑色方角」）。条区刚画完时从同一
/// DC 取一点，拿到的就是最终可见色（含 sheen/颗粒/叠层），不另建色值定义点。
///
/// **逐控件按自己的中心采样**：条面带 sheen（横向渐变），整条共用一个探针点时
/// 远离探针的按钮会差 ~7 灰阶 —— 实机就是「药丸后面一块比条底亮的矩形」
/// （用户 2026-10-07 实拍「新会话」）。`fallback` 只在控件矩形取不到时用。
pub(super) unsafe fn register_band_surface(_hdc: HDC, owner: HWND, _fallback: (i32, i32), controls: &[HWND]) {
    // **不能用 `GetPixel` 采 DC**：WM_PAINT 期间 DC 被更新区裁剪，采样点落在
    // 更新区之外就返回 `CLR_INVALID` —— 实机日志显示每个按钮的采样都失败，表面色
    // 从未登记上，四角只能落回与条底差 ~35 灰阶的 `bg_base`（用户实拍「药丸后面
    // 一块矩形灰底」）。改成从 token 直接算：条底面 = `strip_bg` 叠在面板底渐变上，
    // 行位置取控件中心那一行。
    let tokens = theme::tokens();
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(owner, &mut client) };
    let height = f64::from((client.bottom - client.top).max(1));
    for &control in controls {
        if control == 0 {
            continue;
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        // 表面上下两行：按钮矩形顶/底边换算成面板渐变的 t，条色 `strip_bg` 叠在
        // 面板底之上 —— 补角按这段渐变铺，四角与条底逐像素同色。
        let (top_y, bottom_y) = if unsafe { GetWindowRect(control, &mut rect) } != 0 {
            let mut point = POINT {
                x: (rect.left + rect.right) / 2,
                y: rect.top,
            };
            unsafe { ScreenToClient(owner, &mut point) };
            let span = f64::from(rect.bottom - rect.top).max(1.0);
            (f64::from(point.y), f64::from(point.y) + span)
        } else {
            (0.0, height)
        };
        let sample = |y: f64| {
            let t = (y / height).clamp(0.0, 1.0);
            paint_win::composite_over(tokens.strip_bg, paint_win::fill_sample(&tokens.panel_bg, t))
        };
        paint_win::set_surface_rows(control, sample(top_y), sample(bottom_y));
    }
}

/// 输入行各列的摆放（纯函数，可测；物理像素，Win32 客户区坐标）。
///
/// 用户规则（2026-10-05）：「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
/// 图片/停止/发送按钮占固定宽，整行不压缩输入框到不可用」。按钮宽度只来自常量
/// （不随行宽变），输入框吃剩余并保底 [`INPUT_FIELD_MIN_WIDTH`] —— 旧口径把输入框
/// 下限压到 40、按钮又宽（60/80/52），窄聊天列（主窗聊天列最小 120pt）会把输入框
/// 压成一条缝（macOS 侧 265pt 实机同症，见 `macos_chat::input_row_columns`）。
///
/// 平台结构差异（就地注明）：macOS 是「发送 + 停止」两枚独立按钮（停止仅运行中出现），
/// Windows 是**单主按钮槽**（空闲 = 发送 / 运行中 = 停止，槽宽取两者较宽者，换态不挤动
/// 输入框）—— 因此这里没有 `stop_visible` 维度，其余口径与 macOS 同构。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct InputRowColumns {
    /// 输入框宽度（弹性；保底 `INPUT_FIELD_MIN_WIDTH`）。
    pub(super) field_width: i32,
    /// 主按钮槽左缘（发送/停止同槽）。
    pub(super) primary_x: i32,
    /// 「图片」按钮左缘（常驻）。
    pub(super) pick_x: i32,
}

pub(super) fn input_row_columns(width: i32, scale: f64) -> InputRowColumns {
    let right_margin = scaled(BOTTOM_RIGHT_MARGIN, scale);
    let slot_w = scaled(SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH), scale);
    let pick_w = scaled(PICK_BUTTON_WIDTH, scale);
    let gap = scaled(BOTTOM_BUTTON_GAP, scale);
    let button_margin = scaled(INPUT_BUTTON_MARGIN, scale);
    let side_margin = scaled(SIDE_MARGIN, scale);
    let min_field = scaled(INPUT_FIELD_MIN_WIDTH, scale);
    let primary_x = (width - right_margin - slot_w).max(0);
    let pick_x = (primary_x - gap - pick_w).max(0);
    // 输入框右缘 = 「图片」左缘再让出与按钮列的间距（旧 INPUT_BUTTON_RESERVE 同算式）。
    let field_width = (pick_x - button_margin - side_margin).max(min_field);
    InputRowColumns {
        field_width,
        primary_x,
        pick_x,
    }
}

/// 浮层盒几何（浮层窗口客户区坐标）：左右各留 `pad_x`、底边锚在层底上方 `pad_y`，
/// 高按内容（`wanted_h`）、上限是层高减上下留白。
pub(super) fn overlay_box_rect(
    layer_w: i32,
    layer_h: i32,
    wanted_h: i32,
    pad_x: i32,
    pad_y: i32,
) -> paint_win::Rect {
    let w = (layer_w - pad_x * 2).max(1);
    let max_h = (layer_h - pad_y * 2).max(1);
    let h = wanted_h.clamp(1, max_h);
    let y = (layer_h - pad_y - h).max(0);
    paint_win::Rect::new(pad_x, y, w, h)
}

/// 浮层内容滚动区（裁剪窗）的可视高（物理像素）：盒高扣掉标题行与底部内边距
/// （下限 1）。**唯一算式**：盒摆放、裁剪窗摆放、滚动条页大小与偏移钳制都读它，
/// 不各自重算（纯函数，可测）。
pub(super) fn inspector_body_view_height(panel_box: paint_win::Rect, scale: f64) -> i32 {
    (panel_box.h
        - scaled(INSPECTOR_HEADER_HEIGHT, scale)
        - scaled(INSPECTOR_BODY_PAD_BOTTOM, scale))
    .max(1)
}

/// 把手箭头的朝向：浮层收着 = 上拉（▴）、开着 = 可往下收（▾）。
/// 朝向表示「点一下会发生什么」（旧 meta 轨 chip 的翻面口径）；绘制端按它选三角的
/// 顶点方向（共享 `handle_arrow_label` 的字形口径，Windows 画几何、不依赖字体覆盖）。
pub(super) fn handle_arrow_up(inspector_open: bool) -> bool {
    !inspector_open
}

/// 把手带的状态文案：**只取中性系统回执 `notice`**（用户规则 2026-10-05：
/// **过程状态文案（阶段/工具）只在顶栏显示**，聊天窗底部不重复）。空通知 = 空串。
///
/// 旧实现的 `or_else(|| status.text.clone())` 兜底把过程文案也漏到把手带，
/// 已删除（纯函数 + 单测钉住；`update_status` 是唯一消费者）。
pub(super) fn handle_status_label(status: &StatusSnapshot) -> String {
    status.notice.clone().unwrap_or_default()
}

/// 圆点与文字同生共死（与 macOS `update_status` 的 `dot.setHidden(text.is_empty())`
/// 同口径）：没有真实文案时不亮一个看起来像「在线」的常亮点。
pub(super) fn handle_status_dot_visible(label: &str) -> bool {
    !label.is_empty()
}

/// 会话历史弹层的盒几何（弹层层窗客户区坐标）：**右缘对齐锚点**（「历史」按钮
/// 右缘）、顶边贴层顶下 `gap_y`；宽高按内容，**整体夹进窗口**（`anchor_right`
/// 太靠左/内容超高时裁到边界内，不滚出窗口）。
pub(super) fn history_popover_rect(
    layer_w: i32,
    layer_h: i32,
    anchor_right: i32,
    wanted_w: i32,
    wanted_h: i32,
    gap_y: i32,
) -> paint_win::Rect {
    let w = wanted_w.clamp(1, layer_w.max(1));
    let x = (anchor_right - w).clamp(0, (layer_w - w).max(0));
    let max_h = (layer_h - gap_y).max(1);
    let h = wanted_h.clamp(1, max_h);
    let y = gap_y.min((layer_h - h).max(0)).max(0);
    paint_win::Rect::new(x, y, w, h)
}

/// 点是否落在矩形内（`paint_win::Rect` 是右/下开区间）。
pub(super) fn rect_contains(rect: paint_win::Rect, x: i32, y: i32) -> bool {
    x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom()
}

/// 控件 -> （承载窗, 承载窗自己的绘制例程）：ownerdraw 按钮的「底」重放源。
///
/// 只认两种归属，其余窗口（浮层 / 历史弹层 / 文档弹窗）本轮不接、返回 `None`：
/// - 聊天窗自己的子控件（新会话 / 加号 / 历史 / 图片 / 发送 / 停止 / 待发送 chip）
///   走 `paint_shell`（聊天窗客户区坐标）；
/// - 悬在正文画布上的「新消息」跳转按钮与画布内 chip 走 `paint_canvas_shell`
///   （原点由 `control_rect_in_parent(control, state.canvas)` 换算，见调用点）。
///
/// `state.jump` 的父窗是聊天窗、底却是画布：归属按**控件语义**判定、不按父窗，
/// 否则会把画布上的内容重放成聊天窗的面（药丸四角会与其下消息内容对不上）。
fn button_backdrop_owner(
    state: &ChatWinState,
    control: HWND,
) -> Option<(HWND, unsafe fn(&ChatWinState, HDC))> {
    if control == 0 {
        return None;
    }
    let parent = unsafe { GetParent(control) };
    if control == state.jump || parent == state.canvas {
        return Some((state.canvas, paint_canvas_shell));
    }
    if parent == state.hwnd {
        return Some((state.hwnd, paint_shell));
    }
    None
}

/// 把控件矩形里的**真实底**（承载窗自己画的像素）贴到控件 DC 上。
///
/// 这是本轮「灰色矩形底」的唯一修法：ownerdraw 子控件是不透明表面，矩形里的一切
/// 都得控件自己画；旧口径用 `strip_bg` 合成 `panel_bg` 的近似值补底 / 补角，而真实
/// 条底还叠了 sheen / 颗粒 / 投影，实测差 20+ 灰阶（2026-10-07 实机：加号按钮四角
/// `(192,202,212)` vs 相邻条区 `(223,230,238)`）。重放走承载窗**自己的绘制例程**，
/// 四角与周围逐像素同色。
///
/// 失败（`CHAT` 重建持借期间、控件不属于这两个承载窗、位图建不出）返回 `false`：
/// 调用方按旧近似口径画完（该回落 2026-10-08 起静默降噪，见
/// `paint_win::blit_backdrop` 内注释），不静默变形。
pub(super) unsafe fn blit_button_backdrop(item: &DrawItemStruct, rect: paint_win::Rect) -> bool {
    let control = item.hwndItem;
    CHAT.with(|cell| {
        // 重建 / 布局持借期间不重入（仓库 UI 借用纪律：RefCell 不得重入）。
        let Ok(slot) = cell.try_borrow() else {
            return false;
        };
        let Some(state) = slot.as_ref() else {
            return false;
        };
        let Some((owner, painter)) = button_backdrop_owner(state, control) else {
            return false;
        };
        let Some(origin) = paint_win::control_rect_in_parent(control, owner) else {
            return false;
        };
        unsafe {
            paint_win::blit_backdrop(item.hDC, rect, (origin.x, origin.y), |hdc| {
                painter(state, hdc)
            })
        }
    })
}

/// ownerdraw 按钮统一绘制（聊天窗与画布共用；角色/悬浮从控件自身读）。
pub(super) unsafe fn draw_themed_button(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & ODS_SELECTED != 0;
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    let mut face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = unsafe { read_window_text(item.hwndItem) };
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    // 待发送 chip（有缩略图）：图前文后分区摆放（与 macOS 的 `ImageLeading` 同形）——
    // 底/边/按下态照常走 `draw_button`，标题由这里手工摆（缩略图占掉左侧一段）。
    let thumb = PENDING_THUMBS.with(|images| images.borrow().get(&item.hwndItem).cloned());
    if let Some(frame) = thumb {
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        unsafe {
            draw_pending_chip(
                item.hDC,
                item.hwndItem,
                rect,
                &face,
                &label,
                &frame,
                pressed,
                disabled,
                backdrop,
            )
        };
        return;
    }
    // 无缩略图的待发送 chip（缩略图未就绪 / 不可用）：底照常走 `draw_button`，文案也
    // 必须走 `draw_pending_label` —— 否则末尾的 ✕ 会被 `DT_END_ELLIPSIS` 吃掉。
    if role == ButtonRole::Pending {
        let scale = dpi_scale(item.hwndItem);
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        unsafe {
            paint_win::draw_button(
                item.hDC,
                item.hwndItem,
                rect,
                &face,
                "",
                pressed,
                disabled,
                backdrop,
            );
            draw_pending_label(
                item.hDC,
                rect,
                &face,
                &label,
                rect.x + scaled(PENDING_THUMB_INSET_X, scale),
                scale,
                pressed,
            );
        }
        return;
    }
    let backdrop = unsafe { blit_button_backdrop(item, rect) };
    unsafe {
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            &label,
            pressed,
            disabled,
            backdrop,
        )
    };
}

/// 待发送 chip 的文案绘制：共享 `pending_label` 的形态是「文件名（大小）✕」，
/// 而 chip 正文用 `DT_END_ELLIPSIS` —— 文件名一长，末尾的 ✕ 就被省略号一起吃掉
/// （2026-10-07 用户实拍「有了但是没有 ×」）。这里把 ✕ 摘出来固定贴右缘画，
/// 正文在左侧剩余宽度里省略：撤选提示永远可见，且宽度仍来自共享文案（不另拼一份）。
unsafe fn draw_pending_label(
    hdc: HDC,
    rect: paint_win::Rect,
    face: &paint_win::ButtonFace,
    label: &str,
    text_left: i32,
    scale: f64,
    pressed: bool,
) {
    let (title, close) = match label.rfind('✕') {
        Some(index) => (&label[..index], &label[index..]),
        None => (label, ""),
    };
    let inset = scaled(PENDING_THUMB_INSET_X, scale);
    let shift = i32::from(pressed);
    let mut right = rect.right() - inset;
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(face.ink));
    }
    if !close.is_empty() {
        // 量 ✕ 自身宽度（很短，本身不省略），给它留出固定位置。
        let mut measure = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let text = wide(close);
        unsafe {
            DrawTextW(
                hdc,
                text.as_ptr(),
                -1,
                &mut measure,
                DT_SINGLELINE | DT_NOPREFIX | DT_CALCRECT,
            )
        };
        let close_w = (measure.right - measure.left).max(1);
        let mut close_rect = RECT {
            left: right - close_w,
            top: rect.y + shift,
            right,
            bottom: rect.bottom() + shift,
        };
        unsafe {
            DrawTextW(
                hdc,
                text.as_ptr(),
                -1,
                &mut close_rect,
                DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_RIGHT,
            )
        };
        right -= close_w + scaled(2, scale);
    }
    if right <= text_left || title.is_empty() {
        return;
    }
    let mut title_rect = RECT {
        left: text_left,
        top: rect.y + shift,
        right,
        bottom: rect.bottom() + shift,
    };
    let text = wide(title);
    unsafe {
        DrawTextW(
            hdc,
            text.as_ptr(),
            -1,
            &mut title_rect,
            DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        )
    };
}

/// 带缩略图的待发送 chip：底/边照 `draw_button`（标题传空），缩略图贴左、文案摆在
/// 图右侧的剩余宽度里（单行、尾部省略）。整条仍是撤选命中区 —— 只有绘制方式不同。
///
/// 待发送 chip 恒可用（点击即撤选），不复制 `draw_button` 的禁用色推导；本函数也
/// 只由 `PENDING_THUMBS` 注册的待发送条目命中。
unsafe fn draw_pending_chip(
    hdc: HDC,
    hwnd: HWND,
    rect: paint_win::Rect,
    face: &paint_win::ButtonFace,
    label: &str,
    frame: &DecodedFrame,
    pressed: bool,
    disabled: bool,
    backdrop_painted: bool,
) {
    unsafe {
        paint_win::draw_button(
            hdc,
            hwnd,
            rect,
            face,
            "",
            pressed,
            disabled,
            backdrop_painted,
        );
        let scale = dpi_scale(hwnd);
        let (thumb_w, thumb_h) =
            crate::ui::chat::pending_strip::thumb_display_size(frame.width, frame.height);
        let image_w = scaled(thumb_w.max(1) as i32, scale).max(1);
        let image_h = scaled(thumb_h.max(1) as i32, scale).max(1);
        let image_x = rect.x + scaled(PENDING_THUMB_INSET_X, scale);
        let image_y = rect.y + (rect.h - image_h) / 2;
        // 与 `draw_inline_button` 同一 DIB 口径（自下而上用负高、RGBA 掩码按小端读）。
        let mut info = RgbaBitmapInfo {
            header: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: frame.width as i32,
                biHeight: -(frame.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_BITFIELDS_RGBA,
                biSizeImage: frame.rgba.len() as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            masks: [0x0000_00FF, 0x0000_FF00, 0x00FF_0000],
        };
        StretchDIBits(
            hdc,
            image_x,
            image_y,
            image_w,
            image_h,
            0,
            0,
            frame.width as i32,
            frame.height as i32,
            frame.rgba.as_ptr().cast(),
            (&mut info as *mut RgbaBitmapInfo).cast::<BITMAPINFO>(),
            DIB_RGB_COLORS,
            SRCCOPY,
        );
        // 文案：缩略图右侧到 chip 右缘之间（✕ 固定贴右缘，见 `draw_pending_label`）。
        draw_pending_label(
            hdc,
            rect,
            face,
            label,
            image_x + image_w + scaled(4, scale),
            scale,
            pressed,
        );
    }
}

/// 卡片底板（`PanelElement::Card` 的自绘 STATIC）绘制：`--fbg` 底 + `--bedge`
/// 细边 + `--r1` 圆角（小件半径，与 chip 同档）。
///
/// 底**不能**用 `panel_bg`（与弹层底同色就看不出边界了）：`field_bg` 是输入框 /
/// 待发 chip 一族的次级面，五套主题里都与面板底有明确极性差（暗主题凹一格、
/// 亮主题抬起一张白卡）。圆角手法与浮层盒同款（[`with_round_box`]：区域裁剪 +
/// `FrameRgn` 沿轮廓描边）；区域建失败时退化为方角并**留痕**（不静默丢内容）。
///
/// **未在 Windows 实机验证**（同模块头约定）：本机编不出 Windows 分支。实机核验点
/// 有三处 —— 自绘 STATIC 的 `WM_DRAWITEM`(ODT_STATIC) 通路、底板的 z 序
/// （`SetWindowPos(HWND_BOTTOM)` 是否确实垫在行/按钮之下）、`WS_CLIPSIBLINGS`
/// 下底板重绘不盖住上方兄弟。
pub(super) unsafe fn draw_themed_card(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    let scale = dpi_scale(item.hwndItem);
    let radius = scaled((tokens.radii.sm.round() as i32).max(1), scale).max(1);
    let ok = unsafe {
        with_round_box(item.hDC, rect, radius, tokens.btn_edge, || {
            paint_win::fill_rect(item.hDC, rect, &tokens.field_bg);
        })
    };
    if !ok {
        // 区域创建失败（极罕见）：底已在裁剪前照常画出，这里补方角描边。
        // 绘制期逐控件回落：静默——降噪 2026-10-08 用户裁定（稳态留痕会随重绘刷屏）；
        // 绘制端回落由实机像素取证覆盖。
        unsafe { paint_win::draw_frame(item.hDC, rect, tokens.btn_edge, &Bevel::NONE) };
    }
}

/// `WM_CTLCOLORSTATIC`：字色取控件上记录的主题色（未记录 → `ink`），底透明。
pub(super) unsafe fn ctlcolor_static(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    // 「坐在别的底上」的 STATIC 要返回所在表面的底色作背景刷（STATIC 会用它
    // 擦自己的客户区；返回面板底会补出一块异色板）：
    // - 输入区占位标签盖在 RichEdit 上 → 输入框的合成底色（`rich_bg(&field_bg)` 同值）；
    // - 浮层标题行**没有标题文字**（标题没有共享来源，不自己造；行内只有 ✕）→
    //   不需要额外分支：默认面板底画刷即盒底同色。
    // 把手带的状态文字不再是 STATIC：子窗口的不透明表面会把 composer 渐变挡成一块
    // 灰板（2026-10-07 实机），改由 `paint_shell` 单面绘制。
    let placeholder = CHAT.with(|cell| {
        cell.try_borrow()
            .ok()
            .and_then(|cell| cell.as_ref().map(|state| state.input_placeholder))
            .unwrap_or(0)
    });
    let color = paint_win::text_color_of(control).unwrap_or(tokens.ink);
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(color));
    }
    if control != 0 && control == placeholder {
        return paint_win::solid_brush(flat_over_panel(&tokens.field_bg)) as LRESULT;
    }
    paint_win::solid_brush(tokens.panel_bg.base_color()) as LRESULT
}

/// 输入框主题：底色 + 全文字色（`WM_SETFONT` 会重置默认字体格式，所以字体刷新后要重来一遍）。
pub(super) unsafe fn apply_input_theme(state: &ChatWinState) {
    if state.input == 0 {
        return;
    }
    let t = theme::tokens();
    unsafe {
        SendMessageW(
            state.input,
            EM_SETBKGNDCOLOR,
            0,
            rich_bg(&t.field_bg) as LPARAM,
        );
        // 只改颜色（CFM_COLOR）：不动高度/字面，字体仍由 WM_SETFONT 管。
        let mut format: CharFormatW = std::mem::zeroed();
        format.cbSize = std::mem::size_of::<CharFormatW>() as u32;
        format.dwMask = CFM_COLOR;
        format.crTextColor = paint_win::colorref(t.ink);
        SendMessageW(
            state.input,
            EM_SETCHARFORMAT,
            SCF_ALL,
            &mut format as *mut CharFormatW as LPARAM,
        );
    }
}

/// 主窗与底部面板的位置（窗口尺寸变化时调用）。
pub(super) fn layout_panes() {
    with_chat(|state| unsafe { layout_panes_for(state) });
}

/// 布局本体（apply_full 在已持有 state 的闭包里也调用）。
pub(super) unsafe fn layout_panes_for(state: &mut ChatWinState) {
    unsafe {
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let scale = dpi_scale(state.hwnd);
        let (width, height) = (client.right - client.left, client.bottom - client.top);
        if width <= 0 || height <= 0 {
            return;
        }
        // 状态文字槽 = 单行文字高（在把手带内垂直居中）。
        let status_h = scaled(LABEL_HEIGHT, scale);
        let input_h = scaled(INPUT_HEIGHT, scale);
        // 把手带高来自共享常量（两平台同值）。
        let handle_h = scaled_f(crate::ui::chat::panels::HANDLE_HEIGHT, scale);
        let gap = scaled(PANE_GAP, scale);
        let pending_h = state.pending_height.max(0);
        let panel_h = state
            .panel_height
            .min((f64::from(height) * PANEL_MAX_FRACTION) as i32)
            .max(0);
        // 布局是**底部锚定**（与 macOS `relayout_panes` 同序）：
        // 输入行（贴底）→ 把手带 → 待发送条 → 功能面板 → 正文。
        // 2026-10-05 第二次改版：底部那排 chip 撤掉，输入框往下贴住窗口底，
        // 输入框上方一行是**把手带**（左侧圆点 + 中性通知文字；中置上拉小箭头，
        // **整条带可点**开合浮层）。
        // **浮层 Inspector 不在这条链里**（它挂在消息流区域之上，开合不改任何
        // 条区的 y —— 验收硬指标「开合前后 log 的 y 不变」）；条区算术收口在
        // 纯函数 [`bottom_stack`]（可单测，见文件尾测试）。
        // 注意：Win32 子窗口坐标 y 自客户区**顶部**向下，因此这些位置由
        // `height - ...` 反推。
        let stack = bottom_stack(height, input_h, handle_h, pending_h, panel_h, gap);
        let (input_y, handle_y, pending_y) = (stack.input_y, stack.handle_y, stack.pending_y);
        let (panel_bottom, panel_top, canvas_bottom) =
            (stack.panel_bottom, stack.panel_top, stack.canvas_bottom);
        // 把手带的箭头**字形框**（共享 `handle_arrow_frame`：10×10、水平+垂直居中）：
        // 绘制端按它画三角；命中不在这里 —— 整条带都是开合区（`WM_LBUTTONDOWN`）。
        let arrow_glyph = {
            let glyph = handle_arrow_frame(f64::from(width) / scale);
            RECT {
                left: scaled_f(glyph.x, scale),
                top: handle_y + scaled_f(glyph.y, scale),
                right: scaled_f(glyph.x + glyph.width, scale),
                bottom: handle_y + scaled_f(glyph.y + glyph.height, scale),
            }
        };
        // A3：待发送条（有选择时）在输入行之上、功能面板区之下；无选择时高度为 0。
        // 2026-10-06 横向可滚：子控件 x 记的是**内容坐标**，这里按滚动偏移平移；
        // 越界偏移钳回（撤选/变窄后不留空白滚动区），新增条目滚到最右露出刚加的图。
        let max_scroll = (state.pending_content_w - width).max(0);
        state.pending_scroll_x = state.pending_scroll_x.clamp(0, max_scroll);
        if state.pending_reveal_end {
            state.pending_reveal_end = false;
            if let Some(last) = state.pending_children.last() {
                state.pending_scroll_x = crate::ui::chat::pending_strip::clamp_scroll(
                    crate::ui::chat::pending_strip::reveal_offset(
                        f64::from(last.x),
                        f64::from(last.w),
                        f64::from(width),
                    ),
                    f64::from(state.pending_content_w),
                    f64::from(width),
                )
                .round() as i32;
            }
        }
        for child in &state.pending_children {
            MoveWindow(
                child.hwnd,
                child.x - state.pending_scroll_x,
                pending_y + child.y,
                child.w,
                child.h,
                1,
            );
        }
        for child in &state.panel_children {
            MoveWindow(
                child.hwnd,
                child.x,
                panel_top + child.y,
                child.w,
                child.h,
                1,
            );
        }
        // A1：顶部 26px 顶栏带 + 标签条占顶部（仅面板模式；条高来自共享模块）。
        let nav_h_px = scaled_f(crate::ui::titlebar::HEIGHT, scale) + scaled(TABS_HEIGHT, scale);
        let canvas_top = if state.pane { nav_h_px } else { 0 };
        MoveWindow(
            state.canvas,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(40),
            1,
        );
        // 输入行各列（`input_row_columns` 是唯一摆放口径：按钮固定宽、输入框弹性
        // 吃剩余并保底 `INPUT_FIELD_MIN_WIDTH`）。输入框本体（设计稿 `.inp .ph` 的
        // 单行槽）：高 40、在输入区内垂直居中；承载控件再按 2px 内缩 —— 外圈留给
        // 聊天窗画的 field_edge + field_bevel（承载控件不能透出父窗口的绘制）。
        let cols = input_row_columns(width, scale);
        let input_inset = scaled(CARD_RING_INSET, scale);
        let field_h = scaled(INPUT_FIELD_HEIGHT, scale);
        let field_y = input_y + (input_h - field_h) / 2;
        let field_left = scaled(SIDE_MARGIN, scale);
        let field_w = cols.field_width;
        MoveWindow(
            state.input,
            field_left + input_inset,
            field_y + input_inset,
            (field_w - input_inset * 2).max(scaled(20, scale)),
            (field_h - input_inset * 2).max(scaled(16, scale)),
            1,
        );
        // 占位标签对齐输入文本的首行（自绘等价物，位置未实机校准：按控件内缩 +
        // `WS_EX_CLIENTEDGE` 的非客户边 + 首行文字起点近似；macOS 用
        // `textContainerInset(8,8)` 对齐）。
        if state.input_placeholder != 0 {
            MoveWindow(
                state.input_placeholder,
                field_left + input_inset + scaled(6, scale),
                field_y + input_inset + scaled(3, scale),
                (field_w - input_inset * 2 - scaled(13, scale)).max(scaled(20, scale)),
                scaled(18, scale),
                1,
            );
        }
        // 状态文字：把手带**左半侧**、圆点之后（点 + 文字，垂直居中）；可用宽来自
        // 共享 `handle_status_width(width)`（箭头居中后它只给左半侧：
        // `(宽 − 30)/2 − 4`，窄窗可能压到 0），再扣掉左侧点与间距；
        // 单行省略由绘制端的 `DT_END_ELLIPSIS` 承担。**单面绘制**：文字槽只记几何，
        // 没有 STATIC 子控件（它的不透明表面会把 composer 渐变挡成灰板）。
        let status_text_x = scaled(
            HANDLE_STATUS_PAD_X + HANDLE_STATUS_DOT_RADIUS * 2 + HANDLE_STATUS_TEXT_GAP,
            scale,
        );
        let status_text_w = scaled_f(handle_status_width(f64::from(width) / scale), scale)
            - scaled(HANDLE_STATUS_DOT_RADIUS * 2 + HANDLE_STATUS_TEXT_GAP, scale);
        let handle_status = RECT {
            left: status_text_x,
            top: handle_y + (handle_h - status_h).max(0) / 2,
            right: status_text_x + status_text_w.max(scaled(24, scale)),
            bottom: handle_y + (handle_h - status_h).max(0) / 2 + status_h,
        };
        // 输入行内右侧：「图片」+ 主按钮槽（设计稿 `.inp` 的「图片 + 主按钮」）。
        // 主按钮槽里空闲显示「发送」、运行中显示「停止」（`update_status` 切换），
        // 两者都比槽窄、在槽内水平居中；运行中仍可经 Enter 发送（插话/投递语义）。
        // 列位置全部来自 `input_row_columns`（唯一摆放口径，不再就地重算）。
        let input_btn_h = scaled(INPUT_BUTTON_HEIGHT, scale);
        let input_btn_y = input_y + (input_h - input_btn_h) / 2;
        let slot_w = scaled(SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH), scale);
        let send_w = scaled(SEND_BUTTON_WIDTH, scale);
        let stop_w = scaled(STOP_BUTTON_WIDTH, scale);
        MoveWindow(
            state.send,
            cols.primary_x + (slot_w - send_w) / 2,
            input_btn_y,
            send_w,
            input_btn_h,
            1,
        );
        MoveWindow(
            state.stop,
            cols.primary_x + (slot_w - stop_w) / 2,
            input_btn_y,
            stop_w,
            input_btn_h,
            1,
        );
        MoveWindow(
            state.pick_images,
            cols.pick_x,
            input_btn_y,
            scaled(PICK_BUTTON_WIDTH, scale),
            input_btn_h,
            1,
        );
        // 「↓ 新消息」浮在正文画布右下角（后建按钮在层级上方；可见性随滚动驱动）。
        let jump_w = scaled(JUMP_BUTTON_WIDTH, scale);
        let jump_h = scaled(JUMP_BUTTON_HEIGHT, scale);
        let jump_x = (width - scaled(JUMP_BUTTON_MARGIN, scale) - jump_w).max(0);
        let jump_y = (canvas_bottom - scaled(JUMP_BUTTON_MARGIN, scale) - jump_h).max(canvas_top);
        MoveWindow(state.jump, jump_x, jump_y, jump_w, jump_h, 1);
        // 浮层与会话历史弹层是**独立的各一步**：都只吃上面算好的画布矩形
        // （单向依赖：悬浮层跟随消息流，消息流不看悬浮层）。验收硬指标
        // 「开合前后 log 的 y 不变」由此在结构上成立 —— 本函数不得读取任何
        // 悬浮层状态字段（源码级守门测试按端口黑名单钉住）。
        unsafe { layout_inspector_layer(state, width, canvas_top, canvas_bottom, scale) };
        unsafe { layout_history_layer(state, width, canvas_top, canvas_bottom, scale) };
        if state.pane {
            layout_tabs(state, width, scale);
        }
        // 主题绘制区域（物理像素、客户区坐标；WM_PAINT 逐条读取，空矩形 = 不画）。
        let mut paint = ChatPaintRects::EMPTY;
        if state.pane {
            // 顶部 26px 带：本窗只在该矩形上画顶栏**外投影**（条底由全窗宽顶栏子窗口
            // 自己画）；标签条接在它下方。
            paint.bar = RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: scaled_f(crate::ui::titlebar::HEIGHT, scale),
            };
            paint.tabs = RECT {
                left: 0,
                top: paint.bar.bottom,
                right: width,
                bottom: nav_h_px,
            };
        }
        if panel_h > 0 {
            paint.panels = RECT {
                left: 0,
                top: panel_top,
                right: width,
                bottom: panel_bottom,
            };
        }
        if pending_h > 0 {
            paint.pending = RECT {
                left: 0,
                top: pending_y,
                right: width,
                bottom: pending_y + pending_h,
            };
        }
        // 把手带（输入行上方一行；**无底色、无分隔线**，只有状态点/文字与 ▴ ——
        // 与 macOS 模块头同口径；带区仍有独立命中区，开合浮层）。
        paint.handle = RECT {
            left: 0,
            top: handle_y,
            right: width,
            bottom: handle_y + handle_h,
        };
        paint.handle_status = handle_status;
        paint.handle_arrow = arrow_glyph;
        // 输入区底条（主题 `--ibg`）：**composer 的整块面**，上沿与 macOS
        // `composer_top_from_bands` 同源：**覆盖待发送条（若有）+ 把手带 + 输入行**
        // 一整块（`macos_chat.rs::relayout_panes` 的注释「composer 从消息流下沿一直
        // 铺到窗口底，一整块面」）。旧实现无条时从把手带**下沿**开始铺，带区落在
        // 面上之外 —— 实机就是「输入框上方多出一条灰带」（用户 2026-10-07 实拍）。
        let composer_top = if pending_h > 0 { pending_y } else { handle_y };
        paint.input_bar = RECT {
            left: 0,
            top: composer_top,
            right: width,
            bottom: height,
        };
        // 输入行按钮的「所在面」实色（`draw_button` 的圆角补角用）：按 composer
        // 渐变在**按钮行中心**取样 —— 用整块面的首档色会在按钮四角漏出一圈浅晕
        //（2026-10-07 实机：禁用「发送」四周一圈比 composer 浅的环）。
        let composer_h = (height - composer_top).max(1);
        let row_t = f64::from((input_y + input_h / 2 - composer_top).clamp(0, composer_h))
            / f64::from(composer_h);
        let row_surface = paint_win::fill_sample(&theme::tokens().input_bar_bg, row_t);
        for control in [state.stop, state.pick_images, state.send] {
            paint_win::set_surface_color(control, row_surface);
        }
        // 输入框槽位 = 上面 MoveWindow 的同一几何（单行槽、右侧让给三个按钮）。
        paint.input_field = RECT {
            left: field_left,
            top: field_y,
            right: field_left + field_w,
            bottom: field_y + field_h,
        };
        let strips_changed = !rect_eq(&state.paint.bar, &paint.bar)
            || !rect_eq(&state.paint.tabs, &paint.tabs)
            || !rect_eq(&state.paint.panels, &paint.panels)
            || !rect_eq(&state.paint.pending, &paint.pending)
            || !rect_eq(&state.paint.handle, &paint.handle)
            || !rect_eq(&state.paint.handle_status, &paint.handle_status)
            || !rect_eq(&state.paint.handle_arrow, &paint.handle_arrow)
            || !rect_eq(&state.paint.input_bar, &paint.input_bar)
            || !rect_eq(&state.paint.input_field, &paint.input_field);
        state.paint = paint;
        if strips_changed {
            // 条区几何变了才重绘窗口底（避免每次整帧都重画条纹/颗粒）。
            InvalidateRect(state.hwnd, std::ptr::null(), 0);
            // 承载控件的圆角区域不随重绘更新（输入框尺寸随窗口宽变），几何变了重贴一次。
            apply_input_round_regions(state, scale);
        }
        let mut canvas_client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut canvas_client);
        state.viewport_height = canvas_client.bottom - canvas_client.top;
    }
}

/// 浮层窗口与盒内控件的摆放（**单向依赖**：输入是上面算好的画布矩形 ——
/// 浮层跟随消息流，消息流不看浮层）。
///
/// - 层窗口盖住消息流区域（= 画布矩形）；隐藏时只收起来、几何照常同步；
/// - 弹出的那一刻抬到同级最上兜一层（面板子控件每次整帧重建会造新的兄弟窗口，
///   遮罩必须始终压在消息画布子树之上，见 `build_children` 的层级注释）；
/// - 浮层盒底边锚在层底边上方 `INSPECTOR_PAD`（设计稿 `.insp{bottom:9px}`），
///   左右各留同宽，高度按内容（[`overlay_box_rect`] 封顶）；
/// - 盒几何变化才重画层（内容子控件自己重绘；换入口但高度相同时只有标题文字变）。
pub(super) unsafe fn layout_inspector_layer(
    state: &mut ChatWinState,
    width: i32,
    canvas_top: i32,
    canvas_bottom: i32,
    scale: f64,
) {
    unsafe {
        if state.inspector_layer == 0 {
            return;
        }
        MoveWindow(
            state.inspector_layer,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(1),
            1,
        );
        let open = state.inspector_open;
        ShowWindow(state.inspector_layer, if open { SW_SHOW } else { SW_HIDE });
        if !open {
            state.inspector_box = paint_win::Rect::new(0, 0, 0, 0);
            return;
        }
        SetWindowPos(
            state.inspector_layer,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let layer_h = canvas_bottom - canvas_top;
        // 盒高按**可视区**高收口（内容全高只决定滚动范围，不再决定盒高；内容超可视
        // 高的部分由裁剪窗内部滚动到达）。
        let wanted_h = state.inspector_viewport_height
            + scaled(INSPECTOR_HEADER_HEIGHT, scale)
            + scaled(INSPECTOR_BODY_PAD_BOTTOM, scale);
        let pad = scaled(INSPECTOR_PAD, scale);
        let panel_box = overlay_box_rect(width, layer_h, wanted_h, pad, pad);
        // 盒内摆放：标题行（右侧 ✕）与内容滚动裁剪窗（子控件在裁剪窗里按滚动偏移摆）。
        let head_h = scaled(INSPECTOR_HEADER_HEIGHT, scale);
        let close_size = scaled(INSPECTOR_CLOSE_SIZE, scale);
        let close_inset = scaled(6, scale);
        MoveWindow(
            state.inspector_close,
            panel_box.x + panel_box.w - close_inset - close_size,
            panel_box.y + (head_h - close_size).max(0) / 2,
            close_size,
            close_size,
            1,
        );
        // 裁剪窗：盒内标题行之下、左右内缩让开盒描边与内立体线；可视高 = 盒内可用高
        // （盒被几何夹小——面板/待发送条挤占画布高度——时以盒为准，滚动范围随之收紧）。
        if state.inspector_scroll != 0 {
            let inset = scaled(INSPECTOR_SCROLL_INSET, scale);
            let view_h = inspector_body_view_height(panel_box, scale);
            MoveWindow(
                state.inspector_scroll,
                panel_box.x + inset,
                panel_box.y + head_h,
                (panel_box.w - inset * 2).max(1),
                view_h,
                1,
            );
            // 钳制偏移 + 子控件随偏移平移 + 滚动条信息（唯一落地）。
            apply_inspector_scroll(state, view_h);
        }
        if state.inspector_box != panel_box {
            state.inspector_box = panel_box;
            InvalidateRect(state.inspector_layer, std::ptr::null(), 0);
        }
    }
}

/// 浮层内容的滚动落地（**唯一实现点**：滚动指令与重排都走它）：钳制偏移、
/// 按偏移平移内容子控件（部分可见的由裁剪窗客户区自然裁剪，完全在外的藏起免得
/// 白画）、刷新滚动条信息（范围/页大小/位置；内容不超高时收起滚动条）。
///
/// 与画布滚动（`apply_scroll`）同族：子控件坐标记的是**内容坐标**，这里按偏移平移；
/// 裁剪窗自己的 `WM_PAINT` 只重铺盒底，被移空的区域随之复原。
pub(super) unsafe fn apply_inspector_scroll(state: &mut ChatWinState, view_h: i32) {
    unsafe {
        let max_scroll = (state.inspector_content_height - view_h).max(0);
        let scroll_y = state.inspector_scroll_y.clamp(0, max_scroll);
        state.inspector_scroll_y = scroll_y;
        for child in &state.inspector_children {
            // 与可视区相交即显示（部分可见交给裁剪窗的客户区裁剪；完全在外的
            // 藏起，不让它们白占重绘）。
            let visible = child.y + child.h > scroll_y && child.y < scroll_y + view_h;
            ShowWindow(child.hwnd, if visible { SW_SHOW } else { SW_HIDE });
            if visible {
                MoveWindow(child.hwnd, child.x, child.y - scroll_y, child.w, child.h, 1);
            }
        }
        let mut info: SCROLLINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMin = 0;
        info.nMax = state.inspector_content_height.max(1);
        info.nPage = view_h.max(1) as u32;
        info.nPos = scroll_y;
        SetScrollInfo(state.inspector_scroll, SB_VERT, &info, 1);
        ShowScrollBar(state.inspector_scroll, SB_VERT, i32::from(max_scroll > 0));
        // 子控件移走后的空档归裁剪窗自己重铺（盒底实色、`WS_CLIPCHILDREN` 把子控件
        // 排除在重绘区外，整块失效最省心且每帧重排重复作废的代价可忽略）。
        InvalidateRect(state.inspector_scroll, std::ptr::null(), 0);
    }
}

/// 浮层滚动条 / 滚轮的行滚动指令入口（`WM_VSCROLL` 到 [`inspector_scroll_command`]）。
/// 重排收口在 `layout_panes_for`（唯一摆放口径）—— 与待发送条的滚轮路径同款。
fn inspector_scroll_command(command: i32) {
    with_chat(|state| unsafe {
        let scale = dpi_scale(state.hwnd);
        let line = scaled(INSPECTOR_SCROLL_LINE, scale);
        let view_h = inspector_body_view_height(state.inspector_box, scale);
        let page = (view_h - line).max(line);
        match command {
            SB_LINEUP => state.inspector_scroll_y -= line,
            SB_LINEDOWN => state.inspector_scroll_y += line,
            SB_PAGEUP => state.inspector_scroll_y -= page,
            SB_PAGEDOWN => state.inspector_scroll_y += page,
            SB_TOP => state.inspector_scroll_y = 0,
            SB_BOTTOM => state.inspector_scroll_y = state.inspector_content_height,
            SB_THUMBTRACK | SB_THUMBPOSITION => {
                let mut info: SCROLLINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
                info.fMask = SIF_ALL;
                GetScrollInfo(state.inspector_scroll, SB_VERT, &mut info);
                state.inspector_scroll_y = info.nTrackPos.max(0);
            }
            _ => {}
        }
        // 唯一摆放口径：钳制 + 子控件平移 + 滚动条信息都在 `layout_panes_for` →
        // `layout_inspector_layer` → `apply_inspector_scroll` 里完成。
        layout_panes_for(state);
    });
}

/// 滚轮 → 浮层内容纵向滚动；返回是否消费本次滚轮。
///
/// 只有「浮层开着、内容超可视高」且「光标命中的窗口是滚动裁剪窗（或其子控件）」
/// 才消费（不抢画布/待发送条/正文的滚轮；浮层盒盖在消息流之上，光标在盒内时正文
/// 本来也不该动）。判定用 `GetCursorPos` + `WindowFromPoint`（含父链上溯）—— 与
/// 待发送条同一条「鼠标在哪就滚哪」口径；用 z 序命中而不是几何包含，是为了让
/// 压在裁剪窗之上的浮层（历史弹层）与下拉弹窗不被穿透。
pub(super) fn scroll_inspector_from_wheel(msg: u32, wparam: WPARAM) -> bool {
    // 横向轮在浮层没有既有语义：不消费（落回既有路径）。
    if msg != WM_MOUSEWHEEL {
        return false;
    }
    unsafe {
        let target = CHAT.with(|cell| {
            cell.borrow().as_ref().and_then(|state| {
                let scale = dpi_scale(state.hwnd);
                let view_h = inspector_body_view_height(state.inspector_box, scale);
                (state.inspector_open
                    && state.inspector_scroll != 0
                    && state.inspector_content_height > view_h)
                    .then_some(state.inspector_scroll)
            })
        });
        let Some(scroll) = target else { return false };
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point) == 0 {
            return false;
        }
        // 光标命中按**窗口 z 序**判（不是几何包含）：浮层与历史弹层可能重叠、
        // 下拉弹窗/控件也可能盖在裁剪窗上 —— 那些情况下滚轮不该穿过去滚抽屉。
        // 从命中窗口沿父链上溯，裁剪窗在链上才消费。
        let mut hit = WindowFromPoint(point);
        let mut over_scroll = false;
        while hit != 0 {
            if hit == scroll {
                over_scroll = true;
                break;
            }
            hit = GetParent(hit);
        }
        if !over_scroll {
            return false;
        }
        // 滚轮增量在**高字**（低字是按键标志）；一格 = 120，走行指令（与画布同款
        // 三行一步的粒度）。
        let delta = i32::from(((wparam >> 16) & 0xFFFF) as u16 as i16);
        let lines = (delta / 120).clamp(-5, 5) * 3;
        if lines == 0 {
            return false;
        }
        let command = if lines > 0 { SB_LINEUP } else { SB_LINEDOWN };
        for _ in 0..lines.abs() {
            SendMessageW(scroll, WM_VSCROLL, command as WPARAM, 0);
        }
        true
    }
}

/// 浮层滚动裁剪窗的窗口过程：盒底重铺 + 滚动指令 + 子控件的通知转发回聊天窗。
///
/// 与画布 `canvas_wndproc` 同族（滚动容器）：子控件（面板按钮/下拉/行标签）的
/// `WM_COMMAND`/`WM_DRAWITEM`/`WM_NOTIFY` 先到本窗，转发给父（浮层窗口，再转聊天窗，
/// 分派段在 `chat_wndproc` 统一收口）；`WM_CTLCOLORSTATIC` 就地按既有口径上色。
pub(super) unsafe extern "system" fn inspector_scroll_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底由 WM_PAINT 铺（盒底实色）；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                paint_win::fill_rect(
                    hdc,
                    paint_win::Rect::new(0, 0, rect_w(&client), rect_h(&client)),
                    &theme::tokens().panel_bg,
                );
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_VSCROLL => {
            inspector_scroll_command((wparam & 0xFFFF) as i32);
            0
        }
        WM_MOUSEWHEEL => {
            // 焦点在子控件时的滚轮消息会转到本窗：按行滚动（与画布同粒度）。
            // 增量在 **wParam 高字**（低字是按键标志；lParam 是屏幕坐标）—— 与
            // `windows_editor::on_mouse_wheel` / `scroll_pending_from_wheel` 同口径。
            let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
            let lines = (i32::from(delta) / 120).clamp(-5, 5);
            for _ in 0..lines.abs() {
                inspector_scroll_command(if lines > 0 { SB_LINEUP } else { SB_LINEDOWN });
            }
            0
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        // 同 `overlay_layer_wndproc`：编辑类控件的 CTLCOLOR 消费者是控件父窗
        // （浮层面板元素挂在本滚动裁剪窗上），就地接住并转给同一实现点。
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
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}
