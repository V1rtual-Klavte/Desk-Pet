//! 聊天内联预览的 owner 与生命周期（执行契约 §5.3「聊天图片自动预览开关」）。
//!
//! 自动预览开关 `appearance.chatImagePreview`（默认 false）在宿主侧的落点是
//! [`InlinePreviewManager::set_enabled`]：Node 经桥命令 `configure_chat_image_preview`
//! 在启动与设置保存时推送（命令登记在 `src/services/host/types.ts`，标注「W7 有意扩展」），
//! 收到推送前管理器保持关闭、不行任何加载（与 `configure_global_shortcut` 的
//! 「收到前不注册」同一 fail-closed 口径，Rust 不复制 CONFIG 默认值）。
//!
//! # 生命周期与不变式（全部由本管理器落实）
//!
//! - **关闭（默认）零预读**：开关关闭时 [`InlinePreviewManager::sync_visible`] 不签发
//!   任何加载票据，[`InlinePreviewManager::load`] 对任何已失效票据也会在**读字节之前**
//!   直接丢弃；占位渲染所需的元数据由 UI 侧（`ui::chat::placeholders`）只调
//!   `metadata()` 完成，不经过本模块。
//! - **只在可见消息上加载**：加载的唯一入口是 `sync_visible` 为**当前可见集合**签发的
//!   票据（票据字段私有、无公开构造器，单次消费）；看不到的消息不会进入任何加载路径。
//!   可见性 / 滚动 / 分页的判断是调用方（原生 UI）的责任，本模块只提供能被正确调用的
//!   owner / 生命周期 API。
//! - **离开视口、切会话、收起、关闭聊天视图即释放**：移出可见集合的 owner 的已解码帧
//!   随登记一并释放（`sync_visible` / `release` / `release_all`）；切会话由调用方更换
//!   `view_generation`（owner 的组成部分）并经 `sync_visible` 声明新集合完成。
//! - **晚到结果按 owner/viewGeneration 丢弃**：`load` 在解码前后各复核一次
//!   「开关仍开 + 票据仍是该 owner 的当前未消费票据」，失败的结果随栈释放、不进入
//!   管理器状态（`Discarded`）。owner 复用查看器的 [`PreviewOwner`]（含
//!   `view_generation`），代际变化即不同的 owner，旧代际的结果永远对不上；票据另挡住
//!   「同一 owner 移出后重新入视口」的旧结果——两重复核与查看器侧同一模式。
//! - **查看器独立**：查看器预览由 [`crate::images::preview::PreviewManager`] 单独持有与
//!   释放，与本模块不共享任何状态；开关只影响内联预览，点击占位打开查看器
//!   （`ui::chat::viewer`）不看本模块的开关。
//! - **不影响模型看图**：请求投影（[`crate::images::request::prepare_request_image`]）
//!   与 read 工具（[`crate::images::request::process_read_image`]）不经过本模块，
//!   开关变化不触碰它们，也不触碰 JSONL 里的原路径。
//! - **失败给明确原因**：可见图片加载失败时错误原样返回，并作为 [`InlinePreviewState::Unavailable`]
//!   留在状态里供 UI 呈现；不静默删路径、不降级格式。要重试（如文件恢复）由调用方
//!   release 后重新 `sync_visible` 换取新票据。
//!
//! 与查看器的分工：内联预览只解**首帧**；查看器同样只显示首帧（动画 GIF/WebP 不播放，
//! 2026-10-04 用户指令，理由：内存）。压缩字节在首帧解出后立即释放，管理器只保留像素帧。
//!
//! 线程模型：管理器 `Send + Sync`（下方的编译期断言）；`load` 可在调用方解码工作线程上
//! 执行，**不得在 UI 主线程做解码**。解码期间不持所有权锁，`set_enabled(false)` /
//! `sync_visible` / `release` 不会被慢解码阻塞。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::rust_warn;

use super::decode::{decode_first_frame, DecodedFrame};
use super::preview::PreviewOwner;
use super::{limits, validate::ValidatedImagePath};

/// 一次「可见 → 发起加载」的票据：由 [`InlinePreviewManager::sync_visible`] 签发，
/// 解码完成后原样回传 [`InlinePreviewManager::load`]。
///
/// 字段私有且无公开构造器：**只有可见登记的签发路径能造出票据** —— 这是「没有可见
/// 登记就没有可加载对象」的结构保证。票据一次性：安装 / 失败 / 移出集合后即失效，
/// 旧票据的晚到结果一律丢弃。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineTicket {
    owner: PreviewOwner,
    token: u64,
}

impl InlineTicket {
    /// 票据对应的图片 owner（不解读代际字段；原样传回 `load` 即可）。
    pub fn owner(&self) -> &PreviewOwner {
        &self.owner
    }
}

/// [`InlinePreviewManager::load`] 的结果。
#[derive(Debug)]
pub enum InlineOutcome {
    /// 首帧已安装为当前状态（管理器与调用方共享同一 `Arc<[u8]>`，零拷贝）。
    Ready(DecodedFrame),
    /// 票据已过期（移出可见集合 / 代际变化 / 开关关闭 / 已被新一轮取代 / 已消费）：
    /// 结果在此丢弃并释放，不进入管理器状态。
    Discarded,
}

/// 一张可见图片在内联预览管理器里的状态（UI 只读）。
#[derive(Debug, Clone)]
pub enum InlinePreviewState {
    /// 已登记、等待调用方在解码线程完成后 `load`。
    Loading,
    /// 首帧已就绪，UI 可直接绘制；释放登记即释放该帧。
    Ready(DecodedFrame),
    /// 加载失败（原文件失效 / 超限 / 格式不支持 / 解码失败）：占位继续显示，
    /// 原因供 UI 呈现；重试需 release 后重新声明可见。
    Unavailable { reason: String },
}

struct InlineEntry {
    /// 签发时的代际票据编号（每次登记递增；仅模块内解读）。
    token: u64,
    /// 票据是否已被消费（load 安装成功或失败过）。重入可见集合会换新票据。
    consumed: bool,
    state: InlineEntryState,
}

enum InlineEntryState {
    Loading,
    Ready(DecodedFrame),
    Unavailable(String),
}

#[derive(Default)]
struct InlineState {
    /// 自动预览开关（`configure_chat_image_preview` 推送的落点）；默认关闭。
    enabled: bool,
    next_token: u64,
    /// 当前可见集合：owner → 登记。不在集合里的 owner 不持有任何帧。
    visible: HashMap<PreviewOwner, InlineEntry>,
}

impl InlineState {
    /// 票据当前是否可用：开关开启、登记仍在该 owner 上、票据是当前未消费的那一张。
    fn ticket_usable(&self, ticket: &InlineTicket) -> bool {
        self.enabled
            && self
                .visible
                .get(&ticket.owner)
                .is_some_and(|entry| entry.token == ticket.token && !entry.consumed)
    }
}

/// 内联预览管理器：每台宿主一个实例（由原生聊天 UI 持有）；不依赖 UI 框架，
/// 可在测试里直接驱动。
#[derive(Default)]
pub struct InlinePreviewManager {
    state: Mutex<InlineState>,
}

impl InlinePreviewManager {
    /// UI 只持原路径时的入口：过期票据在格式头校验前丢弃；校验后再挡住取消。
    /// 已开始的文件校验无法撤回，但关闭后不启动新解码、不挂回晚到结果。
    pub fn load_path(
        &self,
        ticket: &InlineTicket,
        path: &str,
        max_bytes: Option<u64>,
    ) -> AppResult<InlineOutcome> {
        if !self.lock().ticket_usable(ticket) {
            return Ok(InlineOutcome::Discarded);
        }
        let source = ValidatedImagePath::validate(path, max_bytes);
        if !self.lock().ticket_usable(ticket) {
            return Ok(InlineOutcome::Discarded);
        }
        match source {
            Ok(source) => self.load(ticket, &source),
            Err(error) => {
                let mut state = self.lock();
                if !state.ticket_usable(ticket) {
                    return Ok(InlineOutcome::Discarded);
                }
                if let Some(entry) = state.visible.get_mut(&ticket.owner) {
                    entry.consumed = true;
                    entry.state = InlineEntryState::Unavailable(error.to_string());
                }
                Err(error)
            }
        }
    }

    /// 新建即关闭：收到 `configure_chat_image_preview` 推送前不加载任何图片。
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置自动预览开关（`configure_chat_image_preview` 的宿主落点）。
    ///
    /// 关闭：立即取消全部在途加载（票据随登记一起失效，其 `load` 在读字节之前丢弃）、
    /// 释放全部已解码帧（UI 应同时释放自己的纹理引用）。开启不预读任何东西：只有后续
    /// `sync_visible` 声明的可见 owner 才会加载。
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.lock();
        if state.enabled == enabled {
            return;
        }
        state.enabled = enabled;
        if !enabled {
            // 显式释放：登记、在途票据与已解码帧一起失效。
            state.visible.clear();
        }
    }

    /// 当前开关值（UI 渲染「占位 or 内联」也读这里，不在别处另存一份布尔）。
    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }

    /// 声明当前可见的图片 owner 集合（UI 依据滚动 / 可见性 / 切会话后调用；幂等）。
    ///
    /// - 仍在集合中的 owner 保留现有登记（`Ready` 不重复解码，`Loading` 不重启）；
    /// - 移出集合的 owner：登记与已解码帧一并释放；
    /// - 新增的 owner：登记并返回**加载票据**，调用方负责在解码线程上执行
    ///   [`InlinePreviewManager::load`]；
    /// - **开关关闭：清空登记并返回空集** —— 零预读由「连票据都不签发」落实。
    ///
    /// 票据一次性：要放弃或重试某个 owner 的加载（例如工作线程未能拉起、文件曾失效），
    /// 先 `release` 该 owner 再重新声明，即可换到一张新票据。
    pub fn sync_visible(&self, owners: &[PreviewOwner]) -> Vec<InlineTicket> {
        let mut state = self.lock();
        if !state.enabled {
            // 防御性清空（set_enabled(false) 已清）：关闭态下不允许有任何登记或票据残留。
            state.visible.clear();
            return Vec::new();
        }
        let wanted: std::collections::HashSet<&PreviewOwner> = owners.iter().collect();
        state.visible.retain(|owner, _| wanted.contains(owner));
        let mut tickets = Vec::new();
        for owner in owners {
            if state.visible.contains_key(owner) {
                continue;
            }
            state.next_token = state.next_token.wrapping_add(1);
            let token = state.next_token;
            state.visible.insert(
                owner.clone(),
                InlineEntry {
                    token,
                    consumed: false,
                    state: InlineEntryState::Loading,
                },
            );
            tickets.push(InlineTicket {
                owner: owner.clone(),
                token,
            });
        }
        tickets
    }

    /// 在解码工作线程上执行一次内联加载（**调用方不得在 UI 主线程调用**）。
    ///
    /// 步骤：
    /// 1. 预检：开关关闭或票据已过期 → 在读字节之前返回 `Discarded`；
    /// 2. 读入有界字节 + 解码首帧（不持锁；与查看器同一准入/解码基础件：
    ///    `revalidate` / `read_within` / `decode_first_frame` / `limits`）；
    /// 3. 提交前复核：期间开关关闭 / 移出可见 / 代际变化 / 票据已消费 → 结果丢弃并释放。
    ///
    /// 失败返回明确原因，并把该 owner 置为 [`InlinePreviewState::Unavailable`]（仍过期则
    /// 只丢弃）。返回的帧与管理器共享同一 `Arc<[u8]>`。
    pub fn load(
        &self,
        ticket: &InlineTicket,
        source: &ValidatedImagePath,
    ) -> AppResult<InlineOutcome> {
        // 1) 预检：关闭/过期票据连原文件都不碰 —— 「关闭时零预读」的宿主侧硬点。
        if !self.lock().ticket_usable(ticket) {
            return Ok(InlineOutcome::Discarded);
        }
        // 2) 读入 + 解码首帧（不持所有权锁；关闭/切会话不被慢解码阻塞）。
        let decoded = load_first_frame(source);
        // 3) 提交前复核：晚到结果在锁内按票据 + owner 丢弃并释放。
        let mut state = self.lock();
        if !state.ticket_usable(ticket) {
            if let Err(error) = &decoded {
                rust_warn!("丢弃晚到的内联预览结果（owner 已过期）: {error}");
            }
            return Ok(InlineOutcome::Discarded);
        }
        let entry = state
            .visible
            .get_mut(&ticket.owner)
            .expect("ticket_usable 保证登记存在");
        entry.consumed = true;
        match decoded {
            Ok(frame) => {
                entry.state = InlineEntryState::Ready(frame.clone());
                Ok(InlineOutcome::Ready(frame))
            }
            Err(error) => {
                entry.state = InlineEntryState::Unavailable(error.to_string());
                Err(error)
            }
        }
    }

    /// 只读状态：`None` = 不在可见集合（应显示占位）；`Loading` 期间占位照常显示。
    pub fn state_of(&self, owner: &PreviewOwner) -> Option<InlinePreviewState> {
        self.lock()
            .visible
            .get(owner)
            .map(|entry| match &entry.state {
                InlineEntryState::Loading => InlinePreviewState::Loading,
                InlineEntryState::Ready(frame) => InlinePreviewState::Ready(frame.clone()),
                InlineEntryState::Unavailable(reason) => InlinePreviewState::Unavailable {
                    reason: reason.clone(),
                },
            })
    }

    /// 释放单个 owner（离开视口 / 消息被回收）；返回是否确有登记被释放。幂等。
    pub fn release(&self, owner: &PreviewOwner) -> bool {
        self.lock().visible.remove(owner).is_some()
    }

    /// 释放全部登记（切会话 / 收起 / 关闭聊天视图收尾），返回释放条数。幂等。
    pub fn release_all(&self) -> usize {
        let mut state = self.lock();
        let count = state.visible.len();
        state.visible.clear();
        count
    }

    fn lock(&self) -> MutexGuard<'_, InlineState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 读入有界字节并解码首帧（与查看器 `open_preview` 同一口径的独立编排）。
///
/// 刻意不合并进 `preview.rs`：W7a 已交付的 `PreviewManager` 语义与测试保持原样，
/// 内联预览只共用同一批基础件（准入上限、有界读取、首帧解码），不共享状态。
fn load_first_frame(source: &ValidatedImagePath) -> AppResult<DecodedFrame> {
    // 可见时刻复核：不信任创建 ValidatedImagePath 时的旧磁盘状态（与查看器点击时刻同口径）。
    let source = source.revalidate()?;
    let limit = limits::image_limits()?.max_bytes;
    let metadata = std::fs::metadata(source.as_path())
        .map_err(|e| AppError::Io(format!("读取图片元数据失败: {e}")))?;
    if metadata.len() > limit {
        return Err(AppError::Tool(format!(
            "图片超过 {} MiB 上限，无法生成内联预览",
            limit / 1024 / 1024
        )));
    }
    // 有界读取：复核与读取之间文件被替换/追加时也不读全量（竞态保护）。
    let Some(bytes) = super::validate::read_within(source.as_path(), limit)? else {
        return Err(AppError::Tool(format!(
            "图片超过 {} MiB 上限，无法生成内联预览",
            limit / 1024 / 1024
        )));
    };
    // 内联只解首帧（动画 GIF/WebP 不播放）；压缩字节在解码返回后随栈释放。
    decode_first_frame(&bytes)
}

/// 编译期护栏：管理器必须能在 UI 主线程与解码工作线程之间安全移交
/// （「可见登记 → 工作线程 load → 提交复核」的异步前提）。一旦变成 `!Send`/`!Sync`，
/// 这一条会让 `cargo check` 直接失败。
#[allow(dead_code)]
fn assert_inline_preview_manager_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<InlinePreviewManager>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use crate::images::preview::{CloseOutcome, PreviewManager};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn owner(generation: u64, entry: &str, image_index: u32) -> PreviewOwner {
        PreviewOwner {
            window_id: "chat".into(),
            view_generation: generation,
            session_id: "session-1".into(),
            entry_id: entry.into(),
            image_index,
        }
    }

    fn temp_validated(tag: &str, bytes: &[u8]) -> (PathBuf, ValidatedImagePath) {
        let dir = fixtures::temp_dir(tag);
        let path = dir.join("inline.bin");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        // 与查看器/聊天图片同一准入上限。
        let validated =
            ValidatedImagePath::validate(&path.to_string_lossy(), Some(15 * 1024 * 1024)).unwrap();
        (dir, validated)
    }

    fn ready_frame(
        manager: &InlinePreviewManager,
        ticket: &InlineTicket,
        source: &ValidatedImagePath,
    ) -> DecodedFrame {
        match manager.load(ticket, source).unwrap() {
            InlineOutcome::Ready(frame) => frame,
            other => panic!("预期 Ready，得到 {other:?}"),
        }
    }

    fn rgba_strong_count(manager: &InlinePreviewManager, owner: &PreviewOwner) -> usize {
        match manager.state_of(owner).expect("owner 应在可见集合里") {
            InlinePreviewState::Ready(frame) => Arc::strong_count(&frame.rgba),
            other => panic!("预期 Ready，得到 {other:?}"),
        }
    }

    #[test]
    fn disabled_switch_signs_no_tickets_and_discards_before_reading() {
        let manager = InlinePreviewManager::new();
        assert!(!manager.enabled(), "收到推送前必须按关闭处理");

        let (dir, source) = temp_validated("inline-disabled", &fixtures::png_solid(2, 2));
        let o = owner(1, "e1", 0);
        assert!(
            manager.sync_visible(std::slice::from_ref(&o)).is_empty(),
            "关闭时不得签发任何加载票据"
        );
        assert!(manager.state_of(&o).is_none(), "关闭时不得建立任何登记");

        // 开启拿票后立刻关闭：票据作废。即使原文件已删除，load 也必须返回 Discarded
        // 而不是读取错误 —— Discarded 证明它连读字节都没做（零预读）。
        manager.set_enabled(true);
        let [ticket] = manager
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        manager.set_enabled(false);
        std::fs::remove_file(source.as_path()).unwrap();
        assert!(matches!(
            manager.load(&ticket, &source).unwrap(),
            InlineOutcome::Discarded
        ));
        assert!(manager.state_of(&o).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_declared_visible_owners_load_and_never_twice() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        let (dir, source) = temp_validated("inline-visible", &fixtures::png_solid(4, 3));
        let (o1, o2, o3) = (owner(1, "e1", 0), owner(1, "e2", 0), owner(1, "e3", 0));

        let tickets = manager.sync_visible(&[o1.clone(), o2.clone()]);
        assert_eq!(tickets.len(), 2, "只有声明的可见 owner 得到票据");
        assert!(
            manager.state_of(&o3).is_none(),
            "未声明可见的消息不得有任何登记"
        );

        // 重复声明同一集合：不重复签发（不重复解码）。
        assert!(manager.sync_visible(&[o1.clone(), o2.clone()]).is_empty());

        let frame = ready_frame(&manager, &tickets[0], &source);
        assert_eq!((frame.width, frame.height), (4, 3));
        assert!(matches!(
            manager.state_of(&o1),
            Some(InlinePreviewState::Ready(_))
        ));
        assert!(matches!(
            manager.state_of(&o2),
            Some(InlinePreviewState::Loading)
        ));
        // 票据一次性：同一张票不能二次安装（第二次在任何读之前就被丢弃）。
        assert!(matches!(
            manager.load(&tickets[0], &source).unwrap(),
            InlineOutcome::Discarded
        ));
        ready_frame(&manager, &tickets[1], &source);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leaving_viewport_and_release_free_frames_immediately() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        let (dir, source) = temp_validated("inline-release", &fixtures::png_solid(2, 2));
        let (o1, o2) = (owner(1, "e1", 0), owner(1, "e2", 0));

        let tickets = manager.sync_visible(&[o1.clone(), o2.clone()]);
        ready_frame(&manager, &tickets[0], &source);
        assert_eq!(
            rgba_strong_count(&manager, &o1),
            2,
            "管理器 + 调用方各持一份"
        );

        // 移出可见集合（滚动离开视口）：帧在 sync 内释放。
        manager.sync_visible(&[o2.clone()]);
        assert!(manager.state_of(&o1).is_none());
        assert!(manager.release(&o2), "release 应释放仍登记的 owner");
        assert!(!manager.release(&o2), "重复 release 幂等");

        // 已释放的旧票据即使晚到也不得安装，且不会扫描任何文件。
        std::fs::remove_file(source.as_path()).unwrap();
        assert!(matches!(
            manager.load(&tickets[1], &source).unwrap(),
            InlineOutcome::Discarded
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reentered_owner_gets_new_ticket_and_old_late_result_is_discarded() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        let (dir, source) = temp_validated("inline-reentry", &fixtures::png_solid(3, 3));
        let o = owner(1, "e1", 0);

        let [first] = manager
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        manager.release(&o);
        let [second] = manager
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        assert_ne!(first, second, "重入视口必须换一张新票据");

        // 第一轮加载的晚到结果：删除原文件后仍返回 Discarded（证明未读取）。
        std::fs::remove_file(source.as_path()).unwrap();
        assert!(matches!(
            manager.load(&first, &source).unwrap(),
            InlineOutcome::Discarded
        ));
        std::fs::write(source.as_path(), fixtures::png_solid(3, 3)).unwrap();
        let frame = ready_frame(&manager, &second, &source);
        assert_eq!((frame.width, frame.height), (3, 3));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generation_change_discards_previous_generation_results() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        let (dir, source) = temp_validated("inline-generation", &fixtures::png_1x1());
        let old = owner(1, "e1", 0);
        let new = owner(2, "e1", 0);

        let [old_ticket] = manager
            .sync_visible(std::slice::from_ref(&old))
            .try_into()
            .unwrap();
        // 切会话/视图重建：调用方递增 viewGeneration 并声明新集合；旧代际的登记被释放。
        let [new_ticket] = manager
            .sync_visible(std::slice::from_ref(&new))
            .try_into()
            .unwrap();
        assert!(manager.state_of(&old).is_none(), "旧代际不得残留登记");

        std::fs::remove_file(source.as_path()).unwrap();
        assert!(
            matches!(
                manager.load(&old_ticket, &source).unwrap(),
                InlineOutcome::Discarded
            ),
            "旧代际结果必须按 owner 丢弃"
        );
        std::fs::write(source.as_path(), fixtures::png_1x1()).unwrap();
        ready_frame(&manager, &new_ticket, &source);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn disabling_releases_frames_and_invalidates_inflight_tickets() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        let (dir, source) = temp_validated("inline-toggle", &fixtures::png_solid(2, 2));
        let o = owner(1, "e1", 0);

        let [inflight] = manager
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        let frame = ready_frame(&manager, &inflight, &source);
        let buffer = frame.rgba;
        assert_eq!(Arc::strong_count(&buffer), 2);

        // 关闭：释放已解码帧；在途票据作废。
        manager.set_enabled(false);
        assert_eq!(Arc::strong_count(&buffer), 1, "关闭开关必须释放内联帧");
        assert!(manager.state_of(&o).is_none());

        // 再开启也不预热：只有重新声明可见才重新加载，且旧票据永远作废。
        manager.set_enabled(true);
        let [fresh] = manager
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        assert_ne!(fresh, inflight);
        assert!(matches!(
            manager.load(&inflight, &source).unwrap(),
            InlineOutcome::Discarded
        ));
        ready_frame(&manager, &fresh, &source);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn viewer_lifecycle_is_independent_of_the_inline_switch() {
        let viewer = PreviewManager::new();
        let inline = InlinePreviewManager::new();
        let (dir, source) = temp_validated("inline-viewer-independent", &fixtures::png_solid(2, 2));

        // 查看器打开当前图（点击占位路径）。
        let viewer_request_owner = owner(1, "viewer-entry", 0);
        let handle = viewer
            .open_preview(viewer_request_owner.clone(), &source)
            .unwrap();
        assert!(viewer.current_frame().is_some());

        // 内联开关关掉：只释放内联资源，不得碰查看器 owner/帧。
        inline.set_enabled(true);
        let o = owner(1, "e1", 0);
        let [ticket] = inline
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        ready_frame(&inline, &ticket, &source);
        inline.set_enabled(false);
        assert_eq!(inline.release_all(), 0, "关闭后内联登记已清空");
        assert!(viewer.current_frame().is_some(), "开关关闭不得释放查看器帧");
        assert_eq!(viewer.active_owner().unwrap(), *handle.owner());

        // 关闭查看器也不影响内联：重新加载一份内联帧后关查看器。
        inline.set_enabled(true);
        let [again] = inline
            .sync_visible(std::slice::from_ref(&o))
            .try_into()
            .unwrap();
        ready_frame(&inline, &again, &source);
        assert_eq!(viewer.close_preview(handle.owner()), CloseOutcome::Closed);
        assert!(matches!(
            inline.state_of(&o),
            Some(InlinePreviewState::Ready(_))
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_failure_reports_reason_and_only_affects_that_owner() {
        let manager = InlinePreviewManager::new();
        manager.set_enabled(true);
        // 两处同内容临时文件：一个保持有效，一个在校验后被损坏。
        let (dir, good) = temp_validated("inline-failure-good", &fixtures::png_solid(2, 2));
        let (dir2, broken) = temp_validated("inline-failure-broken", &fixtures::png_solid(2, 2));
        let (o1, o2) = (owner(1, "e1", 0), owner(1, "e2", 0));

        let tickets = manager.sync_visible(&[o1.clone(), o2.clone()]);
        ready_frame(&manager, &tickets[0], &good);

        std::fs::write(broken.as_path(), b"\x89PNG\r\n\x1a\nrubble").unwrap();
        let error = manager.load(&tickets[1], &broken).unwrap_err();
        assert!(error.to_string().contains("图片解码失败"), "文案：{error}");
        match manager.state_of(&o2) {
            Some(InlinePreviewState::Unavailable { reason }) => {
                assert!(reason.contains("图片解码失败"), "原因：{reason}");
            }
            other => panic!("失败必须记录为 Unavailable，得到 {other:?}"),
        }
        // 另一个 owner 不受影响。
        assert!(matches!(
            manager.state_of(&o1),
            Some(InlinePreviewState::Ready(_))
        ));
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(dir2).unwrap();
    }
}
