// ==========================================
// 人格系统文件命令 — 通用文件 IO
// 目录结构:
//   {project}/src/services/personality/
//     cards/                   ← 内置/用户 Card .md
//     stages/{cardId}.json      ← per-card 阶段文案
//     vars.json                 ← 单例变量池
// ==========================================

use std::fs;
use std::path::PathBuf;

/// 获取项目根目录
fn get_project_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "无法获取项目根目录".to_string())
}

/// 获取项目 src/services/personality/ 基础目录
fn get_personality_base_dir() -> Result<PathBuf, String> {
    Ok(get_project_root()?.join("src").join("services").join("personality"))
}

/// 获取 personality/ 目录路径
#[tauri::command]
pub fn get_personality_dir() -> Result<String, String> {
    let dir = get_personality_base_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 personality 目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 获取 personality/cards/ 目录路径（用户导入的 Card）
#[tauri::command]
pub fn get_cards_dir() -> Result<String, String> {
    let dir = get_personality_base_dir()?.join("cards");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 personality/cards 目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 读取 personality/ 或 cards/ 下的文件
#[tauri::command]
pub fn personality_file_read(path: String) -> Result<Vec<u8>, String> {
    let file_path = resolve_personality_path(&path)?;
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    fs::read(&file_path).map_err(|e| format!("读取失败: {e}"))
}

/// 写入 personality/ 或 cards/ 下的文件（自动创建父目录）
#[tauri::command]
pub fn personality_file_write(path: String, content: Vec<u8>) -> Result<String, String> {
    let file_path = resolve_personality_path(&path)?;

    // 安全检查：确保父目录在 base 下
    let base = get_personality_base_dir()?;
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        let canonical_parent = parent.canonicalize().unwrap_or(parent.to_path_buf());
        if !canonical_parent.starts_with(&canonical_base) {
            return Err("路径穿越禁止".into());
        }
    }

    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 列出 personality/ 或 cards/ 下指定目录的文件
#[tauri::command]
pub fn personality_file_list(dir_path: String) -> Result<Vec<String>, String> {
    let dir = resolve_personality_path(&dir_path)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir_path));
    }

    let mut files: Vec<String> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
            files.push(name.to_string());
        }
    }
    files.sort();
    Ok(files)
}

/// 删除 personality/ 或 cards/ 下的文件
#[tauri::command]
pub fn personality_file_delete(path: String) -> Result<(), String> {
    let file_path = resolve_personality_path(&path)?;
    if !file_path.exists() {
        return Ok(());
    }
    if file_path.is_dir() {
        return Err("不允许删除目录".into());
    }

    let base = get_personality_base_dir()?;
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    let canonical_file = file_path.canonicalize().unwrap_or(file_path.clone());
    if !canonical_file.starts_with(&canonical_base) {
        return Err("路径穿越禁止".into());
    }

    fs::remove_file(&file_path).map_err(|e| format!("删除失败: {e}"))
}

/// 将相对路径解析到项目 src/services/personality/ 下的绝对路径
fn resolve_personality_path(relative: &str) -> Result<PathBuf, String> {
    let base = get_personality_base_dir()?;

    // 兼容前端传入 personality/stages/xxx 的旧相对路径。
    let normalized = relative.strip_prefix("personality/").unwrap_or(relative);

    // 安全检查：过滤 ParentDir 组件防止路径穿越
    let safe: PathBuf = PathBuf::from(normalized)
        .components()
        .filter(|c| !matches!(c, std::path::Component::ParentDir))
        .collect();

    let resolved = base.join(&safe);

    // 确保解析后的路径仍在 base 下
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    if let Some(parent) = resolved.parent() {
        if parent.exists() {
            let canonical_parent = parent.canonicalize().unwrap_or(parent.to_path_buf());
            if !canonical_parent.starts_with(&canonical_base) {
                return Err("路径穿越禁止".into());
            }
        }
    }

    Ok(resolved)
}

