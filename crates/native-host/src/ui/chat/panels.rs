//! 聊天面板的**平台无关渲染块**（W8b）：计划确认 / 权限确认 / 队列与中断 / 用量 /
//! slash 候选统一产出 [`PanelView`]，平台层（`platform/{macos,windows}_chat.rs`）
//! 只做「标签 / 按钮 / 行」三种积木的摆放，不各自解释业务状态。
//!
//! 语义边界：
//! - 模块只描述**当前显示什么**与**点了会派发什么**（[`PanelAction`]）；所有动作
//!   经 `ui.rs::apply_panel_action` 变成 `ChatIntent`（Node 领域承接）或本地纯显示
//!   切换（用量展开、slash 候选选中）。这里不做任何权限/计划判定。
//! - 文案分两类：控件标签与中性系统提示是源码常量（与「停止」按钮同款界面语言）；
//!   角色可见正文（计划步骤描述、权限说明、中断提示）一律来自 Node 投影/事件，
//!   缺失时不显示、不回落硬编码角色台词。

/// 面板行的文字样式（平台层映射到各自语义色）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelLineStyle {
    /// 正文（默认前景色）。
    Normal,
    /// 次要信息（灰色）。
    Dim,
    /// 失败/警告（红色/橙色）。
    Warn,
    /// 成功（绿色）。
    Ok,
}

/// 一个可以点击触发面板动作的按钮。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelButton {
    pub label: String,
    pub action: PanelAction,
    /// 文字链形态（无边框、仅文字）：旧壳 DebugBar 的「工具 N」「Σ 用量」
    /// 「工具注册」即此形态 —— 点击展开明细，而不是一排 chip 按钮。
    pub link: bool,
}

impl PanelButton {
    /// 普通按钮（chip 形态）。
    pub fn new(label: impl Into<String>, action: PanelAction) -> Self {
        Self {
            label: label.into(),
            action,
            link: false,
        }
    }

    /// 文字链按钮（无边框、仅文字；点击语义与按钮相同）。
    pub fn link(label: impl Into<String>, action: PanelAction) -> Self {
        Self {
            label: label.into(),
            action,
            link: true,
        }
    }
}

/// 一行「文本 + 行内按钮」（队列项、候选命令、待处置步骤）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelRow {
    pub text: String,
    pub style: PanelLineStyle,
    pub buttons: Vec<PanelButton>,
}

/// 下拉选择里的一个选项（显示标签 + 选中后派发的动作）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelOption {
    pub label: String,
    pub action: PanelAction,
}

/// 下拉选择（行首标签 + 弹出选项菜单；选中即派发该选项动作）。
///
/// 迁移自旧壳 `DebugBar.vue` 的 `<select>`：会话级「思考强度」「安全策略」用
/// 下拉而不是一排常驻按钮 ——「默认」是与档位并列的语义（清除会话级覆盖），
/// 但交互上是「点开才看到选项」，不是把所有档位铺在面板上。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelSelect {
    /// 行首标签（如「思考强度」）。旧壳靠 `title` 悬停提示，原生面板没有
    /// 悬停提示通道，标签常驻。
    pub label: String,
    pub options: Vec<PanelOption>,
    /// 当前选中下标（0-based；越界由平台层夹到 0）。
    pub selected: usize,
}

/// 面板里的一个显示块（按声明顺序自上而下摆放）。
///
/// **保序**是有意的：三段式（lines → rows → buttons）会把按钮沉到面板末尾 ——
/// 「工具明细」按钮排在「工具注册」之后、它展开的明细却在面板中段，用户点的是
/// 与内容脱节的位置。旧壳 DebugBar 的按钮与它展开的明细贴合，保序对齐这一点。
#[derive(Debug, Clone, PartialEq)]
pub enum PanelBlock {
    /// 非交互文本行。
    Line { style: PanelLineStyle, text: String },
    /// 一行「文本 + 行内按钮」。
    Row(PanelRow),
    /// 下拉选择。
    Select(PanelSelect),
    /// 块级按钮组（并排摆放，超出换行）。
    Buttons(Vec<PanelButton>),
    /// 分组卡片：里面的块画在同一个**有边界的容器**里。
    ///
    /// 为什么需要：一条 `Row` 挤不下时按钮会**换行**，几项会话就糊成一片、
    /// 按钮左右不齐（用户报告「各个会话应该用气泡，不然看不清，按钮也错位了」）。
    /// 卡片给每项一个可见边界，内容仍按保序规则在里面摆。
    Card(Vec<PanelBlock>),
}

/// 面板种类（平台层可用于分组底色/间距；不承载语义判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelKind {
    /// 计划确认/执行/逐步门。
    Plan,
    /// 待处置计划（恢复：继续 / 丢弃）。
    RecoveredPlan,
    /// 权限确认。
    Permission,
    /// 向用户提问（`ask_user`）：问题 + 选项 +「其它」/「取消」。
    Choice,
    /// 中断运行决策条。
    Interrupted,
    /// 排队与暂停项。
    Queue,
    /// 模型用量。
    Usage,
    /// 投递意图选择（插话 / 稍后继续）。
    Delivery,
    /// Slash 候选。
    SlashCandidates,
    /// 会话历史（A1：SessionTabs 的「历史」下拉面板）。
    SessionHistory,
    /// 调试条（DebugBar 迁移：上下文/Token/工具/会话级思考强度与安全策略）。
    DebugBar,
}

/// 一个面板的渲染块（按 `blocks` 声明顺序自上而下摆放）。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelView {
    pub kind: PanelKind,
    pub blocks: Vec<PanelBlock>,
}

impl PanelView {
    pub fn new(kind: PanelKind) -> Self {
        Self {
            kind,
            blocks: Vec::new(),
        }
    }

    pub fn line(mut self, style: PanelLineStyle, text: impl Into<String>) -> Self {
        self.blocks.push(PanelBlock::Line {
            style,
            text: text.into(),
        });
        self
    }

    pub fn row(self, text: impl Into<String>, buttons: Vec<PanelButton>) -> Self {
        self.push_row(PanelLineStyle::Normal, text, buttons)
    }

    pub fn row_styled(
        self,
        style: PanelLineStyle,
        text: impl Into<String>,
        buttons: Vec<PanelButton>,
    ) -> Self {
        self.push_row(style, text, buttons)
    }

    fn push_row(
        mut self,
        style: PanelLineStyle,
        text: impl Into<String>,
        buttons: Vec<PanelButton>,
    ) -> Self {
        self.blocks.push(PanelBlock::Row(PanelRow {
            text: text.into(),
            style,
            buttons,
        }));
        self
    }

    /// 追加一个 chip 按钮；连续声明的按钮并排成一组（超出换行）。
    pub fn button(mut self, label: impl Into<String>, action: PanelAction) -> Self {
        self.push_button(PanelButton::new(label, action));
        self
    }

    /// 追加一个文字链按钮（无边框）；聚合规则同 [`PanelView::button`]。
    pub fn link_button(mut self, label: impl Into<String>, action: PanelAction) -> Self {
        self.push_button(PanelButton::link(label, action));
        self
    }

    /// 追加一个下拉选择（独立一行：标签 + 下拉框）。
    pub fn select(mut self, select: PanelSelect) -> Self {
        self.blocks.push(PanelBlock::Select(select));
        self
    }

    /// 追加一个分组卡片（内部块画在同一个有边界的容器里；见 [`PanelBlock::Card`]）。
    pub fn card(mut self, blocks: Vec<PanelBlock>) -> Self {
        self.blocks.push(PanelBlock::Card(blocks));
        self
    }

    fn push_button(&mut self, button: PanelButton) {
        // 连续声明的按钮聚成一组并排摆放；中间隔了别的块则不聚组。
        if let Some(PanelBlock::Buttons(buttons)) = self.blocks.last_mut() {
            buttons.push(button);
        } else {
            self.blocks.push(PanelBlock::Buttons(vec![button]));
        }
    }
}

/// 面板按钮的动作。Node 领域动作经 `ChatIntent` 派发；本地动作只改显示态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PanelAction {
    // ── 计划确认（确认阶段）──
    /// 「全部执行」：回执 `{confirmed: true, mode: "auto"}`。
    PlanConfirmAll,
    /// 「逐步确认」：回执 `{confirmed: true, mode: "stepByStep"}`。
    PlanConfirmStepByStep,
    /// 「取消」：回执 `{confirmed: false, reason: "user"}`。
    PlanCancel,
    // ── 逐步门（执行阶段）──
    /// 「执行下一步 / 继续」：回执 `{decision: "continue"}`。
    PlanGateContinue,
    /// 「中止」：回执 `{decision: "abort"}`。
    PlanGateAbort,
    /// 「终止执行」：Node 侧 `abortRunningPlan`；未在执行的计划按用户取消收尾（Node 承接）。
    PlanAbortExecution,
    // ── 待处置计划（恢复）──
    PlanResume {
        plan_id: String,
    },
    PlanDiscard {
        plan_id: String,
    },
    /// 未知副作用步骤：标记为已完成（副作用确已生效）。
    PlanStepAlreadyApplied {
        plan_id: String,
        step_id: String,
    },
    /// 未知副作用步骤：重跑此步（记一次新执行尝试）。
    PlanStepRetry {
        plan_id: String,
        step_id: String,
    },
    // ── 权限确认 ──
    /// 「本次允许」（allow_once）。
    PermissionAllowOnce,
    /// 「会话内允许」（allow_session）。
    PermissionAllowSession,
    /// 「拒绝」（deny）。
    PermissionDeny,
    // ── 向用户提问（ask_user；选择面板）──
    /// 点选第 `index` 个选项（0 基；Node 侧校验越界即丢弃，不代用户选）。
    ChoicePick {
        request_id: String,
        index: usize,
    },
    /// 「其它」：用户选择用自己的话回答。面板收起、焦点回输入框；自由原文以用户的
    /// **下一条消息**到达模型（不在回执里回传，宿主不截留、不冒充）。
    ChoiceOther {
        request_id: String,
    },
    /// 「取消」：用户不回答。按取消如实收尾（Node 侧不假装用户选了任何一项）。
    ChoiceCancel {
        request_id: String,
    },
    // ── 排队与中断 ──
    WithdrawQueued {
        entry_id: String,
    },
    ResumePaused,
    DiscardPaused,
    InterruptedContinue,
    InterruptedDiscard,
    // ── 本地显示态 ──
    /// 展开/收起用量明细。
    ToggleUsage,
    /// 选用第 index 条 slash 候选（把 `/<name>` 填回输入框，不执行）。
    SlashPick {
        index: usize,
    },
    /// 选定投递意图（meta 轨上「投递」菜单选一项；`None` = 恢复默认）。
    ///
    /// 取代旧的 `CycleDelivery`（「点一下轮一个」）：用户要求投递是**真下拉菜单**，
    /// 菜单能直接选，轮换语义随之退场。
    SetDelivery {
        mode: Option<super::intents::SendDelivery>,
    },
    // ── 会话历史（A1）──
    /// 展开历史面板；展开时同时请求刷新（打开即重读仓库）。
    ToggleSessionHistory,
    /// 收起历史面板（不动数据）。
    CloseSessionHistory,
    /// 重新请求会话历史（`refreshSessionHistory`；结果随投影回推）。
    RefreshSessionHistory,
    /// 从历史恢复一个会话（Node openSession + switchToSession）。
    RestoreSessionFromHistory {
        session_id: String,
    },
    /// 删除一个历史会话（Node deleteSession；磁盘文件一并删除）。
    DeleteSessionFromHistory {
        session_id: String,
    },
    /// 「记住这条」：把这条**用户消息**的原文写入长期记忆。
    ///
    /// 入口 = **消息右键菜单**（气泡上的按钮已于 2026-10-05 按用户规则退场，
    /// 入口改由右键承接）；平台层只对用户消息挂项，判据 =
    /// `model.rs::MessageSnapshot::remember_event_id`（不在平台层复刻）。
    /// `event_id` 是被右键消息的 ingress 事件身份，Node 侧复核可信来源后提交
    /// （回执带 revision），失败如实拒绝、以中性通知呈现。
    RememberMessage {
        event_id: String,
    },
    // ── 调试条（DebugBar 迁移）──
    /// 会话级思考强度覆盖：`None` = 恢复默认（全局 `ai.thinkingEffort`）。
    SetThinkingEffort {
        effort: Option<String>,
    },
    /// 会话级安全策略覆盖：`None` = 恢复默认（全局 `safety.mode`）。
    SetSafetyMode {
        mode: Option<String>,
    },
    /// 展开/收起「本次请求工具列表」（纯本地显示态）。
    ToggleDebugTools,
    // `ToggleDebugPanel` 删除记录（2026-10-05）：整体折叠机制随上拉抽屉退场。
    /// 展开/收起「工具注册明细」（纯本地显示态）。
    ToggleDebugRegistry,
    /// 触发会话压缩：与输入框发送 `/compact` 走**同一条** slash 入口
    /// （`ChatIntent::SlashCommand` → `chat_slash_command` → `sendMessage`）。
    ///
    /// 可用性不在宿主预判：运行中 / 有排队项 / 无可摘要范围的归宿由 Node 命令层
    /// 如实回复（系统消息），宿主不置灰、不假装成功。
    CompactSession,
    // ── meta 轨 / 浮层（2026-10-05 改版）──
    /// 点输入区上方的把手：开合浮层。
    ToggleInspector,
    /// 收起浮层（点浮层外或 ✕）。
    CloseInspector,
}

/// `apply_panel_action` 的返回：给平台层的本地副作用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PanelOutcome {
    /// 动作已由 `ChatUi` 处理（模型/回执），平台层无需额外动作。
    None,
    /// 请把这段文本填回输入框（slash 补全；光标移到末尾）。
    FillInput(String),
    /// 请把焦点交回输入框（**不改文本、不触发送**）：提问面板的「其它」点下去后，
    /// 用户直接在输入框里写自己的回答 —— 下一条消息就是答复（自由原文不经面板回传）。
    FocusInput,
    /// 动作成功后的中性瞬时回执（旧壳 `showDeliveryNote` 的迁移）：
    /// 平台层经既有 notice 通道呈现，由模型按 [`NOTICE_TTL_MS`] 自动收起。
    Notice(String),
}

/// 未知副作用步骤的处置（与 Node `resolveUnknownSideEffect` 的取值同义）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnknownStepResolution {
    AlreadyApplied,
    Retry,
}

impl UnknownStepResolution {
    /// 线格式取值（Node 侧 `resolveUnknownSideEffect` 的入参字面量）。
    pub fn as_str(&self) -> &'static str {
        match self {
            UnknownStepResolution::AlreadyApplied => "already_applied",
            UnknownStepResolution::Retry => "retry",
        }
    }
}

// ==========================================
// 中性文案常量（界面语言，不是 Card 台词）
// ==========================================

// 决策类面板（计划确认 / 权限确认 / 提问）**没有本地等待超时**（2026-10-06 用户裁决：
// 选择类弹窗不留超时，用户想多久想多久）。原先的三条本地收纳文案
//（计划确认等待超时 / 权限确认已超时 / 提问等待超时）与对应的本地期限一起删除 ——
// 归宿只来自 Node 的结算事件（回执 / 取消 / 会话切换 / 发射失败），面板不会被倒计时收起。
/// 执行期计划长时间没有收尾事件时的本地收纳文案（计划状态以会话为准）。
pub const NOTICE_PLAN_EXECUTION_STALE: &str =
    "计划长时间没有新进度，已收起计划面板（计划状态以会话为准）";
/// 恢复计划条目在投影缺失中断提示时的中性兜底（不是角色台词）。
pub const INTERRUPTED_FALLBACK_TEXT: &str = "上次运行未完成，需要你决定继续或丢弃";

/// 中性通知的存活时长：与旧壳 `showDeliveryNote` 的 4000ms 一致 —— 瞬时提示
/// 自动收起，不在状态行驻留（结果状态以随后的投影回推为准）。
pub const NOTICE_TTL_MS: u64 = 4_000;

// ==========================================
// 决策类动作成功后的中性回执（旧壳 showDeliveryNote 的迁移）
// ==========================================
//
// 文案只陈述**宿主已知的事实**，不是角色台词：
// - 有界请求（撤回/丢弃/终止/处置）在回执返回时领域写已完成 → 用完成式；
// - 非阻塞提交（继续/恢复）唯一同步事实是「已交给 Node」→ 用「已提交」式，
//   下半程归宿由随后的投影与事件呈现。
// 条目的精确归宿（撤回成功 vs 该条已被消费）需要回执结果面才能区分，
// 当前按请求完成给出，不在宿主侧伪造更细的结论。

/// 撤回排队消息（成功口径；该条此后不在队列里）。
pub const NOTICE_WITHDRAW_QUEUED: &str = "已撤回排队消息";
/// 继续处理暂停项（非阻塞提交）。
pub const NOTICE_RESUME_PAUSED: &str = "已提交继续处理";
/// 丢弃全部暂停项（有界请求：Node 侧取出即全部丢弃）。
pub const NOTICE_DISCARD_PAUSED: &str = "已丢弃全部暂停消息";
/// 继续上次中断的运行（非阻塞提交）。
pub const NOTICE_CONTINUE_INTERRUPTED: &str = "已提交继续运行";
/// 丢弃中断运行（有界请求）。
pub const NOTICE_DISCARD_INTERRUPTED: &str = "已丢弃中断运行";
/// 终止执行中的计划（有界请求）。
pub const NOTICE_ABORT_PLAN: &str = "已提交终止执行请求";
/// 恢复待处置计划（非阻塞提交：结算点是整段计划跑完）。
pub const NOTICE_RESUME_PLAN: &str = "已提交恢复计划";
/// 丢弃待处置计划（有界请求）。
pub const NOTICE_DISCARD_PLAN: &str = "已丢弃待处置计划";
/// 未知副作用步骤：标记为已完成（有界请求）。
pub const NOTICE_STEP_ALREADY_APPLIED: &str = "已将步骤标记为已完成";
/// 未知副作用步骤：重跑此步（有界请求）。
pub const NOTICE_STEP_RETRY: &str = "已提交重跑该步骤";
/// 「记住这条」的菜单项文案（消息右键菜单；平台层文案的**唯一来源** ——
/// macOS / Windows 都引用这里，不各自复制字面量）。
pub const REMEMBER_MENU_ITEM_LABEL: &str = "记住这条";
/// 「记住这条」提交成功（入口 = 消息右键菜单；有界请求：Node 侧记忆提交完成才回执；
/// revision 不回显）。
pub const NOTICE_REMEMBER_MESSAGE: &str = "已记住这条用户原文";

// ── 发送投递归宿（`deskpet-send-outcome`；旧壳 `DELIVERY_NOTES` 同文）──
//
// 中性界面语言：只陈述这条输入去了哪里（投递准入当刻的事实），不是 Card 台词 ——
// 与失败诊断同理，用户要能分清「角色在说话」和「系统在汇报」。

/// 插话（steered）：进入当前响应，当前响应结束后处理。
pub const NOTICE_DELIVERY_STEERED: &str = "已排队插话：当前响应结束后处理";
/// 稍后继续（followup）：排到下一回合，当前任务结束后继续。
pub const NOTICE_DELIVERY_FOLLOWUP: &str = "已排队稍后继续：当前任务结束后继续";
/// 下一轮（deferred/nextRun）：不进入本次运行，等下一次运行处理。
pub const NOTICE_DELIVERY_DEFERRED: &str = "已排队：下一次运行处理";

/// 投递归宿 → 回执文案（三值一一对应；值域镜像见 `events.rs::SendOutcomeDelivery`）。
pub fn send_outcome_notice(delivery: super::events::SendOutcomeDelivery) -> &'static str {
    use super::events::SendOutcomeDelivery;
    match delivery {
        SendOutcomeDelivery::Steered => NOTICE_DELIVERY_STEERED,
        SendOutcomeDelivery::Followup => NOTICE_DELIVERY_FOLLOWUP,
        SendOutcomeDelivery::Deferred => NOTICE_DELIVERY_DEFERRED,
    }
}

// ==========================================
// 纯文本格式化（各面板共用口径）
// ==========================================

/// token 数格式化（与 DebugBar `formatTokens` 同义：≥1000 → `x.yk`）。
pub fn format_tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// 队列项预览（与 ChatPanel `previewText` 同义：压平空白、60 字符截断）。
pub fn preview_text(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    if count > 60 {
        let head: String = flat.chars().take(60).collect();
        format!("{head}…")
    } else {
        flat
    }
}

// ==========================================
// 消息扩展块（思考 / 工具调用卡）的共享口径
// ==========================================
//
// 投影扩展（思考 / 工具调用 / 工具失败位）的**展示策略**放这里，两个平台层共用，
// 不在 macOS / Windows 各写一份：内容一律按纯文本处理（不解析 JSON、不执行、
// 不做富文本注入），文本进入控件前必须先经这里单行化并按上限截断。

/// 工具调用参数摘要的字符上限（单行化之后；超出部分以 `…` 截断）。
///
/// 参数是模型产出/工具输入的 JSON 原文，可能很大（数十 KB 级）：卡片只承载这段
/// 受控摘要，**不把原始参数整串放进控件内存**。120 字符约为窄聊天列单行可视宽度
/// 的两倍（CJK 全角与半角混合的最坏情形下也够填充任何布局宽度），不提供展开入口
/// —— 完整参数以会话正文（数据真相源）为准，界面只做摘要。
pub const TOOL_CALL_ARGUMENTS_PREVIEW_CHARS: usize = 120;

/// 工具调用参数的单行摘要：压平全部空白（换行/制表一律折叠为单空格，防撑爆布局）
/// + 按字符截断到 [`TOOL_CALL_ARGUMENTS_PREVIEW_CHARS`]。
///
/// 只做纯文本处理：不解析 JSON、不解码转义、不执行内容；返回值由平台层按纯文本
/// 渲染（macOS 走纯文本标签，Windows 走 RTF 转义装载）。参数为空/全空白时返回
/// `None`（卡片只显示工具名）。
pub fn tool_call_arguments_preview(arguments: &str) -> Option<String> {
    let flat = arguments.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let count = flat.chars().count();
    if count > TOOL_CALL_ARGUMENTS_PREVIEW_CHARS {
        let head: String = flat
            .chars()
            .take(TOOL_CALL_ARGUMENTS_PREVIEW_CHARS)
            .collect();
        Some(format!("{head}…"))
    } else {
        Some(flat)
    }
}

/// 工具调用卡的标题行（中性界面语言 + 工具名；工具名来自模型产出，按纯文本展示）。
pub fn tool_call_card_title(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "工具调用".to_string()
    } else {
        format!("工具调用 · {name}")
    }
}

/// 思考块的折叠开关标签（`expanded=false` 显示展开入口）。
///
/// 默认折叠：思考是过程性内容且可能很长（见平台层块注释的选型说明）。
pub fn thinking_toggle_label(expanded: bool) -> String {
    if expanded {
        "思考 ▾".to_string()
    } else {
        "思考 ▸".to_string()
    }
}

/// 复杂度星级（0..=5，超出夹到边界；与 PlanConfirm 的 ★/☆ 展示同义）。
pub fn complexity_stars(complexity: u32) -> String {
    let filled = complexity.min(5) as usize;
    format!("{}{}", "★".repeat(filled), "☆".repeat(5 - filled))
}

/// 文本宽度的粗估（控件布局用）：CJK 全角按 1.0×字号、其余按 0.6×字号。
/// 只用于按钮/标签的初始摆位，不参与视觉断言。
pub fn estimated_text_width(text: &str, base_size: f64) -> f64 {
    let mut units = 0.0f64;
    for ch in text.chars() {
        // 常见全角范围：CJK 统一表意文字、全角标点、假名、谚文。
        let wide = matches!(ch as u32,
            0x1100..=0x115F
            | 0x2E80..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6);
        units += if wide { 1.0 } else { 0.6 };
    }
    units * base_size
}

// ==========================================
// 面板摆放几何（两平台共用的唯一实现点）
// ==========================================
//
// 平台层只做「按算好的 frame 建控件」；摆放规则（换行、越界裁剪、空间不足时
// 的取舍）全部在这里，两个平台不再各写一份。历史缺陷（用户两次报告：
// 调试条档位控件点不动）就是两边各写一份、且都只按单行摆放导致的：
// - 行内按钮不换行 → 越出聊天列右边界的按钮被窗口边缘裁掉（半截可见或完全不可见，
//   点不到）；
// - 面板区高度封顶后直接 `break` 丢弃后续视图 → 「工具明细 / 注册明细 / 投递」
//   这类交互控件随内容变长被静默扔掉，用户点的是不存在的位置。

/// 面板摆放的几何度量（逻辑单位；Windows 侧按 DPI 缩放后使用）。
///
/// 阈值同源：行高 16、按钮高 22、视图间距 6、水平间距 6、左右内边距 4。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelMetrics {
    pub line_height: f64,
    pub button_height: f64,
    pub view_spacing: f64,
    pub button_gap: f64,
    pub pad_x: f64,
    /// 行首标签与第一个按钮之间的间距。
    pub label_gap: f64,
    /// 行首标签的最小宽度（再窄也给标签留一点；按钮换到下一行）。
    pub min_label_width: f64,
    /// 内容区最小宽度（容器极窄时仍可排）。
    pub min_inner_width: f64,
    /// 面板控件的估算字号（宽度粗估用）。
    pub text_size: f64,
    /// 卡片左右内边距（卡片外框内沿与内部块之间）。
    pub card_pad_x: f64,
    /// 卡片上下内边距。
    pub card_pad_y: f64,
    /// 卡片底板与下一块之间的间距。
    ///
    /// 不留间距时相邻两张卡会**贴成一片**（底边与下一张的顶边共用一条描边），
    /// 反而看不出「一条会话一个气泡」——卡片本来就是为可见边界引入的。
    pub card_gap: f64,
}

/// 面板最高占宿主视图的比例（超出按 [`layout_panels`] 的规则截断；
/// 面板永不挤掉输入区 —— 两个平台共用同一上限，不各写一份）。
pub const PANEL_MAX_FRACTION: f64 = 0.45;

// ── 气泡几何（平台无关；两平台共用同一套「贴合内容宽度」算法） ──

/// 气泡贴边留白（两侧）。
pub const BUBBLE_SIDE_MARGIN: f64 = 6.0;
/// 气泡宽度上限比例（设计稿 `.m{max-width:86%}`）。
pub const BUBBLE_MAX_FRACTION: f64 = 0.86;
/// 气泡宽度下限（极短消息如「好」也保持有形状）。
pub const BUBBLE_MIN_WIDTH: f64 = 34.0;
/// 气泡横向内边距。
pub const BUBBLE_PAD_X: f64 = 10.0;
/// 气泡纵向内边距。
pub const BUBBLE_PAD_Y: f64 = 7.0;

/// 气泡宽度上限（贴边留白后取 86%；列过窄时为可读性保留最小 40）。
pub fn bubble_cap(width: f64) -> f64 {
    ((width - BUBBLE_SIDE_MARGIN * 2.0) * BUBBLE_MAX_FRACTION).max(40.0)
}

/// chip 文案适配：超出可用宽度时**中段省略**（保留头尾、`…` 居中）。
///
/// 2026-10-05 评审：附件 chip 的末尾是「（不可用）」这类状态后缀，尾部硬裁会把
/// 后缀切碎（实机「（不可用）（…」，像溢出 bug）——中段省略同时保住文件名头尾
/// 与状态后缀。两平台共用（与其它面板几何同住本模块）。
pub fn fit_chip_label(text: &str, max_width: f64) -> String {
    let budget = (max_width - 22.0).max(24.0);
    if estimated_text_width(text, 11.0) <= budget {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    // 从「保留 1 个字符」向两端扩展，取最后一个放得下的窗口
    // （初版从空窗口起步一次就返回「…」，实机把图片 chip 截成了一个空 chip）。
    let mut best: Option<String> = None;
    for keep in 1..=chars.len() {
        let head = keep / 2;
        let tail = chars.len() - (keep - head);
        let candidate: String = chars[..head]
            .iter()
            .chain(core::iter::once(&'…'))
            .chain(chars[tail..].iter())
            .collect();
        if estimated_text_width(&candidate, 11.0) <= budget {
            best = Some(candidate);
        } else {
            break; // 估算宽度随 keep 近似单调，放不下即止
        }
    }
    best.unwrap_or_else(|| "…".to_string())
}

/// 气泡最终宽度：内容自然宽（含内边距，`+2` 给描边留位）与内嵌入口（footer）
/// 宽度取大，再夹在上下限之间。含代码块时直接给上限（代码块要横向空间）；
/// `used=0`（测量失效）落回下限。
pub fn bubble_content_width(used: f64, has_code: bool, footer_w: f64, max_width: f64) -> f64 {
    let upper = max_width.max(BUBBLE_MIN_WIDTH);
    if has_code {
        return upper;
    }
    let natural = used + BUBBLE_PAD_X * 2.0 + 2.0;
    (natural.max(footer_w + BUBBLE_PAD_X * 2.0)).clamp(BUBBLE_MIN_WIDTH, upper)
}

/// 说话人标签文本；`None` = 本条不摆标签行。
///
/// 用户条目不摆「你」：右对齐气泡本身就是「我的一侧」（设计稿 `.m.me` 也没有
/// 说话人标签）；助手条目在投影没给到角色名时也不摆空标签——空标签只白占一行。
pub fn role_label_text(
    role: super::model::Role,
    speaker: &str,
    failed_tool: bool,
) -> Option<String> {
    use super::model::Role;
    match role {
        Role::User => None,
        Role::Assistant => {
            let name = speaker.trim();
            (!name.is_empty()).then(|| name.to_string())
        }
        Role::System => Some("系统".to_string()),
        Role::Tool if failed_tool => Some("工具 · 失败".to_string()),
        Role::Tool => Some("工具".to_string()),
    }
}

/// 按空行把一段正文拆成多个气泡（显示级；与 Node 拟人化「空行分段」同口径，
/// 2026-10-05 用户规则：「开启拟人化后回车消息要分成几条」——历史里已提交的
/// 单泡多段记录也在渲染时拆开）：
///
/// - 空行（一行或多行连续空白行）分段；段内单个换行保持同段；
/// - 含代码块（```）的正文不拆（技术内容保持整条）；
/// - 结果保证至少一段（空正文由调用方在拆分前跳过）。
pub fn split_paragraphs(text: &str) -> Vec<String> {
    if text.contains("```") {
        return vec![text.to_string()];
    }
    fn flush(current: &mut Vec<&str>, out: &mut Vec<String>) {
        if current.is_empty() {
            return;
        }
        let joined = current.join("\n").trim().to_string();
        if !joined.is_empty() {
            out.push(joined);
        }
        current.clear();
    }
    let mut out: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            flush(&mut current, &mut out);
        } else {
            current.push(line);
        }
    }
    flush(&mut current, &mut out);
    if out.is_empty() {
        out.push(text.to_string());
    }
    out
}

/// 面板的**呈现面**：决定它归到流内、meta 轨（点开浮层）、还是与输入区联动的临时面板。
///
/// 2026-10-05 改版：此前「用量 / 调试 / 投递」默认折叠进输入区上方的上拉抽屉，
/// 展开会把消息流整体顶走（用户反馈「不符合交互习惯、太挡」）。现在收成输入区
/// 下方一行 meta 轨，详情改走**脱离布局流的浮层** —— 开合前后消息流 y 不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelSurface {
    /// 流内决策面板：必须看见、且要用户拍板才继续。
    Decision,
    /// 收进**输入区上方那个把手**后面的浮层。
    ///
    /// 用量 / 调试 / 投递三块同浮层（顺序按 `panel_views()` 的声明序），
    /// 所以不需要载荷 —— 平台只认「哪些面板进浮层」，不认「打开的是哪一块」。
    Inspector,
    /// 锚定弹层：挂在某个既有控件附近、脱离布局流（点外部关闭）。
    ///
    /// 与 `Inspector` 的区别是**锚点不在 meta 轨上**，而在一个固定控件旁边；
    /// 与 `Transient` 的区别是**不进流内面板栈**——挂在栈里会跑到页面底部，
    /// 与触发它的按钮隔着大半屏（用户报告的「点会话历史的弹窗在下面」）。
    Anchored(AnchorTarget),
    /// 与输入区联动的临时面板（slash 候选）：留在流内，紧贴输入区之上。
    Transient,
}

/// 锚定弹层的锚点。平台层按此取对应控件的 frame 定位，**不自己决定挂哪儿**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorTarget {
    /// 会话标签行右侧的「历史」按钮：弹层挂在它下方、右对齐。
    HistoryButton,
}

// `InspectorPane` / `MenuTarget` / `MenuItem` / `RailTarget` 删除记录（2026-10-05 第二次改版）：
// 用户看了实机后把底部又改了一版 ——「调试、投递合并为调试，然后调试取消显示，
// 改成输入框上面那个横条加个上拉小箭头，输入框往下放，贴住下面」。
// 于是**底下那排 chip 整个退场**，改成一个把手；用量/调试/投递三块内容合进**同一个浮层**
// （顺序仍按 `panel_views()` 的声明序），所以「浮层里有哪几块」不再是平台要区分的事，
// `PanelSurface::Inspector` 也就不需要载荷。
//
// 淘汰的两条路（留档，别再走回来）：
// - 「投递是 meta 轨上的真下拉菜单」：菜单本身没问题，但它依附的那排 chip 没了。
// - 「每个入口一个 InspectorPane」：入口只剩一个把手，分档失去意义。

impl PanelKind {
    /// 这个面板按哪种呈现面渲染。
    ///
    /// 判定只此一处：平台层按结果分区（决策留流内、Inspector 进浮层、Transient 留流内），
    /// 不允许平台层另写一份 `matches!`。
    pub fn surface(self) -> PanelSurface {
        match self {
            PanelKind::Usage | PanelKind::DebugBar | PanelKind::Delivery => PanelSurface::Inspector,
            PanelKind::SlashCandidates => PanelSurface::Transient,
            PanelKind::SessionHistory => PanelSurface::Anchored(AnchorTarget::HistoryButton),
            PanelKind::Plan
            | PanelKind::RecoveredPlan
            | PanelKind::Permission
            | PanelKind::Choice
            | PanelKind::Interrupted
            | PanelKind::Queue => PanelSurface::Decision,
        }
    }
}

// ==========================================
// 输入区上方的把手（取代了原 meta 轨）
// ==========================================

/// 把手带的高度（输入区上沿那条带），右侧画一个**上拉小箭头**。
///
/// 2026-10-05 第二次改版（用户规则「调试、投递合并为调试，然后调试取消显示，
/// 改成输入框上面那个横条加个上拉小箭头，输入框往下放，贴住下面」）：
/// 它取代了原来那排 chip —— 底下那排整个撤掉后，入口只剩这一个把手，
/// 点它开合浮层（用量 / 调试 / 投递三块同浮层，顺序按 `panel_views()` 的声明序）。
/// 输入框因此得以往下贴住窗口底。
pub const HANDLE_HEIGHT: f64 = 22.0;

/// 箭头区域占的宽度（含左右内边距），用来算状态文字能占多少。
pub const HANDLE_ARROW_WIDTH: f64 = 30.0;

/// 箭头的边长。
const HANDLE_ARROW_SIZE: f64 = 10.0;

/// 上拉小箭头在把手里的摆放（左上原点，逻辑单位；**水平 + 垂直都居中**）。
///
/// 用户规则（2026-10-05）：「上拉栏的箭头居中」—— 初版放在最右，实机看下来它缩在角上、
/// 不像「这条带可以拉起来」的把手。居中后它就是这条带的主元素。
pub fn handle_arrow_frame(width: f64) -> PanelFrame {
    PanelFrame {
        x: ((width - HANDLE_ARROW_SIZE) / 2.0).max(0.0),
        y: ((HANDLE_HEIGHT - HANDLE_ARROW_SIZE) / 2.0).max(0.0),
        width: HANDLE_ARROW_SIZE,
        height: HANDLE_ARROW_SIZE,
    }
}

/// 把手**左侧**状态文字可用的宽度。
///
/// 箭头居中后它占掉中间那段，状态文字只能用左半侧（减箭头区的一半与内边距）——
/// 两侧各留 `PAD`，中间让给箭头。窗口很窄时可能压到 0，平台层按 0 处理即可
/// （文字自然截断，不越到箭头上去）。
pub fn handle_status_width(width: f64) -> f64 {
    ((width - HANDLE_ARROW_WIDTH) / 2.0 - 4.0).max(0.0)
}

/// 面板摆放度量常量（逻辑单位）。
/// 下拉 chip 的固定宽度（对 `Select` 行的等宽列；最长选项「全放行 / medium」
/// 在 12pt 文案下有充足余量）。
const SELECT_CHIP_WIDTH: f64 = 92.0;
/// 下拉行与下一行之间额外留出的间距（旧实现两行下拉只隔 0.5pt）。
const SELECT_ROW_GAP: f64 = 4.0;

pub const PANEL_METRICS: PanelMetrics = PanelMetrics {
    line_height: 16.0,
    button_height: 22.0,
    view_spacing: 6.0,
    button_gap: 6.0,
    pad_x: 4.0,
    label_gap: 8.0,
    min_label_width: 40.0,
    min_inner_width: 40.0,
    text_size: 12.0,
    // 卡片内边距（6/5）：比面板的左右内边距（4）略宽一圈，卡片里的内容与
    // 卡片边线之间有呼吸位；5 的上下内边距在 16pt 行高下不显臃肿。
    card_pad_x: 6.0,
    card_pad_y: 5.0,
    // 卡片间距（4）：小于视图间距（6）——卡片之间比「面板之间」更亲密，
    // 但大于 0，两张卡的描边不会贴成一条。
    card_gap: 4.0,
};

/// 面板控件的摆放框（逻辑单位，左上原点，容器坐标系）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PanelFrame {
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// 摆放后的面板元素（按自上而下的视觉顺序；平台层照单建控件）。
#[derive(Debug, Clone, PartialEq)]
pub enum PanelElement {
    /// 非交互文本行（样式交给平台映射为语义色）。
    Line {
        text: String,
        style: PanelLineStyle,
        frame: PanelFrame,
    },
    /// 可点击按钮（`action` 交给平台的动作表；`link=true` 为无边框文字链）。
    Button {
        label: String,
        action: PanelAction,
        link: bool,
        frame: PanelFrame,
    },
    /// 下拉选择：行首标签（`label_frame`）与下拉框本体（`frame`）分帧摆放；
    /// 选项动作按 `options` 顺序登记（平台层把选中下标映射回动作表）。
    Select {
        label: String,
        options: Vec<PanelOption>,
        selected: usize,
        label_frame: PanelFrame,
        frame: PanelFrame,
    },
    /// 卡片底板（**必须排在它内部元素之前**，平台按顺序建控件/图层，
    /// 先建的在下层，这样底不会被内容盖住）。
    ///
    /// 平台只按 `frame` 画底与描边（底走面板内的次级面 + 中性细边 + 圆角，
    /// 不能与弹层底同色）；几何（内边距、收口、间距）全部由 [`layout_panels`] 产出，
    /// 平台层不重算。
    Card { frame: PanelFrame },
}

impl PanelElement {
    pub fn frame(&self) -> PanelFrame {
        match self {
            PanelElement::Line { frame, .. }
            | PanelElement::Button { frame, .. }
            | PanelElement::Card { frame } => *frame,
            PanelElement::Select { frame, .. } => *frame,
        }
    }
}

/// 面板区的摆放结果。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelsLayout {
    /// 自上而下的元素（frame 已保证落在容器内）。
    pub elements: Vec<PanelElement>,
    /// 面板区应占的高度（= 最后一个元素的底边）。
    pub height: f64,
    /// 是否因高度不足裁掉了内容（被裁的只可能是明细文本；交互控件在能放下时一定保留）。
    pub truncated: bool,
}

/// 面板按钮宽度（按标签粗估 + 内边距；中文标签按全角宽度算）。
pub fn panel_button_width(label: &str) -> f64 {
    (estimated_text_width(label, PANEL_METRICS.text_size) + 20.0).max(48.0)
}

/// 下拉 chip 的宽度（固定值；旧实现按各自选项文案取「最长选项 + 36」的估算宽，
/// 同面板两个同文案的下拉差 7.5pt、并排看着像手滑 —— 2026-10-05 评审修复）。
pub fn panel_select_width(_select: &PanelSelect) -> f64 {
    SELECT_CHIP_WIDTH
}

/// 把面板渲染块摆进 `width × max_height` 的容器（左上原点，逻辑单位）。
///
/// 规则（两个平台共用，不允许平台层另写一份）：
/// - 按视图与块的声明顺序摆放（保序：按钮与它展开的明细贴合，见 [`PanelBlock`]）；
/// - 行内按钮依次摆放，**放不下就换行**；任何元素的 frame 都不越出容器左右边界；
/// - 整块放不下时**跳过该块并置位 `truncated`**（平台层留痕，不静默），继续尝试
///   后续块 —— 交互块（行内按钮 / 下拉 / 动作按钮）**整块**摆放：要么连按钮
///   一起放下，要么整块不产生 frame，不留下「看得到点不到」的半截控件；
/// - 文本行逐行摆放：放不下的行被跳过（通常出现在展开的长明细尾部）。
pub fn layout_panels(views: &[PanelView], width: f64, max_height: f64) -> PanelsLayout {
    let metrics = PANEL_METRICS;
    let inner_width = (width - metrics.pad_x * 2.0).max(metrics.min_inner_width);
    let mut elements: Vec<PanelElement> = Vec::new();
    let mut y = 0.0f64;
    let mut truncated = false;

    for (view_index, view) in views.iter().enumerate() {
        if view_index > 0 {
            y += metrics.view_spacing;
        }
        for block in &view.blocks {
            match place_block(
                block,
                y,
                inner_width,
                max_height,
                &mut elements,
                &mut truncated,
            ) {
                Some(end_y) => y = end_y,
                None => truncated = true,
            }
        }
    }

    PanelsLayout {
        elements,
        height: y,
        truncated,
    }
}

/// 摆放单个块；放不下返回 `None`（不产生任何 frame，由调用方置位 `truncated`）。
///
/// `truncated` 只在**卡片内部**的递归里由本函数自己置位（卡片仍产出已放下的部分，
/// 不能走「整块返回 None」的通道），外层调用方按返回值置位。
fn place_block(
    block: &PanelBlock,
    y0: f64,
    inner_width: f64,
    max_height: f64,
    out: &mut Vec<PanelElement>,
    truncated: &mut bool,
) -> Option<f64> {
    let metrics = PANEL_METRICS;
    match block {
        PanelBlock::Line { style, text } => {
            if y0 + metrics.line_height > max_height {
                return None;
            }
            out.push(PanelElement::Line {
                text: text.clone(),
                style: *style,
                frame: PanelFrame {
                    x: metrics.pad_x,
                    y: y0,
                    width: inner_width,
                    height: metrics.line_height,
                },
            });
            Some(y0 + metrics.line_height)
        }
        PanelBlock::Row(row) => {
            let height = button_flow_height(
                Some((row.text.as_str(), row.style)),
                &row.buttons,
                inner_width,
            );
            if y0 + height > max_height {
                return None;
            }
            place_button_flow(
                Some((row.text.as_str(), row.style)),
                &row.buttons,
                y0,
                inner_width,
                out,
            );
            Some(y0 + height)
        }
        PanelBlock::Select(select) => place_select(select, y0, inner_width, max_height, out),
        PanelBlock::Buttons(buttons) => {
            let height = button_flow_height(None, buttons, inner_width);
            if y0 + height > max_height {
                return None;
            }
            place_button_flow(None, buttons, y0, inner_width, out);
            Some(y0 + height)
        }
        PanelBlock::Card(blocks) => place_card(blocks, y0, inner_width, max_height, out, truncated),
    }
}

/// 摆放一个卡片块（[`PanelBlock::Card`]）：内部块先按 `card_pad_x/card_pad_y`
/// 在**卡片内容区的局部坐标**里排（既有摆放规则原样复用，包括嵌套卡片），
/// 排完把内部元素统一平移进容器坐标，再按内部内容的外框收口出底板 frame，
/// 并把 [`PanelElement::Card`] **插在这批元素的最前面** —— 平台按顺序建控件/图层，
/// 先建的在下层，底板排在后面会把内容盖住。
///
/// 返回卡片底边 + `card_gap`（卡片与下一块之间的间距）。
/// 内部块一块也放不下（含显式的空卡片）时**不产任何 frame、不占高度**：
/// 空框比不画更糟（`truncated` 由跳过内部块的那次摆放负责置位）。
fn place_card(
    blocks: &[PanelBlock],
    y0: f64,
    inner_width: f64,
    max_height: f64,
    out: &mut Vec<PanelElement>,
    truncated: &mut bool,
) -> Option<f64> {
    let metrics = PANEL_METRICS;
    let card_inner_width = inner_width - metrics.card_pad_x * 2.0;
    // 内容区的可用高：卡片上下内边距之外才是内部块的地方（放不下内容就整卡跳过）。
    let content_max = max_height - y0 - metrics.card_pad_y * 2.0;
    if card_inner_width <= 0.0 || content_max <= 0.0 {
        return None;
    }
    let mut inner: Vec<PanelElement> = Vec::new();
    let mut inner_y = 0.0f64;
    for block in blocks {
        match place_block(
            block,
            inner_y,
            card_inner_width,
            content_max,
            &mut inner,
            truncated,
        ) {
            Some(end_y) => inner_y = end_y,
            None => *truncated = true,
        }
    }
    if inner.is_empty() {
        // 一块都没放下（含显式的空卡片）：不产底板，也不占高度。
        // 若是高度不足导致的，`truncated` 已由上面被跳过的那次摆放置位；
        // 显式空卡片没有「放不下」的东西，不额外报截断。
        return Some(y0);
    }
    let content_bottom = inner
        .iter()
        .map(|element| element.frame().bottom())
        .fold(0.0, f64::max);
    // 内部块在局部坐标里沿用既有摆放约定（x 从 `pad_x` 起、可用宽 = 传入的
    // `inner_width`），所以平移量只需再补 `card_pad_x`：左内沿 = pad_x + card_pad_x，
    // 右内沿 = pad_x + card_pad_x + (inner_width − 2×card_pad_x) = 卡片右缘 − card_pad_x，
    // 两侧内边距对称。
    let dx = metrics.card_pad_x;
    let dy = y0 + metrics.card_pad_y;
    for element in &mut inner {
        translate_element(element, dx, dy);
    }
    let card_frame = PanelFrame {
        x: metrics.pad_x,
        y: y0,
        width: inner_width,
        height: content_bottom + metrics.card_pad_y * 2.0,
    };
    // 底板先入列（平台按顺序建控件/图层：先建的在下层，不会被内容盖住）。
    out.push(PanelElement::Card { frame: card_frame });
    out.append(&mut inner);
    Some(card_frame.bottom() + metrics.card_gap)
}

/// 平移一个已摆放元素的所有 frame（卡片把内部块从局部坐标搬进容器坐标用）。
fn translate_element(element: &mut PanelElement, dx: f64, dy: f64) {
    fn shift(frame: &mut PanelFrame, dx: f64, dy: f64) {
        frame.x += dx;
        frame.y += dy;
    }
    match element {
        PanelElement::Line { frame, .. }
        | PanelElement::Button { frame, .. }
        | PanelElement::Card { frame } => shift(frame, dx, dy),
        PanelElement::Select {
            label_frame, frame, ..
        } => {
            shift(label_frame, dx, dy);
            shift(frame, dx, dy);
        }
    }
}

/// 摆放一个下拉选择块：标签与下拉框同行的放不下时，标签独占一行、框换到下一行；
/// 换行仍放不下则整块跳过（返回 `None`）。返回块底边。
fn place_select(
    select: &PanelSelect,
    y0: f64,
    inner_width: f64,
    max_height: f64,
    out: &mut Vec<PanelElement>,
) -> Option<f64> {
    let metrics = PANEL_METRICS;
    let select_width = panel_select_width(select).min(inner_width);
    // +4px 余量：估算值是字形宽的下界，零余量会让「思考」这类短标签压线截断成
    // 「…」（2026-10-05 实机截图确证）。
    let label_width = estimated_text_width(&select.label, metrics.text_size) + 4.0;
    let gap = metrics.label_gap;
    let same_line = label_width + gap + select_width <= inner_width;
    // 行距 4：旧实现两行下拉相贴 0.5pt（2026-10-05 评审「像断掉的梯子」）。
    let height = if same_line {
        metrics.button_height + SELECT_ROW_GAP
    } else {
        metrics.button_height * 2.0 + SELECT_ROW_GAP
    };
    if y0 + height > max_height {
        return None;
    }
    let clamped_label = label_width.min(inner_width);
    let label_frame = PanelFrame {
        x: metrics.pad_x,
        y: y0,
        width: clamped_label,
        height: metrics.button_height,
    };
    let frame = PanelFrame {
        x: if same_line {
            // 下拉右对齐内容右缘（2026-10-05 复评方案 A）：同排时标签左、控件右，
            // 与设置页「标签左/控件右」同一网格语法——参数行与下方左对齐的
            // 动作 chip 行形成两种行型，分组靠形式而非空隙（零高度成本）。
            metrics.pad_x + inner_width - select_width
        } else {
            metrics.pad_x
        },
        y: if same_line {
            y0
        } else {
            y0 + metrics.button_height
        },
        width: select_width,
        height: metrics.button_height,
    };
    out.push(PanelElement::Select {
        label: select.label.clone(),
        options: select.options.clone(),
        selected: select.selected.min(select.options.len().saturating_sub(1)),
        label_frame,
        frame,
    });
    Some(y0 + height)
}

/// 一行按钮（可选行首标签）的流式摆放：放不下就换行。
fn place_button_flow(
    label: Option<(&str, PanelLineStyle)>,
    buttons: &[PanelButton],
    y0: f64,
    inner_width: f64,
    out: &mut Vec<PanelElement>,
) {
    let metrics = PANEL_METRICS;
    let x0 = metrics.pad_x;
    let mut y = y0;
    let mut x = x0;

    if let Some((text, style)) = label {
        let label_width = flow_label_width(text, buttons, inner_width);
        out.push(PanelElement::Line {
            text: text.to_string(),
            style,
            frame: PanelFrame {
                x,
                y,
                width: label_width,
                height: if buttons.is_empty() {
                    metrics.line_height
                } else {
                    metrics.button_height
                },
            },
        });
        x += label_width + metrics.label_gap;
    }

    for button in buttons {
        let width = panel_button_width(&button.label).min(inner_width);
        if x + width > x0 + inner_width && x > x0 {
            // 放不下：换到下一行（行首对齐内容区左边）。
            x = x0;
            y += metrics.button_height;
        }
        out.push(PanelElement::Button {
            label: button.label.clone(),
            action: button.action.clone(),
            link: button.link,
            frame: PanelFrame {
                x,
                y,
                width,
                height: metrics.button_height,
            },
        });
        x += width + metrics.button_gap;
    }
}

/// 行首标签宽度：给第一个按钮留出位置后的剩余空间内取估算宽度（不挤掉按钮）。
fn flow_label_width(text: &str, buttons: &[PanelButton], inner_width: f64) -> f64 {
    let metrics = PANEL_METRICS;
    let first_button = buttons
        .first()
        .map(|b| panel_button_width(&b.label))
        .unwrap_or(0.0);
    let reserve = if buttons.is_empty() {
        inner_width
    } else {
        (inner_width - first_button - metrics.label_gap).max(metrics.min_label_width)
    };
    estimated_text_width(text, metrics.text_size)
        .min(reserve)
        .max(metrics.min_label_width)
}

/// 一行按钮流的实际高度（含行首标签占的行；无按钮时就是一行文本的高度）。
fn button_flow_height(
    label: Option<(&str, PanelLineStyle)>,
    buttons: &[PanelButton],
    inner_width: f64,
) -> f64 {
    let metrics = PANEL_METRICS;
    let x0 = metrics.pad_x;
    let mut lines = 1usize;
    let mut x = x0;
    if let Some((text, _)) = label {
        x += flow_label_width(text, buttons, inner_width) + metrics.label_gap;
    }
    for button in buttons {
        let width = panel_button_width(&button.label).min(inner_width);
        if x + width > x0 + inner_width && x > x0 {
            x = x0;
            lines += 1;
        }
        x += width + metrics.button_gap;
    }
    if buttons.is_empty() {
        return metrics.line_height;
    }
    lines as f64 * metrics.button_height
}

/// 面板命中判定（纯函数，与平台层实际建出的控件同源）：
/// 返回点 `(x, y)`（容器坐标系，左上原点）命中的按钮动作。
///
/// 只有被摆放出来的按钮（含文字链）才可能命中；点落在标签、下拉框、空白或
/// 容器外一律 `None` —— 下拉的命中由原生控件自身处理，不经过本函数。
/// 运行期两平台都建真控件（命中由 AppKit / Win32 负责），本函数是布局
/// 回归测试的几何证明工具（按钮中心必须命中自己）。
pub fn hit_test_panels(layout: &PanelsLayout, x: f64, y: f64) -> Option<PanelAction> {
    layout
        .elements
        .iter()
        .rev()
        .find_map(|element| match element {
            PanelElement::Button { action, frame, .. } if frame.contains(x, y) => {
                Some(action.clone())
            }
            _ => None,
        })
}

/// 哈希短前缀（绑定信息展示用；空串返回 None）。
pub fn short_hash(hash: Option<&str>) -> Option<String> {
    let hash = hash?.trim();
    if hash.is_empty() {
        return None;
    }
    Some(hash.chars().take(6).collect())
}

// `format_expiry` 删除记录（2026-10-06）：权限确认不再有有效期（选择类弹窗不留超时，
// 面板上的「有效期至」随之退场），唯一消费者消失后函数一并删除。

/// 会话创建时间（epoch 毫秒）→ `MM月DD日 HH:MM`；缺失或非法返回 None。
///
/// 本地日期展示（`MM月DD日 HH:MM`；对应 zh-CN 的「月日 + 时分」输出口径）。
pub fn format_session_date(created_at_ms: i64) -> Option<String> {
    if created_at_ms <= 0 {
        return None;
    }
    use chrono::TimeZone;
    let at = chrono::Local.timestamp_millis_opt(created_at_ms).single()?;
    Some(at.format("%m月%d日 %H:%M").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token格式化与既定口径一致() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(12345), "12.3k");
    }

    #[test]
    fn 预览压平空白并按字符截断() {
        assert_eq!(preview_text(" a\t b\n cc "), "a b cc");
        let long: String = "中".repeat(70);
        let preview = preview_text(&long);
        assert_eq!(preview.chars().count(), 61, "60 字符 + 省略号");
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn 星级按复杂度夹到五档() {
        assert_eq!(complexity_stars(0), "☆☆☆☆☆");
        assert_eq!(complexity_stars(3), "★★★☆☆");
        assert_eq!(complexity_stars(9), "★★★★★");
    }

    #[test]
    fn 工具参数摘要单行化并按上限截断() {
        // 空/全空白：不产生摘要（卡片只显示工具名）。
        assert_eq!(tool_call_arguments_preview(""), None);
        assert_eq!(tool_call_arguments_preview("  \n\t "), None);
        // 换行/制表压平为单空格；JSON 原文不解析、不转义。
        assert_eq!(
            tool_call_arguments_preview("{\"path\":\n\t\"/tmp/a\"}").as_deref(),
            Some("{\"path\": \"/tmp/a\"}")
        );
        // 超上限按字符截断（CJK 也按字符数，不按字节）。
        let long = "中".repeat(TOOL_CALL_ARGUMENTS_PREVIEW_CHARS + 10);
        let preview = tool_call_arguments_preview(&long).expect("长参数有摘要");
        assert_eq!(
            preview.chars().count(),
            TOOL_CALL_ARGUMENTS_PREVIEW_CHARS + 1
        );
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn 工具卡标题与思考开关文案() {
        assert_eq!(tool_call_card_title(" fs.read "), "工具调用 · fs.read");
        assert_eq!(tool_call_card_title("   "), "工具调用");
        assert_eq!(thinking_toggle_label(false), "思考 ▸");
        assert_eq!(thinking_toggle_label(true), "思考 ▾");
    }

    #[test]
    fn 短哈希截断且空值省略() {
        assert_eq!(short_hash(Some("abcdef123456")).as_deref(), Some("abcdef"));
        assert!(short_hash(None).is_none());
        assert!(short_hash(Some("  ")).is_none());
    }

    #[test]
    fn 文本宽度粗估按全角半角分档() {
        assert!(estimated_text_width("全部执行", 12.0) > estimated_text_width("ok", 12.0));
        let width = estimated_text_width("ab", 10.0);
        assert!((width - 12.0).abs() < f64::EPSILON);
    }

    #[test]
    fn 会话日期格式化对非法值返回none() {
        assert!(format_session_date(0).is_none());
        assert!(format_session_date(-1).is_none());
        let formatted = format_session_date(1_728_000_000_000).expect("合法时间戳可格式化");
        // 「MM月DD日 HH:MM」的形状（具体日期随时区变化，只钉形状与结尾）。
        assert!(
            formatted.ends_with("日 00:00") || formatted.contains("月"),
            "格式化结果: {formatted}"
        );
        assert_eq!(formatted.chars().filter(|c| *c == '月').count(), 1);
    }

    // ── 面板摆放几何的回归测试（历史缺陷：按钮越界被窗口边缘裁掉 → 点不到；
    //    内容超出后直接丢弃 → 用户点的是不存在的位置）──

    /// 构造一个含 N 个选项的下拉（选项标签重复撑宽）。
    fn test_select(label: &str, option_count: usize) -> PanelSelect {
        PanelSelect {
            label: label.to_string(),
            options: (0..option_count)
                .map(|i| PanelOption {
                    label: format!("选项{i}号"),
                    action: PanelAction::ToggleDebugTools,
                })
                .collect(),
            selected: 0,
        }
    }

    fn all_elements_inside(layout: &PanelsLayout, width: f64) -> bool {
        layout.elements.iter().all(|element| {
            element.frame().x >= 0.0 && element.frame().right() <= width + f64::EPSILON
        })
    }

    #[test]
    fn 行内按钮放不下时换行且不越界() {
        // 窄容器 + 一排长按钮：旧实现在这里让按钮越出右边界（被裁掉后点不到）。
        let view = PanelView::new(PanelKind::DebugBar)
            .button("一个相当长的按钮标题文本", PanelAction::ToggleDebugTools)
            .button("另一个同样很长很长的按钮", PanelAction::ToggleUsage)
            .button("短按钮", PanelAction::ToggleDebugRegistry);
        let width = 160.0;
        let layout = layout_panels(&[view], width, 10_000.0);
        assert!(!layout.elements.is_empty(), "按钮必须被摆出来");
        assert!(
            all_elements_inside(&layout, width),
            "任何元素的 frame 不得越出容器"
        );
        // 按钮之间不得重叠（同一行的相邻按钮间距 ≥ 0）。
        let buttons: Vec<_> = layout
            .elements
            .iter()
            .filter_map(|e| match e {
                PanelElement::Button { frame, .. } => Some(*frame),
                _ => None,
            })
            .collect();
        for pair in buttons.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let same_row = (a.y - b.y).abs() < f64::EPSILON;
            if same_row {
                assert!(
                    a.right() <= b.x + f64::EPSILON,
                    "同一行按钮重叠：{a:?} {b:?}"
                );
            }
        }
    }

    #[test]
    fn 空间不足时跳过整块并置位截断() {
        // 容器只够一个块：第一个块（文本行）放下，后续交互块整块跳过、truncated 置位。
        let view = PanelView::new(PanelKind::DebugBar)
            .line(PanelLineStyle::Dim, "第一行")
            .button("按钮", PanelAction::ToggleDebugTools);
        let metrics = PANEL_METRICS;
        let layout = layout_panels(&[view], 200.0, metrics.line_height);
        assert!(
            layout.truncated,
            "有块被跳过时必须置位 truncated（平台层留痕）"
        );
        assert!(all_elements_inside(&layout, 200.0));
        // 被跳过的交互块不得留下任何半截 frame（不允许「看得到点不到」）。
        assert!(
            !layout
                .elements
                .iter()
                .any(|e| matches!(e, PanelElement::Button { .. })),
            "放不下整块的按钮不产生 frame"
        );
    }

    #[test]
    fn 块按声明顺序摆放且按钮聚组() {
        let view = PanelView::new(PanelKind::DebugBar)
            .line(PanelLineStyle::Dim, "甲")
            .button("乙", PanelAction::ToggleDebugTools)
            .button("丙", PanelAction::ToggleUsage)
            .line(PanelLineStyle::Dim, "丁");
        let layout = layout_panels(&[view], 400.0, 10_000.0);
        let kinds: Vec<&str> = layout
            .elements
            .iter()
            .map(|e| match e {
                PanelElement::Line { text, .. } => text.as_str(),
                PanelElement::Button { label, .. } => label.as_str(),
                PanelElement::Select { .. } => "select",
                PanelElement::Card { .. } => "card",
            })
            .collect();
        // 声明顺序 = 摆放顺序（保序）；连续按钮并排在同一行。
        assert_eq!(kinds, vec!["甲", "乙", "丙", "丁"]);
        let y_of = |label: &str| {
            layout
                .elements
                .iter()
                .find_map(|e| match e {
                    PanelElement::Button {
                        label: l, frame, ..
                    } if l == label => Some(frame.y),
                    _ => None,
                })
                .expect("按钮存在")
        };
        assert!(
            (y_of("乙") - y_of("丙")).abs() < f64::EPSILON,
            "连续按钮在同一行"
        );
    }

    #[test]
    fn 下拉生成标签与框两帧且命中不入按钮通道() {
        let view = PanelView::new(PanelKind::DebugBar).select(test_select("思考强度", 5));
        let width = 320.0;
        let layout = layout_panels(&[view], width, 10_000.0);
        let (label_frame, frame, selected) = layout
            .elements
            .iter()
            .find_map(|e| match e {
                PanelElement::Select {
                    label_frame,
                    frame,
                    selected,
                    ..
                } => Some((*label_frame, *frame, *selected)),
                _ => None,
            })
            .expect("下拉被摆出来");
        assert!(all_elements_inside(&layout, width));
        assert!(
            label_frame.right() <= frame.x + f64::EPSILON,
            "标签在框的左侧或上一行"
        );
        // 下拉框不产生按钮命中（命中由原生控件处理）。
        let center = (frame.x + frame.width / 2.0, frame.y + frame.height / 2.0);
        assert!(hit_test_panels(&layout, center.0, center.1).is_none());
        assert_eq!(selected, 0);
    }

    #[test]
    fn 下拉选中下标越界被夹取() {
        let mut select = test_select("安全策略", 4);
        select.selected = 99;
        let view = PanelView::new(PanelKind::DebugBar).select(select);
        let layout = layout_panels(&[view], 320.0, 10_000.0);
        let selected = layout
            .elements
            .iter()
            .find_map(|e| match e {
                PanelElement::Select { selected, .. } => Some(*selected),
                _ => None,
            })
            .expect("下拉被摆出来");
        assert_eq!(selected, 3, "越界下标夹到最后一项");
    }

    #[test]
    fn 按钮中心命中自己而空白命中无() {
        let view = PanelView::new(PanelKind::DebugBar)
            .button("按钮甲", PanelAction::ToggleDebugTools)
            .button("按钮乙", PanelAction::ToggleUsage);
        let layout = layout_panels(&[view], 400.0, 10_000.0);
        for element in &layout.elements {
            if let PanelElement::Button { action, frame, .. } = element {
                let cx = frame.x + frame.width / 2.0;
                let cy = frame.y + frame.height / 2.0;
                assert_eq!(
                    hit_test_panels(&layout, cx, cy),
                    Some(action.clone()),
                    "按钮中心必须命中自己"
                );
            }
        }
        assert!(
            hit_test_panels(&layout, -5.0, -5.0).is_none(),
            "容器外不命中"
        );
    }

    #[test]
    fn 极窄容器下元素宽度仍受约束() {
        // 容器比最小内容区还窄：宽度被抬到 min_inner_width，但控件宽度以容器为准。
        let view = PanelView::new(PanelKind::DebugBar).select(test_select("思考强度", 5));
        let layout = layout_panels(&[view], 60.0, 10_000.0);
        assert!(all_elements_inside(&layout, 60.0), "极窄容器下也不越界");
    }

    #[test]
    fn 气泡宽度贴合内容并夹取上下限() {
        // 短消息：自然宽 = 40 + 左右内边距 20 + 描边位 2 = 62，就是泡宽。
        assert_eq!(bubble_content_width(40.0, false, 0.0, 200.0), 62.0);
        // 极短消息（量测失效 used=0）：落回下限，不塌成一片。
        assert_eq!(
            bubble_content_width(0.0, false, 0.0, 200.0),
            BUBBLE_MIN_WIDTH
        );
        // 长消息：夹在上限（不撑出列宽）。
        assert_eq!(bubble_content_width(500.0, false, 0.0, 200.0), 200.0);
        // footer（「记住这条」）比正文宽：泡宽随 footer = 80 + 20。
        assert_eq!(bubble_content_width(30.0, false, 80.0, 200.0), 100.0);
        // 含代码块：直接给上限（代码块要横向空间）。
        assert_eq!(bubble_content_width(10.0, true, 0.0, 200.0), 200.0);
    }

    #[test]
    fn 气泡上限按列宽八成六() {
        // 300 宽容器：贴边留白 12 → 288 × 0.86 = 247.68。
        assert!((bubble_cap(300.0) - 247.68).abs() < 0.01);
        // 极窄容器：保住可读下限 40。
        assert_eq!(bubble_cap(20.0), 40.0);
    }

    #[test]
    fn 说话人标签口径() {
        use super::super::model::Role;
        // 用户条目不摆「你」；助手空名不摆空标签；工具失败带后缀。
        assert_eq!(role_label_text(Role::User, "糖糖", false), None);
        assert_eq!(role_label_text(Role::Assistant, "   ", false), None);
        assert_eq!(
            role_label_text(Role::Assistant, "糖糖", false),
            Some("糖糖".to_string())
        );
        assert_eq!(
            role_label_text(Role::System, "", false),
            Some("系统".to_string())
        );
        assert_eq!(
            role_label_text(Role::Tool, "", false),
            Some("工具".to_string())
        );
        assert_eq!(
            role_label_text(Role::Tool, "", true),
            Some("工具 · 失败".to_string())
        );
    }

    #[test]
    fn 空行分段成多条气泡() {
        assert_eq!(
            split_paragraphs("看到了\n\n在改 Desk-Pet\n\n周末也这么拼"),
            vec!["看到了", "在改 Desk-Pet", "周末也这么拼"]
        );
        // 段内单个换行保持同段（同一泡内的折行不分条）。
        assert_eq!(
            split_paragraphs("line one\nline two"),
            vec!["line one\nline two"]
        );
        // 连续多个空行折叠，不产生空段。
        assert_eq!(split_paragraphs("a\n\n\n\nb"), vec!["a", "b"]);
        // 尾随空行不产生尾空段。
        assert_eq!(split_paragraphs("a\n\nb\n\n"), vec!["a", "b"]);
        // 无空行 = 单段原样。
        assert_eq!(split_paragraphs("只有一段"), vec!["只有一段"]);
    }

    #[test]
    fn 代码块正文不拆() {
        assert_eq!(
            split_paragraphs("看这个\n\n```ts\nconst a = 1\n```"),
            vec!["看这个\n\n```ts\nconst a = 1\n```"]
        );
    }

    /// 呈现面分类：每个 `PanelKind` 恰好归一类，且决策面板一个都不能进浮层
    /// （进了就会被折叠隐藏，挡住许可确认与计划门）。
    #[test]
    fn 面板呈现面分类() {
        // 用量 / 调试 / 投递 → 同一个浮层（输入区上方的把手开合）。
        assert_eq!(PanelKind::Usage.surface(), PanelSurface::Inspector);
        assert_eq!(PanelKind::DebugBar.surface(), PanelSurface::Inspector);
        // 投递与用量/调试同浮层（用户第二次改版：底下那排 chip 整个撤掉，只剩一个把手）。
        assert_eq!(PanelKind::Delivery.surface(), PanelSurface::Inspector);
        // slash 候选与输入区联动，留在流内（紧贴输入区之上），不进 meta 轨。
        assert_eq!(
            PanelKind::SlashCandidates.surface(),
            PanelSurface::Transient
        );
        // 会话历史**不进流内面板栈**：挂在「历史」按钮下方，否则会跑到页面底部，
        // 与触发它的按钮隔着大半屏。
        assert_eq!(
            PanelKind::SessionHistory.surface(),
            PanelSurface::Anchored(AnchorTarget::HistoryButton)
        );
        // 要拍板的决策面板必须留在流内、始终可见。
        for kind in [
            PanelKind::Plan,
            PanelKind::RecoveredPlan,
            PanelKind::Permission,
            PanelKind::Choice,
            PanelKind::Interrupted,
            PanelKind::Queue,
        ] {
            assert_eq!(kind.surface(), PanelSurface::Decision, "{kind:?}");
        }
    }

    /// 两平台对称（native-host AGENTS §2）：「其它」点击后要把焦点交回输入框
    /// （用户下一条消息就是自由回答）—— 新 `PanelOutcome::FocusInput` 必须在
    /// macOS 与 Windows 两侧都真的接上。本机编不出 Windows 分支（§2），
    /// 只能靠源码级守门（与「两平台都接上卡片底板绘制」同款的静态检查）。
    #[test]
    fn 两平台都接上提问面板的聚焦回填() {
        // `include_str!` 让两份平台源码成为编译期依赖：删掉任一侧的处理分支，
        // 本用例立刻断言失败，而不是静默只在一半平台生效。
        const MACOS: &str = include_str!("../platform/macos_chat.rs");
        const WINDOWS: &str = include_str!("../platform/windows_chat.rs");
        for (name, source) in [("macos_chat.rs", MACOS), ("windows_chat.rs", WINDOWS)] {
            assert!(
                source.contains("PanelOutcome::FocusInput"),
                "{name} 必须处理 PanelOutcome::FocusInput（否则「其它」只在一半平台把焦点交回输入框）"
            );
        }
        // macOS 的聚焦走既有 `focus_input`（不改文本）；Windows 走既有 `focus_main_pane_input`。
        assert!(
            MACOS.contains("self.focus_input()"),
            "macos_chat.rs 没有调用既有的输入框聚焦函数"
        );
        assert!(
            WINDOWS.contains("focus_main_pane_input()"),
            "windows_chat.rs 没有调用既有的输入框聚焦函数"
        );
    }

    #[test]
    fn chip文案中段省略保住头尾且不超预算() {
        let short = "图片 1 · a.png";
        assert_eq!(fit_chip_label(short, 400.0), short, "放得下不改写");

        let long = "图片 1 · 1791084123556.png（不可用）";
        let budget = 120.0;
        let fitted = fit_chip_label(long, budget);
        assert!(
            estimated_text_width(&fitted, 11.0) <= budget - 22.0 + 1e-6,
            "结果宽度 {:.1} 超出预算",
            estimated_text_width(&fitted, 11.0)
        );
        assert!(fitted.starts_with("图片"), "头部信息保留：{fitted}");
        assert!(fitted.ends_with('）'), "尾部状态后缀保留：{fitted}");
        assert!(fitted.contains('…'), "中段可见省略号：{fitted}");
        assert!(fitted.chars().count() >= 6, "不得退化成空 chip：{fitted}");
    }

    // ── 卡片（`PanelBlock::Card`）的几何回归测试 ──
    //
    // 用户报告「各个会话应该用气泡，不然看不清，按钮也错位了」：卡片给每项一个
    // 可见边界。底板必须包住内部元素、四周留出内边距，且**排在内部元素之前**
    // （平台按顺序建控件/图层，先建的在下层；底板排在后面会把内容盖住）。

    fn card_line(text: &str) -> PanelBlock {
        PanelBlock::Line {
            style: PanelLineStyle::Normal,
            text: text.to_string(),
        }
    }

    /// 卡片行数 / 内边距 / 上下留白的共用样例（近似会话历史的一条）。
    fn session_card(name: &str) -> PanelBlock {
        PanelBlock::Card(vec![
            PanelBlock::Line {
                style: PanelLineStyle::Normal,
                text: name.to_string(),
            },
            PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: "10月05日 16:32 · 3 条".to_string(),
            },
            PanelBlock::Buttons(vec![
                PanelButton::new("恢复", PanelAction::ToggleDebugTools),
                PanelButton::new("删除", PanelAction::ToggleUsage),
            ]),
        ])
    }

    fn card_frames(layout: &PanelsLayout) -> Vec<PanelFrame> {
        layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Card { frame } => Some(*frame),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn 卡片底板排在内部元素之前且包住全部内部元素() {
        let metrics = PANEL_METRICS;
        let view = PanelView::new(PanelKind::SessionHistory).card(vec![
            PanelBlock::Line {
                style: PanelLineStyle::Normal,
                text: "会话名".to_string(),
            },
            PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: "10月05日 16:32 · 3 条".to_string(),
            },
            PanelBlock::Buttons(vec![
                PanelButton::new("恢复", PanelAction::ToggleDebugTools),
                PanelButton::new("删除", PanelAction::ToggleUsage),
            ]),
        ]);
        let width = 280.0;
        let layout = layout_panels(&[view], width, 10_000.0);
        let card_index = layout
            .elements
            .iter()
            .position(|element| matches!(element, PanelElement::Card { .. }))
            .expect("卡片底板被摆出来");
        assert_eq!(
            card_index, 0,
            "底板必须排在内部元素之前（平台按顺序建控件：先建的在下层，底板才不会被盖住）"
        );
        let card = match &layout.elements[0] {
            PanelElement::Card { frame } => *frame,
            _ => unreachable!(),
        };
        let inner: Vec<&PanelElement> = layout.elements[1..].iter().collect();
        assert!(!inner.is_empty(), "卡片内部元素在底板之后依次摆放");
        for element in &inner {
            let frame = element.frame();
            assert!(
                frame.x >= card.x + metrics.card_pad_x - 1e-6
                    && frame.right() <= card.right() - metrics.card_pad_x + 1e-6
                    && frame.y >= card.y + metrics.card_pad_y - 1e-6
                    && frame.bottom() <= card.bottom() - metrics.card_pad_y + 1e-6,
                "内部元素必须落在内边距之内：{frame:?} / 卡片 {card:?}"
            );
        }
        // 内边距是「贴边量」：第一块贴左上内沿、最后一块贴下内沿。
        let first = inner.first().expect("有内部元素").frame();
        let content_bottom = inner
            .iter()
            .map(|element| element.frame().bottom())
            .fold(0.0, f64::max);
        assert!(
            (first.x - (card.x + metrics.card_pad_x)).abs() < 1e-6
                && (first.y - (card.y + metrics.card_pad_y)).abs() < 1e-6,
            "第一块从左上内沿起排：{first:?} / 卡片 {card:?}"
        );
        assert!(
            (card.bottom() - (content_bottom + metrics.card_pad_y)).abs() < 1e-6,
            "卡片高按内容收口（内容底 + 下内边距）：卡片 {card:?}"
        );
        assert!(
            all_elements_inside(&layout, width),
            "含底板的全部 frame 不得越出容器"
        );
    }

    #[test]
    fn 卡片里的按钮同一行不换行() {
        // 用户报的「按钮错位」：窄容器里两个按钮必须并排，不得上下错开
        // （样例就是会话历史一条的形状：长名字 + 日期条数 + 两个操作按钮）。
        let view = PanelView {
            kind: PanelKind::SessionHistory,
            blocks: vec![session_card("一个相当长的会话名字用来挤宽度")],
        };
        let layout = layout_panels(&[view], 280.0, 10_000.0);
        let mut rows: Vec<f64> = Vec::new();
        for element in &layout.elements {
            if let PanelElement::Button { frame, .. } = element {
                rows.push(frame.y);
            }
        }
        assert_eq!(rows.len(), 2, "两个按钮都被摆出来");
        assert!(
            (rows[0] - rows[1]).abs() < 1e-6,
            "卡片里的按钮在同一行（用户报告的按钮错位）：{rows:?}"
        );
        // 两个按钮都在卡片框内（不错位到卡片外）。
        let card = card_frames(&layout);
        assert_eq!(card.len(), 1);
        for element in &layout.elements {
            if let PanelElement::Button { frame, .. } = element {
                assert!(
                    frame.x >= card[0].x && frame.right() <= card[0].right(),
                    "按钮在卡片横向范围内：{frame:?} / 卡片 {:?}",
                    card[0]
                );
            }
        }
    }

    #[test]
    fn 内部块全放不下时不产卡片() {
        let metrics = PANEL_METRICS;
        let view = PanelView::new(PanelKind::SessionHistory).card(vec![card_line("会话名")]);
        // 容器高度只够卡片内边距：内部一块也放不下 → 空框比不画更糟（不产任何 frame）。
        let layout = layout_panels(&[view], 280.0, metrics.card_pad_y * 2.0 - 1.0);
        assert!(
            layout.elements.is_empty(),
            "放不下任何内部块时不产底板也不产内容：{:?}",
            layout.elements
        );
        assert!(
            layout.truncated,
            "被跳过的块必须置位 truncated（平台层留痕）"
        );
    }

    #[test]
    fn 卡片内部分块放不下时保留已放下的并置位截断() {
        let metrics = PANEL_METRICS;
        let view = PanelView::new(PanelKind::SessionHistory)
            .card(vec![card_line("第一行"), card_line("第二行")]);
        // 内容区高度恰好一行：第一行放下、第二行跳过，卡片仍产出（不整卡吞掉）。
        let max_height = metrics.card_pad_y * 2.0 + metrics.line_height;
        let layout = layout_panels(&[view], 280.0, max_height);
        let cards = card_frames(&layout);
        assert_eq!(cards.len(), 1, "部分放得下时卡片仍然产出");
        assert!(layout.truncated, "卡片内某块放不下即置位 truncated");
        let texts: Vec<&str> = layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Line { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["第一行"], "已放下的块保留、放不下的不产 frame");
        assert!(
            cards[0].bottom() <= max_height + 1e-6,
            "卡片不越出容器下边界：{:?}",
            cards[0]
        );
    }

    #[test]
    fn 空卡片不产底板也不占高度() {
        // 显式的空卡片（模型侧不该产生，几何侧按「不画、不占位、不报截断」处理）。
        let view = PanelView::new(PanelKind::SessionHistory).card(vec![]);
        let layout = layout_panels(&[view], 280.0, 10_000.0);
        assert!(layout.elements.is_empty(), "空卡片不产任何 frame");
        assert!(!layout.truncated, "没有「放不下」的东西，不报截断");
        assert_eq!(layout.height, 0.0, "空卡片不占高度");
    }

    /// 两平台对称（native-host AGENTS §2）：`PanelElement::Card` 的底板必须在
    /// macOS 与 Windows 两侧都真的接上 —— 本机编不出 Windows 分支（§2），
    /// 只能靠源码级守门（与「模态调用站点」同款的静态检查）。
    #[test]
    fn 两平台都接上卡片底板绘制() {
        // `include_str!` 让两份平台源码成为编译期依赖（要的就是这个：删掉任一侧
        // 的卡片分支本用例立刻编译不过/断言失败，而不是静默只在一半平台生效）。
        const MACOS: &str = include_str!("../platform/macos_chat.rs");
        const WINDOWS: &str = include_str!("../platform/windows_chat.rs");
        for (name, source) in [("macos_chat.rs", MACOS), ("windows_chat.rs", WINDOWS)] {
            assert!(
                source.contains("PanelElement::Card { frame } =>"),
                "{name} 必须处理 PanelElement::Card（否则卡片只在一半平台出现）"
            );
        }
        // Windows 的底板走自绘 STATIC：建窗样式与 `WM_DRAWITEM` 绘制分支缺一不可。
        for needle in ["SS_OWNERDRAW", "ODT_STATIC", "fn draw_themed_card"] {
            assert!(
                WINDOWS.contains(needle),
                "windows_chat.rs 缺 {needle}（卡片底板画不出来）"
            );
        }
        // macOS 的底板是图层绘制的独立构造函数（`place_panel_elements` 里调它）。
        assert!(
            MACOS.contains("fn panel_card") && MACOS.contains("panel_card(mtm, *frame)"),
            "macos_chat.rs 的卡片底板构造函数缺失或没被调用"
        );
    }

    #[test]
    fn 相邻卡片留出间距且不重叠() {
        let view = PanelView::new(PanelKind::SessionHistory)
            .card(vec![card_line("甲")])
            .card(vec![card_line("乙")]);
        let layout = layout_panels(&[view], 280.0, 10_000.0);
        let cards = card_frames(&layout);
        assert_eq!(cards.len(), 2, "两张卡各一块底板");
        assert!(
            cards[1].y >= cards[0].bottom() - 1e-6,
            "卡片不得重叠：{:?} / {:?}",
            cards[0],
            cards[1]
        );
        assert!(
            (cards[1].y - cards[0].bottom() - PANEL_METRICS.card_gap).abs() < 1e-6,
            "卡片之间留出间距（贴在一起看不出是一条会话）：{:?} / {:?}",
            cards[0],
            cards[1]
        );
        // 每块底板只包住自己的行。
        let line_y = |text: &str| {
            layout
                .elements
                .iter()
                .find_map(|element| match element {
                    PanelElement::Line { text: t, frame, .. } if t == text => Some(*frame),
                    _ => None,
                })
                .expect("行存在")
        };
        let first = line_y("甲");
        let second = line_y("乙");
        assert!(
            first.y >= cards[0].y && first.bottom() <= cards[0].bottom(),
            "「甲」在第一张卡内"
        );
        assert!(
            second.y >= cards[1].y && second.bottom() <= cards[1].bottom(),
            "「乙」在第二张卡内"
        );
    }
}
