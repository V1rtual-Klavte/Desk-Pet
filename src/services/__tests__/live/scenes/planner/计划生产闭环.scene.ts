import type { Entry } from "@earendil-works/pi-agent-core"
import type { PiAgentTurnOutput } from "@/services/engine/pi"
import { runPiAgentTurn } from "@/services/engine/pi"
import { initChat, stopActiveRun } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { setOverride } from "@/services/config"
import { userInputMessage } from "@/services/engine/runtime"
import { PLAN_CHECKPOINT_ENTRY, PLAN_STEP_RESULT_ENTRY } from "@/services/agent/memory"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { planEndRecords, planProgressRecords, planRecords } from "../../plan-confirm-channel"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * Plan 的生产闭环：确认通道 → 步骤执行 → 终态条目 → 终态事件，以及执行期取消的结算回归。
 *
 * 之前 planner 契约靠 `unitOnly` 豁免（Live Test 恒 pet、计划入口在 assistant + enabled 双重把守）；
 * 本场景显式打开助手模式与计划开关，把 Plan 真正跑进生产入口：
 * ① 模型给 3 步、`maxSteps=2` → 确认视图与进度事件的步数都是截断后的 2 步；
 * ② 终态是落盘条目（`deskpet.plan_checkpoint` 的 terminal 快照）与终态事件（`done`）两处证据；
 * ③ 取消回归走执行期终止：第 1 步阻塞时停止，计划落 `interrupted`、剩余步骤不执行、
 *    用户主动停止不写兜底失败回复（`abortedByStop` 且没有 `failure`）。
 *
 * 取消回归用 runtime 入口驱动（`runPiAgentTurn`）而不是 `sendMessage`：生产结果不暴露
 * `abortedByStop`，而这条断言要的正是「停止不是失败」的结算形态本身。
 */
const PLAN_JSON = '```json\n{"summary":"两件事","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"},{"id":3,"description":"多余的一步"}]}\n```'
const FIRST_TEXT = "第一步完成"
const SECOND_TEXT = "第二步完成"
const FINAL_TEXT = "计划执行完了，这是最终回复"
const CANCEL_TOOL = "live_plan_cancel_probe"
const CANCEL_TURN_TEXT = "--plan 读取配置并改写"
const CANCEL_PLAN_JSON = `\`\`\`json\n{"summary":"取消回归两步","steps":[{"id":1,"description":"读取第一项配置","allowedTools":["${CANCEL_TOOL}"]},{"id":2,"description":"改写配置"}]}\n\`\`\``

let provider: ReturnType<typeof installFakeProvider> | undefined
let blocking: ReturnType<typeof registerBlockingTool> | undefined

type CustomEntry = Extract<Entry, { type: "custom" }>

/** 按 customType 取宿主自定义条目（`Entry` 的联合不会因 filter 收窄，这里显式收）。 */
function customEntries(entries: Entry[], customType: string): CustomEntry[] {
  return entries.filter((entry): entry is CustomEntry =>
    entry.type === "custom" && entry.customType === customType)
}

/** 计划 checkpoint 的终态：按 planId 取最后一条 checkpoint 的 plan.state。 */
function planStateOf(entries: Entry[], planId: string): string | undefined {
  let state: string | undefined
  for (const entry of customEntries(entries, PLAN_CHECKPOINT_ENTRY)) {
    const payload = entry.data as { plan?: { planId?: string; state?: string } } | undefined
    if (payload?.plan?.planId !== planId) continue
    state = payload.plan.state
  }
  return state
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

export const 计划生产闭环: SceneDef = {
  meta: {
    caseId: "plan-production-loop", module: "planner", contractId: "pl-09",
    description: "生产入口跑完整计划闭环：截断后的确认与进度、终态条目与终态事件；执行期取消落 interrupted 且不写失败回复",
    depth: "deep", suite: "regression", entry: "production",
    tags: ["plan", "production-entry", "boundary", "error"],
    /** 测试宿主没有 PlanConfirm 面板：按 auto 确定性应答确认（逐步门在本场景不出现）。 */
    planPolicy: "auto",
  },
  setup: async () => {
    setOverride("general.mode.assistant", true)
    setOverride("ai.plan.enabled", true)
    // 模型给 3 步，配置只允许 2 步：截断必须体现在确认视图与进度 total 上。
    setOverride("ai.plan.maxSteps", 2)
    provider = installFakeProvider([
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

          // ③ 终态条目：checkpoint 的 terminal 快照是 done
          const entries = await sessionEntries(sessionId)
          const state = planStateOf(entries, confirmed.planId)
          if (state !== "done") throw new Error(`计划终态条目不是 done: ${String(state)}`)

          // ④ 步骤结果条目恰为计划步数，且属于同一个计划
          const stepResults = customEntries(entries, PLAN_STEP_RESULT_ENTRY)
          if (stepResults.length !== 2) throw new Error(`步骤结果条目应为 2 条，实际 ${stepResults.length}`)
          if (!stepResults.every(entry => (entry.data as { planId?: string }).planId === confirmed.planId)) {
            throw new Error("步骤结果条目里混进了别的计划")
          }

          // ⑤ 终态事件
          await waitRecords(() => planEndRecords(), records => records.some(record => record.reason === "done"), "计划终态事件 done")
        },
      },
      {
        type: "expectPlanCancelSettlement",
        run: async () => {
          const sessionId = getActiveSessionId()
          // 取消回归：第 1 步限定阻塞工具，工具一跑起来就停。第二步永远没有结果条目。
          provider?.appendResponses([fakeText(CANCEL_PLAN_JSON), fakeToolCall(CANCEL_TOOL, {}, "plan-cancel-call")])
          blocking = registerBlockingTool(CANCEL_TOOL)
          try {
            const turn = runPiAgentTurn({
              sessionId,
              userText: CANCEL_TURN_TEXT,
              userPrompt: userInputMessage(CANCEL_TURN_TEXT, ""),
              unansweredCount: 0,
              isActiveMessage: false,
            })
            // 工具进入执行 = 步骤的 running 状态与进度事件都已落定（checkpoint 写入先于工具调用），
            // 因此这里只等这个状态，不用固定 sleep。
            await blocking.started
            const stopped = await stopActiveRun(sessionId)
            const output: PiAgentTurnOutput = await turn
            if (!stopped?.planAborted) throw new Error("停止没有命中在跑的计划")

            // ⑥ 剩余步骤未执行：第二个计划没有第 2 步的结果条目（按 planId 圈定，不数上一个计划的）
            const entries = await sessionEntries(sessionId)
            const confirmedPlans = planRecords()
            const cancelledPlanId = confirmedPlans.length > 0 ? confirmedPlans[confirmedPlans.length - 1]!.planId : undefined
            if (!cancelledPlanId) throw new Error("取消回归没有产生计划确认记录")
            const cancelledResults = customEntries(entries, PLAN_STEP_RESULT_ENTRY)
              .filter(entry => (entry.data as { planId?: string }).planId === cancelledPlanId)
            if (cancelledResults.length >= 2) {
              throw new Error(`取消后第二个计划仍有 ${cancelledResults.length} 条步骤结果，第 2 步不该执行`)
            }

            // ⑦ 计划终态落 interrupted，剩余步骤保持未执行
            const state = planStateOf(entries, cancelledPlanId)
            if (state !== "interrupted") throw new Error(`取消后的计划终态应为 interrupted，实际 ${String(state)}`)

            // ⑧ 用户主动停止不写兜底失败回复：结算形态是 abortedByStop，而不是 failure
            if (output.abortedByStop !== true) throw new Error("停止没有按 abortedByStop 结算")
            if (output.failure !== undefined) throw new Error(`主动停止写了失败结算: ${JSON.stringify(output.failure)}`)

            // ⑨ 终态事件
            await waitRecords(() => planEndRecords(), records => records.some(record => record.reason === "cancelled"), "计划终态事件 cancelled")
          } finally {
            // ⑩ 收尾顺序同「停止入口与丢弃」：阻塞工具最后注销，不把探针留给后续场景。
            blocking?.dispose()
            blocking = undefined
            setOverride("general.mode.assistant", false)
            setOverride("ai.plan.maxSteps", 8)
          }
        },
      },
    ],
  }],
}

export default 计划生产闭环
