// ==========================================
// 记忆系统命令 —— 文件注册表 + 会话文件管理
// ==========================================
// 目录结构:
//   {data_root}/
//     memory/               长期记忆注册表
//       MEMORY.md           ★ 结构化注册表（系统块 + 记忆块）
//       SESSION_MEMORY.md   ★ 当前会话工作记忆
//       CANDY.md            用户系统指令
//       User.md             用户画像
//       Outside.md          外部知识
//       Project.md          ★ 会话归档指针 → sessions/
//     sessions/             会话归档目录
//       session-YYYYMMDD-HHmmss-主题.md   结构化会话文件
// ==========================================

use std::path::PathBuf;
use std::fs;
use tauri::command;
use crate::paths::AppPaths;

/// 获取 memory/ 目录下指定文件的完整路径。
#[command]
pub fn get_memory_file(paths: tauri::State<AppPaths>, filename: String) -> Result<String, String> {
    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效文件名: {}", filename))?;

    if safe_name.contains("..") || safe_name.contains('/') || safe_name.contains('\\') {
        return Err(format!("非法文件名: {}", safe_name));
    }

    let file_path = paths.memory.join(&safe_name);
    Ok(file_path.to_string_lossy().to_string())
}

/// 获取 sessions/ 目录下指定文件的完整路径。
#[command]
pub fn get_session_file(paths: tauri::State<AppPaths>, filename: String) -> Result<String, String> {
    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效文件名: {}", filename))?;

    if safe_name.contains("..") || safe_name.contains('/') || safe_name.contains('\\') {
        return Err(format!("非法文件名: {}", safe_name));
    }

    let file_path = paths.sessions.join(&safe_name);
    Ok(file_path.to_string_lossy().to_string())
}

/// ★ 列出 sessions/ 目录下所有 .md 文件（按名称倒序）
#[command]
pub fn list_session_files(paths: tauri::State<AppPaths>) -> Result<Vec<String>, String> {
    let sessions_dir = &paths.sessions;

    let mut files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(sessions_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") && name != ".gitkeep" {
                files.push(name);
            }
        }
    }

    // 按文件名倒序（新的在前）
    files.sort_by(|a, b| b.cmp(a));
    Ok(files)
}

/// ★ 删除 sessions/ 目录下指定的文件
#[command]
pub fn delete_session_file(paths: tauri::State<AppPaths>, filename: String) -> Result<(), String> {
    println!("[Rust] delete_session_file: {} | dir: {}", filename, paths.sessions.display());

    // 安全检查
    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效文件名: {}", filename))?;

    if safe_name.contains("..") || safe_name.contains('/') || safe_name.contains('\\') {
        return Err(format!("非法文件名: {}", safe_name));
    }

    if !safe_name.ends_with(".md") {
        return Err(format!("不是有效的会话文件: {}", safe_name));
    }

    let file_path = paths.sessions.join(&safe_name);
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("删除失败: {}", e))?;
    }

    Ok(())
}

/// ★ 删除任意文件（用于 file_delete 工具 + 重命名清理）
#[command]
pub fn file_delete(paths: tauri::State<AppPaths>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(()); // 文件不存在不算错误
    }
    // 路径穿越防护：校验在 memory/ 或 sessions/ 内
    let resolved = p.canonicalize().map_err(|e| format!("路径解析失败: {e}"))?;
    let in_memory = resolved.starts_with(&paths.memory);
    let in_sessions = resolved.starts_with(&paths.sessions);
    if !in_memory && !in_sessions {
        return Err("安全限制: 只能在 memory/ 或 sessions/ 目录下删除文件".to_string());
    }
    fs::remove_file(&p).map_err(|e| format!("删除失败: {}", e))
}

/// 初始化 memory/ 和 sessions/ 目录结构及模板文件。
/// ★ 使用 AppPaths 统一路径管理。
/// 模板使用新的 MEMORY.md 双块结构。
#[command]
pub fn init_memory_files(paths: tauri::State<AppPaths>) -> Result<String, String> {
    let memory_dir = &paths.memory;
    let sessions_dir = &paths.sessions;

    // 确保 sessions/ 目录存在
    fs::create_dir_all(sessions_dir)
        .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;

    // ── 模板文件（新 MEMORY.md 双块结构，无 SESSION_MEMORY.md）──
    let templates: [(&str, &str); 5] = [
        ("MEMORY.md",
         "# MEMORY.md — 长期记忆注册表\n\n\
          > **系统文件** — 4 个固定指针，指向 memory/ 下的系统 md 文件。\n\
          > **长期记忆** — 糖糖在对话中学习和记录的事实。\n\
          > 格式: `- [日期] [分类] [imp:重要性] 摘要 |id:UUID`\n\n\
          ---\n\n\
          ## 系统文件\n\n\
          - [imp:10] CANDY.md — 用户系统指令\n\
          - [imp:9] User.md — 用户画像与偏好\n\
          - [imp:6] Outside.md — 外部知识指针\n\
          - [imp:8] Project.md — 会话归档指针 → sessions/\n\n\
          ## 长期记忆\n\n\
          <!-- 暂无长期记忆条目 -->\n"),
        ("CANDY.md",
         "# CANDY.md — 用户系统指令\n\n\
          > 此文件中的指令将作为 System Prompt 的一部分注入。\n\
          > 你可以在此写入对糖糖的行为要求。\n\n\
          ---\n\n\
          ## 指令\n\n\
          <!-- 在此添加你的自定义指令，例如：叫我小明、用日语回复、喜欢简短回答等 -->\n"),
        ("User.md",
         "# User.md — 用户画像\n\n\
          > 糖糖会在对话中逐渐了解你，并将关键信息记录在此。\n\
          > 此文件由 MemoryService 自动维护（importance ≥ 7 的 user 类条目）。\n\n\
          ---\n\n\
          ## 用户信息\n\n\
          <!-- 自动记录: 名称、偏好、习惯等 -->\n"),
        ("Outside.md",
         "# Outside.md — 外部知识指针\n\n\
          > 指向外部知识源的链接/引用。\n\
          > 此文件由 MemoryService 自动维护。\n\n\
          ---\n\n\
          ## 外部知识\n"),
        ("Project.md",
         "# Project.md — 会话归档指针索引\n\n\
          > 指向 sessions/ 目录中的历史会话文件。\n\
          > 格式: `- [日期] session名 | 轮数 | 主请求 | 关键技术`\n\n\
          ---\n\n\
          ## 归档会话\n\n\
          <!-- 格式: - [YYYY-MM-DD] session-xxx-主题.md | N轮 | 主请求: xxx | 关键技术: xxx, xxx -->\n"),
    ];

    for (filename, template) in &templates {
        let file_path = memory_dir.join(filename);
        if !file_path.exists() {
            fs::write(&file_path, template)
                .map_err(|e| format!("无法创建 {}: {}", filename, e))?;
        }
    }

    // 确保 sessions/ 下有 .gitkeep（dev 模式）
    if cfg!(debug_assertions) {
        let gitkeep = sessions_dir.join(".gitkeep");
        if !gitkeep.exists() {
            let _ = fs::write(&gitkeep, "");
        }
    }

    Ok(memory_dir.to_string_lossy().to_string())
}
