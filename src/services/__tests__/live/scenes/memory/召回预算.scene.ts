import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { estimateContextTokens } from "@/services/context"
import type { SceneDef } from "../../types"

// ── 场景口径：召回文本的 token 口径（MISS-05，P6 的预算穿透点） ──
//
// 召回预算的消费者是 buildPrompt 的 memory 块（`memoryProjectionBlocks` 按 `projection.tokenBudget`
// 记账），所以「声明的预算」必须真的是「实际占用的 token」。旧的 `text.slice(0, budget * 4)` 用
// 「4 字符 = 1 token」这个中英通吃常数：中文下 1 字符 ≈ 1 token，声明 128 token 的召回实际能塞进
// 约 512 token，预算会计与请求用量直接脱钩。本场景注入超长中文召回文本，断言裁剪后的正文落在
// 请求预算内、被裁剪时显式标记（不静默截尾），且预算内的文本原样通过。

/** 裁剪标记：与 `provider.ts` 的常量逐字一致（钉住「显式标记」这一形态本身）。 */
const TRUNCATION_MARK = "…[召回文本超出预算，已按 token 口径截断]"
const UNIT = "召回正文按 token 口径裁剪，超配时显式标记，不再用字符常数折算。"
/** 5000 字中文：旧口径会放过约 1250 token，远超下面声明的召回预算。 */
const CJK_TEXT = UNIT.repeat(Math.ceil(5_000 / UNIT.length))
const BUDGET = 128

function projectionOf(text: string, tokenBudget: number) {
  return { sourceId: "recall-budget", memoryVersion: "1", provenance: "live-test", taint: "derived" as const, text, tokenBudget }
}

const request = (tokenBudget: number) => ({ requestId: "recall-budget", sessionId: "recall-budget", query: "预算", tokenBudget })

export const 召回预算: SceneDef = {
  meta: {
    caseId: "memory-recall-token-budget",
    module: "memory",
    contractId: "mm-31",
    description: "MemoryProvider 召回正文按 estimateContextTokens 口径裁剪：超预算时截断并显式标记，不再用 4 字符 = 1 token 的通吃常数",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "budget", "boundary"],
  },
  turns: [{
    index: 1,
    description: "注入超长中文召回文本：正文按预算裁剪并显式标记，预算内文本原样通过",
    userText: "校验召回文本的 token 口径。",
    checks: [{ type: "expectRecallTokenBudget", run: async () => {
      if (CJK_TEXT.length < 5_000) throw new Error(`场景素材不足 5000 字: ${CJK_TEXT.length}`)

      // 1. 超预算：正文被裁到预算内，并留下显式标记。
      const clipped = installMemoryProvider({ recall: async req => [projectionOf(CJK_TEXT, req.tokenBudget)] })
      let recalled: Awaited<ReturnType<typeof recallMemory>>
      try {
        recalled = await recallMemory(request(BUDGET))
      } finally { clipped() }
      if (recalled.length !== 1) throw new Error(`超预算召回应返回一条裁剪后的投影，实际 ${recalled.length}`)
      const text = recalled[0]!.text
      if (!text.includes(TRUNCATION_MARK)) throw new Error(`裁剪没有显式标记: ${text.slice(-40)}`)
      const body = text.slice(0, -TRUNCATION_MARK.length)
      if (body.length === 0) throw new Error("裁剪把召回正文清空了")
      // 正文是「预算内的那一份」：旧口径会在这里放过约 512 个汉字（≈512 token）。
      if (estimateContextTokens(body) > BUDGET) {
        throw new Error(`裁剪后的正文超出请求预算: ${estimateContextTokens(body)} > ${BUDGET}`)
      }
      // 标记是显式开销，不计入预算（与 L0 的缩短标记同口径）。
      if (estimateContextTokens(text) > BUDGET + TRUNCATION_MARK.length) {
        throw new Error(`召回文本连标记一起超出「预算 + 标记长度」: ${estimateContextTokens(text)}`)
      }

      // 2. 预算内：原样通过，不追加标记。
      const SHORT = "用户偏好简短回复"
      const passthrough = installMemoryProvider({ recall: async req => [projectionOf(SHORT, req.tokenBudget)] })
      let short: Awaited<ReturnType<typeof recallMemory>>
      try { short = await recallMemory(request(BUDGET)) } finally { passthrough() }
      if (short[0]?.text !== SHORT) throw new Error(`预算内的召回文本被改动: ${short[0]?.text ?? "（没有返回）"}`)

      // 3. 跨投影的预算会计不变：第一条吃满预算后，第二条被 remaining 拦下，正文总量不越界。
      const many = installMemoryProvider({ recall: async req => [projectionOf(CJK_TEXT, req.tokenBudget), projectionOf(CJK_TEXT, req.tokenBudget)] })
      let filled: Awaited<ReturnType<typeof recallMemory>>
      try { filled = await recallMemory(request(BUDGET)) } finally { many() }
      const total = filled.reduce((sum, projection) => sum + estimateContextTokens(projection.text), 0)
      if (total > BUDGET + TRUNCATION_MARK.length * filled.length) {
        throw new Error(`多条召回的合计超出预算: ${total}（投影 ${filled.length} 条）`)
      }

      // 默认空实现下行为不变，且注入的 provider 必须被收回。
      if (getMemoryProvider() !== emptyMemoryProvider) throw new Error("MemoryProvider 恢复未回到空实现")
      if ((await recallMemory(request(BUDGET))).length !== 0) throw new Error("空实现产生了召回")
    } }],
  }],
}

export default 召回预算
