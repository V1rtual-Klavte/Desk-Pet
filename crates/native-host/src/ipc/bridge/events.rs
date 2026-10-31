//! 事件信封、事件路由与 `EventSink` 实现（宿主事件 → Node）。

use serde_json::Value;
use tokio::sync::broadcast;

use super::HostBridge;
use crate::ipc::protocol::RunScope;

/// 收到的事件（Node → 宿主），带归属 scope 与生产者单调序号。
#[derive(Debug, Clone, PartialEq)]
pub struct EventEnvelope {
    pub event: String,
    pub seq: u64,
    pub payload: Value,
    pub scope: RunScope,
}

/// Node → 宿主事件的广播消费侧（`HostBridge::subscribe_events` 的进程内订阅者）。
///
/// 每个桥代际一个任务：订阅事件广播（`dispatch_event` 已按 scope 丢弃旧代际事件，
/// 这里只会收到当前代际的），按事件名路由进聊天域
/// （[`crate::ui::chat::ChatUi::route_wire_event`]：`ChatEvent::from_wire` →
/// `apply_event` —— 断链 D 的 `deskpet-reveal-progress` 与其余聊天事件共用这一条路）。
///
/// 任务只持广播接收端：桥释放 → 广播关闭 → 任务随 `Closed` 退出，不延长桥的生命周期。
/// 接收滞后（`Lagged`）如实留痕 —— 被丢掉多少条必须可见，不静默。
pub(super) async fn run_event_router(mut events: broadcast::Receiver<EventEnvelope>) {
    loop {
        match events.recv().await {
            Ok(envelope) => {
                match crate::ui::chat::chat_ui()
                    .route_wire_event(&envelope.event, &envelope.payload)
                {
                    Ok(true) => {}
                    // 不属于聊天窗消费子集：Node → 宿主方向当前没有其它消费者
                    // （HostEventMap 与 NodeUiEventName 的差集只有宿主自己的生产事件），
                    // 不在此建空路由，只留调试线索。
                    Ok(false) => {
                        crate::rust_debug!("Node → 宿主事件没有消费子集: {}", envelope.event)
                    }
                    Err(error) => {
                        crate::rust_warn!("Node → 宿主事件路由失败: {}（{error}）", envelope.event)
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                crate::rust_warn!(
                    "Node → 宿主事件路由滞后，丢弃了 {skipped} 条事件（事件通道容量不足）"
                );
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

// ==========================================
// EventSink 实现：宿主事件 → Node
// ==========================================

/// `window-observed` 的线载荷：camelCase，未知身份为 null；这里是唯一定义点。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowObservedWire {
    app_id: Option<String>,
    app: Option<String>,
    title: Option<String>,
    observed_at: i64,
    sample_mono_ms: i64,
    monitor_generation: u64,
    sequence: u64,
    observation_state: String,
    idle_for_ms: Option<i64>,
    is_pet_visible: bool,
    is_pet_foreground: bool,
}

/// 把宿主事件经桥推给 Node（`subscribe` 的另一端）。
pub struct BridgeEventSink {
    bridge: HostBridge,
    scope: RunScope,
}

impl BridgeEventSink {
    pub fn new(bridge: HostBridge, scope: RunScope) -> Self {
        Self { bridge, scope }
    }
}

impl crate::host::EventSink for BridgeEventSink {
    fn emit(&self, event: crate::host::HostEvent) {
        let (name, payload) = match event {
            crate::host::HostEvent::WindowObserved(observation) => {
                let payload = WindowObservedWire {
                    app_id: unknown_to_null(observation.app_id),
                    app: unknown_to_null(observation.app),
                    title: unknown_to_null(observation.title),
                    observed_at: observation.observed_at,
                    sample_mono_ms: observation.sample_mono_ms,
                    monitor_generation: observation.monitor_generation,
                    sequence: observation.sequence,
                    observation_state: observation.observation_state,
                    idle_for_ms: observation.idle_for_ms,
                    is_pet_visible: observation.is_pet_visible,
                    is_pet_foreground: observation.is_pet_foreground,
                };
                (
                    "window-observed",
                    serde_json::to_value(payload).unwrap_or(Value::Null),
                )
            }
            // 后台命令结束：载荷本身即线形状（host/mod.rs 的 serde 属性是唯一定义点；
            // TS 侧 `BashBackgroundFinishedPayload` 与它逐字对齐）。
            crate::host::HostEvent::BackgroundCommandFinished(finished) => (
                "bash-background-finished",
                serde_json::to_value(finished).unwrap_or(Value::Null),
            ),
        };
        if let Err(err) = self.bridge.publish_event(name, payload, self.scope.clone()) {
            crate::rust_warn!("{name} 事件投递失败: {err}");
        }
    }
}

fn unknown_to_null(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
