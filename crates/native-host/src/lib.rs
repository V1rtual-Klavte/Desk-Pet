//! V1rtual-Desk-Pet 原生宿主。
//!
//! 目标形态：一个不带 Tauri runtime、不带 WebView/Wry 的桌面宿主进程，负责
//! 窗口与绘制、全局快捷键、透明置顶、托盘、系统 API、子进程监督、SQLite 与
//! 最终执行裁决；业务与模型侧代码留在唯一的标准 Node 进程里，经私有 IPC 互通。
//!
//! 设计约定（见 `docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md` §2.2）：
//! - 本 crate 不依赖 Tauri。宿主能力经显式 `HostState` / 端口 trait 注入。
//! - 模块按域落位：`paths` / `memory` / `proactive` / `monitor` / `commands` /
//!   `host` / `ipc` / `ui` / `render` / `images`。
//! - 每个域只保留一个定义点。

// objc 0.2 的 msg_send!/class!/sel! 宏内部引用 `cfg(feature = "cargo-clippy")`，
// 在 destination crate 展开时触发 check-cfg 噪音（monitor 的平台代码），
// 故以 allow 抑制。
#![allow(unexpected_cfgs)]

pub mod audio;
pub mod commands;
pub mod e2e_trace;
pub mod error;
pub mod host;
pub mod images;
pub mod ipc;
pub mod logger;
mod macros;
pub mod memory;
pub mod monitor;
pub mod paths;
pub mod proactive;
pub mod render;
// W5 原生 UI 域（窗口/托盘/快捷键/呼出收回状态机/音效接口）。
pub mod ui;
// W10b 更新域（Native UpdatePort / update.json 契约 / 安装 helper）。
pub mod update;
pub mod window;
