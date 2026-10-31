//! 计划 / 权限 / 提问面板的状态机（`deskpet-plan-*`、`deskpet-permission-*`、
//! `deskpet-choice-*`）。三类面板都没有本地期限：归宿只来自 Node 的结算事件。

use super::{ChatModel, ChoiceView, PermissionView, PlanStepView, PlanView, StepGateView};

impl ChatModel {
    // ==========================================
    // 计划面板（`deskpet-plan-*`）
    // ==========================================

    /// `deskpet-plan-start`：装填待确认计划（只接受当前会话的载荷，与 PlanConfirm
    /// 面板的 `sessionId !== getActiveSessionId()` 过滤同义）。没有本地期限：
    /// 面板一直等用户拍板，归宿只来自 Node 的结算事件（2026-10-06 用户裁决）。
    pub fn plan_start(
        &mut self,
        session_id: String,
        plan_id: String,
        summary: String,
        steps: Vec<super::super::events::PlanStepWire>,
        complexity: u32,
        force_step_by_step: bool,
    ) -> bool {
        if self.active_session.as_deref() != Some(session_id.as_str()) {
            return false;
        }
        let steps: Vec<PlanStepView> = steps
            .into_iter()
            .map(|step| PlanStepView {
                id: step.id,
                description: step.description,
                allowed_tools: step.allowed_tools.unwrap_or_default(),
                status: None,
            })
            .collect();
        let total = steps.len() as u32;
        self.plan = Some(PlanView {
            plan_id,
            session_id,
            summary,
            steps,
            complexity,
            force_step_by_step,
            executing: false,
            total,
            current_index: 0,
            gate: None,
        });
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-progress`：按 `stepId`（数字文本）定位步骤并更新状态；
    /// 找不到对应步骤时只留痕（与 PlanConfirm 面板的 warn 同义），不改动面板。
    pub fn plan_progress(
        &mut self,
        session_id: &str,
        plan_id: &str,
        step_id: &str,
        total: u32,
        status: super::super::events::PlanStepStatus,
    ) -> bool {
        let Some(plan) = self.plan_for(session_id, plan_id) else {
            return false;
        };
        let index = plan
            .steps
            .iter()
            .position(|step| step.id.to_string() == step_id);
        let Some(index) = index else {
            return false;
        };
        plan.steps[index].status = Some(status);
        plan.current_index = index as u32 + 1;
        plan.total = total;
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-step-gate`：挂上逐步门（逐步前置门 / 失败询问）。
    /// `kind=failed` 时同时把该步骤标为失败（与 PlanConfirm 面板同义）。
    pub fn plan_step_gate(
        &mut self,
        session_id: &str,
        plan_id: &str,
        kind: super::super::events::PlanGateKind,
        step: super::super::events::PlanStepWire,
        index: u32,
        total: u32,
        error: Option<String>,
    ) -> bool {
        let Some(plan) = self.plan_for(session_id, plan_id) else {
            return false;
        };
        if kind == super::super::events::PlanGateKind::Failed {
            if let Some(entry) = plan.steps.iter_mut().find(|entry| entry.id == step.id) {
                entry.status = Some(super::super::events::PlanStepStatus::Failed);
            }
        }
        plan.total = total;
        plan.gate = Some(StepGateView {
            kind,
            step_id: step.id,
            step_description: step.description,
            index,
            total,
            error,
        });
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-end`：收起本会话的计划面板（不带 planId；同一会话同一时刻只有一个计划）。
    pub fn plan_end(&mut self, session_id: &str) -> bool {
        let matches = self
            .plan
            .as_ref()
            .map(|plan| plan.session_id == session_id)
            .unwrap_or(false);
        if matches {
            self.plan = None;
            self.panel_revision += 1;
        }
        matches
    }

    /// 确认回执派发成功后进入执行态（面板继续显示进度）。
    pub fn plan_begin_executing(&mut self) -> bool {
        let Some(plan) = self.plan.as_mut() else {
            return false;
        };
        plan.executing = true;
        self.panel_revision += 1;
        true
    }

    /// 收起计划面板（取消/终止的执行结果由后续 `deskpet-plan-end` 或投影反映）。
    pub fn plan_dismiss(&mut self) -> bool {
        if self.plan.is_none() {
            return false;
        }
        self.plan = None;
        self.panel_revision += 1;
        true
    }

    /// 逐步门裁决派发成功后收起门（避免重复点击；后续进度/收尾事件继续驱动面板）。
    pub fn plan_clear_gate(&mut self) -> bool {
        let changed = self
            .plan
            .as_mut()
            .map(|plan| plan.gate.take().is_some())
            .unwrap_or(false);
        if changed {
            self.panel_revision += 1;
        }
        changed
    }

    /// 面板动作取计划身份（派发回执用）。
    pub fn plan_identity(&self) -> Option<(&str, &str)> {
        self.plan
            .as_ref()
            .map(|plan| (plan.plan_id.as_str(), plan.session_id.as_str()))
    }

    /// 当前计划面板的只读视图（测试与平台断言用）。
    pub fn plan(&self) -> Option<&PlanView> {
        self.plan.as_ref()
    }

    fn plan_for(&mut self, session_id: &str, plan_id: &str) -> Option<&mut PlanView> {
        self.plan
            .as_mut()
            .filter(|plan| plan.session_id == session_id && plan.plan_id == plan_id)
    }

    // ==========================================
    // 权限确认面板
    // ==========================================

    /// 装填一条权限确认请求。**没有本地期限**：面板一直等用户答复，归宿只来自
    /// Node 的结算（回执派发的本地过渡 / 会话切换 / 投影驱动的收起）。
    /// 同一时刻只保留一条（与 `confirmState` 的单槽语义一致）：新请求替换旧请求。
    pub fn permission_request(&mut self, request: super::super::events::PermissionConfirmRequest) -> bool {
        self.permission = Some(PermissionView {
            request_id: request.request_id,
            message: request.message,
            tool_name: request.tool_name,
            session_id: request.session_id,
            run_generation: request.run_generation,
            parameter_summary: request.parameter_summary,
            effect_class: request.effect_class,
            input_hash: request.input_hash,
            policy_hash: request.policy_hash,
        });
        self.panel_revision += 1;
        true
    }

    /// 用户答复派发成功后收起面板（结算由 Node 完成；重复答复在 Node 侧是 no-op）。
    pub fn permission_decided(&mut self, request_id: &str) -> bool {
        let matches = self
            .permission
            .as_ref()
            .map(|permission| permission.request_id == request_id)
            .unwrap_or(false);
        if matches {
            self.permission = None;
            self.panel_revision += 1;
        }
        matches
    }

    /// 当前权限面板的只读视图。
    pub fn permission(&self) -> Option<&PermissionView> {
        self.permission.as_ref()
    }

    // ==========================================
    // 提问（ask_user）面板
    // ==========================================

    /// `deskpet-choice-start`：装填一条待答提问（只接受当前会话的载荷，与计划确认
    /// 面板同款过滤）。同 requestId 重入按替换处理（结算真相源在 Node）。没有本地期限：
    /// 面板一直等用户回答，归宿只来自 Node 的结算事件（2026-10-06 用户裁决）。
    pub fn choice_start(
        &mut self,
        session_id: String,
        request_id: String,
        question: String,
        options: Vec<String>,
    ) -> bool {
        if self.active_session.as_deref() != Some(session_id.as_str()) {
            return false;
        }
        self.choices.retain(|choice| choice.request_id != request_id);
        self.choices.push(ChoiceView {
            request_id,
            session_id,
            question,
            options,
        });
        self.panel_revision += 1;
        true
    }

    /// `deskpet-choice-end`：按 requestId 收起提问面板（校验会话归属；幂等）。
    pub fn choice_end(&mut self, session_id: &str, request_id: &str) -> bool {
        let matches = self
            .choices
            .iter()
            .any(|choice| choice.request_id == request_id && choice.session_id == session_id);
        if !matches {
            return false;
        }
        self.choice_remove(request_id)
    }

    /// 按 requestId 收起一条提问面板（回执派发成功后的本地过渡 / `choice_end` 共用；
    /// 幂等 —— 重复的收起不产生显示变化）。
    pub fn choice_remove(&mut self, request_id: &str) -> bool {
        let before = self.choices.len();
        self.choices.retain(|choice| choice.request_id != request_id);
        if self.choices.len() == before {
            return false;
        }
        self.panel_revision += 1;
        true
    }

    /// 该 requestId 是否仍待答（面板动作派发前的身份核对）。
    pub fn choice_pending(&self, request_id: &str) -> bool {
        self.choices.iter().any(|choice| choice.request_id == request_id)
    }

    /// 当前待答提问的只读视图（测试与平台断言用）。
    pub fn choices(&self) -> &[ChoiceView] {
        &self.choices
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
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

    // ==========================================
    // W8b 面板
    // ==========================================
    fn plan_step(id: i64, description: &str) -> super::super::super::events::PlanStepWire {
        super::super::super::events::PlanStepWire {
            id,
            description: description.into(),
            role: None,
            allowed_tools: None,
        }
    }
    #[test]
    fn 计划面板生命周期与逐门裁决() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(model.plan_start(
            "s1".into(),
            "p1".into(),
            "完成两件事".into(),
            vec![plan_step(1, "第一步"), plan_step(2, "第二步")],
            3,
            false,
        ));
        let plan = model.plan().expect("计划面板已装填");
        assert_eq!(plan.summary, "完成两件事");
        assert!(!plan.executing);
        assert_eq!(plan.total, 2);
        // 没有本地期限（2026-10-06 用户裁决：选择类弹窗不留超时）。
        assert_eq!(model.next_deadline_ms(), None);

        // 确认 → 执行态。
        assert!(model.plan_begin_executing());
        assert_eq!(model.next_deadline_ms(), None);

        // 进度按 stepId 字符串定位。
        assert!(model.plan_progress(
            "s1",
            "p1",
            "1",
            2,
            super::super::super::events::PlanStepStatus::Done,
        ));
        let plan = model.plan().unwrap();
        assert_eq!(plan.steps[0].marker(), "OK");
        assert_eq!(plan.current_index, 1);

        // 失败询问挂门并把步骤标红。
        assert!(model.plan_step_gate(
            "s1",
            "p1",
            super::super::super::events::PlanGateKind::Failed,
            plan_step(2, "第二步"),
            2,
            2,
            Some("炸了".into()),
        ));
        assert_eq!(model.plan().unwrap().steps[1].marker(), "XX");
        assert!(model.plan().unwrap().gate.is_some());

        // 裁决派发成功 → 收起门（面板本身等 plan-end）。
        assert!(model.plan_clear_gate());
        assert!(model.plan().unwrap().gate.is_none());

        // 收尾事件收起面板。
        assert!(model.plan_end("s1"));
        assert!(model.plan().is_none());
    }
    #[test]
    fn 非当前会话与不匹配计划的事件被丢弃() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(!model.plan_start("s2".into(), "p".into(), "目标".into(), vec![], 1, false));
        assert!(model.plan_start(
            "s1".into(),
            "p1".into(),
            "目标".into(),
            vec![plan_step(1, "一")],
            1,
            false,
        ));
        // 另一个 planId 的进度不改本面板。
        assert!(!model.plan_progress(
            "s1",
            "p-other",
            "1",
            1,
            super::super::super::events::PlanStepStatus::Done,
        ));
        // 别的会话的 end 不收本会话面板。
        assert!(!model.plan_end("s2"));
        assert!(model.plan().is_some());
    }
    #[test]
    fn 确认阶段没有本地期限久等不收起() {
        // 2026-10-06 用户裁决：选择类弹窗不留超时。时钟推进 10 分钟（远超旧的 5 分钟
        // 本地期限）后面板仍在 —— 重新引入本地期限这条立即红。
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start("s1".into(), "p1".into(), "目标".into(), vec![plan_step(1, "一")], 1, false);
        assert!(!model.expire_deadlines(10 * 60 * 1000));
        assert!(model.plan().is_some(), "计划确认面板被本地期限收起了");
        assert_eq!(model.next_deadline_ms(), None, "计划确认不该再有本地期限");
    }
    #[test]
    fn 权限面板装填答复且没有本地期限() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let request = super::super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "“bash” 将执行 external_side_effect 操作".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: Some(3),
            parameter_summary: Some("command=ls".into()),
            effect_class: Some("external_side_effect".into()),
            input_hash: Some("abcdef123456".into()),
            policy_hash: Some("123456abcdef".into()),
            tool_call_id: Some("tc1".into()),
        };
        assert!(model.permission_request(request));
        assert_eq!(model.next_deadline_ms(), None, "权限面板不该再有本地期限");

        // 久等不收起（10 分钟；旧实现在 5 分钟本地期限处收起并写超时通知）。
        assert!(!model.expire_deadlines(10 * 60 * 1000));
        assert!(model.permission().is_some(), "权限面板被本地期限收起了");

        // 用户答复派发成功 → 面板收起（归宿只在结算事件上）。
        assert!(model.permission_decided("r1"));
        assert!(model.permission().is_none());
    }
    #[test]
    fn 权限面板内容包进卡片面() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let request = super::super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "“bash” 将执行 external_side_effect 操作".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: Some(3),
            parameter_summary: Some("command=ls".into()),
            effect_class: Some("external_side_effect".into()),
            input_hash: Some("abcdef123456".into()),
            policy_hash: Some("123456abcdef".into()),
            tool_call_id: Some("tc1".into()),
        };
        assert!(model.permission_request(request));
        let views = model.panel_views();
        let view = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Permission)
            .expect("权限面板要在面板列表里");
        // 挡「把卡片包回收成裸行」：权限内容必须是唯一一个顶层 Card 块，
        // 卡内首块是警告行、末块是按钮组（用户规则 2026-10-05：权限确认重做为卡片面）。
        assert_eq!(view.blocks.len(), 1, "权限面板只应有一个顶层块（卡片）");
        let super::super::super::panels::PanelBlock::Card(blocks) = &view.blocks[0] else {
            panic!("权限面板的顶层块必须是 Card");
        };
        assert!(matches!(
            blocks.first(),
            Some(super::super::super::panels::PanelBlock::Line {
                style: super::super::super::panels::PanelLineStyle::Warn,
                ..
            })
        ));
        assert!(matches!(
            blocks.last(),
            Some(super::super::super::panels::PanelBlock::Buttons(_))
        ));
    }
    #[test]
    fn 提问面板生命周期与按钮构成() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        // 非当前会话的载荷被丢弃（与计划确认同款过滤）。
        assert!(!model.choice_start("s2".into(), "choice-x".into(), "问题".into(), vec!["甲".into()]));
        assert!(model.choice_start(
            "s1".into(),
            "choice-c1".into(),
            "喝什么？\n选一个".into(),
            vec!["咖啡".into(), "茶".into()],
        ));

        let views = model.panel_views();
        let choice = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Choice)
            .expect("提问面板存在");
        // 选项 + 「其它」 + 「取消」三个按钮都在（其它/取消是面板固定件，不来自模型参数）。
        let labels: Vec<&str> = view_buttons(&choice).iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["咖啡", "茶", "其它（自己回答）", "取消"]);
        // 问题按显式换行逐行摆放。
        let lines: Vec<&str> = choice
            .blocks
            .iter()
            .filter_map(|block| match block {
                super::super::super::panels::PanelBlock::Line { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["喝什么？", "选一个"]);

        // 并发多条：两条待答并存，逐条收起；面板按 requestId 定位。
        assert!(model.choice_start(
            "s1".into(),
            "choice-c2".into(),
            "第二个问题".into(),
            vec!["A".into(), "B".into()],
        ));
        assert_eq!(model.choices().len(), 2, "并发提问应逐条并存（刻意不设单槽）");
        assert!(model.choice_remove("choice-c1"));
        assert_eq!(model.choices().len(), 1);
        assert!(model.choice_pending("choice-c2"));

        // end 事件按会话 + requestId 收起；重复/迟到是幂等 no-op。
        assert!(!model.choice_end("s2", "choice-c2"), "别的会话的收尾不动作");
        assert!(model.choice_end("s1", "choice-c2"));
        assert!(!model.choice_end("s1", "choice-c2"), "迟到的重复收尾是 no-op");
        assert!(!model.choice_pending("choice-c2"));
    }
    #[test]
    fn 切会话清空计划与权限并对齐队列() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            "目标".into(),
            vec![plan_step(1, "一")],
            1,
            false,
        );
        let request = super::super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "确认".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: None,
            parameter_summary: None,
            effect_class: None,
            input_hash: None,
            policy_hash: None,
            tool_call_id: None,
        };
        model.permission_request(request);

        let mut frame = projection("s2", vec![]);
        frame.queue = Some(super::super::super::projection::ProjectedQueue {
            loaded: true,
            running: false,
            items: vec![],
        });
        model.apply_projection(frame);
        assert!(
            model.plan().is_none(),
            "切会话收起计划面板（Node 已按 session_switched 结算）"
        );
        assert!(model.permission().is_none(), "切会话收起权限面板");
        assert!(model.queue().loaded, "新会话的队列快照随后应用");
    }
    #[test]
    fn 计划面板显示目标与步骤权限面() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let mut step = plan_step(1, "查资料");
        step.allowed_tools = Some(vec!["read".into(), "bash".into()]);
        model.plan_start(
            "s1".into(),
            "p1".into(),
            "整理资料".into(),
            vec![step],
            2,
            false,
        );
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Plan)
            .expect("计划面板存在");
        let lines: Vec<&str> = plan
            .blocks
            .iter()
            .filter_map(|block| match block {
                super::super::super::panels::PanelBlock::Line { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            lines.contains(&"目标：整理资料"),
            "面板没有显示计划目标：{lines:?}"
        );
        assert!(
            lines.contains(&"[--] 查资料（工具：read、bash）"),
            "面板没有显示步骤权限面：{lines:?}"
        );
    }
    #[test]
    fn 面板渲染块按阶段给出按钮() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            "目标".into(),
            vec![plan_step(1, "一")],
            3,
            false,
        );
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Plan)
            .expect("计划面板存在");
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["全部执行", "逐步确认", "取消"], "确认阶段三键");

        // 强制逐步：没有「全部执行」。
        model.plan_dismiss();
        model.plan_start("s1".into(), "p2".into(), "目标".into(), vec![], 1, true);
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Plan)
            .unwrap();
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["逐步确认", "取消"]);

        // 执行阶段：无门 → 终止执行；有门 → 执行下一步/中止。
        model.plan_begin_executing();
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Plan)
            .unwrap();
        assert_eq!(view_buttons(&plan)[0].label, "终止执行");
        model.plan_step_gate(
            "s1",
            "p2",
            super::super::super::events::PlanGateKind::Approval,
            plan_step(1, "一"),
            1,
            1,
            None,
        );
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::Plan)
            .unwrap();
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["执行下一步", "中止"]);
    }
    /// 面板里的全部按钮（含卡片内部；按摆放顺序：先入列的卡片在前）。
    fn view_buttons(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<&crate::ui::chat::panels::PanelButton> {
        fn walk<'a>(
            blocks: &'a [crate::ui::chat::panels::PanelBlock],
            out: &mut Vec<&'a crate::ui::chat::panels::PanelButton>,
        ) {
            use crate::ui::chat::panels::PanelBlock;
            for block in blocks {
                match block {
                    PanelBlock::Buttons(buttons) => out.extend(buttons.iter()),
                    PanelBlock::Card(inner) => walk(inner, out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&view.blocks, &mut out);
        out
    }
}
