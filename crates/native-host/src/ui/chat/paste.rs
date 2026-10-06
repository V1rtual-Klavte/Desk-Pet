//! 剪贴板粘贴图片的共享入口（A3 图片通路的第三条：文件选择器 / 拖入 / 粘贴）。
//!
//! 分工：平台层（macOS `ChatInputView paste:` / Windows 输入控件 `WM_PASTE` 子类）
//! **只做剪贴板读取**并把字节交给 [`add_pasted_image`]；落盘、转码、上限准入与
//! 待发送区都在这一个实现点里，平台层不复制任何规则。
//!
//! 落盘目录是数据根 `pasted/`（与 `screenshots/` 同属「托管聊天图片根」，
//! 写盘/授权两步复用 `commands/screenshot_cmd.rs::save_managed_image`）；
//! 格式口径：白名单（PNG/JPEG/GIF/WebP）原样保存，BMP/TIFF（剪贴板常见的
//! DIB 由平台层补 BMP 容器头后进来）先解码再编码为 PNG，**不缩放** ——
//! 大小由聊天图片上限（`images/limits.json`，Rust 侧 `images/limits.rs`）把关。
//!
//! 线程纪律：本模块不该在 UI 主线程做重活。`add_pasted_image` 的廉价前置判定
//! （空/超大/格式/张数）同步完成并把中性文案交回调用方；解码/转码/写盘/授权/
//! 清理放进 `deskpet-chat-paste` 工作线程，晚到失败走统一的中性通知位
//! （`set_notice`）—— 与「拖入图片的准入在工作线程」是同一先例
//! （`ui/platform/windows_chat.rs::handle_dropped_files`、`macos_chat.rs::commit_file_drop`）。

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use image::ImageFormat;

use crate::commands::screenshot_cmd::{self, PASTED_DIR};
use crate::host::AssetScopePort;
use crate::images::{decode, encode, format, limits};
use crate::{rust_debug, rust_warn};

use super::chat_ui;
use super::set_notice;

/// 粘贴落盘的进程级端口（数据根 + 预览授权）。
///
/// 由宿主启动序列在 UI 构建前安装一次（与 `update::init` / `install_main_queue`
/// 同级的进程级装配）；未安装时 [`add_pasted_image`] 如实返回「暂不可用」，
/// 不静默落到别处、也不退回临时目录。
pub struct PastePorts {
    /// 数据根（`AppPaths.data_root` 的唯一值；`pasted/` 在其中）。
    pub data_root: PathBuf,
    /// 与截图落盘同一份资源授权表（`main.rs` 装配的 `NativeAssetScope`）。
    pub assets: Arc<dyn AssetScopePort>,
}

static PORTS: OnceLock<PastePorts> = OnceLock::new();

/// 安装粘贴端口（幂等；重复安装忽略后一次并留痕，与聊天 UI 的主线程队列同款）。
pub fn install_paste_ports(ports: PastePorts) {
    if PORTS.set(ports).is_err() {
        rust_warn!("粘贴端口重复安装（忽略后一次）");
    }
}

/// 把剪贴板取到的图片字节落入托管目录并加入待发送区。
/// 白名单格式（png/jpg/jpeg/gif/webp）原样保存；TIFF/BMP/DIB 等先解码再编码为 PNG（不缩放）。
/// 超过 `CHAT_IMAGE_LIMITS`（张数/单张字节，与 TS 同源 `src/services/images/limits.json`，Rust 侧 `images/limits.rs`）时返回中性错误文案。
/// 失败一律返回可展示的中性文案（不要角色口吻），调用方负责显示。
///
/// 补充（实现口径，不改签名）：
/// - 同步段只做廉价判定（空/超大/格式/张数/端口就绪），返回的 `Err` 文案可直接展示；
/// - 转码、写盘、授权在 `deskpet-chat-paste` 工作线程执行（不阻塞 UI
///   主线程），晚到失败经 [`set_notice`] 以同前缀的中性文案呈现；
/// - 写入成功但没能进入待发送区（例如并发把张数顶满）时删除刚落盘的文件，不留孤儿。
pub fn add_pasted_image(bytes: Vec<u8>) -> Result<(), String> {
    if PORTS.get().is_none() {
        return Err("图片未添加（宿主尚未就绪）".into());
    }
    let limits = limits::image_limits().map_err(|error| format!("图片未添加：{error}"))?;
    admit_paste_request(&bytes, limits.max_images)?;

    let max_bytes = limits.max_bytes;
    std::thread::Builder::new()
        .name("deskpet-chat-paste".into())
        .spawn(move || match store_and_enqueue(bytes, max_bytes) {
            Ok(()) => set_notice(None),
            Err(text) => set_notice(Some(text)),
        })
        .map(|_| ())
        .map_err(|error| format!("图片未添加：{error}"))
}

/// 廉价准入段（同步、可跑在 UI 主线程）：空载荷 → 原始载荷守卫 → 格式嗅探 → 张数上限。
///
/// **不含单张字节准入** —— 那条作用于最终落盘字节，落在 `prepare_payload` 里：
/// 剪贴板给的常是未压缩表示（4K 屏 `CF_DIB` ≈33 MB、TIFF 数十 MB），转码成 PNG 可能只有
/// 几 MB，拿原始长度在这里卡会把最常见的「粘贴一张截图」直接拒掉（2026-10-06 修）。
/// 反向断言见 `sync_admission_does_not_gate_on_raw_size`。
fn admit_paste_request(bytes: &[u8], max_images: usize) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("剪贴板里没有图片数据".into());
    }
    admit_raw_payload(bytes.len())?;
    if format::sniff_paste(bytes).is_none() {
        return Err("剪贴板里的内容不是可用的图片".into());
    }
    // 张数上限在廉价段先判一次（文案与 `add_pending_images` 同一条）；真正的准入
    // 在 `add_pending_images` 里还会再复核一次（并发下期间可能被顶满）。
    admit_paste_count(crate::ui::chat::pending_image_paths().len(), max_images)
}

/// 原始剪贴板载荷的**防御上限**（不是图片准入）。
///
/// 准入（单张 15 MiB，`CHAT_IMAGE_LIMITS`）作用于**最终落盘字节**：剪贴板给的常是未压缩
/// 表示——Windows 的 `CF_DIB` 一张 4K 屏截图就 ≈33 MB，macOS 的 TIFF 动辄数十 MB——而它们
/// 转码成 PNG 后可能只有几 MB。拿原始长度去卡，会把最常见的「粘贴一张截图」直接拒掉
/// （2026-10-06 跨平台接线时发现）。平台层另有同量级的拷贝守卫（如 `windows_chat.rs` 的
/// `CLIPBOARD_COPY_LIMIT`），那句是「别把超大内存块拷进主线程」，与本条各管一段。
const RAW_PAYLOAD_LIMIT: usize = 64 * 1024 * 1024;

fn admit_raw_payload(length: usize) -> Result<(), String> {
    if length > RAW_PAYLOAD_LIMIT {
        return Err(format!(
            "剪贴板图片数据过大（原始数据超过 {} MiB）",
            RAW_PAYLOAD_LIMIT / 1024 / 1024
        ));
    }
    Ok(())
}

/// 单张字节上限（与 `ValidatedImagePath` 的准入文案同一条，单位 MiB）。
fn admit_paste_bytes(length: u64, max_bytes: u64) -> Result<(), String> {
    if length > max_bytes {
        return Err(format!(
            "图片过大：单张最多 {} MiB",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

/// 张数上限（与 `add_pending_images` / `validate_chat_images` 同一条用户文案；
/// 数值来自 `limits.json` 单一源）。`pending` 是当前待发送区已选张数。
fn admit_paste_count(pending: usize, max_images: usize) -> Result<(), String> {
    if pending + 1 > max_images {
        return Err(format!("每条消息最多 {max_images} 张图片"));
    }
    Ok(())
}

/// 工作线程执行段：转码 → 写盘/授权 → 加入待发送区（托管草稿标记）。
fn store_and_enqueue(bytes: Vec<u8>, max_bytes: u64) -> Result<(), String> {
    let ports = PORTS
        .get()
        .ok_or_else(|| "图片未添加（宿主尚未就绪）".to_string())?;
    let (payload, extension) = prepare_payload(&bytes, max_bytes)?;
    let path = screenshot_cmd::save_managed_image(
        &ports.data_root,
        ports.assets.as_ref(),
        PASTED_DIR,
        extension,
        &payload,
    )
    .map_err(|error| format!("图片未添加：{error}"))?;

    let path_text = path.to_string_lossy().into_owned();
    // 托管草稿入口（`managed=true`）：草稿丢弃（撤选/切会话/退出）时回收文件，
    // 与文件选择器/拖入的用户自有文件区分。
    match chat_ui().add_managed_pending_images(vec![path_text]) {
        Ok(_) => Ok(()),
        Err(error) => {
            // 没能进入待发送区：删除刚落盘的文件，不留没人引用的孤儿（还没进待发送区，
            // 不归草稿回滚管）。删除失败只留痕 —— 主错误（未添加）必须如实上报。
            if let Err(remove_error) = std::fs::remove_file(&path) {
                rust_debug!("粘贴图片未入区回滚失败 {}: {remove_error}", path.display());
            }
            Err(format!("图片未添加：{error}"))
        }
    }
}

/// 字节 → （待落盘字节，扩展名）。白名单原样；BMP/TIFF 解码后编码 PNG（不缩放），
/// 编码结果仍受单张上限约束（转码可能变大，超限与会话准入同一条拒绝）。
fn prepare_payload(bytes: &[u8], max_bytes: u64) -> Result<(Vec<u8>, &'static str), String> {
    let format =
        format::sniff_paste(bytes).ok_or_else(|| "剪贴板里的内容不是可用的图片".to_string())?;
    if matches!(format, ImageFormat::Bmp | ImageFormat::Tiff) {
        let decoded = decode::decode_transcode_source(bytes, format)
            .map_err(|error| format!("剪贴板图片无法读取：{error}"))?;
        let png = encode::encode_png(&decoded.image)
            .map_err(|error| format!("剪贴板图片无法读取：{error}"))?;
        let length = png.len() as u64;
        admit_paste_bytes(length, max_bytes)?;
        return Ok((png, "png"));
    }
    let extension =
        format::file_extension(format).ok_or_else(|| "剪贴板里的内容不是可用的图片".to_string())?;
    // 白名单格式原样落盘（落盘字节 = 最终字节），准入在这一支同样要过 ——
    // 上面的廉价段只挡「原始载荷过大」，不是单张上限。
    admit_paste_bytes(bytes.len() as u64, max_bytes)?;
    Ok((bytes.to_vec(), extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppResult;
    use crate::images::fixtures;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 记录授权动作的测试替身（预览授权不参与本模块断言，但要证明落盘路径被授权过）。
    struct RecordingAssets {
        allowed: Mutex<Vec<PathBuf>>,
    }

    impl AssetScopePort for RecordingAssets {
        fn allow_file(&self, path: &Path) -> AppResult<()> {
            self.allowed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(path.to_path_buf());
            Ok(())
        }

        fn allow_directory(&self, _path: &Path, _recursive: bool) -> AppResult<()> {
            Ok(())
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/.tmp")
            .join(format!(
                "deskpet-chat-paste-{tag}-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 落盘实现会 canonicalize（`validate_new_file_path`），夹具根也归一，
        // 否则 `starts_with` 会被 `..` 组件假阴。
        root.canonicalize().unwrap()
    }

    fn store(root: &Path, payload: &[u8], extension: &str) -> PathBuf {
        let assets = RecordingAssets {
            allowed: Mutex::new(Vec::new()),
        };
        screenshot_cmd::save_managed_image(root, &assets, PASTED_DIR, extension, payload).unwrap()
    }

    #[test]
    fn whitelist_payloads_are_stored_byte_for_byte_with_matching_extensions() {
        let root = temp_root("raw");

        let png = fixtures::png_1x1();
        let png_path = store(&root, &png, "png");
        assert_eq!(fs::read(&png_path).unwrap(), png, "白名单 PNG 必须原样保存");
        assert_eq!(png_path.extension().unwrap(), "png");

        let jpeg = fixtures::jpeg_solid(3, 2);
        let jpeg_path = store(&root, &jpeg, "jpg");
        assert_eq!(
            fs::read(&jpeg_path).unwrap(),
            jpeg,
            "白名单 JPEG 必须原样保存"
        );
        assert_eq!(jpeg_path.extension().unwrap(), "jpg");
        assert!(png_path.starts_with(root.join(PASTED_DIR)), "{png_path:?}");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bmp_payload_is_transcoded_to_png_without_resizing() {
        let (payload, extension) = prepare_payload(&fixtures::bmp_2x2(), 15 * 1024 * 1024).unwrap();
        assert_eq!(extension, "png", "BMP 转码产物落盘为 PNG");
        assert_eq!(format::sniff(&payload), Some(image::ImageFormat::Png));
        let decoded = decode::decode_static(&payload).unwrap();
        let (width, height) = decoded.image.dimensions();
        assert_eq!((width, height), (2, 2), "不缩放，尺寸原样");
        assert_eq!(decoded.image.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(decoded.image.get_pixel(1, 1).0, [255, 255, 255, 255]);
    }

    #[test]
    fn tiff_payload_is_transcoded_to_png() {
        let tiff = fixtures::tiff_solid(4, 3, [7, 8, 9, 255]);
        let (payload, extension) = prepare_payload(&tiff, 15 * 1024 * 1024).unwrap();
        assert_eq!(extension, "png");
        assert_eq!(format::sniff(&payload), Some(image::ImageFormat::Png));
        let decoded = decode::decode_static(&payload).unwrap();
        assert_eq!(decoded.image.dimensions(), (4, 3));
        assert_eq!(decoded.image.get_pixel(2, 1).0, [7, 8, 9, 255]);
    }

    #[test]
    fn unsupported_payload_is_rejected_with_neutral_text_and_whitelist_stays_header_only() {
        let garbage = b"not an image".to_vec();
        let error = prepare_payload(&garbage, 15 * 1024 * 1024).unwrap_err();
        assert!(error.contains("不是可用的图片"), "文案：{error}");

        // 白名单格式与文件选择器/拖入同一准入口径：只认字节头、原样保存，不在这里
        // 额外做整图解码（头合法、负载损坏的图在请求投影时如实失败，与既有通路一致）。
        let mut truncated = fixtures::png_1x1();
        truncated.truncate(20);
        let (payload, extension) = prepare_payload(&truncated, 15 * 1024 * 1024).unwrap();
        assert_eq!(extension, "png");
        assert_eq!(payload, truncated);
    }

    #[test]
    fn oversized_bytes_and_transcodes_are_rejected_against_the_same_limit() {
        let error = admit_paste_bytes(15 * 1024 * 1024 + 1, 15 * 1024 * 1024).unwrap_err();
        assert!(error.contains("15 MiB"), "文案：{error}");
        assert!(admit_paste_bytes(15 * 1024 * 1024, 15 * 1024 * 1024).is_ok());

        // 转码产物变大到超过上限：与准入同一条拒绝（不落盘半成品）。
        let tiff = fixtures::tiff_solid(8, 8, [1, 2, 3, 255]);
        let error = prepare_payload(&tiff, 16).unwrap_err();
        assert!(error.contains("MiB"), "文案：{error}");
    }

    /// 单张上限卡的是**最终落盘字节**，不是剪贴板里的原始表示：未压缩载荷（Windows 的
    /// `CF_DIB`、macOS 的 TIFF）常比转码后的 PNG 大一个量级——4K 截图 ≈33 MB DIB 转出来
    /// 只有几 MB。拿原始长度去卡会把最常见的「粘贴一张截图」直接拒掉（2026-10-06 修）。
    #[test]
    fn size_limit_applies_to_final_payload_not_raw_clipboard_bytes() {
        // 原始 TIFF 明显超过给定的单张上限，转码后的 PNG 远小于它 → 必须放行。
        let tiff = fixtures::tiff_solid(64, 64, [7, 8, 9, 255]);
        assert!(tiff.len() as u64 > 4096, "夹具应大于上限：{}", tiff.len());
        let (payload, extension) = prepare_payload(&tiff, 4096).unwrap();
        assert_eq!(extension, "png");
        assert!(payload.len() as u64 <= 4096, "最终字节 {}", payload.len());

        // 反过来：白名单格式原样落盘（落盘字节 = 最终字节），同一上限必须拦下。
        let mut big_png = fixtures::png_1x1();
        big_png.resize(4097, 0);
        let error = prepare_payload(&big_png, 4096).unwrap_err();
        assert!(error.contains("图片过大"), "文案：{error}");
    }

    /// 同步准入段**不得**按原始长度卡单张上限：一份超过 15 MiB 的 TIFF（未压缩表示）
    /// 必须放行，让大小判定落在转码之后的最终字节上。反过来把原始长度塞进这条
    /// （2026-10-06 修掉的那个形态）本用例立刻变红。
    #[test]
    fn sync_admission_does_not_gate_on_raw_size() {
        let big = fixtures::tiff_solid(2048, 2048, [7, 8, 9, 255]);
        assert!(
            big.len() as u64 > 15 * 1024 * 1024,
            "夹具应超过单张上限：{}",
            big.len()
        );
        assert!(
            admit_paste_request(&big, 4).is_ok(),
            "同步段只看形状与原始载荷守卫，单张上限由转码后的字节判定"
        );
        // 原始载荷守卫仍然有效（畸形内存块不进解码链）。
        let huge = vec![0u8; RAW_PAYLOAD_LIMIT + 1];
        assert!(admit_paste_request(&huge, 4).is_err());
    }

    /// 原始载荷守卫只防畸形/超大内存块，与单张准入是两条线（值 64 MiB；平台层另有
    /// 同量级的拷贝守卫，各管一段）。
    #[test]
    fn raw_payload_guard_only_bounds_the_clipboard_blob() {
        assert!(admit_raw_payload(RAW_PAYLOAD_LIMIT).is_ok());
        let error = admit_raw_payload(RAW_PAYLOAD_LIMIT + 1).unwrap_err();
        assert!(error.contains("64 MiB"), "文案：{error}");
    }

    #[test]
    fn count_limit_uses_the_shared_neutral_message() {
        assert!(admit_paste_count(3, 4).is_ok());
        let error = admit_paste_count(4, 4).unwrap_err();
        assert_eq!(error, "每条消息最多 4 张图片");
    }

    /// 落盘失败如实报错（目录创建失败）：粘贴链路不静默、不换落点。
    #[test]
    fn store_failure_is_reported_not_swallowed() {
        let root = temp_root("fail");
        fs::write(root.join(PASTED_DIR), b"not a dir").unwrap();
        let assets = RecordingAssets {
            allowed: Mutex::new(Vec::new()),
        };
        let (payload, extension) = prepare_payload(&fixtures::png_1x1(), 15 * 1024 * 1024).unwrap();
        let error =
            screenshot_cmd::save_managed_image(&root, &assets, PASTED_DIR, extension, &payload)
                .unwrap_err();
        assert!(
            error.to_string().contains("创建图片目录失败"),
            "文案：{error}"
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
