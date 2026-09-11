// ==========================================
// 窗口监控控制命令
// pause_monitor / resume_monitor / set_monitor_config
// ==========================================

use std::sync::{Arc, atomic::Ordering};
use std::thread;
use std::time::Duration;

use crate::monitor::MonitorState;
use crate::{rust_info, rust_debug};

#[tauri::command]
pub fn pause_monitor(state: tauri::State<'_, Arc<MonitorState>>, duration_ms: u64) {
    state.paused.store(true, Ordering::SeqCst);
    let state_clone = Arc::clone(&state);
    let extra = state_clone.pause_extra_ms.load(Ordering::SeqCst);
    rust_debug!("监控暂停 {}ms + 额外{}ms", duration_ms, extra);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(duration_ms + extra));
        if state_clone.paused.load(Ordering::SeqCst) {
            state_clone.paused.store(false, Ordering::SeqCst);
            // 锁中毒不 panic：后台线程崩过也要能继续恢复监控
            let _lock = state_clone.lock.lock().unwrap_or_else(|e| e.into_inner());
            state_clone.cv.notify_one();
            rust_debug!("监控自动恢复");
        }
    });
}

#[tauri::command]
pub fn resume_monitor(state: tauri::State<'_, Arc<MonitorState>>) {
    state.paused.store(false, Ordering::SeqCst);
    let _lock = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    state.cv.notify_one();
    rust_debug!("监控手动恢复");
}

/// 启动时接收前端传来的轮询配置
#[tauri::command]
pub fn set_monitor_config(
    state: tauri::State<'_, Arc<MonitorState>>,
    polling_interval_ms: u64,
    pause_extra_ms: u64,
    wait_timeout_ms: u64,
) {
    state.polling_interval_ms.store(polling_interval_ms, Ordering::SeqCst);
    state.pause_extra_ms.store(pause_extra_ms, Ordering::SeqCst);
    state.wait_timeout_ms.store(wait_timeout_ms, Ordering::SeqCst);
    rust_info!("配置已接收 | 轮询:{}ms 暂停额外:{}ms 等待超时:{}ms",
        polling_interval_ms, pause_extra_ms, wait_timeout_ms);
}
