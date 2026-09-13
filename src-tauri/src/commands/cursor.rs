// ==========================================
// 光标位置 & 弹窗位置计算
// 共享光标/屏幕检测辅助函数，消除 get_cursor_position 和 compute_popup_position 间的重复代码
// ==========================================

use serde::Serialize;
use tauri::Manager;

use crate::rust_debug;
use crate::rust_log;
use crate::window::enhance_to_iterm_style;

/// 获取光标位置和所在屏幕信息（不做 Y 轴翻转）
/// Windows: 物理像素按显示器 DPI 换算为逻辑（web）坐标，左上原点
/// macOS:   Cocoa 坐标系（原点左下），调用方需做 Y 轴翻转；本身即逻辑坐标
type CursorScreen = (i32, i32, i32, i32, i32, i32, f64, f64);

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
        // 物理像素 → 逻辑坐标：前端 setPosition/setSize 吃的是逻辑坐标，
        // Tauri 还会再乘一次缩放比，这里不换算会让弹窗位置偏移量随缩放比放大
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y); // 0 = MDT_EFFECTIVE_DPI
        let scale_x = if dpi_x == 0 { 1.0 } else { dpi_x as f64 / 96.0 };
        let scale_y = if dpi_y == 0 { 1.0 } else { dpi_y as f64 / 96.0 };
        let lx = (pt.x as f64 / scale_x).round() as i32;
        let ly = (pt.y as f64 / scale_y).round() as i32;
        let lsx = (sx as f64 / scale_x).round() as i32;
        let lsy = (sy as f64 / scale_y).round() as i32;
        let lsw = (sw as f64 / scale_x).round() as i32;
        let lsh = (sh as f64 / scale_y).round() as i32;
        rust_debug!("光标(Win): 物({},{}) 逻({},{}) 屏:物({},{} {}x{}) 逻({},{} {}x{}) DPI:{}x{}",
            pt.x, pt.y, lx, ly, sx, sy, sw, sh, lsx, lsy, lsw, lsh, dpi_x, dpi_y);
        return Ok((lx, ly, lsx, lsy, lsw, lsh, scale_x, scale_y));
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
            1.0, 1.0,
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
    let (cx, cy, sx, sy, sw, sh, _scale_x, _scale_y) = get_cursor_and_screen()?;

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
// NormalizedCursor (鼠标追踪全屏跟随：全局光标坐标 + 屏幕中心归一化)
// ==========================================

#[derive(Clone, Serialize)]
pub struct NormalizedCursor {
    /// 光标所在屏幕内的原始逻辑坐标（x 相对屏幕左缘，y 相对屏幕顶部）
    pub x: i32,
    pub y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
    /// 以光标所在屏幕中心为原点归一化到 [-1,1]：左/上为 -1，右/下为 +1，中心为 0
    pub norm_x: f64,
    pub norm_y: f64,
}

#[tauri::command]
pub fn get_normalized_cursor() -> Result<NormalizedCursor, String> {
    let (cx, cy, sx, sy, sw, sh, _scale_x, _scale_y) = get_cursor_and_screen()?;

    // y 统一为相对屏幕顶部的逻辑坐标（macOS Cocoa→web 翻转，Windows 虚拟屏幕坐标减屏幕原点）
    #[cfg(target_os = "macos")]
    let y_rel = cocoa_to_web_y(cy, sy, sh);
    #[cfg(target_os = "windows")]
    let y_rel = cy - sy;

    let half_w = (sw as f64 / 2.0).max(1.0);
    let half_h = (sh as f64 / 2.0).max(1.0);
    let norm_x = (((cx - sx) as f64 - half_w) / half_w).clamp(-1.0, 1.0);
    let norm_y = ((y_rel as f64 - half_h) / half_h).clamp(-1.0, 1.0);

    Ok(NormalizedCursor {
        x: cx - sx,
        y: y_rel,
        screen_w: sw,
        screen_h: sh,
        norm_x,
        norm_y,
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
    let win_w = if win_w > 0 { win_w } else { 448 };
    let win_h = if win_h > 0 { win_h } else { 272 };

    // ── iTerm 风格增强 + 显示窗口 ──
    if let Some(win) = app.get_webview_window("main") {
        enhance_to_iterm_style(&win);
        let _ = win.set_focus();
    }

    let (cx, cy, sx, sy, sw, sh, _scale_x, _scale_y) = get_cursor_and_screen()?;

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
