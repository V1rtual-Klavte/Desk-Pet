//! 桌宠主窗口的可见/前台状态，经 [`WindowPort`] 读取。
//!
//! 窗口状态读取走 [`WindowPort`]；端口契约不退化成默认值 —— 读取失败一律按
//! 「不可见/非前台」消费（`unwrap_or(false)` 式语义），由本层还原。

use crate::host::{WindowId, WindowPort};
use crate::rust_debug;

/// 返回 `(is_pet_visible, is_pet_foreground)`。
///
/// 主窗口不存在或状态读取失败 → 视为不可见/非前台（既有消费语义：读不到按
/// `false`）；监控线程据此继续发布采样（锁定/不可用由 `observation_state` 表达，
/// 不因读窗口失败而中断观察流）。失败根因留痕在下方 debug 日志（统一入口
/// `crate::logger`），不静默吞掉。
pub fn pet_visibility(window: &dyn WindowPort) -> (bool, bool) {
    match window.visibility(WindowId::Main) {
        Ok(state) => (state.visible, state.focused),
        Err(error) => {
            rust_debug!("主窗口状态不可读，按不可见/非前台处理: {error}");
            (false, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::WindowVisibility;
    use crate::window::test_support::RecordingWindowPort;

    #[test]
    fn 主窗口可见与聚焦状态原样透出() {
        let port = RecordingWindowPort {
            visibility: WindowVisibility {
                visible: true,
                focused: true,
                minimized: false,
            },
            ..Default::default()
        };
        assert_eq!(pet_visibility(&port), (true, true));
        // 只读主窗口：可见性门禁的作用对象是主窗口，不是任意窗口。
        assert_eq!(port.calls(), vec!["visibility:main".to_string()]);
    }

    #[test]
    fn 窗口状态读取失败按不可见非前台消费() {
        let port = RecordingWindowPort {
            visibility_error: Some("窗口不存在"),
            ..Default::default()
        };
        // 读不到按不可见/非前台（`unwrap_or(false)` 式消费语义）：观察流不中断，
        // 锁定/不可用状态由 observationState 表达。
        assert_eq!(pet_visibility(&port), (false, false));
    }
}
