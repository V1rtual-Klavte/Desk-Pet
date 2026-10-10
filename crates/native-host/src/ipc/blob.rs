// ==========================================
// HostBlobRef 注册表：owner/scope 校验、长度与生命周期
// ==========================================
//
// 大内容不经控制帧 JSON 传输：宿主把字节登记为短期句柄（[`HostBlobRef`]），
// Node 用句柄经二进制通道读取；Node 上传的参数大字段（字符串/字节/完整 JSON）也登记在这里，
// 由请求引用并一次性取走（take）。
//
// 安全边界（执行契约 §4.2）：
// - **任意路径不等于 blob 授权**。本模块没有任何「从路径签发句柄」的入口：
//   句柄只由宿主代码在完成路径校验（`paths` 模块的 validate_*）并读成字节后签发，
//   结构上不存在 path → blob 的捷径。调用方签发的 scope 必须来自当次运行的真实归属。
// - owner 校验：句柄带 [`RunScope`]，读取方必须与 app_epoch/node_epoch 完全一致，
//   session/run/generation/turn/toolCall 等更细的归属逐项匹配；旧代际即失效。
// - 拒绝即归还：scope 不匹配的读取会把句柄从注册表移除（不可复活），
//   调用方需要数据时须重新签发 —— 这避免旧消费者反复撞旧句柄。
// - 生命周期：单句柄字节上限 [`BLOB_MAX_BYTES`]，空闲超时 [`BLOB_IDLE_TTL`]；
//   连接断开（`revoke_peer_epoch`）、epoch 轮换、显式 release 都会归还句柄。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::protocol::{HostBlobRef, RunScope};
use crate::error::{AppError, AppResult};
use crate::rust_warn;

/// 单个 blob 的字节上限。控制帧上限管不住 blob，这里单独兜底（W2 约定；
/// 上限存在的意义是防止本地误用/失控分配，而不是业务额度）。
pub const BLOB_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// 未被消费的 blob 的空闲期限；后续签发、上传或读取时机会回收，不另开常驻计时器。
pub const BLOB_IDLE_TTL: Duration = Duration::from_secs(300);

/// 结果/参数中的 blob 标记键（两个方向各一枚，形状固定，两侧唯一约定）：
/// - `$hostBlobRef`：宿主签发、Node 侧物化（读回完整原值）；
/// - `$wireBlob`：Node 上传的参数大字段，宿主侧物化（还原字符串或字节数组）。
pub const HOST_BLOB_MARKER_KEY: &str = "$hostBlobRef";
pub const UPLOAD_MARKER_KEY: &str = "$wireBlob";

/// 句柄来源。宿主签发的句柄可被读多次（取消/释放前）；上传句柄一次性取走。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobOrigin {
    HostIssued,
    PeerUpload,
}

/// 上传内容的还原类型（对应二进制通道 `BlobKind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireBlobKind {
    Text,
    Bytes,
    Json,
}

#[derive(Debug, Clone)]
struct BlobEntry {
    origin: BlobOrigin,
    scope: RunScope,
    bytes: Arc<[u8]>,
    kind: Option<WireBlobKind>,
    touched_at: Instant,
}

#[derive(Default)]
struct RegistryInner {
    entries: HashMap<String, BlobEntry>,
}

/// 进程内 blob 注册表。跨 Node 代际共享（轮换时按 epoch 回收旧句柄）。
#[derive(Default)]
pub struct BlobRegistry {
    inner: Mutex<RegistryInner>,
}

/// 解析出的上传标记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadMarker {
    pub id: String,
    pub kind: WireBlobKind,
}

impl BlobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 宿主签发句柄。`bytes` 必须是调用方**已完成路径校验**后读到的内容；
    /// 本函数不接触路径。超上限即拒绝（不登记）。
    pub fn issue_host_blob(
        &self,
        scope: RunScope,
        bytes: Vec<u8>,
        mime_type: Option<String>,
    ) -> AppResult<HostBlobRef> {
        let len = bytes.len() as u64;
        if len > BLOB_MAX_BYTES {
            return Err(AppError::Other(format!(
                "blob {len} 字节超过单句柄上限 {BLOB_MAX_BYTES}"
            )));
        }
        let id = super::transport::random_hex(16)?;
        let now = Instant::now();
        self.purge_expired(now);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.insert(
            id.clone(),
            BlobEntry {
                origin: BlobOrigin::HostIssued,
                scope: scope.clone(),
                bytes: Arc::from(bytes.into_boxed_slice()),
                kind: None,
                touched_at: now,
            },
        );
        Ok(HostBlobRef {
            id,
            bytes: len,
            mime_type,
            scope,
        })
    }

    /// 登记一次 Node 上传（二进制通道收齐全部块后调用）。
    /// `upload_id` 由 Node 在 `blobOpen` 公告里生成；与已有句柄撞 id 即拒绝
    /// （不允许上传覆盖宿主签发的句柄）。
    pub fn register_upload(
        &self,
        upload_id: &str,
        scope: RunScope,
        bytes: Vec<u8>,
        kind: WireBlobKind,
    ) -> AppResult<()> {
        let len = bytes.len() as u64;
        if len > BLOB_MAX_BYTES {
            return Err(AppError::Other(format!(
                "上传 {len} 字节超过单句柄上限 {BLOB_MAX_BYTES}"
            )));
        }
        let now = Instant::now();
        self.purge_expired(now);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.entries.contains_key(upload_id) {
            return Err(AppError::Other("上传 id 与已有句柄冲突".into()));
        }
        inner.entries.insert(
            upload_id.to_string(),
            BlobEntry {
                origin: BlobOrigin::PeerUpload,
                scope,
                bytes: Arc::from(bytes.into_boxed_slice()),
                kind: Some(kind),
                touched_at: now,
            },
        );
        Ok(())
    }

    /// 一次性取走上传内容（供分派前的参数物化）。scope 不匹配/已被取走即失败。
    pub fn take_upload(
        &self,
        upload_id: &str,
        requester: &RunScope,
    ) -> AppResult<(Arc<[u8]>, WireBlobKind)> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = inner.entries.get(upload_id) else {
            return Err(AppError::Other(
                "上传句柄不存在或已被消费（每个上传只可引用一次）".into(),
            ));
        };
        if entry.origin != BlobOrigin::PeerUpload {
            return Err(AppError::Other("句柄不是上传句柄".into()));
        }
        if let Err(reason) = scope_allows(&entry.scope, requester) {
            // 拒绝即归还：旧 scope 的上传不可复活。
            inner.entries.remove(upload_id);
            return Err(AppError::Other(format!(
                "上传句柄 scope 校验失败: {reason}"
            )));
        }
        let entry = inner.entries.remove(upload_id).expect("上面已确认存在");
        let kind = entry.kind.unwrap_or(WireBlobKind::Bytes);
        Ok((entry.bytes, kind))
    }

    /// 读取宿主签发的句柄。scope 不匹配时**拒绝并归还句柄**。
    pub fn open_read(&self, blob_id: &str, requester: &RunScope) -> AppResult<Arc<[u8]>> {
        self.purge_expired(Instant::now());
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = inner.entries.get_mut(blob_id) else {
            return Err(AppError::Other("blob 句柄不存在或已归还".into()));
        };
        if entry.origin != BlobOrigin::HostIssued {
            return Err(AppError::Other("句柄不是宿主签发的 blob".into()));
        }
        if let Err(reason) = scope_allows(&entry.scope, requester) {
            inner.entries.remove(blob_id);
            rust_warn!("blob 句柄 scope 校验失败，已归还: {reason}");
            return Err(AppError::Other(format!("blob scope 校验失败: {reason}")));
        }
        entry.touched_at = Instant::now();
        Ok(entry.bytes.clone())
    }

    /// 显式归还句柄（releaseBlob / 传输中止）。返回是否真的存在过。
    pub fn release(&self, blob_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.remove(blob_id).is_some()
    }

    /// 归还所有早于 `(app_epoch, node_epoch)` 的句柄（Node 崩溃重启/代际轮换）。
    /// 返回归还数量。当前代际的句柄保留。
    pub fn revoke_before_epoch(&self, app_epoch: &str, node_epoch: u64) -> usize {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.scope.app_epoch != app_epoch || entry.scope.node_epoch < node_epoch
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            inner.entries.remove(id);
        }
        stale.len()
    }

    /// 归还全部句柄（连接断开、关停）。
    pub fn revoke_all(&self) -> usize {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let count = inner.entries.len();
        inner.entries.clear();
        count
    }

    /// 清理空闲超时的句柄。
    pub fn purge_expired(&self, now: Instant) -> usize {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let expired: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.touched_at) > BLOB_IDLE_TTL)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            inner.entries.remove(id);
        }
        expired.len()
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// scope 校验。返回拒绝原因（None 表示允许）。
///
/// 规则：app_epoch 与 node_epoch 必须**完全相等**（旧代际与「未来代际」都拒绝）；
/// 句柄 scope 里出现的更细归属（session/run generation/run/turn/toolCall），
/// 读取方必须逐项相等给出，缺失即不匹配。
pub fn scope_allows(entry: &RunScope, requester: &RunScope) -> Result<(), String> {
    if entry.app_epoch != requester.app_epoch {
        return Err("appEpoch 不匹配（宿主进程已换代）".into());
    }
    if entry.node_epoch != requester.node_epoch {
        return Err(format!(
            "nodeEpoch 不匹配（句柄 {} / 请求方 {}）",
            entry.node_epoch, requester.node_epoch
        ));
    }
    if let Some(v) = &entry.session_id {
        if requester.session_id.as_ref() != Some(v) {
            return Err("sessionId 不匹配".into());
        }
    }
    if let Some(v) = entry.run_generation {
        if requester.run_generation != Some(v) {
            return Err("runGeneration 不匹配".into());
        }
    }
    if let Some(v) = &entry.run_id {
        if requester.run_id.as_ref() != Some(v) {
            return Err("runId 不匹配".into());
        }
    }
    if let Some(v) = &entry.turn_id {
        if requester.turn_id.as_ref() != Some(v) {
            return Err("turnId 不匹配".into());
        }
    }
    if let Some(v) = &entry.tool_call_id {
        if requester.tool_call_id.as_ref() != Some(v) {
            return Err("toolCallId 不匹配".into());
        }
    }
    Ok(())
}

// ── 标记编解码（参数/结果的物化协议）──

/// 把宿主签发的句柄编码为结果里的标记值（字节语义：Node 物化为 `Uint8Array`）。
pub fn host_blob_marker(blob: &HostBlobRef) -> Value {
    json!({ HOST_BLOB_MARKER_KEY: blob })
}

/// 文本语义的标记：Node 物化回完整字符串。显式 utf8 与 JSON 编码区分，
/// 缺省编码按字节处理，未知编码由 Node 拒绝。
pub fn host_text_blob_marker(blob: &HostBlobRef) -> Value {
    json!({ HOST_BLOB_MARKER_KEY: blob, BLOB_ENCODING_KEY: "utf8" })
}

/// JSON semantic marker: Node parses the fetched UTF-8 payload back into its original JSON value.
pub fn host_json_blob_marker(blob: &HostBlobRef) -> Value {
    json!({ HOST_BLOB_MARKER_KEY: blob, BLOB_ENCODING_KEY: "json" })
}

/// 标记里标注文本/字节语义的键。
pub const BLOB_ENCODING_KEY: &str = "$blobEncoding";

/// 解析结果里的宿主 blob 标记。
pub fn parse_host_blob_marker(value: &Value) -> Option<HostBlobRef> {
    let inner = value.get(HOST_BLOB_MARKER_KEY)?;
    serde_json::from_value(inner.clone()).ok()
}

/// 编码一次上传的引用标记（Node 侧编码，宿主侧解析）。
pub fn upload_marker(id: &str, kind: WireBlobKind) -> Value {
    json!({ UPLOAD_MARKER_KEY: { "id": id, "kind": match kind { WireBlobKind::Text => "text", WireBlobKind::Bytes => "bytes", WireBlobKind::Json => "json" } } })
}

/// 解析上传标记。
pub fn parse_upload_marker(value: &Value) -> Option<UploadMarker> {
    let inner = value.get(UPLOAD_MARKER_KEY)?;
    if inner.as_object()?.len() != 2 {
        return None;
    }
    let id = inner.get("id")?.as_str()?.to_string();
    let kind = match inner.get("kind")?.as_str()? {
        "text" => WireBlobKind::Text,
        "bytes" => WireBlobKind::Bytes,
        "json" => WireBlobKind::Json,
        _ => return None,
    };
    Some(UploadMarker { id, kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> RunScope {
        RunScope {
            app_epoch: "boot-1".into(),
            node_epoch: 1,
            session_id: Some("s-1".into()),
            run_generation: Some(3),
            ..Default::default()
        }
    }

    #[test]
    fn 签发读取与作用域校验() {
        let registry = BlobRegistry::new();
        let blob = registry
            .issue_host_blob(
                scope(),
                vec![1, 2, 3],
                Some("application/octet-stream".into()),
            )
            .unwrap();
        assert_eq!(blob.bytes, 3);

        let data = registry.open_read(&blob.id, &scope()).unwrap();
        assert_eq!(&data[..], &[1, 2, 3]);

        // 会话不匹配：拒绝并归还句柄
        let mut other = scope();
        other.session_id = Some("s-2".into());
        let err = registry.open_read(&blob.id, &other).unwrap_err();
        assert!(err.to_string().contains("scope"), "{err}");
        assert_eq!(registry.len(), 0, "拒绝后必须归还句柄");
        assert!(
            registry.open_read(&blob.id, &scope()).is_err(),
            "句柄不可复活"
        );
    }

    #[test]
    fn 旧代际立即失效() {
        let registry = BlobRegistry::new();
        let blob = registry.issue_host_blob(scope(), vec![9], None).unwrap();
        let mut old_node = scope();
        old_node.node_epoch = 0;
        assert!(registry.open_read(&blob.id, &old_node).is_err());

        let blob = registry.issue_host_blob(scope(), vec![9], None).unwrap();
        let mut new_session = scope();
        new_session.run_generation = Some(4);
        assert!(registry.open_read(&blob.id, &new_session).is_err());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn 代际轮换回收旧句柄() {
        let registry = BlobRegistry::new();
        let _old = registry.issue_host_blob(scope(), vec![1], None).unwrap();
        let mut newer = scope();
        newer.node_epoch = 2;
        let keep = registry.issue_host_blob(newer, vec![2], None).unwrap();
        assert_eq!(registry.revoke_before_epoch("boot-1", 2), 1);
        assert_eq!(registry.len(), 1);
        assert!(registry.open_read(&keep.id, &scope_with_epoch(2)).is_ok());
    }

    fn scope_with_epoch(node_epoch: u64) -> RunScope {
        let mut scope = scope();
        scope.node_epoch = node_epoch;
        scope
    }

    #[test]
    fn 上传一次性取走() {
        let registry = BlobRegistry::new();
        let id = "up-1";
        registry
            .register_upload(id, scope(), b"hello".to_vec(), WireBlobKind::Text)
            .unwrap();
        let (bytes, kind) = registry.take_upload(id, &scope()).unwrap();
        assert_eq!(&bytes[..], b"hello");
        assert_eq!(kind, WireBlobKind::Text);
        assert!(
            registry.take_upload(id, &scope()).is_err(),
            "第二次引用必须失败"
        );
    }

    #[test]
    fn 上传作用域不匹配即归还() {
        let registry = BlobRegistry::new();
        registry
            .register_upload("up-2", scope(), b"x".to_vec(), WireBlobKind::Bytes)
            .unwrap();
        let mut wrong = scope();
        wrong.run_generation = Some(99);
        assert!(registry.take_upload("up-2", &wrong).is_err());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn 上传不得覆盖已有句柄() {
        let registry = BlobRegistry::new();
        let blob = registry.issue_host_blob(scope(), vec![1], None).unwrap();
        assert!(registry
            .register_upload(&blob.id, scope(), vec![2], WireBlobKind::Bytes)
            .is_err());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn 新签发会回收旧孤儿而保留新句柄() {
        let registry = BlobRegistry::new();
        let abandoned = registry.issue_host_blob(scope(), vec![1], None).unwrap();
        registry
            .register_upload("unused-upload", scope(), vec![2], WireBlobKind::Bytes)
            .unwrap();
        // 只推进夹具的过期时间，不靠 sleep；触发入口必须是生产签发函数。
        let expired = Instant::now() - BLOB_IDLE_TTL - Duration::from_secs(1);
        for entry in registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .values_mut()
        {
            entry.touched_at = expired;
        }
        let current = registry.issue_host_blob(scope(), vec![7, 8], None).unwrap();
        assert_eq!(registry.len(), 1, "宿主孤儿和未消费上传都应被回收");
        assert!(registry.open_read(&abandoned.id, &scope()).is_err());
        assert!(registry.take_upload("unused-upload", &scope()).is_err());
        assert_eq!(
            &*registry.open_read(&current.id, &scope()).unwrap(),
            &[7, 8]
        );
    }

    #[test]
    fn 超长与空闲回收() {
        let registry = BlobRegistry::new();
        let too_big = vec![0u8; (BLOB_MAX_BYTES + 1) as usize];
        assert!(registry.issue_host_blob(scope(), too_big, None).is_err());

        let blob = registry.issue_host_blob(scope(), vec![7], None).unwrap();
        let later = Instant::now() + BLOB_IDLE_TTL + Duration::from_secs(1);
        assert_eq!(registry.purge_expired(later), 1);
        assert!(registry.open_read(&blob.id, &scope()).is_err());
    }

    #[test]
    fn 标记形状往返() {
        let registry = BlobRegistry::new();
        let blob = registry
            .issue_host_blob(scope(), vec![5, 6], Some("image/png".into()))
            .unwrap();
        let marker = host_blob_marker(&blob);
        assert!(marker.get(HOST_BLOB_MARKER_KEY).is_some());
        let parsed = parse_host_blob_marker(&marker).unwrap();
        assert_eq!(parsed, blob);
        assert!(parse_host_blob_marker(&json!({"other": 1})).is_none());

        let upload = upload_marker("abc", WireBlobKind::Text);
        let parsed = parse_upload_marker(&upload).unwrap();
        assert_eq!(parsed.id, "abc");
        assert_eq!(parsed.kind, WireBlobKind::Text);
        let json_upload = upload_marker("json-upload", WireBlobKind::Json);
        assert_eq!(
            parse_upload_marker(&json_upload).unwrap().kind,
            WireBlobKind::Json
        );
        // 多字段的仿冒标记不接受
        assert!(parse_upload_marker(
            &json!({ UPLOAD_MARKER_KEY: {"id": "a", "kind": "text", "x": 1} })
        )
        .is_none());
    }
}
