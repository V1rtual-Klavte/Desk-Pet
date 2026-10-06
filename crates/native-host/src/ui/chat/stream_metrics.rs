//! 流式渲染的 dev 观测钩子 ——「流式 delta 减负」的 A/B 取数点。
//!
//! 目的：给总表 §8「发消息卡顿余项」的『按实测 A/B 确认收益』提供可复现的数字 ——
//! 每次渲染更新的耗时、渲染类别与次数、尾巴重建 / 整帧重建 / 强制文本排版的次数，
//! 按**一段流式**累计成窗口，在边界经既有 `rust_debug!` 通道汇总一行。
//!
//! 接线（三个调用方）：
//! - [`ChatUi::drain_refresh`](super::ui::ChatUi) 在每次真的把更新交给平台前取
//!   [`RenderKey`]，平台返回后 [`note_render`] 记一笔（计时含平台重建整体耗时）；
//! - 平台层流式渲染段在「重建尾巴 / 重建整帧 / 强制排版」处调用
//!   [`note_tail_rebuild`] / [`note_full_rebuild`] / [`note_text_layout`]（只报次数，
//!   平台不各写一份分段计时 —— 口径可比、两平台同义）；
//! - 尾巴清空帧（[`is_stream_cleared`]）是一次流式收尾：[`flush`] 汇总本段并清零；
//!   窗口满 [`REPORT_EVERY`] 次也兜底汇总（流式没有干净收尾时仍拿得到数字）。
//!
//! 纪律：
//! - **默认不吵**：只有窗口边界一行 `rust_debug!`，不逐条打印；
//! - **dev-only**：公开函数首行 `cfg!(debug_assertions)` 短路（编译期常量，release
//!   里整段统计被优化掉），不产生运行期开销；
//! - 计数是进程级累计（互斥量 + 纯数据），任意线程可调；窗口数据与
//!   [`MetricsWindow::report_line`] 都是纯函数，单测直接钉住口径。
//!
//! 典型 A/B 判读：同一条回复在改动前后各跑一次，对比汇总行的
//!「更新次数 / 平均 / 最大 / 尾巴重建 / 文本重排」——**没有实跑就不要下结论**。

use std::sync::Mutex;

use super::model::ChatRenderUpdate;

/// 窗口兜底上限：累计满这么多次渲染更新就强制汇总一行（长回复 / 无干净收尾）。
const REPORT_EVERY: u64 = 256;

/// 一次渲染更新的类别（与 [`ChatRenderUpdate`] 的三条路径一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderKind {
    /// `StreamOnly`：只换流式尾巴。
    Stream,
    /// `Full`：整帧重建（正文列表 + 面板 + 标签条等）。
    Full,
    /// `StatusOnly`：只换底部状态位。
    Status,
}

impl RenderKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            RenderKind::Stream => "stream",
            RenderKind::Full => "full",
            RenderKind::Status => "status",
        }
    }
}

/// 一次更新的观测键（调度侧在更新被移交给平台**之前**取好）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderKey {
    pub kind: RenderKind,
    /// `StreamOnly` 携带的尾巴文本长度（`None` = 尾巴清空，记 0）；其余类别记 0。
    pub tail_len: usize,
}

impl RenderKey {
    /// 纯函数：从待应用的更新提取观测键。
    pub fn of(update: &ChatRenderUpdate) -> Self {
        match update {
            ChatRenderUpdate::Full(_) => Self {
                kind: RenderKind::Full,
                tail_len: 0,
            },
            ChatRenderUpdate::StreamOnly { text } => Self {
                kind: RenderKind::Stream,
                tail_len: text.as_ref().map(String::len).unwrap_or(0),
            },
            ChatRenderUpdate::StatusOnly(_) => Self {
                kind: RenderKind::Status,
                tail_len: 0,
            },
        }
    }

    /// 本键对应的更新是不是「尾巴清空帧」（[`is_stream_cleared`] 的键形态：
    /// 调度侧在更新被移动后仍能用它判定收尾边界）。
    pub fn closes_stream(self) -> bool {
        self.kind == RenderKind::Stream && self.tail_len == 0
    }
}

/// 尾巴清空帧（`StreamOnly { text: None }`）= 一段流式的收尾：[`flush`] 的取样边界。
pub fn is_stream_cleared(update: &ChatRenderUpdate) -> bool {
    matches!(update, ChatRenderUpdate::StreamOnly { text: None })
}

/// 一个汇总窗口的累计（纯数据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsWindow {
    pub stream_updates: u64,
    pub full_updates: u64,
    pub status_updates: u64,
    /// 每次渲染更新耗时的总和（微秒；计时口径 = 调度侧包裹平台重建的墙钟）。
    pub total_micros: u64,
    pub max_micros: u64,
    /// 平台层「重建流式尾巴」次数（两平台各自的 `update_tail` 入口）。
    pub tail_rebuilds: u64,
    /// 平台层「重建整帧」次数（两平台各自的整帧重建入口）。
    pub full_rebuilds: u64,
    /// 平台层「强制文本排版」次数（macOS 的逐行片段遍历、Windows 的 RichEdit 行数查询）。
    pub text_layouts: u64,
    /// 本窗口见过的最大尾巴文本长度（字节）。
    pub tail_len_max: usize,
}

impl MetricsWindow {
    pub const fn new() -> Self {
        Self {
            stream_updates: 0,
            full_updates: 0,
            status_updates: 0,
            total_micros: 0,
            max_micros: 0,
            tail_rebuilds: 0,
            full_rebuilds: 0,
            text_layouts: 0,
            tail_len_max: 0,
        }
    }

    pub fn updates(&self) -> u64 {
        self.stream_updates + self.full_updates + self.status_updates
    }

    pub fn is_empty(&self) -> bool {
        self.updates() == 0
    }

    /// 记一次渲染更新（耗时单位微秒）。
    pub fn record_render(&mut self, key: RenderKey, micros: u64) {
        match key.kind {
            RenderKind::Stream => self.stream_updates += 1,
            RenderKind::Full => self.full_updates += 1,
            RenderKind::Status => self.status_updates += 1,
        }
        self.total_micros += micros;
        self.max_micros = self.max_micros.max(micros);
        self.tail_len_max = self.tail_len_max.max(key.tail_len);
    }

    /// 平均耗时（微秒；无更新记 0）。
    pub fn avg_micros(&self) -> u64 {
        if self.updates() == 0 {
            return 0;
        }
        self.total_micros / self.updates()
    }

    /// 一行汇总（纯函数；字段顺序与文案是 A/B 对照的字面量，改动即改口径）。
    pub fn report_line(&self) -> String {
        format!(
            "更新 {} 次（流式 {} / 整帧 {} / 状态 {}）· 平均 {}µs · 最大 {}µs · \
             尾巴重建 {} · 整帧重建 {} · 文本重排 {} · 尾巴最长 {}B",
            self.updates(),
            self.stream_updates,
            self.full_updates,
            self.status_updates,
            self.avg_micros(),
            self.max_micros,
            self.tail_rebuilds,
            self.full_rebuilds,
            self.text_layouts,
            self.tail_len_max
        )
    }
}

impl Default for MetricsWindow {
    fn default() -> Self {
        Self::new()
    }
}

/// 进程级窗口（互斥量 + 纯数据；渲染更新是低频路径，无需无锁）。
static WINDOW: Mutex<MetricsWindow> = Mutex::new(MetricsWindow::new());

fn lock_window() -> std::sync::MutexGuard<'static, MetricsWindow> {
    WINDOW.lock().unwrap_or_else(|error| error.into_inner())
}

fn emit(window: &mut MetricsWindow, reason: &str) {
    crate::rust_debug!("流式渲染窗口[{}] {}", reason, window.report_line());
    *window = MetricsWindow::new();
}

/// 记一次渲染更新（调度侧：`ChatUi::drain_refresh` 在平台调用返回后调用）。
pub fn note_render(key: RenderKey, micros: u64) {
    if !cfg!(debug_assertions) {
        return;
    }
    let mut window = lock_window();
    window.record_render(key, micros);
    if window.updates() % REPORT_EVERY == 0 {
        emit(&mut window, "窗口兜底");
    }
}

/// 平台层重建一次流式尾巴（两平台 `update_tail` 入口各调一次）。
pub fn note_tail_rebuild() {
    if !cfg!(debug_assertions) {
        return;
    }
    lock_window().tail_rebuilds += 1;
}

/// 平台层重建一次整帧（两平台整帧入口各调一次）。
pub fn note_full_rebuild() {
    if !cfg!(debug_assertions) {
        return;
    }
    lock_window().full_rebuilds += 1;
}

/// 平台层强制一次文本排版（macOS `text_layout_extent` 的逐行遍历 /
/// Windows `rich_edit_height` 的行数查询）。
pub fn note_text_layout() {
    if !cfg!(debug_assertions) {
        return;
    }
    lock_window().text_layouts += 1;
}

/// 汇总当前窗口并清零（`reason` 是边界名：收尾 / 切会话 / 退出 / 窗口兜底）；
/// 空窗口不打印（不产生噪音行）。
pub fn flush(reason: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let mut window = lock_window();
    if window.is_empty() {
        return;
    }
    emit(&mut window, reason);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::chat::model::StatusSnapshot;

    /// 观测键从三条渲染路径正确提取（尾巴长度只对 `StreamOnly` 有意义）。
    #[test]
    fn 观测键按渲染类别提取尾巴长度() {
        let stream = ChatRenderUpdate::StreamOnly {
            text: Some("你好啊".into()),
        };
        let key = RenderKey::of(&stream);
        assert_eq!(key.kind, RenderKind::Stream);
        assert_eq!(key.tail_len, "你好啊".len());
        assert_eq!(key.kind.as_str(), "stream");

        let cleared = ChatRenderUpdate::StreamOnly { text: None };
        assert!(is_stream_cleared(&cleared), "尾巴清空帧是收尾边界");
        assert_eq!(RenderKey::of(&cleared).tail_len, 0);
        assert!(
            !is_stream_cleared(&stream),
            "有文本的流式帧不是收尾边界（提前汇总会把一段流切碎）"
        );

        let full = ChatRenderUpdate::Full(crate::ui::chat::model::ChatModel::new().snapshot());
        assert_eq!(RenderKey::of(&full).kind, RenderKind::Full);
        assert_eq!(RenderKey::of(&full).tail_len, 0);

        let status = ChatRenderUpdate::StatusOnly(StatusSnapshot::default());
        assert_eq!(RenderKey::of(&status).kind, RenderKind::Status);
    }

    /// 窗口累计：分类计数、平均 / 最大耗时、尾巴最长值；空窗口不打印。
    #[test]
    fn 窗口累计与平均最大耗时() {
        let mut window = MetricsWindow::new();
        assert!(window.is_empty());
        assert_eq!(window.avg_micros(), 0, "空窗口平均为 0（不除零）");
        assert!(window.report_line().contains("更新 0 次"));

        window.record_render(
            RenderKey {
                kind: RenderKind::Stream,
                tail_len: 120,
            },
            300,
        );
        window.record_render(
            RenderKey {
                kind: RenderKind::Stream,
                tail_len: 480,
            },
            900,
        );
        window.record_render(
            RenderKey::of(&ChatRenderUpdate::StreamOnly { text: None }),
            100,
        );
        window.tail_rebuilds = 3;
        window.full_rebuilds = 1;
        window.text_layouts = 6;

        assert_eq!(window.updates(), 3);
        assert_eq!(window.stream_updates, 3);
        assert!(!window.is_empty());
        assert_eq!(window.avg_micros(), (300 + 900 + 100) / 3);
        assert_eq!(window.max_micros, 900);
        assert_eq!(window.tail_len_max, 480, "尾巴最长值取所有流式帧的最大值");

        // 汇总行是 A/B 对照的字面量：字段顺序 / 单位漂移这里先红。
        assert_eq!(
            window.report_line(),
            "更新 3 次（流式 3 / 整帧 0 / 状态 0）· 平均 433µs · 最大 900µs · \
             尾巴重建 3 · 整帧重建 1 · 文本重排 6 · 尾巴最长 480B"
        );
    }

    /// 全量钩子共用一条进程级窗口：计数、兜底窗口与清空边界（单条用例覆盖，
    /// 进程级全局状态不拆多条 —— 并行跑同一二进制会互踩，见 native-host AGENTS §9）。
    #[test]
    fn 全局窗口计数与边界清空() {
        if !cfg!(debug_assertions) {
            // 钩子在 release 构建里按设计空转（`cfg!` 短路）：本用例只对 dev 有效。
            return;
        }
        // 先清零（其它用例不碰全局窗口，但保持幂等）。
        flush("测试清零");

        note_tail_rebuild();
        note_full_rebuild();
        note_text_layout();
        note_render(
            RenderKey {
                kind: RenderKind::Stream,
                tail_len: 7,
            },
            42,
        );
        {
            let window = lock_window();
            assert_eq!(window.tail_rebuilds, 1);
            assert_eq!(window.full_rebuilds, 1);
            assert_eq!(window.text_layouts, 1);
            assert_eq!(window.updates(), 1);
            assert_eq!(window.max_micros, 42);
        }

        // 收尾汇总：清空窗口 → 再 flush 是 no-op（空窗口不打印，也不 panic）。
        flush("收尾");
        {
            let window = lock_window();
            assert!(window.is_empty(), "收尾后窗口清零");
        }
        flush("收尾");
    }
}
