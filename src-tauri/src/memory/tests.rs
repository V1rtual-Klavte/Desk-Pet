//! 记忆库的单元测试：每条都钉住一条产品规则，改坏实现就会红。

use super::protocol::{MEMORY_COMMANDS, MEMORY_SCHEMA_VERSION};
use super::schema::SCHEMA_VERSION;
use super::MemoryStore;
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

#[test]
fn protocol_commands_match_published_schema() {
    // 协议文件是跨 Rust/TS 的唯一边界：命令清单与 schema 版本必须与实现同源。
    assert!(MEMORY_COMMANDS.contains(&"memory_query"));
    assert!(MEMORY_COMMANDS.contains(&"memory_publish_batch"));
    assert_eq!(MEMORY_COMMANDS.len(), 19, "命令数量变了就要同步 protocol.json 与 ipc.ts");
    assert_eq!(MEMORY_SCHEMA_VERSION, SCHEMA_VERSION);
}

#[test]
fn chinese_two_character_queries_match_via_like_fallback() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    add(&store, "op-1", 0, &draft("用户喜欢喝冰美式咖啡", vec!["src-1"]));

    // 「咖啡」只有两个 Unicode 字符：FTS5 trigram 的 MATCH 对它永远零命中，
    // 召回必须靠短词 LIKE 回退才能命中 —— 这是中文陪伴场景最常见的查询形态。
    let short = store.query("咖啡", None, None, 10).unwrap();
    assert_eq!(short.len(), 1, "两字中文查询没有命中（短词回退失效）");
    assert_eq!(short[0]["draft"]["content"], json!("用户喜欢喝冰美式咖啡"));

    // 三字以上的查询走 FTS 正常命中；无关查询不得返回任何条目。
    assert_eq!(store.query("冰美式", None, None, 10).unwrap().len(), 1);
    assert!(store.query("用户的银行卡号", None, None, 10).unwrap().is_empty());
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
    card_draft["scopeId"] = json!("candy");
    add(&store, "op-2", 1, &card_draft);
    let mut expiring = draft("用户这周在出差", vec!["src-1"]);
    expiring["expiresAt"] = json!(1_000i64);
    add(&store, "op-3", 2, &expiring);

    assert_eq!(store.query("猫", Some("user"), None, 10).unwrap().len(), 1);
    assert!(
        store.query("老板", Some("user"), None, 10).unwrap().is_empty(),
        "user 范围查询返回了 card 范围的记忆"
    );
    assert_eq!(store.query("老板", Some("card"), Some("candy"), 10).unwrap().len(), 1);
    assert!(
        store.query("出差", None, None, 10).unwrap().is_empty(),
        "已过有效期的记忆仍被召回"
    );
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
    assert!(store.query("杭州", None, None, 10).unwrap().is_empty(), "遗忘后仍能召回");

    // 同一来源事件不得重新进入候选：索引重建与旧水位补扫都要被拦住。
    let written = store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    assert_eq!(written, 0, "被遗忘的来源重新登记成功（防回灌失效）");
    assert_eq!(store.rebuild().unwrap(), 0, "重建索引复活了已遗忘的条目");
    assert!(store.query("杭州", None, None, 10).unwrap().is_empty());
}

#[test]
fn pending_candidates_stay_out_of_recall_until_published() {
    let (_fixture, store) = Fixture::new();
    store.register_sources(&[source("src-1", "entry-1", "hash-1")]).unwrap();
    let job = store.job_start("review").unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();
    let written = store
        .candidates_add(
            &job_id,
            &[json!({"draft": draft("用户喜欢喝拿铁", vec!["src-1"]), "payloadHash": "hash-a"})],
        )
        .unwrap();
    assert_eq!(written, 1);
    assert!(
        store.query("拿铁", None, None, 10).unwrap().is_empty(),
        "未审批的候选进入了召回"
    );

    let pending = store.review_batch(&job_id).unwrap();
    assert_eq!(pending.len(), 1);
    let candidate_id = pending[0]["id"].as_str().unwrap().to_string();

    // 基准过期（这里故意用旧版本）必须拒绝，不能静默覆盖。
    let stale = store.publish_batch(&job_id, &[candidate_id.clone()], 999);
    assert!(matches!(stale, Err(AppError::MemoryConflict)));

    let revision = store.status().unwrap().revision;
    store.publish_batch(&job_id, &[candidate_id], revision).expect("发布获批候选");
    assert_eq!(store.query("拿铁", None, None, 10).unwrap().len(), 1);
    assert!(store.review_batch(&job_id).unwrap().is_empty(), "已发布的候选仍在待审清单里");
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
