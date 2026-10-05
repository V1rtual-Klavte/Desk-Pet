//! 系统剪贴板写入（原生 UI 自身的用户动作专用）。
//!
//! 归属：UI 的「复制」类按钮（编辑器素材提示词、聊天详情、设置页 Card 模版）
//! 直接走**系统原语**，不经 Node 的 IPC 命令面 —— `commands/tool_exec/desktop.rs`
//! 的 `clipboard_write` 是给模型工具用的另一条路（经分派器调用，Windows 侧以
//! PowerShell 子进程实现）；两条路不合并：UI 复制不为一次点击拉起子进程
//! （控制台闪烁与几百毫秒延迟都不可接受）。
//!
//! 平台契约（对称差异就地注明）：
//! - macOS：NSPasteboard（`clearContents` + `setString:forType:`）；
//! - Windows：`OpenClipboard` / `EmptyClipboard` / `GlobalAlloc(GMEM_MOVEABLE)` /
//!   `SetClipboardData(CF_UNICODETEXT=13)`，UTF-16 + NUL 结尾；
//! - 两平台之外的 target：不引用任何平台 API，`write_text` 如实返回 `false`
//!   （产品只支持 macOS/Windows，见 native-host AGENTS §2；不 panic、不假装成功）。
//!
//! **签名刻意不对称**：Windows 必须显式传 `owner`（本任务的窗口），macOS 只要文本。
//! 原因不是风格而是正确性：MSDN `SetClipboardData` 备注——「If an application calls
//! OpenClipboard with hwnd set to NULL, EmptyClipboard sets the clipboard owner to
//! NULL; this causes SetClipboardData to fail.」即丢掉 owner 会让写入**真的失败**，
//! 不是可选参数；而 NSPasteboard 根本没有所有者概念。两边的调用点本来就在各自平台
//! 文件里（`platform/macos_*.rs` / `platform/windows_*.rs`），不存在同时面向两平台的
//! 调用方，不做「两边都不顺手」的假统一签名（AGENTS §9 同口径）。
//!
//! 失败一律以返回值 `false` 上报（不 panic、不吞）：调用点各自 `rust_warn!` 留痕，
//! 本模块不另建日志出口。

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;

/// 把纯文本写进系统剪贴板（macOS：NSPasteboard）；成功/失败如实返回。
///
/// 覆盖式写入：先 `clearContents` 清掉旧内容（不清会叠加旧格式），再放纯文本类型。
#[cfg(target_os = "macos")]
pub fn write_text(text: &str) -> bool {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    // SAFETY: NSPasteboardTypeString 是 AppKit 的常量 extern static（系统提供，只读）。
    let string_type = unsafe { NSPasteboardTypeString };
    pasteboard.setString_forType(&NSString::from_str(text), string_type)
}

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{GlobalFree, HWND};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

/// 剪贴板文本的 UTF-16 单元序列（NUL 结尾）。
///
/// 纯函数，不调系统 API。**不挂 `#[cfg(target_os = "windows")]`**：挂上就只能在
/// Windows 上编译、单测也跟着只在 Windows CI 跑；这里用 `test` 条件让 macOS 开发机
/// 的 `cargo test` 也能把它编译出来并钉住（本机编不出 Windows 分支，见 AGENTS §2）。
#[cfg(any(target_os = "windows", test))]
fn utf16_units(text: &str) -> Vec<u16> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    // 剪贴板文本要求 NUL 结尾（不含结尾符的缓冲区在别的程序里会读越界/截断）。
    units.push(0);
    units
}

/// 把纯文本写进系统剪贴板（Windows：OpenClipboard + CF_UNICODETEXT）；成功/失败如实返回。
///
/// `owner` 必须是**本任务的窗口**：`OpenClipboard(NULL)` 之后 `EmptyClipboard` 会把
/// 剪贴板所有者置空，`SetClipboardData` 随即失败（见模块头引的 MSDN 备注）——
/// 所以这个参数不能省。调用点都在自己窗口的消息过程里，天然有 hwnd 可传。
#[cfg(target_os = "windows")]
pub fn write_text(owner: HWND, text: &str) -> bool {
    // CF_UNICODETEXT（13）：windows-sys 0.52 只在 Win32_System_Ole 面登记该常量
    // （winuser.h 的裁剪格式号）。本模块只要这一个格式号，不为它开整个 Ole feature，
    // 就地定义（与 `windows_chat.rs` 的既有做法一致）。
    const CF_UNICODETEXT: u32 = 13;

    if unsafe { OpenClipboard(owner) } == 0 {
        return false;
    }
    let mut ok = false;
    unsafe {
        // 先清掉旧内容：打开剪贴板后、放入新格式前必须清空（否则旧格式残留）。
        EmptyClipboard();
        let utf16 = utf16_units(text);
        let handle = GlobalAlloc(GMEM_MOVEABLE, utf16.len() * std::mem::size_of::<u16>());
        if !handle.is_null() {
            let target = GlobalLock(handle) as *mut u16;
            if !target.is_null() {
                std::ptr::copy_nonoverlapping(utf16.as_ptr(), target, utf16.len());
                // 关剪贴板前必须先解锁（文档要求；锁着交给系统会留下未定义状态）。
                GlobalUnlock(handle);
                // 成功后内存归剪贴板所有（系统负责释放）；失败时仍归我们，须自己释放。
                if SetClipboardData(CF_UNICODETEXT, handle as isize) == 0 {
                    let _ = GlobalFree(handle);
                } else {
                    ok = true;
                }
            } else {
                let _ = GlobalFree(handle);
            }
        }
        CloseClipboard();
    }
    ok
}

/// 两平台之外的 target：如实返回失败（不 panic、不假装成功，见模块头）。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn write_text(_text: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编码缓冲（纯函数）钉住：UTF-16 单元数 + NUL 结尾 + 非 BMP 码点按代理对。
    ///
    /// `write_text` 真调系统剪贴板、会**污染用户剪贴板**，不做单测（这条只测纯函数；
    /// 平台调用由各平台实测与 CI 覆盖）。
    #[test]
    fn utf16_缓冲以_nul_结尾且代理对正确() {
        assert_eq!(utf16_units("ab"), vec![0x0061, 0x0062, 0], "ASCII 单元 + NUL");
        // 中文字符单单元：'糖' = U+7CD6。
        assert_eq!(utf16_units("糖"), vec![0x7CD6, 0]);
        // 非 BMP 码点（😀 = U+1F600）按代理对占两个 u16 单元。
        assert_eq!(utf16_units("😀"), vec![0xD83D, 0xDE00, 0]);
        // 空串也必须是「一个 NUL」，不能是空缓冲。
        assert_eq!(utf16_units(""), vec![0]);
        // 字节数口径 = 单元数 × 2（GlobalAlloc 的 dwBytes 就是这么算的）。
        assert_eq!(utf16_units("ab").len() * std::mem::size_of::<u16>(), 6);
    }
}
