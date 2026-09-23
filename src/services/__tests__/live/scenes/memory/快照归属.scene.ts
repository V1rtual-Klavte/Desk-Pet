import type { Context, FauxResponseStep } from "@earendil-works/pi-ai"
import { compactActiveSession, compactionSettingsFor, harnessSlots, PROMPT_REWRITE_ENTRY, PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { aiConfig } from "@/services/config"
import { getEffectiveSafetyMode } from "@/services/debug"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：快照能回答「这是哪次请求、带什么参数、第几代槽」，一次性请求同样进快照体系 ──
//
// 三档快照在回合里按用途/step/代际归属：回合请求带 `request.purpose === "turn"` 与
// `request.step === "assistant"`，一次性摘要请求以 `one-shot:compaction` 身份另立条目，
// 不再把摘要 payload 写成一张归属错误的主回合快照。

/** 快照条目的落盘数据（custom 条目，不进模型消息流）。 */
interface SnapshotEntry {
  id: string
  captureStage: string
  data: Record<string, unknown>
}

async function snapshotEntries(sessionId: string): Promise<SnapshotEntry[]> {
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "custom" && entry.customType === PROMPT_SNAPSHOT_ENTRY
    ? [{ id: entry.id, captureStage: String((entry.data as { captureStage?: unknown } | undefined)?.captureStage ?? ""), data: (entry.data ?? {}) as Record<string, unknown> }]
    : [])
}

function requestOf(entry: SnapshotEntry): { purpose?: unknown; step?: unknown } {
  return (entry.data.request ?? {}) as { purpose?: unknown; step?: unknown }
}

/** 某一档的全部快照（一轮一个请求时通常各一条；接线变化多出条目也必须逐条满足同一归属口径）。 */
function stageEntries(entries: SnapshotEntry[], stage: string): SnapshotEntry[] {
  const found = entries.filter(entry => entry.captureStage === stage)
  if (found.length === 0) throw new Error(`缺少 ${stage} 档快照: ${JSON.stringify(entries.map(entry => entry.captureStage))}`)
  return found
}

// ── 场景前置：载荷按当前窗口预算推导（与压缩检查点同口径，保证存在可摘要范围） ──
const KEEP_MARGIN = 1.25
const UNIT = "压缩候选正文必须保留在磁盘中。"   // 15 字符
const settings = compactionSettingsFor(aiConfig.contextMaxTokens)
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = `用户第一轮：${UNIT.repeat(133)}`

const SUMMARY_MARKER = "继续讨论快照归属的完整证据"

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
      intent: SUMMARY_MARKER,
      facts: ["一次性摘要请求以 one-shot:compaction 身份进快照体系"],
      corrections: [],
      pending: ["核对 prompt_rewrite 条目"],
      continuity: ["本次使用 fake provider"],
      nextSteps: ["检查 contextEpoch 是否推进"],
    }))
  }
}

export const 快照归属: SceneDef = {
  meta: {
    caseId: "memory-snapshot-identity",
    module: "memory",
    contractId: "mm-11",
    description: "快照记录请求用途、参数、计划/能力/代际与换代身份；一次性压缩请求另立 one-shot 条目，不写归属错误的主回合 payload",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "snapshot", "production-entry"],
  },
  setup: async () => {
    installFakeProvider([
      () => fakeText("快照归属完成"),
      () => fakeText("第二轮回复完成。"),
      () => fakeText("第三轮回复完成。"),
      summaryStep(),
    ])
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "一轮 production 回合：三档快照的用途/step/代际与 hash 口径一致",
      userText: FIRST,
      checks: [
        { type: "expectSnapshotIdentity", run: async () => {
          const sessionId = getActiveSessionId()
          const entries = await snapshotEntries(sessionId)
          const generation = harnessSlots.peek(sessionId)!.snapshot().generation
          const stages = ["transform_context", "provider_payload", "provider_usage"] as const
          const picked = stages.flatMap(stage => stageEntries(entries, stage))
          for (const entry of picked) {
            const request = requestOf(entry)
            if (request.purpose !== "turn") throw new Error(`${entry.captureStage} 快照的 request.purpose 不是 turn: ${String(request.purpose)}`)
            if (request.step !== "assistant") throw new Error(`${entry.captureStage} 快照的 request.step 不是 assistant: ${String(request.step)}`)
            if (entry.data.generation !== generation) {
              throw new Error(`${entry.captureStage} 快照的 generation 与槽不一致: ${String(entry.data.generation)} ≠ ${generation}`)
            }
            if (typeof entry.data.systemPromptHash !== "string" || entry.data.systemPromptHash.length === 0) {
              throw new Error(`${entry.captureStage} 快照缺少 systemPromptHash`)
            }
          }
          const systemPromptHashes = new Set(picked.map(entry => entry.data.systemPromptHash))
          if (systemPromptHashes.size !== 1) throw new Error(`三档快照的 systemPromptHash 不一致: ${JSON.stringify([...systemPromptHashes])}`)
          const payloadHashes = stageEntries(entries, "provider_payload").map(entry => entry.data.payloadHash)
          if (payloadHashes.some(hash => typeof hash !== "string" || hash.length === 0)) {
            throw new Error(`provider_payload 快照缺少 payloadHash: ${JSON.stringify(payloadHashes)}`)
          }
          const strayHashes = entries.filter(entry => entry.captureStage !== "provider_payload" && entry.data.payloadHash !== undefined)
          if (strayHashes.length > 0) throw new Error("payloadHash 只应出现在 provider_payload 快照上")
        } },
        { type: "expectSnapshotParamsAndCapabilities", run: async () => {
          const sessionId = getActiveSessionId()
          const payload = stageEntries(await snapshotEntries(sessionId), "provider_payload")[0]!
          const params = (payload.data.requestParams ?? {}) as { maxTokens?: unknown }
          if (typeof params.maxTokens !== "number" || !Number.isInteger(params.maxTokens) || params.maxTokens <= 0) {
            throw new Error(`快照没记录正整数 maxTokens: ${JSON.stringify(params)}`)
          }
          const capabilities = (payload.data.capabilities ?? {}) as { safetyMode?: unknown; toolDecisions?: unknown }
          if (capabilities.safetyMode !== getEffectiveSafetyMode()) {
            throw new Error(`快照的冻结 safetyMode 与当前生效值不一致: ${String(capabilities.safetyMode)} ≠ ${getEffectiveSafetyMode()}`)
          }
          if (!Array.isArray(capabilities.toolDecisions)) throw new Error("快照的 capabilities.toolDecisions 不是数组")
          const compaction = (payload.data.compaction ?? {}) as { count?: unknown }
          if (compaction.count !== 0) throw new Error(`首轮快照的 compaction.count 应为 0: ${String(compaction.count)}`)
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
      description: "手动压缩：一次性摘要请求以 one-shot:compaction 身份另立快照条目",
      userText: `用户第三轮：${LONG}`,
      checks: [
        { type: "expectOneShotCompactionSnapshots", run: async () => {
          const sessionId = getActiveSessionId()
          const before = await snapshotEntries(sessionId)
          const outcome = await compactActiveSession(sessionId)
          if (outcome.status !== "completed") {
            throw new Error(outcome.status === "failed"
              ? `压缩失败: ${outcome.error ?? "未知原因"}`
              : `压缩未完成: ${outcome.status}（首条之后的正文需超过 keepRecentTokens=${settings.keepRecentTokens} 的 chars/4 估算）`)
          }
          const beforeIds = new Set(before.map(entry => entry.id))
          const added = (await snapshotEntries(sessionId)).filter(entry => !beforeIds.has(entry.id))
          // 摘要请求不是本回合的对话请求：不再有归属错误的 turn/provider_payload 快照。
          const wrongPayload = added.filter(entry => entry.captureStage === "provider_payload" && requestOf(entry).purpose === "turn")
          if (wrongPayload.length > 0) {
            throw new Error(`压缩请求写出了归属错误的 provider_payload 快照: ${JSON.stringify(wrongPayload.map(entry => entry.id))}`)
          }
          const oneShot = added.filter(entry => requestOf(entry).purpose === "compaction")
          const payloadStages = new Set(oneShot.filter(entry => entry.captureStage === "provider_payload").map(entry => entry.id))
          const usageStages = oneShot.filter(entry => entry.captureStage === "provider_usage")
          if (payloadStages.size !== 1 || usageStages.length !== 1) {
            throw new Error(`一次性摘要请求应恰好产生 payload + usage 两档快照: ${JSON.stringify(added.map(entry => [entry.captureStage, requestOf(entry).purpose]))}`)
          }
          for (const entry of oneShot) {
            if (requestOf(entry).step !== "compaction") throw new Error("一次性摘要快照的 request.step 不是 compaction")
            const params = (entry.data.requestParams ?? {}) as { maxTokens?: unknown }
            if (typeof params.maxTokens !== "number" || params.maxTokens <= 0) throw new Error(`一次性快照缺少正整数 maxTokens: ${JSON.stringify(params)}`)
            const blocks = entry.data.systemBlocks as Array<{ blockId?: unknown }> | undefined
            if (blocks?.[0]?.blockId !== "one-shot:compaction") {
              throw new Error(`一次性快照的 systemBlocks[0].blockId 不是 one-shot:compaction: ${JSON.stringify(blocks?.[0])}`)
            }
            const messages = entry.data.agentMessages as Array<{ id?: unknown }> | undefined
            if (messages?.[0]?.id !== "one-shot:compaction:0") {
              throw new Error(`一次性快照的 agentMessages[0].id 不是 one-shot:compaction:0: ${JSON.stringify(messages?.[0])}`)
            }
          }
          // usage 档带摘要正文 hash（不落正文）。
          const compaction = (usageStages[0]!.data.compaction ?? {}) as { summaryHash?: unknown }
          if (typeof compaction.summaryHash !== "string" || compaction.summaryHash.length === 0) {
            throw new Error("一次性 usage 快照缺少 compaction.summaryHash")
          }
          if (JSON.stringify(usageStages[0]!.data).includes(SUMMARY_MARKER)) {
            throw new Error("一次性快照落盘了摘要正文（应只留 hash）")
          }
          // 压缩摘要的派生记录：只留 hash 与压缩条目地址，正文（摘要与素材）都不落盘。
          const rewrites = (await sessionEntries(sessionId))
            .flatMap(entry => entry.type === "custom" && entry.customType === PROMPT_REWRITE_ENTRY
              ? [(entry.data ?? {}) as Record<string, unknown>]
              : [])
          if (rewrites.length !== 1) throw new Error(`期望恰好一条 prompt_rewrite 条目，实际 ${rewrites.length}`)
          const rewrite = rewrites[0]!
          if (rewrite.name !== "compaction_summary") throw new Error(`派生记录 name 不是 compaction_summary: ${String(rewrite.name)}`)
          if (rewrite.reason !== "compaction") throw new Error(`派生记录 reason 不是 compaction: ${String(rewrite.reason)}`)
          const compactionEntryId = compactionEntries(await sessionEntries(sessionId)).at(-1)?.id
          if (rewrite.compactionEntryId !== compactionEntryId) {
            throw new Error(`派生记录没有指向本次压缩条目: ${String(rewrite.compactionEntryId)} ≠ ${String(compactionEntryId)}`)
          }
          const derivedFrom = rewrite.derivedFrom as unknown
          if (!Array.isArray(derivedFrom) || derivedFrom.length !== 1 || typeof derivedFrom[0] !== "string" || derivedFrom[0].length === 0) {
            throw new Error(`派生记录缺少唯一的运行来源: ${JSON.stringify(derivedFrom)}`)
          }
          // 派生记录与一次性快照必须来自同一次运行（同一条 runId）：证据链不能有两个来源。
          const runIds = new Set(oneShot.map(entry => entry.data.runId))
          if (runIds.size !== 1 || !runIds.has(derivedFrom[0])) {
            throw new Error(`派生记录的来源与摘要请求的运行不一致: ${String(derivedFrom[0])} vs ${JSON.stringify([...runIds])}`)
          }
          const serialized = JSON.stringify(rewrite)
          if (serialized.includes(SUMMARY_MARKER)) throw new Error("派生记录落盘了摘要正文（应只留 hash）")
          for (const field of ["inputHash", "outputHash", "transformId"]) {
            if (typeof rewrite[field] !== "string" || (rewrite[field] as string).length === 0) {
              throw new Error(`派生记录缺少 ${field}`)
            }
          }
        } },
      ],
    },
  ],
}

export default 快照归属
