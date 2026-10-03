use std::sync::{atomic::Ordering, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

use super::capture::{self, PlatformSample};
use super::visibility::{is_pet_foreground, is_pet_visible};
use super::{MonitorState, WindowObservation};
use crate::{rust_info, rust_warn};

pub fn spawn_monitor_thread(app: tauri::AppHandle, state: Arc<MonitorState>) {
    thread::spawn(move || {
        rust_info!("窗口 observation 线程已启动");
        let mut generation = 0;
        let mut generation_started = Instant::now();
        let mut previous_sample_ms: Option<u64> = None;
        let mut disabled_generation = None;

        loop {
            let current_generation = state.generation.load(Ordering::SeqCst);
            if !state.enabled.load(Ordering::SeqCst) {
                if disabled_generation != Some(current_generation) {
                    generation = current_generation;
                    generation_started = Instant::now();
                    previous_sample_ms = None;
                    let observation = observation(
                        &app, &state,
                        PlatformSample { app_id: None, app: None, title: None, idle_for_ms: None, observation_state: "disabled" },
                        generation, generation_started.elapsed().as_millis() as u64,
                    );
                    emit(&app, observation);
                    disabled_generation = Some(current_generation);
                }
                let guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
                if !state.enabled.load(Ordering::SeqCst) {
                    let _guard = state.cv.wait(guard).unwrap_or_else(|error| error.into_inner());
                }
                continue;
            }

            disabled_generation = None;
            if generation != current_generation {
                generation = current_generation;
                generation_started = Instant::now();
                previous_sample_ms = None;
            }

            let sampled_at = generation_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let sample = capture::sample_window();
            let gap_limit = state.polling_interval_ms.load(Ordering::SeqCst).saturating_mul(2).max(10_000);
            let sample = if previous_sample_ms.is_some_and(|previous| sampled_at.saturating_sub(previous) > gap_limit) {
                PlatformSample { app_id: None, app: None, title: None, idle_for_ms: sample.idle_for_ms, observation_state: "suspended" }
            } else {
                sample
            };
            previous_sample_ms = Some(sampled_at);

            // A config toggle during native sampling invalidates the result; do not publish it under the new generation.
            if state.enabled.load(Ordering::SeqCst) && state.generation.load(Ordering::SeqCst) == generation {
                emit(&app, observation(&app, &state, sample, generation, sampled_at));
            }

            let interval = state.polling_interval_ms.load(Ordering::SeqCst);
            let guard = state.lock.lock().unwrap_or_else(|error| error.into_inner());
            if state.enabled.load(Ordering::SeqCst) && state.generation.load(Ordering::SeqCst) == generation {
                let _ = state.cv.wait_timeout(guard, Duration::from_millis(interval))
                    .unwrap_or_else(|error| error.into_inner());
            }
        }
    });
}

fn observation(
    app: &tauri::AppHandle,
    state: &MonitorState,
    sample: PlatformSample,
    generation: u64,
    sample_mono_ms: u64,
) -> WindowObservation {
    WindowObservation {
        app_id: sample.app_id,
        app: sample.app,
        title: sample.title,
        observed_at: capture::unix_now_ms(),
        sample_mono_ms,
        monitor_generation: generation,
        sequence: state.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        observation_state: sample.observation_state,
        idle_for_ms: sample.idle_for_ms,
        is_pet_visible: is_pet_visible(app),
        is_pet_foreground: is_pet_foreground(app),
    }
}

fn emit(app: &tauri::AppHandle, observation: WindowObservation) {
    if let Err(error) = app.emit("window-observed", observation) {
        rust_warn!("window-observed emit failed: {}", error);
    }
}
