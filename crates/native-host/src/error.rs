// crates/native-host/src/error.rs
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

    /// 凭据路径（`.ssh` 目录组件 / `.pem` / `.key`）的最终判定。
    /// 单元变体、不带路径：错误文案会被回显给用户，不能把敏感路径本身写进去。
    #[error("凭据路径不允许访问")]
    SensitivePath,

    /// 取消请求（`bash_cancel`）在子进程 spawn 前就已立案，执行入口据此立即终止本次运行。
    /// 与「命令执行超时」分开：取消是调用方的意图，不是失败原因不明。
    #[error("操作已取消")]
    Cancelled,

    /// 命令执行超时：`timeout_ms` 或兜底上限到点，子进程已被 kill。
    /// 独立变体是为了让前端按错误码归类（`TIMEOUT` → timeout），不靠 message 文案匹配。
    #[error("命令执行超时")]
    Timeout,

    #[error("无法获取 home 目录")]
    NoHomeDir,

    #[error("{0}")]
    Io(String),

    #[error("配置错误: {0}")]
    Config(String),

    #[error("工具执行失败: {0}")]
    Tool(String),

    #[error("记忆数据库不可用: {0}")]
    Memory(String),

    #[error("记忆路径受保护")]
    MemoryProtectedPath,

    #[error("记忆版本冲突")]
    MemoryConflict,

    /// 经私有 IPC 收到的**远端结构化错误**：对端 `code`/`message` 原样保留。
    /// 丢码等于改语义（TS 侧与 Rust 侧都按码分支），因此不能折叠成 `Other`。
    #[error("{message}")]
    Remote { code: String, message: String },

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 稳定错误码 —— 前端可据此分支，不要去匹配 message 文本。
    /// 远端错误码是运行期字符串，故返回 `Cow`。
    pub fn code(&self) -> std::borrow::Cow<'static, str> {
        use std::borrow::Cow;
        match self {
            Self::PathEscape => Cow::Borrowed("PATH_ESCAPE"),
            Self::PathNotFound(_) => Cow::Borrowed("PATH_NOT_FOUND"),
            Self::NotAbsolute(_) => Cow::Borrowed("NOT_ABSOLUTE"),
            Self::SensitivePath => Cow::Borrowed("SENSITIVE_PATH"),
            Self::Cancelled => Cow::Borrowed("CANCELLED"),
            Self::Timeout => Cow::Borrowed("TIMEOUT"),
            Self::NoHomeDir => Cow::Borrowed("NO_HOME_DIR"),
            Self::Io(_) => Cow::Borrowed("IO"),
            Self::Config(_) => Cow::Borrowed("CONFIG"),
            Self::Tool(_) => Cow::Borrowed("TOOL"),
            Self::Memory(_) => Cow::Borrowed("MEMORY"),
            Self::MemoryProtectedPath => Cow::Borrowed("MEMORY_PROTECTED_PATH"),
            Self::MemoryConflict => Cow::Borrowed("MEMORY_CONFLICT"),
            Self::Remote { code, .. } => Cow::Owned(code.clone()),
            Self::Other(_) => Cow::Borrowed("OTHER"),
        }
    }
}

/// 序列化为 `{ code, message }`，而非默认的 enum 结构。
/// message 走 Display；文案被断言与消费方可见，逐字保持稳定。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", &self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ── 兼容转换 ──
// 不同错误形态（io::Error / String / &str）都能落到 AppError：调用点可统一用 `?` 与
// `err(...)`，无需逐处手工包装。

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

/// 把 `Err(String)` 位置改写为 `err(...)` 的辅助函数。
/// `Err(value)` 要求 value 已经是 `AppError`，而 Rust 不会在 `Err(...)` 里自动 `.into()`；
/// 这个函数补上那一步，错误构造点不必改动括号嵌套。
/// 新代码请优先用具体的 `AppError::Xxx` 变体，让错误码有语义。
pub fn err<T>(message: impl Into<String>) -> AppResult<T> {
    Err(AppError::Other(message.into()))
}
