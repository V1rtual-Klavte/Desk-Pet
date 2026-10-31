//! 面板、标签页与会话历史。

use super::*;
use super::layout::history_popover_rect;
use super::paint::{make_themed_button_r, send_font, stamp_ink};
use super::transcript::{chat_apply, focus_main_pane_input};
use crate::{rust_debug, rust_warn};

// ==========================================
// W8b 面板区（计划/权限/队列/中断/slash 候选）+ 把手带 + 浮层 Inspector
// ==========================================

/// 重建面板子控件（快照里的渲染块 → 按 `layout_panels` 的 frame 建控件）。
///
/// 摆放几何（换行、越界夹取、空间不足跳过整块）来自平台无关的
/// [`crate::ui::chat::panels::layout_panels`]：本函数只按 frame 建控件。
/// 旧实现把摆放规则在这里重写了一份（行内按钮不换行 + 高度不够即终止），
/// 与 macOS 侧不对称，且越界按钮会被窗口边缘裁掉、尾随控件被静默丢弃
/// （用户报告的「档位控件点不动」根因之一）。
///
/// 2026-10-05 第三波：老版上拉抽屉（用量/调试/投递 chip 堆）退场 ——
/// - 流内只留决策 / Transient（判定走共享层 `surface()`，平台层不另写 matches!）；
/// - Inspector 面的三块（用量/调试/投递）收进同一个浮层（把手箭头开合），
///   只在 `snapshot.inspector_open` 时建内容（[`partition_panels`]）。
pub(super) unsafe fn rebuild_panels(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    use crate::ui::chat::panels::layout_panels;

    unsafe {
        for child in state.panel_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        for child in state.inspector_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        for child in state.history_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        state.panel_actions.clear();
        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let width = (client.right - client.left).max(scaled(120, scale));
        let height = (client.bottom - client.top).max(0);
        // 布局全程用逻辑单位（与 macOS 同一份几何）；物理换算只在建控件时做。
        let logical_width = f64::from(width) / scale;
        // 宿主尚未布局（高度为 0）时不设上限，等 relayout 后按真实高度截断显示
        // （与 macOS `rebuild_panels` 的 host_height 守卫同口径）。
        let max_height = if height > 0 {
            f64::from(height) * PANEL_MAX_FRACTION / scale
        } else {
            f64::INFINITY
        };
        // 分区：Inspector 面全进浮层（三块同浮层，顺序 = 声明序）；是否**显示**
        // 由 `snapshot.inspector_open` 决定（见下面 overlay 段），路由与显隐分开。
        let groups = partition_panels(&snapshot.panels);
        let mut actions: Vec<PanelAction> = Vec::new();
        if groups.flow.is_empty() {
            state.panel_height = 0;
        } else {
            let layout = layout_panels(&groups.flow, logical_width, max_height);
            if layout.truncated {
                // 功能面板区上限是 45% 客户区高度（面板不挤掉输入区）；layout_panels
                // 保序跳过放不下的块（整块跳过，不留半截控件），这里留痕不静默。
                rust_debug!(
                    "面板区空间不足：已跳过部分块（保序摆放；max_height={:.0}px）",
                    f64::from(height) * PANEL_MAX_FRACTION
                );
            }
            place_panel_elements(
                state,
                PanelGroup::Functional,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.panel_height = scaled_f(layout.height, scale);
        }
        if !snapshot.inspector_open || groups.overlay.is_empty() {
            // 浮层收着（或三块都没内容）：不建内容控件 —— 层窗由
            // `layout_inspector_layer` 隐藏，遮罩也不出现。
            state.inspector_content_height = 0;
            state.inspector_viewport_height = 0;
            state.inspector_scroll_y = 0;
        } else {
            // 浮层内容宽 = 浮层盒宽（窗口宽 − 左右各 9pt）；**可视高**上限与流内面板
            // 同口径（客户区 45%），再扣掉标题行与底部内边距。
            let box_width =
                (f64::from(width) - f64::from(scaled(INSPECTOR_PAD * 2, scale))) / scale;
            let max_content = if height > 0 {
                (f64::from(height) * PANEL_MAX_FRACTION / scale
                    - f64::from(INSPECTOR_HEADER_HEIGHT + INSPECTOR_BODY_PAD_BOTTOM))
                .max(24.0)
            } else {
                f64::INFINITY
            };
            // 内容**全量摆放**（不设高度上限）：上限只决定可视区高，其余靠裁剪窗的
            // 内部滚动到达 —— 旧的「按上限摆放」会把放不下的块按序跳过（超长的
            // 「注册明细」全展开即触发，内容谁也到不了）。滚动几何走共享
            // `panel_scroll_geometry`（与 macOS 同一口径）。
            let layout = layout_panels(&groups.overlay, box_width, f64::INFINITY);
            let geometry =
                crate::ui::chat::panels::panel_scroll_geometry(layout.height, max_content);
            if geometry.max_offset > 0.0 {
                // 超可视高：内容由内部滚动可达（留痕不静默；这里不再有「丢块」的截断）。
                rust_debug!(
                    "浮层内容超可视高：已启用内部滚动（content={:.0} view={:.0}）",
                    geometry.content_height,
                    geometry.view_height
                );
            }
            place_panel_elements(
                state,
                PanelGroup::Inspector,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.inspector_content_height = scaled_f(geometry.content_height, scale);
            state.inspector_viewport_height = scaled_f(geometry.view_height, scale);
            // 滚动偏移保留（投影刷新频繁，不重置到顶）；越界由布局里统一钳制。
        }
        if groups.anchored.is_empty() {
            state.history_height = 0;
        } else {
            // 弹层内容宽 = 弹层宽 − 两侧内边距；高度上限同「客户区 45%」（内容超出由
            // `layout_panels` 保序截断，弹层在布局里还会被夹进窗口）。
            let pad = f64::from(HISTORY_POPOVER_PAD);
            let max_content = if height > 0 {
                (f64::from(height) * PANEL_MAX_FRACTION / scale - pad * 2.0).max(24.0)
            } else {
                f64::INFINITY
            };
            let layout = layout_panels(
                &groups.anchored,
                f64::from(HISTORY_POPOVER_WIDTH) - pad * 2.0,
                max_content,
            );
            if layout.truncated {
                rust_debug!(
                    "会话历史弹层空间不足：已跳过部分块（保序摆放；max_height={max_content:.0}pt）"
                );
            }
            place_panel_elements(
                state,
                PanelGroup::History,
                &layout.elements,
                &mut actions,
                scale,
            );
            state.history_height =
                scaled_f(layout.height, scale) + scaled(HISTORY_POPOVER_PAD * 2, scale);
        }
        state.panel_actions = actions;
    }
}

/// 按呈现面把面板分到三组（判定走共享层的 `PanelKind::surface()`，平台层不写 matches!）：
/// - 决策 / Transient（slash 候选）→ 流内，永远可见；
/// - Inspector（用量 / 调试 / 投递）→ **同一个浮层**，三块全放（顺序 = 声明序）；
///   浮层开合由 `ChatSnapshot::inspector_open` 决定（不再区分「打开的是哪一块」）——
///   内容不落流内，这是「开合前后消息流 y 不变」的结构保证之一；
/// - Anchored（会话历史 → 「历史」按钮）→ 锚定弹层，**不进流内面板栈**（挂在栈里会
///   跑到页面底部、与触发它的按钮隔着大半屏，就是用户报告的「弹窗在下面」）。
pub(super) struct PanelGroups {
    pub(super) flow: Vec<crate::ui::chat::panels::PanelView>,
    pub(super) overlay: Vec<crate::ui::chat::panels::PanelView>,
    pub(super) anchored: Vec<crate::ui::chat::panels::PanelView>,
}

pub(super) fn partition_panels(views: &[crate::ui::chat::panels::PanelView]) -> PanelGroups {
    use crate::ui::chat::panels::PanelSurface;
    let mut groups = PanelGroups {
        flow: Vec::new(),
        overlay: Vec::new(),
        anchored: Vec::new(),
    };
    for view in views {
        match view.kind.surface() {
            PanelSurface::Inspector => groups.overlay.push(view.clone()),
            PanelSurface::Anchored(_) => groups.anchored.push(view.clone()),
            PanelSurface::Decision | PanelSurface::Transient => groups.flow.push(view.clone()),
        }
    }
    groups
}

/// 面板子控件的归属容器（流内 / 浮层 / 历史弹层；三组共用同一动作表）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum PanelGroup {
    /// 流内面板（计划/权限/中断/队列/slash 候选）：永远可见，父 = 聊天窗。
    Functional,
    /// 浮层内容（当前开着的用量/调试/投递）：父 = 浮层窗口，随浮层显隐。
    Inspector,
    /// 会话历史弹层内容：父 = 弹层窗口，随弹层显隐。
    History,
}

/// 把 `layout_panels` 产出的元素摆进目标容器（流内面板栈与浮层内容栈共用；
/// 与 macOS `place_panel_elements` 同构）。
pub(super) unsafe fn place_panel_elements(
    state: &mut ChatWinState,
    group: PanelGroup,
    elements: &[crate::ui::chat::panels::PanelElement],
    actions: &mut Vec<PanelAction>,
    scale: f64,
) {
    use crate::ui::chat::panels::PanelElement;

    unsafe {
        // 三组的承载窗口与内容坐标系不同（x/y 偏移在重建时算好，布局只做整盒平移）：
        // - Functional：父 = 聊天窗，坐标相对面板区上缘（`layout_panes_for` 平移）；
        // - Inspector：父 = 滚动裁剪窗（锚在盒内标题行之下、左右内缩让开描边），
        //   坐标相对**内容原点**（滚动前）：x 减掉内缩量、y 不再含标题行偏移，
        //   纵向滚动偏移在 `apply_inspector_scroll` 里统一平移；
        // - History：父 = 弹层窗口，四周都让开盒内边距（内容按「弹层宽 − 2×pad」
        //   布局，原点在 pad 处）。
        let (parent, content_dx, content_dy) = match group {
            PanelGroup::Functional => (state.hwnd, 0, 0),
            PanelGroup::Inspector => (
                state.inspector_scroll,
                -scaled(INSPECTOR_SCROLL_INSET, scale),
                0,
            ),
            PanelGroup::History => {
                let pad = scaled(HISTORY_POPOVER_PAD, scale);
                (state.history_layer, pad, pad)
            }
        };
        // 承载窗口没建起来时整组跳过（父句柄 0 会造出顶层窗，绝不允许）。
        if parent == 0 {
            rust_warn!(
                "悬浮层窗口不可用：面板内容未建（{} 个元素被跳过）",
                elements.len()
            );
            return;
        }
        // 卡片底板窗（`PanelElement::Card`）：建完**整批**后统一压到兄弟 z 序最底
        // （见循环后的 `SetWindowPos`）。
        let mut card_hwnds: Vec<HWND> = Vec::new();
        for element in elements {
            match element {
                PanelElement::Card { frame } => {
                    // 卡片底板 = 自绘 STATIC（`SS_OWNERDRAW`）：底与描边由父窗的
                    // `WM_DRAWITEM`/`ODT_STATIC` 段画（`draw_themed_card`），几何照
                    // `layout_panels` 的 frame 摆（平台不重算）。
                    // `WS_CLIPSIBLINGS`：底板在 z 序最底，重绘时把上方重叠的兄弟
                    // （行标签/按钮）从更新区裁掉，不会盖住它们（与输入框占位同款）。
                    let card = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        "",
                        0,
                        WS_CHILD | WS_VISIBLE | SS_OWNERDRAW | WS_CLIPSIBLINGS,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    if card != 0 {
                        card_hwnds.push(card);
                    }
                }
                PanelElement::Line { text, style, frame } => {
                    let label = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        text,
                        0,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    send_font(state, label, 1);
                    stamp_ink(label, panel_line_color(*style));
                }
                PanelElement::Button {
                    label,
                    action,
                    link,
                    frame,
                } => {
                    let id = PANEL_BASE + actions.len() as i32;
                    let control = create_panel_child(
                        state,
                        group,
                        parent,
                        "BUTTON",
                        label,
                        id,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        scaled_f(frame.height, scale),
                    );
                    send_font(state, control, 0);
                    // 文字链（无底无边、仅文字）与 chip 按钮的分档在绘制层（paint_win）。
                    let role = if *link {
                        ButtonRole::Link
                    } else {
                        ButtonRole::Normal
                    };
                    make_themed_button_r(control, role, scale, theme::tokens().radii.sm);
                    actions.push(action.clone());
                }
                PanelElement::Select {
                    label,
                    options,
                    selected,
                    label_frame,
                    frame,
                } => {
                    let text = create_panel_child(
                        state,
                        group,
                        parent,
                        "STATIC",
                        label,
                        0,
                        WS_CHILD | WS_VISIBLE,
                        content_dx + scaled_f(label_frame.x, scale),
                        content_dy + scaled_f(label_frame.y, scale),
                        scaled_f(label_frame.width, scale),
                        scaled_f(label_frame.height, scale),
                    );
                    send_font(state, text, 1);
                    stamp_ink(text, theme::tokens().ink);
                    // 下拉：id = PANEL_SELECT_BASE + 选项动作基址；用户选定（CBN_SELENDOK）
                    // 时取 CB_GETCURSEL 叠加基址，见 WM_COMMAND 的 PANEL_SELECT_BASE 段。
                    // **圆角口径差异（就地注明）**：COMBOBOX 是系统控件，给它贴
                    // `SetWindowRgn` 会把展开的清单一起裁掉（清单是组合框的子窗口），
                    // 且开合期动态换区域要额外接 CBN_DROPDOWN/CBN_CLOSEUP。全应用
                    // 的下拉（流内面板/设置窗/编辑器）都是同一份系统外观；
                    // **主题色**已接线：三个承载父窗过程（聊天窗/浮层滚动裁剪窗/层窗）
                    // 把 `WM_CTLCOLOREDIT`/`WM_CTLCOLORLISTBOX` 转给
                    // `windows_settings::edit_ctlcolor`，这里不单独开第二条路径；
                    // 登记过的后续项只剩**圆角**（仍是系统下拉外观）。
                    let base = actions.len() as i32;
                    let combo = create_panel_child(
                        state,
                        group,
                        parent,
                        "COMBOBOX",
                        "",
                        PANEL_SELECT_BASE + base,
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
                        content_dx + scaled_f(frame.x, scale),
                        content_dy + scaled_f(frame.y, scale),
                        scaled_f(frame.width, scale),
                        // 高度含下拉清单（显示域高度由字体决定；照编辑器下拉的先例——
                        // windows_editor.rs 的素材下拉同样给足高度）。**实机核验点**：
                        // 未展开时窗口矩形整体参与命中测试，超高部分可能遮挡相邻控件
                        // （本机不可编译验证；若实机发现下拉「点不动」，优先查这里，
                        // 备选方案是创建后 SetWindowRgn 只留显示域）。
                        scaled_f(frame.height + 160.0, scale),
                    );
                    send_font(state, combo, 0);
                    for option in options {
                        SendMessageW(
                            combo,
                            CB_ADDSTRING,
                            0,
                            wide(&option.label).as_ptr() as LPARAM,
                        );
                    }
                    SendMessageW(combo, CB_SETCURSEL, *selected, 0);
                    for option in options {
                        actions.push(option.action.clone());
                    }
                }
            }
        }
        // 卡片底板统一压到兄弟 z 序最底 —— 底板必须**垫在**内容下（元素顺序已把它
        // 排在内部元素之前，但子窗创建后的默认 z 序不保证：占位标签那处已实证
        // 「不能只靠创建顺序」）。配合 `WS_CLIPSIBLINGS`，底板重绘不会盖住上面的行/按钮。
        for card in card_hwnds {
            SetWindowPos(
                card,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            // 自绘 STATIC 只在自身更新区非空时才把 `WM_DRAWITEM` 转给父窗：显式作废
            // 一次，建窗后立刻有底，不依赖父窗后续重绘的先后（不擦除：底会填满整框）。
            InvalidateRect(card, std::ptr::null(), 0);
        }
    }
}

// ==========================================
// A1：会话标签条
// ==========================================

/// 重建标签条动态按钮（会话说整表来自投影；每次都整体替换）。
///
/// 活跃标签用「▸ 」前缀标记（Win32 BUTTON 没有跨版本可靠的按下态；用文字标记
/// 等价表达高亮语义）；中断标记用「 !」后缀（等价于圆点角标）。
/// 顶栏（品牌/状态位/关闭「×」）不在这里：它归主窗的全窗宽顶栏（`windows_main.rs`），
/// 状态位文本由 `windows.rs::refresh_titlebar` 直接推给那一份展示副本。
pub(super) unsafe fn rebuild_tabs(state: &mut ChatWinState, snapshot: &crate::ui::chat::ChatSnapshot) {
    unsafe {
        if !state.pane {
            return;
        }
        for child in state.tab_children.drain(..) {
            DestroyWindow(child.hwnd);
        }
        state.session_targets.clear();
        let scale = dpi_scale(state.hwnd);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(state.hwnd, &mut client);
        let width = client.right - client.left;
        let nav_h = scaled(NAV_CONTROL_HEIGHT, scale);
        let right_reserve = scaled(NAV_NEW_WIDTH + NAV_HISTORY_WIDTH + 12, scale);
        let mut x = scaled(4, scale);
        for tab in &snapshot.sessions {
            let name_width = tab_name_width(&tab.name, scale);
            // 2026-10-05 用户规则「会话 tab 的 × 应该在气泡里面」：pill 加宽到
            // 「名字 + 间隙 + ×」，× 落在 pill **内部**的右格 —— 选中标签的材质
            // 从背后包住 ×（原先 × 是 pill 外的独立控件，高亮包不住它）。
            let close_w = if tab.closable {
                scaled(TAB_CLOSE_WIDTH, scale)
            } else {
                0
            };
            let close_gap = if tab.closable {
                scaled(TAB_CLOSE_GAP, scale)
            } else {
                0
            };
            let tab_w = name_width + close_gap + close_w;
            if x + tab_w + scaled(2, scale) > width - right_reserve {
                // 空间不够：右侧「+」「历史」入口优先，其余标签本帧不显示。
                break;
            }
            // 标签文字就是会话名：macOS `rebuild_tabs` 不给选中标签加任何前缀
            // （选中语义由 pill 底表达）。旧实现在这里用「▸ 」当按下态标记，
            // 与 mac 的字面不一致，已删除。
            let mut title = tab.name.clone();
            if tab.interrupted {
                title.push_str(" !");
            }
            let index = state.session_targets.len();
            // 选中标签的底是 mac 的 pill 视图（完整渐变 + 描边 + 立体线 + 投影），
            // 不是按钮面 —— 角色见 `ButtonRole::TabPill`。
            let tab_role = if tab.active {
                ButtonRole::TabPill
            } else {
                ButtonRole::TabOff
            };
            create_nav_child(
                state,
                &title,
                SESSION_TAB_BASE + index as i32,
                x,
                tab_w,
                nav_h,
                tab_role,
            );
            if tab.closable {
                // × 用**无底**角色（TabOff）：选中时 pill 的材质/高亮包住它，不再
                // 出现「实底小方块压在 pill 上」的 pill 外观感。id 段不变。
                create_nav_child(
                    state,
                    "×",
                    SESSION_CLOSE_BASE + index as i32,
                    x + name_width + close_gap,
                    close_w,
                    nav_h,
                    ButtonRole::TabOff,
                );
            }
            x += tab_w + scaled(2, scale);
            state.session_targets.push(tab.id.clone());
        }
    }
}

/// 标签条动态按钮：创建并登记到 `tab_children`（父窗口是聊天窗本体；
/// 坐标由 `layout_nav` 统一摆放）。
unsafe fn create_nav_child(
    state: &mut ChatWinState,
    text: &str,
    id: i32,
    x: i32,
    w: i32,
    h: i32,
    role: ButtonRole,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(text).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            x,
            0,
            w,
            h,
            state.hwnd,
            id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        // 小号字体（标签条控件同口径）。
        if let Some(font) = state.fonts.get(1) {
            SendMessageW(hwnd, WM_SETFONT, *font as WPARAM, 1);
        }
        make_themed_button_r(hwnd, role, dpi_scale(state.hwnd), theme::tokens().radii.sm);
        state.tab_children.push(ChildEntry {
            hwnd,
            x,
            y: 0,
            w,
            h,
        });
        hwnd
    }
}

/// 标签名称宽度（字符宽度估算 → 夹取；与 macOS `session_tab_name_width` 同口径）。
fn tab_name_width(name: &str, scale: f64) -> i32 {
    let logical = (crate::ui::chat::panels::estimated_text_width(name, 11.0) + 16.0)
        .clamp(f64::from(TAB_MIN_WIDTH), f64::from(TAB_MAX_WIDTH));
    scaled(logical.round() as i32, scale)
}

/// 派发一个面板动作并按**动作后的新快照**整帧重建。
///
/// **为什么要立即重建**（用户报告「投递在下拉栏选完之后显示不刷新，必须收回再打开
/// 才更新」的根因与修法）：显示类本地动作只改模型 + `schedule_refresh()`，而刷新走
/// **版本号比对** —— 当时代码里的本地 setter 没有 bump `panel_revision`，`drain_refresh`
/// 便认为「面板没变」把刷新丢掉，界面停在旧状态（重新打开浮层只是碰巧撞上别的
/// 重建时机）。这里在派发后无条件重建：与 `toggle_inspector_ui` / `close_history_ui`
/// 的既有模式一致，覆盖**所有**动作（今后再有忘记 bump 的本地 setter 也不会漏）。
/// 代价：本来就会 bump 的动作（展开开关 / slash 填入 / 会话历史 / 计划权限回执等）
/// 会多一次整帧重建——用户点击频率低、重建在毫秒级，可接受。
/// 更省的做法是共享层给本地 setter 补 `panel_revision += 1`（本体 `ChatModel`，
/// 本平台层不改；已登记在交付报告）。
pub(super) unsafe fn dispatch_panel_action(action: PanelAction) {
    unsafe { handle_panel_outcome(crate::ui::chat::apply_panel_action(action)) };
    chat_apply(ChatRenderUpdate::Full(crate::ui::chat::snapshot()));
}

/// 面板动作结果的统一归宿（只由 [`dispatch_panel_action`] 调用；失败如实通知）。
pub(super) unsafe fn handle_panel_outcome(result: crate::error::AppResult<PanelOutcome>) {
    match result {
        Ok(PanelOutcome::FillInput(text)) => {
            let input = CHAT.with(|cell| cell.borrow().as_ref().map(|state| state.input));
            if let Some(input) = input {
                let length = text.encode_utf16().count() as WPARAM;
                unsafe {
                    SetWindowTextW(input, wide(&text).as_ptr());
                    SendMessageW(input, EM_SETSEL, length, length as LPARAM);
                }
            }
            crate::ui::chat::set_notice(None);
        }
        // 提问「其它」：不改文本，只把焦点交回输入框（用户下一条消息就是自由回答）。
        // 复用呼出路径的聚焦实现（可见性判断与留痕都在它内部；未在 Windows 实机验证）。
        Ok(PanelOutcome::FocusInput) => {
            let focused = focus_main_pane_input();
            if !focused {
                rust_debug!("提问「其它」后聚焦跳过：聊天面板未挂载或当前不可见");
            }
            crate::ui::chat::set_notice(None);
        }
        Ok(PanelOutcome::None) => crate::ui::chat::set_notice(None),
        // 动作成功的中性瞬时回执（旧壳 showDeliveryNote 的迁移）。
        Ok(PanelOutcome::Notice(text)) => crate::ui::chat::set_notice(Some(text)),
        Err(error) => {
            // 派发失败不做乐观 UI 变更；错误详情（远端错误可能较长）走模态对话框，
            // 用户可复制反馈，不用一行 notice 埋掉（见 ui::chat::dialog）。
            crate::ui::chat::dialog::show_failure(
                "操作未送达",
                "本次操作没有送达，界面未做改动。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
}

/// 面板子控件创建（父窗口由 `parent` 给：流内 = 聊天窗本体、浮层 = 浮层窗口；
/// 按 `group` 登记到对应子控件表，不随画布滚动）。
#[allow(clippy::too_many_arguments)]
unsafe fn create_panel_child(
    state: &mut ChatWinState,
    group: PanelGroup,
    parent: HWND,
    class: &str,
    title: &str,
    control_id: i32,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> HWND {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let hwnd = CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(title).as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent,
            control_id as HMENU,
            hinstance,
            std::ptr::null(),
        );
        if hwnd != 0 {
            let entry = ChildEntry {
                hwnd,
                x,
                y,
                w: width,
                h: height,
            };
            match group {
                PanelGroup::Functional => state.panel_children.push(entry),
                PanelGroup::Inspector => state.inspector_children.push(entry),
                PanelGroup::History => state.history_children.push(entry),
            }
        }
        hwnd
    }
}

/// `PanelLineStyle` → 主题字色（Normal/Dim/Warn/Ok → ink/dim/warn/ok）。
fn panel_line_color(style: PanelLineStyle) -> crate::ui::theme::Rgba {
    let t = theme::tokens();
    match style {
        PanelLineStyle::Normal => t.ink,
        PanelLineStyle::Dim => t.dim,
        PanelLineStyle::Warn => t.warn,
        PanelLineStyle::Ok => t.ok,
    }
}

/// 「历史」按钮的右缘（聊天窗客户区坐标）。
///
/// 直接问控件自己的窗口矩形（`GetWindowRect` + `ScreenToClient`），**不重算**
/// `layout_nav` 的 `width − history_w − 4` —— 那会造出第二份几何定义点；
/// 控件不在（独立窗 / 未挂载）时回落到窗口右缘内缩 4。
fn history_button_right(state: &ChatWinState, width: i32, scale: f64) -> i32 {
    unsafe {
        if state.nav_history != 0 {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(state.nav_history, &mut rect) != 0 {
                let mut point = POINT {
                    x: rect.right,
                    y: rect.bottom,
                };
                if ScreenToClient(state.hwnd, &mut point) != 0 {
                    return point.x;
                }
            }
        }
    }
    width - scaled(4, scale)
}

/// 会话历史弹层的摆放（**单向依赖**：只吃画布矩形与「历史」按钮右缘 —— 弹层跟随
/// 布局，布局不看弹层）。
///
/// - 层窗口盖住消息流区域（与浮层同款：遮罩只罩消息流，不罩输入区/标签条，
///   所以「点外部关闭」的点落在消息流上；也正因此**不能**盖标签条 —— 否则
///   「历史」按钮点不到、无法再点收起）；
/// - 盒顶边贴标签条下沿（层顶 + `HISTORY_POPOVER_GAP_Y`）、右缘对齐按钮右缘、
///   宽高按内容并整体夹进层内（[`history_popover_rect`]）；
/// - 弹出的那一刻抬到同级最上（重建会造新兄弟窗口，遮罩必须压在画布子树之上）；
/// - 盒几何变化才重画层；伸到盒外的内容整条藏起（同浮层口径）。
pub(super) unsafe fn layout_history_layer(
    state: &mut ChatWinState,
    width: i32,
    canvas_top: i32,
    canvas_bottom: i32,
    scale: f64,
) {
    unsafe {
        if state.history_layer == 0 {
            return;
        }
        MoveWindow(
            state.history_layer,
            0,
            canvas_top,
            width,
            (canvas_bottom - canvas_top).max(1),
            1,
        );
        let open = state.history_height > 0;
        ShowWindow(state.history_layer, if open { SW_SHOW } else { SW_HIDE });
        if !open {
            state.history_box = paint_win::Rect::new(0, 0, 0, 0);
            return;
        }
        SetWindowPos(
            state.history_layer,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let anchor_right = history_button_right(state, width, scale);
        let wanted_w =
            scaled(HISTORY_POPOVER_WIDTH, scale).max(scaled(HISTORY_POPOVER_MIN_WIDTH, scale));
        let wanted_h = state
            .history_height
            .max(scaled(HISTORY_POPOVER_MIN_HEIGHT, scale));
        let panel_box = history_popover_rect(
            width,
            canvas_bottom - canvas_top,
            anchor_right,
            wanted_w,
            wanted_h,
            scaled(HISTORY_POPOVER_GAP_Y, scale),
        );
        for child in &state.history_children {
            let inside = child.y + child.h <= panel_box.h;
            ShowWindow(child.hwnd, if inside { SW_SHOW } else { SW_HIDE });
            MoveWindow(
                child.hwnd,
                panel_box.x + child.x,
                panel_box.y + child.y,
                child.w,
                child.h,
                1,
            );
        }
        if state.history_box != panel_box {
            state.history_box = panel_box;
            InvalidateRect(state.history_layer, std::ptr::null(), 0);
        }
    }
}

/// A1：会话标签条的控件摆放（仅面板模式；标签按钮的 x/w 由 `rebuild_tabs` 给出，
/// y 在这里统一落到条内垂直居中位置）。
///
/// 顶栏（品牌/状态位/关闭「×」）不在这里：它归主窗的全窗宽顶栏子窗口
/// （`windows_main.rs::layout_titlebar_children`），本窗只在带下方摆标签条。
pub(super) unsafe fn layout_tabs(state: &mut ChatWinState, width: i32, scale: f64) {
    unsafe {
        let titlebar_h = scaled_f(crate::ui::titlebar::HEIGHT, scale);
        let tabs_h = scaled(TABS_HEIGHT, scale);
        let nav_h = scaled(NAV_CONTROL_HEIGHT, scale);
        // 标签条：动态标签在左（x 已在 rebuild 时算好），「+」「历史」靠右。
        let tab_y = titlebar_h + (tabs_h - nav_h) / 2;
        let history_w = scaled(NAV_HISTORY_WIDTH, scale);
        let new_w = scaled(NAV_NEW_WIDTH, scale);
        let history_x = (width - history_w - scaled(4, scale)).max(0);
        let new_x = (history_x - new_w - scaled(4, scale)).max(0);
        MoveWindow(state.nav_history, history_x, tab_y, history_w, nav_h, 1);
        MoveWindow(state.nav_new, new_x, tab_y, new_w, nav_h, 1);
        for child in &state.tab_children {
            MoveWindow(child.hwnd, child.x, tab_y, child.w, child.h, 1);
        }
    }
}
