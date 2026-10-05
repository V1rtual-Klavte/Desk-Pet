//! 窗口层级/呈现的平台实现。
//!
//! [`crate::host::WindowPort`] 的实现只负责取得平台窗口句柄（NSWindow / HWND），
//! 具体 AppKit/Win32 调用都在这里 —— 层级数值的唯一真值是
//! [`crate::host::WindowLevel::macos_level`]，不再有第二份整数。
//!
//! 「设层级」与「呈现窗口」是两个端口方法（[`crate::host::WindowPort::set_level`] /
//! [`crate::host::WindowPort::present`]），这里也分成两组函数：设层级**只改层级**，
//! 呈现（前移/collectionBehavior/激活应用）只做呈现 —— 两者不得压平成一个方法：
//! 压平会让「恢复主窗口层级」顺带把应用抢到前台、图层编辑器前移被丢（已修复）。

#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::host::WindowId;
use crate::host::WindowLevel;

/// macOS：应用窗口层级（`setLevel:`）。**只改层级**，不携带任何呈现副作用 ——
/// collectionBehavior / 前移 / 激活应用都在 [`present_macos_window`]。
///
/// # Safety
/// `ns_window` 必须是由宿主持有、仍然有效的 NSWindow 指针。AppKit 只能在主线程调用：
/// 宿主的端口实现已保证这一点（主线程直接执行，其余线程经 `run_on_main_thread`
/// 派发并等待回执后才返回）。
#[cfg(target_os = "macos")]
pub unsafe fn apply_macos_window_level(ns_window: *mut std::ffi::c_void, level: WindowLevel) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    let ns_win = ns_window as *mut Object;
    let _: () = msg_send![ns_win, setLevel: level.macos_level()];
}

/// macOS：把窗口带到最前。任意窗口 `orderFrontRegardless`；主窗口额外恢复 iTerm
/// 风格呈现（collectionBehavior 六位组合 + 激活本应用）—— 组合逐位沿用既定口径
/// （每位理由见下）。
///
/// # Safety
/// 同 [`apply_macos_window_level`]：`ns_window` 必须是有效 NSWindow，且在主线程调用。
#[cfg(target_os = "macos")]
pub unsafe fn present_macos_window(ns_window: *mut std::ffi::c_void, window: WindowId) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    let ns_win = ns_window as *mut Object;
    let is_main = window == WindowId::Main;
    if is_main {
        // NSWindowCollectionBehavior 位（取值见 AppKit 头文件）：
        //   1<<0  CanJoinAllSpaces          出现在所有普通 Space
        //   1<<8  FullScreenAuxiliary       可随全屏窗口一起显示 —— 缺它时全屏应用会盖住桌宠
        //   1<<18 CanJoinAllApplications    macOS 13+：可加入其它 App 的集合与全屏空间，
        //          「浮动窗口 / 系统浮层」语义，桌宠要的正是它。它与 1<<17 Auxiliary
        //          （About/设置类辅助窗口）互斥，二选一 —— 取 1<<18，不用 1<<17
        //   1<<4  Stationary                不受 Exposé 影响，像桌面窗口一样驻留
        //   1<<5  ParticipatesInCycle      参与窗口轮换
        //   1<<3  Transient                 浮动窗口（与 Stationary 互斥，历史遗留）
        let behavior: usize = (1 << 0) | (1 << 8) | (1 << 18) | (1 << 4) | (1 << 5) | (1 << 3);
        let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
    }
    let _: () = msg_send![ns_win, orderFrontRegardless];
    if is_main {
        // 观测点：层级由 set_level 设置，这里只记呈现完成后的实际状态。
        let level: isize = msg_send![ns_win, level];
        let cb: usize = msg_send![ns_win, collectionBehavior];
        crate::rust_info!("主窗口呈现复位: level={level}，collectionBehavior: {cb:#b}");
        let ns_app: *mut Object = msg_send![objc::class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
    }
}

/// Windows：应用窗口层级。没有等价的「窗口 level」分层，只有 topmost / 非 topmost
/// 两档：Picker 降为普通层级，其余保持置顶。设置窗、图层编辑器与主窗口的层级都走这里。
///
/// # Safety
/// `hwnd` 必须是宿主持有且仍然有效的窗口句柄（调用方须先确认窗口存在）。
#[cfg(target_os = "windows")]
pub unsafe fn apply_windows_window_level(hwnd: isize, level: WindowLevel) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
    };
    let z = if matches!(level, WindowLevel::Picker) {
        HWND_NOTOPMOST
    } else {
        HWND_TOPMOST
    };
    SetWindowPos(hwnd, z, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/// Windows：把窗口带到最前。只有主窗口有层级之外的呈现动作 =
/// `SetWindowPos(HWND_TOPMOST)`；图层编辑器没有额外呈现动作（置顶由 set_level 负责）——
/// 不发明 `SetForegroundWindow` 之类的激活前台调用。
///
/// # Safety
/// 同 [`apply_windows_window_level`]：`hwnd` 必须是宿主持有且仍然有效的窗口句柄。
#[cfg(target_os = "windows")]
pub unsafe fn present_windows_window(hwnd: isize, window: WindowId) {
    if window != WindowId::Main {
        return;
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
    };
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 窗口层级顺序满足两端平台分层口径() {
        // macOS 侧数值直接进 `setLevel:`，必须严格递增才是「层层盖住下层」；
        // Windows 侧只有「Picker 非置顶 / 其余置顶」两档，要求 Picker 与其它变体
        // 可分且是最低档。绝对取值已在 host/mod.rs 的「层级数值与既定常量一致」
        // 逐值钉死，这里只守跨平台依赖的相对顺序，防止换值时次序被颠倒。
        let picker = WindowLevel::Picker.macos_level();
        let main = WindowLevel::Main.macos_level();
        let settings = WindowLevel::Settings.macos_level();
        let editor = WindowLevel::LayerEditor.macos_level();
        assert!(picker < main, "Picker 必须低于主窗口: {picker} !< {main}");
        assert!(
            main < settings,
            "设置窗必须盖住主窗口: {main} !< {settings}"
        );
        assert!(
            settings < editor,
            "编辑器必须高于设置窗: {settings} !< {editor}"
        );
    }
}
