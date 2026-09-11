// ==========================================
// Profile 文件系统命令
// 用户 profile 存储于 AppPaths.profiles
// ==========================================

use std::fs;
use std::path::{Component, Path, PathBuf};
use crate::paths::AppPaths;

/// 写入 profile 文件（自动创建父目录）
#[tauri::command]
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> Result<(), String> {
    let file_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;

    // 安全检查：防止路径穿越 — validate_path 在 canonicalize 失败时直接 Err
    // 对不存在的文件，校验父目录是否存在且在 profiles/ 范围内
    if let Some(parent) = file_path.parent() {
        if parent.exists() {
            AppPaths::validate_path(parent, &paths.profiles)?;
        }
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    } else {
        return Err("无效的文件路径".into());
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
) -> Result<Vec<u8>, String> {
    // 1. 用户 profile (AppPaths.profiles)
    let user_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;
    if user_path.exists() {
        return fs::read(&user_path).map_err(|e| format!("读取失败: {e}"));
    }
    // 2. 内置 profile (AppPaths.builtin_profiles)
    let builtin_path = safe_profile_path(&paths.builtin_profiles, &profile_id, &relative_path)?;
    if builtin_path.exists() {
        return fs::read(&builtin_path).map_err(|e| format!("读取失败: {e}"));
    }
    Err(format!("文件不存在: {}/{}", profile_id, relative_path))
}

/// 删除用户 profile 目录
#[tauri::command]
pub fn profile_delete(profile_id: String, paths: tauri::State<AppPaths>) -> Result<(), String> {
    let dir = safe_profile_path(&paths.profiles, &profile_id, "profile.yaml")?
        .parent().ok_or("无效 Profile 目录")?.to_path_buf();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 返回用户 Profile 素材目录；内置 Profile 由前端打包资源 URL 提供。
#[tauri::command]
pub fn profile_asset_base(profile_id: String, paths: tauri::State<AppPaths>) -> Result<String, String> {
    validate_profile_id(&profile_id)?;
    let user = paths.profiles.join(&profile_id);
    Ok(if user.join("profile.yaml").is_file() {
        user.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

/// 返回 Profile 的可写用户覆盖目录。目录不存在时返回空字符串。
#[tauri::command]
pub fn profile_user_asset_base(profile_id: String, paths: tauri::State<AppPaths>) -> Result<String, String> {
    validate_profile_id(&profile_id)?;
    let user = paths.profiles.join(&profile_id);
    Ok(if user.is_dir() {
        user.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Profile ID 只能包含字母、数字、连字符和下划线".to_string());
    }
    Ok(())
}

fn safe_profile_path(base: &Path, profile_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    validate_profile_id(profile_id)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("Profile 相对路径非法".to_string());
    }
    Ok(base.join(profile_id).join(relative))
}

/// 列出用户 profiles（AppPaths.profiles 下）
#[tauri::command]
pub fn list_user_profiles(paths: tauri::State<AppPaths>) -> Result<Vec<String>, String> {
    let dir = &paths.profiles;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut profiles = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                profiles.push(name.to_string());
            }
        }
    }
    Ok(profiles)
}

/// 递归列出目录中所有图片文件的相对路径
fn list_image_files(dir: &PathBuf) -> Result<Vec<String>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    list_files_recursive(dir, dir, &mut files)?;
    files.sort();
    Ok(files)
}

fn list_files_recursive(base: &PathBuf, current: &PathBuf, files: &mut Vec<String>) -> Result<(), String> {
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
pub fn list_profile_files(profile_id: String, subdir: Option<String>, paths: tauri::State<AppPaths>) -> Result<Vec<String>, String> {
    validate_profile_id(&profile_id)?;
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

fn list_image_files_filtered(dir: &PathBuf, prefix: &Option<String>) -> Result<Vec<String>, String> {
    let all = list_image_files(dir)?;
    match prefix {
        Some(p) => Ok(all.into_iter().filter(|f| f.starts_with(p.as_str())).collect()),
        None => Ok(all),
    }
}
