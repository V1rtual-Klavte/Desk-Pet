import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { createUserProfileProjection, memoryProjectionBlocks, profileProjectionBlock } from "@/services/context"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 画像投影: SceneDef = {
  meta: {
    caseId: "memory-profile-rewrite",
    module: "memory",
    contractId: "mm-17",
    description: "User.md 只读投影与空 MemoryProvider 边界",
    depth: "deep",
    suite: "regression",
    tags: ["memory", "profile", "boundary"],
  },
  setup: async () => { provider = installFakeProvider([fakeText("画像投影已检查")]) },
  turns: [{
    index: 1,
    description: "检查画像来源和空召回结果",
    userText: "检查画像投影。",
    checks: [{ type: "expectProfileProjection", run: async () => {
      const projection = createUserProfileProjection("用户偏好简短回复")
      const block = profileProjectionBlock(projection)
      if (block.layer !== "profile" || block.sourceId !== "User.md" || block.provenance !== "user_profile_file") {
        throw new Error(`画像投影来源不完整: ${JSON.stringify(block)}`)
      }
      if (block.taint !== "derived" || block.projectionVersion !== 1) throw new Error("画像投影缺少派生标记或版本")
      const recalled = await emptyMemoryProvider.recall({ requestId: "profile-test", sessionId: "profile-test", query: "秘密查询", tokenBudget: 128, signal: new AbortController().signal })
      if (recalled.length !== 0 || memoryProjectionBlocks(recalled).length !== 0) throw new Error("空 MemoryProvider 产生了自动召回")
      const injected = { recall: async () => [{
        sourceId: "test", memoryVersion: "1", provenance: "live-test", taint: "derived" as const,
        text: "可注入记忆", tokenBudget: 16,
      }] }
      const restore = installMemoryProvider(injected)
      const injectedRecall = await recallMemory({ requestId: "injected", sessionId: "profile-test", query: "test", tokenBudget: 2 })
      if (injectedRecall.length !== 1 || injectedRecall[0].text.length > 8) {
        throw new Error("MemoryProvider 注入未生效")
      }
      restore()
      if (getMemoryProvider() !== emptyMemoryProvider) throw new Error("MemoryProvider 恢复未回到空实现")
      if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
    } }],
  }],
}

export default 画像投影
