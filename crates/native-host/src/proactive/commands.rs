//! 主动陪伴事务命令面：transport 无关的普通函数。业务裁决留在唯一 MemoryStore 写入者。
//! IPC 层只做参数提取后转发。
use crate::error::AppResult;
use crate::memory::MemoryState;
use serde_json::Value;

macro_rules! proactive_command {
    ($name:ident, $method:ident) => {
        pub fn $name(state: &MemoryState, request: Value) -> AppResult<Value> {
            state.0.$method(&request)
        }
    };
}

proactive_command!(proactive_scan, proactive_scan);
proactive_command!(proactive_query, proactive_query);
proactive_command!(proactive_change, proactive_change);
proactive_command!(proactive_claim, proactive_claim);
proactive_command!(proactive_validate, proactive_validate);
proactive_command!(proactive_settle, proactive_settle);
proactive_command!(proactive_reconcile, proactive_reconcile);
proactive_command!(proactive_control, proactive_control);

pub fn proactive_auxiliary_budget_reserve(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.proactive_auxiliary_budget_reserve(&request)
}

pub fn proactive_auxiliary_budget_settle(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.proactive_auxiliary_budget_settle(&request)
}
