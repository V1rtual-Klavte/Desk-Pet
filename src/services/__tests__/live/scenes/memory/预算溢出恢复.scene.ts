import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { contextBudget, estimateRequestTokens } from "@/services/context"
import { compactionSettingsFor } from "@/services/engine/pi"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { compactionEntries, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：硬预算超限走 Harness 的一次性溢出恢复 ──
//
// 宿主在 transform_context 核对硬预算，超限时的判定经网关上报为 Provider 响应，
// 由 Harness 按自己的溢出判据（响应上的 isRecoverableLength）压缩后重试一次。
// 场景要造出「宿主硬预算先于 Harness 阈值压缩触发」的局面，只能靠两边估算口径的差：
//
// - 本仓估算：中文约 1 token/字符；上游对会话消息按 chars/4 估（fake provider 不产生真实
//   usage 时整体走内容估算）。同一段中文正文，本仓计数是上游的 4 倍。
// - 于是上游 shouldCompact 看不到超限（它的阈值是本仓 normalInputTarget 的上游口径），
//   宿主硬预算先拦。两个口径一致时的顺序不变量由 压缩阈值口径 场景单独把关。
//
// 载荷分档（H = 硬输入上限，R = 上游保留窗口换算回字符）：
// - 第一段 A：A + 静态提示词 < H，第一轮不触发任何压缩；
// - 第二段 B：A + B + 静态 > H 触发硬预算，且 B 单独超过保留窗口 —— 压缩切点落在它本人
//   身上，压缩后的请求视图只剩「摘要 + B + 静态」，重试因此放得进硬预算。
// 保留窗口按上游 chars/4 计，所以「谁单独超过保留窗口」要用字符数比 R。
// 恢复用尽与「没有可摘要范围」两条失败路径需要刻意的失败回合，Live Test 会把带
// output.failure 的回合记成 trial 错误（scene-runner 的 errorKind 规则），无法作为通过证据，
// 因此这里只固定成功路径；判定上报本身由 预算溢出判定 场景以 unit 断言把关。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 200_000, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 200_000)
const OUTPUT_RESERVE = contextBudget(WINDOW_TOKENS).outputReserve
const BUDGET = contextBudget(WINDOW_TOKENS, OUTPUT_RESERVE)
const RETAINED_CHARS = compactionSettingsFor(WINDOW_TOKENS, OUTPUT_RESERVE).keepRecentTokens * 4

const PAYLOAD_UNIT = "硬预算超限必须先压缩再重试。"
function payload(chars: number): string {
  return PAYLOAD_UNIT.repeat(Math.ceil(chars / PAYLOAD_UNIT.length)).slice(0, chars)
}
/** 各段正文的起始标记：断言原文条目与请求视图时用它定位。 */
const FIRST_PREFIX = "第一段长历史："
const SECOND_PREFIX = "第二段超限输入："
const FIRST = `${FIRST_PREFIX}${payload(Math.floor(BUDGET.hardInputLimit * .75))}`
const SECOND = `${SECOND_PREFIX}${payload(Math.max(Math.ceil(RETAINED_CHARS * 1.1), Math.floor(BUDGET.hardInputLimit * .75)))}`

const SUMMARY_MARKER = "溢出恢复必须压缩在重试之前"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["宿主硬预算超限由 Harness 压缩后重试吸收"],
  corrections: [],
  pending: ["核对重试请求是否带上摘要"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查 compaction 条目"],
})

/** Provider 侧观察：每次请求的正文快照与本仓估算口径的请求规模（含摘要请求）。 */
const requests: string[] = []
const requestCosts: number[] = []

function record(context: Context): void {
  requests.push(flattenRequest(context))
  requestCosts.push(estimateRequestTokens(context.systemPrompt ?? "", context.messages, context.tools ?? []))
}

/** 断言失败时带上真实口径：窗口/硬上限/载荷与每次请求的估算规模。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、硬上限 ${BUDGET.hardInputLimit}、保留字符 ${RETAINED_CHARS}`
    + `；载荷 ${FIRST.length}/${SECOND.length}；请求估算 ${requestCosts.join(",")}`
}

function lastMessageText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

function flattenRequest(context: Context): string {
  const messages = context.messages.map(message => typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("\n"))
  return [context.systemPrompt ?? "", ...messages].join("\n")
}

/** 摘要脚本只应被压缩请求取走；被别的请求取走就是脚本错位，立即报错。 */
const summaryStep: FauxResponseStep = context => {
  const text = lastMessageText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}｜${sizing()}`)
  record(context)
  return fakeText(SUMMARY)
}

function replyStep(text: string): FauxResponseStep {
  return context => {
    record(context)
    return fakeText(text)
  }
}

export const 预算溢出恢复: SceneDef = {
  meta: {
    caseId: "memory-budget-overflow-recovery",
    module: "memory",
    contractId: "mm-22",
    description: "宿主硬预算超限改走 Harness 溢出恢复：本地拦下超限请求，压缩提交后重试一次，回合照常完成且原文条目保留",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "budget", "boundary", "error"],
  },
  setup: async () => {
    requests.length = 0
    installFakeProvider([
      replyStep("第一轮回复完成。"),
      summaryStep,
      replyStep("第二轮回复完成。"),
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "铺垫长历史：仍在硬预算以内，不触发任何压缩",
      userText: FIRST,
      checks: [{ type: "expectTurnCompleted", run: async context => {
        if (context.output.failure) throw new Error(`第一轮就失败: ${context.output.failure.message}`)
        if (!context.output.reply.includes("第一轮")) throw new Error(`第一轮回复不是 Provider 响应: ${context.output.reply.slice(0, 60)}`)
        if (compactionEntries(await sessionEntries()).length > 0) throw new Error("第一轮载荷已触发压缩，场景分档失效（第一段应留在硬预算以内）")
        if (requests.length !== 1) throw new Error(`第一轮 Provider 请求次数异常: ${requests.length}`)
      } }],
    },
    {
      index: 2,
      description: "第二段超过硬输入上限：本地拦下超限请求，压缩后重试",
      userText: SECOND,
      checks: [{ type: "expectBudgetOverflowRecovery", run: async context => {
        // 1) 回合照常完成：硬预算超限被一次性溢出恢复吸收，而不是直接终止
        if (context.output.failure) throw new Error(`硬预算超限没有走溢出恢复: ${context.output.failure.message}`)
        if (!context.output.reply.includes("第二轮")) throw new Error(`重试后的回复不是 Provider 响应: ${context.output.reply.slice(0, 60)}`)
        if (context.output.reply.includes("上下文需要约")) throw new Error("硬预算错误文案漏进了回复")
        if (context.output.retriesUsed !== 0) throw new Error(`溢出恢复不应消耗 Harness 重试预算: ${context.output.retriesUsed}`)

        // 2) 压缩确实由宿主摘要内核提交（reason=overflow 的一次性恢复）
        const entries = await sessionEntries()
        const compactions = compactionEntries(entries)
        if (compactions.length === 0) throw new Error("硬预算超限后没有提交 compaction 条目")
        if (!compactions.some(entry => entry.summary.includes(SUMMARY_MARKER))) {
          throw new Error("溢出恢复的摘要不是宿主 before_compaction 内核生成的")
        }

        // 3) 压缩只改请求视图：被摘要覆盖的第一段与超限的第二段原文条目都还在
        const texts = (await sessionMessages()).map(message => message.text)
        if (!texts.some(text => text.startsWith(SECOND_PREFIX))) throw new Error("压缩删除了超限载荷的原文条目")
        if (!texts.some(text => text.startsWith(FIRST_PREFIX))) throw new Error("压缩删除了被摘要覆盖的第一段原文条目")

        // 4) 顺序与边界：超限请求没有发给 Provider（本地拦下），重试带上摘要即发生在压缩之后
        const secondTurnRequests = requests.slice(1)
        if (secondTurnRequests.length !== 2) {
          throw new Error(`第二回合 Provider 请求次数异常: ${secondTurnRequests.length}（期望「摘要 + 重试」两次，超限请求不应发出）`)
        }
        if (!secondTurnRequests[1]?.includes(SUMMARY_MARKER)) throw new Error("重试请求没有带上压缩摘要，说明重试发生在压缩之前")
      } }],
    },
  ],
}

export default 预算溢出恢复
