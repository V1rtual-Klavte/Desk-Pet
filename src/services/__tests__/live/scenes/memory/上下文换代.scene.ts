import type { Context, FauxResponseStep } from "@earendil-works/pi-ai"
import { compactActiveSession, compactionSettingsFor, harnessSlots, PROMPT_SNAPSHOT_ENTRY, readContextEpoch } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { aiConfig } from "@/services/config"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

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

// ── 场景前置：载荷按当前窗口预算推导（与压缩检查点同口径，保证存在可摘要范围） ──
const KEEP_MARGIN = 1.25
const UNIT = "压缩候选正文必须保留在磁盘中。"   // 15 字符
const settings = compactionSettingsFor(aiConfig.contextMaxTokens)
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = `用户第一轮：${UNIT.repeat(133)}`

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

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
    ])
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
          const latest = snapshots.at(-1)
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
          const latest = (await usageSnapshots(sessionId)).at(-1)
          if (latest?.contextEpoch !== 1) throw new Error(`新一轮 provider_usage 快照的 contextEpoch 不是 1: ${String(latest?.contextEpoch)}`)
          if (latest.compaction === undefined || (latest.compaction as { count?: unknown }).count !== epoch?.count) {
            throw new Error(`快照的 compaction.count 与 readContextEpoch 不一致: ${JSON.stringify(latest.compaction)} vs ${JSON.stringify(epoch)}`)
          }
          if ((latest.compaction as { lastEntryId?: unknown }).lastEntryId !== epoch?.lastCompactionEntryId) {
            throw new Error("快照的 compaction.lastEntryId 与 readContextEpoch 不一致")
          }
          const slotEpoch = harnessSlots.snapshot(sessionId)?.contextEpoch
          if (slotEpoch !== epoch?.count) throw new Error(`槽内换代身份与真相源不一致: ${String(slotEpoch)} ≠ ${String(epoch?.count)}`)
        } },
      ],
    },
  ],
}

export default 上下文换代
