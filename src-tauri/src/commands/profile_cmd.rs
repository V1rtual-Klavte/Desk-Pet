// ==========================================
// Profile 文件系统命令
// 用户 profile 存储于 {AppData}/desk-pet/profiles/
// ==========================================

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn get_app_data_dir() -> Result<PathBuf, String> {
    let base = dirs_next().ok_or("无法获取应用数据目录")?;
    Ok(base.join("desk-pet"))
}

/// 获取用户 profiles 目录路径
#[tauri::command]
pub fn get_profiles_dir() -> Result<String, String> {
    let dir = get_app_data_dir()?.join("profiles");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 profiles 目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 写入 profile 文件（自动创建父目录）
#[tauri::command]
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    let dir = get_app_data_dir()?.join("profiles").join(&profile_id);
    let file_path = dir.join(&relative_path);

    // 安全检查：防止路径穿越
    let canonical_dir = dir.canonicalize().unwrap_or(dir.clone());
    let canonical_file = file_path.canonicalize().unwrap_or(file_path.clone());
    if !canonical_file.starts_with(&canonical_dir) {
        return Err("路径穿越禁止".into());
    }

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

/// 删除用户 profile 目录
#[tauri::command]
pub fn profile_delete(profile_id: String) -> Result<(), String> {
    let dir = get_app_data_dir()?.join("profiles").join(&profile_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 列出用户 profiles（AppData 下）
#[tauri::command]
pub fn list_user_profiles() -> Result<Vec<String>, String> {
    let dir = get_app_data_dir()?.join("profiles");
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

/// 列出 profile 中所有图片素材（用户 profile / 内置 profile）
#[tauri::command]
pub fn list_profile_files(profile_id: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // 1. 用户 profile (AppData)
    let user_dir = get_app_data_dir()?.join("profiles").join(&profile_id);
    if user_dir.exists() {
        return list_image_files(&user_dir);
    }
    // 2. 内置 profile (资源目录)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let builtin_dir = resource_dir.join("profiles").join(&profile_id);
        if builtin_dir.exists() {
            return list_image_files(&builtin_dir);
        }
    }
    // 3. dev 模式: public/profiles/ (项目根)
    if let Ok(cargo_manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev_dir = PathBuf::from(&cargo_manifest).parent().unwrap_or(&PathBuf::from(&cargo_manifest)).join("public").join("profiles").join(&profile_id);
        if dev_dir.exists() {
            return list_image_files(&dev_dir);
        }
    }
    Err(format!("Profile '{profile_id}' 未找到"))
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA").ok().map(PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local").join("share"))
    }
}
