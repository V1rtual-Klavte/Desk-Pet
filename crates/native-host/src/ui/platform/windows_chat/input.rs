//! 输入区（滚轮/拖放/剪贴板/IME/发送）与事件处理。

use super::*;
use super::layout::{layout_panes_for, rect_contains};
use super::paint::{rect_is_empty, win_rect_of};
use super::panels::dispatch_panel_action;

/// 滚轮 → 待发送条横向滚动；返回是否消费本次滚轮。
///
/// 只有「光标在待发送条内」且「内容宽超过条宽」才消费（不抢画布/其它控件的滚轮）。
/// 判定用 `GetCursorPos` 换算到客户区而不是看焦点：子按钮持焦点时滚轮消息同样转到
/// 本窗，按光标位置判与「鼠标在哪就滚哪」的直觉一致。滚动量与钳制走共享
/// `pending_strip::clamp_scroll`，重排复用 `layout_panes_for`（唯一摆放口径）。
pub(super) fn scroll_pending_from_wheel(hwnd: HWND, msg: u32, wparam: WPARAM) -> bool {
    unsafe {
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point) == 0 {
            return false;
        }
        ScreenToClient(hwnd, &mut point);
        let target = CHAT.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|state| !rect_is_empty(&state.paint.pending))
                .map(|state| (win_rect_of(&state.paint.pending), state.pending_content_w))
        });
        let Some((pending, content_w)) = target else {
            return false;
        };
        let max_scroll = (content_w - pending.w).max(0);
        if max_scroll == 0 || !rect_contains(pending, point.x, point.y) {
            return false;
        }
        // 滚轮增量在**高字**（低字是按键标志）；纵向轮向下 = 往右看（露出右侧条目），
        // 横向轮向右 = 往右看 —— 与 macOS 触控板横扫/滚轮的方位一致。
        let delta = i32::from(((wparam >> 16) & 0xFFFF) as u16 as i16);
        if delta == 0 {
            return false;
        }
        let direction = if msg == WM_MOUSEHWHEEL { delta } else { -delta };
        let step = scaled(PENDING_SCROLL_STEP, dpi_scale(hwnd)) * direction / 120;
        // 高分辨率滚轮（±小于一格）至少给 1 像素，避免整格没有反应。
        let shift = if step == 0 {
            direction.signum()
        } else {
            step.clamp(-max_scroll, max_scroll)
        };
        with_chat(|state| {
            state.pending_scroll_x = (state.pending_scroll_x + shift).clamp(0, max_scroll);
            // 唯一摆放口径：重排由 `layout_panes_for` 统一做（含偏移钳制与 reveal）。
            layout_panes_for(state);
            // 指示条 thumb 位置随滚动变，而它不在条目控件的重绘范围里：显式作废条区。
            InvalidateRect(state.hwnd, &state.paint.pending, 0);
        });
        true
    }
}

/// A3：读一次 HDROP 里的全部文件路径（**不释放** HDROP —— 释放责任归调用方：
/// `WM_DROPFILES` 的句柄必须由 `DragFinish` 归还，剪贴板 `CF_HDROP` 的句柄归
/// 剪贴板所有、不能 `DragFinish`）。只取路径，不读文件内容。
unsafe fn read_hdrop_paths(hdrop: HDROP) -> Vec<String> {
    unsafe {
        let count = DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let written = DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), length + 1);
            if written == 0 {
                continue;
            }
            paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
        }
        paths
    }
}

/// 拖入/粘贴文件路径的统一归宿（准入与图像域判定在工作线程；失败走中性通知，
/// 与既有拖入行为同一条）。
fn enqueue_dropped_paths(paths: Vec<String>) {
    if let Err(error) = crate::ui::chat::add_dropped_images(paths) {
        crate::ui::chat::set_notice(Some(format!("图片未添加：{error}")));
    }
}

/// A3：读取一次 `WM_DROPFILES` 的文件路径并交待发送区（准入在工作线程）。
///
/// `hdrop` 必须在消息处理内消费（`DragFinish` 归还）；只取路径，不读文件内容。
pub(super) unsafe fn handle_dropped_files(hdrop: HDROP) {
    unsafe {
        let paths = read_hdrop_paths(hdrop);
        DragFinish(hdrop);
        enqueue_dropped_paths(paths);
    }
}

// ══════════ 剪贴板粘贴图片（A3 图片通路第三条：选择器 / 拖入 / 粘贴）══════════

/// 剪贴板读取结果（**必须在 `OpenClipboard` 期间取完**：句柄随关闭失效）。
enum ClipboardPayload {
    /// 已是可解码图片字节（DIB 系已补 14 字节 BMP 容器头）。
    Image(Vec<u8>),
    /// 复制的文件路径（与拖入同一条准入/待发送区通路）。
    Files(Vec<String>),
    /// 没有图片也没有文件：交还 RichEdit 原生粘贴。
    None,
}

/// 处理一次输入框粘贴（`WM_PASTE`）：返回 `true` = 已消费（调用方吞掉消息），
/// `false` = 交还 RichEdit 原生粘贴。
///
/// `OpenClipboard` / `CloseClipboard` 严格配对：打开到关闭之间没有提前 return，
/// 读取的中间失败都以 [`ClipboardPayload::None`] 汇合到同一条关闭路径。
unsafe fn paste_clipboard_payload(owner: HWND) -> bool {
    unsafe {
        if OpenClipboard(owner) == 0 {
            // 剪贴板正被别的进程占用：不拦，交还 RichEdit 自己再试（原生路径）。
            return false;
        }
        let payload = read_clipboard_payload();
        CloseClipboard();
        match payload {
            ClipboardPayload::Image(bytes) => {
                match crate::ui::chat::paste::add_pasted_image(bytes) {
                    Ok(()) => {}
                    // 廉价拒绝（空/超大/格式/张数/端口未就绪）：中性文案就地展示；
                    // 转码/落盘/授权与晚到失败由粘贴工作线程经 set_notice 回报
                    // （不在平台层起线程，也不在这里做重活）。
                    Err(text) => crate::ui::chat::set_notice(Some(text)),
                }
                true
            }
            ClipboardPayload::Files(paths) => {
                enqueue_dropped_paths(paths);
                true
            }
            ClipboardPayload::None => false,
        }
    }
}

/// 读一次剪贴板（调用方已完成 `OpenClipboard`）：图片优先
/// （`CF_DIBV5` → `CF_DIB` → `CF_BITMAP`），其次复制的文件（`CF_HDROP`）。
unsafe fn read_clipboard_payload() -> ClipboardPayload {
    unsafe {
        if let Some(bytes) = clipboard_image_bytes() {
            return ClipboardPayload::Image(bytes);
        }
        if IsClipboardFormatAvailable(CF_HDROP) != 0 {
            let handle = GetClipboardData(CF_HDROP);
            if handle != 0 {
                // CF_HDROP 的句柄就是 HDROP：DragQueryFileW 直接读（不 DragFinish）。
                let paths = read_hdrop_paths(handle as HDROP);
                if !paths.is_empty() {
                    return ClipboardPayload::Files(paths);
                }
            }
        }
        ClipboardPayload::None
    }
}

/// 剪贴板里的图片 → 可解码的 BMP 文件字节（无图片给 `None`）。
/// 调用方必须已 `OpenClipboard`（句柄只在剪贴板打开期间有效）。
unsafe fn clipboard_image_bytes() -> Option<Vec<u8>> {
    unsafe {
        // 顺序即优先级：DIBV5（带 alpha 的现代格式）→ DIB（40 字节头最常见）。
        for format in [CF_DIBV5, CF_DIB] {
            if IsClipboardFormatAvailable(format) == 0 {
                continue;
            }
            let handle = GetClipboardData(format);
            if handle == 0 {
                continue;
            }
            let block = handle as HGLOBAL;
            let pointer = GlobalLock(block);
            if pointer.is_null() {
                continue;
            }
            let size = GlobalSize(block);
            if size > CLIPBOARD_COPY_LIMIT {
                // 畸大内存块：解锁后换下一个格式（准入在共享层，这里只兜分配）。
                GlobalUnlock(block);
                continue;
            }
            // 拷出为 Rust 字节（真正的解码在粘贴工作线程，不占 UI 主线程）。
            let bytes = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
            // 只读快照、不改剪贴板归属；`GlobalUnlock` 对可移动内存成功时同样返回 0
            // （要配 GetLastError 才能区分），这里如实忽略返回值。
            GlobalUnlock(block);
            if let Some(bmp) = bmp_container_from_dib(&bytes) {
                return Some(bmp);
            }
        }
        // CF_BITMAP：句柄是 HBITMAP（不是内存块），经 GetDIBits 取回 DIB。
        if IsClipboardFormatAvailable(CF_BITMAP) != 0 {
            let handle = GetClipboardData(CF_BITMAP);
            if handle != 0 {
                return bitmap_handle_to_bmp(handle as HBITMAP);
            }
        }
        None
    }
}

/// `CF_BITMAP` 的 HBITMAP → 32bpp BI_RGB 的 DIB → BMP 字节（与 DIB 路径共用补头）。
unsafe fn bitmap_handle_to_bmp(hbm: HBITMAP) -> Option<Vec<u8>> {
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return None;
        }
        // 第一步只查尺寸：`biSize` 预填、`lpvBits = NULL`、`cLines = 0` 时 GetDIBits
        // 把宽高写回 `BITMAPINFOHEADER`（MSDN GetDIBits 备注的查询用法）。
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        GetDIBits(
            dc,
            hbm,
            0,
            0,
            std::ptr::null_mut(),
            &mut info,
            DIB_RGB_COLORS,
        );
        let width = info.bmiHeader.biWidth;
        let height = info.bmiHeader.biHeight;
        if width <= 0 || height <= 0 {
            // 负高 = 顶置（downward）DIB；CF_BITMAP 不是该形态，如实拒绝。
            DeleteDC(dc);
            return None;
        }
        // 统一请求 32bpp BI_RGB：GetDIBits 自行做格式转换（含调色板位图），
        // 输出无色表 —— 补 BMP 头时不必再算色表字节数。
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        info.bmiHeader.biSizeImage = 0;
        let pixel_bytes = width as usize * height as usize * 4;
        let mut pixels = vec![0u8; pixel_bytes];
        let copied = GetDIBits(
            dc,
            hbm,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteDC(dc);
        if copied == 0 {
            return None;
        }
        // 40 字节头 + 像素 = DIB 块；与 CF_DIB 路径共用同一个容器补头。
        let header = std::slice::from_raw_parts(
            std::ptr::addr_of!(info.bmiHeader) as *const u8,
            std::mem::size_of::<BITMAPINFOHEADER>(),
        );
        let mut dib = Vec::with_capacity(header.len() + pixel_bytes);
        dib.extend_from_slice(header);
        dib.extend_from_slice(&pixels);
        bmp_container_from_dib(&dib)
    }
}

/// DIB 内存块 → BMP 文件字节：补 14 字节 `BITMAPFILEHEADER`。
///
/// 结构依据：剪贴板给的是「设备无关位图」（`BITMAPINFOHEADER` / `BITMAPV4HEADER` /
/// `BITMAPV5HEADER` + 可选色表 + 像素），而 BMP 文件在 14 字节文件头之后就是同一份
/// DIB —— 补头只需写两处字段、其余清零：
/// - 偏移 0..2 = `"BM"`；偏移 2..6 `bfSize` = 14 + DIB 全长；偏移 6..10 两个保留
///   字段 = 0；偏移 10..14 `bfOffBits` = 14 + `biSize` + 色表字节数。
/// - `biSize` = DIB 内存块的前 4 字节（40/108/124 对应 V3/V4/V5；解码端
///   image crate 0.25 三种头都认）。
/// - `BITMAPINFOHEADER` 的固定偏移（V4/V5 是它的扩展，字段偏移相同）：`biBitCount`
///   14..16、`biCompression` 16..20、`biClrUsed` 32..36。色表字节数：bpp ≤ 8 时
///   项数 = `biClrUsed` 非 0 取它、否则 `1 << bpp`（每项 4 字节）；40 字节头 +
///   `BI_BITFIELDS` 时头后跟 3 个掩码 DWORD（12 字节）；V4/V5 的掩码含在头内，不算。
///
/// 返回 `None` = 头不合法（`biSize` < 40 或色表越过缓冲）：调用方按「不是可解码
/// 图片」处理，绝不拼一个解码必然失败的假文件去骗准入。
pub(super) fn bmp_container_from_dib(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 4 {
        return None;
    }
    let bi_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]);
    if bi_size < 40 || bi_size as usize > dib.len() {
        return None;
    }
    let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]);
    let palette_bytes = if bit_count <= 8 {
        let entries = if clr_used != 0 {
            clr_used.min(256)
        } else {
            1u32 << bit_count
        };
        entries as usize * 4
    } else if compression == BI_BITFIELDS && bi_size == 40 {
        12
    } else {
        0
    };
    let off_bits = 14 + bi_size as usize + palette_bytes;
    if off_bits > 14 + dib.len() {
        return None;
    }
    let file_size = 14 + dib.len();
    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]); // bfReserved1 / bfReserved2
    bmp.extend_from_slice(&(off_bits as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

/// 按当前最早的面板期限布一次一次性定时器（无期限时停表）。
pub(super) fn arm_deadline_timer(state: &ChatWinState) {
    unsafe {
        KillTimer(state.hwnd, TIMER_DEADLINE);
    }
    if let Some(next) = crate::ui::chat::next_deadline_ms() {
        let now = crate::ui::platform::now_ms();
        let delay = next.saturating_sub(now).max(20);
        unsafe {
            SetTimer(
                state.hwnd,
                TIMER_DEADLINE,
                delay.min(u64::from(u32::MAX)) as u32,
                None,
            );
        }
    }
}

/// slash 补全填入（把 `/<name>` 写回输入框并把光标移到末尾；不执行命令）。
unsafe fn autofill_selected_slash(input: HWND) {
    let Some(fill) = crate::ui::chat::slash_autofill() else {
        return;
    };
    let length = fill.encode_utf16().count() as WPARAM;
    unsafe {
        SetWindowTextW(input, wide(&fill).as_ptr());
        SendMessageW(input, EM_SETSEL, length, length as LPARAM);
    }
    // 程序化填入后显式刷新（与 `send_from_input` 清空后的口径一致：不依赖
    // RichEdit 对 `SetWindowTextW` 是否补发 EN_CHANGE）——占位要立即收起。
    with_chat(|state| update_send_enabled(state));
}

pub(super) fn send_from_input() {
    let input = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.input));
    let Some(input) = input else { return };
    let text = unsafe { read_window_text(input) };
    // 待发送区（选择/拖入的图片）随本次发送一并提交；空文本 + 有图也允许发送。
    let images = crate::ui::chat::pending_image_paths();
    if text.trim().is_empty() && images.is_empty() {
        return;
    }
    match crate::ui::chat::dispatch_send_text(&text, images) {
        Ok(()) => {
            unsafe { SetWindowTextW(input, wide("").as_ptr()) };
            crate::ui::chat::set_notice(None);
        }
        Err(error) => {
            // 发送失败：输入与待发送图片已保留。错误详情可能是较长的传输/远端诊断，
            // 走模态对话框（详情可复制）而不是一行几秒即收起的 notice。
            crate::ui::chat::dialog::show_failure(
                "消息未发送",
                "消息没有送达；输入内容与待发送图片已保留。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
    // 程序化清空后显式刷新（SetWindowTextW 通常也会发 EN_CHANGE，这里不依赖它）。
    with_chat(|state| update_send_enabled(state));
}

/// 同步「发送」按钮可用态：输入非空或以有待发送图片（与 Enter 的准入同源）。
pub(super) fn update_send_enabled(state: &ChatWinState) {
    let text = unsafe { read_window_text(state.input) };
    // 占位标签的可见性与发送可用态同源（都由输入文本决定）、同触发点（EN_CHANGE
    // 与各程序化清空/填入点一起刷新）——与 macOS `update_send_enabled` 同构。
    if state.input_placeholder != 0 {
        // 占位是**叠在输入框上**的兄弟控件，只要输入框里有东西（文字 / IMM 组合串）
        // 就会盖住它。判定口径与 macOS 同源（`macos_chat::update_send_enabled`：
        // `placeholder.setHidden(!empty)`，`empty` **只**看输入文本）—— 输入框空着
        // 就显示占位，聚焦与否不影响（用户 2026-10-07 实拍：mac 里点进输入框后
        // 「说点什么…」仍在，Windows 一聚焦就消失）。TSF 拼音的组合串由输入法自己
        // 画在插入点，不写进控件文本，占位留在下面与 macOS 的表现一致。
        let empty = text.is_empty();
        unsafe {
            ShowWindow(
                state.input_placeholder,
                if empty { SW_SHOW } else { SW_HIDE },
            );
            // 占位是**叠在输入框上**的兄弟控件：藏掉它以后输入框不会自动重画，
            // 露出来的仍是占位那几笔像素 —— 用户实拍「被『说点什么…』挡住了」，
            // 文字其实已经在下面，只是被占位的残影盖着。显式作废输入框区域，
            // 让 RichEdit 把这一块重画一遍。
            if state.input != 0 {
                InvalidateRect(state.input, std::ptr::null(), 1);
            }
        }
    }
    let enabled = !text.trim().is_empty() || crate::ui::chat::chat_ui().has_pending_images();
    unsafe { EnableWindow(state.send, i32::from(enabled)) };
    // 自绘按钮的禁用态不保证被 EnableWindow 主动重绘：显式失效一次（禁用样式立即生效）。
    unsafe { InvalidateRect(state.send, std::ptr::null(), 1) };
}

/// 「视作在正文底部」的容差（物理像素；沿用 `rebuild_canvas` 既有的 24，口径一处）。
const JUMP_BOTTOM_TOLERANCE: i32 = 24;

/// 视口是否在正文底部（纯函数；`scroll_y + viewport_h` 贴到内容底差容差内）。
pub(super) fn scroll_at_bottom(scroll_y: i32, viewport_h: i32, content_h: i32) -> bool {
    scroll_y + viewport_h >= content_h - JUMP_BOTTOM_TOLERANCE
}

/// 「↓ 新消息」可见性（2026-10-05 用户规则）：**真有未读新消息且不在底部**才显示——
/// 只有「不在底部」不再是理由（旧口径让它在只是上翻历史时也常驻、压在消息文字上）。
pub(super) fn update_jump_visibility(state: &ChatWinState) {
    let max_scroll = (state.content_height - state.viewport_height).max(0);
    let at_bottom = scroll_at_bottom(state.scroll_y, state.viewport_height, state.content_height);
    let show = state.jump_unread && !at_bottom && max_scroll > 0;
    unsafe { ShowWindow(state.jump, if show { SW_SHOW } else { SW_HIDE }) };
}

/// 读取控件文本（主窗顶栏的自绘按钮也复用，故 `pub(crate)`）。
pub(crate) unsafe fn read_window_text(hwnd: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer: Vec<u16> = vec![0; (length + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), length + 1) };
    let slice = &buffer[..read.max(0) as usize];
    String::from_utf16_lossy(slice)
}

/// 输入内容变化的统一刷新出口：占位标签可见性、「发送」可用态与 slash 候选
/// 同源刷新（`EN_CHANGE` 分支与「RichEdit 原生粘贴不补发 EN_CHANGE」的两处
/// 显式补刷新共用，避免判定复制第二份）。
pub(super) fn refresh_input_state(input: HWND) {
    if input == 0 {
        return;
    }
    let text = unsafe { read_window_text(input) };
    crate::ui::chat::note_input_text(&text);
    with_chat(|state| update_send_enabled(state));
}

/// 「只做视觉、不拦鼠标」子类的统一实现（两处装同一条：**输入区占位标签**与
/// **把手带状态文字**）：命中测试一律穿透（`HTTRANSPARENT` 让消息落到同线程的
/// 下层窗口 —— 占位标签落输入框、状态文字落聊天窗的把手带点击段），其余消息
/// 原样交还 —— 与 macOS `ChatInputPlaceholder` 的 `hitTest:` 返回 nil 同义
/// （不穿透时：点占位文字无法聚焦输入框、点状态文字不会开合浮层）。
pub(super) unsafe extern "system" fn hit_transparent_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(hit_transparent_subclass_proc), 2);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 输入区子类：Enter 发送 / Shift+Enter 换行 / IME 组合期间交还系统。
pub(super) unsafe extern "system" fn input_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_KEYDOWN => {
            // Ctrl+V：**RichEdit 自己处理 Ctrl+V，不会发 WM_PASTE**。
            // 2026-10-07 实机用诊断日志确认：粘贴图片时本文件的 `WM_PASTE` 分支
            // 一次都没被执行，图片被 RichEdit 当成内嵌对象插进了正文（用户实拍
            // 「截图粘贴进去还是这鬼样子、没进上面的可滚动图片区」）。所以在按键
            // 这一层就拦：剪贴板是图片/文件 → 转交待发送区并吃掉按键；纯文本原样
            // 落回 RichEdit 的原生粘贴。`WM_PASTE` 分支保留（右键菜单粘贴走它）。
            if wparam == VK_V as WPARAM && unsafe { GetKeyState(i32::from(VK_CONTROL)) } < 0 {
                if unsafe { paste_clipboard_payload(hwnd) } {
                    return 0;
                }
                // 文本粘贴：交还 RichEdit 自己插字，**它不补发 EN_CHANGE**
                // （2026-10-07 实机：粘贴文字后 `[诊断·输入]` 一条都没有，占位标签
                // 一直压在文字上；打字却有 EN_CHANGE）。先让它把粘贴做完，再显式
                // 补一次刷新 —— 与 EN_CHANGE 共用同一出口，不复制判定。
                let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
                refresh_input_state(hwnd);
                return result;
            }
            let composing = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| state.composing)
                    .unwrap_or(false)
            });
            if !composing {
                // ── slash 候选键盘导航（与 ChatPanel 的 key() 同义）──
                let slash_open = crate::ui::chat::slash_visible();
                if slash_open {
                    match wparam {
                        w if w == VK_DOWN as WPARAM => {
                            crate::ui::chat::slash_move(1);
                            return 0;
                        }
                        w if w == VK_UP as WPARAM => {
                            crate::ui::chat::slash_move(-1);
                            return 0;
                        }
                        w if w == VK_ESCAPE as WPARAM => {
                            crate::ui::chat::slash_dismiss();
                            return 0;
                        }
                        w if w == VK_TAB as WPARAM => {
                            unsafe { autofill_selected_slash(hwnd) };
                            return 0;
                        }
                        _ => {}
                    }
                }
                if wparam == VK_RETURN as WPARAM {
                    let shift_down = unsafe { GetKeyState(i32::from(VK_SHIFT)) } < 0;
                    if !shift_down {
                        if slash_open {
                            // 候选打开时 Enter 先补全（再按一次才发送）。
                            unsafe { autofill_selected_slash(hwnd) };
                        } else {
                            // 交给聊天窗处理“发送”（不在子类里直接碰其他控件，保持单一出口）。
                            unsafe {
                                PostMessageW(GetParent(hwnd), WM_APP_SEND, 0, 0);
                            }
                        }
                        return 0;
                    }
                }
            }
        }
        WM_IME_STARTCOMPOSITION => {
            CHAT.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    state.composing = true;
                }
            });
            // 组合期要立刻收起占位：候选/拼音串画在输入框里，而占位是**叠在输入框上**
            // 的兄弟控件 —— 不收就正好盖住正在输入的字（用户实拍「被『说点什么…』挡住」）。
            with_chat(|state| update_send_enabled(state));
        }
        WM_IME_ENDCOMPOSITION => {
            CHAT.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    state.composing = false;
                }
            });
            // 组合结束：上屏了就有文本（占位继续收着），被取消则文本为空（占位回来）。
            with_chat(|state| update_send_enabled(state));
        }
        WM_IME_COMPOSITION => {
            if (lparam as usize & (GCS_CURSORPOS as usize)) != 0 {
                unsafe { position_candidate_window(hwnd) };
            }
        }
        WM_PAINT => {
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            // TSF 系输入法（本机的微软拼音）**不发 `WM_IME_*`** —— 上面两个分支收不到，
            // 组合期占位就一直压在拼音串上（用户实拍「被『说点什么…』挡住」）。组合串
            // 只能查 IMM 上下文，这里借输入框自己的重绘时机对一次状态；**只在翻转时**
            // 刷新：`update_send_enabled` 里会 InvalidateRect 输入框，无条件刷新会与
            // WM_PAINT 互相触发成死循环。
            let composing = unsafe { ime_composing(hwnd) };
            let flipped = CHAT.with(|cell| {
                let mut cell = cell.borrow_mut();
                match cell.as_mut() {
                    Some(state) if state.composing != composing => {
                        state.composing = composing;
                        true
                    }
                    _ => false,
                }
            });
            if flipped {
                with_chat(|state| update_send_enabled(state));
            }
            return result;
        }
        WM_DROPFILES => {
            // A3：拖进输入区的文件 → 待发送区（接管 RichEdit 自带的拖放处理）。
            unsafe { handle_dropped_files(wparam as HDROP) };
            return 0;
        }
        WM_PASTE => {
            // A3 第三条（2026-10-05 图片通路批）：剪贴板里有图片或复制的文件就接管
            // （Ctrl+V 经 RichEdit 生成 WM_PASTE），其余交还 RichEdit 原生粘贴 ——
            // 文本粘贴行为不变。复用本子类，不挂第二个（守门测试断言）。
            if unsafe { paste_clipboard_payload(hwnd) } {
                return 0;
            }
            // 文本粘贴（右键菜单「粘贴」走这条）：同 Ctrl+V 分支 —— RichEdit
            // 不补发 EN_CHANGE，粘贴完成后显式刷新占位与「发送」可用态。
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            refresh_input_state(hwnd);
            return result;
        }
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(input_subclass_proc), 1);
        },
        // 焦点边沿要重算占位（见 `update_send_enabled`：聚焦即收起，避免盖住 IME 组合串）。
        WM_SETFOCUS | WM_KILLFOCUS => {
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            with_chat(|state| update_send_enabled(state));
            return result;
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 输入法是否正在组合（`GCS_COMPSTR` 非空 = 有未上屏的拼音/候选串）。
///
/// 为什么不用消息：TSF 系输入法（本机微软拼音）**不发 `WM_IME_STARTCOMPOSITION`**，
/// 那两条分支收不到；IMM 上下文里的组合串是唯一可靠的读数。
unsafe fn ime_composing(input: HWND) -> bool {
    let himc = unsafe { ImmGetContext(input) };
    if himc == 0 {
        return false;
    }
    let len = unsafe { ImmGetCompositionStringW(himc, GCS_COMPSTR, std::ptr::null_mut(), 0) };
    unsafe { ImmReleaseContext(input, himc) };
    len > 0
}

/// 组合输入时把 IME 候选框钉到插入符（真实候选窗跟随需人工确认）。
unsafe fn position_candidate_window(input: HWND) {
    unsafe {
        let himc = ImmGetContext(input);
        if himc == 0 {
            return;
        }
        let mut point = POINT { x: 0, y: 0 };
        GetCaretPos(&mut point);
        ClientToScreen(input, &mut point);
        let mut form: CANDIDATEFORM = std::mem::zeroed();
        form.dwIndex = 0;
        form.dwStyle = CFS_CANDIDATEPOS;
        form.ptCurrentPos = point;
        ImmSetCandidateWindow(himc, &form);
        ImmReleaseContext(input, himc);
    }
}

// ==========================================
// 消息右键菜单（「记住这条」入口；气泡按钮退场后的第二形态）
// ==========================================

/// 消息 RichEdit 的右键子类（散文泡与代码块同挂；无身份的控制不挂 —— 右键仍是
/// RichEdit 自带菜单）。`WM_CONTEXTMENU` 的处理顺序是硬要求：**先在闭包里把事件
/// 身份克隆出来、结束 `CHAT` 借用，再弹菜单** —— `TrackPopupMenu` 内部有嵌套消息
/// 泵，跨它持借用会让随后的整帧重建（`with_chat` 是 `try_borrow_mut`）悄悄不发生。
pub(super) unsafe extern "system" fn message_menu_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        WM_CONTEXTMENU => {
            let event_id = CHAT.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .and_then(|state| state.message_menu_targets.get(&hwnd).cloned())
            });
            if let Some(event_id) = event_id {
                unsafe { show_message_menu(hwnd, lparam, &event_id) };
                return 0;
            }
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(message_menu_subclass_proc), 3);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// 弹一次消息右键菜单并执行选中项（只在有记忆身份时调用；无身份的控制走
/// RichEdit 自带菜单，见 [`message_menu_subclass_proc`]）。
///
/// - 菜单 = 复制 / 全选 / 分隔线 / [`REMEMBER_MENU_ITEM_LABEL`]（「记住这条」的
///   文案唯一来源是共享常量，平台文件不写字面量）；
/// - `lparam == -1` 是键盘（Shift+F10 / 菜单键）唤出、没有鼠标点，用控件矩形
///   左上角兜底定位；其余取低 16 位 x / 高 16 位 y（有符号，按 WinUser.h 的
///   `GET_X_LPARAM` 口径）；
/// - 派发复用 [`dispatch_panel_action`]（内置「派发后立即整帧重建」；该出口在
///   production 里必须恰好一处 —— 守门测试断言）。
unsafe fn show_message_menu(hwnd: HWND, lparam: LPARAM, event_id: &str) {
    unsafe {
        let menu = CreatePopupMenu();
        if menu == 0 {
            return;
        }
        // `AppendMenuW` 复制字符串（临时 `wide` 即可；与托盘菜单的写法一致）。
        AppendMenuW(menu, MF_STRING, MENU_COPY, wide(MENU_LABEL_COPY).as_ptr());
        AppendMenuW(
            menu,
            MF_STRING,
            MENU_SELECT_ALL,
            wide(MENU_LABEL_SELECT_ALL).as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(
            menu,
            MF_STRING,
            MENU_REMEMBER,
            wide(REMEMBER_MENU_ITEM_LABEL).as_ptr(),
        );
        let (x, y) = if lparam == -1 {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) != 0 {
                (rect.left, rect.top)
            } else {
                (0, 0)
            }
        } else {
            let raw = lparam as i32;
            (
                (raw & 0xFFFF) as u16 as i16 as i32,
                ((raw >> 16) & 0xFFFF) as u16 as i16 as i32,
            )
        };
        // 先置前台再弹菜单（点击别处菜单才会收起；与托盘菜单同款）。菜单挂在控件
        // 所在窗口链的顶层窗口上（面板模式 / 独立聊天窗都取根祖先）。
        SetForegroundWindow(GetAncestor(hwnd, GA_ROOT));
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            x,
            y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
        // 嵌套消息泵期间可能发生整帧重建（本控件被销毁）：菜单收起后先核对控件
        // 还在，免得把复制/全选发给死句柄（event_id 已克隆，不依赖控件）。
        if IsWindow(hwnd) == 0 {
            return;
        }
        match command as usize {
            MENU_COPY => {
                SendMessageW(hwnd, WM_COPY, 0, 0);
            }
            MENU_SELECT_ALL => {
                // 标准 EDIT/RichEdit 全选：wParam = 0、lParam = -1（全选到末尾）。
                SendMessageW(hwnd, EM_SETSEL, 0, -1);
            }
            MENU_REMEMBER => {
                dispatch_panel_action(PanelAction::RememberMessage {
                    event_id: event_id.to_string(),
                });
            }
            _ => {} // 0 = 取消（点空白 / ESC）；其余 ID 不存在。
        }
    }
}
