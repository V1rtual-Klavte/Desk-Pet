//! 查看器预览 owner（执行契约 §5.3）。
//!
//! 生命周期规则（全部由 [`PreviewManager`] 落实）：
//! - **同时只保留当前图片的一套预览资源**：一帧已解码像素。动画 GIF/WebP 只显示
//!   首帧、不推进（2026-10-04 用户指令，理由：内存），打开即解码，无帧序列缓存。
//! - `open_preview`（点击占位 / 切图 / 切会话重开）会**立即取代**旧 owner 并释放其
//!   全部资源（已解码帧、压缩字节）；`close_preview`（关查看器 / 收起主窗 /
//!   退出）释放当前资源；`close_all` 供不持有具体 owner 的收尾路径使用。
//! - **晚到结果按 owner/viewGeneration 丢弃且释放**：打开路径的解码在所有权锁之外
//!   执行；提交前由调用方复核代际（UI 的 generation 计数），过期结果按 owner
//!   close 释放，close 只认精确 owner，旧代际的关闭碰不到新 owner 的资源
//!   （这是本模块最容易写漏的一条，测试单独覆盖）。
//! - 点击打开时按 Rust 路径规则**复核原文件**（[`ValidatedImagePath::revalidate`]），
//!   失效（不存在/凭据/越权/格式不支持/超过 15 MiB 准入）都以明确原因返回，
//!   不静默删路径、不降低图片数量或格式。
//! - 打开即把压缩字节读进内存（文件句柄立刻关闭）；首帧解码后不再保留压缩字节。
//! - **预览与模型请求不共享永久缓存**：本管理器只在「当前图片」存活期间持有资源，
//!   请求侧每次经 `request::prepare_request_image` 现算，两边没有共享缓存层。
//!
//! 线程模型：管理器是 `Send + Sync`（下面的编译期断言），打开可以在 UI 工作线程上
//! 执行；解码不持所有权锁，`close_preview` / `open_preview` 不被慢解码阻塞。
//! GPU 纹理由 UI 层持有：UI 应在收到替换帧 / 关闭后释放自己的纹理引用，
//! 本模块保证不再保留任何帧引用（`Arc<[u8]>` 强引用计数测试覆盖）。

use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::decode::{decode_first_frame, DecodedFrame};
use super::{format, limits, validate::ValidatedImagePath};

/// 查看器 owner：身份由 window / viewGeneration / session / entry / imageIndex 共同构成
/// （形状与执行契约 §5.3 一致；camelCase 供 IPC 直传）。任一段变化都是新 owner。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOwner {
    pub window_id: String,
    pub view_generation: u64,
    pub session_id: String,
    pub entry_id: String,
    pub image_index: u32,
}

/// 打开结果句柄。调用方只需原样传回 [`PreviewManager::close_preview`]，
/// 不解读内部代际字段。
#[derive(Debug)]
pub struct PreviewHandle {
    owner: PreviewOwner,
    width: u32,
    height: u32,
}

impl PreviewHandle {
    pub fn owner(&self) -> &PreviewOwner {
        &self.owner
    }

    /// 首帧尺寸（动画格式为画布尺寸）。
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// `close_preview` 的结果：关闭了当前 owner，或该 owner 已不是当前（已过期/未打开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    Closed,
    NotActive,
}

struct ActivePreview {
    owner: PreviewOwner,
    current: Option<DecodedFrame>,
}

#[derive(Default)]
struct PreviewState {
    active: Option<ActivePreview>,
}

/// 查看器预览管理器：每台宿主一个实例；不依赖 UI 框架，可在测试里直接驱动。
#[derive(Default)]
pub struct PreviewManager {
    state: Mutex<PreviewState>,
}

impl PreviewManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 打开预览（点击占位/切图/切会话统一走这里）。
    ///
    /// 复核原路径 → 读入字节 → 解码首帧；成功后立即取代当前 owner，
    /// 旧资源在本次调用内释放。任一步失败都返回明确原因，当前 owner 不被破坏。
    pub fn open_preview(
        &self,
        owner: PreviewOwner,
        source: &ValidatedImagePath,
    ) -> AppResult<PreviewHandle> {
        // 点击时刻复核：不信任创建 ValidatedImagePath 时的旧磁盘状态。
        let source = source.revalidate()?;
        let limit = limits::image_limits()?.max_bytes;
        let metadata = std::fs::metadata(source.as_path())
            .map_err(|e| AppError::Io(format!("读取图片元数据失败: {e}")))?;
        if metadata.len() > limit {
            // 原文件已不再满足既有准入上限：明确报告失效原因，不静默降级。
            return Err(AppError::Tool(format!(
                "图片超过 {} MiB 上限，无法打开查看器",
                limit / 1024 / 1024
            )));
        }
        // 有界读取：复核与读取之间文件被替换/追加时也不读全量（竞态保护）。
        let Some(bytes) = super::validate::read_within(source.as_path(), limit)? else {
            return Err(AppError::Tool(format!(
                "图片超过 {} MiB 上限，无法打开查看器",
                limit / 1024 / 1024
            )));
        };
        format::sniff(&bytes).ok_or_else(format::unsupported_error)?;
        // 只解首帧（动画 GIF/WebP 不推进）；压缩字节在解码返回后随栈释放。
        let first = decode_first_frame(&bytes)?;
        let (width, height) = (first.width, first.height);

        let mut state = self.lock();
        // 旧 owner 的帧与压缩字节随赋值在这里释放。
        state.active = Some(ActivePreview {
            owner: owner.clone(),
            current: Some(first),
        });
        Ok(PreviewHandle {
            owner,
            width,
            height,
        })
    }

    /// 关闭指定 owner 的预览（关查看器/切会话先关旧图）。过期 owner 是安全 no-op。
    pub fn close_preview(&self, owner: &PreviewOwner) -> CloseOutcome {
        let mut state = self.lock();
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.owner == *owner)
        {
            // 显式释放：当前帧与压缩字节一起 drop。
            state.active = None;
            CloseOutcome::Closed
        } else {
            CloseOutcome::NotActive
        }
    }

    /// 不依赖调用方持有什么 owner 的强制释放（收起主窗/退出收尾）。
    pub fn close_all(&self) -> CloseOutcome {
        let mut state = self.lock();
        if state.active.take().is_some() {
            CloseOutcome::Closed
        } else {
            CloseOutcome::NotActive
        }
    }

    /// 当前帧的共享句柄（UI 初次绘制用；`Arc` 克隆，不复制像素）。
    pub fn current_frame(&self) -> Option<DecodedFrame> {
        self.lock()
            .active
            .as_ref()
            .and_then(|active| active.current.clone())
    }

    /// 当前 owner（诊断/测试用；正常流程不需要读它）。
    pub fn active_owner(&self) -> Option<PreviewOwner> {
        self.lock()
            .active
            .as_ref()
            .map(|active| active.owner.clone())
    }

    fn lock(&self) -> MutexGuard<'_, PreviewState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 编译期护栏：预览管理器必须能在 UI 线程与解码工作线程之间安全移交
/// （契约 §5.3 的异步加载与晚到释放都以此为前提）。一旦变成 `!Send`/`!Sync`，
/// 这一条会让 `cargo check` 直接失败。
#[allow(dead_code)]
fn assert_preview_manager_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PreviewManager>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn owner(generation: u64, image_index: u32) -> PreviewOwner {
        PreviewOwner {
            window_id: "viewer".into(),
            view_generation: generation,
            session_id: "session-1".into(),
            entry_id: "entry-1".into(),
            image_index,
        }
    }

    fn temp_validated(tag: &str, bytes: &[u8]) -> (PathBuf, ValidatedImagePath) {
        let dir = fixtures::temp_dir(tag);
        let path = dir.join("preview.bin");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        // 预览与聊天图片同一准入上限（与命令层将传入的口径一致）。
        let validated =
            ValidatedImagePath::validate(&path.to_string_lossy(), Some(15 * 1024 * 1024)).unwrap();
        (dir, validated)
    }

    #[test]
    fn open_reports_first_frame_and_dimensions() {
        let (dir, source) = temp_validated("preview-open", &fixtures::png_solid(4, 3));
        let manager = PreviewManager::new();
        let handle = manager.open_preview(owner(1, 0), &source).unwrap();
        assert_eq!(handle.dimensions(), (4, 3));
        let frame = manager.current_frame().expect("打开即解码首帧");
        assert_eq!((frame.width, frame.height), (4, 3));
        assert!(manager.active_owner().is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaced_and_closed_previews_release_frame_buffers() {
        let (dir, source) = temp_validated("preview-release", &fixtures::png_solid(2, 2));
        let manager = PreviewManager::new();

        let handle_a = manager.open_preview(owner(1, 0), &source).unwrap();
        let buffer_a = manager.current_frame().unwrap().rgba;
        assert_eq!(Arc::strong_count(&buffer_a), 2, "管理器 + 测试各持一份");

        // 切图：旧 owner 的资源在 open 内释放。
        let handle_b = manager.open_preview(owner(1, 1), &source).unwrap();
        assert_eq!(Arc::strong_count(&buffer_a), 1, "被替换的预览必须释放旧帧");

        // 关闭：当前帧一并释放。
        let buffer_b = manager.current_frame().unwrap().rgba;
        assert_eq!(
            manager.close_preview(handle_b.owner()),
            CloseOutcome::Closed
        );
        assert_eq!(Arc::strong_count(&buffer_b), 1, "关闭查看器必须释放当前帧");
        assert!(manager.current_frame().is_none());

        // 过期 close 是 no-op；close_all 是收尾兜底。
        assert_eq!(
            manager.close_preview(handle_a.owner()),
            CloseOutcome::NotActive
        );
        assert!(matches!(manager.close_all(), CloseOutcome::NotActive));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn view_generation_change_creates_a_new_owner() {
        let (dir, source) = temp_validated("preview-generation", &fixtures::png_1x1());
        let manager = PreviewManager::new();
        let old = manager.open_preview(owner(1, 0), &source).unwrap();
        let new = manager.open_preview(owner(2, 0), &source).unwrap();
        // 旧 viewGeneration 的关闭动作不能碰新代际的资源。
        assert_eq!(manager.close_preview(old.owner()), CloseOutcome::NotActive);
        assert_eq!(manager.active_owner().unwrap(), *new.owner());
        assert_eq!(manager.close_preview(new.owner()), CloseOutcome::Closed);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gif_opens_on_its_first_frame() {
        // 动画 GIF 不再逐帧播放：打开预览只解首帧；没有可再推进的帧接口。
        let (dir, source) = temp_validated(
            "preview-first-frame",
            &fixtures::gif_animated(2, 100, image::codecs::gif::Repeat::Infinite),
        );
        let manager = PreviewManager::new();
        let handle = manager.open_preview(owner(1, 0), &source).unwrap();
        let first = manager.current_frame().expect("打开即解码首帧");
        assert_eq!((first.width, first.height), (2, 2));
        assert_eq!(first.rgba.len(), 2 * 2 * 4);
        assert_eq!(handle.dimensions(), (2, 2));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn open_fails_with_explicit_reason_for_missing_or_invalid_source() {
        let dir = fixtures::temp_dir("preview-invalid");
        let missing = dir.join("missing.png");
        let missing_source = ValidatedImagePath::validate(&missing.to_string_lossy(), None);
        assert!(
            missing_source.is_err(),
            "构建 ValidatedImagePath 时就该因失效返回原因"
        );

        // 通过校验后文件被删除：open 的点击时刻复核必须再次给出明确原因。
        let path = dir.join("gone.png");
        std::fs::write(&path, fixtures::png_1x1()).unwrap();
        let source = ValidatedImagePath::validate(&path.to_string_lossy(), None).unwrap();
        std::fs::remove_file(&path).unwrap();
        let manager = PreviewManager::new();
        let error = manager.open_preview(owner(1, 0), &source).unwrap_err();
        assert_eq!(error.code(), "PATH_NOT_FOUND");

        // 不受支持的内容：明确报格式原因。
        let text_path = dir.join("text.bin");
        std::fs::write(&text_path, b"definitely not an image").unwrap();
        let text_source = ValidatedImagePath::validate(&text_path.to_string_lossy(), None);
        let error = text_source.unwrap_err();
        assert!(
            error.to_string().contains("PNG/JPEG/GIF/WebP/BMP"),
            "文案：{error}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_open_does_not_disturb_the_current_preview() {
        let (dir, source) = temp_validated("preview-failed-open", &fixtures::png_solid(3, 3));
        let manager = PreviewManager::new();
        let handle = manager.open_preview(owner(1, 0), &source).unwrap();

        let broken_path = dir.join("broken.png");
        std::fs::write(&broken_path, fixtures::png_solid(2, 2)).unwrap();
        let broken_source =
            ValidatedImagePath::validate(&broken_path.to_string_lossy(), None).unwrap();
        // 打开过程中文件被改成不可解码：以明确错误失败，但当前预览不受影响。
        std::fs::write(&broken_path, b"\x89PNG\r\n\x1a\nrubble").unwrap();
        let error = manager
            .open_preview(owner(1, 1), &broken_source)
            .unwrap_err();
        assert!(error.to_string().contains("图片解码失败"), "文案：{error}");
        assert_eq!(manager.active_owner().unwrap(), *handle.owner());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
