//! 截图编码（长边 1280 / PNG / 编码上限 8 MiB）。
//!
//! 缩放与 PNG 编码复用 [`super::decode::fit_dimensions`] / [`super::encode::encode_png`]，
//! 与请求图片走同一实现（契约 §5.4：不给截图另建缩放器）。本模块只负责「原始像素 →
//! 可传输的 PNG 字节与尺寸」；截图的采集目标、隐私门禁与落盘仍在
//! `commands/screenshot_cmd.rs` 的既有流程里（保留上限已按 2026-10-06 定夺取消，
//! 托管图片只由删会话清理与草稿回滚回收），不在本模块重复。
//!
//! 命令层（`commands/screenshot_cmd.rs`）已改接本函数：就地常量与内联缩放已删除，
//! 长边与编码上限的唯一定义点在本模块。

use image::RgbaImage;

use crate::error::{AppError, AppResult};

use super::{decode, encode};

/// 截图长边上限（与 observation 截图同口径；用户确认的边界）。
pub const SCREENSHOT_MAX_EDGE: u32 = 1280;
/// 截图编码后的传输上限（内存 IPC/blob 的单图额度）。
pub const SCREENSHOT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 编码后的截图：字节 + 真实 MIME + 实际尺寸。
#[derive(Debug, Clone)]
pub struct EncodedScreenshot {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
}

/// 原始截图（xcap 的 `RgbaImage`）→ 长边 ≤1280 的 PNG 字节。
///
/// 尺寸为 0、编码失败、超 8 MiB 都返回明确错误（文案固定），不静默截断。
pub fn encode_screenshot(image: &RgbaImage) -> AppResult<EncodedScreenshot> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(AppError::Other("截图尺寸无效".into()));
    }
    let (target_width, target_height) = decode::fit_dimensions(width, height, SCREENSHOT_MAX_EDGE);
    let bytes = if (target_width, target_height) == (width, height) {
        encode::encode_png(image).map_err(|_| AppError::Other("截图编码失败".into()))?
    } else {
        let resized = encode::resize_rgba(image, target_width, target_height);
        encode::encode_png(&resized).map_err(|_| AppError::Other("截图编码失败".into()))?
    };
    check_screenshot_size(bytes.len())?;
    Ok(EncodedScreenshot {
        bytes,
        mime_type: "image/png",
        width: target_width,
        height: target_height,
    })
}

/// 编码后大小门禁；抽出来是为了在单测里直接驱动上限边界（不构造 8 MiB 真实图）。
pub(crate) fn check_screenshot_size(encoded_len: usize) -> AppResult<()> {
    if encoded_len > SCREENSHOT_MAX_BYTES {
        Err(AppError::Other("截图超过内存传输上限".into()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use image::ImageFormat;

    #[test]
    fn downscales_long_edge_to_screenshot_boundary_and_reports_real_png() {
        let image = fixtures::rgba_solid(2560, 1440, [9, 9, 9, 255]);
        let encoded = encode_screenshot(&image).unwrap();
        assert_eq!((encoded.width, encoded.height), (1280, 720));
        assert_eq!(encoded.mime_type, "image/png");
        assert_eq!(crate::images::sniff(&encoded.bytes), Some(ImageFormat::Png));
        assert!(encoded.bytes.len() <= SCREENSHOT_MAX_BYTES);
    }

    #[test]
    fn keeps_small_captures_at_native_size() {
        let image = fixtures::rgba_solid(640, 480, [1, 2, 3, 255]);
        let encoded = encode_screenshot(&image).unwrap();
        assert_eq!((encoded.width, encoded.height), (640, 480));
        let decoded = image::load_from_memory(&encoded.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (640, 480));
    }

    #[test]
    fn zero_sized_capture_is_an_explicit_error() {
        let image = RgbaImage::new(0, 0);
        let error = encode_screenshot(&image).unwrap_err();
        assert!(error.to_string().contains("截图尺寸无效"), "文案：{error}");
    }

    #[test]
    fn size_gate_rejects_only_above_the_transport_cap() {
        assert!(check_screenshot_size(SCREENSHOT_MAX_BYTES).is_ok());
        let error = check_screenshot_size(SCREENSHOT_MAX_BYTES + 1).unwrap_err();
        assert!(error.to_string().contains("内存传输上限"), "文案：{error}");
    }

    #[test]
    fn screenshot_boundaries_match_confirmed_constants() {
        // 契约 §5.2 的既有承诺；改动要连带文档与命令层一起改。
        assert_eq!(SCREENSHOT_MAX_EDGE, 1280);
        assert_eq!(SCREENSHOT_MAX_BYTES, 8 * 1024 * 1024);
    }
}
