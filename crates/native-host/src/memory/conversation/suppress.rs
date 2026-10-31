//! 会话索引的遗忘闭包：来源抑制、引用清理与清空栅栏。

use super::{now_ms, valid_id, ConversationClearFence, SESSION_ID_MAX};
use crate::error::{AppError, AppResult};
use crate::memory::store::db_err;
use crate::memory::MemoryStore;
use rusqlite::{params, Connection, Transaction};

/// `e` 是待检索/删除的条目，`s` 是遗忘来源身份；助手只按已冻结的可信用户锚点关联。
pub(super) const SUPPRESSION_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_suppressions s
  WHERE s.session_id=e.session_id AND (
    e.entry_id=s.entry_id OR e.event_id=s.event_id
    OR (e.role='assistant' AND (e.anchor_entry_id=s.entry_id OR e.anchor_event_id=s.event_id))
  )
)";

/// 回复引用过的事实条目已不存在：它只是旧事实的转述，不能再作为原文证据被召回。
/// JSONL 正文不动，遗忘只改变召回；同一 id 恢复后自动重新可见。
pub(super) const STALE_MEMORY_REF_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_refs r
  LEFT JOIN memory_items i ON i.id=r.item_id
  WHERE r.session_id=e.session_id AND r.entry_id=e.entry_id AND i.id IS NULL
)";

/// `MEMORY_READING_POLICY` 中的更正规则需要召回侧配合：旧值的用户原话来源、以及同一轮
/// 助手转述，在条目被内容或时间不同的活动版本取代后不再作为证据出现。JSONL 正文不动。
pub(super) const SUPERSEDED_SOURCE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM memory_item_sources l
  JOIN memory_sources s ON s.source_id=l.source_id AND s.origin='user'
  JOIN memory_items old ON old.id=l.item_id AND old.version=l.item_version
  JOIN memory_items cur ON cur.id=l.item_id AND cur.status='active' AND cur.version>l.item_version
  WHERE s.session_id=e.session_id AND (
    e.entry_id=s.entry_id OR e.event_id=s.event_id
    OR (e.role='assistant' AND (e.anchor_entry_id=s.entry_id OR e.anchor_event_id=s.event_id))
  )
  AND (
    old.content_norm IS NOT cur.content_norm
    OR old.summary_norm IS NOT cur.summary_norm
    OR old.due_at_json IS NOT cur.due_at_json
    OR old.event_at_json IS NOT cur.event_at_json
    OR old.expires_at IS NOT cur.expires_at
  )
)";

/// 助手回复引用过某条目，但生成时的活动版本与当前活动值不同：这是旧值转述。
/// 按 valid_from/valid_to 判定生成时的版本，纠正后产生的新转述不受影响。
pub(super) const STALE_CITATION_VALUE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_refs r
  JOIN memory_items cur ON cur.id=r.item_id AND cur.status='active'
  JOIN memory_items cited ON cited.id=r.item_id AND cited.version<=cur.version
  WHERE r.session_id=e.session_id AND r.entry_id=e.entry_id AND e.role='assistant'
    AND (cited.valid_from IS NULL OR cited.valid_from<=e.timestamp)
    AND (cited.valid_to IS NULL OR e.timestamp<cited.valid_to)
    AND (
      cited.content_norm IS NOT cur.content_norm
      OR cited.summary_norm IS NOT cur.summary_norm
      OR cited.due_at_json IS NOT cur.due_at_json
      OR cited.event_at_json IS NOT cur.event_at_json
      OR cited.expires_at IS NOT cur.expires_at
    )
)";

/// 助手回复在生成时渲染过的一条会话原文后来被遗忘，或该原文所属的记忆版本被更正：
/// 这条回复只是旧来源的转述，不能再作为原文证据被召回。JSONL 正文不动，同一来源恢复/更正
/// 回来前保持不可见；跨会话引用同样适用。
pub(super) const STALE_QUOTE_SOURCE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_quote_refs q
  WHERE q.session_id=e.session_id AND q.entry_id=e.entry_id AND e.role='assistant'
    AND (
      EXISTS (
        SELECT 1 FROM memory_tombstones t
        WHERE t.session_id=q.source_session_id AND t.entry_id=q.source_entry_id
          AND t.effect='block_extraction'
      )
      OR EXISTS (
        SELECT 1 FROM memory_item_sources l
        JOIN memory_sources s ON s.source_id=l.source_id AND s.origin='user'
        JOIN memory_items old ON old.id=l.item_id AND old.version=l.item_version
        JOIN memory_items cur ON cur.id=l.item_id AND cur.status='active' AND cur.version>l.item_version
        WHERE s.session_id=q.source_session_id AND s.entry_id=q.source_entry_id
          AND (
            old.content_norm IS NOT cur.content_norm
            OR old.summary_norm IS NOT cur.summary_norm
            OR old.due_at_json IS NOT cur.due_at_json
            OR old.event_at_json IS NOT cur.event_at_json
            OR old.expires_at IS NOT cur.expires_at
          )
      )
    )
)";

/// 在当前事务里依据持久身份抑制已忘来源及其同一轮助手回应。
pub(super) fn delete_suppressed_session_tx(tx: &Transaction<'_>, session_id: &str) -> AppResult<usize> {
    let sql = format!(
        "DELETE FROM conversation_index_entries AS e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS}"
    );
    let suppressed = tx.execute(&sql, [session_id]).map_err(db_err)?;
    delete_orphan_entry_refs(tx, Some(session_id))?;
    if suppressed > 0 {
        MemoryStore::rebuild_conversation_terms(tx, session_id)?;
    }
    Ok(suppressed)
}

/// 删除已没有对应索引片段的引用行：片段被抑制/裁剪后，溯源不能继续挂在不存在的内容上。
fn delete_orphan_entry_refs(conn: &Connection, session_id: Option<&str>) -> AppResult<usize> {
    let sql = "DELETE FROM conversation_index_entry_refs AS r WHERE NOT EXISTS (
        SELECT 1 FROM conversation_index_entries e
        WHERE e.session_id=r.session_id AND e.entry_id=r.entry_id
    )";
    let removed = match session_id {
        Some(session_id) => conn
            .execute(&format!("{sql} AND r.session_id=?1"), [session_id])
            .map_err(db_err)?,
        None => conn.execute(sql, []).map_err(db_err)?,
    };
    let quote_sql = "DELETE FROM conversation_index_entry_quote_refs AS q WHERE NOT EXISTS (
        SELECT 1 FROM conversation_index_entries e
        WHERE e.session_id=q.session_id AND e.entry_id=q.entry_id
    )";
    match session_id {
        Some(session_id) => conn.execute(&format!("{quote_sql} AND q.session_id=?1"), [session_id]),
        None => conn.execute(quote_sql, []),
    }
    .map_err(db_err)?;
    Ok(removed)
}

/// Recreate derived conversation suppression identities from durable extraction tombstones,
/// then remove cached user/anchored-assistant fragments those tombstones forbid.
pub(in crate::memory) fn reconcile_conversation_suppressions(conn: &Connection) -> AppResult<usize> {
    conn.execute(
        "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at)
         SELECT session_id,entry_id,'',0,MAX(created_at) FROM memory_tombstones
         WHERE effect='block_extraction'
         GROUP BY session_id,entry_id ON CONFLICT DO NOTHING",
        [],
    )
    .map_err(db_err)?;
    let delete_fts_sql = format!(
        "DELETE FROM conversation_fts WHERE rowid IN (
           SELECT e.rowid FROM conversation_index_entries e WHERE {SUPPRESSION_EXISTS}
         )"
    );
    conn.execute(&delete_fts_sql, []).map_err(db_err)?;
    let delete_entries_sql =
        format!("DELETE FROM conversation_index_entries AS e WHERE {SUPPRESSION_EXISTS}");
    let removed = conn.execute(&delete_entries_sql, []).map_err(db_err)?;
    delete_orphan_entry_refs(conn, None)?;
    if removed > 0 {
        conn.execute("DELETE FROM conversation_index_terms", [])
            .map_err(db_err)?;
        let sessions = {
            let mut statement = conn
                .prepare("SELECT DISTINCT session_id FROM conversation_index_entries")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        for session_id in sessions {
            MemoryStore::rebuild_conversation_terms(conn, &session_id)?;
        }
        conn.execute(
            "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
            [],
        )
        .map_err(db_err)?;
    }
    Ok(removed)
}

pub(in crate::memory) fn conversation_suppressions_need_repair(conn: &Connection) -> AppResult<bool> {
    let ready: bool = conn
        .query_row(
            "SELECT COUNT(*)=3 FROM sqlite_master WHERE type='table' AND name IN
             ('memory_tombstones','conversation_index_suppressions','conversation_index_entries')",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if !ready {
        return Ok(false);
    }
    let missing_identity: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM memory_tombstones t
               WHERE t.effect='block_extraction'
                 AND NOT EXISTS(SELECT 1 FROM conversation_index_suppressions s
                   WHERE s.session_id=t.session_id AND s.entry_id=t.entry_id)
             )",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if missing_identity {
        return Ok(true);
    }
    let stale_entries_sql = format!(
        "SELECT EXISTS(SELECT 1 FROM conversation_index_entries e WHERE {SUPPRESSION_EXISTS})"
    );
    conn.query_row(&stale_entries_sql, [], |row| row.get(0))
        .map_err(db_err)
}

impl MemoryStore {
    /// Called inside `memory_apply_change`'s existing forget transaction before sources are deleted.
    pub(in crate::memory) fn suppress_conversation_source_tx(
        tx: &Transaction<'_>,
        item_id: &str,
    ) -> AppResult<usize> {
        tx.execute(
            "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at)
             SELECT DISTINCT s.session_id,s.entry_id,s.event_id,s.seq,?2
             FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id
             WHERE l.item_id=?1 ON CONFLICT DO NOTHING",
            params![item_id, now_ms()],
        )
        .map_err(db_err)?;
        // Any in-flight snapshot captured the pre-forget eligibility epoch; discard it immediately.
        tx.execute("DELETE FROM conversation_index_staging_batches", [])
            .map_err(db_err)?;
        let sessions = {
            let mut statement = tx
                .prepare("SELECT DISTINCT session_id FROM conversation_index_suppressions WHERE session_id IN (SELECT session_id FROM conversation_index_entries)")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        let mut deleted = 0usize;
        for session_id in sessions {
            let delete_fts_sql = format!(
                "DELETE FROM conversation_fts WHERE rowid IN (SELECT e.rowid FROM conversation_index_entries e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS})"
            );
            tx.execute(&delete_fts_sql, [&session_id]).map_err(db_err)?;
            let delete_entries_sql = format!(
                "DELETE FROM conversation_index_entries AS e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS}"
            );
            let removed = tx
                .execute(&delete_entries_sql, [&session_id])
                .map_err(db_err)?;
            delete_orphan_entry_refs(tx, Some(&session_id))?;
            if removed > 0 {
                Self::rebuild_conversation_terms(tx, &session_id)?;
            }
            deleted += removed;
        }
        if deleted > 0 {
            tx.execute(
                "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
                [],
            )
            .map_err(db_err)?;
        }
        Ok(deleted)
    }

    /// Clear cached rows and persist the authoritative session-sequence inventory in one transaction.
    pub(in crate::memory) fn clear_conversation_index_tx(
        tx: &Transaction<'_>,
        cutoff: i64,
        inventory: Option<&[ConversationClearFence]>,
    ) -> AppResult<()> {
        let fences = inventory.unwrap_or_default();
        let mut unique = std::collections::HashSet::with_capacity(fences.len());
        for fence in fences {
            valid_id(
                &fence.session_id,
                "conversationFence.sessionId",
                SESSION_ID_MAX,
            )?;
            if fence.max_seq < -1 || !unique.insert(fence.session_id.as_str()) {
                return Err(AppError::Memory(
                    "conversationFences 含重复 session 或无效 maxSeq".into(),
                ));
            }
        }
        // Indexed rows provide a local safety fence for direct Rust callers and partial history inventories.
        tx.execute(
            "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at)
             SELECT session_id,MAX(seq),?1 FROM conversation_index_entries WHERE true GROUP BY session_id
             ON CONFLICT(session_id) DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),created_at=excluded.created_at",
            [cutoff],
        )
        .map_err(db_err)?;
        for fence in fences {
            tx.execute(
                "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at) VALUES (?1,?2,?3)
                 ON CONFLICT(session_id) DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),created_at=excluded.created_at",
                params![fence.session_id, fence.max_seq, cutoff],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM conversation_fts", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_terms", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entry_refs", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entry_quote_refs", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entries", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_sessions", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_staging_batches", [])
            .map_err(db_err)?;
        tx.execute(
            "UPDATE conversation_index_meta SET revision=revision+1,clear_cutoff=MAX(clear_cutoff,?1),clear_inventory_complete=?2 WHERE id=1",
            params![cutoff, i64::from(inventory.is_some())],
        )
        .map_err(db_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use super::*;
    use serde_json::json;

    #[test]
    fn forget_suppresses_source_and_same_turn_assistant_across_rebuild() {
        let fixture = Fixture::new();
        let source = json!({
            "sourceId":"src-u1","sessionId":"s1","entryId":"u1","eventId":"u1:user",
            "seq":1,"contentHash":"hash-u1","evidence":"我喜欢咖啡","eligibleForMemory":true,
            "taint":"trusted_user","origin":"user","observedAt":1700000000001i64
        });
        fixture
            .1
            .register_sources(&[source])
            .expect("register source");
        fixture.1.apply_change("add-u1", 0, "add", None, None, Some(&json!({
            "content":"我喜欢咖啡","summary":"我喜欢咖啡","kind":"fact","scope":"user","aliases":[],
            "pinned":false,"importance":5.0,"confidence":0.9,"sourceIds":["src-u1"]
        }))).expect("add fact");
        let rows = vec![
            entry("u1", Some("u1:user"), 1, "user", "我喜欢咖啡", None),
            entry(
                "a1",
                Some("a1:assistant"),
                2,
                "assistant",
                "咖啡适合手冲",
                Some("u1"),
            ),
            entry(
                "active-1",
                Some("active-1:assistant"),
                3,
                "assistant",
                "活动提醒内容",
                None,
            ),
        ];
        fixture.replace("s1", "fp1", None, rows.clone(), 0);
        let revision = fixture.1.status().expect("memory status").revision;
        fixture
            .1
            .apply_change("forget-u1", revision, "forget", Some("mem-1"), None, None)
            .expect_err("must target actual fact id");
        let fact_id = fixture.1.list(None, None, 10).expect("list")[0]["id"]
            .as_str()
            .expect("id")
            .to_string();
        let revision = fixture.1.status().expect("memory status").revision;
        fixture
            .1
            .apply_change(
                "forget-u1-real",
                revision,
                "forget",
                Some(&fact_id),
                None,
                None,
            )
            .expect("forget fact");
        assert_eq!(
            fixture
                .1
                .conversation_search("咖啡", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("search after forget")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let active = fixture
            .1
            .conversation_search("活动提醒", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("unanchored active assistant survives forget");
        assert_eq!(active["entries"].as_array().unwrap().len(), 1);
        assert_eq!(active["entries"][0]["entryId"], "active-1");

        let status = fixture.1.conversation_index_status().expect("index status");
        let epoch = status["forgetEpoch"].as_i64().expect("forget epoch");
        let expected = status["sessions"][0]["fingerprint"].as_str();
        fixture.replace("s1", "fp2", expected, rows, epoch);
        assert_eq!(
            fixture
                .1
                .conversation_search("咖啡", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("search after rebuild")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn forgetting_a_cited_fact_hides_the_assistant_paraphrase_but_keeps_user_restatement() {
        let fixture = Fixture::new();
        seed_fact(&fixture, "mem-allergy");
        let user = entry(
            "u1",
            Some("u1:user"),
            1,
            "user",
            "我对花生过敏，别再推荐花生零食",
            None,
        );
        let mut cited = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        cited.memory_refs = vec!["mem-allergy".into()];
        let uncited = entry(
            "a2",
            Some("a2:assistant"),
            3,
            "assistant",
            "花生属于坚果",
            Some("u1"),
        );
        fixture.replace("s1", "fp1", None, vec![user, cited, uncited], 0);

        let before = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search before forget");
        assert!(
            before["entries"].as_array().unwrap().iter().any(|row| row["entryId"] == "a1"),
            "the citation is live while the cited fact exists"
        );

        drop_fact(&fixture, "mem-allergy");
        let after = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after forget");
        let ids = after["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["entryId"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(!ids.contains(&"a1"), "a stale paraphrase leaves recall");
        assert!(ids.contains(&"u1"), "the user's own restatement remains primary evidence");
        assert!(ids.contains(&"a2"), "uncited replies stay eligible");

        let context = fixture
            .1
            .conversation_context("s1", "a1", None, Some(10), None)
            .expect("context after forget");
        assert!(
            context["entries"].as_array().unwrap().is_empty(),
            "a stale reply cannot be read back as context evidence"
        );
    }

    #[test]
    fn stale_citation_survives_reindex_and_restoring_the_item_id_revives_the_reply() {
        let fixture = Fixture::new();
        seed_fact(&fixture, "mem-allergy");
        let user = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        let mut cited = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        cited.memory_refs = vec!["mem-allergy".into()];
        fixture.replace("s1", "fp1", None, vec![user.clone(), cited.clone()], 0);
        drop_fact(&fixture, "mem-allergy");

        // Reindexing the same JSONL must preserve the citation and keep the paraphrase excluded.
        fixture.replace("s1", "fp2", Some("fp1"), vec![user, cited], 0);
        let reindexed = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after reindex");
        assert!(reindexed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["entryId"] != "a1"));

        // The same item id restored (e.g. re-extracted later) makes the preserved reply recallable again.
        seed_fact(&fixture, "mem-allergy");
        let restored = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after restore");
        assert!(restored["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["entryId"] == "a1"));
    }

    #[test]
    fn correcting_a_value_hides_the_superseded_quote_and_its_same_turn_paraphrase() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-roast", "s1", "u1", "u1:user", "咖啡喜欢浅烘");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我咖啡喜欢浅烘", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你喜欢浅烘",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-roast".into()];
        let mut u2 = entry("u2", Some("u2:user"), 3, "user", "不对 现在改喝深烘了", None);
        u2.timestamp = 1_700_000_000_900;
        let mut a2 = entry(
            "a2",
            Some("a2:assistant"),
            4,
            "assistant",
            "好 深烘",
            Some("u2"),
        );
        a2.timestamp = 1_700_000_001_100;
        a2.memory_refs = vec!["mem-roast".into()];
        fixture.replace("s1", "fp1", None, vec![u1, a1, u2, a2], 0);

        let before = search_entry_ids(&fixture, "浅烘", "s1");
        assert!(before.contains(&"u1".to_string()) && before.contains(&"a1".to_string()));

        supersede_fact(
            &fixture,
            "mem-roast",
            1_700_000_001_000,
            "咖啡喜欢深烘",
            Some(("s1", "u2", "u2:user")),
        );

        assert!(
            search_entry_ids(&fixture, "浅烘", "s1").is_empty(),
            "the superseded quote and its paraphrase leave recall"
        );
        let fresh = search_entry_ids(&fixture, "深烘", "s1");
        assert!(fresh.contains(&"u2".to_string()) && fresh.contains(&"a2".to_string()));
        let context = fixture
            .1
            .conversation_context("s1", "a1", None, Some(10), None)
            .expect("context after correction");
        assert!(context["entries"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_cited_paraphrase_from_another_turn_leaves_recall_after_the_value_changes() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-allergy", "s1", "u1", "u1:user", "对花生过敏");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-allergy".into()];
        let mut u3 = entry("u3", Some("u3:user"), 3, "user", "今天吃了点东西", None);
        u3.timestamp = 1_700_000_000_200;
        let mut a3 = entry(
            "a3",
            Some("a3:assistant"),
            4,
            "assistant",
            "你对花生过敏 别碰花生",
            Some("u3"),
        );
        a3.timestamp = 1_700_000_000_300;
        a3.memory_refs = vec!["mem-allergy".into()];
        let mut u2 = entry(
            "u2",
            Some("u2:user"),
            5,
            "user",
            "其实不是花生 是杏仁",
            None,
        );
        u2.timestamp = 1_700_000_000_900;
        fixture.replace("s1", "fp1", None, vec![u1, a1, u3, a3, u2], 0);

        let before = search_entry_ids(&fixture, "花生", "s1");
        assert!(before.contains(&"a3".to_string()));

        supersede_fact(
            &fixture,
            "mem-allergy",
            1_700_000_001_000,
            "对杏仁过敏",
            Some(("s1", "u2", "u2:user")),
        );

        let after = search_entry_ids(&fixture, "花生", "s1");
        assert!(!after.contains(&"u1".to_string()), "superseded source leaves");
        assert!(!after.contains(&"a1".to_string()), "same-turn paraphrase leaves");
        assert!(
            !after.contains(&"a3".to_string()),
            "a paraphrase citing the old value from another turn leaves"
        );
        assert!(after.contains(&"u2".to_string()), "the correction itself remains");
    }

    #[test]
    fn pin_only_updates_keep_quotes_and_citations_visible() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-allergy", "s1", "u1", "u1:user", "对花生过敏");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-allergy".into()];
        let mut u3 = entry("u3", Some("u3:user"), 3, "user", "今天吃了点东西", None);
        u3.timestamp = 1_700_000_000_200;
        let mut a3 = entry(
            "a3",
            Some("a3:assistant"),
            4,
            "assistant",
            "你对花生过敏 别碰花生",
            Some("u3"),
        );
        a3.timestamp = 1_700_000_000_300;
        a3.memory_refs = vec!["mem-allergy".into()];
        fixture.replace("s1", "fp1", None, vec![u1, a1, u3, a3], 0);

        supersede_fact(&fixture, "mem-allergy", 1_700_000_001_000, "对花生过敏", None);

        let after = search_entry_ids(&fixture, "花生", "s1");
        assert!(after.contains(&"u1".to_string()));
        assert!(after.contains(&"a1".to_string()));
        assert!(after.contains(&"a3".to_string()));
    }

    #[test]
    fn forgetting_a_rendered_quote_source_hides_the_cross_session_paraphrase() {
        let fixture = Fixture::new();
        let source = entry(
            "src-1",
            Some("src-1:user"),
            1,
            "user",
            "我喜欢乌龙茶",
            None,
        );
        fixture.replace("source-session", "fp-source", None, vec![source], 0);
        let ask = entry("ask-1", Some("ask-1:user"), 1, "user", "我上次说喜欢什么茶", None);
        let mut reply = entry(
            "reply-1",
            Some("reply-1:assistant"),
            2,
            "assistant",
            "你说过喜欢乌龙茶",
            Some("ask-1"),
        );
        reply.quote_refs = vec![ConversationQuoteRef {
            session_id: "source-session".into(),
            entry_id: "src-1".into(),
        }];
        fixture.replace(
            "target-session",
            "fp-target",
            None,
            vec![ask.clone(), reply.clone()],
            0,
        );
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        {
            let conn = fixture.1.lock().expect("memory lock");
            conn.execute(
                "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at)
                 VALUES ('source-session','src-1','hash','block_extraction',NULL,0,1)",
                [],
            )
            .expect("seed forget tombstone");
            // 真实 forget 在同一事务里同时回填 suppression 并删除来源片段；只写墓碑时
            // 来源原文仍会作为跨会话命中返回，掩盖回复是否被 quote 闭包挡住。
            reconcile_conversation_suppressions(&conn).expect("reconcile forget suppressions");
        }
        assert!(
            search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty(),
            "the uncited cross-session paraphrase leaves recall with its forgotten source"
        );

        // Re-indexing the same JSONL preserves quote refs and keeps the reply excluded.
        fixture.replace(
            "target-session",
            "fp-target-2",
            Some("fp-target"),
            vec![ask, reply],
            0,
        );
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty());
    }

    #[test]
    fn correcting_a_rendered_quote_source_hides_the_cross_session_paraphrase() {
        let fixture = Fixture::new();
        seed_sourced_fact(
            &fixture,
            "mem-tea",
            "source-session",
            "src-1",
            "src-1:user",
            "喜欢乌龙茶",
        );
        let mut source = entry(
            "src-1",
            Some("src-1:user"),
            1,
            "user",
            "我平时喜欢乌龙茶",
            None,
        );
        source.timestamp = 1_700_000_000_000;
        fixture.replace("source-session", "fp-source", None, vec![source], 0);
        let mut ask = entry("ask-1", Some("ask-1:user"), 1, "user", "我平时喝什么茶", None);
        ask.timestamp = 1_700_000_000_200;
        let mut reply = entry(
            "reply-1",
            Some("reply-1:assistant"),
            2,
            "assistant",
            "你平时喜欢乌龙茶",
            Some("ask-1"),
        );
        reply.timestamp = 1_700_000_000_300;
        reply.quote_refs = vec![ConversationQuoteRef {
            session_id: "source-session".into(),
            entry_id: "src-1".into(),
        }];
        fixture.replace("target-session", "fp-target", None, vec![ask, reply], 0);
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        // A metadata-only rewrite that keeps the value identical must not hide the reply.
        supersede_fact(&fixture, "mem-tea", 1_700_000_001_000, "喜欢乌龙茶", None);
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        supersede_fact(&fixture, "mem-tea", 1_700_000_002_000, "喜欢普洱", None);
        assert!(
            search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty(),
            "the cross-session paraphrase leaves recall once its rendered source is superseded"
        );
    }
}
