//! 窗口端口的测试替身（`#[cfg(test)]`）：按调用顺序留痕，并按需回放失败。
//!
//! `window/**` 与 `monitor/**` 的单测共用，避免每处重复实现八方法 trait；
//! 只用于断言「端口被按什么顺序、什么参数调用」，不模拟任何平台行为。

use crate::error::{AppError, AppResult};
use crate::host::{WindowId, WindowLevel, WindowPort, WindowVisibility};
use std::sync::Mutex;

/// `WindowPort` 替身：`calls()` 返回逐次调用的 `端口:窗口[:层级]` 留痕。
#[derive(Default)]
pub(crate) struct RecordingWindowPort {
    /// 跨模块用 `..Default::default()` 构造需要本字段可见；读取仍走 `calls()`。
    pub calls: Mutex<Vec<String>>,
    /// 指定窗口的 `set_level` 失败（模拟「窗口不存在 / 调用失败」）。
    pub fail_set_level: Option<WindowId>,
    /// `Some` = `visibility` 读取失败（模拟窗口不存在：契约要求返回错误而非默认值）。
    pub visibility_error: Option<&'static str>,
    /// `visibility` 成功时的回放值。
    pub visibility: WindowVisibility,
}

impl RecordingWindowPort {
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn clear(&self) {
        self.calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn record(&self, call: String) {
        self.calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(call);
    }
}

impl WindowPort for RecordingWindowPort {
    fn show(&self, _window: WindowId, _focus: bool) -> AppResult<()> {
        Ok(())
    }

    fn hide(&self, _window: WindowId) -> AppResult<()> {
        Ok(())
    }

    fn focus(&self, window: WindowId) -> AppResult<()> {
        self.record(format!("focus:{}", window.label()));
        Ok(())
    }

    fn set_level(&self, window: WindowId, level: WindowLevel) -> AppResult<()> {
        if self.fail_set_level == Some(window) {
            return Err(AppError::Tool(format!("窗口不存在: {}", window.label())));
        }
        self.record(format!(
            "set_level:{}:{}",
            window.label(),
            level.macos_level()
        ));
        Ok(())
    }

    fn present(&self, window: WindowId) -> AppResult<()> {
        self.record(format!("present:{}", window.label()));
        Ok(())
    }

    fn visibility(&self, window: WindowId) -> AppResult<WindowVisibility> {
        match self.visibility_error {
            Some(message) => Err(AppError::Other(message.to_string())),
            None => {
                self.record(format!("visibility:{}", window.label()));
                Ok(self.visibility)
            }
        }
    }

    fn set_position(&self, _window: WindowId, _x: i32, _y: i32) -> AppResult<()> {
        Ok(())
    }

    fn open_devtools(&self, _window: WindowId) -> AppResult<()> {
        Ok(())
    }
}
