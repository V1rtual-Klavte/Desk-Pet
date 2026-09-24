import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { aiConfig, getOverride, setOverride } from "@/services/config"
import { contextBudget } from "@/services/context"
import { setSessionSafetyMode } from "@/services/debug"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { PLAN_CHECKPOINT_ENTRY } from "@/services/agent/memory"
import { entryMessageText, sessionEntries } from "../../session-entries"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

/**
 * 输入先落盘（STATE-04 / §7 决策 #16 方案 B）：用户条目在计划与预检之前就提交进会话文件。
 *
 * 两条路径共用一个不变量「先落盘、后驱动」：
 *   ① 计划回合：输入先成为会话条目（`seq` 早于本次运行写下的 `deskpet.plan_checkpoint`）——
 *      计划确认/执行期间进程被杀，输入不会丢；
 *   ② 预检失败（硬预算超限）：回合以失败结算，但已落盘的输入条目仍留在会话真相源里，恰好一条。
 *
 * 规划是一次性调用（`generatePlan` → `completePiText`）：fake provider 下按请求正文里的
 * 「用户请求:」标记派发规划脚本（与 `用量分列` 同一写法），不按 purpose 猜。
 */
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, FAKE_MODEL.contextWindow ?? 131_072)
const OUTPUT_RESERVE = contextBudget(WINDOW_TOKENS).outputReserve
const BUDGET = contextBudget(WINDOW_TOKENS, OUTPUT_RESERVE)

/** 本地估算口径下中文约 1 token/字符：按字符数逼近 token 数（与 `预算溢出恢复` 同一分档写法）。 */
const PAYLOAD_UNIT = "预检超限必须先落盘再谈判。"
function payload(chars: number): string {
  return PAYLOAD_UNIT.repeat(Math.ceil(chars / PAYLOAD_UNIT.length)).slice(0, chars)
}
/**
 * 超限正文：单独超过硬输入上限，压缩也吸收不了它本人 —— 回合必然以失败结算。
 * 失败不是本场景的观测对象（输入条目保留才是），所以只断言结算为失败，不钉失败分类与文案。
 */
const GIANT_PREFIX = "预检超限输入："
const GIANT = `${GIANT_PREFIX}${payload(BUDGET.hardInputLimit + 4096)}`

const PLAN_REQUEST = "--plan 读取配置再改写配置"
const PLAN_REQUEST_NEEDLE = "读取配置再改写配置"
/** 规划脚本要求的正文标记（`generatePlan` 的 userText 前缀）。 */
const PLAN_PROMPT_MARKER = "用户请求:"
const PLAN_JSON = '```json\n{"summary":"两步","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"}]}\n```'
const STEP_REPLY = "步骤完成"
const MAIN_REPLY = "计划执行完成"
/** 场景自己的回合（核对用）的脚本响应；它跑在计划回合之后。 */
const TURN_REPLY = "核对完成"

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 规划脚本响应：被别的请求取走就是脚本错位，立即报错。 */
function planStep(): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    if (!text.includes(PLAN_PROMPT_MARKER)) throw new Error(`规划脚本被非规划请求取走: ${text.slice(0, 60)}`)
    return fakeText(PLAN_JSON)
  }
}

/** 场景自己改的配置：按「原始覆盖值」（未必存在）还原，不把开发配置的当前值当默认值。 */
interface OverrideSnapshot {
  assistantMode: boolean | undefined
  planEnabled: boolean | undefined
  safetyMode: string | undefined
}

let snapshot: OverrideSnapshot | undefined
let sessionId = ""
let planned: Awaited<ReturnType<typeof sendMessage>> | undefined

function captureOverrides(): OverrideSnapshot {
  return {
    assistantMode: getOverride<boolean>("general.mode.assistant"),
    planEnabled: getOverride<boolean>("ai.plan.enabled"),
    safetyMode: getOverride<string>("ai.safety.mode"),
  }
}

function restoreOverrides(previous: OverrideSnapshot): void {
  setSessionSafetyMode(null)
  setOverride("general.mode.assistant", previous.assistantMode)
  setOverride("ai.plan.enabled", previous.planEnabled)
  // `safetyConfig.mode` 读的是 `ai.safety.mode`（不是 `safety.mode`）：写错 key 等于没改全局值。
  setOverride("ai.safety.mode", previous.safetyMode)
}

export const 输入先落盘: SceneDef = {
  meta: {
    caseId: "runtime-input-durable-before-plan",
    module: "agent-runtime",
    contractId: "ar-12",
    description: "计划与预检之前输入已提交为会话条目（用户条目 seq 早于 plan_checkpoint），预检失败时输入条目保留",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "session", "planner", "boundary"],
    /** 测试宿主没有 PlanConfirm 面板：按 auto 确定性应答确认（just_do_it 下确认本就不问，作为兜底）。 */
    planPolicy: "auto",
  },
  setup: async () => {
    snapshot = captureOverrides()
    installFakeProvider([
      planStep(),
      fakeText(STEP_REPLY),
      fakeText(STEP_REPLY),
      fakeText(MAIN_REPLY),
      fakeText(TURN_REPLY),
    ], FAKE_MODEL)
    // 计划入口由 assistant && planConfig.enabled 双重把守；安全模式给 just_do_it，计划段不额外等确认。
    setOverride("general.mode.assistant", true)
    setOverride("ai.plan.enabled", true)
    setOverride("ai.safety.mode", "just_do_it")
    setSessionSafetyMode("just_do_it")
    await initChat()
    sessionId = getActiveSessionId()
    planned = await sendMessage(PLAN_REQUEST)
    // 计划回合之后就把助手模式关回 pet：场景自己的回合与后面的超限路径都不该再进计划段
    //（开发配置把 complexityEval 设成 llm 时，助手模式下会多打一次评估请求、把脚本响应提前取走）。
    setOverride("general.mode.assistant", false)
  },
  turns: [{
    index: 1,
    description: "核对计划回合的输入落盘顺序与预检失败时的输入保留",
    userText: "核对上面两条路径的落盘证据。",
    checks: [{
      type: "expectInputDurableBeforePlanAndAfterPreflightFailure",
      run: async () => {
        const previous = snapshot
        if (!previous) throw new Error("场景前置状态缺失：setup 没有记录配置快照")
        try {
          // ① 计划回合正常完成（不是降级回复或空计划：失败会直接暴露在这里）。
          const planTurn = planned
          if (!planTurn) throw new Error("setup 没有完成计划回合")
          if (planTurn.failure) {
            throw new Error(`计划回合失败: ${planTurn.failure.kind}: ${planTurn.failure.message}`)
          }
          if (planTurn.outcome !== "succeeded") throw new Error(`计划回合的结算不是 succeeded: ${planTurn.outcome}`)

          // ② 计划真的走了落盘路径：本次运行写下过 deskpet.plan_checkpoint 条目。
          const entries = await sessionEntries(sessionId)
          const checkpoints = entries.filter(entry =>
            entry.type === "custom" && entry.customType === PLAN_CHECKPOINT_ENTRY)
          if (checkpoints.length === 0) throw new Error("计划回合没有写下 deskpet.plan_checkpoint 条目")
          if (checkpoints.some(entry => typeof entry.seq !== "number")) {
            throw new Error("plan_checkpoint 条目缺少 seq，无法核对落盘顺序")
          }

          // ③ 输入先落盘：用户条目 seq 早于本次运行最早一条 checkpoint。
          const userEntry = entries.find(entry =>
            entry.type === "message" && entry.message.role === "user"
            && entryMessageText(entry.message).includes(PLAN_REQUEST_NEEDLE))
          if (!userEntry) throw new Error("会话条目里没有这次计划请求的用户正文")
          if (typeof userEntry.seq !== "number") throw new Error("用户条目缺少 seq，无法核对落盘顺序")
          const firstCheckpointSeq = Math.min(...checkpoints.map(entry => entry.seq))
          if (!(userEntry.seq < firstCheckpointSeq)) {
            throw new Error(`用户条目没有在计划之前落盘: user seq=${userEntry.seq} ≥ checkpoint seq=${firstCheckpointSeq}`)
          }

          // ④ 预检失败（硬预算超限）：输入已落盘，回合按失败结算但条目必须保留、恰好一条。
          setOverride("general.mode.assistant", false)
          const failed = await sendMessage(GIANT)
          if (failed.outcome !== "failed") {
            throw new Error(`超限输入没有按失败结算: ${failed.outcome}｜窗口 ${WINDOW_TOKENS}、硬上限 ${BUDGET.hardInputLimit}、正文 ${GIANT.length} 字符`)
          }
          const afterFailure = await sessionEntries(sessionId)
          const giantEntries = afterFailure.filter(entry =>
            entry.type === "message" && entry.message.role === "user" && entryMessageText(entry.message) === GIANT)
          if (giantEntries.length !== 1) {
            throw new Error(`预检失败后超限输入条目不是恰好一条: ${giantEntries.length}（正文 ${GIANT.length} 字符）`)
          }
          // 失败不是成功：超限正文不该被当成助手正文露出来。
          const replyTexts = afterFailure.flatMap(entry =>
            entry.type === "message" && entry.message.role === "assistant" ? [entryMessageText(entry.message)] : [])
          if (replyTexts.some(text => text.includes(GIANT_PREFIX))) {
            throw new Error("超限输入被写进了助手正文")
          }
          // 预检失败不改写已提交的写入：计划条目仍在。
          const checkpointsAfter = afterFailure.filter(entry =>
            entry.type === "custom" && entry.customType === PLAN_CHECKPOINT_ENTRY)
          if (checkpointsAfter.length < checkpoints.length) {
            throw new Error("预检失败后 plan_checkpoint 条目变少了")
          }
        } finally {
          restoreOverrides(previous)
        }
      },
    }],
  }],
}

export default 输入先落盘
