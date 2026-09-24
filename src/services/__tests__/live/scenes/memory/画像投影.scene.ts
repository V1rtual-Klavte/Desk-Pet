import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { createUserProfileProjection, estimateContextTokens, memoryProjectionBlocks, profileProjectionBlock } from "@/services/context"

// ── 场景口径：画像只读投影 + 召回端口的注入/恢复与 token 口径裁剪 ──
//
// 注入探针的正文是中文：召回正文的裁剪口径是「按 estimateContextTokens 逐单元累加」
// （1 汉字 ≈ 1 token），不是「4 字符 = 1 token」的字符常数。所以这里同时钉两条：
// 超预算时正文裁到请求预算内并显式标记（MISS-05/`召回预算` 场景的注入面），
// 预算内时正文原样通过（证明注入确实替换了实现，正文没有被裁剪改写）。

/** 裁剪标记：与 `provider.ts` 的常量逐字一致（钉住「显式标记」这一形态本身）。 */
const RECALL_TRUNCATION_MARK = "…[召回文本超出预算，已按 token 口径截断]"
const INJECTED_TEXT = "可注入记忆"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 画像投影: SceneDef = {
  meta: {
    caseId: "memory-profile-rewrite",
    module: "memory",
    contractId: "mm-17",
    description: "User.md 只读投影、空 MemoryProvider 边界，以及注入端口的 token 口径裁剪与恢复",
    depth: "deep",
    suite: "regression",
    tags: ["memory", "profile", "boundary"],
  },
  setup: async () => { provider = installFakeProvider([fakeText("画像投影已检查")]) },
  turns: [{
    index: 1,
    description: "检查画像来源、空召回边界与注入探针的裁剪/原样通过",
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
        text: INJECTED_TEXT, tokenBudget: 16,
      }] }
      const restore = installMemoryProvider(injected)
      // 注入生效：召回 1 条，单条预算取「请求预算」与「投影声明」的严格者（2 < 16）。
      const injectedRecall = await recallMemory({ requestId: "injected", sessionId: "profile-test", query: "test", tokenBudget: 2 })
      if (injectedRecall.length !== 1) throw new Error("MemoryProvider 注入未生效（没有召回投影）")
      if (injectedRecall[0]!.tokenBudget !== 2) {
        throw new Error(`单条预算没有取请求与声明的严格者: ${injectedRecall[0]!.tokenBudget}`)
      }
      // 5 个汉字 ≈ 5 token 超过 2：正文按 token 口径裁到预算内并显式标记（不静默截尾）。
      const clipped = injectedRecall[0]!.text
      const clippedBody = clipped.endsWith(RECALL_TRUNCATION_MARK)
        ? clipped.slice(0, -RECALL_TRUNCATION_MARK.length)
        : ""
      if (!clippedBody) throw new Error(`超预算召回没有显式裁剪标记: ${clipped.slice(-32)}`)
      if (!INJECTED_TEXT.startsWith(clippedBody)) throw new Error("裁剪后的召回正文不是原正文的前缀")
      if (estimateContextTokens(clippedBody) > 2) {
        throw new Error(`裁剪后的召回正文超出请求预算: ${estimateContextTokens(clippedBody)} > 2`)
      }
      // 预算内原样通过：受注入控制的是正文，不是被统一改写过的副本。
      const inBudget = await recallMemory({ requestId: "injected-in-budget", sessionId: "profile-test", query: "test", tokenBudget: 16 })
      if (inBudget.length !== 1 || inBudget[0]!.text !== INJECTED_TEXT) {
        throw new Error(`预算内的召回文本被改写或注入未生效: ${inBudget[0]?.text ?? "（没有返回）"}`)
      }
      restore()
      if (getMemoryProvider() !== emptyMemoryProvider) throw new Error("MemoryProvider 恢复未回到空实现")
      if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
    } }],
  }],
}

export default 画像投影
