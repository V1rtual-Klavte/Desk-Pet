//! 会话索引单测共用的临时库夹具与条目构造。

use super::ConversationIndexEntry;
use crate::memory::MemoryStore;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

pub(super) static NEXT: AtomicU64 = AtomicU64::new(0);

pub(super) struct Fixture(pub(super) PathBuf, pub(super) MemoryStore);

impl Fixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "deskpet-conversation-index-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, AtomicOrdering::SeqCst)
        ));
        let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("open store");
        Self(root, store)
    }

    pub(super) fn replace(
        &self,
        session: &str,
        fp: &str,
        expected: Option<&str>,
        rows: Vec<ConversationIndexEntry>,
        epoch: i64,
    ) -> i64 {
        self.1
            .conversation_index_replace(session, fp, expected, epoch, &rows, None)
            .expect("replace session index")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn entry(
    id: &str,
    event: Option<&str>,
    seq: i64,
    role: &str,
    text: &str,
    anchor: Option<&str>,
) -> ConversationIndexEntry {
    ConversationIndexEntry {
        entry_id: id.into(),
        event_id: event.map(str::to_string),
        seq,
        chunk: 0,
        role: role.into(),
        text: text.into(),
        search_text: String::new(),
        event_at_ms: None,
        event_at_date: None,
        timestamp: 1_700_000_000_000 + seq,
        anchor_entry_id: anchor.map(str::to_string),
        anchor_event_id: None,
        memory_refs: Vec::new(),
        quote_refs: Vec::new(),
    }
}

pub(super) fn seed_fact(fixture: &Fixture, id: &str) {
    let conn = fixture.1.lock().expect("memory lock");
    conn.execute(
        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,created_at,updated_at)
         VALUES (?1,1,'active','对花生过敏','花生过敏','preference','global','[]',0,0.5,0.9,1,1)",
        [id],
    )
    .expect("seed fact");
}

pub(super) fn drop_fact(fixture: &Fixture, id: &str) {
    let conn = fixture.1.lock().expect("memory lock");
    conn.execute("DELETE FROM memory_items WHERE id=?1", [id])
        .expect("drop fact");
}

pub(super) fn seed_sourced_fact(
    fixture: &Fixture,
    id: &str,
    session: &str,
    entry_id: &str,
    event_id: &str,
    text: &str,
) {
    let conn = fixture.1.lock().expect("memory lock");
    conn.execute(
        "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at)
         VALUES (?1,?2,?3,?4,1,'hash',NULL,NULL,'trusted_user','user',1)",
        params![format!("src-{entry_id}"), session, entry_id, event_id],
    )
    .expect("seed source");
    conn.execute(
        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,created_at,updated_at,content_norm,summary_norm)
         VALUES (?1,1,'active',?2,?2,'preference','global','[]',0,0.5,0.9,1,NULL,NULL,1,1,?2,?2)",
        params![id, text],
    )
    .expect("seed fact");
    conn.execute(
        "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,1,?2)",
        params![id, format!("src-{entry_id}")],
    )
    .expect("seed source link");
}

pub(super) fn supersede_fact(
    fixture: &Fixture,
    id: &str,
    at: i64,
    text: &str,
    source: Option<(&str, &str, &str)>,
) {
    let conn = fixture.1.lock().expect("memory lock");
    let version: i64 = conn
        .query_row(
            "SELECT MAX(version) FROM memory_items WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .expect("current version");
    let next = version + 1;
    conn.execute(
        "UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",
        params![id, at],
    )
    .expect("close old version");
    conn.execute(
        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,created_at,updated_at,content_norm,summary_norm)
         VALUES (?1,?2,'active',?3,?3,'preference','global','[]',0,0.5,0.9,1,?4,NULL,?4,?4,?3,?3)",
        params![id, next, text, at],
    )
    .expect("insert new version");
    if let Some((session, entry_id, event_id)) = source {
        conn.execute(
            "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at)
             VALUES (?1,?2,?3,?4,1,'hash',NULL,NULL,'trusted_user','user',?5)",
            params![format!("src-{entry_id}"), session, entry_id, event_id, at],
        )
        .expect("seed correction source");
        conn.execute(
            "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3)",
            params![id, next, format!("src-{entry_id}")],
        )
        .expect("link correction source");
    }
}

pub(super) fn search_entry_ids(fixture: &Fixture, query: &str, session: &str) -> Vec<String> {
    fixture
        .1
        .conversation_search(query, session, Some(10), None, false, false, &[], &[], None, None)
        .expect("search")
        ["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|row| row["entryId"].as_str().expect("entry id").to_string())
        .collect()
}
