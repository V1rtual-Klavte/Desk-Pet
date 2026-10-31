//! 聊天窗窗口过程（`chat_wndproc`）。

use super::*;
use super::dialogs::handle_link_click;
use super::input::{
    arm_deadline_timer, handle_dropped_files, refresh_input_state, scroll_pending_from_wheel,
    send_from_input,
};
use super::layout::{
    ctlcolor_static, draw_themed_button, draw_themed_card, rect_contains, scroll_inspector_from_wheel,
};
use super::paint::{close_inspector_ui, paint_shell, toggle_inspector_ui, win_rect_of};
use super::panels::dispatch_panel_action;
use super::transcript::{canvas_scroll, chat_apply, release_canvas};
use super::window::build_children;
use crate::rust_warn;

// ==========================================
// 窗口过程
// ==========================================

pub(super) unsafe extern "system" fn chat_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 底全部由 WM_PAINT 的 paint_shell 画（类刷为空刷）；吞掉擦除以避免闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| paint_shell(state, hdc));
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
        // 同 `overlay_layer_wndproc`：编辑类控件的 CTLCOLOR 消费者是控件父窗
        // （流内面板元素挂在本窗上），就地接住并转给同一实现点。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => {
            super::super::windows_settings::edit_ctlcolor(wparam, lparam)
        }
        WM_DRAWITEM => {
            if lparam != 0 {
                let item = unsafe { &*(lparam as *const DrawItemStruct) };
                if item.CtlType == ODT_BUTTON {
                    unsafe { draw_themed_button(item) };
                    return 1;
                }
                if item.CtlType == ODT_STATIC {
                    // 面板卡片底板（`PanelElement::Card` 建的自绘 STATIC）。
                    unsafe { draw_themed_card(item) };
                    return 1;
                }
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CREATE => {
            unsafe { build_children(hwnd) };
            0
        }
        WM_SIZE => {
            // 宽度变化会改变正文换行高度与面板按钮排布。共用可见面门禁；隐藏期间
            // 只更新模型，面板重新显示时由共享边沿投递最新 Full。
            let standalone =
                CHAT.with(|cell| cell.borrow().as_ref().is_some_and(|state| !state.pane));
            if standalone && crate::ui::chat::chat_ui().is_window_open() {
                // `WPARAM` 是 `usize`、`SIZE_MINIMIZED` 是 `u32`：显式转型，不靠推断
                //（漏了它本机编不出来 —— Windows 分支在 macOS 上被 cfg 掉）。
                let visible = wparam != SIZE_MINIMIZED as usize && unsafe { IsWindowVisible(hwnd) != 0 };
                let was_visible = crate::ui::chat::is_surface_visible("chat");
                if !visible {
                    with_chat(|state| unsafe { release_canvas(state) });
                }
                crate::ui::chat::set_chat_window_visible(visible);
                if was_visible && visible {
                    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
                }
            } else {
                chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
            }
            0
        }
        WM_LBUTTONDOWN => {
            // 把手带**整条可点**（2026-10-05 第三波）：点带内任意位置开合浮层。
            // 状态文字与箭头都是同一块面上的绘制（没有子控件），所以这是**唯一**
            // 的开合入口 —— 一次点击只翻转一次。带外一律交回默认处理。
            let x = i32::from((lparam & 0xFFFF) as u16 as i16);
            let y = i32::from(((lparam >> 16) & 0xFFFF) as u16 as i16);
            let in_handle = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| rect_contains(win_rect_of(&state.paint.handle), x, y))
                    .unwrap_or(false)
            });
            if in_handle {
                unsafe { toggle_inspector_ui() };
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_GETMINMAXINFO => {
            let info = unsafe { &mut *(lparam as *mut MinMaxInfo) };
            let scale = dpi_scale(hwnd);
            info.ptMinTrackSize = POINT {
                x: scaled(CHAT_WINDOW_MIN_WIDTH, scale),
                y: scaled(CHAT_WINDOW_MIN_HEIGHT, scale),
            };
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let notification = ((wparam >> 16) & 0xFFFF) as u16;
            // 输入内容变化（含程序化填入/清空）：驱动 slash 候选与「发送」按钮可用态。
            if id == INPUT_ID && notification == EN_CHANGE {
                // EN_CHANGE 已携带发通知的 RichEdit 句柄，不回借 CHAT：设置字体/
                // 文字可能同步进入这里，而外层仍在持有聊天布局状态。
                refresh_input_state(lparam as HWND);
                return 0;
            }
            match id {
                STOP_ID => match crate::ui::chat::dispatch_stop() {
                    Ok(()) => crate::ui::chat::set_notice(None),
                    Err(error) => crate::ui::chat::set_notice(Some(format!("停止失败：{error}"))),
                },
                // ── 浮层（2026-10-05 第二次改版；两段都在开口段之前匹配）──
                // 浮层关闭「✕」（浮层窗口把 WM_COMMAND 转到这里）。
                INSPECTOR_CLOSE_ID => unsafe { close_inspector_ui() },
                // 「发送」按钮：与 Enter 同一出口（WM_APP_SEND → send_from_input）。
                BTN_SEND_ID => unsafe {
                    PostMessageW(hwnd, WM_APP_SEND, 0, 0);
                },
                // 「↓ 新消息」：回正文底部（可见性由 apply_scroll 统一驱动）。
                BTN_JUMP_ID => canvas_scroll(SB_BOTTOM),
                // ── A1：标签条按钮（两段范围先于 PANEL_BASE 匹配；顶栏「×」不在这里，
                // 它归全窗宽顶栏子窗口自己的 WM_COMMAND）──
                BTN_NEW_SESSION_ID => match crate::ui::chat::dispatch_new_session() {
                    Ok(()) => crate::ui::chat::set_notice(None),
                    Err(error) => {
                        crate::ui::chat::set_notice(Some(format!("新建会话失败：{error}")));
                    }
                },
                BTN_HISTORY_ID => unsafe {
                    dispatch_panel_action(crate::ui::chat::PanelAction::ToggleSessionHistory)
                },
                // A3：发图入口（原生多选器；工作线程，结果经统一图片域准入后进待发送区）。
                BTN_PICK_IMAGES_ID => {
                    if let Err(error) = crate::ui::chat::pick_images() {
                        crate::ui::chat::set_notice(Some(format!("打开图片选择器失败：{error}")));
                    }
                }
                SESSION_TAB_BASE..SESSION_CLOSE_BASE => {
                    let index = (id - SESSION_TAB_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.session_targets.get(index).cloned())
                    });
                    match target {
                        Some(session_id) => {
                            match crate::ui::chat::dispatch_switch_session(&session_id) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => {
                                    crate::ui::chat::set_notice(Some(format!(
                                        "切换会话失败：{error}"
                                    )));
                                }
                            }
                        }
                        None => rust_warn!("会话标签 id={id} 没有对应会话（渲染已换代）"),
                    }
                }
                // 面板下拉（COMBOBOX）：只认 SELENDOK（用户选定）—— SELCHANGE 在
                // 键盘游走时也发，动作会重复触发。id = PANEL_SELECT_BASE + 基址，
                // 选中下标叠加基址取动作。本段必须先于下方开口段（`PENDING_BASE..`
                // 等）匹配。
                PANEL_SELECT_BASE.. => {
                    if notification != CBN_SELENDOK as u16 {
                        return 0;
                    }
                    let base = (id - PANEL_SELECT_BASE) as usize;
                    let control = lparam as HWND;
                    let selected =
                        unsafe { SendMessageW(control, CB_GETCURSEL, 0, 0) }.max(0) as usize;
                    let action = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.panel_actions.get(base + selected).cloned())
                    });
                    match action {
                        // 下拉选中（投递 / 思考强度 / 安全策略）经统一助手派发并立即重建 ——
                        // 投递是本地动作且模型未 bump 版本号，不立即重建就会「选完不刷新」。
                        Some(action) => unsafe { dispatch_panel_action(action) },
                        None => rust_warn!(
                            "面板下拉 id={id} 选中 {selected} 没有对应动作（渲染已换代）"
                        ),
                    }
                }
                // A3：待发送条目点击 = 撤选（表在 rebuild_pending 时整体替换）。
                // 本段必须先于下方开口的 `SESSION_CLOSE_BASE..`（4600..）匹配。
                PENDING_BASE.. => {
                    let index = (id - PENDING_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.pending_targets.get(index).cloned())
                    });
                    match target {
                        Some(path) => crate::ui::chat::remove_pending_image(&path),
                        None => rust_warn!("待发送条目 id={id} 没有对应路径（渲染已换代）"),
                    }
                }
                SESSION_CLOSE_BASE.. => {
                    let index = (id - SESSION_CLOSE_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.session_targets.get(index).cloned())
                    });
                    match target {
                        Some(session_id) => {
                            match crate::ui::chat::dispatch_close_session(&session_id) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => {
                                    crate::ui::chat::set_notice(Some(format!(
                                        "关闭会话失败：{error}"
                                    )));
                                }
                            }
                        }
                        None => rust_warn!("会话标签关闭 id={id} 没有对应会话（渲染已换代）"),
                    }
                }
                // 面板按钮（W8b）：ID 指向本次渲染的动作表。
                PANEL_BASE.. => {
                    let index = (id - PANEL_BASE) as usize;
                    let action = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.panel_actions.get(index).cloned())
                    });
                    match action {
                        Some(action) => unsafe { dispatch_panel_action(action) },
                        None => rust_warn!("面板按钮 id={id} 没有对应动作（渲染已换代）"),
                    }
                }
                PLACEHOLDER_BASE.. => {
                    let index = (id - PLACEHOLDER_BASE) as usize;
                    let target = CHAT.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.image_targets.get(index))
                            .map(|target| (target.entry_id.clone(), target.image_index))
                    });
                    match target {
                        Some((entry_id, image_index)) => {
                            match crate::ui::chat::open_viewer(&entry_id, image_index) {
                                Ok(()) => crate::ui::chat::set_notice(None),
                                Err(error) => crate::ui::chat::set_notice(Some(format!(
                                    "图片无法打开：{error}"
                                ))),
                            }
                        }
                        None => rust_warn!("图片占位按钮 id={id} 没有对应目标（渲染已换代）"),
                    }
                }
                _ => {}
            }
            0
        }
        WM_TIMER => {
            if wparam == TIMER_DEADLINE {
                // 到点收纳（tick 会经刷新调度回到 apply_full → 重新布点）。
                // 在 with_chat 之外调用，避免重入借用被跳过。
                crate::ui::chat::tick_deadlines();
                with_chat(|state| arm_deadline_timer(state));
            }
            0
        }
        WM_NOTIFY => {
            // RichEdit 的超链接通知（EN_LINK）：只处理用户点击（WM_LBUTTONUP）。
            let header = unsafe { &*(lparam as *const Nmhdr) };
            if header.code == EN_LINK {
                let link = unsafe { &*(lparam as *const ENLINK) };
                if link.msg == 0x0202 {
                    unsafe { handle_link_click(link) };
                }
            }
            0
        }
        WM_APP_SEND => {
            send_from_input();
            0
        }
        WM_DROPFILES => {
            // A3：文件拖入聊天窗（正文底/空白）→ 待发送区。
            unsafe { handle_dropped_files(wparam as HDROP) };
            0
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            // 浮层开着、光标在抽屉内容上且内容超高时先滚抽屉（消费本次滚轮；
            // 与待发送条同一条「鼠标在哪就滚哪」口径，不抢别的区域的滚轮）。
            if unsafe { scroll_inspector_from_wheel(msg, wparam) } {
                return 0;
            }
            // 2026-10-06 多张截图可达性：滚轮落在待发送条上时横向滚条（光标在哪就滚
            // 哪；子按钮持焦点时滚轮消息也会转到本窗）。不在条内/没超宽则不消费，
            // 落回既有语义。
            if unsafe { scroll_pending_from_wheel(hwnd, msg, wparam) } {
                return 0;
            }
            if msg == WM_MOUSEHWHEEL {
                // 横向轮在别的区域没有既有语义：交回默认处理。
                return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
            }
            // 焦点在输入区时的滚轮也滚正文：转发为行滚动给画布。
            let canvas = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.canvas));
            if let Some(canvas) = canvas {
                // 滚轮增量在 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
                // y 坐标 —— 2026-10-06 前误读 lParam，步长随窗口在屏幕上的位置漂移）。
                let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
                let lines = (i32::from(delta) / 120).clamp(-5, 5) * 3;
                let command = if lines > 0 { SB_LINEUP } else { SB_LINEDOWN };
                for _ in 0..lines.abs() {
                    unsafe {
                        SendMessageW(canvas, WM_VSCROLL, command as WPARAM, 0);
                    }
                }
            }
            0
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            // 聊天窗是附属窗：销毁不得退出应用（不 PostQuitMessage）。
            let mut close_inspector = false;
            with_chat(|state| unsafe {
                // `inspector_open` 是 bool（三块同浮层后不再有「打开的是哪一块」的信息）。
                close_inspector = state.inspector_open;
                KillTimer(state.hwnd, TIMER_DEADLINE);
                DRAW_IMAGES.with(|images| {
                    let mut images = images.borrow_mut();
                    for target in &state.image_targets {
                        images.remove(&target.hwnd);
                    }
                });
                for child in &state.panel_children {
                    DestroyWindow(child.hwnd);
                }
                for child in &state.inspector_children {
                    DestroyWindow(child.hwnd);
                }
                for child in &state.history_children {
                    DestroyWindow(child.hwnd);
                }
                // 悬浮层窗口（浮层标题/✕ 是浮层窗口的子窗口，随它一起销毁）。
                if state.inspector_layer != 0 {
                    DestroyWindow(state.inspector_layer);
                }
                if state.history_layer != 0 {
                    DestroyWindow(state.history_layer);
                }
                for child in &state.pending_children {
                    DestroyWindow(child.hwnd);
                }
                // 缩略图注册表随控件一起清（窗口重建后 HWND 可能被复用，旧句柄
                // 留下的帧会挂到新按钮上）。
                PENDING_THUMBS.with(|images| images.borrow_mut().clear());
                for child in &state.children {
                    DestroyWindow(child.hwnd);
                }
                for font in &state.fonts {
                    DeleteObject(*font);
                }
            });
            let was_pane = CHAT.with(|cell| {
                let pane = cell
                    .borrow()
                    .as_ref()
                    .map(|state| state.pane)
                    .unwrap_or(false);
                *cell.borrow_mut() = None;
                pane
            });
            if was_pane {
                // 主窗面板随主窗销毁（宿主退出）：聊天面关闭，但查看器资源由
                // 退出序列统一释放（`on_host_exit`）。
                crate::ui::chat::chat_ui().set_main_pane_open(false);
            } else {
                crate::ui::chat::note_chat_window_closed();
            }
            // 关窗 = 浮层收起：把共享层的开合状态同步归零。平台镜像随窗口状态表
            // 一起销毁（上一行的 `*cell.borrow_mut() = None`），不归零会让模型留下
            // 一个「开着」的陈旧值 —— 重开窗时平台从 None 起步、两边错拍。
            // 这里已经释放了 CHAT 借用；动作只改模型 + 排一次（会被窗口门禁丢掉的）
            // 刷新，失败如实留痕。
            if close_inspector {
                if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseInspector)
                {
                    rust_warn!("聊天窗销毁时同步收起浮层失败: {error}");
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}
