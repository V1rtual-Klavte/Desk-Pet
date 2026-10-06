//! 单实例守卫（同一数据根只允许一个宿主进程）。
//!
//! 多开会得到两个托盘图标、两套 Node/子进程，并对同一数据根并发写入
//! （SQLite / 日志 / CONFIG / 更新暂存）——第二个实例必须被拒绝。锁的作用域是
//! **数据根**：dev 与 release 的数据根不同、可并存互不干扰（E2E 走独立分支，
//! 不经过本模块）。
//!
//! 机制：`{data_root}/.instance.lock` 上的一把 OS 级独占锁（macOS：`open(O_EXLOCK)`
//! 的 flock；Windows：`CreateFileW(dwShareMode=0)` 独占打开）。进程退出（含崩溃）
//! 由 OS 自动释放，没有陈旧锁问题。锁文件**永不删除**：删除会引入 unlink 竞争
//! （A 退出删文件时 B 仍持有旧 fd，C 新建同名文件后与 B 各持一把"锁"）；文件
//! 内容无意义，只有锁有意义。
//!
//! 无法判定（权限/文件系统异常）时返回 `Unavailable`：不把用户锁在门外，
//! 调用方留痕后继续启动。

use std::path::Path;

use crate::rust_warn;

/// 实例守卫：持有成功获得的锁，直到 drop（进程退出时由 OS 释放）。
///
/// 调用方必须让它在整个进程生命周期内存活（`main::run` 的运行栈上持有）。
#[derive(Debug)]
pub struct InstanceGuard {
    /// 平台句柄：macOS 是持 flock 的 `File`；Windows 是独占打开的句柄。
    _handle: HeldHandle,
}

#[cfg(target_os = "macos")]
type HeldHandle = std::fs::File;
#[cfg(target_os = "windows")]
type HeldHandle = std::os::windows::io::OwnedHandle;

/// 获取结果三态。
#[derive(Debug)]
pub enum AcquireOutcome {
    /// 拿到锁（守卫须在进程生命周期内存活）。
    Acquired(InstanceGuard),
    /// 已有实例持有锁（后启动者据此拒绝并退出）。
    AlreadyRunning,
    /// 无法判定（权限/文件系统异常）：调用方留痕后继续启动。
    Unavailable(String),
}

#[cfg(target_os = "macos")]
pub fn acquire(lock_path: &Path) -> AcquireOutcome {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    // O_EXLOCK：open 时原子地取 flock 独占锁；O_NONBLOCK：锁被占时不等待、
    // 直接返回 EWOULDBLOCK —— 正好用来区分「已有实例」。
    let opened = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .custom_flags(libc::O_EXLOCK | libc::O_NONBLOCK)
        .open(lock_path);
    match opened {
        Ok(file) => AcquireOutcome::Acquired(InstanceGuard { _handle: file }),
        Err(error) => {
            if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                return AcquireOutcome::AlreadyRunning;
            }
            AcquireOutcome::Unavailable(format!("获取实例锁失败（{}）: {error}", lock_path.display()))
        }
    }
}

#[cfg(target_os = "windows")]
pub fn acquire(lock_path: &Path) -> AcquireOutcome {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_SHARING_VIOLATION, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_ALWAYS,
    };

    let wide: Vec<u16> = lock_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // dwShareMode=0：独占打开，第二个进程拿 ERROR_SHARING_VIOLATION。与 macOS 的 flock
    // 语义一致（进程退出即释放），且不需要额外维护解锁路径。
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) {
            return AcquireOutcome::AlreadyRunning;
        }
        return AcquireOutcome::Unavailable(format!("获取实例锁失败（{}）: {error}", lock_path.display()));
    }
    // SAFETY: CreateFileW 返回的是本进程新持有的有效句柄；所有权交给 OwnedHandle，drop 即关闭。
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as *mut std::ffi::c_void) };
    AcquireOutcome::Acquired(InstanceGuard { _handle: owned })
}

/// 「已在运行」的用户可见提示（后启动实例在退出前的唯一 UI）。
///
/// macOS 经统一模态入口 `run_modal_alert`（源码级守门测试要求全部 NSAlert 模态走它；
/// 启动早期三个拾取窗并不存在，降层守卫只是 debug 级 no-op）。Windows 用 MessageBoxW。
#[cfg(target_os = "macos")]
pub fn notify_already_running() {
    use objc2::msg_send;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSApplication, NSApplicationActivationPolicy};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("「已在运行」提示只能在主线程弹窗，跳过（拒绝原因已写日志）");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // 启动早期还没有任何窗口；Accessory 策略下这样的进程很难被系统激活，弹窗会落在
    // 其它应用窗口后面。为了「拒绝提示必须看得见」，这里临时切 Regular（本进程随即
    // 退出，Dock 图标一闪即逝）——真正的产品 UI 仍在 UI 域按 Accessory 装配。
    let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("V1rtual-Desk-Pet 已在运行"));
    alert.setInformativeText(&NSString::from_str(
        "同一个数据目录只允许运行一个实例。请使用已经在运行的那个（可从菜单栏的托盘图标打开）。",
    ));
    alert.addButtonWithTitle(&NSString::from_str("好"));
    // 先把弹窗挂出来，再请求激活（沿用既有口径的 `activateIgnoringOtherApps:`，
    // macos.rs 的同一序列）：有窗口的激活请求才会把弹窗带到前台。
    alert.window().makeKeyAndOrderFront(None);
    let _: () = unsafe { msg_send![&*app, activateIgnoringOtherApps: true] };
    let _ = crate::ui::platform::macos_widgets::run_modal_alert(&alert);
}

#[cfg(target_os = "windows")]
pub fn notify_already_running() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_TOPMOST,
    };
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let title = wide("V1rtual-Desk-Pet");
    let message = wide(
        "V1rtual-Desk-Pet 已在运行。\n\n同一个数据目录只允许运行一个实例；请使用已经在运行的那个（可从托盘图标打开）。",
    );
    unsafe {
        MessageBoxW(0, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("单实例守卫只支持 macOS 与 Windows（执行契约只承诺这两个平台）");

#[cfg(test)]
mod tests {
    use super::*;

    /// 锁随「打开的文件描述符/句柄」而不是进程：同一进程第二次 acquire 必须被拒；
    /// drop 之后立即释放（证明没有陈旧锁）。夹具落 `test/.tmp`（AGENTS §6 口径）。
    #[test]
    fn 二次获取被拒_释放后可再获取() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/.tmp");
        std::fs::create_dir_all(&dir).expect("创建 test/.tmp 夹具目录");
        let lock = dir.join(format!("single-instance-test-{}.lock", std::process::id()));
        let _ = std::fs::remove_file(&lock);

        let AcquireOutcome::Acquired(guard) = acquire(&lock) else {
            panic!("首次获取应成功（O_EXLOCK / 独占句柄）");
        };
        assert!(
            matches!(acquire(&lock), AcquireOutcome::AlreadyRunning),
            "第二个获取者必须被拒"
        );
        drop(guard);
        assert!(
            matches!(acquire(&lock), AcquireOutcome::Acquired(_)),
            "守卫释放后应可再次获取"
        );

        let _ = std::fs::remove_file(&lock);
    }
}
