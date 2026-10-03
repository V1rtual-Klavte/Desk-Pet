use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Condvar, Mutex,
};

pub const DEFAULT_POLLING_INTERVAL_MS: u64 = 3_000;
const MIN_POLLING_INTERVAL_MS: u64 = 1_000;
const MAX_POLLING_INTERVAL_MS: u64 = 60_000;

pub struct MonitorState {
    pub enabled: AtomicBool,
    pub generation: AtomicU64,
    pub sequence: AtomicU64,
    pub polling_interval_ms: AtomicU64,
    pub lock: Mutex<()>,
    pub cv: Condvar,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            // Startup is privacy-safe: the frontend applies the user setting after CONFIG loads.
            enabled: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            sequence: AtomicU64::new(0),
            polling_interval_ms: AtomicU64::new(DEFAULT_POLLING_INTERVAL_MS),
            lock: Mutex::new(()),
            cv: Condvar::new(),
        }
    }
}

impl MonitorState {
    pub fn set_enabled(&self, enabled: bool, polling_interval_ms: u64) {
        let interval_changed = self.polling_interval_ms.swap(polling_interval_ms, Ordering::SeqCst) != polling_interval_ms;
        let changed = self.enabled.swap(enabled, Ordering::SeqCst) != enabled;
        if changed || interval_changed {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.sequence.store(0, Ordering::SeqCst);
        }
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.cv.notify_one();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowObservation {
    pub app_id: Option<String>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub observed_at: u64,
    pub sample_mono_ms: u64,
    pub monitor_generation: u64,
    pub sequence: u64,
    pub observation_state: &'static str,
    pub idle_for_ms: Option<u64>,
    pub is_pet_visible: bool,
    pub is_pet_foreground: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub is_pet_visible: bool,
    pub is_pet_foreground: bool,
    pub observation_state: &'static str,
    pub idle_for_ms: Option<u64>,
    pub observed_at: u64,
}

mod capture;
mod thread;
mod visibility;

pub use thread::spawn_monitor_thread;

pub fn runtime_activity(app: &tauri::AppHandle) -> RuntimeActivity {
    let sampled = capture::sample_system_activity();
    RuntimeActivity {
        is_pet_visible: visibility::is_pet_visible(app),
        is_pet_foreground: visibility::is_pet_foreground(app),
        observation_state: sampled.observation_state,
        idle_for_ms: sampled.idle_for_ms,
        observed_at: capture::unix_now_ms(),
    }
}

pub fn validate_polling_interval(interval_ms: u64) -> Result<(), crate::error::AppError> {
    if (MIN_POLLING_INTERVAL_MS..=MAX_POLLING_INTERVAL_MS).contains(&interval_ms) {
        Ok(())
    } else {
        Err(crate::error::AppError::Config(format!(
            "pollingIntervalMs must be between {MIN_POLLING_INTERVAL_MS} and {MAX_POLLING_INTERVAL_MS}"
        )))
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
        state.set_enabled(true, DEFAULT_POLLING_INTERVAL_MS);
        assert!(state.enabled.load(Ordering::SeqCst));
        assert_eq!(state.generation.load(Ordering::SeqCst), generation + 1);
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);

        state.sequence.store(2, Ordering::SeqCst);
        state.set_enabled(true, DEFAULT_POLLING_INTERVAL_MS + 1);
        assert_eq!(state.generation.load(Ordering::SeqCst), generation + 2);
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);

        state.set_enabled(false, DEFAULT_POLLING_INTERVAL_MS + 1);
        assert!(!state.enabled.load(Ordering::SeqCst));
        assert_eq!(state.sequence.load(Ordering::SeqCst), 0);
    }
}
