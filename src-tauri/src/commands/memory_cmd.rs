// ==========================================
// 记忆系统命令 —— memory/ 与 sessions/ 目录初始化
// ==========================================
// 目录结构:
//   {data_root}/
//     memory/               长期记忆注册表
//       MEMORY.md           ★ 结构化注册表（系统块 + 记忆块）
//       CANDY.md            用户系统指令
//       User.md             用户画像
//       Outside.md          外部知识
//       Project.md          会话归档指针（旧归档链路的只读残留）
//     sessions/             会话 JSONL 存储（JsonlSessionRepo 经通用文件命令读写）
// ==========================================

use crate::error::AppResult;
use crate::paths::AppPaths;
use std::fs;
use tauri::command;

/// 初始化 memory/ 和 sessions/ 目录结构及模板文件。
/// 使用 AppPaths 统一路径管理。模板使用 MEMORY.md 双块结构。
#[command]
pub fn init_memory_files(paths: tauri::State<AppPaths>) -> AppResult<String> {
    let memory_dir = &paths.memory;
    let sessions_dir = &paths.sessions;

    // 确保 sessions/ 目录存在
    fs::create_dir_all(sessions_dir).map_err(|e| format!("无法创建 sessions 目录: {}", e))?;

    // ── 模板文件（MEMORY.md 双块结构，无 SESSION_MEMORY.md）──
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
            fs::write(&file_path, template).map_err(|e| format!("无法创建 {}: {}", filename, e))?;
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
