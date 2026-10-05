//! 图片查看器：占位点击 → 独立查看器窗 的 owner/generation 机制（执行契约 §5.3）。
//!
//! 一个进程同一时刻只保留**当前图片**的一套预览资源（[`PreviewManager`] 的承诺）；
//! 本模块负责 UI 侧的两件事：
//!
//! 1. 点击时构建 [`PreviewOwner`]（window/viewGeneration/session/entry/imageIndex），
//!    打开即解码首帧供平台绘制 —— 动画 GIF/WebP 只显示首帧、不播放
//!    （2026-10-04 用户指令，理由：内存）；
//! 2. **切图 / 切会话 / 关查看器 / 收起主窗 / 退出**时关闭 owner 并递增代际，
//!    让晚到的打开/解码结果按代际丢弃（真正的释放由调用方按代际复核后经
//!    `PreviewManager::close_preview` 的 owner 判定执行）。
//!
//! 打开的资源边界与准入复核都在点击时刻进行（`ValidatedImagePath::validate` +
//! `PreviewManager::open_preview` 的二次复核），失效以明确原因返回，由调用方
//! 转成中性通知 —— 不静默删路径、不降级格式/数量。

use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{AppError, AppResult};
use crate::images::preview::{PreviewHandle, PreviewManager, PreviewOwner};
use crate::images::{limits, validate::ValidatedImagePath};

/// 预览 owner 的窗口标识（§5.3 的 `windowId`；查看器是独立窗口，恒为该值）。
pub const VIEWER_WINDOW_ID: &str = "viewer";

/// 一次「打开查看器」请求：定位投影里的一条消息图片。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerRequest {
    pub session_id: String,
    pub entry_id: String,
    pub image_index: u32,
    pub path: String,
}

/// 生成查看器 owner（代际由调用方给）。
pub fn owner_for(request: &ViewerRequest, view_generation: u64) -> PreviewOwner {
    PreviewOwner {
        window_id: VIEWER_WINDOW_ID.to_string(),
        view_generation,
        session_id: request.session_id.clone(),
        entry_id: request.entry_id.clone(),
        image_index: request.image_index,
    }
}

/// 打开预览的可复用步骤（在打开工作线程调用）：准入复核 → 打开 → 首帧。
///
/// 返回句柄用于首帧绘制；调用方负责后续的 owner 关闭。
pub fn open_preview_for(
    manager: &PreviewManager,
    request: &ViewerRequest,
    view_generation: u64,
) -> AppResult<PreviewHandle> {
    let max_bytes = limits::image_limits()?.max_bytes;
    let source = ValidatedImagePath::validate(&request.path, Some(max_bytes))?;
    manager.open_preview(owner_for(request, view_generation), &source)
}

/// 推进代际计数（打开新图与关闭共用；晚到结果凭它丢弃）。
///
/// 计数器由宿主持有（`ui.rs` 的 `Arc<AtomicU64>`），打开与关闭路径共享同一份计数。
pub fn next_generation(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

/// 查看器状态（当前 owner）。字段由调用方的互斥量保护。
#[derive(Debug, Default)]
pub struct ViewerState {
    /// 当前打开的 owner（关闭资源用它；句柄由调用方用于首帧绘制）。
    owner: Option<PreviewOwner>,
}

impl ViewerState {
    pub fn owner(&self) -> Option<&PreviewOwner> {
        self.owner.as_ref()
    }

    /// 记录打开成功的 owner。
    pub fn install(&mut self, owner: PreviewOwner) {
        self.owner = Some(owner);
    }

    /// 释放当前 owner（幂等；返回是否确有资源被关）。代际递增由调用方先行完成。
    pub fn close(&mut self, manager: &PreviewManager) -> bool {
        match self.owner.take() {
            Some(owner) => {
                manager.close_preview(&owner);
                true
            }
            None => false,
        }
    }
}

/// 会话缺失时的明确错误（打开查看器需要 owner 的 session 段）。
pub fn missing_session_error() -> AppError {
    AppError::Other("会话尚未就绪，无法打开查看器".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use std::io::Write;

    fn temp_validated(tag: &str, bytes: &[u8]) -> (std::path::PathBuf, String) {
        let dir = fixtures::temp_dir(tag);
        let path = dir.join("viewer.bin");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        let string = path.to_string_lossy().into_owned();
        (dir, string)
    }

    #[test]
    fn 打开后关闭释放owner并可再次打开() {
        let (dir, path) = temp_validated("viewer-open-close", &fixtures::png_solid(4, 3));
        let manager = PreviewManager::new();
        let request = ViewerRequest {
            session_id: "s1".into(),
            entry_id: "e1".into(),
            image_index: 0,
            path,
        };
        let counter = AtomicU64::new(0);
        let mut state = ViewerState::default();
        let generation = next_generation(&counter);
        let handle = open_preview_for(&manager, &request, generation).unwrap();
        state.install(handle.owner().clone());
        assert_eq!(handle.dimensions(), (4, 3));
        assert!(manager.current_frame().is_some());

        assert!(state.close(&manager), "关闭必须释放当前 owner");
        assert!(manager.current_frame().is_none(), "关闭后不得保留解码帧");
        assert!(!state.close(&manager), "重复关闭是幂等 no-op");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 切图换代际让旧代际关闭失效() {
        let (dir, path) = temp_validated("viewer-switch", &fixtures::png_1x1());
        let manager = PreviewManager::new();
        let request = ViewerRequest {
            session_id: "s1".into(),
            entry_id: "e1".into(),
            image_index: 0,
            path,
        };
        let counter = AtomicU64::new(0);
        let mut state = ViewerState::default();
        let first_generation = next_generation(&counter);
        let first = open_preview_for(&manager, &request, first_generation).unwrap();
        state.install(first.owner().clone());

        // 切到下一张图（同一消息的 index 1）：新代际打开即取代旧 owner。
        let second_request = ViewerRequest {
            image_index: 1,
            ..request.clone()
        };
        let second_generation = next_generation(&counter);
        let second = open_preview_for(&manager, &second_request, second_generation).unwrap();
        state.install(second.owner().clone());
        assert_eq!(
            manager.active_owner().unwrap().image_index,
            1,
            "管理器只保留当前图片"
        );

        // 旧代际的关闭不能碰新代际（owner 不同，管理器按 owner 判定）。
        assert_eq!(
            manager.close_preview(first.owner()),
            crate::images::preview::CloseOutcome::NotActive
        );
        assert!(state.close(&manager));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 失效文件打开给出明确原因() {
        let manager = PreviewManager::new();
        let request = ViewerRequest {
            session_id: "s1".into(),
            entry_id: "e1".into(),
            image_index: 0,
            path: "/definitely/not/here.png".into(),
        };
        let error = open_preview_for(&manager, &request, 1).unwrap_err();
        assert_eq!(error.code(), "PATH_NOT_FOUND");
    }
}
