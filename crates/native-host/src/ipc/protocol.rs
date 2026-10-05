//! 宿主 ↔ Node Harness 的线协议常量与信封。
//!
//! W0 冻结件。传输实现（socket/pipe、帧编解码、背压）在 W2 落地，但下列常量与
//! 信封形状**只有这一个定义点**：Rust 侧定义，握手时披露给 Node，两侧不各存默认值
//! （执行契约 §4.2）。
//!
//! 命令负载（`HostCommandMap` / `HostEventMap`）不在本模块：它们由 TS 侧
//! `src/services/host/types.ts` 持有并按业务消费者对齐，本模块只管传输层。

use std::path::PathBuf;

/// 线协议版本。任何不兼容改动都要 +1；握手双方不一致即拒绝连接，
/// 不允许「尽量兼容」地降级。
pub const PROTOCOL_VERSION: u32 = 1;

/// 控制帧上限（字节）。**这是流控单位，不是用户文本或工具结果的限制** ——
/// 超长的业务字段由 HostBridge 编码成 blob 再物化完整原值。
pub const CONTROL_FRAME_MAX_BYTES: usize = 64 * 1024;

/// 二进制通道单块上限（字节）。
pub const BLOB_CHUNK_MAX_BYTES: usize = 64 * 1024;

/// 每条流的初始信用额度（字节）。按块归还，用于背压。
pub const STREAM_CREDIT_BYTES: usize = 256 * 1024;

/// 握手之后、正式帧之前使用的固定魔数：让半开连接与错连端点尽早失败，
/// 而不是把一段无关字节流当成长度前缀解析。
pub const FRAME_MAGIC: [u8; 4] = *b"DSPK";

/// 运行时模式。由宿主判定并经握手告知 Node —— Node 不得用 cwd、`NODE_ENV`
/// 或用户目录自行推算（执行契约 §3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeMode {
    Development,
    Production,
}

/// 宿主平台。与 `cfg!` 同源，握手后 Node 不再做 UA 嗅探。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostPlatform {
    Windows,
    Macos,
}

impl HostPlatform {
    /// 当前构建目标的平台。只支持 Windows 与 macOS（执行契约 §1）。
    pub const CURRENT: Self = if cfg!(target_os = "windows") {
        Self::Windows
    } else {
        Self::Macos
    };
}

/// 一次运行的归属范围。事件与结果都带 scope，旧 Node、旧会话/代际、
/// 旧 Profile/预览 owner 的结果不得写进新状态（执行契约 §4.1）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScope {
    /// 宿主进程实例身份。宿主重启即换值。
    pub app_epoch: String,
    /// Node 进程代际。崩溃重启后 +1，旧权限与 owner 随之失效。
    pub node_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_generation: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 信封种类。请求与响应共用 `request_id` 配对；事件没有 `request_id`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameKind {
    /// Node → 宿主：调用一条宿主命令。
    Request,
    /// 宿主 → Node：上面那条请求的结果。
    Response,
    /// 双向：业务事件（不参与请求/响应配对）。
    Event,
    /// 双向：流控与生命周期控制，走控制通道优先队列。
    Control,
}

/// 帧头。业务负载在其后按 [`FrameKind`] 解释。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHeader {
    pub protocol_version: u32,
    pub kind: FrameKind,
    /// 请求/响应配对号；`Event` 与部分 `Control` 帧为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    /// 归属范围。事件必须带，旧代际消费者据此丢弃。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<RunScope>,
}

/// 失败结果的线形状。
///
/// **不能退化成字符串**：`PATH_NOT_FOUND` / `PATH_ESCAPE` / `SENSITIVE_PATH` /
/// `MEMORY_CONFLICT` / `CANCELLED` / `TIMEOUT` 等错误码是被业务分支消费的函数级
/// 契约（TS 侧经 `errorCode()` 判定），丢码等于改语义。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    /// 与 `AppError::code()` 同值。
    pub code: String,
    /// 面向用户/日志的说明。已经是脱敏后的文本。
    pub message: String,
}

/// 大内容的短期句柄。宿主注册表校验 owner、长度与生命周期；
/// **任意路径不等于 blob 授权**，句柄只由宿主在完成路径校验后签发。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBlobRef {
    pub id: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// 归属范围；owner 失效即归还句柄。
    pub scope: RunScope,
}

/// Node 连上后的第一条控制帧。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol_version: u32,
    /// 本次启动生成的一次性握手值，只经受控启动信息传入 Node，
    /// **不写 CONFIG、不写日志**。宿主校验后才继续。
    pub handshake: String,
    /// Node 运行时版本（如 `22.22.3`），供宿主核对随包版本/ABI。
    pub node_version: String,
}

/// 宿主对 [`ClientHello`] 的应答。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWelcome {
    pub protocol_version: u32,
    pub app_epoch: String,
    pub node_epoch: u64,
    pub app_version: String,
    pub runtime_mode: RuntimeMode,
    pub platform: HostPlatform,
    /// 传输常量。两侧只用这里披露的值，不各自保留默认。
    pub limits: TransportLimits,
}

/// 传输层限额。与上面的常量同源构造。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportLimits {
    pub control_frame_max_bytes: u64,
    pub blob_chunk_max_bytes: u64,
    pub stream_credit_bytes: u64,
}

impl Default for TransportLimits {
    fn default() -> Self {
        Self {
            control_frame_max_bytes: CONTROL_FRAME_MAX_BYTES as u64,
            blob_chunk_max_bytes: BLOB_CHUNK_MAX_BYTES as u64,
            stream_credit_bytes: STREAM_CREDIT_BYTES as u64,
        }
    }
}

/// 宿主启动 Node 时经**受控启动信息**传入的参数（环境变量或 argv，二者选一由 W2 定）。
///
/// 这里是形状定义，不是传输实现：真正的 endpoint 串、握手值都不写盘、不进日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchInfo {
    /// 私有端点地址（Unix socket 路径 / Windows named pipe 名）。
    pub endpoint: String,
    /// 一次性握手值。
    pub handshake: String,
    /// Node 可执行文件路径（随包发行闭包里的 `node`）。
    pub node_binary: PathBuf,
    /// 唯一 JS 入口（`src/harness/main.ts` 的构建产物）。
    pub entry: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 限额默认值就是常量本身() {
        let limits = TransportLimits::default();
        assert_eq!(
            limits.control_frame_max_bytes,
            CONTROL_FRAME_MAX_BYTES as u64
        );
        assert_eq!(limits.blob_chunk_max_bytes, BLOB_CHUNK_MAX_BYTES as u64);
        assert_eq!(limits.stream_credit_bytes, STREAM_CREDIT_BYTES as u64);
    }

    #[test]
    fn 信封省略空可选字段() {
        let header = FrameHeader {
            protocol_version: PROTOCOL_VERSION,
            kind: FrameKind::Request,
            request_id: Some(7),
            scope: None,
        };
        let json = serde_json::to_string(&header).unwrap();
        assert!(json.contains("\"requestId\":7"), "请求号必须带出: {json}");
        assert!(!json.contains("scope"), "空 scope 不应出现在线上: {json}");
        assert!(!json.contains("Scope"), "字段名一律 camelCase: {json}");
    }

    #[test]
    fn 范围里的空字段同样省略() {
        let scope = RunScope {
            app_epoch: "boot-1".into(),
            node_epoch: 3,
            ..Default::default()
        };
        let json = serde_json::to_string(&scope).unwrap();
        assert!(json.contains("\"appEpoch\":\"boot-1\""));
        assert!(json.contains("\"nodeEpoch\":3"));
        assert!(!json.contains("sessionId"));
    }

    #[test]
    fn 欢迎帧往返保真() {
        let welcome = ServerWelcome {
            protocol_version: PROTOCOL_VERSION,
            app_epoch: "boot-1".into(),
            node_epoch: 0,
            app_version: "0.16.0".into(),
            runtime_mode: RuntimeMode::Development,
            platform: HostPlatform::CURRENT,
            limits: TransportLimits::default(),
        };
        let json = serde_json::to_string(&welcome).unwrap();
        let back: ServerWelcome = serde_json::from_str(&json).unwrap();
        assert_eq!(back, welcome);
    }

    #[test]
    fn 错误码不是自由文本() {
        let error = WireError {
            code: "PATH_ESCAPE".into(),
            message: "路径越界".into(),
        };
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("\"code\":\"PATH_ESCAPE\""));
    }
}
