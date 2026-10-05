//! 平台层入口（AppKit / Win32）。
//!
//! `ui/mod.rs` 只依赖本模块的 `imp` 别名；两个平台文件各自提供同名函数
//! （`run_service`、`window_*`、`open_aux_window`、`close_window`、
//! `set_popup_placement`、`apply_global_shortcut`）。平台代码只在新平台接入时
//! 新增一个模块，不在业务侧写 `cfg` 分支。

use std::sync::OnceLock;
use std::time::Instant;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

// W8a 聊天与查看器内容（与 W5 主平台文件分开：聊天控件自成一份栈；
// W5 的 macos.rs / windows.rs 只留窗口/托盘/快捷键与呼出收回）。
// W9a 起聊天面板挂在主窗内（`mount_main_pane`），独立聊天窗只作为能力保留。
#[cfg(target_os = "macos")]
pub(crate) mod macos_chat;
#[cfg(target_os = "windows")]
pub(crate) mod windows_chat;

// W9a：主窗一体布局（舞台 + 聊天列）、设置窗与编辑器窗内容、控件小工具。
#[cfg(target_os = "macos")]
pub(crate) mod macos_editor;
#[cfg(target_os = "macos")]
pub(crate) mod macos_main;
#[cfg(target_os = "macos")]
pub(crate) mod macos_settings;
#[cfg(target_os = "macos")]
pub(crate) mod macos_widgets;
#[cfg(target_os = "windows")]
pub(crate) mod windows_editor;
#[cfg(target_os = "windows")]
pub(crate) mod windows_main;
#[cfg(target_os = "windows")]
pub(crate) mod windows_settings;

#[cfg(target_os = "macos")]
pub(crate) use macos as imp;
#[cfg(target_os = "windows")]
pub(crate) use windows as imp;

/// 聊天窗的平台实现别名（`ui/chat` 只依赖这一个名字，不在业务侧写 cfg）。
#[cfg(target_os = "macos")]
pub(crate) use macos_chat as chat_imp;
#[cfg(target_os = "windows")]
pub(crate) use windows_chat as chat_imp;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("原生 UI 只支持 macOS 与 Windows（执行契约只承诺这两个平台）");

/// 单调毫秒时钟（进程内唯一基准；状态机与动画共用）。
///
/// 放在平台无关处：动画推进只依赖单调性，具体取值由平台驱动调用。
pub(crate) fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}
