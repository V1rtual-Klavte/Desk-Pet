// ==========================================
// 窗口模块 —— 创建 & 增强
// ==========================================

mod main_win;
mod settings;

pub use main_win::{create_main_window, enhance_to_iterm_style};
pub use settings::{enhance_layer_editor_window, enhance_settings_window, set_picker_window_level};

// ==========================================
// 窗口共享常量：主窗口创建（main_win）、光标弹窗定位（commands/cursor）与
// 层级提升（settings）共用一处，禁止在各自文件里重写数字。
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

/// macOS 窗口层级（NSWindow level）：主窗口 < 设置 < 图层编辑器。
#[cfg(target_os = "macos")]
pub const WINDOW_LEVEL_MAIN: isize = 1000;
#[cfg(target_os = "macos")]
pub const WINDOW_LEVEL_SETTINGS: isize = 1200;
#[cfg(target_os = "macos")]
pub const WINDOW_LEVEL_LAYER_EDITOR: isize = 1500;

/// 原生取文件对话框期间统一下降到普通层级，避免对话框被桌宠窗口盖住。
#[cfg(target_os = "macos")]
pub const WINDOW_LEVEL_PICKER: isize = 0;
