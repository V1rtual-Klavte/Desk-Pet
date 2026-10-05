//! 图片准入限制的 Rust 消费点。
//!
//! 数值唯一源是 `src/services/images/limits.json`（TS 与 Rust 共读同一文件）；
//! 本模块只解析、不复制数值，也不提供第二套默认值。

use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// 与 `src/services/images/limits.json` 逐字段对应（camelCase）。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLimits {
    /// 每条消息最多图片张数（聊天附件准入）。
    pub max_images: usize,
    /// 每张图片字节上限（聊天附件准入与预览打开复核共用）。
    pub max_bytes: u64,
}

/// 读取图片准入限制。解析失败是配置损坏，不静默退回内置默认值。
///
/// 数值单源是这个 JSON 文件；命令层（`commands/chat_images.rs`）已改接本入口，
/// 就地解析已删除，不再保留第二份消费形状。
pub fn image_limits() -> AppResult<ImageLimits> {
    serde_json::from_str(include_str!("../../../../src/services/images/limits.json"))
        .map_err(|e| AppError::Config(format!("图片限制配置无效: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_single_source_matches_confirmed_boundaries() {
        let limits = image_limits().expect("limits.json 必须可解析");
        // 用户确认的功能边界（AGENTS/契约 §5.2），改动必须连带更新文档与 TS 消费点。
        assert_eq!(limits.max_images, 4, "每消息最多 4 张是对用户的承诺");
        assert_eq!(
            limits.max_bytes,
            15 * 1024 * 1024,
            "每图 15 MiB 是对用户的承诺"
        );
    }

    #[test]
    fn limits_file_is_the_only_definition_point() {
        // 读到的值必须来自 include_str! 的那份文件：数值断言放上面，这里守住键名形状，
        // 防止 JSON 改名后 Rust 静默落到 serde 默认（本结构体没有默认值，缺失字段会报错）。
        let raw = include_str!("../../../../src/services/images/limits.json");
        assert!(raw.contains("maxImages"));
        assert!(raw.contains("maxBytes"));
    }
}
