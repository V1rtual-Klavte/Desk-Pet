// ==========================================
// Tauri Commands 统一导出
// ==========================================

pub mod cursor;
pub mod monitor_ctl;
pub mod sim;
pub mod logging;
pub mod tool_exec;
pub mod mcp_bridge;
pub mod memory_cmd;
pub mod profile_cmd;
pub mod personality_fs_cmd;

pub use cursor::{get_cursor_position, compute_popup_position, spawn_cursor_tracker};
pub use monitor_ctl::{pause_monitor, resume_monitor, set_monitor_config};
pub use sim::{open_windows_sim, close_windows_sim};
pub use logging::{log_message, focus_main, open_devtools};
pub use tool_exec::{
    bash_exec, file_read, file_write, file_list,
    system_info, app_open, clipboard_read, clipboard_write,
};
pub use mcp_bridge::{mcp_spawn, mcp_send, mcp_kill};
pub(crate) use mcp_bridge::McpPool;
pub use memory_cmd::{get_memory_file, get_session_file, init_memory_files, list_session_files, delete_session_file, file_delete};
pub use profile_cmd::{profile_file_write, profile_file_read, profile_delete, list_user_profiles, list_profile_files};
pub use personality_fs_cmd::{personality_file_read, personality_file_write, personality_file_list, personality_file_delete};
