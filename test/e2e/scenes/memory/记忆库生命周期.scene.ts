import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import {
  addMemoryCandidates, applyMemoryChange, memoryList, memoryStatus, publishMemoryBatch,
  queryMemory, registerMemorySources, reviewMemoryBatch, startMemoryJob,
} from "@/services/agent/memory"
import type { MemoryDraft, MemorySource } from "@/services/agent/memory"

// 记忆库的真实边界在 Rust：索引、事务、版本冲突、遗忘抑制都只有真 IPC 才能证明。
// 本场景不模拟 Store，直接走生产命令面，断言读回的是已提交状态。

const SOURCE: MemorySource = {
  sourceId: "e2e-session:entry-1",
  sessionId: "e2e-session",
  entryId: "entry-1",
  eventId: "req-e2e:user",
  seq: 1,
  contentHash: "e2e-hash-1",
  evidence: "用户喜欢喝冰美式咖啡，喜欢别人叫他老板",
  eligibleForMemory: true,
  taint: "trusted_user",
  origin: "user",
  observedAt: 1_700_000_000_000,
}

function draft(content: string): MemoryDraft {
  return {
    content,
    summary: content,
    kind: "preference",
    scope: "user",
    aliases: [],
    pinned: false,
    importance: 6,
    confidence: 0.9,
    observedAt: Date.now(),
    sourceIds: [SOURCE.sourceId],
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`
}

async function payloadHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export const 记忆库生命周期: SceneDef = {
  meta: {
    caseId: "memory-store-lifecycle",
    module: "memory",
    contractId: "mm-03",
    description: "真实 SQLite 记忆库：中文短词召回、候选隔离、发布、遗忘防回灌与版本冲突",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["memory", "boundary", "error"],
  },
  setup: async () => {
    installFakeProvider([fakeText("好的。")])
  },
  turns: [
    {
      index: 1,
      description: "记忆库写入、召回、候选发布与遗忘",
      userText: "记住我喜欢冰美式",
      checks: [
        {
          type: "expectMemoryStoreLifecycle",
          run: async () => {
            const registered = await registerMemorySources([SOURCE])
            if (registered !== 1) throw new Error(`来源登记数 ${registered}，期望 1`)

            const base = (await memoryStatus()).revision
            await applyMemoryChange({
              operationId: "e2e-add-1",
              baseRevision: base,
              action: "add",
              draft: draft("用户喜欢喝冰美式咖啡"),
            })

            // 两字中文查询：「咖啡」在 FTS5 trigram 下 MATCH 恒零命中，必须由短词回退命中。
            const short = await queryMemory("咖啡", { limit: 10 })
            if (short.length !== 1) throw new Error(`两字中文召回 ${short.length} 条，期望 1`)
            const unrelated = await queryMemory("用户的银行卡密码", { limit: 10 })
            if (unrelated.length !== 0) throw new Error("无关查询召回了记忆")

            // 待审候选不进召回，发布后才可见。
            const job = await startMemoryJob("review")
            const candidateDraft = draft("用户喜欢别人叫他老板")
            await addMemoryCandidates(job.id, [{
              id: "e2e-candidate-1",
              draft: candidateDraft,
              payloadHash: await payloadHash({ draft: candidateDraft }),
              reason: "用户在自我介绍里提到称呼偏好",
            }])
            const beforePublish = await queryMemory("老板", { limit: 10 })
            if (beforePublish.length !== 0) throw new Error("未审批的候选进入了召回")
            const pending = await reviewMemoryBatch(job.id)
            if (pending.length !== 1) throw new Error(`待审候选 ${pending.length} 条，期望 1`)

            // 基准过期必须被拒绝，不能静默覆盖。
            let conflictRejected = false
            try {
              await publishMemoryBatch(job.id, [pending[0]!.id], (await memoryStatus()).revision + 5)
            } catch {
              conflictRejected = true
            }
            if (!conflictRejected) throw new Error("过期基准的发布没有被拒绝")

            await publishMemoryBatch(job.id, [pending[0]!.id], (await memoryStatus()).revision)
            const published = await queryMemory("老板", { limit: 10 })
            if (published.length !== 1) throw new Error(`发布后召回 ${published.length} 条，期望 1`)

            // 遗忘：召回消失，且同一来源事件不能再被登记（防回灌）。
            const items = await memoryList("user", undefined, 50)
            const target = items.find(item => item.draft.content.includes("冰美式"))
            if (!target) throw new Error("列表里找不到刚写入的记忆")
            await applyMemoryChange({
              operationId: "e2e-forget-1",
              baseRevision: (await memoryStatus()).revision,
              action: "forget",
              itemId: target.id,
            })
            const afterForget = await queryMemory("咖啡", { limit: 10 })
            if (afterForget.length !== 0) throw new Error("遗忘后仍能召回")
            const reRegistered = await registerMemorySources([SOURCE])
            if (reRegistered !== 0) throw new Error(`遗忘来源重新登记 ${reRegistered} 条，期望 0`)
          },
        },
      ],
    },
  ],
}

export default 记忆库生命周期
