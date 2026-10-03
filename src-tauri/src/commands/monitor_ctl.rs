use std::sync::Arc;
use tauri::State;

use crate::error::AppResult;
use crate::monitor::{self, MonitorState, RuntimeActivity};

#[tauri::command]
pub fn set_monitor_enabled(
    state: State<'_, Arc<MonitorState>>,
    enabled: bool,
    polling_interval_ms: u64,
) -> AppResult<()> {
    monitor::validate_polling_interval(polling_interval_ms)?;
    state.set_enabled(enabled, polling_interval_ms);
    Ok(())
}

#[tauri::command]
pub fn get_runtime_activity(app: tauri::AppHandle) -> AppResult<RuntimeActivity> {
    Ok(monitor::runtime_activity(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_interval_rejects_values_outside_observation_bounds() {
        assert!(monitor::validate_polling_interval(999).is_err());
        assert!(monitor::validate_polling_interval(1_000).is_ok());
        assert!(monitor::validate_polling_interval(60_000).is_ok());
        assert!(monitor::validate_polling_interval(60_001).is_err());
    }
}
