// ==========================================
// 默认资源命令
//
// 随包种子 src-tauri/resources/defaults/ 只在首次启动复制一次，
// 之后运行时目录里的资源与用户导入资源所有权相同。误删或想同步种子更新时，
// 用这里的命令手动恢复。种子之外的用户自建资源不受影响。
// ==========================================

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::paths::{self, AppPaths};
use crate::rust_info;

#[derive(Serialize)]
pub struct RestoreResult {
    /// 写回的 Profile 文件数
    pub profiles: usize,
    /// 写回的 Card 文件数
    pub cards: usize,
}

/// 用随包种子覆盖运行时资源，恢复出厂状态。
#[tauri::command]
pub fn restore_default_resources(paths: State<AppPaths>) -> AppResult<RestoreResult> {
    let (profiles, cards) = paths::restore_default_resources(&paths)?;
    rust_info!("默认资源已恢复: Profile {profiles} 个文件, Card {cards} 个文件");
    Ok(RestoreResult { profiles, cards })
}
