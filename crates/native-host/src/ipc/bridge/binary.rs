//! blob 上传/读取与二进制通道 I/O：`BinaryJob`、`UploadState`、参数物化与结果内联编码。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use super::{Admission, BridgeInner};
use crate::error::{AppError, AppResult};
use crate::ipc::blob::{self, WireBlobKind};
use crate::ipc::protocol::{RunScope, WireError};
use crate::ipc::transport::{
    self, BinaryChunk, ControlFrame, ControlPayload, CreditDirection, CreditLedger,
};

pub(super) struct BinaryJob {
    offset: u64,
    last: bool,
    data: Vec<u8>,
}

pub(super) struct UploadState {
    blob_id: String,
    declared: u64,
    received: u64,
    kind: WireBlobKind,
    scope: RunScope,
    buf: Vec<u8>,
}

impl BridgeInner {
    /// 参数物化：把 `$wireBlob` 标记还原成完整原值（文本→字符串，字节→数字数组，JSON→JSON 值）。
    /// 上传句柄一次性取走。
    pub(super) fn materialize_args(&self, scope: &RunScope, value: Value) -> AppResult<Value> {
        if let Some(marker) = blob::parse_upload_marker(&value) {
            let (bytes, kind) = self.blobs.take_upload(&marker.id, scope)?;
            return match kind {
                WireBlobKind::Text => String::from_utf8(bytes.to_vec())
                    .map(Value::String)
                    .map_err(|_| AppError::Other("文本上传不是合法 UTF-8".into())),
                WireBlobKind::Bytes => Ok(Value::Array(
                    bytes.iter().map(|b| Value::from(*b)).collect(),
                )),
                WireBlobKind::Json => {
                    let parsed: Value = serde_json::from_slice(&bytes)
                        .map_err(|e| AppError::Other(format!("JSON 上传无效: {e}")))?;
                    self.materialize_args(scope, parsed)
                }
            };
        }
        match value {
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.materialize_args(scope, item)?);
                }
                Ok(Value::Array(out))
            }
            Value::Object(map) => {
                let mut out = serde_json::Map::with_capacity(map.len());
                for (key, item) in map {
                    out.insert(key, self.materialize_args(scope, item)?);
                }
                Ok(Value::Object(out))
            }
            other => Ok(other),
        }
    }

    pub(super) fn encode_inline_fields_transactional<F>(
        &self,
        scope: &RunScope,
        value: Value,
        mut issue_text_blob: F,
    ) -> AppResult<(Value, Vec<String>)>
    where
        F: FnMut(&RunScope, String) -> AppResult<crate::ipc::protocol::HostBlobRef>,
    {
        let mut issued = Vec::new();
        match self.encode_inline_fields(scope, value, &mut issued, &mut issue_text_blob) {
            Ok(value) => Ok((value, issued)),
            Err(error) => {
                for id in issued {
                    self.blobs.release(&id);
                }
                Err(error)
            }
        }
    }

    fn encode_inline_fields<F>(
        &self,
        scope: &RunScope,
        value: Value,
        issued: &mut Vec<String>,
        issue_text_blob: &mut F,
    ) -> AppResult<Value>
    where
        F: FnMut(&RunScope, String) -> AppResult<crate::ipc::protocol::HostBlobRef>,
    {
        match value {
            Value::String(text) if text.len() > self.config.inline_text_max_bytes => {
                let blob = issue_text_blob(scope, text)?;
                issued.push(blob.id.clone());
                Ok(blob::host_text_blob_marker(&blob))
            }
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.encode_inline_fields(scope, item, issued, issue_text_blob)?);
                }
                Ok(Value::Array(out))
            }
            Value::Object(map) => {
                let mut out = serde_json::Map::with_capacity(map.len());
                for (key, item) in map {
                    out.insert(
                        key,
                        self.encode_inline_fields(scope, item, issued, issue_text_blob)?,
                    );
                }
                Ok(Value::Object(out))
            }
            other => Ok(other),
        }
    }

    // ── blob 读取（宿主 → Node）──

    pub(super) async fn handle_blob_read(
        self: &Arc<Self>,
        request_id: u64,
        scope: RunScope,
        args: Value,
    ) {
        let Some(blob_id) = args
            .get("blobId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            self.respond_err(request_id, "BLOB_ARGS_INVALID", "blob_read 缺少 blobId")
                .await;
            return;
        };
        let data = match self.blobs.open_read(&blob_id, &scope) {
            Ok(data) => data,
            Err(err) => {
                // 句柄不存在/scope 失效：按业务错误码回，句柄已在注册表侧归还。
                self.respond_err(request_id, err.code().as_ref(), err.to_string())
                    .await;
                return;
            }
        };
        // 先确认长度，再流块；中途失败用 BlobAbort 通知（Node 据此拒绝本次读取）。
        self.respond_ok(request_id, json!({ "bytes": data.len() }))
            .await;

        let cancelled = Arc::new(AtomicBool::new(false));
        self.dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, cancelled);
        let inner = self.clone();
        tokio::spawn(async move {
            // 一次只跑一个 blob 传输（每条方向）；Node 侧也串行发起 readBlob。
            let _serial = inner.blob_stream_lock.lock().await;
            let chunk_max = inner.config.blob_chunk_max_bytes;
            let mut offset = 0usize;
            loop {
                let end = (offset + chunk_max).min(data.len());
                let last = end == data.len();
                let slice = &data[offset..end];
                // 信用只在唯一的写循环（run_binary_writer）里记一次账：生产侧只做
                // 取消检查，超出信用的部分由有界 binary_tx 队列阻住生产。
                if inner.is_request_cancelled(request_id) || inner.closed.load(Ordering::SeqCst) {
                    let _ = inner
                        .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                            blob_id: blob_id.clone(),
                            error: WireError {
                                code: "CANCELLED".into(),
                                message: "读取已取消".into(),
                            },
                        }))
                        .await;
                    inner.blobs.release(&blob_id);
                    inner
                        .dispatches
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&request_id);
                    return;
                }
                let job = BinaryJob {
                    offset: offset as u64,
                    last,
                    data: slice.to_vec(),
                };
                if inner.binary_tx.send(job).await.is_err() {
                    break;
                }
                offset = end;
                if last {
                    break;
                }
            }
            inner
                .dispatches
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
        });
    }

    pub(super) async fn handle_blob_open(
        self: &Arc<Self>,
        scope: Option<RunScope>,
        blob_id: String,
        bytes: u64,
        kind: super::transport::BlobKind,
    ) {
        let scope = scope.unwrap_or_else(|| self.default_scope());
        let reject = |code: &str, message: String| ControlPayload::BlobAbort {
            blob_id: blob_id.clone(),
            error: WireError {
                code: code.into(),
                message,
            },
        };
        if !self.scope_current(&scope) {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "SCOPE_STALE",
                    "上传归属与当前代际不一致".into(),
                )))
                .await;
            return;
        }
        if self.admission_state() == Admission::Closed {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "SHUTTING_DOWN",
                    "宿主正在关停".into(),
                )))
                .await;
            return;
        }
        if bytes > blob::BLOB_MAX_BYTES {
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "BLOB_TOO_LARGE",
                    format!("上传 {bytes} 字节超过单句柄上限 {}", blob::BLOB_MAX_BYTES),
                )))
                .await;
            return;
        }
        let mut upload = self.upload.lock().await;
        if upload.is_some() {
            drop(upload);
            let _ = self
                .send_control_frame(ControlFrame::control(reject(
                    "BLOB_BUSY",
                    "已有上传在进行".into(),
                )))
                .await;
            return;
        }
        *upload = Some(UploadState {
            blob_id: blob_id.clone(),
            declared: bytes,
            received: 0,
            kind: match kind {
                super::transport::BlobKind::Text => WireBlobKind::Text,
                super::transport::BlobKind::Bytes => WireBlobKind::Bytes,
                super::transport::BlobKind::Json => WireBlobKind::Json,
            },
            scope,
            buf: Vec::with_capacity(bytes.min(4 * 1024 * 1024) as usize),
        });
        drop(upload);
        let _ = self
            .send_control_frame(ControlFrame::control(ControlPayload::BlobReady { blob_id }))
            .await;
    }
    /// 二进制通道收到的块：只可能是上传数据。归还信用后校验并累积。
    async fn handle_binary_chunk(self: &Arc<Self>, chunk: BinaryChunk) {
        // 收方消费即归还信用（等待而非丢弃的另一半）。
        let _ = self
            .send_control_frame(ControlFrame::control(ControlPayload::Credit {
                direction: CreditDirection::NodeToHost,
                bytes: chunk.data.len().max(1) as u64,
            }))
            .await;

        let mut upload = self.upload.lock().await;
        let Some(state) = upload.as_mut() else {
            drop(upload);
            self.protocol_error("收到无 blobOpen 公告的二进制块").await;
            return;
        };
        let mut abort: Option<WireError> = None;
        if chunk.offset != state.received {
            abort = Some(WireError {
                code: "BLOB_OFFSET_MISMATCH".into(),
                message: format!(
                    "块 offset {} 与已收 {} 不连续",
                    chunk.offset, state.received
                ),
            });
        } else if state.received + chunk.data.len() as u64 > state.declared {
            abort = Some(WireError {
                code: "BLOB_LENGTH_MISMATCH".into(),
                message: "块数据超过公告长度".into(),
            });
        } else {
            state.buf.extend_from_slice(&chunk.data);
            state.received += chunk.data.len() as u64;
        }
        let finished = abort.is_none() && chunk.last;
        if !finished {
            if let Some(error) = abort {
                let blob_id = state.blob_id.clone();
                *upload = None;
                drop(upload);
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                        blob_id,
                        error,
                    }))
                    .await;
            }
            return;
        }
        let state = upload.take().expect("上面已确认存在");
        drop(upload);
        if state.received != state.declared {
            let _ = self
                .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                    blob_id: state.blob_id,
                    error: WireError {
                        code: "BLOB_LENGTH_MISMATCH".into(),
                        message: format!("声明 {} 字节，实收 {}", state.declared, state.received),
                    },
                }))
                .await;
            return;
        }
        match self
            .blobs
            .register_upload(&state.blob_id, state.scope, state.buf, state.kind)
        {
            Ok(()) => {
                // 只有收到 committed，Node 才允许发引用该 id 的请求
                //（控制通道与二进制通道是两个任务，不保证跨通道先后）。
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobCommitted {
                        blob_id: state.blob_id,
                    }))
                    .await;
            }
            Err(err) => {
                let _ = self
                    .send_control_frame(ControlFrame::control(ControlPayload::BlobAbort {
                        blob_id: state.blob_id,
                        error: WireError {
                            code: "BLOB_REJECTED".into(),
                            message: err.to_string(),
                        },
                    }))
                    .await;
            }
        }
    }
}

pub(super) async fn run_binary_writer<W: AsyncWrite + Unpin>(
    mut out: W,
    mut rx: mpsc::Receiver<BinaryJob>,
    credit: Arc<CreditLedger>,
    closed: watch::Receiver<bool>,
    chunk_max: usize,
) {
    while let Some(job) = rx.recv().await {
        if *closed.borrow() {
            break;
        }
        if !credit
            .acquire_or_closed(job.data.len() as u64, &closed)
            .await
        {
            break;
        }
        if transport::write_binary_chunk(&mut out, job.offset, job.last, &job.data, chunk_max)
            .await
            .is_err()
        {
            break;
        }
    }
    let _ = out.shutdown().await;
}

pub(super) async fn run_binary_reader<R: AsyncRead + Unpin>(
    mut input: R,
    weak: Weak<BridgeInner>,
    chunk_max: usize,
) {
    loop {
        let Some(inner) = weak.upgrade() else { break };
        match transport::read_binary_chunk(&mut input, chunk_max).await {
            Ok(chunk) => inner.handle_binary_chunk(chunk).await,
            Err(err) => {
                if !err.is_disconnect() {
                    crate::rust_warn!("二进制通道协议错误: {}", err);
                }
                break;
            }
        }
    }
}
