//! 运行态、通知、队列/中断/用量开关、待发送区与本地期限。

use super::super::placeholders::{discard_managed_files, ImagePlaceholder};
use super::{ChatModel, InterruptedRunView, PendingDraftRelease, QueueState};

impl ChatModel {
    /// 运行态（`deskpet-run-state`）：只作用于当前会话。
    pub fn set_run_state(&mut self, session_id: &str, running: bool) {
        if self.active_session.as_deref() != Some(session_id) {
            return;
        }
        self.running = running;
        if !running {
            // 回合收尾：瞬时尾巴与阶段/工具提示都没有续期者，一起收起
            // （与 ChatPanel 在 run-state=false 时 hideToolStatus 的归宿一致）。
            if self.streaming.is_some() {
                self.streaming = None;
                self.stream_revision += 1;
            }
            if self.status.stage.is_some() || self.status.tool.is_some() {
                self.status.stage = None;
                self.status.tool = None;
                self.status.text = None;
            }
            // 回合结束的兜底收口（W8b）：
            // - 同一会话的权限确认随回合 signal abort 在 Node 侧按 deny 结算，UI 收起；
            // - 执行中的计划本应收到 `deskpet-plan-end`，这里只兜底收起「计划已随回合
            //   结束但结束事件丢失」的执行面板（计划状态以会话为准，不影响任何后续动作）。
            //   确认阶段（未执行）不在这里收起：它是「等用户拍板」的面板，归宿是 Node 的
            //   结算事件（没有本地期限）；提前收起会在「上一回合收尾与新计划确认几乎同时
            //   到达」的竞态里误伤新面板。
            let _ = self.drop_stale_permission_for(session_id);
            let _ = self.drop_stale_executing_plan_for(session_id);
        }
        self.status_revision += 1;
    }

    /// 回合收尾兜底：收起该会话仍在「执行中」的计划面板（`deskpet-plan-end` 丢失的兜底）。
    fn drop_stale_executing_plan_for(&mut self, session_id: &str) -> bool {
        let stale = self
            .plan
            .as_ref()
            .map(|plan| plan.session_id == session_id && plan.executing)
            .unwrap_or(false);
        if stale {
            self.plan = None;
            self.panel_revision += 1;
        }
        stale
    }

    /// 回合收尾兜底：收起属于该会话的权限确认（Node 已按 signal abort 拒绝结算）。
    fn drop_stale_permission_for(&mut self, session_id: &str) -> bool {
        let stale = self
            .permission
            .as_ref()
            .map(|permission| permission.session_id.as_deref() == Some(session_id))
            .unwrap_or(false);
        if stale {
            self.permission = None;
            self.panel_revision += 1;
        }
        stale
    }

    /// 中性系统通知（发送回执、操作回执、图片失效等）；覆盖式，不排队。
    ///
    /// 通知带 [`super::super::panels::NOTICE_TTL_MS`] 的自动收起期限（旧壳
    /// `showDeliveryNote` 的 4 秒隐藏同义）：瞬时提示不驻留状态行，
    /// 到点由 [`Self::expire_deadlines`] 清除。
    pub fn set_notice(&mut self, notice: Option<String>, now_ms: u64) {
        self.write_notice(notice, now_ms);
    }

    /// 统一的通知写入点（含 TTL 期限；`None` = 立即清除）。
    fn write_notice(&mut self, notice: Option<String>, now_ms: u64) {
        self.notice_deadline = notice
            .as_ref()
            .map(|_| now_ms + super::super::panels::NOTICE_TTL_MS);
        self.status.notice = notice;
        self.status_revision += 1;
    }

    /// 发送投递归宿（`deskpet-send-outcome`）：与运行态/阶段提示同口径，只作用于当前会话 ——
    /// 别的会话的回执不在本窗冒充「刚发送的归宿」。文案是旧壳 `DELIVERY_NOTES` 同文的中性
    /// 回执（`panels::send_outcome_notice`），经既有 notice 通道呈现，TTL 由 `write_notice`
    /// 统一挂上（4 秒自动收起）。
    /// 返回是否落进本窗（false = 事件属于别的会话，调用方留调试线索）。
    pub fn set_send_outcome(
        &mut self,
        session_id: &str,
        delivery: super::super::events::SendOutcomeDelivery,
        now_ms: u64,
    ) -> bool {
        if self.active_session.as_deref() != Some(session_id) {
            return false;
        }
        self.write_notice(
            Some(super::super::panels::send_outcome_notice(delivery).to_string()),
            now_ms,
        );
        true
    }

    // ==========================================
    // 队列 / 中断 / 用量 / 投递意图（投影驱动）
    // ==========================================

    pub fn queue(&self) -> &QueueState {
        &self.queue
    }

    pub fn interrupted(&self) -> Option<&InterruptedRunView> {
        self.interrupted.as_ref()
    }

    /// 用量明细展开开关（纯显示态；数据来自投影）。
    pub fn toggle_usage(&mut self) -> bool {
        let Some(usage) = self.usage.as_mut() else {
            return false;
        };
        usage.expanded = !usage.expanded;
        self.panel_revision += 1;
        true
    }

    // `toggle_debug_panel` 删除记录（2026-10-05）：整体折叠机制随上拉抽屉退场。

    /// 调试条「最近一次请求工具列表」展开开关（纯显示态；数据来自投影）。
    pub fn toggle_debug_tools(&mut self) -> bool {
        let Some(debug) = self.debug.as_mut() else {
            return false;
        };
        debug.tools_expanded = !debug.tools_expanded;
        self.panel_revision += 1;
        true
    }

    /// 调试条「工具注册明细」展开开关（纯显示态；数据来自投影）。
    pub fn toggle_debug_registry(&mut self) -> bool {
        let Some(debug) = self.debug.as_mut() else {
            return false;
        };
        debug.registry_expanded = !debug.registry_expanded;
        self.panel_revision += 1;
        true
    }

    // `cycle_delivery` / `delivery()` / `set_delivery` 删除记录（2026-10-06 用户裁决）：
    // 单条显式投递意图整链退场 —— 抽屉的「投递」下拉改为写 CONFIG
    // `ai.conversation.defaultDelivery`（与设置页同键），选中态来自投影的
    // `default_delivery`；忙碌投递只剩「ingress 按 CONFIG 默认决定」一条路。

    // ==========================================
    // 待发送区（聊天发图：选择/拖入后的临时选择态）
    // ==========================================

    /// 待发送图片（元数据；平台层渲染预览条）。
    pub fn pending_images(&self) -> &[ImagePlaceholder] {
        &self.pending_images
    }

    /// 待发送图片的原路径（发送时交给 `ChatIntent::Send::image_paths`）。
    pub fn pending_paths(&self) -> Vec<String> {
        self.pending_images
            .iter()
            .map(|image| image.path.clone())
            .collect()
    }

    /// 追加待发送图片（按原路径去重；返回实际新增数）。准入（数量/大小/格式/路径）
    /// 由调用方在统一图片域完成（`ChatUi::add_pending_images`），这里只存显示态。
    pub fn add_pending_images(&mut self, images: Vec<ImagePlaceholder>) -> usize {
        let mut added = 0;
        for image in images {
            if self
                .pending_images
                .iter()
                .any(|existing| existing.path == image.path)
            {
                continue;
            }
            self.pending_images.push(image);
            added += 1;
        }
        if added > 0 {
            self.pending_revision += 1;
        }
        added
    }

    /// 撤选一张（返回是否确实移除）。撤选即丢弃：`managed` 草稿项当场删文件
    /// （失败只留痕，见 [`discard_managed_files`]），用户自有文件不动。
    pub fn remove_pending_image(&mut self, path: &str) -> bool {
        let Some(index) = self.pending_images.iter().position(|image| image.path == path) else {
            return false;
        };
        let removed = self.pending_images.remove(index);
        self.pending_revision += 1;
        discard_managed_files(std::slice::from_ref(&removed));
        true
    }

    /// 清空待发送区（发送成功 / 切会话 / 退出的释放点；返回是否有变化）。
    ///
    /// 释放语义由 [`PendingDraftRelease`] 在类型上区分：发送是所有权转移（文件保留），
    /// 丢弃是回收托管草稿（`managed` 项删文件、失败只留痕）。逐张撤选走
    /// [`Self::remove_pending_image`]。
    pub fn clear_pending_images(&mut self, release: PendingDraftRelease) -> bool {
        if self.pending_images.is_empty() {
            return false;
        }
        let drafts = std::mem::take(&mut self.pending_images);
        if release == PendingDraftRelease::Discard {
            discard_managed_files(&drafts);
        }
        self.pending_revision += 1;
        true
    }

    // ==========================================
    // 本地等待期限（保证面板不永久卡在半途）
    // ==========================================

    /// 最早到期的本地期限（单调毫秒；平台层据此布一次定时器）。
    ///
    /// 只剩**中性通知的自动收起**一个期限：计划确认 / 权限确认 / 待答提问都没有本地
    /// 期限（2026-10-06 用户裁决：选择类弹窗不留超时，用户想多久想多久；归宿只来自
    /// Node 的结算事件）。`expire_deadlines` 因此只会收起通知。
    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.notice_deadline
    }

    /// 到点收纳：中性通知到点自动隐藏（旧壳 4 秒隐藏同义）。决策类面板不在这里收起
    /// —— 它们只由 Node 的结算事件/面板动作的本地过渡/会话切换驱动。
    /// 返回是否需要一次刷新（可能只是状态位变化）。
    pub fn expire_deadlines(&mut self, now_ms: u64) -> bool {
        let mut changed = false;
        if matches!(self.notice_deadline, Some(deadline) if now_ms >= deadline) {
            self.notice_deadline = None;
            self.status.notice = None;
            self.status_revision += 1;
            changed = true;
        }
        changed
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

    #[test]
    fn 通知带自动收起期限() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_notice(Some("已撤回排队消息".into()), 1_000);
        assert_eq!(
            model.snapshot().status.notice.as_deref(),
            Some("已撤回排队消息")
        );
        assert!(
            model.next_deadline_ms().is_some(),
            "通知带期限（平台据此布定时器）"
        );
        // 未到点不收起。
        assert!(!model.expire_deadlines(1_000 + super::super::super::panels::NOTICE_TTL_MS - 1));
        assert!(model.snapshot().status.notice.is_some());
        // 到点自动隐藏（旧壳 showDeliveryNote 的 4 秒隐藏同义）。
        assert!(model.expire_deadlines(1_000 + super::super::super::panels::NOTICE_TTL_MS));
        assert!(model.snapshot().status.notice.is_none());
        assert!(model.next_deadline_ms().is_none());
        // 显式清除同样撤下期限。
        model.set_notice(Some("临时".into()), 2_000);
        model.set_notice(None, 2_001);
        assert!(model.next_deadline_ms().is_none());
    }
    #[test]
    fn 运行态收尾收起阶段与工具提示() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_run_state("s1", true);
        model.tool_executing("t1", "bash");
        assert!(model.snapshot().status.running);
        assert!(
            model.snapshot().status.text.is_none(),
            "没有投影文案时不显示硬编码台词"
        );
        model.set_run_state("s1", false);
        let snapshot = model.snapshot();
        assert!(!snapshot.status.running);
        assert!(snapshot.status.text.is_none());
    }
    #[test]
    fn 非当前会话的事件被丢弃() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_run_state("s2", true);
        model.set_stage_hint("s2", SimpleStageKey::Error);
        assert!(!model.snapshot().status.running);
        assert!(model.snapshot().status.text.is_none());
    }
    #[test]
    fn 待发送区增删清与切会话释放() {
        use crate::ui::chat::placeholders::ImagePlaceholder;
        fn item(path: &str) -> ImagePlaceholder {
            ImagePlaceholder {
                path: path.into(),
                file_name: path.rsplit('/').next().unwrap_or(path).into(),
                size_bytes: Some(1024),
                available: true,
                managed: false,
            }
        }
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let before = model.snapshot().pending_revision;
        assert_eq!(
            model.add_pending_images(vec![item("/tmp/a.png"), item("/tmp/a.png")]),
            1,
            "同路径去重"
        );
        assert_eq!(model.add_pending_images(vec![item("/tmp/b.png")]), 1);
        assert_eq!(model.pending_paths(), vec!["/tmp/a.png", "/tmp/b.png"]);
        let snapshot = model.snapshot();
        assert_eq!(snapshot.pending_images.len(), 2);
        assert!(snapshot.pending_revision > before, "待发送区变化带版本号");

        assert!(model.remove_pending_image("/tmp/a.png"));
        assert!(
            !model.remove_pending_image("/tmp/a.png"),
            "重复撤选是 no-op"
        );
        assert_eq!(model.pending_paths(), vec!["/tmp/b.png"]);

        model.apply_projection(projection("s2", vec![]));
        assert!(model.pending_images().is_empty(), "切会话释放待发送区");
        assert!(
            !model.clear_pending_images(PendingDraftRelease::Discard),
            "已空时清空是 no-op"
        );
    }
    // ==========================================
    // Part 4.3：粘贴草稿的丢弃语义（真建真删，夹具在系统临时目录）
    // ==========================================
    /// 待发送区条目（`managed` 决定丢弃时是否删文件）。
    fn pending_item(path: &std::path::Path, managed: bool) -> ImagePlaceholder {
        ImagePlaceholder {
            path: path.to_string_lossy().into_owned(),
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            size_bytes: Some(4),
            available: true,
            managed,
        }
    }
    /// 丢弃草稿（切会话走同一 `Discard` 分支）：managed 删文件，非 managed 不删。
    #[test]
    fn 丢弃草稿删托管文件但保留用户自有文件() {
        let dir = crate::images::fixtures::temp_dir("chat-model-discard");
        let pasted = dir.join("pasted.png");
        let user_file = dir.join("user.png");
        std::fs::write(&pasted, b"png").unwrap();
        std::fs::write(&user_file, b"png").unwrap();

        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.add_pending_images(vec![pending_item(&pasted, true), pending_item(&user_file, false)]);
        model.apply_projection(projection("s2", vec![]));

        assert!(model.pending_images().is_empty(), "切会话必须释放待发送区");
        assert!(!pasted.exists(), "托管草稿必须随丢弃删除");
        assert!(user_file.exists(), "文件选择器/拖入的用户文件永不删除");
        std::fs::remove_dir_all(dir).unwrap();
    }
    /// 发送释放 = 所有权转移：清列表但**不删文件**（路径已进消息条目）。
    #[test]
    fn 发送释放只清空不删文件() {
        let dir = crate::images::fixtures::temp_dir("chat-model-send");
        let pasted = dir.join("pasted.png");
        std::fs::write(&pasted, b"png").unwrap();

        let mut model = ChatModel::new();
        model.add_pending_images(vec![pending_item(&pasted, true)]);
        assert!(model.clear_pending_images(PendingDraftRelease::Send));

        assert!(model.pending_images().is_empty());
        assert!(pasted.exists(), "发送是所有权转移，文件必须保留");
        std::fs::remove_dir_all(dir).unwrap();
    }
    /// 撤选删单张：只删被撤选的托管文件，同批其它草稿不动。
    #[test]
    fn 撤选删除单张托管草稿且不碰其它草稿() {
        let dir = crate::images::fixtures::temp_dir("chat-model-remove");
        let first = dir.join("first.png");
        let second = dir.join("second.png");
        std::fs::write(&first, b"png").unwrap();
        std::fs::write(&second, b"png").unwrap();

        let mut model = ChatModel::new();
        model.add_pending_images(vec![
            pending_item(&first, true),
            pending_item(&second, true),
        ]);
        assert!(model.remove_pending_image(&first.to_string_lossy()));

        assert!(!first.exists(), "被撤选的托管草稿必须删除");
        assert!(second.exists(), "未被撤选的草稿不得误删");
        assert_eq!(model.pending_paths().len(), 1);

        // 非托管项撤选只移除，不删用户文件。
        let user_file = dir.join("user.png");
        std::fs::write(&user_file, b"png").unwrap();
        model.add_pending_images(vec![pending_item(&user_file, false)]);
        assert!(model.remove_pending_image(&user_file.to_string_lossy()));
        assert!(user_file.exists(), "用户自有文件撤选后原样保留");
        std::fs::remove_dir_all(dir).unwrap();
    }
    /// 丢弃时文件已不存在（或删除失败）只留痕：清理照常完成、不 panic、列表照样清空。
    #[test]
    fn 丢弃失败不阻塞释放() {
        let dir = crate::images::fixtures::temp_dir("chat-model-missing");
        let missing = dir.join("already-gone.png");

        let mut model = ChatModel::new();
        model.add_pending_images(vec![pending_item(&missing, true)]);
        assert!(model.clear_pending_images(PendingDraftRelease::Discard));

        assert!(model.pending_images().is_empty(), "删除失败不阻塞释放");
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn plan_step(id: i64, description: &str) -> super::super::super::events::PlanStepWire {
        super::super::super::events::PlanStepWire {
            id,
            description: description.into(),
            role: None,
            allowed_tools: None,
        }
    }
    #[test]
    fn 回合收尾兜底收起执行中的计划与同会话权限() {
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
        // 确认阶段的计划不因回合收尾被误收（它是「等用户拍板」的面板，没有本地期限，
        // 也不随「运行结束」消失 —— Node 的结算事件才是它的归宿）。
        model.set_run_state("s1", false);
        assert!(model.plan().is_some());
        // 执行中的计划在回合收尾时兜底收起。
        model.plan_begin_executing();
        model.set_run_state("s1", false);
        assert!(model.plan().is_none());
    }
}
