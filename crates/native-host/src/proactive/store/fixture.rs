//! 主动陪伴存储单测共用的临时库夹具。

use super::{connection, now_ms};
use crate::error::AppResult;
use crate::memory::MemoryStore;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) static NEXT: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Fixture(pub(super) PathBuf, pub(super) MemoryStore);
impl Fixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "deskpet-proactive-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("打开测试库");
        store.register_sources(&[json!({"sourceId":"user-source","sessionId":"s1","entryId":"e1","eventId":"user-event","seq":1,"contentHash":"hash-1","evidence":"明天提醒我","eligibleForMemory":true,"taint":"trusted_user","origin":"user","observedAt":1_700_000_000_000i64})]).expect("登记用户来源");
        Self(root, store)
    }
    pub(super) fn owner() -> Value {
        json!({"sessionId":"s1","cardId":"card-a","cardHash":"hash-a","runGeneration":1})
    }
    pub(super) fn source_ref() -> Value {
        json!({"kind":"user_entry","id":"user-source","version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":"s1:e1:hash-1","validUntil":null})
    }
    pub(super) fn create(&self, id: &str, recurrence: Option<Value>) -> AppResult<Value> {
        let owner = Self::owner();
        let revision = self
            .1
            .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))?
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap();
        self.1.proactive_change(&json!({"operationId":format!("op-{id}"),"baseRevision":revision,"action":"create","owner":owner,"trustedUserEventId":"user-event","sourceRefs":[Self::source_ref()],"taskPatch":{"id":id,"scope":"session","scopeId":"s1","sourceRefs":[Self::source_ref()],"intent":{"text":"提醒"},"nextCheckinAt":now_ms()+60_000,"validUntil":null,"timezone":"UTC","recurrence":recurrence,"eventAt":null,"dueAt":null}}))
    }
    pub(super) fn add_working_item(&self) -> String {
        self.1.apply_change("memory-working-add",0,"add",None,None,Some(&json!({"content":"练琴计划","summary":"练琴计划","kind":"working","scope":"session","scopeId":"s1","aliases":[],"pinned":false,"importance":5.0,"confidence":0.9,"sourceIds":["user-source"],"eventAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"},"dueAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"},"workingState":"open"}))).expect("创建working记忆");
        let conn = connection(&self.1).expect("锁库");
        conn.query_row(
            "SELECT id FROM memory_items WHERE status='active' AND kind='working'",
            [],
            |row| row.get(0),
        )
        .expect("读取working记忆id")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
