use super::*;
use crate::ui::platform::macos_widgets::{standard_appearance_name, BODY_BASE_SIZE};
use crate::ui::settings::layout::{settings_layout, CONTENT_TOP, FOOTER_H, MARGIN, RAIL_W};
use crate::ui::settings::panels::{
    mcp_form_rows, renders_tools_panel, ListPanel, McpTransport, PanelRow, RowAction, RowOption,
    MCP_FIELD_ARGS,
};
use crate::ui::settings::schema::{FieldKind, TABS};
use crate::ui::theme::{paint, ThemeId};

use super::controls::*;
use super::layout::*;

/// 拆分后的平台源码清单：源码级门禁扫描整个目录，等价于拆分前的单文件扫描。
fn source_text() -> &'static str {
    crate::ui::platform::test_sources::macos_settings()
}

#[test]
fn 数值显示去掉尾零且整数不带小数点() {
    assert_eq!(format_number(14.0), "14");
    assert_eq!(format_number(0.3), "0.3");
    assert_eq!(format_number(1.25), "1.25");
    assert_eq!(format_number(0.30000000000000004_f64), "0.3");
}

/// 状态文字的 token 来源：错误 = `danger`、警告 = `warn`，两档不可对调。
#[test]
fn 错误与警告各取自己的token() {
    for id in ThemeId::ALL {
        let tokens = id.tokens();
        assert_eq!(
            notice_color(tokens, NoticeKind::Error),
            tokens.danger,
            "{id:?} 的错误文字应取 danger"
        );
        assert_eq!(
            notice_color(tokens, NoticeKind::Warning),
            tokens.warn,
            "{id:?} 的警告文字应取 warn"
        );
        assert_ne!(tokens.danger, tokens.warn, "{id:?} 的两档状态色不该同值");
    }
}

/// 按钮角色 → 主题面：只有「保存」类主操作贴主按钮面，其余保持系统外观。
#[test]
fn 只有主操作贴主按钮面() {
    assert_eq!(button_face(ButtonRole::Save), Some(paint::Face::Primary));
    assert_eq!(
        button_face(ButtonRole::Form),
        Some(paint::Face::Chip),
        "表单按钮与聊天 chip 同族（2026-10-05 评审：系统 bezel 与主题 chip 两种长相）"
    );
}

/// 各套主题的极性（`dark`）与 `NSAppearance` 映射：暗色主题走 DarkAqua、
/// 明色主题走 Aqua；映射字符串与 objc2 侧的外观名常量逐字一致
/// （防手写字符串漂移）。
///
/// 极性是**逐款断言**的（不从表里反推），所以末尾钉一条「用例数 = 主题数」：
/// 加主题时忘了在这里补一行会红，而不是静默漏测。
#[test]
fn 各套主题的极性映射到正确外观名() {
    use objc2_app_kit::{NSAppearanceNameAqua, NSAppearanceNameDarkAqua};
    let cases = [
        (ThemeId::Brushed, true),
        (ThemeId::Chrome, false),
        (ThemeId::Verdigris, true),
        (ThemeId::Nightfall, true),
        (ThemeId::Azurite, false),
    ];
    assert_eq!(
        cases.len(),
        ThemeId::ALL.len(),
        "新增主题必须在这里补上它的明暗极性"
    );
    for (id, expect_dark) in cases {
        assert_eq!(id.tokens().dark, expect_dark, "{id:?} 的明暗口径");
        // unsafe：extern static 读取；这两个是 AppKit 的常量外观名，
        // 进程生命周期内恒有效，只读比较无别名/竞态风险。
        let expected = unsafe {
            if expect_dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            }
        };
        assert_eq!(
            standard_appearance_name(id.tokens().dark),
            expected.to_string(),
            "{id:?} 的窗口外观名"
        );
    }
}

/// 竖栏行按钮的排布：首行顶距 9、行距 26+1（设计稿 `padding 9px` / `gap 1px`）。
#[test]
fn 竖栏行按钮几何按设计稿排布() {
    assert_eq!(rail_item_y(0), 9.0);
    assert_eq!(rail_item_y(1), 36.0);
    assert_eq!(rail_item_y(4), 117.0, "第 5 行 = 9 + 4×27");
    // 行高与行距是分离的两项：行距必须留 1px（设计稿 gap）。
    assert_eq!(RAIL_ITEM_H, 26.0);
    assert_eq!(RAIL_ITEM_GAP, 1.0);
    // 行宽 = 竖栏宽 − 2×横向内边距。
    assert_eq!(RAIL_W - RAIL_PAD_X * 2.0, 92.0);
}

/// 竖栏行按钮的选中面：选中取 `tab_on_*` 族，未选中取 `dim` 字且无底；
/// 三套主题都查（换主题后由 `style_rail_buttons` 重贴）。
#[test]
fn 竖栏选中面取_tabon_未选中取_dim() {
    for id in ThemeId::ALL {
        let tokens = id.tokens();
        for index in 0..TABS.len() {
            let selected = rail_button_face(index, index, tokens);
            assert_eq!(selected, paint::Face::TabOn, "{id:?} 第 {index} 行是选中行");
            assert_ne!(
                selected,
                paint::Face::Text { ink: tokens.dim },
                "{id:?} 选中与未选中面不得同形"
            );
            for other in 0..TABS.len() {
                if other == index {
                    continue;
                }
                assert_eq!(
                    rail_button_face(other, index, tokens),
                    paint::Face::Text { ink: tokens.dim },
                    "{id:?} 第 {other} 行未选中取 dim 字"
                );
                assert_ne!(
                    rail_button_face(other, index, tokens),
                    paint::Face::Text { ink: tokens.ink },
                    "{id:?} 未选中行不得贴 ink 字（设计稿是 --dim）"
                );
            }
        }
    }
}

/// 开关在未接线（禁用）时的整控件透明度：可点 1.0、禁用 0.45，两档不可同值。
#[test]
fn 开关禁用态降透明度() {
    assert_eq!(switch_alpha(true), 1.0);
    assert_eq!(switch_alpha(false), 0.45);
    assert_ne!(switch_alpha(true), switch_alpha(false));
}

/// 主版面几何：操作条贴窗口底、竖栏与滚动区从窗口顶铺起并停在它上方。
///
/// 回归对象：整页曾直接挂进**不翻转**的 contentView —— 按左上原点书写的
/// 算式被垂直镜像，`height - 30` 的底部操作条被画到窗口顶部。
/// （版面挂载必须走 `build_ui` 的翻转根容器，见「主版面几何」段注释。）
#[test]
fn 底部操作条贴底且主体区停在它上方() {
    for (width, height) in [(440.0, 600.0), (560.0, 720.0)] {
        let layout = settings_layout(width, height);

        for (name, rect) in [
            ("状态行", layout.status),
            ("刷新", layout.refresh),
            ("保存", layout.save),
        ] {
            assert!(
                rect.y >= height - FOOTER_H,
                "{name} 应落在窗口底部的操作条带内（{width}×{height}）"
            );
            assert!(rect.y + rect.h <= height, "{name} 不得越出窗口底边");
            assert!(
                rect.y > height / 2.0,
                "{name} 的 y（从上往下）应在窗口下半区"
            );
        }

        // 竖栏与滚动区：从窗口顶出发，下边界都停在操作条上（FOOTER_H 之上）。
        assert_eq!(layout.rail.y, 0.0, "竖栏从窗口顶铺起");
        assert_eq!(layout.rail.y + layout.rail.h, height - FOOTER_H);
        assert_eq!(layout.scroll.y, CONTENT_TOP);
        assert_eq!(layout.scroll.y + layout.scroll.h, height - FOOTER_H);
        assert!(
            layout.scroll.x >= layout.rail.x + layout.rail.w,
            "滚动区在竖栏右侧，不重叠"
        );
        assert!(
            layout.refresh.x + layout.refresh.w <= layout.save.x,
            "两个操作按钮不重叠"
        );
    }
}

/// 管理面行 y 逐行累加：行距 = 行高、行与行不重叠，行区高度按行数累计。
///
/// 回归对象：`build_panel_row` 曾返回行高常量而不是「下一行 y」，
/// 第 2 行起全部叠在 `y = PANEL_ROW_H`（实机症状：「试听」按钮与
/// 「当前 Profile」行的标签/帮助文字叠在一起）。
#[test]
fn 管理面行_y_逐行累加不重叠() {
    let heights = [PANEL_ROW_H; 5];
    let (ys, end) = panel_rows_span(700.0, &heights);
    assert_eq!(ys, vec![700.0, 738.0, 776.0, 814.0, 852.0]);
    for pair in ys.windows(2) {
        assert_eq!(pair[1] - pair[0], PANEL_ROW_H, "行距 = 行高，不重叠不留缝");
    }
    assert_eq!(end, 700.0 + 5.0 * PANEL_ROW_H, "行区结束 y 必须含全部行高");
    assert_ne!(end, PANEL_ROW_H, "行区结束 y 不是行高常量（旧缺陷形态）");

    let (empty, empty_end) = panel_rows_span(700.0, &[]);
    assert!(empty.is_empty(), "空面板不产生行");
    assert_eq!(empty_end, 700.0, "空面板不推进 y");
}

/// 副标题行必须加高：副标题框是「标题下 19 起、高 30（最多两行）」，
/// 行高不 +15 时两行副标题会压到下一行（实机症状：工具页 MCP 行副标题
/// 与下一行重叠约 11pt）。
/// 标签截断护栏（2026-10-05 行结构重排后按新几何）：schema 全表标签在
/// **默认窗宽的标签块**内都放得下；Action 行无左标签（按钮文字即标题），
/// 改为断言其按钮文案不超出按钮宽度上限。
///
/// 实机回归：旧「右对齐标签列 110pt」把「收到消息自动弹出」截成「…」；
/// 新几何标签块宽 = 内容宽 − 控件宽 − 间距，控件宽度分档见
/// [`field_control_size`]。估算是保守的字符宽度近似（全角 ≈ 1em、ASCII ≈ 0.6em），
/// 不是字体度量；全局字号放大不在护栏内（窗口可缩放，列宽不随字号自适应）。
#[test]
fn 全部字段标签在标签块内完整显示() {
    fn estimated_label_width(text: &str) -> f64 {
        text.chars()
            .map(|ch| {
                let wide = matches!(ch, '\u{1100}'..='\u{FFEF}');
                if wide {
                    BODY_BASE_SIZE
                } else {
                    BODY_BASE_SIZE * 0.6
                }
            })
            .sum()
    }
    // 默认窗宽 540（macos.rs `WindowId::Settings` 默认值）→ 内容宽 = 窗宽 − 竖栏 − 两侧边距。
    let content_w = 540.0 - RAIL_W - MARGIN * 2.0;
    for tab in TABS {
        for section in tab.sections {
            for field in section.fields {
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue; // 不渲染独立控件
                }
                let estimated = estimated_label_width(&field.display_label());
                if matches!(field.kind, FieldKind::Action) {
                    assert!(
                        estimated + 28.0 <= 200.5,
                        "{}/{} 的动作「{}」估算宽度 {estimated:.1}pt 超出按钮宽度上限 200pt",
                        tab.id,
                        section.title,
                        field.label
                    );
                    continue;
                }
                let (ctrl_w, _) = field_control_size(field);
                let label_w = field_label_width(content_w, ctrl_w);
                assert!(
                    estimated <= label_w - 4.0,
                    "{}/{} 的标签「{}」估算宽度 {estimated:.1}pt 超出标签块 {label_w:.1}pt",
                    tab.id,
                    section.title,
                    field.label
                );
            }
        }
    }
}

#[test]
fn 副标题行加高避免两行重叠() {
    let with_subtitle = PanelRow {
        id: "mcp/x".into(),
        title: "t".into(),
        subtitle: "两行副标题内容".into(),
        action: RowAction::None,
        secondary: RowAction::None,
        enabled: true,
        pick: None,
    };
    let without = PanelRow {
        subtitle: String::new(),
        ..with_subtitle.clone()
    };
    let h1 = panel_row_height(&with_subtitle);
    let h0 = panel_row_height(&without);
    assert_eq!(h0, PANEL_ROW_H, "无副标题用基础行高");
    assert_eq!(
        h1,
        PANEL_ROW_H + 18.0,
        "有副标题加高两行（两行上限，2026-10-06 收紧）"
    );
    // 副标题内容底 = 行顶 + 19 + 30 = +49；下一行 y = 行高 56 → 不重叠。
    assert!(h1 >= 49.0 + 4.0, "行高必须盖过两行副标题（49）且留行距");
}

// ── ① 通知分档 / 底部状态行 ──

/// 分档判据：新代际按档选通道（Error=模态 / Info·Warning=浮层），
/// 同一代际不重放。文本比较会被「同一句话连报两次」骗过，所以判据只有代际。
#[test]
fn 通知按档分道且旧代际不重放() {
    use crate::ui::settings::NoticeLevel;
    assert_eq!(notice_action(NoticeLevel::Error, 7, 7), NoticeAction::None);
    assert_eq!(notice_action(NoticeLevel::Info, 7, 7), NoticeAction::None);
    assert_eq!(
        notice_action(NoticeLevel::Warning, 7, 7),
        NoticeAction::None
    );
    assert_eq!(
        notice_action(NoticeLevel::Error, 8, 7),
        NoticeAction::Modal,
        "错误必须走模态（用户必须确认）"
    );
    assert_eq!(
        notice_action(NoticeLevel::Info, 8, 7),
        NoticeAction::Toast,
        "普通回执走顶部浮层"
    );
    assert_eq!(
        notice_action(NoticeLevel::Warning, 8, 7),
        NoticeAction::Toast,
        "警告也是浮层（配色区分）"
    );
}

/// 浮层配色按档取主题 token：Warning 取 `warn`、Info 取 `ink`，两档在任何主题下都可区分。
#[test]
fn 顶部浮层配色按档取主题_token() {
    use crate::ui::settings::NoticeLevel;
    for id in ThemeId::ALL {
        let tokens = id.tokens();
        assert_eq!(
            toast_ink(tokens, NoticeLevel::Warning),
            tokens.warn,
            "{id:?} 警告浮层必须取 warn"
        );
        assert_eq!(
            toast_ink(tokens, NoticeLevel::Info),
            tokens.ink,
            "{id:?} 普通浮层文字取 ink"
        );
        assert_ne!(
            toast_ink(tokens, NoticeLevel::Warning),
            toast_ink(tokens, NoticeLevel::Info),
            "{id:?} 两档浮层配色必须可区分"
        );
    }
}

/// 底部状态行不再承载通知：只留常驻信息，避免「提示全在左下角」的口径回流。
#[test]
fn 底部状态行不再承载通知只看常驻信息() {
    assert_eq!(footer_status_text(true, false, 0), "");
    assert_eq!(
        footer_status_text(true, true, 3),
        "正在保存…",
        "保存进行中的进度优先"
    );
    assert_eq!(footer_status_text(true, false, 3), "有 3 项未保存");
    assert!(
        !footer_status_text(false, false, 0).is_empty(),
        "未接线必须保留常驻说明"
    );
}

/// 文档弹窗呈现判据：已加载 + 本次打开未呈现过 + 无在显弹窗；
/// 保存回执（loaded 不变）不得触发重弹。
#[test]
fn 文档弹窗只在本次打开且已加载时呈现() {
    assert!(document_should_present(true, false, false));
    assert!(
        !document_should_present(false, false, false),
        "读取中不弹（内容未就绪）"
    );
    assert!(
        !document_should_present(true, false, true),
        "本次打开已弹过：保存回执不重弹"
    );
    assert!(
        !document_should_present(true, true, false),
        "弹窗已在显示时不重入"
    );
}

/// 数值「编辑即提交」：完整合法输入提交并夹到范围；半截/非法输入一律不提交
///（不置脏、不写 0 —— 用户输入的中间态不能被当成值）。
#[test]
fn 数值编辑即提交只认完整合法输入() {
    assert_eq!(parse_number_commit("1.5", 1.0, 2.0), Some(1.5));
    assert_eq!(parse_number_commit(" 2 ", 1.0, 2.0), Some(2.0));
    assert_eq!(
        parse_number_commit("9", 1.0, 2.0),
        Some(2.0),
        "超出上限夹回上限"
    );
    assert_eq!(
        parse_number_commit("0", 1.0, 2.0),
        Some(1.0),
        "低于下限夹回下限"
    );
    assert_eq!(
        parse_number_commit("1e", 1.0, 2.0),
        None,
        "半截输入（等待继续键入）不提交"
    );
    assert_eq!(
        parse_number_commit("", 1.0, 2.0),
        None,
        "空串不提交（不写 0）"
    );
    assert_eq!(parse_number_commit("abc", 1.0, 2.0), None);
    assert_eq!(parse_number_commit("NaN", 1.0, 2.0), None, "非有限不提交");
    assert_eq!(parse_number_commit("inf", 1.0, 2.0), None);
}

/// 文档弹窗按钮计划：次要动作（重新生成 / 测试连接 / 复制）不得在改弹窗时丢失；
/// 主操作保存仍在最右（加入顺序），关闭恒在最左。
#[test]
fn 文档弹窗按钮计划保留次要动作() {
    use crate::ui::settings::DocumentTarget;
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::CardStages),
        vec![
            DocDialogButton::Save,
            DocDialogButton::Regenerate,
            DocDialogButton::Close
        ],
        "阶段文案：保存 + 重新生成 + 关闭"
    );
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::McpServer {
            name: "github".into()
        }),
        vec![
            DocDialogButton::Save,
            DocDialogButton::TestConnection,
            DocDialogButton::Close
        ],
        "具名 MCP：保存 + 测试连接 + 关闭"
    );
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::McpServer {
            name: String::new()
        }),
        vec![DocDialogButton::Save, DocDialogButton::Close],
        "新建 MCP（无名）不提供测试连接"
    );
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::V1rtual),
        vec![DocDialogButton::Save, DocDialogButton::Close]
    );
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::CardTemplate),
        vec![DocDialogButton::Copy, DocDialogButton::Close],
        "Card 模版（只读）：复制 + 关闭（复制是本次唯一的只读附加动作）"
    );
    assert_eq!(
        doc_dialog_buttons(&DocumentTarget::VariablePool),
        vec![DocDialogButton::Close],
        "只读文档只有关闭"
    );
    // 「复制」只属 Card 模版：其它只读目标不得借到它（显式反查，防以后误加）。
    for target in [DocumentTarget::VariablePool] {
        assert!(
            !doc_dialog_buttons(&target).contains(&DocDialogButton::Copy),
            "{target:?} 不应出现复制动作"
        );
    }
}

/// 源码片段提取（签名 → 匹配大括号体）：守门用例按函数体扫描，不扫全文件
/// （错误弹窗 / 遗忘确认等仍走模态的站点必须保留）。与 windows_chat 的同名
/// 测试辅助同实现（平台文件各自内联，不为测试建共享模块）。
fn function_body<'a>(src: &'a str, signature: &str) -> Option<&'a str> {
    let start = src.find(signature)?;
    let open = src[start..].find('{')? + start;
    let mut depth = 0usize;
    for (offset, ch) in src[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[open..open + offset + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 文档预览面板版面：标题 / 说明 / 正文 / 按钮行自上而下不重叠、在面板内；
/// 按钮与计划同序、首项贴内容右缘（旧模态弹窗的主操作位）、互不重叠。
#[test]
fn 文档预览面板几何自上而下排布() {
    let plans = [
        vec![
            DocDialogButton::Save,
            DocDialogButton::Regenerate,
            DocDialogButton::Close,
        ],
        vec![
            DocDialogButton::Save,
            DocDialogButton::TestConnection,
            DocDialogButton::Close,
        ],
        vec![DocDialogButton::Copy, DocDialogButton::Close],
        vec![DocDialogButton::Close],
    ];
    for plan in plans {
        let layout = document_panel_layout(&plan);
        assert_eq!(
            layout.text.w, DOC_DIALOG_W,
            "正文区宽度不变（文案观感同旧弹窗）"
        );
        assert_eq!(layout.text.h, DOC_DIALOG_H, "正文区高度不变");
        assert!(
            layout.title.y + layout.title.h <= layout.hint.y,
            "标题在说明之上"
        );
        assert!(
            layout.hint.y + layout.hint.h <= layout.text.y,
            "说明在正文之上"
        );
        assert!(
            layout.text.y + layout.text.h <= layout.buttons[0].y,
            "正文在按钮行之上"
        );
        assert_eq!(layout.buttons.len(), plan.len(), "每个计划动作都有矩形");
        let right = layout.width - DOC_PANEL_MARGIN;
        assert_eq!(
            layout.buttons[0].x + layout.buttons[0].w,
            right,
            "计划首项贴内容右缘（主操作位与旧模态一致）"
        );
        for pair in layout.buttons.windows(2) {
            assert!(
                pair[1].x + pair[1].w <= pair[0].x,
                "按钮自右向左排、两两不重叠"
            );
        }
        for rect in &layout.buttons {
            assert!(rect.x >= 0.0, "按钮不越左缘");
            assert!(rect.w >= DOC_PANEL_BUTTON_MIN_W - 1e-9);
            assert!(rect.w <= DOC_PANEL_BUTTON_MAX_W + 1e-9);
            assert_eq!(rect.y, layout.buttons[0].y, "按钮同一行");
        }
        assert_eq!(
            layout.height,
            layout.buttons[0].y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN,
            "按钮行之下留一个内边距"
        );
    }
}

fn 表单样例() -> crate::ui::settings::panels::McpServerForm {
    crate::ui::settings::panels::McpServerForm {
        name: "demo".to_string(),
        transport: McpTransport::Http,
        command: String::new(),
        args: "-y\npkg".to_string(),
        url: "https://example.com/mcp".to_string(),
        env: "TOKEN=1".to_string(),
        headers: "A=b".to_string(),
        enabled: false,
    }
}

/// MCP 表单版面（纯函数）：每行一个控件、控件高度按形态（多行字段更高）、
/// 行自上而下不重叠、控件右缘对齐内容右缘、按钮行在最后一行之下。
#[test]
fn mcp表单几何按字段行排布() {
    let form = 表单样例();
    let rows = mcp_form_rows(&form, None);
    let plan = vec![
        DocDialogButton::Save,
        DocDialogButton::TestConnection,
        DocDialogButton::Close,
    ];
    let layout = mcp_form_layout(&rows, &plan);
    assert_eq!(layout.width, DOC_DIALOG_W + DOC_PANEL_MARGIN * 2.0);
    assert_eq!(layout.rows.len(), rows.len(), "每行一个标签 + 一个控件");
    let mut previous_bottom = layout.hint.y + layout.hint.h;
    for ((label, control), row) in layout.rows.iter().zip(rows.iter()) {
        assert!(label.y >= previous_bottom - 1e-9, "字段行自上而下不重叠");
        assert_eq!(label.y, control.y, "同一行的标签与控件同顶");
        assert_eq!(
            control.h,
            mcp_form_control_h(&row.control),
            "控件高度按形态取（多行文本更高）"
        );
        assert!(control.x >= label.x + label.w, "控件在标签右侧");
        assert_eq!(
            control.x + control.w,
            layout.width - DOC_PANEL_MARGIN,
            "控件右缘统一对齐内容右缘"
        );
        previous_bottom = control.y + control.h;
    }
    let last = layout.rows.last().expect("表单至少一行");
    assert!(
        layout.buttons[0].y >= last.1.y + last.1.h,
        "按钮行在最后一行之下"
    );
    assert_eq!(
        layout.height,
        layout.buttons[0].y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN
    );
    assert_eq!(layout.buttons.len(), plan.len());
    assert_eq!(
        layout.buttons[0].x + layout.buttons[0].w,
        layout.width - DOC_PANEL_MARGIN,
        "计划首项贴内容右缘（主操作位与旧弹窗一致）"
    );
    // 多行字段确实比单行高（形态映射生效，不是全表同高）。
    let args_index = rows
        .iter()
        .position(|row| row.key == MCP_FIELD_ARGS)
        .unwrap();
    assert!(
        layout.rows[args_index].1.h > layout.rows[0].1.h,
        "args 是 4 行文本高度，name 是单行"
    );
}

/// transport 下拉按钮标题：选中线值 → 「标签 ▾」；未知值回退第一项（与自绘下拉同口径）。
#[test]
fn mcp传输下拉标题按选项表() {
    assert!(
        mcp_transport_title("http").starts_with("http"),
        "标题带选中项标签"
    );
    assert!(mcp_transport_title("http").ends_with(" ▾"));
    assert!(mcp_transport_title("stdio").starts_with("stdio"));
    assert_eq!(
        mcp_transport_title("sse"),
        mcp_transport_title("stdio"),
        "值不在表里回退第一项（sse 已弃用，不在选项表）"
    );
    assert_eq!(McpTransport::OPTIONS.len(), 2);
}

/// 按钮文案表与计划一一对应（点击分发 / 布局 / 标题共用同一份表）。
#[test]
fn 文档预览面板按钮文案覆盖全部动作() {
    for (button, title) in [
        (DocDialogButton::Save, "保存"),
        (DocDialogButton::Regenerate, "重新生成"),
        (DocDialogButton::TestConnection, "测试连接"),
        (DocDialogButton::Copy, "复制"),
        (DocDialogButton::Close, "关闭"),
    ] {
        assert_eq!(doc_button_title(button), title);
        let width = doc_button_width(button);
        assert!((DOC_PANEL_BUTTON_MIN_W..=DOC_PANEL_BUTTON_MAX_W).contains(&width));
    }
}

/// 源码级守门：文档预览载体是**非模态 NSPopover**，不是模态 NSAlert。
///
/// 实机证据（2026-10-05 用户 A/B + 三张截图）：同一份预览器在图层编辑器的
/// 非模态浮层里滚动流畅、在模态 NSAlert 里「所有用到这个框的都卡」——改回
/// 模态承载 = 回到用户报告的问题，所以钉住承载路径的形状。
/// 只扫承载函数体：错误弹窗 / 遗忘确认 / 单行输入等其它模态站点必须保留
/// （它们走 `run_modal_alert` 降级包裹，纪律不变）。
#[test]
fn 文档预览走非模态面板不回到模态承载() {
    let source = source_text();
    let alert_needle = concat!("NS", "Alert");
    let modal_needle = concat!(".run", "Modal(");
    for signature in [
        "fn present_document_panel",
        "fn present_mcp_form_panel",
        "fn document_panel_action",
        "fn finish_document_panel",
        "fn close_document_panel",
    ] {
        let body = function_body(&source, signature)
            .unwrap_or_else(|| panic!("{signature} 必须存在（文档预览面板的承载路径）"));
        assert!(
            !body.contains(alert_needle),
            "{signature} 不得用模态 NSAlert 承载文档预览（实机滚动卡顿的载体）"
        );
        assert!(
            !body.contains(modal_needle),
            "{signature} 不得直接进模态（文档预览是非模态面板）"
        );
    }
    let presenter = function_body(&source, "fn present_document_panel").unwrap();
    assert!(
        presenter.contains("NSPopoverBehavior::ApplicationDefined"),
        "弹出层不自行收起（点外部不关窗、点击不透传背后设置窗）= 旧模态的交互语义"
    );
    assert!(
        presenter.contains("showRelativeToRect_ofView_preferredEdge"),
        "弹出层贴锚点视图呈现"
    );
    assert!(
        presenter.contains("NSViewFrameDidChangeNotification"),
        "渐进布局期间视口钉回正文开头（编辑器浮层同款）"
    );
    // 防误操作的落点（实机验证 transient / semitransient 都会透传点击）：
    // 「不自行收起 + 点击挡板 + 关闭按钮兼 Esc」三件套缺一不可。
    assert!(
        presenter.contains("ClickShieldView::new"),
        "面板在显期间必须挂点击挡板（否则点外部会误操作背后设置窗）"
    );
    assert!(
        presenter.contains("setKeyEquivalent"),
        "关闭按钮兼作 Esc（applicationDefined 下弹出层不自带 Esc 语义）"
    );
    // MCP 表单面板是同一种载体（换内容不换纪律）：同一份弹出层语义必须原样存在。
    let form_presenter = function_body(&source, "fn present_mcp_form_panel").unwrap();
    for (needle, why) in [
        (
            "NSPopoverBehavior::ApplicationDefined",
            "表单面板同样不自行收起",
        ),
        ("ClickShieldView::new", "表单面板同样挂点击挡板"),
        ("setKeyEquivalent", "表单面板的关闭按钮同样兼作 Esc"),
        (
            "showRelativeToRect_ofView_preferredEdge",
            "表单面板同样贴锚点呈现",
        ),
    ] {
        assert!(
            form_presenter.contains(needle),
            "MCP 表单面板缺承载语义: {why}"
        );
    }
    let finish = function_body(&source, "fn finish_document_panel").unwrap();
    assert!(
        finish.contains("removeFromSuperview"),
        "面板收起必须撤掉点击挡板（设置窗要恢复可交互）"
    );
}

/// 自绘下拉的选项表与标题：值→标签映射、未知值回退首项、标题带「▾」。
#[test]
fn 自绘下拉选项表与标题口径() {
    let options = vec![
        ("（未设置）".to_string(), String::new()),
        ("糖糖粉".to_string(), "sugar-pink".to_string()),
        ("yuki".to_string(), "yuki".to_string()),
    ];
    assert_eq!(select_title(&options, "sugar-pink"), "糖糖粉 ▾");
    assert_eq!(
        select_title(&options, ""),
        "（未设置） ▾",
        "空值 = 占位项（未设置）"
    );
    assert_eq!(
        select_title(&options, "已删除的 id"),
        "（未设置） ▾",
        "值不在表里回退第一项（与旧下拉同口径）"
    );
    assert_eq!(select_title(&[], "x"), "— ▾", "空表给占位，不 panic");

    // 夹具取 schema 的枚举字段（不手抄选项表）：用日志级别，合法值取 "debug"。
    let field = crate::ui::settings::schema::field("general.logging.level")
        .expect("日志级别字段应在 schema 里（本轮撤下的是窗口尺寸一族）");
    let FieldKind::Enum(choices) = field.kind else {
        panic!("日志级别必须是枚举字段");
    };
    let options = choice_options(choices);
    assert_eq!(options.len(), choices.len(), "选项表逐项映射，数量不变");
    for (mapped, choice) in options.iter().zip(choices.iter()) {
        assert_eq!(
            mapped,
            &(choice.label.to_string(), choice.value.to_string()),
            "标签与值逐字来自 schema（不重排、不改写）"
        );
    }
    assert_eq!(
        select_title(&options, "debug"),
        "debug ▾",
        "以合法值 debug 走一遍取值 → 标题映射"
    );
}

/// 行内下拉（`RowAction::Pick`）的标题口径：选中项 label + 「▾」；
/// 选中值不在选项表时回退第一项；空表给占位（与自绘下拉同口径）。
#[test]
fn 行内下拉标题取选中项含回退() {
    let options = vec![
        RowOption {
            value: "none".into(),
            label: "静音".into(),
        },
        RowOption {
            value: "ding".into(),
            label: "叮".into(),
        },
    ];
    assert_eq!(pick_row_title(&options, "ding"), "叮 ▾");
    assert_eq!(pick_row_title(&options, "none"), "静音 ▾");
    assert_eq!(
        pick_row_title(&options, "已删除的 id"),
        "静音 ▾",
        "选中值不在表里回退第一项（与 select_title 同口径）"
    );
    assert_eq!(pick_row_title(&[], "ding"), "— ▾", "空表给占位，不 panic");
}

/// 分段控件的最近档判定：档位内精确命中；档位外按最近档高亮（只显示不写值）；
/// 距离相同取声明序靠前；空档位表给自己的 None。
#[test]
fn 数值档位按最近档高亮() {
    let options = [("弱", 1.0), ("强", 2.0)];
    assert_eq!(nearest_option_index(&options, 1.0), Some(0));
    assert_eq!(nearest_option_index(&options, 2.0), Some(1));
    assert_eq!(
        nearest_option_index(&options, 1.5),
        Some(0),
        "档位外中间值按最近档高亮（1.5 距两档等距，取声明序靠前）"
    );
    assert_eq!(
        nearest_option_index(&options, 0.8),
        Some(0),
        "档位外偏低值高亮最近的低档"
    );
    assert_eq!(
        nearest_option_index(&options, 1.9),
        Some(1),
        "档位外偏高值高亮最近的高档"
    );
    assert_eq!(nearest_option_index(&[], 1.0), None, "空档位表没有高亮段");
}

/// 分段控件的选中判据（值 → 面）在五主题下都成立，且**不依赖两族色差**。
///
/// 2026-10-05 回归（用户实机截图 + 像素取证）：旧实现选中贴 `TabOn`、未选中贴
/// `Chip` —— 刷新路径与取值都正确（截图里弱=tab_on_edge、强=btn_edge 逐像素
/// 可辨），但五主题里 `--tabon` 与 `--bbg` 的实色首档几乎同值，两段读作一样。
/// 修复把判据换成设计稿 `.seg` 的「有面 vs 无面」；把本测试退回旧映射
/// （选中 TabOn / 未选中 Chip）即红。
#[test]
fn 分段控件选中段贴按钮面未选中段无底() {
    for id in ThemeId::ALL {
        let tokens = id.tokens();
        let on = number_choice_segment_face(true, tokens);
        let off = number_choice_segment_face(false, tokens);
        assert_eq!(
            on,
            paint::Face::Chip,
            "{id:?} 选中段取按钮族实心 chip（设计稿 .seg i.on）"
        );
        assert_eq!(
            off,
            paint::Face::Text { ink: tokens.dim },
            "{id:?} 未选中段无底无边、dim 字（设计稿 .seg i）"
        );
        assert_ne!(on, off, "{id:?} 选中/未选中面不得同形");
        // 与行内按钮同族：分段选中段就是设置窗行内按钮（Form 角色）的面。
        assert_eq!(
            Some(on),
            button_face(ButtonRole::Form),
            "{id:?} 选中段与行内动作按钮同族"
        );
        // 旧映射（两段都实心）必须与现在不同 —— 这是回归的形态判据。
        assert_ne!(
            on,
            paint::Face::TabOn,
            "{id:?} 选中段不得回到 TabOn（与 Chip 在五主题下不可辨）"
        );
    }
}

/// 值 → 段面：从 Node 线格式快照一路走到面表（真走刷新路径的决策段）。
///
/// 覆盖：档位命中、档位外最近档（只显示不写值）、缺键、非数值类型（字符串），
/// 以及 schema 的档位表本身就是分段控件的选项来源。
#[test]
fn 分段控件从线快照到段面真走一遍() {
    use crate::ui::ports::parse_settings_snapshot;
    use crate::ui::settings::SettingsDraft;
    use serde_json::json;

    let field = crate::ui::settings::schema::field("appearance.parallax.intensity")
        .expect("灵动强度字段应在 schema 里");
    let FieldKind::NumberChoice { options } = field.kind else {
        panic!("灵动强度必须是数值档位字段");
    };
    assert_eq!(
        options,
        &[("弱", 1.0), ("强", 2.0)],
        "分段控件的档位表来自 schema（不复制第二份）"
    );

    let tokens = ThemeId::Azurite.tokens();
    let faces_for = |raw: serde_json::Value| {
        let snapshot = parse_settings_snapshot(&raw).expect("线格式快照可解析");
        let mut draft = SettingsDraft::default();
        draft.load(snapshot);
        number_choice_segment_faces(
            options,
            draft.value("appearance.parallax.intensity"),
            tokens,
        )
    };
    // 期望**硬编码**（不拿被修复函数自身当参照）：选中段 = 按钮族实心 chip，
    // 未选中段 = 无底 dim 字 —— 换回旧的 TabOn/Chip 映射时本测试同样要红。
    let selected_index =
        |faces: &[paint::Face]| faces.iter().position(|face| *face == paint::Face::Chip);
    let all_unselected = |faces: &[paint::Face]| {
        faces
            .iter()
            .all(|face| *face == paint::Face::Text { ink: tokens.dim })
    };

    // 档位内：1.0 → 弱；2.0 → 强（选中段恰好一段）。
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.0 } }));
    assert_eq!(selected_index(&faces), Some(0), "1.0 高亮「弱」");
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 2.0 } }));
    assert_eq!(selected_index(&faces), Some(1), "2.0 高亮「强」");
    // 档位外存量值：最近档高亮（1.5 等距取声明序靠前；不写盘由共享层口径保证）。
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.5 } }));
    assert_eq!(
        selected_index(&faces),
        Some(0),
        "1.5 等距高亮「弱」（声明序靠前）"
    );
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.9 } }));
    assert_eq!(selected_index(&faces), Some(1), "1.9 高亮「强」");
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 0.8 } }));
    assert_eq!(selected_index(&faces), Some(0), "0.8 高亮「弱」");
    // 缺键 / 非数值类型：不给假选中（未接线/未读数时全段中性）。
    let faces = faces_for(json!({ "values": {} }));
    assert!(all_unselected(&faces), "缺键 = 全段未选中，不显示假选中");
    let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": "1" } }));
    assert!(
        all_unselected(&faces),
        "字符串值不给假选中（as_number 不认 Text）"
    );
}

/// 源码级守门：本文件内贴主题面的调用只能经 `set_button_face`（按下反馈的
/// 恢复与主题重贴要拿到同一份面）；任何新增的裸 `paint::style_button` 站点
/// 都会让那枚按钮按下没有统一反馈。
#[test]
fn 贴面调用统一经_set_button_face() {
    let source = source_text();
    // 拆开拼接，避免断言文本自己命中扫描。
    let needle = concat!("paint::style_", "button(");
    assert_eq!(
        source.matches(needle).count(),
        1,
        "style_button 调用点应只有 set_button_face 内部一处 \
         （新增按钮请走 themed_button / rail_button / set_button_face）"
    );
}

/// 子层贴皮必须落在落帧之后（AppKit 层单测走不到，源码级钉住 — 本仓既有做法）。
///
/// 实机 bug（2026-10-05 用户截图 14：宽控件的主题色只盖住左上角一块）：
/// `paint::style_button` / `apply_fill` 的立体线与渐变底是**按贴皮当时的尺寸**
/// 建的子层，`setFrame:` 之后视图底会跟随 bounds、子层不会 → 旧尺寸的半截色。
/// 收口点：自绘按钮覆写 `setFrame:` 落帧后重贴；主题文本字段与通知浮层在各自
/// 站点「先落帧、后贴皮」。把钩子或站点顺序改回「先贴后摆」本用例即红。
#[test]
fn 子层贴皮落在落帧之后() {
    let source = source_text();

    // ① 自绘按钮：setFrame: 钩子先 super 落帧，再按记录的面重贴。
    let hook = source
        .find("fn set_frame(&self, frame: NSRect)")
        .expect("SettingsButton 必须有落帧后重贴的 setFrame: 钩子");
    let hook_body = &source[hook..(hook + 700).min(source.len())];
    assert!(
        hook_body.contains("msg_send![super(self), setFrame: frame]"),
        "setFrame: 钩子必须先调 super 落帧"
    );
    assert!(
        hook_body.contains("set_button_face(self, face)"),
        "落帧后必须按记录的面重贴（子层按最终尺寸重建）"
    );

    // ② 密钥字段（控件组比输入框宽，最容易被旧尺寸咬）：贴皮排在 place 之后。
    let secret_start = source
        .find("FieldKind::Text { secret: true } => {")
        .expect("密钥字段分支应在 build_field 里");
    let secret_end = source[secret_start..]
        .find("FieldKind::Enum(")
        .map(|offset| secret_start + offset)
        .expect("密钥分支之后应是下拉分支");
    let secret_src = &source[secret_start..secret_end];
    let secret_place = secret_src
        .find("place(stack, &*secure_view")
        .expect("密钥密文控件必须落帧");
    let secret_style = secret_src
        .find("style_themed_field(&secure)")
        .expect("密钥密文控件必须贴皮");
    assert!(
        secret_place < secret_style,
        "密钥输入框的贴皮必须排在落帧之后（先贴后改帧 = 底色只盖旧宽度）"
    );

    // ③ 通知浮层：place 在 apply_fill 之前（渐变底按最终宽度建）。
    let toast_start = source.find("fn show_toast").expect("通知浮层函数应在");
    let toast_end = source[toast_start..]
        .find("fn dismiss_toast")
        .map(|offset| toast_start + offset)
        .expect("浮层函数之后应是撤下函数");
    let toast_src = &source[toast_start..toast_end];
    let toast_place = toast_src
        .find("place(&root, &*toast")
        .expect("浮层必须落帧");
    let toast_fill = toast_src
        .find("apply_fill(&layer, &tokens.panel_bg")
        .expect("浮层必须贴主题底");
    assert!(
        toast_place < toast_fill,
        "通知浮层的贴皮必须排在落帧之后（先贴后改帧 = 渐变底只盖固有宽度）"
    );
}

/// 工具页：只撤「工具策略（声明）」这一个只读列表，MCP/Skill 管理面保留。
#[test]
fn 工具页不再渲染工具策略列表() {
    use crate::ui::settings::panels::{PANEL_MCP, PANEL_POLICIES, PANEL_SKILLS};
    assert!(
        !renders_tools_panel(PANEL_POLICIES),
        "「工具策略（声明）」列表按用户规则撤下"
    );
    assert!(renders_tools_panel(PANEL_MCP), "MCP 服务器列表保留");
    assert!(renders_tools_panel(PANEL_SKILLS), "Skill 列表保留");
}

/// 自动整理：记录收在按钮后（标题带条数）；弹层文本逐条列记录，空列表给中性说明。
#[test]
fn 自动整理记录收进按钮与弹层文本() {
    assert_eq!(memory_jobs_button_title(0), "查看记录（0）");
    assert_eq!(memory_jobs_button_title(3), "查看记录（3）");

    let panel = ListPanel {
        id: crate::ui::settings::panels::PANEL_MEMORY_JOBS,
        title: "自动整理",
        hint: "只读历史作业状态。".to_string(),
        error: None,
        warning: None,
        loaded: true,
        rows: vec![
            PanelRow {
                id: "job-1".into(),
                title: "整理完成".into(),
                subtitle: "新增 3 条".into(),
                action: RowAction::None,
                secondary: RowAction::None,
                enabled: true,
                pick: None,
            },
            PanelRow {
                id: "job-2".into(),
                title: "整理取消".into(),
                subtitle: String::new(),
                action: RowAction::None,
                secondary: RowAction::None,
                enabled: true,
                pick: None,
            },
        ],
    };
    let text = jobs_report_text(&panel);
    assert!(text.starts_with("只读历史作业状态。"), "说明在开头");
    assert!(text.contains("• 整理完成　新增 3 条"), "每条含标题与副标题");
    assert!(text.contains("• 整理取消"), "无副标题的行不拖尾空白");
    assert!(!text.contains("job-1"), "弹层文本只给人看的文案");

    let empty = ListPanel {
        rows: Vec::new(),
        ..panel
    };
    assert!(
        jobs_report_text(&empty).contains("（暂无记录）"),
        "空列表给中性说明，不显示空面板"
    );
}
