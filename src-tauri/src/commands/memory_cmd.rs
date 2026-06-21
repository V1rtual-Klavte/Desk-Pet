// ==========================================
// 记忆系统命令 —— 文件注册表模式
// 提供 memory/ 和 sessions/ 目录路径创建与读取
// ==========================================
// 目录结构:
//   {appLocalData}/
//     memory/               长期记忆注册表
//       MEMORY.md           ★ 长期记忆索引
//       SESSION_MEMORY.md   ★ 当前会话工作记忆
//       CANDY.md            用户系统指令
//       User.md             用户画像
//       Outside.md          外部知识
//       Project.md          ★ 会话归档指针 → sessions/
//     sessions/             会话归档目录
//       session-xxx.md      完整会话文件
// ==========================================

use std::path::PathBuf;
use tauri::command;
use tauri::Manager;

/// 获取应用 memory/ 目录的绝对路径。
/// ★ 优先使用项目根目录（dev 模式），回退到 app data dir。
#[command]
pub fn get_memory_dir(app: tauri::AppHandle) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let proj_memory = cwd.join("memory");

    if proj_memory.exists() && proj_memory.is_dir() {
        return Ok(proj_memory.to_string_lossy().to_string());
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    let memory_dir = data_dir.join("memory");
    std::fs::create_dir_all(&memory_dir)
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

    // 安全检查：防止路径遍历
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
/// ★ 优先使用项目根目录（dev 模式），回退到 app data dir。
#[command]
pub fn get_session_file(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let proj_sessions = cwd.join("sessions");

    let sessions_dir = if proj_sessions.exists() && proj_sessions.is_dir() {
        proj_sessions
    } else {
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
        let s = data_dir.join("sessions");
        std::fs::create_dir_all(&s)
            .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
        s
    };

    // 安全检查
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

/// 初始化 memory/ 和 sessions/ 目录结构及模板文件。
/// ★ 优先使用项目根目录（dev 模式），回退到 app data dir（打包模式）。
/// 如果文件已存在，不覆盖。
#[command]
pub fn init_memory_files(app: tauri::AppHandle) -> Result<String, String> {
    // ── 检测项目根目录（dev 模式）──
    // cargo 运行时的 current_dir 就是项目根
    let cwd = std::env::current_dir().unwrap_or_default();
    let proj_memory = cwd.join("memory");
    let proj_sessions = cwd.join("sessions");

    let memory_dir = if proj_memory.exists() && proj_memory.is_dir() {
        // Dev 模式: 使用项目根目录的 memory/ + sessions/
        std::fs::create_dir_all(&proj_sessions)
            .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
        proj_memory
    } else {
        // 打包模式: 使用 app data dir
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
        let m = data_dir.join("memory");
        let s = data_dir.join("sessions");
        std::fs::create_dir_all(&m)
            .map_err(|e| format!("无法创建 memory 目录: {}", e))?;
        std::fs::create_dir_all(&s)
            .map_err(|e| format!("无法创建 sessions 目录: {}", e))?;
        m
    };

    // ── 模板文件 ──
    let templates: [(&str, &str); 6] = [
        ("MEMORY.md",
         "# MEMORY.md — 长期记忆注册表索引\n\n\
          > 每条记录指向一个长期记忆文件或独立事实。\n\
          > 格式: `- [日期] [分类] [imp:重要性] 摘要 |file:文件名 |id:UUID`\n\
          > MemoryService 启动时读取，运行时即时写回。\n\n\
          ---\n\n\
          ## 记忆条目\n\n\
          - [2000-01-01] [system] [imp:10] CANDY.md — 用户系统指令 |file:CANDY.md |id:00000000-0000-0000-0000-000000000001\n\
          - [2000-01-01] [user] [imp:9] User.md — 用户画像与偏好 |file:User.md |id:00000000-0000-0000-0000-000000000002\n\
          - [2000-01-01] [reference] [imp:6] Outside.md — 外部知识指针 |file:Outside.md |id:00000000-0000-0000-0000-000000000003\n"),
        ("SESSION_MEMORY.md",
         "# SESSION_MEMORY.md — 会话工作记忆\n\n\
          > 当前活跃会话的短期工作记忆。\n\
          > 归档时内容移至 sessions/<SessionID>.md\n\n\
          > SessionID: \n\
          > 开始: \n\n\
          ## 对话摘要 (0 轮)\n\n\
          ## 记忆指针\n"),
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
          <!-- 格式: - [YYYY-MM-DD] session-xxx.md | N轮 | 主请求: xxx | 关键技术: xxx, xxx -->\n"),
    ];

    for (filename, template) in &templates {
        let file_path = memory_dir.join(filename);
        if !file_path.exists() {
            std::fs::write(&file_path, template)
                .map_err(|e| format!("无法创建 {}: {}", filename, e))?;
        }
    }

    Ok(memory_dir.to_string_lossy().to_string())
}
