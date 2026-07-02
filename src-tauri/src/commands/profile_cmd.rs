// ==========================================
// Profile 文件系统命令
// 用户 profile 存储于 {AppData}/desk-pet/profiles/
// ==========================================

use std::fs;
use std::path::PathBuf;

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

/// 检查是否安装了 dirs-next（用于获取 AppData 路径）
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
