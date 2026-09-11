// ==========================================
// Profile 文件系统命令
// 用户 profile 存储于 AppPaths.profiles
// ==========================================

use std::fs;
use std::path::{Component, Path, PathBuf};
use crate::paths::AppPaths;
use crate::error::{err, AppError, AppResult};

/// 写入 profile 文件（自动创建父目录）
#[tauri::command]
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> AppResult<()> {
    ensure_user_profile_target(&paths, &profile_id)?;
    let file_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;

    // 安全检查：防止路径穿越 — validate_path 在 canonicalize 失败时直接 Err
    // 对不存在的文件，校验父目录是否存在且在 profiles/ 范围内
    if let Some(parent) = file_path.parent() {
        if parent.exists() {
            AppPaths::validate_path(parent, &paths.profiles)?;
        }
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    } else {
        return err("无效的文件路径");
    }
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

/// 读取 profile 文件（先查 AppPaths.profiles，再查内置）
#[tauri::command]
pub fn profile_file_read(
    profile_id: String,
    relative_path: String,
    paths: tauri::State<AppPaths>,
) -> AppResult<Vec<u8>> {
    // 1. 用户 profile (AppPaths.profiles)
    let user_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;
    if user_path.exists() {
        return fs::read(&user_path).map_err(|e| AppError::Io(format!("读取失败: {e}")));
    }
    // 2. 内置 profile (AppPaths.builtin_profiles)
    let builtin_path = safe_profile_path(&paths.builtin_profiles, &profile_id, &relative_path)?;
    if builtin_path.exists() {
        return fs::read(&builtin_path).map_err(|e| AppError::Io(format!("读取失败: {e}")));
    }
    Err(AppError::PathNotFound(format!("文件不存在: {}/{}", profile_id, relative_path)))
}

/// 删除用户 profile 目录
#[tauri::command]
pub fn profile_delete(profile_id: String, paths: tauri::State<AppPaths>) -> AppResult<()> {
    ensure_user_profile_target(&paths, &profile_id)?;
    let dir = safe_profile_path(&paths.profiles, &profile_id, "profile.yaml")?
        .parent().ok_or("无效 Profile 目录")?.to_path_buf();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 将 Profile 完整复制到用户目录。内置资源先复制，已有用户覆盖再叠加。
#[tauri::command]
pub fn profile_clone(
    source_profile_id: String,
    target_profile_id: String,
    paths: tauri::State<AppPaths>,
) -> AppResult<()> {
    validate_profile_id(&source_profile_id)?;
    ensure_user_profile_target(&paths, &target_profile_id)?;
    if source_profile_id == target_profile_id {
        return err("源 Profile 和目标 Profile 不能相同");
    }

    let target = paths.profiles.join(&target_profile_id);
    if target.exists() {
        return err("目标 Profile 已存在");
    }

    let user_source = paths.profiles.join(&source_profile_id);
    let builtin_source = paths.builtin_profiles.join(&source_profile_id);
    if !user_source.is_dir() && !builtin_source.is_dir() {
        return err(format!("源 Profile 不存在: {source_profile_id}"));
    }

    fs::create_dir_all(&target).map_err(|e| AppError::Io(format!("创建目标目录失败: {e}")))?;
    let target = AppPaths::validate_path(&target, &paths.profiles)?;
    // 内置资源作为基础，用户目录中的同名文件作为覆盖层。
    if builtin_source.is_dir() {
        copy_profile_tree(&builtin_source, &target)?;
    }
    if user_source.is_dir() && !is_builtin_profile(&paths, &source_profile_id) {
        copy_profile_tree(&user_source, &target)?;
    }
    Ok(())
}

fn copy_profile_tree(source: &Path, target: &Path) -> AppResult<()> {
    for entry in fs::read_dir(source).map_err(|e| AppError::Io(format!("读取 Profile 失败: {e}")))? {
        let entry = entry.map_err(|e| AppError::Io(format!("读取 Profile 条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| AppError::Io(format!("读取文件类型失败: {e}")))?;
        if file_type.is_dir() {
            fs::create_dir_all(&target_path).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
            copy_profile_tree(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|e| AppError::Io(format!("复制文件失败: {e}")))?;
        }
    }
    Ok(())
}

/// 返回用户 Profile 素材目录；内置 Profile 由前端打包资源 URL 提供。
#[tauri::command]
pub fn profile_asset_base(profile_id: String, paths: tauri::State<AppPaths>) -> AppResult<String> {
    validate_profile_id(&profile_id)?;
    if is_builtin_profile(&paths, &profile_id) {
        return Ok(String::new());
    }
    let user = paths.profiles.join(&profile_id);
    Ok(if user.join("profile.yaml").is_file() {
        user.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

/// 返回 Profile 的可写用户覆盖目录。目录不存在时返回空字符串。
#[tauri::command]
pub fn profile_user_asset_base(profile_id: String, paths: tauri::State<AppPaths>) -> AppResult<String> {
    validate_profile_id(&profile_id)?;
    if is_builtin_profile(&paths, &profile_id) {
        return Ok(String::new());
    }
    let user = paths.profiles.join(&profile_id);
    Ok(if user.is_dir() {
        user.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

fn validate_profile_id(profile_id: &str) -> AppResult<()> {
    if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::PathEscape);
    }
    Ok(())
}

fn is_builtin_profile(paths: &AppPaths, profile_id: &str) -> bool {
    paths.builtin_profiles.join(profile_id).is_dir()
}

fn ensure_user_profile_target(paths: &AppPaths, profile_id: &str) -> AppResult<()> {
    validate_profile_id(profile_id)?;
    if is_builtin_profile(paths, profile_id) {
        return err("内置 Profile 为只读资源，请先复制为用户 Profile");
    }
    Ok(())
}

fn safe_profile_path(base: &Path, profile_id: &str, relative_path: &str) -> AppResult<PathBuf> {
    validate_profile_id(profile_id)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(AppError::PathEscape);
    }
    Ok(base.join(profile_id).join(relative))
}

/// 列出用户 profiles（AppPaths.profiles 下）
#[tauri::command]
pub fn list_user_profiles(paths: tauri::State<AppPaths>) -> AppResult<Vec<String>> {
    let dir = &paths.profiles;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut profiles = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                if !is_builtin_profile(&paths, name) {
                    profiles.push(name.to_string());
                }
            }
        }
    }
    Ok(profiles)
}

/// 递归列出目录中所有图片文件的相对路径
fn list_image_files(dir: &PathBuf) -> AppResult<Vec<String>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    list_files_recursive(dir, dir, &mut files)?;
    files.sort();
    Ok(files)
}

fn list_files_recursive(base: &PathBuf, current: &PathBuf, files: &mut Vec<String>) -> AppResult<()> {
    let dir = fs::read_dir(current).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in dir {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            list_files_recursive(base, &path, files)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if matches!(ext_lower.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") {
                    if let Ok(rel) = path.strip_prefix(base) {
                        files.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

/// 列出 profile 中所有图片素材（合并用户 + 内置来源）
/// subdir: 可选子目录过滤（如 "materials/L2"）
#[tauri::command]
pub fn list_profile_files(profile_id: String, subdir: Option<String>, paths: tauri::State<AppPaths>) -> AppResult<Vec<String>> {
    validate_profile_id(&profile_id)?;
    if is_builtin_profile(&paths, &profile_id) {
        return Ok(vec![]);
    }
    let prefix = subdir.as_ref().map(|s| {
        let trimmed = s.trim_matches('/');
        if trimmed.is_empty() { None } else { Some(format!("{}/", trimmed)) }
    }).flatten();

    let mut all_files = Vec::new();

    // 只扫描可写的用户 Profile。内置素材来自前端打包资源，不能依赖生产文件系统。
    let user_dir = paths.profiles.join(&profile_id);
    if user_dir.exists() {
        if let Ok(ref files) = list_image_files_filtered(&user_dir, &prefix) {
            for f in files {
                if !all_files.contains(f) {
                    all_files.push(f.clone());
                }
            }
        }
    }

    all_files.sort();
    Ok(all_files)
}

fn list_image_files_filtered(dir: &PathBuf, prefix: &Option<String>) -> AppResult<Vec<String>> {
    let all = list_image_files(dir)?;
    match prefix {
        Some(p) => Ok(all.into_iter().filter(|f| f.starts_with(p.as_str())).collect()),
        None => Ok(all),
    }
}
