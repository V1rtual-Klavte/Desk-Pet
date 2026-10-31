//! Windows 设置窗的纯逻辑单测（自 `windows_settings.rs` 拆出；本模块只在 Windows 编译，
//! 由 CI 的 verify (windows-latest) 执行 —— 见 AGENTS §2）。

use super::*;
use super::dialogs::{
    doc_dialog_button_row, doc_dialog_layout, doc_dialog_secondary, document_should_present,
    mcp_form_dialog_height, mcp_form_dialog_layout, mcp_form_row_h,
};
use super::events::{
    combo_item_text, number_choice_activation, pick_change_is_final, pick_selected_index, read_control,
    write_control,
};
use super::layout::{
    field_control_size, field_label_width, number_choice_equal_widths, number_choice_hit,
    number_choice_selected, panel_row_advance, scroll_target,
};
use super::render::{
    notice_overlay_geometry, row_button_title, row_main_kind, row_secondary_title, set_combo_heights,
};

const PRODUCTION_SOURCES: &[&str] = &[
    include_str!("mod.rs"),
    include_str!("layout.rs"),
    include_str!("render.rs"),
    include_str!("events.rs"),
    include_str!("dialogs.rs"),
];

fn production_source() -> String {
    PRODUCTION_SOURCES.concat()
}

// ==========================================
// 纯逻辑单测（无 Win32 调用；本模块只在 Windows 编译，macOS 上跑不到 —— 见 AGENTS §2。
// 同表在 macOS 可跑的部分：`paint_win` 的 `文字角色映射到各自_token` 与
// `主按钮面全套取_primary_族`；本文件用例由 CI 的 verify (windows-latest) 执行。）
// ==========================================

use super::*;

#[test]
fn 多行文本显示补crlf_读取恢复lf且保留空行与unicode() {
    let source = "白名单\n\n角色🙂\r\n最后一行\n";
    let native = wide(source);
    let expected: Vec<u16> = "白名单\r\n\r\n角色🙂\r\n最后一行\r\n\0".encode_utf16().collect();
    assert_eq!(native, expected);
    assert_eq!(text_from_windows(&native[..native.len() - 1]), "白名单\n\n角色🙂\n最后一行\n");
}
use crate::ui::settings::panels::{McpTransport, MCP_FIELD_ARGS};

#[test]
fn 设置枚举在真实组合框中保留中文标签和线值() {
    struct WindowGuard(HWND);
    impl Drop for WindowGuard {
        fn drop(&mut self) {
            unsafe { DestroyWindow(self.0) };
        }
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 隐藏的系统窗口，不启应用、Node 或用户配置；真实 COMBOBOX 存取可发现
    // CBS_HASSTRINGS 缺失与仅设置下标却从未装载条目这两个实机缺陷。
    let owner = WindowGuard(unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            WS_POPUP,
            0,
            0,
            540,
            400,
            0,
            0,
            hinstance,
            std::ptr::null(),
        )
    });
    assert_ne!(owner.0, 0, "测试属主创建失败");
    let combo = unsafe {
        CreateWindowExW(
            0,
            wide("COMBOBOX").as_ptr(),
            wide("").as_ptr(),
            COMBO_STYLE,
            0,
            0,
            CTRL_W_POPUP,
            ROW_H + COMBO_LIST_H,
            owner.0,
            FIELD_BASE as isize,
            hinstance,
            std::ptr::null(),
        )
    };
    assert_ne!(combo, 0, "测试组合框创建失败");
    set_combo_heights(combo, ROW_H, 1.0);
    let view = SettingsView::default();
    let mut checked = 0;
    for field in TABS
        .iter()
        .flat_map(|tab| tab.sections)
        .flat_map(|section| section.fields)
    {
        let FieldKind::Enum(choices) = field.kind else {
            continue;
        };
        assert!(!choices.is_empty(), "{} 的枚举不应为空", field.key);
        let value = SettingsValue::Text(choices.last().unwrap().value.to_string());
        write_control(combo, field.key, field.kind, Some(&value), &view);
        assert_eq!(
            unsafe {
                SendMessageW(combo, 0x0154 /* CB_GETITEMHEIGHT */, usize::MAX, 0)
            },
            ROW_H as isize,
            "字段区高度必须按逻辑行高设置"
        );
        assert_eq!(
            unsafe {
                SendMessageW(combo, 0x0154 /* CB_GETITEMHEIGHT */, 0, 0)
            },
            ROW_H as isize,
            "列表项高度独立于字段区，不能遗漏"
        );
        assert_eq!(
            unsafe {
                SendMessageW(combo, 0x0146 /* CB_GETCOUNT */, 0, 0)
            },
            choices.len() as isize,
            "{} 的选项必须实际装入控件",
            field.key
        );
        for (index, choice) in choices.iter().enumerate() {
            assert_eq!(
                unsafe { combo_item_text(combo, index as i32) },
                choice.label,
                "{} 必须持有中文标签，不能持有临时UTF16指针",
                field.key
            );
        }
        assert_eq!(
            read_control(combo, field.kind),
            Some(value),
            "{} 选中项必须往返 schema 线值",
            field.key
        );
        checked += 1;
    }
    assert!(checked >= 10, "全表应覆盖主题、AI、频率与工具预设");
}

#[test]
fn 设置滚动能拖动长页并夹在内容范围内() {
    assert_eq!(scroll_target(100, 1000, 200, SB_LINEUP, 0), 76);
    assert_eq!(scroll_target(100, 1000, 200, SB_PAGEDOWN, 0), 300);
    assert_eq!(scroll_target(100, 1000, 200, SB_BOTTOM, 0), 800);
    assert_eq!(scroll_target(800, 1000, 200, SB_LINEDOWN, 0), 800);
    assert_eq!(scroll_target(300, 100, 200, SB_THUMBTRACK, 90), 0);
    assert_eq!(
        scroll_target(0, 120_000, 200, SB_THUMBTRACK, 90_000),
        90_000,
        "滑块位置不能被WM_VSCROLL的16位消息字段截断"
    );
    assert_eq!(scroll_target(0, 1000, 200, SB_THUMBPOSITION, 900), 800);
}

/// 源码级守门：`with_state` 的闭包里不得再借 STATE。
///
/// 嵌套时 `with_state` 会落回 `None`（重入不再 abort），但**那一次的内容会丢**：
/// 设置页刷新、切 Tab、滚动重排丢一次就是可见残缺。两处真实缺陷（`refresh_ui`
/// 与切 Tab 的排布都在借用里调了 [`layout`]，2026-10-07 修复）都是这个形状，
/// 所以守在这一层。
/// **间接嵌套扫不出来**（闭包里调用的 helper 自己借 STATE），靠「先取 hwnd、
/// 出借用再 layout」的形状约束 + [`layout`] 顶部的就地说明。
#[test]
fn with_state_不得在借用里再借_state() {
    let source = production_source();
    // 拆开拼接，避免断言文本命中自身。
    let needle = concat!("with_", "state(");
    assert!(
        source.matches(needle).count() > 1,
        "扫描前提：本文件确实在使用 with_state",
    );
    let nested = crate::ui::platform::windows::source_guard::nested_call_sites(&source, needle);
    assert!(
        nested.is_empty(),
        "with_state 闭包里又借了一次 STATE（外层行, 内层行）：{nested:?} —— 拆成「先取值、出借用再调」",
    );
    assert_eq!(
        source
            .matches(concat!("|state| layout(", "state.hwnd)"))
            .count(),
        0,
        "[layout] 自己借 STATE：必须在借用里先取 hwnd、出借用再调",
    );
}

#[test]
fn 提交类贴主按钮面其余走普通面() {
    // 全面自绘：每个显式按钮都有 ownerdraw 角色（不再有「保持系统外观」的档）。
    for kind in [
        SettingsButton::Save,
        SettingsButton::SaveDocument,
        SettingsButton::SaveCorrection,
    ] {
        assert_eq!(
            button_role(kind),
            ButtonRole::Primary,
            "{kind:?} 是提交类动作，应贴 primary 面"
        );
    }
    for kind in [
        SettingsButton::Refresh,
        SettingsButton::PanelRefresh,
        SettingsButton::DocumentClose,
        SettingsButton::DocumentRegenerate,
        SettingsButton::DocumentTest,
        SettingsButton::DocumentCopy,
        SettingsButton::MemoryPin,
        SettingsButton::MemoryForget,
        SettingsButton::RowPrimary,
        SettingsButton::RowSecondary,
        SettingsButton::MemoryPager,
    ] {
        assert_eq!(
            button_role(kind),
            ButtonRole::Normal,
            "{kind:?} 是普通动作，应走 btn_bg 普通面（不再有系统外观档）"
        );
    }
}

/// 组合框条目配色（② 全面自绘）：字段区取输入面族、条目取 `field_bg`、
/// 选中行有覆盖、文字取 ink / 禁用降 dim；三套主题都成立。
#[test]
fn 组合框条目配色取输入面族与主文字色() {
    for id in theme::ThemeId::ALL {
        let tokens = id.tokens();
        // 字段区（收起态）= 输入面族（Pending = field_bg + field_edge + field_bevel）。
        let field = combo_item_style(tokens, false, false, true);
        assert_eq!(
            format!("{:?}", field.bg),
            format!("{:?}", Some(tokens.field_bg)),
            "{id:?} 字段区底必须取 field_bg（Fill 无 PartialEq，按 Debug 结构比对）"
        );
        assert_eq!(field.edge, Some(tokens.field_edge), "{id:?}");
        assert!(field.bevel.is_some(), "{id:?} 字段区应带输入面族内立体线");
        assert_eq!(field.ink, tokens.ink, "{id:?}");
        assert!(field.overlay.is_none(), "{id:?} 字段区不叠选中覆盖");
        // 清单条目：field_bg 底、无描边；选中行叠悬浮同款覆盖。
        let item = combo_item_style(tokens, false, false, false);
        assert_eq!(
            format!("{:?}", item.bg),
            format!("{:?}", Some(tokens.field_bg)),
            "{id:?} 条目底取 field_bg"
        );
        assert_eq!(item.edge, None, "{id:?} 条目不带字段描边");
        assert!(item.overlay.is_none(), "{id:?} 未选中条目无覆盖");
        let selected = combo_item_style(tokens, true, false, false);
        assert!(
            selected.overlay.is_some(),
            "{id:?} 选中行必须有可见的选中覆盖"
        );
        // 禁用：文字降 dim（底不变）。
        let disabled = combo_item_style(tokens, false, true, true);
        assert_eq!(disabled.ink, tokens.dim, "{id:?} 禁用文字降 dim");
        assert_ne!(
            tokens.ink, tokens.dim,
            "{id:?} ink 与 dim 同值 = 禁用态不可检"
        );
    }
}

/// 弹窗按钮行（②）：从右缘往左排、间距 8、末项不出左缘；只读（无保存）少一项。
#[test]
fn 弹窗按钮行贴右缘从右往左排() {
    // 保存 → 关闭（只读文档）。
    let xs = doc_dialog_button_row(DOC_DIALOG_W, &[DOC_DIALOG_BTN_W_CLOSE]);
    assert_eq!(xs, vec![DOC_DIALOG_W - MARGIN - DOC_DIALOG_BTN_W_CLOSE]);
    // 关闭 → 复制（只读 Card 模版）：复制是次要动作、排在关闭左侧，两按钮都放得下。
    let xs = doc_dialog_button_row(
        DOC_DIALOG_W,
        &[DOC_DIALOG_BTN_W_CLOSE, DOC_DIALOG_BTN_W_COPY],
    );
    assert_eq!(xs.len(), 2);
    assert_eq!(xs[0] + DOC_DIALOG_BTN_W_CLOSE, DOC_DIALOG_W - MARGIN);
    assert_eq!(xs[0] - 8 - DOC_DIALOG_BTN_W_COPY, xs[1]);
    assert!(xs[1] > MARGIN, "复制按钮不得压出左缘");
    // 保存 → 关闭 → 重新生成。
    let xs = doc_dialog_button_row(
        DOC_DIALOG_W,
        &[
            DOC_DIALOG_BTN_W_SAVE,
            DOC_DIALOG_BTN_W_CLOSE,
            DOC_DIALOG_BTN_W_REGENERATE,
        ],
    );
    assert_eq!(xs.len(), 3);
    // 首项贴右缘。
    assert_eq!(xs[0] + DOC_DIALOG_BTN_W_SAVE, DOC_DIALOG_W - MARGIN);
    // 项间距 8、顺序严格从右往左。
    assert_eq!(xs[0] - 8 - DOC_DIALOG_BTN_W_CLOSE, xs[1]);
    assert_eq!(xs[1] - 8 - DOC_DIALOG_BTN_W_REGENERATE, xs[2]);
    assert!(xs[2] > MARGIN, "次要动作不得压出左缘（弹窗宽度要能容下）");
}

/// MCP 表单弹窗几何（纯函数）：每行一个控件、多行字段更高、行自上而下不重叠、
/// 控件右缘对齐内容右缘；按钮行在最后一行之下且客户区放得下按钮行。
#[test]
fn mcp表单弹窗几何按字段行排布() {
    let form = crate::ui::settings::panels::McpServerForm {
        name: "demo".to_string(),
        transport: McpTransport::Http,
        command: String::new(),
        args: "-y\npkg".to_string(),
        url: "https://example.com/mcp".to_string(),
        env: "TOKEN=1".to_string(),
        headers: "A=b".to_string(),
        enabled: false,
    };
    let rows = mcp_form_rows(&form, None);
    assert_eq!(
        rows.len(),
        MCP_FORM_FIELD_COUNT,
        "字段数变了要同批改 id 段遍历"
    );
    let (rects, buttons_y) = mcp_form_dialog_layout(&rows, DOC_DIALOG_W);
    assert_eq!(rects.len(), rows.len(), "每行一个标签 + 一个控件");
    let mut previous_bottom = MARGIN + 24 + 32;
    for ((label, control), row) in rects.iter().zip(rows.iter()) {
        assert!(label.y >= previous_bottom, "字段行自上而下不重叠");
        assert_eq!(label.y, control.y, "同一行的标签与控件同顶");
        assert_eq!(control.h, mcp_form_row_h(&row.control), "控件高度按形态取");
        assert!(control.x >= label.x + label.w, "控件在标签右侧");
        assert_eq!(
            control.x + control.w,
            DOC_DIALOG_W - MARGIN,
            "控件右缘统一对齐内容右缘"
        );
        previous_bottom = control.y + control.h;
    }
    let last = rects.last().expect("表单至少一行");
    assert!(buttons_y >= last.1.y + last.1.h, "按钮行在最后一行之下");
    assert!(
        mcp_form_dialog_height(&rows) >= buttons_y + DOC_DIALOG_BTN_H,
        "客户区高度要放得下按钮行"
    );
    // 多行字段确实更高（形态映射生效，不是全表同高）。
    let args_index = rows
        .iter()
        .position(|row| row.key == MCP_FIELD_ARGS)
        .unwrap();
    assert!(
        rects[args_index].1.h > rects[0].1.h,
        "args 是多行控件高度，name 是单行"
    );
}

/// 工具页必须按**共享口径**过滤面板：Windows 侧曾漏掉这条规则，工具策略
/// （声明）列表照常渲染（用户 2026-10-07 实机截图「设置怎么多了这些工具列表？
/// mac 没有啊」）。判据放共享层 [`renders_tools_panel`]，两端同源；这里再钉一条
/// 源码级守门，防止平台侧又自写一份过滤判据。
#[test]
fn 工具页按共享口径过滤面板() {
    use crate::ui::settings::panels::{PANEL_MCP, PANEL_POLICIES, PANEL_SKILLS};
    assert!(
        !renders_tools_panel(PANEL_POLICIES),
        "「工具策略（声明）」只读列表按用户规则 2026-10-05 撤下"
    );
    assert!(renders_tools_panel(PANEL_MCP), "MCP 服务器列表保留");
    assert!(renders_tools_panel(PANEL_SKILLS), "Skill 列表保留");

    let production = production_source();
    assert!(
        production.contains(".filter(|panel| renders_tools_panel(&panel.id))"),
        "工具页面板过滤必须走共享 `renders_tools_panel`（平台自写判据 = 第二定义点）"
    );
}

/// ownerdraw 按钮必须走**父窗底重放**：token 近似补角正是用户 2026-10-07 实拍
/// 「按钮后面一块灰色矩形底」的根因（近似色与真实条底差十几到三十灰阶）。
/// 源码级守门：生产段不得再直接调 `paint_win::draw_button(` 的近似路径。
#[test]
fn ownerdraw按钮走父窗底重放() {
    let production = production_source();
    assert!(
        production.contains("draw_button_on_parent_backdrop("),
        "按钮绘制必须接父窗底重放（否则四角回到近似色 = 灰色矩形）"
    );
    assert!(
        !production.contains("paint_win::draw_button("),
        "按钮不得回落到 token 近似补角（用户实拍症状的根因）"
    );
}

/// 撤下的设置键不得再出现在**生产段**（schema 撤项后平台侧残留引用 = 死分支 /
/// 死夹具 —— 本批点名的同类坑：漏改平台调用点）。名单随共享层撤项同批维护。
///
/// 源级守门（只跑在 Windows CI）：`_chat.rs` 的同款做法是切到 `#[cfg(test)]` 之前。
#[test]
fn 撤下的设置键不再出现在生产码里() {
    let production = production_source();
    for key in [
        "action.previewPopupSize",
        "general.popup.fixedPosition",
        "general.popup.defaultSize",
        "general.popup.chatWidth",
    ] {
        assert!(
            !production.contains(key),
            "撤下的设置项 {key} 仍被生产码引用（死分支/死夹具）"
        );
    }
}

/// 数值档位（NumberChoice）：按**最近档**高亮但**不产生要写回的值** ——
/// 存量 1.5 打开设置只被显示成最近档，草稿原样保留（用户没点就不该被改写）。
#[test]
fn 数值档位按最近档高亮且不写值() {
    let options: &[(&str, f64)] = &[("弱", 1.0), ("强", 2.0)];
    // 正常值命中各自档位。
    assert_eq!(number_choice_selected(options, Some(1.0)), Some(0));
    assert_eq!(number_choice_selected(options, Some(2.0)), Some(1));
    // 平手取**靠前**档（1.5 距两档等距 → 「弱」）。
    assert_eq!(number_choice_selected(options, Some(1.5)), Some(0));
    // 档位之外的存量值：按最近档高亮、不改值（返回值里没有任何「值」可写）。
    assert_eq!(number_choice_selected(options, Some(1.9)), Some(1));
    assert_eq!(number_choice_selected(options, Some(0.8)), Some(0));
    assert_eq!(number_choice_selected(options, Some(99.0)), Some(1));
    // 值缺失 / 空档位表：无高亮（不猜一个档）。
    assert_eq!(number_choice_selected(options, None), None);
    assert_eq!(number_choice_selected(&[], Some(1.0)), None);
}

/// 数值档位命中（点击语义）：段内命中各自下标；段间间隙与界外不命中
/// （不猜一个档写值）。
#[test]
fn 数值档位命中段与间隙() {
    let widths = number_choice_equal_widths(100, 2);
    assert_eq!(widths, vec![50, 50]);
    assert_eq!(number_choice_hit(&widths, 0), Some(0));
    assert_eq!(number_choice_hit(&widths, 49), Some(0));
    // 50..52 是段间间隙（NUMBER_CHOICE_GAP = 2）→ 不命中。
    assert_eq!(number_choice_hit(&widths, 50), None);
    assert_eq!(number_choice_hit(&widths, 51), None);
    assert_eq!(number_choice_hit(&widths, 52), Some(1));
    assert_eq!(number_choice_hit(&widths, 101), Some(1));
    // 界外（负数 / 超出总宽）不命中。
    assert_eq!(number_choice_hit(&widths, -1), None);
    assert_eq!(number_choice_hit(&widths, 102), None);
    assert_eq!(number_choice_hit(&[], 0), None);
}

/// 激活规则：光标命中哪段就选哪段；命不中（键盘 Space / 点进间隙）→ 下一档循环。
#[test]
fn 数值档位激活命不中时循环下一档() {
    // 光标命中优先（点哪段选哪段）。
    assert_eq!(number_choice_activation(Some(1), Some(0), 2), Some(1));
    assert_eq!(number_choice_activation(Some(0), Some(1), 2), Some(0));
    // 命不中 + 已有高亮 → 下一档（循环：最后一档回到第一档）。
    assert_eq!(number_choice_activation(None, Some(0), 2), Some(1));
    assert_eq!(number_choice_activation(None, Some(1), 2), Some(0));
    // 命不中 + 无高亮 → 第一档。
    assert_eq!(number_choice_activation(None, None, 2), Some(0));
    // 空档位表 → 不写值。
    assert_eq!(number_choice_activation(None, Some(0), 0), None);
    assert_eq!(number_choice_activation(Some(0), Some(0), 0), Some(0));
}

/// 段宽均分：除不尽的余数落在最后一段（总宽守恒）。
#[test]
fn 数值档位段宽均分余数落末段() {
    assert_eq!(number_choice_equal_widths(100, 3), vec![33, 33, 34]);
    assert_eq!(number_choice_equal_widths(101, 2), vec![50, 51]);
    assert_eq!(number_choice_equal_widths(0, 2), vec![0, 0]);
    assert!(number_choice_equal_widths(100, 0).is_empty());
    // 总宽守恒（含间隙前的段宽和 = 客户区宽）。
    let widths = number_choice_equal_widths(97, 4);
    assert_eq!(widths.iter().sum::<i32>(), 97);
}

/// 弹窗控件 id 不得与系统约定 id（IDOK / IDCANCEL）撞号：
/// `GetDlgItem` 按 id 取控件，撞号会让「保存」按钮的取回命中标题 STATIC。
#[test]
fn 弹窗控件_id_不撞系统_id() {
    for id in [
        DOC_DIALOG_TITLE_ID,
        DOC_DIALOG_HINT_ID,
        DOC_DIALOG_EDIT_ID,
        DOC_DIALOG_REGENERATE_ID,
        DOC_DIALOG_TEST_ID,
        DOC_DIALOG_COPY_ID,
    ] {
        assert_ne!(id, IDOK, "弹窗控件 id 撞 IDOK");
        assert_ne!(id, IDCANCEL, "弹窗控件 id 撞 IDCANCEL");
    }
}

/// 弹窗次要动作计划：目标门控与 macOS `doc_dialog_buttons` 同表 ——
/// 「复制」只属只读的 Card 模版，其它只读目标（VariablePool）不得借到；
/// 「重新生成 / 测试连接」的既有门控保持原样。
#[test]
fn 弹窗次要动作只给匹配目标() {
    assert_eq!(
        doc_dialog_secondary(&DocumentTarget::CardTemplate)
            .expect("Card 模版应有复制动作")
            .0,
        "复制",
        "Card 模版（只读）：次要动作是复制"
    );
    let copy = doc_dialog_secondary(&DocumentTarget::CardTemplate).unwrap();
    assert_eq!(copy.1, DOC_DIALOG_COPY_ID);
    assert_eq!(copy.2, SettingsButton::DocumentCopy);
    // 其它只读目标没有次要动作（不关弹窗的附加动作一个都不给）。
    for target in [DocumentTarget::VariablePool] {
        assert!(
            doc_dialog_secondary(&target).is_none(),
            "{target:?} 不应出现次要动作"
        );
    }
    // 可编辑目标里只有既有两处匹配；复制不得借给它们。
    for target in [
        DocumentTarget::V1rtual,
        DocumentTarget::CardMarkdown {
            card_id: "sugar".into(),
        },
        DocumentTarget::McpServer {
            name: String::new(),
        },
    ] {
        assert!(
            doc_dialog_secondary(&target).is_none(),
            "{target:?} 不应出现次要动作"
        );
    }
    assert_eq!(
        doc_dialog_secondary(&DocumentTarget::CardStages).unwrap().0,
        "重新生成"
    );
    assert_eq!(
        doc_dialog_secondary(&DocumentTarget::McpServer {
            name: "github".into()
        })
        .unwrap()
        .0,
        "测试连接"
    );
}

/// 组合框条目行/字段区用面（纯函数）：字段区走输入面族、条目行走普通面。
#[test]
fn 组合框字段区用输入面族() {
    assert_eq!(combo_item_role(true), ButtonRole::Pending);
    assert_eq!(combo_item_role(false), ButtonRole::Normal);
    assert_ne!(combo_item_role(true), combo_item_role(false));
}

/// 颜色编码字节序（AGENTS §9 的 GDI 两字节序）：`COLORREF` 是 `0x00BBGGRR`
/// —— 红在最末字节。本文件所有颜色都经 `paint_win::colorref`，这条钉住该口径。
#[test]
fn 色值编码是_bgr_字节序() {
    // #FF8800 → 蓝 0x00、绿 0x88、红 0xFF。
    assert_eq!(
        paint_win::colorref(theme::Rgba::hex(0xFF_88_00)),
        0x0000_88FF,
        "COLORREF 必须按 0x00BBGGRR 排布（红在最末字节）"
    );
    // 往返一致。
    let color = theme::Rgba::hex(0x12_34_56);
    assert_eq!(
        paint_win::rgba_from_colorref(paint_win::colorref(color)),
        color
    );
}

/// 竖栏行按钮：几何与 id 段都按设计稿/`on_command` 的范围约定钉住。
#[test]
fn 竖栏行按钮几何与_id_段一致() {
    // 行宽 = 竖栏宽 − 2×横向内边距（设计稿 104 − 2×6 = 92）。
    assert_eq!(RAIL_W - RAIL_PAD_X * 2, 92);
    // 行排布：顶距 9、行距 26+1（与 macOS 的 rail_item_y 同式）。
    assert_eq!(RAIL_TOP + 4 * (RAIL_ITEM_H + RAIL_ITEM_GAP), 117);
    // TAB_BASE 段宽 16 必须容下全部 Tab（on_command 的 `..TAB_BASE + 16` 保护）。
    assert!(
        (TABS.len() as i32) < 16,
        "Tab 数超过 TAB_BASE 段宽 = 分派分支会漏"
    );
}

/// 密钥揭示切换：两个方向的密码字符必须不同（0=明文；复遮蔽写回原遮蔽字符）。
#[test]
fn 密钥揭示切换在明文与遮蔽间往返() {
    let masked = secret_toggle(false, 0x25CF);
    assert_eq!(masked, (0, "隐藏"), "遮蔽态点击应切到明文");
    let revealed = secret_toggle(true, 0x25CF);
    assert_eq!(
        revealed,
        (0x25CF, "显示"),
        "明文态点击应恢复建控件时读到的遮蔽字符"
    );
    assert_ne!(masked.0, revealed.0, "明文与遮蔽的密码字符不得同值");
    // 遮蔽字符缺省回落也要能往返（读不到默认值时用 ●）。
    assert_eq!(secret_toggle(true, 0x25CF).0, 0x25CF);
}

/// 标签截断护栏（2026-10-05 行结构重排后按新几何，与 macOS 同表）：schema 全表
/// 标签在**默认窗宽的标签块**内都放得下（标签块宽 = 内容宽 − 控件宽 − 间距，
/// 控件宽度分档见 [`field_control_size`]）。
///
/// Windows 标签用 `small` 基线（11），估算口径与 macOS 一致（保守的字符宽度近似：
/// 全角 ≈ 1em、ASCII ≈ 0.6em，不是字体度量）；Action 行无左标签（按钮文字即标题），
/// 改为断言其按钮文案不超出按钮宽度上限。
#[test]
fn 全部字段标签在标签块内完整显示() {
    /// 标签用 `small` 基线（11）、按钮文案用正文基线（13.5）：估算口径与
    /// `field_control_size` 同源（保守的字符宽度近似：全角 ≈ 1em、ASCII ≈ 0.6em）。
    const LABEL_FONT_BASE: f64 = 11.0;
    const BODY_FONT_BASE: f64 = 13.5;
    fn estimated_width(text: &str, base: f64) -> f64 {
        text.chars()
            .map(|ch| {
                let wide = matches!(ch, '\u{1100}'..='\u{FFEF}');
                if wide {
                    base
                } else {
                    base * 0.6
                }
            })
            .sum()
    }
    // 默认窗宽 540（windows.rs `WindowId::Settings` 默认值）→ 内容区完整宽 =
    // 窗宽 − 竖栏（`rebuild_tab` 的 `content_width` 同口径）。
    let content_width = 540 - RAIL_W;
    for tab in TABS {
        for section in tab.sections {
            for field in section.fields {
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue; // 不渲染独立控件
                }
                if matches!(field.kind, FieldKind::Action) {
                    // Action 行无左标签（按钮文字即标题），断言文案不超出按钮宽度上限。
                    let estimated = estimated_width(field.label, BODY_FONT_BASE);
                    assert!(
                        estimated + 28.0 <= 200.5,
                        "{}/{} 的动作「{}」估算宽度 {estimated:.1}px 超出按钮宽度上限 200px",
                        tab.id,
                        section.title,
                        field.label
                    );
                    continue;
                }
                let estimated = estimated_width(&field.display_label(), LABEL_FONT_BASE);
                let (ctrl_w, _) = field_control_size(field);
                let label_w = field_label_width(content_width, ctrl_w);
                assert!(
                    estimated <= f64::from(label_w) - 4.0,
                    "{}/{} 的标签「{}」估算宽度 {estimated:.1}px 超出标签块 {label_w}px",
                    tab.id,
                    section.title,
                    field.label
                );
            }
        }
    }
}

/// 通知分档（①）：错误绝不降级成浮层、回执绝不弹模态（与 macOS `notice_action` 同表）。
#[test]
fn 通知分档归位() {
    // 同一代际：三个档位都不重复呈现。
    for level in [NoticeLevel::Error, NoticeLevel::Info, NoticeLevel::Warning] {
        assert_eq!(
            notice_action(level, 7, 7),
            NoticeAction::None,
            "{level:?} 同一代际不得重复呈现"
        );
    }
    assert_eq!(notice_action(NoticeLevel::Error, 8, 7), NoticeAction::Modal);
    assert_eq!(notice_action(NoticeLevel::Info, 8, 7), NoticeAction::Toast);
    assert_eq!(
        notice_action(NoticeLevel::Warning, 8, 7),
        NoticeAction::Toast
    );
}

/// 判新只认代际、不比较文本：同一句话连报两次（文本相等）也必须算新通知 ——
/// 否则浮层不会重新计时（需求点名的缺陷）。
#[test]
fn 同一句话连报两次仍按新通知处理() {
    // 第一次呈现：代际 1（已呈现代际 0）。
    assert_eq!(
        notice_action(NoticeLevel::Info, 1, 0),
        NoticeAction::Toast,
        "第一次通知必须算新"
    );
    // 已呈现代际 1 之后，同一文本、新代际 2 —— 必须再算新（分档照旧）。
    // 判据里根本没有文本：函数形状上就没有「按文本判旧」这条路的入口。
    assert_eq!(
        notice_action(NoticeLevel::Info, 2, 1),
        NoticeAction::Toast,
        "同文本 + 新代际 = 新通知，必须重新呈现/重新计时"
    );
    // 同一条（代际未前进）不重复呈现。
    assert_eq!(
        notice_action(NoticeLevel::Info, 2, 2),
        NoticeAction::None,
        "同一条通知不得重复呈现"
    );
}

/// 文档弹窗的呈现门（②）：只在内容已加载、没有在显弹窗、且本次打开未呈现过时才弹
/// （与 macOS `document_should_present` 同判据）。
#[test]
fn 文档弹窗只在加载完成后弹一次() {
    assert!(document_should_present(true, false, false), "加载完成应弹");
    assert!(!document_should_present(false, false, false), "读取中不弹");
    assert!(
        !document_should_present(true, true, false),
        "已有弹窗在显不重入"
    );
    assert!(
        !document_should_present(true, false, true),
        "本次打开已呈现过不重弹（保存回执只重写文本，不再弹）"
    );
}

/// 浮层档位编码往返：三个档位互不相同且可还原（Warning 绝不落回 Info）。
#[test]
fn 浮层档位编码可往返() {
    for level in [NoticeLevel::Info, NoticeLevel::Warning, NoticeLevel::Error] {
        assert_eq!(
            notice_level_from_code(notice_level_code(level)),
            level,
            "{level:?} 编码往返失败"
        );
    }
    let codes = [
        notice_level_code(NoticeLevel::Info),
        notice_level_code(NoticeLevel::Warning),
        notice_level_code(NoticeLevel::Error),
    ];
    assert_ne!(codes[0], codes[1], "Info 与 Warning 编码同值");
    assert_ne!(codes[1], codes[2], "Warning 与 Error 编码同值");
    // 未知编码收拢 Info（槽位只有本文件写，这条只是防御）。
    assert_eq!(notice_level_from_code(99), NoticeLevel::Info);
}

/// 浮层几何（①）：居中于窗口客户区（与 macOS `show_toast` 同式）、贴 `NOTICE_TOP`、
/// 宽度被客户区宽收口、且随 DPI 等比缩放。
#[test]
fn 浮层几何居中于客户区且宽度收口() {
    // 常规：文本 200×34，窗宽 540（逻辑）→ 宽 = 文本 + 2×内边距。
    let (x, y, w, h) = notice_overlay_geometry((200, 34), 540, 1.0);
    assert_eq!((w, h), (200 + NOTICE_PAD_X * 2, 34 + NOTICE_PAD_Y * 2));
    assert_eq!(y, NOTICE_TOP);
    // 水平居中：左缘 = (客户区宽 − 浮层宽) / 2。
    assert_eq!(x, (540 - w) / 2);
    assert_eq!(x + w / 2, 540 / 2, "浮层中线必须对齐窗口中线");
    // 窄文本给最小宽度（不缩成一条）。
    let (_, _, narrow_w, _) = notice_overlay_geometry((10, 20), 540, 1.0);
    assert_eq!(narrow_w, NOTICE_MIN_W);
    // 超宽文本被客户区宽（窗宽 − 2×MARGIN）收口，仍居中。
    let (wide_x, _, wide_w, _) = notice_overlay_geometry((900, 20), 540, 1.0);
    assert_eq!(wide_w, 540 - MARGIN * 2);
    assert_eq!(wide_x, MARGIN);
    // 2× DPI：几何整体等比（物理像素），不会一半逻辑一半物理。
    let (x2, y2, w2, h2) = notice_overlay_geometry((400, 68), 1080, 2.0);
    assert_eq!((x2, y2, w2, h2), (x * 2, y * 2, w * 2, h * 2));
}

/// 文档弹窗内部布局（②）：标题/说明/编辑框自上而下不重叠，按钮行贴底且编辑框吃剩余高度。
#[test]
fn 文档弹窗内部布局不重叠且按钮贴底() {
    let client = (DOC_DIALOG_W, DOC_DIALOG_H);
    let (title, hint, edit, buttons_y) = doc_dialog_layout(client);
    assert_eq!((title.x, title.y), (MARGIN, MARGIN));
    assert!(title.bottom() <= hint.y, "标题与说明不得重叠");
    assert!(hint.bottom() <= edit.y, "说明与编辑框不得重叠");
    // 按钮行贴底：按钮底 + 边距 = 弹窗客户区高。
    assert_eq!(buttons_y + DOC_DIALOG_BTN_H + MARGIN, client.1);
    // 编辑框与按钮行之间留 6px 间隙且吃满剩余高度。
    assert_eq!(edit.bottom() + 6, buttons_y);
    assert!(edit.h > 0);
    // 弹窗变高 → 编辑框变高、按钮行下移（其余不动）。
    let taller = (DOC_DIALOG_W, DOC_DIALOG_H + 106);
    let (title2, hint2, edit2, buttons_y2) = doc_dialog_layout(taller);
    assert_eq!((title2, hint2), (title, hint));
    assert_eq!(buttons_y2, buttons_y + (taller.1 - client.1));
    assert_eq!(edit2.h, edit.h + (taller.1 - client.1));
    // 极小程序区：编辑框有下限（不出现负高度/控件被顶出）。
    let (_, _, tiny_edit, _) = doc_dialog_layout((200, 120));
    assert!(tiny_edit.h >= 40, "编辑框高度必须有下限");
    assert!(tiny_edit.w > 0);
    // 按钮右缘不越出弹窗右缘（保存/关闭都贴内容右缘，两按钮之间留 8px）。
    let save_x = DOC_DIALOG_W - MARGIN - DOC_DIALOG_BTN_W_SAVE;
    let close_x = save_x - 8 - DOC_DIALOG_BTN_W_CLOSE;
    assert!(close_x > MARGIN, "关闭按钮必须在编辑框右侧仍有位置");
    assert!(save_x + DOC_DIALOG_BTN_W_SAVE <= DOC_DIALOG_W - MARGIN);
}

/// 字段提交时机（编辑即置脏组）：数字解析不兜底、越界按 clamp 收口。
#[test]
fn 数字字段解析不兜底且越界收口() {
    // 中间态 / 非法输入：不产生值（绝不是 0）。
    assert_eq!(
        parse_number_text("", 1.0, 2.0),
        None,
        "空串是中间态，不判非法、不写值"
    );
    assert_eq!(parse_number_text("-", 1.0, 2.0), None, "只敲了负号不算值");
    assert_eq!(
        parse_number_text("abc", 1.0, 2.0),
        None,
        "非数字不得兜底成 0"
    );
    assert_eq!(parse_number_text("1e999", 1.0, 2.0), None, "非有限值不写");
    // 正常解析（含首尾空白）。
    assert_eq!(parse_number_text(" 1.5 ", 1.0, 2.0), Some(1.5));
    // 越界 clamp（沿用既有 `read_control` 口径）。
    assert_eq!(parse_number_text("99", 1.0, 2.0), Some(2.0));
    assert_eq!(parse_number_text("0.1", 1.0, 2.0), Some(1.0));
}

/// 编辑提交只在值真的变了时写草稿（防程序化 `SetWindowTextW` 的 `EN_CHANGE` 自激）。
#[test]
fn 编辑提交只在值变化时写草稿() {
    let current = SettingsValue::Number(1.5);
    assert!(edit_commit_needed(
        Some(&current),
        &SettingsValue::Number(2.0)
    ));
    assert!(!edit_commit_needed(
        Some(&current),
        &SettingsValue::Number(1.5)
    ));
    // 文本字段同判据（值相等不重复提交）。
    assert!(!edit_commit_needed(
        Some(&SettingsValue::Text("x".into())),
        &SettingsValue::Text("x".into())
    ));
    assert!(edit_commit_needed(
        Some(&SettingsValue::Text("x".into())),
        &SettingsValue::Text("xy".into())
    ));
    // 草稿里没有这个键（防御性）：第一次提交要写。
    assert!(edit_commit_needed(None, &SettingsValue::Number(1.5)));
}

#[test]
fn 文字角色取对_token_且错误警告不对调() {
    for id in theme::ThemeId::ALL {
        let tokens = id.tokens();
        assert_eq!(
            paint_win::text_color(tokens, TextRole::Body),
            tokens.ink,
            "{id:?}"
        );
        assert_eq!(
            paint_win::text_color(tokens, TextRole::Hint),
            tokens.dim,
            "{id:?}"
        );
        assert_eq!(
            paint_win::text_color(tokens, TextRole::Error),
            tokens.danger,
            "{id:?} 错误文字必须取 danger"
        );
        assert_eq!(
            paint_win::text_color(tokens, TextRole::Warning),
            tokens.warn,
            "{id:?} 警告文字必须取 warn"
        );
        assert_ne!(
            tokens.danger, tokens.warn,
            "{id:?} danger 与 warn 同值 = 对调不可检"
        );
    }
}

/// 行内下拉（`Pick`）的主控件是下拉、不是（空标题）按钮 —— 挡住「下拉行落到
/// 按钮位 = 主控件消失」的退化；文案表与形态表互证。
#[test]
fn 行内下拉主控件按下拉渲染且不落空按钮() {
    assert_eq!(row_main_kind(RowAction::Pick), RowMainKind::Pick);
    assert_eq!(
        row_button_title(RowAction::Pick, false),
        "",
        "Pick 行的主控件是下拉，不占按钮文案"
    );
    // 按钮档文案表：开关两态 / 查看 / 试听（试听作主按钮用于无 pick 的旧行）。
    assert_eq!(row_main_kind(RowAction::Toggle), RowMainKind::Button);
    assert_eq!(row_button_title(RowAction::Toggle, true), "已启用");
    assert_eq!(row_button_title(RowAction::Toggle, false), "已关闭");
    assert_eq!(row_button_title(RowAction::Select, false), "查看");
    assert_eq!(row_button_title(RowAction::Preview, false), "试听");
    // 凭据行（MCP「GitHub 令牌」）：主控件是按钮、文案「设置」（不落空按钮）。
    assert_eq!(row_main_kind(RowAction::Credential), RowMainKind::Button);
    assert_eq!(row_button_title(RowAction::Credential, false), "设置");
    // 记忆作业行（取消 / 继续）与备份行的选中：按钮档、文案固定（选中态按 enabled 两态）。
    assert_eq!(row_main_kind(RowAction::Cancel), RowMainKind::Button);
    assert_eq!(row_button_title(RowAction::Cancel, false), "取消");
    assert_eq!(row_main_kind(RowAction::Resume), RowMainKind::Button);
    assert_eq!(row_button_title(RowAction::Resume, false), "继续");
    assert_eq!(row_main_kind(RowAction::Choose), RowMainKind::Button);
    assert_eq!(row_button_title(RowAction::Choose, true), "已选中");
    assert_eq!(row_button_title(RowAction::Choose, false), "选择");
    assert_eq!(row_main_kind(RowAction::None), RowMainKind::None);
    // 次按钮文案：音效事件行的 action2 = 试听（次按钮位上的 Preview）。
    assert_eq!(row_secondary_title(RowAction::Preview), "试听");
    assert_eq!(row_secondary_title(RowAction::Edit), "编辑");
    assert_eq!(row_secondary_title(RowAction::Delete), "删除");
    assert_eq!(row_secondary_title(RowAction::None), "");
    // 值写回判据：无控件（防御路径）绝不写值。
    assert!(!pick_change_is_final(0, CBN_SELENDOK));
    assert!(!pick_change_is_final(0, CBN_SELCHANGE));
}

/// 行内下拉选中项查找与回退（共享层口径）：按 `value` 命中；不在表里回退
/// 第一项（只回退呈现，不回写、不串项）。
#[test]
fn 行内下拉选中项回退第一项且不串项() {
    use crate::ui::settings::panels::RowOption;
    fn pick(selected: &str) -> RowPick {
        RowPick {
            options: vec![
                RowOption {
                    value: "none".into(),
                    label: "静音".into(),
                },
                RowOption {
                    value: "chime_short".into(),
                    label: "风铃".into(),
                },
                RowOption {
                    value: "welcome_chord".into(),
                    label: "温暖和弦".into(),
                },
            ],
            selected: selected.to_string(),
        }
    }
    // 命中：下标指向的 label 必须是被选中的那一项（字段区显示的就是它）。
    let current = pick("chime_short");
    assert_eq!(pick_selected_index(&current), 1);
    assert_eq!(current.options[pick_selected_index(&current)].label, "风铃");
    assert_eq!(
        current.options[pick_selected_index(&current)].value,
        "chime_short"
    );
    // 选中值不在选项表（列表更新/旧值）→ 回退第一项，不 panic、不猜别的项。
    let stale = pick("removed_sound");
    assert_eq!(pick_selected_index(&stale), 0);
    assert_eq!(stale.options[pick_selected_index(&stale)].label, "静音");
    // 第一项自身命中（idx 0 不等于「没找到」）。
    let first = pick("none");
    assert_eq!(pick_selected_index(&first), 0);
}

/// 行高推进（与 macOS `panel_rows_span` 的行高表同档）：副标题为空 = 单行紧凑；
/// 行内下拉行（subtitle 恒空）不得为下拉加高。
#[test]
fn 行高按副标题分档且下拉行保持紧凑() {
    use crate::ui::settings::panels::RowOption;
    assert_eq!(panel_row_advance(""), PANEL_ROW_H);
    assert_eq!(panel_row_advance("  "), PANEL_ROW_H, "空白副标题同空串口径");
    assert_eq!(panel_row_advance("说明"), PANEL_ROW_H + 18);
    let pick_row = PanelRow {
        id: "reply".into(),
        title: "收到回复".into(),
        subtitle: String::new(),
        action: RowAction::Pick,
        secondary: RowAction::Preview,
        enabled: false,
        pick: Some(RowPick {
            options: vec![RowOption {
                value: "none".into(),
                label: "静音".into(),
            }],
            selected: "none".into(),
        }),
    };
    assert_eq!(panel_row_advance(&pick_row.subtitle), PANEL_ROW_H);
    // 下拉主控件宽必须容下最长选项标签 + 箭头区（100 > 4×13.5 + 12 + 17）。
    assert!(PANEL_PICK_W >= 54 + 12 + 17, "下拉宽容不下四字标签 + 箭头");
}
