// src-tauri/src/error.rs
// ==========================================
// 统一错误类型
// Rust 命令返回值由裸 String 迁移到 AppError：
// 序列化为 { code, message }，前端据此区分错误种类做差异化处理。
// ==========================================

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("路径越权")]
    PathEscape,

    #[error("路径不存在: {0}")]
    PathNotFound(String),

    #[error("工具路径必须是绝对路径: {0}")]
    NotAbsolute(String),

    #[error("无法获取 home 目录")]
    NoHomeDir,

    #[error("{0}")]
    Io(String),

    #[error("配置错误: {0}")]
    Config(String),

    #[error("工具执行失败: {0}")]
    Tool(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 稳定错误码 —— 前端可据此分支，不要去匹配 message 文本
    pub fn code(&self) -> &'static str {
        match self {
            Self::PathEscape => "PATH_ESCAPE",
            Self::PathNotFound(_) => "PATH_NOT_FOUND",
            Self::NotAbsolute(_) => "NOT_ABSOLUTE",
            Self::NoHomeDir => "NO_HOME_DIR",
            Self::Io(_) => "IO",
            Self::Config(_) => "CONFIG",
            Self::Tool(_) => "TOOL",
            Self::Other(_) => "OTHER",
        }
    }
}

/// 序列化为 `{ code, message }`，而非默认的 enum 结构。
/// message 走 Display，保持与迁移前完全一致的文案。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ── 迁移期桥 ──
// 逐文件迁移时新旧两种形态必须能共存，否则每改一处都会破坏编译。

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::Other(message.to_string())
    }
}

impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.to_string()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// 迁移期辅助：把 `Err(String)` 位置改写为 `err(...)`。
/// `Err(value)` 要求 value 已经是 `AppError`，而 Rust 不会在 `Err(...)` 里自动 `.into()`；
/// 这个函数补上那一步，让 34 处错误构造点可以机械替换而不必改动括号嵌套。
/// 新代码请优先用具体的 `AppError::Xxx` 变体，让错误码有语义。
pub fn err<T>(message: impl Into<String>) -> AppResult<T> {
    Err(AppError::Other(message.into()))
}
