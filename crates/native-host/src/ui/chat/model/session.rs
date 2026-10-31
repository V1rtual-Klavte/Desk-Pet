//! 会话标签、历史面板与输入区浮层开关（窗口级视图数据与纯 UI 开关）。

use super::super::projection::ProjectedSession;
use super::{display_session_name, ChatModel, SessionTabView};

impl ChatModel {
    // ==========================================
    // A1：会话标签与历史（窗口级视图数据）
    // ==========================================

    /// 会话标签列表（投影整表覆盖后保持；平台层标签条取 `session_tabs()`）。
    pub fn sessions(&self) -> &[ProjectedSession] {
        &self.sessions
    }

    /// 标签条的展示视图（活跃指针 = `active_session`；多于一个标签才给关闭入口）。
    pub fn session_tabs(&self) -> Vec<SessionTabView> {
        let closable = self.sessions.len() > 1;
        self.sessions
            .iter()
            .map(|session| SessionTabView {
                id: session.id.clone(),
                name: display_session_name(&session.name),
                interrupted: session.interrupted,
                active: self.active_session.as_deref() == Some(session.id.as_str()),
                closable,
            })
            .collect()
    }

    /// 展开/收起历史面板；返回展开后的状态（展开时由 `ChatUi` 追加一次刷新请求）。
    pub fn toggle_history(&mut self) -> bool {
        self.history_open = !self.history_open;
        self.panel_revision += 1;
        self.history_open
    }

    /// 收起历史面板（不动数据；「关闭」按钮）。
    pub fn close_history(&mut self) -> bool {
        if !self.history_open {
            return false;
        }
        self.history_open = false;
        self.panel_revision += 1;
        true
    }

    pub fn history_open(&self) -> bool {
        self.history_open
    }

    /// 点把手：开合浮层。返回操作之后**实际**的开合态。
    pub fn toggle_inspector(&mut self) -> bool {
        self.inspector_open = !self.inspector_open;
        self.inspector_open
    }

    /// 收起浮层（点浮层外或 ✕）。已经收着时是空操作。
    pub fn close_inspector(&mut self) {
        self.inspector_open = false;
    }

    /// 浮层是否开着。
    pub fn inspector_open(&self) -> bool {
        self.inspector_open
    }

    /// 登记「历史请求已送出 / 已收场」；结果到达（投影 `session_history`）时由
    /// `apply_projection` 自动清除。派发失败时调用方以 `false` 收场（不留假的「读取中」）。
    pub fn set_history_refreshing(&mut self, refreshing: bool) -> bool {
        if self.history_refreshing == refreshing {
            return false;
        }
        self.history_refreshing = refreshing;
        self.panel_revision += 1;
        true
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

    // ==========================================
    // A1：会话标签与历史
    // ==========================================
    fn sessions_projection(session: &str, sessions: &[(&str, &str)]) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            messages: vec![message("e1", ProjectedRole::User, "你好")],
            sessions: Some(
                sessions
                    .iter()
                    .map(|(id, name)| crate::ui::chat::projection::ProjectedSession {
                        id: (*id).into(),
                        name: (*name).into(),
                        created_at: 0,
                        interrupted: false,
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }
    #[test]
    fn 会话标签整表覆盖且缺省保持() {
        let mut model = ChatModel::new();
        model.apply_projection(sessions_projection(
            "s1",
            &[("s1", "新会话"), ("s2", "聊工作")],
        ));
        let tabs = model.snapshot().sessions;
        assert_eq!(tabs.len(), 2);
        assert!(
            tabs[0].active && tabs[0].closable,
            "活跃标签 + 多于一个可关闭"
        );
        assert!(!tabs[1].active);
        assert_eq!(tabs[1].name, "聊工作");

        // 不带 sessions 的投影帧：保持现值（窗口级视图数据，不是清空）。
        let mut bare = projection("s1", vec![message("e2", ProjectedRole::User, "在吗")]);
        bare.sessions = None;
        model.apply_projection(bare);
        assert_eq!(model.snapshot().sessions.len(), 2, "缺省保持标签列表");

        // 切换活跃会话：高亮跟随（session_id 变化）。
        let mut switched = projection("s2", vec![]);
        switched.sessions = None;
        model.apply_projection(switched);
        let tabs = model.snapshot().sessions;
        assert!(tabs[1].active && !tabs[0].active, "活跃指针随投影切换");

        // 只有一个标签时不提供关闭入口。
        model.apply_projection(sessions_projection("s2", &[("s2", "聊工作")]));
        assert!(!model.snapshot().sessions[0].closable);
    }
    #[test]
    fn 空名会话回落新会话且中断标记透传() {
        let mut model = ChatModel::new();
        let mut frame = sessions_projection("s1", &[("s1", "  ")]);
        if let Some(sessions) = frame.sessions.as_mut() {
            sessions[0].interrupted = true;
        }
        model.apply_projection(frame);
        let tabs = model.snapshot().sessions;
        assert_eq!(tabs[0].name, "新会话");
        assert!(tabs[0].interrupted);
    }
    #[test]
    fn 历史面板打开收起与读取态() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(!model.history_open());
        assert!(model.toggle_history(), "首次切换 = 展开");
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::SessionHistory)
            .expect("展开后历史面板存在");
        assert!(view_lines(&history)
            .iter()
            .any(|(_, text)| *text == "尚未载入"));

        // 刷新登记「读取中」；结果到达（投影）清除并填充列表。
        model.set_history_refreshing(true);
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(crate::ui::chat::projection::ProjectedSessionHistory {
            loaded: true,
            error: false,
            sessions: vec![crate::ui::chat::projection::ProjectedHistorySession {
                id: "s2".into(),
                name: "聊工作".into(),
                // created_at = 0 格式化不出日期：卡片上若出现日期，只可能来自 activity_at。
                created_at: 0,
                activity_at: Some(1_700_000_000_000),
                message_count: 3,
            }],
        });
        model.apply_projection(frame);
        assert!(model.history_open(), "投影不改变面板开合（纯 UI 开关）");
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        assert!(
            view_cards(&history).len() == 1,
            "一个会话一张卡（渲染成卡片而不是行）"
        );
        assert!(
            view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "聊工作"),
            "历史卡片渲染"
        );
        assert!(
            !view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "正在读取…"),
            "结果到达后收起读取中"
        );
        // 卡片日期取用户活动时间（created_at = 0 无日期可显示，出现日期即证来源）。
        let activity_date =
            super::super::super::panels::format_session_date(1_700_000_000_000).expect("活动时间可格式化");
        assert!(
            view_lines(&history)
                .iter()
                .any(|(_, text)| *text == format!("{activity_date} · 3 条")),
            "历史卡片日期应取 activity_at（回退 createdAt）"
        );

        // 关闭 = 面板消失（数据保留，重开即见）。
        assert!(model.close_history());
        assert!(model
            .panel_views()
            .iter()
            .all(|view| view.kind != super::super::super::panels::PanelKind::SessionHistory));
        model.toggle_history();
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        let cards = view_cards(&history);
        assert_eq!(cards.len(), 1, "一个会话 = 一张卡片（用户规则的「气泡」）");
        assert!(
            view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "聊工作"),
            "重开即见旧数据"
        );
        assert!(
            view_lines(&history).iter().any(|(style, text)| *style
                == super::super::super::panels::PanelLineStyle::Dim
                && text.ends_with("3 条")),
            "日期/条数行按 Dim 呈现（次要信息变小变淡）"
        );
        // 卡片内按钮：恢复 / 删除 各一个动作（底部另有刷新 / 关闭）。
        let buttons = view_buttons(&history);
        let labels: Vec<&str> = buttons.iter().map(|button| button.label.as_str()).collect();
        assert_eq!(labels, vec!["恢复", "删除", "刷新", "关闭"]);
        assert!(matches!(
            buttons[0].action,
            super::super::super::panels::PanelAction::RestoreSessionFromHistory { .. }
        ));
        assert!(matches!(
            buttons[1].action,
            super::super::super::panels::PanelAction::DeleteSessionFromHistory { .. }
        ));
    }
    #[test]
    fn 历史读取失败与空列表不同形() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.toggle_history();
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(crate::ui::chat::projection::ProjectedSessionHistory {
            loaded: true,
            error: true,
            sessions: vec![],
        });
        model.apply_projection(frame);
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        assert!(view_lines(&history)
            .iter()
            .any(|(_, text)| text.contains("读取失败")));
        assert!(
            !view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "暂无历史会话"),
            "失败不冒充空"
        );
    }
    // ── 面板 blocks 的测试辅助（保序块扁平化）──

    /// 面板里所有块级按钮（保序 blocks 的 Buttons 块扁平化）。
    /// 面板里的卡片块（`PanelBlock::Card`）的内部块（按声明顺序）。
    fn view_cards(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<&Vec<crate::ui::chat::panels::PanelBlock>> {
        view.blocks
            .iter()
            .filter_map(|block| match block {
                crate::ui::chat::panels::PanelBlock::Card(blocks) => Some(blocks),
                _ => None,
            })
            .collect()
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

    /// 面板里所有文本行（style + 文本；含卡片内部）。
    fn view_lines(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<(crate::ui::chat::panels::PanelLineStyle, &str)> {
        fn walk<'a>(
            blocks: &'a [crate::ui::chat::panels::PanelBlock],
            out: &mut Vec<(crate::ui::chat::panels::PanelLineStyle, &'a str)>,
        ) {
            use crate::ui::chat::panels::PanelBlock;
            for block in blocks {
                match block {
                    PanelBlock::Line { style, text } => out.push((*style, text.as_str())),
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
