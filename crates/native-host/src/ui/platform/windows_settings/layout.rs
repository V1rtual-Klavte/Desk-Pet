//! Windows 设置窗的布局几何与控件排布（自原 `windows_settings` 单文件拆出）。

use super::*;
use super::render::{notice_overlay_geometry, set_combo_heights};

pub(super) fn place_content_viewport(owner: HWND, viewport: HWND) {
    let scale = dpi_scale(owner);
    let (width, height) = client_size(owner);
    let grid = crate::ui::settings::layout::settings_layout(f64::from(width) / scale, f64::from(height) / scale);
    let rect = grid.scroll;
    unsafe {
        MoveWindow(
            viewport,
            (rect.x * scale).round() as i32,
            (rect.y * scale).round() as i32,
            (rect.w * scale).round() as i32,
            (rect.h * scale).round() as i32,
            1,
        );
    }
}

/// 用最终 GDI 字体量换行高度，不能用固定 11px 字宽猜测不同字体/字号的行数。
pub(super) fn measured_text_height(font: HFONT, text: &str, width: i32, scale: f64, minimum: i32) -> i32 {
    if text.is_empty() {
        return 0;
    }
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            rust_warn!(
                "设置文本量高失败（CreateCompatibleDC，GetLastError={}）",
                GetLastError()
            );
            return minimum;
        }
        let old = SelectObject(dc, font);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: scaled(width.max(1), scale),
            bottom: 0,
        };
        DrawTextW(
            dc,
            wide(text).as_ptr(),
            -1,
            &mut rect,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
        );
        SelectObject(dc, old);
        DeleteDC(dc);
        ((f64::from(rect.bottom - rect.top) / scale).ceil() as i32 + 2).max(minimum)
    }
}

pub(super) fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect: windows_sys::Win32::Foundation::RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left, rect.bottom - rect.top)
}

// ==========================================
// 主题绘制（窗底 / 分隔线 / 字色 / ownerdraw 按钮 / 主题广播）
// ==========================================

/// 字段行的控件尺寸（宽, 高）——宽度分档的单一实现点（`rebuild_tab` 与标签
/// 截断护栏测试同源）：控件右缘统一对齐内容右缘，Action 按钮按文案贴宽（120..200）。
pub(super) fn field_control_size(field: &Field) -> (i32, i32) {
    match field.kind {
        FieldKind::Bool => (SWITCH_W, SWITCH_H),
        // 数值档位：一整排分段（计划宽度 = 各段估宽 + 间隙；绘制端按实际客户区均分）。
        FieldKind::NumberChoice { options } => (number_choice_planned_width(options), ROW_H),
        FieldKind::Number { .. } => (CTRL_W_NUMBER, ROW_H),
        FieldKind::Text { secret: false } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Text { secret: true } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Enum(_)
        | FieldKind::FontFamily
        | FieldKind::CardChoice
        | FieldKind::ProfileChoice => (CTRL_W_POPUP, ROW_H),
        FieldKind::Multiline => (CTRL_W_MULTILINE, MULTILINE_H),
        FieldKind::Info => (CTRL_W_INFO, ROW_H),
        FieldKind::Shortcut => (CTRL_W_SHORTCUT, ROW_H),
        FieldKind::Action => (
            // 按钮宽 ≈ 文案估宽 + 内边距（正文基线 13.5 = `make_font(.., 13, ..)` 的
            // 参考字号，与 macOS `BODY_BASE_SIZE` 同值）；clamp 档与 macOS 一致。
            (crate::ui::chat::panels::estimated_text_width(field.label, 13.5) + 28.0)
                .clamp(120.0, 200.0)
                .round() as i32,
            ROW_H,
        ),
        // 修饰键键位由录制控件按平台写 schema 键，不渲染独立控件。
        FieldKind::ShortcutModifiers => (0, 0),
    }
}

/// 标签块宽度（纯函数）：控件右对齐后标签块吃剩余宽度；与 `rebuild_tab` 同源，
/// 供截断护栏按默认窗宽断言。`content_width` 含两侧 `MARGIN`（与 macOS 的
/// `field_label_width` 入参同口径：完整内容区宽，函数内部再扣边距与间距）。
pub(super) fn field_label_width(content_width: i32, ctrl_w: i32) -> i32 {
    let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
    (ctrl_x - ROW_LABEL_GAP - MARGIN).max(80)
}

// ==========================================
// 数值档位分段控件（NumberChoice；② 自绘族的新面）
// ==========================================
//
// 共享层口径照抄：**CONFIG 里仍是数字**，档位只约束**呈现**、不约束取值 ——
// 存量里可能的 1.5 / 0.8 按**最近档**高亮但**不写盘**，直到用户真点了某一段
// （共享层 `validate_value` 同样不按档位校验：拒绝存量中间值会把「打开设置再保存」
// 变成一次静默改写）。
//
// 控件是**一个** ownerdraw 按钮（一排互斥圆角段）：选中段取选中标签材质（`TabOn`）、
// 未选中段 `TabOff`、悬浮段叠按钮悬浮同款覆盖；点击落在哪一段用点击时的光标位置命中
// （`BN_CLICKED` 不带坐标），命中不了就什么都不做。呈现状态（档位表 + 高亮档）放独立
// 镜像表，理由同 `SWITCH_STATES`：`WM_DRAWITEM` 在绘制期同步到达，走 `with_state`
// 会与正在持借用者的调用路径重入（AGENTS §5.1 的 RefCell 纪律）。

/// 档位字段的呈现（纯函数，可测）：草稿现值 → 高亮档下标，**不产生要写回的值**。
///
/// 「最近档」按绝对距离取最近、平手取**靠前**档（1.5 → 「弱」）；值缺失 → 无高亮。
/// 档位之外的存量值也按最近档高亮，**不改值**（用户没动它就不该被改写）。
pub(super) fn number_choice_selected(options: &[(&str, f64)], value: Option<f64>) -> Option<usize> {
    let value = value?;
    let mut best: Option<(usize, f64)> = None;
    for (index, (_, option_value)) in options.iter().enumerate() {
        let distance = (value - option_value).abs();
        match best {
            Some((_, best_distance)) if best_distance <= distance => {}
            _ => best = Some((index, distance)),
        }
    }
    best.map(|(index, _)| index)
}

/// 段宽按客户区均分（纯函数，可测）：除不尽的余数落在最后一段；`count = 0` → 空。
pub(super) fn number_choice_equal_widths(client_w: i32, count: usize) -> Vec<i32> {
    if count == 0 {
        return Vec::new();
    }
    let total = client_w.max(0);
    let each = total / count as i32;
    let mut widths = vec![each; count];
    if let Some(last) = widths.last_mut() {
        *last = total - each * (count as i32 - 1);
    }
    widths
}

/// 点击命中哪一段（纯函数，可测）：段宽数组 + 控件内 x（同单位）→ 段下标。
/// 段之间留 `NUMBER_CHOICE_GAP` 间隙，落在间隙或界外 → `None`（**不猜一个档写值**）。
pub(super) fn number_choice_hit(widths: &[i32], x: i32) -> Option<usize> {
    let mut left = 0;
    for (index, width) in widths.iter().enumerate() {
        if x >= left && x < left + width {
            return Some(index);
        }
        left += width + NUMBER_CHOICE_GAP;
    }
    None
}

/// 控件的计划宽度（逻辑像素）：各段按文案估宽 + 内边距（clamp 到段宽上下限）+ 段间间隙。
///
/// 只用于给控件定尺寸；绘制/命中端按**实际客户区均分**（[`number_choice_equal_widths`]），
/// 免得 DPI 舍入让按下位置与画出的段错位。
fn number_choice_planned_width(options: &[(&str, f64)]) -> i32 {
    let segments: i32 = options
        .iter()
        .map(|(label, _)| {
            (crate::ui::chat::panels::estimated_text_width(label, 13.5)
                + f64::from(NUMBER_CHOICE_SEG_PAD))
            .clamp(
                f64::from(NUMBER_CHOICE_SEG_MIN),
                f64::from(NUMBER_CHOICE_SEG_MAX),
            )
            .round() as i32
        })
        .sum();
    let gaps = NUMBER_CHOICE_GAP * (options.len().saturating_sub(1) as i32);
    (segments + gaps).max(NUMBER_CHOICE_SEG_MIN)
}

/// 各段矩形（物理像素；相对控件客户区左上角）。
pub(super) fn number_choice_segment_rects(hwnd: HWND) -> Vec<paint_win::Rect> {
    let (client_w, client_h) = client_size(hwnd);
    let count = NUMBER_CHOICES.with(|states| {
        states
            .borrow()
            .get(&(hwnd as isize))
            .map(|state| state.options.len())
            .unwrap_or(0)
    });
    let widths = number_choice_equal_widths(client_w, count);
    let mut left = 0;
    let mut rects = Vec::with_capacity(widths.len());
    for width in widths {
        rects.push(paint_win::Rect::new(left, 0, width, client_h));
        left += width + NUMBER_CHOICE_GAP;
    }
    rects
}

/// 点击时的命中段（光标 → 控件坐标 → [`number_choice_hit`]）；取不到光标 → `None`。
pub(super) fn number_choice_clicked_index(hwnd: HWND) -> Option<usize> {
    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } == 0 || unsafe { ScreenToClient(hwnd, &mut point) } == 0
    {
        return None;
    }
    let widths: Vec<i32> = number_choice_segment_rects(hwnd)
        .iter()
        .map(|rect| rect.w)
        .collect();
    number_choice_hit(&widths, point.x)
}

/// 行高推进（纯函数，可测；与 macOS `panel_rows_span` 的行高表同档）：副标题为空
/// = 单行紧凑行（行内下拉行同此，不为下拉加高）；有副标题 +30 容纳副标题框
/// （标题下 19 起、高 45、最多三行）。
pub(super) fn panel_row_advance(subtitle: &str) -> i32 {
    if subtitle.trim().is_empty() {
        PANEL_ROW_H
    } else {
        // 2026-10-06 与 macOS `panel_row_height` 同口径收紧：副标题两行档（38+18）。
        PANEL_ROW_H + 18
    }
}

/// 批量挪位：`SWP_NOREDRAW` 抑制控件即时自绘，统一由 `layout()` 末尾的
/// **一次** `RedrawWindow` 收口 —— 滚动期「每只控件 `MoveWindow(重绘=1)`」的
/// 重绘风暴是实机滚轮卡顿的根因（2026-10-07）。
unsafe fn move_batched(child: HWND, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        SetWindowPos(
            child,
            0,
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW,
        );
    }
}

/// 按当前滚动量与状态重排全部控件（含固定控件）。
///
/// **自己借 STATE**：调用方不得在 `with_state` 借用里调它（嵌套即丢内容，理由见
/// [`with_state`] 的说明）—— 先 `with_state(|state| state.hwnd)` 取句柄、出借用再调。
pub(super) fn layout(hwnd: HWND) {
    with_state(|state| {
        let scale = dpi_scale(hwnd);
        let (width, height) = client_size(hwnd);
        let mut viewport_rect: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(state.viewport, &mut viewport_rect); }
        let (viewport_width, _) = client_size(state.viewport);
        let gutter = (viewport_rect.right - viewport_rect.left - viewport_width).max(0);
        // Windows 标准滚动条占用客户区宽度；页脚同样扣掉该槽，与内容右缘共线。
        let grid = crate::ui::settings::layout::settings_layout(
            f64::from(width - gutter) / scale,
            f64::from(height) / scale,
        );
        let (_, view_height) = client_size(state.viewport);
        let view_height = ((f64::from(view_height) / scale).round() as i32).max(1);
        state.scroll = state
            .scroll
            .clamp(0, (state.content_height - view_height).max(0));
        let info = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_RANGE | SIF_PAGE | SIF_POS | SIF_DISABLENOSCROLL,
            nMin: 0,
            nMax: state.content_height.saturating_sub(1).max(0),
            nPage: view_height as u32,
            nPos: state.scroll,
            nTrackPos: 0,
        };
        unsafe { SetScrollInfo(state.viewport, SB_VERT, &info, 1) };
        // 字段控件与管理面控件按内容面原点 - scroll 摆放。越界部分由父子窗裁剪，
        // 不再侵入固定页脚、遮住保存按钮或在上方竖栏留下控件残片。
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            let y = scaled(slot.y - state.scroll, scale);
            let w = scaled(slot.w, scale);
            let combo = slot.kind.map_or(false, |kind| {
                matches!(
                    kind,
                    FieldKind::Enum(_)
                        | FieldKind::FontFamily
                        | FieldKind::CardChoice
                        | FieldKind::ProfileChoice
                )
            }) || state
                .row_slots
                .iter()
                .any(|row| row.control == slot.hwnd && row.action == RowAction::Pick);
            unsafe {
                move_batched(
                    slot.hwnd,
                    scaled(slot.x, scale),
                    y,
                    w,
                    scaled(slot.h + if combo { COMBO_LIST_H } else { 0 }, scale),
                );
            }
            if combo {
                set_combo_heights(slot.hwnd, slot.h, scale);
            }
        }
        // 页脚与 macOS 读取同一网格，按本窗 DPI 转为物理像素。
        for (control, rect) in [
            (state.fixed.status, grid.status),
            (state.fixed.refresh, grid.refresh),
            (state.fixed.save, grid.save),
        ] {
            unsafe {
                move_batched(
                    control,
                    (rect.x * scale).round() as i32,
                    (rect.y * scale).round() as i32,
                    (rect.w * scale).round() as i32,
                    (rect.h * scale).round() as i32,
                );
            }
        }
        // 左竖栏行按钮：竖排（顶距 9、行距 26+1），不随滚动位移。
        for (index, button) in state.fixed.tab_buttons.iter().enumerate() {
            unsafe {
                move_batched(
                    *button,
                    scaled(RAIL_PAD_X, scale),
                    scaled(
                        RAIL_TOP + index as i32 * (RAIL_ITEM_H + RAIL_ITEM_GAP),
                        scale,
                    ),
                    scaled(RAIL_W - RAIL_PAD_X * 2, scale),
                    scaled(RAIL_ITEM_H, scale),
                )
            };
        }
        // 文档编辑弹窗（②）是独立顶层窗（模态），不参与内容区摆位；页面内容不被它顶长。
        // 通知浮层（①）：随窗口宽度重新居中；最后置顶 —— 它要浮在页面控件之上。
        if state.notice_overlay != 0 {
            let (width, _) = client_size(hwnd);
            let (x, y, w, h) = notice_overlay_geometry(state.notice_measured, width, scale);
            unsafe {
                MoveWindow(state.notice_overlay, x, y, w, h, 1);
                SetWindowPos(
                    state.notice_overlay,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
        let decorations = state
            .section_rules
            .iter()
            .map(|y| {
                (
                    paint_win::Rect::new(MARGIN, *y, state.content_width - MARGIN * 2, 1),
                    true,
                )
            })
            .chain(state.row_backgrounds.iter().map(|rect| (*rect, false)))
            .map(|(rect, rule)| {
                (
                    paint_win::Rect::new(
                        scaled(rect.x, scale),
                        scaled(rect.y - state.scroll, scale),
                        scaled(rect.w, scale),
                        scaled(rect.h, scale),
                    ),
                    rule,
                )
            })
            .collect();
        CONTENT_DECORATIONS.with(|mirror| *mirror.borrow_mut() = decorations);
        // 滚动/重排的绘制收口：控件在上面的批里用 `SWP_NOREDRAW` 挪位，这里
        // **一次**失效整片内容面并带全部子控件重画 —— 旧实现每只控件
        // `MoveWindow(重绘=1)`，滚一格就是一轮「每控件自绘 + 交错擦底」的风暴
        //（实机滚轮卡顿根因，2026-10-07）。`RDW_ALLCHILDREN` 让移动过的控件在
        // 最终位置各自重画一次，不会丢内容。
        unsafe {
            RedrawWindow(
                state.viewport,
                std::ptr::null(),
                0,
                RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN,
            )
        };
    });
    // 重排后整窗失效一次：**附属窗类刷留空**（`windows.rs` 的类注册，`hbrBackground = 0`），
    // 系统因此不会自动擦除背景 —— 不显式失效，被销毁/移走的旧控件像素会永久留在窗上、
    // 叠在新内容下面（2026-10-07 实机：切 Tab 后「所有的东西都停留在上面」，还被当成
    // 「设置页没有样式」）。`WS_CLIPCHILDREN` 下这次重画只覆盖控件之间的空隙，子控件各自重画。
    unsafe { InvalidateRect(hwnd, std::ptr::null(), 1) };
}

pub(super) fn scroll_target(current: i32, content_height: i32, page: i32, code: i32, track: i32) -> i32 {
    let max = (content_height - page).max(0);
    match code {
        SB_LINEUP => current.saturating_sub(SCROLL_STEP),
        SB_LINEDOWN => current.saturating_add(SCROLL_STEP),
        SB_PAGEUP => current.saturating_sub(page),
        SB_PAGEDOWN => current.saturating_add(page),
        SB_THUMBPOSITION | SB_THUMBTRACK => track,
        SB_TOP => 0,
        SB_BOTTOM => max,
        _ => current,
    }
    .clamp(0, max)
}
