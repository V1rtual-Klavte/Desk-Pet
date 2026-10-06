//! 原生聊天窗域（W8a）：窗口、受控富文本、输入/IME、消息列表、流式显示、图片占位与按视口自动预览。
//! W8b 增补：计划确认 / 权限确认 / 用量 / slash 补全 / 队列与中断面板。
//! A3 增补：聊天发图入口（「图片」按钮 / 文件拖入 → 待发送区 → `dispatch_send_text`
//! 随 `ChatIntent::Send::image_paths` 送出；准入走统一图片域，发送/撤选/切会话后释放）。
//!
//! 组成：
//! - [`dialog`]：通用提示对话框（旧壳 `AppDialog.vue` 的承接：标题 + 结论 +
//!   可复制详情；失败详情不再退化为一行自动收起的 notice）；
//! - [`richtext`]：受控 text-span/块协议（纯逻辑，不执行 HTML/脚本、不联网取图）；
//! - [`model`]：聊天显示模型（投影是真相源；流式增量有界合并、终态向提交读模型收敛、
//!   分泡揭示只消费 humanizer 的进度事件；W8b 的计划/权限/队列/用量/slash 状态也在
//!   这里，事件先落模型再调度渲染）；
//! - [`events`] / [`projection`]：冻结 `HostEventMap` 子集与读模型投影的 Rust 形状
//!   （**接线待 W3c/W4 收口**：IPC 分派层拿到事件/投影后调 [`ChatUi::apply_event`] /
//!   [`ChatUi::apply_projection`] / [`ChatUi::apply_reveal`]）；
//! - [`intents`]：UI → Node 的用户意图端口（经 [`install_host_link_intent_port`]
//!   注入 [`intents::HostLinkChatIntentPort`]：会话管理六条与决策类有界组走有界
//!   请求，发送/停止/slash 与决策类「结算点在计划/回合收尾」三条走非阻塞提交，
//!   计划回执与权限回执走宿主事件面；仅剩 `Retry` 未接线，如实报错）。W8b 的回执形状
//!   （`PlanConfirmResult` / `PlanStepDecision` / `PermissionConfirmation`）经
//!   [`ChatIntent::receipt_event`] 给出线上事件名与载荷，接线实现按它投递；
//! - [`panels`]：面板渲染块协议（计划/权限/队列/中断/用量/投递/slash 统一为
//!   标签+行+按钮，平台层只摆放，不解释状态）；
//! - [`slash`]：slash 候选匹配（注册表来自 Node 投影，规则镜像 `registry.ts::search`）；
//! - [`viewer`]：图片查看器 owner/generation（`images::preview::PreviewManager`）；
//! - `InlinePreviewManager`：原生滚动视口的可见图片 owner 集合；离开视口、隐藏或关闭即释放帧；
//! - [`pending_strip`]：待发送条的两块共享件 —— 缩略图缓存（工作线程解码 + 内容指纹
//!   缓存键，未就绪先按文字形态显示）与 chip 宽度/横向滚动几何（超宽时每个 chip 可滚到）；
//! - [`ui`]：进程级单例与主线程刷新调度；平台层（`ui/platform/*_chat.rs`）从这里取
//!   快照、把用户动作送回来。
//!
//! 线程纪律：窗口与控件只在 UI 主线程操作。本域所有跨线程入口先把数据写进模型
//! （互斥量），再经主线程队列调度渲染 —— 不在非主线程碰 AppKit/Win32。

pub mod dialog;
pub mod events;
pub mod intents;
pub mod model;
pub mod panels;
pub mod paste;
pub mod pending_strip;
pub mod placeholders;
pub mod projection;
pub mod richtext;
pub mod slash;
pub mod stream_metrics;
pub mod ui;
pub mod viewer;

use std::sync::Arc;

use crate::ui::MainThreadQueue;

pub use events::{
    ChatEvent, PermissionConfirmRequest, PlanEndReason, PlanGateKind, PlanStepStatus, PlanStepWire,
    SimpleStageKey,
};
pub use intents::{
    ChatIntent, ChatIntentPort, HostLinkChatIntentPort, PermissionConfirmation,
    PlanConfirmCancelReason, PlanConfirmMode, PlanConfirmResult, PlanStepDecision, SendDelivery,
    UiReceiptEvent,
};
pub use model::{
    ChatModel, ChatRenderUpdate, ChatSnapshot, InterruptedRunView, MessageSnapshot, PermissionView,
    PlanStepView, PlanView, QueueState, RevealProgress, Role, SessionTabView, SlashMatchSnapshot,
    SlashSnapshot, StatusSnapshot, UsageState,
};
pub use panels::{
    PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelOutcome, PanelRow, PanelView,
    UnknownStepResolution,
};
pub use pending_strip::PendingThumbStatus;
pub use placeholders::{pending_label, placeholder_label, ImagePlaceholder};
pub use projection::{
    ProjectedHistorySession, ProjectedQueuedItem, ProjectedQueuedKind, ProjectedRecoveredPlan,
    ProjectedRecoveredStep, ProjectedRecoveredStepState, ProjectedSession, ProjectedSessionHistory,
    ProjectedUsageEntry, SlashCommandView, TranscriptProjection,
};
pub use richtext::{parse_blocks, Block, Span, TableRow};
pub use ui::{chat_ui, ChatUi, InlineVisibleImage};

// ==========================================
// 平台层回调面（`ui/platform/{macos,windows}_chat.rs` 调用）
// ==========================================

/// 平台在 UI 启动时安装主线程队列（跨线程渲染调度需要唤醒主循环）。
pub fn install_main_queue(queue: Arc<MainThreadQueue>) {
    chat_ui().install_main_queue(queue);
}

/// 产品 bootstrap：把经 HostLink 收发的意图端口接到聊天 UI 单例上（UI 启动前一次）。
///
/// HostLink 由 bootstrap 预先安装（`ui::ports::install_host_link`）；未安装时调用方
/// （`ui::start_service`）留痕并保持未接线端口 —— 首次派发如实报错，不静默吞。
pub fn install_host_link_intent_port(link: std::sync::Arc<crate::ui::ports::HostLink>) {
    chat_ui().install_intent_port(std::sync::Arc::new(intents::HostLinkChatIntentPort::new(
        link,
    )));
}

/// 打开独立聊天窗（**能力保留**）：W9a 起产品形态的聊天区在主窗内
/// （`platform/{macos,windows}_chat.rs` 的 `mount_main_pane`，与角色舞台同窗合成），
/// 主窗面板已挂载时该入口转为前移主窗；本函数不自动弹窗以免改变产品行为。
pub fn open_window() {
    chat_ui().open_window();
}

/// 收起主窗（桌宠收回）：按 §5.3 释放查看器解码/动画资源。
pub fn on_main_retracted() {
    chat_ui().on_main_retracted();
}

/// 宿主退出收尾：释放全部预览资源。
pub fn on_host_exit() {
    chat_ui().on_host_exit();
}

/// Native chat viewport visibility updates drive inline-image loading and eviction.
pub fn sync_inline_visible(surface: &str, images: Vec<InlineVisibleImage>) {
    chat_ui().sync_inline_visible(surface, images);
}

/// CONFIG push for `appearance.chatImagePreview`.
pub fn configure_inline_previews(enabled: bool) {
    chat_ui().set_inline_preview_enabled(enabled);
}

/// 聊天窗被关闭（平台窗口回调）。
pub fn note_chat_window_closed() {
    chat_ui().note_window_closed();
}

/// 查看器窗被关闭（平台窗口回调）。
pub fn note_viewer_window_closed() {
    chat_ui().note_viewer_window_closed();
}

/// 平台层读取整帧快照（窗口创建/重建时渲染初始内容）。
pub fn snapshot() -> ChatSnapshot {
    chat_ui().snapshot()
}

/// 平台层派发「发送」意图（发送失败时如实返回，调用方保留输入）。
pub fn dispatch_send_text(text: &str, image_paths: Vec<String>) -> crate::error::AppResult<()> {
    chat_ui().dispatch_send_text(text, image_paths)
}

/// 平台层派发「停止」意图。
pub fn dispatch_stop() -> crate::error::AppResult<()> {
    chat_ui().dispatch_stop()
}

/// 平台层派发「切会话」意图（会话标签点击）。
pub fn dispatch_switch_session(session_id: &str) -> crate::error::AppResult<()> {
    chat_ui().dispatch(ChatIntent::SwitchSession {
        session_id: session_id.to_string(),
    })
}

/// 平台层派发「新建会话」意图（标签条「+」；欢迎语由 Node 侧补）。
pub fn dispatch_new_session() -> crate::error::AppResult<()> {
    chat_ui().dispatch(ChatIntent::NewSession)
}

/// 平台层派发「关闭标签」意图（保留会话文件；标签列表由 Node 随投影回推）。
pub fn dispatch_close_session(session_id: &str) -> crate::error::AppResult<()> {
    chat_ui().dispatch(ChatIntent::CloseSession {
        session_id: session_id.to_string(),
    })
}

/// 平台层派发「重试」意图（入口与语义由 W8b/W4 定案，端口先留）。
pub fn dispatch_retry(session_id: &str) -> crate::error::AppResult<()> {
    chat_ui().dispatch(ChatIntent::Retry {
        session_id: session_id.to_string(),
    })
}

/// 点击图片占位：打开独立查看器（异步；失败以中性通知呈现）。
pub fn open_viewer(message_id: &str, image_index: u32) -> crate::error::AppResult<()> {
    chat_ui().open_viewer(message_id, image_index)
}

/// 中性系统通知（发送失败回执等）。
pub fn set_notice(notice: Option<String>) {
    chat_ui().set_notice(notice);
}

// ==========================================
// 聊天发图：选择 / 拖入 → 待发送区（A3）
// ==========================================

/// 选择图片（输入区「图片」按钮与平台入口）：原生多选器 → 准入 → 待发送区。
///
/// 在工作线程执行（文件对话框阻塞；macOS 的 NSOpenPanel 由 `NativeFileDialog`
/// 转投 UI 主线程）。用户取消是正常结果；失败以中性通知呈现（文案来自统一的
/// 图片准入错误，不新造台词）。
pub fn pick_images() -> crate::error::AppResult<()> {
    use crate::host::FileDialogPort;

    let dialog = chat_ui().file_dialog()?;
    std::thread::Builder::new()
        .name("deskpet-chat-pick".into())
        .spawn(move || match dialog.pick_images() {
            Ok(paths) if paths.is_empty() => {} // 用户取消是正常结果
            Ok(paths) => submit_images(paths),
            Err(error) => {
                crate::ui::chat::set_notice(Some(format!("打开图片选择器失败：{error}")));
            }
        })
        .map(|_| ())
        .map_err(|error| crate::error::AppError::Other(format!("图片选择线程创建失败: {error}")))
}

/// 拖入的图片（平台层在 UI 主线程取到路径后调用；准入放到工作线程，不占主线程）。
pub fn add_dropped_images(paths: Vec<String>) -> crate::error::AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    std::thread::Builder::new()
        .name("deskpet-chat-drop".into())
        .spawn(move || submit_images(paths))
        .map(|_| ())
        .map_err(|error| crate::error::AppError::Other(format!("图片拖入线程创建失败: {error}")))
}

/// 准入并追加待发送图片；成功静默，失败给中性通知。
fn submit_images(paths: Vec<String>) {
    match chat_ui().add_pending_images(paths) {
        Ok(_) => crate::ui::chat::set_notice(None),
        Err(error) => crate::ui::chat::set_notice(Some(format!("图片未添加：{error}"))),
    }
}

/// 待发送区图片原路径（平台层「发送」时取出，随 `dispatch_send_text` 入意图）。
pub fn pending_image_paths() -> Vec<String> {
    chat_ui().pending_image_paths()
}

/// 撤选一张待发送图片（待发送条目的点击语义）。
pub fn remove_pending_image(path: &str) {
    chat_ui().remove_pending_image(path);
}

/// 平台层取一张待发送图片的缩略图（`rebuild_pending` 逐条调用）。
///
/// 命中即返回像素；未命中会在 `deskpet-pending-thumb` 工作线程解码并在完成后
/// 自动重推快照 —— 平台层不必轮询。未就绪（Loading / Unavailable）时平台层按
/// 既有文字形态显示（不显示半个图），就绪后随下一帧贴上。
pub fn pending_thumb(image: &ImagePlaceholder) -> PendingThumbStatus {
    chat_ui().pending_thumb(image)
}

/// 平台层在每次重建待发送条时同步条内集合（缩略图缓存的回收口径：
/// 撤选 / 发送 / 切会话后，条外条目的像素立即下岗）。
pub fn retain_pending_thumbs(images: &[ImagePlaceholder]) {
    chat_ui().retain_pending_thumbs(images);
}

// ==========================================
// W8b：面板与 slash 的平台层回调面
// ==========================================

/// 平台层执行一个面板按钮动作（计划/权限/队列/中断/用量/投递/slash）。
///
/// 失败如实返回（平台层用中性通知呈现；不做乐观 UI 变更）。
pub fn apply_panel_action(action: PanelAction) -> crate::error::AppResult<PanelOutcome> {
    chat_ui().apply_panel_action(action)
}

/// 输入框文本变化（平台层每次文本变化调用；slash 候选由此驱动）。
pub fn note_input_text(text: &str) {
    chat_ui().note_input_text(text);
}

/// slash 候选上移/下移（键盘方向键；delta = ±1）。
pub fn slash_move(delta: i32) {
    chat_ui().slash_move(delta);
}

/// 收起 slash 候选（Escape）。
pub fn slash_dismiss() {
    chat_ui().slash_dismiss();
}

/// slash 候选当前是否可见（输入框键盘处理用）。
pub fn slash_visible() -> bool {
    chat_ui().slash_visible()
}

/// 选用当前 slash 候选：返回 `/<name>`（平台层填回输入框；不执行命令）。
pub fn slash_autofill() -> Option<String> {
    chat_ui().slash_autofill()
}

/// 最早到期的面板本地期限（单调毫秒；平台层据此布一次定时器）。
pub fn next_deadline_ms() -> Option<u64> {
    chat_ui().next_deadline_ms()
}

/// 到点收纳过期的计划确认/权限面板（平台定时器回调）。
pub fn tick_deadlines() {
    chat_ui().tick_deadlines();
}
