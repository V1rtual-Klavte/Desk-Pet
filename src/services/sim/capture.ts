// ==========================================
// sim 评测采集 — attempt 生命周期与跨会话取证
// ==========================================
//
// 运行器在隔离根里先建好 `<repo>/test/reports/chat/<evaluationRunId>/attempts/<NNNN>/`，
// 再把同一路径交给本模块。产品侧只写三种东西：
//   - `trace.jsonl`：trace-recorder 的有界分块（chunk 落盘 + fsync 才 ACK）；
//   - `state/before.json` / `state/after.json`：采集前后的会话与记忆快照；
//   - `state/capture.json`：trace 汇总、跨会话范围、记忆变更与完整性问题。
// dialogue.jsonl、manifest 与封存由测试侧证据模块完成；产品不 import 测试模块。
//
// 取证口径（契约 §6.3）：不限当前活跃会话、不截断 80 条、不固定 200 条记忆。
// 会话按 seq 游标分页并核对尾部；记忆列出上限 500 条后与状态计数核对。任一读取
// 失败、截断、跨根会话、既有消息被改写都进入 issues，并把 complete 置 false ——
// 不用空数组或成功标志代替未知。

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { getActiveSessionId, listPiSessionMetadata, readPiSessionEntriesOnce } from "@/services/session"
import { memoryList, memoryStatus } from "@/services/agent/memory"
import type { MemoryItem, MemoryStatusSnapshot } from "@/services/agent/memory"
import { laneMessageText } from "@/services/engine/runtime"
import { getSimEvalRunContext } from "./run-context"
import type { SimEvalRunContext } from "./run-context"
import type {
  SimCaptureTrialSpec, SimCaptureTrialStatus, SimTraceCaptureResult, SimTraceRecorder,
} from "./trace-recorder"
const EVALUATION_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const ATTEMPT_ID_PATTERN = /^\d{4}$/
const SESSION_PAGE_SIZE = 200
const MAX_SESSION_PAGES = 10_000
const MEMORY_LIST_LIMIT = 500
const CAPTURE_STATE_SCHEMA_VERSION = 1

export type SimCaptureOrigin = "fixture" | "driver" | "assistant"

export interface SimCaptureMessage {
  sessionId: string
  entryId: string
  seq: number
  role: "user" | "assistant"
  text: string
  at: number
  origin: SimCaptureOrigin
}

export interface SimCaptureSessionSnapshot {
  sessionId: string
  createdAt: number
  modifiedAt: number
  seqTip: number | null
  messageCount: number
  complete: boolean
  messages: SimCaptureMessage[]
}

export interface SimCaptureExcludedSession {
  sessionId: string
  cwd: string
  reason: string
}

export interface SimCaptureMemoryItem {
  id: string
  version: number
  status: string
  origin: string
  kind: string
  scope: string
  scopeId: string | null
  content: string
  summary: string
  sourceIds: string[]
  pinned: boolean
  importance: number
  confidence: number
  createdAt: number
  updatedAt: number
}

export interface SimCaptureMemorySnapshot {
  revision: number
  forgetEpoch: number
  itemCount: number
  candidateCount: number
  jobCount: number
  collected: number
  complete: boolean
  items: SimCaptureMemoryItem[]
}

export interface SimCaptureSnapshot {
  capturedAt: string
  sessions: SimCaptureSessionSnapshot[]
  excludedSessions: SimCaptureExcludedSession[]
  activeSessionId: string | null
  memory: SimCaptureMemorySnapshot | null
  /** 会话读取与记忆采集都完整，且没有范围异常。 */
  complete: boolean
  issues: string[]
}

export interface SimCaptureStartInput {
  attemptDir: string
  evaluationRunId: string
  expectedTrials: SimCaptureTrialSpec[]
}

export interface SimCaptureStartResult {
  evaluationRunId: string
  attemptId: string
  attemptDir: string
  tracePath: string
  startedAt: string
  traceStartedAt: number
  before: {
    capturedAt: string
    sessions: Array<{ sessionId: string; seqTip: number | null; messageCount: number; complete: boolean }>
    excludedSessions: SimCaptureExcludedSession[]
    activeSessionId: string | null
    memory: MemorySummary | null
    complete: boolean
    issues: string[]
  }
  complete: boolean
  issues: string[]
}

export interface MemorySummary {
  revision: number
  itemCount: number
  collected: number
  complete: boolean
}

export interface SimCaptureFinishOptions {
  status?: "completed" | "failed" | "interrupted"
  reason?: string
  now?: number
}

export interface SimCaptureFinishResult {
  evaluationRunId: string
  attemptId: string
  attemptDir: string
  tracePath: string
  startedAt: string
  finishedAt: string
  status: "completed" | "interrupted"
  trace: {
    status: "completed" | "interrupted"
    chunkCount: number
    eventCount: number
    droppedCount: number
    orphanCount: number
    complete: boolean
    trials: SimCaptureTrialStatus[]
    issues: string[]
  }
  dialogue: {
    messageCount: number
    sessions: string[]
    origins: Record<SimCaptureOrigin, number>
    messages: SimCaptureMessage[]
  }
  sessions: {
    before: Array<{ sessionId: string; seqTip: number | null; messageCount: number }>
    after: Array<{ sessionId: string; seqTip: number | null; messageCount: number }>
    added: string[]
    removed: string[]
  }
  memory: {
    before: MemorySummary | null
    after: MemorySummary | null
    added: string[]
    updated: string[]
    removed: string[]
  }
  complete: boolean
  issues: string[]
}

export interface SimCaptureStatus {
  evaluationRunId: string
  attemptId: string
  attemptDir: string
  tracePath: string
  startedAt: string
  finished: boolean
  trace: SimTraceCaptureResult | null
}

/** 控制通道事件里只带摘要：完整对话在 `state/after.json`，避免把正文塞进 outbox。 */
export type SimCaptureSummary = Omit<SimCaptureFinishResult, "dialogue"> & {
  dialogue: Omit<SimCaptureFinishResult["dialogue"], "messages">
}

export function summarizeCaptureResult(result: SimCaptureFinishResult): SimCaptureSummary {
  const { messages: _messages, ...dialogue } = result.dialogue
  return { ...result, dialogue }
}

export interface SimCaptureSessionsResult {
  capturedAt: string
  sessions: Array<{ sessionId: string; createdAt: number; seqTip: number | null; messageCount: number }>
  excludedSessions: SimCaptureExcludedSession[]
  activeSessionId: string | null
  complete: boolean
  issues: string[]
}

export interface SimCaptureManager {
  start: (input: SimCaptureStartInput) => Promise<SimCaptureStartResult>
  beginTrial: (caseId: string, trialId: string) => Promise<void>
  endTrial: (
    caseId: string,
    trialId: string,
    options?: { status?: "completed" | "failed"; error?: string },
  ) => Promise<void>
  /** 只读取当前范围，不写状态文件；供运行器在驱动中途核对会话。 */
  sessions: () => Promise<SimCaptureSessionsResult>
  finish: (options?: SimCaptureFinishOptions) => Promise<SimCaptureFinishResult>
  status: () => SimCaptureStatus | null
}

interface AttemptLocation {
  attemptDir: string
  attemptId: string
  tracePath: string
}

interface CaptureRuntime {
  context: SimEvalRunContext
  location: AttemptLocation
  evaluationRunId: string
  before: SimCaptureSnapshot
  startedAt: string
  finished?: SimCaptureFinishResult
}

const normalizePath = (value: string): string => {
  const resolved = resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function writeStateFile(path: string, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const fd = openSync(path, "wx")
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset)
      if (written <= 0) throw new Error(`状态写入返回 0 字节：${path}`)
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function resolveAttemptLocation(
  context: SimEvalRunContext,
  evaluationRunId: string,
  attemptDir: string,
): Promise<AttemptLocation> {
  if (typeof evaluationRunId !== "string" || !EVALUATION_RUN_ID_PATTERN.test(evaluationRunId)) {
    throw new Error(`evaluationRunId 不合法：${String(evaluationRunId)}`)
  }
  if (typeof attemptDir !== "string" || attemptDir.trim() === "") throw new Error("采集缺少 attemptDir")
  const repoRoot = dirname(dirname(dirname(context.runDir)))
  const attemptsRoot = join(repoRoot, "test", "reports", "chat", evaluationRunId, "attempts")
  let attemptsRootReal: string
  let attemptReal: string
  try {
    attemptsRootReal = await realpath(attemptsRoot)
    attemptReal = await realpath(attemptDir)
  } catch (error) {
    throw new Error(`采集目录不存在或不可解析：${messageOf(error)}`)
  }
  if (normalizePath(dirname(attemptReal)) !== normalizePath(attemptsRootReal)) {
    throw new Error(`attemptDir 必须位于 test/reports/chat/${evaluationRunId}/attempts 下：${attemptDir}`)
  }
  const attemptId = attemptReal.split(/[\\/]/).at(-1) ?? ""
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error(`attempt 目录必须是四位序号：${attemptId}`)
  }
  return {
    attemptDir: attemptReal,
    attemptId,
    tracePath: join(attemptReal, "trace.jsonl"),
  }
}

function safeActiveSessionId(): string | null {
  try { return getActiveSessionId() } catch { return null }
}

function memorySummary(snapshot: SimCaptureMemorySnapshot | null): MemorySummary | null {
  if (!snapshot) return null
  return {
    revision: snapshot.revision,
    itemCount: snapshot.itemCount,
    collected: snapshot.collected,
    complete: snapshot.complete,
  }
}

function toMemoryItem(item: MemoryItem): SimCaptureMemoryItem {
  return {
    id: item.id,
    version: item.version,
    status: item.status,
    origin: item.origin,
    kind: item.draft.kind,
    scope: item.draft.scope,
    scopeId: item.draft.scopeId ?? null,
    content: item.draft.content,
    summary: item.draft.summary,
    sourceIds: [...item.draft.sourceIds].sort(),
    pinned: item.draft.pinned,
    importance: item.draft.importance,
    confidence: item.draft.confidence,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

async function readMemorySnapshot(issues: string[]): Promise<SimCaptureMemorySnapshot | null> {
  let status: MemoryStatusSnapshot
  try {
    status = await memoryStatus()
  } catch (error) {
    issues.push(`记忆状态读取失败：${messageOf(error)}`)
    return null
  }
  let items: MemoryItem[]
  try {
    items = await memoryList(undefined, undefined, MEMORY_LIST_LIMIT)
  } catch (error) {
    issues.push(`记忆列表读取失败：${messageOf(error)}`)
    return {
      revision: status.revision,
      forgetEpoch: status.forgetEpoch,
      itemCount: status.itemCount,
      candidateCount: status.candidateCount,
      jobCount: status.jobCount,
      collected: 0,
      complete: false,
      items: [],
    }
  }
  const complete = items.length >= status.itemCount
  if (!complete) {
    issues.push(`记忆条目未完采：状态 ${status.itemCount} 条，实际列出 ${items.length} 条`)
  }
  return {
    revision: status.revision,
    forgetEpoch: status.forgetEpoch,
    itemCount: status.itemCount,
    candidateCount: status.candidateCount,
    jobCount: status.jobCount,
    collected: items.length,
    complete,
    items: items.map(toMemoryItem).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

async function readSessionSnapshot(
  metadata: Awaited<ReturnType<typeof listPiSessionMetadata>>[number],
  issues: string[],
): Promise<SimCaptureSessionSnapshot> {
  const sessionId = metadata.id
  const messages: SimCaptureMessage[] = []
  let lastSeq = 0
  let pages = 0
  let complete = true
  try {
    while (true) {
      pages += 1
      if (pages > MAX_SESSION_PAGES) {
        issues.push(`会话 ${sessionId} 分页超过 ${MAX_SESSION_PAGES} 页，停止读取`)
        complete = false
        break
      }
      const cursor = lastSeq
      const page = await readPiSessionEntriesOnce(sessionId, {
        type: "message",
        order: "asc",
        limit: SESSION_PAGE_SIZE,
        ...(cursor === 0 ? {} : { cursor: { seq: cursor } }),
      })
      for (const entry of page) {
        if (entry.seq <= cursor) {
          // 游标未生效时不能继续翻页：否则会重复采集同一段或无限循环。
          issues.push(`会话 ${sessionId} 分页游标未前进（seq=${entry.seq} <= ${cursor}）`)
          complete = false
          return {
            sessionId,
            createdAt: metadata.createdAt,
            modifiedAt: metadata.modifiedAt,
            seqTip: lastSeq === 0 ? null : lastSeq,
            messageCount: messages.length,
            complete,
            messages,
          }
        }
        lastSeq = entry.seq
        if (entry.type !== "message") continue
        const role = entry.message.role
        if (role !== "user" && role !== "assistant") continue
        const text = laneMessageText(entry.message).trim()
        if (!text) {
          // assistant 工具轮没有可见回复，正文由 trace 承担；用户纯图片消息无法进入
          // 文本对话证据，必须显式标不完整而不是当作没发生。
          if (role === "user") {
            issues.push(`会话 ${sessionId} 的用户消息 ${entry.id} 没有可提取文本，未进入对话证据`)
            complete = false
          }
          continue
        }
        if (!Number.isSafeInteger(entry.timestamp)) {
          issues.push(`会话 ${sessionId} 的消息 ${entry.id} 时间戳非法，未进入对话证据`)
          complete = false
          continue
        }
        messages.push({
          sessionId, entryId: entry.id, seq: entry.seq, role, text, at: entry.timestamp, origin: "fixture",
        })
      }
      if (page.length < SESSION_PAGE_SIZE) break
    }
    const tip = (await readPiSessionEntriesOnce(sessionId, { type: "message", order: "desc", limit: 1 }))[0]
    if (tip && tip.seq > lastSeq) {
      issues.push(`会话 ${sessionId} 分页未到尾部：读到 seq=${lastSeq}，尾部 seq=${tip.seq}`)
      complete = false
    }
    return {
      sessionId,
      createdAt: metadata.createdAt,
      modifiedAt: metadata.modifiedAt,
      seqTip: tip?.seq ?? null,
      messageCount: messages.length,
      complete,
      messages,
    }
  } catch (error) {
    issues.push(`会话 ${sessionId} 读取失败：${messageOf(error)}`)
    return {
      sessionId,
      createdAt: metadata.createdAt,
      modifiedAt: metadata.modifiedAt,
      seqTip: lastSeq === 0 ? null : lastSeq,
      messageCount: messages.length,
      complete: false,
      messages,
    }
  }
}

async function readSnapshot(context: SimEvalRunContext): Promise<SimCaptureSnapshot> {
  const capturedAt = new Date().toISOString()
  const issues: string[] = []
  const activeSessionId = safeActiveSessionId()
  let metadata: Awaited<ReturnType<typeof listPiSessionMetadata>>
  try {
    metadata = await listPiSessionMetadata()
  } catch (error) {
    issues.push(`会话列举失败：${messageOf(error)}`)
    const memory = await readMemorySnapshot(issues)
    return { capturedAt, sessions: [], excludedSessions: [], activeSessionId, memory, complete: false, issues }
  }

  const owned: typeof metadata = []
  const excludedSessions: SimCaptureExcludedSession[] = []
  for (const item of [...metadata].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (normalizePath(item.cwd) !== normalizePath(context.dataRoot)) {
      excludedSessions.push({ sessionId: item.id, cwd: item.cwd, reason: "会话 cwd 不属于本次隔离数据根" })
      issues.push(`排除跨数据根会话 ${item.id}（cwd=${item.cwd}）`)
      continue
    }
    owned.push(item)
  }

  const sessions: SimCaptureSessionSnapshot[] = []
  for (const item of owned) sessions.push(await readSessionSnapshot(item, issues))
  const memory = await readMemorySnapshot(issues)
  const complete = sessions.every(session => session.complete)
    && excludedSessions.length === 0
    && memory !== null
    && memory.complete
    && issues.length === 0
  return { capturedAt, sessions, excludedSessions, activeSessionId, memory, complete, issues }
}

function attributeOrigins(
  before: SimCaptureSnapshot,
  after: SimCaptureSnapshot,
  issues: string[],
): void {
  const beforeByKey = new Map<string, SimCaptureMessage>()
  const beforeTips = new Map<string, number>()
  const beforeSessions = new Set<string>()
  for (const session of before.sessions) {
    beforeSessions.add(session.sessionId)
    beforeTips.set(session.sessionId, session.seqTip ?? 0)
    for (const message of session.messages) beforeByKey.set(`${session.sessionId}\0${message.entryId}`, message)
  }

  for (const session of after.sessions) {
    const tip = beforeTips.get(session.sessionId) ?? 0
    for (const message of session.messages) {
      const key = `${session.sessionId}\0${message.entryId}`
      const existed = beforeByKey.has(key) || message.seq <= tip
      message.origin = existed ? "fixture" : message.role === "user" ? "driver" : "assistant"
    }
  }

  for (const sessionId of beforeSessions) {
    if (!after.sessions.some(session => session.sessionId === sessionId)) {
      issues.push(`会话在采集中消失：${sessionId}`)
    }
  }
  // 读取不完整时不能得出「消息被改写或消失」的结论，避免把读取失败误报成篡改。
  if (!after.complete) return
  const afterByKey = new Map<string, SimCaptureMessage>()
  for (const session of after.sessions) {
    for (const message of session.messages) afterByKey.set(`${session.sessionId}\0${message.entryId}`, message)
  }
  for (const [key, message] of beforeByKey) {
    const current = afterByKey.get(key)
    if (!current) {
      issues.push(`既有消息在采集中消失：${message.sessionId}/${message.entryId}`)
      continue
    }
    if (current.text !== message.text || current.at !== message.at) {
      issues.push(`既有消息在采集中被改写：${message.sessionId}/${message.entryId}`)
    }
  }
}

function buildDialogue(after: SimCaptureSnapshot): SimCaptureMessage[] {
  return after.sessions
    .flatMap(session => session.messages)
    .sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq)
}

function diffMemory(
  before: SimCaptureMemorySnapshot | null,
  after: SimCaptureMemorySnapshot | null,
): { added: string[]; updated: string[]; removed: string[] } {
  if (!before || !after || !before.complete || !after.complete) {
    return { added: [], updated: [], removed: [] }
  }
  const beforeById = new Map(before.items.map(item => [item.id, item]))
  const afterById = new Map(after.items.map(item => [item.id, item]))
  const added = after.items.filter(item => !beforeById.has(item.id)).map(item => item.id)
  const removed = before.items.filter(item => !afterById.has(item.id)).map(item => item.id)
  const updated = after.items
    .filter(item => beforeById.get(item.id)?.version !== item.version)
    .map(item => item.id)
  return { added, updated, removed }
}

export function createSimCaptureManager(recorder: SimTraceRecorder): SimCaptureManager {
  let runtime: CaptureRuntime | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }

  function requireRuntime(): CaptureRuntime {
    if (!runtime) throw new Error("sim 采集尚未开始")
    return runtime
  }

  async function start(input: SimCaptureStartInput): Promise<SimCaptureStartResult> {
    return enqueue(async () => {
      if (runtime) throw new Error("sim 采集已经开始")
      const context = await getSimEvalRunContext()
      if (!context) throw new Error("sim 采集只在 DESKPET_SIM_EVAL 隔离运行中可用")
      if (!Array.isArray(input.expectedTrials) || input.expectedTrials.length === 0) {
        throw new Error("sim 采集必须声明 expectedTrials")
      }
      const location = await resolveAttemptLocation(context, input.evaluationRunId, input.attemptDir)
      mkdirSync(join(location.attemptDir, "state"), { recursive: true })
      const before = await readSnapshot(context)
      const startedAt = new Date().toISOString()
      await recorder.startCapture({
        attemptDir: location.attemptDir,
        tracePath: location.tracePath,
        expectedTrials: input.expectedTrials,
      })
      try {
        writeStateFile(join(location.attemptDir, "state", "before.json"), {
          schemaVersion: CAPTURE_STATE_SCHEMA_VERSION,
          kind: "before",
          evaluationRunId: input.evaluationRunId,
          attemptId: location.attemptId,
          runDir: context.runDir,
          dataRoot: context.dataRoot,
          capturedAt: before.capturedAt,
          activeSessionId: before.activeSessionId,
          sessions: before.sessions,
          excludedSessions: before.excludedSessions,
          memory: before.memory,
          complete: before.complete,
          issues: before.issues,
        })
      } catch (error) {
        await recorder.finishCapture({ status: "interrupted", reason: `before 状态写盘失败：${messageOf(error)}` })
          .catch(() => undefined)
        throw new Error(`before 状态写盘失败：${messageOf(error)}`)
      }
      runtime = { context, location, evaluationRunId: input.evaluationRunId, before, startedAt }
      return {
        evaluationRunId: input.evaluationRunId,
        attemptId: location.attemptId,
        attemptDir: location.attemptDir,
        tracePath: location.tracePath,
        startedAt,
        traceStartedAt: Date.now(),
        before: {
          capturedAt: before.capturedAt,
          sessions: before.sessions.map(session => ({
            sessionId: session.sessionId,
            seqTip: session.seqTip,
            messageCount: session.messageCount,
            complete: session.complete,
          })),
          excludedSessions: before.excludedSessions,
          activeSessionId: before.activeSessionId,
          memory: memorySummary(before.memory),
          complete: before.complete,
          issues: before.issues,
        },
        complete: before.complete,
        issues: before.issues,
      }
    })
  }

  function beginTrial(caseId: string, trialId: string): Promise<void> {
    return enqueue(async () => {
      requireRuntime()
      await recorder.beginTrial(caseId, trialId)
    })
  }

  function endTrial(
    caseId: string,
    trialId: string,
    options: { status?: "completed" | "failed"; error?: string } = {},
  ): Promise<void> {
    return enqueue(async () => {
      requireRuntime()
      await recorder.endTrial(caseId, trialId, options)
    })
  }

  function sessions(): Promise<SimCaptureSessionsResult> {
    return enqueue(async () => {
      const state = requireRuntime()
      const snapshot = await readSnapshot(state.context)
      return {
        capturedAt: snapshot.capturedAt,
        sessions: snapshot.sessions.map(session => ({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          seqTip: session.seqTip,
          messageCount: session.messageCount,
        })),
        excludedSessions: snapshot.excludedSessions,
        activeSessionId: snapshot.activeSessionId,
        complete: snapshot.complete,
        issues: snapshot.issues,
      }
    })
  }

  function finish(options: SimCaptureFinishOptions = {}): Promise<SimCaptureFinishResult> {
    return enqueue(async () => {
      const state = requireRuntime()
      if (state.finished) return state.finished
      const trace = await recorder.finishCapture({
        ...(options.status ? { status: options.status } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
      const issues = [...state.before.issues, ...trace.issues]
      const after = await readSnapshot(state.context)
      issues.push(...after.issues)
      attributeOrigins(state.before, after, issues)
      if (trace.orphanCount > 0) issues.push(`存在 ${trace.orphanCount} 个未归属 orphan 事件，需复核`)

      const dialogueMessages = buildDialogue(after)
      if (dialogueMessages.length === 0) issues.push("采集中没有可进入对话证据的消息")
      const origins: Record<SimCaptureOrigin, number> = { fixture: 0, driver: 0, assistant: 0 }
      for (const message of dialogueMessages) origins[message.origin] += 1
      const dialogueSessions = [...new Set(dialogueMessages.map(message => message.sessionId))].sort()

      const beforeSessionIds = state.before.sessions.map(session => session.sessionId)
      const afterSessionIds = after.sessions.map(session => session.sessionId)
      const addedSessions = afterSessionIds.filter(id => !beforeSessionIds.includes(id))
      const removedSessions = beforeSessionIds.filter(id => !afterSessionIds.includes(id))
      const memoryChanges = diffMemory(state.before.memory, after.memory)

      const traceComplete = trace.status === "completed" && trace.complete && trace.issues.length === 0
      const complete = traceComplete
        && state.before.complete
        && after.complete
        && after.memory !== null
        && after.memory.complete
        && issues.length === 0

      const result: SimCaptureFinishResult = {
        evaluationRunId: state.evaluationRunId,
        attemptId: state.location.attemptId,
        attemptDir: state.location.attemptDir,
        tracePath: state.location.tracePath,
        startedAt: state.startedAt,
        finishedAt: new Date(trace.finishedAt).toISOString(),
        status: complete ? "completed" : "interrupted",
        trace: {
          status: trace.status,
          chunkCount: trace.chunkCount,
          eventCount: trace.eventCount,
          droppedCount: trace.droppedCount,
          orphanCount: trace.orphanCount,
          complete: trace.complete,
          trials: trace.trials,
          issues: trace.issues,
        },
        dialogue: {
          messageCount: dialogueMessages.length,
          sessions: dialogueSessions,
          origins,
          messages: dialogueMessages,
        },
        sessions: {
          before: state.before.sessions.map(session => ({
            sessionId: session.sessionId, seqTip: session.seqTip, messageCount: session.messageCount,
          })),
          after: after.sessions.map(session => ({
            sessionId: session.sessionId, seqTip: session.seqTip, messageCount: session.messageCount,
          })),
          added: addedSessions,
          removed: removedSessions,
        },
        memory: {
          before: memorySummary(state.before.memory),
          after: memorySummary(after.memory),
          added: memoryChanges.added,
          updated: memoryChanges.updated,
          removed: memoryChanges.removed,
        },
        complete,
        issues: unique(issues),
      }

      try {
        writeStateFile(join(state.location.attemptDir, "state", "after.json"), {
          schemaVersion: CAPTURE_STATE_SCHEMA_VERSION,
          kind: "after",
          evaluationRunId: state.evaluationRunId,
          attemptId: state.location.attemptId,
          runDir: state.context.runDir,
          dataRoot: state.context.dataRoot,
          capturedAt: after.capturedAt,
          activeSessionId: after.activeSessionId,
          sessions: after.sessions,
          excludedSessions: after.excludedSessions,
          memory: after.memory,
          complete: after.complete,
          issues: after.issues,
        })
        writeStateFile(join(state.location.attemptDir, "state", "capture.json"), {
          schemaVersion: CAPTURE_STATE_SCHEMA_VERSION,
          kind: "capture",
          evaluationRunId: state.evaluationRunId,
          attemptId: state.location.attemptId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          status: result.status,
          trace: result.trace,
          dialogue: {
            messageCount: result.dialogue.messageCount,
            sessions: result.dialogue.sessions,
            origins: result.dialogue.origins,
          },
          sessions: result.sessions,
          memory: result.memory,
          complete: result.complete,
          issues: result.issues,
        })
      } catch (error) {
        throw new Error(`after/capture 状态写盘失败：${messageOf(error)}`)
      }
      state.finished = result
      return result
    })
  }

  function status(): SimCaptureStatus | null {
    if (!runtime) return null
    return {
      evaluationRunId: runtime.evaluationRunId,
      attemptId: runtime.location.attemptId,
      attemptDir: runtime.location.attemptDir,
      tracePath: runtime.location.tracePath,
      startedAt: runtime.startedAt,
      finished: runtime.finished !== undefined,
      trace: recorder.captureStatus(),
    }
  }

  return { start, beginTrial, endTrial, sessions, finish, status }
}
