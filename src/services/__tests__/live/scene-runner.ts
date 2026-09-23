import type {
  AssertContext,
  AssertionResult,
  ErrorKind,
  ExpectedTurnFailure,
  MemorySnapshot,
  SceneDef,
  SceneEntry,
  SceneResult,
  TurnDef,
  TurnResult,
} from "./types"
import type { PiAgentTurnOutput, TurnFailure } from "@/services/engine/pi"
import { runPiAgentTurn } from "@/services/engine/pi"
import { userInputMessage } from "@/services/engine/runtime"
import { abortAgentRuns, sendMessage, sendActiveMessage } from "@/services/agent/runner"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { harnessSlots } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session/store"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { initSessions } from "@/services/session"
import { MemoryService } from "@/services/agent/memory"
import { formatError } from "@/services/error"
import { confirmRecords } from "./confirm-channel"
import { planRecords } from "./plan-confirm-channel"
import { sessionMessages } from "./session-entries"

export const DEFAULT_SCENE_TIMEOUT = 120_000
/**
 * unit 场景的超时上限。它们不跑模型，正常都是毫秒级；
 * 留 10 秒是为了容下首次触碰磁盘（变量池持久化、Card 加载）的开销。
 */
export const UNIT_SCENE_TIMEOUT = 10_000
/**
 * 超时后等待被放弃的执行收尾的宽限时间。
 *
 * JS 不能强杀任意 await：被放弃的 setup / assertion 只能自己结束。
 * 下一个场景的隔离（standardSetup 重置全局状态、清会话）必须在残留写入落地之后才安全，
 * 所以超时路径先置取消位、再等这一小段时间，避免未结束的异步步骤渗进下一个 trial。
 */
export const SCENE_CANCEL_GRACE_MS = 5_000

class SceneTimeoutError extends Error {
  constructor(timeout: number) {
    super(`场景超过 ${timeout}ms`)
    this.name = "SceneTimeoutError"
  }
}

/**
 * 场景级取消信号。当前只有超时一个触发点：runScene 置位后，
 * runSceneInner 在每个步骤边界检查，不再推进后续 setup 与断言。
 */
class SceneCancelToken {
  private cancelled = false

  isCancelled(): boolean {
    return this.cancelled
  }

  cancel(): void {
    this.cancelled = true
  }
}

/**
 * 超时现场。超时后 runSceneInner 的返回值随 race 一起被丢弃，
 * 报告只能从这里取：已完成的回合、在飞回合已完成的断言、以及卡住的阶段。
 */
class SceneProgress {
  phase: "setup" | "turn" = "setup"
  turn: TurnDef | undefined
  turnStart = 0
  /** 当前在飞断言的类型；只在 await 断言期间有值。 */
  check: string | undefined
  /** 已完成的回合，按顺序累积。 */
  completed: TurnResult[] = []
  /** 在飞回合已完成的断言；回合结束时它的副本已进入 completed。 */
  assertions: AssertionResult[] = []
}

/** 卡住的位置，写进超时 error 供报告定位。 */
function stuckPhase(progress: SceneProgress): string {
  if (progress.phase === "setup") return "卡在 setup"
  if (!progress.turn) return "卡在回合之间"
  return progress.check
    ? `第 ${progress.turn.index} 轮断言 ${progress.check} 执行中`
    : `第 ${progress.turn.index} 轮执行中`
}

/**
 * 超时时报出的轮次：已完成的原样保留；在飞回合补一条 timeout 断言，
 * 既保留它已经跑完的断言，也不让未完成的步骤被读成通过。
 */
function timeoutTurns(progress: SceneProgress): TurnResult[] {
  const pending = progress.turn
  if (progress.phase !== "turn" || !pending) return [...progress.completed]
  const duration = Date.now() - progress.turnStart
  return [
    ...progress.completed,
    {
      index: pending.index,
      description: pending.description,
      userText: pending.userText,
      assertions: [
        ...progress.assertions,
        {
          type: "timeout",
          pass: false,
          error: progress.check ? `场景超时，断言 ${progress.check} 未完成` : "场景超时，本轮次未完成",
        },
      ],
      duration,
      metrics: { duration, replyChars: 0, toolCalls: 0, retries: 0, heapUsedBytes: heapUsedBytes() },
      errorKind: "timeout",
    },
  ]
}

/** 在限定时间内等被放弃的执行落地；超时返回 false，不阻塞下一场景。 */
async function settleWithin(work: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (!work) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      // 被放弃的执行可能以成功或失败结束，两种都算收尾；失败不能变成未捕获异常。
      work.then(() => true, () => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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

/**
 * 状态码档位按独立数字匹配（与 `classifyTurnFailure` 同一口径）：
 * 文案里的估算 token 数等长数字串不能把无关失败误分类成认证、限流或 Provider 故障。
 */
function classifyError(error: unknown): ErrorKind {
  const message = (formatError(error)).toLowerCase()
  if (error instanceof SceneTimeoutError || /timeout|timed out|超时/.test(message)) return "timeout"
  if (/\b401\b|\b403\b|unauthorized|forbidden|api.?key|认证/.test(message)) return "auth"
  if (/\b429\b|rate.?limit|限流/.test(message)) return "rate_limit"
  if (/fetch|network|econn|enotfound|socket|网络/.test(message)) return "network"
  if (/config|provider|model|配置/.test(message)) return "configuration"
  if (/\b5\d\d\b|upstream|service unavailable/.test(message)) return "provider"
  return "unknown"
}

/**
 * 预期失败的判定：声明的分类与文案都命中才算通过，并把命中的真实失败交回给回合结果。
 *
 * 这里是「预期失败」与「被吞掉的错误」的分界：回合正常完成、以别的分类失败、
 * 或失败文案不匹配，都产生一条失败断言 —— 回合照旧判失败，场景照旧不进通过统计。
 */
function judgeExpectedFailure(
  expected: ExpectedTurnFailure,
  output: PiAgentTurnOutput,
): { assertion: AssertionResult; matched?: TurnFailure } {
  const kinds = typeof expected.kind === "string" ? [expected.kind] : expected.kind
  const declaration = `${kinds.join("/")} + ${String(expected.message)}`
  const failure = output.failure
  if (!failure) {
    return { assertion: {
      type: "expectTurnFailure",
      pass: false,
      error: `期望回合以 ${kinds.join("/")} 失败，但回合正常完成`,
      expected: declaration,
      actual: "回合正常完成",
    } }
  }
  // 分类只能圈到粗桶（从文案派生），失败路径本身由文案钉住，两者都要命中。
  const messageHit = typeof expected.message === "string"
    ? failure.message.includes(expected.message)
    : expected.message.test(failure.message)
  const matched = kinds.includes(failure.kind) && messageHit
  const actual = `${failure.kind}: ${failure.message}`
  return {
    assertion: matched
      ? { type: "expectTurnFailure", pass: true, expected: declaration, actual }
      : {
        type: "expectTurnFailure",
        pass: false,
        error: `回合失败与声明的预期不符，期望 ${declaration}`,
        expected: declaration,
        actual,
      },
    ...(matched ? { matched: failure } : {}),
  }
}

async function executeTurn(userText: string, entry: SceneEntry, isActiveMessage = false): Promise<PiAgentTurnOutput> {
  if (entry === "unit") {
    // 不进入模型：断言只依赖进程内状态（纯函数、注册表、变量池）。
    // 返回空输出，让 ctx.output 保持可读而不必特判 undefined。
    return { reply: "", toolCallHistory: [], retriesUsed: 0 }
  }

  // Runtime tests use the same durable session creation as the desktop entry.
  if (!getActiveSessionId()) await initSessions()

  if (entry === "production") {
    const result = await sendMessage(userText)
    return {
      reply: result.reply,
      // 本回合的工具调用历史来自回合结果本身，不再有进程内全局历史可漏、可残留。
      toolCallHistory: result.toolCalls,
      retriesUsed: result.retriesUsed,
      ...(result.failure ? { failure: result.failure } : {}),
    }
  }

  if (isActiveMessage) {
    const reply = await sendActiveMessage(userText)
    return { reply, toolCallHistory: [], retriesUsed: 0 }
  }

  // Mirror the production message lifecycle around the lower-level Pi runtime.
  const sessionId = getActiveSessionId()
  if (!isActiveMessage) pushUserMessage(userText, sessionId)
  const output = await runPiAgentTurn({
    sessionId,
    userText,
    // 这条入口绕过 sendMessage，没有宿主 requestId：投递正文用同一个构造点但不带身份，
    // 与生产入口的「有身份」形态同形（形状只有一处定义）。
    userPrompt: userInputMessage(userText, ""),
    unansweredCount: 0,
    isActiveMessage,
  })
  pushAssistantMessage(output.reply, sessionId)
  return output
}

async function runSceneInner(
  scene: SceneDef,
  trial: number,
  cancel: SceneCancelToken,
  progress: SceneProgress,
): Promise<SceneResult> {
  const start = Date.now()
  const turnResults: TurnResult[] = []
  const entry = scene.meta.entry ?? "runtime"

  progress.phase = "setup"
  if (scene.setup && !cancel.isCancelled()) {
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
    // 取消后不再推进：现场留在 progress，由超时路径写进报告。
    if (cancel.isCancelled()) break
    const turnStart = Date.now()
    progress.phase = "turn"
    progress.turn = turn
    progress.turnStart = turnStart
    progress.check = undefined
    progress.assertions = []

    try {
      const output = await executeTurn(turn.userText, entry, turn.isActiveMessage)
      const sessionId = getActiveSessionId()
      // 会话状态改读真实所有者：运行槽（HarnessSlot）与落盘条目，不再有进程内假状态机。
      const messages = await sessionMessages(sessionId)
      const ctx: AssertContext = {
        output,
        pool: getPoolSnapshot(),
        session: {
          state: harnessSlots.snapshot(sessionId)?.state ?? "closed",
          entryCount: messages.length,
          toolCallCount: messages.filter(message => message.role === "tool").length,
        },
        memory: await takeMemorySnapshot(getActiveSessionId()),
        toolHistory: output.toolCallHistory.map(item => ({
          toolName: item.toolName,
          status: item.status,
        })),
        confirms: confirmRecords(),
        plans: planRecords(),
        trial,
      }

      const assertions: AssertionResult[] = []
      for (const check of turn.checks) {
        if (cancel.isCancelled()) break
        progress.check = check.type
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
        // 每完成一条就同步现场：超时可能发生在任意一条断言之后。
        progress.assertions = [...assertions]
      }
      // 场景声明了预期失败时，框架在场景自己的断言之后补一条判定：
      // 只有声明并命中的失败才不算失败，其余失败照旧让回合判失败。
      const expectation = turn.expectFailure ? judgeExpectedFailure(turn.expectFailure, output) : undefined
      if (expectation) assertions.push(expectation.assertion)
      progress.check = undefined
      // 被取消的轮次没跑完，不算已完成回合 —— 它由超时报告单独呈现。
      if (cancel.isCancelled()) break

      const duration = Date.now() - turnStart
      const matchedFailure = expectation?.matched
      const result: TurnResult = {
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
        // 声明并命中的预期失败照常记录真实分类，同时标注它是预期：
        // 报告据此区分「场景预期的失败」与「失败被吞掉」。
        ...(matchedFailure ? { expectedFailure: { kind: matchedFailure.kind, message: matchedFailure.message } } : {}),
      }
      turnResults.push(result)
      progress.completed.push(result)

      if (assertions.some(assertion => !assertion.pass)) break
    } catch (error) {
      const duration = Date.now() - turnStart
      const kind = classifyError(error)
      const result: TurnResult = {
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
      }
      turnResults.push(result)
      progress.completed.push(result)
      break
    }
  }

  const duration = Date.now() - start
  // 预期失败不是「允许失败」：回合带的 errorKind 只有在被 expectFailure 判定命中时
  // 才不计入失败，其余情况（含没声明却失败）照旧让整个场景判失败。
  const turnPassed = (turn: TurnResult): boolean =>
    turn.assertions.every(assertion => assertion.pass)
    && (!turn.errorKind || turn.expectedFailure !== undefined)
  const allTurnsPassed = turnResults.length === scene.turns.length && turnResults.every(turnPassed)
  // 场景级分类只报告「非预期」的失败：预期的失败不该让通过场景看起来带错。
  const firstErrorKind = turnResults.find(turn => turn.errorKind && !turn.expectedFailure)?.errorKind

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
  const start = Date.now()
  const cancel = new SceneCancelToken()
  const progress = new SceneProgress()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inner: Promise<SceneResult> | undefined
  try {
    inner = runSceneInner(scene, trial, cancel, progress)
    return await Promise.race([
      inner,
      new Promise<SceneResult>((_, reject) => {
        timer = setTimeout(() => reject(new SceneTimeoutError(timeout)), timeout)
      }),
    ])
  } catch (error) {
    if (error instanceof SceneTimeoutError) {
      // 顺序固定：先停框架的后续步骤，再取现场，然后取消已登记的 Agent 回合，
      // 最后等被放弃的执行落地 —— 没落地就进入下一场景，残留写入会污染下一个 trial。
      cancel.cancel()
      const turns = timeoutTurns(progress)
      const stuck = stuckPhase(progress)
      await abortAgentRuns()
      const settled = await settleWithin(inner, SCENE_CANCEL_GRACE_MS)
      return {
        caseId: scene.meta.caseId,
        scene: scene.meta.description,
        module: scene.meta.module,
        contractId: scene.meta.contractId,
        suite: scene.meta.suite,
        trial,
        entry,
        status: "timeout",
        turns,
        duration: Date.now() - start,
        error: `场景超过 ${timeout}ms（${stuck}）${settled ? "" : `；被放弃的执行在 ${SCENE_CANCEL_GRACE_MS}ms 内未收尾，可能影响后续场景`}`,
        errorKind: "timeout",
      }
    }
    return {
      caseId: scene.meta.caseId,
      scene: scene.meta.description,
      module: scene.meta.module,
      contractId: scene.meta.contractId,
      suite: scene.meta.suite,
      trial,
      entry: scene.meta.entry ?? "runtime",
      status: "fail",
      turns: [],
      duration: Date.now() - start,
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
      // 超时只保证了「已登记的 Agent 回合被取消 + 最多等一次收尾宽限」；
      // 被放弃的执行仍可能没落地，同场景的剩余 trial 不再重试。
      // 它们是被计划过的，如实记为 skip，报告才能区分「计划执行」和「实际执行」。
      if (onTimeout === "abort") return results
      for (let skipped = trial + 1; skipped <= trialCount; skipped++) {
        results.push(skippedTrial(scene, skipped, `前序 trial #${trial} 超时，未执行`))
      }
      break
    }
  }
  return results
}
