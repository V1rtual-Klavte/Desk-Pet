use crate::error::AppResult;
use crate::memory::MemoryState;
use serde_json::Value;

pub fn scheduler_state(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.scheduler_state(&request)
}
pub fn schedule_query(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.schedule_query(&request)
}
pub fn schedule_change(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.schedule_change(&request)
}
