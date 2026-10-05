//! 记忆库的命令面：transport 无关的普通函数。
//!
//! 每个函数只做三件事：参数收窄、调用唯一 Store、把结果原样返回。
//! 业务规则一律留在 `store.rs`，命令层不复制第二份判定。
//! IPC 层只做参数提取后转发，不含业务判定。

use super::store::{
    JOB_LEASE_MS, JOB_LIST_LIMIT_DEFAULT, LIST_LIMIT_DEFAULT, QUERY_LIMIT_DEFAULT,
    RECALL_LIMIT_DEFAULT,
};
use super::MemoryState;
use crate::error::{AppError, AppResult};
use crate::paths::{AppPaths, MEMORY_BACKUPS_DIR};
use serde_json::Value;

fn managed_backup_path(paths: &AppPaths, backup_path: &str) -> AppResult<std::path::PathBuf> {
    let requested = std::path::Path::new(backup_path);
    let backups = paths.memory.join(MEMORY_BACKUPS_DIR);
    let resolved = requested
        .canonicalize()
        .map_err(|_| AppError::PathNotFound(backup_path.to_string()))?;
    let base = backups
        .canonicalize()
        .map_err(|_| AppError::PathNotFound(backups.to_string_lossy().to_string()))?;
    if !resolved.starts_with(&base) || !resolved.is_file() {
        return Err(AppError::PathEscape);
    }
    Ok(resolved)
}

pub fn memory_status(state: &MemoryState) -> AppResult<Value> {
    let status = state.0.status()?;
    Ok(serde_json::to_value(status).unwrap_or(Value::Null))
}

pub fn memory_list(
    state: &MemoryState,
    scope: Option<String>,
    scope_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Value>> {
    state.0.list(
        scope.as_deref(),
        scope_id.as_deref(),
        limit.unwrap_or(LIST_LIMIT_DEFAULT),
    )
}

pub fn memory_detail(state: &MemoryState, id: String) -> AppResult<Option<Value>> {
    state.0.detail(&id)
}

pub fn memory_history(state: &MemoryState, id: String) -> AppResult<Vec<Value>> {
    state.0.history(&id)
}

pub fn memory_register_sources(state: &MemoryState, sources: Vec<Value>) -> AppResult<usize> {
    state.0.register_sources(&sources)
}

pub fn memory_query(
    state: &MemoryState,
    query: String,
    scope: Option<String>,
    scope_id: Option<String>,
    session_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Value>> {
    state.0.query(
        &query,
        scope.as_deref(),
        scope_id.as_deref(),
        session_id.as_deref(),
        limit.unwrap_or(QUERY_LIMIT_DEFAULT),
    )
}

pub fn memory_recall_candidates(
    state: &MemoryState,
    query: String,
    card_id: Option<String>,
    session_id: String,
    limit: Option<i64>,
    targets: Option<Vec<Value>>,
    allow_expired_targets: Option<bool>,
) -> AppResult<Value> {
    state.0.recall_candidates(
        &query,
        card_id.as_deref(),
        &session_id,
        limit.unwrap_or(RECALL_LIMIT_DEFAULT),
        targets.as_deref().unwrap_or(&[]),
        allow_expired_targets.unwrap_or(false),
    )
}

pub fn memory_get_items(state: &MemoryState, ids: Vec<String>) -> AppResult<Vec<Value>> {
    state.0.get_items(&ids)
}

#[allow(clippy::too_many_arguments)]
pub fn memory_apply_change(
    window_label: &str,
    state: &MemoryState,
    operation_id: String,
    base_revision: i64,
    action: String,
    item_id: Option<String>,
    expected_version: Option<i64>,
    draft: Option<Value>,
    actor: String,
    trusted_user_event_id: Option<String>,
    trusted_session_id: Option<String>,
) -> AppResult<i64> {
    let store_actor = match actor.as_str() {
        "current_input" if window_label == "main" => "current_input",
        "user_ui" if window_label == "settings" => "user_ui",
        "user_ui"
            if window_label == "main"
                && action == "add"
                && trusted_session_id
                    .as_deref()
                    .is_some_and(|value| !value.is_empty()) =>
        {
            "user_ui_current"
        }
        // Governance clears and evaluation seeding use the internal actor. Keep it
        // on the real main window or the debug-only E2E window.
        "internal"
            if window_label == "main" || (cfg!(debug_assertions) && window_label == "e2e") =>
        {
            "internal"
        }
        _ => {
            return Err(AppError::Memory(
                "记忆变更调用窗口身份与操作类型不匹配".into(),
            ))
        }
    };
    state.0.apply_change_with_actor(
        &operation_id,
        base_revision,
        &action,
        item_id.as_deref(),
        expected_version,
        draft.as_ref(),
        store_actor,
        trusted_user_event_id.as_deref(),
        trusted_session_id.as_deref(),
    )
}

pub fn memory_job_start(
    state: &MemoryState,
    phase: String,
    lease_owner: String,
) -> AppResult<Value> {
    state.0.job_start(&phase, &lease_owner)
}

pub fn memory_job_list(
    state: &MemoryState,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<Vec<Value>> {
    state
        .0
        .job_list(limit.unwrap_or(JOB_LIST_LIMIT_DEFAULT), offset.unwrap_or(0))
}

pub fn memory_job_checkpoint(
    state: &MemoryState,
    job_id: String,
    cursor: String,
    lease_owner: String,
    lease_ms: Option<i64>,
) -> AppResult<Value> {
    state.0.job_checkpoint(
        &job_id,
        &cursor,
        &lease_owner,
        lease_ms.unwrap_or(JOB_LEASE_MS),
    )
}

pub fn memory_job_cancel(
    state: &MemoryState,
    job_id: String,
    lease_owner: String,
) -> AppResult<Value> {
    state.0.job_cancel(&job_id, &lease_owner)
}

pub fn memory_job_resume(
    state: &MemoryState,
    job_id: String,
    lease_owner: String,
) -> AppResult<Value> {
    state.0.job_resume(&job_id, &lease_owner)
}

pub fn memory_job_sources(state: &MemoryState, job_id: String) -> AppResult<Vec<Value>> {
    state.0.job_sources(&job_id)
}

pub fn memory_source_evidence(state: &MemoryState, source_id: String) -> AppResult<Option<Value>> {
    state.0.source_evidence(&source_id)
}

pub fn memory_candidates_add(
    state: &MemoryState,
    job_id: String,
    candidates: Vec<Value>,
) -> AppResult<usize> {
    state.0.candidates_add(&job_id, &candidates)
}

pub fn memory_dreaming_budget_reserve(
    state: &MemoryState,
    reservation_id: String,
    local_date: String,
    reserved_tokens: i64,
    daily_limit: i64,
) -> AppResult<bool> {
    state
        .0
        .reserve_dreaming_budget(&reservation_id, &local_date, reserved_tokens, daily_limit)
}

pub fn memory_dreaming_budget_settle(
    state: &MemoryState,
    reservation_id: String,
    local_date: String,
    reserved_tokens: i64,
    used_tokens: Option<i64>,
) -> AppResult<()> {
    state
        .0
        .settle_dreaming_budget(&reservation_id, &local_date, reserved_tokens, used_tokens)
}

pub fn memory_dreaming_budget(state: &MemoryState, local_date: String) -> AppResult<Value> {
    state.0.dreaming_budget(&local_date)
}

pub fn memory_dreaming_commit(
    state: &MemoryState,
    job_id: String,
    base_revision: i64,
) -> AppResult<i64> {
    state.0.commit_dreaming_job(&job_id, base_revision)
}

pub fn memory_export(state: &MemoryState) -> AppResult<String> {
    state.0.export()
}

pub fn memory_backup(state: &MemoryState) -> AppResult<String> {
    state.0.backup()
}

pub fn memory_rebuild(state: &MemoryState) -> AppResult<i64> {
    state.0.rebuild()
}

pub fn memory_restore(
    state: &MemoryState,
    paths: &AppPaths,
    backup_path: String,
) -> AppResult<i64> {
    let resolved = managed_backup_path(paths, &backup_path)?;
    state.0.restore(&resolved)
}

pub fn memory_restore_preview(paths: &AppPaths, backup_path: String) -> AppResult<Value> {
    let resolved = managed_backup_path(paths, &backup_path)?;
    super::MemoryStore::restore_preview(&resolved)
}
