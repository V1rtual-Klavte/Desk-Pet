//! 顶栏状态位（agent 状态文案）—— 窗口运行时状态，不随 Profile、不持久化、重启回缺省。
//!
//! 唯一真值点仍是 Node 的 `src/services/titlebar.ts`（owner/优先级仲裁在那里：
//! 运行期的 typing 阶段文案、proactive presence 等各自 `setTitlebarStatus`/
//! `releaseTitlebarStatus`，由 `renderOwner()` 汇总成最终文本）。本模块**不重实现
//! 仲裁**，只持有最终文本的一份内存快照：
//!
//! - Node 侧在 `renderOwner()` 渲染出结果处把**最终文本**推给宿主
//!   （`UiHandle::apply_titlebar_status`；推送命令名由接线代理登记，见执行契约的
//!   推送面）；未收到任何推送时保持缺省 [`DEFAULT_TEXT`] —— 与 Node 初值一致；
//! - Node 不在时没有推送者：宿主在两种**可确知**的故障场景自推「服务未连接」中性
//!   文案，写进**同一状态位**（不另建提示通道、不另建状态位）——
//!   · 首次拉起失败 → [`SERVICE_UNAVAILABLE_TEXT`]（`main.rs` 的 `on_ui_ready`
//!     Err 分支）；
//!   · 崩溃重启耗尽（监督器终态）→ [`SERVICE_CRASHED_TEXT`]（由
//!     [`TitlebarAvailabilityHook`] 订阅监督器的服务可用性出口写入）；
//! - 恢复路径都把宿主自推的提示清回缺省、不永久钉住：Node 一旦推送，其最终文本
//!   即整体覆盖提示；监督器报告新一代际可用时 [`clear_service_hint`] 把服务提示
//!   清回缺省（只清宿主自推的两条，不覆盖 Node 推送）；
//! - 文本为空/空白与 `None` 同义：回到缺省（Node 的 `renderOwner` 在无 owner 时
//!   回落 `DEFAULT_TEXT`，空文本只在 owner 携带空串时出现，而生产端
//!   `emitStageHint` 对空文案走的是 release 分支）；
//! - 缺省是**中性空闲态**，不是在线/在播：无 owner = 没有角色在活动，不得用
//!   「配信中」这类文案谎报在线（2026-10-05 用户报告）；
//! - 重启归缺省：状态只在进程内存里，不落盘、不进 localStorage 的对应物。
//!
//! 本模块还持有**条内几何的单一来源**（条高、品牌槽、状态位起点、条内边距、右侧
//! 按钮链与垂直居中规则）：平台各自的渲染（macOS AppKit 视图 / Windows 子窗口）与
//! 只在一侧存在的控件（macOS 的「设置」、Windows 的关闭「×」）仍由平台实现 ——
//! 不把一侧的渲染抽象成另一侧也要用的假接口。平台如何绘制（字体、控件栈）在
//! `platform/{macos,windows}*.rs`；本模块可在测试里直接驱动。

use std::sync::{Mutex, OnceLock};

use crate::host::supervisor::{ServiceAvailability, ServiceAvailabilityHook};
use crate::rust_warn;
use crate::ui::UiHandle;

/// 缺省文案（与 `src/services/titlebar.ts` 的初值 `text: DEFAULT_TEXT` 同字面量）。
pub const DEFAULT_TEXT: &str = "就绪";

/// 宿主自推的「服务未连接」文案：**只用于「Node 从未拉起成功」这一宿主自推场景**。
///
/// 正常路径下本模块只持 Node 推送的最终文本快照（唯一真值点在 Node 的
/// `src/services/titlebar.ts`）；Node 不在时没有推送者，由宿主在启动失败处
/// （`main.rs` 的 `on_ui_ready` Err 分支）直接写这一条。文案中性、非角色口吻，
/// 只陈述宿主可确知的事实，不谎报在线/在播；Node 此后一旦推送即被其文本覆盖。
pub const SERVICE_UNAVAILABLE_TEXT: &str = "服务未连接（后台进程启动失败）";

/// 宿主自推的「服务未连接」文案：**只用于「崩溃重启耗尽」这一宿主自推场景**。
///
/// 监督器在崩溃重启重试次数耗尽后不再产生新代际（终态 Crashed），由
/// [`TitlebarAvailabilityHook`] 把这一条写进同一状态位。与
/// [`SERVICE_UNAVAILABLE_TEXT`] 同结构、同口吻：只陈述可确知的事实 —— 服务未连接、
/// 后台进程发生多次崩溃（重启耗尽必然跨过「尝试次数 > 上限」的门槛，即崩溃不止
/// 一次），不写「已放弃恢复」这类实现措辞、不谎报在线。非角色口吻；Node 此后一旦
/// 推送即被其文本覆盖，恢复路径见 [`clear_service_hint`]。
pub const SERVICE_CRASHED_TEXT: &str = "服务未连接（后台进程多次崩溃）";

fn slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<String>> {
    slot().lock().unwrap_or_else(|error| error.into_inner())
}

/// 写入状态文本（`None`/空白 = 回落缺省）；返回生效文本。
pub fn store(text: Option<String>) -> String {
    let normalized = text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    *lock() = normalized;
    current()
}

/// 当前生效文本（未收到推送或推送为空 → [`DEFAULT_TEXT`]）。
pub fn current() -> String {
    lock().clone().unwrap_or_else(|| DEFAULT_TEXT.to_string())
}

/// 文本是否属于「宿主自推的服务提示」（Node 从不推送这两个字面量，据此区分
/// 「宿主写的故障提示」与「Node 的最终文本」）。
fn is_service_hint(text: &str) -> bool {
    text == SERVICE_UNAVAILABLE_TEXT || text == SERVICE_CRASHED_TEXT
}

/// 服务恢复（监督器报告新一代际可用）：当前文本是宿主自推的服务提示时清回缺省，
/// 返回是否发生了清理。
///
/// 只动宿主自推的两条提示：Node 推送的最终文本（唯一真值点）原样保留 —— 恢复
/// 事件与 Node 的首次推送可能先后到达，无条件清空会覆盖刚到达的 Node 文本。
pub fn clear_service_hint() -> bool {
    let mut guard = lock();
    if guard.as_deref().is_some_and(is_service_hint) {
        *guard = None;
        return true;
    }
    false
}

/// 监督器服务可用性出口 → 顶栏接线（服务模式下由 `main.rs` 装配，复用
/// `apply_titlebar_status`，不另建提示通道）。
///
/// 监督器只在两个时机调用出口（见 [`ServiceAvailabilityHook`]）：
/// - 终态不可用（崩溃重启耗尽等）：Node 已死、没有推送者，写
///   [`SERVICE_CRASHED_TEXT`]；
/// - 新一代际握手成功：把宿主自推的服务提示清回缺省（[`clear_service_hint`]），
///   Node 推送的文本不受影响；没有服务提示时不触碰状态位。
///
/// 顶栏刷新失败只留痕（`rust_warn!`）：服务状态本身已由监督器日志与状态位如实
/// 记录，提示是派生展示，不是需要回抛给监督器的失败。
pub struct TitlebarAvailabilityHook {
    ui: UiHandle,
}

impl TitlebarAvailabilityHook {
    pub fn new(ui: UiHandle) -> Self {
        Self { ui }
    }
}

impl ServiceAvailabilityHook for TitlebarAvailabilityHook {
    fn on_service_availability(&self, availability: &ServiceAvailability) {
        let text = match availability {
            ServiceAvailability::Unavailable { .. } => Some(SERVICE_CRASHED_TEXT.to_string()),
            ServiceAvailability::Available { .. } => {
                if !clear_service_hint() {
                    return;
                }
                None
            }
        };
        if let Err(error) = self.ui.apply_titlebar_status(text) {
            rust_warn!("顶栏服务提示更新失败（监督器服务可用性出口）: {error}");
        }
    }
}

// ==========================================
// 条内几何（两平台消费的单一来源）
// ==========================================
//
// 全窗宽顶栏的条高、品牌槽与状态区起点、条内边距和右侧按钮链是两平台**同一套**
// 布局规则；历史上各持两份定义点（`platform/*_main.rs` 与 `platform/*_chat.rs`
// 的旧顶栏副本互为镜像）。旧顶栏退场后收口到这里：平台只消费这些常量与纯函数，
// 不再落第二份宽度/坐标算式。
//
// 单位是逻辑 pt（Windows 侧按 DPI 缩放后使用）；坐标约定：条左上为原点、y 轴向下。

/// 条高：全窗宽顶栏占的高度；也是聊天列容器/画布顶部预留的带高（两平台同值）。
pub const HEIGHT: f64 = 26.0;
/// 品牌文案（固定字样，不随 Profile / 编辑，不可自定义；2026-10-05 用户拍板全名）。
pub const BRAND_TEXT: &str = "V1rtual-Desk-Pet";
/// 品牌字起点（条左内边距，pt）。
pub const BRAND_X: f64 = 8.0;
/// 条内控件高度（按钮 / 状态位控件；条内垂直居中）。
pub const CONTROL_HEIGHT: f64 = 18.0;
/// 品牌槽估算宽度的余量（pt）：品牌字用粗体渲染，比半角估算宽，宁可多留一截也
/// 不让品牌字尾部出现省略号。历史值 macOS 12 / Windows 14 无平台理由、属漂移，
/// 随共享收口取较大者（品牌槽无可见底，唯一可测差异是 macOS 侧状态区锚点 +2pt）。
const BRAND_MARGIN: f64 = 14.0;
/// 品牌槽右缘与状态区锚点之间的间距（pt）。
pub const STATUS_GAP: f64 = 8.0;
/// 状态位前的强调圆点（设计稿 `.status i`：6pt 圆）与圆点到文字的间距。
/// macOS 在条内按此绘制；Windows 的圆点画在状态文字左侧（渲染口径各平台自定）。
pub const DOT_SIZE: f64 = 6.0;
pub const DOT_GAP: f64 = 5.0;
/// 状态文字槽的宽度下限（再窄就没法读了；两平台同值）。
pub const MIN_STATUS_WIDTH: f64 = 24.0;
/// 右侧按钮链：距窗口右缘的边距与相邻按钮之间的间距（pt）。
pub const RIGHT_MARGIN: f64 = 4.0;
pub const BUTTON_GAP: f64 = 4.0;

/// 品牌槽宽 = 11pt 档位的字宽估算 + 余量。
pub fn brand_width() -> f64 {
    crate::ui::chat::panels::estimated_text_width(BRAND_TEXT, 11.0) + BRAND_MARGIN
}

/// 状态区锚点 x = 品牌槽右缘 + [`STATUS_GAP`]。
///
/// 两平台对锚点的用法不同（渲染差异，都基于同一条锚点规则）：macOS 以它为圆点
/// 左缘（文字再右移 `DOT_SIZE + DOT_GAP`）；Windows 以它为状态文字起点（圆点在
/// 文字左侧另行绘制）。
pub fn status_x() -> f64 {
    BRAND_X + brand_width() + STATUS_GAP
}

/// 条内垂直居中：控件高 `control_height`（逻辑 pt）时的上边距。
pub fn centered_y(control_height: f64) -> f64 {
    (HEIGHT - control_height) / 2.0
}

/// 状态文字槽宽 = 状态区锚点到右侧保留之间的宽度（下限 [`MIN_STATUS_WIDTH`]）。
pub fn status_slot_width(width: f64, right_reserve: f64) -> f64 {
    (width - status_x() - right_reserve).max(MIN_STATUS_WIDTH)
}

/// 右侧按钮链的左缘 x（从右到左；`widths` 按同一顺序给各按钮宽度，逻辑 pt）。
///
/// 链首距窗口右缘 [`RIGHT_MARGIN`]，逐枚再退 [`BUTTON_GAP`]；负坐标钳到 0。
pub fn right_button_x(width: f64, widths: &[f64]) -> Vec<f64> {
    let mut x = width - RIGHT_MARGIN;
    let mut out = Vec::with_capacity(widths.len());
    for button_width in widths {
        x -= button_width;
        out.push(x.max(0.0));
        x -= BUTTON_GAP;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单测合一：全局槽是进程级单例，多个测试分开跑会并行互相覆盖。
    #[test]
    fn 状态位缺省写入与回落语义() {
        *lock() = None;
        assert_eq!(current(), DEFAULT_TEXT, "缺省与 vue 初值同字面量");
        // 缺省必须是中性空闲文案：没有状态可拿时不得谎报在线（旧缺省「配信中」
        // 把空闲显示成在播/在线，2026-10-05 用户报告）。
        assert_eq!(DEFAULT_TEXT, "就绪", "缺省文案是中性空闲态");
        assert_ne!(DEFAULT_TEXT, "配信中", "缺省不得回落成「配信中」");

        // 宿主自推的「服务未连接」（Node 从未拉起成功时由 main.rs 直接写入）：
        // 非空、且必须区别于中性缺省 —— 否则故障会被显示成「就绪」，用户以为服务可用。
        assert!(
            !SERVICE_UNAVAILABLE_TEXT.trim().is_empty(),
            "服务未连接文案不得为空白（空白等价于未写入）"
        );
        assert_ne!(
            SERVICE_UNAVAILABLE_TEXT, DEFAULT_TEXT,
            "故障文案不得与缺省同字面量"
        );
        let applied = store(Some(SERVICE_UNAVAILABLE_TEXT.into()));
        assert_eq!(applied, SERVICE_UNAVAILABLE_TEXT, "写入后生效的就是它");
        assert_eq!(current(), SERVICE_UNAVAILABLE_TEXT, "写入后可原样取回");
        assert_ne!(current(), "就绪", "服务未连接不得回落成缺省文案");

        // 终态崩溃文案（崩溃重启耗尽，由监督器服务可用性出口写入同一状态位）：
        // 非空、区别于缺省、也区别于「首次拉起失败」—— 两个故障场景不同形，便于区分。
        assert!(
            !SERVICE_CRASHED_TEXT.trim().is_empty(),
            "崩溃耗尽文案不得为空白（空白等价于未写入）"
        );
        assert_ne!(SERVICE_CRASHED_TEXT, DEFAULT_TEXT);
        assert_ne!(
            SERVICE_CRASHED_TEXT, SERVICE_UNAVAILABLE_TEXT,
            "两个宿主自推场景不同形，便于区分归因"
        );
        assert_eq!(
            store(Some(SERVICE_CRASHED_TEXT.into())),
            SERVICE_CRASHED_TEXT
        );
        assert_eq!(current(), SERVICE_CRASHED_TEXT);

        // 恢复时机：宿主自推的服务提示清回缺省（不永久钉住）；无提示时是空操作。
        assert!(clear_service_hint(), "崩溃提示必须可被清回缺省");
        assert_eq!(current(), DEFAULT_TEXT);
        assert!(!clear_service_hint(), "没有服务提示时清理是空操作");
        // Node 推送的文本不是服务提示：恢复清理不得覆盖它。
        store(Some("正在输入…".into()));
        assert!(!clear_service_hint(), "Node 推送的最终文本不清理");
        assert_eq!(current(), "正在输入…");
        // 「首次拉起失败」的提示同属服务提示：新一代际可用时一并清掉。
        store(Some(SERVICE_UNAVAILABLE_TEXT.into()));
        assert!(clear_service_hint());
        assert_eq!(current(), DEFAULT_TEXT);

        // 出口接线：终态把崩溃文案写进同一状态位；恢复清回缺省（不永久钉住）。
        // UiHandle 的队列以本测试线程为主线程（run_on_main 就地执行）；平台刷新在
        // 无窗口的测试进程里按各自守护跳过，只动状态位。
        let hook = TitlebarAvailabilityHook::new(UiHandle::new(crate::ui::MainThreadQueue::new()));
        hook.on_service_availability(&ServiceAvailability::Unavailable {
            node_epoch: 0,
            detail: "测试：超过自动重启上限".into(),
        });
        assert_eq!(
            current(),
            SERVICE_CRASHED_TEXT,
            "监督器终态必须把崩溃文案写进同一状态位"
        );
        hook.on_service_availability(&ServiceAvailability::Available { node_epoch: 1 });
        assert_eq!(
            current(),
            DEFAULT_TEXT,
            "监督器报告恢复必须清回缺省，不把提示永久钉住"
        );

        let applied = store(Some("正在输入…".into()));
        assert_eq!(applied, "正在输入…");
        assert_eq!(current(), "正在输入…");

        // 空白与 None 同义：回落缺省（不是显示一个空框）。
        store(Some("   ".into()));
        assert_eq!(current(), DEFAULT_TEXT);
        store(Some(" 陪着你 ".into()));
        assert_eq!(current(), "陪着你", "两端空白被裁剪");
        store(None);
        assert_eq!(current(), DEFAULT_TEXT);
        *lock() = None;
    }

    // ── 条内几何纯函数（两平台同一套算式；不碰全局状态，可并行）──

    /// 品牌槽容得下全名（否则尾部省略号），状态区锚点在品牌槽右缘之后（不重叠）。
    #[test]
    fn 品牌槽容得下全名且状态区不压品牌槽() {
        assert_eq!(BRAND_TEXT, "V1rtual-Desk-Pet");
        let text_w = crate::ui::chat::panels::estimated_text_width(BRAND_TEXT, 11.0);
        assert!(
            brand_width() > text_w,
            "品牌槽放不下全名（槽 {}，估算 {text_w}）",
            brand_width()
        );
        assert_eq!(status_x(), BRAND_X + brand_width() + STATUS_GAP);
        assert!(status_x() >= BRAND_X + brand_width(), "状态区锚点压住了品牌槽");
    }

    /// 最短窗宽（`MAIN_WINDOW_MIN_WIDTH`）下：两平台各自的右缘保留都能留下可读的
    /// 状态文字槽（macOS 46 = 设置按钮一侧；Windows 30 = 关闭「×」一侧）。
    #[test]
    fn 最短窗宽下状态文字槽仍可读() {
        for reserve in [46.0, 30.0] {
            let slot = status_slot_width(crate::window::MAIN_WINDOW_MIN_WIDTH, reserve);
            assert!(
                slot >= MIN_STATUS_WIDTH,
                "最短窗宽下状态槽被压没（右缘保留 {reserve}，槽 {slot}）"
            );
        }
        // 退化宽度按下限兜底（不产生负宽）。
        assert_eq!(status_slot_width(100.0, 46.0), MIN_STATUS_WIDTH);
    }

    /// 垂直居中：控件高在条高内居中（品牌字、圆点、按钮、状态控件共用）。
    #[test]
    fn 条内控件垂直居中() {
        assert_eq!(centered_y(HEIGHT), 0.0);
        assert_eq!(centered_y(CONTROL_HEIGHT), (HEIGHT - CONTROL_HEIGHT) / 2.0);
        assert_eq!(centered_y(DOT_SIZE), (HEIGHT - DOT_SIZE) / 2.0);
    }

    /// 右侧按钮链：从右到左、边距与间距恒定；退化宽度不产生负坐标。
    #[test]
    fn 右侧按钮链从右到左排布() {
        let xs = right_button_x(448.0, &[34.0, 34.0]);
        assert_eq!(xs.len(), 2, "每个按钮一个左缘 x");
        assert_eq!(xs[0], 448.0 - RIGHT_MARGIN - 34.0);
        assert_eq!(xs[1], 448.0 - RIGHT_MARGIN - 34.0 - BUTTON_GAP - 34.0);
        let xs = right_button_x(448.0, &[22.0]);
        assert_eq!(xs, vec![448.0 - RIGHT_MARGIN - 22.0]);
        for x in right_button_x(10.0, &[34.0]) {
            assert!(x >= 0.0, "退化宽度不得产生负坐标");
        }
    }
}
