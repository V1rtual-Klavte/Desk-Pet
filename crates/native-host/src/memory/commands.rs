//! 记忆库的命令面：transport 无关的普通函数。
//!
//! 每个函数只做三件事：参数收窄、调用唯一 Store、把结果原样返回。
//! 业务规则一律留在 `store.rs`，命令层不复制第二份判定。
//! IPC 层只做参数提取后转发，不含业务判定。

use super::store::{
    JOB_LEASE_MS, JOB_LIST_LIMIT_DEFAULT, LIST_LIMIT_DEFAULT, QUERY_LIMIT_DEFAULT,
    RECALL_LIMIT_DEFAULT,
};
use super::conversation::ConversationIndexEntry;
use super::MemoryState;
use super::{ConversationClearFence, ConversationIndexBatch};
use crate::error::{AppError, AppResult};
// 窗口身份（label 字符串）的唯一定义点在 `host/mod.rs` 的 `WindowId`；这里的
// window_label 比较一律取 `WindowId::*.label()`，不写第二份字面量。
use crate::host::WindowId;
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

pub(crate) fn conversation_index_status(state: &MemoryState) -> AppResult<Value> {
    state.0.conversation_index_status()
}

pub(crate) fn conversation_index_replace(
    state: &MemoryState,
    session_id: String,
    fingerprint: String,
    expected_fingerprint: Option<String>,
    expected_forget_epoch: i64,
    entries: Value,
    batch: Option<Value>,
) -> AppResult<i64> {
    let entries: Vec<ConversationIndexEntry> = serde_json::from_value(entries)
        .map_err(|error| AppError::Config(format!("会话索引 entries 参数无效: {error}")))?;
    let batch: Option<ConversationIndexBatch> = batch
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| AppError::Config(format!("会话索引 batch 参数无效: {error}")))?;
    state.0.conversation_index_replace(
        &session_id,
        &fingerprint,
        expected_fingerprint.as_deref(),
        expected_forget_epoch,
        &entries,
        batch,
    )
}

pub(crate) fn conversation_index_prune(
    state: &MemoryState,
    session_ids: Vec<String>,
) -> AppResult<i64> {
    state.0.conversation_index_prune(&session_ids)
}

pub(crate) fn conversation_search(
    state: &MemoryState,
    query: String,
    session_id: String,
    limit: Option<i64>,
    before: Option<i64>,
    recent_fallback: Option<bool>,
) -> AppResult<Value> {
    state.0.conversation_search(
        &query,
        &session_id,
        limit,
        before,
        recent_fallback.unwrap_or(false),
    )
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
    conversation_fences: Option<Value>,
) -> AppResult<i64> {
    let conversation_fences: Option<Vec<ConversationClearFence>> = conversation_fences
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| AppError::Config(format!("conversationFences 参数无效: {error}")))?;
    match (action.as_str(), conversation_fences.as_ref()) {
        ("clear", Some(_)) => {}
        ("clear", None) => {
            return Err(AppError::Config("clear 操作缺少 conversationFences".into()))
        }
        (_, Some(_)) => {
            return Err(AppError::Config(
                "conversationFences 只允许用于 clear 操作".into(),
            ))
        }
        (_, None) => {}
    }
    let store_actor = match actor.as_str() {
        "current_input" if window_label == WindowId::Main.label() => "current_input",
        "user_ui" if window_label == WindowId::Settings.label() => "user_ui",
        "user_ui"
            if window_label == WindowId::Main.label()
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
            if window_label == WindowId::Main.label()
                || (cfg!(debug_assertions) && window_label == WindowId::E2e.label()) =>
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
        conversation_fences.as_deref(),
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

/// `origin` 过滤来源类别（用户事实 / 系统观察）：整理按类别开作业，不混池；
/// 缺省（None）= 两类都取（恢复旧作业用）。
pub fn memory_job_sources(
    state: &MemoryState,
    job_id: String,
    origin: Option<String>,
) -> AppResult<Vec<Value>> {
    state.0.job_sources(&job_id, origin.as_deref())
}

/// 开作业前的只读前置查询：水位之后是否已有待处理来源（与 `memory_job_sources` 同一水位判定）；
/// `origin` 过滤来源类别，缺省 = 两类合计。
pub fn memory_pending_source_count(state: &MemoryState, origin: Option<String>) -> AppResult<i64> {
    state.0.pending_source_count(origin.as_deref())
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

/// 登记一笔 dreaming token 预留：只记账，不再按日 token 总量准入（2026-10-06 用户裁决）。
pub fn memory_dreaming_budget_reserve(
    state: &MemoryState,
    reservation_id: String,
    local_date: String,
    reserved_tokens: i64,
) -> AppResult<()> {
    state
        .0
        .reserve_dreaming_budget(&reservation_id, &local_date, reserved_tokens)
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
