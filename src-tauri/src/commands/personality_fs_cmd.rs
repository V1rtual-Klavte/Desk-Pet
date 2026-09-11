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
use std::path::{Component, Path, PathBuf};
use crate::paths::AppPaths;
use crate::error::{err, AppError, AppResult};

/// 读取 personality/ 或 cards/ 下的文件
/// 优先从 builtin 读取，不存在则回退到 runtime 目录
#[tauri::command]
pub fn personality_file_read(path: String, paths: tauri::State<AppPaths>) -> AppResult<Vec<u8>> {
    let file_path = resolve_personality_path(&path, "read", &paths)?;
    if !file_path.exists() {
        return Err(AppError::PathNotFound(format!("文件不存在: {}", path)));
    }
    fs::read(&file_path).map_err(|e| AppError::Io(format!("读取失败: {e}")))
}

/// 写入 personality/ 或 cards/ 下的文件（仅 runtime，自动创建父目录）
#[tauri::command]
pub fn personality_file_write(
    path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> AppResult<String> {
    let file_path = resolve_personality_path(&path, "write", &paths)?;
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 列出 personality/ 或 cards/ 下指定目录的文件
/// 优先从 builtin 查找目录，不存在则回退到 runtime
#[tauri::command]
pub fn personality_file_list(dir_path: String, paths: tauri::State<AppPaths>) -> AppResult<Vec<String>> {
    let dir = resolve_personality_path(&dir_path, "read", &paths)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    if !dir.is_dir() {
        return err(format!("不是目录: {}", dir_path));
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
pub fn personality_file_delete(path: String, paths: tauri::State<AppPaths>) -> AppResult<()> {
    let file_path = resolve_personality_path(&path, "write", &paths)?;
    if !file_path.exists() {
        return Ok(());
    }
    if file_path.is_dir() {
        return Err(AppError::PathEscape);
    }

    // write 模式下 resolve 已校验父目录在 personality 内，此处再做文件级二次校验
    if file_path.exists() {
        AppPaths::validate_path(&file_path, &paths.personality)?;
    }

    fs::remove_file(&file_path).map_err(|e| AppError::Io(format!("删除失败: {e}")))
}

// ==========================================
// 路径解析（内部）
// ==========================================

/// 将**域内相对路径**（如 `stages/x.json`、`vars.json`）解析为绝对路径。
///
/// base 目录由本模块持有，调用方不得带 `personality/` 前缀 —— 见下方显式拒绝。
///
/// mode:
///   "read"  — 先在 builtin_personality 查找，不存在则回退到 personality
///   "write" — 仅解析到 personality (runtime)，自动创建父目录并校验路径安全
fn resolve_personality_path(relative: &str, mode: &str, paths: &AppPaths) -> AppResult<PathBuf> {
    // 明确拒绝域前缀：base 目录由本模块持有，前端只该传域内相对路径。
    // 若容忍 "personality/xxx"，它会拼成 personality/personality/xxx —— 读是静默找不到，
    // 写则会悄悄建出错误的嵌套目录。这里直接报错，不给兼容空间。
    if relative.starts_with("personality/") || relative.starts_with("personality\\") {
        return err(format!(
            "不要传域前缀，请传域内相对路径（如 stages/x.json）: {relative}"
        ));
    }

    // 只接受域内的普通路径段。不能通过过滤 `..` 修正非法输入：绝对路径在
    // PathBuf::join 时会替换 base，必须整体拒绝。
    let safe = safe_relative_path(relative)?;

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

            prepare_personality_write_path(&target, &paths.personality)?;

            Ok(target)
        }
        _ => err("未知路径解析模式"),
    }
}

fn safe_relative_path(relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(AppError::PathEscape);
    }
    Ok(path.to_path_buf())
}

/// 在创建目录前先校验最近的已存在祖先，避免已有符号链接把创建操作导向 data_root 外。
fn prepare_personality_write_path(target: &Path, base: &Path) -> AppResult<()> {
    if target.exists() {
        AppPaths::validate_path(target, base)?;
        return Ok(());
    }

    let parent = target.parent().ok_or(AppError::PathEscape)?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or(AppError::PathEscape)?;
    }
    AppPaths::validate_path(ancestor, base)?;

    fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    AppPaths::validate_path(parent, base)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use super::safe_relative_path;

    #[test]
    fn accepts_only_normal_relative_components() {
        assert_eq!(safe_relative_path("stages/card.json").unwrap(), PathBuf::from("stages").join("card.json"));
        assert!(safe_relative_path("../outside.json").is_err());
        assert!(safe_relative_path("./stages/card.json").is_err());
        assert!(safe_relative_path("/tmp/outside.json").is_err());
    }
}
