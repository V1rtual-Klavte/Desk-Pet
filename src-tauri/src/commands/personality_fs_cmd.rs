// ==========================================
// 人格系统文件命令 — 通用文件 IO
// 目录结构:
//   {data}/personality/
//     cards/                   ← 用户导入 Card .md
//     stages/{cardId}.json      ← per-card 阶段文案
//     vars.json                 ← 单例变量池
//
// 路径解析:
//   读 (file_read / file_list): builtin_personality → personality
//   写 (file_write / file_delete): 仅 personality (带 validate_path)
// ==========================================

use std::fs;
use std::path::PathBuf;
use crate::paths::AppPaths;

/// 读取 personality/ 或 cards/ 下的文件
/// 优先从 builtin 读取，不存在则回退到 runtime 目录
#[tauri::command]
pub fn personality_file_read(path: String, paths: tauri::State<AppPaths>) -> Result<Vec<u8>, String> {
    let file_path = resolve_personality_path(&path, "read", &paths)?;
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    fs::read(&file_path).map_err(|e| format!("读取失败: {e}"))
}

/// 写入 personality/ 或 cards/ 下的文件（仅 runtime，自动创建父目录）
#[tauri::command]
pub fn personality_file_write(
    path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> Result<String, String> {
    let file_path = resolve_personality_path(&path, "write", &paths)?;
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 列出 personality/ 或 cards/ 下指定目录的文件
/// 优先从 builtin 查找目录，不存在则回退到 runtime
#[tauri::command]
pub fn personality_file_list(dir_path: String, paths: tauri::State<AppPaths>) -> Result<Vec<String>, String> {
    let dir = resolve_personality_path(&dir_path, "read", &paths)?;
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

/// 删除 personality/ 或 cards/ 下的文件（仅 runtime）
#[tauri::command]
pub fn personality_file_delete(path: String, paths: tauri::State<AppPaths>) -> Result<(), String> {
    let file_path = resolve_personality_path(&path, "write", &paths)?;
    if !file_path.exists() {
        return Ok(());
    }
    if file_path.is_dir() {
        return Err("不允许删除目录".into());
    }

    // write 模式下 resolve 已校验父目录在 personality 内，此处再做文件级二次校验
    if file_path.exists() {
        AppPaths::validate_path(&file_path, &paths.personality)?;
    }

    fs::remove_file(&file_path).map_err(|e| format!("删除失败: {e}"))
}

// ==========================================
// 路径解析（内部）
// ==========================================

/// 将前端相对路径（可选 "personality/" 前缀）解析为绝对路径
///
/// mode:
///   "read"  — 先在 builtin_personality 查找，不存在则回退到 personality
///   "write" — 仅解析到 personality (runtime)，自动创建父目录并校验路径安全
fn resolve_personality_path(relative: &str, mode: &str, paths: &AppPaths) -> Result<PathBuf, String> {
    // 兼容前端传入 "personality/stages/xxx" 的旧相对路径
    let normalized = relative.strip_prefix("personality/").unwrap_or(relative);

    // 安全检查：过滤 ParentDir 组件防止路径穿越
    let safe: PathBuf = PathBuf::from(normalized)
        .components()
        .filter(|c| !matches!(c, std::path::Component::ParentDir))
        .collect();

    match mode {
        "read" => {
            // 优先 builtin，再 runtime
            let builtin = paths.builtin_personality.join(&safe);
            if builtin.exists() {
                return Ok(builtin);
            }
            Ok(paths.personality.join(&safe))
        }
        "write" => {
            let target = paths.personality.join(&safe);

            // 自动创建父目录
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败: {e}"))?;
            }

            // 路径穿越防护：校验父目录在 personality 内
            if let Some(parent) = target.parent() {
                if parent.exists() {
                    AppPaths::validate_path(parent, &paths.personality)?;
                }
            }

            Ok(target)
        }
        _ => Err("未知路径解析模式".to_string()),
    }
}
