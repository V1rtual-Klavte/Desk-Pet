//! 事件驱动的观察工作线程。
//!
//! 采样不再按固定间隔轮询：平台事件（前台切换/锁屏/睡眠唤醒/会话切换）与配置变更
//! 经 [`MonitorState::signal`] 置位并唤醒本线程，线程醒来后采样一次并发布
//! `window-observed`，然后继续等待下一个事件。

use std::sync::{atomic::Ordering, Arc};
use std::thread;
use std::time::Instant;
use tauri::Emitter;

use super::capture::{self, PlatformSample};
use super::visibility::{is_pet_foreground, is_pet_visible};
use super::{events, MonitorState, WindowObservation};
use crate::{rust_info, rust_warn};

/// 关闭状态下的重核间隔：只用于「被重新启用」的自愈，不产生任何采样。
const DISABLED_RECHECK: std::time::Duration = std::time::Duration::from_millis(1_000);

pub fn spawn_monitor_thread(app: tauri::AppHandle, state: Arc<MonitorState>) {
    // macOS 的 NSWorkspace 通知只在主线程投递，观察者必须在这里（主线程）注册；
    // Windows 的钩子装在带消息循环的工作线程内，此处只登记唤醒目标。
    events::prepare(&state);
    thread::spawn(move || {
        rust_info!("窗口 observation 线程已启动（事件驱动）");
        let mut generation = 0;
        let mut generation_started = Instant::now();
        let mut disabled_generation = None;

        loop {
            let current_generation = state.generation.load(Ordering::SeqCst);
            if !state.enabled.load(Ordering::SeqCst) {
                // 关闭期间到达的睡眠/唤醒事件不应在重新开启后补发 suspended。
                state.pending_suspended.store(false, Ordering::SeqCst);
                // 同时清掉唤醒位：等待侧以 dirty 判是否立即返回，留着它线程会原地空转；
                // 清位与「恰好此刻被启用」之间的竞态由下面 1 秒重核兜住 —— 重新启用的
                // 采样最多晚 1 秒，而不是睡到保活超时才醒（曾表现为启用后长时间收不到观察事件）。
                state.dirty.store(false, Ordering::SeqCst);
                if disabled_generation != Some(current_generation) {
                    generation = current_generation;
                    generation_started = Instant::now();
                    let observation = observation(
                        &app, &state,
                        PlatformSample { app_id: None, app: None, title: None, idle_for_ms: None, observation_state: "disabled" },
                        generation, generation_started.elapsed().as_millis() as u64,
                    );
                    emit(&app, observation);
                    disabled_generation = Some(current_generation);
                }
                thread::sleep(DISABLED_RECHECK);
                continue;
            }

            disabled_generation = None;
            let generation_changed = generation != current_generation;
            if generation_changed {
                generation = current_generation;
                generation_started = Instant::now();
            }
            if generation_changed || state.dirty.swap(false, Ordering::SeqCst) {
                publish_sample(&app, &state, generation, generation_started);
            }

            events::wait_for_event(&state);
        }
    });
}

fn publish_sample(app: &tauri::AppHandle, state: &MonitorState, generation: u64, generation_started: Instant) {
    let sampled_at = generation_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if state.pending_suspended.swap(false, Ordering::SeqCst)
        && state.enabled.load(Ordering::SeqCst) && state.generation.load(Ordering::SeqCst) == generation
    {
        // 唤醒/会话恢复跨越了一段不可归因的观察中断：先发布 suspended 边界，
        // 让消费端截断分段，而不是把中断时长当作连续使用补回去。
        emit(&app, observation(
            &app, state,
            PlatformSample { app_id: None, app: None, title: None, idle_for_ms: None, observation_state: "suspended" },
            generation, sampled_at,
        ));
    }

    let sample = capture::sample_window();
    // A config toggle during native sampling invalidates the result; do not publish it under the new generation.
    if state.enabled.load(Ordering::SeqCst) && state.generation.load(Ordering::SeqCst) == generation {
        let sampled_at = generation_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        emit(&app, observation(&app, state, sample, generation, sampled_at));
    }
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
