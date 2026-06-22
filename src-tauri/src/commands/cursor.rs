// ==========================================
// 光标位置 & 弹窗位置计算
// 共享光标/屏幕检测辅助函数，消除 get_cursor_position 和 compute_popup_position 间的重复代码
// ==========================================

use serde::Serialize;
use tauri::Manager;

use crate::rust_debug;
use crate::rust_log;
use crate::window::enhance_to_iterm_style;

/// 获取光标位置和所在屏幕信息（返回原始平台坐标，不做 Y 轴翻转）
/// Windows: (cx, cy, sx, sy, sw, sh) 全部 web 坐标系（左上原点）
/// macOS:   (cx, cy, sx, sy, sw, sh) Cocoa 坐标系（原点左下），调用方需做 Y 轴翻转
type CursorScreen = (i32, i32, i32, i32, i32, i32);

fn get_cursor_and_screen() -> Result<CursorScreen, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows_sys::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFOEXW};
        use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
        use windows_sys::Win32::Foundation::POINT;
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return Err("无法获取光标位置".into());
        }
        let monitor = MonitorFromPoint(pt, 2); // MONITOR_DEFAULTTONEAREST
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let (mut sx, mut sy, mut sw, mut sh) = (0i32, 0i32, 1920i32, 1080i32);
        if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut _) != 0 {
            let r = info.monitorInfo.rcMonitor;
            sx = r.left; sy = r.top;
            sw = r.right - r.left; sh = r.bottom - r.top;
        }
        // 获取显示器 DPI，物理像素转逻辑（web）坐标
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y);
        let scale_x = dpi_x as f64 / 96.0;
        let scale_y = dpi_y as f64 / 96.0;
        let lx = (pt.x as f64 / scale_x).round() as i32;
        let ly = (pt.y as f64 / scale_y).round() as i32;
        let lsx = (sx as f64 / scale_x).round() as i32;
        let lsy = (sy as f64 / scale_y).round() as i32;
        let lsw = (sw as f64 / scale_x).round() as i32;
        let lsh = (sh as f64 / scale_y).round() as i32;
        rust_debug!("光标(Win): 物({},{}) 逻({},{}) 屏:物({},{} {}x{}) 逻({},{} {}x{}) DPI:({},{})",
            pt.x, pt.y, lx, ly, sx, sy, sw, sh, lsx, lsy, lsw, lsh, dpi_x, dpi_y);
        return Ok((lx, ly, lsx, lsy, lsw, lsh));
    }

    #[cfg(target_os = "macos")]
    {
        use objc::{class, msg_send, sel, sel_impl};
        use objc::runtime::Object;
        #[repr(C)] struct NSPoint { x: f64, y: f64 }
        #[repr(C)] struct NSSize { width: f64, height: f64 }
        #[repr(C)] struct NSRect { origin: NSPoint, size: NSSize }

        let pt: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };

        // 遍历所有屏幕，找到包含光标的那个
        let screens: *mut Object = unsafe { msg_send![class!(NSScreen), screens] };
        let count: u64 = unsafe { msg_send![screens, count] };
        let mut sf: NSRect = unsafe { std::mem::zeroed() };
        for i in 0..count {
            let screen: *mut Object = unsafe { msg_send![screens, objectAtIndex: i] };
            let f: NSRect = unsafe { msg_send![screen, frame] };
            if pt.x >= f.origin.x && pt.x < f.origin.x + f.size.width
                && pt.y >= f.origin.y && pt.y < f.origin.y + f.size.height
            { sf = f; break; }
        }
        // fallback: 主屏幕
        if sf.size.width == 0.0 {
            let screen: *mut Object = unsafe { msg_send![class!(NSScreen), mainScreen] };
            sf = unsafe { msg_send![screen, frame] };
        }

        return Ok((
            pt.x as i32, pt.y as i32,
            sf.origin.x as i32, sf.origin.y as i32,
            sf.size.width as i32, sf.size.height as i32,
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    compile_error!("get_cursor_and_screen: 不支持的平台");

    #[allow(unreachable_code)]
    Err("无法获取光标位置".into())
}

/// macOS Cocoa → web Y 轴翻转
fn cocoa_to_web_y(cocoa_y: i32, screen_origin_y: i32, screen_height: i32) -> i32 {
    (screen_origin_y + screen_height) - cocoa_y
}

// ==========================================
// CursorPosition (用于缩放动画 transform-origin)
// ==========================================

#[derive(Clone, Serialize)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
    pub screen_x: i32,
    pub screen_y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
}

#[tauri::command]
pub fn get_cursor_position() -> Result<CursorPosition, String> {
    let (cx, cy, sx, sy, sw, sh) = get_cursor_and_screen()?;

    // Windows 已是 web 坐标，macOS 需要 Y 轴翻转
    #[cfg(target_os = "macos")]
    let web_y = cocoa_to_web_y(cy, sy, sh);
    #[cfg(target_os = "windows")]
    let web_y = cy;

    rust_debug!("光标(web): ({},{}) 屏:({},{} {}x{})", cx, web_y, sx, sy, sw, sh);

    Ok(CursorPosition {
        x: cx,
        y: web_y,
        screen_x: sx,
        screen_y: sy,
        screen_w: sw,
        screen_h: sh,
    })
}

// ==========================================
// PopupPosition (用于快捷键弹出位置计算)
// ==========================================

#[derive(Clone, Serialize)]
pub struct PopupPosition {
    pub win_x: i32,
    pub win_y: i32,
    pub cursor_x: i32,
    pub cursor_y: i32,
}

#[tauri::command]
pub fn compute_popup_position(app: tauri::AppHandle, win_w: i32, win_h: i32) -> Result<PopupPosition, String> {
    let win_w = if win_w > 0 { win_w } else { 730 };
    let win_h = if win_h > 0 { win_h } else { 450 };

    // ── iTerm 风格增强 + 显示窗口 ──
    if let Some(win) = app.get_webview_window("main") {
        enhance_to_iterm_style(&win);
        let _ = win.set_focus();
    }

    let (cx, cy, sx, sy, sw, sh) = get_cursor_and_screen()?;

    // ── Cocoa → web 坐标转换（Y 轴翻转） ──
    #[cfg(target_os = "macos")]
    let web_cy = cocoa_to_web_y(cy, sy, sh);
    #[cfg(target_os = "windows")]
    let web_cy = cy;

    // ── 窗口位置：光标居中，clamp 到屏幕边缘 ──
    let web_cx = cx;
    let mut win_x = web_cx - win_w / 2;
    let mut win_y = web_cy - win_h / 2;
    win_x = win_x.clamp(sx, sx + sw - win_w);
    win_y = win_y.clamp(sy, sy + sh - win_h);

    rust_debug!("弹窗位置 web: win({},{}) cursor({},{}) 屏:({},{} {}x{})",
        win_x, win_y, web_cx, web_cy, sx, sy, sw, sh);

    Ok(PopupPosition { win_x, win_y, cursor_x: web_cx, cursor_y: web_cy })
}
