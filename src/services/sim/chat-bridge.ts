/**
 * 开发期聊天控制通道：让 Claude 通过数据根下的文件直接和桌宠聊天。
 *
 * - 不调用用户模拟器模型：`inbox.jsonl` 里的正文由调用方（Claude）写，桌宠仍走真实
 *   `sendMessage` / 记忆召回 / 工具禁用后的普通聊天链。
 * - 只轮询数据根，不监听网络端口；仅 development 模式可启动。
 * - 每条命令的回复写到 `outbox.jsonl`，调用方读回复后再写下一句，形成自然对话。
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { getHostBridge } from "@/services/host"
import { sendMessage } from "@/services/agent/runner"
import { getActiveCard } from "@/services/personality"
import { getActiveSessionId, getSessions, readPiSessionEntriesOnce } from "@/services/session"
import { describeInputDelivery, readRequestResponse } from "@/services/engine/harness"
import type { InputDeliveryLookup, RequestResponseEvidence } from "@/services/engine/harness"
import { laneMessageText } from "@/services/engine/runtime"
import { choiceState, resolveChoice } from "@/services/engine/choice-confirmation"
import { planConfirmState, resolvePlanConfirm, resolvePlanStepDecision } from "@/services/engine/plan-confirmation"
import { confirmState, resolvePermissionConfirm } from "@/services/safety"
import { debug, usageGrandTotal } from "@/services/debug"
import { getRuntimeMode, runtimePath } from "@/services/paths"
import { getLatestWindowObservation, getRecentWindowObservations } from "@/services/window"
import { dispatchHostRequest } from "@/services/native-ui/host-requests"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { runObservationBatchNow, getUnderstandingSnapshotAsync } from "@/services/observation"
import { queryUserTasks } from "@/services/user-tasks"
import { query as proactiveQuery } from "@/services/proactive"
import type { UnderstandingSnapshot } from "@/services/observation"
import {
  runDreamingSweep, memoryJobList, memoryList, memoryStatus, pendingMemorySourceCount,
} from "@/services/agent/memory"
import type { MemoryItem, MemoryStatusSnapshot } from "@/services/agent/memory"
import { tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"
import { activeOwner, pickRecentWindow, seedAndDeliverTask } from "./loop"
import { isManualTriggerHostMethod, runManualTrigger } from "./manual-trigger"
import type { ManualTriggerDeps } from "./manual-trigger"
import { createSimTraceRecorder } from "./trace-recorder"
import type { SimCaptureTrialSpec, SimTraceSummary } from "./trace-recorder"
import { createSimCaptureManager, summarizeCaptureResult } from "./capture"
import type { SimCaptureManager } from "./capture"
import { writeSimFiles } from "./report"
import { getSimEvalRunContext } from "./run-context"
import { getDirectSeedReport } from "./direct-seed"
import { getSimClockSnapshot, setSimClockBase } from "./clock"
import { assertMessageOperation } from "./message-operation"
import type { MessageOperation } from "./message-operation"

const log = createLogger("SimChat")
const POLL_MS = 500
const REPLY_WAIT_MS = 120_000

export interface SimChatMessage {
  role: "user" | "assistant"
  text: string
}

type SimChatCommand =
  | { id?: string; type: "message"; text: string; tools?: "auto" | "none"; imagePaths?: string[]; operation?: unknown }
  /** 直接走原生 UI 的请求分派面：chat / settings / memory / card / profile / mcp / skill / sound 等。 */
  | { id?: string; type: "host"; method: string; args?: unknown }
  | { id?: string; type: "plan"; mode: "auto" | "stepByStep" | "off" }
  /** 回答 ask_user 弹窗；action 省略时只列出待答项。 */
  | { id?: string; type: "choice"; action?: "pick" | "other" | "cancel"; index?: number }
  /** 回答权限确认弹窗；decision 省略时只列出待确认项。 */
  | { id?: string; type: "confirm"; decision?: "allow_once" | "allow_session" | "deny" }
  /** 当前上下文与用量快照（debug 读模型，不触发模型调用）。 */
  | { id?: string; type: "context" }
  /** 推进固定时钟基准（评测驱动按用例步骤调用）；reason 只用于证据。 */
  | { id?: string; type: "clock"; at: string; reason?: string }
  /** 记忆抽取水位（驱动检查点用：待抽取来源 + 活动作业；不触发模型调用）。 */
  | { id?: string; type: "memory_state" }
  /** 最近窗口观察（诊断用，不触发模型调用）。 */
  | { id?: string; type: "window" }
  /** 会话列表（多会话测试用）。 */
  | { id?: string; type: "sessions" }
  /** 用户任务/提醒（schedule_query）。 */
  | { id?: string; type: "tasks" }
  /** 主动陪伴的任务与尝试记录（proactive_query）。 */
  | { id?: string; type: "proactive_state" }
  /** 静默了解快照。 */
  | { id?: string; type: "understanding" }
  /** screenshot=true 时走当前窗口并真实截图；force=true 时绕过档位开关与当天次数（手动触发）。 */
  | { id?: string; type: "observe"; screenshot?: boolean; force?: boolean }
  | { id?: string; type: "dream" }
  | { id?: string; type: "proactive" }
  | { id?: string; type: "task"; kind?: "reminder" | "agent_job"; text?: string
      work?: { goal: string; inputs: string[]; capabilities: string[]; output: string; completion: string } }
  | { id?: string; type: "report" }
  | { id?: string; type: "capture_start"; attemptDir: string; evaluationRunId: string; expectedTrials: SimCaptureTrialSpec[] }
  | { id?: string; type: "capture_begin"; caseId: string; trialId: string }
  | { id?: string; type: "capture_end"; caseId: string; trialId: string; status?: "completed" | "failed"; error?: string }
  | { id?: string; type: "capture_sessions" }
  | { id?: string; type: "capture_finish"; status?: "completed" | "failed" | "interrupted"; reason?: string }
  | { id?: string; type: "capture_status" }
  | { id?: string; type: "stop" }

export interface SimChatBridge {
  dir: string
  inbox: string
  outbox: string
  stop: () => Promise<void>
}

let active: SimChatBridge | undefined

export function isSimChatBridgeRunning(): boolean {
  return active !== undefined
}

/** 宿主退出序列：未封口的采集按中断收口，trace 封口后才放行进程退出。 */
export async function stopSimChatBridge(): Promise<void> {
  const bridge = active
  if (!bridge) return
  active = undefined
  await bridge.stop()
}

export async function startSimChatBridge(): Promise<SimChatBridge> {
  if (getRuntimeMode() !== "development") throw new Error("聊天控制通道仅在开发模式可用")
  if (active) return active
  // 评测运行只认宿主 ready.json 的隔离控制目录；未完成 direct-seed 就不报告 ready。
  const evalContext = await getSimEvalRunContext()
  const seed = evalContext ? getDirectSeedReport() : null
  if (evalContext && !seed) throw new Error("sim-eval 聊天通道启动前 direct-seed 未完成")
  const dir = evalContext?.controlDir ?? await runtimePath("data", "logs", "sim", "control")
  await mkdir(dir, { recursive: true })
  const inbox = join(dir, "inbox.jsonl")
  const outbox = join(dir, "outbox.jsonl")
  await writeFile(inbox, "", { flag: "a" })
  await writeFile(outbox, "", { flag: "a" })
  const recorder = createSimTraceRecorder({ collectEvents: !evalContext })
  const capture: SimCaptureManager | null = evalContext ? createSimCaptureManager(recorder) : null
  const transcript: SimChatMessage[] = []
  const startedAt = Date.now()
  let offset = (await stat(inbox)).size
  let pending = ""
  const decoder = new StringDecoder("utf8")
  let chain = Promise.resolve()
  // 消息回合串行；控制命令（choice/confirm/plan/host/stop/report 等）不排在回合后面，
  // 否则一个等待弹窗的回合会把回答弹窗的命令本身堵死。
  let turnChain = Promise.resolve()
  let stopped = false
  let autoPlanMode: "auto" | "stepByStep" | undefined
  const seenOperations = new Set<string>()
  const manualTriggerDeps: ManualTriggerDeps = {
    now: Date.now,
    tick,
    readEvents: () => recorder.events,
    deliverTask: input => seedAndDeliverTask(activeOwner(), input),
  }
  // 只绑定会话，不把没有会话身份的后台事件借用当前 trial；手工触发的 proactive 事件
  // 才能凭 sessionId 归到正在采集的试次。
  const bindActiveSession = (): void => {
    if (!capture) return
    const sessionId = getActiveSessionId()
    if (sessionId) recorder.bindSession(sessionId)
  }

  const emit = async (event: Record<string, unknown>): Promise<void> => {
    await appendFile(outbox, `${JSON.stringify(redactSecrets({ at: Date.now(), ...event }))}\n`)
  }

  const writeReport = async (): Promise<{ reportPath: string; markdownPath: string; tracePath: string }> => {
    const [understanding, items, status] = await Promise.all([
      getUnderstandingSnapshotAsync(Date.now()).catch(() => undefined as UnderstandingSnapshot | undefined),
      memoryList(undefined, undefined, 200).catch(() => [] as MemoryItem[]),
      memoryStatus().catch(() => undefined as MemoryStatusSnapshot | undefined),
    ])
    const summary = recorder.summary()
    const sessionId = getActiveSessionId()
    const entries = sessionId ? await readPiSessionEntriesOnce(sessionId).catch(() => []) : []
    const sessionTranscript: Array<{ role: "user" | "assistant"; text: string; timestamp: number; entryId: string }> = []
    for (const entry of entries) {
      if (entry.type !== "message") continue
      const role = entry.message.role
      if (role !== "user" && role !== "assistant") continue
      const text = laneMessageText(entry.message).trim()
      if (!text || entry.timestamp < startedAt) continue
      sessionTranscript.push({ role, text, timestamp: entry.timestamp, entryId: entry.id })
    }
    const report = {
      schemaVersion: 1 as const,
      startedAt,
      finishedAt: Date.now(),
      transcript,
      sessionTranscript: sessionTranscript.slice(-80),
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
      trace: summary,
    }
    return writeSimFiles({
      prefix: "chat",
      report,
      markdown: renderChatMarkdown(report),
      events: recorder.events,
    })
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearInterval(planTimer)
    if (capture) {
      // 评测运行不写开发演练报告：正式证据只认 attempt 目录。采集未封口就按中断收口，
      // 让证据显式不完整，而不是让 recorder.stop() 抛错后留下「看似正常退出」。
      try {
        if (capture.status() && !capture.status()?.finished) {
          const result = await capture.finish({ status: "interrupted", reason: "宿主停止时采集仍未封口" })
          await emit({ type: "capture_finished", reason: "host_stop", result: summarizeCaptureResult(result) })
        }
      } catch (error) {
        log.warn("评测采集收尾失败:", formatError(error))
        await emit({ type: "error", error: formatError(error) }).catch(() => undefined)
      }
      try { recorder.stop() } catch (error) { log.warn("trace recorder 停止失败:", formatError(error)) }
    } else {
      try {
        const files = await writeReport()
        await emit({ type: "report", ...files })
      } catch (error) {
        log.warn("聊天控制通道收尾报告失败:", formatError(error))
        await emit({ type: "error", error: formatError(error) }).catch(() => undefined)
      }
      recorder.stop()
    }
    active = undefined
    await emit({ type: "stopped" })
  }

  const handle = async (line: string): Promise<void> => {
    let command: SimChatCommand
    try { command = JSON.parse(line) as SimChatCommand }
    catch {
      await emit({ type: "error", error: "命令不是合法 JSON", line: line.slice(0, 200) })
      return
    }
    const id = command.id ?? crypto.randomUUID()
    try {
      switch (command.type) {
        case "message": {
          const text = command.text.trim()
          if (!text) { await emit({ id, type: "error", error: "消息正文为空" }); return }
          const sessionId = getActiveSessionId()
          if (!sessionId) { await emit({ id, type: "error", error: "当前没有活跃会话" }); return }
          if (capture) recorder.bindSession(sessionId)
          let operation: MessageOperation | undefined
          if (capture) {
            // 评测消息必须带驱动步骤身份：trial 已开始、会话与代际一致，且同一身份不重放。
            operation = assertMessageOperation(command.operation, {
              generation: evalContext!.generation,
              sessionId,
              trials: capture.status()?.trace?.trials ?? [],
            })
            if (seenOperations.has(operation.operationId)) {
              await emit({ id, type: "error", error: `操作身份重复：${operation.operationId}` })
              return
            }
            seenOperations.add(operation.operationId)
          } else if (command.operation !== undefined) {
            await emit({ id, type: "error", error: "非评测运行不接受消息操作身份" })
            return
          }
          const requestId = operation?.operationId ?? crypto.randomUUID()
          // 直接走真实入口：忙碌时由 sendMessage 自己取消主动运行或按配置投递，
          // 不在这里预先等空闲（等待会挡住用户输入打断主动表达的产品语义）。
          const result = await sendMessage(text, {
            requestId,
            ...(command.tools === "none" ? { toolMode: "none" as const } : {}),
            ...(command.imagePaths?.length ? { imagePaths: command.imagePaths } : {}),
          })
          let reply = result.reply.trim()
          let replyBinding: "direct" | "request-response" = "direct"
          let assistantEntryId: string | undefined
          if (!reply && result.outcome === "queued") {
            // 投递回执只证明入队；回复必须按 requestId 找到同一条请求的 run 分支。
            const evidence = await waitForRequestResponse(sessionId, requestId)
            if (evidence) {
              reply = evidence.text
              assistantEntryId = evidence.assistantEntryId
              replyBinding = "request-response"
            }
          }
          let delivery: InputDeliveryLookup
          try {
            delivery = await describeInputDelivery(sessionId, requestId)
          } catch (error) {
            delivery = { ok: false, error: formatError(error) }
          }
          transcript.push({ role: "user", text })
          if (reply) transcript.push({ role: "assistant", text: reply })
          await emit({
            id, type: "message", sessionId, requestId, reply, outcome: result.outcome, toolCalls: result.toolCalls,
            ...(operation ? { operation } : {}),
            ...(assistantEntryId ? { assistantEntryId } : {}),
            replyBinding,
            delivery,
            ...(result.failure ? { failure: result.failure } : {}),
            ...(reply ? {} : { note: result.outcome === "failed" ? "回合未进入 Provider，详见 failure" : "回复未在控制通道内取得，请查看会话正文" }),
          })
          return
        }
        case "host": {
          const manual = isManualTriggerHostMethod(command.method)
          if (manual) bindActiveSession()
          const result = manual
            ? await runManualTrigger(command.method, command.args ?? {}, manualTriggerDeps)
            : await dispatchHostRequest(command.method, command.args ?? {})
          bindActiveSession()
          await emit({ id, type: "host", method: command.method, result })
          return
        }
        case "plan": {
          autoPlanMode = command.mode === "off" ? undefined : command.mode
          await emit({ id, type: "plan", mode: command.mode })
          return
        }
        case "choice": {
          const pending = choiceState.pending[0]
          if (!command.action) {
            await emit({ id, type: "choice", pending: choiceState.pending.map(item => ({
              requestId: item.requestId, options: item.options,
            })) })
            return
          }
          if (!pending) throw new Error("当前没有待答提问")
          if (command.action === "cancel") {
            resolveChoice(pending.requestId, { kind: "cancelled" })
          } else if (command.action === "other") {
            resolveChoice(pending.requestId, { kind: "other" })
          } else {
            const index = command.index ?? 0
            if (!Number.isInteger(index) || index < 0 || index >= pending.options.length) {
              throw new Error(`选项下标超出范围：${index}`)
            }
            resolveChoice(pending.requestId, { kind: "picked", index })
          }
          await emit({ id, type: "choice", requestId: pending.requestId, action: command.action, options: pending.options })
          return
        }
        case "confirm": {
          const pending = confirmState.pending
          if (!command.decision) {
            await emit({ id, type: "confirm", pending: pending
              ? { requestId: pending.id, toolName: pending.toolName, effectClass: pending.effectClass }
              : null })
            return
          }
          if (!pending) throw new Error("当前没有待确认请求")
          resolvePermissionConfirm(command.decision)
          await emit({ id, type: "confirm", requestId: pending.id, decision: command.decision, toolName: pending.toolName })
          return
        }
        case "context": {
          await emit({ id, type: "context", context: {
            lastPromptTokens: debug.lastPromptTokens,
            lastCompletionTokens: debug.lastCompletionTokens,
            lastSystemTokens: debug.lastSystemTokens,
            lastToolCount: debug.lastToolCount,
            lastContextUsage: debug.lastContextUsage,
            contextMaxTokens: debug.contextMaxTokens,
            usage: debug.usage,
            usageTotal: usageGrandTotal(),
          } })
          return
        }
        case "clock": {
          const clock = setSimClockBase(command.at, command.reason ?? "driver")
          await emit({ id, type: "clock", clock })
          return
        }
        case "memory_state": {
          // 只读水位：activeJobs 表示抽取未结束；jobs 保留最近作业（含已结束），
          // 驱动在消息副作用前抓基线，只有基线之外的新作业才证明本轮抽取真的发生过。
          const [status, pendingSources, jobs] = await Promise.all([
            memoryStatus(),
            pendingMemorySourceCount(),
            memoryJobList(100),
          ])
          const recentJobs = jobs.map(job => ({
            id: job.id, phase: job.phase, status: job.status, updatedAt: job.updatedAt,
          }))
          const activeJobs = recentJobs
            .filter(job => job.status === "queued" || job.status === "running" || job.status === "paused")
          await emit({ id, type: "memory_state", result: {
            revision: status.revision,
            itemCount: status.itemCount,
            candidateCount: status.candidateCount,
            pendingSources,
            activeJobs,
            jobs: recentJobs,
          } })
          return
        }
        case "window": {
          const view = (item: NonNullable<ReturnType<typeof getLatestWindowObservation>>) => ({
            app: item.app, title: item.title, state: item.observationState,
            isPetForeground: item.isPetForeground, observedAt: item.observedAt,
            monitorGeneration: item.monitorGeneration, sequence: item.sequence,
          })
          const latest = getLatestWindowObservation()
          await emit({ id, type: "window", latest: latest ? view(latest) : null,
            recent: getRecentWindowObservations().map(view) })
          return
        }
        case "sessions": {
          const active = getActiveSessionId()
          await emit({ id, type: "sessions", active, sessions: getSessions().map(item => ({
            id: item.id, name: item.name, createdAt: item.createdAt,
          })) })
          return
        }
        case "tasks": {
          const result = await queryUserTasks({ owner: activeOwner(), limit: 50, includeResults: true })
          await emit({ id, type: "tasks", result })
          return
        }
        case "proactive_state": {
          const result = await proactiveQuery({ owner: activeOwner(), limit: 20 })
          await emit({ id, type: "proactive_state", result })
          return
        }
        case "understanding": {
          const snapshot = await getUnderstandingSnapshotAsync(Date.now())
          await emit({ id, type: "understanding", snapshot })
          return
        }
        case "observe": {
          const now = Date.now()
          const windowObservation = command.screenshot ? undefined : pickRecentWindow()
          const result = await runObservationBatchNow({
            now,
            localDate: localDayKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone),
            ...(windowObservation ? { windowObservation } : {}),
            ...(command.screenshot ? { forceCurrentWindow: true } : {}),
            ...(command.force ? { force: true } : {}),
          })
          await emit({ id, type: "observe", result, window: windowObservation ? `${windowObservation.app ?? "?"} — ${windowObservation.title ?? "?"}` : "current" })
          return
        }
        case "dream": {
          const result = await runDreamingSweep()
          await emit({ id, type: "dream", result })
          return
        }
        case "proactive": {
          const result = await runManualTrigger("sim_proactive_tick", {}, manualTriggerDeps)
          await emit({ id, type: "proactive", events: result.events })
          return
        }
        case "task": {
          const result = await runManualTrigger("sim_task_deliver", {
            ...(command.kind ? { kind: command.kind } : {}),
            ...(command.text ? { text: command.text } : {}),
            ...(command.work ? { work: command.work } : {}),
          }, manualTriggerDeps)
          await emit({ id, type: "task", result: result.task })
          return
        }
        case "report": {
          if (capture) {
            await emit({ id, type: "report", capture: capture.status() })
            return
          }
          const files = await writeReport()
          await emit({ id, type: "report", ...files })
          return
        }
        case "capture_start": {
          if (!capture) throw new Error("当前不是 sim-eval 隔离运行，不能开始正式采集")
          const result = await capture.start({
            attemptDir: command.attemptDir,
            evaluationRunId: command.evaluationRunId,
            expectedTrials: command.expectedTrials,
          })
          await emit({ id, type: "capture_started", result })
          return
        }
        case "capture_begin": {
          if (!capture) throw new Error("当前不是 sim-eval 隔离运行，不能开始试次")
          await capture.beginTrial(command.caseId, command.trialId)
          bindActiveSession()
          await emit({ id, type: "capture_trial", phase: "begin", caseId: command.caseId, trialId: command.trialId })
          return
        }
        case "capture_end": {
          if (!capture) throw new Error("当前不是 sim-eval 隔离运行，不能结束试次")
          await capture.endTrial(command.caseId, command.trialId, {
            ...(command.status ? { status: command.status } : {}),
            ...(command.error ? { error: command.error } : {}),
          })
          await emit({
            id, type: "capture_trial", phase: "end",
            caseId: command.caseId, trialId: command.trialId, status: command.status ?? "completed",
            ...(command.error ? { error: command.error } : {}),
          })
          return
        }
        case "capture_sessions": {
          if (!capture) throw new Error("当前不是 sim-eval 隔离运行，不能读取采集范围")
          await emit({ id, type: "capture_sessions", result: await capture.sessions() })
          return
        }
        case "capture_finish": {
          if (!capture) throw new Error("当前不是 sim-eval 隔离运行，不能封口采集")
          const result = await capture.finish({
            ...(command.status ? { status: command.status } : {}),
            ...(command.reason ? { reason: command.reason } : {}),
          })
          await emit({ id, type: "capture_finished", result })
          return
        }
        case "capture_status": {
          await emit({ id, type: "capture_status", capture: capture?.status() ?? null })
          return
        }
        case "stop": {
          await emit({ id, type: "stopping" })
          await stop()
          return
        }
        default:
          await emit({ id, type: "error", error: `未知命令类型：${String((command as { type?: unknown }).type)}` })
      }
    } catch (error) {
      log.warn("聊天控制命令失败:", formatError(error))
      await emit({ id, type: "error", error: formatError(error) }).catch(() => undefined)
    }
  }

  const poll = async (): Promise<void> => {
    if (stopped) return
    let size: number
    try { size = (await stat(inbox)).size }
    catch { return }
    if (size <= offset) return
    const buffer = await readFile(inbox)
    const chunk = decoder.write(buffer.subarray(offset))
    offset = buffer.length
    const text = pending + chunk
    const lines = text.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: { type?: unknown } | null = null
      try { parsed = JSON.parse(line) as { type?: unknown } } catch { parsed = null }
      if (parsed?.type === "message") {
        turnChain = turnChain
          .then(() => handle(line))
          .catch(error => log.warn("聊天控制消息处理失败:", formatError(error)))
      } else {
        void handle(line)
      }
      if (stopped) return
    }
  }

  const timer = setInterval(() => {
    chain = chain.then(poll).catch(error => log.warn("聊天控制通道轮询失败:", formatError(error)))
  }, POLL_MS)
  timer.unref?.()
  // 演练里的“用户点确认”：没有原生计划面板，按显式 plan 模式替用户拍板。
  const planTimer = setInterval(() => {
    if (!autoPlanMode) return
    const pending = planConfirmState.pending
    if (pending) resolvePlanConfirm(pending.planId, { confirmed: true, mode: autoPlanMode })
    const gate = planConfirmState.stepGate
    if (gate) resolvePlanStepDecision(gate.planId, "continue")
  }, 300)
  planTimer.unref?.()

  const bridge: SimChatBridge = { dir, inbox, outbox, stop }
  active = bridge
  await emit({
    type: "ready", dir, inbox, outbox,
    sessionId: getActiveSessionId(),
    cardId: getActiveCard()?.id ?? null,
    // 评测运行额外带所有权与装载摘要：执行器据此确认「同一个宿主 + 同一个运行根 + 已装载」。
    ...(evalContext && seed ? {
      generation: evalContext.generation,
      hostPid: evalContext.hostPid,
      runDir: evalContext.runDir,
      clock: getSimClockSnapshot(),
      seed: {
        fixtureId: seed.fixtureId,
        fixtureHash: seed.fixtureHash,
        sessionId: seed.sessionId,
        messageCount: seed.messageCount,
        memoryItemIds: seed.memoryItemIds,
        status: seed.status,
      },
    } : {}),
  })
  log.info("聊天控制通道已启动:", dir)
  return bridge
}

/** 忙碌投递时 `sendMessage` 只返回投递回执；按 requestId 等同一请求的落盘回复。 */
async function waitForRequestResponse(
  sessionId: string,
  requestId: string,
): Promise<RequestResponseEvidence | undefined> {
  const deadline = Date.now() + REPLY_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const evidence = await readRequestResponse(sessionId, requestId)
    if (evidence) return evidence
  }
  return undefined
}

function renderChatMarkdown(report: {
  transcript: SimChatMessage[]
  sessionTranscript?: Array<{ role: "user" | "assistant"; text: string }>
  understanding: { quality: string; coverage: number; independentSources: number; observations: Array<{ kind: string; summary: string; targets?: string[] }> } | null
  memory: { status: MemoryStatusSnapshot | null; items: Array<{ origin: string; kind: string; scope: string; content: string }> }
  trace: SimTraceSummary
}): string {
  const lines = ["# 与桌宠的对话演练", "", "## 聊天", ""]
  const messages = report.sessionTranscript?.length ? report.sessionTranscript : report.transcript
  for (const message of messages) lines.push(`- **${message.role === "user" ? "我" : "桌宠"}**：${message.text}`)
  if (report.understanding) {
    lines.push("", "## 了解层", `- 质量：${report.understanding.quality}（${report.understanding.coverage} 条 / ${report.understanding.independentSources} 个独立来源）`)
    for (const observation of report.understanding.observations) lines.push(`- ${observation.summary}${observation.targets?.length ? `（${observation.targets.join("、")}）` : ""}`)
  }
  lines.push("", "## 记忆库", `- 条目：${report.memory.status?.itemCount ?? report.memory.items.length}`)
  for (const item of report.memory.items) lines.push(`- [${item.origin}] ${item.kind}/${item.scope}：${item.content}`)
  lines.push("", "## Trace", `- 事件：${Object.entries(report.trace.counts).map(([kind, count]) => `${kind}=${count}`).join("、")}`)
  lines.push(`- 用量：input=${report.trace.usage.inputTokens} output=${report.trace.usage.outputTokens} cacheRead=${report.trace.usage.cacheRead}`)
  lines.push(`- 记忆注入来源：${report.trace.memoryRenderedSourceIds.length} 个`)
  if (Object.keys(report.trace.proactiveSkipped).length) {
    lines.push(`- 主动跳过：${Object.entries(report.trace.proactiveSkipped).map(([reason, count]) => `${reason}=${count}`).join("、")}`)
  }
  return lines.join("\n")
}

const SECRET_KEYS = /^(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|secret|password|credential|authorization)$/i

/** 控制通道可能转发 settings_read 等完整设置快照；凭据值绝不落 outbox。 */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactSecrets(item)
  }
  return output
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
