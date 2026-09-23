// ==========================================
// Live Test Scene: 子代理授权的会话与代际绑定（源项 PLAN-03 / 覆盖点 sf-20）
// ==========================================
//
// PLAN-03 的验证点：「子代理里 `allow_session` 后切会话，再取同参 grant 不得命中」。
// 现场取计划步骤子代理 —— runtime 里唯一给子代理带 scope 的路径（`PiSubAgentScope`：
// 许可身份绑定父会话与代际）；fork/team 的独立子代理是无会话的一次性运行（`no-session:-1:…`），
// 不构成本验证点。
//
// 每个计划回合的 provider 脚本（faux 按队列交付，顺序即逐次请求）：
//   1. 计划生成 → 1 步计划，步内只给 DANGER 探针工具；
//   2. 步骤子代理第 1 轮 → 探针调用（宿主 approve 通道应答 `allow_session` → 工具以 done 收场，grant 入账）；
//   3. 步骤子代理第 2 轮 → 同一工具同一参数（必须命中 grant：不再产生确认请求）；
//   4. 步骤子代理第 3 轮 → 步骤完成文本；
//   5. 计划段之后的主回合 → 收尾文本。
//
// 断言（对应 PLAN-03 与 T2.17 的定稿）：
//   ① 会话 A：两次同参调用都以 done 收场（探针 handler 只在权限放行后执行），确认请求只有一次；
//      探针拿到的 sessionId/runGeneration 就是父会话与父槽代际（不是合成 run id / 0），
//      且同参用父身份重新评估仍是 allow —— 授权确实按父会话与代际入账。
//   ② 切到会话 B 后同工具同参数再调用：确认通道必须收到一次新请求（旧 grant 不得跨会话命中）。
//   ③ 会话 A 的 grant 已随切会话清 scope：同参用 (会话 A, 父代际) 重新评估必须回到 ask。
//
// 切会话用产品路径的「新建并切换」（`createNewSession`）：与 `switchToSession` 是同一个
// 清 scope 点（会话指针移动前 `invalidatePermissionScope(旧会话)`），且不需要先造出
// 已存在的会话 B 再二次切换。

import type { FauxResponseStep } from "@earendil-works/pi-ai"
import { PLAN_STEP_RESULT_ENTRY, type PlanStepResult } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"
import { generalConfig, planConfig, setOverride } from "@/services/config"
import { harnessSlots } from "@/services/engine/pi"
import { evaluateToolPermission, freezePermissionPolicy } from "@/services/safety"
import { createNewSession, getActiveSessionId, readPiSessionEntriesOnce } from "@/services/session"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { confirmRecords } from "../../confirm-channel"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { AssertCheck, AssertContext, SceneDef } from "../../types"

const TOOL_ID = "live-sf20-scope-tool"
const TOOL_NAME = "live_sf20_scope_tool"
/** 两次调用必须逐字同参：grant 的身份包含参数 hash。 */
const PARAMS = { target: "sf20-scope" }
const USER_TEXT = "--plan 分析一次需要确认的子代理操作"
const STEP_DONE_A = "步骤 A 完成"
const MAIN_DONE_A = "会话 A 完成"
const STEP_DONE_B = "步骤 B 完成"
const MAIN_DONE_B = "会话 B 完成"

/** 一次探针执行：handler 只在权限放行后才跑，这条记录就是「工具以 done 收场」。 */
interface ProbeCall {
  sessionId: string
  runGeneration: number
  /** 调用发生时父槽的代际：与 runGeneration 交叉核对「绑定的是父代际而不是常量」。 */
  slotGeneration: number
}

let probeTool: ToolDef | undefined
let probeCalls: ProbeCall[] = []
let sessionA = ""
let sessionB = ""
let provider: ReturnType<typeof installFakeProvider> | undefined
// 原值只捕获一次：上一 trial 若在清理前失败，不能把本场景自己的测试值当成「原值」。
let assistantBefore: boolean | undefined
let planEnabledBefore: boolean | undefined

function planJson(): string {
  const plan = {
    summary: "确认一次需要授权的操作",
    steps: [{ id: 1, description: "调用探针工具两次", role: "执行员", allowedTools: [TOOL_NAME] }],
    estimatedComplexity: 3,
  }
  return ["```json", JSON.stringify(plan), "```"].join("\n")
}

/** 一个计划回合的完整 provider 脚本（5 条，见文件头）。 */
function turnScript(stepDone: string, mainDone: string, tag: string): FauxResponseStep[] {
  return [
    fakeText(planJson()),
    fakeToolCall(TOOL_NAME, PARAMS, `${tag}-call-1`),
    fakeToolCall(TOOL_NAME, PARAMS, `${tag}-call-2`),
    fakeText(stepDone),
    fakeText(mainDone),
  ]
}

/**
 * 探针工具：轻量模式（pet）下 DANGER 只有声明 `confirm` 才会走确认通道 —— 本场景要的正是
 * 那条通道（宿主 approve → `allow_session`）。handler 只记录执行事实，不做别的副作用。
 */
function registerProbeTool(): void {
  probeTool = defineTool({
    id: TOOL_ID,
    name: TOOL_NAME,
    description: `Live Test danger probe ${TOOL_NAME}`,
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    safetyLevel: "DANGER",
    lightweightPolicy: "confirm",
    source: "local",
    sourceId: "",
    mode: "pet",
    actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "external_side_effect", mode: "sequential", isolation: "exclusive_effect", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async (_params, ctx) => {
    const sessionId = ctx.sessionId ?? ""
    probeCalls.push({
      sessionId,
      runGeneration: ctx.runGeneration ?? -1,
      slotGeneration: sessionId ? harnessSlots.snapshot(sessionId)?.generation ?? -1 : -1,
    })
    return { success: true, content: "probe-executed" }
  })
  register(probeTool)
}

/** 计划步骤产出证据（PLAN-09②）：条目在父会话里，按 customType 收窄读回。 */
async function stepResults(sessionId: string): Promise<PlanStepResult[]> {
  const results: PlanStepResult[] = []
  for (const entry of await readPiSessionEntriesOnce(sessionId, { customType: PLAN_STEP_RESULT_ENTRY, order: "asc" })) {
    if (entry.type !== "custom") continue
    results.push(entry.data as unknown as PlanStepResult)
  }
  return results
}

/**
 * 只在断言阶段清理：注销工具 + 恢复配置（setOverride 会连带写盘，不能把测试值留在配置里）。
 * 幂等：重复调用只会再写一次相同的值，注销已注销的工具与已经换回的 provider 都是空操作。
 */
function cleanup(): void {
  unregister(TOOL_ID)
  probeTool = undefined
  if (assistantBefore !== undefined) setOverride("general.mode.assistant", assistantBefore)
  if (planEnabledBefore !== undefined) setOverride("ai.plan.enabled", planEnabledBefore)
  provider?.restore()
  provider = undefined
}

/**
 * 断言失败时的立即收尾。
 *
 * 运行器遇到失败的断言会 `break` 掉本场景的后续断言（scene-runner），
 * 清理挂在「最后一条断言」的 `finally` 上就永远等不到执行 —— 助手模式与计划开关会跟着
 * 泄漏进同一个进程里后面的场景，并被 setOverride 的落盘写进开发配置。
 * 所以每条断言自己兜底：任何退出路径都不留配置覆盖。
 */
function cleanupOnFailure(check: AssertCheck): AssertCheck {
  return {
    type: check.type,
    run: async (ctx: AssertContext) => {
      try {
        await check.run(ctx)
      } catch (error) {
        cleanup()
        throw error
      }
    },
  }
}

/** 会话 A 侧：授权按父会话与代际入账（而不是合成 run id），同参第二次命中 grant。 */
const checkGrantBoundToSessionA: AssertCheck = {
  type: "expectSubagentGrantBoundToSessionA",
  run: async (ctx) => {
    if (ctx.output.failure) throw new Error(`会话 A 的计划回合以失败结束: ${ctx.output.failure.message}`)
    if (!ctx.output.reply.includes(MAIN_DONE_A)) {
      throw new Error(`会话 A 的计划回合没有按脚本收尾: ${JSON.stringify(ctx.output.reply)}`)
    }

    // ① 两次同参调用都真的执行了（handler 只在放行后跑）：授权没绑定父会话时这里是 0 次。
    const callsA = probeCalls.filter(call => call.sessionId === sessionA)
    if (callsA.length !== 2) {
      throw new Error(`子代理的探针没有以父会话身份执行两次（实际 ${callsA.length} 次；全部记录 ${JSON.stringify(probeCalls)}）—— 授权身份未绑定父会话，或工具没有以 done 收场`)
    }
    const generationA = callsA[0]!.runGeneration
    if (!Number.isSafeInteger(generationA) || generationA < 1) {
      throw new Error(`子代理拿到的 runGeneration=${generationA}，不是父回合代际（合成的 0 表示仍落在无会话档）`)
    }
    if (callsA.some(call => call.runGeneration !== generationA)) {
      throw new Error(`同一次计划回合里子代理的许可代际不一致: ${JSON.stringify(callsA)}`)
    }
    if (callsA.some(call => call.slotGeneration !== call.runGeneration)) {
      throw new Error(`子代理的许可代际与父槽代际不一致: ${JSON.stringify(callsA)} —— 授权没有绑定父槽代际`)
    }

    // 第二次同参调用必须命中 grant：确认请求只有一次。
    const confirmsA = confirmRecords().filter(record => record.toolName === TOOL_NAME)
    if (confirmsA.length !== 1 || !confirmsA[0]!.approved) {
      throw new Error(`会话 A 的确认请求不是恰好一次（实际 ${confirmsA.length} 次，${JSON.stringify(confirmsA)}）：第二次同参调用没有命中 allow_session grant`)
    }

    // 步骤证据：步骤子代理成功且确实调用了两次工具。
    const stepsA = await stepResults(sessionA)
    if (stepsA.length !== 1) throw new Error(`会话 A 的 plan_step_result 条目不是 1 条: ${stepsA.length}`)
    if (!stepsA[0]!.success || stepsA[0]!.toolCallsMade !== 2) {
      throw new Error(`会话 A 的步骤子代理没有以两次工具调用成功收场: ${JSON.stringify(stepsA[0])}`)
    }

    // 授权确实以 (父会话, 父代际) 入账：同工具同参数用父身份重新评估仍是 allow。
    if (!probeTool) throw new Error("探针工具在断言阶段已注销，场景状态异常")
    const rebound = await evaluateToolPermission(probeTool, PARAMS, {
      mode: "pet", sessionId: sessionA, runGeneration: generationA, toolCallId: "sf20-rebind-a",
      policy: freezePermissionPolicy(),
    })
    if (rebound.decision !== "allow") {
      throw new Error(`子代理的 allow_session 授权没有按父会话与代际入账：同参重评估得到 ${rebound.decision}${rebound.reason ? `（${rebound.reason}）` : ""}`)
    }

    // ② 切到会话 B（新建并切换，与 switchToSession 同一个清 scope 点）；③ 会话 A 的 grant 必须已被清掉。
    const meta = await createNewSession()
    sessionB = meta.id
    if (!sessionB || sessionB === sessionA) throw new Error("新建会话没有切换活跃会话")
    const afterSwitch = await evaluateToolPermission(probeTool, PARAMS, {
      mode: "pet", sessionId: sessionA, runGeneration: generationA, toolCallId: "sf20-after-switch",
      policy: freezePermissionPolicy(),
    })
    if (afterSwitch.decision !== "ask" || !afterSwitch.request) {
      throw new Error(`会话 A 的授权没有随切会话清 scope：同参重评估得到 ${afterSwitch.decision}（应为 ask 且带新的确认请求）`)
    }

    // 会话 B 的回合脚本：下一个 turn 驱动会话 B，同工具同参数必须重新确认。
    provider?.appendResponses(turnScript(STEP_DONE_B, MAIN_DONE_B, "sf20-b"))
  },
}

/** 会话 B 侧：同参调用不得命中会话 A 的旧 grant，必须重新确认。 */
const checkGrantNotReusedAcrossSessions: AssertCheck = {
  type: "expectSubagentGrantRequiresFreshConfirm",
  run: async (ctx) => {
    try {
      if (ctx.output.failure) throw new Error(`会话 B 的计划回合以失败结束: ${ctx.output.failure.message}`)
      if (!ctx.output.reply.includes(MAIN_DONE_B)) {
        throw new Error(`会话 B 的计划回合没有按脚本收尾: ${JSON.stringify(ctx.output.reply)}`)
      }

      const callsB = probeCalls.filter(call => call.sessionId === sessionB)
      if (callsB.length !== 2) {
        throw new Error(`会话 B 的子代理探针没有以会话 B 身份执行两次（实际 ${callsB.length} 次；全部记录 ${JSON.stringify(probeCalls)}）`)
      }
      const generationB = callsB[0]!.runGeneration
      if (!Number.isSafeInteger(generationB) || generationB < 1) {
        throw new Error(`会话 B 的子代理 runGeneration=${generationB}，不是父回合代际`)
      }
      if (callsB.some(call => call.slotGeneration !== call.runGeneration)) {
        throw new Error(`会话 B 的子代理许可代际与父槽代际不一致: ${JSON.stringify(callsB)}`)
      }

      // ② 旧 grant 不得跨会话命中：会话 B 的同参调用必须产生一次新的确认请求（总计 2 次）。
      const confirms = confirmRecords().filter(record => record.toolName === TOOL_NAME)
      if (confirms.length !== 2) {
        throw new Error(`会话 B 的同工具同参调用没有重新确认：确认请求共 ${confirms.length} 次（应为 2 —— 会话 A、B 各一次）：${JSON.stringify(confirms)}`)
      }
      if (!confirms.every(record => record.approved)) {
        throw new Error(`确认通道的应答不是全部放行: ${JSON.stringify(confirms)}`)
      }

      // 会话 B 的第二次同参调用命中 B 自己的 grant（而不是 A 的）。
      if (!probeTool) throw new Error("探针工具在断言阶段已注销，场景状态异常")
      const reboundB = await evaluateToolPermission(probeTool, PARAMS, {
        mode: "pet", sessionId: sessionB, runGeneration: generationB, toolCallId: "sf20-rebind-b",
        policy: freezePermissionPolicy(),
      })
      if (reboundB.decision !== "allow") {
        throw new Error(`会话 B 的 allow_session 授权没有按会话 B 入账：同参重评估得到 ${reboundB.decision}`)
      }

      const stepsB = await stepResults(sessionB)
      if (stepsB.length !== 1) throw new Error(`会话 B 的 plan_step_result 条目不是 1 条: ${stepsB.length}`)
      if (!stepsB[0]!.success || stepsB[0]!.toolCallsMade !== 2) {
        throw new Error(`会话 B 的步骤子代理没有以两次工具调用成功收场: ${JSON.stringify(stepsB[0])}`)
      }
    } finally {
      cleanup()
    }
  },
}

export const 子代理授权范围: SceneDef = {
  meta: {
    caseId: "safety-subagent-grant-scope",
    module: "safety",
    contractId: "sf-20",
    description: "子代理内的 allow_session 授权绑定父会话与代际：切会话后同参 grant 不得命中，必须重新确认",
    depth: "deep",
    suite: "safety",
    entry: "runtime",
    // 探针是 DANGER 工具：测试宿主没有 ChatPanel，确认由通道按场景策略确定性应答
    // （approve → resolveConfirm(true) → `allow_session`，这正是本场景要验证的授权形态）。
    confirmPolicy: "approve",
    planPolicy: "auto",
    tags: ["safety", "boundary", "cancel"],
  },
  setup: async () => {
    probeCalls = []
    sessionA = ""
    sessionB = ""
    // 计划段只认助手模式（runtime 的计划分支入口条件）；enabled 让场景不依赖用户配置。
    // 两者都在断言阶段恢复 —— setOverride 会连带写盘，不能把测试值留在开发配置里。
    assistantBefore ??= generalConfig.assistantMode
    planEnabledBefore ??= planConfig.enabled
    setOverride("general.mode.assistant", true)
    setOverride("ai.plan.enabled", true)

    // setup 抛错时运行器直接结束本场景（后面的断言一个都不跑），覆盖必须在这里就收尾
    try {
      registerProbeTool()
      provider = installFakeProvider(turnScript(STEP_DONE_A, MAIN_DONE_A, "sf20-a"))
      await initChat()
      sessionA = getActiveSessionId()
      if (!sessionA) throw new Error("initChat 之后没有活跃会话")
    } catch (error) {
      cleanup()
      throw error
    }
  },
  turns: [
    {
      index: 1,
      description: "会话 A：子代理的 allow_session 授权按父会话与代际入账，同参第二次命中 grant",
      userText: USER_TEXT,
      checks: [cleanupOnFailure(checkGrantBoundToSessionA)],
    },
    {
      index: 2,
      description: "切到会话 B 后同工具同参数：不得命中旧 grant，必须重新确认",
      userText: USER_TEXT,
      checks: [cleanupOnFailure(checkGrantNotReusedAcrossSessions)],
    },
  ],
}

export default 子代理授权范围
