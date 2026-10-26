// ==========================================
// direct-seed 运行时装载器 — 评测隔离根里的初始状态
// ==========================================
//
// 只在 sim-eval 上下文运行（普通开发会话直接返回 null）：
//   1. 校验隔离根是干净的（没有会话、没有记忆、没有候选），或已有本 fixture 的装载报告；
//   2. 用保留 id 的会话写入纠正前对话，用户消息带真实来源标记与投递身份；
//   3. 经产品同一套来源登记/记忆变更/ dreaming 作业接口写入旧记忆，并把初始来源推进到水位
//      （零候选的 review 提交 = 这套对话已经被整理过），后续纠正消息才会成为待抽取来源；
//   4. 逐项读回校验后写 seed-report.json；重启时凭报告复用，绝不重复装载。
//
// 夹具初始状态允许直接写入（用户裁决）；纠正、自动抽取与跨会话召回仍走真实消息链路。

import { readFile, rename, writeFile } from "node:fs/promises"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import {
  applyMemoryChange, checkpointMemoryJob, commitMemoryDreamingJob, memoryList, memoryStatus,
  pendingMemorySourceCount, registerMemorySources, startMemoryJob, cancelMemoryJob,
} from "@/services/agent/memory"
import type { MemoryDraft, MemoryItem, MemorySource } from "@/services/agent/memory"
import { inputEventId, laneMessageText, messageEventId, userInputMessage } from "@/services/engine/runtime"
import { getActiveCard, getActivePersonalityId } from "@/services/personality"
import { getActiveProfile } from "@/services/profile"
import { listPiSessionMetadata, acquirePiSession, createPiSessionWithId, PI_LANE } from "@/services/session"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { buildDirectSeedPlan } from "./direct-seed-plan"
import type { DirectSeedPlan } from "./direct-seed-plan"
import { getSimEvalRunContext } from "./run-context"
import { getSimClockBaseMs } from "./clock"

const log = createLogger("SimSeed")
const LEASE_OWNER = "memory-dreaming"
const EVIDENCE_CHARS = 4_000
const REPORT_SCHEMA_VERSION = 1

export interface DirectSeedReport {
  schemaVersion: number
  status: "seeded" | "reused"
  fixtureId: string
  fixtureHash: string
  sessionId: string
  sessionTitle: string
  messageCount: number
  userMessageCount: number
  memoryKeys: string[]
  memoryItemIds: string[]
  sourceCount: number
  revision: number
  generation: string
  hostPid: number
  seededAt: string
}

let cached: DirectSeedReport | null = null

/** 本次进程写入/复用的装载报告；未运行 direct-seed 时为 null。 */
export function getDirectSeedReport(): DirectSeedReport | null {
  return cached
}

/**
 * 装载 fixture 的初始会话与旧记忆。非 sim-eval 运行返回 null；
 * sim-eval 下任何校验或写入失败都向上抛（不降级成空初始状态）。
 */
export async function seedDirectFixture(): Promise<DirectSeedReport | null> {
  const context = await getSimEvalRunContext()
  if (!context) return null
  if (cached) return cached

  const saved = await readReport(context.seedReportPath)
  if (saved) {
    await verifySaved(saved)
    cached = { ...saved, status: "reused" }
    log.info("direct-seed 已装载，复用隔离根:", saved.fixtureId, saved.sessionId)
    return cached
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(context.seedPath, "utf8"))
  } catch (error) {
    throw new Error(`sim-eval 缺少可读的 seed.json（${context.seedPath}）：${formatError(error)}`)
  }
  const plan = buildDirectSeedPlan(raw)
  // fixture.clock 是评估时刻；固定时钟必须与它同源，否则装载的历史与「现在」会错位。
  const clockBase = getSimClockBaseMs()
  if (clockBase === null) throw new Error("sim-eval direct-seed 前固定时钟未安装")
  if (clockBase !== plan.clockMs) {
    throw new Error(`fixture.clock 与 clock.json 基准不一致：fixture=${plan.clockMs}，clock=${clockBase}`)
  }
  await assertFreshRoot()
  assertActiveCard(plan)

  const { sources, sourceIdByMessageKey, title } = await appendFixtureSession(plan)
  const registered = await registerMemorySources(sources)
  if (registered !== sources.length) {
    throw new Error(`初始来源登记 ${registered}/${sources.length} 条，夹具来源不完整`)
  }
  const memory = await addInitialMemory(plan, sourceIdByMessageKey)
  // 初始对话已经过整理：零候选 review 把来源推进到水位，后续只剩新消息待抽取。
  const revision = await settleInitialSources(sources.map(source => source.sourceId), memory.revision)
  const pending = await pendingMemorySourceCount()
  if (pending !== 0) {
    throw new Error(`direct-seed 来源水位未收敛：仍有 ${pending} 条待处理来源`)
  }
  await verifyMemory(memory.itemIds)

  const report: DirectSeedReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "seeded",
    fixtureId: plan.fixtureId,
    fixtureHash: plan.fixtureHash,
    sessionId: plan.session.id,
    sessionTitle: title,
    messageCount: plan.session.messages.length,
    userMessageCount: sources.length,
    memoryKeys: plan.memory.map(item => item.key),
    memoryItemIds: memory.itemIds,
    sourceCount: sources.length,
    revision,
    generation: context.generation,
    hostPid: context.hostPid,
    seededAt: new Date().toISOString(),
  }
  await writeReport(context.seedReportPath, report)
  cached = report
  log.info("direct-seed 装载完成:", plan.fixtureId, plan.session.id, `${sources.length} 条来源`, `${memory.itemIds.length} 条记忆`)
  return report
}

async function readReport(path: string): Promise<DirectSeedReport | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`seed-report.json 不是合法 JSON：${path}`)
  }
  if (typeof raw !== "object" || raw === null) throw new Error("seed-report.json 不是对象")
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(`seed-report.json schemaVersion=${String(record.schemaVersion)} 不受支持`)
  }
  if (record.status !== "seeded") throw new Error("seed-report.json 的 status 非法")
  for (const field of ["fixtureId", "fixtureHash", "sessionId", "sessionTitle", "generation"] as const) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new Error(`seed-report.json 缺少字段 ${field}`)
    }
  }
  for (const field of ["hostPid", "messageCount", "userMessageCount", "sourceCount", "revision"] as const) {
    if (typeof record[field] !== "number" || !Number.isInteger(record[field])) {
      throw new Error(`seed-report.json 字段 ${field} 非法`)
    }
  }
  if (!Array.isArray(record.memoryKeys) || !record.memoryKeys.every(item => typeof item === "string")) {
    throw new Error("seed-report.json 的 memoryKeys 非法")
  }
  if (!Array.isArray(record.memoryItemIds) || !record.memoryItemIds.every(item => typeof item === "string")) {
    throw new Error("seed-report.json 的 memoryItemIds 非法")
  }
  if (typeof record.seededAt !== "string" || record.seededAt === "") {
    throw new Error("seed-report.json 缺少字段 seededAt")
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "seeded",
    fixtureId: record.fixtureId as string,
    fixtureHash: record.fixtureHash as string,
    sessionId: record.sessionId as string,
    sessionTitle: record.sessionTitle as string,
    messageCount: record.messageCount as number,
    userMessageCount: record.userMessageCount as number,
    memoryKeys: record.memoryKeys as string[],
    memoryItemIds: record.memoryItemIds as string[],
    sourceCount: record.sourceCount as number,
    revision: record.revision as number,
    generation: record.generation as string,
    hostPid: record.hostPid as number,
    seededAt: record.seededAt as string,
  }
}

async function writeReport(path: string, report: DirectSeedReport): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

/** 已有报告：只核对会话正文与记忆条目仍在，不重新写入；不一致就如实失败。 */
async function verifySaved(report: DirectSeedReport): Promise<void> {
  const metadata = (await listPiSessionMetadata()).find(item => item.id === report.sessionId)
  if (!metadata) throw new Error(`seed-report 指向的会话不存在：${report.sessionId}`)
  const session = await acquirePiSession(report.sessionId)
  const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)
  if (entries.length !== report.messageCount) {
    throw new Error(`会话 ${report.sessionId} 的条目数 ${entries.length} 与装载报告 ${report.messageCount} 不一致`)
  }
  await verifyMemory(report.memoryItemIds)
}

async function verifyMemory(expectedIds: string[]): Promise<void> {
  if (expectedIds.length === 0) return
  const items = await memoryList(undefined, undefined, 500)
  const ids = new Set(items.map(item => item.id))
  const missing = expectedIds.filter(id => !ids.has(id))
  if (missing.length > 0) throw new Error(`装载的初始记忆缺失：${missing.join(", ")}`)
}

/** 隔离根必须是干净的：没有旧会话、旧记忆或旧候选（否则无法与「重复装载」区分）。 */
async function assertFreshRoot(): Promise<void> {
  const sessionCount = (await listPiSessionMetadata()).length
  if (sessionCount > 0) {
    throw new Error(`sim-eval 隔离根已有 ${sessionCount} 个会话且没有 seed-report.json；拒绝二次装载`)
  }
  const status = await memoryStatus()
  if (status.itemCount > 0 || status.candidateCount > 0) {
    throw new Error(`sim-eval 隔离根记忆库非空（条目 ${status.itemCount} / 候选 ${status.candidateCount}）且没有 seed-report.json；拒绝二次装载`)
  }
}

function assertActiveCard(plan: DirectSeedPlan): void {
  const activeId = getActivePersonalityId()
  const activeCard = getActiveCard()
  if (activeId !== plan.card.activeId || !activeCard) {
    throw new Error(`fixture 要求的 Card 未激活：期望 ${plan.card.activeId}，实际 ${activeId ?? "无"}`)
  }
  if (activeCard.name !== plan.card.name) {
    throw new Error(`fixture 要求的 Card 名称不一致：期望 ${plan.card.name}，实际 ${activeCard.name}`)
  }
  if (plan.profileId !== null) {
    const activeProfile = getActiveProfile()
    if (!activeProfile || activeProfile.id !== plan.profileId) {
      throw new Error(`fixture 要求的 Profile 未激活：期望 ${plan.profileId}，实际 ${activeProfile?.id ?? "无"}`)
    }
  }
}

/** 按 fixture 顺序写会话正文；用户消息带真实投递身份、来源标记与 Card 归属。 */
async function appendFixtureSession(plan: DirectSeedPlan): Promise<{
  sources: MemorySource[]
  sourceIdByMessageKey: Map<string, string>
  title: string
}> {
  const summary = await createPiSessionWithId(plan.session.id, plan.session.title)
  const handle = await acquirePiSession(plan.session.id)
  const branch = await handle.branch(PI_LANE, BACKGROUND_CONTEXT)
    ?? await handle.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
  const eventKey = new Map<string, string>()
  for (const message of plan.session.messages) {
    if (message.role === "user") {
      const eventId = inputEventId(`fixture-${plan.fixtureId}-${message.key}`)
      eventKey.set(eventId, message.key)
      await branch.appendMessage({
        ...userInputMessage(message.content, eventId, {
          origin: "user", querySource: "chat", priority: "now", taint: "trusted_user",
          eligibleForMemory: true, cardId: plan.card.activeId,
        }),
        timestamp: message.atMs,
      }, BACKGROUND_CONTEXT)
    } else {
      await branch.appendMessage(fauxAssistantMessage(message.content, { timestamp: message.atMs }), BACKGROUND_CONTEXT)
    }
  }

  const entries = await handle.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)
  if (entries.length !== plan.session.messages.length) {
    throw new Error(`fixture 会话条目数 ${entries.length} 与消息数 ${plan.session.messages.length} 不一致`)
  }
  const sources: MemorySource[] = []
  const sourceIdByMessageKey = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue
    const eventId = messageEventId(entry.message)
    const key = eventId ? eventKey.get(eventId) : undefined
    if (!eventId || !key) throw new Error(`fixture 用户消息缺少投递身份：entry ${entry.id}`)
    const text = laneMessageText(entry.message).trim()
    const sourceId = `${plan.session.id}:${entry.id}`
    sources.push({
      sourceId,
      sessionId: plan.session.id,
      entryId: entry.id,
      eventId,
      seq: entry.seq,
      contentHash: await sha256(text),
      evidence: text.slice(0, EVIDENCE_CHARS),
      sourceLength: text.length,
      cardId: plan.card.activeId,
      eligibleForMemory: true,
      taint: "trusted_user",
      origin: "user",
      observedAt: entry.timestamp,
    })
    sourceIdByMessageKey.set(key, sourceId)
  }
  if (sources.length !== plan.sourceMessages.length) {
    throw new Error(`fixture 用户来源 ${sources.length} 与计划 ${plan.sourceMessages.length} 不一致`)
  }
  return { sources, sourceIdByMessageKey, title: summary.name }
}

/** 旧记忆逐条走产品变更接口；返回提交后的 revision 与读回的条目 id。 */
async function addInitialMemory(
  plan: DirectSeedPlan,
  sourceIdByMessageKey: Map<string, string>,
): Promise<{ itemIds: string[]; revision: number }> {
  let revision = (await memoryStatus()).revision
  const itemIds: string[] = []
  for (const item of plan.memory) {
    const sourceId = sourceIdByMessageKey.get(item.sourceMessageKey)
    if (!sourceId) throw new Error(`夹具记忆 ${item.key} 的来源消息未写入`)
    const draft: MemoryDraft = {
      content: item.content,
      summary: item.content.slice(0, 120),
      kind: item.kind,
      scope: item.scope,
      ...(item.scopeId ? { scopeId: item.scopeId } : {}),
      aliases: [],
      pinned: false,
      importance: 6,
      confidence: 1,
      observedAt: plan.clockMs,
      validFrom: item.validFromMs,
      validTo: item.validUntilMs,
      sourceIds: [sourceId],
    }
    revision = await applyMemoryChange({
      operationId: `direct-seed:${plan.fixtureId}:${item.key}`,
      baseRevision: revision,
      action: "add",
      actor: "internal",
      draft,
    })
    const saved = await findMemoryItem(item, sourceId)
    if (!saved) throw new Error(`初始记忆写入后读不回来：${item.key}`)
    itemIds.push(saved.id)
  }
  return { itemIds, revision }
}

async function findMemoryItem(
  item: DirectSeedPlan["memory"][number],
  sourceId: string,
): Promise<MemoryItem | undefined> {
  const items = await memoryList(item.scope, item.scopeId, 500)
  return [...items].reverse().find(candidate =>
    candidate.draft.content === item.content && candidate.draft.sourceIds.includes(sourceId))
}

/**
 * 把初始来源推进到水位：开一个 review 作业、登记覆盖来源、零候选提交。
 * 与 dreaming 的「本批已整理完」同一事务语义；没有这一步，首轮抽取会重做整段旧对话。
 */
async function settleInitialSources(sourceIds: string[], revision: number): Promise<number> {
  if (sourceIds.length === 0) return revision
  const job = await startMemoryJob("review")
  try {
    await checkpointMemoryJob(job.id, sourceIds[sourceIds.length - 1]!, sourceIds, LEASE_OWNER)
    return await commitMemoryDreamingJob(job.id, revision)
  } catch (error) {
    await cancelMemoryJob(job.id, LEASE_OWNER)
      .catch(cancelError => log.warn("初始来源收尾失败后取消作业失败:", formatError(cancelError)))
    throw error
  }
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}
