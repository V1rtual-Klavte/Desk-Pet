//! 原生事件源：窗口观察自事件驱动改造后不再按固定间隔采样，改由这些平台事件触发。
//!
//! 事件回调只做两件轻量的事：置 `MonitorState` 的标记并唤醒工作线程（`MonitorState::signal`）；
//! 采样与 `window-observed` 发布仍全部发生在 monitor 工作线程，回调不阻塞触发线程。

use std::sync::{Arc, OnceLock};

use super::MonitorState;

/// 工作线程等待原生事件的最长阻塞时间。
///
/// 这是保活兜底，不是采样定时器：超时只会让线程回到外层重核 enabled/generation，
/// 不产生任何观察事件；平台通知丢失或送达失败时不至于永久睡死。
#[cfg(not(windows))]
const KEEPALIVE_WAIT: std::time::Duration = std::time::Duration::from_secs(300);

/// 平台回调需要的进程级状态。monitor 每进程只有一个线程与一份状态。
static EVENT_TARGET: OnceLock<Arc<MonitorState>> = OnceLock::new();

fn signal(suspended: bool) {
    if let Some(state) = EVENT_TARGET.get() {
        state.signal(suspended);
    }
}

/// 注册平台事件源。macOS 的通知只在主线程投递，必须由主线程调用本函数；
/// Windows 的钩子必须装在带消息循环的工作线程，因此这里只登记状态。
pub(crate) fn prepare(state: &Arc<MonitorState>) {
    let _ = EVENT_TARGET.set(Arc::clone(state));
    #[cfg(target_os = "macos")]
    macos::install();
}

pub(crate) fn wake(state: &MonitorState) {
    #[cfg(target_os = "macos")]
    macos::wake(state);
    #[cfg(windows)]
    win::wake(state);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = state;
}

/// 阻塞直到有原生事件（或保活超时）；调用方随后重新核对状态并按需采样。
pub(crate) fn wait_for_event(state: &Arc<MonitorState>) {
    #[cfg(target_os = "macos")]
    macos::wait(state);
    #[cfg(windows)]
    win::wait(state);
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = state;
        std::thread::sleep(KEEPALIVE_WAIT);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    use super::super::MonitorState;
    use super::{signal, KEEPALIVE_WAIT};
    use crate::rust_warn;

    const OBSERVER_CLASS: &str = "DeskPetWindowObserver";

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSWorkspaceDidActivateApplicationNotification: *const Object;
        static NSWorkspaceWillSleepNotification: *const Object;
        static NSWorkspaceDidWakeNotification: *const Object;
        static NSWorkspaceScreensDidSleepNotification: *const Object;
        static NSWorkspaceScreensDidWakeNotification: *const Object;
        static NSWorkspaceSessionDidBecomeActiveNotification: *const Object;
        static NSWorkspaceSessionDidResignActiveNotification: *const Object;
    }

    extern "C" fn note_sample(_this: &Object, _cmd: Sel, _note: *mut Object) {
        signal(false);
    }

    extern "C" fn note_resume(_this: &Object, _cmd: Sel, _note: *mut Object) {
        signal(true);
    }

    unsafe fn add_observer(
        center: *mut Object,
        observer: *mut Object,
        selector: Sel,
        name: *const Object,
    ) {
        let _: () = msg_send![center, addObserver: observer selector: selector name: name object: std::ptr::null::<Object>()];
    }

    pub(super) fn install() {
        // 回调在主线程触发，但只置标记 + 唤醒工作线程；这里也不做任何采样。
        unsafe {
            if Class::get(OBSERVER_CLASS).is_none() {
                let Some(mut declaration) = ClassDecl::new(OBSERVER_CLASS, class!(NSObject)) else {
                    rust_warn!("窗口观察事件类声明失败，原生事件不可用");
                    return;
                };
                declaration.add_method(
                    sel!(deskpetSample:),
                    note_sample as extern "C" fn(&Object, Sel, *mut Object),
                );
                declaration.add_method(
                    sel!(deskpetResume:),
                    note_resume as extern "C" fn(&Object, Sel, *mut Object),
                );
                declaration.register();
            }
            let Some(observer_class) = Class::get(OBSERVER_CLASS) else {
                rust_warn!("窗口观察事件类不可用，原生事件不可用");
                return;
            };
            // 观察者对象随进程存活、不释放：通知中心不持有强引用，释放会留下悬垂指针。
            let observer: *mut Object = msg_send![observer_class, alloc];
            let observer: *mut Object = msg_send![observer, init];

            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let center: *mut Object = msg_send![workspace, notificationCenter];
            add_observer(
                center,
                observer,
                sel!(deskpetSample:),
                NSWorkspaceDidActivateApplicationNotification,
            );
            add_observer(
                center,
                observer,
                sel!(deskpetSample:),
                NSWorkspaceWillSleepNotification,
            );
            // 显示器睡眠是「人离开了但没有锁屏/系统睡眠」的唯一原生信号：先采一次样让
            // idle/状态落到观察里，唤醒时再发恢复边界，避免把离开时段当成连续使用。
            add_observer(
                center,
                observer,
                sel!(deskpetSample:),
                NSWorkspaceScreensDidSleepNotification,
            );
            add_observer(
                center,
                observer,
                sel!(deskpetSample:),
                NSWorkspaceSessionDidResignActiveNotification,
            );
            add_observer(
                center,
                observer,
                sel!(deskpetResume:),
                NSWorkspaceDidWakeNotification,
            );
            add_observer(
                center,
                observer,
                sel!(deskpetResume:),
                NSWorkspaceScreensDidWakeNotification,
            );
            add_observer(
                center,
                observer,
                sel!(deskpetResume:),
                NSWorkspaceSessionDidBecomeActiveNotification,
            );

            // 锁屏/解锁没有公开的 NSWorkspace 常量，优先用登录窗口发布的分布式通知；
            // 拿不到时采样仍会读出锁屏状态，只是缺事件触发。
            let distributed: *mut Object =
                msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
            for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
                let Ok(name) = CString::new(name) else {
                    continue;
                };
                let value: *mut Object =
                    msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()];
                if !value.is_null() {
                    add_observer(
                        distributed,
                        observer,
                        sel!(deskpetSample:),
                        value as *const Object,
                    );
                }
            }
        }
    }

    pub(super) fn wait(state: &Arc<MonitorState>) {
        let mut guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        while !state.dirty.load(Ordering::SeqCst) {
            let (next, timeout) = state
                .cv
                .wait_timeout(guard, KEEPALIVE_WAIT)
                .unwrap_or_else(|error| error.into_inner());
            guard = next;
            // 保活超时只回到外层重核状态，不产生观察事件。
            if timeout.timed_out() {
                break;
            }
        }
    }

    pub(super) fn wake(state: &MonitorState) {
        // 持锁通知：等待侧在锁内核对 dirty，避免丢唤醒。
        let _guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
        state.cv.notify_one();
    }
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Once};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, RegisterPowerSettingNotification,
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
    };
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PeekMessageW,
        PostThreadMessageW, RegisterClassW, TranslateMessage, EVENT_SYSTEM_FOREGROUND,
        HWND_MESSAGE, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
        PBT_POWERSETTINGCHANGE, PM_NOREMOVE, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT,
        WINEVENT_SKIPOWNPROCESS, WM_APP, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW,
        WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, DEVICE_NOTIFY_WINDOW_HANDLE,
    };

    /// GUID 在 windows-sys 0.52 里没有实现 PartialEq，逐字段比较。
    fn is_console_display_state(guid: &windows_sys::core::GUID) -> bool {
        guid.data1 == GUID_CONSOLE_DISPLAY_STATE.data1
            && guid.data2 == GUID_CONSOLE_DISPLAY_STATE.data2
            && guid.data3 == GUID_CONSOLE_DISPLAY_STATE.data3
            && guid.data4 == GUID_CONSOLE_DISPLAY_STATE.data4
    }

    /// `GUID_CONSOLE_DISPLAY_STATE` 的数据是 DWORD：0 = 关，1 = 开，2 = 变暗。
    /// 显示器关闭是「人离开了但没有锁屏/睡眠」的原生信号：先触发采样让 idle 落进观察；
    /// 显示器打开按恢复处理（先发 suspended 边界再采样）。变暗不算离开，忽略。
    unsafe fn handle_display_state(lparam: LPARAM) {
        let setting = lparam as *const POWERBROADCAST_SETTING;
        if setting.is_null()
            || !is_console_display_state(&(*setting).PowerSetting)
            || (*setting).DataLength < 4
        {
            return;
        }
        let state = std::ptr::read_unaligned((*setting).Data.as_ptr().cast::<u32>());
        match state {
            0 => signal(false),
            1 => signal(true),
            _ => {}
        }
    }

    use super::super::MonitorState;
    use super::signal;
    use crate::rust_warn;

    /// 只用于唤醒消息循环的线程消息；工作线程收到后重核 dirty 再决定是否采样。
    const WM_DESKPET_WAKE: u32 = WM_APP + 0x51;

    static INSTALL: Once = Once::new();
    static INSTALL_DONE: AtomicBool = AtomicBool::new(false);

    /// `PowerRegisterSuspendResumeNotification` 的接收参数需要进程级存活。
    /// 原始指针本身只读且不回写，包一层声明 Sync 后放入 static。
    struct PowerParams(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS);
    unsafe impl Sync for PowerParams {}

    static POWER_PARAMS: PowerParams = PowerParams(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(power_notify_callback),
        Context: std::ptr::null_mut(),
    });

    unsafe extern "system" fn foreground_event(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        signal(false);
    }

    unsafe extern "system" fn power_notify_callback(
        _context: *const std::ffi::c_void,
        event_type: u32,
        _setting: *const std::ffi::c_void,
    ) -> u32 {
        match event_type {
            PBT_APMSUSPEND => signal(false),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => signal(true),
            _ => {}
        }
        0
    }

    unsafe extern "system" fn session_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_WTSSESSION_CHANGE => {
                match wparam as u32 {
                    WTS_SESSION_LOCK | WTS_SESSION_UNLOCK => signal(false),
                    _ => {}
                }
                0
            }
            WM_POWERBROADCAST => {
                match wparam as u32 {
                    PBT_APMSUSPEND => signal(false),
                    PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => signal(true),
                    PBT_POWERSETTINGCHANGE => handle_display_state(lparam),
                    _ => {}
                }
                1
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn install(state: &Arc<MonitorState>) {
        INSTALL.call_once(|| unsafe {
            // GetMessage/PostThreadMessage 需要一个已创建的消息队列；先入队再登记线程号，
            // 否则 set_enabled 的唤醒投递可能落空。
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, 0, 0, 0, PM_NOREMOVE);
            state
                .thread_id
                .store(GetCurrentThreadId(), Ordering::SeqCst);
            // 安装期间到达的状态变更（例如启动即开启观察）不会被投递唤醒，补一条自唤醒消息。
            PostThreadMessageW(GetCurrentThreadId(), WM_DESKPET_WAKE, 0, 0);

            let module = GetModuleHandleW(std::ptr::null());
            let class_name: Vec<u16> = "DeskPetMonitorSink\0".encode_utf16().collect();
            let window_class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(session_window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: module,
                hIcon: 0,
                hCursor: 0,
                hbrBackground: 0,
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            // 类已存在时 RegisterClassW 也返回 0，后续 CreateWindowExW 会给出真实结论。
            RegisterClassW(&window_class);
            // 消息窗口不显示、只接收会话/电源通知；WTS 通知按窗口句柄定向发送。
            let sink: HWND = CreateWindowExW(
                0 as WINDOW_EX_STYLE,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0 as WINDOW_STYLE,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                0,
                module,
                std::ptr::null(),
            );
            if sink == 0 {
                rust_warn!("窗口观察消息窗口创建失败，锁屏/电源事件不可用");
            } else {
                if WTSRegisterSessionNotification(sink, NOTIFY_FOR_THIS_SESSION) == 0 {
                    rust_warn!("会话事件注册失败，锁屏状态仅能靠采样读出");
                }
                // 显示器开关是「人离开了但没有锁屏/睡眠」的原生信号，随 WM_POWERBROADCAST 投递。
                let display_notify = RegisterPowerSettingNotification(
                    sink,
                    &GUID_CONSOLE_DISPLAY_STATE,
                    DEVICE_NOTIFY_WINDOW_HANDLE,
                );
                if display_notify == 0 {
                    rust_warn!("显示器电源通知注册失败，离开时段仅能靠锁屏/睡眠事件截断");
                }
            }

            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                0,
                Some(foreground_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook == 0 {
                rust_warn!("前台窗口事件钩子安装失败，窗口切换不再触发采样");
            }

            let mut registration: *mut std::ffi::c_void = std::ptr::null_mut();
            let flags: u32 = DEVICE_NOTIFY_CALLBACK;
            let result = PowerRegisterSuspendResumeNotification(
                flags,
                (&POWER_PARAMS.0 as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS) as isize,
                &mut registration,
            );
            if result != 0 {
                rust_warn!("睡眠/唤醒电源通知注册失败（错误码 {result}）");
            }
            INSTALL_DONE.store(true, Ordering::SeqCst);
        });
    }

    pub(super) fn wait(state: &Arc<MonitorState>) {
        if !INSTALL_DONE.load(Ordering::SeqCst) {
            install(state);
        }
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            let result = GetMessageW(&mut message, 0, 0, 0);
            if result == 0 || result == -1 {
                // WM_QUIT 或取消息失败：没有消息循环可等，短睡避免忙循环。
                std::thread::sleep(std::time::Duration::from_millis(250));
                return;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    pub(super) fn wake(state: &MonitorState) {
        let thread_id = state.thread_id.load(Ordering::SeqCst);
        // 消息队列尚未建立时（启动窗口期）不投递：install 内部会补一条自唤醒消息。
        if thread_id != 0 {
            unsafe {
                PostThreadMessageW(thread_id, WM_DESKPET_WAKE, 0, 0);
            }
        }
    }
}

// wake / wait 的配对是唤醒状态机里唯一可脱离平台 API 单测的部分（macOS 分支走
// 条件变量，本地可测；Windows 分支的消息循环与钩子安装需要真实消息队列，只做源码核对）。
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn 等待线程只在置脏并唤醒后返回() {
        let state = Arc::new(MonitorState::default());
        state.dirty.store(false, Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel();
        let waiting = Arc::clone(&state);
        let handle = std::thread::spawn(move || {
            wait_for_event(&waiting);
            let _ = tx.send(());
        });
        // 未置脏：不得自行返回（保活兜底是 300s，这个窗口内必须还在等）。
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "没有事件时等待线程不得返回（否则观察线程会空转）"
        );
        // 与 `MonitorState::signal` 相同的顺序：先置脏，再唤醒。
        state.dirty.store(true, Ordering::SeqCst);
        wake(&state);
        rx.recv_timeout(Duration::from_secs(2))
            .expect("置脏并唤醒后必须在期限内返回（唤醒不得丢失）");
        handle.join().expect("等待线程不得 panic");
    }
}
