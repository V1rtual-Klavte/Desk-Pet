// ==========================================
// 记忆目录初始化
// ==========================================
// 数据根布局:
//   {data_root}/
//     memory/               长期记忆数据目录
//       memory.sqlite3      ★ 已接受记忆、来源与治理决定的真相源（Rust 管理）
//       V1RTUAL.md          用户手写系统指令（人工入口，不是记忆数据）
//       exports/            只读 Markdown 投影
//       backups/            一致性备份
//     sessions/             会话 JSONL 存储（JsonlSessionRepo 经通用文件命令读写）
//
// 旧的 MEMORY.md / User.md / Outside.md / Project.md 注册表不再创建、不再读取：
// 记忆主路径已换成 SQLite。用户磁盘上的旧文件保持原样，由用户自行决定是否清理。
// ==========================================

use crate::error::AppResult;
use crate::paths::AppPaths;
use std::fs;

const V1RTUAL_TEMPLATE: &str = "# V1RTUAL.md — 用户系统指令\n\n\
    > 此文件中的指令会作为 System Prompt 的一部分注入。\n\
    > 你可以在此写入对桌宠的行为要求。\n\n\
    ---\n\n\
    ## 指令\n\n\
    <!-- 在此添加你的自定义指令，例如：叫我小明、用日语回复、喜欢简短回答等 -->\n\
    ";

/// 初始化 memory/ 与 sessions/ 目录与 V1RTUAL.md 种子。
/// 数据库由 Rust 的 MemoryStore 在启动时建表，这里不重复建库。
pub fn init_memory_files(paths: &AppPaths) -> AppResult<String> {
    let memory_dir = &paths.memory;
    fs::create_dir_all(&paths.sessions).map_err(|e| format!("无法创建 sessions 目录: {e}"))?;
    fs::create_dir_all(memory_dir).map_err(|e| format!("无法创建 memory 目录: {e}"))?;

    let v1rtual = memory_dir.join("V1RTUAL.md");
    if !v1rtual.exists() {
        fs::write(&v1rtual, V1RTUAL_TEMPLATE).map_err(|e| format!("无法创建 V1RTUAL.md: {e}"))?;
    }

    if cfg!(debug_assertions) {
        let gitkeep = paths.sessions.join(".gitkeep");
        if !gitkeep.exists() {
            let _ = fs::write(&gitkeep, "");
        }
    }

    Ok(memory_dir.to_string_lossy().to_string())
}
