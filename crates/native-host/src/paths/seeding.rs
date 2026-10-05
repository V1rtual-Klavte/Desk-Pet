use super::development_data_root;
use super::AppPaths;
use crate::error::{AppError, AppResult};
use std::fs;
use std::path::Path;

pub(crate) fn seed_e2e_stages(paths: &AppPaths) -> AppResult<()> {
    let source = development_data_root()?.join("personality").join("stages");
    let target = paths.personality.join("stages");
    if !source.is_dir() || source == target {
        return Ok(());
    }
    copy_directory(&source, &target)
}

fn copy_directory(source: &Path, target: &Path) -> AppResult<()> {
    fs::create_dir_all(target).map_err(|e| AppError::Io(format!("创建测试种子目录失败: {e}")))?;
    for entry in
        fs::read_dir(source).map_err(|e| AppError::Io(format!("读取测试种子目录失败: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("读取测试种子条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(format!("读取测试种子类型失败: {e}")))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|e| AppError::Io(format!("复制测试阶段种子失败: {e}")))?;
        }
    }
    Ok(())
}

/// 默认资源只在第一次初始化时复制到运行时目录。
///
/// 标记写入后不再补齐缺失文件，用户删除自带 Profile/Card 或素材后不会在下一次
/// 启动时被恢复；运行时目录中的资源与用户导入资源具有完全相同的所有权。
pub(crate) fn seed_default_resources(paths: &AppPaths) -> AppResult<()> {
    let marker = paths.settings.join(".default-resources-seeded");
    if marker.exists() {
        AppPaths::validate_path(&marker, &paths.settings)?;
        return Ok(());
    }

    seed_all(&paths, false)?;
    fs::write(&marker, b"1\n")
        .map_err(|e| AppError::Io(format!("写入默认资源初始化标记失败: {marker:?}: {e}")))?;
    Ok(())
}

/// 各类默认资源的种子同步结果，字段是写回的文件数。
#[derive(serde::Serialize)]
pub struct SeedSummary {
    pub profiles: usize,
    pub cards: usize,
    pub skills: usize,
}

/// 用随包种子覆盖运行时资源，恢复出厂状态。
///
/// 与首次初始化不同，这里会覆盖同名文件。用户自建的资源不在种子里，
/// 因此不受影响；被覆盖的只有随包内置资源。
pub fn restore_default_resources(paths: &AppPaths) -> AppResult<SeedSummary> {
    seed_all(paths, true)
}

fn seed_all(paths: &AppPaths, overwrite: bool) -> AppResult<SeedSummary> {
    Ok(SeedSummary {
        profiles: sync_seed_directory(&paths.seed_profiles, &paths.profiles, "Profile", overwrite)?,
        cards: sync_seed_directory(
            &paths.seed_personality_cards,
            &paths.personality.join("cards"),
            "Card",
            overwrite,
        )?,
        skills: sync_seed_directory(&paths.seed_skills, &paths.skills, "Skill", overwrite)?,
    })
}

/// 把种子目录同步到运行时目录，返回复制的文件数。
///
/// `overwrite` 为假时只补缺失文件（首次初始化，绝不覆盖运行时编辑结果），
/// 为真时用种子覆盖同名文件（恢复出厂）。两种模式都只处理种子里存在的条目。
fn sync_seed_directory(
    source: &Path,
    target: &Path,
    label: &str,
    overwrite: bool,
) -> AppResult<usize> {
    if !source.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|e| AppError::Io(format!("创建 {label} 目录失败: {e}")))?;

    let mut copied = 0;
    for entry in
        fs::read_dir(source).map_err(|e| AppError::Io(format!("读取 {label} 种子失败: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("读取 {label} 种子条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(format!("读取 {label} 种子类型失败: {e}")))?;
        if file_type.is_dir() {
            copied += sync_seed_directory(&source_path, &target_path, label, overwrite)?;
        } else if file_type.is_file() && (overwrite || !target_path.exists()) {
            fs::copy(&source_path, &target_path)
                .map_err(|e| AppError::Io(format!("写入 {label} 种子失败: {e}")))?;
            copied += 1;
        }
    }
    Ok(copied)
}
