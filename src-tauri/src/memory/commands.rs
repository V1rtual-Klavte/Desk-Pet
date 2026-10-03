//! 记忆库的 Tauri 命令面。
//!
//! 每个命令只做三件事：参数收窄、调用唯一 Store、把结果原样返回。
//! 业务规则一律留在 `store.rs`，命令层不复制第二份判定。

use super::MemoryState;
use crate::error::AppResult;
use serde_json::Value;

fn managed_backup_path(paths: &crate::paths::AppPaths, backup_path: &str) -> AppResult<std::path::PathBuf> {
    let requested = std::path::Path::new(backup_path);
    let backups = paths.memory.join("backups");
    let resolved = requested.canonicalize().map_err(|_| crate::error::AppError::PathNotFound(backup_path.to_string()))?;
    let base = backups.canonicalize().map_err(|_| crate::error::AppError::PathNotFound(backups.to_string_lossy().to_string()))?;
    if !resolved.starts_with(&base) || !resolved.is_file() {
        return Err(crate::error::AppError::PathEscape);
    }
    Ok(resolved)
}

#[tauri::command]
pub fn memory_status(state: tauri::State<'_, MemoryState>) -> AppResult<Value> {
    let status = state.0.status()?;
    Ok(serde_json::to_value(status).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn memory_list(
    state: tauri::State<'_, MemoryState>,
    scope: Option<String>,
    scope_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Value>> {
    state.0.list(scope.as_deref(), scope_id.as_deref(), limit.unwrap_or(200))
}

#[tauri::command]
pub fn memory_detail(state: tauri::State<'_, MemoryState>, id: String) -> AppResult<Option<Value>> {
    state.0.detail(&id)
}

#[tauri::command]
pub fn memory_history(state: tauri::State<'_, MemoryState>, id: String) -> AppResult<Vec<Value>> {
    state.0.history(&id)
}

#[tauri::command]
pub fn memory_register_sources(state: tauri::State<'_, MemoryState>, sources: Vec<Value>) -> AppResult<usize> {
    state.0.register_sources(&sources)
}

#[tauri::command]
pub fn memory_query(
    state: tauri::State<'_, MemoryState>,
    query: String,
    scope: Option<String>,
    scope_id: Option<String>,
    session_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<Value>> {
    state.0.query(&query, scope.as_deref(), scope_id.as_deref(), session_id.as_deref(), limit.unwrap_or(12))
}

#[tauri::command]
pub fn memory_recall_candidates(
    state: tauri::State<'_, MemoryState>,
    query: String,
    card_id: Option<String>,
    session_id: String,
    limit: Option<i64>,
    targets: Option<Vec<Value>>,
    allow_expired_targets: Option<bool>,
) -> AppResult<Value> {
    state.0.recall_candidates(
        &query, card_id.as_deref(), &session_id, limit.unwrap_or(50),
        targets.as_deref().unwrap_or(&[]), allow_expired_targets.unwrap_or(false),
    )
}

#[tauri::command]
pub fn memory_get_items(state: tauri::State<'_, MemoryState>, ids: Vec<String>) -> AppResult<Vec<Value>> {
    state.0.get_items(&ids)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn memory_apply_change(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MemoryState>,
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
        "current_input" if window.label() == "main" => "current_input",
        "user_ui" if window.label() == "settings" => "user_ui",
        "user_ui" if window.label() == "main" && action == "add" && trusted_session_id.as_deref().is_some_and(|value| !value.is_empty()) => "user_ui_current",
        // Governance clears and evaluation seeding use the internal actor. Keep it
        // on the real main window or the debug-only E2E window.
        "internal" if window.label() == "main" || (cfg!(debug_assertions) && window.label() == "e2e") => "internal",
        _ => return Err(crate::error::AppError::Memory("记忆变更调用窗口身份与操作类型不匹配".into())),
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

#[tauri::command]
pub fn memory_job_start(state: tauri::State<'_, MemoryState>, phase: String, lease_owner: String) -> AppResult<Value> {
    state.0.job_start(&phase, &lease_owner)
}

#[tauri::command]
pub fn memory_job_list(state: tauri::State<'_, MemoryState>, limit: Option<i64>, offset: Option<i64>) -> AppResult<Vec<Value>> {
    state.0.job_list(limit.unwrap_or(50), offset.unwrap_or(0))
}

#[tauri::command]
pub fn memory_job_checkpoint(
    state: tauri::State<'_, MemoryState>,
    job_id: String,
    cursor: String,
    lease_owner: String,
    lease_ms: Option<i64>,
) -> AppResult<Value> {
    state.0.job_checkpoint(&job_id, &cursor, &lease_owner, lease_ms.unwrap_or(60_000))
}

#[tauri::command]
pub fn memory_job_cancel(state: tauri::State<'_, MemoryState>, job_id: String, lease_owner: String) -> AppResult<Value> {
    state.0.job_cancel(&job_id, &lease_owner)
}

#[tauri::command]
pub fn memory_job_resume(
    state: tauri::State<'_, MemoryState>,
    job_id: String,
    lease_owner: String,
) -> AppResult<Value> {
    state.0.job_resume(&job_id, &lease_owner)
}

#[tauri::command]
pub fn memory_job_sources(state: tauri::State<'_, MemoryState>, job_id: String) -> AppResult<Vec<Value>> {
    state.0.job_sources(&job_id)
}

#[tauri::command]
pub fn memory_source_evidence(state: tauri::State<'_, MemoryState>, source_id: String) -> AppResult<Option<Value>> {
    state.0.source_evidence(&source_id)
}

#[tauri::command]
pub fn memory_candidates_add(
    state: tauri::State<'_, MemoryState>,
    job_id: String,
    candidates: Vec<Value>,
) -> AppResult<usize> {
    state.0.candidates_add(&job_id, &candidates)
}

#[tauri::command]
pub fn memory_dreaming_budget_reserve(state: tauri::State<'_, MemoryState>, reservation_id: String, local_date: String, reserved_tokens: i64, daily_limit: i64) -> AppResult<bool> {
    state.0.reserve_dreaming_budget(&reservation_id, &local_date, reserved_tokens, daily_limit)
}

#[tauri::command]
pub fn memory_dreaming_budget_settle(state: tauri::State<'_, MemoryState>, reservation_id: String, local_date: String, reserved_tokens: i64, used_tokens: Option<i64>) -> AppResult<()> {
    state.0.settle_dreaming_budget(&reservation_id, &local_date, reserved_tokens, used_tokens)
}

#[tauri::command]
pub fn memory_dreaming_budget(state: tauri::State<'_, MemoryState>, local_date: String) -> AppResult<Value> {
    state.0.dreaming_budget(&local_date)
}

#[tauri::command]
pub fn memory_dreaming_commit(state: tauri::State<'_, MemoryState>, job_id: String, base_revision: i64) -> AppResult<i64> {
    state.0.commit_dreaming_job(&job_id, base_revision)
}

#[tauri::command]
pub fn memory_export(state: tauri::State<'_, MemoryState>) -> AppResult<String> {
    state.0.export()
}

#[tauri::command]
pub fn memory_backup(state: tauri::State<'_, MemoryState>) -> AppResult<String> {
    state.0.backup()
}

#[tauri::command]
pub fn memory_rebuild(state: tauri::State<'_, MemoryState>) -> AppResult<i64> {
    state.0.rebuild()
}

#[tauri::command]
pub fn memory_restore(
    state: tauri::State<'_, MemoryState>,
    paths: tauri::State<'_, crate::paths::AppPaths>,
    backup_path: String,
) -> AppResult<i64> {
    let resolved = managed_backup_path(&paths, &backup_path)?;
    state.0.restore(&resolved)
}

#[tauri::command]
pub fn memory_restore_preview(
    paths: tauri::State<'_, crate::paths::AppPaths>,
    backup_path: String,
) -> AppResult<Value> {
    let resolved = managed_backup_path(&paths, &backup_path)?;
    super::MemoryStore::restore_preview(&resolved)
}
