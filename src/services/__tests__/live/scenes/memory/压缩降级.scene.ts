import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import type { Entry } from "@earendil-works/pi-agent-core"
import { COMPACTION_DECLINED_ENTRY, PROMPT_SNAPSHOT_ENTRY, compactionSettingsFor, compactActiveSession } from "@/services/engine/pi"
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
// - 原文条目与正常回合都不受影响。「不受影响」的口径是**原文条目一条不少且逐字不变**，
//   不是「条目集合一模一样」—— 失败压缩自己会新增证据条目（这次一次性摘要请求的
//   deskpet.prompt_snapshot 两档 + 上面那条降级审计），它们不是对原文的改动。
//
// 载荷沿用 保留守卫/摘要投影口径：两段长正文让上游切点落在第二段上，第一轮整体进摘要范围。
//
// 载荷必须在**模块求值期**算好：`turns[].userText` 是模块级字面量，setup 里再赋值给变量
// 不会回填到已经拼好的字符串（2026-09-24 W5 整轮的实测现场：padding 为空 ⇒ 两轮只有「第二轮：」，
// 会话远小于保留窗口 ⇒ 上游切不出可摘要范围 ⇒ /compact 按 declined 如实拒绝，
// 摘要内核一次都没被调用，四条断言全部连带失败）。所以这里与 保留守卫 一样用模块级常量。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const KEEP_MARGIN = 1.05
const UNIT = "压缩降级探针正文必须留在磁盘中。"   // 16 字符
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS)
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = (recent: number) => UNIT.repeat(Math.ceil(recent * 4 * KEEP_MARGIN / 2 / UNIT.length))
const PADDING = LONG(SETTINGS.keepRecentTokens)
const PAD_USER = (round: string): string => `${round}：${PADDING}`
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

/** 断言失败时带上真实口径，别让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、保留窗口 ${SETTINGS.keepRecentTokens}；尾段两段长正文合计 ${PADDING.length * 2} 字符`
    + `（约 ${(PADDING.length * 2 / 4 / SETTINGS.keepRecentTokens).toFixed(2)} 倍保留窗口，上游按 chars/4 计）`
}

/**
 * 载荷前提：尾段两段长正文（上游按 chars/4 估算）必须越过保留窗口，否则上游切不出可摘要范围，
 * `/compact` 会在到达摘要内核之前就按 declined 拒绝 —— 那时本场景什么都证明不了。
 * 放在 setup 里显式失败：配置窗口/载荷推导漂移时直接给出可读原因，而不是让断言去猜。
 */
function assertPayloadPremise(): void {
  if (PADDING.length === 0 || PADDING.length * 2 / 4 <= SETTINGS.keepRecentTokens) {
    throw new Error(`场景载荷前提不成立：尾段两段长正文切不出可摘要范围｜${sizing()}`)
  }
}

/** 会话条目快照：压缩前后对照用（条目本身 + 聊天视图的用户/助手正文序列）。 */
async function entryShape(): Promise<{ entries: Entry[]; users: string[]; assistants: string[] }> {
  const entries = await sessionEntries()
  const messages = await sessionMessages()
  return {
    entries,
    users: messages.filter(message => message.role === "user").map(message => message.text),
    assistants: assistantTexts(messages),
  }
}

/**
 * 失败的压缩允许新增的条目 —— 都是这次一次性摘要请求自己的证据，不是对原文的改动：
 * - `deskpet.prompt_snapshot`：请求 payload 与响应 usage 两档（失败响应同样记用量与偏差对账）；
 * - `deskpet.compaction_declined`：内核失败后由槽落盘的降级审计条目（mm-25 要求它存在）。
 * 返回 undefined = 原文之外不该出现的条目。
 */
function compactionEvidence(entry: Entry): "snapshot" | "declined" | undefined {
  if (entry.type !== "custom") return undefined
  if (entry.customType === PROMPT_SNAPSHOT_ENTRY) return "snapshot"
  if (entry.customType === COMPACTION_DECLINED_ENTRY) return "declined"
  return undefined
}

/** 错误文案里的条目身份：条目可能带着 8 万字符的正文，报告里只留类型、id 与序列化长度。 */
function entryBrief(entry: Entry): string {
  return `${entry.type}${entry.type === "custom" ? `/${entry.customType}` : ""}#${entry.id}`
    + `(${JSON.stringify(entry).length} 字符)`
}

/** 两段序列化的首个差异位置：改写对照用，避免把整份正文塞进错误消息。 */
function divergence(before: string, after: string): string {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index++
  return `首个差异在第 ${index} 字符：before=${JSON.stringify(before.slice(index, index + 120))}`
    + ` after=${JSON.stringify(after.slice(index, index + 120))}`
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
    assertPayloadPremise()
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
      userText: PAD_USER("第二轮"),
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
      userText: PAD_USER("第三轮"),
      checks: [
        { type: "expectProbePayloadInSession", run: async () => {
          // 场景前提：两段长正文真的作为用户条目进了会话。缺了它们上游就没有可摘要范围，
          // 后面每一条断言都会因为「压缩压根没走到摘要内核」而失真 —— 这里先如实失败。
          const users = (await sessionMessages()).filter(message => message.role === "user").map(message => message.text)
          for (const round of ["第二轮", "第三轮"]) {
            const expected = PAD_USER(round)
            if (!users.includes(expected)) {
              throw new Error(`场景载荷没有进入会话条目：缺少「${round}：…」（${PADDING.length} 字符）`
                + `，现有用户条目长度 ${JSON.stringify(users.map(text => text.length))}｜${sizing()}`)
            }
          }
        } },
        { type: "expectCompactCommandFailure", run: async () => {
          const before = await entryShape()
          const text = await compactCommand.execute() ?? ""
          if (!text.startsWith("未压缩")) throw new Error(`/compact 没有报「未压缩」：${text}`)
          if (text.includes("压缩完成")) throw new Error(`/compact 把失败的压缩报成完成：${text}`)
          // 「没有可安全摘要的完整旧轮次」是上游/宿主在**摘要内核之前**的空范围拒绝，不是内核失败：
          // 走到这条说明本场景没验证到 mm-25 的失败可见性，单独给出口径，不混进产品断言。
          if (text.includes("没有可安全摘要的完整旧轮次")) {
            throw new Error(`压缩没有到达摘要内核就被空范围拒绝（/compact=${text}）：载荷/切点前提不成立｜${sizing()}`)
          }
          if (!text.includes("摘要格式无效")) throw new Error(`/compact 的失败文案没有给出原因：${text}`)
          if (summaryRequests.length !== 1) throw new Error(`坏摘要请求应为 1 次，实际 ${summaryRequests.length} 次`)
          // 原文条目保持完整：压缩前已有的条目一条不少、逐字不变（按 id 对齐；丢失与改写都在这里显形）。
          const after = await entryShape()
          const beforeIds = new Set(before.entries.map(entry => entry.id))
          const afterById = new Map(after.entries.map(entry => [entry.id, entry]))
          for (const entry of before.entries) {
            const kept = afterById.get(entry.id)
            if (kept === undefined) throw new Error(`失败的压缩丢掉了原文条目 ${entryBrief(entry)}`)
            const [was, now] = [JSON.stringify(entry), JSON.stringify(kept)]
            if (was !== now) {
              throw new Error(`失败的压缩改写了原文条目 ${entryBrief(entry)}：${divergence(was, now)}`)
            }
          }
          // 允许的新增只有这次失败压缩自己的证据（两档快照 + 一条降级审计），不是「原文被改动」。
          // 逐条分类而不是只比条数：多一条、换一类都如实失败。
          const added = after.entries.filter(entry => !beforeIds.has(entry.id))
          const snapshots = added.filter(entry => compactionEvidence(entry) === "snapshot")
          const declineAudits = added.filter(entry => compactionEvidence(entry) === "declined")
          if (added.length !== 3 || snapshots.length !== 2 || declineAudits.length !== 1) {
            throw new Error(`失败的压缩新增了预期外的条目（快照 ${snapshots.length}/2、降级审计 ${declineAudits.length}/1）：`
              + `${JSON.stringify(added.map(entry => entryBrief(entry)))}｜${sizing()}`)
          }
          // 聊天视图同样不因失败的压缩改变（快照与审计条目不进读模型）。
          if (JSON.stringify(after.users) !== JSON.stringify(before.users)
            || JSON.stringify(after.assistants) !== JSON.stringify(before.assistants)) {
            throw new Error(`失败的压缩改动了聊天视图：用户条目 ${before.users.length} → ${after.users.length}`
              + `、助手条目 ${before.assistants.length} → ${after.assistants.length}`
              + `（用户正文长度 ${JSON.stringify(before.users.map(item => item.length))}`
              + ` → ${JSON.stringify(after.users.map(item => item.length))}）`)
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
          // 一条都没有时单独报（不能靠「0 === 0」过检，也绝不能取不到条目后崩在解引用上）。
          if (declined.length === 0) {
            throw new Error(`两次失败的压缩没有留下任何 deskpet.compaction_declined 审计条目`
              + `（摘要请求 ${summaryRequests.length} 次）：内核失败路径没有走到，或审计条目没有落盘｜${sizing()}`)
          }
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
