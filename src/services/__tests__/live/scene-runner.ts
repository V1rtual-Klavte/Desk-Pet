import type {
  AssertContext,
  AssertionResult,
  ErrorKind,
  MemorySnapshot,
  SceneDef,
  SceneEntry,
  SceneResult,
  TurnResult,
} from "./types"
import type { PiAgentTurnOutput } from "@/services/engine/pi"
import { runPiAgentTurn } from "@/services/engine/pi"
import { abortAgentRuns, sendMessage, sendActiveMessage, toolCallHistory as productionToolHistory } from "@/services/agent/runner"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getSession } from "@/services/engine/session"
import { getActiveSessionId, getContextMessages } from "@/services/session/store"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { initSessions } from "@/services/session"
import { MemoryService } from "@/services/agent/memory"
import { formatError } from "@/services/error"
import { confirmRecords } from "./confirm-channel"
import { sessionMessages } from "./session-entries"

export const DEFAULT_SCENE_TIMEOUT = 120_000
/**
 * unit 场景的超时上限。它们不跑模型，正常都是毫秒级；
 * 留 10 秒是为了容下首次触碰磁盘（变量池持久化、Card 加载）的开销。
 */
export const UNIT_SCENE_TIMEOUT = 10_000

class SceneTimeoutError extends Error {
  constructor(timeout: number) {
    super(`场景超过 ${timeout}ms`)
    this.name = "SceneTimeoutError"
  }
}

/** 会话轮次直接来自会话条目（与 UI 同一读模型），不依赖任何进程内会话工作记忆。 */
async function takeMemorySnapshot(sessionId: string): Promise<MemorySnapshot> {
  const messages = sessionId ? await sessionMessages(sessionId).catch(() => []) : []
  const turns = messages
    .filter((message): message is typeof message & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant")
    .map(message => ({ role: message.role, text: message.text }))
  return {
    totalEntries: MemoryService.count,
    sessionTurnCount: turns.length,
    entriesByCategory: MemoryService.list().reduce((acc, entry) => {
      acc[entry.category] = (acc[entry.category] || 0) + 1
      return acc
    }, {} as Record<string, number>),
    sessionTurns: turns,
  }
}

function heapUsedBytes(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return memory?.usedJSHeapSize
}

function classifyError(error: unknown): ErrorKind {
  const message = (formatError(error)).toLowerCase()
  if (error instanceof SceneTimeoutError || /timeout|timed out|超时/.test(message)) return "timeout"
  if (/401|403|unauthorized|forbidden|api.?key|认证/.test(message)) return "auth"
  if (/429|rate.?limit|限流/.test(message)) return "rate_limit"
  if (/fetch|network|econn|enotfound|socket|网络/.test(message)) return "network"
  if (/config|provider|model|配置/.test(message)) return "configuration"
  if (/5\d\d|upstream|service unavailable/.test(message)) return "provider"
  return "unknown"
}

async function executeTurn(userText: string, entry: SceneEntry, isActiveMessage = false): Promise<PiAgentTurnOutput> {
  if (entry === "unit") {
    // 不进入模型：断言只依赖进程内状态（纯函数、注册表、变量池）。
    // 返回空输出，让 ctx.output 保持可读而不必特判 undefined。
    return { reply: "", toolCallHistory: [], retriesUsed: 0, effects: [] }
  }

  // Runtime tests use the same durable session creation as the desktop entry.
  if (!getActiveSessionId()) await initSessions()

  if (entry === "production") {
    // sendMessage clears this after preprocessing; clear here so handled requests cannot leak a prior turn.
    productionToolHistory.clear()
    const result = await sendMessage(userText)
    return {
      reply: result.reply,
      toolCallHistory: productionToolHistory.entries.map(item => ({ ...item })),
      retriesUsed: result.retriesUsed,
      effects: [result.personalityEffect],
      ...(result.failure ? { failure: result.failure } : {}),
    }
  }

  if (isActiveMessage) {
    const reply = await sendActiveMessage(userText)
    return { reply, toolCallHistory: [], retriesUsed: 0, effects: [] }
  }

  // Mirror the production message lifecycle around the lower-level Pi runtime.
  if (!isActiveMessage) pushUserMessage(userText)
  const sessionId = getActiveSessionId()
  const output = await runPiAgentTurn({
    sessionId,
    userText,
    chatMessages: getContextMessages(),
    unansweredCount: 0,
    messageCount: getContextMessages().length,
    isActiveMessage,
  })
  pushAssistantMessage(output.reply)
  return output
}

async function runSceneInner(scene: SceneDef, trial: number): Promise<SceneResult> {
  const start = Date.now()
  const turnResults: TurnResult[] = []
  const entry = scene.meta.entry ?? "runtime"

  if (scene.setup) {
    try {
      await scene.setup()
    } catch (error) {
      const message = formatError(error)
      return {
        caseId: scene.meta.caseId,
        scene: scene.meta.description,
        module: scene.meta.module,
        contractId: scene.meta.contractId,
        suite: scene.meta.suite,
        trial,
        entry,
        status: "fail",
        turns: [],
        duration: Date.now() - start,
        error: `setup failed: ${message}`,
        errorKind: "infrastructure",
      }
    }
  }

  for (const turn of scene.turns) {
    const turnStart = Date.now()

    try {
      const output = await executeTurn(turn.userText, entry, turn.isActiveMessage)
      const session = getSession(getActiveSessionId())
      const ctx: AssertContext = {
        output,
        pool: getPoolSnapshot(),
        session: {
          state: session.agentState,
          messageCount: session.messageCount,
          toolCallCount: session.toolCallCount,
        },
        memory: await takeMemorySnapshot(getActiveSessionId()),
        toolHistory: output.toolCallHistory.map(item => ({
          toolName: item.toolName,
          status: item.status,
        })),
        confirms: confirmRecords(),
        trial,
      }

      const assertions: AssertionResult[] = []
      for (const check of turn.checks) {
        try {
          await check.run(ctx)
          assertions.push({ type: check.type, pass: true })
        } catch (error) {
          assertions.push({
            type: check.type,
            pass: false,
            error: formatError(error),
          })
        }
      }

      const duration = Date.now() - turnStart
      turnResults.push({
        index: turn.index,
        description: turn.description,
        userText: turn.userText,
        assertions,
        duration,
        metrics: {
          duration,
          replyChars: output.reply.length,
          toolCalls: output.toolCallHistory.length,
          retries: output.retriesUsed,
          heapUsedBytes: heapUsedBytes(),
        },
        // 重试耗尽时 runtime 返回的是兜底文案，断言多半会跟着失败 ——
        // 但把它记成 assertion 会让报告彻底看不出 Provider 的真实故障分布。
        errorKind: output.failure
          ? output.failure.kind
          : assertions.every(assertion => assertion.pass) ? undefined : "assertion",
      })

      if (assertions.some(assertion => !assertion.pass)) break
    } catch (error) {
      const duration = Date.now() - turnStart
      const kind = classifyError(error)
      turnResults.push({
        index: turn.index,
        description: turn.description,
        userText: turn.userText,
        assertions: [{
          type: "system",
          pass: false,
          error: formatError(error),
        }],
        duration,
        metrics: { duration, replyChars: 0, toolCalls: 0, retries: 0, heapUsedBytes: heapUsedBytes() },
        errorKind: kind,
      })
      break
    }
  }

  const duration = Date.now() - start
  const allTurnsPassed = turnResults.length === scene.turns.length
    && turnResults.every(turn => !turn.errorKind && turn.assertions.every(assertion => assertion.pass))
  const firstErrorKind = turnResults.find(turn => turn.errorKind)?.errorKind

  return {
    caseId: scene.meta.caseId,
    scene: scene.meta.description,
    module: scene.meta.module,
    contractId: scene.meta.contractId,
    suite: scene.meta.suite,
    trial,
    entry,
    status: allTurnsPassed ? "pass" : "fail",
    turns: turnResults,
    duration,
    errorKind: firstErrorKind,
  }
}

export async function runScene(scene: SceneDef, trial = 1): Promise<SceneResult> {
  const entry = scene.meta.entry ?? "runtime"
  const timeout = scene.meta.timeout ?? (entry === "unit" ? UNIT_SCENE_TIMEOUT : DEFAULT_SCENE_TIMEOUT)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      runSceneInner(scene, trial),
      new Promise<SceneResult>((_, reject) => {
        timer = setTimeout(() => reject(new SceneTimeoutError(timeout)), timeout)
      }),
    ])
  } catch (error) {
    if (error instanceof SceneTimeoutError) await abortAgentRuns()
    return {
      caseId: scene.meta.caseId,
      scene: scene.meta.description,
      module: scene.meta.module,
      contractId: scene.meta.contractId,
      suite: scene.meta.suite,
      trial,
      entry: scene.meta.entry ?? "runtime",
      status: error instanceof SceneTimeoutError ? "timeout" : "fail",
      turns: [],
      duration: timeout,
      error: formatError(error),
      errorKind: classifyError(error),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 计划试验数：Σ 每个场景的 max(repeat, meta.repetitions)。报告用它和实际执行数对照。 */
export function plannedTrialCount(scenes: SceneDef[], repeat = 1): number {
  return scenes.reduce((sum, scene) => sum + Math.max(repeat, scene.meta.repetitions ?? 1), 0)
}

function skippedTrial(scene: SceneDef, trial: number, reason: string): SceneResult {
  return {
    caseId: scene.meta.caseId,
    scene: scene.meta.description,
    module: scene.meta.module,
    contractId: scene.meta.contractId,
    suite: scene.meta.suite,
    trial,
    entry: scene.meta.entry ?? "runtime",
    status: "skip",
    turns: [],
    duration: 0,
    error: reason,
  }
}

export interface RunAllScenesOptions {
  /**
   * 超时策略。
   * - `"continue"`（默认）：只终止超时的那条场景 —— 它的剩余 trial 记为 skip，
   *   后续场景照常执行。
   * - `"abort"`：维持旧行为，超时后立即结束整个 run。
   */
  onTimeout?: "continue" | "abort"
}

export async function runAllScenes(
  scenes: SceneDef[],
  repeat = 1,
  options: RunAllScenesOptions = {},
): Promise<SceneResult[]> {
  const onTimeout = options.onTimeout ?? "continue"
  const results: SceneResult[] = []
  for (const scene of scenes) {
    const trialCount = Math.max(repeat, scene.meta.repetitions ?? 1)
    for (let trial = 1; trial <= trialCount; trial++) {
      const result = await runScene(scene, trial)
      results.push(result)
      if (result.status !== "timeout") continue
      // Provider 请求无法取消，同场景的剩余 trial 不再重试；但它们是被计划过的，
      // 如实记为 skip，报告才能区分「计划执行」和「实际执行」。
      if (onTimeout === "abort") return results
      for (let skipped = trial + 1; skipped <= trialCount; skipped++) {
        results.push(skippedTrial(scene, skipped, `前序 trial #${trial} 超时，未执行`))
      }
      break
    }
  }
  return results
}
