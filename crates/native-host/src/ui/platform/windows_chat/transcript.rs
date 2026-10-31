//! 消息流主窗格挂载、`chat_apply` 重建入口与画布（滚动/分页/正文控件）。

use super::*;
use super::input::{
    arm_deadline_timer, handle_dropped_files, scroll_at_bottom, update_jump_visibility,
    update_send_enabled,
};
use super::layout::{
    apply_input_theme, blit_button_backdrop, ctlcolor_static, draw_themed_button, layout_panes_for,
};
use super::paint::{
    apply_input_round_regions, build_tail_controls, create_child, create_code_control,
    create_rtf_control, make_themed_button_r, paint_canvas_shell, prose_estimated_width,
    prose_to_rtf_colored, rich_bg, rich_bg_alpha, segment_has_text, send_font, stamp_ink,
    update_status, update_tail,
};
use super::panels::{rebuild_panels, rebuild_tabs};
use super::window::ensure_chat_classes;
use crate::{rust_debug, rust_info, rust_warn};

// ==========================================
// 主窗内聊天面板（W9a：一体主窗布局）
// ==========================================

/// 把聊天面板挂进主窗（子窗口 + 同一套控件；不新建顶层窗）。
pub(crate) fn mount_main_pane(parent: HWND) {
    if CHAT.with(|cell| cell.borrow().is_some()) {
        rust_debug!("聊天面板已存在，忽略重复挂载");
        return;
    }
    if let Err(error) = unsafe { ensure_chat_classes() } {
        rust_warn!("聊天面板类注册失败: {error}");
        return;
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(CHAT_CLASS).as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            200,
            200,
            parent,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        rust_warn!("聊天面板子窗口创建失败");
        return;
    }
    crate::ui::chat::chat_ui().set_main_pane_open(true);
    let visible = unsafe { IsWindowVisible(hwnd) != 0 };
    crate::ui::chat::set_main_pane_visible(visible);
    rust_info!("聊天面板已挂入主窗（Windows：子窗口 + 同一套控件）");
}

/// 主窗布局驱动面板矩形（MoveWindow 会触发面板的 WM_SIZE → 重排 + 重建）。
pub(crate) fn layout_main_pane(parent: HWND, x: i32, y: i32, width: i32, height: i32) {
    let pane = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .filter(|state| state.pane)
            .map(|state| state.hwnd)
    });
    let Some(pane) = pane else { return };
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MoveWindow(pane, x, y, width, height, 1);
    }
    let _ = parent;
}

/// 聊天列展开/收起（收起只隐藏；展开时按最新投影重建）。
pub(crate) fn set_main_pane_visible(_parent: HWND, visible: bool) {
    let pane = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .filter(|state| state.pane)
            .map(|state| state.hwnd)
    });
    let Some(pane) = pane else { return };
    if !visible {
        crate::ui::chat::set_main_pane_visible(false);
    }
    unsafe {
        ShowWindow(pane, if visible { SW_SHOW } else { SW_HIDE });
    }
    if !visible {
        // 收起时停掉面板期限定时器（聊天面不在时不需要本地收纳；展开时重建会重新布点）。
        with_chat(|state| unsafe {
            KillTimer(state.hwnd, TIMER_DEADLINE);
            release_canvas(state);
            crate::ui::chat::sync_inline_visible("main-chat", Vec::new());
        });
    }
    if visible {
        crate::ui::chat::set_main_pane_visible(true);
    }
}

/// 呼出后聚焦主窗聊天输入框（对齐 macOS 与旧壳 `handleDockPopup` 的 `focusInput`）。
///
/// 只在面板可见（主窗在屏、聊天列展开）时聚焦：桌宠形态下面板隐藏，既不把面板
/// 拉出来，也不对隐藏控件硬聚焦。`SetFocus` 无返回值 —— 读回当前焦点核实，
/// 拿不到焦点就如实返回 false，由呼出路径留痕（不假装成功；与 macOS 口径一致）。
pub(crate) fn focus_main_pane_input() -> bool {
    let target: Option<HWND> = CHAT.with(|cell| {
        let slot = cell.borrow();
        let state = match slot.as_ref() {
            Some(state) => state,
            None => return None,
        };
        if !state.pane || state.input == 0 {
            return None;
        }
        if unsafe { IsWindowVisible(state.hwnd) } == 0 {
            return None;
        }
        Some(state.input)
    });
    let Some(input) = target else {
        rust_debug!("呼出聚焦跳过：聊天面板未挂载或当前不可见");
        return false;
    };
    // 线程前提：本函数只在呼出路径调用（UI 线程、SetForegroundWindow 之后），
    // SetFocus 的「前台线程」条件成立。
    unsafe { SetFocus(input) };
    if unsafe { GetFocus() } == input {
        rust_debug!("呼出已聚焦聊天输入框");
        true
    } else {
        rust_warn!("呼出聚焦聊天输入框失败（SetFocus 未生效）");
        false
    }
}

pub(crate) fn clear_inline_previews() {
    with_chat(|state| {
        for target in &mut state.image_targets {
            target.frame = None;
            DRAW_IMAGES.with(|images| {
                if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                    draw.frame = None;
                }
            });
            unsafe { InvalidateRect(target.hwnd, std::ptr::null(), 1) };
        }
    });
}

/// 主窗收起/呼出只改变顶层窗口可见性，保持聊天列开合状态并相应释放/恢复可见图片。
pub(crate) fn main_window_visibility_changed(visible: bool, chat_column_expanded: bool) {
    if visible {
        let parent = CHAT.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|state| state.pane)
                .map(|state| unsafe { GetParent(state.hwnd) })
                .unwrap_or(0)
        });
        if parent != 0 {
            set_main_pane_visible(parent, chat_column_expanded);
        }
    } else {
        crate::ui::chat::set_main_pane_visible(false);
        with_chat(|state| {
            if state.pane {
                for target in &mut state.image_targets {
                    target.frame = None;
                    DRAW_IMAGES.with(|images| {
                        if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                            draw.frame = None;
                        }
                    });
                }
                crate::ui::chat::sync_inline_visible("main-chat", Vec::new());
            }
        });
    }
}

/// 主题切换：重建设备级配色（RTF 颜色表/按钮面/静态字色在创建时固化）+ 重画窗底。
///
/// 主题 GDI 缓存由 `windows.rs` 的广播先统一释放（`paint_win::release_theme_resources`），
/// 这里负责把「按旧 token 画好的东西」全部重建，并用新 token 刷新输入框与固定文字。
pub(crate) fn apply_theme() {
    let exists = CHAT.with(|cell| cell.borrow().is_some());
    if !exists {
        rust_debug!("聊天窗未打开，主题切换仅释放缓存（由广播统一做）");
        return;
    }
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
    with_chat(|state| unsafe {
        apply_input_theme(state);
        // ownerdraw 的窗口区域（SetWindowRgn）不随重绘更新，而 radii 跨主题不同
        // （sm/btn：brushed 4/5、chrome 8/9、verdigris 4/5）：按各按钮创建时的半径
        // 重贴区域（配对与创建处一致：浮层 ✕/＋/历史 用 `--r1`，其余主按钮/次要按钮
        // 用 `--r3`）。
        let scale = dpi_scale(state.hwnd);
        for (control, radius) in [
            (state.send, theme::tokens().radii.btn),
            (state.jump, theme::tokens().radii.btn),
            (state.pick_images, theme::tokens().radii.btn),
            (state.stop, theme::tokens().radii.btn),
            (state.inspector_close, theme::tokens().radii.sm),
            (state.nav_new, theme::tokens().radii.sm),
            (state.nav_history, theme::tokens().radii.sm),
        ] {
            paint_win::install_button(control, scaled(radius.round() as i32, scale));
        }
        // 输入区承载件的圆角区域（radius 跨主题不同：sm 4/8/4）。
        apply_input_round_regions(state, scale);
        stamp_ink(state.input_placeholder, theme::tokens().dim);
        InvalidateRect(state.input_placeholder, std::ptr::null(), 1);
        InvalidateRect(state.hwnd, std::ptr::null(), 1);
        InvalidateRect(state.canvas, std::ptr::null(), 1);
        // 悬浮层窗口画的是主题材质（遮罩/盒底/描边），必须重画；重绘直接吃本次
        // 整帧重建刚写好的盒几何（上面 `chat_apply(Full)` 已跑过布局）。
        // **不要把盒几何归零**：归零会让这一帧的 WM_PAINT 按空盒只铺遮罩、
        // 盒体要等下一次布局才回来（实机表现：切主题后浮层只剩一层遮罩）。
        // macOS 侧同族根因是「贴皮子层只按宿主尺寸守卫、没人按浮层自身帧重贴」
        // （见 `macos_chat::repaint_floating_chrome_if_resized`）；Windows 是立即
        // 模式逐帧重画，重绘守卫就收在 `layout_inspector_layer` 的盒几何比较 +
        // 这里的主题重绘，不存在子层残留。
        if state.inspector_layer != 0 {
            InvalidateRect(state.inspector_layer, std::ptr::null(), 1);
        }
        if state.history_layer != 0 {
            InvalidateRect(state.history_layer, std::ptr::null(), 1);
        }
    });
    rust_info!("聊天窗已按新主题重建（Windows）");
}

/// 全局字体快照变化：重建字体并下发（消息视图按新字体重建）。
pub(crate) fn apply_chat_font() {
    let scale = CHAT.with(|cell| cell.borrow().as_ref().map(|state| dpi_scale(state.hwnd)));
    let Some(scale) = scale else { return };
    with_chat(|state| {
        let snapshot = crate::ui::font::snapshot();
        let ui_face = snapshot
            .family
            .clone()
            .unwrap_or_else(paint_win::resolve_ui_font_family);
        // 统一走 `paint_win::create_ui_font`（**灰度抗锯齿**）：系统缺省的
        // DEFAULT_QUALITY 会打开 ClearType，浅底小字上出现橙/蓝彩边（实机与 mac
        // 录制对比明显「脏」，2026-10-07）；顶栏已先行走这条路径。
        let make = |height: f64, weight: i32, face: &str| {
            paint_win::create_ui_font(-scaled(height.round() as i32, scale), weight, face)
        };
        let body = make(snapshot.scaled_size(13.0, 13.5), FW_NORMAL as i32, &ui_face);
        let small = make(snapshot.scaled_size(11.0, 13.5), FW_NORMAL as i32, &ui_face);
        let bold = make(snapshot.scaled_size(13.0, 13.5), FW_BOLD as i32, &ui_face);
        let mono = make(
            snapshot.scaled_size(12.0, 13.5),
            FW_NORMAL as i32,
            "Consolas",
        );
        for font in state.fonts.drain(..) {
            if font != 0 {
                unsafe { DeleteObject(font) };
            }
        }
        let symbol = make(snapshot.scaled_size(11.0, 13.5), FW_NORMAL as i32, "Segoe UI Symbol");
        state.fonts = vec![body, small, bold, mono, symbol];
        unsafe {
            SendMessageW(state.input, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.input_placeholder, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.stop, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.pick_images, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.send, WM_SETFONT, body as WPARAM, 1);
            SendMessageW(state.jump, WM_SETFONT, small as WPARAM, 1);
            // 浮层关闭键是常驻小号控件（标题行没有标题文字）。
            SendMessageW(state.inspector_close, WM_SETFONT, small as WPARAM, 1);
            for child in &state.pending_children {
                SendMessageW(child.hwnd, WM_SETFONT, small as WPARAM, 1);
            }
            // A1：标签条固定按钮与动态按钮跟着全局字体刷新（顶栏不在这里：
            // 全窗宽顶栏子窗口有自己的字体路径，见 windows_main::apply_titlebar_font）。
            if state.pane {
                for control in [state.nav_new, state.nav_history] {
                    SendMessageW(control, WM_SETFONT, small as WPARAM, 1);
                }
                for child in &state.tab_children {
                    SendMessageW(child.hwnd, WM_SETFONT, small as WPARAM, 1);
                }
            }
        }
        // WM_SETFONT 会重置默认字符格式：字色随字体一起重下发。
        unsafe { apply_input_theme(state) };
    });
    // 消息视图按新字体重建（字体在建控件时固化）。
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
    rust_info!("聊天字体已按全局快照刷新（Windows）");
}

/// 渲染更新（主线程队列调度；窗口不在时按 debug 丢弃 —— ChatUi 已按 window_open 门禁）。
pub(crate) fn chat_apply(update: ChatRenderUpdate) {
    let visible = CHAT.with(|cell| {
        cell.borrow().as_ref().is_some_and(|state| {
            crate::ui::chat::is_surface_visible(if state.pane { "main-chat" } else { "chat" })
        })
    });
    if !visible {
        return;
    }
    match update {
        ChatRenderUpdate::Full(snapshot) => {
            with_chat(|state| unsafe { apply_full(state, &snapshot) })
        }
        ChatRenderUpdate::StreamOnly { text } => {
            with_chat(|state| unsafe { update_tail(state, text.as_deref()) })
        }
        ChatRenderUpdate::StatusOnly(status) => with_chat(|state| update_status(state, &status)),
    }
    // 浮层/弹层子树的补画：层窗开合只走 `ShowWindow`，**状态借用期内**同步派回的
    // WM_PAINT 会被重入保护跳过（更新区已被 BeginPaint 验证），而仅当盒几何变化时
    // 才有的那次 `InvalidateRect` 又救不回来 —— 实机表现是「点一下浮层闪一下就
    // 没有了」，只有外部强制重绘才出现（2026-10-07 逐像素取证）。这里在借用之外
    // 补一次整棵子树的失效（含子控件），让浮层随开合真正上屏。
    invalidate_overlay_layers();
}

/// 浮层 / 会话历史弹层的整棵子树失效（在状态借用**之外**调用，见 [`chat_apply`]）。
fn invalidate_overlay_layers() {
    let (inspector, history) = CHAT.with(|cell| {
        cell.try_borrow()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .map(|state| (state.inspector_layer, state.history_layer))
            })
            .unwrap_or((0, 0))
    });
    // `RDW_UPDATENOW`：浮层开合只走 `ShowWindow`，同步派回的那次 WM_PAINT 会在
    // 状态借用期内被重入保护跳过（BeginPaint 已把更新区验证掉）；只 `RDW_INVALIDATE`
    // 的异步失效实机表现为「点一下浮层闪一下就没有了」，而外部同参数 +
    // `RDW_UPDATENOW` 的强制重绘能让浮层立刻上屏（2026-10-07 逐像素取证）。
    // 本函数在状态借用**之外**调用，同步绘制不会撞重入保护。
    for layer in [inspector, history] {
        if layer == 0 || unsafe { IsWindowVisible(layer) } == 0 {
            continue;
        }
        let ok = unsafe {
            RedrawWindow(
                layer,
                std::ptr::null(),
                0,
                RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW,
            )
        };
        if ok == 0 {
            // 绘制期逐帧回落（本帧浮层可能不重画）：静默——降噪 2026-10-08 用户裁定
            // （稳态留痕会随每次刷新刷屏）；本函数的 `RDW_UPDATENOW` 取舍由 2026-10-07
            // 实机逐像素取证覆盖（见上方注释），失败再现时临时加回日志/探针。
        }
    }
}

/// 整帧应用：面板区 → 顶栏/标签条 → 待发送条 → 布局 → 正文画布 → 期限定时器
/// （顺序有依赖：面板/待发送区高度决定画布位置；按钮先建，布局再统一定位）。
unsafe fn apply_full(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        // 浮层开合直接取快照（唯一真相源在模型；平台不翻转本地状态）。
        state.inspector_open = snapshot.inspector_open;
        if state.active_session != snapshot.active_session {
            state.active_session = snapshot.active_session.clone();
            state.view_generation = state.view_generation.wrapping_add(1);
            // 换会话 = 换了一份正文：未读标记跟着清（新会话从头看起）。
            state.jump_unread = false;
            crate::ui::chat::sync_inline_visible(
                if state.pane { "main-chat" } else { "chat" },
                Vec::new(),
            );
        }
        rebuild_panels(state, snapshot);
        rebuild_tabs(state, snapshot);
        rebuild_pending(state, snapshot);
        layout_panes_for(state);
        rebuild_canvas(state, snapshot);
        arm_deadline_timer(state);
    }
}

/// A3 待发送条重建（选择后、发送前的预览条）。
///
/// 发送成功 / 撤选 / 切会话都会让快照里的 `pending_images` 变化并经整帧刷新
/// 回到这里 —— 条目随快照整体替换，不另存第二份选择态。
///
/// 2026-10-06 用户实测两件事落在这里：
/// - 条目带**缩略图**（粘贴的图要看得见）：像素来自共享 `pending_strip` 缓存，
///   未就绪先按文字形态显示、就绪后由工作线程重推快照自动补上 —— **本函数不解码**；
/// - 条目超出条宽时**横向可滚**（子控件按内容坐标建，`layout_panes_for` 统一平移；
///   滚轮在 `scroll_pending_from_wheel`），新增条目自动滚到最右露出刚加的图。
unsafe fn rebuild_pending(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        for child in state.pending_children.drain(..) {
            DestroyWindow(child.hwnd);
            // 缩略图注册表随控件换代（owner-draw 按 hwnd 查表，旧句柄不留影）。
            PENDING_THUMBS.with(|images| {
                images.borrow_mut().remove(&child.hwnd);
            });
        }
        state.pending_targets.clear();
        // 条内集合就是缩略图缓存的保留集：撤选/发送/切会话后，条外像素立即下岗。
        crate::ui::chat::retain_pending_thumbs(&snapshot.pending_images);
        if snapshot.pending_images.is_empty() {
            state.pending_height = 0;
            state.pending_content_w = 0;
            state.pending_scroll_x = 0;
            state.pending_count = 0;
            state.pending_reveal_end = false;
            update_send_enabled(state); // 待发送区变化 = 「发送」可用态的输入之一
            return; // 空 = 已释放（控件不必存在）
        }
        let scale = dpi_scale(state.hwnd);
        let hinstance = GetModuleHandleW(std::ptr::null());
        let height = scaled(PENDING_HEIGHT, scale);
        let chip_h = scaled(PENDING_CHIP_HEIGHT, scale);
        // 条目高 = chip 高、在条内垂直居中（设计稿 `.pend` 的 5px 上下内边距），
        // 左起 `PENDING_PAD_X`（`.pend` 的 10px 左右内边距）。
        let chip_y = ((height - chip_h) / 2).max(0);
        let mut x = scaled(PENDING_PAD_X, scale);
        let mut thumbs: Vec<(HWND, DecodedFrame)> = Vec::new();
        for (index, image) in snapshot.pending_images.iter().enumerate() {
            let label = crate::ui::chat::pending_label(image);
            // 缩略图只查缓存/登记任务（解码在 `deskpet-pending-thumb` 工作线程）；
            // 未就绪（Loading/Unavailable）按纯文案走 —— 不显示半个图。
            let thumb = match crate::ui::chat::pending_thumb(image) {
                crate::ui::chat::PendingThumbStatus::Ready(frame) => {
                    let (thumb_w, thumb_h) = crate::ui::chat::pending_strip::thumb_display_size(
                        frame.width,
                        frame.height,
                    );
                    Some((frame, thumb_w, thumb_h))
                }
                _ => None,
            };
            let text_width = crate::ui::chat::panels::estimated_text_width(&label, 12.0);
            let thumb_width = thumb
                .as_ref()
                .map(|(_, width, _)| f64::from(*width))
                .unwrap_or(0.0);
            let logical = crate::ui::chat::pending_strip::chip_width(
                text_width,
                thumb_width,
                f64::from(PENDING_ITEM_MIN_WIDTH),
                f64::from(PENDING_ITEM_MAX_WIDTH),
            )
            .round() as i32;
            let width = scaled(logical, scale);
            let hwnd = CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(&label).as_ptr(),
                WS_CHILD | WS_VISIBLE,
                x,
                chip_y,
                width,
                chip_h,
                state.hwnd,
                (PENDING_BASE + index as i32) as HMENU,
                hinstance,
                std::ptr::null(),
            );
            if hwnd != 0 {
                make_themed_button_r(hwnd, ButtonRole::Pending, scale, theme::tokens().radii.sm);
                if let Some((frame, _, _)) = thumb {
                    thumbs.push((hwnd, frame));
                }
                state.pending_children.push(ChildEntry {
                    hwnd,
                    x,
                    y: chip_y,
                    w: width,
                    h: chip_h,
                });
                if let Some(font) = state.fonts.get(1) {
                    SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
                }
            }
            state.pending_targets.push(image.path.clone());
            x += width + scaled(6, scale);
        }
        PENDING_THUMBS.with(|images| {
            let mut images = images.borrow_mut();
            for (hwnd, frame) in thumbs {
                images.insert(hwnd, frame);
            }
        });
        // 内容总宽走共享几何（与 macOS 同一口径；单位 = 物理像素，各输入同单位）。
        let widths: Vec<f64> = state
            .pending_children
            .iter()
            .map(|child| f64::from(child.w))
            .collect();
        state.pending_content_w = crate::ui::chat::pending_strip::strip_content_width(
            &widths,
            f64::from(scaled(PENDING_PAD_X, scale)),
            f64::from(scaled(6, scale)),
        )
        .round() as i32;
        // 新增条目（张数变多）→ 由 layout 滚到最右，把刚加的图露出来。
        let count = snapshot.pending_images.len();
        if count > state.pending_count {
            state.pending_reveal_end = true;
        }
        state.pending_count = count;
        state.pending_height = height;
        update_send_enabled(state); // 待发送区变化 = 「发送」可用态的输入之一
                                    // 条内容变化（增删条目/滚动偏移）也要重画条底的滚动指示；条目控件自身的
                                    // 重绘范围不含那条细线。几何未变时 layout 不会整窗作废，这里显式作废条区
                                    //（首次重建时 `paint.pending` 还是空矩形，作废零面积 = no-op，随后 layout
                                    // 因条区从无到有整窗作废一次）。
        InvalidateRect(state.hwnd, &state.paint.pending, 0);
    }
}

// ==========================================
// 画布：滚动与子控件堆叠
// ==========================================

pub(super) unsafe extern "system" fn canvas_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // 画布底由 WM_PAINT（paint_canvas_shell）统一画；吞掉擦除防闪烁。
            1
        }
        WM_PAINT => {
            unsafe {
                paint_chat_window(hwnd, |state, hdc| paint_canvas_shell(state, hdc));
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
        WM_DRAWITEM => {
            if lparam != 0 {
                let item = unsafe { &*(lparam as *const DrawItemStruct) };
                if item.CtlType == ODT_BUTTON {
                    // 图片占位（有帧数据）走既有专用绘制；其余所有按钮走主题面。
                    if draw_inline_button(item) {
                        return 1;
                    }
                    unsafe { draw_themed_button(item) };
                    return 1;
                }
            }
            0
        }
        WM_VSCROLL => {
            canvas_scroll((wparam & 0xFFFF) as i32);
            0
        }
        WM_MOUSEWHEEL => {
            // 滚轮增量在 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
            // y 坐标 —— 2026-10-06 前误读 lParam，步长随窗口在屏幕上的位置漂移）。
            let delta = ((wparam >> 16) & 0xFFFF) as u16 as i16;
            let lines = (i32::from(delta) / 120).clamp(-5, 5);
            for _ in 0..lines.abs() {
                canvas_scroll(if lines > 0 { SB_LINEUP } else { SB_LINEDOWN });
            }
            0
        }
        WM_SIZE => {
            with_chat(|state| unsafe {
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(state.canvas, &mut client);
                state.viewport_height = client.bottom - client.top;
                apply_scroll(state);
            });
            0
        }
        WM_DROPFILES => {
            // A3：拖进正文画布的文件 → 待发送区。
            unsafe { handle_dropped_files(wparam as HDROP) };
            0
        }
        WM_NOTIFY => {
            // RichEdit 子控件的通知先到画布，这里转发给聊天窗统一处理。
            unsafe {
                SendMessageW(GetParent(hwnd), WM_NOTIFY, wparam, lparam);
            }
            0
        }
        WM_COMMAND => {
            // 画布子控件（图片占位按钮）的通知先到画布，
            // 转发给聊天窗统一处理（与 WM_NOTIFY 同一路由；chat_wndproc 有目标表）。
            unsafe {
                SendMessageW(GetParent(hwnd), WM_COMMAND, wparam, lparam);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

pub(super) fn canvas_scroll(command: i32) {
    with_chat(|state| unsafe {
        let scale = dpi_scale(state.hwnd);
        let line = scaled(LINE_HEIGHT as i32, scale);
        let page = (state.viewport_height - line).max(line);
        match command {
            SB_LINEUP => state.scroll_y -= line,
            SB_LINEDOWN => state.scroll_y += line,
            SB_PAGEUP => state.scroll_y -= page,
            SB_PAGEDOWN => state.scroll_y += page,
            SB_TOP => state.scroll_y = 0,
            SB_BOTTOM => state.scroll_y = state.content_height,
            SB_THUMBTRACK | SB_THUMBPOSITION => {
                let mut info: SCROLLINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
                info.fMask = SIF_ALL;
                GetScrollInfo(state.canvas, SB_VERT, &mut info);
                state.scroll_y = info.nTrackPos.max(0);
            }
            _ => {}
        }
        apply_scroll(state);
        page_transcript_if_needed(state);
    });
}

/// 正文分段加载（与 macOS `page_transcript_if_needed` 对称）：上滑到顶静默补
/// 更早一页，直到第一条；回到底部丢弃已展开的旧段。不展示加载态 ——
/// 消息已在投影快照里，这里只伸缩渲染窗口。
fn page_transcript_if_needed(state: &mut ChatWinState) {
    let snapshot = crate::ui::chat::snapshot();
    let total = snapshot.messages.len();
    let start = state.message_window_start;
    if start == usize::MAX {
        return;
    }
    let tail_start = total.saturating_sub(TRANSCRIPT_PAGE_MESSAGES);
    if state.scroll_y <= 8 && start > 0 {
        let old_doc = state.content_height;
        state.message_window_start = start.saturating_sub(TRANSCRIPT_PAGE_MESSAGES);
        unsafe { rebuild_canvas(state, &snapshot) };
        // 前插后内容变高：滚动位置前移同一差值，保持用户正在看的内容不动。
        let delta = (state.content_height - old_doc).max(0);
        state.scroll_y += delta;
        unsafe { apply_scroll(state) };
        return;
    }
    if start < tail_start
        && scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height)
    {
        // 回到底部：丢弃已展开的旧段（下次上滑重新分段加载）。
        state.message_window_start = usize::MAX;
        unsafe { rebuild_canvas(state, &snapshot) };
    }
}

/// 按 scroll_y 重排子控件并更新滚动条（子控件随 scroll_y 上移）。
pub(super) unsafe fn apply_scroll(state: &mut ChatWinState) {
    unsafe {
        let max_scroll = (state.content_height - state.viewport_height).max(0);
        let scroll_y = state.scroll_y.clamp(0, max_scroll);
        state.scroll_y = scroll_y;
        // 到达底部即清未读（「↓ 新消息」随之收起；未读的唯一清除点）。
        if scroll_at_bottom(scroll_y, state.viewport_height, state.content_height) {
            state.jump_unread = false;
        }
        for child in &state.children {
            MoveWindow(child.hwnd, child.x, child.y - scroll_y, child.w, child.h, 1);
        }
        let mut info: SCROLLINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMin = 0;
        info.nMax = state.content_height.max(1);
        info.nPage = state.viewport_height.max(1) as u32;
        info.nPos = scroll_y;
        SetScrollInfo(state.canvas, SB_VERT, &info, 1);
        ShowScrollBar(state.canvas, SB_VERT, i32::from(max_scroll > 0));
    }
    // 子控件随 scroll_y 移动、卡片框也要跟着重画：画布整体失效（bErase=0，
    // WM_PAINT 全量重画，不需要系统擦除）。
    unsafe { InvalidateRect(state.canvas, std::ptr::null(), 0) };
    update_jump_visibility(state);
    sync_inline_visible(state);
}

fn sync_inline_visible(state: &mut ChatWinState) {
    let top = state.scroll_y;
    let bottom = top + state.viewport_height;
    let mut visible = Vec::new();
    for target in &mut state.image_targets {
        if target.content_y < bottom && target.content_y + target.height > top {
            visible.push(crate::ui::chat::InlineVisibleImage {
                owner: target.owner.clone(),
                path: target.path.clone(),
            });
        } else if target.frame.take().is_some() {
            DRAW_IMAGES.with(|images| {
                if let Some(draw) = images.borrow_mut().get_mut(&target.hwnd) {
                    draw.frame = None;
                }
            });
            unsafe { InvalidateRect(target.hwnd, std::ptr::null(), 1) };
        }
    }
    crate::ui::chat::sync_inline_visible(if state.pane { "main-chat" } else { "chat" }, visible);
}

fn draw_inline_button(item: &DrawItemStruct) -> bool {
    let target = DRAW_IMAGES.with(|images| images.borrow().get(&item.hwndItem).cloned());
    let Some(target) = target else { return false };
    unsafe {
        // 图片占位 chip：底/描边走按钮 chip 族（`--bbg/--bedge/--bsh`；2026-10-05
        // 从输入框族改回按钮族，与 macOS `Face::Chip` 对齐 —— 输入框族在消息流里
        // 像一条通栏横幅「和主题不符」，评审实机证据）；图片与标题叠在上面。
        let tokens = theme::tokens();
        let face = paint_win::button_face(
            tokens,
            ButtonRole::Normal,
            paint_win::button_hovered(item.hwndItem),
            item.itemState & ODS_SELECTED != 0,
        );
        let rect = paint_win::Rect::new(
            item.rcItem.left,
            item.rcItem.top,
            item.rcItem.right - item.rcItem.left,
            item.rcItem.bottom - item.rcItem.top,
        );
        // 图片占位 chip 挂画布：底走画布真实像素重放（与消息流背景对齐）。
        let backdrop = unsafe { blit_button_backdrop(item, rect) };
        paint_win::draw_button(
            item.hDC,
            item.hwndItem,
            rect,
            &face,
            "",
            false,
            false,
            backdrop,
        );
        SetBkMode(item.hDC, TRANSPARENT);
        SetTextColor(item.hDC, paint_win::colorref(tokens.ink));
        let mut text_rect = item.rcItem;
        if let Some(frame) = target.frame {
            if frame.width > 0 && frame.height > 0 {
                // chip 尺寸 = 缩放图宽 + 16、图高 + 32（见 `build_message_controls`）：
                // 预览图在 chip 内居中，标题在图下方（与 macOS 的 ImageAbove 同位）。
                let available_width = (item.rcItem.right - item.rcItem.left - 16).max(1);
                let available_height = (item.rcItem.bottom - item.rcItem.top - 32).max(1);
                let image_height = available_height
                    .min(available_width * frame.height as i32 / frame.width as i32)
                    .max(1);
                let image_width = (image_height * frame.width as i32 / frame.height as i32).max(1);
                let image_top = item.rcItem.top + 8;
                let image_left = item.rcItem.left
                    + ((item.rcItem.right - item.rcItem.left - image_width) / 2).max(0);
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
                    // Little-endian DIB masks read RGBA bytes as R=low, G=next, B=third.
                    masks: [0x0000_00FF, 0x0000_FF00, 0x00FF_0000],
                };
                StretchDIBits(
                    item.hDC,
                    image_left,
                    image_top,
                    image_width,
                    image_height,
                    0,
                    0,
                    frame.width as i32,
                    frame.height as i32,
                    frame.rgba.as_ptr().cast(),
                    (&mut info as *mut RgbaBitmapInfo).cast::<BITMAPINFO>(),
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
                text_rect.top = image_top + image_height + 2;
            }
        }
        let text = wide(&target.title);
        // chip 是贴合内容宽度的单行件（宽 = 估宽 + 22）：单行 + 尾部省略与 macOS
        // 的按钮标题截断同义（旧版满宽大按钮才需要 WORDBREAK）。
        DrawTextW(
            item.hDC,
            text.as_ptr(),
            -1,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
    }
    true
}

// ==========================================
// 消息列表重建（RTF）
// ==========================================

/// 全量重建画布内容（投影整帧；流式更新只换尾巴）。
pub(super) unsafe fn rebuild_canvas(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        // 观测计数（dev A/B）：一次整帧重建（与 macOS `rebuild` 对称）。
        crate::ui::chat::stream_metrics::note_full_rebuild();
        let previous_content = state.content_height;
        let was_at_bottom =
            scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
        release_canvas(state);

        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.canvas, &mut client);
        let canvas_width = (client.right - client.left).max(scaled(200, scale));
        // 说话人名只来自投影（人格域 `activeCardName`）；没有就不显示名 ——
        // 不留硬编码角色名兜底（空串标签渲染为空文本）。
        let speaker = snapshot.speaker.clone().unwrap_or_default();
        state.speaker = speaker.clone();

        // 分段加载：首屏只渲染尾段；窗口起点记在状态里，滚动到顶时向前扩页。
        let total_messages = snapshot.messages.len();
        let start = match state.message_window_start {
            usize::MAX => total_messages.saturating_sub(TRANSCRIPT_PAGE_MESSAGES),
            requested => requested.min(total_messages),
        };
        state.message_window_start = start;
        let mut y = scaled(6, scale);
        for message in &snapshot.messages[start..] {
            y = build_message_controls(state, message, &speaker, canvas_width, y, scale);
        }
        state.base_height = y;
        if let Some(text) = snapshot.streaming.as_deref() {
            y = build_tail_controls(state, text, canvas_width, y, scale);
        }
        state.content_height = y + scaled(8, scale);
        // 未读判据（2026-10-05 用户规则）：**正文/流式版本号前进**（真的有新内容，
        // 窗口缩放导致的重排不算）、用户不在底部、且内容确实变长 = 有新内容落到
        // 视口外；在底部时下面会把滚动贴回底部，不记未读。
        let fresh_content = snapshot.transcript_revision != state.seen_transcript_revision
            || snapshot.stream_revision != state.seen_stream_revision;
        if !was_at_bottom && fresh_content && state.content_height > previous_content {
            state.jump_unread = true;
        }
        state.seen_transcript_revision = snapshot.transcript_revision;
        state.seen_stream_revision = snapshot.stream_revision;
        update_status(state, &snapshot.status);
        if was_at_bottom {
            state.scroll_y = (state.content_height - state.viewport_height).max(0);
        }
        apply_scroll(state);
        // 卡片框（气泡外框）在画布上，重建后要整块重画。
        InvalidateRect(state.canvas, std::ptr::null(), 0);
    }
}

/// 隐藏/重建时释放聊天正文控件与平台像素登记；模型快照仍是正文的唯一来源。
pub(super) unsafe fn release_canvas(state: &mut ChatWinState) {
    unsafe {
        for child in &state.children {
            DestroyWindow(child.hwnd);
        }
        state.children.clear();
        state.links.clear();
        state.message_menu_targets.clear();
        DRAW_IMAGES.with(|images| {
            let mut images = images.borrow_mut();
            for target in &state.image_targets {
                images.remove(&target.hwnd);
            }
        });
        state.image_targets.clear();
        state.card_frames.clear();
        state.tail = None;
        state.content_height = 0;
        state.base_height = 0;
        state.scroll_y = 0;
    }
}

/// 一条消息：角色标签 + 每个可见泡（散文段/代码块）+ 图片占位按钮。
unsafe fn build_message_controls(
    state: &mut ChatWinState,
    message: &MessageSnapshot,
    speaker: &str,
    canvas_width: i32,
    mut y: i32,
    scale: f64,
) -> i32 {
    unsafe {
        // 展示层只放真正的聊天记录（2026-10-05 用户规则：「别把工具和思考放到展示
        // 层，展示只放真正的聊天记录」）：工具结果条目整条不渲染（工具调用卡与
        // 思考块同样已退场——见下方删除记录），只有正文泡/图片算可渲染内容。
        if message.role == Role::Tool {
            return y;
        }
        // 可见性判定与平台无关：正文泡/图片任一存在即渲染；纯工具调用/纯思考的
        // 条目（无正文无图）整条跳过（`has_renderable_content` 已收窄口径）。
        if !message.has_renderable_content() {
            return y;
        }
        // 工具失败结果：中性系统行（标签加「失败」后缀 + 弱提示底色），不伪装角色台词。
        let failed_tool = message.is_failed_tool_result();
        // 「记住这条」右键菜单的事件身份：只有用户消息有（共享判据，平台层不判角色）；
        // 同一条消息的多个控件（各段气泡、代码块）共用同一个身份。
        let remember = message.remember_event_id();
        // 说话人标签：用户条目不摆「你」（右对齐气泡自明身份）、助手无角色名时不摆
        // 空标签 —— 与 macOS 共用 `role_label_text`（两平台同一口径）。
        if let Some(label_text) = role_label_text(message.role, speaker, failed_tool) {
            let label = create_child(
                state,
                "STATIC",
                &label_text,
                0,
                WS_CHILD | WS_VISIBLE,
                scaled_f(BUBBLE_SIDE_MARGIN, scale),
                y,
                canvas_width - scaled_f(BUBBLE_SIDE_MARGIN * 2.0, scale),
                scaled(LABEL_HEIGHT, scale),
            );
            send_font(state, label, 1); // 小号字
                                        // 说话人标签：次要文字；失败工具行用 warn（与正文前景同族）。
            stamp_ink(
                label,
                if failed_tool {
                    theme::tokens().warn
                } else {
                    theme::tokens().dim
                },
            );
            y += scaled(LABEL_HEIGHT, scale) + 3;
        }

        // 气泡列：留白/上限/下限/内边距与宽度算法是两平台共用的 `panels` 口径
        // （2026-10-05 起用户泡右对齐、助手泡左对齐，最宽 86%）；本模块只做
        // 平台侧的量测（估宽）与构建。代码块与气泡同列。
        // 「记住这条」入口的当前形态（2026-10-05 二改）：泡内按钮已删除，入口改由
        // **消息右键菜单**承接（`message_menu_subclass_proc`，只对用户消息挂项；
        // 自动路径仍在 Node 记忆域，与展示层无关）。
        let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
        let cap = scaled_f(bubble_cap(f64::from(canvas_width) / scale), scale);
        let column_x = margin;

        for part in message.visible_parts.iter() {
            if part.trim().is_empty() {
                continue;
            }
            // 段级拆分（2026-10-05 用户规则，与 macOS `build_message_view` 同口径）：
            // 一个 part 里的空行分段拆成多条气泡 —— 历史里已提交的单泡多段记录
            // （拟人化开启前的）也一条条显示，不再「一坨」。含代码块（```）的正文
            // 不拆（split_paragraphs 内部裁定），技术内容保持整条。
            let paragraphs = crate::ui::chat::panels::split_paragraphs(part);
            for paragraph in &paragraphs {
                let blocks = parse_blocks(paragraph);
                let has_code = blocks
                    .iter()
                    .any(|block| matches!(block, Block::CodeBlock { .. }));
                // 连续散文块合并进一个 RichEdit（= 一条气泡）；代码块各自一个
                // （独立横向滚动）。
                let mut segment: Vec<Block> = Vec::new();
                for block in blocks {
                    match block {
                        Block::CodeBlock { lang, lines } => {
                            flush_prose(
                                state,
                                &mut segment,
                                message.role,
                                failed_tool,
                                canvas_width,
                                &mut y,
                                column_x,
                                cap,
                                has_code,
                                remember,
                                scale,
                            );
                            // 代码块与气泡同列（含代码时泡宽 = 上限，代码块撑满该列）；
                            // 用户条目的列随泡右对齐。
                            let code_x = if message.role == Role::User {
                                (canvas_width - margin - cap).max(margin)
                            } else {
                                column_x
                            };
                            let (_, height) = create_code_control(
                                state, &lang, &lines, code_x, y, cap, remember, scale,
                            );
                            y += height + scaled(4, scale);
                        }
                        other => segment.push(other),
                    }
                }
                flush_prose(
                    state,
                    &mut segment,
                    message.role,
                    failed_tool,
                    canvas_width,
                    &mut y,
                    column_x,
                    cap,
                    has_code,
                    remember,
                    scale,
                );
                y += scaled(4, scale);
            }
        }

        for (index, placeholder) in message.images.iter().enumerate() {
            let image_index = index as u32;
            let owner = crate::images::preview::PreviewOwner {
                window_id: if state.pane { "main" } else { "chat" }.into(),
                view_generation: state.view_generation,
                session_id: state.active_session.clone().unwrap_or_default(),
                entry_id: message.id.clone(),
                image_index,
            };
            let mut title = placeholder_label(index, placeholder);
            let mut frame = None;
            match crate::ui::ports::inline_preview().state_of(&owner) {
                Some(crate::images::inline::InlinePreviewState::Ready(ready)) => {
                    frame = Some(ready)
                }
                Some(crate::images::inline::InlinePreviewState::Loading) => {
                    title.push_str("（预览加载中）");
                }
                Some(crate::images::inline::InlinePreviewState::Unavailable { reason }) => {
                    title.push_str(&format!("（预览失败：{reason}）"));
                }
                None => {}
            }
            // 占位 chip（设计稿 `.chip` 的 `--bbg/--bedge/--bsh` 按钮族，与 macOS
            // `Face::Chip` 同族；2026-10-05 前是输入框族——评审实测它在消息流里
            // 像一条通栏横幅「和主题不符」）：贴合内容宽度、高 24；宽度上限与气泡
            // 同受 `bubble_cap`（86% 列宽）限制。带内联预览帧时仍走预览路径
            //（宽 = 缩放图宽 + 16、高 = 图高 + 32）。
            let chip_max = bubble_cap(f64::from(canvas_width) / scale).max(64.0);
            let mut chip_w = scaled_f(
                (estimated_text_width(&title, 11.0) + 22.0).clamp(64.0, chip_max),
                scale,
            );
            let mut button_h = scaled(24, scale);
            if let Some(ready) = frame.as_ref() {
                let cap_logic = f64::from(cap) / scale;
                let shrink = (cap_logic / f64::from(ready.width.max(1)))
                    .min(180.0 / f64::from(ready.height.max(1)))
                    .min(1.0);
                let image_height = (f64::from(ready.height) * shrink).max(1.0);
                chip_w = scaled_f(
                    (f64::from(ready.width) * shrink + 16.0).clamp(64.0, chip_max),
                    scale,
                );
                button_h = scaled_f(image_height + 32.0, scale);
            }
            // 用户条目的图片随气泡列右对齐；其余左对齐（与气泡同列）。
            let chip_x = if message.role == Role::User {
                (canvas_width - margin - chip_w).max(margin)
            } else {
                column_x
            };
            let button_y = y;
            let control_id = PLACEHOLDER_BASE + state.image_targets.len() as i32;
            let control = create_child(
                state,
                "BUTTON",
                &title,
                control_id,
                WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
                chip_x,
                y,
                chip_w,
                button_h,
            );
            if control != 0 {
                // 按钮 chip 族（`--bbg/--bedge/--bsh` + 小圆角 `--r1`；`ButtonRole::Normal`
                // 就是 bbg 族，与 macOS 的 `Face::Chip` 逐 token 对应）。
                make_themed_button_r(control, ButtonRole::Normal, scale, theme::tokens().radii.sm);
                let target = WinImageTarget {
                    entry_id: message.id.clone(),
                    image_index,
                    path: placeholder.path.clone(),
                    owner,
                    hwnd: control,
                    content_y: button_y,
                    height: button_h,
                    title,
                    frame,
                };
                DRAW_IMAGES.with(|images| {
                    images.borrow_mut().insert(control, target.clone());
                });
                state.image_targets.push(target);
                unsafe { InvalidateRect(control, std::ptr::null(), 1) };
            }
            y += button_h + scaled(4, scale);
        }

        y += scaled(MESSAGE_SPACING, scale);
        y
    }
}

// `build_remember_entry` 删除记录（2026-10-05 用户规则「我的消息去掉『记住这条』按钮，
// 要么我叫他记住，要么自动」）：平台侧入口按钮、`REMEMBER_BASE` 动作段、
// `remember_targets` 事件表与 `draw_themed_button` 的泡内配色分支一并删除；
// 记忆能力本身不动 —— `PanelAction::RememberMessage` → `ChatIntent::RememberMessage`
// → Node 的 "remember-message" 通道保留（显式路径由用户/命令触发，自动路径在 Node
// 记忆域）；`MessageSnapshot.event_id` 仍是投影数据。
// 二改（2026-10-05 图片通路批收尾）：入口以**消息右键菜单**形态恢复 ——
// `MessageSnapshot::remember_event_id` 判据 + `message_menu_subclass_proc` 菜单，
// 泡内文字按钮与动作段不恢复（守门测试继续禁）。

// `build_thinking_controls` 删除记录（2026-10-05）：思考块（折叠 chip/展开正文）
// 随用户规则「别把工具和思考放到展示层，展示只放真正的聊天记录」整体退场，
// 连同 `THINKING_BASE` 动作段、`thinking_targets`/`thinking_expanded` 状态与
// chip「贴合宽度」量测一起删除。

// `build_tool_card_controls` 删除记录（2026-10-05）：工具调用卡随「展示层只放
// 真正的聊天记录」用户规则退场；运行中的工具活动**不在聊天窗底部呈现**
// （2026-10-05 用户规则：过程状态文案只在顶栏显示；把手带只显示中性通知）。

/// 把已累积的散文块渲染成 RTF 控件（段结束时调用）。
///
/// **贴合内容宽度**（与 macOS `build_bubble_view` 同一算法，量测手段不同）：
/// `cap` 只是上限，实际泡宽取正文自然宽（估宽）；用户泡右对齐、其余与列左缘
/// 对齐。正文仍按上限宽度排版（RichEdit 自己的折行），泡宽只影响控件/外框摆位。
///
/// 2026-10-05 用户规则「我的消息去掉『记住这条』按钮，要么我叫他记住，要么自动」：
/// 入口宽度参数给 `bubble_content_width` 的 footer 位传 0（共享算法的「无入口」值），
/// 泡底不再留入口高度，平台侧的入口按钮与事件表已整体删除（二改：入口改由消息
/// 右键菜单承接，见 `show_message_menu`；`remember` 参数就是给子类挂项用的）。
#[allow(clippy::too_many_arguments)]
unsafe fn flush_prose(
    state: &mut ChatWinState,
    segment: &mut Vec<Block>,
    role: Role,
    failed_tool: bool,
    canvas_width: i32,
    y: &mut i32,
    column_x: i32,
    cap: i32,
    has_code: bool,
    // 「记住这条」右键菜单的事件身份（仅用户消息有；控件挂子类用，见
    // `message_menu_subclass_proc`）。
    remember: Option<&str>,
    scale: f64,
) {
    if segment.is_empty() {
        return;
    }
    // 空段落（含代码块 part 的尾随换行解析出的空行）不成泡：只有空段落的段被
    // 跳过，不画一个只有空行的空白气泡框（macOS 侧这类空行并进同一条气泡，
    // Windows 的代码块是独立控件 —— 就地注明这一平台差异）。
    if !segment_has_text(segment) {
        segment.clear();
        return;
    }
    // 主题底 + 前景色索引（RichEdit 不能透明：底色 = token 代表色合成面板底）。
    // 卡片与 macOS `BubbleTheme::for_message` 对齐：用户泡 = 气泡族（立体线 + 投影），
    // 助手 = 轻气泡（`bubble_ai_*`，无立体线/投影），系统条目落面板底
    // （工具结果条目整条不渲染 —— 2026-10-05 展示层只放聊天记录；下方 `Role::Tool`
    // 分支只为 match 完整性保留，与 macOS `BubbleTheme::for_role` 同口径）。
    let tokens = theme::tokens();
    let (background, ink, card) = if failed_tool {
        // 失败工具结果：warn 12% 作底、warn 作前景（中性提示，不伪装角色台词）。
        (rich_bg_alpha(tokens.warn, 0.12), RTF_WARN, None)
    } else {
        match role {
            Role::User => (
                rich_bg(&tokens.bubble_user_bg),
                RTF_USER_INK,
                Some(CardKind::UserBubble),
            ),
            Role::Assistant => (
                rich_bg(&tokens.bubble_ai_bg),
                RTF_INK,
                Some(CardKind::AssistantBubble),
            ),
            // 系统条目与 mac 同口径（`macos_chat::BubbleTheme::for_role` 的
            // `Role::System`）：**无卡、无底、`dim` 字** —— 旧实现给 ink 字 +
            // 面板底，系统消息在消息流里读成「一条正常发言」。承载控件不能透明，
            // 底仍取面板色（与画布同值、接缝不可见），只把字色改到 `dim`。
            Role::System => (rich_bg(&tokens.panel_bg), RTF_DIM, None),
            Role::Tool => (rich_bg(&tokens.panel_bg), RTF_INK, None),
        }
    };
    // 泡宽：内容自然宽（逐行估宽的最大值）夹在上下限之间；含代码块时直接给上限
    // （`bubble_content_width` 的共享口径；footer 位传 0 = 无入口）。
    let used = prose_estimated_width(segment, RTF_BODY_LOGICAL_SIZE);
    let cap_logic = f64::from(cap) / scale;
    // RichEdit 不能透明：承载控件为 1px 描边 + 1px 立体线，每侧让出 2px（共 4px）；
    // 共享泡宽只含 2px 总余量 —— 卡片补 2px，控件正文区才等于估宽。夹回列宽上限。
    let border_extra = if card.is_some() { scaled(2, scale) } else { 0 };
    let bubble_w = (scaled_f(bubble_content_width(used, has_code, 0.0, cap_logic), scale)
        + border_extra)
        .min(cap);
    let margin = scaled_f(BUBBLE_SIDE_MARGIN, scale);
    let x = if role == Role::User {
        (canvas_width - margin - bubble_w).max(margin)
    } else {
        column_x
    };
    let (rtf, links) = prose_to_rtf_colored(segment, ink);
    segment.clear();
    let (control, height) = unsafe {
        create_rtf_control(
            state, &rtf, x, *y, bubble_w, background, card, remember, scale, false,
        )
    };
    if control != 0 && !links.is_empty() {
        // EN_LINK 是**控件级事件掩码**：不设掩码时点击链接不会发任何通知，也不会有
        // 任何默认打开行为（RichEdit 没有 AppKit 那样的「控件自己打开」回落）；
        // 掩码按「本控件确实带链接」逐个设置 —— 两侧都不依赖全局状态。
        unsafe {
            SendMessageW(control, EM_SETEVENTMASK, 0, ENM_LINK as LPARAM);
        }
        state.links.insert(control, links);
    }
    *y += height + scaled(2, scale);
}
