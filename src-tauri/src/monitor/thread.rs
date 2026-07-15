// ==========================================
// 后台监控线程
// 轮询窗口标题 → emit("window-changed")
// ==========================================

use std::sync::{Arc, atomic::Ordering};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

use super::{MonitorState, WindowChangePayload};
use super::capture::capture_window_title;
use super::visibility::is_pet_visible;

use crate::{rust_info, rust_debug, rust_log, rust_warn};

pub fn spawn_monitor_thread(
    handle: tauri::AppHandle,
    state: Arc<MonitorState>,
) {
    thread::spawn(move || {
        rust_info!("窗口监控线程已启动");
        loop {
            while state.paused.load(Ordering::SeqCst) {
                let timeout_ms = state.wait_timeout_ms.load(Ordering::SeqCst);
                let guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
                let _ = match state.cv.wait_timeout(guard, Duration::from_millis(timeout_ms)) {
                    Ok(v) => v,
                    Err(_) => {
                        rust_warn!("Condvar wait_timeout poison, retrying loop");
                        break;
                    }
                };
            }
            let interval_ms = state.polling_interval_ms.load(Ordering::SeqCst);
            thread::sleep(Duration::from_millis(interval_ms));

            let title = capture_window_title();
            if !title.is_empty() {
                let visible = is_pet_visible(&handle);
                rust_debug!("emit window-changed | 可见:{}", visible);
                let _ = handle.emit("window-changed", WindowChangePayload {
                    title: title.clone(),
                    content: title,
                    is_pet_visible: visible,
                });
            }
        }
    });
}
