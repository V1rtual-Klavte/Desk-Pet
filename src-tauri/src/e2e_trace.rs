use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;

const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRACE_LINE_BYTES: usize = MAX_CHUNK_BYTES + 1024;
static TRACE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceBoundary {
    kind: String,
    scene_id: Option<String>,
    trial_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceRecord {
    seq: u64,
    scene_id: String,
    trial_id: String,
    orphan: bool,
    event: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceChunk {
    schema_version: u8,
    chunk_id: String,
    chunk_seq: u64,
    seq_from: Option<u64>,
    seq_to: Option<u64>,
    event_count: usize,
    dropped_count: usize,
    boundary: TraceBoundary,
    events: Vec<TraceRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedChunk {
    chunk: TraceChunk,
    content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceCursor {
    path_identity: String,
    trace_bytes: u64,
    chunk_seq: u64,
    chunk_id: String,
    content_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceChunkAck {
    chunk_id: String,
    chunk_seq: u64,
    persisted: bool,
}

#[tauri::command]
pub(crate) fn e2e_trace(
    paths: State<'_, AppPaths>,
    chunk: TraceChunk,
) -> AppResult<TraceChunkAck> {
    if !cfg!(debug_assertions) {
        return Err(AppError::Tool("trace 仅允许调试构建使用".into()));
    }
    if !crate::paths::is_e2e() {
        return Err(AppError::Tool("trace 仅允许 E2E 运行使用".into()));
    }
    append_chunk(&paths.data_root, chunk)
}

fn append_chunk(data_root: &Path, chunk: TraceChunk) -> AppResult<TraceChunkAck> {
    let _guard = TRACE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    validate_chunk(&chunk)?;
    let path = trace_file_path(data_root)?;
    let chunk_json = serde_json::to_vec(&chunk)
        .map_err(|e| AppError::Other(format!("trace chunk 序列化失败: {e}")))?;
    if chunk_json.len() > MAX_CHUNK_BYTES {
        return Err(AppError::Tool("trace chunk 超过 4 MiB".into()));
    }
    let content_sha256 = hex_sha256(&chunk_json);
    let cursor_path = ack_file_path(&path)?;
    let cursor = load_or_recover_cursor(&path, &cursor_path)?;
    if chunk.chunk_seq == cursor.chunk_seq
        && chunk.chunk_id == cursor.chunk_id
        && content_sha256 == cursor.content_sha256
    {
        return Ok(ack(&chunk));
    }
    if chunk.chunk_seq <= cursor.chunk_seq {
        return Err(AppError::Tool("已确认的历史 trace chunk 不接受重放".into()));
    }
    let expected_seq = cursor.chunk_seq + 1;
    if chunk.chunk_seq != expected_seq {
        return Err(AppError::Tool(format!(
            "trace chunkSeq 不连续: expected={expected_seq}, actual={}",
            chunk.chunk_seq
        )));
    }

    let persisted = PersistedChunk { chunk: chunk.clone(), content_sha256: content_sha256.clone() };
    let mut line = serde_json::to_vec(&persisted)
        .map_err(|e| AppError::Other(format!("trace envelope 序列化失败: {e}")))?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::Io(format!("打开 trace 文件失败: {e}")))?;
    file.write_all(&line)
        .and_then(|_| file.sync_all())
        .map_err(|e| AppError::Io(format!("持久化 trace chunk 失败: {e}")))?;
    let trace_bytes = file.metadata()
        .map_err(|e| AppError::Io(format!("读取 trace 文件长度失败: {e}")))?
        .len();
    persist_cursor(&cursor_path, TraceCursor {
        path_identity: path_identity(&path)?,
        trace_bytes,
        chunk_seq: chunk.chunk_seq,
        chunk_id: chunk.chunk_id.clone(),
        content_sha256: content_sha256.clone(),
    })?;
    Ok(ack(&chunk))
}

fn ack(chunk: &TraceChunk) -> TraceChunkAck {
    TraceChunkAck {
        chunk_id: chunk.chunk_id.clone(),
        chunk_seq: chunk.chunk_seq,
        persisted: true,
    }
}

fn validate_chunk(chunk: &TraceChunk) -> AppResult<()> {
    if chunk.schema_version != 1 || chunk.chunk_id.trim().is_empty() || chunk.chunk_seq == 0 {
        return Err(AppError::Tool("trace chunk 标识或 schema 无效".into()));
    }
    if chunk.event_count != chunk.events.len() {
        return Err(AppError::Tool("trace eventCount 与 events 不一致".into()));
    }
    if chunk.events.is_empty() {
        if chunk.seq_from.is_some() || chunk.seq_to.is_some() {
            return Err(AppError::Tool("空 trace chunk 不得带事件序号范围".into()));
        }
    } else {
        let first = chunk.events.first().map(|item| item.seq);
        let last = chunk.events.last().map(|item| item.seq);
        if chunk.seq_from != first || chunk.seq_to != last {
            return Err(AppError::Tool("trace 序号范围与 events 不一致".into()));
        }
        if chunk.events.windows(2).any(|items| items[0].seq >= items[1].seq) {
            return Err(AppError::Tool("trace event 序号必须严格递增".into()));
        }
    }
    Ok(())
}

fn trace_file_path(data_root: &Path) -> AppResult<PathBuf> {
    let root = data_root
        .canonicalize()
        .map_err(|e| AppError::Io(format!("解析 E2E 数据根失败: {e}")))?;
    let path = data_root.join("e2e-trace.jsonl");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err(AppError::PathEscape);
        }
    }
    let parent = path.parent().ok_or(AppError::PathEscape)?
        .canonicalize()
        .map_err(|e| AppError::Io(format!("解析 trace 目录失败: {e}")))?;
    if !parent.starts_with(root) {
        return Err(AppError::PathEscape);
    }
    Ok(path)
}

fn ack_file_path(trace_path: &Path) -> AppResult<PathBuf> {
    let path = trace_path.with_file_name("e2e-trace-ack.json");
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::PathEscape);
    }
    let temp = path.with_extension("json.tmp");
    if fs::symlink_metadata(&temp).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::PathEscape);
    }
    Ok(path)
}

fn path_identity(path: &Path) -> AppResult<String> {
    let resolved = if path.exists() {
        path.canonicalize()
    } else {
        path.parent().ok_or(AppError::PathEscape)?.canonicalize().map(|parent| {
            parent.join(path.file_name().unwrap_or_default())
        })
    }.map_err(|e| AppError::Io(format!("解析 trace 文件身份失败: {e}")))?;
    Ok(resolved.to_string_lossy().to_string())
}

fn load_or_recover_cursor(trace_path: &Path, cursor_path: &Path) -> AppResult<TraceCursor> {
    let identity = path_identity(trace_path)?;
    let trace_bytes = if trace_path.exists() {
        fs::metadata(trace_path).map_err(|e| AppError::Io(format!("读取 trace 元信息失败: {e}")))?.len()
    } else { 0 };
    if let Ok(text) = fs::read_to_string(cursor_path) {
        if let Ok(cursor) = serde_json::from_str::<TraceCursor>(&text) {
            if cursor.path_identity == identity && cursor.trace_bytes == trace_bytes {
                return Ok(cursor);
            }
        }
    }
    recover_cursor(trace_path, identity, trace_bytes)
}

/// Crash recovery streams one bounded JSONL row at a time and retains only the last ACK cursor.
fn recover_cursor(path: &Path, identity: String, trace_bytes: u64) -> AppResult<TraceCursor> {
    let mut cursor = TraceCursor {
        path_identity: identity,
        trace_bytes: 0,
        chunk_seq: 0,
        chunk_id: String::new(),
        content_sha256: String::new(),
    };
    if !path.exists() { return Ok(cursor); }
    let file = File::open(path).map_err(|e| AppError::Io(format!("恢复 trace cursor 失败: {e}")))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = read_bounded_line(&mut reader, &mut line)
            .map_err(|e| AppError::Io(format!("扫描 trace JSONL 失败: {e}")))?;
        if read == 0 { break; }
        if line.last() != Some(&b'\n') {
            return Err(AppError::Io("trace 文件末行不完整，需先 salvage".into()));
        }
        line.pop();
        let persisted: PersistedChunk = serde_json::from_slice(&line)
            .map_err(|e| AppError::Io(format!("trace 文件包含损坏记录: {e}")))?;
        validate_chunk(&persisted.chunk)?;
        let chunk_bytes = serde_json::to_vec(&persisted.chunk)
            .map_err(|e| AppError::Other(format!("trace chunk 校验失败: {e}")))?;
        if hex_sha256(&chunk_bytes) != persisted.content_sha256 {
            return Err(AppError::Io("trace chunk SHA-256 校验失败".into()));
        }
        let expected = cursor.chunk_seq + 1;
        if persisted.chunk.chunk_seq != expected {
            return Err(AppError::Io("trace 文件中的 chunkSeq 不连续".into()));
        }
        cursor.chunk_seq = persisted.chunk.chunk_seq;
        cursor.chunk_id = persisted.chunk.chunk_id;
        cursor.content_sha256 = persisted.content_sha256;
        cursor.trace_bytes += read as u64;
    }
    if cursor.trace_bytes != trace_bytes {
        return Err(AppError::Io("trace cursor 扫描长度与文件长度不符".into()));
    }
    Ok(cursor)
}

fn read_bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<usize> {
    let mut total = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() { return Ok(total); }
        let count = available.iter().position(|byte| *byte == b'\n').map_or(available.len(), |index| index + 1);
        if line.len() + count > MAX_TRACE_LINE_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "trace JSONL 行超过 4 MiB 限制"));
        }
        let complete = available[count - 1] == b'\n';
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        total += count;
        if complete { return Ok(total); }
    }
}

fn persist_cursor(path: &Path, cursor: TraceCursor) -> AppResult<()> {
    let temp = path.with_extension("json.tmp");
    if fs::symlink_metadata(&temp).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::PathEscape);
    }
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|e| AppError::Other(format!("序列化 trace ACK 失败: {e}")))?;
    let mut file = File::create(&temp)
        .map_err(|e| AppError::Io(format!("创建 trace ACK 临时文件失败: {e}")))?;
    file.write_all(&bytes).and_then(|_| file.sync_all())
        .map_err(|e| AppError::Io(format!("持久化 trace ACK 失败: {e}")))?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| AppError::Io(format!("替换 trace ACK 失败: {e}")))?;
    }
    fs::rename(&temp, path).map_err(|e| AppError::Io(format!("发布 trace ACK 失败: {e}")))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("desk-pet-trace-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn chunk(chunk_seq: u64, chunk_id: &str) -> TraceChunk {
        TraceChunk {
            schema_version: 1,
            chunk_id: chunk_id.into(),
            chunk_seq,
            seq_from: Some(chunk_seq),
            seq_to: Some(chunk_seq),
            event_count: 1,
            dropped_count: 0,
            boundary: TraceBoundary { kind: "scene_end".into(), scene_id: Some("s".into()), trial_id: Some("t".into()) },
            events: vec![TraceRecord {
                seq: chunk_seq,
                scene_id: "s".into(),
                trial_id: "t".into(),
                orphan: false,
                event: serde_json::json!({"kind":"turn_end"}),
            }],
        }
    }

    #[test]
    fn durable_append_returns_same_ack_for_exact_retry() {
        let root = root();
        let first = append_chunk(&root, chunk(1, "chunk-1")).unwrap();
        let retry = append_chunk(&root, chunk(1, "chunk-1")).unwrap();
        assert_eq!(first.chunk_id, retry.chunk_id);
        assert_eq!(first.chunk_seq, retry.chunk_seq);
        assert_eq!(fs::read_to_string(root.join("e2e-trace.jsonl")).unwrap().lines().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_ack_cursor_recovers_from_jsonl_and_exact_last_retry_is_idempotent() {
        let root = root();
        let first = append_chunk(&root, chunk(1, "chunk-1")).unwrap();
        fs::remove_file(root.join("e2e-trace-ack.json")).unwrap();
        let retry = append_chunk(&root, chunk(1, "chunk-1")).unwrap();
        assert_eq!(first.chunk_id, retry.chunk_id);
        assert_eq!(fs::read_to_string(root.join("e2e-trace.jsonl")).unwrap().lines().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_rejects_sequence_gap_and_chunk_id_reuse_with_new_content() {
        let root = root();
        append_chunk(&root, chunk(1, "chunk-1")).unwrap();
        append_chunk(&root, chunk(2, "chunk-2")).unwrap();
        assert!(matches!(append_chunk(&root, chunk(1, "chunk-1")), Err(AppError::Tool(_))));
        assert!(matches!(append_chunk(&root, chunk(4, "chunk-4")), Err(AppError::Tool(_))));
        let mut changed = chunk(2, "chunk-2");
        changed.dropped_count = 1;
        assert!(matches!(append_chunk(&root, changed), Err(AppError::Tool(_))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_rejects_oversized_jsonl_line_with_bounded_read_buffer() {
        let root = root();
        let path = root.join("e2e-trace.jsonl");
        let mut file = File::create(&path).unwrap();
        file.write_all(&vec![b'x'; MAX_TRACE_LINE_BYTES + 1]).unwrap();
        file.write_all(b"\n").unwrap();
        file.sync_all().unwrap();
        let result = recover_cursor(&path, path.to_string_lossy().to_string(), MAX_TRACE_LINE_BYTES as u64 + 2);
        assert!(matches!(result, Err(AppError::Io(_))));
        fs::remove_dir_all(root).unwrap();
    }
}
