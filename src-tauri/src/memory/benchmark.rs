//! Evaluation-only storage benchmark. Production uses the same MemoryStore methods.
use super::MemoryStore;
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
#[cfg(test)]
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(debug_assertions)]
static STORE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn e2e_memory_reset(state: tauri::State<'_, super::MemoryState>, paths: tauri::State<'_, crate::paths::AppPaths>) -> AppResult<Value> {
    if !cfg!(debug_assertions) || !crate::paths::is_e2e() {
        return Err(AppError::Config("记忆重置仅允许隔离 E2E debug 宿主".into()));
    }
    #[cfg(debug_assertions)]
    {
        crate::paths::AppPaths::validate_path(&paths.memory, &paths.data_root)?;
        let status = state.0.reset_for_evaluation()?;
        return Ok(json!({"generation": STORE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1, "status": status, "freshStore": true}));
    }
    #[cfg(not(debug_assertions))]
    { let _ = (state, paths); Err(AppError::Config("release 不开放评测重置".into())) }
}

pub const PERF_SAMPLES: usize = 100;
pub const PERF_SIZES: [usize; 2] = [1_000, 10_000];
pub const HOT_QUERY_P95_TARGET_MS: f64 = 500.0;

fn hot_target_met(measurements: &Value) -> bool {
    measurements["queries"].as_array().is_some_and(|queries| {
        queries.len() == 4 && queries.iter().all(|row| row["latency"]["p95Ms"].as_f64().is_some_and(|ms| ms <= HOT_QUERY_P95_TARGET_MS))
    })
}

fn elapsed_ms(start: Instant) -> f64 { start.elapsed().as_secs_f64() * 1_000.0 }

pub fn summarize(samples: &[f64]) -> Value {
    if samples.is_empty() { return json!({"count":0,"p50Ms":null,"p95Ms":null,"maxMs":null,"samplesMs":[]}); }
    let mut ordered = samples.to_vec();
    ordered.sort_by(f64::total_cmp);
    let percentile = |p: f64| ordered[((ordered.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"count": ordered.len(), "p50Ms": percentile(0.5), "p95Ms": percentile(0.95), "maxMs": ordered.last(), "samplesMs": samples})
}

/// Fixed, synthetic evidence; all writes go through source admission and revision transactions.
pub fn seed(store: &MemoryStore, count: usize, namespace: &str) -> AppResult<Value> {
    if !PERF_SIZES.contains(&count) { return Err(AppError::Config("性能数据集只允许 1k / 10k".into())); }
    let start = Instant::now();
    let mut revision = store.status()?.revision;
    revision = store.apply_change(&format!("{namespace}-clear"), revision, "clear", None, None, None)?;
    let observed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    for index in 0..count {
        let source = format!("{namespace}-source-{index}");
        let content = format!("用户的测试档案编号 {index:05}，喜欢咖啡和冰美式，旅行地点编号 {index:05}");
        store.register_sources(&[json!({
            "sourceId": source, "sessionId": namespace, "entryId": format!("{namespace}-entry-{index}"),
            "eventId": format!("{namespace}-event-{index}"), "seq": index + 1,
            "contentHash": format!("synthetic-{namespace}-{index}"), "evidence": content,
            "eligibleForMemory": true, "origin": "user", "taint": "trusted_user", "observedAt": observed
        })])?;
        let draft = json!({"content": content, "summary": content, "kind":"fact", "scope":"user",
            "aliases":[], "pinned":false, "importance":5, "confidence":1, "sourceIds":[source]});
        revision = store.apply_change(&format!("{namespace}-add-{index}"), revision, "add", None, None, Some(&draft))?;
    }
    let actual = store.status()?.item_count;
    if actual != count as i64 { return Err(AppError::Memory(format!("性能 fixture 数量错误: {actual}/{count}"))); }
    Ok(json!({"count":count, "revision": revision, "seedMs":elapsed_ms(start)}))
}

pub fn measure(store: &MemoryStore, namespace: &str) -> AppResult<Value> {
    let mut query_reports = Vec::new();
    for query in ["咖啡", "冰美式", "编号 00500", "完全无关的火星银行密码"] {
        let mut samples = Vec::with_capacity(PERF_SAMPLES);
        let mut hits = 0;
        for _ in 0..PERF_SAMPLES {
            let start = Instant::now();
            let items = store.query(query, Some("user"), None, None, 50)?;
            let ids = items.iter().filter_map(|item| item["id"].as_str().map(str::to_owned)).collect::<Vec<_>>();
            let full = store.get_items(&ids)?;
            if full.len() != items.len() { return Err(AppError::Memory("查询和取全文的条目数量不一致".into())); }
            hits = full.len();
            samples.push(elapsed_ms(start));
        }
        if (query.starts_with("完全无关") && hits != 0) || (!query.starts_with("完全无关") && hits == 0) {
            return Err(AppError::Memory(format!("性能查询结果错误: {query}, hits={hits}")));
        }
        query_reports.push(json!({"query":query,"hits":hits,"latency":summarize(&samples)}));
    }
    let start = Instant::now();
    store.rebuild()?;
    let rebuild_ms = elapsed_ms(start);
    let job = store.job_start("review", namespace)?;
    let revision = store.status()?.revision;
    let sources = store.query("咖啡", Some("user"), None, None, 1)?;
    let draft = &sources[0]["draft"];
    let candidate_id = format!("{namespace}-publish-candidate");
    let job_id = job["id"].as_str().ok_or_else(|| AppError::Memory("性能 job 缺少 id".into()))?;
    store.candidates_add(job_id, &[json!({"id":candidate_id,"draft":draft,"payloadHash":super::store::payload_hash(draft),"baseRevision":revision})])?;
    let start = Instant::now();
    store.commit_dreaming_job(job_id, revision)?;
    let publish_ms = elapsed_ms(start);
    let start = Instant::now();
    let backup = store.backup()?;
    Ok(json!({"queries":query_reports,"rebuildMs":rebuild_ms,"publishMs":publish_ms,"backupMs":elapsed_ms(start),"backupBytes":std::fs::metadata(backup)?.len()}))
}

#[cfg(test)]
fn disk_bytes(path: &Path) -> AppResult<u64> {
    let mut total = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        total += if metadata.is_dir() { disk_bytes(&entry.path())? } else { metadata.len() };
    }
    Ok(total)
}

#[tauri::command]
pub fn e2e_memory_performance(state: tauri::State<'_, super::MemoryState>, count: usize) -> AppResult<Value> {
    if !cfg!(debug_assertions) || !crate::paths::is_e2e() {
        return Err(AppError::Config("性能 IPC 仅允许隔离 E2E debug 宿主".into()));
    }
    let namespace = format!("ipc-perf-{count}-{}", state.0.status()?.revision);
    let fixture = seed(&state.0, count, &namespace)?;
    let measurements = measure(&state.0, &namespace)?;
    let initial_target_met = count != 10_000 || hot_target_met(&measurements);
    Ok(json!({"fixture":fixture,"measurements":measurements,"initialTargetMet":initial_target_met,
        "target":{"datasetSize":10_000,"p95Ms":HOT_QUERY_P95_TARGET_MS},
        "clockDomain":"rust-instant","build":"debug","scope":"native-storage"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank_without_averaging_tail() {
        let result = summarize(&[100.0, 1.0, 2.0, 3.0]);
        assert_eq!(result["p50Ms"], json!(2.0));
        assert_eq!(result["p95Ms"], json!(100.0));
    }

    #[test]
    fn hot_target_requires_every_query_and_measured_tail() {
        let good = json!({"queries": [{"latency":{"p95Ms":5}}, {"latency":{"p95Ms":5}}, {"latency":{"p95Ms":50}}, {"latency":{"p95Ms":5}}]});
        assert!(hot_target_met(&good));
        let mut slow = good.clone();
        slow["queries"][2]["latency"]["p95Ms"] = json!(501);
        assert!(!hot_target_met(&slow));
        slow["queries"][2]["latency"]["p95Ms"] = Value::Null;
        assert!(!hot_target_met(&slow));
        assert!(!hot_target_met(&json!({"queries":[]})));
    }

    #[test]
    #[ignore = "explicit release benchmark, started by scripts/memory-performance.mjs"]
    fn release_storage_benchmark() {
        assert!(!cfg!(debug_assertions), "性能基线必须用 --release");
        let root = std::env::var("DESKPET_MEMORY_PERF_ROOT").expect("由性能启动器提供独立临时根");
        let root = Path::new(&root);
        assert!(root.is_absolute() && root.file_name().unwrap().to_string_lossy().starts_with("memory-perf-"));
        println!("MEMORY_PERF_STARTED");
        let mut datasets = Vec::new();
        for count in PERF_SIZES {
            let directory = root.join(format!("{count}"));
            let db = directory.join("memory.sqlite3");
            let store = MemoryStore::open_at(&db).expect("独立数据库");
            let fixture = seed(&store, count, &format!("release-{count}")).expect("真实存储 fixture");
            drop(store);
            let mut reopen_samples = Vec::new();
            for _ in 0..20 {
                let start = Instant::now();
                let reopened = MemoryStore::open_at(&db).expect("重新打开");
                let items = reopened.query("咖啡", Some("user"), None, None, 50).expect("重开检索");
                assert_eq!(items.len(), 50);
                reopen_samples.push(elapsed_ms(start));
                drop(reopened);
            }
            let store = MemoryStore::open_at(&db).expect("热连接");
            let measurements = measure(&store, &format!("measure-{count}")).expect("存储测量");
            drop(store);
            datasets.push(json!({"fixture":fixture,"reopenAndQuery":summarize(&reopen_samples),"measurements":measurements,"diskBytes":disk_bytes(&directory).unwrap()}));
        }
        let passed = datasets.iter().filter(|row| row["fixture"]["count"] == json!(10_000)).all(|row| hot_target_met(&row["measurements"]));
        let report = json!({"schemaVersion":"desk-pet-memory-performance/v1","build":"release","scope":"native-storage","clockDomain":"rust-instant","coldDefinition":"connection reopen; OS page cache is uncontrolled","target":{"datasetSize":10_000,"p95Ms":HOT_QUERY_P95_TARGET_MS,"queries":"all four representative query + get_items paths"},"passed":passed,"datasets":datasets});
        std::fs::write(root.join("native.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        assert!(passed, "10k 热路径 P95 超出 500ms；测量已保存在 native.json");
    }
}
