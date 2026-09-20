// ==========================================
// Tauri Commands 统一导出
// ==========================================

pub mod app_lifecycle;
pub mod bash_policy;
pub mod cursor;
pub mod logging;
pub mod mcp_bridge;
pub mod memory_cmd;
pub mod monitor_ctl;
pub mod personality_fs_cmd;
pub mod profile_cmd;
pub mod resources_cmd;
pub mod sim;
pub mod skill_cmd;
pub mod tool_exec;
pub mod tool_permit;

pub use app_lifecycle::app_restart;
pub use cursor::{compute_popup_position, get_cursor_position, spawn_cursor_tracker};
pub use logging::{log_messages, open_devtools, report_frontend_error, set_log_config};
pub(crate) use mcp_bridge::McpPool;
pub use mcp_bridge::{mcp_kill, mcp_send, mcp_spawn};
pub use memory_cmd::init_memory_files;
pub use monitor_ctl::{pause_monitor, resume_monitor, set_monitor_config};
pub use personality_fs_cmd::{
    personality_file_list, personality_file_read, personality_file_write,
};
pub use profile_cmd::{
    export_profile_zip, list_profile_files, list_profiles, profile_asset_base, profile_clone,
    profile_delete, profile_file_read, profile_file_write,
};
pub use resources_cmd::{restore_default_resources, skill_delete};
pub use skill_cmd::skill_list_metadata;
pub use sim::{close_windows_sim, open_windows_sim};
pub(crate) use tool_exec::BashPool;
pub use tool_exec::{
    app_open, bash_cancel, bash_exec, clipboard_read, clipboard_write, dir_create, file_append,
    file_canonical_path, file_exists, file_info, file_list, file_read, file_read_binary,
    file_remove, file_rename, file_write, system_info,
};
// 应用级工具执行许可所有者（§5.1）：前端借用/释放，Rust 持有额度。
pub(crate) use tool_permit::ToolPermitPool;
pub use tool_permit::{
    tool_permit_acquire, tool_permit_cancel, tool_permit_release, tool_permit_set_max_shared_readers,
    tool_permit_snapshot,
};
