//! 原生宿主与唯一 Node Harness 之间的私有传输。
//!
//! 端点由原生宿主创建（macOS Unix domain socket / Windows named pipe），
//! Node 由宿主拉起并只经受控启动信息拿到连接参数与握手值。
//!
//! 两条硬边界（执行契约 §4.2）：
//! 1. **不复用 stdout/stderr**。完整 npm 与原生扩展会自行打印，那两条标准流
//!    只作日志采集；RPC 走独立端点。
//! 2. **控制通道与二进制通道分开**。取消、shutdown、owner 失效走控制通道的
//!    优先队列，不排在图片字节后面。
//!
//! # 最终字节布局（两侧唯一规范；transport.rs 是 Rust 侧实现点）
//!
//! ── 端点 ──
//!
//! - macOS：`$TMPDIR/deskpet-host-<24 位随机 hex>/ipc.sock`。目录 `0700`、
//!   socket 文件 `0600`（当前用户专属）；端点关闭时删除文件与目录。
//! - Windows：`\\.\pipe\deskpet-host-<24 位随机 hex>`，先建首个管道实例占住名字。
//! - 一次 Node 代际（一次启动/一次崩溃重启）使用一个**新端点 + 新的一次性握手值**。
//!
//! ── 连接与角色（一条端点、两条连接）──
//!
//! Node 对同一端点建立两条连接，连上后**立即**发送 1 字节角色：
//!
//! ```text
//! 控制连接：  0x01
//! 二进制连接：0x02
//! ```
//!
//! 控制通道必须**先**建立：控制握手（hello/welcome）完成前，二进制连接会被拒绝。
//! 角色字节之后、正式分帧之前，两侧都必须发送/校验固定魔数 `DSPK`（4 字节，
//! `protocol.rs::FRAME_MAGIC`），让错连端点尽早失败。
//!
//! ── 握手 ──
//!
//! ```text
//! 控制通道（Node 发起）：
//!   Node → 宿主：[0x01][magic 4B][ClientHello 控制帧]
//!   宿主 → Node：[magic 4B][ServerWelcome 控制帧]
//!   （Hello/Welcome 都是下面的标准控制帧，kind=control、op=hello/welcome。）
//!   校验失败时宿主尽力发一帧 protocolError 后关闭，不发 welcome。
//!
//! 二进制通道：
//!   Node → 宿主：[0x02][magic 4B][u32 LE token 长度][token UTF-8 字节]
//!                 token 即 ClientHello.handshake（一次性握手值）
//!   宿主 → Node：[magic 4B][u8 状态]
//!     0 = OK        1 = 握手值不匹配
//!     2 = 控制通道尚未建立（先发了二进制）  3 = 本代端点两条连接已用完
//!   非 0 时宿主随即关闭连接。
//! ```
//!
//! ── 控制帧（控制通道，双向，长度前缀 JSON）──
//!
//! ```text
//! [u32 LE payload_len][payload: payload_len 字节 UTF-8 JSON]
//! ```
//!
//! `payload_len` 只算 JSON 本体，不含 4 字节前缀；上限即 `CONTROL_FRAME_MAX_BYTES`。
//! **超限必须拒绝并报错（protocolError + 关闭），绝不截断**：长度前缀超限时宿主不读取
//! 载荷（避免按对端声明分配内存），直接关连接。
//!
//! JSON 本体 = `FrameHeader` 的信封字段平铺 + `payload` 字段：
//!
//! ```json
//! { "protocolVersion": 1, "kind": "request", "requestId": 7,
//!   "scope": { "appEpoch": "…", "nodeEpoch": 3, "sessionId": "…" },
//!   "payload": { "payloadKind": "request", "method": "file_read", "args": { … } } }
//! ```
//!
//! - `payload.payloadKind` 必须与信封 `kind` 一致，不一致即协议违规。
//! - `kind` 取值：`request` / `response` / `event` / `control`。
//! - `request`：`{ "method", "args", "deadlineMs"? }`（命令名与参数原样透传，宿主分派）。
//! - `response`：`{ "ok": true, "result": … }` 或 `{ "ok": false, "error": { "code", "message" } }`；
//!   错误码与 `AppError::code()` 同表，**不降级为字符串**。
//! - `event`：`{ "event", "seq", "payload" }`；生产者代际在信封 `scope`（appEpoch+nodeEpoch），
//!   `seq` 是生产者单调序号。
//! - `control`：`{ "op": "…", … }`（见下）。走优先队列。
//!
//! 控制 op 一览：`hello` / `welcome`（握手）、`cancel`（取消 requestId，优先）、
//! `credit`（二进制通道信用归还，`direction` 以发送方命名）、`blobOpen` / `blobReady` /
//! `blobCommitted` / `blobAbort`（上传四段式：公告 → 受理 → 发块 → 收齐登记）、
//! `shutdown` / `shutdownFlush`（关停与 flush 真实报告）、
//! `scopeRevoked`（代际轮换，旧权限/owner 失效）、`ping` / `pong`、`protocolError`。
//!
//! ── 二进制帧（二进制通道，双向）──
//!
//! ```text
//! [u32 LE payload_len][u64 LE offset][u8 flags][data …]
//! payload_len = 9 + data.len()      （9 = offset 8 + flags 1）
//! flags: bit0 = 1 表示末块；其余位保留，必须为 0（非 0 即协议违规）
//! data.len() ≤ BLOB_CHUNK_MAX_BYTES
//! ```
//!
//! 每条方向的二进制传输**串行**：同一时刻只有一次 blob 传输在跑（另一侧排队），
//! 因此帧里不需要流 id —— 传输归属由控制通道上的宣告决定：
//! - 宿主 → Node：Node 发 `request{method:"blob_read", args:{blobId}}`；宿主先回
//!   `response{ok, result:{bytes}}`，随后块按 offset 递增、末块置位；中断发 `blobAbort`。
//! - Node → 宿主：Node 发 `control{op:"blobOpen", blobId, bytes, kind}`，收到
//!   `blobReady` 后开始发块；宿主收齐末块后登记上传，请求里用标记引用（见下）。
//!
//! ── 信用（背压）──
//!
//! 每方向初始 `STREAM_CREDIT_BYTES`（经 `ServerWelcome.limits` 披露，**两侧不各存
//! 默认值**）。发送方每发一个块先扣「数据字节数」；收方每消费一个块即经控制通道回
//! `credit{direction, bytes}`。额度不足时发送方**等待**（不静默丢弃），对端断开/关停时
//! 等待被唤醒并中止传输（如实报错）。
//!
//! ── 大字段物化标记（应用层结果不缩水）──
//!
//! - 结果侧：宿主把超过 `inline_text_max_bytes` 的字符串自动编码为 blob，在 JSON 里
//!   以 `{"$hostBlobRef": {id, bytes, mimeType?, scope}, "$blobEncoding": "utf8"}` 占位
//!   （无 `$blobEncoding` 即字节语义）；聚合结果超出完整 response frame 时，整份结果
//!   以 JSON blob 返回（`$blobEncoding: "json"`）。Node 侧自动读取并恢复原值。
//! - 参数侧：Node 把大字符串/字节/JSON 参数先上传（blobOpen 流程），JSON 里以
//!   `{"$wireBlob": {"id": "…", "kind": "text"|"bytes"|"json"}}` 占位；宿主在分派前物化回
//!   完整原值（text → 字符串；bytes → 数字数组；json → 解析后递归物化）。
//!
//! ── 受控启动信息（唯一真相源）──
//!
//! 宿主以**环境变量 `DESKPET_HOST_LAUNCH`** 传入一行 JSON（camelCase）：
//! `{"endpoint": "…", "handshake": "…", "entry": "…", "nodeBinary": "…"}`。
//! 这是 Node 获取连接参数与一次性握手值的**唯一**渠道：不写 CONFIG、不写日志、
//! 不走 argv。Node 侧实现见 `src/services/host/`（客户端、hello/welcome 顺序与
//! 这里逐条对齐）。
//!
//! # 模块划分
//!
//! - [`protocol`]：W0 冻结的线协议常量与信封（本文件的权威来源）。
//! - [`transport`]：端点创建、角色握手、分帧编解码、信用账本。
//! - [`blob`]：`HostBlobRef` 注册表（owner/scope 校验、长度与生命周期、物化标记）。
//! - [`bridge`]：请求/响应配对、事件派发、控制优先队列、背压与 blob 流。
//! - 监督器（Node 进程生命周期、握手、epoch 轮换、关停序列）在 `crate::host::supervisor`。

pub mod blob;
pub mod bridge;
pub mod protocol;
pub mod transport;

pub use blob::{
    parse_host_blob_marker, parse_upload_marker, BlobOrigin, BlobRegistry, WireBlobKind,
    BLOB_IDLE_TTL, BLOB_MAX_BYTES, HOST_BLOB_MARKER_KEY, UPLOAD_MARKER_KEY,
};
pub use bridge::{
    accept_control_handshake, BridgeConfig, BridgeEventSink, CommandDispatcher, DispatchContext,
    EventEnvelope, FlushReport, HelloError, HelloExpectations, HostBridge, UnavailableDispatcher,
};
pub use protocol::{HostBlobRef, RunScope};
pub use transport::{
    BinaryChunk, ControlFrame, ControlPayload, CreditDirection, Endpoint, FramePayload,
    FrameReadError, PeerStream,
};
