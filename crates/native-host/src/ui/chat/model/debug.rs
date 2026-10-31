//! 调试条：消耗行文案、思考强度/安全策略下拉与投影快照的构造。

use crate::ui::settings::schema::SAFETY_MODE;
use super::super::projection::{ProjectedDebug, ProjectedUsageEntry};
use super::{usage_purpose_label, DebugState};

impl DebugState {
    /// 由投影快照构造，保留纯 UI 的展开开关（帧到达不替用户收起面板）。
    pub(super) fn from_projected(projected: ProjectedDebug, previous: Option<&DebugState>) -> Self {
        Self {
            last_context_usage: projected.last_context_usage,
            last_tool_names: projected.last_tool_names,
            registered_tools: projected.registered_tools,
            thinking_effort: projected.thinking_effort,
            safety_mode: projected.safety_mode,
            tools_expanded: previous.map(|state| state.tools_expanded).unwrap_or(false),
            registry_expanded: previous
                .map(|state| state.registry_expanded)
                .unwrap_or(false),
        }
    }
}

// `debug_tools_label` 删除记录（2026-10-06 用户规则「删绿字」）：meta 行不再压缩展示
// 最近一次请求的工具名（那段整体的消费者是 meta 行），没有第二个调用方，随字段退场。
// 完整工具名列表仍在「工具明细」展开里逐条显示（`last_tool_names` 不删）。

/// 调试条的「消耗行」文本（累计口径）：主回合桶的 入 / 出 / 命中率。
///
/// **为什么取累计桶而不是 per-request**：用户问的是「token 花了多少」（消耗），
/// 而命中率只在分桶里存在（per-request 只存 `lastPromptTokens`，且它是 Provider
/// 归一后的**未命中**输入，不含缓存命中——正是旧「Token」一格显得像算错的原因）。
/// 全用途（含压缩/规划/记忆等一次性调用）的总量另有「Σ 用量」入口，这里只报
/// **主回合**的消耗，两个口径不混。
///
/// 2026-10-06 用户裁决（原话「给下面的输入输出 缓存命中率」）：**固定三段 —— 入 / 出 / 命中率**；
/// 裸的「缓存读/写」段退场（读的信息量已被命中率与入/出覆盖；写是 Anthropic 独有的
/// 口径，用户未要）。只列有值的分段（出为 0 不写）；一个分段都没有（尚无已回报用量）
/// 返回 `None` —— 不摆「入 — / 出 —」的空壳。跨 1000 的量级走 `format_tokens` 缩写。
///
/// **缓存命中率** = `缓存读 ÷ 输入总量`，输入总量 = 读 + 未命中输入 + 缓存写，与 Node 的
/// `totalInputTokens`（`context/budget.ts` 的真实输入口径）同源：pi-ai 把 `input`
/// 归一成**缓存未命中**部分，三者相加才是这次请求真实的输入规模；分母不算缓存写会把
/// Anthropic 这类「写入占大头」的请求命中率算虚高。DeepSeek 不回报 cacheWrite，
/// 此式即用户建议的「缓存读 ÷ (输入 + 缓存读)」。
/// 分母为 0 = 没有任何已回报输入（还没请求过）→ **省略这一段**：不显示 0% 冒充
/// 「命中率为零」。有输入但没有缓存读时 0% 是真读数，照显示。
///
/// 宽度：三段合计实测 209–249pt（含用户样本 275.9k/27.6k 量级），265pt 列
/// （内宽 257pt）放得下，不依赖平台截断（见测试 `调试条两行在265列宽内放得下`）。
pub(super) fn debug_spend_line(entries: &[ProjectedUsageEntry]) -> Option<String> {
    use super::super::panels::format_tokens;
    // 主回合桶恒存在（Node 的 `collectUsage` 固定输出七个 purpose），仍按查找处理：
    // 找不到就不显示，不猜别的桶冒充。
    let main = entries.iter().find(|entry| entry.purpose == "main")?;
    let mut parts: Vec<String> = Vec::new();
    if main.input > 0 {
        parts.push(format!("入 {}", format_tokens(main.input)));
    }
    if main.output > 0 {
        parts.push(format!("出 {}", format_tokens(main.output)));
    }
    // 命中率分母 = 这次请求的真实输入总量（含不再单列的缓存读/写，见函数文档）；
    // 0 不显示 0% 冒充读数缺失。
    let input_total = main.input + main.cache_read + main.cache_write;
    if input_total > 0 {
        let hit_rate = (main.cache_read as f64 / input_total as f64 * 100.0).round() as u64;
        parts.push(format!("命中 {hit_rate}%"));
    }
    if parts.is_empty() {
        return None;
    }
    // 标签与用量明细行同源（`usage_purpose_label` 的「主回合」），措辞不在第二处定义。
    Some(format!(
        "{} {}",
        usage_purpose_label(&main.purpose),
        parts.join(" · ")
    ))
}

/// 调试条的思考强度下拉：选项 = CONFIG `ai.thinking.effort` 的值域
/// （auto/low/medium/high/max，与旧壳 `DebugBar.vue` 的 select 逐字一致），**没有
/// 「默认」项**；选中态来自投影里的配置现值（未知值按第一档显示）。
pub(super) fn thinking_effort_select(debug: &DebugState) -> super::super::panels::PanelSelect {
    use super::super::panels::{PanelAction, PanelOption, PanelSelect};
    const VALUES: [&str; 5] = ["auto", "low", "medium", "high", "max"];
    let options = VALUES
        .iter()
        .map(|value| PanelOption {
            label: (*value).to_string(),
            action: PanelAction::SetThinkingEffort {
                effort: (*value).to_string(),
            },
        })
        .collect();
    let selected = VALUES
        .iter()
        .position(|value| *value == debug.thinking_effort)
        .unwrap_or(0);
    PanelSelect {
        // 列窄（~265px）：label 取两字短名，下拉框放得下不截断（全称信息在选项语义里）。
        label: "思考".into(),
        options,
        selected,
    }
}

/// 调试条的安全策略下拉：选项表 = 设置页「确认策略」同一份
/// （`settings::schema::SAFETY_MODE`：全放行 / 告知确认 / 全部确认），**没有
/// 「默认」项**；选中态来自投影里的配置现值（未知值按第一档显示）。
pub(super) fn safety_mode_select(debug: &DebugState) -> super::super::panels::PanelSelect {
    use super::super::panels::{PanelAction, PanelOption, PanelSelect};
    let options: Vec<PanelOption> = SAFETY_MODE
        .iter()
        .map(|choice| PanelOption {
            label: choice.label.to_string(),
            action: PanelAction::SetSafetyMode {
                mode: choice.value.to_string(),
            },
        })
        .collect();
    let selected = SAFETY_MODE
        .iter()
        .position(|choice| choice.value == debug.safety_mode)
        .unwrap_or(0);
    PanelSelect {
        // 与「思考」同口径的两字短名（列窄，避免 label 截断）。
        label: "安全".into(),
        options,
        selected,
    }
}

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

    #[test]
    fn 调试条面板随投影显示且标记当前选择() {
        use crate::ui::chat::panels::{PanelAction, PanelBlock, PanelKind, PanelView};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: Some(42),
            last_tool_names: vec!["fs.read".into(), "bash".into()],
            registered_tools: vec![],
            thinking_effort: "auto".into(),
            safety_mode: "tell_me".into(),
        });
        frame.usage = Some(crate::ui::chat::projection::ProjectedUsage {
            entries: vec![crate::ui::chat::projection::ProjectedUsageEntry {
                purpose: "main".into(),
                calls: 3,
                reported: 3,
                input: 3_456,
                output: 789,
                cache_read: 12_345,
                cache_write: 0,
                total: 16_590,
            }],
        });
        model.apply_projection(frame);
        // 完整形态（2026-10-05 用户规则）：面板整块住在上拉抽屉里，面板自身不再有
        // 「调试信息 ▸」把手，思考/安全下拉直接可见。
        let panel = debug_panel(&model);
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Buttons(buttons)
                    if buttons.iter().any(|button| button.label.starts_with("调试信息"))
            )),
            "面板内不再有整体折叠把手（抽屉即折叠）"
        );
        assert!(
            panel
                .blocks
                .iter()
                .filter(|b| matches!(b, PanelBlock::Select(_)))
                .count()
                == 2,
            "思考强度与安全策略两个下拉直接可见"
        );
        // 上下文行（2026-10-05 用户规则「token 花了多少，输入输出，缓存也要写」：
        // 「Token {tokens}」一格退场、消耗另起一行；2026-10-06 用户规则「删绿字」：
        // 「工具 …」「注册 N (MCP:N)」两段退场，行内只剩上下文占用）。防回退：断言精确
        // 文本 + 不再有 Token/工具名/注册数段。
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text == "上下文 42%"
            )),
            "上下文行只余上下文占用"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text.starts_with("Token")
            )),
            "Token 段整体退场（不再有 Token 行/段）"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. }
                    if text.contains("注册") || text.contains("· 工具")
            )),
            "绿字行的工具名与注册数两段退场（删字段不留壳）"
        );
        // 消耗行：主回合桶的 入/出/命中率 三段（跨千走量级缩写；裸的缓存读/写段已退场）。
        // 命中率 = 12.3k/(3.5k+12.3k) ≈ 78%（分桶里 input 是未命中部分，见 debug_spend_line）。
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. }
                    if text == "主回合 入 3.5k · 出 789 · 命中 78%"
            )),
            "消耗行取主回合桶、入/出/命中率三段"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text.contains("缓存")
            )),
            "裸的缓存读/写段退场（命中率承载缓存信息）"
        );

        // 两个会话级覆盖是下拉（旧壳 select 的迁移）：选中态来自投影。
        let selects: Vec<_> = panel
            .blocks
            .iter()
            .filter_map(|b| match b {
                PanelBlock::Select(select) => Some(select),
                _ => None,
            })
            .collect();
        assert_eq!(selects.len(), 2, "思考强度与安全策略各一个下拉");
        // 「默认」项退场（2026-10-06 用户裁决）：选项即配置值域，选中态来自投影里的
        // 配置现值（thinking_effort=auto → 第一档）。
        assert_eq!(selects[0].label, "思考");
        assert_eq!(selects[0].selected, 0, "auto 选中第一档");
        assert_eq!(
            selects[0].options[0].action,
            PanelAction::SetThinkingEffort {
                effort: "auto".into()
            }
        );
        assert_eq!(
            selects[0].options[1].action,
            PanelAction::SetThinkingEffort {
                effort: "low".into()
            },
            "档位动作携带 CONFIG 字面量"
        );
        assert!(
            selects[0]
                .options
                .iter()
                .all(|option| !matches!(&option.action, PanelAction::SetThinkingEffort { effort } if effort.is_empty())),
            "不存在空档位（「默认」项已退场）"
        );
        // safety_mode=tell_me → 选中「告知确认」；选项表与设置页同一份（文案不另立）。
        assert_eq!(selects[1].label, "安全");
        assert_eq!(
            selects[1]
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            SAFETY_MODE
                .iter()
                .map(|choice| choice.label)
                .collect::<Vec<_>>(),
            "安全选项文案必须与设置页同一份（不另立第二份表）"
        );
        assert_eq!(selects[1].selected, 1, "tell_me 选中告知确认");
        assert_eq!(
            selects[1].options[0].action,
            PanelAction::SetSafetyMode {
                mode: "just_do_it".into()
            }
        );
        assert_eq!(
            selects[1].options[1].action,
            PanelAction::SetSafetyMode {
                mode: "tell_me".into()
            }
        );

        // 「工具明细」「注册明细」「压缩」是 chip（设计稿 `.pbox.debug` 的 `.chip`；紧随
        // meta 行成一行，点击展开自有列表或派发压缩）。2026-10-06 起数量不再上 meta 行
        // （「删绿字」规则），明细入口保留 —— 它们是显式展开动作，不是常显文本。
        let chips: Vec<_> = panel
            .blocks
            .iter()
            .flat_map(|b| match b {
                PanelBlock::Buttons(buttons) => buttons.iter().collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect();
        assert!(chips.iter().any(|button| button.label == "工具明细"));
        assert!(chips.iter().any(|button| button.label == "注册明细"));
        // 「压缩」按钮必须指向压缩动作本身（改坏映射这条立即红）。
        assert!(
            chips
                .iter()
                .any(|button| button.label == "压缩" && button.action == PanelAction::CompactSession),
            "压缩按钮必须携带 CompactSession 动作"
        );

        // 展开开关是纯本地态：切换后出现明细；后续帧（不带 debug）保持现值与展开态。
        assert!(model.toggle_debug_tools());
        assert!(debug_panel(&model)
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "· fs.read")));
        model.apply_projection(projection("s1", vec![]));
        let panel = debug_panel(&model);
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "上下文 42%")), "缺省保持现值");
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "主回合 入 3.5k · 出 789 · 命中 78%")), "消耗行随用量现值保留");
        assert!(
            panel
                .blocks
                .iter()
                .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "· fs.read")),
            "展开态保留"
        );
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Select(_))));

        // 没有投影数据时不显示调试条（不摆空壳）。
        let mut empty = ChatModel::new();
        empty.apply_projection(projection("s1", vec![]));
        assert!(empty
            .panel_views()
            .iter()
            .all(|view| view.kind != PanelKind::DebugBar));

        fn debug_panel(model: &ChatModel) -> PanelView {
            model
                .panel_views()
                .into_iter()
                .find(|view| view.kind == PanelKind::DebugBar)
                .expect("调试条应显示")
        }
    }
    #[test]
    fn 消耗行入出与命中率三段且缓存读写不再单列() {
        use crate::ui::chat::projection::{ProjectedUsage, ProjectedUsageEntry};
        fn usage_of(input: u64, output: u64, cache_read: u64, cache_write: u64) -> ProjectedUsage {
            ProjectedUsage {
                entries: vec![ProjectedUsageEntry {
                    purpose: "main".into(),
                    calls: 1,
                    reported: 1,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    total: input + output + cache_read + cache_write,
                }],
            }
        }
        // 读、写都有（Anthropic 形态）：缓存读/写不再单列，只以命中率承载缓存信息。
        // 命中率 = 8000/(1200+8000+4000) = 60.6% → 61%（分母含缓存写，与 totalInputTokens 同源）。
        let both = debug_spend_line(&usage_of(1200, 300, 8000, 4000).entries);
        assert_eq!(both.as_deref(), Some("主回合 入 1.2k · 出 300 · 命中 61%"));
        assert!(
            !both.as_deref().unwrap_or_default().contains("缓存"),
            "裸的缓存读/写段已退场（2026-10-06 用户裁决的三段形态）"
        );
        // 只有读（DeepSeek 的实际形态，日志样本：in=731 / cacheRead=12160）：
        // 命中率 = 12160/12891 = 94.3% → 94%。
        assert_eq!(
            debug_spend_line(&usage_of(731, 323, 12160, 0).entries).as_deref(),
            Some("主回合 入 731 · 出 323 · 命中 94%")
        );
        // 只有写、无读：有输入但零命中是真读数，照显示 0%（不冒充缺失）。
        assert_eq!(
            debug_spend_line(&usage_of(100, 0, 0, 5000).entries).as_deref(),
            Some("主回合 入 100 · 命中 0%")
        );
        // 输入全部命中缓存（未命中 input=0）→ 100%，且不写「入 0」空段。
        assert_eq!(
            debug_spend_line(&usage_of(0, 500, 8000, 0).entries).as_deref(),
            Some("主回合 出 500 · 命中 100%")
        );
        // 分母为 0（没有任何已回报输入）→ 命中率整段省略：不显示 0% 冒充「命中率为零」。
        assert_eq!(
            debug_spend_line(&usage_of(0, 30, 0, 0).entries).as_deref(),
            Some("主回合 出 30")
        );
        // 一个分段都没有（尚无已回报用量）→ 不摆空壳（与 Σ 用量为 0 整条不显示同旨）。
        assert_eq!(debug_spend_line(&usage_of(0, 0, 0, 0).entries), None);
        // 没有主回合桶（异常投影）→ 不拿别的桶冒充主回合口径。
        let compaction_only = ProjectedUsage {
            entries: vec![ProjectedUsageEntry {
                purpose: "compaction".into(),
                calls: 1,
                reported: 1,
                input: 9,
                output: 9,
                cache_read: 0,
                cache_write: 0,
                total: 18,
            }],
        };
        assert_eq!(debug_spend_line(&compaction_only.entries), None);
    }
    #[test]
    fn 工具明细为空时写明是最近一次请求() {
        use crate::ui::chat::panels::{PanelBlock, PanelKind};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: Some(5),
            last_tool_names: vec![],
            registered_tools: vec![],
            thinking_effort: "auto".into(),
            safety_mode: "tell_me".into(),
        });
        model.apply_projection(frame);
        assert!(model.toggle_debug_tools());
        let panel = model
            .panel_views()
            .into_iter()
            .find(|view| view.kind == PanelKind::DebugBar)
            .expect("调试条应显示");
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text == "最近一次请求未携带工具"
            )),
            "占位行必须与 meta 行同指「最近一次」（本次/上次的歧义是用户报告的困惑；\
             改回「本次请求未携带工具」这条立即红）"
        );
    }
    #[test]
    fn 上下文未知显示破折号而不是零() {
        // 2026-10-06（用户报告「重启后 上下文 0%」）：null = 未知必须与真 0% 不同形 ——
        // 显示「—」且用 Dim（无值态），不落进 Ok 绿；真 0% 是另一条路径（有读数）照常显示。
        use crate::ui::chat::panels::{PanelBlock, PanelKind, PanelLineStyle};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: None,
            last_tool_names: vec![],
            registered_tools: vec![],
            thinking_effort: "auto".into(),
            safety_mode: "tell_me".into(),
        });
        model.apply_projection(frame);
        let panel = model
            .panel_views()
            .into_iter()
            .find(|view| view.kind == PanelKind::DebugBar)
            .expect("调试条应显示");
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, style, .. }
                    if text == "上下文 —" && *style == PanelLineStyle::Dim
            )),
            "未知读数显示「—」（Dim），不显示 0% 冒充「上下文是空的」"
        );
        assert!(
            !panel
                .blocks
                .iter()
                .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "上下文 0%")),
            "不得把未知渲染成 0%（这正是用户报告的重启形态）"
        );
    }
    /// 265pt 聊天列（默认值）的布局守门：两行各自都要放得下，不靠平台截断兜底。
    /// 内宽 = 列宽 − 2×`pad_x`；估算字号 11pt（两平台面板行同为小号）。
    ///
    /// 2026-10-06（用户规则「删绿字 + 下行加缓存命中率」，随后的用户裁决把消耗行定为
    /// **三段**：入 / 出 / 命中率，裸的缓存读/写退场）：上下文行只剩一格；
    /// 消耗行三段在典型值与**用户样本量级**（275.9k / 27.6k / 命中率）下都 ≤ 内宽，
    /// 这正是三段形态取代「四段 + 平台截断」的理由 —— 若日后又塞回第四段，这条会先红。
    #[test]
    fn 调试条两行在265列宽内放得下() {
        use crate::ui::chat::panels::{estimated_text_width, PANEL_METRICS};
        use crate::ui::chat::projection::{ProjectedUsage, ProjectedUsageEntry};
        let inner = 265.0 - PANEL_METRICS.pad_x * 2.0;
        let ctx_line = "上下文 12%";
        let ctx_width = estimated_text_width(ctx_line, 11.0);
        assert!(
            ctx_width <= inner,
            "上下文行超宽：{ctx_width:.1} > {inner}"
        );
        fn usage_of(input: u64, output: u64, cache_read: u64) -> ProjectedUsage {
            ProjectedUsage {
                entries: vec![ProjectedUsageEntry {
                    purpose: "main".into(),
                    calls: 12,
                    reported: 12,
                    input,
                    output,
                    cache_read,
                    cache_write: 0,
                    total: input + output + cache_read,
                }],
            }
        }
        // 典型量级（十位千 + 百位）。
        let spend = debug_spend_line(&usage_of(30_100, 4_200, 40_500).entries).expect("有消耗行");
        let spend_width = estimated_text_width(&spend, 11.0);
        assert!(
            spend_width <= inner,
            "消耗行超宽：{spend_width:.1} > {inner}（{spend}）"
        );
        // 用户样本量级（入 275.9k / 出 27.6k / 缓存读 177.0k → 命中 39%）：
        // 三段形态在最大常规量级下仍放得下（实测 235.4pt ≤ 257pt）。
        let sample = debug_spend_line(&usage_of(275_900, 27_600, 177_000).entries).expect("有消耗行");
        assert!(
            sample.contains("275.9k") && sample.contains("命中 39%"),
            "用户样本量级形态漂移：{sample}"
        );
        let sample_width = estimated_text_width(&sample, 11.0);
        assert!(
            sample_width <= inner,
            "用户样本量级超宽：{sample_width:.1} > {inner}（{sample}）"
        );
        // 一行塞不下（用户提到的「别硬塞」）：占比行 + 消耗行合计明显超过内宽。
        let merged = format!("{ctx_line} · {spend}");
        assert!(
            estimated_text_width(&merged, 11.0) > inner,
            "合并成一行反而放得下？两行拆分的前提变了，重新评估布局"
        );
    }
    #[test]
    fn 思考强度下拉覆盖max档() {
        let debug = DebugState {
            last_context_usage: None,
            last_tool_names: Vec::new(),
            registered_tools: Vec::new(),
            thinking_effort: "max".into(),
            safety_mode: "just_do_it".into(),
            tools_expanded: false,
            registry_expanded: false,
        };
        let select = thinking_effort_select(&debug);
        assert_eq!(select.options.len(), 5);
        assert_eq!(select.options[4].label, "max");
        assert_eq!(select.selected, 4);
    }
}
