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
import type { PiAgentTurnOutput } from "@/services/agent/pi"
import { runPiAgentTurn } from "@/services/agent/pi"
import { sendMessage, toolCallHistory as productionToolHistory } from "@/services/agent/runner"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getSession } from "@/services/engine/session"
import { getContextMessages } from "@/services/session/store"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { MemoryService } from "@/services/agent/memory"

const DEFAULT_SCENE_TIMEOUT = 120_000

class SceneTimeoutError extends Error {
  constructor(timeout: number) {
    super(`场景超过 ${timeout}ms`)
    this.name = "SceneTimeoutError"
  }
}

function takeMemorySnapshot(): MemorySnapshot {
  return {
    totalEntries: MemoryService.count,
    sessionTurnCount: MemoryService.sessionTurnCount,
    entriesByCategory: MemoryService.list().reduce((acc, entry) => {
      acc[entry.category] = (acc[entry.category] || 0) + 1
      return acc
    }, {} as Record<string, number>),
    sessionTurns: MemoryService.session?.turns.map(({ role, text }) => ({ role, text })) ?? [],
  }
}

function heapUsedBytes(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return memory?.usedJSHeapSize
}

function classifyError(error: unknown): ErrorKind {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (error instanceof SceneTimeoutError || /timeout|timed out|超时/.test(message)) return "timeout"
  if (/401|403|unauthorized|forbidden|api.?key|认证/.test(message)) return "auth"
  if (/429|rate.?limit|限流/.test(message)) return "rate_limit"
  if (/fetch|network|econn|enotfound|socket|网络/.test(message)) return "network"
  if (/config|provider|model|配置/.test(message)) return "configuration"
  if (/5\d\d|upstream|service unavailable/.test(message)) return "provider"
  return "unknown"
}

async function executeTurn(userText: string, entry: SceneEntry): Promise<PiAgentTurnOutput> {
  if (entry === "production") {
    // sendMessage clears this after preprocessing; clear here so handled requests cannot leak a prior turn.
    productionToolHistory.clear()
    const result = await sendMessage(userText)
    return {
      reply: result.reply,
      toolCallHistory: productionToolHistory.entries.map(item => ({ ...item })),
      retriesUsed: 0,
      effects: [result.personalityEffect],
    }
  }

  // Mirror the production message lifecycle around the lower-level Pi runtime.
  pushUserMessage(userText)
  const output = await runPiAgentTurn({
    userText,
    chatMessages: getContextMessages(),
    unansweredCount: 0,
    messageCount: getContextMessages().length,
    isActiveMessage: false,
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
      const message = error instanceof Error ? error.message : String(error)
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
      const output = await executeTurn(turn.userText, entry)
      const session = getSession()
      const ctx: AssertContext = {
        output,
        pool: getPoolSnapshot(),
        session: {
          state: session.agentState,
          messageCount: session.messageCount,
          toolCallCount: session.toolCallCount,
        },
        memory: takeMemorySnapshot(),
        toolHistory: output.toolCallHistory.map(item => ({
          toolName: item.toolName,
          status: item.status,
        })),
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
            error: error instanceof Error ? error.message : String(error),
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
        errorKind: assertions.every(assertion => assertion.pass) ? undefined : "assertion",
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
          error: error instanceof Error ? error.message : String(error),
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
    && turnResults.every(turn => turn.assertions.every(assertion => assertion.pass))
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
  const timeout = scene.meta.timeout ?? DEFAULT_SCENE_TIMEOUT
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      runSceneInner(scene, trial),
      new Promise<SceneResult>((_, reject) => {
        timer = setTimeout(() => reject(new SceneTimeoutError(timeout)), timeout)
      }),
    ])
  } catch (error) {
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
      error: error instanceof Error ? error.message : String(error),
      errorKind: classifyError(error),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runAllScenes(scenes: SceneDef[], repeat = 1): Promise<SceneResult[]> {
  const results: SceneResult[] = []
  for (const scene of scenes) {
    const trialCount = Math.max(repeat, scene.meta.repetitions ?? 1)
    for (let trial = 1; trial <= trialCount; trial++) {
      const result = await runScene(scene, trial)
      results.push(result)
      // The Provider API cannot cancel an in-flight request, so stop the run after a timeout.
      if (result.status === "timeout") return results
    }
  }
  return results
}
