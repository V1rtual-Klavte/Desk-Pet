import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { compactActiveSession, compactionSettingsFor, harnessSlots, PROMPT_SNAPSHOT_ENTRY, readContextEpoch } from "@/services/engine/harness"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { aiConfig } from "@/services/config"
import { installFakeProvider, fakeText, lastRequestText } from "../../../host/fake-provider"
import { compactionEntries, sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../../e2e/types"

// ── 场景口径：换代身份沿 lane 分支读取，未知时不写 0 ──
//
// `readContextEpoch` 是唯一定义点（沿分支回溯已提交的 compaction 条目）；槽快照、请求快照与
// 设置页显示共用它 —— 会话级全量计数会把其它分支的压缩算进来，读不到时写 0 又会谎称未换代。

async function usageSnapshots(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "custom" && entry.customType === PROMPT_SNAPSHOT_ENTRY
    && (entry.data as { captureStage?: unknown } | undefined)?.captureStage === "provider_usage"
    ? [(entry.data ?? {}) as Record<string, unknown>]
    : [])
}

// ── 场景前置：载荷按**生效窗口**预算推导（配置值与注入模型窗口取小，与 resolvePiTurnModel 一致） ──
//
// 先前的旧口径按配置窗口（256k）推导、运行期却跑在 faux 默认模型的 128k 窗口上；保留窗口改为
// 随窗口缩放后两个窗口的数字分家，载荷直接超过摘要调用的单片上限（oversized_unit）。
// 现在显式声明注入模型，载荷与运行期取同一份窗口。
//
// 长正文用 ASCII：上游 findCutPoint 按 chars/4 计消息，本仓对非 ASCII 按 1 token/字符计 ——
// 纯中文尾段要越过保留窗口，光按上游口径铺就有 4 倍本仓成本，先顶破硬预算。ASCII 下两把
// 尺子一致（4 字符 ≈ 1 token），「1.25 倍保留窗口」的余量语义保持逐字不变。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const settings = compactionSettingsFor(WINDOW_TOKENS, FAKE_MODEL.maxTokens)
const KEEP_MARGIN = 1.25
const UNIT = "压缩候选正文必须保留在磁盘中。"   // 15 字符
/** 尾段长正文（ASCII）：合计 ≈ 1.25 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = "x".repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2))
const FIRST = `用户第一轮：${UNIT.repeat(133)}`

/** 第 4 条脚本响应专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
function summaryStep(): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    if (!text.includes("\"instructions\"")) {
      throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
    }
    return fakeText(JSON.stringify({
      intent: "继续讨论上下文换代身份",
      facts: ["换代身份沿 lane 分支回溯已提交 compaction 条目"],
      corrections: [],
      pending: ["核对槽快照与请求快照同源"],
      continuity: ["本次使用 fake provider"],
      nextSteps: ["检查 readContextEpoch"],
    }))
  }
}

export const 上下文换代: SceneDef = {
  meta: {
    caseId: "memory-context-epoch-branch",
    module: "memory",
    contractId: "mm-28",
    description: "context epoch 沿 lane 分支回溯已提交 compaction：槽、快照与 readContextEpoch 同源，读不到不写 0",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "snapshot", "compaction"],
  },
  setup: async () => {
    installFakeProvider([
      () => fakeText("第一轮回复完成。"),
      () => fakeText("第二轮回复完成。"),
      () => fakeText("第三轮回复完成。"),
      summaryStep(),
      () => fakeText("第四轮回复完成。"),
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "首轮：换代身份为 0，且本分支确实没有压缩条目",
      userText: FIRST,
      checks: [
        { type: "expectInitialEpochZero", run: async () => {
          const sessionId = getActiveSessionId()
          const epoch = await readContextEpoch(sessionId)
          if (!epoch || epoch.count !== 0 || epoch.lastCompactionEntryId !== undefined) {
            throw new Error(`首轮换代身份应为 0 且无压缩条目: ${JSON.stringify(epoch)}`)
          }
          const snapshots = await usageSnapshots(sessionId)
          const latest = snapshots[snapshots.length - 1]
          if (latest?.contextEpoch !== 0) throw new Error(`首轮 provider_usage 快照的 contextEpoch 不是 0: ${String(latest?.contextEpoch)}`)
        } },
      ],
    },
    {
      index: 2,
      description: "积累到超过保留窗口",
      userText: `用户第二轮：${LONG}`,
      checks: [
        { type: "expectTurnCompleted", run: async context => {
          if (!context.output.reply.trim()) throw new Error("第二轮没有回复")
        } },
      ],
    },
    {
      index: 3,
      description: "手动压缩：换代身份推进到 1 并指向该压缩条目",
      userText: `用户第三轮：${LONG}`,
      checks: [
        { type: "expectCompactionAdvancesEpoch", run: async () => {
          const sessionId = getActiveSessionId()
          const outcome = await compactActiveSession(sessionId)
          if (outcome.status !== "completed") {
            throw new Error(outcome.status === "failed"
              ? `压缩失败: ${outcome.error ?? "未知原因"}`
              : `压缩未完成: ${outcome.status}（首条之后的正文需超过 keepRecentTokens=${settings.keepRecentTokens} 的 chars/4 估算）`)
          }
          const entries = compactionEntries(await sessionEntries(sessionId))
          if (entries.length !== 1) throw new Error(`期望恰好一条 compaction 条目，实际 ${entries.length}`)
          const epoch = await readContextEpoch(sessionId)
          if (epoch?.count !== 1) throw new Error(`压缩后换代身份应为 1: ${JSON.stringify(epoch)}`)
          if (epoch.lastCompactionEntryId !== entries[0]!.id) {
            throw new Error(`换代身份没有指向那条压缩条目: ${String(epoch.lastCompactionEntryId)} ≠ ${entries[0]!.id}`)
          }
        } },
      ],
    },
    {
      index: 4,
      description: "再跑一轮：请求快照与槽快照沿用同一换代身份",
      userText: "第四轮：确认换代身份。",
      checks: [
        { type: "expectEpochSingleSource", run: async () => {
          const sessionId = getActiveSessionId()
          const epoch = await readContextEpoch(sessionId)
          const usage = await usageSnapshots(sessionId)
          const latest = usage[usage.length - 1]
          if (latest?.contextEpoch !== 1) throw new Error(`新一轮 provider_usage 快照的 contextEpoch 不是 1: ${String(latest?.contextEpoch)}`)
          if (latest.compaction === undefined || (latest.compaction as { count?: unknown }).count !== epoch?.count) {
            throw new Error(`快照的 compaction.count 与 readContextEpoch 不一致: ${JSON.stringify(latest.compaction)} vs ${JSON.stringify(epoch)}`)
          }
          // 压缩条目地址的字段名在写入侧与类型声明之间没对齐：主回合快照由 runtime.ts 经对象展开写
          // `lastCompactionEntryId`，而 `PromptCompactionContext` 声明的是 `lastEntryId`
          // （展开写入不受 excess property 检查，类型检查拦不住）。这里两个名字都认，只钉
          // 「快照必须带出真相源那条条目 id」这条不变量；两边对齐后本断言不需要改。
          const address = latest.compaction as { lastEntryId?: unknown; lastCompactionEntryId?: unknown }
          if (address.lastEntryId !== epoch?.lastCompactionEntryId && address.lastCompactionEntryId !== epoch?.lastCompactionEntryId) {
            throw new Error(`快照的压缩条目地址与 readContextEpoch 不一致: ${JSON.stringify(latest.compaction)} vs ${String(epoch?.lastCompactionEntryId)}`)
          }
          const slotEpoch = harnessSlots.snapshot(sessionId)?.contextEpoch
          if (slotEpoch !== epoch?.count) throw new Error(`槽内换代身份与真相源不一致: ${String(slotEpoch)} ≠ ${String(epoch?.count)}`)
        } },
      ],
    },
  ],
}

export default 上下文换代
