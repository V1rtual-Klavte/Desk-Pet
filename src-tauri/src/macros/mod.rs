// ==========================================
// Rust 端日志宏 —— 只做语法糖，机制在 crate::logger
// ==========================================

#[macro_export]
macro_rules! rust_error {
    ($($arg:tt)*) => { $crate::rust_log!($crate::logger::LEVEL_ERROR, $($arg)*) };
}

#[macro_export]
macro_rules! rust_warn {
    ($($arg:tt)*) => { $crate::rust_log!($crate::logger::LEVEL_WARN, $($arg)*) };
}

#[macro_export]
macro_rules! rust_info {
    ($($arg:tt)*) => { $crate::rust_log!($crate::logger::LEVEL_INFO, $($arg)*) };
}

#[macro_export]
macro_rules! rust_debug {
    ($($arg:tt)*) => { $crate::rust_log!($crate::logger::LEVEL_DEBUG, $($arg)*) };
}

/// 被过滤掉的级别连参数都不展开 —— 高频调用点（光标线程 ~60fps）零成本。
///
/// 用 `$crate::` 而非裸路径：调用点无需再 `use crate::rust_log`。
#[macro_export]
macro_rules! rust_log {
    ($level:expr, $($arg:tt)*) => {{
        let __level: u8 = $level;
        if $crate::logger::level_enabled(__level) {
            $crate::logger::emit(__level, format_args!($($arg)*));
        }
    }};
}
