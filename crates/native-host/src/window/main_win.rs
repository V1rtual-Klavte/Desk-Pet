//! 主窗口增强。
//!
//! 窗口**创建**在原生 UI 域（`ui/platform`）；本模块只保留创建后的增强入口。
//! 平台实现（NSWindow level/collectionBehavior、Win32 SetWindowPos）在
//! [`crate::window::platform`]，经 [`WindowPort::set_level`] 与
//! [`WindowPort::present`] 到达，不再有第二份。

use crate::error::AppResult;
use crate::host::{WindowId, WindowLevel, WindowPort};

/// 窗口增强：最高层级 + 全屏悬浮 + 所有桌面（双端）。
///
/// 层级走 `set_level`、呈现（macOS 的 collectionBehavior/前移/激活，Windows 主窗口的
/// 置顶前移）走 `present`；本函数只声明「主窗口回到自身层级并重新呈现」这一事实。
pub fn enhance_to_iterm_style(port: &dyn WindowPort) -> AppResult<()> {
    port.set_level(WindowId::Main, WindowLevel::Main)?;
    port.present(WindowId::Main)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::test_support::RecordingWindowPort;

    #[test]
    fn 主窗口增强先回升层级再重新呈现() {
        let port = RecordingWindowPort::default();
        enhance_to_iterm_style(&port).unwrap();
        assert_eq!(
            port.calls(),
            vec![
                "set_level:main:1000".to_string(),
                "present:main".to_string(),
            ],
            "设层级与呈现是两个独立端口动作，顺序不可压平",
        );
    }
}
