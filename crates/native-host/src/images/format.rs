//! 受支持格式集合与格式嗅探 / MIME 映射。
//!
//! 判据只认字节头（与 TS `imageMime()`、`validate_chat_images` 的准入同一集合）；
//! 扩展名不参与判定。返回的 MIME 一律由实际格式映射得到，保证「标签与字节一致」。

use image::ImageFormat;

use crate::error::{AppError, AppResult};

/// 用户可读的支持格式描述；准入错误文案的唯一使用点。
pub const SUPPORTED_FORMATS_LABEL: &str = "PNG/JPEG/GIF/WebP/BMP";

/// 准入门面支持的图片格式集合（与 limits.json 的准入、TS `imageMime()` 同一集合）。
pub fn is_supported(format: ImageFormat) -> bool {
    matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    )
}

/// 字节头嗅探。只返回集合内格式；无法识别或集合外格式返回 `None`。
pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes)
        .ok()
        .filter(|format| is_supported(*format))
}

/// 粘贴入口的格式判定：聊天准入集合（PNG/JPEG/GIF/WebP/BMP）**加** TIFF。
///
/// 与 [`sniff`] 的分工：准入集合不因粘贴入口扩大 —— TIFF 不在聊天图片白名单（`sniff`
/// 仍拒绝它），只在粘贴链路里先解码再编码为 PNG 落盘；扩展名不参与判定。
pub fn sniff_paste(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes)
        .ok()
        .filter(|format| is_supported(*format) || *format == ImageFormat::Tiff)
}

/// 落盘文件扩展名（粘贴通道按真实格式命名；转码产物一律传 [`ImageFormat::Png`]）。
/// 扩展名只是磁盘上的可读性标签，**不参与任何准入判定**（判据始终是字节头）。
pub fn file_extension(format: ImageFormat) -> Option<&'static str> {
    Some(match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        _ => return None,
    })
}

/// 真实 MIME：由实际编码/嗅探出的格式映射，调用方不得另行硬编码。
pub fn mime_of(format: ImageFormat) -> &'static str {
    format.to_mime_type()
}

/// MIME → 格式（只认集合内）。Pi 传来的 mime 仅作辅助参考，真值仍以字节嗅探为准。
pub fn format_of_mime(mime: &str) -> Option<ImageFormat> {
    ImageFormat::from_mime_type(mime).filter(|format| is_supported(*format))
}

/// 不受支持格式的统一错误（准入文案固定，各入口共用）。
pub fn unsupported_error() -> AppError {
    AppError::Tool(format!("文件不是受支持的 {SUPPORTED_FORMATS_LABEL} 图片"))
}

/// 一次性读取文件头并嗅探（调用方已保证常规文件；读失败按 IO 错误如实返回）。
pub(crate) fn sniff_reader(reader: &mut impl std::io::Read) -> AppResult<ImageFormat> {
    let mut header = [0u8; 32];
    let read = reader
        .read(&mut header)
        .map_err(|e| AppError::Io(format!("读取图片失败: {e}")))?;
    sniff(&header[..read]).ok_or_else(unsupported_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;

    #[test]
    fn sniff_recognizes_every_supported_format() {
        assert_eq!(sniff(&fixtures::png_1x1()), Some(ImageFormat::Png));
        assert_eq!(sniff(&fixtures::jpeg_solid(2, 2)), Some(ImageFormat::Jpeg));
        assert_eq!(sniff(fixtures::gif_tiny_1x1()), Some(ImageFormat::Gif));
        assert_eq!(
            sniff(&fixtures::webp_lossless_solid(2, 2)),
            Some(ImageFormat::WebP)
        );
        assert_eq!(sniff(&fixtures::bmp_2x2()), Some(ImageFormat::Bmp));
    }

    #[test]
    fn sniff_rejects_unsupported_and_garbage_bytes() {
        // TIFF 头（集合外格式）与纯文本都必须被拒。
        assert_eq!(sniff(b"II*\0\x08\0\0\0"), None);
        assert_eq!(sniff(b"not an image"), None);
        assert_eq!(sniff(&[]), None);
        assert_eq!(
            sniff(b"\x89PNG"),
            None,
            "只有前缀不构成完整嗅探依据时也拒绝"
        );
    }

    #[test]
    fn mime_mapping_matches_encoder_output_bytes() {
        // 「编码结果与 MIME 必须一致」：以编码产物为真值反查嗅探 MIME。
        use crate::images::encode;
        use image::RgbaImage;
        let image = RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        for target in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let encoded = encode::encode_rgba(&image, target).expect("fixture 编码必须成功");
            assert_eq!(sniff(&encoded.bytes), Some(target));
            assert_eq!(mime_of(target), encoded.mime_type);
        }
    }

    #[test]
    fn mime_round_trips_with_format_of_mime() {
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
            ImageFormat::Bmp,
        ] {
            assert_eq!(format_of_mime(mime_of(format)), Some(format));
        }
        assert_eq!(format_of_mime("image/tiff"), None, "集合外 MIME 不得放行");
        assert_eq!(format_of_mime("application/octet-stream"), None);
    }

    #[test]
    fn unsupported_error_uses_confirmed_format_label() {
        let message = unsupported_error().to_string();
        assert!(message.contains("PNG/JPEG/GIF/WebP/BMP"), "文案：{message}");
    }

    #[test]
    fn paste_sniff_accepts_tiff_without_widening_the_chat_whitelist() {
        let tiff = fixtures::tiff_solid(2, 2, [9, 8, 7, 255]);
        assert_eq!(sniff_paste(&tiff), Some(ImageFormat::Tiff));
        // 准入集合不变：同一份字节在正式准入口仍被拒（TIFF 只在粘贴链路转码）。
        assert_eq!(sniff(&tiff), None);
        // 白名单格式与无法识别的字节：与 sniff 同判。
        assert_eq!(sniff_paste(&fixtures::png_1x1()), Some(ImageFormat::Png));
        assert_eq!(sniff_paste(b"not an image"), None);
        assert_eq!(sniff_paste(&[]), None);
    }

    #[test]
    fn file_extension_matches_real_format_and_is_absent_for_transcode_others() {
        assert_eq!(file_extension(ImageFormat::Png), Some("png"));
        assert_eq!(file_extension(ImageFormat::Jpeg), Some("jpg"));
        assert_eq!(file_extension(ImageFormat::Gif), Some("gif"));
        assert_eq!(file_extension(ImageFormat::WebP), Some("webp"));
        assert_eq!(file_extension(ImageFormat::Bmp), Some("bmp"));
        assert_eq!(file_extension(ImageFormat::Tiff), None);
    }
}
