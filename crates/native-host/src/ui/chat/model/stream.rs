//! 投影应用、流式尾巴、阶段/工具状态位与分泡揭示。
//!
//! 这些是 `ChatModel` 的瞬时显示态写入点；终态收敛（提交读模型覆盖流式尾巴）
//! 的规则见 `ChatModel::apply_projection` 与 `ChatModel::stream_end`。

use super::super::events::SimpleStageKey;
use super::super::projection::TranscriptProjection;
use super::{
    texts_compatible, ChatModel, CommittedMessage, DebugState, InterruptedRunView,
    PendingDraftRelease, QueueState, RevealProgress, Role, StatusSnapshot, StatusState,
    StreamingState, ToolActivity, UsageState,
};

impl ChatModel {
    /// 已提交投影整帧覆盖。
    ///
    /// 会话切换会清空瞬时态（流式尾巴、揭示进度、状态位）——与今天
    /// `watch(getActiveSessionId)` 的清理语义一致：切走不显示上一会话的半截正文。
    /// W8b：切会话同时收起计划/权限面板（事件驱动、不属于投影；都按会话归属；
    /// Node 侧对旧会话的确认已按 session_switched 结算，UI 不回执、不复活结算）。
    ///
    /// **面板字段的缺省语义按字段性质分两类**（划分与理由见 `projection.rs` 的
    /// `TranscriptProjection` 文档）：
    /// - 会话/视图态（queue / interrupted / recovered_plans / slash_commands /
    ///   default_delivery）：**随帧权威，缺省即清空** —— 帧内没有的就不该继续留在
    ///   UI 上（否则「已撤回的排队项」「已丢弃的待处置计划」会永远显示）；
    /// - 进程级累计（usage）：**缺省保持现值**（不随会话/帧变化）。
    ///
    /// **终态收敛**：本帧里若已有与流式尾巴「兼容」的助手提交（正文归一化后
    /// 相等或互为前缀），瞬时尾巴立即让位给提交条目，保证终态只显示提交读模型。
    pub fn apply_projection(&mut self, projection: TranscriptProjection) {
        let switched = self.active_session.as_deref() != Some(projection.session_id.as_str());
        if switched {
            self.active_session = Some(projection.session_id.clone());
            self.reveals.clear();
            self.streaming = None;
            self.status = StatusState::default();
            self.running = false;
            // 队列/中断/待处置计划的收口不在这里重复：它们是随帧权威字段，
            // 由下方「缺省即清空」的分支统一处理。
            self.plan = None;
            self.permission = None;
            // 提问面板同口径：切会话即收起（Node 侧已按 session_switched 结算，
            // `deskpet-choice-end` 是它的兜底；UI 不回执、不复活结算）。
            self.choices.clear();
            self.slash.partial = None;
            self.slash.selected = 0;
            self.stream_revision += 1;
            self.status_revision += 1;
            self.panel_revision += 1;
            // 活跃指针变化 = 标签条高亮变化（A1）。
            self.tabs_revision += 1;
            // §5.3：待发送区是用户主动选择后的临时状态，不跨会话（切会话即释放）。
            // Part 4.3：释放即丢弃 —— 粘贴入口的托管草稿当场删文件（用户自有文件不删）。
            self.clear_pending_images(PendingDraftRelease::Discard);
        }
        if let Some(speaker) = projection.speaker_name {
            self.speaker = Some(speaker);
        }
        self.prompts = projection.prompts;
        self.messages = projection
            .messages
            .into_iter()
            .map(CommittedMessage::from_projected)
            .collect();

        // ── 面板读模型（缺省语义按字段性质分两类；划分与理由见 projection.rs）──
        let mut panels_changed = false;
        // 会话/视图态：**随帧权威，缺省即清空** —— 帧内没有的就不该继续留在 UI 上
        // （否则「已撤回的排队项」「已丢弃的待处置计划」会永远显示，没有回收者）。
        let queue = projection.queue.unwrap_or_default();
        let queue = QueueState {
            loaded: queue.loaded,
            running: queue.running,
            items: queue.items,
        };
        if self.queue != queue {
            self.queue = queue;
            panels_changed = true;
        }
        let interrupted = projection
            .interrupted
            .filter(|interrupted| interrupted.active)
            .map(|interrupted| InterruptedRunView {
                operation_id: interrupted.operation_id.unwrap_or_default(),
                kind: interrupted.kind.unwrap_or_default(),
                started_at: interrupted.started_at.unwrap_or(0),
                aborting: interrupted.aborting,
            });
        if self.interrupted != interrupted {
            self.interrupted = interrupted;
            panels_changed = true;
        }
        let recovered_plans = projection.recovered_plans.unwrap_or_default();
        if self.recovered_plans != recovered_plans {
            self.recovered_plans = recovered_plans;
            panels_changed = true;
        }
        let slash_commands = projection.slash_commands.unwrap_or_default();
        if self.slash_commands != slash_commands {
            self.slash_commands = slash_commands;
            panels_changed = true;
        }
        let default_delivery = projection
            .default_delivery
            .as_deref()
            .and_then(super::super::intents::SendDelivery::from_str);
        if self.default_delivery != default_delivery {
            self.default_delivery = default_delivery;
            panels_changed = true;
        }
        // 窗口级视图数据：**缺省保持现值**（帧内携带时整表覆盖；理由见 projection.rs）。
        if let Some(sessions) = projection.sessions {
            if self.sessions != sessions {
                self.sessions = sessions;
                self.tabs_revision += 1;
            }
        }
        if let Some(history) = projection.session_history {
            // 结果到达 = 「读取中」结束（成功与失败都算有回音）；即使列表内容与上次
            // 相同，「读取中」这一提示位的消失也要触发一次面板刷新。
            let was_refreshing = self.history_refreshing;
            self.history_refreshing = false;
            if was_refreshing
                || self.history_loaded != history.loaded
                || self.history_error != history.error
                || self.history_sessions != history.sessions
            {
                self.history_loaded = history.loaded;
                self.history_error = history.error;
                self.history_sessions = history.sessions;
                panels_changed = true;
            }
        }
        // 进程级累计：**缺省保持现值**（不随会话/帧变化；本帧没带只是没重新快照）。
        if let Some(usage) = projection.usage {
            let expanded = self
                .usage
                .as_ref()
                .map(|state| state.expanded)
                .unwrap_or(false);
            self.usage = Some(UsageState {
                entries: usage.entries,
                expanded,
            });
            panels_changed = true;
        }
        // 调试条：与 `usage` 同类（进程级运行期状态，缺省保持现值）；展开开关是
        // 纯 UI 态，由 `DebugState::from_projected` 保留（帧到达不替用户收起面板）。
        if let Some(debug) = projection.debug {
            let next = DebugState::from_projected(debug, self.debug.as_ref());
            if self.debug.as_ref() != Some(&next) {
                self.debug = Some(next);
                panels_changed = true;
            }
        }
        if panels_changed {
            self.panel_revision += 1;
        }

        // 揭示进度只保留本帧仍存在的消息（投影是整帧覆盖，旧 entryId 的状态没有消费者）。
        let live_ids: Vec<String> = self
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        self.reveals
            .retain(|id, _| live_ids.iter().any(|live| live == id));

        if let Some(streaming) = self.streaming.clone() {
            let committed_tail = self
                .messages
                .iter()
                .rev()
                .find(|message| message.role == Role::Assistant)
                .map(|message| message.parts.join("\n"));
            let compatible = committed_tail
                .as_deref()
                .map(|committed| texts_compatible(&streaming.text, committed))
                .unwrap_or(false);
            if compatible {
                self.streaming = None;
                self.stream_revision += 1;
            }
        }
        self.transcript_revision += 1;
    }

    /// 流式增量（`deskpet-assistant-stream`）。
    ///
    /// 只属于当前会话；非当前会话的增量直接丢弃（旧会话的半截正文不得混入）。
    /// 同会话的连续增量做有界合并：文本直接拼接，渲染节奏由 `ui.rs` 的刷新调度
    /// 限频，不在模型里丢字。
    pub fn stream_delta(&mut self, session_id: &str, delta: &str) {
        if self.active_session.as_deref() != Some(session_id) || delta.is_empty() {
            return;
        }
        match self.streaming.as_mut() {
            Some(streaming) if streaming.session_id == session_id => {
                streaming.text.push_str(delta);
            }
            _ => {
                self.streaming = Some(StreamingState {
                    session_id: session_id.to_string(),
                    text: delta.to_string(),
                });
            }
        }
        self.stream_revision += 1;
    }

    /// 流式收尾（`deskpet-assistant-stream-end`）：清掉瞬时尾巴。
    ///
    /// 与今天 ChatPanel 的语义一致：收尾只清瞬时文本，最终气泡由提交路径
    /// （投影帧）推送 —— 终态因此只可能是提交读模型。
    pub fn stream_end(&mut self, session_id: &str) {
        if self.streaming.as_ref().map(|s| s.session_id.as_str()) == Some(session_id) {
            self.streaming = None;
            self.stream_revision += 1;
        }
    }

    /// 阶段提示（`deskpet-stage-hint`）：只收语义 key，文案经投影的 prompts 解析。
    ///
    /// `typing` 属于标题栏状态位（「配信中」），聊天窗不占用底部状态位
    /// （与 ChatPanel 的 `if (stage === "typing") return` 一致）。
    pub fn set_stage_hint(&mut self, session_id: &str, stage: SimpleStageKey) {
        if self.active_session.as_deref() != Some(session_id) {
            return;
        }
        if stage == SimpleStageKey::Typing {
            return;
        }
        self.status.stage = Some(stage);
        self.status.text = self.prompts.get(stage.as_str()).cloned();
        self.status_revision += 1;
    }

    /// 工具开始（`tool-executing`）。
    pub fn tool_executing(&mut self, _tool_id: &str, tool_name: &str) {
        self.status.tool = Some(ToolActivity {
            tool_name: tool_name.to_string(),
            running: true,
            success: None,
        });
        self.status.text = self.prompts.get("executing").cloned();
        self.status_revision += 1;
    }

    /// 工具结束（`tool-completed`）。
    pub fn tool_completed(&mut self, _tool_id: &str, tool_name: &str, success: bool) {
        self.status.tool = Some(ToolActivity {
            tool_name: tool_name.to_string(),
            running: false,
            success: Some(success),
        });
        self.status.text = self
            .prompts
            .get(if success { "done" } else { "blocked" })
            .cloned();
        self.status_revision += 1;
    }

    /// 分泡揭示进度（humanizer 调度器的状态；非当前会话或无投影槽的进度丢弃）。
    pub fn apply_reveal(&mut self, progress: RevealProgress) {
        if self.active_session.as_deref() != Some(progress.session_id.as_str()) {
            return;
        }
        let entry = self.reveals.entry(progress.message_id).or_default();
        // 旧代际的进度不得覆盖新代际。
        if progress.run_generation < entry.run_generation {
            return;
        }
        entry.revealed = progress.revealed;
        entry.part_count = progress.part_count;
        entry.typing = progress.typing;
        entry.run_generation = progress.run_generation;
        self.transcript_revision += 1;
    }

    /// 当前流式尾巴文本（增量渲染路径；避免为一次文本更新克隆整帧）。
    pub fn streaming_text(&self) -> Option<String> {
        self.streaming
            .as_ref()
            .map(|streaming| streaming.text.clone())
    }

    /// 当前底部状态快照。
    pub fn status_snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            text: self.status.text.clone(),
            notice: self.status.notice.clone(),
            running: self.running,
        }
    }
}

impl RevealProgress {
    /// 从 JSON 载荷解析（IPC 接线用；解析失败如实报错）。
    pub fn from_json(payload: &str) -> crate::error::AppResult<Self> {
        serde_json::from_str(payload).map_err(|error| {
            crate::error::AppError::Other(format!("分泡揭示进度解析失败: {error}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;

    fn projection(session: &str, messages: Vec<ProjectedMessage>) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            speaker_name: Some("糖糖".into()),
            messages,
            prompts: Default::default(),
            ..Default::default()
        }
    }

    fn message(id: &str, role: ProjectedRole, text: &str) -> ProjectedMessage {
        ProjectedMessage {
            id: id.into(),
            event_id: None,
            role,
            text: text.into(),
            parts: vec![],
            image_paths: vec![],
            timestamp: 0,
            thinking: None,
            tool_calls: vec![],
            is_error: false,
            tool_call_id: None,
        }
    }

    #[test]
    fn 投影整帧覆盖消息并生成快照() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![
                message("e1", ProjectedRole::User, "你好"),
                message("e2", ProjectedRole::Assistant, "在的"),
            ],
        ));
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0].visible_parts, vec!["你好"]);
        assert_eq!(snapshot.messages[1].role, Role::Assistant);
        assert_eq!(snapshot.active_session.as_deref(), Some("s1"));
    }
    #[test]
    fn 思考与工具调用字段随投影进入快照() {
        let mut model = ChatModel::new();
        let mut assistant = message("e1", ProjectedRole::Assistant, "");
        assistant.thinking = Some("先想想".into());
        assistant.tool_calls = vec![ProjectedToolCall {
            id: "tc1".into(),
            name: "fs.read".into(),
            arguments: "{}".into(),
        }];
        let mut tool = message("e2", ProjectedRole::Tool, "读取失败");
        tool.tool_call_id = Some("tc1".into());
        tool.is_error = true;
        model.apply_projection(projection("s1", vec![assistant, tool]));

        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].thinking.as_deref(), Some("先想想"));
        assert_eq!(snapshot.messages[0].tool_calls.len(), 1);
        assert_eq!(snapshot.messages[0].tool_calls[0].name, "fs.read");
        assert!(!snapshot.messages[0].is_error);
        assert_eq!(snapshot.messages[1].tool_call_id.as_deref(), Some("tc1"));
        assert!(snapshot.messages[1].is_error);
        assert!(snapshot.messages[1].thinking.is_none());
    }
    #[test]
    fn 展示层只认正文与图片_纯工具调用与思考整条跳过() {
        let mut model = ChatModel::new();
        let mut assistant = message("e1", ProjectedRole::Assistant, "");
        assistant.tool_calls = vec![ProjectedToolCall {
            id: "tc1".into(),
            name: "fs.read".into(),
            arguments: "{\"path\":\"/tmp/a\"}".into(),
        }];
        let mut failed = message("e2", ProjectedRole::Tool, "读取失败");
        failed.tool_call_id = Some("tc1".into());
        failed.is_error = true;
        let mut plain_tool = message("e3", ProjectedRole::Tool, "读到 3 行");
        plain_tool.tool_call_id = Some("tc2".into());
        let mut empty = message("e4", ProjectedRole::Assistant, "");
        empty.thinking = Some("  \n ".into()); // 全空白思考 = 没有内容
        model.apply_projection(projection("s1", vec![assistant, failed, plain_tool, empty]));

        let snapshot = model.snapshot();
        // 纯工具调用的助手条目不再算内容（展示层不放工具；2026-10-05 用户规则）。
        assert!(!snapshot.messages[0].has_renderable_content());
        // 有思考但无正文也不算内容（思考不进展示层）。
        assert!(!snapshot.messages[3].has_renderable_content());
        // 带正文的工具结果条目在模型层仍算「有内容」——是否展示由平台按角色裁决。
        assert!(snapshot.messages[2].has_renderable_content());
        // 只有 tool 角色的 is_error 是「失败的工具结果语义」。
        assert!(snapshot.messages[1].is_failed_tool_result());
        assert!(!snapshot.messages[2].is_failed_tool_result());
        assert!(!snapshot.messages[0].is_failed_tool_result());
    }
    /// 「记住这条」入口的唯一判据（两平台右键菜单共用；平台层不各自复刻角色判定）。
    #[test]
    fn 记住这条入口只认用户条目且事件身份非空白() {
        let mut user_ok = message("e1", ProjectedRole::User, "好");
        user_ok.event_id = Some("req-1:user".into());
        let user_none = message("e2", ProjectedRole::User, "没有事件身份");
        let mut user_blank = message("e3", ProjectedRole::User, "空白身份");
        user_blank.event_id = Some("  ".into());
        let mut assistant = message("e4", ProjectedRole::Assistant, "在");
        assistant.event_id = Some("req-1:user".into());
        let mut system = message("e5", ProjectedRole::System, "系统");
        system.event_id = Some("req-1:user".into());
        let mut tool = message("e6", ProjectedRole::Tool, "工具");
        tool.event_id = Some("req-1:user".into());
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![user_ok, user_none, user_blank, assistant, system, tool],
        ));
        let messages = model.snapshot().messages;
        assert_eq!(messages[0].remember_event_id(), Some("req-1:user"));
        assert_eq!(
            messages[1].remember_event_id(),
            None,
            "缺事件身份 = 不提供入口"
        );
        assert_eq!(
            messages[2].remember_event_id(),
            None,
            "空白身份与缺失同义（菜单不得出现）"
        );
        for message in &messages[3..] {
            assert_eq!(
                message.remember_event_id(),
                None,
                "非用户条目没有记忆来源资格：{:?}",
                message.role
            );
        }
    }
    #[test]
    fn 流式增量只进当前会话并拼接() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.stream_delta("s2", "别的会话的增量");
        assert!(model.snapshot().streaming.is_none());
        model.stream_delta("s1", "你");
        model.stream_delta("s1", "好");
        assert_eq!(model.snapshot().streaming.as_deref(), Some("你好"));
    }
    #[test]
    fn 流式收尾清尾巴且提交条目收敛不掉泡() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![message("e1", ProjectedRole::User, "在吗")],
        ));
        model.stream_delta("s1", "在的");
        assert!(model.snapshot().streaming.is_some());
        model.stream_end("s1");
        assert!(model.snapshot().streaming.is_none());

        // 提交条目到达：只显示提交正文，无重复。
        model.apply_projection(projection(
            "s1",
            vec![
                message("e1", ProjectedRole::User, "在吗"),
                message("e2", ProjectedRole::Assistant, "在的"),
            ],
        ));
        let snapshot = model.snapshot();
        assert!(snapshot.streaming.is_none());
        assert_eq!(snapshot.messages.len(), 2);
    }
    #[test]
    fn 提交帧也能让兼容的流式尾巴立即收敛() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        // 分泡标记按 humanizer 协议独占一行（`protocol.ts`「分泡独占一行」）；
        // 归一化只剥离「标记行」，此前 fixture 把标记写成行内形态，不是流能产出的形状。
        model.stream_delta("s1", "前半\n<<SPLIT>>\n后半");
        // 提交文本是剥掉分泡标记后的合并正文：归一化后前缀兼容 → 尾巴让位。
        model.apply_projection(projection(
            "s1",
            vec![message("e2", ProjectedRole::Assistant, "前半\n后半")],
        ));
        assert!(model.snapshot().streaming.is_none());
    }
    #[test]
    fn 切会话清理瞬时态且揭示进度不跨会话() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![message("e1", ProjectedRole::Assistant, "一")],
        ));
        model.stream_delta("s1", "半截");
        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 1,
            revealed: 1,
            part_count: 3,
            typing: true,
        });
        model.apply_projection(projection(
            "s2",
            vec![message("e9", ProjectedRole::Assistant, "新会话")],
        ));
        let snapshot = model.snapshot();
        assert!(snapshot.streaming.is_none());
        assert_eq!(
            snapshot.messages[0].visible_parts.len(),
            1,
            "新会话消息完整可见"
        );
        assert_eq!(snapshot.messages[0].pending_parts, 0);
    }
    #[test]
    fn 揭示进度按消息标识裁剪泡数() {
        let mut model = ChatModel::new();
        let mut parts = vec!["一".to_string(), "二".to_string(), "三".to_string()];
        let mut first = message("e1", ProjectedRole::Assistant, "一二三");
        first.parts = parts.clone();
        model.apply_projection(projection("s1", vec![first]));
        parts.clear();

        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 7,
            revealed: 2,
            part_count: 3,
            typing: true,
        });
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].visible_parts, vec!["一", "二"]);
        assert_eq!(snapshot.messages[0].pending_parts, 1);

        // 旧代际进度不得覆盖新代际。
        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 6,
            revealed: 1,
            part_count: 3,
            typing: false,
        });
        assert_eq!(model.snapshot().messages[0].visible_parts.len(), 2);
    }
    #[test]
    fn 无揭示状态的消息完整显示() {
        let mut model = ChatModel::new();
        let mut first = message("e1", ProjectedRole::Assistant, "全场");
        first.parts = vec!["一".into(), "二".into()];
        model.apply_projection(projection("s1", vec![first]));
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].visible_parts.len(), 2);
        assert_eq!(snapshot.messages[0].pending_parts, 0);
    }
    #[test]
    fn 阶段提示经投影文案解析() {
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.prompts.insert("thinking".into(), "让我想想".into());
        model.apply_projection(frame);
        model.set_stage_hint("s1", SimpleStageKey::Thinking);
        assert_eq!(model.snapshot().status.text.as_deref(), Some("让我想想"));
        // typing 不占用底部状态位。
        model.set_stage_hint("s1", SimpleStageKey::Typing);
        assert_eq!(model.snapshot().status.text.as_deref(), Some("让我想想"));
    }
    #[test]
    fn 图片只折叠为占位元数据不读内容() {
        let mut model = ChatModel::new();
        let mut first = message("e1", ProjectedRole::User, "看图");
        first.image_paths = vec!["/definitely/not/here.png".into()];
        model.apply_projection(projection("s1", vec![first]));
        let snapshot = model.snapshot();
        let placeholder = &snapshot.messages[0].images[0];
        assert!(!placeholder.available, "不存在的文件只报不可用");
        assert_eq!(placeholder.file_name, "here.png");
        assert!(placeholder.size_bytes.is_none());
    }
    #[test]
    fn 投影面板字段按性质分缺省语义() {
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.queue = Some(super::super::super::projection::ProjectedQueue {
            loaded: true,
            running: true,
            items: vec![super::super::super::projection::ProjectedQueuedItem {
                entry_id: "e1".into(),
                kind: super::super::super::projection::ProjectedQueuedKind::NextRun,
                text: "暂停项".into(),
                request_id: None,
            }],
        });
        frame.interrupted = Some(super::super::super::projection::ProjectedInterruptedRun {
            active: true,
            operation_id: Some("op1".into()),
            kind: Some("run".into()),
            started_at: Some(7),
            aborting: false,
        });
        frame.usage = Some(super::super::super::projection::ProjectedUsage {
            entries: vec![super::super::super::projection::ProjectedUsageEntry {
                purpose: "main".into(),
                calls: 2,
                reported: 1,
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
                total: 150,
            }],
        });
        frame.slash_commands = Some(vec![super::super::super::projection::SlashCommandView {
            name: "help".into(),
            description: "查看帮助".into(),
        }]);
        frame.recovered_plans = Some(vec![super::super::super::projection::ProjectedRecoveredPlan {
            plan_id: "p1".into(),
            session_id: "s1".into(),
            summary: "旧计划".into(),
            steps: vec![],
        }]);
        frame.default_delivery = Some("followUp".into());
        model.apply_projection(frame);
        assert_eq!(model.queue().items.len(), 1);
        assert!(model.interrupted().is_some());
        assert_eq!(
            model.snapshot().default_delivery,
            Some(super::super::super::intents::SendDelivery::FollowUp)
        );
        assert_eq!(model.snapshot().recovered_plans.len(), 1);
        model.note_input_text("/");
        assert!(model.slash_visible(), "slash 注册表来自本帧投影");
        model.note_input_text("");

        // 会话/视图态：随帧权威，缺省即清空（帧内没有的不再保留 —— 「已撤回的
        // 排队项」「已丢弃的待处置计划」必须随帧消失）。
        model.apply_projection(projection("s1", vec![]));
        assert!(
            model.queue().items.is_empty() && !model.queue().loaded,
            "空帧清空队列"
        );
        assert!(model.interrupted().is_none(), "空帧清空中断");
        assert!(
            model.snapshot().default_delivery.is_none(),
            "空帧清空默认投递显示"
        );
        assert!(
            model.snapshot().recovered_plans.is_empty(),
            "空帧清空待处置计划"
        );
        model.note_input_text("/");
        assert!(!model.slash_visible(), "空帧清空 slash 注册表");
        model.note_input_text("");

        // 进程级累计：用量缺省保持现值（空帧不抖掉进度型数据）。
        assert!(model.snapshot().usage.is_some(), "空帧不清空用量");

        // 中断的显式清空态（active=false）与缺省清空等价。
        let mut reactivate = projection("s1", vec![]);
        reactivate.interrupted = Some(super::super::super::projection::ProjectedInterruptedRun {
            active: true,
            operation_id: Some("op2".into()),
            kind: Some("run".into()),
            started_at: Some(8),
            aborting: false,
        });
        model.apply_projection(reactivate);
        assert!(model.interrupted().is_some());
        let mut clear = projection("s1", vec![]);
        clear.interrupted = Some(Default::default());
        model.apply_projection(clear);
        assert!(model.interrupted().is_none());
    }
}
