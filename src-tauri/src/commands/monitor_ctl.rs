use std::sync::Arc;
use tauri::State;

use crate::error::AppResult;
use crate::monitor::{self, MonitorState, RuntimeActivity};

#[tauri::command]
pub fn set_monitor_enabled(state: State<'_, Arc<MonitorState>>, enabled: bool) -> AppResult<()> {
    state.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn get_runtime_activity(app: tauri::AppHandle) -> AppResult<RuntimeActivity> {
    Ok(monitor::runtime_activity(&app))
}
