// ==========================================
// 线协议事件名单点守卫 —— 常量值与冻结的线格式字节逐一一致
// ==========================================
//
// 归属 L2 的依据：纯常量值核对（无 IPC、无落盘、无回合）；断言的是「事件名常量的字符串
// 值与 Rust 侧按名分发的字节相同」—— 事件名是跨语言线协议的一部分，改名必须同时改 Rust
// （`crates/native-host/src/ui/chat/events.rs` 的 `ChatEvent::from_wire`、
// `ui/chat/intents.rs` 的 `RECEIPT_*`、`ui/ports.rs` 的 `HOST_REQUEST_EVENT`），
// 否则事件静默无人消费。
//
// 期望值在表里逐字写死、不从常量互相推导：常量漂移时本文件先红（不是 change-detector
// 的反面 —— 被守卫的正是这串冻结字节本身）。

import { describe, expect, it } from "vitest"
import {
  HOST_EVENT_ASSISTANT_STREAM,
  HOST_EVENT_ASSISTANT_STREAM_END,
  HOST_EVENT_BASH_BACKGROUND_FINISHED,
  HOST_EVENT_CHOICE_END,
  HOST_EVENT_CHOICE_START,
  HOST_EVENT_CURSOR_MOVE,
  HOST_EVENT_PERMISSION_CONFIRM,
  HOST_EVENT_PLAN_END,
  HOST_EVENT_PLAN_PROGRESS,
  HOST_EVENT_PLAN_START,
  HOST_EVENT_PLAN_STEP_GATE,
  HOST_EVENT_REVEAL_PROGRESS,
  HOST_EVENT_RUN_STATE,
  HOST_EVENT_SEND_OUTCOME,
  HOST_EVENT_STAGE_HINT,
  HOST_EVENT_TOOL_COMPLETED,
  HOST_EVENT_TOOL_EXECUTING,
  HOST_EVENT_WINDOW_OBSERVED,
  HOST_REQUEST_EVENT,
  UI_RECEIPT_CHOICE_RESOLVED,
  UI_RECEIPT_PERMISSION_CONFIRM_RESOLVED,
  UI_RECEIPT_PLAN_CONFIRM_RESOLVED,
  UI_RECEIPT_PLAN_STEP_DECISION,
} from "@/services/host"

/** [常量, 线格式字节]；右侧与 Rust 分派/发布端同名，逐字冻结。 */
const WIRE_NAMES: Array<[string, string]> = [
  // HostEventMap（宿主/Node → UI）
  [HOST_EVENT_WINDOW_OBSERVED, "window-observed"],
  [HOST_EVENT_BASH_BACKGROUND_FINISHED, "bash-background-finished"],
  [HOST_EVENT_CURSOR_MOVE, "deskpet-cursor-move"],
  [HOST_EVENT_ASSISTANT_STREAM, "deskpet-assistant-stream"],
  [HOST_EVENT_ASSISTANT_STREAM_END, "deskpet-assistant-stream-end"],
  [HOST_EVENT_STAGE_HINT, "deskpet-stage-hint"],
  [HOST_EVENT_TOOL_EXECUTING, "tool-executing"],
  [HOST_EVENT_TOOL_COMPLETED, "tool-completed"],
  [HOST_EVENT_RUN_STATE, "deskpet-run-state"],
  [HOST_EVENT_SEND_OUTCOME, "deskpet-send-outcome"],
  [HOST_EVENT_REVEAL_PROGRESS, "deskpet-reveal-progress"],
  [HOST_EVENT_PLAN_START, "deskpet-plan-start"],
  [HOST_EVENT_PLAN_PROGRESS, "deskpet-plan-progress"],
  [HOST_EVENT_PLAN_STEP_GATE, "deskpet-plan-step-gate"],
  [HOST_EVENT_PLAN_END, "deskpet-plan-end"],
  [HOST_EVENT_CHOICE_START, "deskpet-choice-start"],
  [HOST_EVENT_CHOICE_END, "deskpet-choice-end"],
  [HOST_EVENT_PERMISSION_CONFIRM, "deskpet-permission-confirm"],
  // UiReceiptMap（UI → Node；Rust 侧 RECEIPT_* 同名）
  [UI_RECEIPT_PLAN_CONFIRM_RESOLVED, "deskpet-plan-confirm-resolved"],
  [UI_RECEIPT_PLAN_STEP_DECISION, "deskpet-plan-step-decision"],
  [UI_RECEIPT_CHOICE_RESOLVED, "deskpet-choice-resolved"],
  [UI_RECEIPT_PERMISSION_CONFIRM_RESOLVED, "deskpet-permission-confirm-resolved"],
  // 宿主 → Node 请求通道（Rust ui/ports.rs 的同名常量）
  [HOST_REQUEST_EVENT, "deskpet-host-request"],
]

describe("线协议事件名单点", () => {
  it("常量值与冻结的线格式字节一致（Rust 按同名分发）[host-wire-event-names]", () => {
    for (const [constant, wire] of WIRE_NAMES) {
      expect(constant, "事件名常量与线格式字节不允许漂移").toBe(wire)
    }
  })
})
