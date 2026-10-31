//! 流内面板/浮层 Inspector/会话标签的构建与面板按钮控件。

use super::super::stack::ChatStackView;
use super::super::window::{as_any, theme_layer, without_implicit_animation};
use super::*;

impl ChatContentController {
    // ── W8b 面板区 ──

    /// 重建面板区（快照里的渲染块 → 标签/行/按钮；按钮 tag 指向本次动作表）。
    ///
    /// 摆放几何（换行、越界夹取、空间不足时先保交互控件）全部来自平台无关的
    /// [`crate::ui::chat::panels::layout_panels`]：平台层只按 frame 建控件。
    /// 旧实现把摆放规则在这里重写了一份（单行不换行 + 高度不够即 `break`），
    /// 曾把越界按钮与尾随动作按钮丢掉 —— 用户报告的「档位控件点不动」根因之一。
    ///
    /// 2026-10-05 改版：`PanelSurface::Inspector` 的面板不再进流内栈，改为浮层里
    /// **当前开着的那一个**（[`Self::rebuild_inspector`]）；流内只放决策 + 临时面板。
    pub(super) fn rebuild_panels(
        &self,
        mtm: MainThreadMarker,
        snapshot: &crate::ui::chat::ChatSnapshot,
    ) {
        use crate::ui::chat::panels::layout_panels;

        let Some(stack) = self.ivars().panel_stack.get() else {
            return;
        };
        for subview in stack.subviews().iter() {
            subview.removeFromSuperview();
        }
        self.ivars().panel_actions.borrow_mut().clear();
        self.ivars().panel_select_options.borrow_mut().clear();
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        // 分组（判定只在 `PanelKind::surface()`）：
        // - Inspector（用量/调试/投递，**三块同浮层**、按声明序）→ `rebuild_inspector`；
        // - Anchored（会话历史）→ 「历史」按钮下方的锚定弹层（`rebuild_history_popover`）；
        // - Decision + Transient（计划/权限/中断/队列/slash 候选）→ 流内面板栈。
        // 三组共用一个动作表（tag = 表内下标）。
        let (inspector_views, anchored_views, flow_views) = partition_panels(&snapshot.panels);
        // 宿主尚未布局（高度为 0）时不设上限，等 relayout 后按真实高度截断显示。
        let host_height = match self.host_view() {
            Some(host) if host.bounds().size.height > 0.0 => host.bounds().size.height,
            _ => 0.0,
        };
        let max_height = if host_height > 0.0 {
            host_height * PANEL_MAX_FRACTION
        } else {
            f64::INFINITY
        };
        let mut actions: Vec<PanelAction> = Vec::new();
        let mut select_labels: Vec<(isize, Vec<String>)> = Vec::new();

        let layout = layout_panels(&flow_views, width, max_height);
        self.place_panel_elements(
            mtm,
            &layout.elements,
            &stack,
            &mut actions,
            &mut select_labels,
        );
        if layout.truncated {
            // 面板区上限是 45% 宿主高度（面板不挤掉输入区），小窗口下内容会截断；
            // layout_panels 保序跳过放不下的块（整块跳过，不留半截控件），这里留痕不静默。
            rust_debug!("面板区空间不足：已跳过部分块（保序摆放；max_height={max_height:.0}）");
        }
        stack.setFrameSize(NSSize::new(width, layout.height.max(1.0)));
        self.ivars().panel_height.set(layout.height);

        // 把手箭头朝向随开合状态（开 → ▾ 可收起，合 → ▴ 可上拉）。
        if let Some(arrow) = self.ivars().handle_arrow.get() {
            arrow.setTitle(&NSString::from_str(&handle_arrow_title(
                snapshot.inspector_open,
            )));
        }
        self.rebuild_inspector(
            mtm,
            snapshot.inspector_open,
            &inspector_views,
            &mut actions,
            &mut select_labels,
        );
        self.rebuild_history_popover(mtm, &anchored_views, &mut actions, &mut select_labels);

        *self.ivars().panel_actions.borrow_mut() = actions;
        *self.ivars().panel_select_options.borrow_mut() = select_labels;
    }

    /// 重建会话历史锚定弹层（`PanelSurface::Anchored` 的那一个面板）。
    ///
    /// 定位：挂在「历史」按钮**下方**、与其右缘对齐（`anchored_popover_frame`），
    /// 四边夹在宿主内；内容仍走 `layout_panels` + `place_panel_elements`。
    /// **不参与布局流**：帧只读锚点与自身内容，不反写任何带（消息流 y 不变）。
    fn rebuild_history_popover(
        &self,
        mtm: MainThreadMarker,
        anchored_views: &[crate::ui::chat::panels::PanelView],
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::{layout_panels, PanelSurface};
        let (Some(popover), Some(body)) = (
            self.ivars().history_popover.get(),
            self.ivars().history_body.get(),
        ) else {
            return;
        };
        for subview in body.subviews().iter() {
            subview.removeFromSuperview();
        }
        let view = anchored_views
            .iter()
            .find(|view| matches!(view.kind.surface(), PanelSurface::Anchored(_)));
        let Some(view) = view else {
            self.ivars().history_body_height.set(0.0);
            popover.ivars().active.set(false);
            popover.setHidden(true);
            return;
        };
        // 锚点：「历史」按钮在宿主坐标里的 frame（按钮在标签条内，两段坐标都是 y 向上）。
        let Some(anchor) = self.history_anchor_frame() else {
            // 独立聊天窗没有会话标签行（能力保留形态）：锚点不存在，不显示弹层。
            self.ivars().history_body_height.set(0.0);
            popover.ivars().active.set(false);
            popover.setHidden(true);
            rust_debug!("会话历史弹层无锚点（无会话标签行），按不显示处理");
            return;
        };
        let Some(host) = self.host_view() else {
            return;
        };
        let host_w = host.bounds().size.width;
        let width = (HISTORY_POPOVER_WIDTH).min((host_w - HISTORY_POPOVER_MARGIN * 2.0).max(120.0));
        let (_, body_w) = floating_body_rect(width, HISTORY_POPOVER_PAD_X);
        // 可用高度：从锚点下沿到宿主下边距（超出的内容由 layout_panels 截断并留痕）。
        let available =
            (anchor.y - HISTORY_POPOVER_GAP - HISTORY_POPOVER_MARGIN - HISTORY_POPOVER_PAD_Y * 2.0)
                .max(40.0);
        let layout = layout_panels(std::slice::from_ref(view), body_w, available);
        if layout.truncated {
            rust_debug!("会话历史弹层内容超上限：已跳过部分块（available={available:.0}）");
        }
        self.place_panel_elements(mtm, &layout.elements, &body, actions, select_labels);
        self.ivars().history_body_height.set(layout.height);
        popover.ivars().active.set(true);
        popover.setHidden(false);
    }

    /// 「历史」按钮在宿主坐标里的 frame（按钮在标签条内；锚定弹层定位用）。
    pub(super) fn history_anchor_frame(&self) -> Option<crate::ui::chat::panels::PanelFrame> {
        use crate::ui::chat::panels::PanelFrame;
        let button = self.ivars().history_button.borrow().clone()?;
        let strip = self.ivars().tabs_strip.get()?;
        let button_frame = button.frame();
        let strip_frame = strip.frame();
        Some(PanelFrame {
            x: strip_frame.origin.x + button_frame.origin.x,
            y: strip_frame.origin.y + button_frame.origin.y,
            width: button_frame.size.width,
            height: button_frame.size.height,
        })
    }

    /// 重建浮层内容（当前开着的入口那**一个**面板；关闭时收起浮层）。
    ///
    /// 内容摆放复用 [`crate::ui::chat::panels::layout_panels`] 与
    /// [`Self::place_panel_elements`]（与流内面板同一套积木），不另写布局。
    fn rebuild_inspector(
        &self,
        mtm: MainThreadMarker,
        open: bool,
        inspector_views: &[crate::ui::chat::panels::PanelView],
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::{layout_panels, panel_scroll_geometry};
        let (Some(body), Some(title)) = (
            self.ivars().inspector_body.get(),
            self.ivars().inspector_title.get(),
        ) else {
            return;
        };
        for subview in body.subviews().iter() {
            subview.removeFromSuperview();
        }
        let was_shown = self.ivars().inspector_shown.get();
        // 浮层收着、或还没有可显示的面板（还没到投影）：按关闭处理，不留空浮层。
        if !open || inspector_views.is_empty() {
            self.ivars().inspector_body_height.set(0.0);
            self.ivars().inspector_doc_height.set(0.0);
            self.set_inspector_shown(false, was_shown);
            return;
        }
        // 三块内容同浮层：整组进 `layout_panels`（保序 = `panel_views()` 的声明序）。
        let views: &[crate::ui::chat::panels::PanelView] = inspector_views;
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        let overlay_w = (width - INSPECTOR_SIDE_MARGIN * 2.0).max(40.0);
        let (_, body_w) = floating_body_rect(overlay_w, INSPECTOR_BODY_PAD_X);
        let scroll_h = self
            .ivars()
            .scroll
            .get()
            .map(|scroll| scroll.frame().size.height)
            .unwrap_or(0.0);
        let max_body = inspector_body_max_height(scroll_h);
        // 抽屉内容**全量摆放**（不设高度上限）：上限只决定可视区高，其余靠内部滚动
        // 到达 —— 旧的「按上限摆放」会把放不下的块按序跳过（超长的「注册明细」全
        // 展开即触发，内容谁也到不了）；滚动几何走共享 `panel_scroll_geometry`。
        let layout = layout_panels(views, body_w, f64::INFINITY);
        let geometry = panel_scroll_geometry(layout.height, max_body);
        if geometry.max_offset > 0.0 {
            // 超可视高：内容由内部滚动可达（留痕不静默；这里不再有「丢块」的截断）。
            rust_debug!(
                "浮层内容超可视高：已启用内部滚动（content={:.0} view={:.0}）",
                geometry.content_height,
                geometry.view_height
            );
        }
        self.place_panel_elements(mtm, &layout.elements, &body, actions, select_labels);
        title.setStringValue(&NSString::from_str(INSPECTOR_TITLE));
        // 标题/✕ 是常驻控件（只建一次）：全局字体快照变化后重贴字号
        // （`sync_fonts` 会把 NSControl 统一成正文基准，标题原字号会漂）。
        title.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
        )));
        if let Some(close) = self.ivars().inspector_close.get() {
            close.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
                crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
            )));
        }
        self.ivars()
            .inspector_doc_height
            .set(geometry.content_height);
        self.ivars().inspector_body_height.set(geometry.view_height);
        self.set_inspector_shown(true, was_shown);
    }

    /// 浮层开合的呈现与过渡（opacity + 轻微位移；`CATransaction` 显式短时长）。
    ///
    /// 只在**状态翻转**时播放过渡（`was_shown != show`）：每次重建重放会闪烁。
    /// 收起后不立即 `setHidden(true)`（否则过渡不可见），改由命中开关立即失活
    /// （`FloatingPanelIvars::active`，点击直接穿透）；下一次以「已关闭」状态重建时
    /// 才真正隐藏。不做 completion 回调：仓里没有 block2 依赖，用状态机替代。
    fn set_inspector_shown(&self, show: bool, was_shown: bool) {
        let (Some(overlay), Some(scrim)) = (
            self.ivars().inspector_overlay.get(),
            self.ivars().inspector_scrim.get(),
        ) else {
            return;
        };
        // 记录呈现态：上一次的 `show` 是本次是否播放过渡的唯一判据
        // （不写回的话每次重建都会重放过渡，收起也不会播放）。
        self.ivars().inspector_shown.set(show);
        // 任何一次状态落地都先撤销在途的「收起后隐藏」定时器。
        if let Some(timer) = self.ivars().inspector_hide_timer.borrow_mut().take() {
            timer.invalidate();
        }
        overlay.ivars().active.set(show);
        scrim.ivars().active.set(show);
        scrim.setHidden(!show);
        let target = CATransform3D::new_translation(0.0, 0.0, 0.0);
        let start = inspector_anim_start_transform();
        let apply = |opacity: f32, transform: CATransform3D, animate: bool| {
            let Some(layer) = theme_layer(&overlay) else {
                return;
            };
            if animate {
                CATransaction::begin();
                CATransaction::setAnimationDuration(INSPECTOR_ANIM_DURATION);
                // 过渡是显式动画：本事务里不关隐式动作（与逐帧路径相反）。
                CATransaction::setDisableActions(false);
                layer.setOpacity(opacity);
                layer.setTransform(transform);
                CATransaction::commit();
            } else {
                without_implicit_animation(|| {
                    layer.setOpacity(opacity);
                    layer.setTransform(transform);
                });
            }
        };
        if show {
            overlay.setHidden(false);
            // 翻转才播过渡；已显示时把内容重建的直接钉在目标态（不闪）。
            apply(1.0, target, !was_shown);
        } else if was_shown {
            apply(0.0, start, true);
            // 过渡播完再真正隐藏（无 block2 依赖：一次性定时器收尾；期间又开了则跳过）。
            let timer = unsafe {
                NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                    INSPECTOR_ANIM_DURATION + 0.06,
                    as_any(self),
                    sel!(hideInspectorAfterClose:),
                    None,
                    false,
                )
            };
            *self.ivars().inspector_hide_timer.borrow_mut() = Some(timer);
        } else {
            apply(0.0, start, false);
            overlay.setHidden(true);
        }
    }

    /// 把 `layout_panels` 产出的元素摆进目标容器（流内面板栈与浮层内容区共用）。
    fn place_panel_elements(
        &self,
        mtm: MainThreadMarker,
        elements: &[crate::ui::chat::panels::PanelElement],
        target: &ChatStackView,
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::PanelElement;
        for element in elements {
            match element {
                PanelElement::Line { text, style, frame } => {
                    let label = panel_line_label(mtm, text, *style);
                    target.addSubview(&label);
                    label.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                }
                PanelElement::Card { frame } => {
                    // 底板按元素顺序**先建**：AppKit 后加的子视图在上层，
                    // 先加的沉在下面 —— 卡片不会被它内部的内容盖住
                    // （顺序由 `panels::layout_panels` 保证）。
                    let card = panel_card(mtm, *frame);
                    target.addSubview(&card);
                }
                PanelElement::Button {
                    label,
                    action,
                    link,
                    frame,
                } => {
                    let control = panel_button(mtm, self, label, action, *link, actions);
                    target.addSubview(&control);
                    control.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                    // **落帧之后**才贴皮：渐变/子层底按当前 bounds 建，先贴后改帧
                    // 会只盖住旧尺寸（实机：面板 chip 的底色只盖住一半）。
                    apply_panel_button_face(&control, action, *link);
                }
                PanelElement::Select {
                    label,
                    options,
                    selected,
                    label_frame,
                    frame,
                } => {
                    let text = panel_line_label(mtm, label, PanelLineStyle::Normal);
                    target.addSubview(&text);
                    text.setFrame(NSRect::new(
                        NSPoint::new(label_frame.x, label_frame.y),
                        NSSize::new(label_frame.width, label_frame.height),
                    ));
                    let control =
                        panel_select(mtm, self, options, *selected, actions, select_labels);
                    target.addSubview(&control);
                    control.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                    // 同 Button：下拉 chip 的 `--bbg` 族是渐变，贴皮必须在落帧之后。
                    paint::style_button(&control, paint::Face::Chip);
                }
            }
        }
    }

    // ── A1：会话标签条 ──

    /// 重建会话标签条（整帧重建时调用；独立聊天窗模式直接跳过）。
    ///
    /// 顶栏（品牌/状态位/按钮）不在这里：它归主窗的全窗宽顶栏（`macos_main.rs`），
    /// 状态位文本由 `macos.rs::refresh_titlebar` 直接推给那一份展示副本。
    pub(super) fn rebuild_tabs(
        &self,
        mtm: MainThreadMarker,
        snapshot: &crate::ui::chat::ChatSnapshot,
    ) {
        if !self.ivars().nav_embedded.get() {
            return;
        }
        let width = self.ivars().width.get().max(self.ivars().min_width.get());

        // ── 标签条：会话标签（左）+ 「+」「历史」（右，优先保留）──
        let Some(strip) = self.ivars().tabs_strip.get() else {
            return;
        };
        for subview in strip.subviews().iter() {
            subview.removeFromSuperview();
        }
        self.ivars().session_targets.borrow_mut().clear();
        let y = (TABS_HEIGHT - NAV_BUTTON_HEIGHT) / 2.0;
        let right_reserve = TABS_NEW_WIDTH + TABS_HISTORY_WIDTH + 12.0;
        let mut x = 4.0;
        let tokens = crate::ui::theme::tokens();
        for tab in &snapshot.sessions {
            let name_width = session_tab_name_width(&tab.name);
            let close_width = if tab.closable { TAB_CLOSE_WIDTH } else { 0.0 };
            let pill_width = session_tab_pill_width(&tab.name, tab.closable);
            if x + pill_width + 2.0 > width - right_reserve {
                // 空间不够：右侧「+」「历史」入口优先，其余标签本帧不显示。
                break;
            }
            let tag = self.ivars().session_targets.borrow().len();
            let title = if tab.interrupted {
                format!("{} !", tab.name)
            } else {
                tab.name.clone()
            };
            // 标签 pill（2026-10-05 用户规则：「× 要在气泡里面」）：选中态的高亮底
            // 画在 pill 容器上、**包住名字与 ×**；名字/× 是无底文字按钮，叠在 pill 上。
            // 底走 `--tabon` 族 + 小圆角（设计稿 `.tab.on`），未选中不画底（`.tab`）。
            let pill = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(
                    NSPoint::new(x, y),
                    NSSize::new(pill_width, NAV_BUTTON_HEIGHT),
                ),
            );
            if tab.active {
                if let Some(layer) = theme_layer(&pill) {
                    paint::paint_backdrop(
                        &layer,
                        &paint::Backdrop {
                            fill: tokens.tab_on_bg,
                            sheen: None,
                            grain: None,
                            stroke: Some(tokens.tab_on_edge),
                            stroke_width: 1.0,
                            bevel: tokens.tab_on_bevel,
                            elevation: tokens.tab_on_shadow,
                            corner_radius: f64::from(tokens.radii.sm),
                            flipped: false,
                        },
                    );
                }
            }
            strip.addSubview(&pill);
            let name_face = if tab.active {
                paint::Face::Text { ink: tokens.ink }
            } else {
                paint::Face::Text { ink: tokens.dim }
            };
            let name_button =
                nav_button(mtm, self, &title, sel!(sessionTab:), name_width, name_face);
            name_button.setTag(tag as isize);
            strip.addSubview(&name_button);
            name_button.setFrame(NSRect::new(
                NSPoint::new(x, y),
                NSSize::new(name_width, NAV_BUTTON_HEIGHT),
            ));
            if tab.closable {
                // × 落在 pill 内部（名字右侧、同一个高亮底之内）。
                let close_button = nav_button(
                    mtm,
                    self,
                    "×",
                    sel!(closeSessionTab:),
                    close_width,
                    paint::Face::Text { ink: tokens.dim },
                );
                close_button.setTag(tag as isize);
                strip.addSubview(&close_button);
                close_button.setFrame(NSRect::new(
                    NSPoint::new(x + name_width, y),
                    NSSize::new(close_width, NAV_BUTTON_HEIGHT),
                ));
            }
            x += pill_width + 2.0;
            self.ivars()
                .session_targets
                .borrow_mut()
                .push(tab.id.clone());
        }
        let history_x = (width - TABS_HISTORY_WIDTH - 4.0).max(0.0);
        let plus_x = (history_x - TABS_NEW_WIDTH - 4.0).max(0.0);
        // `.tabadd` / `.tabhist` 用小圆角 `--r1`（设计稿 70-72 行）。
        let plus = nav_button(
            mtm,
            self,
            "+",
            sel!(newSession:),
            TABS_NEW_WIDTH,
            paint::Face::Chip,
        );
        strip.addSubview(&plus);
        plus.setFrame(NSRect::new(
            NSPoint::new(plus_x, y),
            NSSize::new(TABS_NEW_WIDTH, NAV_BUTTON_HEIGHT),
        ));
        // 历史面板开着 = 选中态（`--tabon` 族），关着 = 普通按钮族。
        let history_open = snapshot.panels.iter().any(|view| {
            view.kind == super::super::super::super::chat::panels::PanelKind::SessionHistory
        });
        let history_face = if history_open {
            paint::Face::TabOn
        } else {
            paint::Face::Chip
        };
        let history = nav_button(
            mtm,
            self,
            "历史",
            sel!(toggleHistory:),
            TABS_HISTORY_WIDTH,
            history_face,
        );
        strip.addSubview(&history);
        history.setFrame(NSRect::new(
            NSPoint::new(history_x, y),
            NSSize::new(TABS_HISTORY_WIDTH, NAV_BUTTON_HEIGHT),
        ));
        // 锚定弹层的锚点：标签条子视图每帧重建，这里同步替换引用（旧按钮随重建移出层级）。
        *self.ivars().history_button.borrow_mut() = Some(history);
    }

    /// 面板动作的统一归宿（面板按钮与「历史」按钮共用；失败不做乐观 UI 变更）。
    ///
    /// **本地显示态动作派发成功后就地整帧重建**（见 [`panel_action_is_local_display`]）：
    /// 模型对它们未必 bump `panel_revision`（实机 bug：投递档在下拉里选完显示不刷新，
    /// 要收回浮层再打开才更新），刷新回调可能永远不到 —— 主动重建保证「点完立刻看见」。
    pub(super) fn dispatch_panel_action(&self, action: PanelAction) {
        let local_display = panel_action_is_local_display(&action);
        match crate::ui::chat::apply_panel_action(action) {
            Ok(PanelOutcome::FillInput(text)) => {
                self.fill_input(&text);
                crate::ui::chat::set_notice(None);
            }
            // 提问「其它」：不改文本，只把焦点交回输入框（用户下一条消息就是自由回答）。
            Ok(PanelOutcome::FocusInput) => {
                self.focus_input();
                crate::ui::chat::set_notice(None);
            }
            Ok(PanelOutcome::None) => {
                if local_display {
                    self.rebuild_from_model();
                }
                crate::ui::chat::set_notice(None);
            }
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

    /// 把文本填回输入框并把光标移到末尾（slash 补全；不执行命令）。
    fn fill_input(&self, text: &str) {
        let Some(input) = self.ivars().input.get() else {
            return;
        };
        input.setString(&NSString::from_str(text));
        let length = NSString::from_str(text).length();
        input.setSelectedRange(NSRange {
            location: length,
            length: 0,
        });
        // 程序化填入不触发 textDidChange：显式同步「发送」按钮可用态。
        self.update_send_enabled();
        // 独立窗模式取本控制器窗口；面板模式没有窗口，取输入框所在窗口。
        if let Some(window) = self.window() {
            window.makeFirstResponder(Some(input));
        } else if let Some(window) = input.window() {
            window.makeFirstResponder(Some(input));
        }
    }

    /// 按当前最早的面板期限布一次一次性定时器（无期限/无面板时停表）。
    pub(super) fn arm_deadline_timer(&self) {
        let mut timer = self.ivars().deadline_timer.borrow_mut();
        if let Some(existing) = timer.take() {
            existing.invalidate();
        }
        let Some(next) = crate::ui::chat::next_deadline_ms() else {
            return;
        };
        let now = crate::ui::platform::now_ms();
        let delay = next.saturating_sub(now).max(20) as f64 / 1000.0;
        let fresh = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                delay,
                as_any(self),
                sel!(deadlineFired:),
                None,
                false,
            )
        };
        *timer = Some(fresh);
    }
}

/// 卡片底板（`PanelElement::Card`）：面板内的次级面 + 中性细边 + 小圆角。
///
/// 底**不能**用 `panel_bg`（与弹层底同色就看不出边界了）：取输入框 / 待发 chip
/// 一族的 `field_bg` —— 五套主题里它与面板底都有明确极性差（暗主题是凹下去的一格、
/// 亮主题是一张抬起的白卡），会话之间因此有一眼可辨的分界。描边取 `btn_edge`
/// （普通按钮描边：五套主题里都是与所在底可分辨的中性细线）。几何全部来自
/// `panels::layout_panels` 的 frame，本函数不重算、不夹取。
fn panel_card(mtm: MainThreadMarker, frame: PanelFrame) -> Retained<NSView> {
    let tokens = crate::ui::theme::tokens();
    let card = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        ),
    );
    if let Some(layer) = theme_layer(&card) {
        paint::paint_backdrop(
            &layer,
            &paint::Backdrop {
                fill: tokens.field_bg,
                sheen: None,
                grain: None,
                stroke: Some(tokens.btn_edge),
                stroke_width: 1.0,
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                corner_radius: f64::from(tokens.radii.sm),
                // 卡片落在翻转容器（`ChatStackView`，y 自上而下）里：渐变方向与
                // 立体线朝向跟着翻（与标签条 pill 的 `flipped: false` 同因不同果）。
                flipped: true,
            },
        );
    }
    card
}

/// 面板标签（单行；样式 → 主题语义色 + 字重 + 截断口径）。
///
/// 层级（2026-10-05 用户规则「权限确认卡片：标题/正文/副文本层级分明」）：
/// - `Warn` = **标题**：加粗（权限卡首行就是「谁要做什么」的判词，加粗才立得住）；
/// - `Normal` = 正文：`ink`；
/// - `Dim` = 副文本：`dim` 且**中段截断** —— 这类行装的是 `command=…`、`会话 <id>`
///   这类长键值/标识串，尾部截断会把后半段（脚本尾巴、id 尾段）切掉，中段省略
///   保住头尾（旧实现一律尾部截断，实机看就是「会话 id 行溢出难看」）；
/// - `Ok` = 成功：`ok`，尾部截断。
///
/// 行高由 `panels::layout_panels` 算定（16pt），字号维持 `HELP_BASE_SIZE` ——
/// 只换色/字重/截断，不改「一行」这个既定几何。
fn panel_line_label(
    mtm: MainThreadMarker,
    text: &str,
    style: PanelLineStyle,
) -> Retained<NSTextField> {
    let tokens = crate::ui::theme::tokens();
    let (color, bold, break_mode) = match style {
        PanelLineStyle::Normal => (
            paint::color(tokens.ink),
            false,
            NSLineBreakMode::ByTruncatingTail,
        ),
        PanelLineStyle::Dim => (
            paint::color(tokens.dim),
            false,
            NSLineBreakMode::ByTruncatingMiddle,
        ),
        PanelLineStyle::Warn => (
            paint::color(tokens.warn),
            true,
            NSLineBreakMode::ByTruncatingTail,
        ),
        PanelLineStyle::Ok => (
            paint::color(tokens.ok),
            false,
            NSLineBreakMode::ByTruncatingTail,
        ),
    };
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    let size = crate::ui::platform::macos_widgets::HELP_BASE_SIZE;
    let font = if bold {
        crate::ui::platform::macos_widgets::resolve_bold_font(size)
    } else {
        crate::ui::platform::macos_widgets::resolve_font(size)
    };
    label.setFont(Some(&font));
    label.setTextColor(Some(&color));
    label.setLineBreakMode(break_mode);
    label
}

/// 构造一个面板按钮并登记动作（tag = 动作表下标）。
///
/// 宽度不走这里：frame 由平台无关的 `panels::layout_panels` 算好（含换行与
/// 越界夹取），本函数只负责把标签/动作做成原生控件；**贴皮不在这里做** ——
/// 调用方落帧之后调 [`apply_panel_button_face`]（先贴后改帧会只盖住旧尺寸）。
/// `link=false` 的 chip 走 [`PanelChipButton`]（自绘底 + 全幅按下反馈）。
fn panel_button(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    label: &str,
    action: &PanelAction,
    link: bool,
    actions: &mut Vec<PanelAction>,
) -> Retained<NSButton> {
    let control: Retained<NSButton> = if link {
        // 文字链：无底无边的纯文字按钮（按下反馈 = 系统压暗标题，无底就够用）。
        unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(label),
                Some(as_any(controller)),
                Some(sel!(panelAction:)),
                mtm,
            )
        }
    } else {
        // chip：自绘底要全幅按下反馈 → 专门一类（见 `PanelChipButton`）。
        PanelChipButton::new(mtm, label, as_any(controller), sel!(panelAction:)).into_super()
    };
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
    )));
    let tag = actions.len();
    actions.push(action.clone());
    control.setTag(tag as isize);
    control
}

// ── 面板 chip / 下拉：borderless 自绘底的**全幅按下反馈** ──

/// 按下压深罩的 alpha（黑罩；与设置窗同一档观感，深浅主题同一技术）。
const PANEL_CHIP_PRESS_DIM_ALPHA: f32 = 0.20;
/// 按下罩层的子层名（幂等清理用；与 `paint` 的前缀命名空间不重叠）。
const PANEL_CHIP_PRESS_LAYER_NAME: &str = "chatpanelchip-pressed";

define_class!(
    /// 面板 chip / 下拉的自绘按钮（borderless + `paint::style_button` 自绘底）。
    ///
    /// 为什么要专门一类：`paint::style_button` 关掉系统 bezel 后，AppKit 对按下的
    /// 唯一动作是 `NSContentsCellMask`（只压暗标题），按钮底纹不动 —— 实机观感是
    /// 「按下没反应」（2026-10-05 设置窗同款问题，见 `macos_settings::SettingsButton`；
    /// 本仓两处各自实现、不跨模块引类型）。覆写 `highlight(_:)`：按下在**面的圆角内**
    /// 盖一层全幅压深罩、松开摘掉 —— 罩层是独立子层，不改贴皮状态，按构造不会「半截」。
    #[unsafe(super(NSButton))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct PanelChipButton;

    unsafe impl NSObjectProtocol for PanelChipButton {}

    impl PanelChipButton {
        #[unsafe(method(highlight:))]
        fn highlight(&self, flag: bool) {
            set_panel_chip_pressed(self, flag);
            // 交还超类：标题的压暗行为（`NSContentsCellMask`）保持系统口径。
            let _: () = unsafe { msg_send![super(self), highlight: flag] };
        }
    }
);

impl PanelChipButton {
    /// 建一枚面板 chip / 下拉按钮（`buttonWithTitle:` 的改类替代：目标/动作手装，
    /// 因为 `+[NSButton buttonWithTitle:…]` 只会造 NSButton，拿不到本类）。
    fn new(
        mtm: MainThreadMarker,
        title: &str,
        target: &AnyObject,
        action: objc2::runtime::Sel,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let control: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(80.0, BOTTOM_BUTTON_HEIGHT)
                )
            ]
        };
        control.setTitle(&NSString::from_str(title));
        unsafe {
            control.setTarget(Some(target));
            control.setAction(Some(action));
        }
        control.setBezelStyle(NSBezelStyle::Push);
        control
    }
}

/// 面板 chip 的按下罩：**面的圆角内盖全幅压深**（幂等：按名字先清后建）。
fn set_panel_chip_pressed(button: &NSButton, pressed: bool) {
    let Some(layer) = button.layer() else {
        return;
    };
    without_implicit_animation(|| {
        clear_panel_chip_press_layer(&layer);
        if !pressed {
            return;
        }
        let overlay = CALayer::new();
        overlay.setName(Some(&NSString::from_str(PANEL_CHIP_PRESS_LAYER_NAME)));
        overlay.setFrame(layer.bounds());
        // 面的最小圆角口径（chip = `radii.sm`）：底没带圆角时也跟上，方罩不露直角。
        let radius = if layer.cornerRadius() > 0.0 {
            layer.cornerRadius()
        } else {
            f64::from(crate::ui::theme::tokens().radii.sm)
        };
        overlay.setCornerRadius(radius);
        overlay.setBackgroundColor(Some(
            &paint::color(Rgba::black_alpha(PANEL_CHIP_PRESS_DIM_ALPHA)).CGColor(),
        ));
        // z = 0：盖在标题（contents）与负 z 的填充/立体线之上，整枚一起压深。
        layer.addSublayer(&overlay);
    });
}

/// 清理按下罩（先收集再移除：`CALayer.sublayers` 不是快照，边枚举边改会抛
/// 「mutation detected during enumeration」，见 native-host AGENTS §9）。
fn clear_panel_chip_press_layer(layer: &CALayer) {
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let stale: Vec<Retained<CALayer>> = sublayers
        .iter()
        .filter(|sub| {
            sub.name()
                .is_some_and(|name| name.to_string() == PANEL_CHIP_PRESS_LAYER_NAME)
        })
        .collect();
    for sub in stale {
        sub.removeFromSuperlayer();
    }
}

/// 面板按钮的皮（**必须落帧之后调用**，见 [`place_panel_elements`] 的调用点）。
///
/// - `link=true`：文字链（无底无边、仅文字；旧壳 DebugBar 的「工具 N」「Σ 用量」同款）；
/// - 其余：面板 chip（普通按钮族 + 小圆角，设计稿 `.chip`）。
///
/// 权限确认三按钮按**动作**分主次（2026-10-05 用户规则「三按钮层级分明：拒绝=普通、
/// 本次允许=主、会话内允许=次」）：主次只认 `PanelAction` 变体，不嗅标签文案，
/// 平台不改变模型给的顺序与语义。
fn apply_panel_button_face(control: &NSButton, action: &PanelAction, link: bool) {
    let face = if link {
        paint::Face::Text {
            ink: crate::ui::theme::tokens().ink,
        }
    } else {
        panel_button_action_face(action).unwrap_or(paint::Face::Chip)
    };
    paint::style_button(control, face);
}

/// 「动作决定的面板按钮形态」（纯函数，可测）：权限三按钮各归其档；其余动作返回
/// `None`（调用方按默认 chip 处理）。不嗅标签文案、不看面板种类。
pub(in crate::ui::platform::macos_chat) fn panel_button_action_face(
    action: &PanelAction,
) -> Option<paint::Face> {
    match action {
        PanelAction::PermissionAllowOnce => Some(paint::Face::Primary),
        PanelAction::PermissionDeny => Some(paint::Face::Normal),
        PanelAction::PermissionAllowSession => Some(paint::Face::Chip),
        _ => None,
    }
}

/// 构造一个面板下拉 **chip**（设计稿 `.chip` 一行小片）：标题显示当前档位 +「▾」，
/// 点击弹 NSMenu 选择。**不用系统 NSPopUpButton**：它的 bezel/箭头是系统外观，
/// 深色主题下与设计稿的 chip 观感不符（2026-10-05 用户点名「样式也不一样」）。
///
/// 选项标签存进 `select_labels`（`(tag, labels)`），点击回调按表重建菜单；
/// 动作仍按「tag + 选中下标」查 `panel_actions`（与旧下拉同一口径）。
fn panel_select(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    options: &[crate::ui::chat::panels::PanelOption],
    selected: usize,
    actions: &mut Vec<PanelAction>,
    select_labels: &mut Vec<(isize, Vec<String>)>,
) -> Retained<NSButton> {
    let current = options
        .get(selected)
        .map(|option| option.label.as_str())
        .unwrap_or("—");
    // chip 走自绘类（自绘底 + 全幅按下反馈；`buttonWithTitle:` 只造 NSButton）。
    let control = PanelChipButton::new(
        mtm,
        &format!("{current} ▾"),
        as_any(controller),
        sel!(panelSelect:),
    );
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
    )));
    // 贴皮由调用方落帧之后做（chip 是 `--bbg` 族渐变；先贴后改帧只盖住旧尺寸）。
    let tag = actions.len() as isize;
    let mut labels = Vec::with_capacity(options.len());
    for option in options {
        labels.push(option.label.clone());
        actions.push(option.action.clone());
    }
    select_labels.push((tag, labels));
    control.setTag(tag);
    control.into_super()
}

/// A1：标签条按钮的构造（tag 由调用方按用途设置；不加入面板动作表）。
fn nav_button(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    title: &str,
    action: objc2::runtime::Sel,
    width: f64,
    face: paint::Face,
) -> Retained<NSButton> {
    let control = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(as_any(controller)),
            Some(action),
            mtm,
        )
    };
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
    )));
    // 先落帧再贴皮：`buttonWithTitle:` 给的是固有尺寸，先贴后改帧会让渐变/子层底
    // 只盖住旧尺寸（与面板 chip 同因，见 `apply_panel_button_face` 的注释）。
    control.setFrameSize(NSSize::new(width, NAV_BUTTON_HEIGHT));
    paint::style_button(&control, face);
    control
}

/// A1：会话标签名称宽度（按字符宽度估算后夹到上下限；过长的名称由按钮尾部省略）。
fn session_tab_name_width(name: &str) -> f64 {
    (crate::ui::chat::panels::estimated_text_width(name, 11.0) + 16.0)
        .clamp(TAB_MIN_WIDTH, TAB_MAX_WIDTH)
}

/// 会话标签 pill 的宽度：名字 + 可关闭时的 × 宽度（**× 在 pill 里面**，
/// 选中态高亮包住两者 —— 2026-10-05 用户规则）。
pub(in crate::ui::platform::macos_chat) fn session_tab_pill_width(
    name: &str,
    closable: bool,
) -> f64 {
    session_tab_name_width(name) + if closable { TAB_CLOSE_WIDTH } else { 0.0 }
}
