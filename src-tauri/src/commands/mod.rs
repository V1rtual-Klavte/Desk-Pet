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

pub use cursor::{get_cursor_position, compute_popup_position};
pub use monitor_ctl::{pause_monitor, resume_monitor, set_monitor_config};
pub use sim::{open_windows_sim, close_windows_sim};
pub use logging::{log_message, focus_main};
pub use tool_exec::{
    bash_exec, file_read, file_write, file_list,
    system_info, app_open, clipboard_read, clipboard_write,
};
pub use mcp_bridge::{mcp_spawn, mcp_send, mcp_kill};
pub use memory_cmd::{get_memory_dir, get_memory_file, get_session_file, init_memory_files};
