// ==========================================
// 宿主唯一事件出口：生产者事件的组合路由
// ==========================================
//
// 两条宿主侧事件生产者（`monitor::spawn_monitor_thread` 的 `window-observed` 与
// `commands::cursor::spawn_cursor_tracker` 的 `deskpet-cursor-move`）只依赖
// [`EventSink`]。本模块是出口的实现，按 原生宿主迁移过程记录 §9.4 的冻结裁定路由：
//
// 1. `CursorMoved`：**只**直投原生 UI（原生宿主迁移过程记录 §9.4 第 1 条：该事件不进 Node 侧
//    `HostEventMap`；60fps 经 Node + IPC 转发没有意义）。原生 UI 的消费口是
//    [`NativeEventSink`]，由 UI 域实现（当前实现见 `ui/stage.rs`）。
// 2. `WindowObserved`：**双投** —— 原生 UI 与 Node（原生宿主迁移过程记录 §9.4 第 2 条）。Node 侧的
//    负载适配复用 W2 的 [`BridgeEventSink`]（线载荷形状唯一），但桥必须**按当前
//    代际即时解析**：Node 崩溃重启换代际时监督器会丢弃旧桥（`rotate_epoch`），
//    缓存住某个 `BridgeEventSink`/`HostBridge` 只会把事件投给死桥。这里每次
//    emit 都取 `supervisor.current_bridge()`，事件永远发给当前代际；没有活动桥
//    （Node 未启动 / 崩溃轮换窗口内）时按「观察是当前状态读模型、不重放」跳过
//    并留痕，等下一次采样。
//
// 这是全应用唯一的事件广播点：不得为此再建第二条广播路径，业务代码也不感知路由。

use std::sync::Arc;

use crate::host::supervisor::NodeSupervisor;
use crate::host::{CursorPosition, EventSink, HostEvent, WindowObservation};
use crate::ipc::bridge::BridgeEventSink;
use crate::rust_debug;

/// 原生 UI 侧的事件直投口（进程内同线程语义由实现决定；出口不关心 UI 结构）。
pub trait NativeEventSink: Send + Sync {
    /// 全局光标位置变化（`deskpet-cursor-move` 的直连消费者：主窗舞台渲染器）。
    fn cursor_moved(&self, cursor: CursorPosition);
    /// 窗口观察采样（与 Node 双投；原生 UI 一侧按自身需要消费）。
    fn window_observed(&self, observation: &WindowObservation);
}

/// 宿主唯一事件出口的组合实现（`main.rs` 装配后交给两条生产者）。
pub struct HostEventRouter {
    supervisor: Arc<NodeSupervisor>,
    native: Arc<dyn NativeEventSink>,
}

impl HostEventRouter {
    pub fn new(supervisor: Arc<NodeSupervisor>, native: Arc<dyn NativeEventSink>) -> Self {
        Self { supervisor, native }
    }

    /// `window-observed` → Node：解析**当前**桥，适配负载后投递。
    ///
    /// 每代际即时解析的理由见模块头；`BridgeEventSink` 只在本次投递内存在。
    /// `bash-background-finished`（前台超时转后台的命令结束）同走这条路径，同样不重放：
    /// 无活动桥时按「一次性事实、无消费者」丢弃并留痕（与观察采样的差别：
    /// 观察是当前状态读模型、等下一次采样即可，后台结束是终点事件，丢了就是丢了）。
    fn forward_to_node(&self, event: HostEvent) {
        let Some(bridge) = self.supervisor.current_bridge() else {
            rust_debug!(
                "宿主事件未投 Node：当前没有活动桥（Node 未就绪或代际轮换窗口内），按不重放处理"
            );
            return;
        };
        let scope = bridge.default_scope();
        BridgeEventSink::new(bridge, scope).emit(event);
    }
}

impl EventSink for HostEventRouter {
    fn emit(&self, event: HostEvent) {
        match event {
            // 原生宿主迁移过程记录 §9.4 第 1 条：光标事件只直投原生 UI，不经 Node。
            HostEvent::CursorMoved(cursor) => self.native.cursor_moved(cursor),
            // 原生宿主迁移过程记录 §9.4 第 2 条：窗口观察双投（原生 UI + 当前代际 Node）。
            HostEvent::WindowObserved(observation) => {
                self.native.window_observed(&observation);
                self.forward_to_node(HostEvent::WindowObserved(observation));
            }
            // 后台命令结束只有 Node 侧消费者（完成通知走聊天系统消息），单投。
            finished @ HostEvent::BackgroundCommandFinished(_) => {
                self.forward_to_node(finished)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::supervisor::{NodeSupervisor, SupervisorConfig};
    use crate::ipc::protocol::LaunchInfo;
    use std::sync::Mutex;

    /// 记录原生 UI 实际收到的事件（断言路由，不触碰真实 UI）。
    #[derive(Default)]
    struct RecordingNative {
        cursors: Mutex<Vec<CursorPosition>>,
        observations: Mutex<Vec<WindowObservation>>,
    }

    impl NativeEventSink for RecordingNative {
        fn cursor_moved(&self, cursor: CursorPosition) {
            self.cursors
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(cursor);
        }

        fn window_observed(&self, observation: &WindowObservation) {
            self.observations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(observation.clone());
        }
    }

    /// 未拉起任何 Node 的监督器：`current_bridge()` 为 `None`。
    fn idle_supervisor() -> Arc<NodeSupervisor> {
        let config = SupervisorConfig::new(
            LaunchInfo {
                endpoint: String::new(),
                handshake: String::new(),
                node_binary: "/bin/echo".into(),
                entry: "/dev/null".into(),
            },
            "0.0.0-test",
            "boot-test",
            "22.22.3",
        );
        Arc::new(NodeSupervisor::new(config).unwrap())
    }

    fn observation() -> WindowObservation {
        WindowObservation {
            app_id: String::new(),
            app: String::new(),
            title: String::new(),
            observed_at: 1,
            sample_mono_ms: 2,
            monitor_generation: 1,
            sequence: 1,
            observation_state: "disabled".into(),
            idle_for_ms: None,
            is_pet_visible: false,
            is_pet_foreground: false,
        }
    }

    #[test]
    fn 光标只直投原生ui_观察双投且无桥时如实跳过node() {
        let native = Arc::new(RecordingNative::default());
        let router = HostEventRouter::new(idle_supervisor(), native.clone());

        router.emit(HostEvent::CursorMoved(CursorPosition {
            x: 3,
            y: 4,
            screen_x: 0,
            screen_y: 0,
            screen_w: 100,
            screen_h: 100,
        }));
        router.emit(HostEvent::WindowObserved(observation()));

        assert_eq!(
            native
                .cursors
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1,
            "光标事件必须直投原生 UI"
        );
        assert_eq!(
            native
                .observations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1,
            "观察事件的原生 UI 一腿"
        );
        // Node 一腿：没有活动桥时按「不重放」跳过 —— 不 panic、不阻塞、不影响原生投递。
    }
}
