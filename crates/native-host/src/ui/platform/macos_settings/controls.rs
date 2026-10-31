use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSAccessibility, NSBezelStyle, NSButton, NSButtonType, NSColor, NSEvent, NSEventModifierFlags,
    NSFocusRingType, NSScrollView, NSSecureTextField, NSTextAlignment, NSTextField, NSTextView,
    NSView,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use objc2_quartz_core::CALayer;

use crate::ui::settings::panels::{RowAction, RowOption};
use crate::ui::settings::schema::FieldKind;
use crate::ui::settings::{settings_ui, SettingsView, ShortcutModifiers};
use crate::ui::theme::{self, paint, Rgba, Tokens};
use crate::{rust_debug, rust_warn};

use crate::ui::platform::macos_widgets::{
    as_any, resolve_font, without_implicit_animation, BODY_BASE_SIZE, HELP_BASE_SIZE,
};

use super::*;

// 面板在显期间的点击挡板：盖住设置窗内容区，吞掉全部鼠标事件。
//
// **为什么需要它**：文档预览面板用 `applicationDefined` 弹出层（不自行收起）。
// 先用 transient / semitransient 实机试过，两者在「点外部」时都会把那次点击
// **透传到背后设置窗**（实测：点竖栏按钮会真的切换 Tab）—— 那正是「编辑文档时
// 误操作背后的设置窗」。挡板把设置窗一侧的鼠标事件吃掉（弹出层是另一个窗口，
// 不受影响），合起来复刻旧模态的交互语义：点外部什么也不发生，必须用
// 保存 / 关闭 / Esc 收尾。载入仍是**非模态**弹出层（滚动不卡）——这是与旧模态
// 唯一的形态差异，也是本次修复的本体。
//
// 挡板不接受第一响应者、也不绘制：面板（弹出层窗口）保持键盘焦点与视觉不变。
define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    pub(super) struct ClickShieldView;

    unsafe impl NSObjectProtocol for ClickShieldView {}

    impl ClickShieldView {
        /// 吞掉鼠标按下：不沿响应链上传，背后控件不会被点到。
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {}

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, _event: &NSEvent) {}

        /// 滚轮一并吞掉：设置页滚动区在面板在显期间不动（视口不会被背后滚走）。
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {}

        /// 后台窗口的首次点击也吞（不让这一下点穿透到控件）。
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: &NSEvent) -> bool {
            true
        }

        /// 不接受第一响应者：面板保持键盘焦点（编辑中的正文不被打断）。
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            false
        }
    }
);

impl ClickShieldView {
    pub(super) fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

/// 主文字色（分组标题 / 字段标签 / 信息值）：`ink`。
pub(super) fn ink() -> Retained<NSColor> {
    paint::color(theme::tokens().ink)
}

/// 次要说明文字色（副标题 / 提示 / 状态行）：`dim`。
pub(super) fn dim() -> Retained<NSColor> {
    paint::color(theme::tokens().dim)
}

/// 设置窗按钮的动作角色（决定是否贴主题按钮面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ButtonRole {
    /// 提交类主操作（窗口级「保存」）：贴 `--sbg` 主按钮面（`paint::Face::Primary`）。
    Save,
    /// 其余表单 / 行内按钮：保持系统 bezel（标准控件随窗口外观极性明暗）。
    /// 「保存文档」是文档编辑区的子上下文动作，不抢窗口主操作，归此类。
    Form,
}

/// 角色 → 主题按钮面（纯函数，可测；`None` = 保持系统外观，不贴主题面）。
///
/// 2026-10-05 评审修复：`Form` 旧映射到 `None`（系统 bezel），实机在深色主题下
/// 是一块浅灰、与聊天面的主题 chip 两种长相（「同一控件族在两个面长得不一样」）。
/// 现改贴 `Face::Chip`（`--bbg` 族 + `--r1`），与聊天 chip 同族同形。
pub(super) fn button_face(role: ButtonRole) -> Option<paint::Face> {
    match role {
        ButtonRole::Save => Some(paint::Face::Primary),
        ButtonRole::Form => Some(paint::Face::Chip),
    }
}

/// 竖栏第 `index` 行按钮的顶距（纯函数，按设计稿 `9px + i×(26+1)`）。
pub(super) fn rail_item_y(index: usize) -> f64 {
    RAIL_TOP + index as f64 * (RAIL_ITEM_H + RAIL_ITEM_GAP)
}

/// 竖栏行按钮的主题面（纯函数，可测）：选中 = `--tabon` 三件套（[`paint::Face::TabOn`]），
/// 未选中 = 无底无边、`dim` 字（[`paint::Face::Text`]）。未选中行不贴 `ink`：
/// 设计稿 `.srail span` 未选中就是 `--dim`。
pub(super) fn rail_button_face(index: usize, selected: usize, tokens: &Tokens) -> paint::Face {
    if index == selected {
        paint::Face::TabOn
    } else {
        paint::Face::Text { ink: tokens.dim }
    }
}

/// 开关在未接线（禁用）时的整控件透明度（纯函数，可测；自绘面没有系统控件的自动变灰）。
pub(super) fn switch_alpha(connected: bool) -> f64 {
    if connected {
        1.0
    } else {
        0.45
    }
}

// ── 自绘按钮：统一的按下反馈 ──

/// 按下压深的罩层 alpha（黑罩；深浅主题同一技术）。
///
/// 放在本文件而不是 tokens：它不是一个颜色槽位，而是「按下 = 整底压深一档」的
/// 渲染技术（tokens 与设计稿都没有独立的按下态槽位）。深色主题的按钮底变暗、
/// 浅色主题的白底变灰，四个方向都对得上「按下去」的语义。
const PRESSED_DIM_ALPHA: f32 = 0.20;
/// 按下罩层的子层名（幂等清理用；与 `paint` 的前缀命名空间不重叠）。
const PRESSED_LAYER_NAME: &str = "settingsbtn-pressed";

pub(super) struct SettingsButtonIvars {
    /// 最近一次贴的面（松开时据此重贴恢复；`None` = 尚未贴过面）。
    face: Cell<Option<paint::Face>>,
}

// 设置窗的自绘按钮（贴主题面的按钮全走它）。
//
// 按下反馈必须自绘：`paint::style_button` 把系统 bezel 关掉（borderless）后，
// 系统对按下的唯一动作是压暗标题，力度随控件与主题飘 —— 同一屏里有的按钮按下
// 变色、有的只是字略暗，即用户报的「按钮不统一 / 颜色半截」。这里覆写
// `highlight(_:)`：按下在按钮的圆角内盖一层全幅压深罩（按构造不可能半截），
// 松开按记录的 face 重贴恢复；disabled 不参与（系统不会高亮不可用按钮），
// 禁用口径（中性底 + 亮字，见 `paint::style_button` 注释）保持不动。
define_class!(
    #[unsafe(super(NSButton))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SettingsButtonIvars]
    pub(super) struct SettingsButton;

    unsafe impl NSObjectProtocol for SettingsButton {}

    impl SettingsButton {
        #[unsafe(method(highlight:))]
        fn highlight(&self, flag: bool) {
            if flag {
                set_button_pressed(self, true);
            } else if let Some(face) = self.ivars().face.get() {
                // 松开：按最近一次贴的面重贴（同时清掉罩层）。
                set_button_face(self, face);
            } else {
                // 尚未贴过面（异常时序）：也得把罩层清掉，不留「卡住的压深」。
                set_button_pressed(self, false);
            }
        }

        /// 落帧后重贴（帧变化时重排子层）。
        ///
        /// `style_button` 的立体线（子层）与投影路径都是**按贴皮当时的尺寸**建的；
        /// 之后 `setFrame:` 改大小时视图自身的底/边会跟随 bounds，子层不会 ——
        /// 实机症状是「主题色只盖住左上角一块」（用户 2026-10-05 截图 14：宽控件
        /// 的顶边线/底饰带只覆盖旧宽度的左半截；与聊天面板同族根因）。统一在 frame
        /// 落定后按记录的面重贴，所有布置点的「先贴还是先摆」次序不再影响结果。
        #[unsafe(method(setFrame:))]
        fn set_frame(&self, frame: NSRect) {
            let _: () = unsafe { msg_send![super(self), setFrame: frame] };
            if let Some(face) = self.ivars().face.get() {
                set_button_face(self, face);
            }
        }
    }
);

impl SettingsButton {
    /// 建一枚自绘按钮（`push_button` 的同形替代：Push bezel 语义 + 主题面自绘）。
    fn new(
        mtm: MainThreadMarker,
        title: &str,
        target: &AnyObject,
        action: objc2::runtime::Sel,
        font: &Retained<objc2_app_kit::NSFont>,
        align_left: bool,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SettingsButtonIvars {
            face: Cell::new(None),
        });
        let button: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(120.0, 24.0))
            ]
        };
        button.setTitle(&NSString::from_str(title));
        // 先定型再定 bezel：`setButtonType` 可能重置 bezel 样式，顺序反了会丢 Push 语义。
        button.setButtonType(NSButtonType::MomentaryPushIn);
        button.setBezelStyle(NSBezelStyle::Push);
        button.setFont(Some(font));
        if align_left {
            button.setAlignment(NSTextAlignment::Left);
        }
        // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
        unsafe {
            button.setTarget(Some(target));
            button.setAction(Some(action));
        }
        button
    }
}

/// 贴面并记录：本文件内所有 `paint::style_button` 调用统一经这里 ——
/// 按下恢复（`highlight:`）与主题重贴拿到的是同一份面，不存在第二份状态。
///
/// 顺带清掉可能残留的按下罩层：刷新（`refresh_ui` 在按下期间到达）重贴后不会
/// 留下一枚卡住的压深罩。
pub(super) fn set_button_face(button: &NSButton, face: paint::Face) {
    paint::style_button(button, face);
    set_button_pressed(button, false);
    if let Some(themed) = button.downcast_ref::<SettingsButton>() {
        themed.ivars().face.set(Some(face));
    }
}

/// 按下罩层：在按钮圆角内盖一层半透明压深（全幅覆盖到圆角，不产生「半截色」）。
/// 幂等：重复按下/恢复不叠加（先按名字清理旧件）。
fn set_button_pressed(button: &NSButton, pressed: bool) {
    let Some(layer) = button.layer() else {
        return;
    };
    without_implicit_animation(|| {
        clear_pressed_layer(&layer);
        if !pressed {
            return;
        }
        let overlay = CALayer::new();
        overlay.setName(Some(&NSString::from_str(PRESSED_LAYER_NAME)));
        overlay.setFrame(layer.bounds());
        // 无底的面（分段未选中段 / 竖栏未选中行）圆角为 0：罩层跟上控件的最小圆角
        // 口径（`radii.sm`），免得方形罩层在圆角轨道里露出直角。
        let radius = if layer.cornerRadius() > 0.0 {
            layer.cornerRadius()
        } else {
            f64::from(theme::tokens().radii.sm)
        };
        overlay.setCornerRadius(radius);
        overlay.setBackgroundColor(Some(
            &paint::color(Rgba::black_alpha(PRESSED_DIM_ALPHA)).CGColor(),
        ));
        // z = 0：盖在标题（contents）与负 z 的背景/立体线之上，整枚一起压深。
        layer.addSublayer(&overlay);
    });
}

/// 清理按下罩层（先收集再移除：`CALayer.sublayers` 不是快照，边枚举边改会抛
///「mutation detected during enumeration」，见 native-host AGENTS §9）。
fn clear_pressed_layer(layer: &CALayer) {
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let stale: Vec<Retained<CALayer>> = sublayers
        .iter()
        .filter(|sub| {
            sub.name()
                .is_some_and(|name| name.to_string() == PRESSED_LAYER_NAME)
        })
        .collect();
    for sub in stale {
        sub.removeFromSuperlayer();
    }
}

/// 按角色创建按钮：主操作贴主题主按钮面，其余贴同类 chip 面（[`ButtonRole`]）。
pub(super) fn themed_button(
    mtm: MainThreadMarker,
    title: &str,
    target: &AnyObject,
    action: objc2::runtime::Sel,
    role: ButtonRole,
) -> Retained<NSButton> {
    let button = SettingsButton::new(
        mtm,
        title,
        target,
        action,
        &resolve_font(BODY_BASE_SIZE),
        false,
    );
    let button: Retained<NSButton> = button.into_super();
    if let Some(face) = button_face(role) {
        set_button_face(&button, face);
    }
    button
}

/// 竖栏行按钮（原生按钮承载焦点与键盘可达）：`tag` = Tab 下标，
/// 主题面（选中/未选中）由 [`SettingsContentController::style_rail_buttons`] 统一贴。
pub(super) fn rail_button(
    mtm: MainThreadMarker,
    controller: &SettingsContentController,
    title: &str,
    index: usize,
) -> Retained<NSButton> {
    let button = SettingsButton::new(
        mtm,
        title,
        as_any(controller),
        sel!(railTab:),
        &resolve_font(HELP_BASE_SIZE),
        true,
    );
    let button: Retained<NSButton> = button.into_super();
    button.setTag(index as isize);
    button
}

/// 主题开关（`FieldKind::Bool`）：无边框透明按钮承载点击与 `state`，
/// 视觉（轨道 + 滑块）由 [`paint::apply_switch`] 画在它的图层上（每次刷新幂等重绘）。
///
/// 不用 AppKit 复选框：标准控件不可改主题色（模块头）；`Switch` 类型让点击
/// 自行翻转 `state`，`read_control_value` 与提交路径因此不需要第二份状态。
pub(super) fn switch_button(
    mtm: MainThreadMarker,
    label: &str,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSButton> {
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(""),
            Some(target),
            Some(action),
            mtm,
        )
    };
    button.setButtonType(NSButtonType::Switch);
    button.setBordered(false);
    button.setTransparent(true);
    button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
    button.setWantsLayer(true);
    // 标题为空（视觉全在图层上）：无障碍名仍给出字段标签，VoiceOver 读得到用途。
    NSAccessibility::setAccessibilityLabel(&*button, Some(&NSString::from_str(label)));
    button
}

/// 一个行动作槽：点击时回传（面板 id + 行 id）给设置域。
pub(super) struct RowSlot {
    pub(super) panel: &'static str,
    pub(super) row_id: String,
    pub(super) action: RowAction,
    /// 行内下拉（`RowAction::Pick`）的选项表：渲染该行时的快照，点击弹菜单直接用它
    /// （与行同代，不需要第二次查面板数据）；其余行为空表。
    pub(super) pick_options: Vec<RowOption>,
}

// ==========================================
// 控件槽与控制器
// ==========================================

/// 一个已创建的控件槽：`tag` = 槽下标；`key` 为 `None` 时是纯展示视图。
pub(super) struct ControlSlot {
    pub(super) view: Retained<NSView>,
    pub(super) key: Option<&'static str>,
    pub(super) kind: Option<FieldKind>,
    /// 该控件的基础字号（全局字体快照变化时按它重算）。
    pub(super) font_base: f64,
    /// 多行文本的正文视图（`Multiline` 专用；其余为 `None`）。
    pub(super) text_view: Option<Retained<NSTextView>>,
    /// 密钥字段的明/密双控件（`Text { secret: true }` 专用；其余为 `None`）。
    pub(super) secret: Option<SecretFields>,
}

impl ControlSlot {
    pub(super) fn clone_ref(&self) -> Self {
        Self {
            view: self.view.clone(),
            key: self.key,
            kind: self.kind,
            font_base: self.font_base,
            text_view: self.text_view.clone(),
            secret: self.secret.clone(),
        }
    }
}

/// 密钥字段的双控件组：AppKit 没有公开的「运行时切换 secure」属性
/// （`NSSecureTextField` 是独立类），所以建**同框的两个控件** ——
/// 密文（NSSecureTextField）默认可见，明文（NSTextField）隐藏；
/// 「显示/隐藏」按钮切换可见者并在切换前把文字同步过去（结束正在进行的编辑）。
pub(super) struct SecretFields {
    pub(super) secure: Retained<NSSecureTextField>,
    pub(super) plain: Retained<NSTextField>,
    pub(super) button: Retained<NSButton>,
}

impl Clone for SecretFields {
    fn clone(&self) -> Self {
        Self {
            secure: self.secure.clone(),
            plain: self.plain.clone(),
            button: self.button.clone(),
        }
    }
}
// ==========================================
// 快捷键录制视图
// ==========================================

// 录制视图：点「呼出快捷键」按钮后占住第一响应者，捕获下一次按键
// （修饰键单独按下走 flagsChanged，不产生 keyDown）；失焦（点去别处）按取消处理。
define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    pub(super) struct ShortcutRecorderView;

    unsafe impl NSObjectProtocol for ShortcutRecorderView {}

    impl ShortcutRecorderView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: Option<&NSEvent>) {
            let Some(event) = event else { return };
            if let Some(controller) = current_controller() {
                controller.finish_shortcut_capture(event);
            }
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // 失去焦点 = 取消录制（与 Esc 同归宿，不写任何值）。
            if let Some(controller) = current_controller() {
                controller.cancel_shortcut_capture();
            }
            true
        }
    }
);

impl ShortcutRecorderView {
    pub(super) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0))
            ]
        }
    }
}

/// 当前设置窗控制器（与 `CONTROLLER` 线程局部同一来源；录制动作只在主线程发生）。
fn current_controller() -> Option<Retained<SettingsContentController>> {
    CONTROLLER.with(|cell| cell.borrow().clone())
}

/// 录制时忽略的键码：修饰键与 CapsLock / Fn（单独按下不构成组合键）。
const RECORDER_IGNORED_KEYCODES: &[u16] =
    &[0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F];

/// 原生按键 → 规范键名：优先按 `ui::shortcut` 的键码表反查（键名的唯一来源）；
/// 表外可打印字符回落到字符（`parse_spec` 会归一化大小写）。
fn recorded_key(key_code: u16, event: &NSEvent) -> Option<String> {
    if RECORDER_IGNORED_KEYCODES.contains(&key_code) {
        return None;
    }
    if let Some((name, _)) = crate::ui::shortcut::MACOS_KEYCODES
        .iter()
        .find(|(_, code)| *code == u32::from(key_code))
    {
        return Some((*name).to_string());
    }
    let text = event.charactersIgnoringModifiers()?;
    let text = text.to_string();
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) if ch.is_ascii() && !ch.is_control() => Some(ch.to_string()),
        _ => None,
    }
}

/// 快捷键的组合展示（macOS 符号；未知修饰键名原样显示）。
pub(super) fn shortcut_display(view: &SettingsView) -> String {
    let Some((key, modifiers)) =
        crate::ui::settings::shortcut_parts(&view.values, SHORTCUT_MODIFIERS_KEY)
    else {
        return "录制快捷键".to_string();
    };
    let mut parts: Vec<String> = modifiers
        .iter()
        .map(|modifier| match modifier.as_str() {
            "Control" => "⌃".to_string(),
            "Command" => "⌘".to_string(),
            "Alt" => "⌥".to_string(),
            "Shift" => "⇧".to_string(),
            other => other.to_string(),
        })
        .collect();
    parts.push(key);
    parts.join("")
}

impl SettingsContentController {
    /// 开始快捷键录制：录制视图覆盖按钮并占住第一响应者。
    pub(super) fn start_shortcut_capture(&self) {
        if self.ivars().shortcut_recording.get() {
            return;
        }
        let recorder = self.ivars().shortcut_recorder.borrow().clone();
        let Some(recorder) = recorder else {
            rust_warn!("快捷键录制视图不存在（通用页未构建？）");
            return;
        };
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        self.ivars().shortcut_recording.set(true);
        recorder.setHidden(false);
        // 录制视图占住响应链：下一次按键进 keyDown；点去别处触发 resign（取消）。
        if !window.makeFirstResponder(Some(&recorder)) {
            self.ivars().shortcut_recording.set(false);
            recorder.setHidden(true);
            settings_ui().set_warning("录制未能获得键盘焦点，请重试");
            return;
        }
        self.refresh_values();
    }

    /// 结束录制（成功/取消共用）：收起草稿变更由调用方决定。
    fn stop_shortcut_capture(&self) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        self.ivars().shortcut_recording.set(false);
        if let Some(window) = self.ivars().window.borrow().clone() {
            // 先交出第一响应者再隐藏：隐藏的视图不能继续持有焦点。
            let _ = window.makeFirstResponder(None);
        }
        if let Some(recorder) = self.ivars().shortcut_recorder.borrow().as_ref() {
            recorder.setHidden(true);
        }
    }

    /// Esc / 失焦：取消录制，不写任何值。
    fn cancel_shortcut_capture(&self) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        self.stop_shortcut_capture();
        self.refresh_values();
    }

    /// 捕获一次按键（录制视图 `keyDown` 的回调；映射不出键名时保持录制）。
    pub(super) fn finish_shortcut_capture(&self, event: &NSEvent) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        let key_code = event.keyCode();
        let flags = event.modifierFlags();
        let modifiers = ShortcutModifiers {
            control: flags.contains(NSEventModifierFlags::Control),
            command: flags.contains(NSEventModifierFlags::Command),
            alt: flags.contains(NSEventModifierFlags::Option),
            shift: flags.contains(NSEventModifierFlags::Shift),
        };
        let Some(key) = recorded_key(key_code, event) else {
            // 修饰键本体：忽略，继续录制；其余映射不出的按键给一条中性提示，
            // 避免用户以为录制失灵。
            if !RECORDER_IGNORED_KEYCODES.contains(&key_code) {
                settings_ui().set_warning("该按键不在支持的快捷键列表里，请换一个组合");
            }
            return;
        };
        if key == "Escape" && !modifiers.any() {
            rust_debug!("快捷键录制被 Esc 取消");
            self.cancel_shortcut_capture();
            settings_ui().set_notice(Some("已取消录制，快捷键未改动".into()));
            return;
        }
        self.stop_shortcut_capture();
        match settings_ui().apply_shortcut(&key, modifiers, SHORTCUT_MODIFIERS_KEY) {
            Ok(()) => settings_ui().set_notice(Some("新快捷键已录入，保存后生效".into())),
            Err(error) => settings_ui().set_error(format!("快捷键未更新：{error}")),
        }
    }
}
// ==========================================
// 小工具
// ==========================================

pub(super) fn format_number(number: f64) -> String {
    if number.fract().abs() < f64::EPSILON {
        format!("{}", number as i64)
    } else {
        // 去尾零：0.1 步长的值不显示成 0.30000000000000004。
        let text = format!("{number:.4}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// 密文单行文本（密钥字段；`NSSecureTextField` 与普通 `NSTextField` 同款外观，
/// 但始终以圆点显示，无法在运行时切回明文 —— 明文由同框的另一只控件承担）。
pub(super) fn secure_text_field(
    mtm: MainThreadMarker,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSSecureTextField> {
    let field = NSSecureTextField::initWithFrame(
        NSSecureTextField::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(200.0, 22.0)),
    );
    field.setEditable(true);
    field.setBezeled(true);
    field.setDrawsBackground(true);
    field.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
    unsafe {
        field.setTarget(Some(target));
        field.setAction(Some(action));
    }
    field
}

/// 多行只读文本（信息块 / 任意长度文本的展示与复制）。
pub(super) fn readonly_text_view(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
    size: f64,
) -> (Retained<NSScrollView>, Retained<NSTextView>) {
    let (scroll, text) = multiline_field(mtm, width, height);
    text.setEditable(false);
    text.setSelectable(true);
    text.setFont(Some(&resolve_font(size)));
    (scroll, text)
}

/// 可换行的静态文本（管理面说明 / 副标题；超过 `max_lines` 行截断）。
pub(super) fn wrapped_label(
    mtm: MainThreadMarker,
    text: &str,
    size: f64,
    color: Option<&NSColor>,
    max_lines: isize,
) -> Retained<NSTextField> {
    let field = NSTextField::wrappingLabelWithString(&NSString::from_str(text), mtm);
    field.setFont(Some(&resolve_font(size)));
    field.setMaximumNumberOfLines(max_lines);
    if let Some(color) = color {
        field.setTextColor(Some(color));
    }
    field
}

/// 自绘输入框（用户规则 2026-10-05「全面自绘」）：底/描边/内立体/圆角/文字色取 token，
/// 系统 bezel 与系统聚焦环关闭；光标色在进入编辑时由委托按 token 设（`NSTextField`
/// 自身没有插入符色 API，落点在字段编辑器）。
pub(super) fn themed_text_field(
    mtm: MainThreadMarker,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSTextField> {
    let field = NSTextField::initWithFrame(
        NSTextField::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(200.0, ROW_H)),
    );
    field.setBordered(false);
    field.setDrawsBackground(false);
    field.setFocusRingType(NSFocusRingType::None);
    field.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    field.setWantsLayer(true);
    style_themed_field(&field);
    unsafe {
        field.setTarget(Some(target));
        field.setAction(Some(action));
    }
    field
}

/// 输入框主题面（控件建在市场后与字体/主题广播时调用；在 Tab 重建路径自然重贴）。
pub(super) fn style_themed_field(field: &NSTextField) {
    let tokens = theme::tokens();
    field.setTextColor(Some(&paint::color(tokens.ink)));
    if let Some(layer) = field.layer() {
        without_implicit_animation(|| {
            paint::apply_fill(&layer, &tokens.field_bg, true);
            paint::set_corner_radius(&layer, f64::from(tokens.radii.sm));
            paint::apply_bevel(&layer, &tokens.field_bevel, true);
        });
    }
}

/// 多行文本（在滚动视图里放 NSTextView；Enter 换行，不触发动作）。
pub(super) fn multiline_field(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
) -> (Retained<NSScrollView>, Retained<NSTextView>) {
    let scroll = NSScrollView::initWithFrame(
        NSScrollView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setBorderType(objc2_app_kit::NSBorderType::BezelBorder);
    let text = NSTextView::initWithFrame(
        NSTextView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    text.setEditable(true);
    text.setRichText(false);
    text.setVerticallyResizable(true);
    text.setHorizontallyResizable(false);
    text.setTextContainerInset(NSSize::new(6.0, 6.0));
    text.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    scroll.setDocumentView(Some(&text));
    (scroll, text)
}
