//! 整帧快照与面板渲染块（平台层只摆放，不解释状态）。

use crate::ui::settings::schema::DELIVERY;
use super::super::placeholders::placeholder_for;
use super::debug::{debug_spend_line, safety_mode_select, thinking_effort_select};
use super::{
    display_session_name, usage_purpose_label, ChatModel, ChatSnapshot, CommittedMessage,
    MessageSnapshot, StatusSnapshot,
};

impl ChatModel {
    /// 构建整帧快照。
    pub fn snapshot(&self) -> ChatSnapshot {
        ChatSnapshot {
            active_session: self.active_session.clone(),
            speaker: self.speaker.clone(),
            messages: self
                .messages
                .iter()
                .map(|message| {
                    let visible = self.visible_part_count(message);
                    MessageSnapshot {
                        id: message.id.clone(),
                        event_id: message.event_id.clone(),
                        role: message.role,
                        visible_parts: message.parts.iter().take(visible).cloned().collect(),
                        pending_parts: message.parts.len().saturating_sub(visible),
                        images: message
                            .image_paths
                            .iter()
                            .map(|path| placeholder_for(path))
                            .collect(),
                        timestamp: message.timestamp,
                        thinking: message.thinking.clone(),
                        tool_calls: message.tool_calls.clone(),
                        is_error: message.is_error,
                        tool_call_id: message.tool_call_id.clone(),
                    }
                })
                .collect(),
            streaming: self
                .streaming
                .as_ref()
                .map(|streaming| streaming.text.clone()),
            status: StatusSnapshot {
                text: self.status.text.clone(),
                notice: self.status.notice.clone(),
                running: self.running,
            },
            plan: self.plan.clone(),
            recovered_plans: self.recovered_plans.clone(),
            permission: self.permission.clone(),
            queue: self.queue.clone(),
            interrupted: self.interrupted.clone(),
            usage: self.usage.clone(),
            slash: self.slash_snapshot(),
            default_delivery: self.default_delivery,
            sessions: self.session_tabs(),
            panels: self.panel_views(),
            transcript_revision: self.transcript_revision,
            stream_revision: self.stream_revision,
            status_revision: self.status_revision,
            panel_revision: self.panel_revision,
            tabs_revision: self.tabs_revision,
            pending_images: self.pending_images.clone(),
            pending_revision: self.pending_revision,
            inspector_open: self.inspector_open,
        }
    }

    fn visible_part_count(&self, message: &CommittedMessage) -> usize {
        match self.reveals.get(&message.id) {
            Some(state) => state.revealed.min(message.parts.len()),
            None => message.parts.len(),
        }
    }
}

// ==========================================
// 面板渲染块（平台层只摆放，不解释状态）
// ==========================================

impl ChatModel {
    /// 当前应显示的全部面板（按自上而下的顺序：会话历史 → 权限 → 提问 → 计划 → 待处置 →
    /// 中断 → 队列 → 用量 → 调试条 → 投递 → slash 候选；slash 候选紧挨输入区）。
    pub fn panel_views(&self) -> Vec<super::super::panels::PanelView> {
        let mut views = Vec::new();
        self.push_session_history_panel(&mut views);
        self.push_permission_panel(&mut views);
        self.push_choice_panels(&mut views);
        self.push_plan_panel(&mut views);
        self.push_recovered_plan_panels(&mut views);
        self.push_interrupted_panel(&mut views);
        self.push_queue_panel(&mut views);
        self.push_usage_panel(&mut views);
        self.push_debug_panel(&mut views);
        self.push_delivery_panel(&mut views);
        self.push_slash_panel(&mut views);
        views
    }

    /// 会话历史面板（A1）：**每个会话一个卡片**（名字 / 日期·条数 / 操作按钮各占一行）；
    /// 底部「刷新 / 关闭」。
    ///
    /// 卡片（而不是行内按钮）的理由：弹层很窄（内容宽 ~280pt），旧版把
    /// `名字（日期 · N 条）` + 行内「恢复 / 删除」塞进一条 `Row`，稍长的会话名就把
    /// 第二个按钮挤到下一行，几项会话糊成一片、按钮左右不齐（用户报告「各个会话
    /// 应该用气泡，不然看不清，按钮也错位了」）。卡片给每项一个可见边界，
    /// 按钮独占一行后不会再被挤换行。
    ///
    /// 状态语义：读取失败与「确实没有历史」呈现不同（两者可区分）。
    fn push_session_history_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{
            PanelAction, PanelBlock, PanelButton, PanelKind, PanelLineStyle, PanelView,
        };
        if !self.history_open {
            return;
        }
        let mut view = PanelView::new(PanelKind::SessionHistory);
        view = view.line(PanelLineStyle::Dim, "会话历史");
        if self.history_refreshing {
            view = view.line(PanelLineStyle::Dim, "正在读取…");
        }
        if self.history_error {
            view = view.line(PanelLineStyle::Warn, "历史会话读取失败，请查看日志");
        } else if !self.history_loaded {
            view = view.line(PanelLineStyle::Dim, "尚未载入");
        } else if self.history_sessions.is_empty() {
            view = view.line(PanelLineStyle::Dim, "暂无历史会话");
        }
        for session in &self.history_sessions {
            let name = display_session_name(&session.name);
            // 列表按**用户活动时间**倒序（Node 侧排好），卡片日期取同一口径：活动时间缺省
            // （没有用户消息）回退创建时间 —— 显示与排序不各用一套时间。
            let displayed_at = session.activity_at.unwrap_or(session.created_at);
            let meta = match super::super::panels::format_session_date(displayed_at) {
                Some(date) => format!("{date} · {} 条", session.message_count),
                None => format!("{} 条", session.message_count),
            };
            view = view.card(vec![
                PanelBlock::Line {
                    style: PanelLineStyle::Normal,
                    text: name,
                },
                // 日期/条数是次要信息：独立一行 + Dim（名字独占一行不挤）。
                PanelBlock::Line {
                    style: PanelLineStyle::Dim,
                    text: meta,
                },
                PanelBlock::Buttons(vec![
                    PanelButton::new(
                        "恢复",
                        PanelAction::RestoreSessionFromHistory {
                            session_id: session.id.clone(),
                        },
                    ),
                    PanelButton::new(
                        "删除",
                        PanelAction::DeleteSessionFromHistory {
                            session_id: session.id.clone(),
                        },
                    ),
                ]),
            ]);
        }
        view = view.button("刷新", PanelAction::RefreshSessionHistory);
        view = view.button("关闭", PanelAction::CloseSessionHistory);
        out.push(view);
    }

    fn push_plan_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(plan) = &self.plan else { return };
        let mut view = PanelView::new(PanelKind::Plan);
        // 目标摘要是用户确认的对象（步骤只是拆解）；空串不占一行。
        if !plan.summary.trim().is_empty() {
            view = view.line(PanelLineStyle::Dim, format!("目标：{}", plan.summary));
        }
        if plan.executing {
            let total = plan.total.max(plan.steps.len() as u32);
            view = view.line(
                PanelLineStyle::Normal,
                format!("执行中 ({}/{total})", plan.current_index),
            );
        } else {
            view = view.line(
                PanelLineStyle::Normal,
                format!(
                    "任务分析  {}",
                    super::super::panels::complexity_stars(plan.complexity)
                ),
            );
        }
        for step in &plan.steps {
            let style = match step.status {
                Some(super::super::events::PlanStepStatus::Failed) => PanelLineStyle::Warn,
                Some(super::super::events::PlanStepStatus::Done) => PanelLineStyle::Dim,
                _ => PanelLineStyle::Normal,
            };
            // 权限面与步骤同排：用户确认的是「这一步能做什么」，不只是描述。
            let tools = if step.allowed_tools.is_empty() {
                String::new()
            } else {
                format!("（工具：{}）", step.allowed_tools.join("、"))
            };
            view = view.line(
                style,
                format!("[{}] {}{tools}", step.marker(), step.description),
            );
        }
        if let Some(gate) = &plan.gate {
            use super::super::events::PlanGateKind;
            let (style, text) = match gate.kind {
                PlanGateKind::Approval => (
                    PanelLineStyle::Dim,
                    format!("下一步：{}", gate.step_description),
                ),
                PlanGateKind::Failed => (
                    PanelLineStyle::Warn,
                    format!("步骤失败：{}", gate.error.as_deref().unwrap_or("未知错误")),
                ),
            };
            view = view.line(style, text);
        }
        if !plan.executing {
            if !plan.force_step_by_step {
                view = view.button("全部执行", PanelAction::PlanConfirmAll);
            }
            view = view.button("逐步确认", PanelAction::PlanConfirmStepByStep);
            view = view.button("取消", PanelAction::PlanCancel);
        } else if let Some(gate) = &plan.gate {
            let continue_label = match gate.kind {
                super::super::events::PlanGateKind::Failed => "继续",
                super::super::events::PlanGateKind::Approval => "执行下一步",
            };
            view = view.button(continue_label, PanelAction::PlanGateContinue);
            view = view.button("中止", PanelAction::PlanGateAbort);
        } else {
            view = view.button("终止执行", PanelAction::PlanAbortExecution);
        }
        out.push(view);
    }

    fn push_recovered_plan_panels(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        use super::super::projection::ProjectedRecoveredStepState as Step;
        for plan in &self.recovered_plans {
            let mut view = PanelView::new(PanelKind::RecoveredPlan);
            view = view.line(
                PanelLineStyle::Normal,
                format!(
                    "上次的计划还没跑完：{}。继续只跑剩下的步骤，未知副作用步骤不会自动重跑 —— 需要你先标记或选择重跑。",
                    plan.summary
                ),
            );
            for step in &plan.steps {
                let (marker, label, style) = match step.state {
                    Step::Pending => ("--", "待执行", PanelLineStyle::Normal),
                    Step::Running => ("..", "待重跑", PanelLineStyle::Normal),
                    Step::Done => ("OK", "已完成", PanelLineStyle::Dim),
                    Step::Failed => ("XX", "失败", PanelLineStyle::Warn),
                    Step::Skipped => ("--", "已跳过", PanelLineStyle::Dim),
                    Step::Interrupted => ("..", "已中断", PanelLineStyle::Warn),
                    Step::UnknownSideEffect => ("??", "未知副作用", PanelLineStyle::Warn),
                };
                let buttons = if step.state == Step::UnknownSideEffect {
                    vec![
                        PanelButton::new(
                            "标记为已完成",
                            PanelAction::PlanStepAlreadyApplied {
                                plan_id: plan.plan_id.clone(),
                                step_id: step.step_id.clone(),
                            },
                        ),
                        PanelButton::new(
                            "重跑此步",
                            PanelAction::PlanStepRetry {
                                plan_id: plan.plan_id.clone(),
                                step_id: step.step_id.clone(),
                            },
                        ),
                    ]
                } else {
                    Vec::new()
                };
                view = view.row_styled(
                    style,
                    format!("[{marker}] {}（{label}）", step.title),
                    buttons,
                );
            }
            view = view.button(
                "继续",
                PanelAction::PlanResume {
                    plan_id: plan.plan_id.clone(),
                },
            );
            view = view.button(
                "丢弃",
                PanelAction::PlanDiscard {
                    plan_id: plan.plan_id.clone(),
                },
            );
            out.push(view);
        }
    }

    fn push_permission_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{
            PanelAction, PanelBlock, PanelButton, PanelKind, PanelLineStyle, PanelView,
        };
        let Some(permission) = &self.permission else {
            return;
        };
        let mut view = PanelView::new(PanelKind::Permission);
        // 权限确认是用户必须处置的阻断卡：内容包进 `Card`（有边界的卡片面），
        // 与其它面板的裸行区分开（用户规则 2026-10-05「权限确认弹窗重做」）。
        let mut blocks: Vec<PanelBlock> = Vec::new();
        blocks.push(PanelBlock::Line {
            style: PanelLineStyle::Warn,
            text: permission.message.clone(),
        });
        if let Some(params) = permission
            .parameter_summary
            .as_deref()
            .filter(|params| !params.trim().is_empty())
        {
            blocks.push(PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: params.to_string(),
            });
        }
        // 绑定信息：会话 / 代际 / 策略与参数指纹（精确参数/策略/会话/代际）。
        // 没有「有效期」一项：等待本身没有超时（2026-10-06 用户裁决）。
        let mut parts: Vec<String> = Vec::new();
        if let Some(session) = permission.session_id.as_deref() {
            parts.push(format!("会话 {session}"));
        }
        if let Some(generation) = permission.run_generation {
            parts.push(format!("代际 {generation}"));
        }
        if let Some(policy) = super::super::panels::short_hash(permission.policy_hash.as_deref()) {
            parts.push(format!("策略 #{policy}"));
        }
        if let Some(input) = super::super::panels::short_hash(permission.input_hash.as_deref()) {
            parts.push(format!("参数 #{input}"));
        }
        if !parts.is_empty() {
            blocks.push(PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: parts.join(" · "),
            });
        }
        blocks.push(PanelBlock::Buttons(vec![
            PanelButton::new("拒绝", PanelAction::PermissionDeny),
            PanelButton::new("本次允许", PanelAction::PermissionAllowOnce),
            PanelButton::new("会话内允许", PanelAction::PermissionAllowSession),
        ]));
        view = view.card(blocks);
        out.push(view);
    }

    /// 提问（`ask_user`）面板：问题 + 选项 +「其它」/「取消」。
    ///
    /// 「其它」与「取消」是面板的固定按钮（不来自模型参数）：前者收起面板、焦点回
    /// 输入框，用户下一条消息就是自由回答；后者按用户取消如实收尾。选项、「其它」、
    /// 「取消」共用一个按钮流（连续声明聚成并排一组、放不下自动换行）：选项与「其它」
    /// 是 chip，「取消」是文字链 —— 点「选项」与点「放弃回答」在视觉上区分得开。
    fn push_choice_panels(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        for choice in &self.choices {
            let mut view = PanelView::new(PanelKind::Choice);
            // 问题按显式换行逐行摆放：面板行是单行控件，长问题里的换行不该被压成一行
            // （空行跳过，全空文本由调用方保证不出现——准入要求 question 非空）。
            for line in choice.question.split('\n') {
                if !line.trim().is_empty() {
                    view = view.line(PanelLineStyle::Normal, line.trim());
                }
            }
            for (index, option) in choice.options.iter().enumerate() {
                view = view.button(
                    option.clone(),
                    PanelAction::ChoicePick {
                        request_id: choice.request_id.clone(),
                        index,
                    },
                );
            }
            view = view.button(
                "其它（自己回答）",
                PanelAction::ChoiceOther {
                    request_id: choice.request_id.clone(),
                },
            );
            view = view.link_button(
                "取消",
                PanelAction::ChoiceCancel {
                    request_id: choice.request_id.clone(),
                },
            );
            out.push(view);
        }
    }

    fn push_interrupted_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(interrupted) = &self.interrupted else {
            return;
        };
        // 提示文案与主回合写下的 `fallbacks.runInterrupted` 同源（Node 投影进 prompts）；
        // 缺失时用中性系统说明，不回落角色台词。
        let text = self
            .prompts
            .get("runInterrupted")
            .cloned()
            .unwrap_or_else(|| super::super::panels::INTERRUPTED_FALLBACK_TEXT.to_string());
        let mut view = PanelView::new(PanelKind::Interrupted);
        view = view.line(PanelLineStyle::Normal, text);
        if interrupted.aborting {
            view = view.line(PanelLineStyle::Dim, "正在停止…");
        }
        view = view.button("继续", PanelAction::InterruptedContinue);
        view = view.button("丢弃", PanelAction::InterruptedDiscard);
        out.push(view);
    }

    fn push_queue_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        use super::super::projection::ProjectedQueuedKind as Kind;
        if self.queue.items.is_empty() {
            return;
        }
        let mut view = PanelView::new(PanelKind::Queue);
        view = view.line(
            PanelLineStyle::Normal,
            format!("排队中 · {}", self.queue.items.len()),
        );
        for item in &self.queue.items {
            let kind = match item.kind {
                Kind::Steer => "插话",
                Kind::FollowUp => "稍后继续",
                Kind::NextRun => "已暂停",
            };
            view = view.row(
                format!("[{kind}] {}", super::super::panels::preview_text(&item.text)),
                vec![PanelButton::new(
                    "撤回",
                    PanelAction::WithdrawQueued {
                        entry_id: item.entry_id.clone(),
                    },
                )],
            );
        }
        let paused = self
            .queue
            .items
            .iter()
            .filter(|item| item.kind == Kind::NextRun)
            .count();
        if paused > 0 {
            view = view.line(
                PanelLineStyle::Dim,
                format!("{paused} 条已暂停，发新消息会先处理它们"),
            );
            view = view.button("继续处理", PanelAction::ResumePaused);
            view = view.button("全部丢弃", PanelAction::DiscardPaused);
        }
        out.push(view);
    }

    fn push_usage_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(usage) = &self.usage else { return };
        let grand: u64 = usage.entries.iter().map(|entry| entry.total).sum();
        // 无任何已回报用量时整条不显示（2026-10-05）：没有数据时「Σ 用量: —」
        // 只是一行占位噪音（用户报告「放一堆 token 字在这，怎么聊天」）；
        // 有数据才给入口（文字链 = 旧壳点击展开明细的形态，明细紧随其后）。
        if grand == 0 {
            return;
        }
        let mut view = PanelView::new(PanelKind::Usage);
        view = view.link_button(
            format!("Σ 用量: {}", super::super::panels::format_tokens(grand)),
            PanelAction::ToggleUsage,
        );
        if usage.expanded {
            for entry in &usage.entries {
                let label = usage_purpose_label(&entry.purpose);
                let text = if entry.reported > 0 {
                    format!(
                        "{label}: 入 {} / 出 {} · {} 次{}",
                        super::super::panels::format_tokens(entry.input),
                        super::super::panels::format_tokens(entry.output),
                        entry.calls,
                        if entry.reported < entry.calls {
                            format!("（{} 次未回报）", entry.calls - entry.reported)
                        } else {
                            String::new()
                        }
                    )
                } else if entry.calls > 0 {
                    format!("{label}: 未回报 usage · {} 次", entry.calls)
                } else {
                    format!("{label}: 暂无")
                };
                view = view.line(PanelLineStyle::Dim, text);
            }
            view = view.line(
                PanelLineStyle::Dim,
                "Provider 回报的 usage（含缓存口径），不是估算值",
            );
        }
        out.push(view);
    }

    /// 调试条面板（DebugBar 迁移）：上下文占用 / 主回合消耗（含缓存命中率）+
    /// 「思考强度」「安全策略」两个下拉 + 「工具明细」「注册明细」「压缩」动作。
    ///
    /// 数据来自投影 `debug`（进程级快照，缺省保持现值）；Node 尚未投影该字段时
    /// 整条不显示（不摆空壳）。两个下拉（旧壳 `DebugBar.vue` 的 `<select>`）就是
    /// 设置页对应项（CONFIG `ai.thinking.effort` / `ai.safety.mode`）的快捷入口：
    /// 选中即写配置，没有「默认」项；选中态来自投影里的配置现值。
    ///
    /// **完整形态入住上拉抽屉**（2026-10-05 用户规则「那些设置、投递、图片什么的
    /// 都放到上拉；工具、mcp、上下文那些呢？思考强度呢？」）：整块面板现在只在
    /// 输入区上拉抽屉里显示，抽屉自身即折叠——面板内不再有「调试信息 ▸」把手
    /// （该折叠机制已删）。
    ///
    /// 2026-10-05 用户规则「token计算有问题……token花了多少，输入输出，缓存也要写」：
    /// - 「Token {tokens}」一格退场（它只显示 Provider 归一后的**未命中**输入，长对话里
    ///   是个被缓存吞掉一个数量级的小数字）；上下文占比改由 Node 以**真实 prompt 用量**
    ///   为基准计算（`debug.ts::updateRequestStats`，拿不到真实值才退回估算）；
    /// - 「入/出/缓存读」消耗行取 `usage` 的主回合桶（累计；缓存字段只在分桶里存在），
    ///   与「上下文 X%」**分两行**：265pt 聊天列（内宽 257pt）放不下一行塞六段，
    ///   见 `debug_spend_line` 与测试 `调试条两行在265列宽内放得下`；
    /// - 「压缩」按钮与输入框发送 `/compact` 同一条入口（`ChatIntent::SlashCommand`），
    ///   忙碌/排队/无可摘要范围的归宿由 Node 命令层如实回复，宿主不预判可用性。
    ///
    /// 2026-10-06 用户规则「删绿字 + 下行加缓存命中率」：meta 行的「工具 …（最近一次
    /// 请求携带的工具名）」「注册 N (MCP:N)」两段退场（随投影字段一并删除，不留壳），
    /// 行内只剩上下文占用；缓存命中率并进消耗行（见 `debug_spend_line`）。
    /// 「工具明细」「注册明细」两个入口保留：它们是用户显式展开的动作，不是常显文本。
    ///
    /// 「工具明细」「注册明细」「压缩」点击后的行为各自见按钮声明处；前两者的自有列表
    /// 仍**紧跟各自按钮**（[`PanelView`] 的保序原则）。
    fn push_debug_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(debug) = &self.debug else { return };
        let mut view = PanelView::new(PanelKind::DebugBar);
        view = view.select(thinking_effort_select(debug));
        view = view.select(safety_mode_select(debug));
        // 上下文占用与旧 DebugBar 同阈值（≥80 警示、≥50 过渡、其余正常；
        // 面板调色板只有 语义色的四档，50–79 用 Normal 表达「需留意」）。
        // 未知（None）不是「0%」：显示「—」并用 Dim（无值态），不参与阈值着色 ——
        // 0% 会谎报「上下文是空的」，而 None 的语义是「读不到真实占用」。
        let (ctx_style, ctx_text) = match debug.last_context_usage {
            Some(usage) if usage >= 80 => (PanelLineStyle::Warn, format!("上下文 {usage}%")),
            Some(usage) if usage >= 50 => (PanelLineStyle::Normal, format!("上下文 {usage}%")),
            Some(usage) => (PanelLineStyle::Ok, format!("上下文 {usage}%")),
            None => (PanelLineStyle::Dim, "上下文 —".to_string()),
        };
        // meta 行独占一行（设计稿 `.pbox.debug` 的 `.pmeta` 同形）：265pt 聊天列里
        // 「信息行 + chip 行」同行放不下——实测信息行被截成「工具 无…」、
        // chip 换行反而多占一行（2026-10-05 复评提出的合并方案经实机验证不可行，
        // 按设计稿原形回滚）；三个 chip 紧随其后自成一行。消耗行同样独立成行
        // （常见值下两行合计约 499pt > 257pt 内宽，见测试 `调试条两行在265列宽内放得下`）。
        view = view.line(ctx_style, ctx_text);
        // 消耗行（累计口径，单独一行；无已回报用量时不摆空壳——与 `push_usage_panel`
        // 的「Σ 用量为 0 整条不显示」同一理由）。
        if let Some(usage) = &self.usage {
            if let Some(spend) = debug_spend_line(&usage.entries) {
                view = view.line(PanelLineStyle::Dim, spend);
            }
        }
        // 「工具明细」「注册明细」按设计稿 `.pbox.debug` 的 `.chip`（2026-10-05：
        // 旧文字链在实机里认不出是可点的，用户判「展开后没有样式」的一部分）。
        view = view.button("工具明细", PanelAction::ToggleDebugTools);
        view = view.button("注册明细", PanelAction::ToggleDebugRegistry);
        // 「压缩」：与输入框发送 `/compact` 同一条 slash 入口（不新开平行通道）。
        // 不置灰：运行中/排队中等不可压缩窗口由 Node 命令层按 busyPolicy 如实回复
        // （系统消息），点一次必有回应，宿主不假装成功、也不假装不可用。
        view = view.button("压缩", PanelAction::CompactSession);
        if debug.tools_expanded {
            if debug.last_tool_names.is_empty() {
                // 「最近一次」与 meta 行/占比同指：统计只由对话请求刷新
                // （主动表达回合被 `runtime.ts` 的 onUsage 排除，见那里的注释）。
                view = view.line(PanelLineStyle::Dim, "最近一次请求未携带工具");
            } else {
                for name in &debug.last_tool_names {
                    view = view.line(PanelLineStyle::Dim, format!("· {name}"));
                }
            }
        }
        if debug.registry_expanded {
            if debug.registered_tools.is_empty() {
                view = view.line(PanelLineStyle::Dim, "暂无注册工具");
            } else {
                for tool in &debug.registered_tools {
                    view = view.line(
                        PanelLineStyle::Dim,
                        format!("{} · {}", tool.source, tool.name),
                    );
                }
            }
        }
        out.push(view);
    }

    /// 默认投递方式（浮层里的一行下拉：插话 / 稍后继续；**没有「默认」项**——
    /// 配置总有值）。选一项 = 写 CONFIG `ai.conversation.defaultDelivery`
    /// （与设置页「默认发送方式（忙碌时）」同键、同文案表），选中态来自投影的
    /// `default_delivery` 现值。
    ///
    /// 2026-10-05 第二次改版：它一度被改成 meta 轨上的独立下拉菜单，但**那排 chip 整个
    /// 撤掉了**（用户规则「调试、投递合并为调试，然后调试取消显示，改成输入框上面那个横条
    /// 加个上拉小箭头」），于是投递回到浮层，与用量/调试同处一屏。
    /// 2026-10-06 用户裁决（原话「改成和设置一样的……这三个选项和设置的都是改配置，
    /// 不是单条」）：单条显式投递意图退场，本下拉就是设置页对应项的快捷入口。
    fn push_delivery_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelKind, PanelOption, PanelSelect, PanelView};
        if self.active_session.is_none() {
            return;
        }
        // 选项表 = 设置页同一份（`settings::schema::DELIVERY`）：抽屉不另立值域/文案。
        let options: Vec<PanelOption> = DELIVERY
            .iter()
            .map(|choice| PanelOption {
                label: choice.label.to_string(),
                action: PanelAction::SetDefaultDelivery {
                    delivery: super::super::intents::SendDelivery::from_str(choice.value)
                        .expect("设置页投递选项表的值必须命中 SendDelivery 值域"),
                },
            })
            .collect();
        // 选中态来自投影（该字段随帧权威、每帧都带；投影未达时按第一项显示，随帧收敛）。
        let selected = self
            .default_delivery
            .and_then(|current| {
                options.iter().position(|option| {
                    matches!(
                        &option.action,
                        PanelAction::SetDefaultDelivery { delivery } if *delivery == current
                    )
                })
            })
            .unwrap_or(0);
        out.push(PanelView::new(PanelKind::Delivery).select(PanelSelect {
            label: "投递".into(),
            options,
            selected,
        }));
    }

    fn push_slash_panel(&self, out: &mut Vec<super::super::panels::PanelView>) {
        use super::super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        let snapshot = self.slash_snapshot();
        if !snapshot.visible {
            return;
        }
        let mut view = PanelView::new(PanelKind::SlashCandidates);
        let count = snapshot.matches.len();
        view = view.line(PanelLineStyle::Dim, format!("命令候选 · {count}"));
        for (index, item) in snapshot.matches.iter().enumerate() {
            let marker = if item.selected { "▸" } else { " " };
            view = view.row(
                format!("{marker} /{} — {}", item.name, item.description),
                vec![PanelButton::new("填入", PanelAction::SlashPick { index })],
            );
        }
        out.push(view);
    }
}

// `delivery_label` 删除记录（2026-10-05 第三次改版）：它原为「meta 轨 chip 文案」与
// 「投递面板」共用，轨撤掉后没有第二个消费者了；投递面板的选择项文案直接写在
// `push_delivery_panel` 的 `PanelOption` 里（与 `selected` 下标同处一地，更不容易漂）。

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;
    use crate::ui::chat::projection::TranscriptProjection;

    fn projection(session: &str, messages: Vec<ProjectedMessage>) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            speaker_name: Some("糖糖".into()),
            messages,
            prompts: Default::default(),
            ..Default::default()
        }
    }

    /// 投递下拉是设置页「默认发送方式（忙碌时）」的快捷入口（2026-10-06 用户裁决）：
    /// 选项表直接引用 `settings::schema::DELIVERY`（文案与值域的唯一来源），选中态
    /// 来自投影的 `default_delivery`（CONFIG 现值），**没有「默认」选项**。
    #[test]
    fn 投递下拉按配置投影选中且与设置页同表() {
        use super::super::super::intents::SendDelivery;
        use super::super::super::panels::{PanelAction, PanelBlock, PanelKind};
        fn delivery_select(model: &ChatModel) -> super::super::super::panels::PanelSelect {
            model
                .panel_views()
                .into_iter()
                .find(|view| view.kind == PanelKind::Delivery)
                .expect("有活跃会话时投递面板应在")
                .blocks
                .into_iter()
                .find_map(|block| match block {
                    PanelBlock::Select(select) => Some(select),
                    _ => None,
                })
                .expect("投递面板应由一个下拉构成")
        }

        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let select = delivery_select(&model);
        assert_eq!(select.label, "投递");
        assert_eq!(
            select
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            DELIVERY.iter().map(|choice| choice.label).collect::<Vec<_>>(),
            "选项文案必须与设置页同一份（不另立第二份表）"
        );
        assert_eq!(select.selected, 0, "投影未达时按第一项显示，随帧收敛");

        // 配置现值命中某项：选中跟随投影（followUp → 第二项），动作 = 写配置。
        let mut frame = projection("s1", vec![]);
        frame.default_delivery = Some("followUp".into());
        model.apply_projection(frame);
        let select = delivery_select(&model);
        assert_eq!(select.selected, 1, "投影的 default_delivery 决定选中");
        assert_eq!(
            select.options[1].action,
            PanelAction::SetDefaultDelivery {
                delivery: SendDelivery::FollowUp
            }
        );
        assert_eq!(
            select.options[0].action,
            PanelAction::SetDefaultDelivery {
                delivery: SendDelivery::Steer
            }
        );
    }
    // `投递意图循环为默认插话稍后` 删除记录（2026-10-06 用户裁决）：本地轮换态
    // （`cycle_delivery`）随单条显式投递意图整链退场；投递下拉的选中与派发由
    // `投递下拉按配置投影选中且与设置页同表` 覆盖。
    /// 用户报告「各个会话应该用气泡，不然看不清，按钮也错位了」：
    /// 每个会话一个卡片，名字 / 日期条数 / 操作按钮各占一行 —— 窄弹层宽度下
    /// 「恢复」「删除」必须落在同一行。旧布局把三者塞进一条 `Row`，稍长的会话名
    /// 就会把第二个按钮挤到下一行（用户看到的按钮错位）。
    #[test]
    fn 会话历史每项一个卡片且按钮不换行() {
        use crate::ui::chat::panels::{
            layout_panels, PanelAction, PanelElement, PanelFrame, PanelKind,
        };
        use crate::ui::chat::projection::{ProjectedHistorySession, ProjectedSessionHistory};
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.toggle_history();
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(ProjectedSessionHistory {
            loaded: true,
            error: false,
            sessions: vec![
                ProjectedHistorySession {
                    id: "s2".into(),
                    name: "一个相当长的历史会话名字".into(),
                    created_at: 0,
                    activity_at: None,
                    message_count: 12,
                },
                ProjectedHistorySession {
                    id: "s3".into(),
                    name: "短名".into(),
                    created_at: 0,
                    activity_at: None,
                    message_count: 0,
                },
            ],
        });
        model.apply_projection(frame);
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == PanelKind::SessionHistory)
            .expect("历史面板存在");
        // 内容宽度取两平台的较窄者（macOS 弹层 320−2×11、Windows 300−2×10）。
        let width = 280.0;
        let layout = layout_panels(std::slice::from_ref(history), width, 10_000.0);

        // 每个会话的两个操作按钮都在同一行（用户报告的按钮错位）。
        for id in ["s2", "s3"] {
            let mut button_rows: Vec<PanelFrame> = Vec::new();
            for element in &layout.elements {
                if let PanelElement::Button { action, frame, .. } = element {
                    let mine = matches!(
                        action,
                        PanelAction::RestoreSessionFromHistory { session_id } if session_id == id
                    ) || matches!(
                        action,
                        PanelAction::DeleteSessionFromHistory { session_id } if session_id == id
                    );
                    if mine {
                        button_rows.push(*frame);
                    }
                }
            }
            assert_eq!(button_rows.len(), 2, "{id} 的两个操作按钮都要摆出来");
            assert!(
                (button_rows[0].y - button_rows[1].y).abs() < 1e-6,
                "{id} 的「恢复」「删除」必须在同一行（按钮错位）：{button_rows:?}"
            );
        }

        // 每个会话一张卡：底板包住该会话的内容、卡片之间不重叠。
        let cards: Vec<PanelFrame> = layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Card { frame } => Some(*frame),
                _ => None,
            })
            .collect();
        assert_eq!(cards.len(), 2, "两个会话 = 两张卡片");
        assert!(
            cards[1].y >= cards[0].bottom(),
            "卡片不得重叠：{:?} / {:?}",
            cards[0],
            cards[1]
        );
        let name_frames: Vec<PanelFrame> = layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Line { text, frame, .. }
                    if text == "一个相当长的历史会话名字" || text == "短名" =>
                {
                    Some(*frame)
                }
                _ => None,
            })
            .collect();
        assert_eq!(name_frames.len(), 2, "两行会话名都摆出来");
        for (name, card) in name_frames.iter().zip(cards.iter()) {
            assert!(
                name.x >= card.x
                    && name.right() <= card.right()
                    && name.y >= card.y
                    && name.bottom() <= card.bottom(),
                "会话名落在自己的卡片里：{name:?} / {card:?}"
            );
        }
        // 全部 frame 不越出弹层内容宽。
        for element in &layout.elements {
            let frame = element.frame();
            assert!(
                frame.x >= 0.0 && frame.right() <= width + 1e-6,
                "不越出弹层内容宽：{frame:?}"
            );
        }
    }
}
