// ==========================================
// 应用生命周期命令
// app_restart —— 进程级重启
// ==========================================

use crate::error::AppResult;
use crate::rust_info;

/// 进程级重启：拉起新进程并退出当前进程。
///
/// 必须用 `request_restart()`，不能用 `AppHandle::restart()`：后者在本线程就是
/// 事件循环线程时直接 `cleanup_before_exit()` + `process::restart()`，**不发
/// `RunEvent::Exit`**，lib.rs 里回收 MCP 子进程的钩子不会执行，每次重启都漏下
/// 一批 npx / node。`request_restart()` 不做线程分支，统一经事件循环发 Exit，
/// 回收钩子必定先跑完再重启。
#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) -> AppResult<()> {
    rust_info!("收到重启请求，转入进程级重启");
    app.request_restart();
    Ok(())
}
