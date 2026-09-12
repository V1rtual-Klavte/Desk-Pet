// ==========================================
// 日志 & 窗口聚焦命令
// ==========================================

use tauri::Manager;

use crate::error::AppResult;
use crate::logger;
use crate::rust_info;

/// 接收前端统一日志。
/// 前端已按生效级别过滤，且以**单一 FIFO 队列**批量发送以保证顺序，
/// 所以这里不再按级别分流（分流会打乱文件里的物理顺序），原样落盘即可。
#[tauri::command]
pub fn log_messages(msgs: Vec<String>) {
    for msg in msgs {
        logger::emit_frontend(&msg);
    }
}

/// 前端启动后推送生效级别。
/// 与 set_monitor_config 同一模式：配置的唯一真相源在前端，Rust 只接收原语。
#[tauri::command]
pub fn set_log_config(level: u8) {
    logger::set_level(level);
    rust_info!(
        "日志级别已由前端设置: {}",
        logger::level_name(logger::level())
    );
}

/// 前端未捕获异常上报 —— 即使前端界面全挂，终端与日志文件里也要留下完整记录。
#[tauri::command]
pub fn report_frontend_error(source: String, message: String, stack: String) {
    logger::emit(
        logger::LEVEL_ERROR,
        format_args!("[前端异常][{source}] {message}\n{stack}"),
    );
}

/// 聚焦主窗口（通知卡片点击时调用）
#[tauri::command]
pub fn focus_main(app: tauri::AppHandle) -> AppResult<()> {
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
pub fn open_devtools(app: tauri::AppHandle) -> AppResult<()> {
    #[cfg(debug_assertions)]
    {
        if let Some(w) = app.get_webview_window("main") {
            w.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
    Ok(())
}
