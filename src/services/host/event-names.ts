// ==========================================
// 线协议事件名 —— 唯一取用点（TS ↔ Rust 按这些字节分发）
// ==========================================
//
// 事件名是跨语言线格式的一部分，字符串值逐字冻结（改值 = 改线协议，须同步 Rust 分派）：
//   · `HOST_EVENT_*`   = `HostEventMap`（./types.ts）的键 —— 宿主/Node → UI 的推送事件名；
//   · `UI_RECEIPT_*`   = `UiReceiptMap`（./ui-events.ts）的键 —— UI → Node 的回执事件名；
//   · `HOST_REQUEST_EVENT` = 宿主 → Node 请求通道的事件名。
// 消费点一律 import 本文件（host barrel 再导出），不写第二处字面量；
// `HostEventMap` / `UiReceiptMap` / `NodeUiEventName` 的键都按这些常量计算，
// 常量与矩阵键的漂移由 tsc 在全部消费点收口。
// 本文件是零依赖叶子（没有 import）：types.ts 与 ui-events.ts 都要引用它，
// 放这里避免「类型矩阵 ↔ 事件端口」互相 import。

// ── 宿主/Node → UI（HostEventMap 的键）──

/** 系统观察采样（Rust monitor 线程 emit，monitor/thread.rs）。 */
export const HOST_EVENT_WINDOW_OBSERVED = "window-observed"
/** 后台命令结束（Rust `commands/tool_exec/bash.rs` 的等待线程 emit；只投 Node）。 */
export const HOST_EVENT_BASH_BACKGROUND_FINISHED = "bash-background-finished"
/**
 * 光标位置推送（Rust commands/cursor.rs；只直投原生 UI，不经 Node 转发，
 * 列入矩阵只为保住契约形状）。
 */
export const HOST_EVENT_CURSOR_MOVE = "deskpet-cursor-move"
/** 助手流式增量（Node `engine/harness/runtime.ts` 生产；Rust 分派见 `ui/chat/events.rs`）。 */
export const HOST_EVENT_ASSISTANT_STREAM = "deskpet-assistant-stream"
/** 流式收尾（同 `HOST_EVENT_ASSISTANT_STREAM`）。 */
export const HOST_EVENT_ASSISTANT_STREAM_END = "deskpet-assistant-stream-end"
/** 阶段提示（只发语义 key，文案由 UI 按当前 Card 取）。 */
export const HOST_EVENT_STAGE_HINT = "deskpet-stage-hint"
/** 工具开始（Node → UI；Rust 分派见 `ui/chat/events.rs`）。 */
export const HOST_EVENT_TOOL_EXECUTING = "tool-executing"
/** 工具结束（同 `HOST_EVENT_TOOL_EXECUTING`）。 */
export const HOST_EVENT_TOOL_COMPLETED = "tool-completed"
/** 运行态通知（UI 只据此显示/收起停止按钮；真相源是 Node 的运行槽）。 */
export const HOST_EVENT_RUN_STATE = "deskpet-run-state"
/** 发送投递归宿（「已排队插话」「稍后继续」这类回执的真相源）。 */
export const HOST_EVENT_SEND_OUTCOME = "deskpet-send-outcome"
/** 分泡揭示进度（humanizer 调度器状态变化的投影）。 */
export const HOST_EVENT_REVEAL_PROGRESS = "deskpet-reveal-progress"
/** 待确认计划（含全部步骤）。 */
export const HOST_EVENT_PLAN_START = "deskpet-plan-start"
/** 计划步骤进度。 */
export const HOST_EVENT_PLAN_PROGRESS = "deskpet-plan-progress"
/** 步骤门（逐步前置/失败询问）。 */
export const HOST_EVENT_PLAN_STEP_GATE = "deskpet-plan-step-gate"
/** 计划收尾（收起面板）。 */
export const HOST_EVENT_PLAN_END = "deskpet-plan-end"
/** 待答提问（`ask_user` 工具）。 */
export const HOST_EVENT_CHOICE_START = "deskpet-choice-start"
/** 提问收尾（收起对应面板）。 */
export const HOST_EVENT_CHOICE_END = "deskpet-choice-end"
/** 权限确认请求（Node → UI；回执方向见 `UI_RECEIPT_PERMISSION_CONFIRM_RESOLVED`）。 */
export const HOST_EVENT_PERMISSION_CONFIRM = "deskpet-permission-confirm"

// ── UI → Node 回执（UiReceiptMap 的键；Rust 侧同名常量见
//    `crates/native-host/src/ui/chat/intents.rs` 的 RECEIPT_*）──

/** UI 结算一条待确认计划（面板确认/取消）。 */
export const UI_RECEIPT_PLAN_CONFIRM_RESOLVED = "deskpet-plan-confirm-resolved"
/** UI 对步骤门给出裁决（continue / abort）。 */
export const UI_RECEIPT_PLAN_STEP_DECISION = "deskpet-plan-step-decision"
/** UI 对一条提问的应答（picked / other / cancelled）。 */
export const UI_RECEIPT_CHOICE_RESOLVED = "deskpet-choice-resolved"
/** UI 对一条权限确认请求的应答（allow_once / allow_session / deny）。 */
export const UI_RECEIPT_PERMISSION_CONFIRM_RESOLVED = "deskpet-permission-confirm-resolved"

// ── 宿主 → Node 请求通道 ──

/**
 * 宿主 → Node 请求的事件名（`HostRequestEnvelope` 经它投递）。
 *
 * 名称是**传输细节**（方法与载荷形状的唯一定义点在 `HostRequestMap`）；改名必须与
 * `crates/native-host/src/ui/ports.rs` 的同一常量同步。
 */
export const HOST_REQUEST_EVENT = "deskpet-host-request"
