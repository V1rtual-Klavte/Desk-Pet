//! 聊天 UI 的进程级单例（W8a）。
//!
//! 职责划分：
//! - **模型**（[`ChatModel`]）保存当前投影的显示态；事件/投影/揭示进度都先改模型；
//! - **刷新调度**：任何数据变化只把「有活要干」标记一次并投递主线程任务；
//!   渲染任务运行期间到达的新数据会再次调度一次，渲染时总是取**最新**状态 ——
//!   流式增量的渲染次数由在途任务合并（不丢内容、不逐 delta 重排）；
//! - **平台**：窗口/控件全部在 `ui::platform::chat_imp`（AppKit / Win32），
//!   本文件只经主线程队列调用它；平台回调（按钮、输入、窗口关闭）经
//!   `mod.rs` 的公开函数回到这里；
//! - **意图**：用户动作只构造 [`ChatIntent`] 交给注入的 [`ChatIntentPort`]，
//!   未注入时如实报错（绝不静默吞掉用户消息）。
//!
//! Node → UI 的入口（`apply_event` / `apply_projection` / `apply_reveal`）是
//! **接线待 W3c/W4** 的落点：IPC 分派层拿到冻结事件与读模型投影后调用这三个口。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::error::{AppError, AppResult};
use crate::images::preview::{PreviewManager, PreviewOwner};
use crate::images::{limits, validate::ValidatedImagePath};
use crate::ui::MainThreadQueue;
use crate::{rust_debug, rust_info, rust_warn};

use super::events::ChatEvent;
use super::intents::{
    ChatIntent, ChatIntentPort, NullChatIntentPort, PermissionConfirmation, PlanConfirmMode,
    PlanConfirmResult, PlanStepDecision,
};
use super::model::{ChatModel, ChatRenderUpdate, ChatSnapshot, Revisions, StatusSnapshot};
use super::panels::{PanelAction, PanelOutcome, UnknownStepResolution};
use super::placeholders::{placeholder_for, ImagePlaceholder};
use super::projection::TranscriptProjection;
use super::viewer::{self, ViewerRequest, ViewerState};

/// 面板动作派发成功后的本地过渡（失败不做任何乐观变更）。
enum PanelTransition {
    None,
    /// 确认已送出：进入执行态并撤下确认阶段的本地期限。
    PlanExecuting,
    /// 取消/终止已送出：收起计划面板。
    PlanDismiss,
    /// 裁决已送出：收起逐步门。
    PlanClearGate,
    /// 权限答复已送出：收起该确认面板。
    PermissionResolved {
        request_id: String,
    },
}

/// 决策类面板动作成功后的中性瞬时回执（旧壳 `showDeliveryNote` 的迁移）。
///
/// 文案只陈述宿主已知的事实（划分与理由见 `panels.rs` 的常量注释）：有界请求在
/// 回执返回时领域写已完成、非阻塞提交唯一同步事实是「已交给 Node」；条目的精确
/// 归宿（撤回成功 vs 该条已被消费）需要回执结果面，当前不伪造更细的结论。
/// 显示的最终状态仍以随后的投影回推为准。
fn success_notice(action: &PanelAction) -> Option<&'static str> {
    use super::panels as notices;
    Some(match action {
        PanelAction::WithdrawQueued { .. } => notices::NOTICE_WITHDRAW_QUEUED,
        PanelAction::ResumePaused => notices::NOTICE_RESUME_PAUSED,
        PanelAction::DiscardPaused => notices::NOTICE_DISCARD_PAUSED,
        PanelAction::InterruptedContinue => notices::NOTICE_CONTINUE_INTERRUPTED,
        PanelAction::InterruptedDiscard => notices::NOTICE_DISCARD_INTERRUPTED,
        PanelAction::PlanAbortExecution => notices::NOTICE_ABORT_PLAN,
        PanelAction::PlanResume { .. } => notices::NOTICE_RESUME_PLAN,
        PanelAction::PlanDiscard { .. } => notices::NOTICE_DISCARD_PLAN,
        PanelAction::PlanStepAlreadyApplied { .. } => notices::NOTICE_STEP_ALREADY_APPLIED,
        PanelAction::PlanStepRetry { .. } => notices::NOTICE_STEP_RETRY,
        PanelAction::RememberMessage { .. } => notices::NOTICE_REMEMBER_MESSAGE,
        _ => return None,
    })
}

/// 墙钟毫秒（epoch；与 Node `Date.now()` 同口径，用于换算确认请求的有效期）。
fn wall_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

/// 进程级聊天 UI 单例。
pub struct ChatUi {
    model: Mutex<ChatModel>,
    previews: PreviewManager,
    intents: Mutex<Arc<dyn ChatIntentPort>>,
    queue: OnceLock<Arc<MainThreadQueue>>,
    refresh_pending: AtomicBool,
    /// 三个渲染版本号的上一次渲染值（主线程使用）。
    rendered: Mutex<Revisions>,
    /// 独立聊天窗（能力保留）是否打开。
    window_open: AtomicBool,
    /// 主窗内的聊天面板是否已挂载（W9a 的产品形态；与独立窗任一存在即可渲染）。
    main_pane_open: AtomicBool,
    /// 查看器代际（打开/关闭递增；`Arc` 与动画 worker 共享）。
    viewer_generation: Arc<AtomicU64>,
    viewer: Mutex<ViewerState>,
    /// Native viewport → image refs, grouped by chat surface so the shared manager sees the union.
    inline_visible: Mutex<std::collections::HashMap<String, Vec<InlineVisibleImage>>>,
}

/// One message image intersecting a native chat viewport.
#[derive(Debug, Clone)]
pub struct InlineVisibleImage {
    pub owner: PreviewOwner,
    pub path: String,
}

static CHAT_UI: OnceLock<ChatUi> = OnceLock::new();

/// 进程级单例。
pub fn chat_ui() -> &'static ChatUi {
    CHAT_UI.get_or_init(ChatUi::new)
}

impl ChatUi {
    fn new() -> Self {
        Self {
            model: Mutex::new(ChatModel::new()),
            previews: PreviewManager::new(),
            intents: Mutex::new(Arc::new(NullChatIntentPort)),
            queue: OnceLock::new(),
            refresh_pending: AtomicBool::new(false),
            rendered: Mutex::new(Revisions::default()),
            window_open: AtomicBool::new(false),
            main_pane_open: AtomicBool::new(false),
            viewer_generation: Arc::new(AtomicU64::new(0)),
            viewer: Mutex::new(ViewerState::default()),
            inline_visible: Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 预览管理器（单例经 `&'static self` 取，可直接交给动画工作线程）。
    pub fn previews(&self) -> &PreviewManager {
        &self.previews
    }

    // ==========================================
    // 装配 / 主线程队列
    // ==========================================

    /// 安装主线程队列（平台在 UI 启动时调用一次）。
    ///
    /// 未安装前（UI 未启动）不能投递渲染任务：状态仍会更新，窗口打开时
    /// 由平台全量渲染，不丢数据。
    pub fn install_main_queue(&self, queue: Arc<MainThreadQueue>) {
        if self.queue.set(queue).is_err() {
            rust_warn!("聊天 UI 主线程队列重复安装（忽略后一次）");
        }
    }

    fn run_on_ui(&self, job: impl FnOnce() + Send + 'static) {
        match self.queue.get() {
            Some(queue) => queue.push(Box::new(job)),
            None => {
                // UI 未启动或未安装队列：不静默丢弃，留痕（模型数据仍在，
                // 窗口打开时会全量渲染）。
                rust_warn!("聊天 UI 尚未安装主线程队列，本次渲染调度被跳过");
            }
        }
    }

    fn refresh_visible_views(&self) {
        let snapshot = self.snapshot();
        self.run_on_ui(move || {
            crate::ui::platform::chat_imp::chat_apply(ChatRenderUpdate::Full(snapshot));
        });
    }

    /// 标记「有变化」并调度一次渲染（在途任务即合并）。
    fn schedule_refresh(&self) {
        if self.refresh_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        self.run_on_ui(|| chat_ui().drain_refresh());
    }

    /// 主线程渲染任务：先清标志再取最新状态，因此渲染期间新增的数据
    /// 会再调度一次（不丢更新）；窗口未打开时不做平台调用。
    ///
    /// 面板（计划/权限/队列/用量/slash/会话历史）与会话标签（A1）变化走 `Full`：
    /// 都是低频的用户尺度事件，平台层从同一快照重建面板/标签条与正文，
    /// 不额外发明第二套增量协议。
    fn drain_refresh(&self) {
        self.refresh_pending.store(false, Ordering::SeqCst);
        let update = {
            let model = Self::lock(&self.model);
            let revisions = model.revisions();
            let mut rendered = Self::lock(&self.rendered);
            if revisions.transcript != rendered.transcript
                || revisions.panels != rendered.panels
                || revisions.tabs != rendered.tabs
                || revisions.pending != rendered.pending
            {
                rendered.transcript = revisions.transcript;
                rendered.stream = revisions.stream;
                rendered.status = revisions.status;
                rendered.panels = revisions.panels;
                rendered.tabs = revisions.tabs;
                rendered.pending = revisions.pending;
                Some(ChatRenderUpdate::Full(model.snapshot()))
            } else if revisions.stream != rendered.stream {
                rendered.stream = revisions.stream;
                rendered.status = revisions.status;
                Some(ChatRenderUpdate::StreamOnly {
                    text: model.streaming_text(),
                })
            } else if revisions.status != rendered.status {
                rendered.status = revisions.status;
                Some(ChatRenderUpdate::StatusOnly(model.status_snapshot()))
            } else {
                None
            }
        };
        let Some(update) = update else { return };
        if self.window_open.load(Ordering::SeqCst) || self.main_pane_open.load(Ordering::SeqCst) {
            crate::ui::platform::chat_imp::chat_apply(update);
        }
    }

    // ==========================================
    // 窗口
    // ==========================================

    /// 打开（或前移）聊天窗。窗口不存在即创建并在创建时全量渲染；失败在平台层留痕。
    pub fn open_window(&self) {
        self.run_on_ui(|| {
            crate::ui::platform::chat_imp::open_chat_window();
            chat_ui().window_open.store(true, Ordering::SeqCst);
        });
    }

    /// 关闭聊天窗（窗口资源由平台释放）。
    pub fn close_window(&self) {
        self.run_on_ui(|| {
            crate::ui::platform::chat_imp::close_chat_window();
        });
    }

    /// 平台窗口关闭回调（windowWillClose / WM_DESTROY）。
    pub fn note_window_closed(&self) {
        self.window_open.store(false, Ordering::SeqCst);
        self.sync_inline_visible("chat", Vec::new());
        // 主窗内的聊天面板仍在时（产品形态），不释放查看器资源 —— 收起的是一个窗口，
        // 不是聊天面本身。
        if self.main_pane_open.load(Ordering::SeqCst) {
            rust_debug!("独立聊天窗已关；主窗聊天面板仍在，查看器资源不随之释放");
            return;
        }
        // 聊天视图关闭 = 查看器资源与窗口一并收口（§5.3 的释放点之一）。
        self.close_viewer(true);
    }

    /// 主窗聊天面板挂载/卸载（W9a：聊天区的产品形态在主窗内）。
    ///
    /// 挂载后渲染更新直接进主窗面板；卸载（主窗销毁）时若独立窗也不在，
    /// 则按「聊天视图关闭」处理资源。
    pub fn set_main_pane_open(&self, open: bool) {
        self.main_pane_open.store(open, Ordering::SeqCst);
        if !open {
            self.sync_inline_visible("main-chat", Vec::new());
        }
        if !open && !self.window_open.load(Ordering::SeqCst) {
            self.close_viewer(true);
        }
    }

    /// 同步每个 Native 聊天面的可见图片集合；滚出视口的像素由共享 manager 立即释放。
    pub fn sync_inline_visible(&self, surface: &str, images: Vec<InlineVisibleImage>) {
        let by_surface = {
            let mut visible = Self::lock(&self.inline_visible);
            if images.is_empty() {
                visible.remove(surface);
            } else {
                visible.insert(surface.to_string(), images);
            }
            visible
                .values()
                .flat_map(|images| images.iter().cloned())
                .collect::<Vec<_>>()
        };
        let manager = crate::ui::ports::inline_preview();
        let owners = by_surface
            .iter()
            .map(|image| image.owner.clone())
            .collect::<Vec<_>>();
        let tickets = manager.sync_visible(&owners);
        let paths = by_surface
            .into_iter()
            .map(|image| (image.owner, image.path))
            .collect::<std::collections::HashMap<_, _>>();
        let max_bytes = match limits::image_limits() {
            Ok(limits) => limits.max_bytes,
            Err(error) => {
                rust_warn!("聊天图片预览限制不可用：{error}");
                return;
            }
        };
        for ticket in tickets {
            let Some(path) = paths.get(ticket.owner()).cloned() else {
                rust_warn!("内联预览票据缺少源路径，忽略该图片");
                continue;
            };
            let spawn = std::thread::Builder::new()
                .name("deskpet-inline-preview".into())
                .spawn(move || {
                    match crate::ui::ports::inline_preview().load_path(
                        &ticket,
                        &path,
                        Some(max_bytes),
                    ) {
                        Ok(crate::images::inline::InlineOutcome::Ready(_)) => {
                            chat_ui().refresh_visible_views();
                        }
                        Ok(crate::images::inline::InlineOutcome::Discarded) => {}
                        Err(error) => {
                            rust_warn!("聊天内联预览失败：{error}");
                            chat_ui().refresh_visible_views();
                        }
                    }
                });
            if let Err(error) = spawn {
                rust_warn!("聊天内联预览线程启动失败：{error}");
            }
        }
    }

    /// 配置推送入口：切换关闭后清掉 Native 控件中的像素引用，再依新开关刷新可见占位。
    pub fn set_inline_preview_enabled(&self, enabled: bool) {
        crate::ui::ports::inline_preview().set_enabled(enabled);
        if !enabled {
            crate::ui::platform::chat_imp::clear_inline_previews();
        }
        self.refresh_visible_views();
    }

    pub fn is_window_open(&self) -> bool {
        self.window_open.load(Ordering::SeqCst)
    }

    // ==========================================
    // Node → UI 入口（接线待 W3c/W4）
    // ==========================================

    /// 冻结事件入口（流式正文、运行态、阶段提示、工具状态、计划与权限确认）。
    pub fn apply_event(&self, event: ChatEvent) {
        let now_mono = crate::ui::platform::now_ms();
        {
            let mut model = Self::lock(&self.model);
            match event {
                ChatEvent::AssistantStream { session_id, delta } => {
                    model.stream_delta(&session_id, &delta);
                }
                ChatEvent::AssistantStreamEnd { session_id } => {
                    model.stream_end(&session_id);
                }
                ChatEvent::RunState {
                    session_id,
                    running,
                } => {
                    model.set_run_state(&session_id, running);
                }
                ChatEvent::SendOutcome {
                    session_id,
                    request_id,
                    delivery,
                } => {
                    // 投递归宿回执（旧壳发送后 `showDeliveryNote(DELIVERY_NOTES[...])` 的同义迁移）：
                    // 与运行态/阶段提示同口径，只落当前会话；别的会话的回执不在本窗冒充刚发送的归宿。
                    if !model.set_send_outcome(&session_id, delivery, now_mono) {
                        rust_debug!("发送投递归宿事件不属于当前会话，已忽略: {request_id}");
                    }
                }
                ChatEvent::Reveal(progress) => {
                    // 分泡揭示进度（humanizer 调度器投影）；节奏由 Node 持有，这里只落进度。
                    model.apply_reveal(progress);
                }
                ChatEvent::StageHint { session_id, stage } => {
                    model.set_stage_hint(&session_id, stage);
                }
                ChatEvent::ToolExecuting { tool_id, tool_name } => {
                    model.tool_executing(&tool_id, &tool_name);
                }
                ChatEvent::ToolCompleted {
                    tool_id,
                    tool_name,
                    success,
                } => {
                    model.tool_completed(&tool_id, &tool_name, success);
                }
                ChatEvent::PlanStart {
                    session_id,
                    plan_id,
                    steps,
                    complexity,
                    force_step_by_step,
                } => {
                    model.plan_start(
                        session_id,
                        plan_id,
                        steps,
                        complexity,
                        force_step_by_step,
                        now_mono,
                    );
                }
                ChatEvent::PlanProgress {
                    session_id,
                    plan_id,
                    step_id,
                    total,
                    desc,
                    status,
                } => {
                    // `desc` 是生产端补充说明（冻结载荷的一部分）；面板按步骤表渲染，
                    // 进度事件只用它做定位（找不到步骤时留痕、不改面板）。
                    if !model.plan_progress(&session_id, &plan_id, &step_id, total, status) {
                        rust_debug!(
                            "计划进度事件找不到对应步骤或计划: {plan_id}/{step_id}（desc={desc}）"
                        );
                    }
                }
                ChatEvent::PlanStepGate {
                    session_id,
                    plan_id,
                    kind,
                    step,
                    index,
                    total,
                    error,
                } => {
                    if !model.plan_step_gate(&session_id, &plan_id, kind, step, index, total, error)
                    {
                        rust_debug!("计划步骤门事件没有对应计划: {plan_id}");
                    }
                }
                ChatEvent::PlanEnd { session_id, .. } => {
                    model.plan_end(&session_id);
                }
                ChatEvent::PermissionConfirm(request) => {
                    // 有效期换算：`expiresAt` 是 Node 墙钟（epoch 毫秒），本地期限用单调时钟。
                    let remaining = request.expires_at.map(|expires| expires - wall_now_ms());
                    match remaining {
                        Some(ms) if ms <= 0 => {
                            // 已过期的确认请求（晚到/时钟偏差）：Node 侧 TTL 已按拒绝结算，
                            // 这条事件不再呈现面板（丢弃并留痕，不静默吞成成功）。
                            rust_debug!(
                                "权限确认请求已过期（expiresAt={:?}），按晚到事件丢弃",
                                request.expires_at
                            );
                        }
                        other => {
                            let deadline = other.map(|ms| now_mono + ms.max(0) as u64);
                            model.permission_request(request, deadline);
                        }
                    }
                }
            }
        }
        self.schedule_refresh();
    }

    /// 已提交读模型投影入口（整帧覆盖）。切换会话时按 §5.3 释放查看器。
    ///
    /// **生产端纪律（A2 接线警告）**：本帧是整帧读模型 —— `messages` 整帧覆盖
    /// （帧内缺省 = 空列表 = 清空正文）、会话/视图态面板缺省即清空。线上生产者只有
    /// `pushSessionProjection` 一条（会话 / 历史 / 正文同 builder）；其余面板字段
    /// 将来必须并入**同一帧（同一 builder）**，否则轮流发帧会互相清空；划分与理由
    /// 见 `projection.rs::TranscriptProjection` 文档。
    pub fn apply_projection(&self, projection: TranscriptProjection) {
        let switched = {
            let model = Self::lock(&self.model);
            model.active_session() != Some(projection.session_id.as_str())
        };
        Self::lock(&self.model).apply_projection(projection);
        if switched {
            // 切会话：取消解码/动画并释放当前图片（查看器窗口一并关闭）。
            self.close_viewer(true);
        }
        self.schedule_refresh();
    }

    /// 分泡揭示进度入口（humanizer 调度器的状态投影；节奏不在这里重算）。
    pub fn apply_reveal(&self, progress: super::model::RevealProgress) {
        Self::lock(&self.model).apply_reveal(progress);
        self.schedule_refresh();
    }

    /// Node → 宿主事件的路由入口（事件名 + JSON 载荷）—— `ipc/bridge.rs` 的事件
    /// 广播订阅（`HostBridge::subscribe_events` 的进程内消费者）的落点。
    ///
    /// 按事件名经 [`ChatEvent::from_wire`] 解析后交给 [`Self::apply_event`]：
    /// - `Ok(true)`：事件属于聊天窗消费子集（已应用进模型）；
    /// - `Ok(false)`：名字不在子集内 —— 当前 Node → 宿主方向没有其它消费者，不在此
    ///   建空路由（调用方留痕即可，不是错误）；
    /// - `Err`：载荷解析失败如实报错，由调用方留痕，不静默丢帧。
    pub fn route_wire_event(&self, name: &str, payload: &serde_json::Value) -> AppResult<bool> {
        match ChatEvent::from_wire(name, &payload.to_string())? {
            Some(event) => {
                self.apply_event(event);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// 中性系统通知（发送失败回执、图片失效说明、操作回执等）。
    ///
    /// 通知带自动收起期限（[`super::panels::NOTICE_TTL_MS`]）：写模型时取当前
    /// 单调时钟作为期限起点，到点由 `expire_deadlines` 清除（旧壳 4 秒隐藏同义）。
    pub fn set_notice(&self, notice: Option<String>) {
        let now = crate::ui::platform::now_ms();
        Self::lock(&self.model).set_notice(notice, now);
        self.schedule_refresh();
    }

    /// 通用提示对话框（`ui::chat::dialog` 的转投点；平台层用模态对话框呈现）。
    ///
    /// 主线程调用即时弹出（模态到用户关闭，调用点因此能读到用户已看见的事实）；
    /// 工作线程经主线程队列转投。UI 未启动（队列未安装）时留痕跳过，
    /// 不伪造「已弹出」。
    pub(crate) fn show_dialog(&self, spec: super::dialog::DialogSpec) {
        self.run_on_ui(move || crate::ui::platform::chat_imp::show_dialog(spec));
    }

    // ==========================================
    // 面板动作（W8b；平台层的按钮回调入口）
    // ==========================================

    /// 执行一个面板按钮动作。
    ///
    /// 分流：
    /// - **本地动作**（用量展开、投递意图循环、slash 选用）只改显示态；
    /// - **回执动作**（计划确认 / 逐步门 / 权限答复）构造 `ChatIntent` 经端口派发 ——
    ///   `ChatIntentPort` 的接线实现按 `ChatIntent::receipt_event()` 把回执投给 Node；
    /// - **领域动作**（撤回/恢复/中断/终止）同样经端口交给 Node 领域 API。
    ///
    /// 派发失败**不做乐观状态变更**并如实报错（平台层给中性通知）；
    /// 派发成功后才做本地过渡（进执行态/收起门/收起面板），避免「按钮说没了、
    /// 答复其实没送到」的半截状态。
    pub fn apply_panel_action(&self, action: PanelAction) -> AppResult<PanelOutcome> {
        match &action {
            PanelAction::ToggleUsage => {
                if Self::lock(&self.model).toggle_usage() {
                    self.schedule_refresh();
                }
                return Ok(PanelOutcome::None);
            }
            PanelAction::ToggleDebugTools => {
                if Self::lock(&self.model).toggle_debug_tools() {
                    self.schedule_refresh();
                }
                return Ok(PanelOutcome::None);
            }
            PanelAction::ToggleDebugRegistry => {
                if Self::lock(&self.model).toggle_debug_registry() {
                    self.schedule_refresh();
                }
                return Ok(PanelOutcome::None);
            }
            PanelAction::SetDelivery { mode } => {
                Self::lock(&self.model).set_delivery(*mode);
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            PanelAction::SlashPick { index } => {
                let fill = Self::lock(&self.model).slash_pick(*index);
                if fill.is_some() {
                    self.schedule_refresh();
                }
                return Ok(match fill {
                    Some(fill) => PanelOutcome::FillInput(fill),
                    None => PanelOutcome::None,
                });
            }
            // ── meta 轨 / 浮层（纯显示态，不走 Node）──
            //
            // 浮层开合只改模型 + 排一次刷新：内容面板本来就随投影常驻在
            // `panel_views()` 里，平台层按 `surface()` 把它们放进浮层容器，
            // 所以这里**不需要**额外的数据请求（与会话历史的「打开即重读」不同）。
            PanelAction::ToggleInspector => {
                Self::lock(&self.model).toggle_inspector();
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            PanelAction::CloseInspector => {
                Self::lock(&self.model).close_inspector();
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            // ── A1：会话历史（本地开关 + 一次刷新请求）──
            PanelAction::ToggleSessionHistory => {
                let opened = Self::lock(&self.model).toggle_history();
                if opened {
                    // 打开即重读仓库：展开后追加一次刷新请求。
                    // 派发失败如实返回（平台给中性通知）；「读取中」只在请求确实送出后登记。
                    self.dispatch(ChatIntent::RequestSessionHistory)?;
                    Self::lock(&self.model).set_history_refreshing(true);
                }
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            PanelAction::CloseSessionHistory => {
                Self::lock(&self.model).close_history();
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            PanelAction::RefreshSessionHistory => {
                self.dispatch(ChatIntent::RequestSessionHistory)?;
                Self::lock(&self.model).set_history_refreshing(true);
                self.schedule_refresh();
                return Ok(PanelOutcome::None);
            }
            _ => {}
        }

        let (intent, transition) = self.build_panel_intent(&action)?;
        self.dispatch(intent)?;
        let changed = {
            let mut model = Self::lock(&self.model);
            match transition {
                PanelTransition::PlanExecuting => model.plan_begin_executing(),
                PanelTransition::PlanDismiss => model.plan_dismiss(),
                PanelTransition::PlanClearGate => model.plan_clear_gate(),
                PanelTransition::PermissionResolved { request_id } => {
                    model.permission_decided(&request_id)
                }
                PanelTransition::None => false,
            }
        };
        if changed {
            self.schedule_refresh();
        }
        // 决策类动作成功后的中性瞬时回执（旧壳 showDeliveryNote 的迁移）。
        Ok(match success_notice(&action) {
            Some(text) => PanelOutcome::Notice(text.to_string()),
            None => PanelOutcome::None,
        })
    }

    /// 面板动作 → 意图与本地过渡（派发成功后才应用过渡）。
    fn build_panel_intent(&self, action: &PanelAction) -> AppResult<(ChatIntent, PanelTransition)> {
        let missing_session = || AppError::Other("当前没有活跃会话，无法执行该操作".into());
        let active_session = || self.active_session().ok_or_else(missing_session);
        Ok(match action {
            // 浮层开合是纯显示动作，在 `apply_panel_action` 里已提前返回，正常走不到这里。
            // 给明确的错误而不是 `unreachable!()`：分发路径若被重构漏掉，用户看到的是一条
            // 中性错误，而不是宿主 panic。
            PanelAction::ToggleInspector | PanelAction::CloseInspector => {
                return Err(AppError::Other(
                    "浮层开合是纯显示动作，不经 Node 派发".into(),
                ));
            }
            PanelAction::PlanConfirmAll | PanelAction::PlanConfirmStepByStep => {
                let (plan_id, _) = Self::lock(&self.model)
                    .plan_identity()
                    .map(|(plan_id, session)| (plan_id.to_string(), session.to_string()))
                    .ok_or_else(|| AppError::Other("当前没有待确认的计划".into()))?;
                let mode = if matches!(action, PanelAction::PlanConfirmAll) {
                    PlanConfirmMode::Auto
                } else {
                    PlanConfirmMode::StepByStep
                };
                (
                    ChatIntent::PlanConfirmResolved {
                        plan_id,
                        result: PlanConfirmResult::confirmed(mode),
                    },
                    PanelTransition::PlanExecuting,
                )
            }
            PanelAction::PlanCancel => {
                let (plan_id, _) = Self::lock(&self.model)
                    .plan_identity()
                    .map(|(plan_id, session)| (plan_id.to_string(), session.to_string()))
                    .ok_or_else(|| AppError::Other("当前没有待确认的计划".into()))?;
                (
                    ChatIntent::PlanConfirmResolved {
                        plan_id,
                        result: PlanConfirmResult::cancelled(
                            super::intents::PlanConfirmCancelReason::User,
                        ),
                    },
                    PanelTransition::PlanDismiss,
                )
            }
            PanelAction::PlanGateContinue | PanelAction::PlanGateAbort => {
                let (plan_id, _) = Self::lock(&self.model)
                    .plan_identity()
                    .map(|(plan_id, session)| (plan_id.to_string(), session.to_string()))
                    .ok_or_else(|| AppError::Other("当前没有待裁决的步骤门".into()))?;
                let decision = if matches!(action, PanelAction::PlanGateContinue) {
                    PlanStepDecision::Continue
                } else {
                    PlanStepDecision::Abort
                };
                (
                    ChatIntent::PlanStepDecision { plan_id, decision },
                    PanelTransition::PlanClearGate,
                )
            }
            PanelAction::PlanAbortExecution => {
                let (plan_id, session_id) = Self::lock(&self.model)
                    .plan_identity()
                    .map(|(plan_id, session)| (plan_id.to_string(), session.to_string()))
                    .ok_or_else(|| AppError::Other("当前没有执行中的计划".into()))?;
                (
                    ChatIntent::AbortRunningPlan {
                        session_id,
                        plan_id,
                    },
                    PanelTransition::PlanDismiss,
                )
            }
            PanelAction::PlanResume { plan_id } => (
                ChatIntent::ResumePlan {
                    session_id: active_session()?,
                    plan_id: plan_id.clone(),
                },
                PanelTransition::None,
            ),
            PanelAction::PlanDiscard { plan_id } => (
                ChatIntent::DiscardPlan {
                    session_id: active_session()?,
                    plan_id: plan_id.clone(),
                },
                PanelTransition::None,
            ),
            PanelAction::PlanStepAlreadyApplied { plan_id, step_id } => (
                ChatIntent::ResolveUnknownSideEffect {
                    plan_id: plan_id.clone(),
                    step_id: step_id.clone(),
                    resolution: UnknownStepResolution::AlreadyApplied,
                },
                PanelTransition::None,
            ),
            PanelAction::PlanStepRetry { plan_id, step_id } => (
                ChatIntent::ResolveUnknownSideEffect {
                    plan_id: plan_id.clone(),
                    step_id: step_id.clone(),
                    resolution: UnknownStepResolution::Retry,
                },
                PanelTransition::None,
            ),
            PanelAction::PermissionAllowOnce
            | PanelAction::PermissionAllowSession
            | PanelAction::PermissionDeny => {
                let request_id = Self::lock(&self.model)
                    .permission()
                    .map(|permission| permission.request_id.clone())
                    .ok_or_else(|| AppError::Other("当前没有待确认的权限请求".into()))?;
                let decision = match action {
                    PanelAction::PermissionAllowOnce => PermissionConfirmation::AllowOnce,
                    PanelAction::PermissionAllowSession => PermissionConfirmation::AllowSession,
                    _ => PermissionConfirmation::Deny,
                };
                (
                    ChatIntent::PermissionDecision {
                        request_id: request_id.clone(),
                        decision,
                    },
                    PanelTransition::PermissionResolved { request_id },
                )
            }
            PanelAction::WithdrawQueued { entry_id } => (
                ChatIntent::WithdrawQueued {
                    session_id: active_session()?,
                    entry_id: entry_id.clone(),
                },
                PanelTransition::None,
            ),
            PanelAction::ResumePaused => (
                ChatIntent::ResumePausedInputs {
                    session_id: active_session()?,
                },
                PanelTransition::None,
            ),
            PanelAction::DiscardPaused => (
                ChatIntent::DiscardPausedInputs {
                    session_id: active_session()?,
                },
                PanelTransition::None,
            ),
            PanelAction::InterruptedContinue => (
                ChatIntent::ContinueInterruptedRun {
                    session_id: active_session()?,
                },
                PanelTransition::None,
            ),
            PanelAction::InterruptedDiscard => (
                ChatIntent::DiscardInterruptedRun {
                    session_id: active_session()?,
                },
                PanelTransition::None,
            ),
            // ── A1：会话历史（领域动作走 Node；列表更新随投影回推，不做本地增删）──
            PanelAction::RestoreSessionFromHistory { session_id } => (
                ChatIntent::RestoreSession {
                    session_id: session_id.clone(),
                },
                PanelTransition::None,
            ),
            PanelAction::DeleteSessionFromHistory { session_id } => (
                ChatIntent::DeleteSession {
                    session_id: session_id.clone(),
                },
                PanelTransition::None,
            ),
            // 「记住这条」（入口 = 消息右键菜单）：`event_id` 是被右键消息的 ingress
            // 事件身份（平台层经 `MessageSnapshot::remember_event_id` 判据挂项，不在
            // 平台层复刻角色判定）。没有活跃会话时如实报错，不伪造成功。
            PanelAction::RememberMessage { event_id } => (
                ChatIntent::RememberMessage {
                    session_id: active_session()?,
                    event_id: event_id.clone(),
                },
                PanelTransition::None,
            ),
            // ── 调试条：会话级覆盖（有界请求；Node 侧更新后重推投影，显示随帧收敛）──
            PanelAction::SetThinkingEffort { effort } => (
                ChatIntent::SetThinkingEffort {
                    effort: effort.clone(),
                },
                PanelTransition::None,
            ),
            PanelAction::SetSafetyMode { mode } => (
                ChatIntent::SetSafetyMode { mode: mode.clone() },
                PanelTransition::None,
            ),
            // 「压缩」：复用输入框发送 `/compact` 的同一条 slash 入口（不新开命令）。
            // 没有活跃会话时如实报错（平台给中性通知）；压缩可用性（运行中/排队中）
            // 由 Node 命令层按 busyPolicy 回复系统消息，宿主不预判、不假成功。
            PanelAction::CompactSession => (
                ChatIntent::SlashCommand {
                    session_id: Some(active_session()?),
                    command: "/compact".into(),
                },
                PanelTransition::None,
            ),
            // 本地动作在 `apply_panel_action` 顶部已分流。
            PanelAction::ToggleUsage
            | PanelAction::SetDelivery { .. }
            | PanelAction::SlashPick { .. }
            | PanelAction::ToggleSessionHistory
            | PanelAction::CloseSessionHistory
            | PanelAction::RefreshSessionHistory
            | PanelAction::ToggleDebugTools
            | PanelAction::ToggleDebugRegistry => {
                return Err(AppError::Other("本地面板动作被错误地送进意图构造".into()));
            }
        })
    }

    // ==========================================
    // Slash 候选（输入以 `/` 开头）
    // ==========================================

    /// 输入框文本变化（平台层每次变化调用；程序化填入的文本只收起候选）。
    pub fn note_input_text(&self, text: &str) {
        if Self::lock(&self.model).note_input_text(text) {
            self.schedule_refresh();
        }
    }

    /// 候选上下移动（键盘方向键）。
    pub fn slash_move(&self, delta: i32) {
        if Self::lock(&self.model).slash_move(delta) {
            self.schedule_refresh();
        }
    }

    /// 收起候选（Escape）。
    pub fn slash_dismiss(&self) {
        if Self::lock(&self.model).slash_dismiss() {
            self.schedule_refresh();
        }
    }

    /// 候选当前是否可见（输入框键盘处理用）。
    pub fn slash_visible(&self) -> bool {
        Self::lock(&self.model).slash_visible()
    }

    /// 选用当前候选：返回 `/<name>` 供平台层填回输入框（不执行）。
    pub fn slash_autofill(&self) -> Option<String> {
        let fill = Self::lock(&self.model).slash_autofill();
        if fill.is_some() {
            self.schedule_refresh();
        }
        fill
    }

    // ==========================================
    // 本地等待期限（面板不永久卡住的兜底）
    // ==========================================

    /// 最早到期的本地期限（单调毫秒；平台层据此布一次定时器；None = 无需定时器）。
    pub fn next_deadline_ms(&self) -> Option<u64> {
        Self::lock(&self.model).next_deadline_ms()
    }

    /// 到点收纳过期的计划确认/权限面板（平台定时器回调）。
    pub fn tick_deadlines(&self) {
        let now = crate::ui::platform::now_ms();
        if Self::lock(&self.model).expire_deadlines(now) {
            self.schedule_refresh();
        }
    }

    // ==========================================
    // UI → Node 意图（接线待 W3c/W4）
    // ==========================================

    /// 注入意图端口（bootstrap 在 Node 接线就绪后调用）。
    pub fn install_intent_port(&self, port: Arc<dyn ChatIntentPort>) {
        *Self::lock(&self.intents) = port;
        rust_info!("聊天意图端口已注入");
    }

    /// 派发用户意图；失败如实返回（调用方保留输入并给出中性通知）。
    pub fn dispatch(&self, intent: ChatIntent) -> AppResult<()> {
        let port = Self::lock(&self.intents).clone();
        port.dispatch(intent)
    }

    /// 当前活跃会话（平台层构造意图时用）。
    pub fn active_session(&self) -> Option<String> {
        Self::lock(&self.model).active_session().map(str::to_string)
    }

    /// 由「发送」动作派生意图：`/` 开头走 slash 命令（与今天 ingress 语义一致）。
    pub fn dispatch_send_text(&self, text: &str, image_paths: Vec<String>) -> AppResult<()> {
        let text = text.trim().to_string();
        if text.is_empty() && image_paths.is_empty() {
            return Ok(());
        }
        let session_id = self.active_session();
        if text.starts_with('/') && image_paths.is_empty() {
            self.dispatch(ChatIntent::SlashCommand {
                session_id,
                command: text,
            })
        } else {
            // 投递意图：面板未显式选择时为 None（由 Node 按配置默认处理；UI 不复制默认值）。
            let delivery = Self::lock(&self.model).delivery();
            self.dispatch(ChatIntent::Send {
                session_id,
                text,
                image_paths,
                delivery,
            })?;
            // 发送成功 = 待发送区释放（§5.3：发送/撤选/切会话后释放）。失败保留选择：
            // 待发送区不做乐观清空，平台层保留输入并给中性通知。
            if Self::lock(&self.model).clear_pending_images() {
                self.schedule_refresh();
            }
            Ok(())
        }
    }

    // ==========================================
    // 聊天发图：待发送区（选择/拖入后的临时选择态）
    // ==========================================

    /// 原生文件对话框（W4 的 [`crate::host::native_ports::NativeFileDialog`]）。
    ///
    /// `UiHandle` 取自已安装的主线程队列（聊天 UI 启动时由平台装入同一份队列）。
    /// macOS 的 NSOpenPanel 经它转投 UI 主线程；调用方应在工作线程执行阻塞等待。
    pub(super) fn file_dialog(&self) -> AppResult<crate::host::native_ports::NativeFileDialog> {
        let queue = self.queue.get().ok_or_else(|| {
            AppError::Other("原生 UI 尚未安装主线程队列，无法打开文件对话框".into())
        })?;
        Ok(crate::host::native_ports::NativeFileDialog::new(
            crate::ui::UiHandle::new(queue.clone()),
        ))
    }

    /// 待发送图片原路径（平台层「发送」时取出；发送成功后清空）。
    pub fn pending_image_paths(&self) -> Vec<String> {
        Self::lock(&self.model).pending_paths()
    }

    /// 待发送区是否有图片（空文本 + 有待发送图片时也允许发送）。
    pub fn has_pending_images(&self) -> bool {
        !Self::lock(&self.model).pending_images().is_empty()
    }

    /// 准入并追加待发送图片（原生选择器与拖入共用；可在工作线程调用）。
    ///
    /// 准入走统一图片域，不建第二份规则：
    /// - 数量上限与每图字节上限取自 [`limits`]（`images/limits.json` 是唯一数值源）；
    /// - 路径规则/常规文件/字节上限/格式头复核走 [`ValidatedImagePath`]；
    ///   格式集合与错误文案来自 `images::format`（如 `unsupported_error()`）。
    ///
    /// 任一路径被拒时整批不添加（与命令层 `validate_chat_images` 的整批语义一致），
    /// 错误文案直接复用统一图片域产出；调用方（平台层）以中性通知呈现。
    pub fn add_pending_images(&self, paths: Vec<String>) -> AppResult<usize> {
        if paths.is_empty() {
            return Ok(0); // 用户取消是正常结果
        }
        let limits = limits::image_limits()?;
        let mut admitted = Vec::with_capacity(paths.len());
        for path in &paths {
            let validated = ValidatedImagePath::validate(path, Some(limits.max_bytes))?;
            admitted.push(validated.as_path().to_string_lossy().into_owned());
        }
        let mut model = Self::lock(&self.model);
        let mut fresh: Vec<ImagePlaceholder> = Vec::new();
        for path in admitted {
            let duplicate = model
                .pending_images()
                .iter()
                .chain(fresh.iter())
                .any(|image| image.path == path);
            if duplicate {
                continue;
            }
            // 占位元数据只读文件元信息（不读字节、不解码；§5.3 的预览按需从简）。
            fresh.push(placeholder_for(&path));
        }
        if model.pending_images().len() + fresh.len() > limits.max_images {
            // 与命令层 `commands/chat_images.rs::validate_chat_images` 同一条用户文案
            // （数量值来自 limits.json 单一源）；发送时命令层还会再复核一次。
            return Err(AppError::Tool(format!(
                "每条消息最多 {} 张图片",
                limits.max_images
            )));
        }
        let added = model.add_pending_images(fresh);
        drop(model);
        if added > 0 {
            self.schedule_refresh();
        }
        Ok(added)
    }

    /// 撤选一张待发送图片（返回是否确实移除）。
    pub fn remove_pending_image(&self, path: &str) -> bool {
        let removed = Self::lock(&self.model).remove_pending_image(path);
        if removed {
            self.schedule_refresh();
        }
        removed
    }

    /// 停止当前运行（运行态由 `deskpet-run-state` 回推收起按钮）。
    pub fn dispatch_stop(&self) -> AppResult<()> {
        let session_id = self
            .active_session()
            .ok_or_else(|| AppError::Other("当前没有活跃会话，无法停止".into()))?;
        self.dispatch(ChatIntent::Stop { session_id })
    }

    // ==========================================
    // 查看器
    // ==========================================

    /// 点击图片占位：异步打开独立查看器（校验/解码在工作线程，UI 更新经主线程）。
    pub fn open_viewer(&self, message_id: &str, image_index: u32) -> AppResult<()> {
        let (session_id, path) = {
            let model = Self::lock(&self.model);
            let session_id = model
                .active_session()
                .map(str::to_string)
                .ok_or_else(viewer::missing_session_error)?;
            let message = model
                .message(message_id)
                .ok_or_else(|| AppError::Other("消息不在当前投影里，无法打开图片".into()))?;
            let path = message
                .image_paths
                .get(image_index as usize)
                .cloned()
                .ok_or_else(|| AppError::Other("该消息没有对应序号的图片".into()))?;
            (session_id, path)
        };
        let request = ViewerRequest {
            session_id,
            entry_id: message_id.to_string(),
            image_index,
            path,
        };
        // 打开新图 = 换代际 + 释放旧 owner（切图路径；旧 worker 凭代际退出）。
        let generation = viewer::next_generation(&self.viewer_generation);
        let _ = Self::lock(&self.viewer).close(&self.previews);
        let spawn = std::thread::Builder::new()
            .name("deskpet-viewer-open".into())
            .spawn(move || chat_ui().run_viewer_open(request, generation));
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("查看器打开线程创建失败: {error}"))),
        }
    }

    /// 打开工作线程：复核 + 解码首帧 → 主线程建窗/绘制 → 动画 worker。
    fn run_viewer_open(&self, request: ViewerRequest, generation: u64) {
        if self.viewer_generation.load(Ordering::SeqCst) != generation {
            return; // 打开期间已被切图/关闭
        }
        let handle = match viewer::open_preview_for(&self.previews, &request, generation) {
            Ok(handle) => handle,
            Err(error) => {
                let reason = error.to_string();
                self.run_on_ui(move || {
                    // 失效以中性系统通知呈现；不静默删路径、不降级格式。
                    chat_ui().set_notice(Some(format!("图片无法打开：{reason}")));
                });
                return;
            }
        };
        if self.viewer_generation.load(Ordering::SeqCst) != generation {
            // 晚到的打开结果：释放并退出（PreviewManager 侧再按 owner 兜底）。
            self.previews.close_preview(handle.owner());
            return;
        }
        Self::lock(&self.viewer).install(handle.owner().clone());
        // 只呈现首帧：逐帧动画不接入产品（2026-10-04 用户指令，理由是内存）。
        // 因此这里没有帧推进 worker —— 查看到的就是打开那一刻解出的那一帧。
        let first_frame = self.previews.current_frame();
        self.run_on_ui(move || {
            crate::ui::platform::chat_imp::open_viewer_window();
            if let Some(frame) = first_frame {
                crate::ui::platform::chat_imp::viewer_set_frame(frame);
            }
        });
    }

    /// 关闭查看器：`close_window=false` 只释放资源（切图），true 连窗口一起关。
    pub fn close_viewer(&self, close_window: bool) {
        viewer::next_generation(&self.viewer_generation);
        let had_owner = Self::lock(&self.viewer).close(&self.previews);
        if close_window {
            self.run_on_ui(|| {
                crate::ui::platform::chat_imp::close_viewer_window();
            });
        } else if had_owner {
            rust_warn!("查看器资源已释放（窗口保留，等待新图）");
        }
    }

    /// 查看器窗口被用户关闭（平台回调）：释放资源。
    pub fn note_viewer_window_closed(&self) {
        self.close_viewer(false);
    }

    /// 收起主窗（产品语义：桌宠收起）：取消解码/动画并释放 CPU 图（§5.3）。
    pub fn on_main_retracted(&self) {
        self.close_viewer(true);
    }

    /// 宿主退出收尾：释放全部预览资源。
    pub fn on_host_exit(&self) {
        viewer::next_generation(&self.viewer_generation);
        let _ = Self::lock(&self.viewer).close(&self.previews);
        let _ = self.previews.close_all();
        Self::lock(&self.inline_visible).clear();
        crate::ui::ports::inline_preview().release_all();
    }

    // ==========================================
    // 渲染取数（平台层调用）
    // ==========================================

    /// 整帧快照（窗口打开/平台核对时用）。
    pub fn snapshot(&self) -> ChatSnapshot {
        Self::lock(&self.model).snapshot()
    }

    /// 当前流式尾巴文本。
    pub fn streaming_text(&self) -> Option<String> {
        Self::lock(&self.model).streaming_text()
    }

    /// 当前底部状态快照。
    pub fn status_snapshot(&self) -> StatusSnapshot {
        Self::lock(&self.model).status_snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::chat::projection::{ProjectedMessage, ProjectedRole};

    fn projection(session: &str, text: &str) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            speaker_name: None,
            messages: vec![ProjectedMessage {
                id: "e1".into(),
                // 「记住这条」的入口判据是投影 eventId（`remember_event_id` 有专门用例）；
                // 本帧条目按无事件身份构造，不影响其余用例。
                event_id: None,
                role: ProjectedRole::User,
                text: text.into(),
                parts: vec![],
                image_paths: vec![],
                timestamp: 0,
                thinking: None,
                tool_calls: vec![],
                is_error: false,
                tool_call_id: None,
            }],
            prompts: Default::default(),
            ..Default::default()
        }
    }

    #[test]
    fn 未注入端口时派发如实报错() {
        let ui = ChatUi::new();
        let error = ui
            .dispatch(ChatIntent::Stop {
                session_id: "s".into(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("W3c/W4"));
    }

    #[test]
    fn 发送派发按斜杠前缀分流() {
        struct Recorder {
            seen: Mutex<Vec<ChatIntent>>,
        }
        impl Recorder {
            fn new() -> Self {
                Self {
                    seen: Mutex::new(Vec::new()),
                }
            }
        }
        impl ChatIntentPort for Recorder {
            fn dispatch(&self, intent: ChatIntent) -> AppResult<()> {
                self.seen.lock().unwrap().push(intent);
                Ok(())
            }
        }

        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));
        let recorder = Arc::new(Recorder::new());
        ui.install_intent_port(recorder.clone());

        ui.dispatch_send_text("普通消息", vec![]).unwrap();
        ui.dispatch_send_text("/skill list", vec![]).unwrap();
        ui.dispatch_send_text("   ", vec![]).unwrap();
        let seen = recorder.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "空白文本不派发");
        assert!(matches!(seen[0], ChatIntent::Send { .. }));
        assert!(matches!(seen[1], ChatIntent::SlashCommand { .. }));
        assert_eq!(ui.active_session().as_deref(), Some("s1"));
    }

    /// 「压缩」按钮复用输入框发送 `/compact` 的同一条入口：面板动作 → `SlashCommand`
    /// 意图（命令文本逐字 `/compact`），不新开命令/通道。没有活跃会话时如实报错
    /// （平台层据此给中性通知，不静默吞）。
    #[test]
    fn 压缩按钮复用slash入口派发compact命令() {
        let (ui, recorder) = instrumented_ui();
        let outcome = ui
            .apply_panel_action(PanelAction::CompactSession)
            .expect("有活跃会话时派发成功");
        assert_eq!(outcome, PanelOutcome::None, "宿主不伪造压缩完成回执");
        match recorder.last() {
            ChatIntent::SlashCommand {
                command,
                session_id,
            } => {
                assert_eq!(command, "/compact", "命令文本必须与斜杠入口逐字一致");
                assert_eq!(session_id.as_deref(), Some("s1"));
            }
            other => panic!("应为 SlashCommand，得到 {other:?}"),
        }

        // 没有活跃会话：不派发、如实报错（不假装已提交压缩）。
        let empty = ChatUi::new();
        let error = empty
            .apply_panel_action(PanelAction::CompactSession)
            .unwrap_err();
        assert!(
            error.to_string().contains("没有活跃会话"),
            "错误文案：{error}"
        );
    }

    /// 「记住这条」（入口 = 消息右键菜单）：动作携带的 eventId 必须逐字进意图、
    /// 会话取当前活跃会话，成功后走 notice 通道回中性回执；没有活跃会话时如实
    /// 报错（不伪造成功、不做乐观变更）。
    #[test]
    fn 记住这条经消息右键派发并回中性回执() {
        use crate::ui::chat::panels::NOTICE_REMEMBER_MESSAGE;

        let (ui, recorder) = instrumented_ui();
        // 回执映射与常量同源（改坏映射这条立即红）。
        assert_eq!(
            success_notice(&PanelAction::RememberMessage {
                event_id: "req-1:user".into(),
            }),
            Some(NOTICE_REMEMBER_MESSAGE)
        );

        let outcome = ui
            .apply_panel_action(PanelAction::RememberMessage {
                event_id: "req-1:user".into(),
            })
            .expect("有活跃会话时派发成功");
        assert_eq!(
            outcome,
            PanelOutcome::Notice(NOTICE_REMEMBER_MESSAGE.to_string()),
            "成功回执走 notice 通道（不是角色台词）"
        );
        match recorder.last() {
            ChatIntent::RememberMessage {
                session_id,
                event_id,
            } => {
                assert_eq!(session_id, "s1", "会话取当前活跃会话");
                assert_eq!(event_id, "req-1:user", "事件身份必须逐字传递");
            }
            other => panic!("应为 RememberMessage，得到 {other:?}"),
        }

        // 没有活跃会话：不派发、如实报错。
        let empty = ChatUi::new();
        let error = empty
            .apply_panel_action(PanelAction::RememberMessage {
                event_id: "req-1:user".into(),
            })
            .unwrap_err();
        assert!(
            error.to_string().contains("没有活跃会话"),
            "错误文案：{error}"
        );
    }

    #[test]
    fn 待发送图片准入走统一图片域且发送成功释放() {
        let dir = crate::images::fixtures::temp_dir("chat-ui-pending");
        let good = dir.join("ok.png");
        std::fs::write(&good, crate::images::fixtures::png_1x1()).unwrap();
        let bad = dir.join("notes.txt");
        std::fs::write(&bad, b"just text").unwrap();
        let good = good.to_string_lossy().into_owned();
        let bad = bad.to_string_lossy().into_owned();

        let (ui, recorder) = instrumented_ui();
        // 不支持的格式：整批拒绝，文案来自统一图片域（format::unsupported_error）。
        let error = ui.add_pending_images(vec![good.clone(), bad]).unwrap_err();
        assert!(
            error.to_string().contains("PNG/JPEG/GIF/WebP/BMP"),
            "文案：{error}"
        );
        assert!(!ui.has_pending_images(), "整批被拒时不留下半批");

        // 合法图片：进入待发送区；重复添加按路径去重。
        assert_eq!(ui.add_pending_images(vec![good.clone()]).unwrap(), 1);
        assert_eq!(ui.add_pending_images(vec![good.clone()]).unwrap(), 0);
        assert_eq!(ui.pending_image_paths().len(), 1);

        // 发送成功 = 释放（§5.3）；发送失败保留由 dispatch 的错误路径保证（这里验证成功路径）。
        let paths = ui.pending_image_paths();
        ui.dispatch_send_text("看图", paths).unwrap();
        match recorder.last() {
            ChatIntent::Send { image_paths, .. } => assert_eq!(image_paths.len(), 1),
            other => panic!("应为 Send，得到 {other:?}"),
        }
        assert!(!ui.has_pending_images(), "发送成功释放待发送区");

        // 数量上限：每消息最多 4 张（值来自 limits.json 单一源）。
        let mut five = Vec::new();
        for index in 0..5 {
            let path = dir.join(format!("img{index}.png"));
            std::fs::write(&path, crate::images::fixtures::png_1x1()).unwrap();
            five.push(path.to_string_lossy().into_owned());
        }
        let error = ui.add_pending_images(five).unwrap_err();
        assert!(error.to_string().contains("最多 4 张"), "文案：{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 关闭查看器递增代际并释放owner() {
        let ui = ChatUi::new();
        assert!(
            !ui.viewer.lock().unwrap().close(&ui.previews),
            "没有 owner 时关闭是 no-op"
        );
        let generation = viewer::next_generation(&ui.viewer_generation);
        assert_eq!(generation, 1);
        ui.close_viewer(false);
        assert_eq!(ui.viewer_generation.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn 投影切换会话不残留流式尾巴() {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "旧会话"));
        ui.apply_event(ChatEvent::AssistantStream {
            session_id: "s1".into(),
            delta: "半截".into(),
        });
        assert_eq!(ui.streaming_text().as_deref(), Some("半截"));
        ui.apply_projection(projection("s2", "新会话"));
        assert!(ui.streaming_text().is_none());
    }

    #[test]
    fn 事件驱动视图更新且别的会话被丢弃() {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));
        ui.apply_event(ChatEvent::RunState {
            session_id: "s1".into(),
            running: true,
        });
        assert!(ui.snapshot().status.running);
        ui.apply_event(ChatEvent::RunState {
            session_id: "s2".into(),
            running: true,
        });
        assert!(ui.snapshot().status.running, "别的会话的运行态不影响本窗");
    }

    #[test]
    fn 发送投递归宿只落当前会话且走notice通道() {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));
        ui.apply_event(ChatEvent::SendOutcome {
            session_id: "s1".into(),
            request_id: "r1".into(),
            delivery: crate::ui::chat::events::SendOutcomeDelivery::Steered,
        });
        assert_eq!(
            ui.snapshot().status.notice.as_deref(),
            Some("已排队插话：当前响应结束后处理"),
            "当前会话的投递回执经 notice 通道呈现（旧壳 DELIVERY_NOTES 同文）"
        );
        // 别的会话的回执不覆盖本窗回执（与运行态同口径）。
        ui.apply_event(ChatEvent::SendOutcome {
            session_id: "s2".into(),
            request_id: "r2".into(),
            delivery: crate::ui::chat::events::SendOutcomeDelivery::Deferred,
        });
        assert_eq!(
            ui.snapshot().status.notice.as_deref(),
            Some("已排队插话：当前响应结束后处理"),
            "别的会话的投递回执不影响本窗"
        );
    }

    // ==========================================
    // W8b：面板动作 → 回执 / 本地过渡
    // ==========================================

    struct IntentRecorder {
        seen: Mutex<Vec<ChatIntent>>,
    }

    impl IntentRecorder {
        fn new() -> Self {
            Self {
                seen: Mutex::new(Vec::new()),
            }
        }

        fn last(&self) -> ChatIntent {
            self.seen
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("有派发记录")
        }
    }

    impl ChatIntentPort for IntentRecorder {
        fn dispatch(&self, intent: ChatIntent) -> AppResult<()> {
            self.seen.lock().unwrap().push(intent);
            Ok(())
        }
    }

    fn instrumented_ui() -> (ChatUi, Arc<IntentRecorder>) {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));
        let recorder = Arc::new(IntentRecorder::new());
        ui.install_intent_port(recorder.clone());
        (ui, recorder)
    }

    #[test]
    fn 计划确认面板动作派发回执并进入执行态() {
        let (ui, recorder) = instrumented_ui();
        ui.apply_event(ChatEvent::PlanStart {
            session_id: "s1".into(),
            plan_id: "p1".into(),
            steps: vec![crate::ui::chat::events::PlanStepWire {
                id: 1,
                description: "第一步".into(),
                role: None,
                allowed_tools: None,
            }],
            complexity: 2,
            force_step_by_step: false,
        });
        assert!(ui.snapshot().plan.is_some());

        let outcome = ui
            .apply_panel_action(PanelAction::PlanConfirmStepByStep)
            .unwrap();
        assert_eq!(outcome, PanelOutcome::None);
        let receipt = recorder.last();
        let event = receipt.receipt_event().expect("确认是回执");
        assert_eq!(event.name, "deskpet-plan-confirm-resolved");
        assert_eq!(
            event.payload,
            serde_json::json!({"planId":"p1","result":{"confirmed":true,"mode":"stepByStep"}})
        );
        // 派发成功后进入执行态（面板保留显示进度）。
        assert!(ui.snapshot().plan.as_ref().unwrap().executing);
    }

    #[test]
    fn 计划取消派发用户取消回执并收起面板() {
        let (ui, recorder) = instrumented_ui();
        ui.apply_event(ChatEvent::PlanStart {
            session_id: "s1".into(),
            plan_id: "p1".into(),
            steps: vec![],
            complexity: 1,
            force_step_by_step: false,
        });
        ui.apply_panel_action(PanelAction::PlanCancel).unwrap();
        let event = recorder.last().receipt_event().unwrap();
        assert_eq!(
            event.payload,
            serde_json::json!({"planId":"p1","result":{"confirmed":false,"reason":"user"}})
        );
        assert!(ui.snapshot().plan.is_none(), "取消成功后收起面板");
    }

    #[test]
    fn 权限答复派发回执并在成功后收起面板() {
        let (ui, recorder) = instrumented_ui();
        ui.apply_event(ChatEvent::PermissionConfirm(
            crate::ui::chat::events::PermissionConfirmRequest {
                request_id: "r1".into(),
                message: "需要确认".into(),
                tool_name: "bash".into(),
                session_id: Some("s1".into()),
                run_generation: Some(2),
                parameter_summary: Some("command=ls".into()),
                effect_class: Some("external_side_effect".into()),
                input_hash: None,
                policy_hash: None,
                tool_call_id: None,
                // 远未到期（避免测试机器时钟偏差导致装配时就被判过期）。
                expires_at: Some(wall_now_ms() + 60_000),
            },
        ));
        assert!(ui.snapshot().permission.is_some());
        ui.apply_panel_action(PanelAction::PermissionAllowSession)
            .unwrap();
        let event = recorder.last().receipt_event().unwrap();
        assert_eq!(event.name, "deskpet-permission-confirm-resolved");
        assert_eq!(
            event.payload,
            serde_json::json!({"requestId":"r1","decision":"allow_session"})
        );
        assert!(ui.snapshot().permission.is_none());
    }

    #[test]
    fn 未注入端口时面板动作如实报错且不做乐观变更() {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));
        ui.apply_event(ChatEvent::PlanStart {
            session_id: "s1".into(),
            plan_id: "p1".into(),
            steps: vec![],
            complexity: 1,
            force_step_by_step: false,
        });
        let error = ui
            .apply_panel_action(PanelAction::PlanConfirmAll)
            .unwrap_err();
        assert!(error.to_string().contains("W3c/W4"), "文案：{error}");
        let plan = ui.snapshot().plan.expect("失败不收起面板");
        assert!(!plan.executing, "失败不进入执行态");
    }

    #[test]
    fn slash候选动作与本地填入() {
        let (ui, _recorder) = instrumented_ui();
        // 注入命令表（经投影）。
        let mut frame = projection("s1", "你好");
        frame.slash_commands = Some(vec![crate::ui::chat::projection::SlashCommandView {
            name: "help".into(),
            description: "查看帮助".into(),
        }]);
        ui.apply_projection(frame);
        ui.note_input_text("/he");
        assert!(ui.slash_visible());
        match ui
            .apply_panel_action(PanelAction::SlashPick { index: 0 })
            .unwrap()
        {
            PanelOutcome::FillInput(fill) => assert_eq!(fill, "/help"),
            other => panic!("应为填入动作，得到 {other:?}"),
        }
        assert!(!ui.slash_visible(), "填入后候选收起");
    }

    // ==========================================
    // A1：会话标签与历史
    // ==========================================

    #[test]
    fn 历史面板展开派发刷新且收起只改本地() {
        use crate::ui::chat::panels::PanelKind;
        let (ui, recorder) = instrumented_ui();
        assert!(
            !ui.snapshot()
                .panels
                .iter()
                .any(|view| { view.kind == PanelKind::SessionHistory }),
            "初始不显示历史面板"
        );

        ui.apply_panel_action(PanelAction::ToggleSessionHistory)
            .unwrap();
        assert_eq!(
            recorder.last().name(),
            "request-session-history",
            "展开即请求刷新"
        );
        assert!(
            ui.snapshot()
                .panels
                .iter()
                .any(|view| view.kind == PanelKind::SessionHistory),
            "面板已展开"
        );

        ui.apply_panel_action(PanelAction::CloseSessionHistory)
            .unwrap();
        assert!(
            !ui.snapshot()
                .panels
                .iter()
                .any(|view| view.kind == PanelKind::SessionHistory),
            "关闭后消失"
        );
        assert_eq!(recorder.seen.lock().unwrap().len(), 1, "关闭不再派发");

        ui.apply_panel_action(PanelAction::RefreshSessionHistory)
            .unwrap();
        assert_eq!(recorder.last().name(), "request-session-history");
    }

    #[test]
    fn 历史面板恢复与删除派发领域意图() {
        let (ui, recorder) = instrumented_ui();
        ui.apply_panel_action(PanelAction::RestoreSessionFromHistory {
            session_id: "s2".into(),
        })
        .unwrap();
        assert_eq!(recorder.last().name(), "restore-session");
        ui.apply_panel_action(PanelAction::DeleteSessionFromHistory {
            session_id: "s2".into(),
        })
        .unwrap();
        assert_eq!(recorder.last().name(), "delete-session");
    }

    #[test]
    fn 新建与关闭标签派发领域意图() {
        // 用本地实例驱动（模块级 dispatch_* 走进程级单例，测试不依赖全局端口接线）。
        let (ui, recorder) = instrumented_ui();
        ui.dispatch(ChatIntent::NewSession).unwrap();
        assert_eq!(recorder.last().name(), "new-session");
        ui.dispatch(ChatIntent::CloseSession {
            session_id: "s2".into(),
        })
        .unwrap();
        assert_eq!(recorder.last().name(), "close-session");
    }

    #[test]
    fn 会话标签随投影进入快照() {
        let (ui, _recorder) = instrumented_ui();
        let mut frame = projection("s1", "你好");
        frame.sessions = Some(vec![
            crate::ui::chat::projection::ProjectedSession {
                id: "s1".into(),
                name: "新会话".into(),
                created_at: 0,
                interrupted: false,
            },
            crate::ui::chat::projection::ProjectedSession {
                id: "s2".into(),
                name: "聊工作".into(),
                created_at: 0,
                interrupted: true,
            },
        ]);
        ui.apply_projection(frame);
        let tabs = ui.snapshot().sessions;
        assert_eq!(tabs.len(), 2);
        assert!(tabs[0].active);
        assert!(tabs[1].interrupted);
    }

    // ==========================================
    // 事件路由（IPC 广播消费）
    // ==========================================

    #[test]
    fn 事件路由按名分发且未知名与坏载荷如实返回() {
        let ui = ChatUi::new();
        ui.apply_projection(projection("s1", "你好"));

        // 命中消费子集：应用进模型（运行态）。
        assert!(ui
            .route_wire_event(
                "deskpet-run-state",
                &serde_json::json!({"sessionId":"s1","running":true})
            )
            .unwrap());
        assert!(ui.snapshot().status.running);

        // 名字不在子集内：如实回「未消费」而不是静默假装已应用。
        assert!(!ui
            .route_wire_event("deskpet-not-a-real-event", &serde_json::json!({}))
            .unwrap());

        // 载荷解析失败：如实报错（不静默丢帧）。
        let error = ui
            .route_wire_event("deskpet-run-state", &serde_json::json!({"sessionId":"s1"}))
            .unwrap_err();
        assert!(error.to_string().contains("解析失败"), "{error}");
    }
}
