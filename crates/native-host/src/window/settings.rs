//! 设置窗口 / 图层编辑器 窗口层级提升。
//!
//! 平台差异经 [`WindowPort::set_level`]（层级）与 [`WindowPort::present`]（呈现）
//! 落到 [`crate::window::platform`]：macOS 是 `setLevel:` / 前移与激活，Windows 是
//! topmost / 非 topmost 两档。

use crate::error::AppResult;
use crate::host::{WindowId, WindowLevel, WindowPort};
use crate::rust_debug;

/// 提升设置窗口层级，确保浮动在主窗口之上，并置前取 key。
///
/// 三步顺序固定为（macOS 分支）：
/// `setLevel(1200)` → `orderFrontRegardless` → `makeKeyAndOrderFront`。
/// 端口上依次是 `set_level` + `present` + `focus`：
/// - `set_level` 只改层级（主窗 1000 之上、图层编辑器 1500 之下）；
/// - `present` 对**非主窗口**只做 `orderFrontRegardless`，不设 collectionBehavior、
///   不激活应用 —— 这正是设置窗要的，且不会引入 F1 那类抢前台副作用；
/// - `focus` 承担 macOS 的 `makeKeyAndOrderFront` / Windows 的 `SetForegroundWindow`。
///
/// **已知差异（登记在原生宿主迁移过程记录 §9.5）**：本端口 `focus` 的平台实现等价于
/// `makeKeyAndOrderFront` **外加一次** `activateIgnoringOtherApps`，即比三步序列
/// 多一次应用激活。方向一致（都是把设置窗推到最前），未实机对比观感。
///
/// Windows：两个 topmost 窗口之间的前后顺序由激活决定，`set_level` 保持置顶、
/// `focus` 显式置于前台（见 `window/mod.rs` 的层级口径）；`present` 对非主窗不动作。
pub fn enhance_settings_window(port: &dyn WindowPort) -> AppResult<()> {
    port.set_level(WindowId::Settings, WindowLevel::Settings)?;
    port.present(WindowId::Settings)?;
    port.focus(WindowId::Settings)
}

/// 取文件期间临时降级窗口层级。
///
/// 主窗口在 1000、设置 1200、图层编辑器 1500，为的是层层盖住下层；而原生文件
/// 对话框（macOS 的 NSOpenPanel / Windows 的通用对话框）在**普通层级**，会被
/// 它们整个盖住导致完全无法操作。打开对话框前降级、选完恢复。
///
/// 恢复阶段也只走 `set_level` —— 不调用 `present`：恢复主窗层级不得顺带前移/激活
/// 把应用抢到前台（F1 修复点：该副作用不得由「设层级」顺带触发）。
///
/// 三个窗口逐个处理：某个窗口不存在（未打开、或设置窗已关而编辑器仍开着）或层级
/// 设置失败只跳过它，不阻塞其余窗口（不存在的窗口不算错误）；
/// 失败留痕在 debug 级别，不改变调用方结果。
pub fn set_picker_window_level(port: &dyn WindowPort, picking: bool) -> AppResult<()> {
    let levels = [
        (WindowId::Main, WindowLevel::Main),
        (WindowId::Settings, WindowLevel::Settings),
        (WindowId::LayerEditor, WindowLevel::LayerEditor),
    ];
    for (window, restored) in levels {
        let level = if picking {
            WindowLevel::Picker
        } else {
            restored
        };
        if let Err(error) = port.set_level(window, level) {
            rust_debug!("窗口层级设置跳过 {}: {error}", window.label());
        }
    }
    Ok(())
}

/// 提升图层编辑器窗口层级 — 高于设置窗口。
///
/// macOS：`setLevel(1500)` 后还要 `orderFrontRegardless`（顺序固定），端口上是
/// `set_level` + `present`；Windows：`set_level` 置顶（该分支只有这一个 SetWindowPos），
/// `present` 对非主窗口不额外动作。
pub fn enhance_layer_editor_window(port: &dyn WindowPort) -> AppResult<()> {
    port.set_level(WindowId::LayerEditor, WindowLevel::LayerEditor)?;
    port.present(WindowId::LayerEditor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::test_support::RecordingWindowPort;

    #[test]
    fn 设置窗增强顺序为层级呈现聚焦() {
        let port = RecordingWindowPort::default();
        enhance_settings_window(&port).unwrap();
        // 三步顺序固定：先升层级、再呈现（不激活应用）、最后聚焦取 key。
        assert_eq!(
            port.calls(),
            vec![
                "set_level:settings:1200".to_string(),
                "present:settings".to_string(),
                "focus:settings".to_string(),
            ],
        );
    }

    #[test]
    fn 图层编辑器增强不聚焦不抢前台() {
        let port = RecordingWindowPort::default();
        enhance_layer_editor_window(&port).unwrap();
        assert_eq!(
            port.calls(),
            vec![
                "set_level:layer-editor:1500".to_string(),
                "present:layer-editor".to_string(),
            ],
            "编辑器增强不得带 focus（避免应用整体抢前台）",
        );
    }

    #[test]
    fn 取文件期间三窗口降到普通层级再各自恢复() {
        let port = RecordingWindowPort::default();
        set_picker_window_level(&port, true).unwrap();
        assert_eq!(
            port.calls(),
            vec![
                "set_level:main:0".to_string(),
                "set_level:settings:0".to_string(),
                "set_level:layer-editor:0".to_string(),
            ],
            "打开对话框前三个窗口都降到 Picker 层级",
        );
        port.clear();
        set_picker_window_level(&port, false).unwrap();
        assert_eq!(
            port.calls(),
            vec![
                "set_level:main:1000".to_string(),
                "set_level:settings:1200".to_string(),
                "set_level:layer-editor:1500".to_string(),
            ],
            "恢复阶段只设层级回各自档位",
        );
    }

    #[test]
    fn 单个窗口设层级失败不阻塞其余窗口() {
        let port = RecordingWindowPort {
            fail_set_level: Some(WindowId::Settings),
            ..Default::default()
        };
        // 窗口不存在或设置失败只跳过该窗口：整体不报错，其余窗口照常降级。
        set_picker_window_level(&port, true).unwrap();
        assert_eq!(
            port.calls(),
            vec![
                "set_level:main:0".to_string(),
                "set_level:layer-editor:0".to_string(),
            ],
            "失败的设置窗被跳过，其余窗口照常处理",
        );
    }
}
