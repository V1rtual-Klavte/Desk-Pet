//! 缩放与编码（全仓唯一实现）。
//!
//! 策略（契约 §5.2）：
//! - 只有「派生预览 / 已需重编码的请求图」才编码，小图与未缩放图原字节直传；
//! - 文字/透明/像素素材优先无损：PNG 保持 PNG，GIF 首帧与 BMP 转 PNG，WebP 用无损重编码；
//! - 唯一的有损重编码目标是 JPEG（质量 [`JPEG_QUALITY`] 起始候选），且只对本来就
//!   有损的 JPEG 源做；
//! - 编码结果的 MIME 一律由实际格式映射（[`format::mime_of`]），调用方不得另行硬编码。

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{imageops::FilterType, ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};

use crate::error::{AppError, AppResult};

use super::format;

/// JPEG 重编码质量（契约 §5.2 的起始候选 90）。
pub const JPEG_QUALITY: u8 = 90;

/// 编码产物：字节 + 真实 MIME + 实际尺寸。
#[derive(Debug, Clone)]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
}

/// 已需重编码时的目标格式（请求/read 路径的唯一策略点）：
/// - PNG → PNG（无损，覆盖文字/像素/透明素材）；
/// - JPEG → JPEG（有损格式本就无无损可用，q90 是轻度压缩）；
/// - WebP → WebP 无损（保留格式与透明度，不引入新的有损层）；
/// - GIF → PNG（静态首帧交无损；旧画布路径对 GIF 同样落到 PNG 产出）；
/// - BMP → PNG（既有规则）。
pub fn reencode_target(source: ImageFormat) -> ImageFormat {
    match source {
        ImageFormat::Jpeg => ImageFormat::Jpeg,
        ImageFormat::WebP => ImageFormat::WebP,
        _ => ImageFormat::Png,
    }
}

/// 等比缩放到给定尺寸（调用方先用 [`super::decode::fit_dimensions`] 算好目标尺寸）。
/// 滤波口径固定为 `FilterType::Triangle`（截图与请求图共用）：全仓只此一份缩放实现。
pub fn resize_rgba(rgba: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    image::imageops::resize(rgba, width, height, FilterType::Triangle)
}

/// RGBA → 目标格式编码。
pub fn encode_rgba(rgba: &RgbaImage, target: ImageFormat) -> AppResult<EncodedImage> {
    let (width, height) = rgba.dimensions();
    let mut bytes = Vec::new();
    match target {
        ImageFormat::Png => {
            PngEncoder::new(&mut bytes)
                .write_image(rgba.as_raw(), width, height, ExtendedColorType::Rgba8)
                .map_err(encode_failed)?;
        }
        ImageFormat::Jpeg => {
            // JPEG 无 alpha：显式做 RGBA→RGB 转换，不依赖编码器对 4 通道的隐式处理。
            let rgb = rgb8_from_rgba(rgba);
            JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
                .encode(&rgb, width, height, ExtendedColorType::Rgb8)
                .map_err(encode_failed)?;
        }
        ImageFormat::WebP => {
            WebPEncoder::new_lossless(&mut bytes)
                .write_image(rgba.as_raw(), width, height, ExtendedColorType::Rgba8)
                .map_err(encode_failed)?;
        }
        other => {
            return Err(AppError::Other(format!("不支持编码为 {other:?}")));
        }
    }
    Ok(EncodedImage {
        bytes,
        mime_type: format::mime_of(target),
        format: target,
        width,
        height,
    })
}

/// PNG 编码（截图路径复用；与 [`encode_rgba`] 同一编码器）。
pub fn encode_png(rgba: &RgbaImage) -> AppResult<Vec<u8>> {
    Ok(encode_rgba(rgba, ImageFormat::Png)?.bytes)
}

fn rgb8_from_rgba(rgba: &RgbaImage) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() * 3);
    for pixel in rgba.pixels() {
        out.extend_from_slice(&pixel.0[..3]);
    }
    out
}

fn encode_failed(error: image::ImageError) -> AppError {
    AppError::Other(format!("图片编码失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;

    #[test]
    fn reencode_target_policy_is_lossless_first() {
        assert_eq!(reencode_target(ImageFormat::Png), ImageFormat::Png);
        assert_eq!(reencode_target(ImageFormat::WebP), ImageFormat::WebP);
        assert_eq!(reencode_target(ImageFormat::Jpeg), ImageFormat::Jpeg);
        assert_eq!(
            reencode_target(ImageFormat::Gif),
            ImageFormat::Png,
            "GIF 首帧转无损 PNG"
        );
        assert_eq!(
            reencode_target(ImageFormat::Bmp),
            ImageFormat::Png,
            "BMP 必须转 PNG"
        );
    }

    #[test]
    fn encode_outputs_sniff_back_as_their_declared_format() {
        let image = fixtures::rgba_solid(5, 4, [7, 8, 9, 200]);
        for target in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let encoded = encode_rgba(&image, target).unwrap();
            assert_eq!(encoded.format, target);
            assert_eq!(
                format::sniff(&encoded.bytes),
                Some(target),
                "{target:?} 的字节必须与 MIME 一致"
            );
            assert_eq!(encoded.mime_type, format::mime_of(target));
            assert_eq!((encoded.width, encoded.height), (5, 4));
        }
    }

    #[test]
    fn png_and_webp_encodings_stay_lossless() {
        let image = fixtures::rgba_solid(3, 3, [3, 200, 111, 77]);
        for target in [ImageFormat::Png, ImageFormat::WebP] {
            let encoded = encode_rgba(&image, target).unwrap();
            let decoded = image::load_from_memory_with_format(&encoded.bytes, target)
                .unwrap()
                .to_rgba8();
            assert_eq!(
                decoded.as_raw(),
                image.as_raw(),
                "{target:?} 必须逐像素无损（含 alpha）"
            );
        }
    }

    #[test]
    fn resize_rgba_produces_exact_target_dimensions() {
        let image = fixtures::rgba_solid(2000, 1000, [1, 2, 3, 255]);
        let (target_width, target_height) = super::super::decode::fit_dimensions(2000, 1000, 1568);
        let resized = resize_rgba(&image, target_width, target_height);
        assert_eq!(resized.dimensions(), (1568, 784));
    }

    #[test]
    fn unsupported_encode_target_is_an_explicit_error() {
        let image = fixtures::rgba_solid(2, 2, [0, 0, 0, 255]);
        let error = encode_rgba(&image, ImageFormat::Gif).unwrap_err();
        assert!(error.to_string().contains("不支持编码"), "文案：{error}");
    }
}
