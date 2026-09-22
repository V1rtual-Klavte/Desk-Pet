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
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { acquirePiSession } from "@/services/session/repo"
import { inputEventId, messageRequestId } from "@/services/engine/runtime"
import { harnessSlots } from "./harness-slot"

const log = createLogger("Delivery")

/** 请求快照的审计条目类型：写入方在 runtime.ts 的 queueAuditEntry，读取方（本模块）按它核对。 */
export const PROMPT_SNAPSHOT_ENTRY = "deskpet.prompt_snapshot"

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

interface SessionEvidence {
  committedEntryId?: string
  prepared?: { snapshotId: string; contextEpoch?: number }
  responded?: { snapshotId: string; contextEpoch?: number }
}

/** 该输入是否已经作为正文条目落盘：继续/丢弃的回滚据此决定要不要把消息放回 inbox。 */
export async function isInputCommitted(sessionId: string, requestId: string): Promise<boolean> {
  try {
    return (await readSessionEvidence(sessionId, requestId)).committedEntryId !== undefined
  } catch (error) {
    // 读不出来按「不确定」处理：调用方宁可多留一条待处理输入，也不能重复追加用户正文。
    log.warn("投递落盘核对失败:", { sessionId, requestId }, formatError(error))
    return true
  }
}

/**
 * 查询一条输入走到了哪一阶段。查不到任何证据（身份不属于本会话、条目已被清理）返回 undefined；
 * 读取失败按「读不到更靠后的证据」处理：阶段只降不升，绝不凭空报「已进入请求」。
 */
export async function describeInputDelivery(sessionId: string, requestId: string): Promise<InputDeliveryEvidence | undefined> {
  const queued = harnessSlots.snapshot(sessionId)?.queued.find(item => item.requestId === requestId)
  if (queued) return { stage: "queued", queuedKind: queued.kind, evidenceId: queued.entryId }
  let evidence: SessionEvidence
  try {
    evidence = await readSessionEvidence(sessionId, requestId)
  } catch (error) {
    log.warn("投递证据读取失败，按未核对处理:", { sessionId, requestId }, formatError(error))
    return undefined
  }
  if (evidence.responded) {
    return { stage: "responded", evidenceId: evidence.responded.snapshotId, ...epochOf(evidence.responded.contextEpoch) }
  }
  if (evidence.prepared) {
    return { stage: "request_prepared", evidenceId: evidence.prepared.snapshotId, ...epochOf(evidence.prepared.contextEpoch) }
  }
  if (evidence.committedEntryId) return { stage: "context_committed", evidenceId: evidence.committedEntryId }
  return undefined
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
