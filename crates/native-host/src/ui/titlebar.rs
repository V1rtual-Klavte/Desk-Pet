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
//! - 文本为空/空白与 `None` 同义：回到缺省（Node 的 `renderOwner` 在无 owner 时
//!   回落 `DEFAULT_TEXT`，空文本只在 owner 携带空串时出现，而生产端
//!   `emitStageHint` 对空文案走的是 release 分支）；
//! - 缺省是**中性空闲态**，不是在线/在播：无 owner = 没有角色在活动，不得用
//!   「配信中」这类文案谎报在线（2026-10-05 用户报告）；
//! - 重启归缺省：状态只在进程内存里，不落盘、不进 localStorage 的对应物。
//!
//! 平台如何呈现（标签位置/字体）在 `platform/{macos,windows}*.rs`；本模块可在
//! 测试里直接驱动。

use std::sync::{Mutex, OnceLock};

/// 缺省文案（与 `src/services/titlebar.ts` 的初值 `text: DEFAULT_TEXT` 同字面量）。
pub const DEFAULT_TEXT: &str = "就绪";

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
}
