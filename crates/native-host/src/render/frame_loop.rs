//! 帧循环启停状态机（纯逻辑，零平台依赖）。
//!
//! 与 W5 的窗口状态机（`visible -> retracting -> hidden -> revealing -> visible`）的
//! 分工：动画何时结束、何时该停由 W5 决定并调用 [`crate::render::Renderer::stop_frames`]；
//! 本状态机负责把「想要运行/停止」的意图变成**边沿**（重复请求不重复启停平台计时器），
//! 并保证停止状态下到达的 tick 一律被拒绝 —— 它是「隐藏后零帧回调」的第二道防线
//! （第一道是平台计时器真的被取消）。`rejected_ticks` 在正确集成的进程里必须保持 0。

/// [`FrameLoop::set_running`] 的结果：只有真实的 0→1 或 1→0 边沿才要求平台动计时器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoopTransition {
    #[default]
    None,
    Started,
    Stopped,
}

#[derive(Debug, Default)]
pub struct FrameLoop {
    running: bool,
    ticks: u64,
    rejected_ticks: u64,
}

impl FrameLoop {
    /// 表达「希望帧循环运行/停止」。返回边沿：`Started`/`Stopped` 时调用方必须
    /// 真实启/停平台计时器；`None` 表示无变化，不得重复动作。
    pub fn set_running(&mut self, want_running: bool) -> LoopTransition {
        if want_running == self.running {
            return LoopTransition::None;
        }
        self.running = want_running;
        if want_running {
            LoopTransition::Started
        } else {
            LoopTransition::Stopped
        }
    }

    /// 一次 tick 到达。运行中：计数并放行（应呈现一帧）；已停止：拒绝并记违反计数。
    pub fn accept_tick(&mut self) -> bool {
        if self.running {
            self.ticks += 1;
            true
        } else {
            self.rejected_ticks += 1;
            false
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    /// 运行期被接受的 tick 数（= 渲染帧数）。
    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    /// 停止期到达的 tick 数。正确集成下必须为 0；非 0 说明平台计时器没有真的停。
    pub fn rejected_ticks(&self) -> u64 {
        self.rejected_ticks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 启停是边沿触发_重复请求不重复通知平台() {
        let mut loop_state = FrameLoop::default();
        assert_eq!(loop_state.set_running(true), LoopTransition::Started);
        assert_eq!(loop_state.set_running(true), LoopTransition::None);
        assert_eq!(loop_state.set_running(false), LoopTransition::Stopped);
        assert_eq!(loop_state.set_running(false), LoopTransition::None);
        assert_eq!(loop_state.set_running(true), LoopTransition::Started);
        assert!(loop_state.is_running());
    }

    #[test]
    fn 停止后tick被拒绝且计数_恢复后继续计数() {
        let mut loop_state = FrameLoop::default();
        assert_eq!(loop_state.set_running(true), LoopTransition::Started);
        assert!(loop_state.accept_tick());
        assert!(loop_state.accept_tick());
        assert_eq!(loop_state.ticks(), 2);

        assert_eq!(loop_state.set_running(false), LoopTransition::Stopped);
        for _ in 0..3 {
            assert!(!loop_state.accept_tick(), "停止状态不得放行任何 tick");
        }
        assert_eq!(loop_state.ticks(), 2, "被拒绝的 tick 不得计入帧数");
        assert_eq!(loop_state.rejected_ticks(), 3);

        assert_eq!(loop_state.set_running(true), LoopTransition::Started);
        assert!(loop_state.accept_tick());
        assert_eq!(loop_state.ticks(), 3);
        assert_eq!(loop_state.rejected_ticks(), 3, "恢复不重置违反计数");
    }

    #[test]
    fn 未启动时tick一律拒绝() {
        let mut loop_state = FrameLoop::default();
        assert!(!loop_state.is_running());
        assert!(!loop_state.accept_tick());
        assert_eq!(loop_state.ticks(), 0);
        assert_eq!(loop_state.rejected_ticks(), 1);
    }
}
