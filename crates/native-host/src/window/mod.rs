//! 窗口域。
//!
//! 窗口**创建**在原生 UI 域（`ui/platform`）；本模块提供窗口的共享几何常量、
//! 创建后增强与层级提升（经 [`host::WindowPort`]）。
//!
//! 层级数值不在本模块：唯一真值是 [`crate::host::WindowLevel::macos_level`]
//! （`host/mod.rs` 的既有定义）。平台代码（AppKit / Win32）在 [`platform`]，
//! 不再有第二份。

pub mod main_win;
pub mod platform;
pub mod settings;

#[cfg(test)]
pub(crate) mod test_support;

// ==========================================
// 窗口共享常量：主窗口创建与增强（ui/platform、window/main_win）、光标弹窗定位（commands/cursor）与
// 层级提升（window/settings）共用一处，禁止在各自文件里重写数字。
// ==========================================

/// 主窗口默认内尺寸（逻辑像素）；光标弹窗定位的兜底尺寸与其同源。
pub const MAIN_WINDOW_WIDTH: f64 = 730.0;
pub const MAIN_WINDOW_HEIGHT: f64 = 450.0;

/// 主窗口最小内尺寸（逻辑像素）。
pub const MAIN_WINDOW_MIN_WIDTH: f64 = 448.0;
pub const MAIN_WINDOW_MIN_HEIGHT: f64 = 272.0;

/// Windows 光标/屏幕检测的兜底分辨率：取真实显示器信息失败时使用。
#[cfg(target_os = "windows")]
pub const FALLBACK_SCREEN_WIDTH: i32 = 1920;
#[cfg(target_os = "windows")]
pub const FALLBACK_SCREEN_HEIGHT: i32 = 1080;

/// Windows DPI 基准：逻辑坐标 = 物理像素 ÷（dpi ÷ 基准）。
#[cfg(target_os = "windows")]
pub const DPI_BASELINE: u32 = 96;
