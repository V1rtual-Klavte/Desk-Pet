// ==========================================
// 私有端点的创建、角色握手与长度前缀分帧
// ==========================================
//
// 字节布局的最终规范写在 `ipc/mod.rs` 的模块文档（Node 侧照它实现，两侧不各存一份
// 口头约定）。本文件是该规范在 Rust 侧的唯一实现点：端点、角色字节、分帧编解码。
//
// 两条硬边界：
// 1. 端点由宿主创建（macOS Unix domain socket / Windows named pipe），Node 只经
//    受控启动信息拿到地址；stdout/stderr 永不承载 RPC。
// 2. 一条端点、两条连接，连接后首字节声明角色（控制必须先建立）。控制帧超限
//    必须拒绝并报错，**不能截断**。

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use super::protocol::{
    ClientHello, FrameHeader, FrameKind, RunScope, ServerWelcome, TransportLimits, WireError,
    FRAME_MAGIC, PROTOCOL_VERSION,
};
use crate::error::{AppError, AppResult};

// ── 连接角色与状态字节 ──

/// 连接后首字节：控制通道。**必须先于二进制通道建立**。
pub const ROLE_CONTROL: u8 = 0x01;
/// 连接后首字节：二进制（blob）通道。
pub const ROLE_BINARY: u8 = 0x02;

/// 二进制握手回包状态：接受。
pub const HANDSHAKE_OK: u8 = 0;
/// 二进制握手回包状态：一次性握手值不匹配。
pub const HANDSHAKE_UNAUTHORIZED: u8 = 1;
/// 二进制握手回包状态：控制通道尚未建立（连接顺序被违反）。
pub const HANDSHAKE_NO_CONTROL: u8 = 2;
/// 二进制握手回包状态：本代端点两条连接都已用完（重复连接）。
pub const HANDSHAKE_ALREADY_USED: u8 = 3;

/// 二进制帧标志位：bit0 = 末块。其余位保留，必须为 0。
pub const BINARY_FLAG_LAST: u8 = 0b0000_0001;
/// 二进制帧定长头：u32 长度 + u64 offset + u8 flags。
pub const BINARY_HEADER_BYTES: usize = 13;
/// 二进制帧长度字段与数据之间的固定开销（offset 8 + flags 1）。
pub const BINARY_PAYLOAD_OVERHEAD: usize = 9;

/// 二进制握手 token 的长度上限（防御超长分配；一次性握手值远短于此）。
const MAX_TOKEN_BYTES: usize = 1024;

// ── 帧读取错误（保留种类，供上层决定「报错并关连接」还是「正常断开」）──

#[derive(Debug)]
pub enum FrameReadError {
    /// 对端在帧边界处正常断开。
    Closed,
    /// 读 I/O 失败（含连接被重置）。
    Io(io::Error),
    /// 声明长度超过限额。**拒绝、绝不截断**：不读取载荷，由上层关连接。
    TooLarge { declared: usize, max: usize },
    /// 读到一半对端断开（半帧）。
    Partial { wanted: usize, got: usize },
    /// JSON 解析失败。
    Json(String),
    /// 信封/载荷校验失败（kind 与 payload 不匹配、flags 非法等）。
    Invalid(String),
}

impl std::fmt::Display for FrameReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "对端已断开"),
            Self::Io(e) => write!(f, "读取失败: {e}"),
            Self::TooLarge { declared, max } => {
                write!(f, "帧长度 {declared} 超过上限 {max}（拒绝且不截断）")
            }
            Self::Partial { wanted, got } => write!(f, "半帧：需要 {wanted} 字节只读到 {got}"),
            Self::Json(e) => write!(f, "帧 JSON 解析失败: {e}"),
            Self::Invalid(e) => write!(f, "帧校验失败: {e}"),
        }
    }
}

impl FrameReadError {
    /// 是否属于「对端已死/已走」——这些不当作协议违规上报。
    pub fn is_disconnect(&self) -> bool {
        matches!(self, Self::Closed | Self::Io(_) | Self::Partial { .. })
    }

    /// 供 WireError 使用的稳定错误码。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Closed => "PEER_CLOSED",
            Self::Io(_) => "IO",
            Self::TooLarge { .. } => "FRAME_TOO_LARGE",
            Self::Partial { .. } => "PARTIAL_FRAME",
            Self::Json(_) => "FRAME_MALFORMED",
            Self::Invalid(_) => "FRAME_INVALID",
        }
    }
}

impl From<io::Error> for FrameReadError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

// ==========================================
// 帧信封与载荷
// ==========================================

/// 控制通道上的一个帧：信封字段平铺 + `payload`。
///
/// `payload` 用 `payloadKind` 自描述，解码后必须与信封 `kind` 一致（[`ControlFrame::validate`]）；
/// 不一致说明对端实现有误，按协议违规处理，不做「尽量解释」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlFrame {
    #[serde(flatten)]
    pub header: FrameHeader,
    pub payload: FramePayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "payloadKind", rename_all = "camelCase")]
pub enum FramePayload {
    Request(RequestPayload),
    Response(ResponsePayload),
    Event(EventPayload),
    Control(ControlPayload),
}

/// Node → 宿主：调用一条宿主命令。业务命令经 `method/args` 透传，宿主侧分派。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPayload {
    pub method: String,
    #[serde(default)]
    pub args: Value,
    /// 调用方要求的执行期限（毫秒）。缺省表示不设期限，由调用方取消/断线兜底。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
}

/// 请求结果。`ok=true` 带 `result`，`ok=false` 带结构化 `error`（**不降级为字符串**）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePayload {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
}

/// 业务事件。归属 scope 与生产者代际在信封 `scope` 上，`seq` 是生产者的单调序号。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    pub event: String,
    pub seq: u64,
    #[serde(default)]
    pub payload: Value,
}

/// 流控与生命周期控制。走控制通道优先队列。
///
/// **两个 rename 都要**：`rename_all` 只管**变体名**（`BlobOpen` → `blobOpen`），
/// **不变体内部字段名** —— 字段要 `rename_all_fields`。少了后者，`blob_id` 会以
/// snake_case 出去/进来，而 Node 侧（`src/services/host/connection.ts`）收发的一律是
/// camelCase（`blobId` / `requestId` / `appEpoch` / `nodeEpoch` / `flushDeadlineMs`），
/// 于是每一帧都 `missing field 'blob_id'` → 协议违规 → 连接关闭。
/// （2026-10-04 实测：`pnpm dev` 里 Node 因此退出码 71 崩溃循环。）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ControlPayload {
    /// Node → 宿主：第一条控制帧。
    Hello {
        hello: ClientHello,
    },
    /// 宿主 → Node：对 Hello 的应答。
    Welcome {
        welcome: ServerWelcome,
    },
    /// 双向：取消某个进行中的 requestId。
    Cancel {
        request_id: u64,
    },
    /// 收方 → 发方：二进制通道信用归还（单位：数据字节，不含帧头）。
    Credit {
        direction: CreditDirection,
        bytes: u64,
    },
    /// Node → 宿主：即将上传一个 blob（宿主应答 BlobReady 后才开始发块）。
    BlobOpen {
        blob_id: String,
        bytes: u64,
        kind: BlobKind,
    },
    /// 宿主 → Node：上传已受理，可以开始发块。
    BlobReady {
        blob_id: String,
    },
    /// 宿主 → Node：上传已收齐并登记完成（收到它之后，请求才可以引用该 id）。
    BlobCommitted {
        blob_id: String,
    },
    /// 双向：终止一个 blob 传输或拒绝一次上传；随后该 id 不再有效。
    BlobAbort {
        blob_id: String,
        error: WireError,
    },
    /// 宿主 → Node：停止收新工作、flush、准备退出。
    Shutdown {
        reason: String,
        flush_deadline_ms: u64,
    },
    /// Node → 宿主：退出前的 flush 真实结果（成功/未完成都如实报）。
    ShutdownFlush {
        flushed: bool,
        pending: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// 宿主 → Node：Node 代际轮换，旧 scope（旧权限/owner/确认）一律失效。
    ScopeRevoked {
        app_epoch: String,
        node_epoch: u64,
    },
    /// 双向：存活探测。
    Ping,
    Pong,
    /// 双向：协议违规，说明后关闭连接。
    ProtocolError {
        error: WireError,
    },
}

/// 信用记账方向：以「谁在发送二进制数据」命名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CreditDirection {
    /// 宿主 → Node 方向（Node 读 blob）。
    HostToNode,
    /// Node → 宿主方向（Node 上传参数 blob）。
    NodeToHost,
}

/// 上传内容类型：文本原值会被还原成字符串，字节原值会被还原成字节数组。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlobKind {
    Text,
    Bytes,
    Json,
}

impl ControlFrame {
    pub fn request(
        request_id: u64,
        scope: Option<RunScope>,
        method: impl Into<String>,
        args: Value,
    ) -> Self {
        Self {
            header: FrameHeader {
                protocol_version: PROTOCOL_VERSION,
                kind: FrameKind::Request,
                request_id: Some(request_id),
                scope,
            },
            payload: FramePayload::Request(RequestPayload {
                method: method.into(),
                args,
                deadline_ms: None,
            }),
        }
    }

    pub fn ok(request_id: u64, result: Value) -> Self {
        Self {
            header: FrameHeader {
                protocol_version: PROTOCOL_VERSION,
                kind: FrameKind::Response,
                request_id: Some(request_id),
                scope: None,
            },
            payload: FramePayload::Response(ResponsePayload {
                ok: true,
                result: Some(result),
                error: None,
            }),
        }
    }

    pub fn err(request_id: u64, error: WireError) -> Self {
        Self {
            header: FrameHeader {
                protocol_version: PROTOCOL_VERSION,
                kind: FrameKind::Response,
                request_id: Some(request_id),
                scope: None,
            },
            payload: FramePayload::Response(ResponsePayload {
                ok: false,
                result: None,
                error: Some(error),
            }),
        }
    }

    pub fn event(scope: RunScope, event: impl Into<String>, seq: u64, payload: Value) -> Self {
        Self {
            header: FrameHeader {
                protocol_version: PROTOCOL_VERSION,
                kind: FrameKind::Event,
                request_id: None,
                scope: Some(scope),
            },
            payload: FramePayload::Event(EventPayload {
                event: event.into(),
                seq,
                payload,
            }),
        }
    }

    pub fn control(payload: ControlPayload) -> Self {
        Self {
            header: FrameHeader {
                protocol_version: PROTOCOL_VERSION,
                kind: FrameKind::Control,
                request_id: None,
                scope: None,
            },
            payload: FramePayload::Control(payload),
        }
    }

    pub fn kind(&self) -> FrameKind {
        self.header.kind
    }

    pub fn request_id(&self) -> Option<u64> {
        self.header.request_id
    }

    /// 信封与载荷的一致性校验。解码后必须调用。
    pub fn validate(&self) -> Result<(), String> {
        if self.header.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "协议版本不一致：对端 {}，本端 {}",
                self.header.protocol_version, PROTOCOL_VERSION
            ));
        }
        match (&self.header.kind, &self.payload) {
            (FrameKind::Request, FramePayload::Request(_)) => {
                if self.header.request_id.is_none() {
                    return Err("Request 帧缺少 requestId".into());
                }
            }
            (FrameKind::Response, FramePayload::Response(payload)) => {
                if self.header.request_id.is_none() {
                    return Err("Response 帧缺少 requestId".into());
                }
                let coherent = if payload.ok {
                    payload.error.is_none()
                } else {
                    payload.error.is_some()
                };
                if !coherent {
                    return Err("Response 帧的 ok/error 不自洽".into());
                }
            }
            (FrameKind::Event, FramePayload::Event(payload)) => {
                if payload.event.is_empty() {
                    return Err("Event 帧缺少事件名".into());
                }
                if self.header.scope.is_none() {
                    return Err("Event 帧缺少 scope（旧代际据此丢弃）".into());
                }
            }
            (FrameKind::Control, FramePayload::Control(_)) => {}
            (kind, _) => {
                return Err(format!("信封 kind {kind:?} 与载荷类型不匹配"));
            }
        }
        Ok(())
    }
}

// ==========================================
// 控制帧编解码
// ==========================================

/// 编码控制帧：`u32 LE 长度` + JSON(UTF-8)。超限即错误，绝不截断。
pub fn encode_control_frame(frame: &ControlFrame, max_bytes: usize) -> AppResult<Vec<u8>> {
    frame
        .validate()
        .map_err(|reason| AppError::Other(format!("拒绝编码非法帧: {reason}")))?;
    let body =
        serde_json::to_vec(frame).map_err(|e| AppError::Other(format!("帧序列化失败: {e}")))?;
    if body.len() > max_bytes {
        return Err(AppError::Other(format!(
            "控制帧 {} 字节超过上限 {max_bytes}：拒绝发送（不截断），大内容请改用 blob",
            body.len()
        )));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// 读取一个控制帧。`max_bytes` 为载荷上限；声明长度超限时立即返回
/// [`FrameReadError::TooLarge`]，**不读取载荷**（上层应报错并关闭连接）。
pub async fn read_control_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<ControlFrame, FrameReadError> {
    let mut len_buf = [0u8; 4];
    match read_exact_or_eof(reader, &mut len_buf).await? {
        false => return Err(FrameReadError::Closed),
        true => {}
    }
    let declared = u32::from_le_bytes(len_buf) as usize;
    if declared > max_bytes {
        return Err(FrameReadError::TooLarge {
            declared,
            max: max_bytes,
        });
    }
    let mut body = vec![0u8; declared];
    read_exact_counted(reader, &mut body).await?;
    let frame: ControlFrame =
        serde_json::from_slice(&body).map_err(|e| FrameReadError::Json(e.to_string()))?;
    frame.validate().map_err(FrameReadError::Invalid)?;
    Ok(frame)
}

/// 写入一个控制帧。
pub async fn write_control_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &ControlFrame,
    max_bytes: usize,
) -> Result<(), FrameReadError> {
    let bytes = encode_control_frame(frame, max_bytes)
        .map_err(|e| FrameReadError::Invalid(e.to_string()))?;
    writer.write_all(&bytes).await?;
    Ok(())
}

// ==========================================
// 二进制帧编解码
// ==========================================

/// 二进制通道的一个数据块：`u32 LE 长度` + `u64 LE offset` + `u8 flags` + 数据。
///
/// 长度字段 = 9 + 数据字节数；单块数据上限即 `BLOB_CHUNK_MAX_BYTES`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryChunk {
    pub offset: u64,
    pub last: bool,
    pub data: Vec<u8>,
}

pub fn encode_binary_chunk(
    offset: u64,
    last: bool,
    data: &[u8],
    chunk_max: usize,
) -> AppResult<Vec<u8>> {
    if data.len() > chunk_max {
        return Err(AppError::Other(format!(
            "二进制块 {} 字节超过上限 {chunk_max}",
            data.len()
        )));
    }
    let payload_len = (BINARY_PAYLOAD_OVERHEAD + data.len()) as u32;
    let mut out = Vec::with_capacity(BINARY_HEADER_BYTES + data.len());
    out.extend_from_slice(&payload_len.to_le_bytes());
    out.extend_from_slice(&offset.to_le_bytes());
    out.push(if last { BINARY_FLAG_LAST } else { 0 });
    out.extend_from_slice(data);
    Ok(out)
}

pub async fn write_binary_chunk<W: AsyncWrite + Unpin>(
    writer: &mut W,
    offset: u64,
    last: bool,
    data: &[u8],
    chunk_max: usize,
) -> Result<(), FrameReadError> {
    let bytes = encode_binary_chunk(offset, last, data, chunk_max)
        .map_err(|e| FrameReadError::Invalid(e.to_string()))?;
    writer.write_all(&bytes).await?;
    Ok(())
}

/// 读取一个二进制块。长度/标志非法即协议错误（拒绝、不猜）。
pub async fn read_binary_chunk<R: AsyncRead + Unpin>(
    reader: &mut R,
    chunk_max: usize,
) -> Result<BinaryChunk, FrameReadError> {
    let mut head = [0u8; BINARY_HEADER_BYTES];
    match read_exact_or_eof(reader, &mut head).await? {
        false => return Err(FrameReadError::Closed),
        true => {}
    }
    let payload_len = u32::from_le_bytes(head[0..4].try_into().expect("4 字节")) as usize;
    let max_payload = BINARY_PAYLOAD_OVERHEAD + chunk_max;
    if payload_len < BINARY_PAYLOAD_OVERHEAD {
        return Err(FrameReadError::Invalid(format!(
            "二进制帧长度 {payload_len} 小于固定头 {BINARY_PAYLOAD_OVERHEAD}"
        )));
    }
    if payload_len > max_payload {
        return Err(FrameReadError::TooLarge {
            declared: payload_len,
            max: max_payload,
        });
    }
    let offset = u64::from_le_bytes(head[4..12].try_into().expect("8 字节"));
    let flags = head[12];
    if flags & !BINARY_FLAG_LAST != 0 {
        return Err(FrameReadError::Invalid(format!(
            "二进制帧 flags 含保留位: 0x{flags:02x}"
        )));
    }
    let data_len = payload_len - BINARY_PAYLOAD_OVERHEAD;
    let mut data = vec![0u8; data_len];
    read_exact_counted(reader, &mut data).await?;
    Ok(BinaryChunk {
        offset,
        last: flags & BINARY_FLAG_LAST != 0,
        data,
    })
}

// ── 读取辅助：区分「边界处断开」与「半帧」──

/// 返回 Ok(false) 表示读到 0 字节且对端已关闭（帧边界断开）。
async fn read_exact_or_eof<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<bool, FrameReadError> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..]).await?;
        if n == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err(FrameReadError::Partial {
                wanted: buf.len(),
                got: filled,
            });
        }
        filled += n;
    }
    Ok(true)
}

async fn read_exact_counted<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<(), FrameReadError> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..]).await?;
        if n == 0 {
            return Err(FrameReadError::Partial {
                wanted: buf.len(),
                got: filled,
            });
        }
        filled += n;
    }
    Ok(())
}

// ==========================================
// 端点：宿主创建、Node 连接
// ==========================================

#[cfg(windows)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 端口角色状态：控制必须先建立，两条连接各一次。
#[derive(Debug, Default)]
pub struct EndpointState {
    control_accepted: AtomicBool,
    binary_accepted: AtomicBool,
}

/// 私有端点。地址只在内存与受控启动信息里出现，不写盘、不写日志。
pub struct Endpoint {
    address: String,
    state: Arc<EndpointState>,
    /// 已受控关闭（清理过 socket 文件/目录）。
    closed: AtomicBool,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(unix)]
    dir: std::path::PathBuf,
    #[cfg(windows)]
    listener: tokio::sync::Mutex<Option<tokio::net::windows::named_pipe::NamedPipeServer>>,
    #[cfg(windows)]
    next_instance: AtomicUsize,
}

impl Endpoint {
    /// 创建端点。必须在 Tokio runtime 上下文内调用（UDS/命名管道注册需要 reactor）。
    ///
    /// macOS：`$TMPDIR/deskpet-host-<随机>/ipc.sock`，目录 0700、socket 0600（当前用户）。
    /// Windows：`\\.\pipe\deskpet-host-<随机>`，先创建首个管道实例占住名字。
    pub fn create() -> AppResult<Self> {
        let suffix = random_hex(12)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            use std::os::unix::fs::PermissionsExt;

            let dir = std::env::temp_dir().join(format!("deskpet-host-{suffix}"));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|e| AppError::Other(format!("端点目录创建失败: {e}")))?;
            let path = dir.join("ipc.sock");
            let listener = tokio::net::UnixListener::bind(&path)
                .map_err(|e| AppError::Other(format!("端点绑定失败: {e}")))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| AppError::Other(format!("端点权限收紧失败: {e}")))?;
            return Ok(Self {
                address: path.to_string_lossy().into_owned(),
                state: Arc::new(EndpointState::default()),
                closed: AtomicBool::new(false),
                listener,
                dir,
            });
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;

            let address = format!(r"\\.\pipe\deskpet-host-{suffix}");
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&address)
                .map_err(|e| AppError::Other(format!("端点创建失败: {e}")))?;
            return Ok(Self {
                address,
                state: Arc::new(EndpointState::default()),
                closed: AtomicBool::new(false),
                listener: tokio::sync::Mutex::new(Some(first)),
                next_instance: AtomicUsize::new(1),
            });
        }
    }

    /// 端点地址（Unix socket 路径 / named pipe 名）。
    pub fn address(&self) -> &str {
        &self.address
    }

    /// 接受控制通道连接：必须携带角色字节 0x01 + magic。其它角色/坏 magic 的连接被关闭，
    /// 循环继续等待（整体时限由调用方超时控制）。
    pub async fn accept_control(&self) -> AppResult<PeerStream> {
        loop {
            let mut stream = self.accept_raw().await?;
            let mut role = [0u8; 1];
            if stream.read_exact(&mut role).await.is_err() {
                continue;
            }
            if role[0] != ROLE_CONTROL {
                // 二进制先于控制：明确回「magic + 状态字节」再关，对端据此拿到诊断。
                if role[0] == ROLE_BINARY {
                    let _ = write_handshake_status(&mut stream, HANDSHAKE_NO_CONTROL).await;
                }
                continue;
            }
            if !read_magic(&mut stream).await {
                continue;
            }
            self.state.control_accepted.store(true, Ordering::SeqCst);
            return Ok(stream);
        }
    }

    /// 接受二进制通道连接：先 magic，再 `u32 LE token 长度 + token`。
    /// 回 `magic + u8 状态`；非 0 时关闭连接并继续等待。
    pub async fn accept_binary(&self, handshake: &str) -> AppResult<PeerStream> {
        loop {
            let mut stream = self.accept_raw().await?;
            let mut role = [0u8; 1];
            if stream.read_exact(&mut role).await.is_err() {
                continue;
            }
            if role[0] != ROLE_BINARY || !read_magic(&mut stream).await {
                continue;
            }
            let mut len_buf = [0u8; 4];
            if stream.read_exact(&mut len_buf).await.is_err() {
                continue;
            }
            let token_len = u32::from_le_bytes(len_buf) as usize;
            if token_len > MAX_TOKEN_BYTES {
                let _ = write_handshake_status(&mut stream, HANDSHAKE_UNAUTHORIZED).await;
                continue;
            }
            let mut token = vec![0u8; token_len];
            if stream.read_exact(&mut token).await.is_err() {
                continue;
            }
            let token = String::from_utf8(token).unwrap_or_default();

            let status = if !self.state.control_accepted.load(Ordering::SeqCst) {
                HANDSHAKE_NO_CONTROL
            } else if self.state.binary_accepted.load(Ordering::SeqCst) {
                HANDSHAKE_ALREADY_USED
            } else if !constant_time_eq(token.as_bytes(), handshake.as_bytes()) {
                HANDSHAKE_UNAUTHORIZED
            } else {
                HANDSHAKE_OK
            };
            if write_handshake_status(&mut stream, status).await.is_err() {
                continue;
            }
            if status != HANDSHAKE_OK {
                continue;
            }
            self.state.binary_accepted.store(true, Ordering::SeqCst);
            return Ok(stream);
        }
    }

    /// 端点是否两条连接都已用完。
    pub fn fully_consumed(&self) -> bool {
        self.state.control_accepted.load(Ordering::SeqCst)
            && self.state.binary_accepted.load(Ordering::SeqCst)
    }

    /// 显式关闭：删除 socket 文件/目录（Unix），停止接受新连接。
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(self.dir.join("ipc.sock"));
            let _ = std::fs::remove_dir(&self.dir);
        }
    }

    #[cfg(unix)]
    async fn accept_raw(&self) -> AppResult<PeerStream> {
        let (stream, _addr) = self
            .listener
            .accept()
            .await
            .map_err(|e| AppError::Other(format!("端点接受连接失败: {e}")))?;
        Ok(PeerStream::Unix(stream))
    }

    #[cfg(windows)]
    async fn accept_raw(&self) -> AppResult<PeerStream> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let server = {
            let mut held = self.listener.lock().await;
            match held.take() {
                Some(first) => first,
                None => {
                    let index = self.next_instance.fetch_add(1, Ordering::SeqCst);
                    // 名字已被本代端点占用，后续实例不再声明 first_pipe_instance。
                    let _ = index;
                    ServerOptions::new()
                        .create(&self.address)
                        .map_err(|e| AppError::Other(format!("端点实例创建失败: {e}")))?
                }
            }
        };
        server
            .connect()
            .await
            .map_err(|e| AppError::Other(format!("端点等待连接失败: {e}")))?;
        Ok(PeerStream::PipeServer(server))
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.close();
    }
}

// ==========================================
// PeerStream：两条连接共用的读写句柄
// ==========================================

pub enum PeerStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    PipeServer(tokio::net::windows::named_pipe::NamedPipeServer),
    /// 仅测试/宿主内自连用：同一端点的客户端句柄（生产路径的客户端是 Node）。
    #[cfg(all(windows, test))]
    PipeClient(tokio::net::windows::named_pipe::NamedPipeClient),
}

impl std::fmt::Debug for PeerStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PeerStream")
    }
}

impl AsyncRead for PeerStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            PeerStream::Unix(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            PeerStream::PipeServer(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(all(windows, test))]
            PeerStream::PipeClient(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for PeerStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            PeerStream::Unix(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            PeerStream::PipeServer(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(all(windows, test))]
            PeerStream::PipeClient(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            PeerStream::Unix(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            PeerStream::PipeServer(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(all(windows, test))]
            PeerStream::PipeClient(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            PeerStream::Unix(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            PeerStream::PipeServer(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(all(windows, test))]
            PeerStream::PipeClient(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

// ==========================================
// 辅助
// ==========================================

pub(crate) fn random_hex(byte_len: usize) -> AppResult<String> {
    let mut bytes = vec![0u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Other(format!("系统熵源不可用: {e}")))?;
    let mut out = String::with_capacity(byte_len * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

/// 一次性握手值的比较：不提前返回，避免时序侧信道。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn read_magic<S: AsyncRead + Unpin>(stream: &mut S) -> bool {
    let mut magic = [0u8; 4];
    stream.read_exact(&mut magic).await.is_ok() && magic == FRAME_MAGIC
}

async fn write_handshake_status<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u8,
) -> io::Result<()> {
    let mut out = [0u8; 5];
    out[0..4].copy_from_slice(&FRAME_MAGIC);
    out[4] = status;
    stream.write_all(&out).await
}

/// 二进制通道发送端使用的信用令牌。初始额度在握手里披露；归还单位是数据字节。
///
/// 用 `watch` 而非 `Notify` 广播额度变化：`notified()` 的唤醒在「先检查条件、后注册等待」
/// 之间存在丢唤醒窗口，而背压等待一旦丢唤醒就会永久卡住；`watch::changed()` 是版本触发的，
/// 不丢事件。等待者由发送端显式传入「关闭」通道，语义是等待而不是静默丢弃。
#[derive(Debug)]
pub struct CreditLedger {
    remaining: std::sync::atomic::AtomicU64,
    changed: tokio::sync::watch::Sender<u64>,
}

impl CreditLedger {
    pub fn new(initial: u64) -> Self {
        let (changed, _) = tokio::sync::watch::channel(initial);
        Self {
            remaining: std::sync::atomic::AtomicU64::new(initial),
            changed,
        }
    }

    pub fn remaining(&self) -> u64 {
        self.remaining.load(Ordering::SeqCst)
    }

    /// 归还信用（收方消费了字节后调用）。
    pub fn grant(&self, bytes: u64) {
        let total = self.remaining.fetch_add(bytes, Ordering::SeqCst) + bytes;
        let _ = self.changed.send(total);
    }

    /// 唤醒所有等待者（额度没变，只推进版本，让等待者重跑停止判断）。
    pub fn wake_all(&self) {
        let total = self.remaining.load(Ordering::SeqCst);
        let _ = self.changed.send(total);
    }

    fn try_take(&self, bytes: u64) -> bool {
        loop {
            let current = self.remaining.load(Ordering::SeqCst);
            if current < bytes {
                return false;
            }
            if self
                .remaining
                .compare_exchange(current, current - bytes, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return true;
            }
        }
    }

    /// 等待并预支 `bytes` 信用（`bytes=0` 视为 1，保证零长块也走同一记账路径）。
    /// `closed` 为真或发送端消失时返回 `false` —— 调用方应中止传输，不能当作已发送。
    pub async fn acquire_or_closed(
        &self,
        bytes: u64,
        closed: &tokio::sync::watch::Receiver<bool>,
    ) -> bool {
        let bytes = bytes.max(1);
        let mut credit = self.changed.subscribe();
        let mut closed = closed.clone();
        loop {
            if *closed.borrow() {
                return false;
            }
            if self.try_take(bytes) {
                return true;
            }
            tokio::select! {
                result = credit.changed() => {
                    if result.is_err() {
                        // 账本已随桥销毁：用剩余额度做最后一次判定，否则视为断开。
                        return self.try_take(bytes);
                    }
                }
                result = closed.changed() => {
                    if result.is_err() || *closed.borrow() {
                        return false;
                    }
                }
            }
        }
    }
}

/// 供握手与测试使用的限额便捷构造。
pub fn limits_from_config(control_max: usize, chunk_max: usize, credit: usize) -> TransportLimits {
    TransportLimits {
        control_frame_max_bytes: control_max as u64,
        blob_chunk_max_bytes: chunk_max as u64,
        stream_credit_bytes: credit as u64,
    }
}

/// 客户端自连（测试与未来宿主内自检用）：连接端点并完成角色/nonce 握手。
#[cfg(test)]
pub(crate) mod test_peer {
    use super::*;

    pub async fn connect_control(address: &str) -> io::Result<PeerStream> {
        let mut stream = connect_raw(address).await?;
        // 前导字节单次写出：服务端读过角色字节就可能拒绝并关闭（如二进制先到），
        // 分段写会在被关闭的 Windows 管道上撞出 BrokenPipe；一次 write_all 让
        // 「角色 + magic」作为一整段交付，之后的读才能稳定拿到握手状态。
        let mut lead = Vec::with_capacity(1 + FRAME_MAGIC.len());
        lead.push(ROLE_CONTROL);
        lead.extend_from_slice(&FRAME_MAGIC);
        stream.write_all(&lead).await?;
        Ok(stream)
    }

    pub async fn connect_binary(address: &str, token: &str) -> io::Result<(PeerStream, u8)> {
        let mut stream = connect_raw(address).await?;
        // 同上：角色 + magic + 长度 + token 合并成一次写。
        let mut lead = Vec::with_capacity(1 + FRAME_MAGIC.len() + 4 + token.len());
        lead.push(ROLE_BINARY);
        lead.extend_from_slice(&FRAME_MAGIC);
        lead.extend_from_slice(&(token.len() as u32).to_le_bytes());
        lead.extend_from_slice(token.as_bytes());
        stream.write_all(&lead).await?;
        let mut reply = [0u8; 5];
        stream.read_exact(&mut reply).await?;
        assert_eq!(&reply[0..4], &FRAME_MAGIC);
        Ok((stream, reply[4]))
    }

    #[cfg(unix)]
    async fn connect_raw(address: &str) -> io::Result<PeerStream> {
        Ok(PeerStream::Unix(
            tokio::net::UnixStream::connect(address).await?,
        ))
    }

    #[cfg(windows)]
    async fn connect_raw(address: &str) -> io::Result<PeerStream> {
        use tokio::net::windows::named_pipe::ClientOptions;
        // Windows 命名管道与 Unix socket 不同：客户端 CreateFile 时若名字下还没有
        // 「已进入监听」的实例（服务端尚未轮到 connect()），或实例全被占用，会立刻
        // 得到 ERROR_PIPE_BUSY。tokio 的 open() 是同步调用、不让出执行权，而
        // current_thread 运行时下被 spawn 的 accept 任务要先有机会被调度才能建实例/
        // 进监听 —— 生产侧 Node 走 libuv（它对 ERROR_PIPE_BUSY 同样重试等待），
        // 测试对端按同一语义实现：有界重试。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(address) {
                Ok(pipe) => return Ok(PeerStream::PipeClient(pipe)),
                Err(error)
                    if error.raw_os_error() == Some(231)
                        && std::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

// ==========================================
// 单元测试
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::{FrameKind, RunScope};

    fn scope() -> RunScope {
        RunScope {
            app_epoch: "boot-1".into(),
            node_epoch: 2,
            session_id: Some("s-1".into()),
            ..Default::default()
        }
    }

    #[test]
    fn 控制帧往返保真() {
        let frame = ControlFrame::request(
            7,
            Some(scope()),
            "file_read",
            serde_json::json!({"path": "a.txt"}),
        );
        let bytes = encode_control_frame(&frame, 64 * 1024).unwrap();
        let declared = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        assert_eq!(declared as usize, bytes.len() - 4);
        let back = poll_once(read_control_frame(&mut &bytes[..], 64 * 1024)).unwrap();
        assert_eq!(back, frame);
        assert_eq!(back.kind(), FrameKind::Request);
        assert_eq!(back.request_id(), Some(7));
    }

    #[test]
    fn 事件帧带作用域与序号() {
        let frame = ControlFrame::event(
            scope(),
            "window-observed",
            9,
            serde_json::json!({"app": "x"}),
        );
        let bytes = encode_control_frame(&frame, 64 * 1024).unwrap();
        let back = poll_once(read_control_frame(&mut &bytes[..], 64 * 1024)).unwrap();
        match back.payload {
            FramePayload::Event(event) => {
                assert_eq!(event.event, "window-observed");
                assert_eq!(event.seq, 9);
            }
            other => panic!("载荷类型不符: {other:?}"),
        }
        assert_eq!(back.header.scope.unwrap().node_epoch, 2);
    }

    #[test]
    fn 超长控制帧编码直接被拒() {
        let big = "x".repeat(70 * 1024);
        let frame = ControlFrame::ok(1, serde_json::json!({ "content": big }));
        let err = encode_control_frame(&frame, 64 * 1024).unwrap_err();
        assert!(err.to_string().contains("超过上限"), "{err}");
    }

    #[test]
    fn 超长控制帧解码被拒且不读载荷() {
        // 声明 1 MiB 长度，后面一个字节都没有：解开必须立即 TooLarge（没有阻塞在载荷上）。
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(1024 * 1024u32).to_le_bytes());
        let err = poll_once(read_control_frame(&mut &bytes[..], 64 * 1024)).unwrap_err();
        match err {
            FrameReadError::TooLarge { declared, max } => {
                assert_eq!(declared, 1024 * 1024);
                assert_eq!(max, 64 * 1024);
            }
            other => panic!("期望 TooLarge，得到 {other}"),
        }
    }

    #[test]
    fn 半帧与断开区分() {
        let frame = ControlFrame::request(3, None, "ping", serde_json::json!({}));
        let bytes = encode_control_frame(&frame, 64 * 1024).unwrap();
        let partial = &bytes[..bytes.len() - 3];
        let err = poll_once(read_control_frame(&mut &partial[..], 64 * 1024)).unwrap_err();
        assert!(matches!(err, FrameReadError::Partial { .. }), "{err}");

        let empty: &[u8] = &[];
        let err = poll_once(read_control_frame(&mut &empty[..], 64 * 1024)).unwrap_err();
        assert!(matches!(err, FrameReadError::Closed), "{err}");
    }

    #[test]
    fn 信封与载荷不一致被拒() {
        let mut frame = ControlFrame::control(ControlPayload::Ping);
        frame.header.protocol_version = PROTOCOL_VERSION + 1;
        assert!(frame.validate().is_err());
    }

    #[test]
    fn 二进制帧字节布局与常量一致() {
        let chunk = encode_binary_chunk(0x0102030405060708, true, b"abc", 64 * 1024).unwrap();
        assert_eq!(chunk.len(), BINARY_HEADER_BYTES + 3);
        assert_eq!(&chunk[0..4], &12u32.to_le_bytes()[..]); // 9 + 3
        assert_eq!(&chunk[4..12], &0x0102030405060708u64.to_le_bytes()[..]);
        assert_eq!(chunk[12], BINARY_FLAG_LAST);
        assert_eq!(&chunk[13..], &b"abc"[..]);
        let back = poll_once(read_binary_chunk(&mut &chunk[..], 64 * 1024)).unwrap();
        assert_eq!(
            back,
            BinaryChunk {
                offset: 0x0102030405060708,
                last: true,
                data: b"abc".to_vec()
            }
        );
    }

    #[test]
    fn 二进制帧保留位与超长被拒() {
        let mut chunk = encode_binary_chunk(0, false, b"x", 64 * 1024).unwrap();
        chunk[12] = 0b0000_0010;
        let err = poll_once(read_binary_chunk(&mut &chunk[..], 64 * 1024)).unwrap_err();
        assert!(matches!(err, FrameReadError::Invalid(_)), "{err}");

        let mut oversized = Vec::new();
        oversized.extend_from_slice(&(9u32 + 64 * 1024 + 1).to_le_bytes());
        oversized.extend_from_slice(&0u64.to_le_bytes());
        oversized.push(0);
        let err = poll_once(read_binary_chunk(&mut &oversized[..], 64 * 1024)).unwrap_err();
        assert!(matches!(err, FrameReadError::TooLarge { .. }), "{err}");

        assert!(encode_binary_chunk(0, false, &vec![0u8; 64 * 1024 + 1], 64 * 1024).is_err());
    }

    #[test]
    fn 信用记账等待而非丢弃() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let ledger = std::sync::Arc::new(CreditLedger::new(100));
            let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
            assert!(ledger.acquire_or_closed(60, &closed_rx).await);
            assert_eq!(ledger.remaining(), 40);

            // 40 < 50：必须等待归还，归还后才继续。
            let l2 = ledger.clone();
            let granted = tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                l2.grant(50);
            });
            assert!(ledger.acquire_or_closed(50, &closed_rx).await);
            assert_eq!(ledger.remaining(), 40);
            granted.await.unwrap();

            // 关闭信号：等待者被唤醒并返回 false（绝不静默当作已发送）。
            let (closed_tx2, closed_rx2) = tokio::sync::watch::channel(false);
            let l3 = ledger.clone();
            let waiter = tokio::spawn(async move { l3.acquire_or_closed(1000, &closed_rx2).await });
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            closed_tx2.send(true).unwrap();
            assert!(!waiter.await.unwrap());

            // 额度变化唤醒等待者。
            let (_closed_tx3, closed_rx3) = tokio::sync::watch::channel(false);
            let l4 = ledger.clone();
            let waiter = tokio::spawn(async move { l4.acquire_or_closed(500, &closed_rx3).await });
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            ledger.grant(500);
            assert!(waiter.await.unwrap());
            let _ = closed_tx;
        });
    }

    #[test]
    fn 端点角色顺序被强制() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let endpoint = Endpoint::create().unwrap();
            let address = endpoint.address().to_string();
            assert!(address.contains("deskpet-host-"), "{address}");

            // 二进制先到：拒绝（状态 2），控制后到：接受。
            let endpoint = std::sync::Arc::new(endpoint);
            let acceptor = endpoint.clone();
            let accept_task = tokio::spawn(async move { acceptor.accept_control().await });
            let (_bad_binary, status) = test_peer::connect_binary(&address, "nope").await.unwrap();
            assert_eq!(status, HANDSHAKE_NO_CONTROL);
            let _control = test_peer::connect_control(&address).await.unwrap();
            let control = accept_task.await.unwrap().unwrap();
            drop(control);

            // 错误的握手值：拒绝；正确的：接受。
            let acceptor = endpoint.clone();
            let accept_task =
                tokio::spawn(async move { acceptor.accept_binary("secret-token").await });
            let (_wrong, status) = test_peer::connect_binary(&address, "wrong").await.unwrap();
            assert_eq!(status, HANDSHAKE_UNAUTHORIZED);
            let (_binary, status) = test_peer::connect_binary(&address, "secret-token")
                .await
                .unwrap();
            assert_eq!(status, HANDSHAKE_OK);
            let _binary = accept_task.await.unwrap().unwrap();
            assert!(endpoint.fully_consumed());
        });
    }

    #[test]
    fn 握手值比较是常量的() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    // 仓内没有 futures 运行时依赖；用最小驱动辅助测试内存字节流
    // （这些读取全在 Ready 上完成，首次 poll 必然返回）。
    fn poll_once<F: std::future::Future>(fut: F) -> F::Output {
        let mut fut = Box::pin(fut);
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        match fut.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("测试辅助只支持一次 poll 即完成的内存流"),
        }
    }
}
