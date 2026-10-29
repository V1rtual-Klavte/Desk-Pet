import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { applyMemoryChange, getMemoryRecallCandidates, memoryStatus, registerMemorySources } from "@/services/agent/memory"
import type { MemoryDraft, MemorySource } from "@/services/agent/memory"

let trialIdentity = ""

export const 事件时间召回: SceneDef = {
  meta: {
    caseId: "memory-event-time-recall",
    module: "memory",
    contractId: "mm-69",
    description: "事实 eventTime 经 Node 与真实 Rust IPC 在 SQLite 先过滤",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["memory", "boundary"],
  },
  setup: async () => {
    trialIdentity = crypto.randomUUID()
    installFakeProvider([fakeText("收到。")])
  },
  turns: [
    {
      index: 1,
      description: "结构化半开事件时间范围先筛事实，并返回过滤前后数量",
      userText: "核对一个事件日期索引",
      checks: [
        {
          type: "expectEventTimeRecall",
          run: async () => {
            const firstInstant = Date.UTC(2025, 0, 1, 12)
            const secondInstant = firstInstant + 60_000
            const sources: MemorySource[] = [firstInstant, secondInstant].map((instant, index) => ({
              sourceId: `${trialIdentity}:source:${index}`,
              sessionId: trialIdentity,
              entryId: `${trialIdentity}:entry:${index}`,
              eventId: `${trialIdentity}:event:${index}`,
              seq: index + 1,
              contentHash: `${trialIdentity}:hash:${index}`,
              evidence: "用户完成了南山步道旅行",
              eligibleForMemory: true,
              taint: "trusted_user",
              origin: "user",
              observedAt: instant,
            }))
            const registered = await registerMemorySources(sources)
            if (registered !== sources.length) throw new Error(`事件来源登记 ${registered} 条，期望 ${sources.length}`)

            const addEpisode = async (index: number, instant: number): Promise<void> => {
              const source = sources[index]!
              const draft: MemoryDraft = {
                content: "用户完成了南山步道旅行",
                summary: "用户完成了南山步道旅行",
                kind: "episode",
                scope: "user",
                aliases: [],
                pinned: false,
                importance: 5,
                confidence: 1,
                observedAt: instant,
                eventAt: { precision: "minute", instant, timezone: "UTC" },
                sourceIds: [source.sourceId],
              }
              await applyMemoryChange({
                operationId: `${trialIdentity}:add:${index}`,
                baseRevision: (await memoryStatus()).revision,
                action: "add",
                actor: "internal",
                itemId: `${trialIdentity}:item:${index}`,
                draft,
              })
            }
            await addEpisode(0, firstInstant)
            await addEpisode(1, secondInstant)

            const snapshot = await getMemoryRecallCandidates(
              "南山步道旅行",
              trialIdentity,
              [],
              false,
              { start: firstInstant, end: secondInstant },
              true,
            )
            const ids = snapshot.candidates.map(item => item.id)
            if (ids.length !== 1 || ids[0] !== `${trialIdentity}:item:0`) {
              throw new Error(`事件时间半开区间返回 ${JSON.stringify(ids)}，期望仅命中起点事件`)
            }
            if (snapshot.diagnostics?.timeFilterBefore !== 2 || snapshot.diagnostics.timeFilterAfter !== 1) {
              throw new Error(`事件时间过滤计数为 ${JSON.stringify(snapshot.diagnostics)}，期望 2→1`)
            }
          },
        },
      ],
    },
  ],
}

export default 事件时间召回
