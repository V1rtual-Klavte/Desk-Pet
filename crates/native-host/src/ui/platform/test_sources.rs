//! 平台目录的生产源码并集（不含测试模块）。
//!
//! 跨平台源码门禁要在**任意目标**上扫描两平台实现，而 `macos_chat` 等模块本身是
//! `cfg(target_os)` 门控的；把 `include_str!` 清单放在这个平台中立的模块里，
//! 门禁才能在 Windows 上读到 macOS 源码，反之亦然。

use std::sync::OnceLock;

fn concat_once(slot: &'static OnceLock<String>, parts: &[&str]) -> &'static str {
    slot.get_or_init(|| parts.concat())
}

pub(crate) fn macos_chat() -> &'static str {
    static SOURCE: OnceLock<String> = OnceLock::new();
    concat_once(&SOURCE, &[
        include_str!("macos_chat/mod.rs"),
        include_str!("macos_chat/window.rs"),
        include_str!("macos_chat/stack.rs"),
        include_str!("macos_chat/input.rs"),
        include_str!("macos_chat/content/mod.rs"),
        include_str!("macos_chat/content/view.rs"),
        include_str!("macos_chat/content/transcript.rs"),
        include_str!("macos_chat/content/panels.rs"),
    ])
}

pub(crate) fn windows_chat() -> &'static str {
    static SOURCE: OnceLock<String> = OnceLock::new();
    concat_once(&SOURCE, &[
        include_str!("windows_chat/mod.rs"),
        include_str!("windows_chat/window.rs"),
        include_str!("windows_chat/wndproc.rs"),
        include_str!("windows_chat/layout.rs"),
        include_str!("windows_chat/paint.rs"),
        include_str!("windows_chat/transcript.rs"),
        include_str!("windows_chat/panels.rs"),
        include_str!("windows_chat/input.rs"),
        include_str!("windows_chat/dialogs.rs"),
    ])
}

pub(crate) fn macos_settings() -> &'static str {
    static SOURCE: OnceLock<String> = OnceLock::new();
    concat_once(&SOURCE, &[
        include_str!("macos_settings/mod.rs"),
        include_str!("macos_settings/layout.rs"),
        include_str!("macos_settings/controls.rs"),
        include_str!("macos_settings/content/mod.rs"),
        include_str!("macos_settings/content/build.rs"),
        include_str!("macos_settings/content/edit.rs"),
        include_str!("macos_settings/content/document.rs"),
    ])
}

pub(crate) fn windows_settings() -> &'static str {
    static SOURCE: OnceLock<String> = OnceLock::new();
    concat_once(&SOURCE, &[
        include_str!("windows_settings/mod.rs"),
        include_str!("windows_settings/layout.rs"),
        include_str!("windows_settings/render.rs"),
        include_str!("windows_settings/events.rs"),
        include_str!("windows_settings/dialogs.rs"),
    ])
}
