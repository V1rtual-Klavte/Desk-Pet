use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(any(target_os = "macos", test))]
use std::sync::Once;

// 留痕宏只在锁屏探测分类路径使用；与分类函数同一 cfg（Windows 非测试构建不带它们）。
#[cfg(any(target_os = "macos", test))]
use crate::{rust_info, rust_warn};

/// 一次前台窗口采样。`screen_state` 与 `idle_for_ms` 是两个正交维度：
/// `screen_state` 表达屏幕能力（`observed` 前台窗口可截 / `locked` 锁屏，截图无意义 /
/// `unavailable` 真不可知），空闲时长单独承载（锁屏也带 idle）。
///
/// 监控线程的边界样本（`disabled`/`suspended`）会经同一字段直通到事件载荷；
/// 事件载荷 `observation_state` 保持 5 值生命周期维度、字段名不改（monitor/thread.rs）。
pub struct PlatformSample {
    pub app_id: Option<String>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub idle_for_ms: Option<u64>,
    pub screen_state: &'static str,
}

/// 系统活动采样：屏幕维度 + 空闲时长。锁屏（`locked`）也携带空闲时长——
/// 「用户离开」与「离开多久」是两件事，消费方按需取用。
pub struct SystemActivitySample {
    pub idle_for_ms: Option<u64>,
    pub screen_state: &'static str,
}

/// 屏幕维度不可确认的采样：不带空闲（不知道就不编造；未知不等于 0）。
fn unavailable_activity() -> SystemActivitySample {
    SystemActivitySample {
        idle_for_ms: None,
        screen_state: "unavailable",
    }
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub fn sample_window() -> PlatformSample {
    let activity = sample_system_activity();
    if activity.screen_state != "observed" {
        // 锁屏/不可知：不采前台身份与标题（锁屏时前台窗口无意义），
        // 屏幕维度与空闲时长原样透出 —— 锁屏也带 idle 是下游「离开多久」的输入。
        return PlatformSample {
            app_id: None,
            app: None,
            title: None,
            idle_for_ms: activity.idle_for_ms,
            screen_state: activity.screen_state,
        };
    }
    let (app_id, app, title) = platform_window();
    let screen_state = if app_id.is_some() {
        "observed"
    } else {
        "unavailable"
    };
    PlatformSample {
        app_id,
        app,
        title,
        idle_for_ms: activity.idle_for_ms,
        screen_state,
    }
}

// ── 锁屏探测：分类纯函数与一次性留痕 ──

/// `CGSSessionScreenIsLocked` 键的原始探测结果。
/// CFDictionary 存不了 null（存 null 等于删键），故「键缺失」与「显式 false」可区分。
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LockProbe {
    Missing,
    ExplicitFalse,
    ExplicitTrue,
    Unexpected,
}

/// 由探测结果得出的锁屏三态。
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LockState {
    Unlocked,
    Locked,
    Unknown,
}

/// 一次性留痕（进程级全局；`Once` 保证同一原因只打一条，不随每次采样重复）。
#[cfg(any(target_os = "macos", test))]
static MISSING_LOGGED: Once = Once::new();
#[cfg(any(target_os = "macos", test))]
static UNEXPECTED_LOGGED: Once = Once::new();

/// 探测结果分类：**键缺失 = 未锁定**（继续查 idle），显式 false 同样未锁定，
/// `kCFBooleanTrue` = 锁屏；非 null 且两者都不是 = 不可确认（一次性 `rust_warn!`）。
///
/// 理由与实测证据：`CGSSessionScreenIsLocked` 是只在锁屏时写入的键 —— macOS 未锁屏时
/// `CGSessionCopyCurrentDictionary` **不写该键**。旧实现把「键缺失」判成不可确认，
/// 导致本机日志 642 条 `unavailable` / 0 条 `observed`，依赖观察的两条链从未跑过。
///
/// **风险注明**：这是隐私相关的放宽 —— 未来系统若在锁屏时也不写此键，会误报
/// `observed`；这是相对「键缺失即永久 unavailable、两条链从不运行」的取舍，已在文档写明。
#[cfg(any(target_os = "macos", test))]
fn lock_probe_state(probe: LockProbe) -> LockState {
    match probe {
        LockProbe::Missing => {
            MISSING_LOGGED.call_once(|| {
                rust_info!(
                    "锁屏探测：CGSSessionScreenIsLocked 键缺失，按未锁定处理（未锁屏该键不写入）"
                );
            });
            LockState::Unlocked
        }
        LockProbe::ExplicitFalse => LockState::Unlocked,
        LockProbe::ExplicitTrue => LockState::Locked,
        LockProbe::Unexpected => {
            UNEXPECTED_LOGGED.call_once(|| {
                rust_warn!("锁屏探测：CGSSessionScreenIsLocked 取值非常规，按不可确认处理")
            });
            LockState::Unknown
        }
    }
}

/// 由锁屏探测 + 空闲秒数组装系统活动采样：`{observed, locked}` 都要求有效空闲；
/// 空闲缺失 / NaN / 负数（任何状态）或锁屏不可确认 → 整体 `unavailable` 且不带 idle
/// （保持「未知不带值」的既有语义）。锁屏分支保留 idle 是与旧实现的刻意差异。
#[cfg(any(target_os = "macos", test))]
fn system_activity_from(probe: LockProbe, idle: Option<f64>) -> SystemActivitySample {
    let state = lock_probe_state(probe);
    let idle_for_ms = idle
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| (seconds * 1_000.0).min(u64::MAX as f64) as u64);
    match (state, idle_for_ms) {
        (LockState::Unlocked, Some(ms)) => SystemActivitySample {
            idle_for_ms: Some(ms),
            screen_state: "observed",
        },
        (LockState::Locked, Some(ms)) => SystemActivitySample {
            idle_for_ms: Some(ms),
            screen_state: "locked",
        },
        _ => unavailable_activity(),
    }
}

#[cfg(windows)]
pub fn sample_system_activity() -> SystemActivitySample {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let desktop = OpenInputDesktop(0, 0 as BOOL, DESKTOP_READOBJECTS);
        if desktop == 0 {
            return unavailable_activity();
        }
        let mut name = [0u16; 128];
        let mut required = 0u32;
        let name_ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * std::mem::size_of::<u16>()) as u32,
            &mut required,
        ) != 0;
        CloseDesktop(desktop);
        if !name_ok {
            return unavailable_activity();
        }
        let desktop_name = String::from_utf16_lossy(
            &name[..name
                .iter()
                .position(|item| *item == 0)
                .unwrap_or(name.len())],
        );

        // 与 macOS 对称（行为变更，Windows 侧未在本机验证）：winlogon（锁屏）分支先查
        // `GetLastInputInfo` 再定状态，`locked` 也带 idle；空闲无法查得时整体不可确认
        // （对齐 macOS 的「idle 无效 → unavailable」口径）。此前 winlogon 直接返回 idle None。
        let mut input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut input) == 0 {
            return unavailable_activity();
        }
        // Both values are 32-bit GetTickCount milliseconds; wrapping_sub handles its ~49-day wrap.
        let idle_for_ms = GetTickCount().wrapping_sub(input.dwTime) as u64;
        let locked = desktop_name.eq_ignore_ascii_case("winlogon");
        SystemActivitySample {
            idle_for_ms: Some(idle_for_ms),
            screen_state: if locked { "locked" } else { "observed" },
        }
    }
}

#[cfg(target_os = "macos")]
pub fn sample_system_activity() -> SystemActivitySample {
    use std::ffi::{c_char, c_void, CString};

    type CfTypeRef = *const c_void;
    type CfStringRef = CfTypeRef;
    type CfDictionaryRef = CfTypeRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CfDictionaryRef;
        fn CGEventSourceSecondsSinceLastEventType(state_id: u32, event_type: u32) -> f64;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CfTypeRef;
        static kCFBooleanFalse: CfTypeRef;
        fn CFStringCreateWithCString(
            allocator: CfTypeRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFDictionaryGetValue(dictionary: CfDictionaryRef, key: CfTypeRef) -> CfTypeRef;
        fn CFRelease(value: CfTypeRef);
    }

    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            // 拿不到会话字典 = 屏幕维度真不可知（与「键缺失」不同：后者是未锁屏时的正常形态，
            // 判定理由与风险见 lock_probe_state）。
            return unavailable_activity();
        }
        let key = match CString::new("CGSSessionScreenIsLocked") {
            Ok(value) => value,
            Err(_) => {
                CFRelease(session);
                return unavailable_activity();
            }
        };
        // kCFStringEncodingUTF8 is 0x08000100.
        let cf_key = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), 0x0800_0100);
        if cf_key.is_null() {
            CFRelease(session);
            return unavailable_activity();
        }
        let lock_value = CFDictionaryGetValue(session, cf_key);
        let probe = if lock_value.is_null() {
            LockProbe::Missing
        } else if lock_value == kCFBooleanTrue {
            LockProbe::ExplicitTrue
        } else if lock_value == kCFBooleanFalse {
            LockProbe::ExplicitFalse
        } else {
            LockProbe::Unexpected
        };
        CFRelease(cf_key);
        CFRelease(session);
        // 锁屏与未锁屏都查空闲：锁屏期间该 API 的语义（是否仍以最后一次输入计秒）
        // **未实测验证**，按契约口径保留数值，由消费方决定用途。
        let seconds = CGEventSourceSecondsSinceLastEventType(1, u32::MAX);
        system_activity_from(probe, Some(seconds))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn sample_system_activity() -> SystemActivitySample {
    unavailable_activity()
}

#[cfg(windows)]
fn platform_window() -> (Option<String>, Option<String>, Option<String>) {
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd == 0 {
            return (None, None, None);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return (None, None, None);
        }
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        let app_id = if process == 0 {
            None
        } else {
            let mut buffer = [0u16; 1024];
            let size = GetProcessImageFileNameW(process, buffer.as_mut_ptr(), buffer.len() as u32);
            CloseHandle(process);
            if size == 0 {
                None
            } else {
                let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
                std::path::Path::new(&full_path)
                    .file_stem()
                    .map(|name| name.to_string_lossy().to_ascii_lowercase())
            }
        };
        let mut title_buffer = [0u16; 2048];
        let title_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title =
            (title_len > 0).then(|| String::from_utf16_lossy(&title_buffer[..title_len as usize]));
        let app = app_id.clone();
        (app_id, app, title)
    }
}

#[cfg(target_os = "macos")]
fn platform_window() -> (Option<String>, Option<String>, Option<String>) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    unsafe fn ns_string(value: *mut Object) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let pointer: *const c_char = msg_send![value, UTF8String];
        if pointer.is_null() {
            None
        } else {
            Some(CStr::from_ptr(pointer).to_string_lossy().into_owned())
        }
    }

    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let running_app: *mut Object = msg_send![workspace, frontmostApplication];
        if running_app.is_null() {
            return (None, None, None);
        }
        let bundle: *mut Object = msg_send![running_app, bundleIdentifier];
        let name: *mut Object = msg_send![running_app, localizedName];
        let app_id = ns_string(bundle);
        let app = ns_string(name);
        let pid: i32 = msg_send![running_app, processIdentifier];
        let title = capture_mac_window_title(pid);
        (app_id, app, title)
    }
}

#[cfg(target_os = "macos")]
fn capture_mac_window_title(owner_pid: i32) -> Option<String> {
    use std::ffi::{c_char, c_void, CString};

    type CfTypeRef = *const c_void;
    type CfArrayRef = CfTypeRef;
    type CfDictionaryRef = CfTypeRef;
    type CfStringRef = CfTypeRef;
    type CfNumberRef = CfTypeRef;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CfArrayRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CfArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CfArrayRef, index: isize) -> CfTypeRef;
        fn CFDictionaryGetValue(dictionary: CfDictionaryRef, key: CfTypeRef) -> CfTypeRef;
        fn CFStringCreateWithCString(
            allocator: CfTypeRef,
            text: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFStringGetCString(
            value: CfStringRef,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> bool;
        fn CFNumberGetValue(value: CfNumberRef, number_type: i32, output: *mut i32) -> bool;
        fn CFRelease(value: CfTypeRef);
    }

    unsafe {
        let names = CString::new("kCGWindowName").ok()?;
        let owners = CString::new("kCGWindowOwnerPID").ok()?;
        let layers = CString::new("kCGWindowLayer").ok()?;
        let name_key = CFStringCreateWithCString(std::ptr::null(), names.as_ptr(), 0x0800_0100);
        let owner_key = CFStringCreateWithCString(std::ptr::null(), owners.as_ptr(), 0x0800_0100);
        let layer_key = CFStringCreateWithCString(std::ptr::null(), layers.as_ptr(), 0x0800_0100);
        if name_key.is_null() || owner_key.is_null() || layer_key.is_null() {
            if !name_key.is_null() {
                CFRelease(name_key);
            }
            if !owner_key.is_null() {
                CFRelease(owner_key);
            }
            if !layer_key.is_null() {
                CFRelease(layer_key);
            }
            return None;
        }
        // On-screen, non-desktop windows are returned in front-to-back order. Avoid launching
        // AppleScript once per observation: it is far slower than the CoreGraphics query and
        // would dominate every event-driven sample.
        let array = CGWindowListCopyWindowInfo(1 | 16, 0);
        let mut title = None;
        if !array.is_null() {
            for index in 0..CFArrayGetCount(array).min(32) {
                let dictionary = CFArrayGetValueAtIndex(array, index);
                if dictionary.is_null() {
                    continue;
                }
                let owner_ref = CFDictionaryGetValue(dictionary, owner_key);
                let mut window_owner = 0i32;
                if owner_ref.is_null()
                    || !CFNumberGetValue(owner_ref, 3, &mut window_owner)
                    || !window_owner_matches(window_owner, owner_pid)
                {
                    continue;
                }
                let layer_ref = CFDictionaryGetValue(dictionary, layer_key);
                let mut layer = -1i32;
                if layer_ref.is_null() || !CFNumberGetValue(layer_ref, 3, &mut layer) || layer != 0
                {
                    continue;
                }
                let value = CFDictionaryGetValue(dictionary, name_key);
                if value.is_null() {
                    continue;
                }
                let mut buffer = [0i8; 1024];
                if CFStringGetCString(
                    value,
                    buffer.as_mut_ptr(),
                    buffer.len() as isize,
                    0x0800_0100,
                ) {
                    let text = std::ffi::CStr::from_ptr(buffer.as_ptr())
                        .to_string_lossy()
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        title = Some(text);
                        break;
                    }
                }
            }
            CFRelease(array);
        }
        CFRelease(name_key);
        CFRelease(owner_key);
        CFRelease(layer_key);
        title
    }
}

#[cfg(any(target_os = "macos", test))]
fn window_owner_matches(window_owner: i32, frontmost_pid: i32) -> bool {
    window_owner == frontmost_pid
}

#[cfg(test)]
mod owner_tests {
    #[test]
    fn frontmost_title_requires_matching_window_owner_pid() {
        assert_eq!(super::window_owner_matches(41, 41), true);
        assert_eq!(super::window_owner_matches(42, 41), false);
    }
}

/// 锁屏探测分类与 idle 保留口径。**合成单一用例**覆盖进程级 `Once` 留痕路径
/// （AGENTS §9：`cargo test --lib` 并行跑同一二进制的用例，拆开会互踩出偶发红）。
#[cfg(test)]
mod activity_tests {
    use super::*;

    #[test]
    fn lock_probe_classifies_states_and_keeps_idle() {
        // 键缺失 + 有效 idle → observed（本故障回归锚点：旧实现把键缺失判为 unavailable）。
        assert_eq!(lock_probe_state(LockProbe::Missing), LockState::Unlocked);
        let missing = system_activity_from(LockProbe::Missing, Some(1.5));
        assert_eq!(missing.screen_state, "observed");
        assert_eq!(missing.idle_for_ms, Some(1500));

        // 显式 false → observed。
        assert_eq!(
            lock_probe_state(LockProbe::ExplicitFalse),
            LockState::Unlocked
        );
        let explicit_false = system_activity_from(LockProbe::ExplicitFalse, Some(2.0));
        assert_eq!(explicit_false.screen_state, "observed");
        assert_eq!(explicit_false.idle_for_ms, Some(2000));

        // true → locked 且 idle 保留（行为变更：不再提前返回 None）。
        assert_eq!(lock_probe_state(LockProbe::ExplicitTrue), LockState::Locked);
        let locked = system_activity_from(LockProbe::ExplicitTrue, Some(3.25));
        assert_eq!(locked.screen_state, "locked");
        assert_eq!(locked.idle_for_ms, Some(3250));

        // 非常规取值 → unavailable；重复调用仍走一次性留痕路径，结果稳定不 panic。
        assert_eq!(lock_probe_state(LockProbe::Unexpected), LockState::Unknown);
        let unexpected = system_activity_from(LockProbe::Unexpected, Some(1.0));
        assert_eq!(unexpected.screen_state, "unavailable");
        assert_eq!(unexpected.idle_for_ms, None);
        let unexpected_again = system_activity_from(LockProbe::Unexpected, Some(1.0));
        assert_eq!(unexpected_again.screen_state, "unavailable");
        let missing_again = system_activity_from(LockProbe::Missing, Some(1.0));
        assert_eq!(missing_again.screen_state, "observed");

        // idle 无效（NaN / 负数 / 缺失）→ 整体 unavailable 且不带 idle（observed/locked 同口径）。
        for probe in [LockProbe::Missing, LockProbe::ExplicitTrue] {
            for idle in [Some(f64::NAN), Some(-1.0), None] {
                let sample = system_activity_from(probe, idle);
                assert_eq!(sample.screen_state, "unavailable");
                assert_eq!(sample.idle_for_ms, None);
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_window() -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}
