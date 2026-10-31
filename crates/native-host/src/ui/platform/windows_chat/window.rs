//! 窗口类注册、聊天窗与查看器窗口的创建/关闭与消息循环接线。

use super::*;
use super::input::{hit_transparent_subclass_proc, input_subclass_proc};
use super::layout::{apply_input_theme, inspector_scroll_wndproc, layout_panes};
use super::paint::{make_themed_button, make_themed_button_r, overlay_layer_wndproc, stamp_ink};
use super::transcript::canvas_wndproc;
use super::wndproc::chat_wndproc;
use crate::{rust_debug, rust_info, rust_warn};

// ==========================================
// 平台入口（`ui/chat` 经 `platform::chat_imp` 调用，全部在主线程）
// ==========================================

/// 打开（或前移）聊天窗；不存在即创建并全量渲染。
///
/// 主窗聊天面板已挂载时（W9a 产品形态）不再开第二个聊天面：前移主窗并留痕。
pub(crate) fn open_chat_window() {
    let existing = CHAT.with(|cell| cell.borrow().as_ref().map(|state| (state.hwnd, state.pane)));
    if let Some((hwnd, pane)) = existing {
        unsafe {
            if pane {
                rust_info!("主窗聊天面板已挂载，独立聊天窗请求转为前移主窗（同窗合成优先）");
                let parent = GetParent(hwnd);
                if parent != 0 {
                    SetForegroundWindow(parent);
                }
            } else {
                ShowWindow(hwnd, SW_SHOW);
                SetForegroundWindow(hwnd);
            }
        }
        if !pane {
            crate::ui::chat::set_chat_window_open(true);
            crate::ui::chat::set_chat_window_visible(true);
        }
        return;
    }
    match unsafe { create_chat_window() } {
        Ok(()) => {
            crate::ui::chat::set_chat_window_open(true);
            crate::ui::chat::set_chat_window_visible(true);
        }
        Err(error) => rust_warn!("聊天窗创建失败: {error}"),
    }
}

/// 关闭聊天窗（关闭即释放控件与字体，可再次打开；主窗面板走 `set_main_pane_visible`）。
pub(crate) fn close_chat_window() {
    let hwnd = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .and_then(|state| if state.pane { None } else { Some(state.hwnd) })
    });
    match hwnd {
        Some(hwnd) => unsafe {
            DestroyWindow(hwnd);
        },
        None => rust_debug!("独立聊天窗未打开，关闭请求忽略"),
    }
}

/// 打开（或前移）独立查看器窗（`WindowId::Viewer`，W5 的附属窗设施）。
pub(crate) fn open_viewer_window() {
    match super::super::windows::open_aux_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已打开/前移"),
        Err(error) => rust_warn!("查看器窗口打开失败: {error}"),
    }
}

/// 关闭查看器窗（未打开时按 debug 记录）。
pub(crate) fn close_viewer_window() {
    match super::super::windows::close_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已关闭"),
        Err(error) => rust_debug!("查看器窗口无需关闭: {error}"),
    }
}

/// 查看器内容挂载（`windows.rs` 的 `open_aux` 在创建 `WindowId::Viewer` 后调用）。
pub(crate) fn install_viewer_content(hwnd: HWND) {
    VIEWER.with(|cell| {
        *cell.borrow_mut() = Some(ViewerState {
            hwnd,
            width: 0,
            height: 0,
            bgra: Vec::new(),
        });
    });
    rust_info!("查看器内容已挂载（等待 PreviewManager 首帧）");
}

/// 查看器帧更新（首帧与动画帧都走这里）。
pub(crate) fn viewer_set_frame(frame: DecodedFrame) {
    // RGBA → BGRA（BI_RGB 32bpp；查看器不做 alpha 合成，逐帧转换成本可接受）。
    let mut bgra = Vec::with_capacity(frame.rgba.len());
    for pixel in frame.rgba.chunks_exact(4) {
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    VIEWER.with(|cell| {
        let mut viewer = cell.borrow_mut();
        let Some(viewer) = viewer.as_mut() else {
            rust_debug!("查看器帧到达但窗口未开/已关，丢弃");
            return;
        };
        viewer.width = frame.width as i32;
        viewer.height = frame.height as i32;
        viewer.bgra = bgra;
        unsafe { InvalidateRect(viewer.hwnd, std::ptr::null(), 1) };
    });
}

/// 查看器窗口绘制（`windows.rs` 的 aux_wndproc 在 WM_PAINT 调用）。
pub(crate) fn paint_viewer(hwnd: HWND) {
    unsafe {
        let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        VIEWER.with(|cell| {
            let viewer = cell.borrow();
            let Some(viewer) = viewer.as_ref() else {
                return;
            };
            if viewer.bgra.is_empty() || viewer.width <= 0 || viewer.height <= 0 {
                return;
            }
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: viewer.width,
                biHeight: -viewer.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            StretchDIBits(
                hdc,
                0,
                0,
                client.right - client.left,
                client.bottom - client.top,
                0,
                0,
                viewer.width,
                viewer.height,
                viewer.bgra.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
        });
        EndPaint(hwnd, &ps);
    }
}

/// 查看器窗口销毁（`windows.rs` 的 aux_wndproc 在 WM_DESTROY 调用）。
pub(crate) fn note_viewer_destroyed() {
    VIEWER.with(|cell| *cell.borrow_mut() = None);
    crate::ui::chat::note_viewer_window_closed();
}

// ==========================================
// 窗口创建与布局
// ==========================================

/// 注册聊天窗/画布类并装载 RichEdit（顶层窗与主窗面板共用同一份）。
pub(super) unsafe fn ensure_chat_classes() -> Result<(), String> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 类名的 UTF-16 缓冲必须先绑定再取指针（临时 Vec 会立刻析构，指针悬垂）。
    let chat_class = wide(CHAT_CLASS);
    let canvas_class = wide(CANVAS_CLASS);
    unsafe {
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = Some(chat_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = chat_class.as_ptr();
        if RegisterClassW(&wc) == 0 {
            return Err("RegisterClassW（聊天窗）失败".into());
        }
        let mut canvas: WNDCLASSW = std::mem::zeroed();
        canvas.style = CS_HREDRAW | CS_VREDRAW;
        canvas.lpfnWndProc = Some(canvas_wndproc);
        canvas.hInstance = hinstance;
        canvas.lpszClassName = canvas_class.as_ptr();
        if RegisterClassW(&canvas) == 0 {
            return Err("RegisterClassW（聊天画布）失败".into());
        }
        // 浮层 Inspector 的承载窗口类（遮罩 + 浮层盒绘制 + 承载内容子控件）。
        let inspector_class = wide(LAYER_CLASS);
        let mut inspector: WNDCLASSW = std::mem::zeroed();
        inspector.style = CS_HREDRAW | CS_VREDRAW;
        inspector.lpfnWndProc = Some(overlay_layer_wndproc);
        inspector.hInstance = hinstance;
        inspector.lpszClassName = inspector_class.as_ptr();
        if RegisterClassW(&inspector) == 0 {
            return Err("RegisterClassW（浮层 Inspector）失败".into());
        }
        // 浮层内容滚动裁剪窗的窗口类（`WS_VSCROLL` 容器；只画盒底）。
        let scroll_class = wide(INSPECTOR_SCROLL_CLASS);
        let mut scroll: WNDCLASSW = std::mem::zeroed();
        scroll.lpfnWndProc = Some(inspector_scroll_wndproc);
        scroll.hInstance = hinstance;
        scroll.lpszClassName = scroll_class.as_ptr();
        if RegisterClassW(&scroll) == 0 {
            return Err("RegisterClassW（浮层滚动窗）失败".into());
        }
    }

    // RichEdit 4.1 需要先装载 Msftedit.dll；失败即如实报错（不静默降级成纯文本壳）。
    let lib = unsafe { LoadLibraryW(wide("Msftedit.dll").as_ptr()) };
    if lib == 0 {
        return Err("Msftedit.dll 装载失败，RichEdit 不可用".into());
    }
    Ok(())
}

unsafe fn create_chat_window() -> Result<(), String> {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    unsafe { ensure_chat_classes()? };

    let system_dpi = unsafe { GetDpiForSystem().max(DPI_BASELINE) };
    let startup_scale = f64::from(system_dpi) / f64::from(DPI_BASELINE);
    let width = scaled(CHAT_WINDOW_WIDTH, startup_scale);
    let height = scaled(CHAT_WINDOW_HEIGHT, startup_scale);
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let x = (screen_w - width) / 2;
    let y = (screen_h - height) / 2;

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(CHAT_CLASS).as_ptr(),
            wide("聊天 - 虚拟桌宠").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            width,
            height,
            0,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if hwnd == 0 {
        return Err("聊天窗 CreateWindowExW 失败".into());
    }
    // 独立顶层窗（父句柄 0） + 高于主窗的层级。W9a：经 `WindowId::Chat` 查表
    // （`creation_level` 是唯一映射，不在这里复制档位）。
    let level = crate::ui::creation_level(WindowId::Chat);
    unsafe {
        crate::window::platform::apply_windows_window_level(hwnd, level);
        SetForegroundWindow(hwnd);
    }
    Ok(())
}

/// 创建子控件（WM_CREATE 时调用，与原型同构）。
///
/// `pane` 由父窗口判定：有父窗口 = 主窗内聊天面板（W9a），无父窗口 = 独立聊天窗。
pub(super) unsafe fn build_children(hwnd: HWND) {
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let scale = dpi_scale(hwnd);
    let pane = unsafe { GetParent(hwnd) } != 0;

    // ── 画布（可滚动堆叠容器，承载消息 RichEdit 与占位按钮）──
    let canvas = unsafe {
        CreateWindowExW(
            0,
            wide(CANVAS_CLASS).as_ptr(),
            wide("").as_ptr(),
            // `WS_CLIPSIBLINGS`：画布与浮层/弹层是重叠兄弟窗。缺它时画布重绘会把
            // 自己画进**上层浮层**的区域（本文件同类问题已有定论，见占位标签与
            // 面板底板的同款注释），实机症状就是「浮层开了、内容也对，但屏幕上
            // 被画布盖回原样」——只有外部强制重绘浮层才看得见（2026-10-07）。
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            100,
            100,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── 输入区（多行 RichEdit，原生 IME；Enter 语义在子类里）──
    let input = unsafe {
        CreateWindowExW(
            // 不挂 WS_EX_CLIENTEDGE：那是系统给的单像素下沉立体边框，与 macOS 的
            // 圆角输入槽差得远（用户 2026-10-07 实拍「原生样式、丑」）。输入槽的
            // 圆角底/描边由聊天窗自己的 `paint_input_slot` 画在控件之下。
            0,
            wide("RICHEDIT50W").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD
                | WS_VISIBLE
                // 不挂 WS_VSCROLL：多行输入右侧会多出一条原生滚动条（含上下箭头），
                // macOS 侧没有这条；超长文本靠 `ES_AUTOVSCROLL` 跟随插入符滚动。
                // 占位标签是叠在输入框上的兄弟控件：本控件开 `WS_CLIPSIBLINGS` 后，
                // 重绘时会把上方的重叠兄弟（占位 STATIC）从更新区裁掉，不会把它盖住。
                | WS_CLIPSIBLINGS
                | ES_MULTILINE as u32
                | ES_AUTOVSCROLL as u32
                | ES_WANTRETURN as u32,
            0,
            0,
            100,
            scaled(INPUT_HEIGHT, scale),
            hwnd,
            INPUT_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── 输入区占位（「说点什么…」）：自绘等价物 ──
    //
    // 输入控件是多行 RichEdit（不是标准 EDIT），`EM_SETCUEBANNER` 对 RichEdit
    // 没有可依赖的公开语义（且失配时是静默无效，不会报错），所以用**覆盖式
    // STATIC**：建在输入框之后，并显式抬到兄弟 z 序最上（`winuser` 文档：子窗口
    // 创建后默认落在 z 序**最底**，不能只靠创建顺序）；可见性由 `update_send_enabled`
    // 按文本是否为空驱动（与 macOS 的 `textDidChange` → 占位刷新同源）；命中穿透由
    // `hit_transparent_subclass_proc` 的 `HTTRANSPARENT` 保证（点占位文字聚焦输入框，
    // 与 macOS 的 `hitTest:` 同义；把手带状态文字复用同一子类）。
    let input_placeholder = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(INPUT_PLACEHOLDER).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            120,
            scaled(18, scale),
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        SetWindowSubclass(input_placeholder, Some(hit_transparent_subclass_proc), 2, 0);
        // 抬到兄弟 z 序最上（见上：子窗口默认最底；否则输入框重绘会盖住占位）。
        SetWindowPos(
            input_placeholder,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }

    // 把手带的状态文字不建 STATIC：它是 composer 面上的一行字，子窗口的不透明
    // 表面会把渐变挡成一块灰板（2026-10-07 实机），改由 `paint_shell` 单面绘制，
    // 几何槽在 `layout_panes_for` 的 `paint.handle_status`（文案口径见
    // [`handle_status_label`]：只显示中性系统通知 `notice`）。

    // ── 停止按钮（运行中显示；运行态由 `deskpet-run-state` 回推）──
    let stop = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("停止").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(STOP_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            STOP_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        // 设计稿 `.btn`（第三波起停止是输入行的主按钮）：`--sbg` 族 + 按钮圆角 `--r3`。
        make_themed_button_r(stop, ButtonRole::Primary, scale, theme::tokens().radii.btn);
        ShowWindow(stop, SW_HIDE);
    }

    // ── A3：发图入口按钮（选择 → 待发送区；2026-10-05 第三波起回到输入行，
    //    设计稿 `.inp` 的「图片 + 主按钮」；抽屉退场后不再随展开态隐藏）──
    let pick_images = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("图片").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(PICK_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            BTN_PICK_IMAGES_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { make_themed_button(pick_images, ButtonRole::Normal, scale) };

    // ── 「发送」按钮（与 Enter 同一出口：WM_APP_SEND → send_from_input）──
    let send = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("发送").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            scaled(SEND_BUTTON_WIDTH, scale),
            scaled(INPUT_BUTTON_HEIGHT, scale),
            hwnd,
            BTN_SEND_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe { make_themed_button(send, ButtonRole::Primary, scale) };
    // 初始输入为空且无待发送图片：与旧壳 disabled 条件一致。
    unsafe { EnableWindow(send, 0) };

    // ── 「↓ 新消息」跳转按钮（浮在正文画布右下角；上翻历史时由滚动位置驱动）──
    let jump = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("↓ 新消息").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            JUMP_BUTTON_WIDTH,
            JUMP_BUTTON_HEIGHT,
            hwnd,
            BTN_JUMP_ID as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    unsafe {
        make_themed_button(jump, ButtonRole::Normal, scale);
        ShowWindow(jump, SW_HIDE);
    }

    // 把手上拉箭头同样**单面绘制**（见 `paint_shell` 的三角段）：它曾是
    // `ButtonRole::TabOff` 的子按钮，按钮自己的表面色会在带中央补出一块方板，
    // 且同一次点击会既进聊天窗的 `WM_LBUTTONDOWN` 又进按钮的 `WM_COMMAND`
    //（开完立刻被关掉 —— 用户 2026-10-07 实拍「点一下闪一下就消失」）。

    // ── 浮层 Inspector 的承载窗口（遮罩 + 浮层盒 = 同一个子窗口）──
    //
    // 生命周期：随聊天窗常驻、默认隐藏（开合只 ShowWindow/SetWindowPos，不反复建窗）。
    // 层级：在这里创建（画布与跳转按钮之后）= 兄弟窗口里更上层，消息画布与其 RichEdit
    // 全在它之下 —— 遮罩才盖得住内容、点得到（父窗口的绘制盖不住子窗口，这正是
    // 遮罩要独立成窗的原因）；弹出时再 `SetWindowPos(HWND_TOP)` 兜一层防重建打乱。
    // 内容子控件（标题 / ✕ / 面板元素）都是它的子窗口，随它显隐并被它裁剪。
    let inspector_layer = unsafe {
        CreateWindowExW(
            0,
            wide(LAYER_CLASS).as_ptr(),
            wide("").as_ptr(),
            // 不带 WS_VISIBLE：开合由 layout_panes_for 驱动。
            // `WS_CLIPSIBLINGS`：与画布重叠，重绘互不越界（见画布创建处的同款注释）。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            10,
            10,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 关闭「✕」（常驻，命中走 WM_COMMAND 的专段）。标题文案没有共享来源（三块内容
    // 合进一个浮层后不再有「打开的是哪一块」），**不自己造**：标题行只保留右侧 ✕。
    // 浮层窗口创建失败（极罕见）时不建这个子控件（父为 0 会变成顶层窗口，绝不允许），
    // 留痕后浮层功能整体禁用（句柄 0 在布局里被跳过）。
    let inspector_close = if inspector_layer != 0 {
        let close = unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("✕").as_ptr(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                10,
                10,
                inspector_layer,
                INSPECTOR_CLOSE_ID as HMENU,
                hinstance,
                std::ptr::null(),
            )
        };
        unsafe {
            // 关闭键是弱化的文字入口（设计稿 `.insx`：默认无底、悬浮才出底）。
            // 半径取 `radii.sm`（与 macOS 浮层关闭键同档，见交付报告的两平台对照）。
            make_themed_button_r(close, ButtonRole::TabOff, scale, theme::tokens().radii.sm);
        }
        close
    } else {
        rust_warn!("浮层窗口创建失败：关闭键与浮层内容不可用");
        0
    };

    // ── 浮层内容的滚动裁剪窗（2026-10-06 抽屉内部滚动）──
    // 挂在浮层窗口之下：`WS_VSCROLL` + `WS_CLIPCHILDREN` —— 面板元素是它的子窗口，
    // 部分滚出可视区的控件由客户区自然裁剪（不再整条藏起），滚动条只在内容超可视高
    // 时出现（见 `apply_inspector_scroll`）。独立子窗口而不是把元素直接挂浮层窗口的
    // 原因：浮层窗口盖住整块消息流区域（含盒外的遮罩），内容必须有**自己的**裁剪
    // 边界；滚动条也必须落在盒内而不是层窗右缘。
    let inspector_scroll = if inspector_layer != 0 {
        let scroll = unsafe {
            CreateWindowExW(
                0,
                wide(INSPECTOR_SCROLL_CLASS).as_ptr(),
                wide("").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_VSCROLL,
                0,
                0,
                10,
                10,
                inspector_layer,
                0,
                hinstance,
                std::ptr::null(),
            )
        };
        // 初始无滚动；内容超可视高时由 `apply_inspector_scroll` 打开。
        unsafe { ShowScrollBar(scroll, SB_VERT, 0) };
        scroll
    } else {
        0
    };

    // ── 会话历史弹层的承载窗口（同 `LAYER_CLASS`：遮罩 + 圆角盒 + 内容子控件）──
    //
    // 与浮层的关系：两层都盖住消息流区域、互斥性由模型状态决定（历史开合 = 视图在不在
    // 快照里）；两层同时开着时后弹的（历史创建在后）压在上面，点掉一层即露出另一层。
    // 内容子控件全部在重建时新建，随弹层显隐；本窗口常驻（只 Show/Hide）。
    let history_layer = unsafe {
        CreateWindowExW(
            0,
            wide(LAYER_CLASS).as_ptr(),
            wide("").as_ptr(),
            // 不带 WS_VISIBLE：开合由 layout_history_layer 驱动；同款 `WS_CLIPSIBLINGS`。
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            10,
            10,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };

    // ── A1：标签条的固定控件（仅主窗面板模式；独立窗全为 0）──
    // 顶部顶栏带（品牌/状态位/关闭「×」）不在这里：归主窗的全窗宽顶栏
    // （`windows_main.rs::create_titlebar`）。
    let mut nav_new: HWND = 0;
    let mut nav_history: HWND = 0;
    if pane {
        let make_nav = |text: &str, id: i32| unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                10,
                10,
                hwnd,
                id as HMENU,
                hinstance,
                std::ptr::null(),
            )
        };
        nav_new = make_nav("+", BTN_NEW_SESSION_ID);
        nav_history = make_nav("历史", BTN_HISTORY_ID);
        // `.tabadd` / `.tabhist` 用小圆角 `--r1`（与 macOS `Face::Chip` 对称）。
        make_themed_button_r(nav_new, ButtonRole::Normal, scale, theme::tokens().radii.sm);
        make_themed_button_r(
            nav_history,
            ButtonRole::Normal,
            scale,
            theme::tokens().radii.sm,
        );
    }

    // 系统字体（与 Windows 端既有口径一致：微软雅黑 UI / 等宽 Consolas）。
    // 灰度抗锯齿（`create_ui_font`）：与顶栏/全局字体同一路径，不用 ClearType
    //（浅底小字彩边，2026-10-07 实机）。
    let make_font = |height: i32, weight: i32, face: &str| {
        paint_win::create_ui_font(-scaled(height, scale), weight, face)
    };
    // 全局字体快照（`appearance.font` 的投影）：族名缺省回落 W8a 既有的中文 UI 字体，
    // 字号按「正文 13」基线同比缩放；等宽体保持 Consolas（代码块语义不随全局族名改）。
    let snapshot = crate::ui::font::snapshot();
    let ui_face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    let body_size = snapshot.scaled_size(13.0, 13.5).round() as i32;
    let small_size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    let mono_size = snapshot.scaled_size(12.0, 13.5).round() as i32;
    let body = make_font(body_size, FW_NORMAL as i32, &ui_face);
    let small = make_font(small_size, FW_NORMAL as i32, &ui_face);
    let bold = make_font(body_size, FW_BOLD as i32, &ui_face);
    let mono = make_font(mono_size, FW_NORMAL as i32, "Consolas");
    let symbol = make_font(small_size, FW_NORMAL as i32, "Segoe UI Symbol");

    unsafe {
        SendMessageW(input, WM_SETFONT, body as WPARAM, 1);
        // 占位与输入文本同字体（macOS 占位与输入框同为 14pt）；字色 dim（次要文字）。
        SendMessageW(input_placeholder, WM_SETFONT, body as WPARAM, 1);
        stamp_ink(input_placeholder, theme::tokens().dim);
        SendMessageW(stop, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(pick_images, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(send, WM_SETFONT, body as WPARAM, 1);
        SendMessageW(jump, WM_SETFONT, small as WPARAM, 1);
        // 关闭键是小号 chrome（标题行没有标题文字）。
        SendMessageW(inspector_close, WM_SETFONT, small as WPARAM, 1);
        if pane {
            // A1：标签条按钮用小号字体（导航条是次要 chrome）。
            for control in [nav_new, nav_history] {
                SendMessageW(control, WM_SETFONT, small as WPARAM, 1);
            }
        }
        // 输入区的 Enter 语义（发送/换行/IME 组合）经子类接管。
        SetWindowSubclass(input, Some(input_subclass_proc), 1, 0);
    }

    CHAT.with(|cell| {
        *cell.borrow_mut() = Some(ChatWinState {
            hwnd,
            pane,
            canvas,
            input,
            input_placeholder,
            stop,
            fonts: vec![body, small, bold, mono, symbol],
            content_height: 0,
            scroll_y: 0,
            message_window_start: usize::MAX,
            viewport_height: 0,
            children: Vec::new(),
            base_height: 0,
            tail: None,
            links: HashMap::new(),
            message_menu_targets: HashMap::new(),
            image_targets: Vec::new(),
            active_session: None,
            view_generation: 0,
            composing: false,
            // 说话人名由投影（人格域）提供；未收到投影前不显示名，不留硬编码角色名兜底。
            speaker: String::new(),
            panel_children: Vec::new(),
            panel_height: 0,
            panel_actions: Vec::new(),
            handle_status_label: String::new(),
            inspector_layer,
            inspector_close,
            inspector_scroll,
            inspector_children: Vec::new(),
            inspector_content_height: 0,
            inspector_viewport_height: 0,
            inspector_scroll_y: 0,
            inspector_box: paint_win::Rect::new(0, 0, 0, 0),
            inspector_open: false,
            history_layer,
            history_children: Vec::new(),
            history_height: 0,
            history_box: paint_win::Rect::new(0, 0, 0, 0),
            pick_images,
            send,
            jump,
            jump_unread: false,
            seen_transcript_revision: 0,
            seen_stream_revision: 0,
            pending_children: Vec::new(),
            pending_height: 0,
            pending_targets: Vec::new(),
            pending_content_w: 0,
            pending_scroll_x: 0,
            pending_count: 0,
            pending_reveal_end: false,
            nav_new,
            nav_history,
            tab_children: Vec::new(),
            session_targets: Vec::new(),
            paint: ChatPaintRects::EMPTY,
            card_frames: Vec::new(),
        });
    });
    // 输入框主题（底色 + 字色；WM_SETFONT 之后应用，避免被默认格式覆盖）。
    with_chat(|state| unsafe { apply_input_theme(state) });
    // A3：文件拖入（拖进聊天窗 / 输入区 / 正文 → 待发送区）。三个窗口都注册
    // legacy 拖放（WM_DROPFILES），落点就近由各自窗口过程处理。
    unsafe {
        DragAcceptFiles(hwnd, 1);
        DragAcceptFiles(input, 1);
        DragAcceptFiles(canvas, 1);
    }

    layout_panes();
    unsafe {
        SetFocus(input);
    }
    rust_info!("聊天窗已创建（Win32/RichEdit；输入框已取焦点）");
}
