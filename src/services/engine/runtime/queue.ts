// 排队视图、向活动回合投递与暂停输入归还：lane 持久 inbox 的产品侧只读入口。
// 纯搬移自 harness/runtime.ts（T1.6 拆入 runtime 编排层），不改变行为。

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { laneMessageText } from "@/services/engine/protocol"
import type { InputSourceMark } from "@/services/engine/protocol"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import type { HarnessCancelQueuedKind, HarnessDeliveryReceipt, HarnessQueuedItem } from "@/services/engine/state"
import { createLogger } from "@/services/logger"

const log = createLogger("PiRuntime")

/**
 * 向正在执行的回合投递新输入，先落盘（lane 持久 inbox）再影响模型。
 *
 * Harness 的语义是「本轮边界注入」，不是立即中止 —— 当前批次里已经开始的工具会照常跑完，
 * 模型在下一轮才会看到这条消息并据此调整；settling 阶段改用 followUp，自然结束前继续处理。
 *
 * @returns 是否有正在执行的回合接收了投递（undefined 表示没有可投递的运行）
 */
export async function deliverActiveTurn(
  sessionId: string,
  text: string,
  identity: { eventId: string; mark?: InputSourceMark; imagePaths?: readonly string[] },
  kind?: "steer" | "followUp" | "nextRun",
): Promise<HarnessDeliveryReceipt | undefined> {
  // §4.2 保留：没有运行槽 = 没有可投递的回合，`undefined` 是如实答复（调用方据此收起/改走正常回合），
  // 不是静默失败；「有 lane 操作但不是宿主回合（压缩在飞）」的区分见 isSessionBusy。
  if (!harnessSlots.isRunning(sessionId)) return undefined
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return undefined
  const receipt = await slot.steer(text, identity, kind)
  if (!receipt) log.warn("投递未生效:", { sessionId, kind: kind ?? "auto" })
  return receipt
}

/**
 * 会话是否忙：宿主回合或 lane 结构操作在飞。唯一「忙」判定的对外出口。
 *
 * `deliverActiveTurn` 的 `undefined` 有两条原因 —— 真没有可投递的回合，与「有 lane 操作
 * 但不是宿主回合（压缩在飞）」。调用方用本方法区分：后者是准入拒绝，不是「改走正常回合」。
 */
export async function isSessionBusy(sessionId: string): Promise<boolean> {
  return await harnessSlots.hasOpenOperation(sessionId)
}

// ── 排队视图与单项撤回（PI-1：UI 不再自建队列状态） ──

export interface QueuedInputsView {
  /**
   * false = 队列镜像不可信：会话还没有运行槽（未打开），或开槽时的初值播种未完成/失败。
   * 此时列表为空不代表「没有排队项」，也不代表「槽不存在」。
   */
  loaded: boolean
  /** 当前运行是否在进行（消费中的项离开列表说明已进入对话）。 */
  running: boolean
  items: HarnessQueuedItem[]
}

/** lane 持久 inbox 的只读排队视图；真相源仍由 Harness 持有。 */
export function listQueuedInputs(sessionId: string): QueuedInputsView {
  const snapshot = harnessSlots.snapshot(sessionId)
  if (!snapshot) return { loaded: false, running: false, items: [] }
  return { loaded: snapshot.queueMirrorReady, running: snapshot.state === "running", items: snapshot.queued }
}

/**
 * 撤回一条尚未被消费的排队项。
 * cancelled / already_consumed / not_found 的语义与 lane.cancelQueued 一致；
 * unavailable 表示该会话的槽或通道当前不可用。
 */
export async function withdrawQueuedInput(sessionId: string, entryId: string): Promise<HarnessCancelQueuedKind> {
  return await harnessSlots.cancelQueued(sessionId, entryId)
}

// ── 停止后继续 / 丢弃（PI-1：归还的暂停输入由用户决定） ──

/**
 * 取出暂停项（停止归还的 nextRun）准备重投递：取出即从 lane inbox 撤回，
 * 所以调用方必须在投递失败时用 returnPausedInputs 放回，不能吞掉。
 */
export async function takePausedInputs(sessionId: string): Promise<AgentMessage[]> {
  const slot = harnessSlots.peek(sessionId)
  return slot ? await slot.takePausedMessages() : []
}

/** 投递未获接受时把取出的暂停消息按 nextRun 原样放回（持久、不自动继续）。 */
export async function returnPausedInputs(sessionId: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return
  await slot.requeuePausedMessages(messages)
}

/** 取回的暂停消息拼成文本（规划/召回按文本工作）；身份留在消息本身上，不靠这段文本。 */
export function pausedInputsText(messages: AgentMessage[]): string {
  return messages.map(laneMessageText).filter(text => text.length > 0).join("\n")
}
