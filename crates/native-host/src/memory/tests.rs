//! 记忆库的单元测试：每条都钉住一条产品规则，改坏实现就会红。

use super::protocol::{MEMORY_COMMANDS, MEMORY_SCHEMA_VERSION};
use super::schema::SCHEMA_VERSION;
use super::store::{id_suffix, payload_hash, rand_suffix};
use super::MemoryStore;
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// 临时库：每个用例一个独立目录，落盘路径由测试自己管。
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> (Self, MemoryStore) {
        let root = std::env::temp_dir().join(format!(
            "deskpet-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("打开测试库");
        (Self(root), store)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, entry: &str, hash: &str) -> Value {
    json!({
        "sourceId": id,
        "sessionId": "s1",
        "entryId": entry,
        "eventId": format!("{entry}:user"),
        "seq": 1,
        "contentHash": hash,
        "evidence": "用户原话",
        "eligibleForMemory": true,
        "taint": "trusted_user",
        "origin": "user",
        "observedAt": 1_700_000_000_000i64,
    })
}

fn draft(content: &str, source_ids: Vec<&str>) -> Value {
    json!({
        "content": content,
        "summary": content,
        "kind": "fact",
        "scope": "user",
        "aliases": [],
        "pinned": false,
        "importance": 5.0,
        "confidence": 0.9,
        "sourceIds": source_ids,
    })
}

fn add(store: &MemoryStore, op: &str, base: i64, draft: &Value) -> i64 {
    store
        .apply_change(op, base, "add", None, None, Some(draft))
        .expect("写入记忆")
}

/// id 后缀必须扛住「计数器与时钟锁步推进」：旧实现是两数 XOR，
/// `(c+1) ^ (t+1) == c ^ t` 在两者尾随 1 的个数相同时恒成立（约 1/3），同一毫秒内的
/// 相邻两次调用会生成逐字相同的 id，撞 `memory_items` 主键
/// （UNIQUE constraint failed: memory_items.id, memory_items.version）——
/// 2026-10-06 Windows CI 报的正是这个主键冲突。把后缀改回 XOR 本用例立刻变红。
#[test]
fn id_suffix_survives_lockstep_counter_and_clock() {
    for (counter, tick) in [(0u64, 0u32), (1, 1), (2, 2), (3, 3), (7, 7), (15, 15)] {
        assert_ne!(
            id_suffix(counter, tick),
            id_suffix(counter + 1, tick + 1),
            "锁步形态（counter={counter}）下后缀重复：相邻两次调用会撞同一个 id"
        );
    }
    // 同一计数器、不同亚毫秒也必须能区分（时间位不是装饰）。
    assert_ne!(id_suffix(4, 100), id_suffix(4, 101));
    // 进程内逐次调用的总不变量：后缀互不相同。
    let generated: std::collections::HashSet<String> =
        (0..2000).map(|_| rand_suffix()).collect();
    assert_eq!(generated.len(), 2000, "同进程内 id 后缀出现重复");
}

#[cfg(debug_assertions)]
#[test]
fn evaluation_reset_replaces_database_and_source_governance() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("eval-source", "eval-entry", "eval-hash")])
        .expect("登记来源");
    let revision = add(
        &store,
        "eval-add",
        0,
        &draft("旧试验事实", vec!["eval-source"]),
    );
    store
        .apply_change("eval-forget", revision, "clear", None, None, None)
        .expect("遗忘旧库");
    store.job_start("review", "s1").expect("旧试验任务");
    let old = store.status().expect("旧库状态");
    assert!(old.revision > 0 && old.forget_epoch > 0 && old.job_count > 0);
    let fresh = store
        .reset_for_evaluation()
        .expect("重建同一所有者的数据库");
    assert_eq!(fresh.revision, 0);
    assert_eq!(fresh.forget_epoch, 0);
    assert_eq!(fresh.item_count, 0);
    assert_eq!(fresh.job_count, 0);
    assert_eq!(fresh.candidate_count, 0);
    // 同一 source id 在上一试验被遗忘，重建后必须按新证据重新准入。
    store
        .register_sources(&[source("eval-source", "fresh-entry", "fresh-hash")])
        .expect("新来源");
    assert_eq!(
        add(
            &store,
            "eval-add",
            0,
            &draft("新试验事实", vec!["eval-source"])
        ),
        1
    );
    let items = store
        .query("新试验事实", Some("user"), None, None, 50)
        .expect("实际新查询");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["draft"]["content"], json!("新试验事实"));
}

#[test]
fn protocol_commands_match_published_schema() {
    // 协议文件是跨 Rust/TS 的唯一边界：命令清单与 schema 版本必须与实现同源。
    assert!(MEMORY_COMMANDS.contains(&"memory_query"));
    assert!(MEMORY_COMMANDS.contains(&"memory_recall_candidates"));
    assert!(MEMORY_COMMANDS.contains(&"memory_dreaming_commit"));
    assert!(MEMORY_COMMANDS.contains(&"memory_job_list"));
    assert!(MEMORY_COMMANDS.contains(&"memory_restore_preview"));
    assert!(MEMORY_COMMANDS.contains(&"memory_source_evidence"));
    // 前置查询：dreaming 开作业前用它决定「水位之后无来源就跳过」。
    assert!(MEMORY_COMMANDS.contains(&"memory_pending_source_count"));
    assert_eq!(
        MEMORY_COMMANDS.len(),
        27,
        "命令数量变了就要同步 protocol.json 与 ipc.ts"
    );
    assert_eq!(MEMORY_SCHEMA_VERSION, SCHEMA_VERSION);
}

#[test]
fn source_evidence_hides_forgotten_sources_and_job_list_omits_secrets() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("visible-source", "visible-entry", "visible-hash")])
        .unwrap();
    let visible = store.source_evidence("visible-source").unwrap().unwrap();
    assert_eq!(visible["evidence"], json!("用户原话"));
    assert_eq!(visible["eligibleForMemory"], json!(true));
    assert_eq!(store.source_evidence("missing").unwrap(), None);

    let revision = add(
        &store,
        "source-add",
        0,
        &draft("待忘记", vec!["visible-source"]),
    );
    let item = store
        .query("待忘记", Some("user"), None, None, 50)
        .unwrap()
        .remove(0);
    store
        .apply_change(
            "source-forget",
            revision,
            "forget",
            item["id"].as_str(),
            Some(1),
            None,
        )
        .unwrap();
    assert_eq!(store.source_evidence("visible-source").unwrap(), None);

    store.job_start("review", "private-owner").unwrap();
    let jobs = store.job_list(50, 0).unwrap();
    assert_eq!(jobs.len(), 1);
    assert!(jobs[0].get("leaseOwner").is_none());
    assert!(jobs[0].get("cursor").is_none());
}

#[test]
fn chat_user_ui_add_requires_one_complete_current_trusted_source() {
    let (_fixture, store) = Fixture::new();
    let mut trusted = source("chat-source", "chat-entry", "unused");
    trusted["contentHash"] = json!(format!("{:x}", Sha256::digest("用户原话".as_bytes())));
    store.register_sources(&[trusted]).unwrap();
    let complete = draft("用户原话", vec!["chat-source"]);
    assert_eq!(
        store
            .apply_change_with_actor(
                "chat-save",
                0,
                "add",
                None,
                None,
                Some(&complete),
                "user_ui_current",
                Some("chat-entry:user"),
                Some("s1")
            )
            .unwrap(),
        1,
    );

    let partial = draft("用户原", vec!["chat-source"]);
    assert!(store
        .apply_change_with_actor(
            "chat-partial",
            1,
            "add",
            None,
            None,
            Some(&partial),
            "user_ui_current",
            Some("chat-entry:user"),
            Some("s1")
        )
        .is_err());
    assert!(store
        .apply_change_with_actor(
            "chat-wrong-session",
            1,
            "add",
            None,
            None,
            Some(&complete),
            "user_ui_current",
            Some("chat-entry:user"),
            Some("other-session")
        )
        .is_err());
    assert!(store
        .apply_change_with_actor(
            "chat-update",
            1,
            "update",
            Some("item"),
            Some(1),
            Some(&complete),
            "user_ui_current",
            Some("chat-entry:user"),
            Some("s1")
        )
        .is_err());
}

#[test]
fn restore_preview_validates_managed_backup_metadata_without_applying_it() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("preview-source", "preview-entry", "preview-hash")])
        .unwrap();
    add(
        &store,
        "preview-add",
        0,
        &draft("备份内容", vec!["preview-source"]),
    );
    let backup = store.backup().unwrap();
    let preview = MemoryStore::restore_preview(std::path::Path::new(&backup)).unwrap();
    assert_eq!(preview["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(preview["itemCount"], json!(1));
    assert_eq!(preview["jobCount"], json!(0));
    assert_eq!(store.status().unwrap().item_count, 1);
}

#[test]
fn chinese_two_character_queries_match_via_like_fallback() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    add(
        &store,
        "op-1",
        0,
        &draft("用户喜欢喝冰美式咖啡", vec!["src-1"]),
    );

    // 「咖啡」只有两个 Unicode 字符：FTS5 trigram 的 MATCH 对它永远零命中，
    // 召回必须靠短词 LIKE 回退才能命中 —— 这是中文陪伴场景最常见的查询形态。
    let short = store.query("咖啡", None, None, None, 10).unwrap();
    assert_eq!(short.len(), 1, "两字中文查询没有命中（短词回退失效）");
    assert_eq!(short[0]["draft"]["content"], json!("用户喜欢喝冰美式咖啡"));

    // 三字以上的查询走 FTS 正常命中；无关查询不得返回任何条目。
    assert_eq!(
        store.query("冰美式", None, None, None, 10).unwrap().len(),
        1
    );
    assert!(store
        .query("用户的银行卡号", None, None, None, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn fts_only_hits_keep_scope_expiry_and_version_boundaries() {
    let (fixture, store) = Fixture::new();
    store
        .register_sources(&[source("fts-source", "fts-entry", "fts-hash")])
        .unwrap();
    add(
        &store,
        "fts-user",
        0,
        &draft("用户喜欢CAFÉ", vec!["fts-source"]),
    );
    let mut card = draft("其他Card喜欢CAFÉ", vec!["fts-source"]);
    card["scope"] = json!("card");
    card["scopeId"] = json!("other-card");
    add(&store, "fts-card", 1, &card);
    let mut expired = draft("已过期CAFÉ", vec!["fts-source"]);
    expired["validTo"] = json!(1_000i64);
    add(&store, "fts-expired", 2, &expired);
    // SQLite LIKE does not fold non-ASCII É/é; this must exercise the FTS branch.
    let conn = rusqlite::Connection::open(fixture.0.join("memory.sqlite3")).unwrap();
    let like_hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM memory_items WHERE content LIKE '%café%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(like_hits, 0);
    let hits = store
        .query("café", Some("user"), None, Some("s1"), 50)
        .unwrap();
    assert_eq!(
        hits.len(),
        1,
        "FTS must find the live user fact while excluding card and expired facts"
    );
    assert_eq!(hits[0]["draft"]["content"], json!("用户喜欢CAFÉ"));
    assert!(store
        .query("café", Some("card"), Some("active-card"), Some("s1"), 50)
        .unwrap()
        .is_empty());
    let id = hits[0]["id"].as_str().unwrap();
    store
        .apply_change(
            "fts-correct",
            3,
            "update",
            Some(id),
            Some(1),
            Some(&draft("用户改喝红茶", vec!["fts-source"])),
        )
        .unwrap();
    // Inject an old index row to verify exact (id, version) matching independently of index cleanup.
    conn.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,1,'CAFÉ','','')", [id]).unwrap();
    assert!(
        store
            .query("café", Some("user"), None, Some("s1"), 50)
            .unwrap()
            .is_empty(),
        "stale FTS version resurrected the corrected fact"
    );
    let corrected = store
        .query("红茶", Some("user"), None, Some("s1"), 50)
        .unwrap();
    assert_eq!(corrected.len(), 1);
    assert_eq!(corrected[0]["version"], json!(2));
}

#[test]
fn query_filters_scope_and_expiry() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[
            source("src-1", "entry-1", "hash-1"),
            source("src-2", "entry-2", "hash-2"),
        ])
        .unwrap();
    add(
        &store,
        "op-1",
        0,
        &draft("用户养了一只叫团子的猫", vec!["src-1"]),
    );
    let mut card_draft = draft("用户在糖糖这里喜欢被叫老板", vec!["src-2"]);
    card_draft["scope"] = json!("card");
    card_draft["scopeId"] = json!("v1rtual");
    add(&store, "op-2", 1, &card_draft);
    let mut expiring = draft("用户这周在出差", vec!["src-1"]);
    expiring["expiresAt"] = json!(1_000i64);
    add(&store, "op-3", 2, &expiring);

    assert_eq!(
        store
            .query("猫", Some("user"), None, None, 10)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .query("老板", Some("user"), None, None, 10)
            .unwrap()
            .is_empty(),
        "user 范围查询返回了 card 范围的记忆"
    );
    assert_eq!(
        store
            .query("老板", Some("card"), Some("v1rtual"), None, 10)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .query("出差", None, None, None, 10)
            .unwrap()
            .is_empty(),
        "已过有效期的记忆仍被召回"
    );
}

#[test]
fn pinned_core_is_read_without_query_and_bound_to_current_scopes_and_revision() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[
            source("core-user", "core-user-entry", "core-user-hash"),
            source("core-card", "core-card-entry", "core-card-hash"),
            source("core-other", "core-other-entry", "core-other-hash"),
            source("core-session", "core-session-entry", "core-session-hash"),
            source("core-expired", "core-expired-entry", "core-expired-hash"),
        ])
        .unwrap();
    let mut user = draft("核心称呼是小澄", vec!["core-user"]);
    user["pinned"] = json!(true);
    add(&store, "core-user-add", 0, &user);
    let mut card = draft("当前Card称呼是老板", vec!["core-card"]);
    card["scope"] = json!("card");
    card["scopeId"] = json!("current-card");
    card["pinned"] = json!(true);
    add(&store, "core-card-add", 1, &card);
    let mut other = draft("其它Card秘密称呼是主管", vec!["core-other"]);
    other["scope"] = json!("card");
    other["scopeId"] = json!("other-card");
    other["pinned"] = json!(true);
    add(&store, "core-other-add", 2, &other);
    let mut session = draft("当前会话核心事项", vec!["core-session"]);
    session["scope"] = json!("session");
    session["scopeId"] = json!("s1");
    session["pinned"] = json!(true);
    add(&store, "core-session-add", 3, &session);
    let mut expired = draft("过期核心称呼", vec!["core-expired"]);
    expired["pinned"] = json!(true);
    expired["expiresAt"] = json!(1_000i64);
    add(&store, "core-expired-add", 4, &expired);

    let snapshot = store
        .recall_candidates(
            "一个完全无关的天气问题",
            Some("current-card"),
            "s1",
            50,
            &[],
            false,
        )
        .unwrap();
    assert!(
        snapshot["candidates"].as_array().unwrap().is_empty(),
        "无关问题不应从动态召回命中内容"
    );
    let pinned = snapshot["pinned"].as_array().unwrap();
    let texts = pinned
        .iter()
        .map(|item| item["draft"]["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(texts.contains(&"核心称呼是小澄"));
    assert!(texts.contains(&"当前Card称呼是老板"));
    assert!(texts.contains(&"当前会话核心事项"));
    assert!(!texts
        .iter()
        .any(|text| text.contains("其它Card") || text.contains("过期")));
    assert_eq!(
        snapshot["revision"],
        json!(store.status().unwrap().revision),
        "候选和核心画像 revision 应来自同一读取快照"
    );
}

#[test]
fn exact_feedback_targets_allow_expiry_but_enforce_version_and_owner_scope() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[
            source("target-user", "target-user-entry", "target-user-hash"),
            source("target-card", "target-card-entry", "target-card-hash"),
            source(
                "target-session",
                "target-session-entry",
                "target-session-hash",
            ),
            source("target-other", "target-other-entry", "target-other-hash"),
        ])
        .unwrap();
    let mut user = draft("到期但仍active的用户事项", vec!["target-user"]);
    user["expiresAt"] = json!(1i64);
    store
        .apply_change(
            "target-user-add",
            0,
            "add",
            Some("target-user-id"),
            None,
            Some(&user),
        )
        .unwrap();
    let mut card = draft("当前Card事项", vec!["target-card"]);
    card["scope"] = json!("card");
    card["scopeId"] = json!("current-card");
    store
        .apply_change(
            "target-card-add",
            1,
            "add",
            Some("target-card-id"),
            None,
            Some(&card),
        )
        .unwrap();
    let mut session = draft("当前session事项", vec!["target-session"]);
    session["scope"] = json!("session");
    session["scopeId"] = json!("s1");
    store
        .apply_change(
            "target-session-add",
            2,
            "add",
            Some("target-session-id"),
            None,
            Some(&session),
        )
        .unwrap();
    let mut other = draft("其它Card事项", vec!["target-other"]);
    other["scope"] = json!("card");
    other["scopeId"] = json!("other-card");
    store
        .apply_change(
            "target-other-add",
            3,
            "add",
            Some("target-other-id"),
            None,
            Some(&other),
        )
        .unwrap();

    let targets = vec![
        json!({"id":"target-user-id","version":1}),
        json!({"id":"target-card-id","version":1}),
        json!({"id":"target-session-id","version":1}),
        json!({"id":"target-other-id","version":1}),
        json!({"id":"target-user-id","version":2}),
    ];
    let snapshot = store
        .recall_candidates("", Some("current-card"), "s1", 50, &targets, true)
        .unwrap();
    let ids = snapshot["targeted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        ["target-user-id", "target-card-id", "target-session-id"]
    );
    assert!(snapshot["candidates"].as_array().unwrap().is_empty());
}

#[test]
fn relevance_beats_importance_when_a_stronger_query_match_is_available() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[
            source("weak-match", "weak-entry", "weak-hash"),
            source("strong-match", "strong-entry", "strong-hash"),
        ])
        .unwrap();
    let mut weak = draft("用户喜欢喝咖啡", vec!["weak-match"]);
    weak["importance"] = json!(10.0);
    add(&store, "weak-add", 0, &weak);
    let mut strong = draft("用户喜欢喝拿铁", vec!["strong-match"]);
    strong["importance"] = json!(1.0);
    add(&store, "strong-add", 1, &strong);

    let results = store
        .query("用户喜欢喝拿铁", Some("user"), None, Some("s1"), 1)
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0]["draft"]["content"],
        json!("用户喜欢喝拿铁"),
        "强查询匹配应胜过 importance 较高的弱片段命中"
    );
}

#[test]
fn future_and_closed_validity_intervals_are_not_recalled() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    let mut future = draft("未来才生效的偏好", vec!["src-1"]);
    future["validFrom"] = json!(4_102_444_800_000i64);
    add(&store, "op-future", 0, &future);
    let mut closed = draft("已经失效的偏好", vec!["src-1"]);
    closed["validTo"] = json!(1_000i64);
    add(&store, "op-closed", 1, &closed);
    assert!(store
        .query("偏好", None, None, None, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn forget_blocks_recall_and_reingest_and_rebuild() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    add(&store, "op-1", 0, &draft("用户住在杭州", vec!["src-1"]));
    let item = store.detail("mem-missing").unwrap();
    assert!(item.is_none());
    let items = store.list(Some("user"), None, 10).unwrap();
    let id = items[0]["id"].as_str().unwrap().to_string();

    let revision = store.status().unwrap().revision;
    store
        .apply_change("op-forget", revision, "forget", Some(&id), None, None)
        .expect("遗忘提交");
    assert!(
        store
            .query("杭州", None, None, None, 10)
            .unwrap()
            .is_empty(),
        "遗忘后仍能召回"
    );

    // 同一来源事件不得重新进入候选：索引重建与旧水位补扫都要被拦住。
    let written = store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    assert_eq!(written, 0, "被遗忘的来源重新登记成功（防回灌失效）");
    assert_eq!(store.rebuild().unwrap(), 0, "重建索引复活了已遗忘的条目");
    assert!(store
        .query("杭州", None, None, None, 10)
        .unwrap()
        .is_empty());
    assert!(
        store.detail(&id).unwrap().is_none(),
        "遗忘后 detail 仍返回正文"
    );
}

#[test]
fn forget_tombstone_blocks_sibling_add_from_same_source() {
    // 遗忘是按来源事件（session+entry+content_hash）整条抑制的：一条条目被遗忘后，
    // 共享同一来源的兄弟条目仍可召回，但任何**新增**引用该来源的写入都会被墓碑拦下
    // （防「忘了又复活」）。bench 夹具的 session→user 归一因此必须先把全部副本 add
    // 完再 forget 原件；逐条 add→forget 会在共享来源的第二条上撞出
    // `来源未登记`（2026-10-03 LongMemEval oracle lme-oracle-e01b8e2f 的真实故障）。
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    let mut first = draft("用户喜欢喝拿铁", vec!["src-1"]);
    first["scope"] = json!("session");
    first["scopeId"] = json!("sess-1");
    let mut second = draft("用户住在杭州", vec!["src-1"]);
    second["scope"] = json!("session");
    second["scopeId"] = json!("sess-1");
    let revision = store.status().unwrap().revision;
    add(&store, "op-first", revision, &first);
    let revision = store.status().unwrap().revision;
    add(&store, "op-second", revision, &second);
    // 夹具归一第一条：先 add user 副本，再 forget 原件。
    let revision = store.status().unwrap().revision;
    add(
        &store,
        "op-copy-1",
        revision,
        &draft("用户喜欢喝拿铁", vec!["src-1"]),
    );
    let items = store.list(Some("session"), None, 10).unwrap();
    let first_id = items
        .iter()
        .find(|item| item["draft"]["content"] == json!("用户喜欢喝拿铁"))
        .and_then(|item| item["id"].as_str())
        .unwrap()
        .to_string();
    let revision = store.status().unwrap().revision;
    store
        .apply_change(
            "op-forget-1",
            revision,
            "forget",
            Some(&first_id),
            None,
            None,
        )
        .unwrap();
    // 夹具归一第二条：add 会撞上第一条 forget 留下的墓碑。
    let revision = store.status().unwrap().revision;
    let blocked = store.apply_change(
        "op-copy-2",
        revision,
        "add",
        None,
        None,
        Some(&draft("用户住在杭州", vec!["src-1"])),
    );
    assert!(
        matches!(blocked, Err(AppError::Memory(ref message)) if message.contains("来源未登记")),
        "同一来源的兄弟条目在原件被遗忘后仍被允许新增（墓碑拦新增失效）"
    );
    assert_eq!(
        store.query("杭州", None, None, None, 10).unwrap().len(),
        1,
        "未遗忘的兄弟条目应仍可召回"
    );
}

#[test]
fn dreaming_candidates_commit_only_at_job_boundary() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    let job = store.job_start("review", "host").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    let written = store
        .candidates_add(
            &job_id,
            &[json!({"draft": draft("用户喜欢喝拿铁", vec!["src-1"]), "payloadHash": payload_hash(&draft("用户喜欢喝拿铁", vec!["src-1"]))})],
        )
        .unwrap();
    assert_eq!(written, 1);
    assert!(
        store
            .query("拿铁", None, None, None, 10)
            .unwrap()
            .is_empty(),
        "prepared 候选进入了召回"
    );

    // Commit with a stale library version must reject the whole automatic publish.
    let stale = store.commit_dreaming_job(&job_id, 999);
    assert!(matches!(stale, Err(AppError::MemoryConflict)));

    let revision = store.status().unwrap().revision;
    store
        .commit_dreaming_job(&job_id, revision)
        .expect("自动提交本 job 的合格候选");
    assert_eq!(store.query("拿铁", None, None, None, 10).unwrap().len(), 1);
}

#[test]
fn pending_source_count_follows_watermark_and_tombstones() {
    // dreaming 开作业前的前置查询：判定与 job_sources 同源（水位以 session_id + seq 为准）。
    let (_fixture, store) = Fixture::new();
    let mut first = source("src-1", "entry-1", "hash-1");
    first["seq"] = json!(1);
    let mut second = source("src-2", "entry-2", "hash-2");
    second["seq"] = json!(2);
    store
        .register_sources(&[first, second])
        .expect("登记两条来源");
    assert_eq!(
        store.pending_source_count(None).unwrap(),
        2,
        "新库的两条来源都应待处理"
    );

    // 作业推进到第一条：对应会话水位随 checkpoint 前移，只剩第二条。
    let job = store.job_start("review", "host").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    store
        .job_checkpoint(&job_id, "src-1", "host", 60_000)
        .expect("推进水位");
    assert_eq!(
        store.pending_source_count(None).unwrap(),
        1,
        "水位之后仍应只剩未处理的一条"
    );

    // 墓碑仍然生效：同一来源事件被遗忘后不得再计入待处理。这里让另一条条目继续
    // 引用该来源（来源行因此不被清理），命中的只能是墓碑过滤这一支。
    let revision = store.status().unwrap().revision;
    add(
        &store,
        "op-pending-a",
        revision,
        &draft("用户周末去爬山", vec!["src-2"]),
    );
    let revision = store.status().unwrap().revision;
    add(
        &store,
        "op-pending-b",
        revision,
        &draft("用户想买登山鞋", vec!["src-2"]),
    );
    let forgotten = store
        .list(Some("user"), None, 10)
        .unwrap()
        .into_iter()
        .find(|item| item["draft"]["content"] == json!("用户周末去爬山"))
        .and_then(|item| item["id"].as_str().map(str::to_string))
        .expect("第二条条目");
    let revision = store.status().unwrap().revision;
    store
        .apply_change(
            "op-forget-pending",
            revision,
            "forget",
            Some(&forgotten),
            None,
            None,
        )
        .expect("遗忘条目");
    assert_eq!(
        store.pending_source_count(None).unwrap(),
        0,
        "被遗忘的来源仍被计入待处理（墓碑过滤失效）"
    );
}

#[test]
fn natural_chinese_question_retrieves_address_fact_by_concept_bigrams() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-address", "entry-address", "hash-address")])
        .unwrap();
    add(
        &store,
        "address-fact",
        0,
        &draft("用户希望被称呼为阿澄", vec!["src-address"]),
    );
    let results = store
        .query("你平时想让我怎么称呼你？", None, None, None, 10)
        .unwrap();
    assert!(
        results
            .iter()
            .any(|item| item["draft"]["content"] == json!("用户希望被称呼为阿澄")),
        "由模板礼貌语气包裹的完整问题应命中‘称呼’事实"
    );
}

#[test]
fn revision_conflict_and_operation_idempotency() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("src-1", "entry-1", "hash-1")])
        .unwrap();
    add(&store, "op-1", 0, &draft("用户喜欢喝手冲", vec!["src-1"]));

    let stale = store.apply_change(
        "op-2",
        0,
        "add",
        None,
        None,
        Some(&draft("用户喜欢喝茶", vec!["src-1"])),
    );
    assert!(
        matches!(stale, Err(AppError::MemoryConflict)),
        "过期基准的写入没有被拒绝"
    );

    // 同一 operationId 重复提交（例如提交结果未知后的重试）只生效一次。
    let revision = store.status().unwrap().revision;
    add(
        &store,
        "op-3",
        revision,
        &draft("用户喜欢喝茶", vec!["src-1"]),
    );
    let after_first = store.status().unwrap().revision;
    let replay = store
        .apply_change(
            "op-3",
            revision,
            "add",
            None,
            None,
            Some(&draft("用户喜欢喝茶", vec!["src-1"])),
        )
        .unwrap();
    assert_eq!(replay, after_first, "重放同一条操作改动了版本");
    assert_eq!(
        store.list(Some("user"), None, 10).unwrap().len(),
        2,
        "重放写入了第二条记忆"
    );
}

#[test]
fn untrusted_sources_are_never_registered() {
    let (_fixture, store) = Fixture::new();
    let mut assistant = source("src-tool", "entry-tool", "hash-tool");
    assistant["taint"] = json!("untrusted");
    assistant["origin"] = json!("tool");
    assistant["eligibleForMemory"] = json!(false);
    assert_eq!(
        store.register_sources(&[assistant]).unwrap(),
        0,
        "工具来源被登记成了用户事实"
    );

    // 未登记来源的草稿不能落库：模型声明 provenance 不算证据。
    let orphan = store.apply_change(
        "op-x",
        0,
        "add",
        None,
        None,
        Some(&draft("用户有两只猫", vec!["src-ghost"])),
    );
    assert!(orphan.is_err(), "未登记来源的记忆被写入");
}

// ── MCP 凭据（mcp_credentials 表）──

#[test]
fn mcp_credential_roundtrip_and_status_never_exposes_values() {
    let (_fixture, store) = Fixture::new();
    assert_eq!(store.credential_status("github").unwrap(), Vec::<String>::new());
    assert_eq!(store.credential_get("github", "GITHUB_TOKEN").unwrap(), None);

    store
        .credential_set("github", "GITHUB_TOKEN", "probe-token-1")
        .unwrap();
    assert_eq!(
        store.credential_get("github", "GITHUB_TOKEN").unwrap().as_deref(),
        Some("probe-token-1")
    );
    // 名单只报变量名、不带值：设置面状态显示的唯一依据。
    let status = store.credential_status("github").unwrap();
    assert_eq!(status, vec!["GITHUB_TOKEN".to_string()]);
    assert!(
        !status.iter().any(|item| item.contains("probe-token-1")),
        "status 回执里出现了值"
    );
    // 别的服务器不受影响（键是 server + var）。
    assert_eq!(store.credential_get("other", "GITHUB_TOKEN").unwrap(), None);
    assert_eq!(store.credential_status("other").unwrap(), Vec::<String>::new());

    // 同键覆盖：旧值不再可读，名单不重复。
    store
        .credential_set("github", "GITHUB_TOKEN", "probe-token-2")
        .unwrap();
    assert_eq!(
        store.credential_get("github", "GITHUB_TOKEN").unwrap().as_deref(),
        Some("probe-token-2")
    );
    assert_eq!(store.credential_status("github").unwrap(), vec!["GITHUB_TOKEN".to_string()]);

    // 删除如实报告删没删到；删除后 get 回落 None（调用方按变量缺失失败）。
    assert!(store.credential_delete("github", "GITHUB_TOKEN").unwrap());
    assert!(!store.credential_delete("github", "GITHUB_TOKEN").unwrap());
    assert_eq!(store.credential_get("github", "GITHUB_TOKEN").unwrap(), None);
}

#[test]
fn mcp_credential_rejects_blank_axes() {
    let (_fixture, store) = Fixture::new();
    for (server, var, value) in [
        ("", "GITHUB_TOKEN", "probe-token"),
        ("github", "", "probe-token"),
        ("github", "GITHUB_TOKEN", ""),
        ("github", "GITHUB_TOKEN", "   "),
    ] {
        let error = store.credential_set(server, var, value).unwrap_err();
        assert_eq!(
            error.code(),
            "CONFIG",
            "空坐标/空值没有被拒绝: {server:?}/{var:?}/{value:?}"
        );
    }
    assert_eq!(store.credential_status("github").unwrap(), Vec::<String>::new());
}

// ── dreaming token 账（只记账，不按日总量准入）──

#[test]
fn dreaming_budget_records_usage_without_daily_token_gate() {
    let (_fixture, store) = Fixture::new();
    // 单笔预留是旧中档上限（72000）的 3 倍：旧口径下这一笔必然被拒。
    store
        .reserve_dreaming_budget("job-1:0", "2026-10-05", 216_000)
        .expect("超出旧日上限的预留被拒绝（日 token 总量门禁又回来了）");
    assert_eq!(
        store.dreaming_budget("2026-10-05").unwrap()["reservedTokens"],
        json!(216_000),
        "预留没有进账"
    );
    // 结算把实际用量（继续超旧上限）记进 used：账照记，不是清零。
    store
        .settle_dreaming_budget("job-1:0", "2026-10-05", 216_000, Some(300_000))
        .expect("结算失败");
    let budget = store.dreaming_budget("2026-10-05").unwrap();
    assert_eq!(budget["usedTokens"], json!(300_000), "用量没有记进账");
    assert_eq!(budget["reservedTokens"], json!(0), "结算没有释放预留");
    // 当日账已远超旧三档上限（24000 / 72000 / 120000）后，新预留仍被接受并照记。
    store
        .reserve_dreaming_budget("job-1:1", "2026-10-05", 90_000)
        .expect("当日账超旧上限后新预留被拒绝");
    assert_eq!(
        store.dreaming_budget("2026-10-05").unwrap()["reservedTokens"],
        json!(90_000)
    );
    // 幂等重放：同 id 同昼同额直接返回原账，不重复累加。
    store
        .reserve_dreaming_budget("job-1:1", "2026-10-05", 90_000)
        .expect("同额重放被拒绝");
    assert_eq!(
        store.dreaming_budget("2026-10-05").unwrap()["reservedTokens"],
        json!(90_000),
        "重放把同一笔预留记了两次"
    );
    // 参数校验与冲突语义保持：空 id / 非法日期 / 负数如实报错，同 id 不同额报冲突。
    assert!(store.reserve_dreaming_budget("", "2026-10-05", 1).is_err());
    assert!(store.reserve_dreaming_budget("job-1:2", "2026-10-0", 1).is_err());
    assert!(store.reserve_dreaming_budget("job-1:2", "2026-10-05", -1).is_err());
    assert!(matches!(
        store.reserve_dreaming_budget("job-1:1", "2026-10-05", 91_000),
        Err(AppError::MemoryConflict)
    ));
}

// ── 派生行为结论（系统观察，2026-10-06 方案 b）──

/// 派生来源：合成会话身份 `behavior`，与真实会话空间不相交；taint 必须与 origin 成对。
fn derived_source(id: &str, entry: &str, hash: &str, seq: i64) -> Value {
    json!({
        "sourceId": id,
        "sessionId": "behavior",
        "entryId": entry,
        "eventId": format!("behavior:{hash}"),
        "seq": seq,
        "contentHash": hash,
        "evidence": "近一个月的活跃时段：工作日集中在 19–23 时。（判据：近30日画像窗口的最强 4 小时活跃带）",
        "eligibleForMemory": true,
        "taint": "derived",
        "origin": "derived_behavior",
        "observedAt": 1_700_000_000_000i64,
    })
}

fn derived_draft(content: &str, source_id: &str, extra: Value) -> Value {
    let mut value = json!({
        "content": content,
        "summary": content,
        "kind": "fact",
        "scope": "user",
        "aliases": ["behavior-slot:rhythm"],
        "pinned": false,
        "importance": 4.0,
        "confidence": 0.5,
        "sourceIds": [source_id],
    });
    if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        for (key, item) in extra {
            base.insert(key.clone(), item.clone());
        }
    }
    value
}

fn publish_candidates(store: &MemoryStore, drafts: &[Value]) -> AppResult<i64> {
    let job = store.job_start("review", "host").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    let payloads: Vec<Value> = drafts
        .iter()
        .enumerate()
        .map(|(index, draft)| {
            json!({
                "id": format!("cand-test-{index}-{}", payload_hash(draft)),
                "draft": draft,
                "payloadHash": payload_hash(draft),
            })
        })
        .collect();
    store.candidates_add(&job_id, &payloads).expect("候选落 staging");
    let revision = store.status().unwrap().revision;
    store.commit_dreaming_job(&job_id, revision)
}

fn proactive_revision(store: &MemoryStore) -> i64 {
    let owner = json!({"sessionId":"s1","cardId":"card-a","cardHash":"hash-a","runGeneration":1});
    store
        .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))
        .unwrap()["revision"]
        .as_i64()
        .unwrap()
}

fn clear_behavior_sources(store: &MemoryStore) {
    let owner = json!({"sessionId":"s1","cardId":"card-a","cardHash":"hash-a","runGeneration":1});
    store
        .proactive_change(&json!({
            "operationId": "op-clear-behavior",
            "baseRevision": proactive_revision(store),
            "action": "control",
            "owner": owner,
            "controlPatch": {"clearBehaviorSources": true},
        }))
        .expect("清除画像来源");
}

#[test]
fn derived_sources_are_admitted_in_their_own_class_and_keep_user_rejections() {
    let (_fixture, store) = Fixture::new();
    // 错配不受理：derived_behavior 必须配 taint=derived —— 不是「换个标签的用户事实」。
    let mut mismatched = derived_source("bad-source", "conclusion:rhythm", "hash-bad", 10);
    mismatched["taint"] = json!("trusted_user");
    assert_eq!(
        store.register_sources(&[mismatched]).unwrap(),
        0,
        "错配的来源类别被登记成了准入来源"
    );
    // 工具来源照旧拒收：派生准入的放宽没有顺手放行其它类别。
    let mut tool = source("tool-source", "entry-tool", "hash-tool");
    tool["origin"] = json!("tool");
    tool["taint"] = json!("untrusted");
    tool["eligibleForMemory"] = json!(false);
    assert_eq!(store.register_sources(&[tool]).unwrap(), 0);

    assert_eq!(
        store
            .register_sources(&[
                source("user-1", "entry-u1", "hash-u1"),
                derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r", 100),
            ])
            .unwrap(),
        2,
        "两类准入来源没有各自登记"
    );
    // 前置查询与作业取数按类别分区：两处共用同一段水位判定。
    assert_eq!(store.pending_source_count(Some("user")).unwrap(), 1);
    assert_eq!(
        store.pending_source_count(Some("derived_behavior")).unwrap(),
        1
    );
    assert_eq!(store.pending_source_count(None).unwrap(), 2);
    let job = store.job_start("review", "host").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    let user_sources = store.job_sources(&job_id, Some("user")).unwrap();
    assert_eq!(user_sources.len(), 1);
    assert_eq!(user_sources[0]["origin"], json!("user"));
    let derived_sources = store.job_sources(&job_id, Some("derived_behavior")).unwrap();
    assert_eq!(derived_sources.len(), 1, "派生来源没有按类别取到");
    assert_eq!(derived_sources[0]["origin"], json!("derived_behavior"));
    assert_eq!(derived_sources[0]["taint"], json!("derived"));
    assert_eq!(
        store.job_sources(&job_id, None).unwrap().len(),
        2,
        "缺省取数应当两类都可见（恢复旧作业路径）"
    );
}

#[test]
fn mixed_pools_and_core_or_working_flags_are_rejected_at_publish() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[
            source("user-1", "entry-u1", "hash-u1"),
            derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r", 100),
        ])
        .unwrap();
    // 混池候选：同时引用用户来源与派生来源 —— 整批拒绝，不静默二选一。
    let mixed = derived_draft("混池结论", "user-1", json!({"sourceIds": ["user-1", "behavior-conclusion:rhythm:aaaa"]}));
    let mixed_result = publish_candidates(&store, &[mixed]);
    assert!(
        matches!(&mixed_result, Err(AppError::Memory(message)) if message.contains("混池")),
        "混池候选没有被拒绝: {mixed_result:?}"
    );
    // 派生 + pinned（核心画像）拒绝。
    let pinned = derived_draft("核心画象结论", "behavior-conclusion:rhythm:aaaa", json!({"pinned": true}));
    let pinned_result = publish_candidates(&store, &[pinned]);
    assert!(
        matches!(&pinned_result, Err(AppError::Memory(message)) if message.contains("核心画像")),
        "派生结论进入了核心画像: {pinned_result:?}"
    );
    // 派生 + working 拒绝。
    let working = derived_draft(
        "事项化的结论",
        "behavior-conclusion:rhythm:aaaa",
        json!({"kind": "working", "workingState": "open"}),
    );
    let working_result = publish_candidates(&store, &[working]);
    assert!(
        matches!(&working_result, Err(AppError::Memory(message)) if message.contains("working")),
        "派生结论被写成了 working 事项: {working_result:?}"
    );
    // 纯派生候选照常发布，条目 origin 由来源类别派生。
    let revision = publish_candidates(
        &store,
        &[derived_draft("近一个月的活跃时段：工作日集中在 19–23 时。", "behavior-conclusion:rhythm:aaaa", json!({}))],
    )
    .expect("纯派生候选没有发布");
    assert!(revision > 0);
    let items = store.list(Some("user"), None, 10).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["origin"], json!("derived_behavior"));
    assert_eq!(
        store
            .source_evidence("behavior-conclusion:rhythm:aaaa")
            .unwrap()
            .is_some(),
        true,
        "派生来源的证据不可回看"
    );
}

#[test]
fn new_derived_version_supersedes_previous_slot_and_leaves_user_facts_alone() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[source("user-1", "entry-u1", "hash-u1")])
        .unwrap();
    add(&store, "op-u", 0, &draft("用户喜欢喝拿铁", vec!["user-1"]));

    store
        .register_sources(&[derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r1", 100)])
        .unwrap();
    publish_candidates(
        &store,
        &[derived_draft("近一个月的活跃时段：工作日集中在 19–23 时。", "behavior-conclusion:rhythm:aaaa", json!({}))],
    )
    .expect("第一版结论发布失败");
    let first = store
        .list(Some("user"), None, 10)
        .unwrap()
        .into_iter()
        .find(|item| item["origin"] == json!("derived_behavior"))
        .expect("第一版结论条目");
    let first_id = first["id"].as_str().unwrap().to_string();

    // 新数据推翻旧结论：新版本带 supersedesId → 旧条目退出召回（版本 + 覆盖收敛）。
    store
        .register_sources(&[derived_source("behavior-conclusion:rhythm:bbbb", "conclusion:rhythm", "hash-r2", 200)])
        .unwrap();
    publish_candidates(
        &store,
        &[derived_draft(
            "近一个月的活跃时段：工作日集中在 9–13 时。",
            "behavior-conclusion:rhythm:bbbb",
            json!({"supersedesId": first_id}),
        )],
    )
    .expect("第二版结论发布失败");
    let active = store.list(Some("user"), None, 10).unwrap();
    let derived: Vec<&Value> = active
        .iter()
        .filter(|item| item["origin"] == json!("derived_behavior"))
        .collect();
    assert_eq!(derived.len(), 1, "旧结论没有被新版本覆盖");
    assert!(
        derived[0]["draft"]["content"]
            .as_str()
            .unwrap()
            .contains("9–13"),
        "在库的不是新版本结论"
    );
    assert!(
        active.iter().any(|item| item["draft"]["content"] == json!("用户喜欢喝拿铁")),
        "覆盖派生结论时动了用户事实"
    );
}

#[test]
fn apply_change_cannot_cross_source_classes() {
    let (_fixture, store) = Fixture::new();
    store
        .register_sources(&[derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r", 100)])
        .unwrap();
    // 派生来源 + working / pinned 在写入入口同样被拒绝（不只是整理发布口）。
    let working = derived_draft(
        "事项化的结论",
        "behavior-conclusion:rhythm:aaaa",
        json!({"kind": "working", "workingState": "open"}),
    );
    assert!(store.apply_change("op-w", 0, "add", None, None, Some(&working)).is_err());
    let pinned = derived_draft("核心画象结论", "behavior-conclusion:rhythm:aaaa", json!({"pinned": true}));
    assert!(store.apply_change("op-p", 0, "add", None, None, Some(&pinned)).is_err());
    // 合法派生条目（internal 入口）可以落库，但用户来源草稿不能把它「改写」成用户事实。
    let revision = store
        .apply_change(
            "op-d",
            0,
            "add",
            None,
            None,
            Some(&derived_draft("第一条观察结论", "behavior-conclusion:rhythm:aaaa", json!({}))),
        )
        .expect("派生条目写入失败");
    let item_id = store.list(Some("user"), None, 10).unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    store
        .register_sources(&[source("user-1", "entry-u1", "hash-u1")])
        .unwrap();
    let rewrite = store.apply_change(
        "op-rewrite",
        revision,
        "update",
        Some(&item_id),
        None,
        Some(&draft("用户说他作息规律", vec!["user-1"])),
    );
    assert!(
        matches!(&rewrite, Err(AppError::Memory(message)) if message.contains("跨来源类别")),
        "系统观察被改写成了用户事实: {rewrite:?}"
    );
}

#[test]
fn behavior_clear_forgets_derived_items_and_blocks_replay() {
    let (_fixture, store) = Fixture::new();
    // 用户事实与派生条目共存：清除只动派生一侧。
    store
        .register_sources(&[source("user-1", "entry-u1", "hash-u1")])
        .unwrap();
    add(&store, "op-u", 0, &draft("用户喜欢喝拿铁", vec!["user-1"]));
    store
        .register_sources(&[derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r", 100)])
        .unwrap();
    publish_candidates(
        &store,
        &[derived_draft("近一个月的活跃时段：工作日集中在 19–23 时。", "behavior-conclusion:rhythm:aaaa", json!({}))],
    )
    .expect("派生条目发布失败");

    // 在飞候选：一个引用派生来源、一个引用用户来源；清除后只留后者（前者连候选一起失效）。
    store
        .register_sources(&[derived_source("behavior-conclusion:apps:cccc", "conclusion:apps", "hash-r2", 200)])
        .unwrap();
    let job = store.job_start("review", "host").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    let inflight_derived = derived_draft("在飞派生候选", "behavior-conclusion:apps:cccc", json!({}));
    let inflight_user = draft("在飞用户候选", vec!["user-1"]);
    store
        .candidates_add(
            &job_id,
            &[
                json!({"id": "cand-inflight-d", "draft": inflight_derived, "payloadHash": payload_hash(&inflight_derived)}),
                json!({"id": "cand-inflight-u", "draft": inflight_user, "payloadHash": payload_hash(&inflight_user)}),
            ],
        )
        .expect("在飞候选落 staging");
    assert_eq!(store.status().unwrap().candidate_count, 2);

    let revision_before = store.status().unwrap().revision;
    clear_behavior_sources(&store);

    // 正文：派生条目消失，用户事实保留。
    let items = store.list(Some("user"), None, 10).unwrap();
    assert!(
        items.iter().all(|item| item["origin"] == json!("user")),
        "清除画像后仍有派生条目在库"
    );
    assert!(items.iter().any(|item| item["draft"]["content"] == json!("用户喜欢喝拿铁")));
    // 索引：FTS 不再命中已清正文。
    assert_eq!(store.query("活跃时段", None, None, None, 10).unwrap().len(), 0);
    assert_eq!(store.query("拿铁", None, None, None, 10).unwrap().len(), 1);
    // 候选：引用派生来源的候选被删，用户候选保留。
    assert_eq!(
        store.status().unwrap().candidate_count,
        1,
        "清除没有覆盖候选（引用派生来源的候选仍在）"
    );
    // 来源证据：已清来源不可回看，用户来源照旧。
    assert!(store
        .source_evidence("behavior-conclusion:rhythm:aaaa")
        .unwrap()
        .is_none());
    assert!(store.source_evidence("user-1").unwrap().is_some());
    // 失效：同一结论文本重新登记被墓碑拦下（已清的来源不能迟到回灌）。
    assert_eq!(
        store
            .register_sources(&[derived_source("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r", 100)])
            .unwrap(),
        0,
        "已清画像的结论文本被重新登记"
    );
    // 在飞作业的发布复核被 forget_epoch 拦下（不是靠候选恰好被删）。
    let revision_after = store.status().unwrap().revision;
    assert!(revision_after > revision_before, "清除没有推进记忆 revision");
    assert!(
        matches!(store.commit_dreaming_job(&job_id, revision_after), Err(AppError::MemoryConflict)),
        "跨清除代的作业仍然发布了候选"
    );
    // 空转保护：库里已无派生数据，再清一次不动 epoch/revision。
    let before = store.status().unwrap();
    clear_behavior_sources(&store);
    let after = store.status().unwrap();
    assert_eq!(before.forget_epoch, after.forget_epoch);
    assert_eq!(before.revision, after.revision);
}
