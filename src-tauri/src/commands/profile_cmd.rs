// ==========================================
// Profile 文件系统命令
// 用户 profile 存储于 AppPaths.profiles
// ==========================================

use std::fs;
use std::path::PathBuf;
use crate::paths::AppPaths;

/// 写入 profile 文件（自动创建父目录）
/// dev 模式下同时同步到 public/profiles 以形成闭包（Vite 开发服务器可加载）
#[tauri::command]
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> Result<(), String> {
    let dir = paths.profiles.join(&profile_id);
    let file_path = dir.join(&relative_path);

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

    // ★ dev 模式：同步拷贝到 builtin_profiles（即 public/profiles/）以形成闭包
    //   生产模式下 builtin_profiles 指向 Tauri resource_dir，不执行此同步
    #[cfg(debug_assertions)]
    {
        let public_path = paths.builtin_profiles.join(&profile_id).join(&relative_path);
        if let Some(parent) = public_path.parent() {
            if parent.exists() {
                AppPaths::validate_path(parent, &paths.builtin_profiles)?;
            }
            fs::create_dir_all(parent).map_err(|e| format!("创建 public 目录失败: {e}"))?;
        }
        fs::write(&public_path, &content).map_err(|e| format!("同步到 public/ 失败: {e}"))?;
    }

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
    let user_path = paths.profiles.join(&profile_id).join(&relative_path);
    if user_path.exists() {
        return fs::read(&user_path).map_err(|e| format!("读取失败: {e}"));
    }
    // 2. 内置 profile (AppPaths.builtin_profiles)
    let builtin_path = paths.builtin_profiles.join(&profile_id).join(&relative_path);
    if builtin_path.exists() {
        return fs::read(&builtin_path).map_err(|e| format!("读取失败: {e}"));
    }
    Err(format!("文件不存在: {}/{}", profile_id, relative_path))
}

/// 删除用户 profile 目录
#[tauri::command]
pub fn profile_delete(profile_id: String, paths: tauri::State<AppPaths>) -> Result<(), String> {
    let dir = paths.profiles.join(&profile_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
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
    let prefix = subdir.as_ref().map(|s| {
        let trimmed = s.trim_matches('/');
        if trimmed.is_empty() { None } else { Some(format!("{}/", trimmed)) }
    }).flatten();

    let mut all_files = Vec::new();

    // 收集内置 profile 的素材
    let builtin_files = list_builtin_profile_images(&profile_id, &paths.builtin_profiles, &prefix);
    if let Ok(ref files) = builtin_files {
        all_files.extend(files.clone());
    }

    // 收集用户 profile (AppPaths.profiles) 的素材
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

    // 内置回退（如果没有用户目录）
    if all_files.is_empty() {
        if let Ok(ref files) = builtin_files {
            all_files.extend(files.clone());
        }
    }

    all_files.sort();
    if all_files.is_empty() {
        Err(format!("Profile '{}' 未找到素材", profile_id))
    } else {
        Ok(all_files)
    }
}

fn list_builtin_profile_images(profile_id: &str, builtin_profiles: &PathBuf, prefix: &Option<String>) -> Result<Vec<String>, String> {
    let mut files = Vec::new();

    // builtin_profiles 已由 AppPaths::resolve_resource_dir 处理 dev/prod 差异
    let builtin_dir = builtin_profiles.join(profile_id);
    if builtin_dir.exists() {
        if let Ok(ref f) = list_image_files_filtered(&builtin_dir, prefix) {
            files.extend(f.clone());
        }
    }

    Ok(files)
}

fn list_image_files_filtered(dir: &PathBuf, prefix: &Option<String>) -> Result<Vec<String>, String> {
    let all = list_image_files(dir)?;
    match prefix {
        Some(p) => Ok(all.into_iter().filter(|f| f.starts_with(p.as_str())).collect()),
        None => Ok(all),
    }
}
