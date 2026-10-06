// ==========================================
// 截图命令 —— 桌宠「看一眼再给用户看」的采集与落盘
//
// 与静默了解的 observation_capture_screen 分开：那条链路要求 enabled + 非桌宠前台 +
// idle ≥ 30min（静默了解的门槛），本链路只要求隐私总闸 enabled，供用户在对话里显式要求截图。
// 采集目标是前台窗口，桌宠自己是前台时退到主显示器整屏（不截桌宠自己的自拍）；
// 缩放/编码走统一图片域 `images::screenshot`（长边 ≤1280、PNG ≤8 MiB、base64 只在 IPC
// 内存），本文件不保留第二份常量与缩放实现。
// 文件落盘在数据根 screenshots/：原子替换写入 + 只保留最新 N 个文件（按 mtime 淘汰）。
// 写盘/授权/保留三步是 `save_managed_image`（本文件），与粘贴落盘（数据根 pasted/，
// 见 ui/chat/paste.rs）共用同一实现；两个目录同属「托管聊天图片根」，
// 删会话连带清理的边界集合由 `managed_chat_image_dirs` 唯一枚举。
//
// transport 无关的普通函数：窗口状态经 WindowPort、预览授权经 AssetScopePort、
// 路径经 AppPaths 显式注入。
// ==========================================

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use xcap::Window;

use crate::error::{AppError, AppResult};
use crate::host::{AssetScopePort, WindowId, WindowPort};
use crate::images::screenshot::{encode_screenshot, SCREENSHOT_MAX_BYTES};
use crate::monitor::{runtime_activity, MonitorState};
use crate::paths::AppPaths;
use crate::rust_debug;

/// 托管聊天图片目录（`screenshots/` 与 `pasted/`）只保留最新 N 个文件（按 mtime 淘汰最旧）。
/// 上限在 Rust 侧定义，前端不复制；常量名保留（`docs/current/tool-system.md` 按此名引用）。
pub const SCREENSHOT_RETENTION: usize = 200;
/// 截图落盘目录（AI 截图工具；`save_screenshot` 消费）。
pub const SCREENSHOT_DIR: &str = "screenshots";
/// 粘贴落盘目录（剪贴板粘贴图片；`ui/chat/paste.rs` 消费，与截图同族、同保留上限）。
pub const PASTED_DIR: &str = "pasted";

/// 「托管聊天图片根」的唯一枚举点：删会话连带清理（`chat_delete_session_images`）
/// 只允许删除这两个根之内的常规文件。
///
/// 新增/改名一个托管目录时同步：本函数（删除边界）、[`SCREENSHOT_DIR`] / [`PASTED_DIR`]
/// 的消费者（`save_screenshot` / `ui/chat/paste.rs`）与聊天图片契约。
pub fn managed_chat_image_dirs(data_root: &Path) -> [PathBuf; 2] {
    [data_root.join(SCREENSHOT_DIR), data_root.join(PASTED_DIR)]
}

/// 只有会启动回合的窗口能截图/落盘（与借用者声明口径一致：main 与 Live Test 窗口）。
///
/// 允许集合固定为 main / e2e；这里用 [`WindowId`] 表达同一集合与同一错误码
/// （PathEscape）。未知 label 不是可调用方 —— 调用方须先在壳层用
/// `WindowId::from_label` 做认定，查不到即 [`None`]，与落到拒绝分支等价。
fn require_business_window(caller: Option<WindowId>) -> AppResult<()> {
    if matches!(caller, Some(WindowId::Main) | Some(WindowId::E2e)) {
        Ok(())
    } else {
        Err(AppError::PathEscape)
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCapture {
    data: String,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

/// 截图目标：前台窗口；桌宠自己是前台（用户正在聊天输入，常见）或没有前台窗口时退到主显示器整屏。
///
/// 不截桌宠自己的窗口是刻意的：那等于给用户看一张她自己的自拍，而不是「你现在的画面」。
/// 这是用户显式请求的截图，不是静默观察，所以不套 idle 与「非桌宠前台」两条观察门槛。
fn capture_target(port: &dyn WindowPort) -> AppResult<xcap::image::RgbaImage> {
    let pet_foreground = runtime_activity(port).is_pet_foreground;
    if !pet_foreground {
        if let Ok(windows) = Window::all() {
            for candidate in windows {
                if !candidate.is_focused().unwrap_or(false) {
                    continue;
                }
                if let Ok(image) = candidate.capture_image() {
                    return Ok(image);
                }
                // 前台窗口捕获失败（例如权限临时不可用）不再逐个尝试，统一退到显示器兜底。
                break;
            }
        }
    }
    let monitors = xcap::Monitor::all().map_err(|_| AppError::Other("无法枚举显示器".into()))?;
    let monitor = monitors
        .iter()
        .find(|item| item.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| AppError::Other("没有可捕获的显示器".into()))?;
    monitor
        .capture_image()
        .map_err(|_| AppError::Other("截图不可用".into()))
}

/// 截取画面。要求隐私总闸（MonitorState.enabled，与 ai.silentAccess.enabled 同源）已开启，
/// 采集后复检一次：总闸在采集期间被关闭时丢弃这张图。
pub fn capture_screenshot(
    caller: Option<WindowId>,
    port: &dyn WindowPort,
    state: &MonitorState,
) -> AppResult<ScreenshotCapture> {
    require_business_window(caller)?;
    if !state.enabled.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    let image = capture_target(port)?;
    if !state.enabled.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    // 缩放/编码唯一实现是统一图片域（长边 ≤1280 / PNG / ≤8 MiB，与观察截图同口径）；
    // 「尺寸无效 / 编码失败 / 超传输上限」的错误文案与错误码由该实现给出。
    let encoded = encode_screenshot(&image)?;
    Ok(ScreenshotCapture {
        data: STANDARD.encode(encoded.bytes),
        mime_type: encoded.mime_type,
        width: encoded.width,
        height: encoded.height,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedScreenshot {
    path: String,
}

/// 把截图工具拿到的 PNG base64 落进数据根 `screenshots/<时间戳>.png`。
///
/// 写盘/授权/保留三步复用 [`save_managed_image`]（与粘贴落盘共用同一实现）：
/// 原子替换写、`AssetScopePort::allow_file` 预览授权、按 mtime 只保留最新
/// [`SCREENSHOT_RETENTION`] 个文件。预览授权在落盘时一并完成（与 `validate_chat_images`
/// 对用户图片的授权同一机制），否则聊天里的 `convertFileSrc` 预览会被 asset 协议范围拒绝。
pub fn save_screenshot(
    caller: Option<WindowId>,
    paths: &AppPaths,
    assets: &dyn AssetScopePort,
    image_base64: String,
) -> AppResult<SavedScreenshot> {
    require_business_window(caller)?;
    let bytes = STANDARD
        .decode(image_base64.as_bytes())
        .map_err(|_| AppError::Other("截图数据不是有效的 base64".into()))?;
    if bytes.is_empty() || bytes.len() > SCREENSHOT_MAX_BYTES {
        return Err(AppError::Other("截图数据大小无效".into()));
    }
    // 只接受 PNG：这份命令的输入应当来自 capture_screenshot，而不是任意二进制。
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::Other("截图数据不是 PNG".into()));
    }

    let safe_path = save_managed_image(
        &paths.data_root,
        assets,
        SCREENSHOT_DIR,
        "png",
        &bytes,
    )?;
    Ok(SavedScreenshot {
        path: safe_path.to_string_lossy().into_owned(),
    })
}

/// 把图片字节写入托管聊天图片目录（`screenshots/` 或 `pasted/`）并完成预览授权与保留清理。
///
/// 两个调用点共用这一份实现（[`save_screenshot`] 与 `ui/chat/paste.rs` 的粘贴落盘），
/// 三步与既有截图落盘同口径：
/// 1. 同目录临时文件 + `rename` 原子替换（与 `file_write_atomic` 同款；跨文件系统的
///    rename 会被内核拒绝，所以临时文件必须与目标同目录）；
/// 2. 预览授权（[`AssetScopePort::allow_file`]；失败不吞掉落盘结果，只留痕 ——
///    没有授权时聊天里的图片不会显示）；
/// 3. 按 mtime 只保留最新 [`SCREENSHOT_RETENTION`] 个常规文件。
///
/// 目标不覆盖已有文件（同毫秒顺延文件名）；路径边界走 [`AppPaths`] 的既有校验
/// （校验新文件路径 + 建目录后复核父目录去向），本函数不写第二份分隔符归一。
/// `extension` 只是磁盘上的可读性标签，格式准入始终以字节头为准（调用方必须传与字节
/// 一致的扩展名；转码产物传 `png`）。
pub fn save_managed_image(
    data_root: &Path,
    assets: &dyn AssetScopePort,
    dir_name: &str,
    extension: &str,
    bytes: &[u8],
) -> AppResult<PathBuf> {
    let dir = data_root.join(dir_name);
    let target = next_available_path(&dir, unix_now_ms(), extension);
    let safe_path = AppPaths::validate_new_file_path(&target)?;
    let parent = safe_path.parent().ok_or(AppError::PathEscape)?;
    std::fs::create_dir_all(parent)
        .map_err(|error| AppError::Io(format!("创建图片目录失败: {error}")))?;
    // 建目录之后再确认一次父目录去向：校验到写入之间可能被换成指向根外的符号链接。
    AppPaths::revalidate_existing_parent(&safe_path)?;

    let file_name = safe_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(AppError::PathEscape)?;
    let temp_path = parent.join(format!(
        "{file_name}.tmp-{}-{}",
        std::process::id(),
        unix_now_ms()
    ));
    if let Err(error) = std::fs::write(&temp_path, bytes) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::Io(format!("写入图片失败: {error}")));
    }
    if let Err(error) = AppPaths::revalidate_existing_parent(&safe_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temp_path, &safe_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::Io(format!("写入图片失败: {error}")));
    }

    if let Err(error) = assets.allow_file(&safe_path) {
        rust_debug!("图片预览授权失败: {error}");
    }
    prune_managed_images(&dir, SCREENSHOT_RETENTION);

    Ok(safe_path)
}

/// 同毫秒内重复调用时顺延文件名，避免覆盖上一张（顺序调用下几乎不会发生，仅作兜底）。
fn next_available_path(dir: &Path, now_ms: u64, extension: &str) -> PathBuf {
    let mut stamp = now_ms;
    loop {
        let candidate = dir.join(format!("{stamp}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
        stamp += 1;
    }
}

/// 按 mtime 从旧到新保留最新 `retain` 个常规文件，其余删除。
///
/// 只统计常规文件（目录、符号链接不参与计数也不删除）；单个删除失败只留痕，不影响其它条目，
/// 清理失败更不允许让一次成功的图片落盘变成失败。
fn prune_managed_images(dir: &Path, retain: usize) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            rust_debug!("图片保留清理跳过不可读目录: {error}");
            return;
        }
    };
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        files.push((path, mtime_ms));
    }
    for path in expired_managed_image_paths(files, retain) {
        if let Err(error) = std::fs::remove_file(&path) {
            rust_debug!("清理过期图片失败 {}: {error}", path.display());
        }
    }
}

/// 纯选择逻辑：按 mtime 升序取最旧的多余条目（超过 `retain` 的部分）。保持可单测。
fn expired_managed_image_paths(mut files: Vec<(PathBuf, u64)>, retain: usize) -> Vec<PathBuf> {
    if files.len() <= retain {
        return Vec::new();
    }
    files.sort_by_key(|(_, mtime_ms)| *mtime_ms);
    let remove_count = files.len() - retain;
    files.drain(..remove_count).map(|(path, _)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::Mutex;
    use std::time::Duration;

    /// 记录授权动作的测试替身（预览授权只做留痕，不参与断言路径以外的行为）。
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

    /// 每用例独占的夹具目录（仓库 `test/.tmp`，不落仓库外）。
    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/.tmp")
            .join(format!("deskpet-image-store-{tag}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        // 落盘实现会 canonicalize（`validate_new_file_path`），夹具根也归一，
        // 否则 `starts_with` 会被 `..` 组件假阴。
        root.canonicalize().unwrap()
    }

    fn paths_with_mtimes(count: usize) -> Vec<(PathBuf, u64)> {
        (0..count)
            .map(|index| (PathBuf::from(format!("/tmp/{index}.png")), index as u64))
            .collect()
    }

    #[test]
    fn prune_keeps_newest_entries_and_removes_oldest_first() {
        let expired = expired_managed_image_paths(paths_with_mtimes(205), 200);
        assert_eq!(expired.len(), 5);
        // mtime 升序：删掉的是最旧的 0..5，保留 5..205。
        assert_eq!(expired[0], PathBuf::from("/tmp/0.png"));
        assert_eq!(expired[4], PathBuf::from("/tmp/4.png"));
    }

    #[test]
    fn prune_is_noop_at_or_below_retention_limit() {
        assert_eq!(
            SCREENSHOT_RETENTION, 200,
            "保留上限是对用户的承诺（文案与文档同值），改动要一起改"
        );
        assert!(expired_managed_image_paths(paths_with_mtimes(200), 200).is_empty());
        assert!(expired_managed_image_paths(paths_with_mtimes(3), 200).is_empty());
        assert!(expired_managed_image_paths(Vec::new(), 200).is_empty());
    }

    #[test]
    fn prune_does_not_assume_sorted_input() {
        let files = vec![
            (PathBuf::from("/tmp/new.png"), 300u64),
            (PathBuf::from("/tmp/old.png"), 100u64),
            (PathBuf::from("/tmp/mid.png"), 200u64),
        ];
        let expired = expired_managed_image_paths(files, 2);
        assert_eq!(expired, vec![PathBuf::from("/tmp/old.png")]);
    }

    #[test]
    fn next_available_path_does_not_overwrite_existing_same_millisecond_file() {
        // 目录名带纳秒，避免上一次中断留下的残留影响断言。
        let root = temp_root("name");
        std::fs::write(root.join("1000.png"), b"x").unwrap();
        let next = next_available_path(&root, 1000, "png");
        assert_eq!(next, root.join("1001.png"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 落盘走「原子替换 + 授权 + 保留清理」三步且不留临时文件（粘贴与截图共用的实现点）。
    #[test]
    fn save_managed_image_is_atomic_authorized_and_prunes_by_mtime() {
        let root = temp_root("store");
        let assets = RecordingAssets {
            allowed: Mutex::new(Vec::new()),
        };
        let payload = b"\x89PNG\r\n\x1a\npayload-bytes".to_vec();
        let saved =
            save_managed_image(&root, &assets, PASTED_DIR, "png", &payload).expect("落盘必须成功");

        assert_eq!(std::fs::read(&saved).unwrap(), payload, "字节必须原样落盘");
        assert!(saved.starts_with(root.join(PASTED_DIR)), "{saved:?}");
        assert_eq!(
            assets.allowed.lock().unwrap().len(),
            1,
            "落盘后必须做一次预览授权"
        );
        assert!(
            std::fs::read_dir(root.join(PASTED_DIR))
                .unwrap()
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")),
            "原子写的临时文件不得残留"
        );

        // 保留清理：放入 3 个更老的文件，prune(retain = 2) 按 mtime 淘汰最旧的两个。
        let dir = root.join(PASTED_DIR);
        for (name, age_secs) in [("old.png", 30u64), ("mid.png", 20u64)] {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            File::open(&path)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(age_secs))
                .unwrap();
        }
        prune_managed_images(&dir, 2);
        let remaining: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(remaining.len(), 2, "{remaining:?}");
        assert!(!remaining.contains(&"old.png".to_string()), "{remaining:?}");
        assert!(
            !remaining.iter().any(|name| name.contains(".tmp-")),
            "{remaining:?}"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 目录创建失败必须如实报错（不吞、不换落点）；同一份错误文案两个调用点共用。
    #[test]
    fn save_managed_image_reports_directory_failure() {
        let root = temp_root("store-fail");
        // 目标目录名被一个常规文件占住：create_dir_all 必然失败。
        std::fs::write(root.join(PASTED_DIR), b"not a dir").unwrap();
        let assets = RecordingAssets {
            allowed: Mutex::new(Vec::new()),
        };
        let error = save_managed_image(&root, &assets, PASTED_DIR, "png", b"x").unwrap_err();
        assert!(
            error.to_string().contains("创建图片目录失败"),
            "文案：{error}"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
