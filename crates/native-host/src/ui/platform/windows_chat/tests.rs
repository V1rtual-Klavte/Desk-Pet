//! 本模块单测（源码级守门与纯函数断言）。

// ==========================================
// 纯逻辑单测（无 Win32 调用；本模块只在 Windows 编译，macOS 上跑不到 —— 见 AGENTS §2。
// 本文件用例由 CI 的 verify (windows-latest) 执行；同表纯函数另在开发机做过
// 逐字镜像验证（先桩后实现，先红后绿），见交付报告。）
// ==========================================

use super::*;
use crate::ui::chat::panels::{PanelKind, PanelSurface, PanelView};
use crate::ui::theme::ThemeId;
use super::dialogs::*;
use super::input::*;
use super::layout::*;
use super::paint::*;
use super::panels::*;
use super::transcript::*;
use super::window::*;
use super::wndproc::*;

/// ownerdraw 按钮必须走**承载窗底重放**：token 近似补角/补底正是用户 2026-10-07
/// 实拍「按钮后面一块灰色矩形底」的根因（近似色比条区真实像素暗 20+ 灰阶）。
/// 源码级守门（与 `windows_settings` 的同名测试同款）：四条绘制入口都得先
/// `blit_button_backdrop` 再画药丸。
#[test]
fn ownerdraw按钮走承载窗底重放() {
    let production = production_source();
    assert!(
        production.contains("unsafe fn blit_button_backdrop("),
        "缺少承载窗底重放实现（底必须来自父窗真实像素）"
    );
    assert_eq!(
        production
            .matches("let backdrop = unsafe { blit_button_backdrop(item, rect) };")
            .count(),
        4,
        "四条绘制入口（通用按钮 / 待发送 chip / 无缩略图 chip / 画布内图片 chip）都必须重放底"
    );
}

/// 接触影不得画隐藏控件：隐藏窗口照样有矩形（`GetWindowRect` 有效），
/// `paint_button_shadows` 不看可见性就会在原位留一枚**没有按钮的灰药丸** ——
/// 用户 2026-10-07 实拍「上拉条上面一个莫名其妙的灰色气泡」正是隐藏的
/// 「↓ 新消息」按钮被画布一直补投影。
#[test]
fn 接触影跳过隐藏控件() {
    let production = production_source();
    let start = production
        .find("unsafe fn paint_button_shadows")
        .expect("paint_button_shadows 必须存在");
    let body = &production[start..(start + 900).min(production.len())];
    assert!(
        body.contains("IsWindowVisible(control)"),
        "投影前必须判控件可见性（否则隐藏按钮留下一枚无字灰药丸）"
    );
}

#[test]
fn richedit_结构遵循_sdk_四字节对齐() {
    assert_eq!(std::mem::align_of::<EDITSTREAM>(), 4);
    assert_eq!(
        std::mem::offset_of!(EDITSTREAM, callback),
        std::mem::size_of::<usize>() + 4
    );
    assert_eq!(
        std::mem::size_of::<EDITSTREAM>(),
        2 * std::mem::size_of::<usize>() + 4
    );
    assert_eq!(
        std::mem::offset_of!(ENLINK, w_param),
        std::mem::size_of::<Nmhdr>() + 4
    );
}

#[test]
fn rtf_流式装载不回借聊天布局状态() {
    unsafe {
        assert_ne!(LoadLibraryW(wide("Msftedit.dll").as_ptr()), 0);
        let control = CreateWindowExW(
            0,
            wide("RICHEDIT50W").as_ptr(),
            wide("").as_ptr(),
            WS_POPUP | ES_MULTILINE as u32,
            0,
            0,
            320,
            100,
            0,
            0,
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        assert_ne!(control, 0, "必须真实建立 RichEdit 来验证同步流式回调");
        let expected = "正文：hello 中文";
        let rtf = format!("{{\\rtf1\\ansi {}}}", rtf_escape(expected));
        CHAT.with(|cell| {
            let _rebuild_borrow = cell.borrow_mut();
            stream_rtf(control, &rtf);
            assert_eq!(read_window_text(control), expected);
            assert_eq!(SendMessageW(control, EM_GETLINECOUNT, 0, 0), 1);
            SetWindowTextW(control, wide("first\r\nsecond").as_ptr());
            assert_eq!(SendMessageW(control, EM_GETLINECOUNT, 0, 0), 2);
        });
        DestroyWindow(control);
    }
}

#[test]
fn rtf_回调分段推进到真正的文件末尾() {
    let bytes = b"12345";
    let mut source = RtfStream { bytes, position: 0 };
    let cookie = &mut source as *mut RtfStream<'_> as usize;
    let mut buffer = [0u8; 3];
    let mut written = -1;
    unsafe {
        assert_eq!(
            rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
            0
        );
        assert_eq!(written, 3);
        assert_eq!(&buffer, b"123");
        assert_eq!(
            rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
            0
        );
        assert_eq!(written, 2);
        assert_eq!(&buffer[..2], b"45");
        assert_eq!(
            rtf_stream_callback(cookie, buffer.as_mut_ptr(), 3, &mut written),
            0
        );
        assert_eq!(written, 0);
    }
}

/// 拆分后的生产源码（`tests.rs` 以外各子文件拼接；源码级守门断言都在这段上做，
/// 否则会命中测试自己的字面量 —— 那种断言永远为真、等于没写）。
fn production_source() -> &'static str {
    crate::ui::platform::test_sources::windows_chat()
}

/// 从源码里截出某个函数的函数体（大括号配对；守门断言用）。
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

/// 浮层盒：底边锚定、左右留边、高度按内容且有上限。
#[test]
fn 浮层盒_底边锚定且高度封顶() {
    let panel_box = overlay_box_rect(400, 500, 120, 9, 9);
    assert_eq!(panel_box, paint_win::Rect::new(9, 500 - 9 - 120, 382, 120));
    let capped = overlay_box_rect(400, 300, 500, 9, 9);
    assert_eq!(capped.h, 300 - 18);
    assert_eq!(capped.bottom(), 300 - 9);
    let tiny = overlay_box_rect(10, 10, 999, 9, 9);
    assert!(tiny.w >= 1 && tiny.h >= 1, "退化尺寸不得产生负宽高");
}

/// 「点浮层外关闭」的命中判定：盒内（含空白）不关，盒外关；右/下开区间。
#[test]
fn 浮层点击_盒内不关盒外关() {
    let panel_box = paint_win::Rect::new(9, 100, 200, 150);
    assert!(rect_contains(panel_box, 9, 100));
    assert!(rect_contains(panel_box, 208, 249));
    assert!(!rect_contains(panel_box, 208, 250));
    assert!(!rect_contains(panel_box, 8, 150));
    assert!(!rect_contains(panel_box, 100, 250));
}

/// 遮罩按主题明暗分档（深色近黑 / 浅色近白），且与面板底实色合成后可见。
#[test]
fn 遮罩色随主题明暗分档且与面板底可辨() {
    for id in ThemeId::ALL {
        let t = id.tokens();
        let scrim = scrim_color(t);
        assert!(
            scrim.a > 0.3 && scrim.a < 0.7,
            "{id:?} 遮罩透明度越界: {}",
            scrim.a
        );
        if t.dark {
            assert!(
                scrim.r <= 0.05 && scrim.g <= 0.05 && scrim.b <= 0.1,
                "{id:?} 深色遮罩应近黑"
            );
        } else {
            assert!(
                scrim.r >= 0.9 && scrim.g >= 0.9 && scrim.b >= 0.9,
                "{id:?} 浅色遮罩应近白"
            );
        }
        let flat = scrim_flat(t);
        let panel = t.panel_bg.base_color();
        let delta =
            (flat.r - panel.r).abs() + (flat.g - panel.g).abs() + (flat.b - panel.b).abs();
        assert!(
            delta > 0.03,
            "{id:?} 遮罩合成后与面板底太接近（Δ={delta:.3}）"
        );
    }
}

/// 圆角三档来自 token（chip 用 `sm`、浮层盒用 `md`；0 会让圆角静默失效）。
#[test]
fn 圆角三档来自_token() {
    for id in ThemeId::ALL {
        let t = id.tokens();
        assert!(
            t.radii.sm > 0.0 && t.radii.md > 0.0 && t.radii.btn > 0.0,
            "{id:?} 圆角未填"
        );
    }
}

/// 面板分区：**全部决策面**（计划/恢复计划/权限/中断/队列）与 Transient（slash）
/// 永远在流内 —— 权限弹窗等必须始终可见，不许被悬浮层抢走；**三块 Inspector
/// （用量/调试/投递）全进同一个浮层**（顺序 = 声明序，不再区分「打开的是哪一块」）；
/// **会话历史进锚定弹层、不进流内面板栈**（挂在栈里会跑到页面底部）。
#[test]
fn 面板分区_流内与浮层各归其位() {
    let decisions = [
        PanelKind::Plan,
        PanelKind::RecoveredPlan,
        PanelKind::Permission,
        PanelKind::Interrupted,
        PanelKind::Queue,
    ];
    let mut views: Vec<PanelView> = decisions.iter().map(|k| PanelView::new(*k)).collect();
    views.push(PanelView::new(PanelKind::SlashCandidates));
    views.push(PanelView::new(PanelKind::SessionHistory));
    views.push(PanelView::new(PanelKind::Usage));
    views.push(PanelView::new(PanelKind::DebugBar));
    views.push(PanelView::new(PanelKind::Delivery));

    let groups = partition_panels(&views);
    // 决策面全部在流内（含权限 —— 静态核对结论就钉在这条断言上）。
    for kind in decisions {
        assert!(
            groups.flow.iter().any(|v| v.kind == kind),
            "{kind:?} 必须留在流内（必须可见的决策面）"
        );
    }
    assert_eq!(groups.flow.len(), 6); // 5 决策 + slash
    assert!(groups
        .flow
        .iter()
        .all(|v| !matches!(v.kind.surface(), PanelSurface::Inspector)));
    // 三块 Inspector 全进浮层，且保序（用量 → 调试 → 投递 = 声明序）。
    assert_eq!(groups.overlay.len(), 3);
    let overlay_kinds: Vec<PanelKind> = groups.overlay.iter().map(|v| v.kind).collect();
    assert_eq!(
        overlay_kinds,
        vec![PanelKind::Usage, PanelKind::DebugBar, PanelKind::Delivery]
    );
    assert_eq!(groups.anchored.len(), 1);
    assert_eq!(groups.anchored[0].kind, PanelKind::SessionHistory);
}

/// 把手箭头：朝向随浮层开合翻面（收着 = 上拉 ▴、开着 = 可往下收 ▾）。
/// 两平台都用字形；Windows 的符号字体与正文字体独立，朝向随模型翻转。
#[test]
fn 把手箭头_朝向随开合翻面() {
    assert!(handle_arrow_up(false), "浮层收着 = 上拉 ▴");
    assert!(!handle_arrow_up(true), "浮层开着 = 可往下收 ▾");
}

/// 把手箭头字形框由**共享** `handle_arrow_frame` 给出：水平+垂直居中
/// （用户规则「上拉栏的箭头居中」）；绘制端在框内画字形，命中区是整条带。
#[test]
fn 把手箭头_共享字形框居中() {
    for logical_width in [200.0, 360.0, 460.0, 800.0] {
        let glyph = handle_arrow_frame(logical_width);
        // 共享几何第二版：字形**水平+垂直都居中**（用户规则「上拉栏的箭头居中」）。
        assert!(
            (glyph.x + glyph.width / 2.0 - logical_width / 2.0).abs() <= 0.5,
            "宽 {logical_width}: 共享字形必须居中"
        );
        assert!(
            (glyph.y + glyph.height / 2.0 - crate::ui::chat::panels::HANDLE_HEIGHT / 2.0).abs()
                <= 0.5,
            "字形在带内垂直居中"
        );
        assert!(glyph.x >= 0.0, "字形不许滚出左缘");
    }
    // 状态文字只占**左半侧**（箭头居中后中间那段让给箭头）；窄窗可压到 0。
    let left = crate::ui::chat::panels::handle_status_width(460.0);
    assert!(left < 230.0, "状态文字不许压过中线（实得 {left}）");
    assert_eq!(crate::ui::chat::panels::handle_status_width(10.0), 0.0);
}

/// 用户规则（2026-10-05）：**过程状态文案只在顶栏显示** —— 把手带文案只取
/// 中性通知 `notice`，空通知 = 空串；`text`（阶段/工具文案）不得漏到底部
/// （旧实现的 `or(text)` 兜底是这条规则的反例）。
#[test]
fn 把手带状态文案只取通知() {
    let mut status = StatusSnapshot {
        text: Some("正在调用工具".into()),
        ..StatusSnapshot::default()
    };
    assert_eq!(
        handle_status_label(&status),
        "",
        "过程文案（text）不得漏到把手带"
    );
    status.notice = Some("已发送".into());
    assert_eq!(handle_status_label(&status), "已发送");
    assert!(
        !handle_status_label(&status).contains("工具"),
        "通知与过程文案不得拼接"
    );
    status.notice = None;
    assert_eq!(handle_status_label(&status), "", "空通知 = 空串");
}

/// 圆点与文字同生共死（与 macOS `update_status` 的 `dot.setHidden(text.is_empty())`
/// 同口径，不 trim）。
#[test]
fn 圆点与文字同生共死() {
    assert!(!handle_status_dot_visible(""));
    assert!(handle_status_dot_visible("已发送"));
}

/// 把手带文案不再落过程文案 —— 源码级守门（防止 `update_status` 退回
/// `status.text` 兜底；文案口径必须收口到纯函数，圆点可见性变化必须补重绘）。
#[test]
fn 把手带文案不落过程文案_源码守门() {
    let production = production_source();
    let body = function_body(production, "fn update_status").expect("update_status 必须存在");
    assert!(
        !body.contains("status.text") && !body.contains("or_else"),
        "update_status 不得回落过程文案（status.text）：把手带只显示 notice"
    );
    assert!(
        body.contains("handle_status_label"),
        "把手带文案口径必须经纯函数 handle_status_label"
    );
    assert!(
        body.contains("handle_status_dot_visible") && body.contains("InvalidateRect"),
        "圆点可见性变化必须补把手带重绘（圆点画在聊天窗底上）"
    );
}

/// 把手带**整条可点**（2026-10-05 第三波）：聊天窗必须接住带内空白处的按下
/// 并开合浮层；带上的状态文字与箭头都是**单面绘制**（没有会咬掉命中的子控件，
/// 也没有会在同一次点击里开完又关的第二条通道）。
#[test]
fn 把手带整条可点_源码守门() {
    let production = production_source();
    let wndproc = function_body(production, "unsafe extern \"system\" fn chat_wndproc")
        .expect("chat_wndproc 必须存在");
    assert!(
        wndproc.contains("WM_LBUTTONDOWN")
            && wndproc.contains("toggle_inspector_ui")
            && wndproc.contains("state.paint.handle"),
        "聊天窗必须按把手带矩形接住按下并开合浮层"
    );
    assert!(
        !production.contains("BTN_HANDLE_ID"),
        "把手带不许再挂子按钮（一次点击进两条开合通道 = 开完又关）"
    );
    assert!(
        production.contains("paint.handle_arrow") && production.contains("wide(glyph)")
            && production.contains("Segoe UI Symbol"),
        "上拉箭头必须由聊天窗单面绘制（符号字体 + 共享字形框）"
    );
}

/// 浮层四角净化（对治「弹层左上角矩形残影」）：圆角盒绘制后必须按
/// 「方角 − 圆角」差集把缺口刷回遮罩色 —— 不赌 `GradientFill`/`AlphaBlend`
/// 对 DC 圆角裁剪区的遵守（本机无 Windows 工具链的实机核验点）。
#[test]
fn 浮层四角净化_源码守门() {
    let production = production_source();
    let body = function_body(production, "unsafe fn paint_inspector_box")
        .expect("paint_inspector_box 必须存在");
    assert!(
        body.contains("corner_notch_over_scrim"),
        "圆角盒绘制后必须补四角净化（方角不得从圆弧外侧露出）"
    );
    let notch = function_body(production, "unsafe fn corner_notch_over_scrim")
        .expect("corner_notch_over_scrim 必须存在");
    assert!(
        notch.contains("CombineRgn") && notch.contains("RGN_DIFF") && notch.contains("FillRgn"),
        "净化必须走「方角 − 圆角」差集填充"
    );
    assert!(
        notch.contains("scrim_flat"),
        "缺口必须刷回遮罩色（与盒外同色）"
    );
}

/// 底部锚定条区几何（2026-10-05 第二次改版）：**输入行贴底**、把手带在其上，
/// 待发送条/面板依次向上让位。
///
/// 2026-10-07 与 mac `chat_bands` 逐档对齐后的正文下沿：**无插入带时贴把手带
/// 上沿**（旧口径留一个 `PANE_GAP`，实机就是上拉条上方多一截空档，用户实拍）；
/// 有待发送条时贴条的上沿；有流内面板时面板上方留一个 `PANE_GAP`。
#[test]
fn 底部条区几何_输入贴底_把手带在其上() {
    let gap = 8;
    let stack = bottom_stack(640, 56, 22, 0, 0, gap);
    assert_eq!(stack.input_y, 584, "输入行贴客户区底");
    assert_eq!(stack.handle_y, 562);
    assert_eq!(stack.handle_y + 22, stack.input_y, "把手带紧贴输入行上方");
    assert_eq!(
        stack.canvas_bottom, 562,
        "无插入带时正文下沿贴把手带上沿（不再留 PANE_GAP，与 mac chat_bands 同档）"
    );

    let with_pending = bottom_stack(640, 56, 22, 30, 0, gap);
    assert_eq!(with_pending.pending_y, 524);
    assert_eq!(with_pending.panel_bottom, 516);
    assert_eq!(
        with_pending.canvas_bottom, 524,
        "有待发送条时正文下沿贴条的上沿（条在 composer 面里，不另留缝）"
    );

    let with_panel = bottom_stack(640, 56, 22, 0, 60, gap);
    assert_eq!(with_panel.panel_bottom, 554);
    assert_eq!(with_panel.panel_top, 494);
    assert_eq!(with_panel.canvas_bottom, 486);
}

/// 会话历史弹层几何：右缘对齐锚点、顶边贴层顶下 gap、整体夹在窗口内
/// （「滚出窗口时要夹住」）。纯函数，先红后绿的镜像验证见交付报告。
#[test]
fn 历史弹层几何_右对齐并夹在窗口内() {
    // 常规：右缘对齐「历史」按钮右缘（anchor 380）、宽 300 → x = 80；顶边 = gap。
    let panel_box = history_popover_rect(400, 500, 380, 300, 120, 4);
    assert_eq!(panel_box, paint_win::Rect::new(80, 4, 300, 120));
    // 锚点太靠左：x 夹到 0（不许滚出左缘）。
    assert_eq!(history_popover_rect(400, 500, 50, 300, 120, 4).x, 0);
    // 内容宽超过窗口：裁到窗口宽、x = 0。
    let wide = history_popover_rect(400, 500, 380, 500, 120, 4);
    assert_eq!((wide.x, wide.w), (0, 400));
    // 内容高超过层高：底边夹进层内（h = 层高 − gap）。
    let tall = history_popover_rect(400, 500, 380, 300, 999, 4);
    assert_eq!((tall.y, tall.h), (4, 496));
    assert!(tall.bottom() <= 500);
    // 退化尺寸不 panic、不出负值。
    let tiny = history_popover_rect(0, 0, 0, 0, 0, 0);
    assert!(tiny.w >= 1 && tiny.h >= 1);
}

/// 「↓ 新消息」的底部判据：贴底（容差内）才算在底部 —— 未读只在「不在底部」
/// 才可能保留（按钮不再因「只是上翻历史」而出现）。
#[test]
fn 底部容差_贴底才算在底部() {
    assert!(!scroll_at_bottom(0, 400, 1000));
    assert!(!scroll_at_bottom(500, 400, 1000));
    assert!(scroll_at_bottom(576, 400, 1000));
    assert!(scroll_at_bottom(600, 400, 1000));
    // 内容不足一屏：任何位置都算在底部（不产生未读）。
    assert!(scroll_at_bottom(0, 400, 300));
}

/// 旧顶栏（被全窗宽顶栏覆盖的聊天列副本）已删除：控件、命中转发、文本刷新
/// 路径与条内几何算式都不得回潮；顶部 26px 带仍按共享条高预留（标签条接在
/// 全窗宽顶栏下方）。断言词拆开拼接，避免测试文本自己命中扫描。
/// 与 macOS `macos_chat.rs` 的同名守卫对称 —— 本文件在 macOS 上不参与编译，
/// 由 CI 的 windows job 执行（本机只做离线核对，见模块头）。
#[test]
fn 聊天列不再自建顶栏() {
    let production = production_source();
    for (name, needle) in [
        ("状态位控件常量", concat!("const TITLEBAR", "_STATUS_ID")),
        ("顶栏关闭按钮常量", concat!("const BTN_HIDE", "_ID")),
        ("品牌槽宽算式", concat!("fn titlebar_brand", "_width")),
        ("状态位起点算式", concat!("fn titlebar_status", "_x")),
        ("品牌文案常量", concat!("const TITLEBAR", "_BRAND_TEXT")),
        ("顶栏文本刷新副本", concat!("fn apply_titlebar", "_text")),
        ("顶栏命中转发", concat!("pane_titlebar", "_screen_hit")),
    ] {
        assert_eq!(
            production.matches(needle).count(),
            0,
            "旧顶栏实现残留「{name}」：{needle}"
        );
    }
    assert!(
        production.contains(concat!("crate::ui::titlebar::", "HEIGHT")),
        "顶部预留与标签条必须消费共享条高（顶部带归全窗宽顶栏）"
    );
}

/// 输入行弹性（2026-10-05 用户规则；与 macOS `input_row_columns` 同口径）：
/// 按钮占固定宽、不随行宽变；输入框吃剩余宽度，**任何行宽下都不低于下限**
/// （旧下限 40 会把输入框压成一条缝）；窄行允许输入框与按钮列重叠（保内容可用）。
#[test]
fn 输入行弹性_输入框吃剩余且保底() {
    // 宽行（460）：输入框拿剩余，按钮贴右缘。
    let wide = input_row_columns(460, 1.0);
    assert_eq!(
        wide.primary_x,
        460 - BOTTOM_RIGHT_MARGIN - SEND_BUTTON_WIDTH.max(STOP_BUTTON_WIDTH)
    );
    assert_eq!(
        wide.pick_x,
        wide.primary_x - BOTTOM_BUTTON_GAP - PICK_BUTTON_WIDTH
    );
    assert_eq!(
        wide.field_width,
        wide.pick_x - INPUT_BUTTON_MARGIN - SIDE_MARGIN,
        "输入框 = 行宽 − 按钮列 − 间距（弹性）"
    );
    // 主聊天列最小宽 120pt（windows_main::CHAT_MIN_WIDTH，scale=1 即物理宽）：
    // 旧常量在这里只能给 ≈40 的输入框；现在按钮收窄 + 保底 72。
    for width in [120, 160, 265, 360] {
        let cols = input_row_columns(width, 1.0);
        assert!(
            cols.field_width >= INPUT_FIELD_MIN_WIDTH,
            "宽 {width}：输入框 {} 低于下限 {INPUT_FIELD_MIN_WIDTH}",
            cols.field_width
        );
        assert!(cols.primary_x >= 0 && cols.pick_x >= 0, "不许出负坐标");
    }
    // 按钮宽度都是常量：换行宽不改变按钮尺寸（只挪位置）。
    let narrow = input_row_columns(160, 1.0);
    assert_eq!(
        wide.primary_x - wide.pick_x,
        narrow.primary_x - narrow.pick_x
    );
    // DPI 2 倍：下限与按钮一起同比放大（不靠魔法数）。
    let hidpi = input_row_columns(530, 2.0);
    assert!(hidpi.field_width >= INPUT_FIELD_MIN_WIDTH * 2);
}

/// 待发送条几何自洽（改常量时先红）：chip 在条内上下各留 4px 内边距
/// （设计稿 `.pend` 的 5px 口径取 4）。
#[test]
fn 待发送条上下内边距() {
    assert_eq!(
        PENDING_HEIGHT - PENDING_CHIP_HEIGHT,
        8,
        "待发送条上下各留 4px 内边距"
    );
}

/// 验收硬指标「悬浮层开合前后消息流 y 不变」的源码级守门：
/// 条区几何（`layout_panes_for`）不得读取任何悬浮层状态；浮层与历史弹层只分别由
/// `layout_inspector_layer` / `layout_history_layer` 单向跟随画布矩形。
/// 改坏这条会在 CI 直接红。
#[test]
fn 浮层不参与布局流_源码守门() {
    let production = production_source();
    let body = function_body(production, "unsafe fn layout_panes_for")
        .expect("layout_panes_for 必须存在");
    assert!(
        !body.contains("state.inspector")
            && !body.contains("inspector_open")
            && !body.contains("state.history"),
        "layout_panes_for 读取了悬浮层状态：开合会牵动消息流 y（违反验收硬指标）"
    );
    // 反向护栏：两层窗口的摆放确实还在布局里（单向跟随画布矩形）。
    assert!(
        body.contains("layout_inspector_layer(state")
            && body.contains("layout_history_layer(state"),
        "悬浮层的摆放必须由 layout_panes_for 单向驱动"
    );
}

/// 浮层内容可视高：盒高扣掉标题行与底部内边距，下限 1（盒被夹小后不为负/零）。
#[test]
fn 浮层内容可视高按盒几何收口() {
    let scale = 1.0;
    let panel = paint_win::Rect::new(9, 100, 382, 30 + 10 + 200);
    assert_eq!(inspector_body_view_height(panel, scale), 200);
    // 盒比头+底内边距还矮：下限 1（不产生 0/负的可视高）。
    let tiny = paint_win::Rect::new(9, 100, 382, 20);
    assert_eq!(inspector_body_view_height(tiny, scale), 1);
    // DPI 2：两条内边距随比例放大（不是魔法数）。
    let hidpi = paint_win::Rect::new(9, 100, 764, (30 + 10 + 200) * 2);
    assert_eq!(inspector_body_view_height(hidpi, 2.0), 400);
}

/// 抽屉内部滚动（2026-10-06）的源码级守门：内容子控件必须挂在滚动裁剪窗上、
/// 抽屉内容必须**全量摆放**（不按上限跳过块）、滚动落地必须收口到唯一函数
/// （钳制 + 子控件平移 + 滚动条信息）、聊天窗滚轮分派必须接上「光标在哪滚哪」。
/// 改坏任一条会在 CI 直接红。**未在 Windows 实机验证**（本机只做离线核对）。
#[test]
fn 浮层内部滚动接线_源码守门() {
    let production = production_source();
    assert!(
        production.contains("INSPECTOR_SCROLL_CLASS"),
        "滚动裁剪窗的窗口类缺失（注册与创建都要有）"
    );
    let rebuild =
        function_body(production, "unsafe fn rebuild_panels").expect("rebuild_panels 必须存在");
    assert!(
        rebuild.contains("f64::INFINITY"),
        "抽屉内容必须全量摆放（不设高度上限；按上限摆放会静默丢块）"
    );
    assert!(
        rebuild.contains("panel_scroll_geometry("),
        "重建必须按共享滚动几何取可视高（与 macOS 同口径）"
    );
    let place = function_body(production, "unsafe fn place_panel_elements")
        .expect("place_panel_elements 必须存在");
    assert!(
        place.contains("state.inspector_scroll"),
        "面板元素必须挂到滚动裁剪窗（挂在浮层窗口上会缺裁剪边界）"
    );
    let layout = function_body(production, "unsafe fn layout_inspector_layer")
        .expect("layout_inspector_layer 必须存在");
    assert!(
        layout.contains("apply_inspector_scroll("),
        "滚动落地必须收口到 apply_inspector_scroll（钳制/平移/滚动条唯一实现点）"
    );
    let wheel = function_body(production, "unsafe extern \"system\" fn chat_wndproc")
        .expect("chat_wndproc 必须存在");
    assert!(
        wheel.contains("scroll_inspector_from_wheel("),
        "聊天窗滚轮分派必须接上浮层滚动（否则焦点在输入区时光标在抽屉上滚不动）"
    );
}

/// 正文滚轮增量必须读 **wParam 高字**（低字是按键标志；lParam 高字是光标屏幕
/// y 坐标 —— 读错会让步长随窗口在屏幕上的位置漂移）。2026-10-06 修正
/// `chat_wndproc` 与 `canvas_wndproc` 两处后立的源码守门：改回 lParam 口径
/// CI（Windows）直接红。**未在 Windows 实机验证**（本机只做离线核对）。
#[test]
fn 正文滚轮增量读wparam高字_源码守门() {
    let production = production_source();
    for signature in [
        "unsafe extern \"system\" fn chat_wndproc",
        "unsafe extern \"system\" fn canvas_wndproc",
    ] {
        let body = function_body(production, signature).expect("窗口过程必须存在");
        assert!(
            body.contains("((wparam >> 16) & 0xFFFF) as u16 as i16"),
            "{signature} 的滚轮增量没读 wParam 高字（lParam 高字是屏幕坐标，会让步长随窗口屏幕位置漂移）"
        );
    }
    assert!(
        !production.contains("delta = ((lparam >> 16)"),
        "滚轮增量不得读 lParam 高字（那是光标屏幕坐标，不是轮增量）"
    );
}

/// 编辑类控件配色（2026-10-06）：`PanelElement::Select` 的系统 COMBOBOX 与
/// 可编辑框的 `WM_CTLCOLOREDIT` / `WM_CTLCOLORLISTBOX` 由**控件父窗**消费
/// （组合框的展开清单也由承载它的父窗接）—— 三个承载容器（聊天窗 / 浮层滚动
/// 裁剪窗 / 层窗）缺一处，那一组的下拉与输入框就回落系统经典外观。配色统一
/// 转给 `windows_settings::edit_ctlcolor`（唯一实现点，本文件不得另开第二份）。
/// **未在 Windows 实机验证**（本机只做离线核对，见模块头）。
#[test]
fn 编辑类控件配色三父窗都接_源码守门() {
    let production = production_source();
    for signature in [
        "unsafe extern \"system\" fn chat_wndproc",
        "unsafe extern \"system\" fn inspector_scroll_wndproc",
        "unsafe extern \"system\" fn overlay_layer_wndproc",
    ] {
        let body = function_body(production, signature).expect("窗口过程必须存在");
        assert!(
            body.contains("WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX =>"),
            "{signature} 缺编辑类控件 CTLCOLOR 臂（对应容器里的下拉/输入框会回落系统外观）"
        );
        assert!(
            body.contains("super::windows_settings::edit_ctlcolor(wparam, lparam)"),
            "{signature} 必须把编辑类控件配色转给唯一实现点（windows_settings::edit_ctlcolor）"
        );
    }
    assert!(
        !production.contains("SetBkColor"),
        "编辑类控件配色不得在本文件另开第二份实现（SetBkColor 是 edit_ctlcolor 的私有细节）"
    );
}

/// 面板动作派发必须走 [`dispatch_panel_action`]（派发 + 立即整帧重建）——
/// 「投递在下拉里选完之后显示不刷新」的根因是当时的本地动作没有 bump 版本号、
/// 刷新被版本比对丢掉；修法是平台派发后无条件重建。这条守门防止某条分派路径
/// 退回「只派发不重建」。
#[test]
fn 面板动作派发都走立即重建() {
    let production = production_source();
    let helper = function_body(production, "unsafe fn dispatch_panel_action")
        .expect("dispatch_panel_action 必须存在");
    assert!(helper.contains("apply_panel_action"), "助手必须派发动作");
    assert!(
        helper.contains("chat_apply(ChatRenderUpdate::Full"),
        "助手必须立即整帧重建（否则版本比对会把刷新丢掉）"
    );
    // 裸派发只允许出现在助手自身那一处；分派臂一律走助手。
    assert_eq!(
        production
            .matches("handle_panel_outcome(crate::ui::chat::apply_panel_action")
            .count(),
        1,
        "面板动作不许绕过 dispatch_panel_action（会丢「选完不刷新」的修复）"
    );
    assert!(
        production.matches("dispatch_panel_action(").count() >= 4,
        "三个分派点（面板按钮 / 面板下拉 / 历史按钮）都该走助手"
    );
}

/// 第二版改版的删净守门：底部那排 chip / 轨段 / 原生投递菜单的**符号一个都不许
/// 留在生产代码里**（共享层已物理删除这些类型；留下会编译不过或有 unused 告警）。
/// 断言在 production 段上做（测试自己的字面量不算）。
///
/// 变更记录（2026-10-05 图片通路批收尾）：禁用表**移除**了 `TrackPopupMenu` /
/// `CreatePopupMenu` —— 二者不再是旧轨菜单的专属符号：消息右键菜单（「记住这条」
/// 的第二形态）按计划使用同一组菜单 API。禁的是**旧轨**（`RAIL_*`、
/// `open_rail_menu`、`MenuTarget` 等）而不是菜单 API 本身；菜单 API 的新用法由
/// 下一条「消息右键菜单接线_源码守门」正向钉住（旧轨的删净部分一条未放宽）。
#[test]
fn 旧轨与菜单代码已删净_源码守门() {
    let production = production_source();
    for needle in [
        "RAIL_BASE",
        "RAIL_END",
        "RAIL_METRICS",
        "rail_children",
        "rail_targets",
        "rail_status_width",
        "rebuild_rail",
        "rail_target_index",
        "rail_chip_role",
        "open_rail_menu",
        "menu_item_id",
        "menu_index_for_command",
        "rail_entries_from",
        "delivery_label_rail",
        "RailTarget",
        "InspectorPane",
        "MenuTarget",
        "layout_rail",
        "尚未接线",
    ] {
        assert!(
            !production.contains(needle),
            "生产代码里还留着已删符号：{needle}"
        );
    }
    // 把手带是浮层唯一入口（单面绘制）：必须保留带区按下段与共享箭头几何。
    assert!(
        production.contains("rect_contains(win_rect_of(&state.paint.handle)")
            && production.contains("handle_arrow_frame"),
        "把手开合必须接线（带区命中 + 共享 handle_arrow_frame）"
    );
    // 浮层开合直接吃快照（平台不维护镜像）。
    let rebuild =
        function_body(production, "unsafe fn rebuild_panels").expect("rebuild_panels 必须存在");
    assert!(
        rebuild.contains("snapshot.inspector_open"),
        "浮层显隐必须吃快照的 inspector_open"
    );
}

/// 「记住这条」右键菜单接线守门（第二形态：气泡按钮退场后入口由消息右键承接）。
/// Windows 形态 = 消息 RichEdit 挂子类接管 `WM_CONTEXTMENU` + 自建弹出菜单 +
/// 经唯一出口 `dispatch_panel_action` 派发；文案必须引用共享常量
/// `REMEMBER_MENU_ITEM_LABEL`（平台文件不许硬编码字面量）；事件身份表与消息菜单
/// 目标表必须在 `release_canvas` 里一并清理，且 `rebuild_canvas` 必须经它
/// （旧控件句柄不得留影成死菜单）。
#[test]
fn 消息右键菜单接线_源码守门() {
    let production = production_source();
    for needle in [
        "WM_CONTEXTMENU",
        "message_menu_subclass_proc",
        "SetWindowSubclass(control, Some(message_menu_subclass_proc), 3, 0)",
        "CreatePopupMenu",
        "AppendMenuW",
        "TrackPopupMenu",
        "TPM_RETURNCMD",
        "PanelAction::RememberMessage",
    ] {
        assert!(
            production.contains(needle),
            "消息右键菜单接线缺失：{needle}"
        );
    }
    assert!(
        production.contains("wide(REMEMBER_MENU_ITEM_LABEL)"),
        "菜单项文案必须来自共享常量 REMEMBER_MENU_ITEM_LABEL（唯一来源）"
    );
    assert!(
        !production.contains("\"记住这条\""),
        "平台文件不许硬编码「记住这条」字符串字面量（唯一来源见共享常量）"
    );
    // 两张表在 `release_canvas` 里一并清（`message_menu_targets` 紧挨 `links`）：
    // 释放路径只有这一条 —— 重建走它、隐藏与关闭也走它，比「只在重建里清」覆盖更宽。
    // 所以这里钉的是**整条链**：rebuild → release_canvas → 两张表都清。
    let release =
        function_body(production, "unsafe fn release_canvas").expect("release_canvas 必须存在");
    assert!(
        release.contains("state.message_menu_targets.clear()"),
        "释放画布必须清掉消息菜单目标表（旧控件句柄不得留影成死菜单）"
    );
    assert!(
        release.contains("state.links.clear()"),
        "释放画布必须清掉事件身份表（与消息菜单目标表同批清）"
    );
    let rebuild =
        function_body(production, "unsafe fn rebuild_canvas").expect("rebuild_canvas 必须存在");
    assert!(
        rebuild.contains("release_canvas(state)"),
        "重建画布必须经 release_canvas，否则控件释放与两张表的清理会被绕过"
    );
    assert_eq!(
        production
            .matches("handle_panel_outcome(crate::ui::chat::apply_panel_action")
            .count(),
        1,
        "记忆动作不许绕过 dispatch_panel_action（出口必须唯一，见上一条守门）"
    );
}

/// 输入框粘贴图片接线守门（A3 图片通路第三条：选择器 / 拖入 / 粘贴）：
/// `WM_PASTE` 必须由**既有输入子类**接管（不挂第二个子类）、图片字节必须走共享
/// 入口 `add_pasted_image`（落盘/准入/路径都不在平台层）、剪贴板严格配对关闭。
/// 反向：平台文件不许出现托管目录常量（路径归 Rust 命令域）。
#[test]
fn 粘贴接线_源码守门() {
    let production = production_source();
    for needle in [
        "WM_PASTE",
        "OpenClipboard",
        "CloseClipboard",
        "GetClipboardData",
        "add_pasted_image",
        "bmp_container_from_dib",
    ] {
        assert!(production.contains(needle), "粘贴接线缺失：{needle}");
    }
    // CF_* 是本地定义（windows-sys 0.52 只在未启用的 System_Ole 面登记它们）：
    // 值逐条钉住，防止手滑改错格式号（错号 = 静默取不到数据）。
    for needle in [
        "const CF_BITMAP: u32 = 2",
        "const CF_DIB: u32 = 8",
        "const CF_HDROP: u32 = 15",
        "const CF_DIBV5: u32 = 17",
    ] {
        assert!(
            production.contains(needle),
            "剪贴板格式常量被改坏：{needle}"
        );
    }
    let input_proc = function_body(
        production,
        "unsafe extern \"system\" fn input_subclass_proc",
    )
    .expect("input_subclass_proc 必须存在");
    assert!(
        input_proc.contains("WM_PASTE"),
        "粘贴必须由既有输入子类接管（不挂第二个子类）"
    );
    assert_eq!(
        production
            .matches("SetWindowSubclass(input, Some(input_subclass_proc)")
            .count(),
        1,
        "输入控件不许挂第二个子类"
    );
    // 路径归 Rust 命令域：平台文件不出现托管目录常量。
    for needle in ["PASTED_DIR", "SCREENSHOT_DIR", "screenshots/"] {
        assert!(
            !production.contains(needle),
            "平台文件出现托管路径常量（路径归 Rust 命令域）：{needle}"
        );
    }
    assert!(
        !production.contains("\"记住这条\""),
        "平台文件不许硬编码菜单文案字面量（唯一来源 = 共享常量）"
    );
}

/// DIB → BMP 容器补头的偏移口径（纯逻辑，Windows CI 上跑）：`bfOffBits` =
/// 14 + `biSize` + 色表字节数；40 字节头 + `BI_BITFIELDS` 另加 3 个掩码 DWORD；
/// 头不合法必须拒绝（不拼一个解码必然失败的假文件去骗准入）。
#[test]
fn dib补BMP容器头的偏移() {
    // 造一个「头字段可摆、缓冲足够」的 DIB：长度 = 头 + 2 KiB 余量。
    fn dib(bit_count: u16, compression: u32, clr_used: u32, bi_size: u32) -> Vec<u8> {
        let mut data = vec![0u8; bi_size.max(40) as usize + 2048];
        data[0..4].copy_from_slice(&bi_size.to_le_bytes());
        data[14..16].copy_from_slice(&bit_count.to_le_bytes());
        data[16..20].copy_from_slice(&compression.to_le_bytes());
        data[32..36].copy_from_slice(&clr_used.to_le_bytes());
        data
    }
    let off = |b: &[u8]| u32::from_le_bytes([b[10], b[11], b[12], b[13]]) as usize;
    let size = |b: &[u8]| u32::from_le_bytes([b[2], b[3], b[4], b[5]]) as usize;

    let source = dib(24, 0, 0, 40);
    let bmp = bmp_container_from_dib(&source).unwrap();
    assert_eq!(off(&bmp), 14 + 40, "24bpp 无色表");
    assert_eq!(size(&bmp), 14 + source.len(), "bfSize = 14 + DIB 全长");
    assert_eq!(&bmp[..2], b"BM");
    assert_eq!(&bmp[14..], &source[..], "DIB 原样跟在 14 字节文件头后");

    // ≤8bpp：biClrUsed = 0 → 1<<bpp 项、每项 4 字节；非 0 用它。
    assert_eq!(
        off(&bmp_container_from_dib(&dib(8, 0, 0, 40)).unwrap()),
        14 + 40 + 1024
    );
    assert_eq!(
        off(&bmp_container_from_dib(&dib(8, 0, 16, 40)).unwrap()),
        14 + 40 + 64
    );
    // 40 字节头 + BI_BITFIELDS：掩码 3×DWORD 紧随头后（V4/V5 在头内，不再加）。
    assert_eq!(
        off(&bmp_container_from_dib(&dib(32, 3, 0, 40)).unwrap()),
        14 + 40 + 12
    );
    assert_eq!(
        off(&bmp_container_from_dib(&dib(32, 3, 0, 124)).unwrap()),
        14 + 124
    );
    // 头不合法：biSize < 40 或超出缓冲 → 拒绝。
    assert!(bmp_container_from_dib(&[]).is_none());
    assert!(bmp_container_from_dib(&[0, 0, 0, 0]).is_none());
    let full = dib(24, 0, 0, 40);
    let truncated = &full[..20];
    assert!(bmp_container_from_dib(truncated).is_none());
}

/// 正文估宽必须与 RTF 正文字号同源（2026-10-20 与 macOS「卡住」裁字同批核对）：
/// 正文走 20 半磅 = 10pt = 13.333px，估宽若按 13.0 会每字少 0.333px，
/// 接近泡宽上限时末字被 RichEdit 裁掉；字号插值也必须走同一常量。
#[test]
fn 正文估宽与RTF字号同源_源码守门() {
    let production = production_source();
    assert!(
        production.contains("prose_estimated_width(segment, RTF_BODY_LOGICAL_SIZE)"),
        "正文估宽必须用 RTF 正文字号常量"
    );
    assert!(
        production.contains("estimated_natural_width(&tail_text, RTF_BODY_LOGICAL_SIZE)"),
        "流式尾巴估宽同样要用 RTF 正文字号常量"
    );
    assert!(
        !production.contains("prose_estimated_width(segment, 13.0)"),
        "不得回落到写死的 13.0（与 RTF 10pt 不一致）"
    );
    assert!(
        production.contains(r"\\fs{}"),
        "RTF 正文字号必须走 RTF_BODY_HALF_POINTS 插值"
    );
    assert!(
        !production.contains("fs20"),
        "不得再写死 RTF 字号字面量（会与估宽常量分叉）"
    );
    // 卡片外框：RichEdit 每侧让出 2px 边框 + 泡内边距；共享泡宽只含 2px 总余量，
    // 平台侧必须补足 2px，否则控件正文区比估宽少 2px（末字会被裁）。
    assert!(
        production.contains("let border_extra = if card.is_some()"),
        "卡片泡宽必须补 RichEdit 边框让位的 2px"
    );
}
