use std::time::{SystemTime, UNIX_EPOCH};

pub struct PlatformSample {
    pub app_id: Option<String>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub idle_for_ms: Option<u64>,
    pub observation_state: &'static str,
}

pub struct SystemActivitySample {
    pub idle_for_ms: Option<u64>,
    pub observation_state: &'static str,
    pub locked: bool,
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub fn sample_window() -> PlatformSample {
    let activity = sample_system_activity();
    if activity.observation_state != "observed" || activity.locked {
        return PlatformSample {
            app_id: None, app: None, title: None, idle_for_ms: activity.idle_for_ms,
            observation_state: if activity.locked { "locked" } else { activity.observation_state },
        };
    }
    let (app_id, app, title) = platform_window();
    let observation_state = if app_id.is_some() { "observed" } else { "unavailable" };
    PlatformSample { app_id, app, title, idle_for_ms: activity.idle_for_ms, observation_state }
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
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
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
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        let desktop_name = String::from_utf16_lossy(&name[..name.iter().position(|item| *item == 0).unwrap_or(name.len())]);
        if desktop_name.eq_ignore_ascii_case("winlogon") {
            return SystemActivitySample { idle_for_ms: None, observation_state: "locked", locked: true };
        }

        let mut input = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut input) == 0 {
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        // Both values are 32-bit GetTickCount milliseconds; wrapping_sub handles its ~49-day wrap.
        let idle_for_ms = GetTickCount().wrapping_sub(input.dwTime) as u64;
        SystemActivitySample { idle_for_ms: Some(idle_for_ms), observation_state: "observed", locked: false }
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
        fn CFStringCreateWithCString(allocator: CfTypeRef, c_str: *const c_char, encoding: u32) -> CfStringRef;
        fn CFDictionaryGetValue(dictionary: CfDictionaryRef, key: CfTypeRef) -> CfTypeRef;
        fn CFRelease(value: CfTypeRef);
    }

    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        let key = match CString::new("CGSSessionScreenIsLocked") {
            Ok(value) => value,
            Err(_) => {
                CFRelease(session);
                return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
            }
        };
        // kCFStringEncodingUTF8 is 0x08000100. A missing lock property is treated as unavailable,
        // never as an affirmative unlocked result.
        let cf_key = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), 0x0800_0100);
        if cf_key.is_null() {
            CFRelease(session);
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        let lock_value = CFDictionaryGetValue(session, cf_key);
        let lock_known = !lock_value.is_null();
        let locked = lock_known && lock_value == kCFBooleanTrue;
        CFRelease(cf_key);
        CFRelease(session);
        if !lock_known {
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        if locked {
            return SystemActivitySample { idle_for_ms: None, observation_state: "locked", locked: true };
        }
        let seconds = CGEventSourceSecondsSinceLastEventType(1, u32::MAX);
        if !seconds.is_finite() || seconds < 0.0 {
            return SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false };
        }
        let idle_for_ms = (seconds * 1_000.0).min(u64::MAX as f64) as u64;
        SystemActivitySample { idle_for_ms: Some(idle_for_ms), observation_state: "observed", locked: false }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn sample_system_activity() -> SystemActivitySample {
    SystemActivitySample { idle_for_ms: None, observation_state: "unavailable", locked: false }
}

#[cfg(windows)]
fn platform_window() -> (Option<String>, Option<String>, Option<String>) {
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd == 0 { return (None, None, None); }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 { return (None, None, None); }
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        let app_id = if process == 0 {
            None
        } else {
            let mut buffer = [0u16; 1024];
            let size = GetProcessImageFileNameW(process, buffer.as_mut_ptr(), buffer.len() as u32);
            CloseHandle(process);
            if size == 0 { None } else {
                let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
                std::path::Path::new(&full_path).file_stem().map(|name| name.to_string_lossy().to_ascii_lowercase())
            }
        };
        let mut title_buffer = [0u16; 2048];
        let title_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = (title_len > 0).then(|| String::from_utf16_lossy(&title_buffer[..title_len as usize]));
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
        if value.is_null() { return None; }
        let pointer: *const c_char = msg_send![value, UTF8String];
        if pointer.is_null() { None } else { Some(CStr::from_ptr(pointer).to_string_lossy().into_owned()) }
    }

    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let running_app: *mut Object = msg_send![workspace, frontmostApplication];
        if running_app.is_null() { return (None, None, None); }
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
        fn CFStringCreateWithCString(allocator: CfTypeRef, text: *const c_char, encoding: u32) -> CfStringRef;
        fn CFStringGetCString(value: CfStringRef, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
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
            if !name_key.is_null() { CFRelease(name_key); }
            if !owner_key.is_null() { CFRelease(owner_key); }
            if !layer_key.is_null() { CFRelease(layer_key); }
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
                if dictionary.is_null() { continue; }
                let owner_ref = CFDictionaryGetValue(dictionary, owner_key);
                let mut window_owner = 0i32;
                if owner_ref.is_null() || !CFNumberGetValue(owner_ref, 3, &mut window_owner) || !window_owner_matches(window_owner,owner_pid) { continue; }
                let layer_ref = CFDictionaryGetValue(dictionary, layer_key);
                let mut layer = -1i32;
                if layer_ref.is_null() || !CFNumberGetValue(layer_ref, 3, &mut layer) || layer != 0 { continue; }
                let value = CFDictionaryGetValue(dictionary, name_key);
                if value.is_null() { continue; }
                let mut buffer = [0i8; 1024];
                if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, 0x0800_0100) {
                    let text = std::ffi::CStr::from_ptr(buffer.as_ptr()).to_string_lossy().trim().to_string();
                    if !text.is_empty() { title = Some(text); break; }
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
fn window_owner_matches(window_owner: i32, frontmost_pid: i32) -> bool { window_owner == frontmost_pid }

#[cfg(test)]
mod owner_tests {
    #[test]
    fn frontmost_title_requires_matching_window_owner_pid() {
        assert_eq!(super::window_owner_matches(41, 41), true);
        assert_eq!(super::window_owner_matches(42, 41), false);
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_window() -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}
