//! 宿主命令域：transport 无关的普通函数。
//!
//! 设计契约（`docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md` §2.2/§3）：
//! - 每个命令的实现只做参数收窄与既有业务调用，本 crate 不依赖 Tauri；
//! - IPC 层只做参数提取后转发，命令名/参数名保持逐字一致；
//! - IPC 层复用同一批函数，不另写第二份判定。

pub mod bash_policy;
pub mod chat_images;
pub mod cursor;
pub mod font_cmd;
pub mod logging;
pub mod mcp_bridge;
pub mod mcp_credentials;
pub mod mcp_managed;
pub mod memory_cmd;
pub mod monitor_ctl;
pub mod observation_cmd;
pub mod personality_fs_cmd;
pub mod profile_cmd;
pub mod resources_cmd;
pub mod runtime_command;
pub mod screenshot_cmd;
pub mod session_fs;
pub mod skill_cmd;
pub mod tool_exec;
pub mod tool_permit;
