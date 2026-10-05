//! 解码：五种准入格式（PNG/JPEG/GIF/WebP/BMP）的静态/首帧解码。
//!
//! **动画 GIF/WebP 不播放**（2026-10-04 用户指令，理由：内存）：查看器与内联预览
//! 统一只显示第一帧；GIF/WebP 仍属准入格式，与静态图走同一条 `image` 静态解码路径
//! （`image` 的 GIF/WebP 解码器整图解码时返回首帧），不存在帧游标、帧合成、帧序列
//! 缓存或动画推进线程。
//!
//! 释放语义：解出的整帧用 `Arc<[u8]>` 交给调用方；压缩字节随函数栈在解码后释放。

use std::io::Cursor;
use std::sync::Arc;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbaImage};

use crate::error::{AppError, AppResult};

use super::format;

/// 长边上限缩放后的目标尺寸：只缩不放，四舍五入且至少 1 像素
/// （`min(1, max_edge/max)` + `round` 口径），
/// 是全仓唯一的缩放尺寸计算点（请求 1568 / 截图 1280 都走这里）。
pub fn fit_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let scale = (max_edge as f64 / width.max(height) as f64).min(1.0);
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

/// 静态整图解码结果（含真实格式）。
#[derive(Debug)]
pub struct StaticImage {
    pub format: ImageFormat,
    pub image: RgbaImage,
}

/// 解码为 RGBA 整图；EXIF 方向按浏览器 `createImageBitmap` 的默认行为应用
/// —— 重编码产物必须保持视觉直立（与画布路径的既定口径一致）。
pub fn decode_static(bytes: &[u8]) -> AppResult<StaticImage> {
    let format = format::sniff(bytes).ok_or_else(format::unsupported_error)?;
    let reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut decoder = reader.into_decoder().map_err(decode_failed)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_failed)?;
    image.apply_orientation(orientation);
    Ok(StaticImage {
        format,
        image: image.to_rgba8(),
    })
}

/// 只解析头部拿尺寸，不分配整图（请求管线判断是否需要缩放用）。
pub fn probe_dimensions(bytes: &[u8]) -> AppResult<(u32, u32)> {
    let format = format::sniff(bytes).ok_or_else(format::unsupported_error)?;
    let reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.into_dimensions().map_err(decode_failed)
}

/// 已解码的一帧（查看器与内联预览共用的呈现单位）。
///
/// 产品只显示首帧、不播放动画（2026-10-04 用户指令，理由：内存），因此没有帧序与
/// 展示时长语义。`rgba` 用 `Arc<[u8]>` 共享：谁持有引用谁负责释放，管理器交出帧时
/// 零拷贝；preview/inline 测试用强引用计数覆盖释放语义。
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<[u8]>,
}

/// 解码首帧：静态图即整图；动画 GIF/WebP 只取第一帧，不推进、不合成后续帧。
/// 与 [`decode_static`] 同一解码器栈与 EXIF 方向口径。
pub fn decode_first_frame(bytes: &[u8]) -> AppResult<DecodedFrame> {
    let decoded = decode_static(bytes)?;
    let (width, height) = decoded.image.dimensions();
    Ok(DecodedFrame {
        width,
        height,
        rgba: Arc::from(decoded.image.into_raw()),
    })
}

fn decode_failed(error: image::ImageError) -> AppError {
    AppError::Other(format!("图片解码失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;

    #[test]
    fn fit_dimensions_shrinks_only_the_long_edge_and_never_upscales() {
        assert_eq!(fit_dimensions(2000, 1000, 1568), (1568, 784));
        assert_eq!(fit_dimensions(3000, 2000, 1280), (1280, 853));
        assert_eq!(fit_dimensions(4000, 6000, 1568), (1045, 1568));
        // 恰好等于阈值 / 小于阈值：原样。
        assert_eq!(fit_dimensions(1568, 900, 1568), (1568, 900));
        assert_eq!(fit_dimensions(100, 50, 1568), (100, 50));
        // 极端细长比例不塌缩到 0。
        assert_eq!(fit_dimensions(10_000, 1, 1568), (1568, 1));
        assert_eq!(fit_dimensions(1, 1, 1568), (1, 1));
    }

    #[test]
    fn decode_static_reads_inline_png_and_inline_bmp_byte_for_byte() {
        let png = decode_static(&fixtures::png_1x1()).expect("内联 PNG 必须可解");
        assert_eq!(png.format, ImageFormat::Png);
        assert_eq!(png.image.dimensions(), (1, 1));

        let bmp = decode_static(&fixtures::bmp_2x2()).expect("手工 BMP 必须可解");
        assert_eq!(bmp.format, ImageFormat::Bmp);
        assert_eq!(bmp.image.dimensions(), (2, 2));
        // BMP 底行在前、BGR 顺序：左下红 / 右下白 / 左上蓝 / 右上绿。
        // fixture 的字节（`fixtures::bmp_2x2`）与这里逐条对齐：文件首行 = 图像底行
        // `00 00 FF`(BGR 红) / `FF FF FF`(白)，次行 = 图像顶行 `FF 00 00`(BGR 蓝) / `00 FF 00`(绿)。
        assert_eq!(bmp.image.get_pixel(0, 0).0, [0, 0, 255, 255], "左上应为蓝");
        assert_eq!(bmp.image.get_pixel(1, 0).0, [0, 255, 0, 255], "右上应为绿");
        assert_eq!(bmp.image.get_pixel(0, 1).0, [255, 0, 0, 255], "左下应为红");
        assert_eq!(
            bmp.image.get_pixel(1, 1).0,
            [255, 255, 255, 255],
            "右下应为白"
        );
    }

    #[test]
    fn decode_static_reports_broken_payload_as_error_with_reason() {
        // 头合法、负载损坏：必须报「图片解码失败」而不是返回半张图。
        let mut broken = fixtures::png_1x1();
        broken.truncate(20);
        let error = decode_static(&broken).unwrap_err();
        assert!(error.to_string().contains("图片解码失败"), "文案：{error}");
    }

    #[test]
    fn probe_dimensions_reads_header_without_full_decode() {
        let (width, height) = probe_dimensions(&fixtures::png_solid(37, 19)).unwrap();
        assert_eq!((width, height), (37, 19));
        let (width, height) = probe_dimensions(&fixtures::gif_animated(
            2,
            100,
            image::codecs::gif::Repeat::Infinite,
        ))
        .unwrap();
        assert_eq!((width, height), (2, 2));
    }

    #[test]
    fn tiny_inline_gif_first_frame_decodes_transparent_pixel() {
        let frame = decode_first_frame(&fixtures::gif_tiny_1x1()).expect("1x1 GIF 必须可解");
        assert_eq!((frame.width, frame.height), (1, 1));
        assert_eq!(frame.rgba.len(), 4);
        assert_eq!(frame.rgba[3], 0, "内联 GIF 的像素是透明的");
    }
}
