// ==========================================
// 记忆系统命令 —— 文件注册表 + 会话文件管理
// ==========================================
// 目录结构:
//   {appLocalData}/
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
use tauri::Manager;

/// ★ 从 cwd 向上查找包含 memory/ 目录的项目根（dev 模式）
fn find_project_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    // 最多往上查 5 层
    for _ in 0..5 {
        let memory = dir.join("memory");
        if memory.exists() && memory.is_dir() {
            return Some(dir);
        }
        if !dir.pop() { break; }
    }
    None
}

/// 获取应用 memory/ 目录的绝对路径。
/// ★ 优先使用项目根目录（dev 模式），回退到 app data dir。
#[command]
pub fn get_memory_dir(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(proj_root) = find_project_root() {
        let proj_memory = proj_root.join("memory");
        if proj_memory.exists() && proj_memory.is_dir() {
            return Ok(proj_memory.to_string_lossy().to_string());
        }
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    let memory_dir = data_dir.join("memory");
    fs::create_dir_all(&memory_dir)
        .map_err(|e| format!("无法创建 memory 目录: {}", e))?;

    Ok(memory_dir.to_string_lossy().to_string())
}

/// 获取 memory/ 目录下指定文件的完整路径。
#[command]
pub fn get_memory_file(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    let memory_dir = data_dir.join("memory");

    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效文件名: {}", filename))?;

    if safe_name.contains("..") || safe_name.contains('/') || safe_name.contains('\\') {
        return Err(format!("非法文件名: {}", safe_name));
    }

    let file_path = memory_dir.join(&safe_name);
    Ok(file_path.to_string_lossy().to_string())
}

/// 获取 sessions/ 目录下指定文件的完整路径。
#[command]
pub fn get_session_file(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let sessions_dir = resolve_sessions_dir(&app)?;

    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效文件名: {}", filename))?;

    if safe_name.contains("..") || safe_name.contains('/') || safe_name.contains('\\') {
        return Err(format!("非法文件名: {}", safe_name));
    }

    let file_path = sessions_dir.join(&safe_name);
    Ok(file_path.to_string_lossy().to_string())
}

/// 解析 sessions/ 目录路径
fn resolve_sessions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(proj_root) = find_project_root() {
        let proj_sessions = proj_root.join("sessions");
        fs::create_dir_all(&proj_sessions).ok();
        return Ok(proj_sessions);
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let s = data_dir.join("sessions");
    fs::create_dir_all(&s)
        .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
    Ok(s)
}

/// ★ 列出 sessions/ 目录下所有 .md 文件（按名称倒序）
#[command]
pub fn list_session_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let sessions_dir = resolve_sessions_dir(&app)?;

    let mut files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
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
pub fn delete_session_file(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let sessions_dir = resolve_sessions_dir(&app)?;
    println!("[Rust] delete_session_file: {} | dir: {}", filename, sessions_dir.display());

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

    let file_path = sessions_dir.join(&safe_name);
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("删除失败: {}", e))?;
    }

    Ok(())
}

/// ★ 删除任意文件（用于 file_delete 工具 + 重命名清理）
#[command]
pub fn file_delete(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(()); // 文件不存在不算错误
    }
    // 安全检查：只允许在 memory/ 或 sessions/ 目录下删除
    let path_str = p.to_string_lossy().to_string();
    if !path_str.contains("/memory/") && !path_str.contains("/sessions/")
        && !path_str.contains("\\memory\\") && !path_str.contains("\\sessions\\") {
        return Err(format!("安全限制: 只能在 memory/ 或 sessions/ 目录下删除文件"));
    }
    fs::remove_file(&p)
        .map_err(|e| format!("删除失败: {}", e))
}

/// 初始化 memory/ 和 sessions/ 目录结构及模板文件。
/// ★ 优先使用项目根目录（dev 模式），回退到 app data dir。
/// 模板使用新的 MEMORY.md 双块结构。
#[command]
pub fn init_memory_files(app: tauri::AppHandle) -> Result<String, String> {
    let memory_dir = if let Some(proj_root) = find_project_root() {
        let m = proj_root.join("memory");
        let s = proj_root.join("sessions");
        fs::create_dir_all(&s)
            .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
        m
    } else {
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
        let m = data_dir.join("memory");
        let s = data_dir.join("sessions");
        fs::create_dir_all(&m)
            .map_err(|e| format!("无法创建 memory 目录: {}", e))?;
        fs::create_dir_all(&s)
            .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
        m
    };

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
    if let Some(proj_root) = find_project_root() {
        let gitkeep = proj_root.join("sessions").join(".gitkeep");
        if !gitkeep.exists() {
            let _ = fs::write(&gitkeep, "");
        }
    }

    Ok(memory_dir.to_string_lossy().to_string())
}
