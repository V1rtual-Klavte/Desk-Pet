//! Windows 设置窗的主题绘制、控件构建与通知浮层呈现（自原 `windows_settings` 单文件拆出）。

use super::*;
use super::dialogs::{apply_theme_doc_dialog, paint_doc_dialog_background};
use super::events::{
    NOTICE_FONT, combo_item_text, notice_timer_proc, notice_wndproc, on_size, pick_selected_index,
    write_control,
};
use super::layout::{
    client_size, field_control_size, field_label_width, layout, measured_text_height,
    number_choice_clicked_index, number_choice_segment_rects, number_choice_selected,
    panel_row_advance,
};

pub(super) fn paint_content_background(hwnd: HWND, hdc: HDC) {
    let (width, height) = client_size(hwnd);
    // 内容面与窗底同源（`panel_bg`，见模块头「主题接线」的 2026-10-07 改口径说明）：
    // 这一层是滚动视口，用户看到的「设置页底色」就是它，不能用 `field_bg`（近白）。
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, width, height),
        &theme::tokens().panel_bg,
    );
    CONTENT_DECORATIONS.with(|mirror| {
        for (rect, rule) in mirror.borrow().iter() {
            let tokens = theme::tokens();
            if *rule {
                paint_win::fill_color(hdc, *rect, tokens.rule);
            } else {
                paint_win::fill_color(hdc, *rect, row_background(tokens));
            }
        }
    });
}

pub(super) fn set_combo_heights(hwnd: HWND, height: i32, scale: f64) {
    // 字段区 (-1) 和固定高度列表 (0) 是独立设置，不能只设前者。
    unsafe {
        if SetWindowSubclass(hwnd, Some(combo_chrome_proc), COMBO_CHROME_ID, 0) == 0 {
            rust_warn!(
                "设置下拉主题绘制接线失败（GetLastError={}）",
                GetLastError()
            );
        }
        SendMessageW(
            hwnd,
            CB_SETITEMHEIGHT,
            usize::MAX,
            scaled(height, scale) as LPARAM,
        );
        SendMessageW(hwnd, CB_SETITEMHEIGHT, 0, scaled(height, scale) as LPARAM);
    }
}

const COMBO_CHROME_ID: usize = 0x5343;

/// 系统仍负责展开、键盘与选项语义；这里只覆盖系统白色箭头和边框。
unsafe extern "system" fn combo_chrome_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    if msg == WM_PAINT || msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_NCPAINT {
        let mut info: COMBOBOXINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<COMBOBOXINFO>() as u32;
        if GetComboBoxInfo(hwnd, &mut info) != 0 {
            let dc = windows_sys::Win32::Graphics::Gdi::GetDC(hwnd);
            if dc != 0 {
                let t = theme::tokens();
                let r = info.rcButton;
                let rect = paint_win::Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top);
                paint_win::fill_rect(dc, rect, &t.field_bg);
                let cx = r.left + (r.right - r.left) / 2;
                let cy = r.top + (r.bottom - r.top) / 2;
                let d = scaled(3, dpi_scale(hwnd)).max(2);
                paint_win::fill_triangle(
                    dc,
                    [(cx - d, cy - 1), (cx + d, cy - 1), (cx, cy + d)],
                    t.dim,
                );
                let (w, h) = client_size(hwnd);
                paint_win::draw_frame(
                    dc,
                    paint_win::Rect::new(0, 0, w, h),
                    t.field_edge,
                    &t.field_bevel,
                );
                windows_sys::Win32::Graphics::Gdi::ReleaseDC(hwnd, dc);
            }
        }
    } else if msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(combo_chrome_proc), COMBO_CHROME_ID);
    }
    result
}

/// 窗底 + 左竖栏 + 底部 `bar_edge` 分隔线（WM_ERASEBKGND 与 WM_PAINT 共用；物理像素）。
///
/// 底取 `tokens().panel_bg`（2026-10-07 改口径，理由见模块头「主题接线」）；左竖栏止于底部固定条
/// 上缘（`rail_bg` + 右缘 1px `rail_edge`）；分隔线只剩底部固定条的上边线（原顶部
/// Tab 带随竖栏改造删除）。类画刷在 `windows.rs` 的附属窗类注册里已留空，
/// 这里的自绘是唯一的底来源（换主题不必重注册窗口类）。
pub(crate) fn paint_background(hwnd: HWND, hdc: HDC) {
    let (width, height) = client_size(hwnd);
    if width <= 0 || height <= 0 {
        return;
    }
    let tokens = theme::tokens();
    let scale = dpi_scale(hwnd);
    let grid = crate::ui::settings::layout::settings_layout(f64::from(width) / scale, f64::from(height) / scale);
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, width, height),
        &tokens.panel_bg,
    );
    // 竖栏底：右缘分界线是 1px 独立矩形（主题 `Fill` 的 EdgeSide 只有上下边）。
    let rail_h = (grid.rail.h * scale).round() as i32;
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, scaled(RAIL_W, scale), rail_h),
        &tokens.rail_bg,
    );
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(scaled(RAIL_W - 1, scale), 0, 1, rail_h),
        tokens.rail_edge,
    );
    // 操作条上缘 1px `bar_edge` 分隔线（设计稿 `.sfoot` 的 border-top；与 macOS
    // `SettingsLayout.separator` 同款）：滚动内容与操作条之间有明确分界，不再出现
    // 「内容半行贴在操作条上」的观感。
    let bottom_rule_y = (grid.separator.y * scale).round() as i32;
    paint_win::fill_color(
        hdc,
        paint_win::Rect::new(0, bottom_rule_y, width, 1),
        tokens.bar_edge,
    );
}

/// ownerdraw 按钮的绘制入口：先把**父窗真实像素**重放到控件矩形，再画药丸面。
///
/// 为什么不能继续用 token 近似补角：ownerdraw 子控件是不透明表面，矩形里的一切
/// 都得控件自己画；而近似色在「竖栏底 / 内容面 / 页脚」这类各自换过底色的区域必然
/// 差十几到三十灰阶 —— 实机就是用户 2026-10-07 实拍的两类症状：未选中 Tab 变成
/// 「灰色药丸 + 灰色矩形底」、页脚按钮四周一圈异色矩形。重放走父窗**自己的绘制
/// 例程**（`paint_background` / `paint_content_background`），四角与周围逐像素同色。
///
/// 只认这两族父窗（根窗 `AUX_CLASS`、内容滚动面 `CONTENT_CLASS`）；弹窗/浮层的
/// 父窗这次不接，返回 `false` = 已按旧近似口径画完（与
/// [`paint_win::draw_button_on_backdrop`] 的约定一致）。
pub(super) fn draw_button_on_parent_backdrop(
    item: &DrawItemStruct,
    rect: paint_win::Rect,
    face: &paint_win::ButtonFace,
    label: &str,
    pressed: bool,
    disabled: bool,
) -> bool {
    let parent = unsafe { GetParent(item.hwndItem) };
    if parent == 0 {
        return false;
    }
    let class = window_class_name(parent);
    let painter: fn(HWND, HDC) = if class == CONTENT_CLASS {
        paint_content_background
    } else if class == super::super::windows::AUX_CLASS {
        paint_background
    } else if class == DOC_DIALOG_CLASS {
        // 弹窗底是 `field_bg` 平色；同源重放后「复制 / 关闭」的四角与弹窗底同色
        // （用户 2026-10-07 实拍 Card 模版弹窗的浅色矩形底）。
        |hwnd, hdc| unsafe { paint_doc_dialog_background(hwnd, hdc) }
    } else {
        return false;
    };
    unsafe {
        paint_win::draw_button_on_backdrop(
            item.hDC,
            item.hwndItem,
            parent,
            rect,
            face,
            label,
            pressed,
            disabled,
            |hdc| painter(parent, hdc),
        )
    }
}

/// 键盘焦点环（ownerdraw 没有系统焦点矩形，`ODS_FOCUS` 时自己补一条）：
/// `DrawFocusRect` 是 XOR 绘制，叠在主题面上任何底色都可见。
pub(super) fn draw_focus_ring(item: &DrawItemStruct, rect: paint_win::Rect) {
    if item.itemState & ODS_FOCUS == 0 {
        return;
    }
    let ring = rect.deflate(3);
    if ring.is_empty() {
        return;
    }
    let win = RECT {
        left: ring.x,
        top: ring.y,
        right: ring.right(),
        bottom: ring.bottom(),
    };
    unsafe { DrawFocusRect(item.hDC, &win) };
}

/// ownerdraw 组合框条目（②）：字段区取 `field_*` 面色、下拉条目取 `field_bg` 底 +
/// 悬浮同款选中覆盖；文字 `ink`、禁用降 `dim`。条目文本仍由控件的字符串表提供
/// （`CB_GETLBTEXT` 照旧可用，读写路径零改动）。
pub(super) fn draw_combo_item(item: &DrawItemStruct) {
    let tokens = theme::tokens();
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    if rect.is_empty() {
        return;
    }
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    // 字段区（收起态）判据：`itemID == -1`（下拉列表控件的静态字段区）或
    // `ODS_COMBOBOXEDIT`（edit 部分的标记，防御性一并认）。
    let field_area = item.itemID == u32::MAX || item.itemState & ODS_COMBOBOXEDIT != 0;
    let style = combo_item_style(
        tokens,
        item.itemState & ODS_SELECTED != 0,
        disabled,
        field_area,
    );
    unsafe {
        if let Some(bg) = &style.bg {
            paint_win::fill_rect(item.hDC, rect, bg);
        }
        if let Some(edge) = style.edge {
            paint_win::draw_frame(
                item.hDC,
                rect,
                edge,
                &style.bevel.unwrap_or(theme::Bevel::NONE),
            );
        }
        if let Some(overlay) = style.overlay {
            paint_win::fill_color(item.hDC, rect, overlay);
        }
        let font = SendMessageW(item.hwndItem, WM_GETFONT, 0, 0) as HFONT;
        let old = if font != 0 {
            SelectObject(item.hDC, font)
        } else {
            0
        };
        // 文本来源：条目行取该项字符串；`itemID == -1`（字段区 / 收起态）取控件文本
        // （`WM_GETTEXT` 对下拉选中的条目返回其文本，两平台读值口径同源）。
        let text = if item.itemID == u32::MAX {
            window_text(item.hwndItem)
        } else {
            combo_item_text(item.hwndItem, item.itemID as i32)
        };
        let pad = scaled(COMBO_TEXT_PAD, dpi_scale(item.hwndItem));
        let mut text_rect = item.rcItem;
        text_rect.left += pad;
        text_rect.right -= pad;
        SetBkMode(item.hDC, TRANSPARENT);
        SetTextColor(item.hDC, paint_win::colorref(style.ink));
        DrawTextW(
            item.hDC,
            wide(&text).as_ptr(),
            -1,
            &mut text_rect,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
        if old != 0 {
            SelectObject(item.hDC, old);
        }
    }
}

/// 主题广播（`windows.rs::apply_theme` 调用）。
///
/// 顺序不变量：调用方已先 `paint_win::release_theme_resources()`（旧主题的画刷/纹理
/// 都在那里 `DeleteObject`），本函数只做「按新 token 重刷字色 + 强制重绘」；
/// 本文件自己不持有任何 GDI 对象，所以没有需要在这里释放的句柄。
pub(crate) fn apply_theme() {
    let applied = with_state(|state| {
        let tokens = theme::tokens();
        let scale = dpi_scale(state.hwnd);
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            if let Some(role) = slot.role {
                paint_win::set_text_color(slot.hwnd, paint_win::text_color(tokens, role));
            }
            // 全面自绘后每个按钮都是 ownerdraw：圆角随 `radii.btn` 重贴区域
            // （开关是半高胶囊、竖栏行按钮取 `radii.sm`，两者都不走这里）。
            let is_switch =
                SWITCH_STATES.with(|states| states.borrow().contains(slot.hwnd as isize));
            if !is_switch && is_themed_button(slot.hwnd) {
                paint_win::install_button(
                    slot.hwnd,
                    scaled(tokens.radii.btn.round() as i32, scale),
                );
            }
            // 字段面（EDIT / COMBOBOX）的圆角半径随 `radii.sm` 变化：重贴区域即可换肤
            // （与按钮的 `radii.btn` 分开，见 `is_field_surface`）。
            if slot.kind.as_ref().map_or(false, is_field_surface) {
                apply_field_region(
                    slot.hwnd,
                    scaled(slot.w, scale),
                    scaled(slot.h, scale),
                    scale,
                );
            }
            unsafe { InvalidateRect(slot.hwnd, std::ptr::null(), 1) };
        }
        stamp_text(state.fixed.status, TextRole::Hint);
        // 固定条的按钮不在槽表里（创建于 install），半径刷新与失效在这里补。
        for control in [state.fixed.refresh, state.fixed.save] {
            if is_themed_button(control) {
                paint_win::install_button(control, scaled(tokens.radii.btn.round() as i32, scale));
            }
        }
        // 竖栏行按钮的圆角半径随 `radii.sm` 变化：重贴区域后再失效重绘。
        for control in state.fixed.tab_buttons.iter() {
            paint_win::install_button(*control, scaled(tokens.radii.sm.round() as i32, scale));
            unsafe { InvalidateRect(*control, std::ptr::null(), 1) };
        }
        // 文档弹窗（②）与通知浮层（①）不在槽表里：各自重刷字色/圆角/重绘
        //（弹窗只在它开着时才需要 —— 模态期间换主题是低频但真实存在的路径）。
        if state.doc_dialog != 0 {
            apply_theme_doc_dialog(state.doc_dialog, scale);
        }
        if state.notice_overlay != 0 {
            // 浮层绘制读 tokens 现值：重绘 + 按新 `radii.btn` 重贴圆角区域即完成换肤。
            refresh_notice_region(state.notice_overlay, scale);
            unsafe { InvalidateRect(state.notice_overlay, std::ptr::null(), 1) };
        }
        unsafe {
            InvalidateRect(state.fixed.status, std::ptr::null(), 1);
            InvalidateRect(state.fixed.refresh, std::ptr::null(), 1);
            InvalidateRect(state.fixed.save, std::ptr::null(), 1);
            InvalidateRect(state.viewport, std::ptr::null(), 1);
            InvalidateRect(state.hwnd, std::ptr::null(), 1);
        }
    });
    match applied {
        Some(()) => rust_info!("设置窗已按新主题重刷字色并重绘（Windows）"),
        None => rust_debug!("设置窗未打开，主题广播跳过"),
    }
}

// ==========================================
// 字段行几何（纯函数，可测；与 macOS `field_control_size` / `field_label_width` 同式）
// ==========================================

/// 分段控件绘制：整组一圈中性描边；每段按选中/悬浮取面、文字居中（选中 `ink`、
/// 未选中 `dim`）；读 tokens 现值 —— 换主题后由 `apply_theme` 触发重绘。
pub(super) fn draw_number_choice(item: &DrawItemStruct) {
    let state =
        NUMBER_CHOICES.with(|states| states.borrow().get(&(item.hwndItem as isize)).copied());
    let Some(state) = state else {
        return;
    };
    let tokens = theme::tokens();
    let rects = number_choice_segment_rects(item.hwndItem);
    if rects.is_empty() {
        return;
    }
    let group = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    let hovered = number_choice_clicked_index(item.hwndItem);
    let font = unsafe { SendMessageW(item.hwndItem, WM_GETFONT, 0, 0) } as HFONT;
    unsafe {
        let old = if font != 0 {
            SelectObject(item.hDC, font)
        } else {
            0
        };
        for (index, segment) in rects.iter().enumerate() {
            let selected = state.selected == Some(index);
            let face = paint_win::button_face(
                tokens,
                if selected {
                    ButtonRole::TabOn
                } else {
                    ButtonRole::TabOff
                },
                hovered == Some(index) && !selected,
                false,
            );
            let segment = segment.offset(group.x, group.y);
            if let Some(bg) = &face.bg {
                paint_win::fill_rect(item.hDC, segment, bg);
            }
            if let Some(overlay) = face.overlay {
                paint_win::fill_color(item.hDC, segment, overlay);
            }
            if let Some((label, _)) = state.options.get(index) {
                let mut text_rect = RECT {
                    left: segment.x,
                    top: segment.y,
                    right: segment.right(),
                    bottom: segment.bottom(),
                };
                SetBkMode(item.hDC, TRANSPARENT);
                SetTextColor(item.hDC, paint_win::colorref(face.ink));
                DrawTextW(
                    item.hDC,
                    wide(label).as_ptr(),
                    -1,
                    &mut text_rect,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                );
            }
        }
        // 整组描边：中性 `bar_edge`（与分隔线同族），让「分段组」在页面上有边界。
        paint_win::draw_frame(item.hDC, group, tokens.bar_edge, &theme::Bevel::NONE);
        if old != 0 {
            SelectObject(item.hDC, old);
        }
    }
}

/// 重建当前 Tab 的字段控件（旧控件销毁）。
pub(super) fn rebuild_tab() {
    let _syncing = ControlSyncGuard::begin();
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    with_state(|state| {
        // 重建前的销毁数量留痕（info 级）：实机「切 Tab 后旧内容还留在窗上」有两个可能 ——
        // 控件没销毁（这里会是 0）与像素没重画（这里大于 0，靠 `layout` 末尾的失效补）。
        // 每次切 Tab 一行，不构成噪声；定案后可回落到 debug。
        let rebuild_from = state.slots.len();
        for slot in state.slots.drain(..) {
            unsafe { DestroyWindow(slot.hwnd) };
            // 句柄会被系统复用：销毁的开关 / 档位段必须注销，不能留陈旧状态项。
            SWITCH_STATES.with(|states| states.borrow_mut().unregister(slot.hwnd as isize));
            unregister_number_choice(slot.hwnd as isize);
        }
        // 密钥揭示按钮与动态帮助行的控件随槽位销毁：引用一并清空。
        state.secret_pairs.clear();
        state.dynamic_hints.clear();
        let hwnd = state.viewport;
        let scale = dpi_scale(hwnd);
        // 逻辑坐标（摆放由 `layout` 统一按 DPI 缩放；创建时的物理初值会被覆盖）。
        // 控件坐标以内容面为原点；内容面自身裁剪顶部与页脚外的像素。
        let (width, _height) = client_size(hwnd);
        let logical_width = (f64::from(width) / scale).round() as i32;
        state.content_width = logical_width;
        let content_w = (logical_width - MARGIN * 2).max(120);
        // 内容区完整宽度（含两侧 MARGIN；与 macOS `build_field` 的 `width` 同口径）：
        // 控件右缘统一对齐 `content_width - MARGIN`，宽度分档见 [`field_control_size`]。
        let content_width = logical_width;
        let tab = &TABS[state.tab];

        // 字体按槽的基础字号在创建时取用（这里固定用 13 号正文）。
        let body = *state.fonts.first().unwrap_or(&0);
        let small = *state.fonts.get(1).unwrap_or(&body);

        let mut y = 6i32;
        state.section_rules.clear();
        let mut slots: Vec<WinSlot> = Vec::new();
        for (section_index, section) in tab.sections.iter().enumerate() {
            if section_index > 0 {
                state.section_rules.push(y);
                y += 1 + SECTION_GAP;
            }
            // 小节标题。
            let title_h = measured_text_height(
                *state.fonts.get(2).unwrap_or(&body),
                section.title,
                content_w,
                scale,
                18,
            );
            let title = unsafe {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide(section.title).as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    MARGIN,
                    0,
                    content_w,
                    title_h,
                    hwnd,
                    0,
                    hinstance,
                    std::ptr::null(),
                )
            };
            unsafe {
                SendMessageW(
                    title,
                    WM_SETFONT,
                    *state.fonts.get(2).unwrap_or(&body) as WPARAM,
                    1,
                )
            };
            stamp_text(title, TextRole::Body);
            slots.push(WinSlot {
                hwnd: title,
                key: None,
                kind: None,
                x: MARGIN,
                y,
                w: content_w,
                h: title_h,
                font_base: 13,
                role: Some(TextRole::Body),
            });
            y += title_h + 4;
            for field in section.fields {
                // 修饰键键位由录制控件按平台写入 schema 里的键，不渲染独立控件。
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue;
                }
                // 行结构（2026-10-05 按设计稿 `.srow` 与 macOS 同式重排）：标签块在**左**
                // （标签在上，帮助与动态提示在标签下、按标签块宽自动换行，`dim` 小字），
                // 控件在**右**、右缘统一对齐内容右缘，行内垂直居中；Action 行无左标签
                // （按钮文字即标题）。旧布置（右对齐标签列 + 控件挤在中列 + 帮助塞控件
                // 下）把全部文案压进中列，长帮助会截断。
                let (ctrl_w, planned_h) = field_control_size(field);
                let ctrl_h = if matches!(field.kind, FieldKind::Bool) {
                    planned_h
                } else {
                    planned_h.max(measured_text_height(body, "国Ag", ctrl_w, scale, ROW_H - 6) + 6)
                };
                let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
                let label_w = field_label_width(content_width, ctrl_w);
                let label_text = field.display_label();
                let label_h = measured_text_height(small, &label_text, label_w, scale, 18);
                let help_h = measured_text_height(small, field.help, label_w, scale, HELP_H);
                // 动态帮助行（如 Bash 白名单计数）：文本在刷新路径按草稿现值重算；
                // 高度要参与左块估算，所以在这里先取一次。
                let dynamic_hint = crate::ui::settings::dynamic_field_hint(
                    field.key,
                    &settings_ui().view().values,
                );
                let hint_h = dynamic_hint.as_ref().map_or(0, |text| {
                    measured_text_height(small, text, label_w, scale, HELP_H)
                });
                // 左块高度：标签 18 + 帮助（2 + N×行高）+ 动态提示一行；行高取控件高与
                // 左块高的较大者，控件在行内垂直居中。
                let mut block_h = if matches!(field.kind, FieldKind::Action) {
                    0
                } else {
                    label_h
                };
                if help_h > 0 {
                    block_h += 2 + help_h;
                }
                if dynamic_hint.is_some() {
                    block_h += 2 + hint_h;
                }
                let row_h = ctrl_h.max(block_h).max(ROW_H);
                let ctrl_y = y + ((row_h - ctrl_h) / 2).max(0);

                // 标签文本含单位后缀（`display_label`，与 macOS 同源）。
                if !matches!(field.kind, FieldKind::Action) {
                    let label = unsafe {
                        CreateWindowExW(
                            0,
                            wide("STATIC").as_ptr(),
                            wide(&label_text).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                            MARGIN,
                            0,
                            label_w,
                            label_h,
                            hwnd,
                            0,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(label, WM_SETFONT, small as WPARAM, 1) };
                    stamp_text(label, TextRole::Body);
                    slots.push(WinSlot {
                        hwnd: label,
                        key: None,
                        kind: None,
                        x: MARGIN,
                        y: y + 2,
                        w: label_w,
                        h: label_h,
                        font_base: 11,
                        role: Some(TextRole::Body),
                    });
                }

                let (class, style, text) = match field.kind {
                    // 自绘开关：不承载 BM_SETCHECK 语义（状态在 SWITCH_STATES 镜像表）。
                    FieldKind::Bool => (
                        "BUTTON",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                        field.label,
                    ),
                    FieldKind::Number { .. } => (
                        "EDIT",
                        // 不挂 `WS_BORDER`：系统边框是「上下两条深色横线」，与 mac 的圆角
                        // 白药丸字段完全不同（2026-10-07 实拍对照）。字段的边界感交给
                        // 白面 + `apply_field_region` 的圆角在 `panel_bg` 窗底上的对比。
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL as u32,
                        "",
                    ),
                    // 数值档位：一个 ownerdraw 按钮画整排互斥段（`paint_win::draw_*` 之外
                    // 的自绘面，绘制在 `on_drawitem` 的 `NUMBER_CHOICES` 分支）。
                    FieldKind::NumberChoice { .. } => (
                        "BUTTON",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                        "",
                    ),
                    // 密钥：遮蔽态由 `ES_PASSWORD` 承担；「显示/隐藏」按钮用
                    // `EM_SETPASSWORDCHAR` 在明文/复遮蔽之间切换（见 on_command 的揭示分支）。
                    FieldKind::Text { secret } => (
                        "EDIT",
                        WS_CHILD
                            | WS_VISIBLE
                            | WS_TABSTOP
                            | ES_AUTOHSCROLL as u32
                            | (if secret { ES_PASSWORD as u32 } else { 0 }),
                        "",
                    ),
                    // 下拉（②「全面自绘」）：`CBS_OWNERDRAWFIXED` + 本例的 `WM_DRAWITEM`
                    // 分支画选中字段区与全部条目；**保留真下拉语义**（键盘、CBN_* 通知、
                    // `CB_GETCURSEL/CB_SETCURSEL/CB_GETLBTEXT` 全部照旧，读写路径零改动）。
                    // 条目高度用 `CB_SETITEMHEIGHT(-1, h)` 在创建后程序化设定 ——
                    // `WM_MEASUREITEM` 未被 windows.rs 的设置窗分派转发，CB_SETITEMHEIGHT
                    // 给 owner-draw-fixed 组合框同时设字段区与全部条目高度（文档行为），
                    // 不依赖那条消息。
                    FieldKind::Enum(_)
                    | FieldKind::FontFamily
                    | FieldKind::CardChoice
                    | FieldKind::ProfileChoice => ("COMBOBOX", WS_VISIBLE | COMBO_STYLE, ""),
                    FieldKind::Multiline => (
                        "EDIT",
                        WS_CHILD
                            | WS_VISIBLE
                            | WS_TABSTOP
                            | WS_VSCROLL
                            | ES_AUTOVSCROLL as u32
                            | ES_MULTILINE as u32
                            | ES_WANTRETURN as u32,
                        "",
                    ),
                    FieldKind::Info => ("STATIC", WS_CHILD | WS_VISIBLE, ""),
                    FieldKind::Shortcut => {
                        ("BUTTON", WS_CHILD | WS_VISIBLE | WS_TABSTOP, "录制快捷键")
                    }
                    // 上面已跳过；这里兜底不产生特殊样式。
                    FieldKind::ShortcutModifiers => ("STATIC", WS_CHILD, ""),
                    FieldKind::Action => {
                        ("BUTTON", WS_CHILD | WS_VISIBLE | WS_TABSTOP, field.label)
                    }
                };
                // 控件位置：右缘对齐内容右缘（ctrl_x）、行内垂直居中（ctrl_y）；
                // 密钥字段把揭示按钮的位置从控件宽里让出来（按钮贴控件组右缘）。
                let (field_w, field_h) = match field.kind {
                    FieldKind::Text { secret: true } => {
                        ((ctrl_w - SECRET_BTN_W - 4).max(40), ctrl_h)
                    }
                    _ => (ctrl_w, ctrl_h),
                };
                let control = unsafe {
                    CreateWindowExW(
                        0,
                        wide(class).as_ptr(),
                        wide(text).as_ptr(),
                        // WS_CLIPSIBLINGS：通知浮层要浮在字段控件之上（见安装处样式说明）。
                        style | WS_CLIPSIBLINGS,
                        ctrl_x,
                        0,
                        field_w,
                        if class == "COMBOBOX" {
                            field_h + COMBO_LIST_H
                        } else {
                            field_h
                        },
                        hwnd,
                        (FIELD_BASE + slots.len() as i32) as isize,
                        hinstance,
                        std::ptr::null(),
                    )
                };
                unsafe { SendMessageW(control, WM_SETFONT, body as WPARAM, 1) };
                // 字段面圆角：`EDIT` / `COMBOBOX` 是系统控件、天生直角，而 mac 设置窗
                // 的字段是圆角面 —— 贴 `radii.sm` 区域后与输入框/按钮同一口径。
                // 症状（2026-10-07 用户实拍「设置页那些字段有莫名其妙的白底矩形」）：
                // 纯白直角面压在渐变窗底上，上白下灰像是随机贴上去的方块。
                if is_field_surface(&field.kind) {
                    apply_field_region(control, field_w, field_h, scale);
                }
                if matches!(field.kind, FieldKind::Bool) {
                    // 圆角 = 半高（设计 `.sw` 的胶囊）；样式位已在创建时给。
                    paint_win::install_button(control, scaled(SWITCH_H / 2, scale));
                    SWITCH_STATES.with(|states| {
                        states.borrow_mut().register(control as isize, false);
                    });
                }
                if let FieldKind::NumberChoice { options } = field.kind {
                    // 高亮档按草稿现值取最近档（值缺失 = 无高亮）；呈现状态放镜像表
                    //（绘制期读它，不碰 STATE）。
                    let selected = number_choice_selected(
                        options,
                        settings_ui()
                            .view()
                            .values
                            .get(field.key)
                            .and_then(SettingsValue::as_number),
                    );
                    register_number_choice(control, options, selected);
                    // 整组一个圆角区域（`radii.btn`）；悬浮跟踪由 `install_button` 的子类承担。
                    paint_win::install_button(
                        control,
                        scaled(theme::tokens().radii.btn.round() as i32, scale),
                    );
                }
                if matches!(
                    field.kind,
                    FieldKind::Enum(_)
                        | FieldKind::FontFamily
                        | FieldKind::CardChoice
                        | FieldKind::ProfileChoice
                ) {
                    set_combo_heights(control, field_h, scale);
                }
                if matches!(field.kind, FieldKind::Action | FieldKind::Shortcut) {
                    // schema 驱动的动作按钮 / 快捷键录制按钮：全面自绘的普通面
                    // （ownerdraw + 悬浮/圆角子类；角色 Normal）。
                    unsafe {
                        make_themed_button(
                            control,
                            ButtonRole::Normal,
                            scale,
                            theme::tokens().radii.btn,
                        )
                    };
                }
                slots.push(WinSlot {
                    hwnd: control,
                    key: Some(field.key),
                    kind: Some(field.kind),
                    x: ctrl_x,
                    y: ctrl_y,
                    w: field_w,
                    h: field_h,
                    font_base: 13,
                    // 字段控件自身不记录字色：ownerdraw 按钮的 GWLP_USERDATA 被角色占用；
                    // STATIC / 只读 EDIT 经 WM_CTLCOLORSTATIC、可编辑 EDIT 经
                    // WM_CTLCOLOREDIT（`windows.rs` 的 `aux_wndproc` 转发，见 `edit_ctlcolor`）
                    // 按 tokens 现场取色，下拉由 `WM_DRAWITEM` 自绘。
                    role: None,
                });
                if matches!(field.kind, FieldKind::Text { secret: true }) {
                    // 揭示按钮：与编辑框同排、放右侧；遮蔽字符在建控件时读回默认值
                    // （`EM_GETPASSWORDCHAR`），复遮蔽写回同一字符。
                    let password_char =
                        unsafe { SendMessageW(control, EM_GETPASSWORDCHAR, 0, 0) as usize };
                    let button = unsafe {
                        CreateWindowExW(
                            0,
                            wide("BUTTON").as_ptr(),
                            wide("显示").as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
                            0,
                            0,
                            SECRET_BTN_W,
                            ROW_H,
                            hwnd,
                            (SECRET_ID_BASE + state.secret_pairs.len() as i32) as isize,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(button, WM_SETFONT, body as WPARAM, 1) };
                    // 全面自绘：揭示按钮也是普通面（ownerdraw + 悬浮/圆角子类）。
                    unsafe {
                        make_themed_button(
                            button,
                            ButtonRole::Normal,
                            scale,
                            theme::tokens().radii.btn,
                        )
                    };
                    slots.push(WinSlot {
                        hwnd: button,
                        key: None,
                        kind: None,
                        // 贴控件组右缘（与输入框同一右缘）：窄窗口下按钮不被挤出内容区。
                        x: ctrl_x + ctrl_w - SECRET_BTN_W,
                        y: ctrl_y,
                        w: SECRET_BTN_W,
                        h: ROW_H,
                        font_base: 13,
                        role: None,
                    });
                    state.secret_pairs.push(WinSecretPair {
                        edit: control,
                        button,
                        revealed: false,
                        // ES_PASSWORD 控件的默认遮蔽字符（读不到时回落 ● U+25CF）。
                        password_char: if password_char == 0 {
                            0x25CF
                        } else {
                            password_char
                        },
                    });
                }
                // 左块文案：标签之下的帮助（换行）+ 动态提示一行；Action 行无标签，
                // 帮助直接从行首起（与 macOS 的 `block_y` 同式）。
                let mut block_y = if matches!(field.kind, FieldKind::Action) {
                    y + 2
                } else {
                    y + label_h + 2
                };
                if help_h > 0 {
                    let help = unsafe {
                        CreateWindowExW(
                            0,
                            wide("STATIC").as_ptr(),
                            wide(field.help).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                            MARGIN,
                            0,
                            label_w,
                            help_h,
                            hwnd,
                            0,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(help, WM_SETFONT, small as WPARAM, 1) };
                    stamp_text(help, TextRole::Hint);
                    slots.push(WinSlot {
                        hwnd: help,
                        key: None,
                        kind: None,
                        x: MARGIN,
                        y: block_y,
                        w: label_w,
                        h: help_h,
                        font_base: 11,
                        role: Some(TextRole::Hint),
                    });
                    block_y += help_h + 2;
                }
                // 动态帮助行（如 Bash 白名单计数）：静态 help 下一行，刷新时按草稿重算。
                if let Some(text) = dynamic_hint {
                    let hint = unsafe {
                        CreateWindowExW(
                            0,
                            wide("STATIC").as_ptr(),
                            wide(&text).as_ptr(),
                            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                            MARGIN,
                            0,
                            label_w,
                            hint_h,
                            hwnd,
                            0,
                            hinstance,
                            std::ptr::null(),
                        )
                    };
                    unsafe { SendMessageW(hint, WM_SETFONT, small as WPARAM, 1) };
                    stamp_text(hint, TextRole::Hint);
                    slots.push(WinSlot {
                        hwnd: hint,
                        key: None,
                        kind: None,
                        x: MARGIN,
                        y: block_y,
                        w: label_w,
                        h: hint_h,
                        font_base: 11,
                        role: Some(TextRole::Hint),
                    });
                    state.dynamic_hints.push((hint, field.key));
                }
                // 行高推进收口到一处（行内元素不再各自推进 y）。
                y += row_h + ROW_GAP;
            }
            y += SECTION_GAP;
        }
        state.slots = slots;
        // 管理面（工具页 / 记忆页）：先释放旧 Tab 的面板控件，再按当前代数重建。
        state.panel_base_y = y;
        destroy_panel_area(state);
        build_panel_controls(state);
        rust_info!(
            "设置页重建：销毁旧控件 {rebuild_from} 个，新建 {} 个（Tab={}）",
            state.slots.len(),
            TABS[state.tab].id
        );
    });
}

// ==========================================
// 管理面（工具页 / 记忆页）
// ==========================================

/// 一个管理面板（标题 + 可选刷新 + 说明 + 错误/告警 + 行）；返回新的 y。
#[allow(clippy::too_many_arguments)]
pub(super) fn build_panel(
    state: &mut SettingsState,
    panel: &ListPanel,
    refresh: Option<i32>,
    content_w: i32,
    mut y: i32,
    body: HFONT,
    small: HFONT,
    bold: HFONT,
) -> i32 {
    let title_w = if refresh.is_some() {
        content_w - 90
    } else {
        content_w
    };
    create_panel_control(
        state,
        "STATIC",
        panel.title,
        MARGIN,
        y,
        title_w.max(120),
        20,
        bold,
        13,
        Some(TextRole::Body),
        0,
        0,
    );
    let scale = dpi_scale(state.hwnd);
    if let Some(page) = refresh {
        let button = create_panel_control(
            state,
            "BUTTON",
            "刷新",
            MARGIN + content_w - PANEL_BTN_W,
            y - 2,
            PANEL_BTN_W,
            26,
            body,
            13,
            None,
            0,
            PANEL_REFRESH_ID_BASE + page,
        );
        style_button(SettingsButton::PanelRefresh, button, scale);
    }
    y += 24;
    create_panel_control(
        state,
        "STATIC",
        &panel.hint,
        MARGIN,
        y,
        content_w,
        32,
        small,
        11,
        Some(TextRole::Hint),
        0,
        0,
    );
    y += 34;
    // 错误与警告各取自己的 token（`danger` / `warn`，见 paint_win::text_color）。
    if let Some(error) = &panel.error {
        create_panel_control(
            state,
            "STATIC",
            error,
            MARGIN,
            y,
            content_w,
            32,
            small,
            11,
            Some(TextRole::Error),
            0,
            0,
        );
        y += 34;
    } else if let Some(warning) = &panel.warning {
        create_panel_control(
            state,
            "STATIC",
            warning,
            MARGIN,
            y,
            content_w,
            32,
            small,
            11,
            Some(TextRole::Warning),
            0,
            0,
        );
        y += 34;
    }
    if panel.error.is_none() && panel.rows.is_empty() {
        let text = if panel.loaded {
            "（没有条目）"
        } else {
            "读取中…"
        };
        create_panel_control(
            state,
            "STATIC",
            text,
            MARGIN,
            y,
            content_w,
            16,
            small,
            11,
            Some(TextRole::Hint),
            0,
            0,
        );
        y += 18;
    }
    for row in &panel.rows {
        // 逐行累加：`build_panel_row` 曾返回行高常量，`y =` 赋值把第 2 行起的
        // 所有行都叠到同一个 y（与 macOS 侧同款缺陷，2026-10-05 对称修复）。
        // 行高不 +30 时长副标题会压到下一行；档位收口在 `panel_row_advance`
        // （下拉行 subtitle 恒空 = 单行紧凑，不为下拉加高）。
        build_panel_row(state, panel.id, row, content_w, y, body, small);
        y += panel_row_advance(&row.subtitle);
    }
    y + SECTION_GAP
}

/// 「已记住」分页行（`上一页` / `第 x / y 页 · 共 N 条` / `下一页`）。
///
/// 只在列表非空时由调用方渲染（空态沿用面板的「（没有条目）」文案）；页码与
/// 两枚按钮的可用性来自共享层的 [`MemoryPager`]（平台不自行算页数）。
/// 首页/末页对应按钮 `EnableWindow(0)`：ownerdraw 面在 `WM_DRAWITEM` 里按
/// `ODS_DISABLED` 画禁用档（见 `on_drawitem`），不需要另贴一次面。
/// **未实机验证**（本机编不出 Windows 分支，见 native-host AGENTS §2）。
pub(super) fn build_memory_pager(
    state: &mut SettingsState,
    content_w: i32,
    y: i32,
    pager: &MemoryPager,
    body: HFONT,
    small: HFONT,
) -> i32 {
    let scale = dpi_scale(state.hwnd);
    let prev = create_panel_control(
        state,
        "BUTTON",
        "上一页",
        MARGIN,
        y,
        PANEL_BTN_W,
        26,
        body,
        13,
        None,
        0,
        MEMORY_PAGE_ID_BASE + MEMORY_PAGE_PREV,
    );
    let next = create_panel_control(
        state,
        "BUTTON",
        "下一页",
        MARGIN + content_w - PANEL_BTN_W,
        y,
        PANEL_BTN_W,
        26,
        body,
        13,
        None,
        0,
        MEMORY_PAGE_ID_BASE + MEMORY_PAGE_NEXT,
    );
    style_button(SettingsButton::MemoryPager, prev, scale);
    style_button(SettingsButton::MemoryPager, next, scale);
    unsafe {
        EnableWindow(prev, pager.prev_enabled as i32);
        EnableWindow(next, pager.next_enabled as i32);
    }
    // 中间文本水平居中（SS_CENTER），横向吃两枚按钮之间的剩余宽度。
    create_panel_control(
        state,
        "STATIC",
        &pager.label,
        MARGIN + PANEL_BTN_W + 8,
        y + 5,
        (content_w - (PANEL_BTN_W + 8) * 2).max(60),
        18,
        small,
        11,
        Some(TextRole::Hint),
        SS_CENTER,
        0,
    );
    y + 34
}

pub(super) fn row_main_kind(action: RowAction) -> RowMainKind {
    match action {
        RowAction::Pick => RowMainKind::Pick,
        RowAction::Toggle
        | RowAction::Select
        | RowAction::Preview
        | RowAction::Credential
        | RowAction::Cancel
        | RowAction::Resume
        | RowAction::Choose => RowMainKind::Button,
        RowAction::Edit | RowAction::Delete | RowAction::None => RowMainKind::None,
    }
}

/// 行主按钮文案（纯函数，可测）。`Pick` 行不渲染按钮（主控件是行内下拉），与
/// `row_main_kind` 的 `Pick` 分支互证 —— 下拉行不许落到空标题按钮上。
pub(super) fn row_button_title(action: RowAction, enabled: bool) -> &'static str {
    match action {
        RowAction::Toggle => {
            if enabled {
                "已启用"
            } else {
                "已关闭"
            }
        }
        RowAction::Select => "查看",
        RowAction::Preview => "试听",
        // 凭据输入行：主按钮打开原生输入框（值写入应用自有存储）。
        RowAction::Credential => "设置",
        // 记忆作业行：取消 / 继续（行出现哪个动作由 Node 按作业状态投影）。
        RowAction::Cancel => "取消",
        RowAction::Resume => "继续",
        // 备份列表行：选中态由共享层叠加在 `enabled` 上（选择是 UI 状态）。
        RowAction::Choose => {
            if enabled {
                "已选中"
            } else {
                "选择"
            }
        }
        RowAction::Pick | RowAction::Edit | RowAction::Delete | RowAction::None => "",
    }
}

/// 行次按钮（`action2`）文案（纯函数，可测）：试听是音效事件行的次动作
/// （静音行不带 action2，不渲染）；其余未登记的次动作恒为空。
pub(super) fn row_secondary_title(action: RowAction) -> &'static str {
    match action {
        RowAction::Edit => "编辑",
        RowAction::Delete => "删除",
        RowAction::Preview => "试听",
        _ => "",
    }
}

/// 一行：标题 + 副标题（最多三行，超出裁切）+ 主控件（按钮/行内下拉）+ 次按钮。
fn build_panel_row(
    state: &mut SettingsState,
    panel: &'static str,
    row: &PanelRow,
    content_w: i32,
    y: i32,
    body: HFONT,
    small: HFONT,
) {
    let has_secondary = row.secondary != RowAction::None;
    // 主控件宽度：下拉行按下拉档（`PANEL_PICK_W`），按钮行/无主控件行按按钮档。
    let main_kind = row_main_kind(row.action);
    let main_w = if main_kind == RowMainKind::Pick {
        PANEL_PICK_W
    } else {
        PANEL_BTN_W
    };
    let buttons_w = if has_secondary {
        main_w + PANEL_BTN_W + 4
    } else {
        main_w
    };
    let text_w = (content_w - buttons_w - 8).max(120);
    state.row_backgrounds.push(paint_win::Rect::new(
        MARGIN,
        y,
        content_w,
        panel_row_advance(&row.subtitle) - 6,
    ));
    let title = create_panel_control(
        state,
        "STATIC",
        &row.title,
        MARGIN,
        y + 1,
        text_w,
        18,
        body,
        13,
        Some(TextRole::Body),
        0,
        0,
    );
    ROW_LABELS.with(|labels| labels.borrow_mut().insert(title));
    if !row.subtitle.is_empty() {
        // 副标题最多两行（框高 30 = 2×行高；STATIC 自动换行，超高裁切）——
        // 与 macOS `build_panel_row` 的 `wrapped_label(..., 2)` 同规格（2026-10-06 收紧）。
        let subtitle = create_panel_control(
            state,
            "STATIC",
            &row.subtitle,
            MARGIN,
            y + 19,
            text_w,
            30,
            small,
            11,
            Some(TextRole::Hint),
            0,
            0,
        );
        ROW_LABELS.with(|labels| labels.borrow_mut().insert(subtitle));
    }
    let scale = dpi_scale(state.hwnd);
    let mut button_x = MARGIN + content_w - main_w;
    if has_secondary {
        // 次动作在左、主动作在右（编辑/删除走专用入口与原生确认；试听播当前分配）。
        let secondary_title = row_secondary_title(row.secondary);
        let index = state.row_slots.len() as i32;
        button_x -= PANEL_BTN_W + 4;
        let secondary = create_panel_control(
            state,
            "BUTTON",
            secondary_title,
            button_x,
            y + 6,
            PANEL_BTN_W,
            26,
            body,
            13,
            None,
            0,
            ROW_ID_BASE + index,
        );
        style_button(SettingsButton::RowSecondary, secondary, scale);
        state.row_slots.push(WinRowSlot {
            panel,
            row_id: row.id.clone(),
            action: row.secondary,
            control: secondary,
            pick_values: Vec::new(),
        });
        button_x += PANEL_BTN_W + 4;
    }
    match main_kind {
        RowMainKind::Pick => build_panel_pick(state, panel, row, button_x, y, body, scale),
        RowMainKind::Button => {
            let button_title = row_button_title(row.action, row.enabled);
            // 空标题到这里是形态表与文案表失配（防御跳过，不建无字按钮）。
            if !button_title.is_empty() {
                let index = state.row_slots.len() as i32;
                let primary = create_panel_control(
                    state,
                    "BUTTON",
                    button_title,
                    button_x,
                    y + 6,
                    PANEL_BTN_W,
                    26,
                    body,
                    13,
                    None,
                    0,
                    ROW_ID_BASE + index,
                );
                style_button(SettingsButton::RowPrimary, primary, scale);
                state.row_slots.push(WinRowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    control: primary,
                    pick_values: Vec::new(),
                });
            }
        }
        RowMainKind::None => {}
    }
}

/// 行内下拉主控件（`RowAction::Pick`）：复用字段区下拉的自绘机制
/// （`CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED` + `WM_DRAWITEM`），条目文案 = 选项
/// label，字段区显示当前选中项（找不到回退第一项）；下拉箭头由系统绘制，
/// 不额外在文案里拼「▾」（否则列表条目也会带上箭头字形）。
///
/// 选中归宿：`on_command` 的 [`pick_change_is_final`] 分支按 `CB_GETCURSEL`
/// 下标从 [`WinRowSlot::pick_values`] 还原 `value` 后走 `pick_panel_row`。
fn build_panel_pick(
    state: &mut SettingsState,
    panel: &'static str,
    row: &PanelRow,
    x: i32,
    y: i32,
    font: HFONT,
    scale: f64,
) {
    let Some(pick) = &row.pick else {
        // 共享层已保证 pick 载荷与动作成对（不成对解析报错）；这里防御不建控件，
        // 不留一颗点不动的空下拉。
        rust_warn!("行 {} 是下拉动作但没有 pick 载荷（不渲染）", row.id);
        return;
    };
    let index = state.row_slots.len() as i32;
    let combo = create_panel_control(
        state,
        "COMBOBOX",
        "",
        x,
        y + 6,
        PANEL_PICK_W,
        26,
        font,
        13,
        None,
        COMBO_STYLE,
        ROW_ID_BASE + index,
    );
    // 字段区与条目同高（与字段区下拉同创建口径，见样式处的注释）。
    set_combo_heights(combo, 26, scale);
    for option in &pick.options {
        unsafe {
            SendMessageW(
                combo,
                CB_ADDSTRING,
                0,
                wide(&option.label).as_ptr() as isize,
            )
        };
    }
    // 选中值不在选项表时回退第一项（只影响呈现；不写回、不改选中值）。
    let selected = pick_selected_index(pick);
    unsafe { SendMessageW(combo, CB_SETCURSEL, selected, 0) };
    state.row_slots.push(WinRowSlot {
        panel,
        row_id: row.id.clone(),
        action: row.action,
        control: combo,
        pick_values: pick
            .options
            .iter()
            .map(|option| option.value.clone())
            .collect(),
    });
}

/// 记忆详情区（四态：未选中 / 读取中 / 失败 / 就绪）；返回新的 y。
pub(super) fn build_memory_detail(
    state: &mut SettingsState,
    content_w: i32,
    mut y: i32,
    body: HFONT,
    small: HFONT,
    bold: HFONT,
) -> i32 {
    match settings_ui().memory_detail_state() {
        MemoryDetailState::None => y,
        MemoryDetailState::Loading => {
            create_panel_control(
                state,
                "STATIC",
                "条目详情读取中…",
                MARGIN,
                y,
                content_w,
                16,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y + 18
        }
        MemoryDetailState::Error(error) => {
            // 读取失败是如实展示的错误诊断：取 `danger`。
            create_panel_control(
                state,
                "STATIC",
                &error,
                MARGIN,
                y,
                content_w,
                32,
                small,
                11,
                Some(TextRole::Error),
                0,
                0,
            );
            y + 34
        }
        MemoryDetailState::Ready(detail) => {
            create_panel_control(
                state,
                "STATIC",
                "条目详情与纠正",
                MARGIN,
                y,
                content_w,
                20,
                bold,
                13,
                Some(TextRole::Body),
                0,
                0,
            );
            y += 24;
            // 只读信息块（多行 EDIT + 只读）。
            let info = create_panel_control(
                state,
                "EDIT",
                &detail.info,
                MARGIN,
                y,
                content_w,
                DETAIL_INFO_H,
                small,
                11,
                None,
                ES_READONLY as u32 | WS_VSCROLL,
                -1,
            );
            let _ = info;
            y += DETAIL_INFO_H + 6;
            // 内容编辑框（纠正草稿）。
            let content = create_panel_control(
                state,
                "EDIT",
                &detail.content,
                MARGIN,
                y,
                content_w,
                DETAIL_EDIT_H,
                body,
                13,
                None,
                WS_VSCROLL,
                -2,
            );
            state.detail_content = content;
            y += DETAIL_EDIT_H + 6;
            // 动作按钮：保存纠正 / 核心画像标记 / 忘记这条。
            let pin_title = if detail.pinned {
                "移出核心画像"
            } else {
                "加入核心画像"
            };
            let mut x = MARGIN;
            let buttons: [(&str, i32, SettingsButton, i32); 3] = [
                (
                    "保存纠正",
                    DETAIL_ACTION_SAVE,
                    SettingsButton::SaveCorrection,
                    90,
                ),
                (pin_title, DETAIL_ACTION_PIN, SettingsButton::MemoryPin, 110),
                (
                    "忘记这条",
                    DETAIL_ACTION_FORGET,
                    SettingsButton::MemoryForget,
                    90,
                ),
            ];
            let scale = dpi_scale(state.hwnd);
            for (label_text, action, kind, w) in buttons {
                let button = create_panel_control(
                    state,
                    "BUTTON",
                    label_text,
                    x,
                    y,
                    w,
                    26,
                    body,
                    13,
                    None,
                    0,
                    DETAIL_ID_BASE + action,
                );
                style_button(kind, button, scale);
                x += w + 8;
            }
            y += 30;
            create_panel_control(
                state,
                "STATIC",
                "忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。",
                MARGIN,
                y,
                content_w,
                32,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y += 34;
            create_panel_control(
                state,
                "STATIC",
                "历史版本与来源审计",
                MARGIN,
                y,
                content_w,
                20,
                bold,
                13,
                Some(TextRole::Body),
                0,
                0,
            );
            y += 24;
            if detail.history.is_empty() {
                create_panel_control(
                    state,
                    "STATIC",
                    "没有可显示的历史版本。",
                    MARGIN,
                    y,
                    content_w,
                    16,
                    small,
                    11,
                    Some(TextRole::Hint),
                    0,
                    0,
                );
                y += 18;
            }
            for row in &detail.history {
                create_panel_control(
                    state,
                    "STATIC",
                    &row.title,
                    MARGIN,
                    y + 1,
                    content_w,
                    18,
                    body,
                    13,
                    Some(TextRole::Body),
                    0,
                    0,
                );
                if !row.subtitle.is_empty() {
                    create_panel_control(
                        state,
                        "STATIC",
                        &row.subtitle,
                        MARGIN,
                        y + 19,
                        content_w,
                        30,
                        small,
                        11,
                        Some(TextRole::Hint),
                        0,
                        0,
                    );
                }
                y += 52;
            }
            y + SECTION_GAP
        }
    }
}

/// 展开中的来源原话块（固定高度只读 EDIT；三态由共享层给坐标）；返回新的 y。
pub(super) fn build_memory_evidence(
    state: &mut SettingsState,
    content_w: i32,
    mut y: i32,
    small: HFONT,
) -> i32 {
    let Some(evidence) = settings_ui().memory_evidence_state() else {
        return y;
    };
    match evidence {
        MemoryEvidenceState::Loading { .. } => {
            create_panel_control(
                state,
                "STATIC",
                "正在读取来源原话…",
                MARGIN,
                y,
                content_w,
                16,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y + 18
        }
        MemoryEvidenceState::Error { error, .. } => {
            // 读取失败是如实展示的错误诊断：取 `danger`。
            create_panel_control(
                state,
                "STATIC",
                &error,
                MARGIN,
                y,
                content_w,
                32,
                small,
                11,
                Some(TextRole::Error),
                0,
                0,
            );
            y + 34
        }
        MemoryEvidenceState::Ready { source_id, text } => {
            create_panel_control(
                state,
                "STATIC",
                &format!("已展开 {source_id} 的原话（再点该行收起）"),
                MARGIN,
                y,
                content_w,
                16,
                small,
                11,
                Some(TextRole::Hint),
                0,
                0,
            );
            y += 18;
            create_panel_control(
                state,
                "EDIT",
                &text,
                MARGIN,
                y,
                content_w,
                MEMORY_EVIDENCE_H,
                small,
                11,
                None,
                ES_READONLY as u32 | WS_VSCROLL,
                // 负数 = 无命令 id（只读展示，不进行槽；与详情 info 块同一约定）。
                -3,
            );
            y + MEMORY_EVIDENCE_H + 6
        }
    }
}

/// 浮层字体（0 = 未设置，绘制/量尺寸按系统默认字体兜底）。
pub(super) fn notice_font() -> HFONT {
    NOTICE_FONT.with(Cell::get)
}

/// 浮层几何（纯函数，物理像素输入输出；`scale` = 窗口 DPI 缩放）。
///
/// 宽度 = 文本量得宽 + 2×内边距（上下限：`NOTICE_MIN_W` .. 客户区宽 − 2×MARGIN），
/// 高度 = 文本高 + 2×内边距；水平居中于窗口客户区、纵向贴 `NOTICE_TOP`
/// （居中口径与最小宽度与 macOS `show_toast` 同值）。返回 (x, y, w, h)。
pub(super) fn notice_overlay_geometry(
    measured: (i32, i32),
    client_w: i32,
    scale: f64,
) -> (i32, i32, i32, i32) {
    let (text_w, text_h) = measured;
    let margin = scaled(MARGIN, scale);
    let pad_x = scaled(NOTICE_PAD_X, scale);
    let pad_y = scaled(NOTICE_PAD_Y, scale);
    let max_w = (client_w - margin * 2).max(scaled(60, scale));
    let w = (text_w + pad_x * 2)
        .max(scaled(NOTICE_MIN_W, scale))
        .min(max_w);
    let h = text_h + pad_y * 2;
    let x = ((client_w - w) / 2).max(0);
    let y = scaled(NOTICE_TOP, scale);
    (x, y, w, h)
}

/// 通知分档呈现（`refresh_ui` 的最后一环；必须在 `with_state` 借用之外调用）。
pub(super) fn present_notice(view: &SettingsView) {
    let Some(text) = view.notice.as_deref().filter(|text| !text.is_empty()) else {
        // 清空通知不呈现（`SettingsUi::set_notice_with` 只在非空时推进代际）。
        return;
    };
    let action = with_state(|state| {
        notice_action(
            view.notice_level,
            view.notice_generation,
            state.presented_generation,
        )
    });
    match action {
        Some(NoticeAction::None) => {}
        Some(NoticeAction::Modal) => {
            let modal_up = with_state(|state| state.notice_modal_up).unwrap_or(true);
            if modal_up {
                // 已有模态（错误弹窗 / 文档弹窗）在显：不抢弹、代际不记账 ——
                // 收尾后的下一次刷新补呈现（与 macOS 同规）。
                return;
            }
            let Some(settings_hwnd) = with_state(|state| state.hwnd) else {
                return;
            };
            with_state(|state| state.presented_generation = view.notice_generation);
            with_state(|state| state.notice_modal_up = true);
            show_error_modal(settings_hwnd, text);
            with_state(|state| state.notice_modal_up = false);
        }
        Some(NoticeAction::Toast) => {
            with_state(|state| {
                state.presented_generation = view.notice_generation;
                show_notice_overlay(state, text, view.notice_level);
            });
        }
        None => {} // 设置窗未开：本次不呈现（重开时按当时通知重新判新）
    }
}

/// 错误档模态：`MessageBoxW`（属主 = 设置窗；模态期属主禁用 = 应用内模态，必须确认）。
///
/// 返回值不参与决策：只有「确定」一个按钮。设置窗是 `WS_EX_TOPMOST` 的层级窗，
/// 系统把以它为属主的对话框提升到属主之上（与编辑器关闭确认同口径）。
/// 标题与 macOS `present_error_modal` 同文案；按钮文案是系统「确定」（macOS 为「知道了」），
/// 系统对话框给不了自定义按钮文案，就地登记。
fn show_error_modal(settings_hwnd: HWND, text: &str) {
    unsafe {
        MessageBoxW(
            settings_hwnd,
            wide(text).as_ptr(),
            wide("设置操作未完成").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// 显示/替换顶部浮层（Info/Warning）：懒创建 → 写入文本与档位 → 量尺寸摆位 → 重开计时。
///
/// 新的一条必须**重新计时**：先撤旧计时器再设新的（代际判新已经保证「同文重申」
/// 会走到这里，计时不能靠文本变化）。
fn show_notice_overlay(state: &mut SettingsState, text: &str, level: NoticeLevel) {
    if state.notice_overlay == 0 {
        match create_notice_overlay(state) {
            Some(overlay) => {
                state.notice_overlay = overlay;
                // 成功即解除降级（曾失败过也不让状态行继续兜底显示通知）。
                state.notice_overlay_failed = false;
            }
            None => {
                // 降级：浮层建不出来时通知回落到状态行（留痕在 create_notice_overlay）。
                state.notice_overlay_failed = true;
                return;
            }
        }
    }
    let overlay = state.notice_overlay;
    let scale = dpi_scale(state.hwnd);
    unsafe {
        SetWindowTextW(overlay, wide(text).as_ptr());
        SetWindowLongPtrW(overlay, GWLP_USERDATA, notice_level_code(level));
        KillTimer(overlay, NOTICE_TIMER_ID);
        let (client_w, _) = client_size(state.hwnd);
        let max_text_w = scaled(NOTICE_MAX_TEXT_W, scale);
        let measured = measure_notice_text(text, max_text_w);
        state.notice_measured = measured;
        let (x, y, w, h) = notice_overlay_geometry(measured, client_w, scale);
        MoveWindow(overlay, x, y, w, h, 1);
        refresh_notice_region(overlay, scale);
        // 子窗口显示不抢焦点；置顶（HWND_TOP）保证在兄弟控件之上。
        ShowWindow(overlay, SW_SHOWNA);
        SetWindowPos(
            overlay,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        InvalidateRect(overlay, std::ptr::null(), 1);
        SetTimer(
            overlay,
            NOTICE_TIMER_ID,
            NOTICE_TOAST_MS,
            Some(notice_timer_proc),
        );
    }
}

/// 懒创建浮层（设置窗的子窗口；失败返回 None 并在统一日志留痕）。
fn create_notice_overlay(state: &mut SettingsState) -> Option<HWND> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(NOTICE_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(notice_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出（与输入弹窗同规）。
    unsafe { RegisterClassW(&wc) };
    let overlay = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("").as_ptr(),
            // 初始隐藏（WS_VISIBLE 由 ShowWindow 加上）；WS_CLIPSIBLINGS 让更下层
            // 兄弟控件不画进浮层区域（见安装处的样式说明）。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            state.hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if overlay == 0 {
        rust_warn!("通知浮层创建失败，通知回落到状态行显示");
        return None;
    }
    // 浮层用设置窗的说明字号（与状态行同档；字体变化由 `apply_font` 重发）。
    let font = *state.fonts.get(1).unwrap_or(&0);
    if font != 0 {
        unsafe { SendMessageW(overlay, WM_SETFONT, font as WPARAM, 1) };
    }
    Some(overlay)
}

/// 量浮层文本（`DT_CALCRECT` + `DT_WORDBREAK`）：浮层字体下按最大宽度折行后的实际尺寸。
fn measure_notice_text(text: &str, max_w: i32) -> (i32, i32) {
    unsafe {
        let hdc = CreateCompatibleDC(0);
        if hdc == 0 {
            // 量不到时给一个保守的单行尺寸（几何函数的上下限会收口）。
            return (max_w.min(160), 18);
        }
        let font = notice_font();
        let old = if font != 0 {
            SelectObject(hdc, font)
        } else {
            0
        };
        let mut rect: RECT = std::mem::zeroed();
        rect.right = max_w.max(1);
        DrawTextW(
            hdc,
            wide(text).as_ptr(),
            -1,
            &mut rect,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
        );
        if old != 0 {
            SelectObject(hdc, old);
        }
        DeleteDC(hdc);
        (
            (rect.right - rect.left).max(1),
            (rect.bottom - rect.top).max(1),
        )
    }
}

/// 浮层圆角区域（半径随主题 `radii.btn`；`SetWindowRgn` 成功后区域归系统所有）。
/// 字段面（承载输入/下拉的系统控件）判据：这些控件的窗口天生直角，需要
/// [`apply_field_region`] 贴圆角区域才能与 mac 设置窗的圆角字段同形
/// （2026-10-07 用户实拍「字段有莫名其妙的白底矩形」）。
///
/// 单一定义点：创建路径与换主题重贴路径共用，避免两处各列一遍字段种类。
fn is_field_surface(kind: &FieldKind) -> bool {
    matches!(
        kind,
        FieldKind::Text { .. }
            | FieldKind::Number { .. }
            | FieldKind::Multiline
            | FieldKind::Enum(_)
            | FieldKind::FontFamily
            | FieldKind::CardChoice
            | FieldKind::ProfileChoice
    )
}

/// 字段面圆角区域（半径随主题 `radii.sm`；`SetWindowRgn` 成功后区域归系统所有）。
///
/// 尺寸取**物理像素**的字段可见区（下拉列表是独立窗口，区域只按字段区给即可）。
/// 失败不致命：区域建不出来或系统拒收时控件退化为直角 —— 逐字段（创建 / 换主题
/// 重贴）回落，2026-10-08 起静默降噪（稳态留痕会随重建刷屏，见各回落后注释；
/// 通知浮层 [`apply_notice_region`] 是一次性窗口，仍留 warning）。
fn apply_field_region(control: HWND, w: i32, h: i32, scale: f64) {
    if control == 0 || w <= 0 || h <= 0 {
        return;
    }
    let radius = scaled(theme::tokens().radii.sm.round() as i32, scale).max(0);
    let region = unsafe { CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2) };
    if region == 0 {
        // 逐字段回落（创建 / 换主题重贴期；本字段退化为直角）：静默——降噪 2026-10-08
        // 用户裁定（稳态留痕会随重建刷屏）；绘制端回落由实机像素取证覆盖。
        return;
    }
    if unsafe { SetWindowRgn(control, region, 1) } == 0 {
        // 失败时区域仍归调用方，必须自行释放（成功时系统接管）。
        unsafe { DeleteObject(region) };
        // 逐字段回落（创建 / 换主题重贴期；本字段退化为直角）：静默——降噪 2026-10-08
        // 用户裁定（稳态留痕会随重建刷屏）；绘制端回落由实机像素取证覆盖。
    }
}

fn apply_notice_region(overlay: HWND, w: i32, h: i32, scale: f64) {
    if overlay == 0 || w <= 0 || h <= 0 {
        return;
    }
    let radius = scaled(theme::tokens().radii.btn.round() as i32, scale).max(0);
    let region = unsafe { CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2) };
    if region == 0 {
        rust_warn!("通知浮层的圆角区域创建失败（本次显示为直角）");
        return;
    }
    if unsafe { SetWindowRgn(overlay, region, 1) } == 0 {
        // 失败时区域仍归调用方，必须自行释放（成功时系统接管）。
        unsafe { DeleteObject(region) };
        rust_warn!("通知浮层的圆角区域设置失败（本次显示为直角）");
    }
}

/// 按浮层当前客户区重贴圆角区域（换主题半径变化与尺寸变化共用）。
fn refresh_notice_region(overlay: HWND, scale: f64) {
    if overlay == 0 {
        return;
    }
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(overlay, &mut client) };
    apply_notice_region(
        overlay,
        client.right - client.left,
        client.bottom - client.top,
        scale,
    );
}

/// 浮层绘制：`panel_bg` 做底 + 1px `bar_edge` 描边（在 `field_bg` 页底上明显分层；
/// 面与描边与 macOS `show_toast` 同源），文字 Info 取 `ink`、Warning 取 `warn`
/// （需求口径；与 macOS `toast_ink` 同表）。读 tokens 现值 —— 换主题后由
/// `apply_theme` 触发重绘，不留旧主题色。
pub(super) fn paint_notice_overlay(hwnd: HWND, hdc: HDC, text: &str, level: NoticeLevel) {
    let tokens = theme::tokens();
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut client) };
    let rect = paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top);
    if rect.is_empty() {
        return;
    }
    paint_win::fill_rect(hdc, rect, &tokens.panel_bg);
    paint_win::draw_frame(hdc, rect, tokens.bar_edge, &theme::Bevel::NONE);
    let ink = match level {
        // Error 不走浮层（模态档）；防御性归到主文字色。
        NoticeLevel::Info | NoticeLevel::Error => tokens.ink,
        NoticeLevel::Warning => tokens.warn,
    };
    let font = notice_font();
    let old = if font != 0 {
        unsafe { SelectObject(hdc, font) }
    } else {
        0
    };
    let scale = dpi_scale(hwnd);
    let pad_x = scaled(NOTICE_PAD_X, scale);
    let pad_y = scaled(NOTICE_PAD_Y, scale);
    let mut text_rect: RECT = unsafe { std::mem::zeroed() };
    text_rect.left = pad_x;
    text_rect.top = pad_y;
    text_rect.right = (rect.right() - pad_x).max(pad_x + 1);
    text_rect.bottom = (rect.bottom() - pad_y).max(pad_y + 1);
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, paint_win::colorref(ink));
        DrawTextW(
            hdc,
            wide(text).as_ptr(),
            -1,
            &mut text_rect,
            DT_WORDBREAK | DT_CENTER | DT_NOPREFIX,
        );
        if old != 0 {
            SelectObject(hdc, old);
        }
    }
}

pub(super) fn refresh_values(state: &mut SettingsState, view: &SettingsView) {
    let _syncing = ControlSyncGuard::begin();
    let connected = view.connected;
    for slot in state.slots.iter() {
        let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
            continue;
        };
        if kind.is_action() {
            unsafe { EnableWindow(slot.hwnd, 1) };
            continue;
        }
        // 聚焦中的编辑框不回声覆盖：用户输入在聚焦期间是权威（逐字置脏触发的刷新
        // 会把 clamp / 规范化后的值当场改写进控件，打字会被打断）；失焦提交后的
        // 下一次刷新再把规范化值写回。
        let editing = unsafe { GetFocus() == slot.hwnd }
            && matches!(
                kind,
                FieldKind::Number { .. } | FieldKind::Text { .. } | FieldKind::Multiline
            );
        if !editing {
            write_control(slot.hwnd, key, kind, view.values.get(key), view);
        }
        let editable = connected;
        unsafe { EnableWindow(slot.hwnd, if editable { 1 } else { 0 }) };
    }
    // 密钥揭示按钮不在字段槽的启用路径上：跟随连接态。
    for pair in state.secret_pairs.iter() {
        unsafe { EnableWindow(pair.button, if connected { 1 } else { 0 }) };
    }
    // 动态帮助行（如 Bash 白名单计数）：按草稿现值重算，提交后立即跟上。
    for (hint, key) in state.dynamic_hints.iter() {
        if let Some(text) = crate::ui::settings::dynamic_field_hint(key, &view.values) {
            unsafe { SetWindowTextW(*hint, wide(&text).as_ptr()) };
        }
    }
    // 状态行：不再承载通知（通知走浮层/模态，①），只留常驻的有信息量状态；
    // 浮层建不出来时（降级路径）才在这里兜底显示当前通知，不丢信息。
    if state.fixed.status != 0 {
        let text = if state.capturing_shortcut {
            "请按下新的组合键…（Esc 取消）".to_string()
        } else if !view.connected {
            "设置数据未接线（Node 设置读写端口就绪后自动生效）".to_string()
        } else if view.saving {
            "正在保存…".to_string()
        } else if !view.dirty.is_empty() {
            format!("有 {} 项未保存", view.dirty.len())
        } else if state.notice_overlay_failed {
            view.notice.clone().unwrap_or_default()
        } else {
            String::new()
        };
        unsafe { SetWindowTextW(state.fixed.status, wide(&text).as_ptr()) };
    }
    if state.fixed.save != 0 {
        let enabled = view.connected && !view.dirty.is_empty() && !view.saving;
        unsafe { EnableWindow(state.fixed.save, if enabled { 1 } else { 0 }) };
    }
    // 竖栏行按钮：按当前 Tab 贴选中/未选中面（幂等；换主题后由 apply_theme 再刷圆角）。
    for (index, button) in state.fixed.tab_buttons.iter().enumerate() {
        let role = if index == state.tab {
            ButtonRole::TabOn
        } else {
            ButtonRole::TabOff
        };
        paint_win::set_role(*button, role);
        unsafe { InvalidateRect(*button, std::ptr::null(), 1) };
    }
    // 管理面：数据代数变化时只重建面板区。
    sync_panels(state);
}

/// 快捷键的组合展示（Windows 键位名；未知修饰键名原样显示）。
pub(super) fn shortcut_display(view: &crate::ui::settings::SettingsView) -> String {
    let Some((key, modifiers)) =
        crate::ui::settings::shortcut_parts(&view.values, SHORTCUT_MODIFIERS_KEY)
    else {
        return "录制快捷键".to_string();
    };
    let mut parts: Vec<String> = modifiers
        .iter()
        .map(|modifier| match modifier.as_str() {
            "Control" => "Ctrl".to_string(),
            "Command" => "Win".to_string(),
            "Alt" => "Alt".to_string(),
            "Shift" => "Shift".to_string(),
            other => other.to_string(),
        })
        .collect();
    parts.push(key);
    parts.join("+")
}

/// 全局字体变化：替换字体后重算字段行高，旧字体等全部控件切换完成再释放。
pub(crate) fn apply_font() {
    let applied = with_state(|state| {
        let hwnd = state.hwnd;
        let scale = dpi_scale(hwnd);
        let body = make_font(scale, 13, false);
        let small = make_font(scale, 11, false);
        let bold = make_font(scale, 13, true);
        let old_fonts = std::mem::replace(&mut state.fonts, vec![body, small, bold]);
        let old_bold = old_fonts.get(2).copied().unwrap_or(0);
        for slot in state.slots.iter().chain(state.panel_slots.iter()) {
            let previous = unsafe { SendMessageW(slot.hwnd, WM_GETFONT, 0, 0) } as HFONT;
            let font = if previous != 0 && previous == old_bold {
                bold
            } else if slot.font_base <= 11 {
                small
            } else {
                body
            };
            unsafe { SendMessageW(slot.hwnd, WM_SETFONT, font as WPARAM, 1) };
        }
        // 下方 on_size 会按最新字体重建全部内容控件（标题仍用 bold，不退成正文）。
        state.content_width = -1;
        for hwnd in state.fixed.tab_buttons.iter() {
            // 竖栏行按钮的字号基线是「小号」（与 macOS 的 HELP_BASE_SIZE 同口径）。
            unsafe { SendMessageW(*hwnd, WM_SETFONT, small as WPARAM, 1) };
        }
        unsafe {
            SendMessageW(state.fixed.status, WM_SETFONT, small as WPARAM, 1);
            SendMessageW(state.fixed.refresh, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.fixed.save, WM_SETFONT, body as WPARAM, 1);
        }
        // 文档编辑弹窗（②）自持字体（与输入弹窗同规），不随这里重发；
        // 通知浮层（①）与设置窗共用字体句柄：重发字体，并按新度量重新摆位。
        if state.notice_overlay != 0 {
            let overlay = state.notice_overlay;
            unsafe { SendMessageW(overlay, WM_SETFONT, small as WPARAM, 1) };
            let text = window_text(overlay);
            let (client_w, _) = client_size(state.hwnd);
            let measured = measure_notice_text(&text, scaled(NOTICE_MAX_TEXT_W, scale));
            state.notice_measured = measured;
            let (x, y, w, h) = notice_overlay_geometry(measured, client_w, scale);
            unsafe { MoveWindow(overlay, x, y, w, h, 1) };
            refresh_notice_region(overlay, scale);
        }
        (hwnd, old_fonts)
    });
    if let Some((hwnd, old_fonts)) = applied {
        on_size(hwnd);
        for font in old_fonts {
            if font != 0 {
                unsafe { DeleteObject(font) };
            }
        }
        apply_theme();
    }
    rust_debug!("设置窗字体已按全局快照刷新");
}

