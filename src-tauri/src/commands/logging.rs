// ==========================================
// 日志 & 窗口聚焦命令
// ==========================================

use tauri::Manager;

use crate::{rust_info, rust_log};

/// 接收前端统一日志并打印到终端
#[tauri::command]
pub fn log_message(msg: String) {
    println!("{}", msg);
}

/// 聚焦主窗口（通知卡片点击时调用）
#[tauri::command]
pub fn focus_main(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        rust_info!("通知点击 → 聚焦主窗口");
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// macOS 系统通知 — 已移除
// 尝试过 tauri-plugin-notification（需代码签名）和 osascript
// display notification（Tauri WebView 沙箱下 osascript 无法
// 触发用户通知中心），均无法在 macOS 未签名开发构建中正常工作。
// 保留此注释作为占位，未来若 Apple 放开限制或 Tauri 提供新方案再议。
// ═══════════════════════════════════════════════════════════════

/// 打开主窗口 DevTools（调试用）
#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.open_devtools();
    }
    Ok(())
}
