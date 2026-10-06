// ==========================================
// 提问选择（ask_user）的确认通道 —— Node 领域与 UI 之间的「向用户提问」桥
//
// 提问方向走 UI 事件端口（`publishUiEvent` → HostEventMap 的 `deskpet-choice-start` /
// `deskpet-choice-end`），回答方向走 UI 回执端口（`subscribeUiReceipt` 的
// `deskpet-choice-resolved`），由 `initChoiceConfirmationReceipts()` 安装订阅
// （harness 引导调用一次）。
//
// 与 `plan-confirmation.ts` 同款骨架（会话键控、emit 失败立即结算、未知/重复回执
// no-op、结算只发生一次），三处差异是刻意的：
//   · **不设单槽**：按 requestId 键控的多条待答（同一工具批次可并发多个提问），
//     面板逐条渲染、逐条结算；
//   · **没有执行相位**：答案是即时产物，结算即工具结果，没有「确认后还要跑一段」；
//   · **「其它」的语义**：用户选择用自己的话回答 —— 面板上「其它」点下去即结算
//     （`{kind:"other"}`），用户的自由原文以**下一条消息**为准到达模型；通道不截留、
//     不冒充。选择回执的三种取值（picked / other / cancelled）都由 UI 原样给出，
//     未知取值按协议违规丢弃（与权限回执同口径），绝不代用户选。
//
// 「用户直接在输入框发消息、不点面板」不走回执通道：消息侧（ingress，见
// `HarnessSlot.steer`）在消息进入 lane 持久 inbox 之后把该会话仍未结算的提问按
// `user_replied` 取消（`cancelSessionChoices` 的第三个归宿）—— 面板随结算收起，
// 工具结果如实说明「用户没在面板里选、直接发来了消息」，同样不冒充任何点选。
// ==========================================

import {
  publishUiEvent,
  subscribeUiReceipt,
  HOST_EVENT_CHOICE_END,
  HOST_EVENT_CHOICE_START,
  UI_RECEIPT_CHOICE_RESOLVED,
  type HostEventMap,
  type NodeUiEventName,
} from "@/services/host"
import { beginUserWait } from "./user-wait"
import { reactive } from "vue"
import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { createLogger } from "@/services/logger"
import { formatError, reportError } from "@/services/error"

const log = createLogger("ChoiceConfirm")

/** UI 对一次提问的答复（`UiReceiptMap["deskpet-choice-resolved"]` 的 result 形状）。 */
export type ChoiceResolution =
  | { kind: "picked"; index: number }
  | { kind: "other" }
  | { kind: "cancelled" }

/**
 * 提问归宿。`answered` 才携带用户答复；非答复的**五种**原因都有明确来源
 * （`user` 用户点了取消；`user_replied` 用户不回面板、直接在输入框发了一条消息
 * （ingress 侧投递成功后结算，见 `cancelSessionChoices`）；`session_switched` 切会话
 * 含 signal abort，用户停止回合走同一条；`not_active` 会话被关闭；`emit_failed`
 * 提问事件发不出去）。
 * 没有 `timeout`（2026-10-06 用户裁决：选择类弹窗不留超时，`user-wait.ts` 的等待豁免）；
 * 也没有 `ui_unavailable`：选择面板常驻注册、没有「监听注册失败」这条产生路径
 *（与计划确认的六值口径刻意不同 —— 不留走不到的死分支）。
 */
export type ChoiceOutcome =
  | { answered: true; answer: { kind: "picked"; index: number; option: string } | { kind: "other" } }
  | { answered: false; reason: "user" | "user_replied" | "session_switched" | "not_active" | "emit_failed" }

/** 待答提问的只读视图（面板渲染 + 测试替身按它应答；reactive 以便 `flush: "sync"` 应答）。 */
export interface PendingChoiceView {
  requestId: string
  sessionId: string
  question: string
  options: string[]
}

/**
 * 待答提问的视图表（UI 渲染 + 测试替身按它应答）。真相源是下面的 `pendingChoices`
 * 结算表，不得反向从视图派生行为。
 */
export const choiceState = reactive<{ pending: PendingChoiceView[] }>({ pending: [] })

/** 待答提问：requestId → 结算句柄。跨会话可并发；同一会话也允许并发（工具批次并行）。 */
interface ChoiceEntry {
  view: PendingChoiceView
  resolve: (outcome: ChoiceOutcome) => void
  /** 回合预算豁免的等待登记（`user-wait.ts`）：结算（任何原因）即 release。 */
  releaseWait: () => void
  signalCleanup?: () => void
}
const pendingChoices = new Map<string, ChoiceEntry>()

/**
 * 非答复归宿的用户可见说明（系统消息文案，与 `NON_CONFIRM_NOTICE` 同源互补）：
 * 切会话/关闭在 `cancelSessionChoices` 写出、发射失败在结算处写出；
 * `user`（用户自己点了取消）与 `user_replied`（用户直接发消息、面板随结算收起）不需要
 * 系统消息 —— 用户自己的动作不需要解释，模型侧的回执由 `choiceDeclineText` 承担。
 * 没有 `timeout` 条目：本域不设等待超时（2026-10-06 用户裁决）。
 */
export const CHOICE_NON_ANSWER_NOTICE = {
  session_switched: "已离开该会话，提问已取消",
  not_active: "该会话已不再活跃，提问已取消",
  emit_failed: "提问未能送达界面，已取消本次提问",
} as const

/**
 * 未答复的中性说明（模型可见的工具结果组成件，不是角色台词）。
 *
 * 与 `CHOICE_NON_ANSWER_NOTICE`（系统消息文案）同一份口径：后者覆盖三个由本域写出的
 * 归宿，工具结果另外覆盖 `user`（用户自己点了取消）与 `user_replied`（用户没在面板里选、
 * 直接发来了一条消息 —— 本条提问随之取消，用户的答复就是那条消息），两种渠道的文案
 * 不许各写一套（与 `planConfirmDeclineText` 同款）。
 *
 * `user_replied` 不冒充任何点选：只如实说明「用户直接发了消息」并指向那条消息 ——
 * ingress 只证明用户发了话，无从知道这句话对应哪个选项（也不能替用户挑一个）。
 */
export function choiceDeclineText(reason: Extract<ChoiceOutcome, { answered: false }>["reason"]): string {
  if (reason === "user") return "用户取消了本次提问"
  if (reason === "user_replied") {
    return "用户没有在面板中选择，而是直接发来了一条消息；本条提问已取消，请以下一条用户消息为准继续，不要重复提问"
  }
  return CHOICE_NON_ANSWER_NOTICE[reason]
}

// ═══════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════

/**
 * UI 事件发射的唯一出口：经 UI 事件端口发布（桥的 publishEvent）。
 * 发射失败不抛给调用方，记日志 + 上报后返回 false，由调用方决定归宿 ——
 * 提问方不知道事件没发出去时不能永久悬挂（与 plan-confirmation 同款）。
 */
async function emitUiEvent<K extends NodeUiEventName>(
  event: K,
  payload: HostEventMap[K],
): Promise<boolean> {
  try {
    await publishUiEvent(event, payload)
    return true
  } catch (error) {
    log.error(`提问 UI 事件发射失败: ${event}`, formatError(error))
    reportError("ChoiceConfirm", error, { kind: `提问 UI 事件发射失败（${event}）`, overlay: false })
    return false
  }
}

/**
 * 写非答复归宿的系统消息。只写给该会话仍在前台时的用户（与计划确认同款）：
 * 切会话在指针移动前调用本函数（那时活跃会话仍指向旧会话，消息才进对会话）。
 */
function writeNotice(sessionId: string, reason: keyof typeof CHOICE_NON_ANSWER_NOTICE): void {
  if (getActiveSessionId() !== sessionId) return
  pushSystemMessage(CHOICE_NON_ANSWER_NOTICE[reason], sessionId)
}

/**
 * 结算一条待答提问：摘等待登记、摘 signal 监听、resolve、清视图（若指向该 requestId）。
 * 返回是否真的结算了 —— 任何路径只结算一次。
 */
function settleChoice(requestId: string, outcome: ChoiceOutcome): boolean {
  const entry = pendingChoices.get(requestId)
  if (!entry) return false
  pendingChoices.delete(requestId)
  entry.releaseWait()
  entry.signalCleanup?.()
  const index = choiceState.pending.findIndex(view => view.requestId === requestId)
  if (index !== -1) choiceState.pending.splice(index, 1)
  entry.resolve(outcome)
  return true
}

/** 收起 UI 面板的收尾事件（结算后的显式调用点：signal / 关会话 / 发射失败 / 用户直发消息取消）。 */
export function notifyChoiceEnd(sessionId: string, requestId: string): void {
  void emitUiEvent(HOST_EVENT_CHOICE_END, { sessionId, requestId })
}

// ═══════════════════════════════════════════════════
// 提问
// ═══════════════════════════════════════════════════

export interface RequestChoiceInput {
  sessionId: string
  /** 提问身份；调用方用工具调用 id 派生，保证一次工具调用一个 requestId。 */
  requestId: string
  question: string
  /** 面板可选项（已由调用方准入：2..6 个、非空）。 */
  options: string[]
  /** 父回合取消信号（工具调用信号）：abort 按 `session_switched` 结算（与计划确认同口径）。 */
  signal?: AbortSignal
}

/**
 * 请求用户做一次选择（按 requestId 键控）。**没有等待超时**（2026-10-06 用户裁决：
 * 选择类弹窗不留超时）—— 等待期间该会话的回合墙钟与工具超时停表（`user-wait.ts`），
 * 用户想多久想多久。非答复归宿只来自明确事件：`signal` 的 abort（用户停止回合 /
 * 会话切换）按 `session_switched`、事件发射失败按 `emit_failed`、`user` 由面板回执
 * resolve、`not_active` 由会话关闭触发、`user_replied` 由用户直发消息的 ingress 结算
 * （消息进入 lane 持久 inbox 之后，见 `HarnessSlot.steer`）。
 */
export function requestChoice(input: RequestChoiceInput): Promise<ChoiceOutcome> {
  const { sessionId, requestId, question, options, signal } = input
  // 不同调用点不共用 requestId；真重入时先把旧的那份结算掉，不给它留悬挂的 promise 与等待登记。
  settleChoice(requestId, { answered: false, reason: "session_switched" })
  return new Promise<ChoiceOutcome>(resolve => {
    const view: PendingChoiceView = { requestId, sessionId, question, options: [...options] }
    const entry: ChoiceEntry = {
      view,
      resolve,
      // 等用户回答：登记等待，挂起该会话的回合墙钟与工具超时（任何结算路径都会 release）。
      releaseWait: beginUserWait(sessionId),
    }
    pendingChoices.set(requestId, entry)

    // signal 先接线再暴露视图：同步应答（flush: "sync" 的替身）在视图赋值时就会结算，
    // 那时监听必须已经可摘除，否则会留下悬空监听（与 requestPlanConfirm 同款）。
    const onAbort = () => {
      if (!settleChoice(requestId, { answered: false, reason: "session_switched" })) return
      notifyChoiceEnd(sessionId, requestId)
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.signalCleanup = () => signal.removeEventListener("abort", onAbort)
    }

    choiceState.pending.push(view)

    void emitUiEvent(HOST_EVENT_CHOICE_START, {
      sessionId,
      requestId,
      question,
      options: view.options,
    }).then(delivered => {
      if (delivered) return
      // 事件没送达 = 用户永远看不到提问：立即按 emit_failed 结算。
      if (!settleChoice(requestId, { answered: false, reason: "emit_failed" })) return
      log.error("提问事件发射失败，已按 emit_failed 结算:", requestId, sessionId)
      writeNotice(sessionId, "emit_failed")
      notifyChoiceEnd(sessionId, requestId)
    })
  })
}

/**
 * 结算一条待答提问（回执通道调用）。取值与索引在这里收口校验：
 *   · 未知/重复 requestId 是 no-op（settleChoice 只结算一次）；
 *   · `picked` 的 index 必须是该提问选项范围内的整数 —— 越界回执按协议违规丢弃
 *     （与权限回执的非法取值同口径：不让非法取值有把提问结算成非用户选择的机会）。
 */
export function resolveChoice(requestId: string, resolution: ChoiceResolution): void {
  const entry = pendingChoices.get(requestId)
  if (!entry) return
  if (resolution.kind === "picked") {
    const index = resolution.index
    if (!Number.isInteger(index) || index < 0 || index >= entry.view.options.length) {
      log.warn("选择回执的选项下标越界（协议违规），已丢弃:", requestId, String(index))
      return
    }
    settleChoice(requestId, { answered: true, answer: { kind: "picked", index, option: entry.view.options[index]! } })
    return
  }
  if (resolution.kind === "other" || resolution.kind === "cancelled") {
    settleChoice(requestId, resolution.kind === "other"
      ? { answered: true, answer: { kind: "other" } }
      : { answered: false, reason: "user" })
    return
  }
  log.warn("选择回执的 kind 取值非法（协议违规），已丢弃:", String((resolution as { kind?: unknown }).kind))
}

// ═══════════════════════════════════════════════════
// 会话生命周期与 ingress 结算（用户直发消息）
// ═══════════════════════════════════════════════════

/**
 * 取消该会话的全部待答提问；返回取消条数。三种归宿各有调用点：
 *   · `session_switched` / `not_active`：切会话/会话不再活跃，必须在会话指针移动**之前**
 *     调用（与 `cancelSessionPlans` 同款）—— 取消文案写进旧会话，用户也不会再对不可见的
 *     提问负责；
 *   · `user_replied`：用户不回面板、直接在输入框发了一条消息（ingress 侧在消息进入
 *     lane 持久 inbox 之后调用）—— 不写系统消息（用户自己的动作，面板收起即反馈），
 *     模型侧的回执由 `choiceDeclineText` 的 user_replied 文案如实承担。
 */
export function cancelSessionChoices(
  sessionId: string,
  reason: "session_switched" | "not_active" | "user_replied",
): number {
  let cancelled = 0
  for (const [requestId, entry] of [...pendingChoices.entries()]) {
    if (entry.view.sessionId !== sessionId) continue
    if (!settleChoice(requestId, { answered: false, reason })) continue
    cancelled++
    if (reason !== "user_replied") writeNotice(sessionId, reason)
    notifyChoiceEnd(sessionId, requestId)
  }
  return cancelled
}

/**
 * 安装 UI 回执订阅（UI→Node 反向通道；Node 宿主引导时调用一次，幂等）。
 *
 * 结算语义：未知/重复 requestId 是 no-op；回执迟到不复活结算，传输不承诺重放
 * （与计划回执同款）。
 */
let receiptsInstalled = false
let stopReceiptSubscriptions: Array<() => void> = []
export function initChoiceConfirmationReceipts(): void {
  if (receiptsInstalled) return
  const stop = subscribeUiReceipt(UI_RECEIPT_CHOICE_RESOLVED, ({ requestId, result }) => {
    resolveChoice(requestId, result)
  })
  stopReceiptSubscriptions = [stop]
  receiptsInstalled = true
}

/** 进程关停时释放回执订阅；Node 重启会在新 HostBridge 上重新装配。 */
export function disposeChoiceConfirmationReceipts(): void {
  const stops = stopReceiptSubscriptions
  stopReceiptSubscriptions = []
  receiptsInstalled = false
  let failure: unknown
  for (const stop of stops) {
    try {
      stop()
    } catch (error) {
      if (failure === undefined) failure = error
    }
  }
  if (failure !== undefined) {
    throw Object.assign(new Error("Choice 回执订阅清理失败"), { cause: failure })
  }
}
