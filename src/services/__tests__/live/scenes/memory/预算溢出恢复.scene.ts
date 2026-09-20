import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { contextBudget, estimateRequestTokens } from "@/services/context"
import { compactionSettingsFor, harnessSlots } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session"
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
//   身上，压缩后的请求视图只剩「摘要 + B + 静态」，重试因此放得进硬预算；
// - 第三段 C：单独超过 H，压缩切点仍落在它身上 —— 压缩只吸收了它之前的历史，
//   重试视图「摘要 + C + 静态」照样超限，Harness 的一次性恢复因此用尽（providerError）；
// - 第四段 D：短载荷。上一轮的压缩已经把 C 之前的一切收进摘要，切点累积到 C（虚拟保留段）
//   就停住，可摘要范围为空 —— 上游以 compaction_declined 结束，失败分类保留上游文案，
//   宿主回复回落本回合的预算判定。
//
// 保留窗口按上游 chars/4 计，所以「谁单独超过保留窗口」要用字符数比 R。
// 后两条失败路径由期望失败声明（turn.expectFailure）承载：回合必须以声明的分类与文案失败，
// 正常完成或换成别的失败都判失败 —— 预期失败不是「允许失败」。
// 判定上报本身由 预算溢出判定 场景以 unit 断言把关。
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
const THIRD_PREFIX = "第三段恢复用尽载荷："
const FOURTH_PREFIX = "第四段无摘要范围载荷："
const FIRST = `${FIRST_PREFIX}${payload(Math.floor(BUDGET.hardInputLimit * .75))}`
const SECOND = `${SECOND_PREFIX}${payload(Math.max(Math.ceil(RETAINED_CHARS * 1.1), Math.floor(BUDGET.hardInputLimit * .75)))}`
/**
 * 第三段：正文本身就超过硬输入上限（留 4k 余量），压缩只能吸收它之前的历史，
 * 重试视图因此照样超限 —— 恢复只有一次，第二次溢出就落到 providerError。
 */
const THIRD = `${THIRD_PREFIX}${payload(BUDGET.hardInputLimit + 4096)}`
/** 第四段：短载荷。超限不是由它造成的（第三段还在请求视图里），它只负责触发下一次恢复筹备。 */
const FOURTH = `${FOURTH_PREFIX}${payload(160)}`

const SUMMARY_MARKER = "溢出恢复必须压缩在重试之前"
const RECOVERY_MARKER = "恢复用尽之前必须完成一次压缩"
function summary(intent: string, fact: string): string {
  return JSON.stringify({
    intent,
    facts: [fact],
    corrections: [],
    pending: ["核对 compaction 条目"],
    continuity: ["本次使用 fake provider"],
    nextSteps: ["检查原文条目是否保留"],
  })
}
const SUMMARY = summary(SUMMARY_MARKER, "宿主硬预算超限由 Harness 压缩后重试吸收")
/** 第三段那次的摘要：它覆盖的是超限载荷之前的历史，不是超限载荷自己。 */
const RECOVERY_SUMMARY = summary(RECOVERY_MARKER, "第二次溢出不再有可摘要的空间，恢复用尽")

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
function summaryStep(text: string): FauxResponseStep {
  return context => {
    const request = lastMessageText(context)
    if (!request.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${request.slice(0, 60)}｜${sizing()}`)
    record(context)
    return fakeText(text)
  }
}

function replyStep(text: string): FauxResponseStep {
  return context => {
    record(context)
    return fakeText(text)
  }
}

/**
 * 本回合的硬预算判定文案：`ContextBudgetError` 的正文。
 *
 * 「恢复用尽」把它作为失败文案上报；「没有可摘要范围」declined 时失败分类保留上游文案，
 * 回复回落的也是它 —— 两条路径都靠这条判定把「本回合的预算结论」和别的原因分开。
 */
function budgetVerdict(): RegExp {
  return new RegExp(`上下文需要约 \\d+ tokens，超过可用 ${BUDGET.hardInputLimit} tokens`)
}

/** 会话真相源里必须仍有这几段原文条目：压缩与失败都不改写已提交的写入。 */
async function expectOriginalEntries(sections: readonly (readonly [string, string])[]): Promise<void> {
  const texts = (await sessionMessages()).map(message => message.text)
  for (const [label, prefix] of sections) {
    if (!texts.some(text => text.startsWith(prefix))) throw new Error(`会话条目里丢掉了${label}的原文`)
  }
}

export const 预算溢出恢复: SceneDef = {
  meta: {
    caseId: "memory-budget-overflow-recovery",
    module: "memory",
    contractId: "mm-22",
    description: "宿主硬预算超限改走 Harness 溢出恢复：本地拦下超限请求，压缩提交后重试一次，回合照常完成且原文条目保留；恢复用尽与无可摘要范围两条失败路径按预期失败判定",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "budget", "boundary", "error"],
  },
  setup: async () => {
    requests.length = 0
    requestCosts.length = 0
    installFakeProvider([
      replyStep("第一轮回复完成。"),
      summaryStep(SUMMARY),
      replyStep("第二轮回复完成。"),
      // 第三段的两次超限请求都被宿主拦下（不发 Provider），只有摘要请求会取走这条脚本；
      // 第四段连摘要请求都到不了 —— 脚本到这里正好用完。
      summaryStep(RECOVERY_SUMMARY),
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
    {
      index: 3,
      description: "第三段单独超过硬预算：压缩一次后重试仍超限，恢复用尽并回落硬预算判定",
      userText: THIRD,
      // 失败分类从文案派生（runtime 的 classifyTurnFailure），预算判定文案里带估算值，
      // 同一个失败会落在 unknown 或 provider；路径本身由判定文案（含本回合硬上限）钉住。
      expectFailure: { kind: ["unknown", "provider"], message: budgetVerdict() },
      checks: [{ type: "expectOverflowRecoveryExhausted", run: async context => {
        // 1) 用户可见回复就是本回合的硬预算判定（失败文案同一句话，由 expectFailure 的匹配器钉住）
        if (!budgetVerdict().test(context.output.reply)) {
          throw new Error(`恢复用尽的回复不是硬预算判定: ${context.output.reply.slice(0, 80)}｜${sizing()}`)
        }
        if (context.output.retriesUsed !== 0) throw new Error(`恢复用尽不应消耗 Harness 重试预算: ${context.output.retriesUsed}`)

        // 2) 恢复用尽之前确实压缩过一次，且摘要来自宿主 before_compaction 内核
        const compactions = compactionEntries(await sessionEntries())
        if (compactions.length !== 2) {
          throw new Error(`第三回合的压缩次数异常: ${compactions.length}（期望第二轮一次 + 本回合一次）`)
        }
        const recovery = compactions[1]!
        if (!recovery.fromHook || !recovery.summary.includes(RECOVERY_MARKER)) {
          throw new Error("恢复用尽前的压缩不是宿主 before_compaction 内核提交的")
        }

        // 3) 两次超限请求（首次 + 压缩后的重试）都没有发给 Provider：
        //    本回合到达 Provider 的只有摘要请求，且摘要范围不覆盖超限载荷本身。
        const thirdTurnRequests = requests.slice(3)
        if (thirdTurnRequests.length !== 1) {
          throw new Error(`第三回合到达 Provider 的请求次数异常: ${thirdTurnRequests.length}（期望只有摘要请求，超限的首次与重试都不该发出）`)
        }
        if (!thirdTurnRequests[0]?.includes(SECOND_PREFIX) || thirdTurnRequests[0]?.includes(THIRD_PREFIX)) {
          throw new Error("恢复用尽前的摘要范围不对：应覆盖第二段历史，且不包含本回合的超限载荷")
        }

        // 4) 压缩只改请求视图：三段原文条目一条不少（失败不清空已提交的写入）
        await expectOriginalEntries([["第一段", FIRST_PREFIX], ["第二段", SECOND_PREFIX], ["第三段", THIRD_PREFIX]])
      } }],
    },
    {
      index: 4,
      description: "第三段仍占满请求视图：没有可安全摘要的范围，上游 declined，失败分类保留上游文案、回复回落本回合判定",
      userText: FOURTH,
      // 这条路径的失败文案是上游的固定文案（无数字），分类稳定落在 unknown。
      expectFailure: { kind: "unknown", message: "Overflow compaction was declined" },
      checks: [{ type: "expectOverflowCompactionDeclined", run: async context => {
        // 1) 展示文案回落到本回合的预算判定，上游 decline 文案没有漏进回复
        if (!budgetVerdict().test(context.output.reply)) {
          throw new Error(`declined 后没有回落到本回合的硬预算判定: ${context.output.reply.slice(0, 80)}｜${sizing()}`)
        }
        if (context.output.reply.includes("Overflow compaction was declined")) {
          throw new Error("上游 decline 文案漏进了用户可见回复")
        }

        // 2) decline 之前没有发出摘要请求（连 Provider 都没到），也没有提交 compaction 条目
        if (requests.length !== 4) {
          throw new Error(`declined 的回合到达 Provider 的请求次数异常: ${requests.length}（期望仍为前三个回合的 4 次）`)
        }
        const compactions = compactionEntries(await sessionEntries())
        if (compactions.length !== 2) {
          throw new Error(`declined 仍提交了 compaction 条目: ${compactions.length}`)
        }
        if ((harnessSlots.snapshot(getActiveSessionId())?.contextEpoch ?? 0) !== 2) {
          throw new Error("declined 推进了上下文换代身份")
        }

        // 3) 原文条目一条不少：decline 不改写会话真相源
        await expectOriginalEntries([
          ["第一段", FIRST_PREFIX], ["第二段", SECOND_PREFIX],
          ["第三段", THIRD_PREFIX], ["第四段", FOURTH_PREFIX],
        ])
      } }],
    },
  ],
}

export default 预算溢出恢复
