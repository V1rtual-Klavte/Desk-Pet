// ==========================================
// Windows 模拟器命令
// ==========================================

use std::path::PathBuf;
use tauri::{WebviewWindowBuilder, Manager};

use crate::rust_info;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn close_windows_sim(app: tauri::AppHandle) -> AppResult<String> {
    if let Some(w) = app.get_webview_window("windows-sim") {
        rust_info!("关闭 Windows 模拟器");
        let _ = w.destroy();
        Ok("closed".into())
    } else {
        Ok("not found".into())
    }
}

#[tauri::command]
pub async fn open_windows_sim(app: tauri::AppHandle) -> AppResult<String> {
    let label = "windows-sim";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.set_focus();
        return Ok("focused".into());
    }
    rust_info!("创建 Windows 模拟器窗口");
    WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(PathBuf::from("index.html")))
        .title("Windows")
        .inner_size(800.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .decorations(false)
        .center()
        .devtools(true)
        .build()
        .map(|w| format!("created: {}", w.label()))
        .map_err(|e| AppError::Io(format!("{}", e)))
}
