// ==========================================
// 应用生命周期命令
// app_restart —— 进程级重启
// ==========================================

use crate::error::{AppError, AppResult};
use crate::rust_info;
use tauri::Manager;

/// 进程级重启：拉起新进程并退出当前进程。
///
/// 必须用 `request_restart()`，不能用 `AppHandle::restart()`：后者在本线程就是
/// 事件循环线程时直接 `cleanup_before_exit()` + `process::restart()`，**不发
/// `RunEvent::Exit`**，lib.rs 里回收 MCP 子进程的钩子不会执行，每次重启都漏下
/// 一批 npx / node。`request_restart()` 不做线程分支，统一经事件循环发 Exit，
/// 回收钩子必定先跑完再重启。
///
/// 开发模式（debug 构建）例外，走 [`reload_ui`]。
#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) -> AppResult<()> {
    if cfg!(debug_assertions) {
        return reload_ui(&app);
    }
    rust_info!("收到重启请求，转入进程级重启");
    app.request_restart();
    Ok(())
}

/// 开发模式下以界面重载代替进程重启：关闭其他窗口，重载主窗口。
///
/// `pnpm tauri dev` 的 CLI 把 app 当子进程管理，子进程一退出就结束整个 dev 会话
/// 并关掉 Vite 开发服务器。`process::restart()` 抢在退出前拉起的孤儿进程没有页面
/// 可加载，只剩一个空白窗口，终端里的 Ctrl+C 也失效（CLI 早已退出），只能从托盘
/// 退出。重载后前端从零 boot，设置改动与冷启动同样从磁盘重新读取；窗口集合也对齐
/// 真重启的结果——只剩主窗口。
fn reload_ui(app: &tauri::AppHandle) -> AppResult<()> {
    let Some(main) = app.get_webview_window("main") else {
        // 开发构建里没有主窗口的只有 E2E 宿主（它建的是 e2e 窗口）：如实报错，
        // 不静默假装重启成功
        return Err(AppError::Other("开发模式重启：未找到主窗口，无法重载".into()));
    };
    rust_info!("开发模式：以重载界面代替进程级重启（进程重启会终止 dev 会话）");
    for (label, window) in app.webview_windows() {
        if label != "main" {
            // 关闭失败（窗口已在关闭流程等）不影响重载目标：主窗口重载后就是唯一窗口
            let _ = window.close();
        }
    }
    main.reload()
        .map_err(|error| AppError::Other(format!("主窗口重载失败: {error}")))
}
