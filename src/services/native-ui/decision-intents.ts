// ==========================================
// 决策类聊天意图的宿主请求承接（本包）—— Node 侧应答
// ==========================================
//
// 方向：**原生 UI 发起、Node 应答**（与 chat-intents.ts / management-intents.ts 同一条
// host-request 通道：事件 `deskpet-host-request` + 回执命令 `host_request_result`）。
// 方法名与 args 形状登记在 `src/services/host/types.ts` 的 `HostRequestMap`
// 「本包：决策类面板动作」组；Rust 侧映射在 `crates/native-host/src/ui/chat/intents.rs`
// 的 `decision_request`（有界 request）/ `decision_submit`（非阻塞 notify）。
//
// 本模块只做两件事：入参形状校验（协议违规以结构化 CONFIG 拒绝）与调用既有领域入口；
// 不复制领域语义、不另建队列/计划状态、不制造第二份结算点。
//
// 各条与既有面板的语义对应（对照 HEAD 的 ChatPanel.vue / PlanConfirm.vue）：
//   · `chat_abort_running_plan`     → `abortRunningPlan(sessionId)`（执行期终止；
//     未在执行时返回 false = no-op，不谎报「已终止」也不报错）；
//   · `chat_resume_plan`            → `resumePlan(sessionId, planId)`（只跑剩余步骤；
//     忙碌/未知计划/未知副作用未处置的拒绝由领域写系统消息）；
//   · `chat_discard_plan`           → `discardPlan(sessionId, planId)`（未知/不可处置 = false no-op）；
//   · `chat_resolve_unknown_side_effect` → `planCheckpointStore.resolveUnknownSideEffect`；
//   · `chat_withdraw_queued`        → `withdrawQueuedInput(sessionId, entryId)`；只有
//     `unavailable`（槽/lane 通道不可用）是真失败，以结构化错误拒绝；`cancelled` /
//     `already_consumed` / `not_found` 都表示条目已不在队列里可撤回，按如实归宿返回成功；
//   · `chat_resume_paused_inputs`   → `resumePausedInputs(sessionId)`（无暂停项 = undefined no-op）；
//   · `chat_discard_paused_inputs`  → `takePausedInputs(sessionId)` 取出后丢弃
//     （选择理由见 HostRequestMap 条目注释）；
//   · `chat_continue_interrupted_run` → `continueInterruptedRun(sessionId)`（无中断运行 = no-op）；
//   · `chat_discard_interrupted_run`  → `discardInterruptedRun(sessionId)`（无槽 = no-op）。
//
// 面板的瞬时提示语（旧壳 showDeliveryNote）分两半处理：
//   · **动作成功后的中性回执**（「已撤回排队消息」等）由宿主侧给出 —— Rust
//     `ui/chat/panels.rs` 的 `NOTICE_*` 常量 + `ui/chat/ui.rs::success_notice`，
//     经既有 notice 通道呈现、4 秒自动收起（文案只陈述宿主已知事实：有界请求
//     = 请求已完成、非阻塞提交 = 已交给 Node）；
//   · **精确归宿**（撤回成功 vs 该条已被消费、继续是否真的开始）仍不在本层断言：
//     回执形状一律 void、Rust 端口不消费 result，需要先设计回执结果面；显示结果
//     一律以随后的投影回推为准，不在本层伪造成功或失败文案。

import { resumePausedInputs } from "@/services/agent"
import {
  abortRunningPlan,
  continueInterruptedRun,
  discardInterruptedRun,
  discardPlan,
  planCheckpointStore,
  resumePlan,
  takePausedInputs,
  withdrawQueuedInput,
} from "@/services/engine"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { pushSessionProjection } from "./session-projection"

const log = createLogger("NativeUi")

/** 入参形状失败：结构化 CONFIG（与 chat-intents / host-requests 的入参校验同口径）。 */
function requireString(args: unknown, key: string, method: string): string {
  const value = (args as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${method} 缺少有效的 ${key}`), { code: "CONFIG" })
  }
  return value
}

/**
 * 面板动作完成后的投影重推（fire-and-forget）。
 *
 * 面板读模型（队列 / 中断运行 / 待处置计划）是「随帧权威、缺省即清空」的整帧字段：
 * 动作后不重推就会停在旧值（已撤回的排队项、已处置的中断会永远显示）。失败只留痕 ——
 * 动作本身已完成，下一次投影推送会带回真实状态。
 */
function repushProjection(method: string): void {
  void pushSessionProjection().catch((error) => {
    log.warn(`${method} 后的投影重推失败：${formatError(error)}`)
  })
}

/** 终止该会话正在执行中的计划（未在执行时是如实 no-op）。 */
export async function chatAbortRunningPlan(args: unknown): Promise<void> {
  abortRunningPlan(requireString(args, "sessionId", "chat_abort_running_plan"))
  repushProjection("chat_abort_running_plan")
}

/** 继续一个待处置计划：只跑剩余步骤（拒绝/失败由领域写系统消息）。 */
export async function chatResumePlan(args: unknown): Promise<void> {
  const sessionId = requireString(args, "sessionId", "chat_resume_plan")
  const planId = requireString(args, "planId", "chat_resume_plan")
  await resumePlan(sessionId, planId)
  repushProjection("chat_resume_plan")
}

/** 丢弃一个待处置计划（返回 false = 未知/不可处置，如实 no-op）。 */
export async function chatDiscardPlan(args: unknown): Promise<void> {
  const sessionId = requireString(args, "sessionId", "chat_discard_plan")
  const planId = requireString(args, "planId", "chat_discard_plan")
  await discardPlan(sessionId, planId)
  repushProjection("chat_discard_plan")
}

/** 处置一个未知副作用步骤（未知 planId 由 store 的 require 如实抛错，不静默造记录）。 */
export async function chatResolveUnknownSideEffect(args: unknown): Promise<void> {
  const planId = requireString(args, "planId", "chat_resolve_unknown_side_effect")
  const stepId = requireString(args, "stepId", "chat_resolve_unknown_side_effect")
  const resolution = (args as { resolution?: unknown } | null | undefined)?.resolution
  if (resolution !== "already_applied" && resolution !== "retry") {
    throw Object.assign(
      new Error("chat_resolve_unknown_side_effect 的 resolution 只接受 already_applied / retry"),
      { code: "CONFIG" },
    )
  }
  await planCheckpointStore.resolveUnknownSideEffect(planId, stepId, resolution)
  repushProjection("chat_resolve_unknown_side_effect")
}

/** 撤回一条尚未被消费的排队项（只有 `unavailable` 是结构化失败）。 */
export async function chatWithdrawQueued(args: unknown): Promise<void> {
  const sessionId = requireString(args, "sessionId", "chat_withdraw_queued")
  const entryId = requireString(args, "entryId", "chat_withdraw_queued")
  const kind = await withdrawQueuedInput(sessionId, entryId)
  if (kind === "unavailable") {
    // 真失败：不让界面把「通道坏了」误读成「已撤回」。其余归宿（cancelled /
    // already_consumed / not_found）都是「条目已不在队列里可撤回」的如实结果。
    throw Object.assign(new Error("撤回失败：运行槽或队列通道当前不可用"), { code: "OTHER" })
  }
  repushProjection("chat_withdraw_queued")
}

/** 取出暂停项并按原顺序投递成一次标准回合（无暂停项/未获准入由领域承担）。 */
export async function chatResumePausedInputs(args: unknown): Promise<void> {
  await resumePausedInputs(requireString(args, "sessionId", "chat_resume_paused_inputs"))
  repushProjection("chat_resume_paused_inputs")
}

/**
 * 逐条撤回全部暂停项：`takePausedInputs` 取出即从 lane inbox 撤回，取出后丢弃 —
 * 这正是「全部丢弃」的语义（选择理由见 HostRequestMap 条目注释）。没有槽/没有
 * 暂停项 = 撤回 0 条（no-op），不是错误。
 */
export async function chatDiscardPausedInputs(args: unknown): Promise<void> {
  const sessionId = requireString(args, "sessionId", "chat_discard_paused_inputs")
  const taken = await takePausedInputs(sessionId)
  if (taken.length > 0) log.info(`已丢弃 ${taken.length} 条暂停输入`, { sessionId })
  repushProjection("chat_discard_paused_inputs")
}

/** 继续上次中断的运行（无中断运行 = 领域 no-op）。 */
export async function chatContinueInterruptedRun(args: unknown): Promise<void> {
  await continueInterruptedRun(requireString(args, "sessionId", "chat_continue_interrupted_run"))
  repushProjection("chat_continue_interrupted_run")
}

/** 丢弃上次中断的运行（无槽 = 无中断运行，领域 no-op）。 */
export async function chatDiscardInterruptedRun(args: unknown): Promise<void> {
  await discardInterruptedRun(requireString(args, "sessionId", "chat_discard_interrupted_run"))
  repushProjection("chat_discard_interrupted_run")
}
