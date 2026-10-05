//! 窗口/系统观察域。
//!
//! 事件驱动的采样与发布：平台事件（前台切换/锁屏/睡眠唤醒/显示器睡眠唤醒/会话切换）
//! 与配置变更经 [`MonitorState::signal`] 置位并唤醒工作线程；线程醒来后采样一次并
//! 经 [`crate::host::EventSink`] 发布 `window-observed`。本模块不依赖任何 UI 框架：
//! 窗口可见/前台状态经 [`crate::host::WindowPort`] 读取，事件出口经 `EventSink`。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(windows)]
use std::sync::atomic::AtomicU32;
#[cfg(not(windows))]
use std::sync::{Condvar, Mutex};

use crate::host::WindowPort;

pub struct MonitorState {
    pub enabled: AtomicBool,
    pub generation: AtomicU64,
    pub sequence: AtomicU64,
    /// 原生事件到达标记：工作线程据此采样，避免无事件空转。
    pub dirty: AtomicBool,
    /// 观察中断标记：睡眠/唤醒/会话切换等事件置位，
    /// 工作线程在下一次采样前先发布一条 `suspended` 边界观察。
    pub pending_suspended: AtomicBool,
    #[cfg(not(windows))]
    pub lock: Mutex<()>,
    #[cfg(not(windows))]
    pub cv: Condvar,
    /// Windows 工作线程的消息循环线程号；0 = 消息队列尚未建立，唤醒投递会落空。
    #[cfg(windows)]
    pub thread_id: AtomicU32,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            // Startup is privacy-safe: the frontend applies the user setting after CONFIG loads.
            enabled: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            sequence: AtomicU64::new(0),
            // 先置位：线程起步（或平台事件源刚装好）时先采一次，再等事件。
            dirty: AtomicBool::new(true),
            pending_suspended: AtomicBool::new(false),
            #[cfg(not(windows))]
            lock: Mutex::new(()),
            #[cfg(not(windows))]
            cv: Condvar::new(),
            #[cfg(windows)]
            thread_id: AtomicU32::new(0),
        }
    }
}

impl MonitorState {
    pub fn set_enabled(&self, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.sequence.store(0, Ordering::SeqCst);
        }
        self.signal(false);
    }

    /// 平台事件与配置变更的唯一唤醒入口：置标记后唤醒工作线程。
    /// `suspended` 表示这次事件跨过了不可归因的观察中断（唤醒/会话恢复）。
    pub fn signal(&self, suspended: bool) {
        if suspended {
            self.pending_suspended.store(true, Ordering::SeqCst);
        }
        self.dirty.store(true, Ordering::SeqCst);
        events::wake(self);
    }
}

/// 一次性运行活动快照。**字段集固定**：get_runtime_activity 的
/// IPC 结果形状、E2E `expectNativeObservationProtocol` 断言都按这些名字与语义读。
/// `screen_state` 取 `observed`（前台窗口可截）/`locked`（锁屏，截图无意义）/
/// `unavailable`（真不可知）；`idle_for_ms` 是与它正交的第二维度（锁屏也带 idle）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub is_pet_visible: bool,
    pub is_pet_foreground: bool,
    pub screen_state: &'static str,
    pub idle_for_ms: Option<u64>,
    pub observed_at: u64,
}

mod capture;
mod events;
mod thread;
mod visibility;

pub use thread::spawn_monitor_thread;

/// 即时读取系统活动与桌宠窗口状态。窗口可见/前台经 [`WindowPort`] 读取。
pub fn runtime_activity(window: &dyn WindowPort) -> RuntimeActivity {
    let sampled = capture::sample_system_activity();
    let (is_pet_visible, is_pet_foreground) = visibility::pet_visibility(window);
    RuntimeActivity {
        is_pet_visible,
        is_pet_foreground,
        screen_state: sampled.screen_state,
        idle_for_ms: sampled.idle_for_ms,
        observed_at: capture::unix_now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn monitor_starts_disabled_and_each_permission_generation_resets_sequence() {
        let state = MonitorState::default();
        assert!(!state.enabled.load(Ordering::SeqCst));
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);
        let generation = state.generation.load(Ordering::SeqCst);

        state.sequence.store(7, Ordering::SeqCst);
        state.set_enabled(true);
        assert!(state.enabled.load(Ordering::SeqCst));
        assert_eq!(state.generation.load(Ordering::SeqCst), generation + 1);
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);

        // 重复下发同一授权值不再推进代际：观察由原生事件驱动，没有“间隔变更”这类第二输入。
        state.sequence.store(2, Ordering::SeqCst);
        state.set_enabled(true);
        assert_eq!(state.generation.load(Ordering::SeqCst), generation + 1);
        assert_eq!(state.sequence.load(Ordering::SeqCst), 2);

        state.set_enabled(false);
        assert!(!state.enabled.load(Ordering::SeqCst));
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);

        state.pending_suspended.store(false, Ordering::SeqCst);
        state.signal(true);
        assert!(state.pending_suspended.load(Ordering::SeqCst));
        assert!(state.dirty.load(Ordering::SeqCst));
    }
}
