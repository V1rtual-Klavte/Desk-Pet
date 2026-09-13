// ==========================================
// 运行时资源命令
//
// 随包种子 src-tauri/resources/defaults/ 只在首次启动复制一次，之后运行时目录
// 里的资源与用户导入资源所有权相同：用户可以改、可以删，应用不再覆盖。
// 这里提供两个手动的集中入口 —— 找回误删的内置资源，以及删除整个 Skill 目录
// （通用 file_delete 只允许 memory/ 与 sessions/）。
// ==========================================

use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::{self, AppPaths, SeedSummary};
use crate::rust_info;

/// 用随包种子覆盖运行时资源，恢复出厂状态。
#[tauri::command]
pub fn restore_default_resources(paths: State<AppPaths>) -> AppResult<SeedSummary> {
    let summary = paths::restore_default_resources(&paths)?;
    rust_info!(
        "默认资源已恢复: Profile {} 个文件, Card {} 个文件, Skill {} 个文件",
        summary.profiles,
        summary.cards,
        summary.skills
    );
    Ok(summary)
}

/// 删除 data_root/skills/{name}/ 整个目录。
#[tauri::command]
pub fn skill_delete(name: String, paths: State<AppPaths>) -> AppResult<()> {
    let dir = resolve_skill_dir(&name, &paths)?;
    if !dir.exists() {
        return Ok(());
    }
    AppPaths::validate_path(&dir, &paths.skills)?;
    fs::remove_dir_all(&dir).map_err(|e| AppError::Io(format!("删除 Skill 失败: {e}")))?;
    rust_info!("Skill 已删除: {name}");
    Ok(())
}

/// 把 skill 名解析为 data_root/skills/ 下的目录。
///
/// Pi 约定 skill 名只能是小写字母、数字与连字符，因此这里直接按字符集拒绝，
/// 不做任何路径归一化 —— 带 `/`、`.` 或域前缀的入参一律判非法。
fn resolve_skill_dir(name: &str, paths: &AppPaths) -> AppResult<PathBuf> {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(AppError::PathEscape);
    }
    Ok(paths.skills.join(name))
}
