//! 窗口观察总闸与运行活动快照的命令面。

use crate::error::AppResult;
use crate::host::WindowPort;
use crate::monitor::{self, MonitorState, RuntimeActivity};

pub fn set_monitor_enabled(state: &MonitorState, enabled: bool) -> AppResult<()> {
    state.set_enabled(enabled);
    Ok(())
}

pub fn get_runtime_activity(window: &dyn WindowPort) -> AppResult<RuntimeActivity> {
    Ok(monitor::runtime_activity(window))
}
