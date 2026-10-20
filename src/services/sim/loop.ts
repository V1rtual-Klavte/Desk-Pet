/**
 * 开发期组件演练：真实 app 进程内的「了解 → dreaming → 主动消息 → 定时任务」。
 *
 * 聊天不在这里生成 —— 用户由 Claude 通过 `chat-bridge` 的控制文件直接驱动，
 * 本模块只负责可重复的组件轮次与报告。
 */
import { getHostBridge } from "@/services/host"
import { getActiveCard } from "@/services/personality"
import { getActiveSessionId } from "@/services/session"
import { getRuntimeMode } from "@/services/paths"
import { harnessSlots } from "@/services/engine/harness"
import { sha256Text } from "@/services/engine/runtime"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { runObservationBatchNow, getUnderstandingSnapshotAsync } from "@/services/observation"
import type { UnderstandingSnapshot } from "@/services/observation"
import { getRecentWindowObservations } from "@/services/window"
import type { WindowObservation } from "@/services/window"
import { runDreamingSweep, memoryList, memoryStatus } from "@/services/agent/memory"
import type { MemoryItem, MemoryStatusSnapshot } from "@/services/agent/memory"
import { tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"
import type { ProactiveOwner, ProactiveSourceRef } from "@/services/proactive"
import { changeUserTask, queryUserTasks, taskCapabilityFingerprint, taskContentFingerprint } from "@/services/user-tasks"
import type { UserTaskDefinition } from "@/services/user-tasks"
import { listAll } from "@/services/tool"
import type { ScheduleQueryResponse, SchedulerRunRecord } from "@/services/scheduler/protocol"
import { createSimTraceRecorder } from "./trace-recorder"
import type { SimTraceSummary } from "./trace-recorder"
import { writeSimFiles } from "./report"

const log = createLogger("SimLoop")
const TASK_WAIT_MS = 90_000

export interface SimLoopOptions {
  rounds?: number
  withTask?: boolean
  signal?: AbortSignal
}

export interface SimRoundLog {
  round: number
  localDate: string
  now: number
  observation: { status: string; reason?: string; window?: string; targets: string[] }
  dreaming: { status: string; jobId?: string; message?: string }
  proactive: { events: Array<{ kind: string; payload: Record<string, unknown> }> }
  task?: SimTaskResult
}

export interface SimTaskResult {
  taskId: string
  created: boolean
  delivered: boolean
  run?: SchedulerRunRecord
  state?: string
  error?: string
}

export interface SimTaskOptions {
  kind?: "reminder" | "agent_job"
  text?: string
  work?: {
    goal: string
    inputs: string[]
    capabilities: string[]
    output: string
    completion: string
  }
}

export interface SimLoopResult {
  reportPath: string
  markdownPath: string
  tracePath: string
  rounds: SimRoundLog[]
  summary: SimTraceSummary
}

let running = false

export function isSimLoopRunning(): boolean {
  return running
}

export async function runSimLoop(options: SimLoopOptions = {}): Promise<SimLoopResult> {
  if (getRuntimeMode() !== "development") throw new Error("组件演练仅在开发模式可用")
  if (running) throw new Error("已有一轮组件演练在跑")
  running = true
  const rounds = Math.max(1, Math.round(options.rounds ?? 1))
  const owner = activeOwner()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const roundLogs: SimRoundLog[] = []
  const recorder = createSimTraceRecorder()
  let task: SimTaskResult | undefined
  try {
    for (let round = 0; round < rounds; round += 1) {
      if (options.signal?.aborted) break
      const now = Date.now()
      const localDate = localDayKey(now, timezone)
      const roundLog: SimRoundLog = {
        round: round + 1,
        localDate,
        now,
        observation: { status: "skipped", targets: [] },
        dreaming: { status: "skipped" },
        proactive: { events: [] },
      }

      const windowObservation = pickRecentWindow()
      const observation = await runObservationBatchNow({
        now,
        localDate,
        ...(windowObservation ? { windowObservation } : {}),
      })
      roundLog.observation = {
        status: observation.status,
        ...(observation.reason ? { reason: observation.reason } : {}),
        ...(windowObservation ? { window: `${windowObservation.app ?? "?"} — ${windowObservation.title ?? "?"}` } : {}),
        targets: [],
      }

      const dreaming = await runDreamingSweep()
      roundLog.dreaming = {
        status: dreaming.status,
        ...(dreaming.jobId ? { jobId: dreaming.jobId } : {}),
        ...(dreaming.message ? { message: dreaming.message } : {}),
      }

      if (round === 0 && options.withTask !== false) {
        task = await seedAndDeliverTask(owner)
        roundLog.task = task
      }

      const before = recorder.events.length
      await tick(Date.now())
      roundLog.proactive.events = recorder.events.slice(before)
        .filter(event => event.kind.startsWith("proactive_"))
        .map(event => ({ kind: event.kind, payload: event.payload }))

      roundLogs.push(roundLog)
    }
  } finally {
    running = false
    recorder.stop()
  }

  const [understanding, items, status] = await Promise.all([
    getUnderstandingSnapshotAsync(Date.now()).catch(() => undefined as UnderstandingSnapshot | undefined),
    memoryList(undefined, undefined, 200).catch(() => [] as MemoryItem[]),
    memoryStatus().catch(() => undefined as MemoryStatusSnapshot | undefined),
  ])
  const taskState = task
    ? await queryUserTasks({ owner, taskId: task.taskId, includeResults: true }).catch(() => undefined as ScheduleQueryResponse | undefined)
    : undefined
  const summary = recorder.summary()
  const report = {
    schemaVersion: 1 as const,
    startedAt: roundLogs[0]?.now ?? Date.now(),
    finishedAt: Date.now(),
    owner: { sessionId: owner.sessionId, cardId: owner.cardId, cardHash: owner.cardHash },
    rounds: roundLogs,
    understanding: understanding
      ? {
          quality: understanding.quality,
          coverage: understanding.coverage,
          independentSources: understanding.independentSources,
          observations: understanding.observations.map(row => ({
            kind: row.kind, observedAt: row.observedAt, summary: row.summary, targets: row.targets ?? [],
          })),
        }
      : null,
    memory: {
      status: status ?? null,
      items: items.map(item => ({
        id: item.id, version: item.version, status: item.status, origin: item.origin,
        kind: item.draft.kind, scope: item.draft.scope, content: item.draft.content,
      })),
    },
    task: task ? { created: task, state: taskState ?? null } : null,
    trace: summary,
  }
  const files = await writeSimFiles({
    prefix: "drill",
    report,
    markdown: renderMarkdown(report),
    events: recorder.events,
  })
  log.info("组件演练完成:", files.reportPath)
  return { ...files, rounds: roundLogs, summary }
}

export function activeOwner(): ProactiveOwner {
  const sessionId = getActiveSessionId()
  const card = getActiveCard()
  if (!sessionId || !card) throw new Error("闭环演练需要活跃会话与 Card")
  return { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: harnessSlots.snapshot(sessionId)?.generation ?? 0 }
}

/** 桌宠自己占前台时，用最近一次非桌宠窗口作为真实观察来源；没有就交给批次按现有门禁跳过。 */
export function pickRecentWindow(): WindowObservation | undefined {
  const recent = getRecentWindowObservations()
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const observation = recent[index]!
    if (!observation.isPetForeground && (observation.observationState === "observed" || observation.observationState === "locked")) {
      return observation
    }
  }
  return undefined
}

export async function seedAndDeliverTask(owner: ProactiveOwner, options: SimTaskOptions = {}): Promise<SimTaskResult> {
  const taskId = `sim-task-${crypto.randomUUID()}`
  const sourceId = `sim-source-${crypto.randomUUID()}`
  const entryId = `sim-entry-${crypto.randomUUID()}`
  const eventId = `sim-event-${crypto.randomUUID()}`
  const kind = options.kind ?? "reminder"
  const evidence = options.text ?? (kind === "agent_job" ? "检查当前窗口并写一句总结" : "提醒我过一会儿起来走走")
  const contentHash = await sha256Text(evidence)
  const now = Date.now()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const work = kind === "agent_job"
    ? options.work ?? {
        goal: evidence,
        inputs: [],
        capabilities: ["window_info", "system_info"],
        output: "一句中文总结",
        completion: "总结包含当前应用或窗口标题",
      }
    : undefined
  try {
    await getHostBridge().request("memory_register_sources", {
      sources: [{
        sourceId, sessionId: owner.sessionId, entryId, eventId, seq: 1, contentHash, evidence,
        cardId: owner.cardId, observedAt: now, eligibleForMemory: true, origin: "user", taint: "trusted_user",
      }],
    })
    const reference: ProactiveSourceRef = {
      kind: "user_entry", id: sourceId, version: 1, revision: 1, scope: "session", scopeId: owner.sessionId,
      fingerprint: `${owner.sessionId}:${entryId}:${contentHash}`, validUntil: null,
    }
    const local = new Date(now)
    const at = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`
    const until = now + 3_600_000
    const grants = work
      ? work.capabilities.flatMap(name => {
          const tool = listAll().find(item => item.name === name)
          return tool ? [{ toolName: name, descriptorHash: taskCapabilityFingerprint(tool) }] : []
        })
      : []
    if (work && grants.length !== work.capabilities.length) {
      return { taskId, created: false, delivered: false, error: "任务声明的能力当前未注册：" + work.capabilities.join("、") }
    }
    const definition: UserTaskDefinition = {
      kind,
      text: evidence,
      ...(work ? { work } : {}),
      schedule: {
        calendar: { frequency: "daily", timezone },
        trigger: { kind: "at", time: at },
        count: { kind: "fixed", value: 1, per: "day" },
        minGapMinutes: 1,
        validity: { from: now - 60_000, until },
        missedPolicy: "within_window",
      },
      execution: { thinkingEffort: "low" },
      delivery: { sessionId: owner.sessionId, cardId: owner.cardId, cardHash: owner.cardHash, windowMinutes: 15, expression: "自然提醒" },
    }
    definition.authorization = {
      trustedUserEventId: eventId,
      contentFingerprint: taskContentFingerprint(definition),
      sourceVersions: [{ kind: reference.kind, id: reference.id, version: reference.version,
        revision: reference.revision, fingerprint: reference.fingerprint }],
      capabilityGrants: grants,
    }
    const snapshot = await queryUserTasks({ owner, limit: 1 })
    const created = await changeUserTask({
      operationId: `sim-create-${taskId}`,
      baseRevision: snapshot.revision,
      action: "create",
      owner,
      trustedUserEventId: eventId,
      sourceRefs: [reference],
      taskPatch: {
        id: taskId, scope: "session", scopeId: owner.sessionId, sourceRefs: [reference], intent: definition,
        eventAt: null, dueAt: null, nextCheckinAt: now - 1, validUntil: until, timezone, recurrence: null,
      },
    })
    if (!created.task) return { taskId, created: false, delivered: false, error: "真实 Rust 未创建定时任务" }
    const delivered = await waitForTaskDelivery(owner, taskId, kind === "agent_job" ? 300_000 : TASK_WAIT_MS)
    return {
      taskId, created: true, delivered: delivered?.status === "delivered", state: created.task.state,
      ...(delivered ? { run: delivered } : {}),
    }
  } catch (error) {
    return { taskId, created: false, delivered: false, error: formatError(error) }
  }
}

async function waitForTaskDelivery(owner: ProactiveOwner, taskId: string, timeoutMs: number): Promise<SchedulerRunRecord | undefined> {
  const deadline = Date.now() + timeoutMs
  let latest: SchedulerRunRecord | undefined
  while (Date.now() < deadline) {
    const state = await getHostBridge().request("scheduler_state", {
      request: { operation: "run_list", owner, taskId, limit: 1 },
    })
    if ("runs" in state && state.runs.length > 0) {
      latest = state.runs[0]
      if (latest.status === "delivered") return latest
      if (["failed", "needs_input", "expired", "unresolved"].includes(latest.status)) return latest
    }
    await sleep(500)
  }
  return latest
}

function renderMarkdown(report: {
  rounds: SimRoundLog[]
  understanding: { quality: string; coverage: number; independentSources: number; observations: Array<{ kind: string; summary: string; targets?: string[] }> } | null
  memory: { status: MemoryStatusSnapshot | null; items: Array<{ origin: string; kind: string; scope: string; content: string }> }
  trace: SimTraceSummary
}): string {
  const lines = ["# 组件演练", ""]
  for (const round of report.rounds) {
    lines.push(`## 第 ${round.round} 轮 · ${round.localDate}`)
    lines.push(`- 静默了解：${round.observation.status}${round.observation.reason ? `（${round.observation.reason}）` : ""}${round.observation.window ? ` · ${round.observation.window}` : ""}`)
    lines.push(`- dreaming：${round.dreaming.status}${round.dreaming.message ? ` · ${round.dreaming.message}` : ""}`)
    lines.push(`- 主动事件：${round.proactive.events.length ? round.proactive.events.map(event => event.kind).join("、") : "无"}`)
    if (round.task) lines.push(`- 定时任务：created=${round.task.created} delivered=${round.task.delivered}${round.task.error ? ` · ${round.task.error}` : ""}`)
    lines.push("")
  }
  if (report.understanding) {
    lines.push("## 了解层", `- 质量：${report.understanding.quality}（${report.understanding.coverage} 条 / ${report.understanding.independentSources} 个独立来源）`)
    for (const observation of report.understanding.observations) lines.push(`- ${observation.summary}`)
    lines.push("")
  }
  lines.push("## 记忆库", `- 条目：${report.memory.status?.itemCount ?? report.memory.items.length}`)
  for (const item of report.memory.items) lines.push(`- [${item.origin}] ${item.kind}/${item.scope}：${item.content}`)
  lines.push("", "## Trace", `- 事件：${Object.entries(report.trace.counts).map(([kind, count]) => `${kind}=${count}`).join("、")}`)
  lines.push(`- 用量：input=${report.trace.usage.inputTokens} output=${report.trace.usage.outputTokens} cacheRead=${report.trace.usage.cacheRead}`)
  lines.push(`- 记忆注入来源：${report.trace.memoryRenderedSourceIds.length} 个`)
  if (Object.keys(report.trace.proactiveSkipped).length) {
    lines.push(`- 主动跳过：${Object.entries(report.trace.proactiveSkipped).map(([reason, count]) => `${reason}=${count}`).join("、")}`)
  }
  return lines.join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
