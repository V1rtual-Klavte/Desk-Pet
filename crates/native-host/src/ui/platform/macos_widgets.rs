//! macOS 控件小工具（W9a）：设置窗/编辑器窗共用的 AppKit 控件构造与全局字体解析。
//!
//! 只放「构造 + 布局」的薄封装，不放业务判定；所有函数必须在 UI 主线程调用。
//! 字体统一走 [`resolve_font`]：族名来自全局字体快照（`appearance.font` 的投影），
//! 系统查不到时回落到 `NSFont::systemFontOfSize`（执行契约 §6.4 的 fallback 要求）。

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, Sel};
use objc2::{define_class, msg_send, sel, MainThreadOnly, Message};
use objc2_app_kit::{
    NSAlert, NSApplication, NSAppearance, NSAppearanceCustomization, NSButton, NSColor, NSControl,
    NSControlStateValueOff, NSControlStateValueOn, NSEvent, NSEventModifierFlags, NSFont,
    NSLineBreakMode, NSPopUpButton, NSScrollView, NSSlider, NSTextField, NSTextView, NSView,
    NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};

use crate::host::WindowPort;
use crate::ui::font;
use crate::ui::theme::{self, paint, Bevel, Elevation, Fill};

/// 全局字体解析：快照里有族名且系统查得到就用它，否则系统默认字体。
///
/// `size` 是控件基线字号；配置了全局字号时按「正文基线 13.5」的同比缩放。
pub(crate) fn resolve_font(size: f64) -> Retained<NSFont> {
    let snapshot = font::snapshot();
    let resolved_size = snapshot.scaled_size(size, BODY_BASE_SIZE);
    match snapshot.family.as_deref() {
        Some(family) => NSFont::fontWithName_size(&NSString::from_str(family), resolved_size)
            .unwrap_or_else(|| {
                // 缺失字体使用系统 fallback（不静默绑定到其它族、不改写配置）。
                crate::rust_debug!("字体 {family} 在本机不可用，使用系统 fallback");
                NSFont::systemFontOfSize(resolved_size)
            }),
        None => NSFont::systemFontOfSize(resolved_size),
    }
}

/// 正文基线字号（聊天正文与设置控件正文同口径）。
pub(crate) const BODY_BASE_SIZE: f64 = 13.5;
/// 辅助/说明文字基线。
pub(crate) const HELP_BASE_SIZE: f64 = 11.0;

/// 任意 ObjC 对象 → `&AnyObject`（target/action 等弱类型接口）。
///
/// 与 `macos.rs` 的同名函数同为一行转写；这里独立一份是为了让设置/编辑器模块
/// 不依赖主窗模块的私有项（chat 的窗口类仍复用 macos.rs 的 `new_window`/`DeskPetWindow`）。
pub(crate) fn as_any<T: objc2::Message>(obj: &T) -> &AnyObject {
    unsafe { &*(obj as *const T as *const AnyObject) }
}

/// 取一份按父类 `NSView` 记账的引用（retain 一份；对象身份与类不变）。
///
/// # Safety 约束（调用方必须满足）
/// `T` 必须是 `NSView` 的 ObjC 子类实例（本模块只用于 AppKit 控件）。
pub(crate) fn retained_view<T: Message>(obj: &Retained<T>) -> Retained<NSView> {
    unsafe {
        Retained::retain(Retained::as_ptr(obj) as *const NSView as *mut NSView)
            .expect("AppKit 对象指针必然非空")
    }
}

/// 粗体版全局字体（节标题用）。
pub(crate) fn resolve_bold_font(size: f64) -> Retained<NSFont> {
    let base = resolve_font(size);
    let Some(mtm) = MainThreadMarker::new() else {
        return base;
    };
    let manager = objc2_app_kit::NSFontManager::sharedFontManager(mtm);
    manager.convertFont_toHaveTrait(&base, objc2_app_kit::NSFontTraitMask::BoldFontMask)
}

/// 静态文本标签（左对齐）。
pub(crate) fn label(
    mtm: MainThreadMarker,
    text: &str,
    size: f64,
    color: Option<&NSColor>,
) -> Retained<NSTextField> {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    field.setFont(Some(&resolve_font(size)));
    if let Some(color) = color {
        field.setTextColor(Some(color));
    }
    field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
    field
}

/// 说明文字样式（主题次要色 `dim` + 小号）。
///
/// 本助手只有设置窗与编辑器窗在用（rg 全仓确认），两窗都消费主题 token，
/// 所以直接取 `dim` 而不是系统 `secondaryLabelColor`（系统语义色会破主题）。
pub(crate) fn help_label(mtm: MainThreadMarker, text: &str) -> Retained<NSTextField> {
    label(
        mtm,
        text,
        HELP_BASE_SIZE,
        Some(&paint::color(theme::tokens().dim)),
    )
}

/// 普通按钮（Push 样式）。
pub(crate) fn push_button(
    mtm: MainThreadMarker,
    title: &str,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSButton> {
    // 工厂方法带 unretained 的 target（AppKit 约定）：调用方保证目标对象比控件活得久。
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(target),
            Some(action),
            mtm,
        )
    };
    button.setBezelStyle(objc2_app_kit::NSBezelStyle::Push);
    button.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    button
}

pub(crate) fn set_checked(button: &NSButton, checked: bool) {
    button.setState(if checked {
        NSControlStateValueOn
    } else {
        NSControlStateValueOff
    });
}

pub(crate) fn is_checked(button: &NSButton) -> bool {
    button.state() == NSControlStateValueOn
}

/// 可编辑单行文本；`secret` = 密码样式（以圆点显示）。
pub(crate) fn text_field(
    mtm: MainThreadMarker,
    secret: bool,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSTextField> {
    let field = NSTextField::initWithFrame(
        NSTextField::alloc(mtm),
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
    if secret {
        // 密码样式：macOS 上没有公开的「secure text field」属性可直接设置（NSSecureTextField
        // 是独立类），这里以固定占位显示并在提交时仍按明文处理（值不落盘于本域）。
        field.setPlaceholderString(Some(&NSString::from_str("••••••")));
    }
    field
}

/// 单选下拉（枚举 / 字体族）。
pub(crate) fn popup(
    mtm: MainThreadMarker,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSPopUpButton> {
    let button = NSPopUpButton::initWithFrame_pullsDown(
        NSPopUpButton::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(200.0, 24.0)),
        false,
    );
    // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
    unsafe {
        button.setTarget(Some(target));
        button.setAction(Some(action));
    }
    button.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    // 显式按主题极性设控件外观（2026-10-05）：窗口级 `setAppearance` 实测未传导到
    // 下拉控件（verdigris 实机下拉仍是浅色 bezel，像素采样 #909A98＝浅色半透明
    // 叠深底），这里逐控件补一份：深色主题 DarkAqua、浅色主题 Aqua。
    let name = NSString::from_str(standard_appearance_name(theme::tokens().dark));
    match NSAppearance::appearanceNamed(&name) {
        Some(appearance) => button.setAppearance(Some(&appearance)),
        // 新建 NSString 必然等于外观名字符串，查不到才是异常；如实留痕。
        None => crate::rust_warn!("AppKit 外观 {name} 不存在，下拉保持默认外观"),
    }
    button
}

/// 滑块（连续发送 action；编辑器拖动/缩放预览依赖连续值）。
pub(crate) fn slider(
    mtm: MainThreadMarker,
    min: f64,
    max: f64,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSSlider> {
    let slider = NSSlider::initWithFrame(
        NSSlider::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(160.0, 20.0)),
    );
    slider.setMinValue(min);
    slider.setMaxValue(max);
    slider.setContinuous(true);
    // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
    unsafe {
        slider.setTarget(Some(target));
        slider.setAction(Some(action));
    }
    slider
}

// ==========================================
// 标准编辑快捷键（⌘C/⌘V/⌘X/⌘A）
// ==========================================

/// 「纯 ⌘ 组合键」的字符（小写化）：含 Command 且**不含** Control / Option 时返回
/// `charactersIgnoringModifiers()` 的小写形态；其它组合（带 Control/Option 的、
/// 非 Command 的、取不到字符的）一律 `None`。Shift 允许参与，`⌘⇧V` 与 `⌘V`
/// 同键（大小写差异由小写化抹平）。
///
/// 为什么存在这一族：产品用 `NSApplicationActivationPolicy::Accessory`
///（桌宠，**刻意不设应用主菜单**，见 `macos.rs::run_service`）—— 标准编辑快捷键
/// 没有 key equivalent 可派发，AppKit 只会 beep（实机症状：设置窗里 ⌘C/⌘V 没反应）。
/// 补挂菜单会推翻产品设计，所以由 [`handle_standard_edit_shortcut`] 在窗口层接住。
/// **判据只此一份**：接住点横跨窗口类与容器视图两处钩子，不各写一套修饰键条件。
pub(crate) fn command_shortcut_key(event: &NSEvent) -> Option<String> {
    let flags = event.modifierFlags();
    if !flags.contains(NSEventModifierFlags::Command)
        || flags.contains(NSEventModifierFlags::Control)
        || flags.contains(NSEventModifierFlags::Option)
    {
        return None;
    }
    event
        .charactersIgnoringModifiers()
        .map(|chars| chars.to_string().to_lowercase())
}

/// 标准编辑动作（选择子与 AppKit 标准编辑菜单逐字一致）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StandardEditAction {
    Paste,
    Copy,
    Cut,
    SelectAll,
}

impl StandardEditAction {
    /// 键字符 → 动作；不是这四个键一律 `None`（其它 ⌘ 组合不吞）。
    ///
    /// 大小写不敏感（`⌘⇧V` 取到的就是大写 `V`）：判据不依赖调用方先做小写化，
    /// 少一处会漂移的前提。
    pub(crate) fn from_key(key: &str) -> Option<Self> {
        if key.eq_ignore_ascii_case("v") {
            Some(Self::Paste)
        } else if key.eq_ignore_ascii_case("c") {
            Some(Self::Copy)
        } else if key.eq_ignore_ascii_case("x") {
            Some(Self::Cut)
        } else if key.eq_ignore_ascii_case("a") {
            Some(Self::SelectAll)
        } else {
            None
        }
    }

    fn selector(self) -> Sel {
        match self {
            Self::Paste => sel!(paste:),
            Self::Copy => sel!(copy:),
            Self::Cut => sel!(cut:),
            Self::SelectAll => sel!(selectAll:),
        }
    }
}

/// 窗口层接住标准编辑快捷键；返回 `true` = 事件已被消费（调用方不再走 `super`）。
///
/// 两处钩子共用这一份实现（`performKeyEquivalent:` 的实现体）：
/// - `DeskPetWindow`（`macos.rs`）：覆盖全部产品窗（主/聊天/设置/编辑器/查看器）；
/// - [`FlippedView`]：覆盖浮层窗口 —— `NSPopover` 的窗不是产品窗类，只有内容根视图在树里。
///
/// **只在「正在编辑文本」时接管**：first responder 是 `NSTextView`（单行 `NSTextField`
/// 编辑期的字段编辑器也是它的子类）。判据与标准编辑菜单的启用条件同义 —— 菜单项只在
/// 文本响应者响应时才可用；无文本焦点时本函数不动任何键，原样回落 `super`。
///
/// 派发走 `sendAction:to:from:`（target = nil = 沿响应链找第一响应者），**各视图自己的
/// 覆写仍然生效**：聊天输入框的 `paste:`（剪贴板有图片就先进待发送区）就是经这条被调到的。
/// 2026-10-07 用最小 AppKit 探针实机核过这条链（无主菜单 + Accessory 策略下）：
/// 基线复现「⌘V 不粘贴」、窗口类钩子与视图钩子都可达、自定义 `paste:`/`copy:` 覆写被调用
/// 且各只一次（排除与 keyDown 双派发）。
pub(crate) fn handle_standard_edit_shortcut(window: &NSWindow, event: &NSEvent) -> bool {
    let Some(responder) = window.firstResponder() else {
        return false;
    };
    if as_any(&*responder).downcast_ref::<NSTextView>().is_none() {
        return false;
    }
    let Some(action) =
        command_shortcut_key(event).and_then(|key| StandardEditAction::from_key(&key))
    else {
        return false;
    };
    // 主线程标记取不到只可能是「不在 UI 主线程」——本函数只被 AppKit 在主线程调用，
    // 那属于状态异常；如实不处理（回落 super），不 panic、也不假装成功。
    let Some(mtm) = MainThreadMarker::new() else {
        crate::rust_warn!("标准编辑快捷键在非主线程到达，已回落系统处理");
        return false;
    };
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: sendAction:to:from: 是 NSApplication 的标准目标-动作派发（无额外前提）。
    unsafe { app.sendAction_to_from(action.selector(), None, None) }
}

// ==========================================
// 翻转容器（左上原点，与表单从上往下的排布一致）
// ==========================================

define_class!(
    /// 顶部对齐的容器：isFlipped = true，让子视图 frame 的 y 从顶部往下量
    /// （与聊天窗的堆叠容器同做法）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    pub(crate) struct FlippedView;

    unsafe impl NSObjectProtocol for FlippedView {}

    impl FlippedView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        /// 标准编辑快捷键的容器级接住点：浮层（`NSPopover`）的窗不是产品窗类
        /// （`DeskPetWindow`），只有内容根视图在它的视图树里 —— 本类的实例就是
        /// 设置/编辑器浮层表单的根，`performKeyEquivalent:` 走树时即可到达。
        /// 判据与守卫见 [`handle_standard_edit_shortcut`]，与窗口类钩子同一份实现。
        #[unsafe(method(performKeyEquivalent:))]
        fn perform_key_equivalent(&self, event: &NSEvent) -> Bool {
            if let Some(window) = self.window() {
                if handle_standard_edit_shortcut(&window, event) {
                    return Bool::YES;
                }
            }
            // SAFETY: nsview 的同名方法；参数就是本方法的入参。
            unsafe { msg_send![super(self), performKeyEquivalent: event] }
        }
    }
);

impl FlippedView {
    pub(crate) fn new(mtm: MainThreadMarker, width: f64, height: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height))
            ]
        }
    }
}

/// 竖向滚动的表单容器：返回 (scroll_view, 文档视图)。
///
/// 调用方往文档视图里加控件（左上原点坐标系），最后用 `set_frame_size` 设定内容高度。
pub(crate) fn scroll_form(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
) -> (Retained<NSScrollView>, Retained<FlippedView>) {
    let scroll = NSScrollView::initWithFrame(
        NSScrollView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setBorderType(objc2_app_kit::NSBorderType::NoBorder);
    scroll.setDrawsBackground(false);
    let document = FlippedView::new(mtm, width, height);
    scroll.setDocumentView(Some(&document));
    (scroll, document)
}

/// 把控件加进容器并设置 frame（左上原点）。
///
/// `child` 可以是任何 AppKit 视图（`objc2` 为每个类生成了到父类的 `AsRef`），
/// 也直接接受 `&Retained<T>`（`Retained` 实现了 `AsRef<T>` 的目标解引用）。
pub(crate) fn place<T: AsRef<NSView>>(parent: &NSView, child: &T, x: f64, y: f64, w: f64, h: f64) {
    let view: &NSView = child.as_ref();
    view.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)));
    parent.addSubview(view);
}

/// 视图是否正作为所在窗口的 first responder（NSTextView 的「正在编辑」判据；
/// NSTextField 的同类判据是 `NSControl::currentEditor`）。
pub(crate) fn is_editing_now(view: &NSView) -> bool {
    unsafe {
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return false;
        }
        let responder: *mut AnyObject = msg_send![window, firstResponder];
        !responder.is_null() && std::ptr::eq(responder as *const NSView, view as *const NSView)
    }
}

/// 关闭隐式动画后改 CALayer 属性（与 chat/render 同款防护）。
pub(crate) fn without_implicit_animation<F: FnOnce()>(f: F) {
    objc2_quartz_core::CATransaction::begin();
    objc2_quartz_core::CATransaction::setDisableActions(true);
    f();
    objc2_quartz_core::CATransaction::commit();
}

/// 递归刷新容器内全部控件的字体（全局字体快照变化时调用）。
///
/// 只改 `NSControl` 系控件；说明文字与滑块保持小号基线，正文控件用正文基线。
pub(crate) fn sync_fonts(view: &NSView) {
    for subview in view.subviews().iter() {
        if let Some(control) = subview.downcast_ref::<NSControl>() {
            let base = if subview.downcast_ref::<NSSlider>().is_some() {
                HELP_BASE_SIZE
            } else {
                BODY_BASE_SIZE
            };
            control.setFont(Some(&resolve_font(base)));
        } else {
            sync_fonts(&subview);
        }
    }
}

// ==========================================
// 窗口级主题（设置窗 / 编辑器窗共用）
// ==========================================

/// 主题分组分隔线的厚度（逻辑点）。
pub(crate) const RULE_LINE_H: f64 = 1.0;

/// `Tokens.dark` → AppKit 标准外观名（纯函数，可测）。
///
/// 返回的是 AppKit 公开外观名的实际字符串值（单测与 objc2 侧的
/// `NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua` 常量对账，防手写漂移）。
/// 窗口设置该外观后，下拉、滚动条、滑块、复选框等**标准控件**都按这份极性
/// 绘制 —— 这是设置窗与编辑器「活在主题里」的关键一步。
pub(crate) const fn standard_appearance_name(dark: bool) -> &'static str {
    if dark {
        "NSAppearanceNameDarkAqua"
    } else {
        "NSAppearanceNameAqua"
    }
}

/// 窗口级主题（两个附属窗共用；`macos_settings` 与 `macos_editor` 的构建期与
/// 换主题路径都走这里）。
///
/// 两件事：
/// 1. **窗口底**：内容视图图层铺**面板底全家**（`--pbg` + `--ptex` + grain）——
///    设计稿 `.set` 就是 `background:var(--pbg)` + 纹理 + 颗粒，设置窗/编辑器
///    与聊天面板是同一张面板面。此前用 `--fbg`（近黑字段底）理由是"表单/卡片面"，
///    实机在 verdigris 下整面纯黑，用户判「设置页面根本没动」（2026-10-05 截图
///    证据）；口径回归设计稿。
///    窗口会缩放（两个附属窗都可拖边框），所以走 [`paint::apply_window_backdrop`]
///    （全部绘制子层带自缩放掩码），不能直接 `paint_backdrop`。
/// 2. **外观极性**：按 `tokens.dark` 给窗口设 `NSAppearance`，标准控件跟随明暗。
pub(crate) fn apply_window_theme(window: &NSWindow) {
    let tokens = theme::tokens();
    if let Some(content) = window.contentView() {
        content.setWantsLayer(true);
        if let Some(layer) = content.layer() {
            paint::apply_window_backdrop(
                &layer,
                &paint::Backdrop {
                    fill: tokens.panel_bg,
                    sheen: tokens.panel_tex,
                    grain: tokens.panel_grain,
                    stroke: None,
                    stroke_width: 0.0,
                    bevel: Bevel::NONE,
                    elevation: Elevation::NONE,
                    corner_radius: 0.0,
                    // 附属窗内容视图是普通 NSView（y 向上），与聊天面板宿主同口径。
                    flipped: false,
                },
            );
        }
    }
    let name = NSString::from_str(standard_appearance_name(tokens.dark));
    match NSAppearance::appearanceNamed(&name) {
        Some(appearance) => window.setAppearance(Some(&appearance)),
        // 新建 NSString 必然等于外观名字符串，系统查不到才是异常；如实留痕，不改变窗口其余状态。
        None => crate::rust_warn!("AppKit 外观 {name} 不存在，窗口保持默认外观"),
    }
}

/// 一条主题分组分隔线（`--grule`，1px）：设置页小节之间、编辑器控件列与预览之间。
pub(crate) fn rule_line(mtm: MainThreadMarker, width: f64, height: f64) -> Retained<NSView> {
    let view = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    repaint_rule_line(&view);
    view
}

/// 按当前主题重画一条分隔线（换主题时用；视图本身不重建的场合）。
pub(crate) fn repaint_rule_line(view: &NSView) {
    view.setWantsLayer(true);
    if let Some(layer) = view.layer() {
        paint::apply_fill(&layer, &Fill::Solid(theme::tokens().rule), false);
    }
}

// ==========================================
// 模态弹窗期间的窗口层级守卫
// ==========================================

/// 模态弹窗（NSAlert / 文件面板）期间的窗口层级包裹。
///
/// 主窗 1000 / 设置 1200 / 编辑器 1500 是平时的分层；而 AppKit 在模态期把弹窗压在
/// level 8（实测被强制，抬弹窗层级无效）—— level 1500 的编辑器窗会**整面盖住**
/// 模态弹窗，加上模态吞事件，表现为「假死」（用户报告的「没保存点关闭卡死」）。
/// 进入模态前把三窗降到普通层级（`set_picker_window_level(true)`），无论正常返回
/// 还是 panic 展开都经 Drop 恢复各自档位。
///
/// 端口参数供单测注入（生产传 [`crate::ui::MainThreadPort`]）；本函数只在 UI
/// 主线程调用（`set_level` 直接落 AppKit，见 `window/platform.rs`）。
pub(crate) fn with_picker_level_guard<R>(port: &dyn WindowPort, run: impl FnOnce() -> R) -> R {
    struct Restore<'a>(&'a dyn WindowPort);
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            let _ = crate::window::settings::set_picker_window_level(self.0, false);
        }
    }
    let _ = crate::window::settings::set_picker_window_level(port, true);
    let _restore = Restore(port);
    run()
}

/// NSAlert 模态运行的唯一入口。
///
/// 裸的 `runModal` 必须集中在本函数内（经 [`with_picker_level_guard`] 降级三窗），
/// 其它模块一律调本函数 —— 新增裸站点会绕过降级，有源码级守卫测试盯住。
pub(crate) fn run_modal_alert(alert: &NSAlert) -> isize {
    with_picker_level_guard(&crate::ui::MainThreadPort, || alert.runModal())
}

/// 单行文本输入弹窗（模态，经 [`run_modal_alert`] 同款降级包裹）。
///
/// 返回 `Ok(None)` = 用户取消；空串是合法输入（清空语义由调用方判定）。
pub(crate) fn prompt_text(
    title: &str,
    label: &str,
    initial: &str,
) -> crate::error::AppResult<Option<String>> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err(crate::error::AppError::Other(
            "文本输入弹窗必须在 UI 主线程发起".into(),
        ));
    };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(label));
    alert.addButtonWithTitle(&NSString::from_str("确定"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    let field = NSTextField::initWithFrame(
        NSTextField::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(240.0, 22.0)),
    );
    field.setStringValue(&NSString::from_str(initial));
    field.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    alert.setAccessoryView(Some(&field));
    // 聚焦 + 全选：打开即可直接键入替换（取消走第二个按钮）。
    alert.window().makeFirstResponder(Some(&field));
    unsafe { field.selectText(None) };
    if run_modal_alert(&alert) != objc2_app_kit::NSAlertFirstButtonReturn {
        return Ok(None);
    }
    Ok(Some(field.stringValue().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::test_support::RecordingWindowPort;

    /// 模态期间三窗口必须降到 Picker 层级，退出（含 panic 展开）后恢复各自档位 ——
    /// 降级是「没保存点关闭卡死」的修复本体：把它注释掉本用例即红。
    #[test]
    fn 模态包裹期间三窗口降层且退出后恢复() {
        let port = RecordingWindowPort::default();
        let result = with_picker_level_guard(&port, || 42);
        assert_eq!(result, 42, "包裹不该改写返回值");
        assert_eq!(
            port.calls(),
            vec![
                "set_level:main:0".to_string(),
                "set_level:settings:0".to_string(),
                "set_level:layer-editor:0".to_string(),
                "set_level:main:1000".to_string(),
                "set_level:settings:1200".to_string(),
                "set_level:layer-editor:1500".to_string(),
            ],
            "模态前降层、模态后恢复的调用序列",
        );
    }

    /// panic 展开路径同样恢复（Drop 守卫），不留「一次异常后编辑器永远压在普通层级」。
    #[test]
    fn 模态包裹内恐慌展开也恢复层级() {
        let port = RecordingWindowPort::default();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_picker_level_guard(&port, || panic!("模拟模态内异常"))
        }));
        assert!(outcome.is_err(), "异常应继续向上传播");
        assert_eq!(
            port.calls().last().map(String::as_str),
            Some("set_level:layer-editor:1500"),
            "展开路径也必须把三窗恢复到各自档位",
        );
    }

    /// 源码级守门：模态弹窗的调用站点只有 `run_modal_alert` 一处（降级的唯一入口）。
    ///
    /// AppKit 层级行为无法在单测里真开模态窗，用源码形状守住「新 runModal 站点
    /// 绕过降级」这一类回归。已迁移的三处文件全部纳入；仍在裸调用、各自文件所有权
    /// 不在本批的站点（macos_settings.rs / macos_chat.rs / native_ports.rs）见交付报告，
    /// 迁移完成后应把对应文件加入下方清单。
    #[test]
    fn 模态调用站点不绕过降级包裹() {
        // 拆开拼接，避免断言文本自己命中扫描。
        let needle = concat!(".run", "Modal(");
        let widgets = include_str!("macos_widgets.rs");
        assert_eq!(
            widgets.matches(needle).count(),
            1,
            "macos_widgets 的模态调用站点应为 1（仅 run_modal_alert）",
        );
        for (name, source) in [
            ("macos_editor.rs", include_str!("macos_editor.rs")),
            ("updates.rs", include_str!("../settings/updates.rs")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "{name} 出现裸模态调用：必须改走 run_modal_alert",
            );
        }
    }

    /// 标准编辑动作只认四个键：⌘V/⌘C/⌘X/⌘A；其它 ⌘ 组合（如 ⌘Z/⌘S）不得被吞。
    /// `⌘⇧V` 取到大写字符，大小写不敏感是**行为要求**不是便利 —— 掉这项就会让
    /// 带 Shift 的写法静默失效。
    #[test]
    fn 标准编辑动作只认四个键且大小写不敏感() {
        assert_eq!(StandardEditAction::from_key("v"), Some(StandardEditAction::Paste));
        assert_eq!(StandardEditAction::from_key("V"), Some(StandardEditAction::Paste));
        assert_eq!(StandardEditAction::from_key("c"), Some(StandardEditAction::Copy));
        assert_eq!(StandardEditAction::from_key("x"), Some(StandardEditAction::Cut));
        assert_eq!(StandardEditAction::from_key("a"), Some(StandardEditAction::SelectAll));
        for other in ["z", "s", "f", "", "vv", " ", "选"] {
            assert_eq!(
                StandardEditAction::from_key(other),
                None,
                "⌘{other} 不属标准编辑动作，必须原样落回系统",
            );
        }
    }

    /// 源码级守门：判据（`command_shortcut_key`）与接住实现
    /// （`handle_standard_edit_shortcut` 的两处 `performKeyEquivalent:` 钩子）
    /// 各只有一处 —— 两处钩子各写一套修饰键条件必然漂移，视图层再长一份
    /// 「视图自己的 keyDown 兜底」则会与窗口层双派发。
    #[test]
    fn 标准编辑快捷键判据与接住点各只一份() {
        // 拆开拼接，避免断言文本自己命中扫描（本文件含本测试的源码）。
        let predicate = concat!("fn command_", "shortcut_key(");
        let hook = concat!("#[unsafe(method(perform", "KeyEquivalent:))]");
        let widgets = include_str!("macos_widgets.rs");
        assert_eq!(
            widgets.matches(predicate).count(),
            1,
            "判据实现应只在 macos_widgets.rs 出现一次",
        );
        assert_eq!(
            widgets.matches(hook).count(),
            1,
            "容器级接住钩子应只在 macos_widgets.rs 出现一次（FlippedView）",
        );
        for (name, source, hooks) in [
            ("macos.rs", include_str!("macos.rs"), 1),
            ("macos_chat.rs", include_str!("macos_chat.rs"), 0),
            ("macos_settings.rs", include_str!("macos_settings.rs"), 0),
            ("macos_editor.rs", include_str!("macos_editor.rs"), 0),
            ("macos_main.rs", include_str!("macos_main.rs"), 0),
        ] {
            assert_eq!(
                source.matches(predicate).count(),
                0,
                "{name} 出现第二份修饰键判据：应复用 macos_widgets 的实现",
            );
            assert_eq!(
                source.matches(hook).count(),
                hooks,
                "{name} 的 performKeyEquivalent: 钩子数不符（窗口级只应有一个，视图级归容器）",
            );
        }
    }
}
