/**
 * 投递证据链的只读查询（PI-1 余项）。
 *
 * 每一档都由既有产物推出，不新建账本、不猜结论：
 * - queued / offered：lane 持久 inbox 的只读快照（kind 就是投递意图）；
 * - context_committed：带输入身份的 user 条目已成为会话正文；
 * - request_prepared：某次请求的落盘快照里出现了该输入的身份；
 * - responded：同一请求拿到了 usage 回执（provider_usage 阶段的快照）。
 *
 * 「已排队」不能当「已处理」：读不到更靠后的证据就停在能证明的那一档。
 */

import { TODO_CONTEXT } from "@earendil-works/pi-agent-core"
import { operationResult } from "@earendil-works/pi-agent-core/harness/session"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { PI_LANE, acquirePiSession } from "@/services/session/repo"
import { PROMPT_SNAPSHOT_ENTRY, inputEventId, messageRequestId } from "@/services/engine/runtime"
import { harnessSlots } from "./harness-slot"

const log = createLogger("Delivery")

export interface ActiveAttemptEvidence {
  operationId: string
  triggerEntryId: string
  assistantEntryId: string
  text: string
  timestamp: number
  parts?: string[]
  silent?: boolean
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
}

/** Resolve active attempt -> native assistant entry using operation prompt and terminal/state records. */
export interface ActiveAttemptAssociation { attemptId: string; triggerEntryId: string; expectsReply?: boolean }

export async function readActiveAttemptAssociations(sessionId: string): Promise<Map<string, ActiveAttemptAssociation>> {
  const session = await acquirePiSession(sessionId)
  const entries = await session.findEntries({ order: "asc" }, TODO_CONTEXT)
  const triggers = entries.filter(entry => entry.type === "message"
    && entry.message.role === "custom" && entry.message.customType === "deskpet.active_message"
    && isRecord(entry.message.details)
    && typeof entry.message.details.attemptId === "string")
  if (!triggers.length) return new Map()
  // `operationMeta` is an in-flight value and is deleted by pi-agent-core after terminal cleanup.
  // The immutable operation result keeps the branch anchors needed to bind a trigger to its tip.
  const operations = await session.scanValues(operationResult(""), TODO_CONTEXT)
  const result = new Map<string, ActiveAttemptAssociation>()
  for (const trigger of triggers) {
    if (trigger.type !== "message" || trigger.message.role !== "custom" || !isRecord(trigger.message.details)) continue
    const attemptId = trigger.message.details.attemptId
    if (typeof attemptId !== "string") continue
    const triggerIndex = entries.findIndex(entry => entry.id === trigger.id)
    for (const stored of operations) {
      const terminal = stored.value
      if (terminal.kind !== "run" || terminal.status !== "completed" || !terminal.tipId) continue
      const fromIndex = entries.findIndex(entry => entry.id === terminal.fromTipId)
      const tipIndex = entries.findIndex(entry => entry.id === terminal.tipId)
      if (fromIndex < 0 || tipIndex < 0 || !(fromIndex < triggerIndex && triggerIndex < tipIndex)) continue
      result.set(terminal.tipId, { attemptId, triggerEntryId: trigger.id, expectsReply: trigger.message.details.expectsReply !== false })
      break
    }
  }
  return result
}

/** Prove one active attempt from its custom trigger, terminal native operation, and committed assistant tip. */
export async function readActiveAttemptEvidence(
  sessionId: string,
  attemptId: string,
  requestId: string,
): Promise<ActiveAttemptEvidence | undefined> {
  const session = await acquirePiSession(sessionId)
  const entries = await session.findEntries({ order: "asc" }, TODO_CONTEXT)
  const trigger = entries.find(entry => entry.type === "message"
    && entry.message.role === "custom" && entry.message.customType === "deskpet.active_message"
    && isRecord(entry.message.details)
    && entry.message.details.attemptId === attemptId && entry.message.details.requestId === requestId)
  if (!trigger) return undefined
  // `operationMeta` is removed during terminal cleanup. Use the immutable result's branch anchors
  // and the exact trigger/tip ordering to prove this operation belongs to this active attempt.
  const operations = await session.scanValues(operationResult(""), TODO_CONTEXT)
  const triggerIndex = entries.findIndex(entry => entry.id === trigger.id)
  for (const stored of operations) {
    const terminal = stored.value
    if (terminal.kind !== "run" || terminal.status !== "completed" || !terminal.tipId) continue
    const fromIndex = entries.findIndex(entry => entry.id === terminal.fromTipId)
    const tipIndex = entries.findIndex(entry => entry.id === terminal.tipId)
    if (fromIndex < 0 || tipIndex < 0 || !(fromIndex < triggerIndex && triggerIndex < tipIndex)) continue
    const assistant = entries.find(entry => entry.type === "message" && entry.id === terminal.tipId)
    if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant"
      || assistant.message.stopReason === "error" || assistant.message.stopReason === "aborted") continue
    const text = contentText(assistant.message.content).trim()
    const silent = (assistant.message as typeof assistant.message & { deskpetSilent?: boolean }).deskpetSilent === true
    if (!text && !silent) continue
    const usage = assistant.message.usage
    return {
      operationId: terminal.operationId,
      triggerEntryId: trigger.id,
      assistantEntryId: assistant.id,
      text,
      timestamp: typeof assistant.message.timestamp === "number" ? assistant.message.timestamp : assistant.timestamp,
      ...(silent ? { silent: true } : {}),
      ...(assistant.message.content.filter(part => part.type === "text").length > 1
        ? { parts: assistant.message.content.filter(part => part.type === "text").map(part => part.text) } : {}),
      ...(usage ? { usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(Number.isFinite(usage.cacheRead) ? { cacheRead: usage.cacheRead } : {}),
        ...(Number.isFinite(usage.cacheWrite) ? { cacheWrite: usage.cacheWrite } : {}),
      } } : {}),
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function contentText(content: AssistantMessage["content"]): string {
  return content.filter(part => part.type === "text").map(part => part.text).join("\n")
}

/** 请求视图的换代身份：本会话 lane 分支上已提交的压缩次数与最近一条压缩条目。 */
export interface ContextEpoch {
  /** 已提交的 compaction 条目数（沿 lane 分支回溯，不看其它分支）。 */
  count: number
  /** 最近一条已提交 compaction 条目 id（快照的 compaction.lastEntryId 用它）。 */
  lastCompactionEntryId?: string
}

/**
 * 请求视图换代身份的唯一定义点。读失败返回 undefined（调用方不得当成 0）。
 *
 * 沿 lane 的分支回溯已提交的 compaction 条目：会话级全量计数会把其它分支的压缩算进来，
 * 而写 0 又会把「读不到」说成「没有压缩过」。
 */
export async function readContextEpoch(sessionId: string): Promise<ContextEpoch | undefined> {
  try {
    const session = await acquirePiSession(sessionId)
    const branch = await session.branch(PI_LANE, TODO_CONTEXT)
    if (!branch) return { count: 0 }
    const entries = await branch.findEntries({ type: "compaction", order: "oldestFirst" }, TODO_CONTEXT)
    const last = entries[entries.length - 1]
    return { count: entries.length, ...(last ? { lastCompactionEntryId: last.id } : {}) }
  } catch (error) {
    log.error("上下文换代身份读取失败:", { sessionId }, formatError(error))
    return undefined
  }
}

export type InputDeliveryStage = "queued" | "context_committed" | "request_prepared" | "responded"

export interface InputDeliveryEvidence {
  stage: InputDeliveryStage
  /** queued 阶段的投递意图（inbox 的 kind）。 */
  queuedKind?: "steer" | "followUp" | "nextRun"
  /** 证明该阶段的持久身份：inbox entryId / 会话条目 id / 快照 id。 */
  evidenceId?: string
  /** 请求视图换代身份（request_prepared 起可读）。 */
  contextEpoch?: number
}

/**
 * 投递证据查询的判别式结果：`ok:false`（读取失败）与「确实没有证据」必须不同形，
 * 调用方才能如实呈现「核对不了」而不是把它说成「没有证据」。
 */
export type InputDeliveryLookup =
  | { ok: true; evidence?: InputDeliveryEvidence }
  | { ok: false; error: string }

/** 正文落盘核对的三态：读失败是「不确定」，既不是「已落盘」也不是「未落盘」。 */
export type InputCommitState = "committed" | "pending" | "unknown"

interface SessionEvidence {
  committedEntryId?: string
  prepared?: { snapshotId: string; contextEpoch?: number }
  responded?: { snapshotId: string; contextEpoch?: number }
}

/**
 * 该输入是否已经作为正文条目落盘：继续/丢弃的回滚据此决定要不要把消息放回 inbox。
 * `"unknown"`（读取失败）时调用方按「不重复追加用户正文」处理，并补一条用户可见提示 ——
 * 判定发生在只读层，但结论会改变回滚行为，所以证据（log.error）与提示都在这里一次给全。
 */
export async function isInputCommitted(sessionId: string, requestId: string): Promise<InputCommitState> {
  try {
    return (await readSessionEvidence(sessionId, requestId)).committedEntryId === undefined ? "pending" : "committed"
  } catch (error) {
    log.error("输入提交状态读取失败:", { sessionId, requestId }, formatError(error))
    // 文案并入既有投递提示族（「已加入对话」）；动态 import 断开 delivery ← engine/harness ← session 的静态环。
    const { pushSystemMessage } = await import("@/services/session/messages")
    pushSystemMessage("这条输入的落盘状态没能核对，已按「已加入对话」处理，不再重复追加正文", sessionId)
    return "unknown"
  }
}

/**
 * 查询一条输入走到了哪一阶段。查不到任何证据（身份不属于本会话、条目已被清理）返回
 * `{ ok: true }` 不带 evidence；读取失败返回 `{ ok: false, error }`（阶段只降不升，绝不凭空报「已进入请求」）。
 */
export async function describeInputDelivery(sessionId: string, requestId: string): Promise<InputDeliveryLookup> {
  const queued = harnessSlots.snapshot(sessionId)?.queued.find(item => item.requestId === requestId)
  if (queued) return { ok: true, evidence: { stage: "queued", queuedKind: queued.kind, evidenceId: queued.entryId } }
  let evidence: SessionEvidence
  try {
    evidence = await readSessionEvidence(sessionId, requestId)
  } catch (error) {
    log.warn("投递证据读取失败，按未核对处理:", { sessionId, requestId }, formatError(error))
    return { ok: false, error: formatError(error) }
  }
  if (evidence.responded) {
    return { ok: true, evidence: { stage: "responded", evidenceId: evidence.responded.snapshotId, ...epochOf(evidence.responded.contextEpoch) } }
  }
  if (evidence.prepared) {
    return { ok: true, evidence: { stage: "request_prepared", evidenceId: evidence.prepared.snapshotId, ...epochOf(evidence.prepared.contextEpoch) } }
  }
  if (evidence.committedEntryId) return { ok: true, evidence: { stage: "context_committed", evidenceId: evidence.committedEntryId } }
  return { ok: true }
}

function epochOf(contextEpoch: number | undefined): { contextEpoch?: number } {
  return contextEpoch === undefined ? {} : { contextEpoch }
}

/**
 * 一次遍历取齐会话文件里的三档证据。
 * 快照条目按 seq 升序：prepared 取最早（首次进入请求投影），responded 取最晚（最后一轮拿到回执）。
 */
async function readSessionEvidence(sessionId: string, requestId: string): Promise<SessionEvidence> {
  const eventId = inputEventId(requestId)
  const evidence: SessionEvidence = {}
  const session = await acquirePiSession(sessionId)
  const entries = await session.findEntries({ order: "asc" }, TODO_CONTEXT)
  for (const entry of entries) {
    if (entry.type === "message") {
      if (evidence.committedEntryId === undefined && entry.message.role === "user"
        && messageRequestId(entry.message as { deskpetEventId?: unknown }) === requestId) {
        evidence.committedEntryId = entry.id
      }
      continue
    }
    if (entry.type !== "custom" || entry.customType !== PROMPT_SNAPSHOT_ENTRY) continue
    const data = entry.data as {
      snapshotId?: unknown
      captureStage?: unknown
      contextEpoch?: unknown
      agentMessages?: unknown
    } | undefined
    if (!data || !Array.isArray(data.agentMessages)) continue
    if (!data.agentMessages.some(item => (item as { id?: unknown } | null)?.id === eventId)) continue
    const found = {
      snapshotId: typeof data.snapshotId === "string" ? data.snapshotId : entry.id,
      ...epochOf(typeof data.contextEpoch === "number" ? data.contextEpoch : undefined),
    }
    if (data.captureStage === "provider_usage") evidence.responded = found
    else evidence.prepared ??= found
  }
  return evidence
}
