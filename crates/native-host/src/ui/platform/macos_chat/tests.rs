use super::content::{panel_button_action_face, session_tab_pill_width};

/// 生产源码（不含测试模块）：源码级守门跨拆分后的全部文件扫描。
const SOURCES: [&str; 8] = [
    include_str!("mod.rs"),
    include_str!("window.rs"),
    include_str!("stack.rs"),
    include_str!("input.rs"),
    include_str!("content/mod.rs"),
    include_str!("content/view.rs"),
    include_str!("content/transcript.rs"),
    include_str!("content/panels.rs"),
];

fn source_text() -> String {
    SOURCES.concat()
}

use super::*;

// ── 会话历史锚定弹层（挂在「历史」按钮下方；脱离布局流）──

/// 锚点 = 「历史」按钮在宿主坐标里的 frame（示例：贴右、在顶部标签行里）。
fn history_anchor() -> crate::ui::chat::panels::PanelFrame {
    crate::ui::chat::panels::PanelFrame {
        x: 568.0,
        y: 330.0,
        width: 34.0,
        height: 18.0,
    }
}

#[test]
fn 历史弹层挂锚点下方且右对齐() {
    let anchor = history_anchor();
    let (x, y, w, h) = anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 200.0)
        .expect("有内容且空间足够时应能定位");
    // 右缘与锚点右缘对齐（再夹进宿主右边距）。
    let expected_x = (anchor.right() - w).min(616.0 - HISTORY_POPOVER_MARGIN - w);
    assert!(
        (x - expected_x).abs() < 0.01,
        "右对齐锚点：x={x} 期望 {expected_x}"
    );
    // 顶边在锚点下沿之下一个 gap。
    let top = y + h;
    assert!(
        (top - (anchor.y - HISTORY_POPOVER_GAP)).abs() < 0.01,
        "弹层顶边应贴锚点下沿：top={top}"
    );
    assert!((h - 200.0).abs() < 0.01);
    // 整体在宿主内。
    assert!(x >= HISTORY_POPOVER_MARGIN - 0.01);
    assert!(x + w <= 616.0 - HISTORY_POPOVER_MARGIN + 0.01);
    assert!(y >= HISTORY_POPOVER_MARGIN - 0.01);
}

#[test]
fn 历史弹层在窗口内被夹住() {
    // 窄聊天列：宽度收缩到宿主内（不越右缘）。
    let anchor = history_anchor();
    let (x, _y, w, _h) =
        anchored_popover_frame(266.0, anchor, HISTORY_POPOVER_WIDTH, 200.0).expect("仍能定位");
    assert!(
        w <= 266.0 - HISTORY_POPOVER_MARGIN * 2.0 + 0.01,
        "宽度夹进宿主"
    );
    assert!(x + w <= 266.0 - HISTORY_POPOVER_MARGIN + 0.01, "右缘夹住");
    assert!(x >= HISTORY_POPOVER_MARGIN - 0.01, "左缘夹住");
    // 内容过高：高度被夹到「锚点下沿到底边留白」，不被窗口底裁掉。
    let (.., h) =
        anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 10_000.0).expect("仍能定位");
    assert!(
        (h - (anchor.y - HISTORY_POPOVER_GAP - HISTORY_POPOVER_MARGIN)).abs() < 0.01,
        "高度夹到可用空间：h={h}"
    );
    // 没有内容 / 锚点下方没有空间：不产出 frame（保持隐藏）。
    assert!(anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 0.0).is_none());
    let low_anchor = crate::ui::chat::panels::PanelFrame {
        x: 0.0,
        y: 30.0,
        width: 34.0,
        height: 18.0,
    };
    assert!(anchored_popover_frame(616.0, low_anchor, HISTORY_POPOVER_WIDTH, 200.0).is_none());
}

// ── 把手带（2026-10-05 第二次改版：取代 meta 轨 chip 排）──

#[test]
fn 把手箭头朝向随开合状态() {
    // 合着 → ▴（可上拉）；开着 → ▾（可收起）。用户规则「上拉小箭头」。
    assert_eq!(handle_arrow_title(false), "▴");
    assert_eq!(handle_arrow_title(true), "▾");
}

#[test]
fn 把手带整条可点() {
    // 用户规则（2026-10-05）「上拉条整条可点」：把手带容器是专门的可点视图
    // （命中归整条 + pointing hand），箭头退化为视觉提示。AppKit 命中/光标在
    // 单测里走不到，这里用源码级护栏钉住三件必需件（本仓既有做法）。
    let source = source_text();
    assert!(
        source.contains("HandleBandView::new(mtm, width)"),
        "把手带容器必须是 HandleBandView（整条可点），不是普通堆叠容器"
    );
    assert!(
        source.contains("pointingHandCursor"),
        "把手带悬停要换 pointing hand（热区没有可见边界）"
    );
    assert!(
        source.contains("apply_inspector_change(PanelAction::ToggleInspector)"),
        "整条点击与箭头按钮必须同一出口（不另写第二份开合语义）"
    );
}

#[test]
fn 带类底色经band_span内缩到面板边框以内() {
    // 纯函数：左右各内缩一个描边宽；不足两个描边宽时退化为 0 宽（不给负值）。
    assert_eq!(band_span(400.0, 1.0), (1.0, 398.0));
    assert_eq!(band_span(265.0, 1.0), (1.0, 263.0));
    assert_eq!(band_span(1.0, 1.0), (1.0, 0.0));
    assert_eq!(band_span(0.0, 1.0), (0.0, 0.0));
    // 源码护栏（AppKit frame 单测走不到）：relayout 里把手带与输入区底条必须用
    // 同一口径的内缩 —— 填充铺到宿主外沿会染掉面板左右/下描边（实机：
    // 「上拉条底色超到边框之外」）。
    let source = source_text();
    let relayout_at = source
        .find("fn relayout_panes(")
        .expect("relayout_panes 必须存在");
    let relayout = &source[relayout_at..];
    let end = relayout.find("\n    fn ").unwrap_or(relayout.len());
    let body = &relayout[..end];
    assert!(
        body.contains("let (band_x, band_w) = band_span(width, PANEL_STROKE_WIDTH);"),
        "relayout 必须用 band_span 算带类左右边界"
    );
    assert!(
        body.contains("NSPoint::new(band_x, bands.handle_y)"),
        "把手带底色要内缩（x 用 band_x）"
    );
    assert!(
        body.contains("NSPoint::new(band_x, PANEL_STROKE_WIDTH)"),
        "输入区底条左右与下缘都要内缩（不压面板描边）"
    );
}

#[test]
fn 输入行输入框弹性且保底() {
    // 用户规则（2026-10-05）「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
    // 图片/停止/发送占固定宽，整行不压缩输入框到不可用」。
    // 真实聊天列宽（用户配置 ≈265–285pt）：三个按钮都亮时输入框必须 ≥ 下限，
    // 且不与「图片」按钮重叠（重叠 = 输入框被压到不可用）。
    for width in [265.0, 283.0] {
        let cols = input_row_columns(width, true);
        assert!(
            cols.field_width >= INPUT_FIELD_MIN_WIDTH,
            "宽度 {width}：输入框 {:.1} 低于下限 {INPUT_FIELD_MIN_WIDTH}",
            cols.field_width
        );
        assert!(
            INPUT_BUTTON_MARGIN + cols.field_width <= cols.pick_x + 0.01,
            "宽度 {width}：输入框右缘 {:.1} 侵入「图片」按钮 x={:.1}",
            INPUT_BUTTON_MARGIN + cols.field_width,
            cols.pick_x
        );
    }
    // 停止不显示（未运行）时输入框更宽；按钮宽度不随行宽变（固定宽）。
    let wide = input_row_columns(265.0, false);
    let narrow = input_row_columns(265.0, true);
    assert!(
        wide.field_width > narrow.field_width,
        "停止退场后输入框变宽"
    );
    assert!(wide.stop_x.is_none(), "未运行时不给停止按钮落位");
    assert!(narrow.stop_x.is_some(), "运行时停止按钮必须占位");
    assert_eq!(
        narrow.send_x - narrow.stop_x.unwrap(),
        STOP_BUTTON_WIDTH + BOTTOM_BUTTON_GAP,
        "按钮间距固定：停止与发送之间是一个按钮宽 + 一个 gap"
    );
    assert_eq!(
        narrow.stop_x.unwrap(),
        narrow.pick_x + PICK_BUTTON_WIDTH + BOTTOM_BUTTON_GAP,
        "停止按钮左缘 = 图片按钮右缘 + gap（同一列口径）"
    );
    // 极窄列：输入框保底不为负、按钮靠左夹到 0（退化场景，不为负数）。
    let tiny = input_row_columns(120.0, true);
    assert_eq!(tiny.field_width, INPUT_FIELD_MIN_WIDTH);
    assert!(tiny.pick_x >= 0.0 && tiny.send_x >= 0.0);
}

#[test]
fn 把手带状态文案只取通知() {
    // 用户裁定（2026-10-05）：过程状态文案（阶段/工具）只在顶栏显示，把手带
    // 只留 `notice`；`status.text` 一律不回落（旧实现 `.or(status.text)` 会漏到底）。
    // 与 Windows 侧同名测试同口径（两平台对称）。
    let mut status = StatusSnapshot {
        text: Some("试着用这个工具…".into()),
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
    // 源码守门：`update_status` 不得退回 `status.text` 兜底（口径必须收口到
    // 纯函数）—— 与 Windows 侧同款护栏。
    let source = source_text();
    let at = source
        .find("fn update_status(")
        .expect("update_status 必须存在");
    let rest = &source[at..];
    let end = rest.find("\n    fn ").unwrap_or(rest.len());
    let body = &rest[..end];
    assert!(
        !body.contains("status.text") && !body.contains("or_else"),
        "update_status 不得回落过程文案（status.text）：把手带只显示 notice"
    );
    assert!(
        body.contains("handle_status_label"),
        "把手带文案口径必须经纯函数 handle_status_label"
    );
}

#[test]
fn 权限按钮按动作分主次() {
    // 用户规则（2026-10-05）「三按钮层级分明：拒绝=普通、本次允许=主、
    // 会话内允许=次」：主次只认动作变体（不嗅标签文案）。
    assert_eq!(
        panel_button_action_face(&PanelAction::PermissionAllowOnce),
        Some(paint::Face::Primary),
        "本次允许 = 主按钮"
    );
    assert_eq!(
        panel_button_action_face(&PanelAction::PermissionDeny),
        Some(paint::Face::Normal),
        "拒绝 = 普通按钮"
    );
    assert_eq!(
        panel_button_action_face(&PanelAction::PermissionAllowSession),
        Some(paint::Face::Chip),
        "会话内允许 = 次（小圆角 chip）"
    );
    assert_eq!(
        panel_button_action_face(&PanelAction::ToggleUsage),
        None,
        "其它动作不特殊化（调用方给默认 chip）"
    );
}

#[test]
fn 面板chip贴皮落在落帧之后() {
    // 实机 bug（2026-10-05 用户截图：inspector 里「默认 ▾」chip 的底色只盖住一半）：
    // `buttonWithTitle` 先给出固有尺寸，贴皮若发生在 `setFrame` 之前，渐变/子层底
    // 按旧 bounds 建、之后不会跟着 frame 走。这里钉住顺序（AppKit 层单测走不到）。
    let source = source_text();
    let set_frame = source
        .find("control.setFrame(NSRect::new(")
        .expect("面板按钮必须先落帧");
    let face = source
        .find("apply_panel_button_face(&control, action, *link)")
        .expect("面板按钮必须贴皮");
    assert!(
        set_frame < face,
        "面板按钮的贴皮必须排在落帧之后（先贴后改帧 = 底色只盖一半）"
    );
}

#[test]
fn composer是一整块面且白边贴上沿() {
    // 用户规则（2026-10-05 第二次复验）「不要搞个条出来了」「这个白边应该贴着下面」：
    // 无待发送条/面板时 composer 铺到消息流下沿 —— 把手带与它上方 8pt 的 PANE_GAP
    // 都落进同一块面里，把手带不再自成一条灰条。
    let bands = chat_bands(600.0, 0.0, 0.0, 0.0);
    assert_eq!(
        composer_top_from_bands(0.0, 0.0, &bands),
        bands.scroll_y,
        "无插入带时 composer 铺到消息流下沿（把手带不另成一条）"
    );
    // 第三次复验（「调矮」）：composer 上沿 = 把手带上沿（78 = 56 + 22），
    // 白边就贴在带的上沿 —— 中间不再有 8pt 空铺面。
    assert_eq!(
        composer_top_from_bands(0.0, 0.0, &bands),
        INPUT_HEIGHT + HANDLE_HEIGHT,
        "composer 上沿 = 把手带上沿（无插入带时不再留 PANE_GAP 空档）"
    );
    assert_eq!(
        bands.handle_y, INPUT_HEIGHT,
        "把手带位置未动（用户「不是让你把上拉调高顶上去」）"
    );
    // 有待发送条：铺到它的上沿（`.pend` 在 composer 里，设计稿的包含关系）。
    let bands_pend = chat_bands(600.0, 32.0, 0.0, 0.0);
    assert_eq!(
        composer_top_from_bands(32.0, 0.0, &bands_pend),
        bands_pend.pending_y + 32.0
    );
    // 有流内面板：收回到把手带上沿（面板属消息流，PANE_GAP 留作分隔）。
    let bands_panel = chat_bands(600.0, 0.0, 100.0, 0.0);
    assert_eq!(
        composer_top_from_bands(0.0, 100.0, &bands_panel),
        bands_panel.handle_y + bands_panel.handle_h
    );
    // 源码护栏（AppKit 绘制单测走不到）：把手带不得再自带底/线（否则又是「多出来
    // 一条」）；composer 的上边线必须是白边 `bar_edge`（贴着它自己的上沿）。
    let source = source_text();
    // 拆开拼接：断言文本自己会命中源码扫描（本仓既有做法）。
    let band_veil = concat!("Fill::Solid(tokens.strip_bg),", " true)");
    assert!(
        !source.contains(band_veil),
        "把手带不得自带 strip_bg 底（用户：不要搞个条出来）"
    );
    let at = source
        .find("fn repaint_chrome(")
        .expect("repaint_chrome 必须存在");
    let rest = &source[at..];
    let end = rest.find("\n    fn ").unwrap_or(rest.len());
    assert!(
        rest[..end].contains("InsetLine::hard(tokens.bar_edge, 1.0)"),
        "composer 上沿要画白边 bar_edge（贴着它自己的上沿）"
    );
}

#[test]
fn 消息流上下软线按翻转图层落位() {
    // 实机（2026-10-05 第二次复验，brushed）：`--logsh` 是「上白（软）+ 下蓝灰（软）」
    // 两条线，实机却把白线画到滚动区**底部**（用户读到「标签栏下方一条横杠」）——
    // 滚动视图图层是翻转几何（正文容器 `isFlipped`），`apply_line` 的 `flipped`
    // 传 false 就会上下颠倒。护栏：口径收口到常量，别退回写死。
    assert!(SCROLL_LAYER_FLIPPED, "滚动视图图层是翻转几何");
    let source = source_text();
    let at = source
        .find("fn repaint_chrome(")
        .expect("repaint_chrome 必须存在");
    let rest = &source[at..];
    let end = rest.find("\n    fn ").unwrap_or(rest.len());
    assert!(
        rest[..end].contains("tokens.log_inset.as_ref(),"),
        "logsh 必须经 tokens 接线"
    );
    assert!(
        rest[..end].contains("SCROLL_LAYER_FLIPPED"),
        "logsh 的 apply_line 必须传 SCROLL_LAYER_FLIPPED（不写死 false）"
    );
}

#[test]
fn 面板chip按下有全幅压深反馈() {
    // 实机（设置窗同款问题，2026-10-05）：`paint::style_button` 关掉系统 bezel 后，
    // AppKit 对按下的唯一动作是 `NSContentsCellMask`（只压暗标题），按钮底纹不动 ——
    // 「按下没反应」。本文件的 chip 走 `PanelChipButton`：`highlight:` 里盖全幅压深罩。
    // AppKit 追踪在单测里走不到，这里源码级钉住三件必需件（本仓既有做法）。
    let source = source_text();
    assert!(
        source.contains("fn highlight("),
        "自绘 chip 必须覆写 highlight:（否则按下只有标题变暗）"
    );
    assert!(
        source.contains("chatpanelchip-pressed"),
        "按下罩必须带唯一子层名（幂等清理，不留卡住的压深）"
    );
    assert!(
        source.contains("PanelChipButton::new("),
        "面板按钮与下拉 chip 都必须走 PanelChipButton"
    );
    assert!(
        source.contains("super(self), highlight: flag"),
        "覆写后要交还超类（标题的压暗行为保持系统口径）"
    );
}

#[test]
fn 浮层贴皮被relayout守卫重贴() {
    // 实机 bug（2026-10-05 用户截图：「详情」标题左侧一团灰色矩形，部分主题才见）：
    // 浮层建视图时帧是初始值，打开后帧变大却没人重贴背板 —— 子层（立体线/渐变）
    // 留在旧帧上。修复 = relayout 末尾按浮层自身帧守卫补贴；护栏钉「真被调到」。
    let source = source_text();
    let relayout_at = source
        .find("fn relayout_panes(")
        .expect("relayout_panes 必须存在");
    let relayout = &source[relayout_at..];
    let end = relayout.find("\n    fn ").unwrap_or(relayout.len());
    assert!(
        relayout[..end].contains("repaint_floating_chrome_if_resized()"),
        "relayout 必须调用浮层重贴守卫（只定义不调用 = 残影会回来）"
    );
    assert!(
        source.contains("floating_paint_size"),
        "重贴必须有尺寸备忘守卫（不能每帧 churn 子层）"
    );
}

#[test]
fn 浮层按声明序收全部inspector块() {
    use crate::ui::chat::panels::{PanelKind, PanelLineStyle, PanelView};
    // 声明序：用量 → 调试 → 投递（模型 `panel_views()` 的顺序）；另有两块流内/锚定。
    let panels = vec![
        PanelView::new(PanelKind::Usage).line(PanelLineStyle::Dim, "用量"),
        PanelView::new(PanelKind::Queue).line(PanelLineStyle::Dim, "队列"),
        PanelView::new(PanelKind::DebugBar).line(PanelLineStyle::Dim, "调试"),
        PanelView::new(PanelKind::SessionHistory).line(PanelLineStyle::Dim, "历史"),
        PanelView::new(PanelKind::Delivery).line(PanelLineStyle::Dim, "投递"),
    ];
    let (inspector, anchored, flow) = partition_panels(&panels);
    let kinds: Vec<PanelKind> = inspector.iter().map(|view| view.kind).collect();
    assert_eq!(
        kinds,
        vec![PanelKind::Usage, PanelKind::DebugBar, PanelKind::Delivery],
        "浮层组按声明序收全部 Inspector 块（三块同浮层）"
    );
    assert_eq!(anchored.len(), 1);
    assert_eq!(anchored[0].kind, PanelKind::SessionHistory);
    assert_eq!(flow.len(), 1);
    assert_eq!(flow[0].kind, PanelKind::Queue);
}

// ── 「↓ 新消息」的真实判据（2026-10-05 用户规则）──

#[test]
fn 新消息按钮只在有未读且不在底部时显示() {
    assert!(jump_button_visible(false, true), "不在底部且有未读才显示");
    assert!(
        !jump_button_visible(true, true),
        "在底部不显示（没有可跳的目标）"
    );
    assert!(
        !jump_button_visible(false, false),
        "没有新内容不显示（不许常驻）"
    );
    assert!(!jump_button_visible(true, false));
}

#[test]
fn 未读判定以内容水位为准() {
    // 同水位（没有新内容）：未读不成立，即使屏幕不在底部。
    assert!(!jump_has_new_content(7, 7, Some("abc"), Some("abc")));
    assert!(!jump_has_new_content(7, 7, None, None));
    // 新提交消息（revision 前进）或流式尾巴文本变化都算新内容。
    assert!(jump_has_new_content(7, 8, Some("abc"), Some("abc")));
    assert!(jump_has_new_content(7, 7, Some("abc"), Some("abcd")));
    assert!(jump_has_new_content(7, 7, None, Some("新内容")));
    // 尾巴清空（回合收尾、列表高度变化）也算变化。
    assert!(jump_has_new_content(7, 7, Some("abc"), None));
}

// ── 旧顶栏删除守门（顶栏品牌文案与几何测试在 `ui/titlebar.rs`）──

#[test]
fn 聊天列不再自建顶栏() {
    // 旧顶栏（被全窗宽顶栏覆盖的聊天列副本）已删除：构建、拖拽视图、文本刷新
    // 路径与条内几何算式都不得回潮；顶部 26pt 带仍按共享条高预留（标签条接在
    // 全窗宽顶栏下方）。断言词拆开拼接，避免测试文本自己命中扫描。
    let source = source_text();
    for (name, needle) in [
        ("旧顶栏拖拽视图", concat!("Titlebar", "DragView")),
        ("品牌槽宽算式", concat!("fn titlebar_brand", "_width")),
        ("状态位起点算式", concat!("fn titlebar_status", "_x")),
        ("品牌文案常量", concat!("const TITLEBAR", "_BRAND_TEXT")),
        ("顶栏文本刷新副本", concat!("fn apply_titlebar", "_text")),
    ] {
        assert_eq!(
            source.matches(needle).count(),
            0,
            "旧顶栏实现残留「{name}」：{needle}"
        );
    }
    let production = source.as_str();
    assert!(
        production.contains(concat!("crate::ui::titlebar::", "HEIGHT")),
        "标签条与顶部预留必须消费共享条高（顶部带归全窗宽顶栏）"
    );
}

#[test]
fn 新消息按钮是内容宽度的小pill() {
    let width = jump_button_width();
    assert!(width >= 64.0, "短文案也留出可点面积");
    assert!(width <= 110.0, "小 pill 不铺满聊天列");
}

// ── 各带几何：浮层不参与布局流 ──

#[test]
fn 输入贴底且把手带在它之上() {
    let bands = chat_bands(600.0, 0.0, 0.0, 0.0);
    // 用户规则「输入框往下放，贴住下面」：输入行下沿 = 0。
    assert_eq!(bands.input_y, 0.0);
    assert_eq!(bands.handle_y, INPUT_HEIGHT, "把手带紧贴输入行上沿");
    assert_eq!(bands.handle_h, HANDLE_HEIGHT);
    assert_eq!(
        bands.pending_y,
        INPUT_HEIGHT + HANDLE_HEIGHT + PANE_GAP,
        "待发送条在把手带之上"
    );
    assert_eq!(bands.panel_y, bands.pending_y, "没有待发送条时面板贴把手带");
    // 2026-10-05 第三次复验：无插入带时去掉两处 8pt 纯铺面（下：消息流贴把手带上沿；
    // 上：消息流顶到 top_inset），把手带位置与高度不动。
    assert_eq!(
        bands.scroll_y,
        bands.handle_y + bands.handle_h,
        "没有插入带时消息流下沿直接贴把手带上沿（不再留基础 PANE_GAP）"
    );
    assert!((bands.scroll_h - (600.0 - bands.scroll_y)).abs() < 0.01);
    // 有插入带时既有链保持：面板贴待发送条，各留一个 PANE_GAP 当分隔。
    let with_pending = chat_bands(600.0, 32.0, 0.0, 0.0);
    assert_eq!(
        with_pending.scroll_y,
        with_pending.pending_y + 32.0,
        "有待发送条时消息流贴它的上沿"
    );
    let with_panel = chat_bands(600.0, 0.0, 100.0, 0.0);
    assert_eq!(
        with_panel.scroll_y,
        with_panel.panel_y + 100.0 + PANE_GAP,
        "有面板时消息流与面板区之间仍留 PANE_GAP"
    );
    // 上沿：滚动区一直顶到 top_inset（标签条下沿），不再多留 PANE_GAP。
    let inset = chat_bands(600.0, 0.0, 0.0, 50.0);
    assert!(
        (inset.scroll_h - (600.0 - inset.scroll_y - 50.0)).abs() < 0.01,
        "滚动区上沿顶到 top_inset（标签条下方不再留 8pt 铺面）"
    );
}

#[test]
fn 把手几何取自共享层() {
    // 箭头 10×10、**水平+垂直都居中**（2026-10-05 用户规则「上拉栏的箭头居中」；
    // 共享 `handle_arrow_frame` 给结果，平台只建控件）。
    let frame = handle_arrow_frame(400.0);
    assert!((frame.width - 10.0).abs() < 0.01 && (frame.height - 10.0).abs() < 0.01);
    assert!(
        (frame.x + frame.width / 2.0 - 400.0 / 2.0).abs() < 0.01,
        "箭头字形中心在把手带正中"
    );
    // 命中区（箭头区）也必须以同一中心居中：与字形中心重合，不许留在右侧。
    let arrow_w = HANDLE_ARROW_WIDTH.min(400.0);
    let hit_center = (frame.x + frame.width / 2.0 - arrow_w / 2.0) + arrow_w / 2.0;
    assert!(
        (hit_center - 400.0 / 2.0).abs() < 0.01,
        "命中区中心 = 字形中心 = 带中央（实机不许「看的在中间、点的在右边」）"
    );
    // 状态文字可用宽 = 左半侧（`(宽 − 箭头区)/2 − 4`），不与居中的箭头抢位。
    assert!((handle_status_width(400.0) - (181.0)).abs() < 0.01);
    assert_eq!(handle_status_width(20.0), 0.0, "极窄时不为负");
    // 实机回归护栏（源码级）：命中区 x 必须由**共享字形中心**推导 —— AppKit 里的
    // 命中区纯几何测不到，而它曾经按右对齐算，实机是「箭头在中间、能点的在右边」。
    let source = source_text();
    // 拆开拼接，避免断言文本自己命中扫描。
    let needle = concat!("glyph.x + glyph.width / 2.0", " - arrow_w / 2.0");
    assert!(
        source.contains(needle),
        "命中区必须跟随共享字形中心（不许自己按右对齐算）"
    );
}

#[test]
fn 本地显示态动作派发后要主动重建() {
    // 实机 bug（「投递在下拉栏选了后显示状态不刷新，必须收回再打开才更新」）：
    // 这类动作只改模型显示态、不经 Node，且模型未必 bump `panel_revision`，
    // 刷新回调可能永远不到 —— 平台必须自己重建。
    assert!(panel_action_is_local_display(&PanelAction::ToggleUsage));
    assert!(panel_action_is_local_display(
        &PanelAction::ToggleDebugTools
    ));
    assert!(panel_action_is_local_display(
        &PanelAction::ToggleDebugRegistry
    ));
    assert!(panel_action_is_local_display(
        &PanelAction::ToggleSessionHistory
    ));
    // 走 Node 的动作不在其列（回执/投影会带来刷新）：抽屉三个下拉自
    // 2026-10-06 起统一写 CONFIG（有界请求 → 回执后的投影重推）。
    assert!(!panel_action_is_local_display(
        &PanelAction::PermissionAllowOnce
    ));
    assert!(!panel_action_is_local_display(&PanelAction::PlanCancel));
    assert!(!panel_action_is_local_display(
        &PanelAction::SetDefaultDelivery {
            delivery: crate::ui::chat::SendDelivery::Steer
        }
    ));
    assert!(!panel_action_is_local_display(
        &PanelAction::SetThinkingEffort {
            effort: "auto".into()
        }
    ));
    assert!(!panel_action_is_local_display(
        &PanelAction::SetSafetyMode {
            mode: "tell_me".into()
        }
    ));
}

#[test]
fn 浮层不参与布局流() {
    // 验收硬指标：浮层开合前后消息流的 frame 不能变。`chat_bands` 没有浮层
    // 参数（类型层证明），这里再钉一次：同样的输入重复调用结果逐项相等。
    let before = chat_bands(640.0, 22.0, 48.0, 50.0);
    let after = chat_bands(640.0, 22.0, 48.0, 50.0);
    assert_eq!(before, after);
    // 待发送条与面板占位时：面板与消息流依次上移，但顺序不变。
    assert!(before.pending_y > before.input_y);
    assert!(before.panel_y > before.pending_y);
    assert!(before.scroll_y > before.panel_y);
}

#[test]
fn 浮层贴消息流下沿且左右留白() {
    let bands = chat_bands(640.0, 0.0, 0.0, 0.0);
    let content = inspector_content_height(120.0);
    let (x, y, w, h) = inspector_overlay_frame(460.0, bands.scroll_y, bands.scroll_h, content)
        .expect("有内容时应能定位");
    assert!((x - INSPECTOR_SIDE_MARGIN).abs() < 0.01);
    assert!((w - (460.0 - INSPECTOR_SIDE_MARGIN * 2.0)).abs() < 0.01);
    assert!(
        (y - (bands.scroll_y + INSPECTOR_BOTTOM_MARGIN)).abs() < 0.01,
        "底边贴消息流下沿之上"
    );
    assert!((h - content).abs() < 0.01);
    // 浮层整体落在消息流内（不会伸进输入行/把手带）。
    assert!(y >= bands.scroll_y);
    assert!(y + h <= bands.scroll_y + bands.scroll_h);
    assert!(y > bands.input_y + INPUT_HEIGHT, "浮层不覆盖输入行");
    // 无内容 / 容器过窄（左右留白后不足 40pt）：不给 frame（由展示逻辑保持隐藏）。
    assert!(inspector_overlay_frame(460.0, bands.scroll_y, bands.scroll_h, 0.0).is_none());
    assert!(inspector_overlay_frame(56.0, bands.scroll_y, bands.scroll_h, content).is_none());
}

#[test]
fn 浮层内容区按上限夹取() {
    // 高窗口：设计稿上限 246。
    assert!((inspector_body_max_height(800.0) - INSPECTOR_BODY_MAX_HEIGHT).abs() < 0.01);
    // 矮窗口：至少留 24（不塌成 0；这是**可视区**下限，超出的内容由内部滚动到达）。
    assert!(inspector_body_max_height(60.0) >= 24.0);
    // 总高 = 标题 + 上下内边距 + 内容；无内容 = 0（不定位浮层）。
    assert_eq!(inspector_content_height(0.0), 0.0);
    assert!(
        (inspector_content_height(100.0)
            - (INSPECTOR_HEADER_HEIGHT
                + INSPECTOR_BODY_PAD_TOP
                + 100.0
                + INSPECTOR_BODY_PAD_BOTTOM))
            .abs()
            < 0.01
    );
}

#[test]
fn 入场变换同时含位移与缩放() {
    let transform = inspector_anim_start_transform();
    assert!((transform.m11 - INSPECTOR_ANIM_SCALE).abs() < 1e-6);
    assert!((transform.m22 - INSPECTOR_ANIM_SCALE).abs() < 1e-6);
    assert!(
        (transform.m42 - INSPECTOR_ANIM_LIFT).abs() < 0.2,
        "起始位移应约为 {}pt，实际 {}",
        INSPECTOR_ANIM_LIFT,
        transform.m42
    );
    assert_eq!(transform.m44, 1.0);
}

#[test]
fn 浮层内容区左右补足设计内边距() {
    // 元素自带 PANEL_METRICS.pad_x 内边距，容器再补到设计稿的左右 11pt。
    let (x, _w) = floating_body_rect(460.0 - INSPECTOR_SIDE_MARGIN * 2.0, INSPECTOR_BODY_PAD_X);
    let left_inset = x + crate::ui::chat::panels::PANEL_METRICS.pad_x;
    assert!((left_inset - INSPECTOR_BODY_PAD_X).abs() < 0.01);
    assert!(
        (x - (INSPECTOR_BODY_PAD_X - crate::ui::chat::panels::PANEL_METRICS.pad_x)).abs() < 0.01
    );
}

#[test]
fn 会话标签的关闭按钮落在pill内() {
    // 可关闭标签：pill 宽度 = 名字宽 + × 宽 —— × 在 pill 的范围内（不是外侧独立控件）。
    let name = "晚上的事";
    let closable = session_tab_pill_width(name, true);
    let single = session_tab_pill_width(name, false);
    assert!(
        (closable - (single + TAB_CLOSE_WIDTH)).abs() < 0.01,
        "可关闭标签的 pill 要为 × 留出宽度：{closable} vs {single}"
    );
    assert!(closable > single, "带 × 的 pill 比不带 × 的宽");
    // 名宽本身仍受上下限约束（过长名称尾部省略）。
    assert!(single >= TAB_MIN_WIDTH - 0.01 && single <= TAB_MAX_WIDTH + 0.01);
}

#[test]
fn 换主题会刷新输入框文字与占位颜色() {
    // 2026-10-05 实机回归（Y2K 铬主题下输入框里的字看不清）：输入框文字/占位/
    // 插入符是**构建期**定色，换主题不重贴就会留旧主题的浅色（深色主题切浅色后
    // 落在白色 `--fbg` 上几乎不可见）。这里钉住 `repaint_chrome` 的刷新链。
    // （品牌字/状态位不在本文件：顶栏颜色刷新归 `macos_main.rs::paint_chrome`。）
    let source = source_text();
    // 带左括号定位：避免先命中 `repaint_chrome_if_resized`。
    let start = source
        .find("fn repaint_chrome(")
        .expect("repaint_chrome 必须存在");
    let rest = &source[start..];
    let end = rest.find("\n    fn ").unwrap_or(rest.len());
    let body = &rest[..end];
    for (name, needle) in [
        ("输入框文字", "input.setTextColor"),
        ("输入框插入符", "setInsertionPointColor"),
        ("输入框占位", "placeholder.setTextColor"),
    ] {
        assert!(
            body.contains(needle),
            "repaint_chrome 缺少{name}的颜色刷新（换主题后会留旧主题色）：{needle}"
        );
    }
}

#[test]
fn 记住这条入口是消息右键菜单() {
    // 2026-10-05 用户规则：气泡按钮退场，入口改由**消息右键菜单**承接
    // （旧形态 = 泡内按钮 + tag 表 + 底部入口结构；新形态 = 正文视图的
    // 右键菜单覆写 + 菜单项动作 + 共享文案常量）。正向断言新形态在场、
    // 反向继续禁旧形态回潮；断言词拆开拼接，避免测试文本自己命中扫描
    //（本注释与断言字符串里都不出现拼接后的完整词）。
    let source = source_text();
    for (name, needle) in [
        ("右键菜单覆写", concat!("menuFor", "Event:")),
        ("菜单项动作", concat!("remember", "Message:")),
        ("共享文案常量引用", concat!("REMEMBER_MENU_ITEM", "_LABEL")),
    ] {
        assert!(
            source.contains(needle),
            "「记住这条」右键入口缺「{name}」：{needle}"
        );
    }
    for (name, needle) in [
        ("按钮 tag 表", concat!("remember", "_targets")),
        ("泡内底部入口结构", concat!("Bubble", "Footer")),
    ] {
        assert_eq!(
            source.matches(needle).count(),
            0,
            "「记住这条」旧按钮形态回潮「{name}」：{needle}"
        );
    }
}

#[test]
fn 输入框粘贴图片只接共享入口() {
    // 粘贴接线守门：平台层只做剪贴板读取（覆写 NSText 的粘贴方法）并交给
    // 共享入口（`ui/chat/paste.rs`）；落盘目录等路径常量归 Rust 命令域，
    // 平台文件里出现就是第二份定义点。断言词拆开拼接，避免测试文本自己
    // 命中扫描（正反两个方向都要求实现里真的在场/真的没有）。
    let source = source_text();
    for (name, needle) in [
        ("粘贴覆写", concat!("past", "e:")),
        ("共享入口引用", concat!("add_pasted", "_image")),
    ] {
        assert!(
            source.contains(needle),
            "输入框粘贴接线缺「{name}」：{needle}"
        );
    }
    for (name, needle) in [
        ("托管目录常量", concat!("PASTED", "_DIR")),
        ("截图目录常量", concat!("SCREENSHOT", "_DIR")),
    ] {
        assert_eq!(
            source.matches(needle).count(),
            0,
            "平台文件不该出现「{name}」（路径归 Rust 命令域）：{needle}"
        );
    }
}

// ── 上拉抽屉符号退场（编译已证明无引用；源码守门防回潮）──

#[test]
fn 上拉抽屉符号已整体删除() {
    // 拆开拼接，避免断言文本自己命中扫描（与 macos_widgets 的模态守门同做法）。
    let source = source_text();
    for (name, needle) in [
        ("展开态", concat!("accessories", "_expanded")),
        ("把手", concat!("accessory", "_handle")),
        ("内容栈", concat!("accessory", "_stack")),
        ("高度", concat!("accessory", "_height")),
        ("把手标签", concat!("accessory", "_handle_label")),
        ("把手动作", concat!("toggleAccess", "ories:")),
    ] {
        assert_eq!(
            source.matches(needle).count(),
            0,
            "上拉抽屉符号「{name}」未删净：{needle}"
        );
    }
}

/// 泡量测保持**单遍**（2026-10-06 流式 delta 减负）：同一个散文视图的宽与高
/// 必须来自同一次 [`text_layout_extent`] —— 旧实现先 `autosize_text_view` 量
/// 高度、再 `prose_used_width` 二次遍历全部行片段量宽度；流式尾巴每个 delta
/// 都重建一个泡，双遍历在流式路径上是每帧成本。AppKit 布局单测走不到（需主
/// 线程 + 真视图），这里用源码护栏钉住（本仓既有做法；A/B 钩子的 `text_layouts`
/// 计数在双遍历回潮时会翻倍）。
#[test]
fn 泡量测保持单遍_源码守门() {
    let source = source_text();
    let at = source
        .find("fn autosize_text_view(")
        .expect("autosize_text_view 必须存在");
    let body = &source[at..];
    // 顶层函数体以列 0 的 `}` 收束（体内没有列 0 的闭括号）。
    let end = body
        .find("\n}\n")
        .map(|index| index + 2)
        .unwrap_or(body.len());
    let body = &body[..end];
    assert_eq!(
        body.matches("text_layout_extent(").count(),
        1,
        "定帧与取宽必须共用同一次 text_layout_extent（二次遍历 = 每帧白跑一遍全行片段）"
    );
    assert!(
        body.contains("used_width"),
        "量测必须把最宽行宽一并返回（泡宽用它，见 build_bubble_view）"
    );
    let production = source.as_str();
    assert!(
        !production.contains("fn prose_used_width"),
        "二次量测函数 prose_used_width 已合并删除，不得回潮"
    );
}

/// 泡宽量测与渲染必须用同一个整点宽度（2026-10-20 实机「卡住」右半被裁）：
/// 窗口外按 1x 量到 198.44 → 折在「卡」，窗口里按 2x 取整 198.5 → 折在「卡住」，
/// 泡宽按前者算就比渲染行宽少一截。共享函数的 ceil 是唯一写入点，不得回落到
/// 浮点内联表达式。
#[test]
fn 气泡正文宽度走共享整点函数_源码守门() {
    let source = source_text();
    let production = source.as_str();
    assert!(
        production.contains("bubble_inner_width(max_width)"),
        "泡量测/渲染宽度必须走共享 `bubble_inner_width`（整点取整）"
    );
    assert!(
        !production.contains("max_width - BUBBLE_PAD_X * 2.0"),
        "不得回落到浮点内联宽度（1x 量测与 2x 渲染会折出不同行宽）"
    );
}
