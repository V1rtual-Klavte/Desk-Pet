//! Windows 设置窗的窗口过程、消息处理与控件动作（自 `windows_settings.rs` 拆出）。

use super::*;
use super::dialogs::{confirm_dangerous, confirm_dangerous_for_key, sync_document_dialog};
use super::layout::{
    client_size, layout, number_choice_clicked_index, number_choice_selected,
    place_content_viewport, scroll_target,
};
use super::render::{
    draw_button_on_parent_backdrop, draw_combo_item, draw_focus_ring, draw_number_choice,
    notice_font, paint_content_background, paint_notice_overlay, present_notice, rebuild_tab,
    refresh_values, shortcut_display,
};

/// 内容面只画工作表底色，不画根窗的竖栏/页脚；全部控件通知仍走现有设置入口。
unsafe extern "system" fn content_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            on_command(GetParent(hwnd), wparam);
            0
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => on_ctlcolor(wparam, lparam),
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => edit_ctlcolor(wparam, lparam),
        WM_DRAWITEM if on_drawitem(lparam) => 1,
        WM_MEASUREITEM if lparam != 0 => {
            let item = &mut *(lparam as *mut MEASUREITEMSTRUCT);
            if item.CtlType == ODT_COMBOBOX {
                item.itemHeight = scaled(ROW_H, dpi_scale(hwnd)) as u32;
                return 1;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_VSCROLL => {
            // 多行 EDIT 自己的滚动条不会走这里；这里只接内容面自己的标准滚动条。
            if lparam == 0 {
                on_vscroll(GetParent(hwnd), wparam);
            }
            0
        }
        WM_MOUSEWHEEL => {
            on_mouse_wheel(GetParent(hwnd), wparam);
            0
        }
        WM_ERASEBKGND => {
            paint_content_background(hwnd, wparam as HDC);
            1
        }
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            paint_content_background(hwnd, hdc);
            EndPaint(hwnd, &ps);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn create_content_viewport(owner: HWND) -> HWND {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = wide(CONTENT_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(content_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class.as_ptr();
    // 同类重复注册可以返回 0；真正的创建失败在下方统一留痕。
    unsafe { RegisterClassW(&wc) };
    let viewport = unsafe {
        CreateWindowExW(
            WS_EX_CONTROLPARENT,
            class.as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VSCROLL,
            0,
            0,
            0,
            0,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if viewport == 0 {
        rust_warn!("设置内容滚动面创建失败（GetLastError={}）", unsafe {
            GetLastError()
        });
        return 0;
    }
    // 根窗的滚动条会挤占整页（含固定页脚），移交给内容面后必须移除。
    unsafe {
        let style = GetWindowLongPtrW(owner, GWL_STYLE);
        SetWindowLongPtrW(owner, GWL_STYLE, style & !(WS_VSCROLL as isize));
        SetWindowPos(
            owner,
            0,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
    place_content_viewport(owner, viewport);
    viewport
}

/// 设置窗建立后挂载内容（W5 的 open_aux 调用）。
pub(crate) fn install_settings_content(hwnd: HWND) {
    let viewport = create_content_viewport(hwnd);
    if viewport == 0 {
        // 错误已由 create_content_viewport 指名系统错误码；不显示无裁剪的残缺表单。
        return;
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = dpi_scale(hwnd);
    let mut fonts = Vec::new();
    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let bold = make_font(scale, 13, true);
    fonts.push(body);
    fonts.push(small);
    fonts.push(bold);

    let mut tab_buttons = Vec::new();
    // 左竖栏行按钮（位置由 layout 统一排；选中/未选中面在 refresh_values 按角色贴）。
    // WS_CLIPSIBLINGS（本文件全部子控件都带）：通知浮层要浮在兄弟控件之上，
    // 兄弟控件不画进浮层区域靠的就是这个样式（它是「被上层兄弟裁剪」的开关）。
    for (index, tab) in TABS.iter().enumerate() {
        let button = unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(tab.label).as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
                0,
                0,
                scaled(RAIL_W - RAIL_PAD_X * 2, scale),
                scaled(RAIL_ITEM_H, scale),
                hwnd,
                (TAB_BASE + index as i32) as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe { SendMessageW(button, WM_SETFONT, small as WPARAM, 1) };
        // ownerdraw：面由 `WM_DRAWITEM` 按 TabOn/TabOff 角色画；圆角取 `radii.sm`（--r1）。
        unsafe { make_themed_button(button, ButtonRole::TabOff, scale, theme::tokens().radii.sm) };
        tab_buttons.push(button);
    }
    // 状态行 + 刷新/保存。
    let status = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            scaled(MARGIN, scale),
            scaled(1, scale),
            scaled(240, scale),
            scaled(18, scale),
            hwnd,
            STATUS_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { SendMessageW(status, WM_SETFONT, small as WPARAM, 1) };
    // 状态行是信息通道（进展与错误共用一条），取说明色；专门的错误/警告行另算。
    stamp_text(status, TextRole::Hint);
    let refresh = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("刷新").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
            0,
            0,
            scaled(80, scale),
            scaled(26, scale),
            hwnd,
            REFRESH_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    let save = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("保存").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_CLIPSIBLINGS,
            0,
            0,
            scaled(80, scale),
            scaled(26, scale),
            hwnd,
            SAVE_ID as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SendMessageW(refresh, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(save, WM_SETFONT, body as WPARAM, 1);
    }
    style_button(SettingsButton::Refresh, refresh, scale);
    style_button(SettingsButton::Save, save, scale);

    STATE.with(|cell| {
        *cell.borrow_mut() = Some(SettingsState {
            hwnd,
            viewport,
            content_width: 0,
            wheel_remainder: 0,
            tab: 0,
            slots: Vec::new(),
            fixed: FixedControls {
                tab_buttons,
                status,
                refresh,
                save,
            },
            fonts,
            scroll: 0,
            content_height: 0,
            section_rules: Vec::new(),
            row_backgrounds: Vec::new(),
            secret_pairs: Vec::new(),
            dynamic_hints: Vec::new(),
            panel_slots: Vec::new(),
            panel_generation: 0,
            panel_base_y: 0,
            panel_end_y: 0,
            row_slots: Vec::new(),
            detail_content: 0,
            notice_overlay: 0,
            notice_measured: (0, 0),
            notice_overlay_failed: false,
            presented_generation: 0,
            notice_modal_up: false,
            doc_dialog_up: false,
            doc_dialog: 0,
            doc_dialog_content: None,
            doc_presented_this_open: false,
            doc_draft: None,
            doc_form_draft: None,
            capturing_shortcut: false,
        });
    });
    rebuild_tab();
    layout(hwnd);
    refresh_ui();
    settings_ui().ensure_font_families();
    settings_ui().ensure_cards();
    rust_info!("设置窗内容已建立（Windows：{} 个 Tab）", TABS.len());
}

/// `WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN`：字色按控件记录的角色取（未记录 → `ink`；
/// 禁用控件统一降为 `dim`），文字底透明、控件底回 `field_bg`（窗底色）。
///
/// 注意：可编辑 `EDIT` 走 [`edit_ctlcolor`]（由 `windows.rs` 的 `aux_wndproc` 转发）；
/// 只读/禁用 `EDIT` 也发 `WM_CTLCOLORSTATIC`，会一并拿到主题字色。
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
    let background = if window_class_name(control) == "EDIT" {
        tokens.field_bg.base_color()
    } else if ROW_LABELS.with(|labels| labels.borrow().contains(&control)) {
        row_background(tokens)
    } else {
        tokens.panel_bg.base_color()
    };
    unsafe {
        SetBkColor(hdc, paint_win::colorref(background));
    }
    paint_win::solid_brush(background) as LRESULT
}

/// `WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX`（②「全面自绘」）：可编辑输入框与下拉清单
/// 的底色取 `field_bg`、字色取 `ink`（禁用降 `dim`）；EDIT 的插入符随字色。
///
/// 与 STATIC/BTN 的透明底不同：编辑类必须给**实色**底刷 + `SetBkColor`
/// （透明底在滚动/部分重绘时会拖出残影）。返回值是背景刷。
pub(crate) fn edit_ctlcolor(wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let hdc = wparam as HDC;
    let control = lparam as HWND;
    let tokens = theme::tokens();
    let enabled = unsafe { IsWindowEnabled(control) } != 0;
    let ink = if enabled { tokens.ink } else { tokens.dim };
    let base = tokens.field_bg.base_color();
    unsafe {
        SetTextColor(hdc, paint_win::colorref(ink));
        SetBkColor(hdc, paint_win::colorref(base));
    }
    paint_win::solid_brush(base) as LRESULT
}

/// `WM_DRAWITEM`：ownerdraw 按钮 / 开关 / 组合框条目绘制。
/// 返回是否已处理（`false` = 不是本模块登记的自绘控件，交回 DefWindowProc）。
pub(crate) fn on_drawitem(lparam: LPARAM) -> bool {
    if lparam == 0 {
        return false;
    }
    let item = unsafe { &*(lparam as *const DrawItemStruct) };
    if item.CtlType == ODT_COMBOBOX {
        draw_combo_item(item);
        return true;
    }
    if item.CtlType != ODT_BUTTON {
        return false;
    }
    let disabled = item.itemState & (ODS_DISABLED | ODS_GRAYED) != 0;
    let rect = paint_win::Rect::new(
        item.rcItem.left,
        item.rcItem.top,
        item.rcItem.right - item.rcItem.left,
        item.rcItem.bottom - item.rcItem.top,
    );
    // 开关没有按钮角色：在 `role_of` 判定之前按状态镜像分流（否则会被画成普通按钮面）。
    let switch = SWITCH_STATES.with(|states| {
        let states = states.borrow();
        states
            .contains(item.hwndItem as isize)
            .then(|| states.get(item.hwndItem as isize))
    });
    if let Some(on) = switch {
        unsafe { paint_win::draw_switch(item.hDC, rect, on, disabled) };
        draw_focus_ring(item, rect);
        return true;
    }
    // 数值档位段：没有按钮角色，按镜像表分流（同开关的处理位置）。
    let number_choice =
        NUMBER_CHOICES.with(|states| states.borrow().contains_key(&(item.hwndItem as isize)));
    if number_choice {
        draw_number_choice(item);
        draw_focus_ring(item, rect);
        return true;
    }
    let tokens = theme::tokens();
    let role = paint_win::role_of(item.hwndItem);
    let hovered = paint_win::button_hovered(item.hwndItem);
    let pressed = item.itemState & ODS_SELECTED != 0;
    let face = paint_win::button_face(tokens, role, hovered, pressed);
    let label = window_text(item.hwndItem);
    // 底走父窗真实像素重放（`draw_button_on_parent_backdrop` 内部失败时回落旧近似
    // 口径；该回落 2026-10-08 起静默降噪，见 `paint_win::blit_backdrop` 内注释）；
    // 无论走哪条路，药丸都已画完。
    let _ = draw_button_on_parent_backdrop(item, rect, &face, &label, pressed, disabled);
    draw_focus_ring(item, rect);
    true
}

/// 一次激活（点击 / 键盘 Space）落在哪一段（纯函数，可测）。
///
/// 光标命中的段优先；命不中（键盘激活，或点进了 2px 段间间隙）→ 取当前高亮档的
/// **下一档**（循环）—— 让键盘用户也能换档（ownerdraw 按钮的 Space 会发 `BN_CLICKED`，
/// 但那时没有点击坐标）。`count = 0` / 无档位 → `None`（不写值）。
pub(super) fn number_choice_activation(
    hit: Option<usize>,
    selected: Option<usize>,
    count: usize,
) -> Option<usize> {
    if let Some(index) = hit {
        return Some(index);
    }
    if count == 0 {
        return None;
    }
    Some(match selected {
        Some(index) => (index + 1) % count,
        None => 0,
    })
}

/// 行内下拉的选中项下标（纯函数，可测）：按 `value` 在选项表里找 `selected`；
/// 找不到回退**第一项**（共享层口径：平台只回退呈现，不回写、不自造选中值）。
pub(super) fn pick_selected_index(pick: &RowPick) -> usize {
    pick.options
        .iter()
        .position(|option| option.value == pick.selected)
        .unwrap_or(0)
}

/// 行内下拉当前选中项的值（`CB_GETCURSEL` 下标 → 选项表；无选中/越界返回 None，
/// 不猜一个值写回）。
fn pick_selected_value(control: HWND, values: &[String]) -> Option<String> {
    if control == 0 {
        return None;
    }
    let index = unsafe { SendMessageW(control, CB_GETCURSEL, 0, 0) };
    if index < 0 {
        return None;
    }
    values.get(index as usize).cloned()
}

/// 下拉选中通知是否代表「用户确选了一件」（值写回的唯一判据）：
/// - `CBN_SELENDOK`：从展开列表里选中并收合（鼠标点位 / Enter）；
/// - `CBN_SELCHANGE` 且列表**未展开**：收起态键盘直接换档（这条路径不补发 SELENDOK）。
/// 展开中游走（SELCHANGE + 列表已展开）与 Esc 取消（SELENDCANCEL）都不写值 ——
/// 取消不留半截写入，游走不会被放大成一串后台写。
pub(super) fn pick_change_is_final(control: HWND, code: u32) -> bool {
    if control == 0 {
        return false;
    }
    if code == CBN_SELENDOK {
        return true;
    }
    code == CBN_SELCHANGE && unsafe { SendMessageW(control, CB_GETDROPPEDSTATE, 0, 0) == 0 }
}

/// WM_COMMAND：Tab 切换 / 字段动作 / 保存 / 刷新。
pub(crate) fn on_command(hwnd: HWND, wparam: WPARAM) -> bool {
    if SYNCING_CONTROLS.with(Cell::get) {
        // SetWindowText/EnableWindow/DestroyWindow 的同步回声由外层刷新负责；
        // 此时还持有 STATE，反向采值会重复借用并丢掉那次工作。
        return true;
    }
    let id = (wparam & 0xFFFF) as i32;
    let code = ((wparam >> 16) & 0xFFFF) as u32;
    match id {
        SAVE_ID => {
            if let Err(error) = harvest_and_save() {
                settings_ui().set_notice(Some(format!("有字段未通过校验，未保存：{error}")));
            }
            refresh_ui();
            return true;
        }
        REFRESH_ID => {
            settings_ui().reload();
            refresh_ui();
            return true;
        }
        STATUS_ID => return false,
        _ if (TAB_BASE..TAB_BASE + 16).contains(&id) => {
            // 竖栏按钮 id = TAB_BASE + 下标；下标校验走两平台共用口。
            let Some(tab) = tab_index_for_tag((id - TAB_BASE) as isize) else {
                rust_warn!("竖栏按钮的 id 不映射任何 Tab（id={id}）");
                return true;
            };
            // 借 STATE 的操作必须逐段进行（`with_state` 不能再嵌套在另一个借用里）。
            let changed = with_state(|state| {
                if state.tab != tab {
                    state.tab = tab;
                    state.scroll = 0;
                    true
                } else {
                    false
                }
            });
            if changed.unwrap_or(false) {
                rebuild_tab();
                // 句柄先在借用里取出、排布在借用外调：`layout` 自己还要借 STATE（见上一条
                // 纪律与 `layout` 顶部），在借用里调它会**嵌套**同一个 RefCell —— 那是裸
                // `borrow_mut`，panic 又发生在窗口过程里（无法 unwind）→ 进程直接 abort。
                if let Some(hwnd) = with_state(|state| state.hwnd) {
                    layout(hwnd);
                }
                refresh_ui();
            }
            if TABS[tab].id == "general" {
                // 坐标等字段由宿主拖动写回：进入通用页时静默重拉一次（不提示）。
                settings_ui().refresh_silently();
            }
            if TABS[tab].id == "appearance" {
                settings_ui().ensure_font_families();
                settings_ui().ensure_profiles();
                settings_ui().ensure_sound_panel();
            }
            if TABS[tab].id == "ai" {
                settings_ui().ensure_cards();
            }
            // 工具 / 记忆 Tab 的管理面首次进入时拉取（各自在途去重）。
            if TABS[tab].id == "tools" {
                settings_ui().ensure_tools_panels();
            }
            if TABS[tab].id == "memory" {
                settings_ui().ensure_memory();
            }
            return true;
        }
        // ── 管理面（W9d）：页面刷新 / 记忆详情动作 / 行动作 ──
        _ if (PANEL_REFRESH_ID_BASE..PANEL_REFRESH_ID_BASE + 16).contains(&id) => {
            match id - PANEL_REFRESH_ID_BASE {
                REFRESH_TOOLS => settings_ui().refresh_tools_panels(),
                REFRESH_MEMORY => settings_ui().refresh_memory(),
                REFRESH_SOUNDS => settings_ui().refresh_sound_panel(),
                _ => rust_warn!("管理面刷新没有对应页面（id={id}）"),
            }
            refresh_ui();
            return true;
        }
        // ── 记忆「已记住」翻页（2026-10-06）：页码收口在设置域，这里只回传方向 ──
        _ if (MEMORY_PAGE_ID_BASE..MEMORY_PAGE_ID_BASE + 16).contains(&id) => {
            match id - MEMORY_PAGE_ID_BASE {
                MEMORY_PAGE_PREV => settings_ui().step_memory_page(-1),
                MEMORY_PAGE_NEXT => settings_ui().step_memory_page(1),
                _ => rust_warn!("记忆分页没有对应按钮（id={id}）"),
            }
            refresh_ui();
            return true;
        }
        _ if (DETAIL_ID_BASE..DETAIL_ID_BASE + 16).contains(&id) => {
            match id - DETAIL_ID_BASE {
                DETAIL_ACTION_SAVE => {
                    let text = with_state(|state| {
                        if state.detail_content != 0 {
                            Some(window_text(state.detail_content))
                        } else {
                            None
                        }
                    })
                    .flatten();
                    if let Some(text) = text {
                        if let Err(error) = settings_ui().memory_save_correction(&text) {
                            settings_ui().set_notice(Some(format!("纠正未提交：{error}")));
                        }
                    }
                }
                DETAIL_ACTION_PIN => {
                    if let Err(error) = settings_ui().memory_toggle_pinned() {
                        settings_ui().set_notice(Some(format!("核心画像标记未提交：{error}")));
                    }
                }
                DETAIL_ACTION_FORGET => {
                    // 危险操作：原生确认（与编辑器未保存确认同款 MessageBoxW；不依赖通用 dialog 服务）。
                    let response = unsafe {
                        MessageBoxW(
                            hwnd,
                            wide("遗忘只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份不受影响。\n确认忘记这条记忆？").as_ptr(),
                            wide("忘记这条记忆").as_ptr(),
                            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
                        )
                    };
                    if response == IDYES {
                        if let Err(error) = settings_ui().memory_forget() {
                            settings_ui().set_notice(Some(format!("遗忘未提交：{error}")));
                        }
                    } else {
                        rust_debug!("遗忘确认被用户取消（response={response}）");
                    }
                }
                _ => rust_warn!("记忆详情动作没有对应按钮（id={id}）"),
            }
            refresh_ui();
            return true;
        }
        _ if (ROW_ID_BASE..ROW_ID_BASE + 4096).contains(&id) => {
            let info = with_state(|state| {
                state
                    .row_slots
                    .get((id - ROW_ID_BASE) as usize)
                    .map(|slot| {
                        (
                            slot.row_id.clone(),
                            slot.panel,
                            slot.action,
                            slot.control,
                            slot.pick_values.clone(),
                        )
                    })
            })
            .flatten();
            if let Some((row_id, panel, action, control, pick_values)) = info {
                // 行内下拉的中间通知（展开 / 展开中游走 / 取消，判据见
                // `pick_change_is_final`）不写值，也不重排页面 —— 尾部的 `refresh_ui`
                // 会经 `layout` 对展开中的下拉重发 MoveWindow，可能打断展开与键盘游走。
                // 只有「确选」的那一次走到下面的写回。
                if action == RowAction::Pick && !pick_change_is_final(control, code) {
                    return true;
                }
                let outcome = match action {
                    RowAction::Toggle => settings_ui().toggle_panel_row(panel, &row_id),
                    // 行选择按面板分发（条目 = 详情；来源 = 展开原话；备份 = 选中）。
                    RowAction::Select | RowAction::Choose => {
                        settings_ui().panel_row_select(panel, &row_id)
                    }
                    // 记忆作业行的取消 / 继续（行主按钮；动作集合由 Node 行投影定义）。
                    RowAction::Cancel | RowAction::Resume => {
                        settings_ui().memory_job_action(panel, &row_id, action)
                    }
                    // 次动作按钮（MCP「编辑」、Skill「删除」）走本批的专用入口；
                    // 删除前先做原生确认。
                    RowAction::Delete
                        if confirm_dangerous(hwnd, "行删除", "删除该条目？此操作不可撤销。") =>
                    {
                        settings_ui().panel_secondary_action(panel, &row_id, action)
                    }
                    RowAction::Delete => {
                        rust_debug!("行删除确认被用户取消");
                        Ok(())
                    }
                    RowAction::Edit => settings_ui().panel_secondary_action(panel, &row_id, action),
                    // 试听是音效事件行的次按钮（action2）：行 id = 事件键，当前分配由
                    // 共享层从行快照的 `pick.selected` 取（平台不解析行数据；不改配置）。
                    RowAction::Preview => settings_ui().preview_panel_row(panel, &row_id),
                    // 凭据输入行（MCP 面板的「GitHub 令牌」）：弹原生输入框取值后定向写存储。
                    RowAction::Credential => settings_ui().prompt_panel_credential(panel, &row_id),
                    // 行内下拉（音效事件行）：按下标从选项值表还原 `value` 写回
                    // （`action == Pick` 且已过「确选」判据才会到这里）。
                    RowAction::Pick => match pick_selected_value(control, &pick_values) {
                        Some(value) => settings_ui().pick_panel_row(panel, &row_id, &value),
                        None => {
                            rust_debug!("行内下拉没有可还原的选中值（未写值；id={id}）");
                            Ok(())
                        }
                    },
                    RowAction::None => Ok(()),
                };
                if let Err(error) = outcome {
                    settings_ui().set_notice(Some(format!("操作未执行：{error}")));
                }
            } else {
                rust_warn!("管理面行动作没有对应槽（id={id}）");
            }
            refresh_ui();
            return true;
        }
        // ── 密钥揭示（编辑框 + 按钮双控件组）──
        _ if (SECRET_ID_BASE..SECRET_ID_BASE + 16).contains(&id) => {
            let index = (id - SECRET_ID_BASE) as usize;
            with_state(|state| {
                let Some(pair) = state.secret_pairs.get_mut(index) else {
                    rust_warn!("密钥揭示按钮没有对应控件组（id={id}）");
                    return;
                };
                // 明文 ⇄ 遮蔽：EM_SETPASSWORDCHAR 传 0 = 显示原文；传建控件时读回的
                // 遮蔽字符 = 恢复圆点。切回遮蔽后必须重绘（字符位置会重排）。
                let (password_char, title) = secret_toggle(pair.revealed, pair.password_char);
                pair.revealed = !pair.revealed;
                unsafe {
                    SendMessageW(pair.edit, EM_SETPASSWORDCHAR, password_char, 0);
                    InvalidateRect(pair.edit, std::ptr::null(), 1);
                    SetWindowTextW(pair.button, wide(title).as_ptr());
                    // ownerdraw 按钮的标题变了要显式失效（自绘读 `window_text`）。
                    InvalidateRect(pair.button, std::ptr::null(), 1);
                }
            });
            return true;
        }
        // 行编辑文档的动作不走设置窗：它们由文档编辑弹窗自己的窗口过程处理（②），
        // 不经过这里。
        _ if id >= FIELD_BASE => {
            let index = (id - FIELD_BASE) as usize;
            let slot_info = with_state(|state| {
                state
                    .slots
                    .get(index)
                    .map(|slot| (slot.hwnd, slot.key, slot.kind))
            })
            .flatten();
            let Some((control, key, kind)) = slot_info else {
                return false;
            };
            if let (Some(key), Some(kind)) = (key, kind) {
                if kind.is_action() {
                    // 依赖控件值的动作先采全表（输入框里的编辑也要进草稿）。
                    // 只剩「重启」——「预览尺寸」动作已随窗口尺寸那批设置项撤下
                    // （2026-10-05，schema 与共享层同批；见测试 `撤下的设置键不再出现在生产码里`）。
                    if matches!(key, "action.restart") {
                        if let Err(error) = harvest_controls() {
                            settings_ui()
                                .set_notice(Some(format!("有字段未通过校验，动作未执行：{error}")));
                            return true;
                        }
                    }
                    // 危险动作（删除/覆盖类）先走原生确认；取消 = 动作未执行。
                    if !confirm_dangerous_for_key(hwnd, key) {
                        return true;
                    }
                    if let Err(error) = settings_ui().run_action(key) {
                        settings_ui().set_notice(Some(format!("动作未执行：{error}")));
                    }
                    return true;
                }
                if matches!(kind, FieldKind::Shortcut) {
                    // 点击进入录制：模态轮询捕获真实按键（值不从控件读）。
                    capture_shortcut(hwnd);
                    refresh_ui();
                    return true;
                }
                if matches!(kind, FieldKind::Bool) {
                    // 自绘开关：点击（BN_CLICKED）与空格键都到此。先翻转镜像再提交；
                    // 提交失败回滚镜像 —— 视觉留在原态（成功则经 refresh 回写同一值）。
                    let next =
                        SWITCH_STATES.with(|states| states.borrow_mut().toggle(control as isize));
                    if let Err(error) = settings_ui().set_value(key, SettingsValue::Bool(next)) {
                        SWITCH_STATES
                            .with(|states| states.borrow_mut().set(control as isize, !next));
                        settings_ui().set_notice(Some(format!("输入无效：{error}")));
                    }
                    return true;
                }
                if let FieldKind::NumberChoice { options } = kind {
                    // 点击某一段即选中并置脏（与「编辑即置脏」同口径）：`BN_CLICKED`
                    // 不带坐标，用点击时的光标位置命中段；命中不了（落在段间间隙 / 界外 /
                    // 取不到光标）就什么都不做 —— 绝不猜一个档写下去。
                    let index = number_choice_activation(
                        number_choice_clicked_index(control),
                        NUMBER_CHOICES.with(|states| {
                            states
                                .borrow()
                                .get(&(control as isize))
                                .and_then(|state| state.selected)
                        }),
                        options.len(),
                    );
                    match index.and_then(|index| options.get(index)) {
                        Some((_, number)) => {
                            if let Err(error) =
                                settings_ui().set_value(key, SettingsValue::Number(*number))
                            {
                                settings_ui().set_notice(Some(format!("输入无效：{error}")));
                            }
                        }
                        None => rust_debug!("档位段激活没有对应档位（未写值）"),
                    }
                    return true;
                }
                // 编辑框：EN_CHANGE（编辑即置脏 —— 底部「保存」随即可用）；失焦
                // （EN_KILLFOCUS）是校验与显示收口时机（见 [`commit_edit_value`]）。
                // 下拉（CBN_SELCHANGE）走下面的即时提交兜底。
                let is_edit = matches!(
                    kind,
                    FieldKind::Number { .. } | FieldKind::Text { .. } | FieldKind::Multiline
                );
                if is_edit {
                    if code == EN_CHANGE {
                        commit_edit_value(control, kind, key, false);
                    } else if code == EN_KILLFOCUS {
                        commit_edit_value(control, kind, key, true);
                    }
                    return true;
                }
                if matches!(
                    kind,
                    FieldKind::Enum(_)
                        | FieldKind::FontFamily
                        | FieldKind::CardChoice
                        | FieldKind::ProfileChoice
                ) && !pick_change_is_final(control, code)
                {
                    // 展开/高亮通知不提交，不因刷新重新定位仍打开的下拉窗口。
                    return true;
                }
                if let Some(value) = read_control(control, kind) {
                    if let Err(error) = settings_ui().set_value(key, value) {
                        settings_ui().set_notice(Some(format!("输入无效：{error}")));
                    }
                }
            }
            return true;
        }
        _ => {}
    }
    let _ = hwnd;
    false
}

/// WM_VSCROLL：内容面的标准滚动条，含 32 位拖动位置。
pub(crate) fn on_vscroll(hwnd: HWND, wparam: WPARAM) {
    let code = (wparam & 0xFFFF) as i32;
    with_state(|state| {
        let scale = dpi_scale(hwnd);
        let (_, height) = client_size(state.viewport);
        let page = ((f64::from(height) / scale).round() as i32).max(1);
        let mut info = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_TRACKPOS,
            nMin: 0,
            nMax: 0,
            nPage: 0,
            nPos: 0,
            nTrackPos: 0,
        };
        unsafe { GetScrollInfo(state.viewport, SB_VERT, &mut info) };
        state.scroll = scroll_target(
            state.scroll,
            state.content_height,
            page,
            code,
            info.nTrackPos,
        );
    });
    layout(hwnd);
}

/// 滚轮向上/向下滚动内容面，触摸板不足一格的增量保留到下一条消息。
pub(crate) fn on_mouse_wheel(hwnd: HWND, wparam: WPARAM) {
    let delta = ((wparam >> 16) & 0xFFFF) as i16 as i32;
    let changed = with_state(|state| {
        state.wheel_remainder += delta;
        let steps = state.wheel_remainder / WHEEL_DELTA;
        state.wheel_remainder %= WHEEL_DELTA;
        if steps == 0 {
            return false;
        }
        let (_, height) = client_size(state.viewport);
        let page = ((f64::from(height) / dpi_scale(hwnd)).round() as i32).max(1);
        state.scroll =
            (state.scroll - steps * SCROLL_STEP * 3).clamp(0, (state.content_height - page).max(0));
        true
    });
    if changed == Some(true) {
        layout(hwnd);
    }
}

/// WM_SIZE：重排。
pub(crate) fn on_size(hwnd: HWND) {
    let Some((viewport, previous_width)) =
        with_state(|state| (state.viewport, state.content_width))
    else {
        return;
    };
    place_content_viewport(hwnd, viewport);
    let (width, _) = client_size(viewport);
    let logical_width = (f64::from(width) / dpi_scale(hwnd)).round() as i32;
    if logical_width != previous_width {
        // 重排宽度需重算帮助行数/管理面几何。正在输入的半成品与选区先快照，
        // 不能用草稿中的最后有效数字覆盖空串、负号或正在编辑的文本。
        let pending = with_state(|state| {
            let focused = unsafe { GetFocus() };
            state
                .slots
                .iter()
                .find(|slot| {
                    slot.hwnd == focused
                        && matches!(
                            slot.kind,
                            Some(
                                FieldKind::Number { .. }
                                    | FieldKind::Text { .. }
                                    | FieldKind::Multiline
                            )
                        )
                })
                .and_then(|slot| {
                    slot.key.map(|key| {
                        let mut start = 0u32;
                        let mut end = 0u32;
                        unsafe {
                            SendMessageW(
                                slot.hwnd,
                                EM_GETSEL,
                                &mut start as *mut u32 as WPARAM,
                                &mut end as *mut u32 as LPARAM,
                            )
                        };
                        (key, window_text(slot.hwnd), start, end)
                    })
                })
        })
        .flatten();
        rebuild_tab();
        let view = settings_ui().view();
        with_state(|state| refresh_values(state, &view));
        if let Some((key, text, start, end)) = pending {
            let control = with_state(|state| {
                state
                    .slots
                    .iter()
                    .find(|slot| slot.key == Some(key))
                    .map(|slot| slot.hwnd)
            })
            .flatten();
            if let Some(control) = control {
                // SetFocus/SetWindowText 会同步发送通知，放在 STATE 借用之外。
                unsafe {
                    SetFocus(control);
                    SetWindowTextW(control, wide(&text).as_ptr());
                    SendMessageW(control, EM_SETSEL, start as WPARAM, end as LPARAM);
                }
            }
        }
    }
    layout(hwnd);
}

/// WM_DESTROY：释放字体与状态（窗口关闭即销毁资源）。
pub(crate) fn on_destroy() {
    // 句柄会被系统复用：窗口销毁即清空开关 / 档位段镜像，下次开窗不留陈旧项。
    SWITCH_STATES.with(|states| states.borrow_mut().clear());
    NUMBER_CHOICES.with(|states| states.borrow_mut().clear());
    STATE.with(|cell| {
        if let Some(state) = cell.borrow_mut().take() {
            for font in state.fonts {
                if font != 0 {
                    unsafe { DeleteObject(font) };
                }
            }
        }
    });
    settings_ui().note_window_closed();
    rust_info!("设置窗已关闭：控件与字体释放、草稿丢弃");
}

// ==========================================
// 通知分档呈现（①）：Error → 模态，Info/Warning → 顶部浮层
// ==========================================
//
// 手段选择与 z 序/焦点处理见文件头「通知分档」。这里只强调两条硬约束：
// - **判新只认 `notice_generation`**（不比较文本）：同一句话连报两次时文本相等；
// - 浮层的自动消失用 `SetTimer` + `TIMERPROC` 回调（不依赖设置窗过程函数转发
//   `WM_TIMER`），绘制/计时路径**不读设置窗 STATE**（绘制可能在任意借用之外到达）。

thread_local! {
    /// 浮层当前字体。自建窗口类不承担系统控件的 `WM_SETFONT` 存储语义
    /// （`DefWindowProc` 对非控件窗口不保证 `WM_SETFONT`/`WM_GETFONT` 往返），
    /// 自己记一份；与 `SWITCH_STATES` 独立于 `STATE` 的理由相同 ——
    /// 绘制路径不碰设置窗状态。
    pub(super) static NOTICE_FONT: Cell<HFONT> = const { Cell::new(0) };
}

/// 浮层自动消失（`SetTimer` 的回调形式；不读 STATE、不依赖消息转发）。
pub(super) unsafe extern "system" fn notice_timer_proc(hwnd: HWND, _msg: u32, id: usize, _time: u32) {
    if hwnd == 0 || id != NOTICE_TIMER_ID {
        return;
    }
    unsafe {
        KillTimer(hwnd, NOTICE_TIMER_ID);
        ShowWindow(hwnd, SW_HIDE);
    }
}

/// 浮层窗口过程：自绘主题面 + 语义字色；空操作消息按默认处理。
pub(super) unsafe extern "system" fn notice_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                // 文本/档位存在窗口自身（不进设置窗 STATE）：绘制可能在任何借用之外
                // 到达，读 STATE 会有 RefCell 重入风险（AGENTS §9）。
                let text = window_text(hwnd);
                let level = notice_level_from_code(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
                paint_notice_overlay(hwnd, hdc, &text, level);
                EndPaint(hwnd, &ps);
            }
            0
        }
        // 浮层不打断操作：点击穿透到下面的兄弟控件（子窗口的命中测试由系统下发到这里）。
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_ERASEBKGND => 1,
        // 自建窗口类自己记字体（见 `NOTICE_FONT`）；文本仍走 `WM_SETTEXT`/`WM_GETTEXT`
        // （那一对是窗口通用语义，DefWindowProc 负责）。
        WM_SETFONT => {
            NOTICE_FONT.with(|font| font.set(wparam as HFONT));
            0
        }
        WM_GETFONT => notice_font() as LRESULT,
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 数据刷新（拉取完成/保存回执）。
pub(crate) fn refresh_ui() {
    let view = settings_ui().view();
    with_state(|state| refresh_values(state, &view));
    // 文档弹窗（②）与页面控件是两条独立通道：随文档加载状态开合（模态）。
    sync_document_dialog(&view);
    // 管理面重建会新建控件：统一重排一次（面板区按滚动量整体位移）。
    // 句柄先在借用里取出、排布在借用外调 —— `layout` 自己借 STATE，嵌套即 abort（见其顶部）。
    if let Some(hwnd) = with_state(|state| state.hwnd) {
        layout(hwnd);
    }
    // 通知分档（①）在借用之外：错误档要跑模态消息循环，不能再借 STATE。
    present_notice(&view);
}

/// 采全表控件值进草稿（保存与依赖当前值的动作共用；编辑框里的编辑也进草稿）。
///
/// 先在**一次借用**里把 (键, 值) 全部读出来，再在借用之外逐条提交：`set_value` 会
/// 同步走到 `SettingsUi::refresh()` → `refresh_ui()`（主线程内联执行），若在
/// `with_state` 借用里调用会重入 `STATE` 的 `RefCell`（AGENTS §9 的 RefCell 纪律）。
fn harvest_controls() -> crate::error::AppResult<()> {
    let collected: Vec<(&'static str, SettingsValue)> = with_state(|state| {
        state
            .slots
            .iter()
            .filter_map(|slot| {
                let (key, kind) = (slot.key?, slot.kind?);
                if kind.is_action() {
                    return None;
                }
                read_control(slot.hwnd, kind).map(|value| (key, value))
            })
            .collect()
    })
    .unwrap_or_default();
    for (key, value) in collected {
        settings_ui().set_value(key, value)?;
    }
    Ok(())
}

/// 保存前采全表，再提交。
fn harvest_and_save() -> crate::error::AppResult<()> {
    harvest_controls()?;
    settings_ui().save()
}

/// 录制快捷键：模态轮询捕获（不新增窗口类/键盘钩子）。
///
/// 录制期间禁用设置窗输入（打字不会落进任何编辑框），用 `GetAsyncKeyState` 全局
/// 轮询按键边沿；只轮询键码表里的键 —— 表外按键本就无法注册，不捕获是如实行为。
/// 退出条件：捕获有效组合 / Esc 取消 / 超时。
fn capture_shortcut(hwnd: HWND) {
    unsafe { EnableWindow(hwnd, 0) };
    // 录制是「模式」不是通知：提示留在状态行、录制期间不被刷新抹掉（`refresh_values`
    // 按 `capturing_shortcut` 固定该文案）—— 浮层的「几秒自动消失」语义不适合模式提示。
    with_state(|state| state.capturing_shortcut = true);
    refresh_ui();
    let mut was_down: HashSet<u16> = HashSet::new();
    // 开始录制时已按下的键不算新边沿（用户可能正按着修饰键）。
    for (_, vk) in crate::ui::shortcut::WINDOWS_VIRTUAL_KEYS {
        if key_down(*vk as i32) {
            was_down.insert(*vk as u16);
        }
    }
    let deadline = Instant::now() + Duration::from_millis(SHORTCUT_CAPTURE_TIMEOUT_MS);
    let mut captured: Option<(String, ShortcutModifiers)> = None;
    let mut cancelled = false;
    while Instant::now() < deadline {
        // 泵消息保持界面可绘制；窗口已禁用，不会有新的输入消息。
        pump_messages();
        let modifiers = current_modifiers();
        if key_down(i32::from(VK_ESCAPE)) && !modifiers.any() {
            cancelled = true;
            break;
        }
        for (name, vk) in crate::ui::shortcut::WINDOWS_VIRTUAL_KEYS {
            let down = key_down(*vk as i32);
            let was = was_down.contains(&(*vk as u16));
            if down && !was {
                // Esc 已在上面按取消处理；其余按键到此即一个可注册的候选。
                captured = Some(((*name).to_string(), modifiers));
            }
            if down {
                was_down.insert(*vk as u16);
            } else {
                was_down.remove(&(*vk as u16));
            }
        }
        if captured.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(SHORTCUT_CAPTURE_POLL_MS));
    }
    unsafe { EnableWindow(hwnd, 1) };
    with_state(|state| state.capturing_shortcut = false);
    match captured {
        Some((key, modifiers)) => {
            match settings_ui().apply_shortcut(&key, modifiers, SHORTCUT_MODIFIERS_KEY) {
                Ok(()) => settings_ui().set_notice(Some("新快捷键已录入，保存后生效".into())),
                Err(error) => settings_ui().set_notice(Some(format!("快捷键未更新：{error}"))),
            }
        }
        None if cancelled => {
            settings_ui().set_notice(Some("已取消录制，快捷键未改动".into()));
            rust_debug!("快捷键录制被 Esc 取消");
        }
        None => settings_ui().set_notice(Some("快捷键录制超时（未捕获按键）".into())),
    }
    refresh_ui();
}

/// `GetAsyncKeyState` 高位 = 当前按下。
fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// 当前修饰键（Win 键按 Command 口径写入 `winModifiers`）。
fn current_modifiers() -> ShortcutModifiers {
    ShortcutModifiers {
        control: key_down(i32::from(VK_CONTROL)),
        command: key_down(i32::from(VK_LWIN)) || key_down(i32::from(VK_RWIN)),
        alt: key_down(i32::from(VK_MENU)),
        shift: key_down(i32::from(VK_SHIFT)),
    }
}

/// 泵掉本线程消息队列（录制期间保持窗口可绘制）。
fn pump_messages() {
    let mut message: MSG = unsafe { std::mem::zeroed() };
    while unsafe { PeekMessageW(&mut message, 0, 0, 0, PM_REMOVE) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// 编辑框的值提交（`on_blur=false` = `EN_CHANGE` 编辑中；`true` = `EN_KILLFOCUS` 失焦）。
///
/// 口径（用户规则 2026-10-05：「改了必须要回车，不行，弄成改了就能点保存」）：
/// - **编辑即置脏**：能解析出值时立刻写草稿，底部「保存」随即可用；
/// - **中间态不判非法**：空串 / 只敲了「-」等解析不出的输入**不写草稿、不清控件**
///   （不要一边打字一边判非法、更不要静默把「abc」写成 0）；失焦仍解析不出时，
///   把显示恢复成草稿现值（校验与显示都在失焦收口）；
/// - 解析出且与草稿现值相同：**不重复提交** —— 程序化 `SetWindowTextW` 也可能补发
///   `EN_CHANGE`，去掉这一层就是「写值 → 通知 → 再写」自激；
/// - 失焦提交沿用既有口径：越界按 `read_control` 的 clamp 收口、校验不过走通知；
///   编辑中途的校验失败只记 `rust_debug!`（每敲一个字都弹窗会变成噪音）。
fn commit_edit_value(control: HWND, kind: FieldKind, key: &str, on_blur: bool) {
    let Some(value) = read_control(control, kind) else {
        if on_blur {
            rust_debug!("失焦的值不可解析，显示恢复为草稿现值（{key}）");
            refresh_ui();
        }
        return;
    };
    let needed = {
        let view = settings_ui().view();
        edit_commit_needed(view.values.get(key), &value)
    };
    if !needed {
        return;
    }
    if let Err(error) = settings_ui().set_value(key, value) {
        if on_blur {
            settings_ui().set_notice(Some(format!("输入无效：{error}")));
        } else {
            rust_debug!("编辑中的值未通过校验（{key}）：{error}");
        }
    }
}

pub(super) fn read_control(hwnd: HWND, kind: FieldKind) -> Option<SettingsValue> {
    if hwnd == 0 {
        return None;
    }
    unsafe {
        match kind {
            FieldKind::Bool => {
                // 自绘开关不承载 `BM_GETCHECK`：状态只存在于镜像表。
                SWITCH_STATES
                    .with(|states| Some(SettingsValue::Bool(states.borrow().get(hwnd as isize))))
            }
            FieldKind::Number { min, max, .. } => {
                parse_number_text(&window_text(hwnd), min, max).map(SettingsValue::Number)
            }
            FieldKind::Text { .. } | FieldKind::Multiline => {
                Some(SettingsValue::Text(window_text(hwnd)))
            }
            FieldKind::Enum(choices) => {
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                let choice = choices.get(index.max(0) as usize)?;
                Some(SettingsValue::Text(choice.value.to_string()))
            }
            FieldKind::FontFamily => {
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    Some(SettingsValue::Text(String::new()))
                } else {
                    Some(SettingsValue::Text(window_text(hwnd)))
                }
            }
            FieldKind::CardChoice => {
                // 值 = Card id（不是显示名）：首个占位项「（未设置）」映射为空串。
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    return Some(SettingsValue::Text(String::new()));
                }
                let options = crate::ui::settings::settings_ui().card_options();
                let option = options
                    .as_ref()
                    .and_then(|list| list.get((index - 1) as usize))?;
                Some(SettingsValue::Text(option.id.clone()))
            }
            FieldKind::ProfileChoice => {
                // 值 = Profile id（不是显示名）：首个占位项「（未设置）」映射为空串。
                let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
                if index <= 0 {
                    return Some(SettingsValue::Text(String::new()));
                }
                let options = crate::ui::settings::settings_ui().profile_options();
                let option = options
                    .as_ref()
                    .and_then(|list| list.get((index - 1) as usize))?;
                Some(SettingsValue::Text(option.id.clone()))
            }
            // 只读展示与录制控件都不从控件读值（录制结果在 capture_shortcut 写入）。
            FieldKind::Info | FieldKind::Shortcut | FieldKind::ShortcutModifiers => None,
            // 档位段是草稿值的**视图**：不从控件读值（采全表/保存都不得顺手改写它 ——
            // 存量 1.5 打开设置再保存必须原样保留；只有点击分段才写）。
            FieldKind::NumberChoice { .. } => None,
            FieldKind::Action => None,
        }
    }
}

/// 下拉框第 `index` 项的文本（`CB_GETLBTEXTLEN` + `CB_GETLBTEXT`；越界/失败返回空串）。
pub(super) unsafe fn combo_item_text(hwnd: HWND, index: i32) -> String {
    let len = SendMessageW(hwnd, 0x0149 /* CB_GETLBTEXTLEN */, index as usize, 0);
    if len < 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    SendMessageW(
        hwnd,
        0x0148, /* CB_GETLBTEXT */
        index as usize,
        buf.as_mut_ptr() as isize,
    );
    text_from_windows(&buf[..len as usize])
}

/// 下拉框条目与期望标题不一致（数量或内容）→ 需重建。
///
/// **只比数量会漏掉改名**（数量不变、标题过期），过期标题与按 id 的取值错位：
/// 用户按看到的名字选中，读回的却是另一个 id（macOS 侧同款判据）。
unsafe fn combo_choice_stale(hwnd: HWND, desired: &[String]) -> bool {
    // CB_GETCOUNT 按 Win32 语义是 int；`SendMessageW` 的返回宽是 LRESULT=isize，
    // 收回到 i32 才能直接喂给 `combo_item_text` 的索引参数（CB_ERR=-1 走首条比较即判过期）。
    let count = SendMessageW(hwnd, 0x0146 /* CB_GETCOUNT */, 0, 0) as i32;
    count as usize != desired.len()
        || (0..count).any(|i| combo_item_text(hwnd, i) != desired[i as usize])
}

pub(super) fn write_control(
    hwnd: HWND,
    key: &str,
    kind: FieldKind,
    value: Option<&SettingsValue>,
    view: &crate::ui::settings::SettingsView,
) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        match kind {
            FieldKind::Bool => {
                // 自绘开关：状态写镜像表 + 失效重绘（`WM_DRAWITEM` 从镜像表读）。
                let checked = value.and_then(SettingsValue::as_bool).unwrap_or(false);
                SWITCH_STATES.with(|states| states.borrow_mut().set(hwnd as isize, checked));
                InvalidateRect(hwnd, std::ptr::null(), 1);
            }
            FieldKind::Number { min, .. } => {
                let number = value.and_then(SettingsValue::as_number).unwrap_or(min);
                SetWindowTextW(hwnd, wide(&format_number(number)).as_ptr());
            }
            FieldKind::NumberChoice { options } => {
                // 只更新高亮档（按草稿现值取最近档）——**不写值**：档位只约束呈现，
                // 存量 1.5 在这里只被「显示成最近档」，草稿原样保留。
                let selected =
                    number_choice_selected(options, value.and_then(SettingsValue::as_number));
                set_number_choice_selected(hwnd, selected);
                InvalidateRect(hwnd, std::ptr::null(), 1);
            }
            FieldKind::Text { .. } | FieldKind::Multiline => {
                let text = value.and_then(SettingsValue::as_text).unwrap_or("");
                SetWindowTextW(hwnd, wide(text).as_ptr());
            }
            FieldKind::Enum(choices) => {
                // schema 枚举此前只设置选中下标，没有装载任何条目，所有预设下拉恒为空。
                let desired: Vec<String> = choices
                    .iter()
                    .map(|choice| choice.label.to_string())
                    .collect();
                if combo_choice_stale(hwnd, &desired) {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    for title in &desired {
                        SendMessageW(hwnd, CB_ADDSTRING, 0, wide(title).as_ptr() as LPARAM);
                    }
                }
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                let index = choices
                    .iter()
                    .position(|choice| choice.value == current)
                    .unwrap_or(0);
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::FontFamily => {
                let families = view.font_families.clone();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                let expected_len = families.as_ref().map(|list| list.len() + 1).unwrap_or(1);
                let actual = SendMessageW(hwnd, 0x0146 /* CB_GETCOUNT */, 0, 0);
                if actual as usize != expected_len {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    SendMessageW(
                        hwnd,
                        CB_ADDSTRING,
                        0,
                        wide("（系统默认）").as_ptr() as isize,
                    );
                    if let Some(families) = &families {
                        for family in families.iter() {
                            SendMessageW(hwnd, CB_ADDSTRING, 0, wide(family).as_ptr() as isize);
                        }
                    }
                }
                if current.is_empty() {
                    SendMessageW(hwnd, CB_SETCURSEL, 0, 0);
                } else {
                    let index = SendMessageW(
                        hwnd,
                        0x0158, /* CB_FINDSTRINGEXACT */
                        -1isize as usize,
                        wide(current).as_ptr() as isize,
                    );
                    if index >= 0 {
                        SendMessageW(hwnd, CB_SETCURSEL, index as usize, 0);
                    }
                }
            }
            FieldKind::CardChoice => {
                let options = crate::ui::settings::settings_ui().card_options();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 期望标题 = 占位 + 选项显示名；按内容判重建（不只比条数，见 combo_choice_stale）。
                let mut desired: Vec<String> = vec!["（未设置）".to_string()];
                if let Some(list) = &options {
                    desired.extend(list.iter().map(|option| option.name.clone()));
                }
                if combo_choice_stale(hwnd, &desired) {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    for title in &desired {
                        SendMessageW(hwnd, CB_ADDSTRING, 0, wide(title).as_ptr() as isize);
                    }
                }
                // 按 id 定位（显示名可能重复/变更）：找不到时回到「未设置」。
                let index = if current.is_empty() {
                    0
                } else {
                    options
                        .as_ref()
                        .and_then(|list| list.iter().position(|option| option.id == current))
                        .map(|position| position as usize + 1)
                        .unwrap_or(0)
                };
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::ProfileChoice => {
                let options = crate::ui::settings::settings_ui().profile_options();
                let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 与 CardChoice 同款内容判据：改名 / 列表变化都要重建（条数相同也重建）。
                let mut desired: Vec<String> = vec!["（未设置）".to_string()];
                if let Some(list) = &options {
                    desired.extend(list.iter().map(|option| option.name.clone()));
                }
                if combo_choice_stale(hwnd, &desired) {
                    SendMessageW(hwnd, 0x014B /* CB_RESETCONTENT */, 0, 0);
                    for title in &desired {
                        SendMessageW(hwnd, CB_ADDSTRING, 0, wide(title).as_ptr() as isize);
                    }
                }
                // 按 id 定位（显示名可能重复/变更）：找不到时回到「未设置」。
                let index = if current.is_empty() {
                    0
                } else {
                    options
                        .as_ref()
                        .and_then(|list| list.iter().position(|option| option.id == current))
                        .map(|position| position as usize + 1)
                        .unwrap_or(0)
                };
                SendMessageW(hwnd, CB_SETCURSEL, index, 0);
            }
            FieldKind::Info => {
                let text = crate::ui::settings::info_text(key, &view.values);
                SetWindowTextW(hwnd, wide(&text).as_ptr());
            }
            FieldKind::Shortcut => {
                SetWindowTextW(hwnd, wide(&shortcut_display(view)).as_ptr());
            }
            FieldKind::ShortcutModifiers => {}
            // 动作入口不走值刷新（`refresh_values` 在动作分支直接 continue 并单独刷标题）。
            FieldKind::Action => {}
        }
    }
}
