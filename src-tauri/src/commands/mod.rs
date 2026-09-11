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
pub use logging::{log_messages, set_log_config, report_frontend_error, focus_main, open_devtools};
pub use tool_exec::{
    bash_exec, bash_cancel, file_read, file_read_binary, file_write, file_list,
    file_info, file_exists, file_canonical_path,
    system_info, app_open, clipboard_read, clipboard_write,
};
pub(crate) use tool_exec::BashPool;
pub use mcp_bridge::{mcp_spawn, mcp_send, mcp_kill};
pub(crate) use mcp_bridge::McpPool;
pub use memory_cmd::{get_memory_file, get_session_file, init_memory_files, list_session_files, delete_session_file, file_delete};
pub use profile_cmd::{profile_file_write, profile_file_read, profile_delete, profile_clone, export_profile_zip, profile_asset_base, profile_user_asset_base, list_user_profiles, list_profile_files};
pub use personality_fs_cmd::{personality_file_read, personality_file_write, personality_file_list, personality_file_delete};
