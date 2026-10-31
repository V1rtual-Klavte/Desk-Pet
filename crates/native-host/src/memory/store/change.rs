//! 记忆写入：来源登记、草稿校验、显式治理变更与派生来源清除。

use super::super::ConversationClearFence;
use super::{
    b, db_err, event_at_projection, i, normalize_memory_text, now_ms, number, opt_s, rand_suffix,
    s, strings, MemoryStore, DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE, SUPERSEDES_MAX,
};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn stable_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        stable_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub(super) fn validate_draft(draft: &Value) -> AppResult<()> {
    let content = s(draft, "content");
    let kind = s(draft, "kind");
    let scope = s(draft, "scope");
    if content.trim().is_empty() {
        return Err(AppError::Memory("记忆正文不能为空".into()));
    }
    if !matches!(kind.as_str(), "fact" | "preference" | "episode" | "working") {
        return Err(AppError::Memory(format!("未知记忆类型: {kind}")));
    }
    if !matches!(scope.as_str(), "user" | "session") {
        return Err(AppError::Memory(format!("未知记忆范围: {scope}")));
    }
    if strings(draft, "sourceIds").is_empty() {
        return Err(AppError::Memory("记忆条目必须带来源".into()));
    }
    if kind == "working"
        && !matches!(
            s(draft, "workingState").as_str(),
            "open" | "completed" | "cancelled"
        )
    {
        return Err(AppError::Memory(
            "working 条目必须带 open/completed/cancelled 状态".into(),
        ));
    }
    if (kind != "working" && (draft.get("dueAt").is_some_and(|v| !v.is_null())
        || draft.get("workingState").is_some_and(|v| !v.is_null())))
        || (!matches!(kind.as_str(), "working" | "episode")
            && draft.get("eventAt").is_some_and(|v| !v.is_null()))
    {
        return Err(AppError::Memory("仅 episode/working 条目可带 eventAt，dueAt 和 workingState 仅适用于 working".into()));
    }
    for key in ["eventAt", "dueAt"] {
        if let Some(anchor) = draft.get(key).filter(|value| !value.is_null()) {
            let precision = anchor
                .get("precision")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let timezone = anchor
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let valid = !timezone.is_empty()
                && match precision {
                    "day" => anchor
                        .get("localDate")
                        .and_then(Value::as_str)
                        .is_some_and(|value| {
                            value.len() == 10
                                && value.as_bytes().get(4) == Some(&b'-')
                                && value.as_bytes().get(7) == Some(&b'-')
                        }),
                    "minute" => anchor.get("instant").and_then(Value::as_i64).is_some(),
                    _ => false,
                };
            if !valid {
                return Err(AppError::Memory(format!("{key} 的 day/minute 时间锚无效")));
            }
        }
    }
    // 合并候选的目标列表（dreaming 整理专属）：形状在此校验；范围/kind/来源类别与来源并集
    // 在发布事务里逐条复核（`apply_change` 会在写入前明确拒绝这一字段，不给静默忽略的机会）。
    if draft
        .get("supersedesIds")
        .is_some_and(|value| !value.is_null())
    {
        let shape_ok = draft
            .get("supersedesIds")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= SUPERSEDES_MAX
                    && items
                        .iter()
                        .all(|item| item.as_str().is_some_and(|id| !id.is_empty()))
            });
        if !shape_ok {
            return Err(AppError::Memory(format!(
                "supersedesIds 必须是非空、至多 {SUPERSEDES_MAX} 条的字符串数组"
            )));
        }
        let ids = strings(draft, "supersedesIds");
        let mut unique = std::collections::HashSet::new();
        if ids.iter().any(|id| !unique.insert(id.as_str())) {
            return Err(AppError::Memory("supersedesIds 不能包含重复条目".into()));
        }
        if draft
            .get("supersedesId")
            .is_some_and(|value| !value.is_null())
        {
            return Err(AppError::Memory(
                "合并候选不能同时携带 supersedesId 与 supersedesIds".into(),
            ));
        }
        if kind == "working" {
            return Err(AppError::Memory("working 事项不参与合并".into()));
        }
    }
    Ok(())
}

/// 派生来源清除的范围：全量（清行为画像）或只收静默了解沉淀（清静默了解）。
#[derive(Clone, Copy)]
enum DerivedForgetScope {
    All,
    Understanding,
}

/// 清除派生来源沉淀的记忆（与遗忘同一闭包口径）。`scope` 决定圈定的来源子集：
/// `All` = 全部 `origin='derived_behavior'` 来源（画像结论 + 静默了解观察）；
/// `Understanding` = 其中的 `entry_id` 以 `understanding:` 开头的来源（静默了解沉淀），
/// 画像结论（`conclusion:` 前缀）不在范围内。
///
/// 顺序固定为「先失效引用、再删数据」：
/// 1. 收集范围内的派生条目（含已 supersede 的历史版本）→ 失效主动侧对它们的引用；
/// 2. 对**范围内全部**派生来源写提取墓碑（不只被在库条目引用的那些）：
///    挡住评审期间 in-flight 候选的发布，也挡住同一文本的迟到回灌；
/// 3. 删引用范围内来源的 prepared 候选（与遗忘的候选口径一致）；
/// 4. 删条目（全版本）、来源关联与 FTS 行；
/// 5. 删已无引用的墓碑来源行；
/// 6. 推进 forget_epoch（在飞作业的发布复核因此拒绝）与 revision（运行侧刷新记忆投影）。
///
/// 返回失效的条目数；范围内没有任何数据时不动 epoch/revision（不做空转）。
/// `All` 由主动侧 `proactive_change` 的 `clearBehaviorSources` 事务调用（与任务/机会/尝试
/// 的按 kind 失效同一时刻发生），或计量升级的内部 forget_derived_behavior 动作调用；`Understanding` 由 `memory_apply_change` 的
/// `forget_understanding` 动作调用（清除静默了解）——两条入口共用这一份闭包实现，
/// 不在 Node 侧另造第二套清除链。
fn forget_derived_items_scoped_tx(
    tx: &Transaction<'_>,
    scope: DerivedForgetScope,
) -> AppResult<usize> {
    // 同一段圈定条件按使用处补别名前缀；reason 逐范围区分，便于墓碑溯源（过滤只看 effect）。
    let (source_filter, final_filter, reason) = match scope {
        DerivedForgetScope::All => (
            "s.origin='derived_behavior'",
            "origin='derived_behavior'",
            "behavior_clear",
        ),
        DerivedForgetScope::Understanding => (
            "s.origin='derived_behavior' AND s.entry_id LIKE 'understanding:%'",
            "origin='derived_behavior' AND entry_id LIKE 'understanding:%'",
            "understanding_clear",
        ),
    };
    let now = now_ms();
    let epoch = MemoryStore::meta(tx, "forget_epoch")? + 1;
    // 1. 范围内在库条目（active 与历史版本都算）：先失效主动侧引用。
    let mut item_ids: Vec<String> = Vec::new();
    {
        let mut statement = tx
            .prepare(&format!(
                "SELECT DISTINCT i.id FROM memory_items i WHERE EXISTS (\
                   SELECT 1 FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id \
                   WHERE l.item_id=i.id AND {source_filter})",
            ))
            .map_err(db_err)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        for row in rows {
            item_ids.push(row.map_err(db_err)?);
        }
    }
    for item_id in &item_ids {
        crate::proactive::store::invalidate_memory_closure_tx(tx, item_id)?;
    }
    // 2. 墓碑：覆盖范围内全部来源，发布复核与重新登记都会被拦下。
    tx.execute(
        &format!(
            "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
             SELECT s.session_id,s.entry_id,s.content_hash,'block_extraction',?3,?1,?2 FROM memory_sources s \
             WHERE {source_filter} ON CONFLICT DO NOTHING",
        ),
        params![epoch, now, reason],
    )
    .map_err(db_err)?;
    let remaining: i64 = tx
        .query_row(
            &format!("SELECT COUNT(*) FROM memory_sources WHERE {final_filter}"),
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if remaining == 0 && item_ids.is_empty() {
        return Ok(0);
    }
    // 3. 候选：引用范围内来源的评审产物一并删除。
    tx.execute(
        &format!(
            "DELETE FROM memory_candidates WHERE status='prepared' AND EXISTS (\
               SELECT 1 FROM json_each(memory_candidates.source_ids_json) c JOIN memory_sources s ON s.source_id=c.value \
               WHERE {source_filter})",
        ),
        [],
    )
    .map_err(db_err)?;
    // 4. 正文/关联/索引：条目连全部版本链删除。
    for item_id in &item_ids {
        tx.execute(
            "DELETE FROM memory_item_sources WHERE item_id=?1",
            [item_id],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM memory_items WHERE id=?1", [item_id])
            .map_err(db_err)?;
        tx.execute("DELETE FROM memory_fts WHERE item_id=?1", [item_id])
            .map_err(db_err)?;
    }
    // 5. 来源行：墓碑已写、且不再被任何条目引用时删除。
    tx.execute(
        &format!(
            "DELETE FROM memory_sources WHERE {final_filter} AND NOT EXISTS(\
               SELECT 1 FROM memory_item_sources keep WHERE keep.source_id=memory_sources.source_id)",
        ),
        [],
    )
    .map_err(db_err)?;
    // 6. 代际与版本。
    MemoryStore::bump(tx, "forget_epoch")?;
    MemoryStore::bump(tx, "revision")?;
    Ok(item_ids.len())
}

/// 清除行为画像时一并失效「系统观察」沉淀的记忆（画像结论 + 静默了解观察，全量范围）。
pub(crate) fn forget_derived_behavior_items_tx(tx: &Transaction<'_>) -> AppResult<usize> {
    forget_derived_items_scoped_tx(tx, DerivedForgetScope::All)
}

/// 清除静默了解时失效「了解观察」沉淀的记忆（画像结论不受影响；与清画像共用同一闭包实现）。
pub(crate) fn forget_understanding_items_tx(tx: &Transaction<'_>) -> AppResult<usize> {
    forget_derived_items_scoped_tx(tx, DerivedForgetScope::Understanding)
}

impl MemoryStore {
    pub(super) fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        let aliases: String = row.get(8)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "version": row.get::<_, i64>(1)?,
            "status": row.get::<_, String>(2)?,
            "draft": {
                "content": row.get::<_, String>(3)?,
                "summary": row.get::<_, String>(4)?,
                "kind": row.get::<_, String>(5)?,
                "scope": row.get::<_, String>(6)?,
                "scopeId": row.get::<_, Option<String>>(7)?,
                "aliases": serde_json::from_str::<Value>(&aliases).unwrap_or_else(|_| json!([])),
                "pinned": row.get::<_, i64>(9)? != 0,
                "importance": row.get::<_, f64>(10)?,
                "confidence": row.get::<_, f64>(11)?,
                "observedAt": row.get::<_, Option<i64>>(12)?,
                "validFrom": row.get::<_, Option<i64>>(13)?,
                "validTo": row.get::<_, Option<i64>>(14)?,
                "expiresAt": row.get::<_, Option<i64>>(15)?,
                "supersedesId": row.get::<_, Option<String>>(16)?,
                "sourceIds": [],
                "eventAt": row.get::<_, Option<String>>(19)?.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                "dueAt": row.get::<_, Option<String>>(20)?.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                "workingState": row.get::<_, Option<String>>(21)?,
            },
            "createdAt": row.get::<_, i64>(17)?,
            "updatedAt": row.get::<_, i64>(18)?,
        }))
    }

    pub(super) const ITEM_COLUMNS: &'static str = "i.id,i.version,i.status,i.content,i.summary,i.kind,i.scope,i.scope_id,\
        i.aliases_json,i.pinned,i.importance,i.confidence,i.observed_at,i.valid_from,i.valid_to,i.expires_at,\
        i.supersedes_id,i.created_at,i.updated_at,i.event_at_json,i.due_at_json,i.working_state";

    /// 条目来源类别：全部来源都是系统观察结论 → `derived_behavior`，否则 `user`。
    /// 混用（两类同一条目）在写入处已被拒绝，这里取保守值不掩盖问题。
    fn origin_from_source_origins(origins: &[String]) -> &'static str {
        if !origins.is_empty() && origins.iter().all(|origin| origin == "derived_behavior") {
            "derived_behavior"
        } else {
            "user"
        }
    }

    /// 读一组来源的类别（(含用户来源, 含系统观察来源)）；未登记来源如实报错——
    /// 候选/草稿的 provenance 只能来自已登记来源，不能凭空声明。
    fn source_classes(conn: &Connection, source_ids: &[String]) -> AppResult<(bool, bool)> {
        let mut has_user = false;
        let mut has_derived = false;
        for source_id in source_ids {
            let origin: Option<String> = conn
                .query_row(
                    "SELECT origin FROM memory_sources WHERE source_id=?1",
                    [source_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            match origin.as_deref() {
                Some("user") => has_user = true,
                Some("derived_behavior") => has_derived = true,
                Some(other) => {
                    return Err(AppError::Memory(format!(
                        "来源 {source_id} 的类别 {other} 不具备记忆资格"
                    )))
                }
                None => return Err(AppError::Memory(format!("来源未登记: {source_id}"))),
            }
        }
        Ok((has_user, has_derived))
    }

    /// 写入前的分池校验：两类来源不得混用；系统观察不进核心画像、不做 working 事项。
    pub(super) fn validate_source_pool(
        conn: &Connection,
        source_ids: &[String],
        pinned: bool,
        kind: &str,
    ) -> AppResult<&'static str> {
        let (has_user, has_derived) = Self::source_classes(conn, source_ids)?;
        if has_user && has_derived {
            return Err(AppError::Memory(
                "候选来源混用用户事实与系统观察：两类分区存放，不混池".into(),
            ));
        }
        let origin = if has_derived {
            "derived_behavior"
        } else {
            "user"
        };
        if origin == "derived_behavior" {
            if pinned {
                return Err(AppError::Memory("系统观察结论不进入核心画像".into()));
            }
            if kind == "working" {
                return Err(AppError::Memory("系统观察结论不能作为 working 事项".into()));
            }
        }
        Ok(origin)
    }

    /// 合并候选的目标解析（dreaming 发布专用）：逐个复核「仍在库、同 scope、同 kind、
    /// 未置顶」，返回 (条目 id, 其 active 版本)。来源类别与来源并集由调用处在同一事务里继续
    /// 校验 —— 目标失效（已被删除/覆盖）时如实报 MEMORY_CONFLICT，不做静默跳过。
    pub(super) fn merge_supersede_targets(
        conn: &Connection,
        draft: &Value,
        scope: &str,
        scope_id: Option<&str>,
        kind: &str,
    ) -> AppResult<Vec<(String, i64)>> {
        let mut targets = Vec::new();
        for id in strings(draft, "supersedesIds") {
            let row: Option<(String, String, Option<String>, i64, i64)> = conn
                .query_row(
                    "SELECT kind,scope,scope_id,pinned,version FROM memory_items WHERE id=?1 AND status='active'",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()
                .map_err(db_err)?;
            let (target_kind, target_scope, target_scope_id, target_pinned, target_version) =
                row.ok_or(AppError::MemoryConflict)?;
            if target_kind != kind
                || target_scope != scope
                || target_scope_id.as_deref() != scope_id
                || target_pinned != 0
            {
                return Err(AppError::Memory(
                    "合并候选的目标条目与候选不同范围或类型（或处于置顶状态）".into(),
                ));
            }
            targets.push((id, target_version));
        }
        Ok(targets)
    }

    /// 读某条在库条目（指定版本）的来源类别归属：用于「不跨来源类别改写」的守卫。
    pub(super) fn item_origin(conn: &Connection, item_id: &str, version: i64) -> AppResult<String> {
        let mut statement = conn
            .prepare(
                "SELECT s.origin FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id \
                 WHERE l.item_id=?1 AND l.item_version=?2",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map(params![item_id, version], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        let mut origins = Vec::new();
        for row in rows {
            origins.push(row.map_err(db_err)?);
        }
        Ok(Self::origin_from_source_origins(&origins).to_string())
    }

    /// 补齐每个条目的来源清单与来源类别：来源是「这条记忆从哪来」的唯一答案，
    /// 详情与列表都要带；类别（origin）由来源类别唯一派生，没有第二个存储位。
    pub(super) fn attach_sources(conn: &Connection, mut items: Vec<Value>) -> AppResult<Vec<Value>> {
        for item in &mut items {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let version = item.get("version").and_then(Value::as_i64).unwrap_or(1);
            let mut statement = conn
                .prepare(
                    "SELECT l.source_id,s.origin FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id \
                     WHERE l.item_id=?1 AND l.item_version=?2 ORDER BY l.source_id",
                )
                .map_err(db_err)?;
            let rows = statement
                .query_map(params![id, version], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_err)?;
            let mut sources = Vec::new();
            let mut origins = Vec::new();
            for row in rows {
                let (source_id, origin) = row.map_err(db_err)?;
                sources.push(source_id);
                origins.push(origin);
            }
            if let Some(draft) = item.get_mut("draft").and_then(Value::as_object_mut) {
                draft.insert("sourceIds".into(), json!(sources));
            }
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "origin".into(),
                    json!(Self::origin_from_source_origins(&origins)),
                );
            }
        }
        Ok(items)
    }

    /// 登记来源：只接受两类准入来源（用户本人可信输入 / 系统观察结论），
    /// 并且命中墓碑的事件直接拒收。重复登记是幂等的（同一 source_id 重复出现不新增行）。
    pub fn register_sources(&self, sources: &[Value]) -> AppResult<usize> {
        let conn = self.lock()?;
        let mut written = 0usize;
        for source in sources {
            let source_id = s(source, "sourceId");
            let origin = s(source, "origin");
            let taint = s(source, "taint");
            // 类别与 taint 必须成对：错配（例如 derived_behavior + trusted_user）不是
            // 「换个标签的用户事实」，直接拒收，不给静默归一化的机会。
            let admissible = (origin == "user" && taint == "trusted_user")
                || (origin == "derived_behavior" && taint == "derived");
            if source_id.is_empty() || !b(source, "eligibleForMemory") || !admissible {
                continue;
            }
            let session_id = s(source, "sessionId");
            let entry_id = s(source, "entryId");
            let event_id = opt_s(source, "eventId")
                .ok_or_else(|| AppError::Memory("来源缺少稳定 eventId".into()))?;
            let content_hash = s(source, "contentHash");
            let blocked: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM memory_tombstones WHERE session_id=?1 AND entry_id=?2 \
                     AND content_hash=?3 AND effect='block_extraction' LIMIT 1",
                    params![session_id, entry_id, content_hash],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if blocked.is_some() {
                continue;
            }
            written += conn
                .execute(
                    "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) \
                     ON CONFLICT(source_id) DO UPDATE SET evidence=excluded.evidence, card_id=excluded.card_id",
                    params![
                        source_id,
                        session_id,
                        entry_id,
                        event_id,
                        i(source, "seq").unwrap_or(0),
                        content_hash,
                        opt_s(source, "evidence"),
                        opt_s(source, "cardId"),
                        s(source, "taint"),
                        s(source, "origin"),
                        i(source, "observedAt").unwrap_or_else(now_ms),
                    ],
                )
                .map_err(db_err)?;
        }
        Ok(written)
    }

    /// 显式治理写入口：记住 / 更正 / 代替 / 遗忘 / 清空。
    pub fn apply_change(
        &self,
        operation_id: &str,
        base_revision: i64,
        action: &str,
        item_id: Option<&str>,
        expected_version: Option<i64>,
        draft: Option<&Value>,
    ) -> AppResult<i64> {
        self.apply_change_with_actor(
            operation_id,
            base_revision,
            action,
            item_id,
            expected_version,
            draft,
            "internal",
            None,
            None,
            None,
        )
    }

    pub(crate) fn apply_change_with_actor(
        &self,
        operation_id: &str,
        base_revision: i64,
        action: &str,
        item_id: Option<&str>,
        expected_version: Option<i64>,
        draft: Option<&Value>,
        actor: &str,
        trusted_user_event_id: Option<&str>,
        trusted_session_id: Option<&str>,
        conversation_fences: Option<&[ConversationClearFence]>,
    ) -> AppResult<i64> {
        let mut conn = self.lock()?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;

        // 幂等：这条操作已经提交过就直接回放它的结果，不重复写一遍。
        let prior: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT revision, forget_epoch FROM memory_operations WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        if let Some((revision, _)) = prior {
            return Ok(revision);
        }

        let revision = Self::meta(&transaction, "revision")?;
        if revision != base_revision {
            return Err(AppError::MemoryConflict);
        }
        if actor == "current_input" {
            let event_id = trusted_user_event_id
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("记忆变更缺少当前可信用户事件身份".into()))?;
            let valid: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM memory_sources WHERE event_id=?1 AND origin='user' AND taint='trusted_user')",[event_id],|row|row.get(0)).map_err(db_err)?;
            if !valid {
                return Err(AppError::Memory(
                    "当前可信用户事件尚未登记或不具备记忆资格".into(),
                ));
            }
        }
        if actor == "user_ui_current" {
            if action != "add" {
                return Err(AppError::Memory("聊天记住入口仅允许新增事实".into()));
            }
            let event_id = trusted_user_event_id
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("聊天记住缺少当前可信用户事件身份".into()))?;
            let session_id = trusted_session_id
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("聊天记住缺少当前会话身份".into()))?;
            let draft = draft.ok_or_else(|| AppError::Memory("聊天记住缺少记忆内容".into()))?;
            let source_ids = strings(draft, "sourceIds");
            if source_ids.len() != 1 {
                return Err(AppError::Memory("聊天记住只能绑定唯一可信来源".into()));
            }
            let source_id = &source_ids[0];
            let source: Option<(String, String, Option<String>)> = transaction.query_row(
                "SELECT s.session_id,s.content_hash,s.evidence FROM memory_sources s \
                 WHERE s.source_id=?1 AND s.event_id=?2 AND s.origin='user' AND s.taint='trusted_user' \
                 AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id \
                   AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
                params![source_id, event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional().map_err(db_err)?;
            let (source_session, content_hash, evidence) =
                source.ok_or_else(|| AppError::Memory("可信来源不存在或已被遗忘".into()))?;
            let evidence =
                evidence.ok_or_else(|| AppError::Memory("可信来源没有可用原话".into()))?;
            let mut hasher = Sha256::new();
            hasher.update(evidence.as_bytes());
            if source_session != session_id
                || format!("{:x}", hasher.finalize()) != content_hash
                || s(draft, "content") != evidence
            {
                return Err(AppError::Memory(
                    "聊天记住只能保存当前会话中的完整可信原话".into(),
                ));
            }
            match (
                s(draft, "scope").as_str(),
                opt_s(draft, "scopeId").as_deref(),
            ) {
                ("user", None) => {}
                _ => {
                    return Err(AppError::Memory(
                        "聊天记住只能保存用户范围的记忆".into(),
                    ))
                }
            }
        }
        let mut touched_version: Option<i64> = None;
        let mut touched_item: Option<String> = item_id.map(str::to_string);

        match action {
            "clear" => {
                let clear_cutoff = now_ms();
                transaction
                    .execute("DELETE FROM memory_fts", [])
                    .map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_item_sources", [])
                    .map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_items", [])
                    .map_err(db_err)?;
                // 清空挡住全部已知来源：不记录的话，补扫旧会话会把忘掉的内容重新填回来。
                let epoch = Self::meta(&transaction, "forget_epoch")? + 1;
                transaction
                    .execute(
                        "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                         SELECT session_id,entry_id,content_hash,'block_extraction','clear',?1,?2 FROM memory_sources \
                         WHERE true ON CONFLICT DO NOTHING",
                        params![epoch, clear_cutoff],
                    )
                    .map_err(db_err)?;
                Self::clear_conversation_index_tx(&transaction, clear_cutoff, conversation_fences)?;
                // 候选和来源证据也属于应用管理的记忆正文，清空后不能留在可读表里。
                transaction
                    .execute("DELETE FROM memory_candidates", [])
                    .map_err(db_err)?;
                crate::proactive::store::clear_memory_closure_tx(&transaction)?;
                transaction
                    .execute("DELETE FROM memory_sources", [])
                    .map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_watermarks", [])
                    .map_err(db_err)?;
                Self::bump(&transaction, "forget_epoch")?;
            }
            "forget" => {
                let id = touched_item
                    .clone()
                    .ok_or_else(|| AppError::Memory("遗忘必须指定条目 id".into()))?;
                let active: Option<i64> = transaction
                    .query_row(
                        "SELECT version FROM memory_items WHERE id=?1 AND status='active'",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(db_err)?;
                let version =
                    active.ok_or_else(|| AppError::Memory("该记忆条目不存在或已被遗忘".into()))?;
                touched_version = Some(version);
                let epoch = Self::meta(&transaction, "forget_epoch")? + 1;
                // 只抑制这条事实自己的来源事件，不牵连同一句话里的其它事实。
                transaction
                    .execute(
                        "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                         SELECT s.session_id,s.entry_id,s.content_hash,'block_extraction','forget',?1,?2 \
                         FROM memory_item_sources link JOIN memory_sources s ON s.source_id=link.source_id \
                         WHERE link.item_id=?3 ON CONFLICT DO NOTHING",
                        params![epoch, now_ms(), id],
                    )
                    .map_err(db_err)?;
                Self::suppress_conversation_source_tx(&transaction, &id)?;
                // 删除引用该事实来源的候选正文，独立来源的评审产物仍可继续审查。
                transaction.execute(
                    "DELETE FROM memory_candidates WHERE status='prepared' AND EXISTS (SELECT 1 FROM json_each(memory_candidates.source_ids_json) candidate_source JOIN memory_item_sources link ON link.source_id=candidate_source.value WHERE link.item_id=?1)",
                    [&id],
                ).map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_item_sources WHERE item_id=?1", [&id])
                    .map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_items WHERE id=?1", [&id])
                    .map_err(db_err)?;
                transaction
                    .execute("DELETE FROM memory_fts WHERE item_id=?1", [&id])
                    .map_err(db_err)?;
                crate::proactive::store::invalidate_memory_closure_tx(&transaction, &id)?;
                transaction.execute(
                    "DELETE FROM memory_sources WHERE EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=memory_sources.session_id AND t.entry_id=memory_sources.entry_id AND t.content_hash=memory_sources.content_hash AND t.effect='block_extraction' AND t.reason='forget') AND NOT EXISTS (SELECT 1 FROM memory_item_sources keep WHERE keep.source_id=memory_sources.source_id)",
                    [],
                ).map_err(db_err)?;
                Self::bump(&transaction, "forget_epoch")?;
            }
            "forget_understanding" | "forget_derived_behavior" => {
                // 静默了解只圈定 understanding:；计量升级撤销全部 derived_behavior。
                // 二者都保留用户事实，只接受内部治理 actor。
                if actor != "internal" {
                    return Err(AppError::Memory("撤销系统观察只接受内部治理 actor".into()));
                }
                if action == "forget_derived_behavior" {
                    forget_derived_behavior_items_tx(&transaction)?;
                } else {
                    forget_understanding_items_tx(&transaction)?;
                }
            }
            "add" | "update" | "supersede" | "complete" | "cancel" => {
                let draft = draft.ok_or_else(|| AppError::Memory("缺少记忆内容".into()))?;
                // 合并候选只走 dreaming 的发布事务（memory_dreaming_commit）；治理写入不接受
                // supersedesIds —— 明确拒绝而不是静默忽略，避免调用方以为合并已生效。
                if draft
                    .get("supersedesIds")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(AppError::Memory(
                        "合并候选只接受 dreaming 整理作业的发布路径".into(),
                    ));
                }
                validate_draft(draft)?;
                if actor == "current_input" || actor == "user_ui_current" {
                    let event_id = trusted_user_event_id
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            AppError::Memory("记忆变更缺少当前可信用户事件身份".into())
                        })?;
                    let owns_event = strings(draft, "sourceIds").into_iter().any(|source_id| {
                        transaction.query_row("SELECT 1 FROM memory_sources WHERE source_id=?1 AND event_id=?2 AND origin='user' AND taint='trusted_user'",params![source_id,event_id],|row|row.get::<_,i64>(0)).optional().ok().flatten().is_some()
                    });
                    if !owns_event {
                        return Err(AppError::Memory(
                            "记忆变更来源不属于当前可信用户事件".into(),
                        ));
                    }
                } else if actor != "user_ui" && actor != "internal" {
                    return Err(AppError::Memory("未知记忆治理 actor".into()));
                }
                if action == "complete" && s(draft, "workingState") != "completed" {
                    return Err(AppError::Memory(
                        "complete 操作必须将 workingState 设为 completed".into(),
                    ));
                }
                if action == "cancel" && s(draft, "workingState") != "cancelled" {
                    return Err(AppError::Memory(
                        "cancel 操作必须将 workingState 设为 cancelled".into(),
                    ));
                }
                let scope = s(draft, "scope");
                let scope_id = opt_s(draft, "scopeId");
                if scope == "user" && scope_id.is_some() {
                    return Err(AppError::Memory("user 范围的记忆不接受 scopeId".into()));
                }
                // 来源必须是已登记且未被墓碑拦下的事件：模型不能凭空声明 provenance。
                for source_id in strings(draft, "sourceIds") {
                    let known: Option<String> = transaction
                        .query_row(
                            "SELECT s.session_id FROM memory_sources s WHERE s.source_id=?1 AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
                            [&source_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(db_err)?;
                    if known.is_none() {
                        return Err(AppError::Memory(format!("来源未登记: {source_id}")));
                    }
                }
                // 来源分池：条目类别由来源类别唯一派生；混用与越界（核心画像 / working）拒绝。
                let source_ids = strings(draft, "sourceIds");
                let item_origin = Self::validate_source_pool(
                    &transaction,
                    &source_ids,
                    b(draft, "pinned"),
                    &s(draft, "kind"),
                )?;

                let id = touched_item
                    .clone()
                    .unwrap_or_else(|| format!("mem-{}-{}", now_ms(), rand_suffix()));
                touched_item = Some(id.clone());
                // 旧版本关闭与新版本生效必须落在同一时点，否则更正的记忆会出现
                // 「旧值仍有效」或「新值尚未生效」的空档。
                let now = now_ms();
                let version = match action {
                    "add" => 1,
                    _ => {
                        let active: Option<(i64, String, Option<String>)> = transaction
                            .query_row(
                                "SELECT version, scope, scope_id FROM memory_items WHERE id=?1 AND status='active'",
                                [&id],
                                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                            )
                            .optional()
                            .map_err(db_err)?;
                        let (current, current_scope, current_scope_id) = active
                            .ok_or_else(|| AppError::Memory("目标记忆不存在或已失效".into()))?;
                        if expected_version.is_some_and(|expected| expected != current) {
                            return Err(AppError::MemoryConflict);
                        }
                        if current_scope != scope
                            || current_scope_id.as_deref() != scope_id.as_deref()
                        {
                            return Err(AppError::Memory("更正的记忆不能跨范围改归属".into()));
                        }
                        // 不跨来源类别改写：系统观察不能被用户事实「顺手升级」，反之亦然。
                        let current_origin = Self::item_origin(&transaction, &id, current)?;
                        if current_origin != item_origin {
                            return Err(AppError::Memory(
                                "记忆条目不能跨来源类别改写（系统观察与用户事实分池）".into(),
                            ));
                        }
                        transaction
                            .execute(
                                "UPDATE memory_items SET status='superseded',updated_at=?2,valid_to=?2 WHERE id=?1 AND status='active'",
                                params![id, now],
                            )
                            .map_err(db_err)?;
                        if matches!(action, "complete" | "cancel") {
                            crate::proactive::store::finish_working_closure_tx(
                                &transaction,
                                &id,
                                &s(draft, "workingState"),
                            )?;
                        } else {
                            crate::proactive::store::invalidate_memory_closure_tx(
                                &transaction,
                                &id,
                            )?;
                        }
                        current + 1
                    }
                };
                touched_version = Some(version);
                let aliases = serde_json::to_string(draft.get("aliases").unwrap_or(&json!([])))
                    .map_err(|e| AppError::Memory(e.to_string()))?;
                transaction
                    .execute(
                    "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state,event_at_ms,event_at_date,content_norm,summary_norm,aliases_norm) \
                         VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
                        params![
                            id,
                            version,
                            s(draft, "content"),
                            s(draft, "summary"),
                            s(draft, "kind"),
                            scope,
                            scope_id,
                            aliases,
                            b(draft, "pinned") as i64,
                            number(draft, "importance", DEFAULT_IMPORTANCE),
                            number(draft, "confidence", DEFAULT_CONFIDENCE),
                            i(draft, "observedAt").unwrap_or(now),
                            draft
                                .get("validFrom")
                                .and_then(Value::as_i64)
                                .or_else(|| (action != "add").then_some(now)),
                            draft.get("validTo").and_then(Value::as_i64),
                            draft.get("expiresAt").and_then(Value::as_i64),
                            draft.get("supersedesId").and_then(Value::as_str).or_else(|| if action == "add" { None } else { Some(id.as_str()) }),
                            now,
                            draft.get("eventAt").filter(|value| !value.is_null()).map(Value::to_string),
                            draft.get("dueAt").filter(|value| !value.is_null()).map(Value::to_string),
                            opt_s(draft, "workingState"),
                            event_at_projection(draft.get("eventAt").filter(|value| !value.is_null())).0,
                            event_at_projection(draft.get("eventAt").filter(|value| !value.is_null())).1,
                            normalize_memory_text(&s(draft, "content")),
                            normalize_memory_text(&s(draft, "summary")),
                            normalize_memory_text(&aliases),
                        ],
                    )
                    .map_err(db_err)?;
                for source_id in strings(draft, "sourceIds") {
                    transaction
                        .execute(
                            "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                            params![id, version, source_id],
                        )
                        .map_err(db_err)?;
                }
                transaction
                    .execute(
                        "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",
                        params![id, version, normalize_memory_text(&s(draft, "content")), normalize_memory_text(&s(draft, "summary")), normalize_memory_text(&aliases)],
                    )
                    .map_err(db_err)?;
            }
            other => return Err(AppError::Memory(format!("未知记忆操作: {other}"))),
        }

        let new_revision = Self::bump(&transaction, "revision")?;
        let epoch = Self::meta(&transaction, "forget_epoch")?;
        transaction
            .execute(
                "INSERT INTO memory_operations(operation_id,action,item_id,item_version,revision,forget_epoch,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![operation_id, action, touched_item, touched_version, new_revision, epoch, now_ms()],
            )
            .map_err(db_err)?;
        transaction.commit().map_err(db_err)?;
        Ok(new_revision)
    }
}
