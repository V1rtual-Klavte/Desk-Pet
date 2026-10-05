//! 事件驱动的观察工作线程。
//!
//! 采样不再按固定间隔轮询：平台事件（前台切换/锁屏/睡眠唤醒/会话切换）与配置变更
//! 经 [`MonitorState::signal`] 置位并唤醒本线程，线程醒来后采样一次并发布
//! `window-observed`，然后继续等待下一个事件。
//!
//! 迁移后不再持有 `AppHandle`：事件出口是 [`EventSink`]，窗口可见/前台状态是
//! [`WindowPort`]。**不放任何轮询兜底** —— 采样只由事件与重核驱动。

use std::sync::{atomic::Ordering, Arc};
use std::thread;
use std::time::Instant;

use super::capture::{self, PlatformSample};
use super::visibility::pet_visibility;
use super::{events, MonitorState};
use crate::host::{EventSink, HostEvent, WindowObservation, WindowPort};
use crate::rust_info;

/// 关闭状态下的重核间隔：只用于「被重新启用」的自愈，不产生任何采样。
const DISABLED_RECHECK: std::time::Duration = std::time::Duration::from_millis(1_000);

pub fn spawn_monitor_thread(
    sink: Arc<dyn EventSink>,
    window: Arc<dyn WindowPort>,
    state: Arc<MonitorState>,
) {
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
                        &*window,
                        &state,
                        PlatformSample {
                            app_id: None,
                            app: None,
                            title: None,
                            idle_for_ms: None,
                            observation_state: "disabled",
                        },
                        generation,
                        generation_started.elapsed().as_millis() as u64,
                    );
                    emit(&*sink, observation);
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
                publish_sample(&*sink, &*window, &state, generation, generation_started);
            }

            events::wait_for_event(&state);
        }
    });
}

fn publish_sample(
    sink: &dyn EventSink,
    window: &dyn WindowPort,
    state: &MonitorState,
    generation: u64,
    generation_started: Instant,
) {
    let sampled_at = generation_started
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    if state.pending_suspended.swap(false, Ordering::SeqCst)
        && state.enabled.load(Ordering::SeqCst)
        && state.generation.load(Ordering::SeqCst) == generation
    {
        // 唤醒/会话恢复跨越了一段不可归因的观察中断：先发布 suspended 边界，
        // 让消费端截断分段，而不是把中断时长当作连续使用补回去。
        emit(
            sink,
            observation(
                window,
                state,
                PlatformSample {
                    app_id: None,
                    app: None,
                    title: None,
                    idle_for_ms: None,
                    observation_state: "suspended",
                },
                generation,
                sampled_at,
            ),
        );
    }

    let sample = capture::sample_window();
    // A config toggle during native sampling invalidates the result; do not publish it under the new generation.
    if state.enabled.load(Ordering::SeqCst) && state.generation.load(Ordering::SeqCst) == generation
    {
        let sampled_at = generation_started
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        emit(
            sink,
            observation(window, state, sample, generation, sampled_at),
        );
    }
}

/// 把一次平台采样组装成事件载荷。
///
/// `PlatformSample` 的身份字段是 `Option<String>`；端口契约的 [`WindowObservation`]
/// 用 `String` 承载（未知为空串）。**`idle_for_ms` 不做任何折算**：未知保持 `None`
/// （空串→null 的还原发生在壳层 EventSink 的载荷适配处，消费方不得把未知当 0）。
fn observation(
    window: &dyn WindowPort,
    state: &MonitorState,
    sample: PlatformSample,
    generation: u64,
    sample_mono_ms: u64,
) -> WindowObservation {
    let (is_pet_visible, is_pet_foreground) = pet_visibility(window);
    WindowObservation {
        app_id: sample.app_id.unwrap_or_default(),
        app: sample.app.unwrap_or_default(),
        title: sample.title.unwrap_or_default(),
        observed_at: capture::unix_now_ms().min(i64::MAX as u64) as i64,
        sample_mono_ms: sample_mono_ms.min(i64::MAX as u64) as i64,
        monitor_generation: generation,
        sequence: state.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        observation_state: sample.observation_state.to_string(),
        idle_for_ms: sample
            .idle_for_ms
            .map(|idle| idle.min(i64::MAX as u64) as i64),
        is_pet_visible,
        is_pet_foreground,
    }
}

fn emit(sink: &dyn EventSink, observation: WindowObservation) {
    // 事件出口只有一个：失败留痕在 EventSink 实现一侧（它才拿得到路由错误）。
    sink.emit(HostEvent::WindowObserved(observation));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::WindowVisibility;
    use crate::window::test_support::RecordingWindowPort;

    fn sample(
        app_id: Option<&str>,
        idle: Option<u64>,
        observation_state: &'static str,
    ) -> PlatformSample {
        PlatformSample {
            app_id: app_id.map(ToString::to_string),
            app: app_id.map(ToString::to_string),
            title: app_id.map(|_| "标题".to_string()),
            idle_for_ms: idle,
            observation_state,
        }
    }

    fn port(visible: bool, focused: bool) -> RecordingWindowPort {
        RecordingWindowPort {
            visibility: WindowVisibility {
                visible,
                focused,
                minimized: false,
            },
            ..Default::default()
        }
    }

    #[test]
    fn 观察载荷把未知字段还原为空串且闲置时间不折算() {
        let state = MonitorState::default();
        let sampled = observation(
            &port(true, false),
            &state,
            sample(None, None, "unavailable"),
            7,
            123,
        );
        // 端口契约用 String 承载「未知」：空串，不是编造的占位值。
        assert_eq!(sampled.app_id, "");
        assert_eq!(sampled.app, "");
        assert_eq!(sampled.title, "");
        // 「未知闲置」必须保持 None：把未知当 0 会把不可用时段伪装成「刚操作过」。
        assert_eq!(sampled.idle_for_ms, None);
        assert_eq!(sampled.observation_state, "unavailable");
        assert_eq!(sampled.monitor_generation, 7);
        assert_eq!(sampled.sample_mono_ms, 123);
        assert_eq!(sampled.sequence, 1, "序号从 1 起并逐次递增");
        assert!(sampled.is_pet_visible);
        assert!(!sampled.is_pet_foreground);
        assert!(sampled.observed_at > 0, "墙钟时间由采样点填充");

        let next = observation(
            &port(false, true),
            &state,
            sample(Some("com.apple.Safari"), Some(5000), "observed"),
            8,
            200,
        );
        assert_eq!(next.sequence, 2, "每次组装都推进序号，消费端据此发现丢帧");
        assert_eq!(next.app_id, "com.apple.Safari");
        assert_eq!(next.idle_for_ms, Some(5000), "已知闲置时长原样透出");
        assert!(!next.is_pet_visible && next.is_pet_foreground);
    }
}
