//! 模型输入侧的两个入口：请求附件（路径）与 read 工具（字节）。
//!
//! 两者共用同一条解码/缩放/编码管线（契约 §5.4：请求附件 / read / screenshot 不各建缩放器）：
//! - [`prepare_request_image`]：保留原路径校验（允许根/凭据/常规文件/15 MiB/格式头），
//!   返回编码字节 + 真实 MIME + hints；**由调用方（命令层）决定经 blob 通道返回**，
//!   本函数不做 IPC、不写盘、不缓存。
//! - [`process_read_image`]：Pi `ReadImageProcessor` 的字节入口。任何解码/编码失败都
//!   回退原图（既有回退语义：用户看得见图比看得见报错重要），失败根因用
//!   `rust_warn!` 留痕，不返回「图片消失」式错误。
//!
//! 规则（既定口径）：长边 >1568 才等比重编码、BMP 不论尺寸转 PNG、
//! 小图（未缩放且非 BMP）原字节直传、hints 文案固定。

use image::ImageFormat;

use crate::error::{AppError, AppResult};
use crate::rust_warn;

use super::{decode, encode, format, limits, validate, validate::ValidatedImagePath};

/// 请求图长边上限（全仓 Rust 侧唯一阈值定义点）。
///
/// 唯一真相源：TS 侧 `src/services/images/processor.ts` 的 `MAX_IMAGE_EDGE = 1568`
/// 是过渡期的双份定义，Node 的模型请求切到 [`prepare_request_image`] 后必须删除
/// TS 那份；数值改动只发生在本常量。
pub const REQUEST_IMAGE_EDGE: u32 = 1568;

/// 请求附件编码产物（blob 交接形状）。
#[derive(Debug, Clone)]
pub struct PreparedRequestImage {
    /// 校验后的 canonical 路径（JSONL 里的原路径不变；这里只回报处理所用的路径）。
    pub path: String,
    pub bytes: Vec<u8>,
    /// 与 `bytes` 实际编码格式一致的真实 MIME。
    pub mime_type: String,
    /// 供请求视图展示的提示（BMP 转换 / 缩放）；文案固定。
    pub hints: Vec<String>,
    /// 是否发生了解码/重编码（`false` = 原字节直传）。观测用，不参与协议。
    pub reencoded: bool,
}

/// read 工具编码产物（调用方按 Pi `ReadImageProcessor` 形状组装返回；
/// base64 使用标准编码，不在 Rust 侧逐字符处理）。
#[derive(Debug, Clone)]
pub struct ProcessedReadImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub hints: Vec<String>,
    pub reencoded: bool,
}

/// 请求附件：给定路径 → 校验 → 解码/缩放/编码 → 字节 + 真实 MIME + hints。
///
/// 校验失败（路径越权/凭据/不存在/超 15 MiB/非支持格式）如实返回错误；
/// 解码或编码失败回退原字节（不把「图片没了」当结果）。
pub fn prepare_request_image(requested: &str) -> AppResult<PreparedRequestImage> {
    let limits = limits::image_limits()?;
    let source = ValidatedImagePath::validate(requested, Some(limits.max_bytes))?;
    // 有界读取：校验与读取之间文件被替换/追加时也不读全量（竞态保护）。
    let Some(bytes) = validate::read_within(source.as_path(), limits.max_bytes)? else {
        return Err(AppError::Tool(format!(
            "图片须为常规文件且不超过 {} MiB",
            limits.max_bytes / 1024 / 1024
        )));
    };
    // 以实际读到的字节为真值重新嗅探；校验与读取之间文件可能被替换。
    let format = format::sniff(&bytes).ok_or_else(format::unsupported_error)?;
    let processed = run_pipeline(bytes, format, true, REQUEST_IMAGE_EDGE);
    Ok(PreparedRequestImage {
        path: source.as_path().to_string_lossy().into_owned(),
        bytes: processed.bytes,
        mime_type: processed.mime_type,
        hints: processed.hints,
        reencoded: processed.reencoded,
    })
}

/// read 工具：字节 + Pi 探测的 mime → 同一管线。永不因解码/编码失败而丢图。
pub fn process_read_image(
    bytes: &[u8],
    mime_hint: &str,
    auto_resize_images: bool,
) -> ProcessedReadImage {
    match format::sniff(bytes) {
        Some(format) => run_pipeline(
            bytes.to_vec(),
            format,
            auto_resize_images,
            REQUEST_IMAGE_EDGE,
        ),
        // 嗅探不了（Pi 已按字节头过滤过，这里只是防御）：原样交回，MIME 沿用调用方给的。
        None => ProcessedReadImage {
            bytes: bytes.to_vec(),
            mime_type: mime_hint.to_string(),
            hints: Vec::new(),
            reencoded: false,
        },
    }
}

/// 共用管线：按需解码 →（缩放）→ 编码；不需要动图则原字节直传。
fn run_pipeline(
    bytes: Vec<u8>,
    format: ImageFormat,
    auto_resize: bool,
    max_edge: u32,
) -> ProcessedReadImage {
    let is_bmp = format == ImageFormat::Bmp;
    let probed = decode::probe_dimensions(&bytes).ok();
    let needs_resize =
        probed.is_some_and(|(width, height)| auto_resize && width.max(height) > max_edge);
    // 小图原样：不需要缩放也不是 BMP，重编码只会掉保真、白烧 CPU。
    if !is_bmp && probed.is_some() && !needs_resize {
        return passthrough(bytes, format);
    }

    let decoded = match decode::decode_static(&bytes) {
        Ok(decoded) => decoded,
        Err(error) => {
            // 根因留痕在这里；对模型/用户呈现的是原图（回退语义：宁可可见图，不要报错）。
            rust_warn!("图片解码失败，原图直传: {error}");
            return passthrough(bytes, format);
        }
    };
    let (source_width, source_height) = decoded.image.dimensions();
    let resize = auto_resize && source_width.max(source_height) > max_edge;
    let image = if resize {
        let (target_width, target_height) =
            decode::fit_dimensions(source_width, source_height, max_edge);
        encode::resize_rgba(&decoded.image, target_width, target_height)
    } else {
        decoded.image
    };
    match encode::encode_rgba(&image, encode::reencode_target(format)) {
        Ok(encoded) => {
            let mut hints = Vec::new();
            if is_bmp {
                hints.push(format!("[BMP 已转为 {}]", encoded.mime_type));
            }
            if resize {
                hints.push(format!(
                    "[已缩放 {source_width}x{source_height} → {}x{}]",
                    encoded.width, encoded.height
                ));
            }
            ProcessedReadImage {
                bytes: encoded.bytes,
                mime_type: encoded.mime_type.to_string(),
                hints,
                reencoded: true,
            }
        }
        Err(error) => {
            rust_warn!("图片编码失败，原图直传: {error}");
            passthrough(bytes, format)
        }
    }
}

fn passthrough(bytes: Vec<u8>, format: ImageFormat) -> ProcessedReadImage {
    ProcessedReadImage {
        bytes,
        mime_type: format::mime_of(format).to_string(),
        hints: Vec::new(),
        reencoded: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_file(tag: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let dir = fixtures::temp_dir(tag);
        let path = dir.join("image.bin");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn small_image_passes_through_byte_for_byte_with_real_mime() {
        let png = fixtures::png_1x1();
        let processed = process_read_image(&png, "image/png", true);
        assert_eq!(processed.bytes, png, "小图必须原字节直传");
        assert_eq!(processed.mime_type, "image/png");
        assert!(processed.hints.is_empty());
        assert!(!processed.reencoded);
    }

    #[test]
    fn bmp_converts_to_png_regardless_of_size_or_auto_resize_flag() {
        for auto_resize in [true, false] {
            let processed = process_read_image(&fixtures::bmp_2x2(), "image/bmp", auto_resize);
            assert_eq!(format::sniff(&processed.bytes), Some(ImageFormat::Png));
            assert_eq!(processed.mime_type, "image/png");
            assert_eq!(processed.hints, vec!["[BMP 已转为 image/png]"]);
            assert!(processed.reencoded);
        }
    }

    #[test]
    fn large_png_resizes_to_edge_with_matching_mime_and_hint() {
        let bytes = fixtures::png_solid(2000, 1000);
        let processed = process_read_image(&bytes, "image/png", true);
        let decoded = decode::decode_static(&processed.bytes).unwrap();
        assert_eq!(decoded.image.dimensions(), (1568, 784));
        assert_eq!(processed.mime_type, "image/png");
        assert_eq!(processed.hints, vec!["[已缩放 2000x1000 → 1568x784]"]);
        assert!(processed.reencoded);
    }

    #[test]
    fn translucent_large_png_keeps_lossless_png_and_alpha_after_resize() {
        let bytes = fixtures::png_translucent(2000, 1000);
        let processed = process_read_image(&bytes, "image/png", true);
        assert_eq!(
            format::sniff(&processed.bytes),
            Some(ImageFormat::Png),
            "透明素材必须无损"
        );
        let decoded = decode::decode_static(&processed.bytes).unwrap();
        assert_eq!(decoded.image.dimensions(), (1568, 784));
        assert_eq!(
            decoded.image.get_pixel(0, 0).0[3],
            128,
            "缩放不得抹掉透明通道"
        );
    }

    #[test]
    fn large_jpeg_stays_jpeg_after_resize() {
        let bytes = fixtures::jpeg_solid(2000, 1000);
        let processed = process_read_image(&bytes, "image/jpeg", true);
        assert_eq!(format::sniff(&processed.bytes), Some(ImageFormat::Jpeg));
        assert_eq!(processed.mime_type, "image/jpeg");
        assert_eq!(processed.hints, vec!["[已缩放 2000x1000 → 1568x784]"]);
    }

    #[test]
    fn auto_resize_disabled_keeps_large_image_untouched() {
        let bytes = fixtures::png_solid(2000, 1000);
        let processed = process_read_image(&bytes, "image/png", false);
        assert_eq!(processed.bytes, bytes);
        assert!(!processed.reencoded);
        assert!(processed.hints.is_empty());
    }

    #[test]
    fn decode_failure_falls_back_to_original_bytes_with_reason_logged() {
        // 头合法、负载损坏：回退原图而不是丢图。
        let mut broken = fixtures::png_1x1();
        broken.truncate(20);
        let processed = process_read_image(&broken, "image/png", true);
        assert_eq!(processed.bytes, broken);
        assert_eq!(processed.mime_type, "image/png");
        assert!(processed.hints.is_empty());
        assert!(!processed.reencoded);
    }

    #[test]
    fn unsniffable_bytes_fall_back_with_the_caller_mime_hint() {
        let garbage = b"not an image at all".to_vec();
        let processed = process_read_image(&garbage, "image/png", true);
        assert_eq!(processed.bytes, garbage);
        assert_eq!(
            processed.mime_type, "image/png",
            "回退 MIME 沿用调用方探测结果"
        );
        assert!(!processed.reencoded);
    }

    #[test]
    fn prepare_request_image_validates_then_encodes_small_file_unchanged() {
        let (dir, path) = temp_file("request-passthrough", &fixtures::png_1x1());
        let prepared = prepare_request_image(&path.to_string_lossy()).unwrap();
        assert_eq!(prepared.bytes, fixtures::png_1x1());
        assert_eq!(prepared.mime_type, "image/png");
        assert!(prepared.path.ends_with("image.bin"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prepare_request_image_downscales_large_file_with_hint() {
        let (dir, path) = temp_file("request-resize", &fixtures::png_solid(2000, 1000));
        let prepared = prepare_request_image(&path.to_string_lossy()).unwrap();
        assert_eq!(prepared.hints, vec!["[已缩放 2000x1000 → 1568x784]"]);
        let decoded = decode::decode_static(&prepared.bytes).unwrap();
        assert_eq!(decoded.image.dimensions(), (1568, 784));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prepare_request_image_enforces_same_admission_as_chat_images() {
        let dir = fixtures::temp_dir("request-admission");

        let missing = dir.join("missing.png");
        assert_eq!(
            prepare_request_image(&missing.to_string_lossy())
                .unwrap_err()
                .code(),
            "PATH_NOT_FOUND"
        );

        let text = dir.join("notes.txt");
        std::fs::write(&text, b"plain text").unwrap();
        let unsupported = prepare_request_image(&text.to_string_lossy()).unwrap_err();
        assert!(unsupported.to_string().contains("PNG/JPEG/GIF/WebP/BMP"));

        // 稀疏文件直接撑到 15 MiB+1，驱动大小上限分支，不实际写 15 MiB 数据。
        let oversize = dir.join("oversize.png");
        let file = std::fs::File::create(&oversize).unwrap();
        file.set_len(15 * 1024 * 1024 + 1).unwrap();
        drop(file);
        let error = prepare_request_image(&oversize.to_string_lossy()).unwrap_err();
        assert!(error.to_string().contains("不超过 15 MiB"), "文案：{error}");

        std::fs::remove_dir_all(dir).unwrap();
    }
}
