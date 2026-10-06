//! 图片单测的 fixture 字节（仅测试编译）。
//!
//! 解码器必须能被 fixture 字节驱动，而不是被「用编码 API 绕过解码」驱动：
//! - PNG/GIF 使用内联字节（仓库先例：L4 场景 `原路径图片输入.scene.ts` 的 1x1 PNG base64）；
//! - JPEG/WebP/TIFF 没有可靠的极小内联字面量，用同一 `image` 栈的编码器现造字节再走完整解码；
//! - BMP 由本文件手工拼字节（格式足够简单，可逐字段核对）。
//!
//! 动画 WebP 没有可用的编码器（`image` 的 WebP 编码只有单帧无损），本仓不伪造
//! 动画 WebP fixture；多帧 GIF fixture 用于首帧解码与头部探测测试（动画不播放）。

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::gif::{GifEncoder, Repeat};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::tiff::TiffEncoder;
use image::codecs::webp::WebPEncoder;
use image::{Delay, ExtendedColorType, Frame, ImageEncoder, Rgba, RgbaImage};

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 每个用例独占的临时目录（位于系统临时目录，`validate_file_path` 的允许根内）。
pub(crate) fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "deskpet-images-{tag}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 1x1 不透明 PNG，与 L4 场景内联的 base64 逐字节一致（回归 pass-through 语义）。
pub(crate) fn png_1x1() -> Vec<u8> {
    STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
        .expect("内联 PNG fixture 必须是合法 base64")
}

pub(crate) fn rgba_solid(width: u32, height: u32, color: [u8; 4]) -> RgbaImage {
    RgbaImage::from_pixel(width, height, Rgba(color))
}

pub(crate) fn png_solid(width: u32, height: u32) -> Vec<u8> {
    let image = rgba_solid(width, height, [12, 200, 90, 255]);
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

/// 半透明 PNG：验证「透明素材优先无损（PNG）」策略。
pub(crate) fn png_translucent(width: u32, height: u32) -> Vec<u8> {
    let image = rgba_solid(width, height, [12, 200, 90, 128]);
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

pub(crate) fn jpeg_solid(width: u32, height: u32) -> Vec<u8> {
    let image = rgba_solid(width, height, [200, 40, 30, 255]);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 90)
        .encode_image(&image)
        .unwrap();
    bytes
}

pub(crate) fn webp_lossless_solid(width: u32, height: u32) -> Vec<u8> {
    let image = rgba_solid(width, height, [5, 60, 220, 255]);
    let mut bytes = Vec::new();
    WebPEncoder::new_lossless(&mut bytes)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

/// 2x2 24 位 BMP，手工拼字节（底行在前；BGR 顺序；每行 4 字节对齐）。
/// 像素约定：左下=红、右下=白、左上=蓝、右上=绿。
pub(crate) fn bmp_2x2() -> Vec<u8> {
    let mut out = Vec::with_capacity(70);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&70u32.to_le_bytes()); // 文件大小 = 14 + 40 + 16
    out.extend_from_slice(&[0u8; 4]); // 保留
    out.extend_from_slice(&54u32.to_le_bytes()); // 像素数据偏移
    out.extend_from_slice(&40u32.to_le_bytes()); // DIB 头大小
    out.extend_from_slice(&2i32.to_le_bytes()); // 宽
    out.extend_from_slice(&2i32.to_le_bytes()); // 高（正数 = 底行在前）
    out.extend_from_slice(&1u16.to_le_bytes()); // 平面数
    out.extend_from_slice(&24u16.to_le_bytes()); // 每像素位数
    out.extend_from_slice(&0u32.to_le_bytes()); // 压缩 = 无
    out.extend_from_slice(&16u32.to_le_bytes()); // 像素数据大小
    out.extend_from_slice(&[0u8; 16]); // 分辨率与调色板字段
                                       // 文件中的第一行 = 图像底行：左红（BGR 00 00 FF）右白（FF FF FF）+ 2 字节行填充
    out.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00]);
    // 文件中的第二行 = 图像顶行：左蓝（BGR FF 00 00）右绿（BGR 00 FF 00）+ 2 字节行填充
    out.extend_from_slice(&[0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00]);
    out
}

/// 纯色 TIFF（RGBA8、无压缩；编码器现造字节，走完整 TIFF 解码链）。
/// 剪贴板粘贴转码路径的 fixture：TIFF 不在聊天准入集合，只经 `decode_transcode_source`。
pub(crate) fn tiff_solid(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
    let image = rgba_solid(width, height, color);
    let mut cursor = Cursor::new(Vec::new());
    TiffEncoder::new(&mut cursor)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    cursor.into_inner()
}

/// 经典 43 字节 1x1 透明 GIF89a（带 0 延迟的图形控制扩展）。
/// 内联字节而非编码器产物：这条 fixture 同时覆盖「嗅探 → 解码」的最短真实路径。
pub(crate) const TINY_GIF_1X1: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x01, 0x00, 0x01, 0x00, // 1x1
    0x80, 0x00, 0x00, // 有全局色表，2 色
    0x00, 0x00, 0x00, // 色 0：黑
    0xFF, 0xFF, 0xFF, // 色 1：白
    0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // GCE：透明索引 0，延迟 0
    0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // 图像描述符
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW 数据
    0x3B, // 结束
];

pub(crate) fn gif_tiny_1x1() -> &'static [u8] {
    TINY_GIF_1X1
}

/// 多帧动画 GIF：每帧整画布、纯色、各自延迟；循环次数由调用方指定。
pub(crate) fn gif_animated(frame_count: usize, delay_ms: u32, repeat: Repeat) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut bytes);
        encoder.set_repeat(repeat).unwrap();
        let colors = [
            [255u8, 0, 0, 255],
            [0, 0, 255, 255],
            [0, 255, 0, 255],
            [255, 255, 0, 255],
        ];
        let frames = (0..frame_count).map(|index| {
            let image = rgba_solid(2, 2, colors[index % colors.len()]);
            Frame::from_parts(image, 0, 0, Delay::from_numer_denom_ms(delay_ms, 1))
        });
        encoder.encode_frames(frames).unwrap();
    }
    bytes
}
