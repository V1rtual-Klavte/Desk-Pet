//! 记忆库的 Tauri 命令面。
//!
//! 每个命令只做三件事：参数收窄、调用唯一 Store、把结果原样返回。
//! 业务规则一律留在 `store.rs`，命令层不复制第二份判定。

use super::MemoryState;
use crate::error::AppResult;
use serde_json::Value;

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
pub fn memory_get_items(state: tauri::State<'_, MemoryState>, ids: Vec<String>) -> AppResult<Vec<Value>> {
    state.0.get_items(&ids)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn memory_apply_change(
    state: tauri::State<'_, MemoryState>,
    operation_id: String,
    base_revision: i64,
    action: String,
    item_id: Option<String>,
    expected_version: Option<i64>,
    draft: Option<Value>,
) -> AppResult<i64> {
    state.0.apply_change(
        &operation_id,
        base_revision,
        &action,
        item_id.as_deref(),
        expected_version,
        draft.as_ref(),
    )
}

#[tauri::command]
pub fn memory_job_start(state: tauri::State<'_, MemoryState>, phase: String, lease_owner: String) -> AppResult<Value> {
    state.0.job_start(&phase, &lease_owner)
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
pub fn memory_candidates_add(
    state: tauri::State<'_, MemoryState>,
    job_id: String,
    candidates: Vec<Value>,
) -> AppResult<usize> {
    state.0.candidates_add(&job_id, &candidates)
}

#[tauri::command]
pub fn memory_review_batch(state: tauri::State<'_, MemoryState>, job_id: String) -> AppResult<Vec<Value>> {
    state.0.review_batch(&job_id)
}

#[tauri::command]
pub fn memory_publish_batch(
    state: tauri::State<'_, MemoryState>,
    job_id: String,
    candidate_ids: Vec<String>,
    base_revision: i64,
) -> AppResult<i64> {
    state.0.publish_batch(&job_id, &candidate_ids, base_revision)
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
    let requested = std::path::Path::new(&backup_path);
    let backups = paths.memory.join("backups");
    let resolved = requested.canonicalize().map_err(|_| crate::error::AppError::PathNotFound(backup_path.clone()))?;
    let base = backups.canonicalize().map_err(|_| crate::error::AppError::PathNotFound(backups.to_string_lossy().to_string()))?;
    if !resolved.starts_with(&base) || resolved.is_dir() {
        return Err(crate::error::AppError::PathEscape);
    }
    state.0.restore(&resolved)
}
