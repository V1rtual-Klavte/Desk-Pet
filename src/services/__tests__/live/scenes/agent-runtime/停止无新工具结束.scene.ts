import type { Entry } from "@earendil-works/pi-agent-core"
import { harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { permitSnapshot, register, TOOL_POLICY_VERSION, unregister } from "@/services/tool"
import type { PermitSnapshot } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 取消域级联的回归网（FIX-62④ / PLAN-02）：停止发生在工具执行中时，
 * ① 停止后不再产生新的工具结果条目（被停止的运行不会继续走到下一次工具/模型请求）；
 * ② 归还清单如实（未消费的 steer 输入回到调用方）；
 * ③ 独占额度回到空闲（取消发生时工具的释放路径确实执行 —— 类型检查证明不了这一点）；
 * ④ 下一回合照常可用（停止不是故障，会话不被卡死）。
 *
 * 「无新 tool_end」的口径：被停止回合经 provider 的请求次数必须停在 1 —— 工具结果一旦被
 * 结算，循环的下一个动作就是再问一次模型；请求数增长即「停止后还在跑」。同一条口径也
 * 覆盖在飞工具自身：它只能留下取消记录（isError），不能留下完成产物。
 */
const BLOCK_TOOL = "live_t207_stop_block"
const BLOCK_TOOL_ID = "live-t207-stop-block"
const BLOCK_CALL = "t207-call-block"
const STEER_TEXT = "停止前留下的补充，别丢。"
const RELEASE_TEXT = "exclusive-released"
const NEXT_TURN_TEXT = "停止后的下一回合照常完成"
/** 工具随取消结束的预算：正常路径上信号立即生效，超时只可能来自取消没送达。 */
const CANCEL_SETTLE_BUDGET_MS = 3_000
const PERMIT_IDLE_BUDGET_MS = 2_000
const ENTRY_SETTLE_BUDGET_MS = 1_000

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 该调用的工具结果条目；正文与错误标记用下面的取值器读（取值器内部做类型收窄）。 */
function toolResultEntries(entries: Entry[], toolCallId: string): Entry[] {
  return entries.filter(
    entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
  )
}

/** 别的调用留下的工具结果条目数：停止后的新增条目只能来自被停止的运行。 */
function otherToolResultCount(entries: Entry[], exceptCallId: string): number {
  return entries.filter(
    entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId !== exceptCallId,
  ).length
}

function toolResultText(entry: Entry): string {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return ""
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

function toolResultIsError(entry: Entry): boolean {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return false
  return entry.message.isError === true
}

let blocking: { started: Promise<void>; release: () => void } | undefined
let forcedRelease = false
let returnedCount = 0
let planAborted = false
let requestsInStoppedTurn = 0
let exclusiveHeldBeforeStop = false
let blockResultsAfterSettle = 0
let blockResultTextsAfterSettle: string[] = []
let blockResultIsError: boolean[] = []
let otherToolResults = 0
let permitAfterStop: PermitSnapshot | undefined
let queuedKindsAfterStop: string[] = []
let slotRunningAfterStop = true

/** 独占额度是否已按预期状态出现；等待在许可所有者里发生，不靠时序猜测。 */
async function waitForExclusive(expected: boolean): Promise<boolean> {
  const deadline = Date.now() + PERMIT_IDLE_BUDGET_MS
  while (Date.now() < deadline) {
    if ((await permitSnapshot()).exclusiveActive === expected) return true
    await delay(25)
  }
  return false
}

/** 等额度回空闲（有界）；返回最后看到的快照，失败由断言读出具体数字。 */
async function waitForPermitIdle(): Promise<PermitSnapshot> {
  const deadline = Date.now() + PERMIT_IDLE_BUDGET_MS
  let snapshot = await permitSnapshot()
  while (Date.now() < deadline) {
    snapshot = await permitSnapshot()
    if (!snapshot.exclusiveActive && snapshot.sharedActive === 0 && snapshot.queued === 0) return snapshot
    await delay(25)
  }
  return snapshot
}

/**
 * 落盘是异步的：等该调用的工具结果条目数量连续两次采样不再增长（有界），返回稳定值。
 * 停止后的基线取稳定值，才不会被「取消记录还没写完」当成新增条目。
 */
async function settledToolResultCount(toolCallId: string): Promise<number> {
  const deadline = Date.now() + ENTRY_SETTLE_BUDGET_MS
  let last = toolResultEntries(await sessionEntries(), toolCallId).length
  while (Date.now() < deadline) {
    await delay(50)
    const next = toolResultEntries(await sessionEntries(), toolCallId).length
    if (next === last) return next
    last = next
  }
  return last
}

/** 独占效果的阻塞工具：持有许可直到放行或 gate signal 中止（工具执行中停止的现场）。 */
function registerExclusiveBlockingTool(): void {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let releaseAll!: () => void
  const released = new Promise<void>(resolve => { releaseAll = resolve })
  register({
    id: BLOCK_TOOL_ID,
    name: BLOCK_TOOL,
    description: `Live Test blocking tool ${BLOCK_TOOL}`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE",
    source: "local",
    sourceId: "",
    mode: "pet",
    actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "local_mutation", mode: "sequential", isolation: "exclusive_effect", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
    handler: async (_params, ctx) => {
      markStarted()
      await new Promise<void>(resolve => {
        void released.then(resolve)
        const signal = ctx.signal
        if (signal?.aborted) resolve()
        else signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      if (ctx.signal?.aborted) return { success: false, content: "", error: "工具已取消", errorCode: "cancelled" }
      return { success: true, content: RELEASE_TEXT }
    },
  })
  blocking = { started, release: releaseAll }
}

export const 停止无新工具结束: SceneDef = {
  meta: {
    caseId: "runtime-stop-no-new-tool-end",
    module: "agent-runtime",
    contractId: "ar-17",
    description: "工具执行中停止：归还清单如实、停止后不再产生新的工具结果条目、独占额度回空闲、下一回合照常可用",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "cancel", "stop", "tool-execution", "boundary"],
  },
  setup: async () => {
    const provider = installFakeProvider([fakeToolCall(BLOCK_TOOL, {}, BLOCK_CALL)])
    await initChat()
    const sessionId = getActiveSessionId()
    registerExclusiveBlockingTool()
    const requestsBefore = provider.payloads.length
    const firstTurn = sendMessage("开始一个会在工具里被停止的任务。")
    await blocking!.started
    // 工具真的拿到了独占额度：不然「额度回空闲」的断言什么都没证明。
    exclusiveHeldBeforeStop = await waitForExclusive(true)
    await sendMessage(STEER_TEXT, { requestId: "runtime-stop-no-new-tool-end", delivery: "steer" })

    // 用户显式停止（生产入口）。
    const stopped = await stopActiveRun(sessionId)
    if (!stopped) throw new Error("运行中的回合没有可停止的运行（停止入口返回 undefined）")
    returnedCount = stopped.steer.length + stopped.followUp.length
    planAborted = stopped.planAborted

    // 工具必须随取消结束：没结束就放行一次以免场景挂死，但那会被 forcedRelease 如实判失败。
    const releaseTimer = setTimeout(() => { forcedRelease = true; blocking?.release() }, CANCEL_SETTLE_BUDGET_MS)
    await firstTurn
    clearTimeout(releaseTimer)
    requestsInStoppedTurn = provider.payloads.length - requestsBefore

    baseAssertions()
    // 落盘基线：等到该调用的结果条目稳定，记录条数、正文与错误标记。
    blockResultsAfterSettle = await settledToolResultCount(BLOCK_CALL)
    const entries = await sessionEntries()
    const blockResults = toolResultEntries(entries, BLOCK_CALL)
    blockResultTextsAfterSettle = blockResults.map(toolResultText)
    blockResultIsError = blockResults.map(toolResultIsError)
    otherToolResults = otherToolResultCount(entries, BLOCK_CALL)
    permitAfterStop = await waitForPermitIdle()
    // 队列里只允许留下「停止归还」的 nextRun：没有别的东西还在等下一次运行。
    queuedKindsAfterStop = (harnessSlots.snapshot(sessionId)?.queued ?? []).map(item => item.kind)
    slotRunningAfterStop = harnessSlots.isRunning(sessionId)

    // 下一回合的回复在停止收尾之后才入队：工具执行中停止不会多消费一次 provider 响应。
    provider.appendResponses([fakeText(NEXT_TURN_TEXT), fakeText(NEXT_TURN_TEXT)])
  },
  turns: [{
    index: 1,
    description: "停止后会话与许可域都能继续使用",
    userText: "停止之后再确认一下。",
    checks: [{
      type: "expectStopNoNewToolEnd",
      run: async (ctx) => {
        blocking?.release()
        unregister(BLOCK_TOOL_ID)

        // ① 停止后不再产生新的工具结果条目：请求数停在 1，条目数不再增长，也没有别的工具留下结果。
        const entriesNow = await sessionEntries()
        const blockResultsNow = toolResultEntries(entriesNow, BLOCK_CALL)
        if (blockResultsNow.length !== blockResultsAfterSettle) {
          throw new Error(`停止后该调用的工具结果条目仍在增长: ${blockResultsAfterSettle} → ${blockResultsNow.length}`)
        }
        const otherNow = otherToolResultCount(entriesNow, BLOCK_CALL)
        if (otherNow !== otherToolResults) {
          throw new Error(`停止后出现了别的工具结果条目: ${otherToolResults} → ${otherNow}`)
        }
        // 被停止的运行只能留下取消记录，不能留下完成产物。
        blockResultTextsAfterSettle.forEach((text, index) => {
          if (text.includes(RELEASE_TEXT)) throw new Error(`停止后工具仍然执行完成: ${text}`)
          if (blockResultIsError[index] !== true) throw new Error(`停止后的工具结果不是取消错误: ${text}`)
        })

        // ② 归还清单如实：工具执行期投递的 steer 输入回到调用方，队列只留下它（nextRun）。
        if (returnedCount !== 1) throw new Error(`停止应归还 1 条未消费输入，实际 ${returnedCount}`)
        if (queuedKindsAfterStop.some(kind => kind !== "nextRun")) {
          throw new Error(`停止归还后队列里还有非 nextRun 残留: ${JSON.stringify(queuedKindsAfterStop)}`)
        }
        if (slotRunningAfterStop) throw new Error("停止并收尾后运行槽仍被报成运行中")
        // 这一次停止没有计划在跑：`planAborted` 必须如实为 false（字段语义不能冒充）。
        if (planAborted) throw new Error("普通回合作业被报成「计划被终止」")

        // ③ 独占额度回空闲：取消发生在工具执行中时，释放路径确实执行了。
        if (!permitAfterStop) throw new Error("停止后没有读到许可快照")
        if (permitAfterStop.exclusiveActive || permitAfterStop.sharedActive !== 0 || permitAfterStop.queued !== 0) {
          throw new Error(`停止后额度没有回空闲: shared=${permitAfterStop.sharedActive} exclusive=${permitAfterStop.exclusiveActive} queued=${permitAfterStop.queued}`)
        }

        // ④ 下一回合可用：停止之后同一会话还能正常完整跑一个回合。
        if (ctx.output.failure) throw new Error(`停止后的回合以失败结束: ${ctx.output.failure.message}`)
        if (!ctx.output.reply.includes(NEXT_TURN_TEXT)) {
          throw new Error(`停止后的回合没有按脚本完成: ${JSON.stringify(ctx.output.reply)}`)
        }
        const replies = assistantTexts(await sessionMessages())
        if (!replies.some(text => text.includes(NEXT_TURN_TEXT))) {
          throw new Error("停止后的回复没有落盘")
        }
      },
    }],
  }],
}

/** 停止当下的硬性事实：这几条不依赖落盘时序，先判掉再等条目稳定。 */
function baseAssertions(): void {
  if (forcedRelease) throw new Error("停止后工具没有随取消信号结束（靠放行才收尾）")
  if (!exclusiveHeldBeforeStop) throw new Error("工具执行期间独占额度没有生效：停止时的现场不成立")
  if (requestsInStoppedTurn !== 1) {
    throw new Error(`被停止的回合向 provider 发了 ${requestsInStoppedTurn} 次请求：停止后运行仍在继续`)
  }
}

export default 停止无新工具结束
