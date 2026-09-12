// ==========================================
// Tauri Commands 统一导出
// ==========================================

pub mod cursor;
pub mod logging;
pub mod mcp_bridge;
pub mod memory_cmd;
pub mod monitor_ctl;
pub mod personality_fs_cmd;
pub mod profile_cmd;
pub mod sim;
pub mod tool_exec;

pub use cursor::{compute_popup_position, get_cursor_position, spawn_cursor_tracker};
pub use logging::{focus_main, log_messages, open_devtools, report_frontend_error, set_log_config};
pub(crate) use mcp_bridge::McpPool;
pub use mcp_bridge::{mcp_kill, mcp_send, mcp_spawn};
pub use memory_cmd::{
    delete_session_file, file_delete, get_memory_file, get_session_file, init_memory_files,
    list_session_files,
};
pub use monitor_ctl::{pause_monitor, resume_monitor, set_monitor_config};
pub use personality_fs_cmd::{
    personality_file_delete, personality_file_list, personality_file_read, personality_file_write,
};
pub use profile_cmd::{
    export_profile_zip, list_profile_files, list_profiles, profile_asset_base, profile_clone,
    profile_delete, profile_file_read, profile_file_write,
};
pub use sim::{close_windows_sim, open_windows_sim};
pub(crate) use tool_exec::BashPool;
pub use tool_exec::{
    app_open, bash_cancel, bash_exec, clipboard_read, clipboard_write, file_canonical_path,
    file_exists, file_info, file_list, file_read, file_read_binary, file_write, system_info,
};
