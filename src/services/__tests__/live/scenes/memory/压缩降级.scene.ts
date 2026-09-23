import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { COMPACTION_DECLINED_ENTRY, compactionSettingsFor, compactActiveSession } from "@/services/engine/pi"
import { compactCommand } from "@/services/engine/slash/commands/compact"
import { aiConfig } from "@/services/config"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { assistantTexts, compactionEntries, countTexts, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：摘要内核失败必须显式 decline（不落上游通用英文摘要） ──
//
// 宿主 before_compaction 内核抛错时，钩子返回 {decline:true}：上游据此 publishStructuralOutcome
// (kind:"declined")，既不提交 compaction 条目、也不回退它自己的通用摘要（那条摘要一旦提交就是
// 后续所有回合唯一的历史视图且不可回滚）。代价与原因都要可见：
// - /compact 报「未压缩：<原因>」；
// - compactActiveSession 返回 {status:"failed"}；
// - 会话里留一条 deskpet.compaction_declined 审计条目；
// - 原文条目与正常回合都不受影响。
//
// 载荷沿用 保留守卫/摘要投影口径：两段长正文让上游切点落在第二段上，第一轮整体进摘要范围。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const KEEP_MARGIN = 1.05
const UNIT = "压缩降级探针正文必须留在磁盘中。"   // 18 字符
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = (recent: number) => UNIT.repeat(Math.ceil(recent * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = "第一轮：记住这句话，之后压缩如果失败原文必须还在。"

/** 摘要请求收到非 JSON 正文 → parseStructuredSummary 失败 → 摘要内核抛「摘要格式无效」。 */
const BAD_SUMMARY = "这不是 JSON"

const summaryRequests: string[] = []

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 坏摘要脚本专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
const badSummaryStep: FauxResponseStep = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`坏摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(BAD_SUMMARY)
}

let provider: ReturnType<typeof installFakeProvider> | undefined
let padding = ""

/** 断言失败时带上真实口径，别让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${FAKE_MODEL.contextWindow}、保留窗口按预算推导；tail ${padding.length} 字符`
}

/** 会话条目快照：压缩前后对照用（条数 + 用户/助手正文序列）。 */
async function entryShape(): Promise<{ count: number; users: string[]; assistants: string[] }> {
  const entries = await sessionEntries()
  const messages = await sessionMessages()
  return {
    count: entries.length,
    users: messages.filter(message => message.role === "user").map(message => message.text),
    assistants: assistantTexts(messages),
  }
}

export const 压缩降级: SceneDef = {
  meta: {
    caseId: "memory-compaction-degrade-declines",
    module: "memory",
    contractId: "mm-25",
    description: "摘要内核失败时显式 decline：/compact 报失败并给出原因，不提交 compaction 条目，留降级审计条目",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "error"],
  },
  setup: async () => {
    padding = LONG(compactionSettingsFor(WINDOW_TOKENS).keepRecentTokens)
    summaryRequests.length = 0
    provider = installFakeProvider([
      fakeText("第一轮回复完成。"),
      fakeText("第二轮回复完成。"),
      fakeText("第三轮回复完成。"),
      badSummaryStep,
      badSummaryStep,
      fakeText("压缩降级后的正常回复。"),
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "第一轮正文进入会话，作为后面摘要范围的覆盖目标",
      userText: FIRST,
      checks: [{ type: "expectFirstTurn", run: async () => {
        if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
      } }],
    },
    {
      index: 2,
      description: "垫入第一段长正文：仍不该有任何自动压缩",
      userText: `第二轮：${padding}`,
      checks: [{ type: "expectNoCompactionYet", run: async () => {
        const compactions = compactionEntries(await sessionEntries())
        if (compactions.length !== 0) {
          throw new Error(`载荷在场景准备阶段就触发了自动压缩（${compactions.length} 条）｜${sizing()}`)
        }
      } }],
    },
    {
      index: 3,
      description: "手动压缩两次都遇到坏摘要：命令报失败、内核返回 failed、留降级条目、原文不动",
      userText: `第三轮：${padding}`,
      checks: [
        { type: "expectCompactCommandFailure", run: async () => {
          const before = await entryShape()
          const text = await compactCommand.execute() ?? ""
          if (!text.startsWith("未压缩")) throw new Error(`/compact 没有报「未压缩」：${text}`)
          if (text.includes("压缩完成")) throw new Error(`/compact 把失败的压缩报成完成：${text}`)
          if (!text.includes("摘要格式无效")) throw new Error(`/compact 的失败文案没有给出原因：${text}`)
          if (summaryRequests.length !== 1) throw new Error(`坏摘要请求应为 1 次，实际 ${summaryRequests.length} 次`)
          // 原文条目与聊天视图都不因失败的压缩改变。
          const after = await entryShape()
          if (JSON.stringify(after) !== JSON.stringify(before)) {
            throw new Error(`失败的压缩改动了会话条目：${JSON.stringify(before)} → ${JSON.stringify(after)}`)
          }
          if (compactionEntries(await sessionEntries()).length !== 0) throw new Error("decline 的压缩提交了 compaction 条目")
        } },
        { type: "expectCompactApiFailure", run: async () => {
          // 第二次：直接走运行时入口，验证返回形态（命令层只是它的文案）。
          const outcome = await compactActiveSession(getActiveSessionId())
          if (outcome.status !== "failed") throw new Error(`compactActiveSession 没有报 failed：${outcome.status}`)
          if (!outcome.error?.includes("摘要格式无效")) throw new Error(`失败没有带上内核原因：${outcome.error ?? "(空)"}`)
          if (summaryRequests.length !== 2) throw new Error(`坏摘要请求应为 2 次，实际 ${summaryRequests.length} 次`)
        } },
        { type: "expectDeclinedAuditEntry", run: async () => {
          const entries = await sessionEntries()
          const declined = entries.filter(entry => entry.type === "custom" && entry.customType === COMPACTION_DECLINED_ENTRY)
          // 每次失败的压缩各留一条：条目数应与摘要请求数一致（证据与事实一一对应）。
          if (declined.length !== summaryRequests.length) {
            throw new Error(`降级审计条目与失败压缩次数不一致：${declined.length} 条 vs ${summaryRequests.length} 次｜${sizing()}`)
          }
          const data = (declined[declined.length - 1] as { data?: Record<string, unknown> }).data ?? {}
          if (data.status !== "declined" || data.reason !== "manual") {
            throw new Error(`降级条目缺少终态/原因: ${JSON.stringify(data)}`)
          }
          if (typeof data.error !== "string" || !data.error.includes("摘要格式无效")) {
            throw new Error(`降级条目没有带上内核失败原因: ${JSON.stringify(data.error)}`)
          }
          if (compactionEntries(entries).length !== 0) throw new Error("decline 之后出现了 compaction 条目")
        } },
        { type: "expectTurnStillWorks", run: async () => {
          // 对照：decline 只影响压缩，不污染正常回合。
          const result = await sendMessage("再正常回一轮。")
          if (result.failure) throw new Error(`压缩降级后的正常回合失败：${result.failure.message}`)
          const texts = assistantTexts(await sessionMessages())
          if (countTexts(texts, "压缩降级后的正常回复。") !== 1) {
            throw new Error(`正常回合的回复没有恰好落盘一次：${JSON.stringify(texts.slice(-3))}`)
          }
          // 原文仍在：失败两次的压缩没有动过第一轮正文。
          const users = (await sessionMessages()).filter(message => message.role === "user").map(message => message.text)
          if (!users.includes(FIRST)) throw new Error("第一轮正文在压缩降级后丢失")
          if (compactionEntries(await sessionEntries()).length !== 0) throw new Error("正常回合触发了压缩")
        } },
      ],
    },
  ],
}

export default 压缩降级
