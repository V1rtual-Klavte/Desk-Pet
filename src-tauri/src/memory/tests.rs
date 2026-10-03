//! 记忆库的单元测试：每条都钉住一条产品规则，改坏实现就会红。

use super::protocol::{MEMORY_COMMANDS, MEMORY_SCHEMA_VERSION};
use super::schema::SCHEMA_VERSION;
use super::MemoryStore;
use super::store::payload_hash;
use crate::error::AppError;
use serde_json::{json, Value};
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
    store.apply_change(op, base, "add", None, None, Some(draft)).expect("写入记忆")
}

#[cfg(debug_assertions)]
#[test]
fn evaluation_reset_replaces_database_and_source_governance() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("eval-source", "eval-entry", "eval-hash")]).expect("登记来源");
    let revision = add(&store, "eval-add", 0, &draft("旧试验事实", vec!["eval-source"]));
    store.apply_change("eval-forget", revision, "clear", None, None, None).expect("遗忘旧库");
    store.job_start("review", "s1").expect("旧试验任务");
    let old = store.status().expect("旧库状态");
    assert!(old.revision > 0 && old.forget_epoch > 0 && old.job_count > 0);
    let fresh = store.reset_for_evaluation().expect("重建同一所有者的数据库");
    assert_eq!(fresh.revision, 0);
    assert_eq!(fresh.forget_epoch, 0);
    assert_eq!(fresh.item_count, 0);
    assert_eq!(fresh.job_count, 0);
    assert_eq!(fresh.candidate_count, 0);
    // 同一 source id 在上一试验被遗忘，重建后必须按新证据重新准入。
    store.register_sources(&[source("eval-source", "fresh-entry", "fresh-hash")]).expect("新来源");
    assert_eq!(add(&store, "eval-add", 0, &draft("新试验事实", vec!["eval-source"])), 1);
    let items = store.query("新试验事实", Some("user"), None, None, 50).expect("实际新查询");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["draft"]["content"], json!("新试验事实"));
}

#[test]
fn protocol_commands_match_published_schema() {
    // 协议文件是跨 Rust/TS 的唯一边界：命令清单与 schema 版本必须与实现同源。
    assert!(MEMORY_COMMANDS.contains(&"memory_query"));
    assert!(MEMORY_COMMANDS.contains(&"memory_dreaming_commit"));
    assert_eq!(MEMORY_COMMANDS.len(), 22, "命令数量变了就要同步 protocol.json 与 ipc.ts");
    assert_eq!(MEMORY_SCHEMA_VERSION, SCHEMA_VERSION);
}

#[test]
fn chinese_two_character_queries_match_via_like_fallback() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    add(&store, "op-1", 0, &draft("用户喜欢喝冰美式咖啡", vec!["src-1"]));

    // 「咖啡」只有两个 Unicode 字符：FTS5 trigram 的 MATCH 对它永远零命中，
    // 召回必须靠短词 LIKE 回退才能命中 —— 这是中文陪伴场景最常见的查询形态。
    let short = store.query("咖啡", None, None, None, 10).unwrap();
    assert_eq!(short.len(), 1, "两字中文查询没有命中（短词回退失效）");
    assert_eq!(short[0]["draft"]["content"], json!("用户喜欢喝冰美式咖啡"));

    // 三字以上的查询走 FTS 正常命中；无关查询不得返回任何条目。
    assert_eq!(store.query("冰美式", None, None, None, 10).unwrap().len(), 1);
    assert!(store.query("用户的银行卡号", None, None, None, 10).unwrap().is_empty());
}

#[test]
fn fts_only_hits_keep_scope_expiry_and_version_boundaries() {
    let (fixture, store) = Fixture::new();
    store.register_sources(&[source("fts-source", "fts-entry", "fts-hash")]).unwrap();
    add(&store, "fts-user", 0, &draft("用户喜欢CAFÉ", vec!["fts-source"]));
    let mut card = draft("其他Card喜欢CAFÉ", vec!["fts-source"]);
    card["scope"] = json!("card");
    card["scopeId"] = json!("other-card");
    add(&store, "fts-card", 1, &card);
    let mut expired = draft("已过期CAFÉ", vec!["fts-source"]);
    expired["validTo"] = json!(1_000i64);
    add(&store, "fts-expired", 2, &expired);
    // SQLite LIKE does not fold non-ASCII É/é; this must exercise the FTS branch.
    let conn = rusqlite::Connection::open(fixture.0.join("memory.sqlite3")).unwrap();
    let like_hits: i64 = conn.query_row("SELECT count(*) FROM memory_items WHERE content LIKE '%café%'", [], |row| row.get(0)).unwrap();
    assert_eq!(like_hits, 0);
    let hits = store.query("café", Some("user"), None, Some("s1"), 50).unwrap();
    assert_eq!(hits.len(), 1, "FTS must find the live user fact while excluding card and expired facts");
    assert_eq!(hits[0]["draft"]["content"], json!("用户喜欢CAFÉ"));
    assert!(store.query("café", Some("card"), Some("active-card"), Some("s1"), 50).unwrap().is_empty());
    let id = hits[0]["id"].as_str().unwrap();
    store.apply_change("fts-correct", 3, "update", Some(id), Some(1), Some(&draft("用户改喝红茶", vec!["fts-source"]))).unwrap();
    // Inject an old index row to verify exact (id, version) matching independently of index cleanup.
    conn.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,1,'CAFÉ','','')", [id]).unwrap();
    assert!(store.query("café", Some("user"), None, Some("s1"), 50).unwrap().is_empty(), "stale FTS version resurrected the corrected fact");
    let corrected = store.query("红茶", Some("user"), None, Some("s1"), 50).unwrap();
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
    add(&store, "op-1", 0, &draft("用户养了一只叫团子的猫", vec!["src-1"]));
    let mut card_draft = draft("用户在糖糖这里喜欢被叫老板", vec!["src-2"]);
    card_draft["scope"] = json!("card");
    card_draft["scopeId"] = json!("v1rtual");
    add(&store, "op-2", 1, &card_draft);
    let mut expiring = draft("用户这周在出差", vec!["src-1"]);
    expiring["expiresAt"] = json!(1_000i64);
    add(&store, "op-3", 2, &expiring);

    assert_eq!(store.query("猫", Some("user"), None, None, 10).unwrap().len(), 1);
    assert!(
        store.query("老板", Some("user"), None, None, 10).unwrap().is_empty(),
        "user 范围查询返回了 card 范围的记忆"
    );
    assert_eq!(store.query("老板", Some("card"), Some("v1rtual"), None, 10).unwrap().len(), 1);
    assert!(
        store.query("出差", None, None, None, 10).unwrap().is_empty(),
        "已过有效期的记忆仍被召回"
    );
}

#[test]
fn future_and_closed_validity_intervals_are_not_recalled() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    let mut future = draft("未来才生效的偏好", vec!["src-1"]);
    future["validFrom"] = json!(4_102_444_800_000i64);
    add(&store, "op-future", 0, &future);
    let mut closed = draft("已经失效的偏好", vec!["src-1"]);
    closed["validTo"] = json!(1_000i64);
    add(&store, "op-closed", 1, &closed);
    assert!(store.query("偏好", None, None, None, 10).unwrap().is_empty());
}

#[test]
fn forget_blocks_recall_and_reingest_and_rebuild() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    add(&store, "op-1", 0, &draft("用户住在杭州", vec!["src-1"]));
    let item = store.detail("mem-missing").unwrap();
    assert!(item.is_none());
    let items = store.list(Some("user"), None, 10).unwrap();
    let id = items[0]["id"].as_str().unwrap().to_string();

    let revision = store.status().unwrap().revision;
    store
        .apply_change("op-forget", revision, "forget", Some(&id), None, None)
        .expect("遗忘提交");
    assert!(store.query("杭州", None, None, None, 10).unwrap().is_empty(), "遗忘后仍能召回");

    // 同一来源事件不得重新进入候选：索引重建与旧水位补扫都要被拦住。
    let written = store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    assert_eq!(written, 0, "被遗忘的来源重新登记成功（防回灌失效）");
    assert_eq!(store.rebuild().unwrap(), 0, "重建索引复活了已遗忘的条目");
    assert!(store.query("杭州", None, None, None, 10).unwrap().is_empty());
    assert!(store.detail(&id).unwrap().is_none(), "遗忘后 detail 仍返回正文");
}

#[test]
fn dreaming_candidates_commit_only_at_job_boundary() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
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
        store.query("拿铁", None, None, None, 10).unwrap().is_empty(),
        "prepared 候选进入了召回"
    );

    // Commit with a stale library version must reject the whole automatic publish.
    let stale = store.commit_dreaming_job(&job_id, 999);
    assert!(matches!(stale, Err(AppError::MemoryConflict)));

    let revision = store.status().unwrap().revision;
    store.commit_dreaming_job(&job_id, revision).expect("自动提交本 job 的合格候选");
    assert_eq!(store.query("拿铁", None, None, None, 10).unwrap().len(), 1);
}

#[test]
fn natural_chinese_question_retrieves_address_fact_by_concept_bigrams() {
    let (_fixture,store)=Fixture::new();
    store.register_sources(&[source("src-address","entry-address","hash-address")]).unwrap();
    add(&store,"address-fact",0,&draft("用户希望被称呼为阿澄",vec!["src-address"]));
    let results=store.query("你平时想让我怎么称呼你？",None,None,None,10).unwrap();
    assert!(results.iter().any(|item|item["draft"]["content"]==json!("用户希望被称呼为阿澄")),"由模板礼貌语气包裹的完整问题应命中‘称呼’事实");
}

#[test]
fn revision_conflict_and_operation_idempotency() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    add(&store, "op-1", 0, &draft("用户喜欢喝手冲", vec!["src-1"]));

    let stale = store.apply_change("op-2", 0, "add", None, None, Some(&draft("用户喜欢喝茶", vec!["src-1"])));
    assert!(matches!(stale, Err(AppError::MemoryConflict)), "过期基准的写入没有被拒绝");

    // 同一 operationId 重复提交（例如提交结果未知后的重试）只生效一次。
    let revision = store.status().unwrap().revision;
    add(&store, "op-3", revision, &draft("用户喜欢喝茶", vec!["src-1"]));
    let after_first = store.status().unwrap().revision;
    let replay = store
        .apply_change("op-3", revision, "add", None, None, Some(&draft("用户喜欢喝茶", vec!["src-1"])))
        .unwrap();
    assert_eq!(replay, after_first, "重放同一条操作改动了版本");
    assert_eq!(store.list(Some("user"), None, 10).unwrap().len(), 2, "重放写入了第二条记忆");
}

#[test]
fn untrusted_sources_are_never_registered() {
    let (_fixture, store) = Fixture::new();
    let mut assistant = source("src-tool", "entry-tool", "hash-tool");
    assistant["taint"] = json!("untrusted");
    assistant["origin"] = json!("tool");
    assistant["eligibleForMemory"] = json!(false);
    assert_eq!(store.register_sources(&[assistant]).unwrap(), 0, "工具来源被登记成了用户事实");

    // 未登记来源的草稿不能落库：模型声明 provenance 不算证据。
    let orphan = store.apply_change("op-x", 0, "add", None, None, Some(&draft("用户有两只猫", vec!["src-ghost"])));
    assert!(orphan.is_err(), "未登记来源的记忆被写入");
}
