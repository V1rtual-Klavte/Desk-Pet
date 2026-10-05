//! 呼出/收回状态机、弹窗摆位与自动呼出判定 —— 零 UI 依赖的纯逻辑。
//!
//! 呼出/收回的语义与动画口径（逐项）：
//!
//! - 单一状态机 `visible -> retracting -> hidden -> revealing -> visible`；
//! - 收起先完整播放 0.25s 缩放淡出，动画终点**真正停止帧回调**并隐藏窗口；
//!   hidden 只保存最新逻辑状态，不产生循环帧（[`Tick::Idle`]）；
//! - 呼出按 0.35s 弹性曲线从 scale(0)/opacity(0) 放大到 scale(1)/opacity(1)
//!   （`cubic-bezier(0.34, 1.56, 0.64, 1)`，带越冲）；
//! - 「重复按键护栏」：动画进行中忽略触发，动画结束后再保留
//!   [`TOGGLE_TAIL_MS`] 尾巴（固定 500ms）；
//! - transform origin 取「光标相对窗口左上角」（固定位置模式取窗口中心）。
//!
//! 本模块不做任何平台调用：平台帧计时器与窗口操作在 `ui/platform/` 消费这里的
//! [`Tick`] / [`FrameVisual`]，测试可直接驱动（不启动窗口）。
//!
//! 时钟是调用方传入的单调毫秒（[`ShowHideMachine`] 不读系统时间），测试用显式
//! 数值推进。

/// 收起动画时长（毫秒）——沿用既有动画口径。
pub const RETRACT_DURATION_MS: u64 = 250;

/// 呼出动画时长（毫秒）——沿用既有动画口径。
pub const REVEAL_DURATION_MS: u64 = 350;

/// 「重复按键护栏」的释放尾巴（毫秒）——动画结束后再压 500ms。
pub const TOGGLE_TAIL_MS: u64 = 500;

/// 收起曲线（既定 timing function，含负向预备动作）。
pub const RETRACT_CURVE: (f64, f64, f64, f64) = (0.36, 0.0, 0.66, -0.56);

/// 呼出曲线（既定 timing function，含弹性越冲）。
pub const REVEAL_CURVE: (f64, f64, f64, f64) = (0.34, 1.56, 0.64, 1.0);

/// 窗口显示阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Visible,
    Retracting,
    Hidden,
    Revealing,
}

/// 一帧视觉参数（层级缩放的 0..1 进度经曲线求值后的结果）。
///
/// 曲线带预备/越冲，数值可能短暂越出 `[0, 1]`（这正是旧 CSS 动画的表现）；
/// 平台按各自 API 的容忍度处理（Core Animation 的 opacity 会自行夹取，
/// Windows 的 `SourceConstantAlpha` 由平台侧夹取）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameVisual {
    pub scale: f64,
    pub opacity: f64,
}

/// 一次帧回调的结论。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tick {
    /// 非动画态：**不产生帧、不改动任何绘制**（隐藏零帧的依据）。
    /// 驱动方在收到它时应停掉帧表（防御性收口）。
    Idle,
    /// 动画推进中的一帧（含最后一帧之前的全部帧）。
    Frame(FrameVisual),
    /// 本次回调完成收起：驱动方须停表、`orderOut`/`SW_HIDE` 并复位视觉。
    RetractFinished,
    /// 本次回调完成呼出：驱动方须停表并复位视觉（身份变换等价于终值）。
    RevealFinished,
}

/// 呼出/收回状态机。
pub struct ShowHideMachine {
    stage: Stage,
    transition_start_ms: u64,
    cooldown_until_ms: u64,
    origin: (f64, f64),
}

impl Default for ShowHideMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl ShowHideMachine {
    /// 初始态为可见（主窗创建后即显示）。
    pub const fn new() -> Self {
        Self {
            stage: Stage::Visible,
            transition_start_ms: 0,
            cooldown_until_ms: 0,
            origin: (0.0, 0.0),
        }
    }

    pub const fn stage(&self) -> Stage {
        self.stage
    }

    /// 当前是否需要帧回调（仅动画中）。
    pub const fn wants_frames(&self) -> bool {
        matches!(self.stage, Stage::Retracting | Stage::Revealing)
    }

    /// 当前 transform origin（窗口坐标系，左上原点）。
    pub const fn origin(&self) -> (f64, f64) {
        self.origin
    }

    /// 触发护栏：动画进行中或处于释放尾巴内都返回 `false`（旧 `isAnimating` 语义）。
    pub const fn can_toggle(&self, now_ms: u64) -> bool {
        if self.wants_frames() {
            return false;
        }
        now_ms >= self.cooldown_until_ms
    }

    /// 开始收起。返回 `false` 表示本次触发被护栏忽略（状态不变）。
    pub fn begin_retract(&mut self, now_ms: u64) -> bool {
        if !self.can_toggle(now_ms) {
            return false;
        }
        self.stage = Stage::Retracting;
        self.transition_start_ms = now_ms;
        true
    }

    /// 开始呼出。`origin` 是已算好的 transform origin（窗口坐标系）。
    pub fn begin_reveal(&mut self, now_ms: u64, origin: (f64, f64)) -> bool {
        if !self.can_toggle(now_ms) {
            return false;
        }
        self.stage = Stage::Revealing;
        self.transition_start_ms = now_ms;
        self.origin = origin;
        true
    }

    /// 收起过程中更新 origin（收起前用当前光标重算；只在实际动画中有效）。
    pub fn set_origin(&mut self, origin: (f64, f64)) {
        self.origin = origin;
    }

    /// 帧回调。`now_ms` 必须单调（同一基准）。
    pub fn tick(&mut self, now_ms: u64) -> Tick {
        match self.stage {
            Stage::Visible | Stage::Hidden => Tick::Idle,
            Stage::Retracting => {
                let t = raw_progress(now_ms, self.transition_start_ms, RETRACT_DURATION_MS);
                if t >= 1.0 {
                    self.stage = Stage::Hidden;
                    self.cooldown_until_ms = now_ms.saturating_add(TOGGLE_TAIL_MS);
                    Tick::RetractFinished
                } else {
                    let (x1, y1, x2, y2) = RETRACT_CURVE;
                    let eased = cubic_bezier(x1, y1, x2, y2, t);
                    Tick::Frame(FrameVisual {
                        scale: 1.0 - eased,
                        opacity: 1.0 - eased,
                    })
                }
            }
            Stage::Revealing => {
                let t = raw_progress(now_ms, self.transition_start_ms, REVEAL_DURATION_MS);
                if t >= 1.0 {
                    self.stage = Stage::Visible;
                    self.cooldown_until_ms = now_ms.saturating_add(TOGGLE_TAIL_MS);
                    Tick::RevealFinished
                } else {
                    let (x1, y1, x2, y2) = REVEAL_CURVE;
                    let eased = cubic_bezier(x1, y1, x2, y2, t);
                    Tick::Frame(FrameVisual {
                        scale: eased,
                        opacity: eased,
                    })
                }
            }
        }
    }
}

/// 原始进度 `t ∈ [0, 1]`（未过曲线）。
fn raw_progress(now_ms: u64, start_ms: u64, duration_ms: u64) -> f64 {
    if duration_ms == 0 {
        return 1.0;
    }
    let elapsed = now_ms.saturating_sub(start_ms);
    (elapsed as f64 / duration_ms as f64).clamp(0.0, 1.0)
}

// ==========================================
// Cubic Bézier（与 Web Animations / CSS 同路数：牛顿迭代求 X(u)=t，再取 Y(u)）
// ==========================================

fn bezier_axis(a1: f64, a2: f64, t: f64) -> f64 {
    let a = 1.0 - 3.0 * a2 + 3.0 * a1;
    let b = 3.0 * a2 - 6.0 * a1;
    let c = 3.0 * a1;
    ((a * t + b) * t + c) * t
}

fn bezier_axis_derivative(a1: f64, a2: f64, t: f64) -> f64 {
    let a = 1.0 - 3.0 * a2 + 3.0 * a1;
    let b = 3.0 * a2 - 6.0 * a1;
    let c = 3.0 * a1;
    (3.0 * a * t + 2.0 * b) * t + c
}

/// 在 `t ∈ [0, 1]` 处求三次贝塞尔曲线（控制点 `(x1,y1)`、`(x2,y2)`）的 y 值。
///
/// `t` 是进度轴（0=起点，1=终点），返回动画值轴。端点精确为 0 / 1。
pub fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, t: f64) -> f64 {
    if !(t > 0.0) {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let mut u = t;
    let mut solved = false;
    for _ in 0..8 {
        let x = bezier_axis(x1, x2, u) - t;
        if x.abs() < 1e-9 {
            solved = true;
            break;
        }
        let d = bezier_axis_derivative(x1, x2, u);
        if d.abs() < 1e-9 {
            break;
        }
        let next = u - x / d;
        if !(0.0..=1.0).contains(&next) {
            break;
        }
        u = next;
    }
    if !solved {
        // 二分兜底（牛顿发散或落到边界外时）。
        let (mut lo, mut hi) = (0.0, 1.0);
        let mut mid = u.clamp(0.0, 1.0);
        for _ in 0..40 {
            let x = bezier_axis(x1, x2, mid);
            if (x - t).abs() < 1e-9 {
                break;
            }
            if x < t {
                lo = mid;
            } else {
                hi = mid;
            }
            mid = (lo + hi) / 2.0;
        }
        u = mid;
    }
    bezier_axis(y1, y2, u)
}

// ==========================================
// 弹窗摆位
// ==========================================

/// 屏幕矩形（逻辑像素，左上原点 —— 与 `commands/cursor.rs` 的 web 坐标同一系）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 光标居中 / 固定位置两种摆位模式（旧 `general.popup.mode`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlacementMode {
    /// 跟随光标：以光标为窗口中心，clamp 到屏幕内。
    Cursor,
    /// 固定位置：窗口左上角用用户保存的坐标（旧 `fixedPosition`），clamp 到屏幕内。
    Fixed { x: f64, y: f64 },
    /// 固定模式但配置里还没有坐标（用户刚把 `mode` 切成 fixed、一次都还没拖过窗口）。
    ///
    /// 过渡态：切过去不移动窗口、呼出仍按光标落位（既定路径）；位置写回照常进行 ——
    /// 用户在固定模式里拖动一次后坐标落盘，宿主快照转为 [`Self::Fixed`]。
    /// 没有这个过渡态，`mode=fixed` 且 `fixedPosition` 为空时宿主会永远停在
    /// 跟随光标模式，固定位置在设置里「改了不生效」。
    FixedAtCurrent,
}

impl PlacementMode {
    /// 从 Node 推送载荷解析摆位模式（`set_popup_placement` 命令；形状登记在
    /// `src/services/host/types.ts`：`{mode:"cursor"} | {mode:"fixed", x?, y?}`）。
    ///
    /// 返回 `None` = 载荷无效：未知 mode、`fixed` 只带一个坐标或坐标非有限值 ——
    /// 调用方（`host/dispatch.rs`）报结构化 `CONFIG` 错误，不静默回退到默认模式。
    /// `cursor` 模式忽略随行坐标；`fixed` 两个坐标都缺省 = [`Self::FixedAtCurrent`]。
    pub fn from_wire(mode: &str, x: Option<f64>, y: Option<f64>) -> Option<Self> {
        match mode {
            "cursor" => Some(Self::Cursor),
            "fixed" => match (x, y) {
                (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some(Self::Fixed { x, y }),
                (None, None) => Some(Self::FixedAtCurrent),
                _ => None,
            },
            _ => None,
        }
    }

    /// 推送应用后需要**立即**摆放到的固定坐标（`None` = 不摆位）。
    ///
    /// 固定位置模式切过去（或坐标更新）必须立刻把窗口移过去，否则固定模式要等
    /// 下一次呼出才生效；跟随光标模式与 [`Self::FixedAtCurrent`]（还没有坐标）都不
    /// 移动窗口 —— 位置在呼出时由光标决定。平台层（`ui/platform/`）据此决定是否调
    /// `setFrame`/`SetWindowPos`。
    pub const fn immediate_placement(&self) -> Option<(f64, f64)> {
        match self {
            Self::Cursor | Self::FixedAtCurrent => None,
            Self::Fixed { x, y } => Some((*x, *y)),
        }
    }

    /// 是否属于「固定位置」语义（拖动/缩放结束的写回据此开启位置写回）。
    ///
    /// [`Self::FixedAtCurrent`] 也算固定语义：用户已经在固定模式里，第一次拖动就应
    /// 把坐标写回 CONFIG（否则永远等不到第一份坐标）。
    pub const fn is_fixed(&self) -> bool {
        matches!(self, Self::Fixed { .. } | Self::FixedAtCurrent)
    }
}

/// 把窗口左上角 clamp 到屏幕内（窗口比屏幕大时回落到屏幕原点）。
///
/// **全 crate 唯一的窗口落点 clamp 定义点**：固定位置模式（`ui/platform/`）直接调用；
/// 光标居中路径（`commands/cursor.rs::compute_popup_position`）也调用本函数，不再各留一份
/// 公式。`f64::clamp` 在 `min > max` 时会 panic，这里显式兜底；跨屏/负原点等边界在测试中固定。
pub fn clamp_window_origin(origin: (f64, f64), size: (f64, f64), screen: ScreenRect) -> (f64, f64) {
    let clamp_axis = |value: f64, low: f64, high: f64| {
        if high < low {
            low
        } else if value < low {
            low
        } else if value > high {
            high
        } else {
            value
        }
    };
    (
        clamp_axis(origin.0, screen.x, screen.x + screen.w - size.0),
        clamp_axis(origin.1, screen.y, screen.y + screen.h - size.1),
    )
}

/// transform origin = 焦点相对窗口左上角的偏移（窗口坐标系，左上原点）。
pub fn transform_origin(window_origin: (f64, f64), focus_point: (f64, f64)) -> (f64, f64) {
    (
        focus_point.0 - window_origin.0,
        focus_point.1 - window_origin.1,
    )
}

// ==========================================
// 自动呼出（`general.popup.autoPopupOnMessage`）
// ==========================================

/// 自动呼出主窗的运行时开关（`general.popup.autoPopupOnMessage` 的宿主快照）。
///
/// - Node 经 `set_popup_auto_show`（推送面 `pushNativeUiState`）下发；**收到推送前
///   按 false 处理（fail-closed，与 `configure_chat_image_preview` 的既有先例同口径）**；
/// - 只存开关值，不落盘、重启归 false；**不含窗口语义** —— 是否/何时呼出由平台层在
///   「新提交的助手条目」到达时结合呼出/收回状态机自行裁决（执行契约裁定 1：Node
///   不得驱动窗口显隐与层级，所以不能由 Node 调 `show_main`）；
/// - 进程级单例（与 [`crate::ui::titlebar`] 的槽位同一形态）：写入点在 IPC 分派线程，
///   读取点在各平台 UI 主线程，用原子量免锁。
static POPUP_AUTO_SHOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 写入自动呼出开关（`set_popup_auto_show` 的宿主落点）。
pub fn store_popup_auto_show(enabled: bool) {
    POPUP_AUTO_SHOW.store(enabled, std::sync::atomic::Ordering::SeqCst);
}

/// 当前自动呼出开关（未收到推送时 false）。
pub fn popup_auto_show() -> bool {
    POPUP_AUTO_SHOW.load(std::sync::atomic::Ordering::SeqCst)
}

/// 「新提交的助手条目」判定器（平台层每个 UI 实例持有一份；纯逻辑，可测试驱动）。
///
/// 语义对齐旧壳 ChatPanel 对 `chatHistory` 的长度监听
/// （`newLength > oldLength && oldLength > 0 && 末尾 role === "assistant"`）：
///
/// - **同一会话内**、末尾助手条目 id 发生变化且新的尾巴存在 → 视为「新提交」
///   （`None → Some` 是「用户消息之后回复落盘」的正常路径；`Some → None` 是用户
///   又发了消息，不算）；
/// - **首次观察某会话只建立基线、不触发**（进程启动的首帧历史填充、切换会话都是
///   「视图变化」而不是新提交）；
/// - **上一次观察必须已见正文**（旧壳 `oldLength > 0` 的对应物）：启动时首帧还没有
///   正文、随后历史一次性填充（`空列表 → 末尾助手`）不是「新回复」，不触发；
/// - **不能用消息条数当判据**：投影帧的 `messages` 是按 32KiB 预算裁剪的尾窗
///   （`session-projection.ts::transcriptWindow`），长会话里尾部窗口长度会饱和，
///   条目 id 才是可靠判据；
/// - 观察到「新提交」不代表开关已开：是否呼出由调用方再查 [`popup_auto_show`] 与
///   呼出状态机的当前阶段。
pub struct CommittedAssistantTracker {
    /// 最近一次观察到的活跃会话。
    session: Option<String>,
    /// 最近一次观察到的末尾助手条目 id（末尾不是助手条目时为 None）。
    assistant_tail: Option<String>,
    /// 最近一次观察时已提交列表是否非空（旧壳 `oldLength > 0` 的对应物）。
    saw_messages: bool,
}

impl Default for CommittedAssistantTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl CommittedAssistantTracker {
    pub const fn new() -> Self {
        Self {
            session: None,
            assistant_tail: None,
            saw_messages: false,
        }
    }

    /// 观察一次已提交读模型（活跃会话 + 末尾助手条目 id + 列表是否非空）。
    ///
    /// 返回 true = 相对上次观察出现了**新提交的助手条目**（调用方据此触发自动呼出）。
    pub fn observe(
        &mut self,
        session: Option<&str>,
        assistant_tail: Option<&str>,
        has_messages: bool,
    ) -> bool {
        if self.session.as_deref() != session {
            // 会话变化（含首帧）：只建基线 —— 新条目判定只在同一会话内成立。
            self.session = session.map(str::to_string);
            self.assistant_tail = assistant_tail.map(str::to_string);
            self.saw_messages = has_messages;
            return false;
        }
        let previous_saw_messages = self.saw_messages;
        let tail_changed = self.assistant_tail.as_deref() != assistant_tail;
        self.assistant_tail = assistant_tail.map(str::to_string);
        self.saw_messages = has_messages;
        tail_changed && assistant_tail.is_some() && previous_saw_messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_at(machine: &mut ShowHideMachine, now: u64) -> FrameVisual {
        match machine.tick(now) {
            Tick::Frame(v) => v,
            other => panic!("期望动画帧，得到 {other:?}"),
        }
    }

    #[test]
    fn 初始可见且不需要帧() {
        let machine = ShowHideMachine::new();
        assert_eq!(machine.stage(), Stage::Visible);
        assert!(!machine.wants_frames());
        assert!(machine.can_toggle(0));
    }

    #[test]
    fn 收起动画覆盖全程并在终点切换隐藏() {
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(1_000));
        assert_eq!(machine.stage(), Stage::Retracting);
        assert!(machine.wants_frames());

        // 起点附近：scale/opacity 接近 1。
        let v = frame_at(&mut machine, 1_000);
        assert!((v.scale - 1.0).abs() < 1e-6, "scale={}", v.scale);

        // 中段：0 < scale < 1（负向预备动作可能短暂略大于 1 或略小于 0，取宽区间）。
        let v = frame_at(&mut machine, 1_125);
        assert!((-0.2..=1.2).contains(&v.scale), "scale={}", v.scale);
        assert_eq!(v.scale, v.opacity, "缩放与淡出同进度（lockstep 语义）");

        // 终点：完成事件；随后隐藏。
        assert_eq!(machine.tick(1_250), Tick::RetractFinished);
        assert_eq!(machine.stage(), Stage::Hidden);
        assert!(!machine.wants_frames());
    }

    #[test]
    fn 隐藏后不产生任何帧() {
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(0));
        assert_eq!(machine.tick(RETRACT_DURATION_MS), Tick::RetractFinished);
        // 连续多次回调（模拟残留计时器）一律 Idle：hidden 零帧。
        for now in [300, 400, 1_000, 60_000] {
            assert_eq!(
                machine.tick(now),
                Tick::Idle,
                "hidden 期不得产生帧（now={now}）"
            );
        }
    }

    #[test]
    fn 重复按键护栏在动画中与释放尾巴内都拦截() {
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(100));
        // 动画进行中：任何触发都被忽略（旧 isAnimating）。
        assert!(!machine.can_toggle(200));
        assert!(!machine.begin_reveal(200, (0.0, 0.0)));

        // 动画结束的瞬间仍要等尾巴（旧 setTimeout 500ms）。
        assert_eq!(machine.tick(350), Tick::RetractFinished);
        assert!(!machine.can_toggle(350));
        assert!(!machine.can_toggle(350 + TOGGLE_TAIL_MS - 1));
        // 尾巴结束后恢复。
        assert!(machine.can_toggle(350 + TOGGLE_TAIL_MS));
        assert!(machine.begin_reveal(350 + TOGGLE_TAIL_MS, (12.0, 34.0)));
    }

    #[test]
    fn 呼出动画从零放大到一并记录origin() {
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(0));
        assert_eq!(machine.tick(RETRACT_DURATION_MS), Tick::RetractFinished);
        let start = RETRACT_DURATION_MS + TOGGLE_TAIL_MS + 1;
        assert!(machine.begin_reveal(start, (40.0, 60.0)));
        assert_eq!(machine.origin(), (40.0, 60.0));
        assert_eq!(machine.stage(), Stage::Revealing);

        let v = frame_at(&mut machine, start);
        assert!(
            v.scale.abs() < 1e-6,
            "呼出从 scale(0) 开始，scale={}",
            v.scale
        );

        assert_eq!(
            machine.tick(start + REVEAL_DURATION_MS),
            Tick::RevealFinished
        );
        assert_eq!(machine.stage(), Stage::Visible);
        assert!(!machine.wants_frames());
    }

    #[test]
    fn 收起曲线带负向预备动作_呼出曲线带越冲() {
        let (x1, y1, x2, y2) = RETRACT_CURVE;
        let min = (0..=100)
            .map(|i| cubic_bezier(x1, y1, x2, y2, i as f64 / 100.0))
            .fold(f64::INFINITY, f64::min);
        assert!(min < 0.0, "收起曲线应有负向预备动作，min={min}");

        let (x1, y1, x2, y2) = REVEAL_CURVE;
        let max = (0..=100)
            .map(|i| cubic_bezier(x1, y1, x2, y2, i as f64 / 100.0))
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(max > 1.0, "呼出曲线应有弹性越冲，max={max}");
    }

    #[test]
    fn 贝塞尔端点精确且落在控制点凸包内() {
        // **不判单调**：两条曲线按设计就非单调 —— 收起靠 `y2 = -0.56` 的负向预备动作
        // （消费侧 `scale = 1.0 - eased` 于是先弹大再收缩），呼出靠 `y1 = 1.56` 的越冲
        // （`scale = eased` 直接放大）。相邻测试 `收起曲线带负向预备动作_呼出曲线带越冲`
        // 正是要求 min < 0 与 max > 1，两者不可能同时成立。
        // 这里守三次贝塞尔真正成立的性质：端点精确 + 值域不出控制点凸包
        //（求解器退化或落错 u 时，值会立刻越界，断言会红）。
        for (x1, y1, x2, y2) in [RETRACT_CURVE, REVEAL_CURVE] {
            assert_eq!(cubic_bezier(x1, y1, x2, y2, 0.0), 0.0);
            assert_eq!(cubic_bezier(x1, y1, x2, y2, 1.0), 1.0);
            let lo = 0.0_f64.min(y1).min(y2);
            let hi = 1.0_f64.max(y1).max(y2);
            for i in 0..=50 {
                let t = i as f64 / 50.0;
                let v = cubic_bezier(x1, y1, x2, y2, t);
                assert!(
                    (lo - 1e-9..=hi + 1e-9).contains(&v),
                    "t={t} 处越出控制点凸包 [{lo}, {hi}]：{v}"
                );
            }
        }
    }

    #[test]
    fn 屏幕内位置原样保留() {
        let screen = ScreenRect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        };
        assert_eq!(
            clamp_window_origin((100.0, 200.0), (730.0, 450.0), screen),
            (100.0, 200.0)
        );
    }

    #[test]
    fn 越出右缘与下缘时clamp回可完整显示位置() {
        let screen = ScreenRect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        };
        assert_eq!(
            clamp_window_origin((1500.0, 900.0), (730.0, 450.0), screen),
            (1920.0 - 730.0, 1080.0 - 450.0)
        );
        assert_eq!(
            clamp_window_origin((-50.0, -30.0), (730.0, 450.0), screen),
            (0.0, 0.0)
        );
    }

    #[test]
    fn 负原点副屏的clamp使用该屏自身坐标系() {
        // 副屏在主屏左侧：x ∈ [-1280, 0)。
        let screen = ScreenRect {
            x: -1280.0,
            y: 0.0,
            w: 1280.0,
            h: 800.0,
        };
        assert_eq!(
            clamp_window_origin((-1300.0, -20.0), (600.0, 400.0), screen),
            (-1280.0, 0.0)
        );
        assert_eq!(
            clamp_window_origin((-100.0, 500.0), (600.0, 400.0), screen),
            (-600.0, 400.0)
        );
    }

    #[test]
    fn 窗口大于屏幕时回落到屏幕原点而不是panic() {
        let screen = ScreenRect {
            x: 0.0,
            y: 0.0,
            w: 500.0,
            h: 300.0,
        };
        assert_eq!(
            clamp_window_origin((10.0, 10.0), (730.0, 450.0), screen),
            (0.0, 0.0)
        );
    }

    #[test]
    fn transform_origin是焦点相对窗口左上角的偏移() {
        assert_eq!(
            transform_origin((100.0, 200.0), (400.0, 350.0)),
            (300.0, 150.0)
        );
        // 固定位置模式：焦点取窗口中心。
        assert_eq!(transform_origin((0.0, 0.0), (365.0, 225.0)), (365.0, 225.0));
    }

    #[test]
    fn 摆位载荷解析cursor忽略坐标() {
        assert_eq!(
            PlacementMode::from_wire("cursor", None, None),
            Some(PlacementMode::Cursor)
        );
        // cursor 带坐标也解析为 cursor（坐标只对 fixed 有意义，不参与判定）。
        assert_eq!(
            PlacementMode::from_wire("cursor", Some(1.0), Some(2.0)),
            Some(PlacementMode::Cursor)
        );
    }

    #[test]
    fn 摆位载荷解析fixed要求坐标成对且有限() {
        assert_eq!(
            PlacementMode::from_wire("fixed", Some(120.0), Some(340.0)),
            Some(PlacementMode::Fixed { x: 120.0, y: 340.0 })
        );
        // 两个坐标都缺省 = 过渡态「固定模式、锚定当前位置」（配置里还没有坐标）。
        assert_eq!(
            PlacementMode::from_wire("fixed", None, None),
            Some(PlacementMode::FixedAtCurrent)
        );
        // fixed 只带一个坐标 / 非有限值一律 None（调用方报 CONFIG 错误，不静默回退）。
        assert_eq!(PlacementMode::from_wire("fixed", None, Some(1.0)), None);
        assert_eq!(PlacementMode::from_wire("fixed", Some(1.0), None), None);
        assert_eq!(
            PlacementMode::from_wire("fixed", Some(f64::NAN), Some(1.0)),
            None
        );
        assert_eq!(
            PlacementMode::from_wire("fixed", Some(1.0), Some(f64::INFINITY)),
            None
        );
        // 未知模式一律 None。
        assert_eq!(PlacementMode::from_wire("dof", Some(1.0), Some(1.0)), None);
        assert_eq!(PlacementMode::from_wire("", None, None), None);
    }

    #[test]
    fn 只有带坐标的fixed模式在推送应用时需要立即摆位() {
        // cursor：不移动窗口（下一次呼出才按光标落位）。
        assert_eq!(PlacementMode::Cursor.immediate_placement(), None);
        // fixed（过渡态，还没有坐标）：也不移动窗口；呼出仍按光标落位。
        assert_eq!(PlacementMode::FixedAtCurrent.immediate_placement(), None);
        // fixed：切过去/坐标更新都立即摆到该坐标。
        assert_eq!(
            PlacementMode::Fixed { x: 10.0, y: 20.0 }.immediate_placement(),
            Some((10.0, 20.0))
        );
        // cursor → fixed → cursor 的往返：每一步的立即摆位结论都在此固定。
        assert_eq!(
            PlacementMode::from_wire("cursor", None, None)
                .unwrap()
                .immediate_placement(),
            None
        );
        assert_eq!(
            PlacementMode::from_wire("fixed", Some(10.0), Some(20.0))
                .unwrap()
                .immediate_placement(),
            Some((10.0, 20.0))
        );
        assert_eq!(
            PlacementMode::from_wire("cursor", Some(9.0), Some(9.0))
                .unwrap()
                .immediate_placement(),
            None
        );
    }

    #[test]
    fn fixed语义包含过渡态() {
        // 拖动/缩放写回只认「固定语义」：过渡态也算，第一次拖动就能落坐标。
        assert!(!PlacementMode::Cursor.is_fixed());
        assert!(PlacementMode::FixedAtCurrent.is_fixed());
        assert!(PlacementMode::Fixed { x: 0.0, y: 0.0 }.is_fixed());
    }

    #[test]
    fn 自动呼出开关缺省为关且写入后生效() {
        // fail-closed：进程初值必须为 false（等价于 configure_chat_image_preview 的缺口语义）。
        store_popup_auto_show(false);
        assert!(!popup_auto_show());
        store_popup_auto_show(true);
        assert!(popup_auto_show());
        store_popup_auto_show(false);
        assert!(!popup_auto_show());
    }

    #[test]
    fn 新提交助手条目只在同会话内尾巴变化时触发() {
        let mut tracker = CommittedAssistantTracker::new();

        // 首帧（会话 A、末尾助手 a1）：只建基线，不触发（旧壳 oldLength > 0 抑制）。
        assert!(!tracker.observe(Some("A"), Some("a1"), true));
        // 同一帧重复到达：不触发。
        assert!(!tracker.observe(Some("A"), Some("a1"), true));
        // 用户消息落盘（末尾不再是助手条目）：不触发。
        assert!(!tracker.observe(Some("A"), None, true));
        // 回复提交（末尾助手从无到有）：触发 —— 这是主路径。
        assert!(tracker.observe(Some("A"), Some("a2"), true));
        // 重复帧：不触发（幂等，流式增量/阶段提示不经过这里）。
        assert!(!tracker.observe(Some("A"), Some("a2"), true));
        // 下一条回复：触发。
        assert!(tracker.observe(Some("A"), Some("a3"), true));
        // 同一会话但尾巴变为用户/工具条目：不触发。
        assert!(!tracker.observe(Some("A"), None, true));

        // 切会话（B）：只建基线、不触发（视图变化不是新提交）。
        assert!(!tracker.observe(Some("B"), Some("b1"), true));
        // B 会话内新回复：触发。
        assert!(tracker.observe(Some("B"), Some("b2"), true));
        // 切回 A：重设基线（A 的尾巴 a3 与 B 的基线无关），不触发。
        assert!(!tracker.observe(Some("A"), Some("a3"), true));
        // A 内新回复：触发。
        assert!(tracker.observe(Some("A"), Some("a4"), true));

        // 无活跃会话（投影尚未到达/已清空）：不触发。
        assert!(!tracker.observe(None, None, false));
        assert!(!tracker.observe(None, None, false));
    }

    #[test]
    fn 启动时历史填充不算新回复() {
        let mut tracker = CommittedAssistantTracker::new();

        // 启动首帧还没有正文（空列表）→ 基线（会话 C、无尾巴、无正文）。
        assert!(!tracker.observe(Some("C"), None, false));
        // 历史随后一次性填充到末尾助手：上一次观察没有正文，不算「新回复」。
        assert!(!tracker.observe(Some("C"), Some("c1"), true));
        // 之后的真实回复：触发（上一次观察已见正文）。
        assert!(tracker.observe(Some("C"), Some("c2"), true));

        // 对照：先看到用户的提问（有正文、尾巴不是助手），再来回复 → 触发。
        let mut tracker = CommittedAssistantTracker::new();
        assert!(!tracker.observe(Some("D"), None, false)); // 启动基线（空）
        assert!(!tracker.observe(Some("D"), None, true)); // 用户消息落盘
        assert!(tracker.observe(Some("D"), Some("d1"), true)); // 回复
    }

    // ── 「飞快连按」回归：被拒的 begin_* 必须零副作用 ──
    //
    // 现场缺陷（用户实跑）：连按时窗口「直接出来、没有动画」。状态机本身拦住了每一
    // 次被拒的触发，但平台侧 reveal 曾在**护栏判定之前**执行定位副作用
    //（compute_popup_position 的「增强/聚焦」会直接显示已 orderOut 的窗口）。
    // 因此这里把「被拒 = 阶段不变 + origin 不被写入 + 动画时钟不被重启动」逐项钉死，
    // 平台侧的「判定前置到副作用之前」以这组结论为准。

    #[test]
    fn 动画期间连续触发一律被拒且状态不变() {
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(1_000));
        assert_eq!(machine.stage(), Stage::Retracting);

        // 收起动画进行中：收/呼连续触发全被拒；阶段与 origin 不得被改写。
        for now in [1_000, 1_050, 1_100, 1_249] {
            assert!(
                !machine.begin_retract(now),
                "收起动画中收起必须被拒（now={now}）"
            );
            assert!(
                !machine.begin_reveal(now, (7.0, 8.0)),
                "收起动画中呼出必须被拒（now={now}）"
            );
            assert_eq!(
                machine.stage(),
                Stage::Retracting,
                "被拒不得改变阶段（now={now}）"
            );
            assert_eq!(
                machine.origin(),
                (0.0, 0.0),
                "被拒不得写入 origin（now={now}）"
            );
        }
        // 被拒不等于「未发生」：动画仍按原起点推进（起点未被连按重启动）。
        let v = frame_at(&mut machine, 1_125);
        assert!((-0.2..=1.2).contains(&v.scale), "scale={}", v.scale);
        assert_eq!(machine.tick(1_250), Tick::RetractFinished);
        assert_eq!(machine.stage(), Stage::Hidden);

        // 呼出动画进行中：对称结论（含 origin 停留在获批时写入的值）。
        assert!(machine.begin_reveal(1_750, (1.0, 2.0)));
        assert_eq!(machine.stage(), Stage::Revealing);
        for now in [1_750, 1_800, 2_099] {
            assert!(
                !machine.begin_retract(now),
                "呼出动画中收起必须被拒（now={now}）"
            );
            assert!(
                !machine.begin_reveal(now, (9.0, 9.0)),
                "呼出动画中呼出必须被拒（now={now}）"
            );
            assert_eq!(
                machine.stage(),
                Stage::Revealing,
                "被拒不得改变阶段（now={now}）"
            );
            assert_eq!(
                machine.origin(),
                (1.0, 2.0),
                "被拒不得覆盖 origin（now={now}）"
            );
        }
        assert_eq!(machine.tick(2_100), Tick::RevealFinished);
        assert_eq!(machine.stage(), Stage::Visible);
    }

    #[test]
    fn 收起完成后释放尾巴内呼出被拒且不写origin() {
        // 「飞快连按」主现场：收起动画刚结束进入 hidden，尾随按键落在 500ms
        // 释放尾巴内 —— 被拒的呼出不得进入 revealing、不得记录 origin
        //（平台侧据此保证窗口不显示：判定先于一切窗口副作用）。
        let mut machine = ShowHideMachine::new();
        assert!(machine.begin_retract(10_000));
        assert_eq!(machine.tick(10_250), Tick::RetractFinished);
        assert_eq!(machine.stage(), Stage::Hidden);

        for now in [10_250, 10_400, 10_749] {
            assert!(
                !machine.begin_reveal(now, (42.0, 43.0)),
                "释放尾巴内呼出必须被拒（now={now}）"
            );
            assert_eq!(
                machine.stage(),
                Stage::Hidden,
                "被拒后阶段必须维持 hidden（now={now}）"
            );
            assert_eq!(
                machine.origin(),
                (0.0, 0.0),
                "被拒的呼出不得记录 origin（now={now}）"
            );
        }
        // 尾巴结束的那一毫秒（finish + 500ms，端点包含）才放行并写入 origin。
        assert!(machine.begin_reveal(10_750, (42.0, 43.0)));
        assert_eq!(machine.stage(), Stage::Revealing);
        assert_eq!(machine.origin(), (42.0, 43.0));
    }

    #[test]
    fn 呼出完成后释放尾巴内收起被拒且维持可见() {
        let mut machine = ShowHideMachine::new();
        let finish_retract = RETRACT_DURATION_MS;
        assert!(machine.begin_retract(0));
        assert_eq!(machine.tick(finish_retract), Tick::RetractFinished);

        let reveal_start = finish_retract + TOGGLE_TAIL_MS;
        assert!(machine.begin_reveal(reveal_start, (5.0, 6.0)));
        let reveal_finish = reveal_start + REVEAL_DURATION_MS;
        assert_eq!(machine.tick(reveal_finish), Tick::RevealFinished);
        assert_eq!(machine.stage(), Stage::Visible);

        // 可见态 + 尾巴内：收/呼都被拒，阶段维持 visible（不开始新的收起）。
        for now in [
            reveal_finish,
            reveal_finish + 300,
            reveal_finish + TOGGLE_TAIL_MS - 1,
        ] {
            assert!(
                !machine.begin_retract(now),
                "呼出释放尾巴内收起必须被拒（now={now}）"
            );
            assert!(
                !machine.begin_reveal(now, (0.0, 0.0)),
                "呼出释放尾巴内呼出必须被拒（now={now}）"
            );
            assert_eq!(
                machine.stage(),
                Stage::Visible,
                "被拒后阶段必须维持 visible（now={now}）"
            );
        }
        assert!(machine.begin_retract(reveal_finish + TOGGLE_TAIL_MS));
        assert_eq!(machine.stage(), Stage::Retracting);
    }

    #[test]
    fn 连按序列只有放行的那一次开始过渡() {
        // 直驱「组合键飞快按」的完整序列：一次获批收起 → 动画中连按被拒 →
        // 尾巴内连按被拒（这正是实跑里窗口被直接显示的那一段）→ 尾巴后获批呼出。
        let mut machine = ShowHideMachine::new();
        let mut accepted = Vec::new();

        // t=0/80/160/240：只有第一次（收起）获批，其余都在动画中被拒。
        for i in 0..4u64 {
            let now = i * 80;
            if machine.begin_retract(now) {
                accepted.push(("retract", now));
            }
        }
        assert_eq!(
            accepted,
            vec![("retract", 0u64)],
            "动画中只有第一次触发获批"
        );
        assert_eq!(machine.stage(), Stage::Retracting);

        // 动画尚未走完（t=240 < 250）：此刻按下的呼出同样被拒。
        assert!(!machine.begin_reveal(240, (1.0, 1.0)));

        // t=250：收起完成 → hidden + 500ms 尾巴（至 750ms）。
        assert_eq!(machine.tick(RETRACT_DURATION_MS), Tick::RetractFinished);

        // 尾巴内连按呼出（t=320..=720）：全部被拒；窗口语义停在 hidden、
        // origin 未被写入 —— 平台侧据此不产生任何窗口显示副作用。
        for now in (320..=720).step_by(80) {
            assert!(
                !machine.begin_reveal(now, (9.0, 9.0)),
                "尾巴内呼出必须被拒（now={now}）"
            );
            assert_eq!(
                machine.stage(),
                Stage::Hidden,
                "被拒不得改变阶段（now={now}）"
            );
            assert_eq!(
                machine.origin(),
                (0.0, 0.0),
                "被拒不得写入 origin（now={now}）"
            );
        }

        // 尾巴结束后的第一次按键才获批呼出。
        assert!(machine.begin_reveal(800, (9.0, 9.0)));
        assert_eq!(machine.stage(), Stage::Revealing);
        assert_eq!(machine.origin(), (9.0, 9.0));
        assert_eq!(machine.tick(800 + REVEAL_DURATION_MS), Tick::RevealFinished);
        assert_eq!(machine.stage(), Stage::Visible);
    }
}
