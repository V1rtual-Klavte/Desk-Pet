import type { Entry } from "@earendil-works/pi-agent-core"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { planConfig, setOverride } from "@/services/config"
import { DESKPET_SYSTEM_MESSAGE_ENTRY } from "@/services/engine/runtime"
import { PLAN_CHECKPOINT_ENTRY, PLAN_STEP_RESULT_ENTRY } from "@/services/agent/memory"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { planEndRecords, planInteractionRecords, planProgressRecords, planRecords } from "../../plan-confirm-channel"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 计划域的运行时接线场景。一个场景的 `meta.contractId` 只能挂一个覆盖点，所以按行为拆成三个：
 *
 * - `plan-production-loop`（pl-09）：确认通道 → 步骤执行 → 终态条目 → 终态事件；
 * - `plan-execution-stop-settlement`（pl-10）：执行期停止的结算（计划落 interrupted、剩余步骤
 *   保持未执行、停止不按失败结算）；
 * - `plan-step-gate-each-step`（pl-11）：`stepByStep` 下逐步前置门每步都真的问一次。
 *
 * 三个场景都在自己的 setup 里显式打开计划开关：本套 Live 的配置基线把 `ai.plan.enabled`
 * 钉在 `false`（见 standard-setup.ts），而计划入口只看这一个开关。
 *
 * 2026-09-24 W5 整轮：pl-10（`timeout`，卡在 setup）与 pl-11（「应恰好一次计划确认，实际 0」）同因失败，
 * 根因在生产段而非场景 —— `runPiAgentTurn` 先把 `--plan` 前缀剥掉、再把剥后的正文交给
 * `evaluateComplexity`，于是 `evaluateComplexity` 的 `startsWith("--plan")` force 分支永不命中；
 * 剥离后的正文又不含关键词（`complexityEval=keyword` 下 score=1），计划段因此一次都没进
 *（pl-11 的 101 字符回复正是被主回合直接吐出来的规划脚本）。这是产品缺陷，已修在
 * `engine/pi/runtime.ts`：复杂度判定看原文本，前缀只从交给规划 prompt 的正文里剥。场景断言未改。
 */
const PLAN_JSON = '```json\n{"summary":"两件事","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"},{"id":3,"description":"多余的一步"}]}\n```'
const FIRST_TEXT = "第一步完成"
const SECOND_TEXT = "第二步完成"
const FINAL_TEXT = "计划执行完了，这是最终回复"
/** pl-11：2 步计划（`maxSteps` 默认下不截断），两句话都成功、每步前各过一次门。 */
const GATE_PLAN_JSON = '```json\n{"summary":"两步改配置","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"}]}\n```'
const GATE_TURN_TEXT = "--plan 帮我改配置"
const GATE_STEP1_TEXT = "配置已读取"
const GATE_STEP2_TEXT = "配置已改写"
const GATE_FINAL_TEXT = "两步都做完了"
const CANCEL_TOOL = "live_plan_cancel_probe"
const CANCEL_TURN_TEXT = "--plan 读取配置并改写"
const CANCEL_PLAN_JSON = `\`\`\`json\n{"summary":"取消回归两步","steps":[{"id":1,"description":"读取第一项配置","allowedTools":["${CANCEL_TOOL}"]},{"id":2,"description":"改写配置"}]}\n\`\`\``
/** pl-10 的收尾回合：停止发生在 setup 的回合里，场景自己的回合只用来承载核对断言。 */
const SETTLE_TURN_TEXT = "刚才的计划停下来了吗？"
const SETTLE_TURN_REPLY = "计划已经停下了。"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
/** pl-10：被停止的那个生产回合的结算，setup 里跑完、check 里核对。 */
let stopSessionId = ""
let stopPlanAborted = false
let stopResult: Awaited<ReturnType<typeof sendMessage>> | undefined
/** 场景开始时被改写的配置值（还原时用它们的真实值，不把开发配置的当前值当默认值）。 */
let restoreConfig: { complexityEval: string; maxSteps: number } | undefined

type CustomEntry = Extract<Entry, { type: "custom" }>

/** 按 customType 取宿主自定义条目（`Entry` 的联合不会因 filter 收窄，这里显式收）。 */
function customEntries(entries: Entry[], customType: string): CustomEntry[] {
  return entries.filter((entry): entry is CustomEntry =>
    entry.type === "custom" && entry.customType === customType)
}

/** 计划终态的 terminal 快照：计划状态与全量步骤基线都在里面（按 planId 取最后一条）。 */
function planTerminalOf(entries: Entry[], planId: string): { state?: string; steps: { stepId?: string; state?: string }[] } {
  let terminal: { state?: string; steps: { stepId?: string; state?: string }[] } = { steps: [] }
  for (const entry of customEntries(entries, PLAN_CHECKPOINT_ENTRY)) {
    const payload = entry.data as {
      action?: string
      plan?: { planId?: string; state?: string }
      steps?: { stepId?: string; state?: string }[]
    } | undefined
    if (payload?.action !== "terminal" || payload.plan?.planId !== planId) continue
    terminal = { state: payload.plan.state, steps: payload.steps ?? [] }
  }
  return terminal
}

/** 事件回环投递是异步的：按状态有界等待（不用固定 sleep 代替状态等待）。 */
async function waitRecords<T>(read: () => T[], ok: (items: T[]) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (ok(read())) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${what}`)
}

/** 系统提示经 `persistSystemMessage` 异步落盘：按状态有界等待，超时把实际看到的消息一并报出。 */
async function waitSystemMessage(sessionId: string, needle: string): Promise<void> {
  const deadline = Date.now() + 3000
  let seen: string[] = []
  while (Date.now() < deadline) {
    seen = customEntries(await sessionEntries(sessionId), DESKPET_SYSTEM_MESSAGE_ENTRY)
      .map(entry => String((entry.data as { text?: string } | undefined)?.text ?? ""))
    if (seen.some(text => text.includes(needle))) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：系统提示「${needle}」未落盘，实际 ${JSON.stringify(seen)}`)
}

export const 计划生产闭环: SceneDef = {
  meta: {
    caseId: "plan-production-loop", module: "planner", contractId: "pl-09",
    description: "生产入口跑完整计划闭环：截断后的确认与进度、终态条目与终态事件",
    depth: "deep", suite: "regression", entry: "production",
    tags: ["plan", "production-entry", "boundary", "error"],
    /** 测试宿主没有 PlanConfirm 面板：按 auto 确定性应答确认（逐步门在本场景不出现）。 */
    planPolicy: "auto",
  },
  setup: async () => {
    setOverride("ai.plan.enabled", true)
    // 关键词命中给 3 分：阈值钉在 3 才等价于「命中即触发」，免得开发配置把阈值抬高后
    // 本场景落进「计划根本没启动」的另一种失败里。
    setOverride("ai.plan.complexityThreshold", 3)
    // 模型给 3 步，配置只允许 2 步：截断必须体现在确认视图与进度 total 上。
    setOverride("ai.plan.maxSteps", 2)
    installFakeProvider([
      fakeText(PLAN_JSON),
      fakeText(FIRST_TEXT),
      fakeText(SECOND_TEXT),
      fakeText(FINAL_TEXT),
    ])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "复杂度命中 → 生成 → 确认 → 逐步执行 → 终态落盘",
    userText: "帮我重构整个配置模块",
    checks: [
      {
        type: "expectPlanProductionLoop",
        run: async ctx => {
          const sessionId = getActiveSessionId()
          const restore = { maxSteps: planConfig.maxSteps, complexityThreshold: planConfig.complexityThreshold }
          try {
            if (ctx.output.failure) throw new Error(`计划回合失败: ${JSON.stringify(ctx.output.failure)}`)

            // ① 确认记录带会话身份，且本场景恰好一次（auto 策略应答为 confirmed）
            if (ctx.plans.length !== 1) throw new Error(`应恰好一次计划确认，实际 ${ctx.plans.length}`)
            const confirmed = ctx.plans[0]!
            if (confirmed.sessionId !== sessionId) throw new Error(`确认记录没有带会话身份: ${confirmed.sessionId}`)
            if (!confirmed.confirmed) throw new Error("auto 策略下确认没有被应答为 confirmed")
            if (confirmed.mode !== "auto") throw new Error(`确认方式应为 auto，实际 ${confirmed.mode}`)

            // ② 确认视图与进度事件都按截断后的步数：3 步被 maxSteps=2 截断
            if (confirmed.steps !== 2) throw new Error(`确认视图的步数应是截断后的 2，实际 ${confirmed.steps}`)
            await waitRecords(() => planProgressRecords(), records => records.some(record => record.status === "done"), "计划进度事件")
            const progress = planProgressRecords()
            if (progress.some(record => record.total !== 2)) {
              throw new Error(`进度的 total 不是截断后步数: ${JSON.stringify(progress)}`)
            }
            if (progress.some(record => record.step > 2)) {
              throw new Error(`进度里出现了被截断的步骤: ${JSON.stringify(progress)}`)
            }

            // ②b 工具面放大的用户可见报告：本计划的步骤都没限定 allowedTools，宿主逐步写一条系统
            //     消息，口径是子代理实际拿到的那一份（派生型工具在子代理入口被剥掉，所以不是「全部」）。
            await waitSystemMessage(sessionId, "将使用除派生型工具外的全部已注册工具")

            // ③ 终态条目：checkpoint 的 terminal 快照是 done，且全量步骤基线里两步都 done
            const entries = await sessionEntries(sessionId)
            const terminal = planTerminalOf(entries, confirmed.planId)
            if (terminal.state !== "done") throw new Error(`计划终态条目不是 done: ${String(terminal.state)}`)
            if (terminal.steps.filter(step => step.state === "done").length !== 2) {
              throw new Error(`终态快照的步骤基线不对: ${JSON.stringify(terminal.steps)}`)
            }

            // ④ 步骤结果条目恰为计划步数，且属于同一个计划
            const stepResults = customEntries(entries, PLAN_STEP_RESULT_ENTRY)
            if (stepResults.length !== 2) throw new Error(`步骤结果条目应为 2 条，实际 ${stepResults.length}`)
            if (!stepResults.every(entry => (entry.data as { planId?: string }).planId === confirmed.planId)) {
              throw new Error("步骤结果条目里混进了别的计划")
            }

            // ⑤ 终态事件
            await waitRecords(() => planEndRecords(), records => records.some(record => record.reason === "done"), "计划终态事件 done")
          } finally {
            setOverride("ai.plan.maxSteps", restore.maxSteps)
            setOverride("ai.plan.complexityThreshold", restore.complexityThreshold)
            setOverride("ai.plan.enabled", false)
          }
        },
      },
    ],
  }],
}

/**
 * 执行期停止的结算（pl-10）。
 *
 * 被停止的回合走**生产入口** `sendMessage()`：停止入口 `stopActiveRun()` 与用户点「停止」是
 * 同一条通道。停止必须发生在回合在飞时（第 1 步的工具还阻塞着），所以回合在 setup 里发起、
 * 由 setup 在 `blocking.started` 之后停止 —— 同「停止入口与丢弃」的造法；场景自己的回合
 * 只用来承载核对断言（它的正文不含关键词、`complexityEval` 又被钉在 keyword，不会进计划段）。
 *
 * 「停止不是失败」在生产层的可观测形态有三处，逐条断言：`SendMessageResult` 不带 `failure`、
 * `outcome` 不是 failed、回复为空（`finishWithoutTurn` 的取消分支不写正文）；再加宿主只在
 * `abortedByStop` 时写的那条「已停止本次回复」系统提示 —— `abortedByStop` 字段本身由
 * agent-runtime 的停止场景断言，本场景要的是它在生产链路里的结算形态。
 */
export const 计划取消结算: SceneDef = {
  meta: {
    caseId: "plan-execution-stop-settlement", module: "planner", contractId: "pl-10",
    description: "生产入口执行期停止：计划落 interrupted、剩余步骤保持 pending、终态事件 cancelled，且停止不按失败结算",
    depth: "deep", suite: "regression", entry: "production",
    tags: ["plan", "production-entry", "cancel", "boundary", "error"],
    /** 测试宿主没有 PlanConfirm 面板：按 auto 确定性应答确认（本场景不出现逐步门）。 */
    planPolicy: "auto",
  },
  setup: async () => {
    restoreConfig = { complexityEval: planConfig.complexityEval, maxSteps: planConfig.maxSteps }
    // 收尾回合（turns[0]）走的是普通助手回合：钉住评估方式，免得开发配置改成 llm 后
    // 它多打一次模型请求、把脚本里的响应提前取走。
    setOverride("ai.plan.complexityEval", "keyword")
    setOverride("ai.plan.enabled", true)
    installFakeProvider([
      fakeText(CANCEL_PLAN_JSON),
      fakeToolCall(CANCEL_TOOL, {}, "plan-cancel-call"),
      fakeText(SETTLE_TURN_REPLY),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    // 探针必须先注册：第 1 步的 allowedTools 指向它，解析不到就会走「工具不存在、该步未执行」
    // 的另一条路径，本场景要证的不是那条。
    blocking = registerBlockingTool(CANCEL_TOOL)
    const stoppedTurn = sendMessage(CANCEL_TURN_TEXT)
    // 工具进入执行 = 计划已绑定中断通道、步骤落 running（checkpoint 写入先于工具调用），
    // 因此这里只等这个状态，不用固定 sleep 代替状态等待。等待**有界**：计划没跑起来时
    // （「--plan 没有强制触发」这类前提失效）要给出「工具未进入执行」的诊断，不能把整场景
    // 拖成 120s 的裸超时 —— 2026-09-24 W5 在这里吃掉 125s，报告里只剩一句「卡在 setup」。
    // 计时器在 started 先到时会清掉，不会留下未处理的拒绝。
    const startedBudgetMs = 10_000
    let startedTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        blocking.started,
        new Promise<never>((_, reject) => {
          startedTimer = setTimeout(
            () => reject(new Error(`阻塞工具在 ${startedBudgetMs}ms 内没有进入执行：计划没有跑起来（本场景 setup 只等这一步）`)),
            startedBudgetMs,
          )
        }),
      ])
    } finally {
      if (startedTimer !== undefined) clearTimeout(startedTimer)
    }
    const stopped = await stopActiveRun(sessionId)
    stopSessionId = sessionId
    stopPlanAborted = stopped?.planAborted === true
    stopResult = await stoppedTurn
  },
  turns: [{
    index: 1,
    description: "核对停止后的计划结算与生产层结算形态",
    userText: SETTLE_TURN_TEXT,
    checks: [{
      type: "expectPlanExecutionStopSettlement",
      run: async () => {
        blocking?.dispose()
        blocking = undefined
        try {
          const result = stopResult
          if (!result) throw new Error("setup 没有完成被停止的生产回合")
          // ① 前提：停止命中的是在跑的计划（不是只停了回合）
          if (!stopPlanAborted) throw new Error("停止没有命中在跑的计划")

          // ② 结算形态：用户主动停止不写兜底失败回复、不带 failure
          if (result.failure !== undefined) throw new Error(`主动停止写了失败结算: ${JSON.stringify(result.failure)}`)
          if (result.outcome !== "succeeded") throw new Error(`停止被结算成 ${result.outcome}，而不是正常收尾`)
          if (result.reply !== "") throw new Error(`停止后不该有助手正文: ${JSON.stringify(result.reply)}`)

          // ③ 用户可见的停止凭证：宿主只在 abortedByStop 时写这条系统提示
          await waitSystemMessage(stopSessionId, "已停止本次回复")

          // ④ 本场景只有被停止的那一个计划（收尾回合没进计划段），确认记录带会话身份
          const confirms = planRecords()
          if (confirms.length !== 1) throw new Error(`应恰好一次计划确认，实际 ${confirms.length}`)
          const planId = confirms[0]!.planId
          if (confirms[0]!.sessionId !== stopSessionId) throw new Error(`确认记录没有带会话身份: ${confirms[0]!.sessionId}`)

          // ⑤ 计划终态落 interrupted
          const entries = await sessionEntries(stopSessionId)
          const terminal = planTerminalOf(entries, planId)
          if (terminal.state !== "interrupted") throw new Error(`计划终态应为 interrupted，实际 ${String(terminal.state)}`)

          // ⑥ 剩余步骤保持未执行：第 2 步仍是 pending，也没有第 2 步的结果条目
          //（按 planId 圈定，不数别的计划的条目）
          const stepTwo = terminal.steps.find(step => step.stepId === "2")
          if (stepTwo?.state !== "pending") {
            throw new Error(`取消后第 2 步应保持 pending，实际 ${String(stepTwo?.state)}`)
          }
          const stepTwoResults = customEntries(entries, PLAN_STEP_RESULT_ENTRY).filter(entry => {
            const data = entry.data as { planId?: string; stepId?: string } | undefined
            return data?.planId === planId && data.stepId === "2"
          })
          if (stepTwoResults.length !== 0) {
            throw new Error(`取消后第 2 步仍然产出了 ${stepTwoResults.length} 条结果条目`)
          }

          // ⑦ 终态事件
          await waitRecords(() => planEndRecords(), records => records.some(record => record.reason === "cancelled"), "计划终态事件 cancelled")
        } finally {
          if (restoreConfig) {
            setOverride("ai.plan.complexityEval", restoreConfig.complexityEval)
            setOverride("ai.plan.maxSteps", restoreConfig.maxSteps)
            restoreConfig = undefined
          }
          setOverride("ai.plan.enabled", false)
        }
      },
    }],
  }],
}

/**
 * 逐步前置门（pl-11）：`stepByStep` 下每一步开工前都要用户放行。
 *
 * 确认按 `stepByStep` 应答 → `stepMode` 生效 → `executePlan` 的 `stepGate: "each"` 每步前经
 * `onStepGate` 问一次；测试通道对每个门都按 `continue` 应答，所以计划照常跑完。断言落在
 * 「问了几次、每次的答案、以及计划没被门卡住」上 —— 门选择中止的 `declined` 归宿不在本场景
 * （宿主通道对确认与门只有一套 `planPolicy`，给不出「确认自动 + 门中止」的组合）。
 */
export const 计划逐步门: SceneDef = {
  meta: {
    caseId: "plan-step-gate-each-step", module: "planner", contractId: "pl-11",
    description: "stepByStep 下逐步前置门每步都问一次、按 continue 应答后计划照常跑完",
    depth: "deep", suite: "regression", entry: "production",
    tags: ["plan", "production-entry", "step-gate"],
    /** 确认与逐步门都按 stepByStep 应答：确认给出 mode，门给出 continue。 */
    planPolicy: "stepByStep",
  },
  setup: async () => {
    setOverride("ai.plan.enabled", true)
    installFakeProvider([
      fakeText(GATE_PLAN_JSON),
      fakeText(GATE_STEP1_TEXT),
      fakeText(GATE_STEP2_TEXT),
      fakeText(GATE_FINAL_TEXT),
    ])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "逐步确认 → 每步前放行 → 计划跑完",
    userText: GATE_TURN_TEXT,
    checks: [{
      type: "expectPlanStepGateEachStep",
      run: async ctx => {
        const sessionId = getActiveSessionId()
        try {
          if (ctx.output.failure) throw new Error(`逐步确认回合失败: ${JSON.stringify(ctx.output.failure)}`)

          // ① 确认的 mode 真的生效：面板给 stepByStep，计划段就按逐步模式跑
          if (ctx.plans.length !== 1) throw new Error(`应恰好一次计划确认，实际 ${ctx.plans.length}`)
          const confirmed = ctx.plans[0]!
          if (confirmed.sessionId !== sessionId) throw new Error(`确认记录没有带会话身份: ${confirmed.sessionId}`)
          if (confirmed.mode !== "stepByStep") throw new Error(`确认方式应为 stepByStep，实际 ${confirmed.mode}`)

          // ② 逐步门每步问一次：2 步计划 → 恰好 2 次门裁决，且都放行
          const gates = planInteractionRecords().filter(record => record.kind === "step_gate")
          if (gates.length !== 2) throw new Error(`2 步计划应有 2 次逐步门裁决，实际 ${gates.length}`)
          if (!gates.every(gate => gate.decision === "continue")) {
            throw new Error(`逐步门的应答不是 continue: ${JSON.stringify(gates)}`)
          }

          // ③ 门没有把计划卡住：每步都执行了，计划跑完、终态与事件都是完成
          const entries = await sessionEntries(sessionId)
          const terminal = planTerminalOf(entries, confirmed.planId)
          if (terminal.state !== "done") throw new Error(`计划终态应为 done，实际 ${String(terminal.state)}`)
          const stepResults = customEntries(entries, PLAN_STEP_RESULT_ENTRY)
          if (stepResults.length !== 2) throw new Error(`步骤结果条目应为 2 条，实际 ${stepResults.length}`)
          if (!stepResults.every(entry => (entry.data as { planId?: string }).planId === confirmed.planId)) {
            throw new Error("步骤结果条目里混进了别的计划")
          }
          await waitRecords(() => planProgressRecords(), records => records.some(record => record.status === "done"), "计划进度事件")
          const progress = planProgressRecords()
          if (progress.some(record => record.total !== 2)) {
            throw new Error(`进度的 total 不是计划步数: ${JSON.stringify(progress)}`)
          }
          await waitRecords(() => planEndRecords(), records => records.some(record => record.reason === "done"), "计划终态事件 done")
        } finally {
          setOverride("ai.plan.enabled", false)
        }
      },
    }],
  }],
}

export default 计划生产闭环
