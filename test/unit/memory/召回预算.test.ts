// ==========================================
// 召回预算 —— 从 test/e2e/scenes/memory/召回预算.scene.ts 迁到 L2
// ==========================================
//
// 场景口径：召回文本的 token 口径（MISS-05，P6 的预算穿透点）。
//
// 召回预算的消费者是请求视图里的尾随记忆块（`renderMemoryRecall` 按 `projection.tokenBudget`
// 记账），所以「声明的预算」必须真的是「实际占用的 token」。旧的 `text.slice(0, budget * 4)` 用
// 「4 字符 = 1 token」这个中英通吃常数：中文下 1 字符 ≈ 1 token，声明 128 token 的召回实际能塞进
// 约 512 token，预算会计与请求用量直接脱钩。事实条目是语义整体，超预算时必须整条淘汰，
// 不能把正文前缀注入并丢掉末尾的否定或条件。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { estimateContextTokens } from "@/services/context"
import { createRuntimeTraceContext, subscribeRuntimeTrace } from "@/services/engine/runtime"

const UNIT = "召回事实按条目完整投影，不从否定或条件中间截断。"
/** 5000 字中文，远超下面声明的召回预算。 */
const CJK_TEXT = UNIT.repeat(Math.ceil(5_000 / UNIT.length))
const BUDGET = 128

function projectionOf(text: string, tokenBudget: number) {
  return { sourceId: "recall-budget", memoryVersion: "1", provenance: "e2e", taint: "derived" as const, text, tokenBudget, tier: "recall" as const }
}

const request = (tokenBudget: number) => ({ requestId: "recall-budget", sessionId: "recall-budget", query: "预算", tokenBudget })

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-recall-"))
  setTestDataRoot(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("召回预算", () => {
  it("预算不足时淘汰完整条目并按全文token计量 [memory-recall-token-budget]", async () => {
    expect(CJK_TEXT.length, `场景素材不足 5000 字: ${CJK_TEXT.length}`).toBeGreaterThanOrEqual(5_000)

    // 1. 超预算：整条事实淘汰，后半句的否定不会被裁掉。
    const clipped = installMemoryProvider({ recall: async req => [projectionOf(CJK_TEXT, req.tokenBudget)] })
    let recalled: Awaited<ReturnType<typeof recallMemory>>
    try {
      recalled = await recallMemory(request(BUDGET))
    } finally { clipped() }
    expect(recalled, "超预算事实被截成残缺内容").toHaveLength(0)

    // 2. 预算内：全文原样通过，budget 等于全文估算用量。
    const SHORT = "用户偏好简短回复"
    const passthrough = installMemoryProvider({ recall: async req => [projectionOf(SHORT, req.tokenBudget)] })
    let short: Awaited<ReturnType<typeof recallMemory>>
    try { short = await recallMemory(request(BUDGET)) } finally { passthrough() }
    expect(short[0]?.text, `预算内的召回文本被改动: ${short[0]?.text ?? "（没有返回）"}`).toBe(SHORT)
    expect(short[0]?.tokenBudget).toBe(estimateContextTokens(SHORT))

    // 3. 跨投影的预算会计不变：第一条吃满预算后，第二条被 remaining 拦下，正文总量不越界。
    const first = "甲".repeat(16)
    const second = "乙".repeat(16)
    const many = installMemoryProvider({ recall: async req => [projectionOf(first, req.tokenBudget), projectionOf(second, req.tokenBudget)] })
    let filled: Awaited<ReturnType<typeof recallMemory>>
    try { filled = await recallMemory(request(24)) } finally { many() }
    expect(filled, `剩余预算不足时没有整条淘汰第二项: ${filled.length}`).toHaveLength(1)
    expect(filled[0]?.text).toBe(first)
    expect(filled[0]?.tokenBudget).toBe(estimateContextTokens(first))
    const total = filled.reduce((sum, projection) => sum + estimateContextTokens(projection.text), 0)
    expect(total, `多条召回的合计超出预算: ${total}`).toBeLessThanOrEqual(24)

    // 默认空实现下行为不变，且注入的 provider 必须被收回。
    expect(getMemoryProvider(), "MemoryProvider 恢复未回到空实现").toBe(emptyMemoryProvider)
    expect((await recallMemory(request(BUDGET))).length, "空实现产生了召回").toBe(0)

    const events: Array<{kind: string; payload: Record<string,unknown>}> = []
    const stopTrace = subscribeRuntimeTrace(event => { events.push(event) })
    const fallbackProvider = installMemoryProvider({recall: async req => {
      req.fallbackReason = "rerank_failed"
      return [projectionOf(SHORT, BUDGET)]
    }})
    try {
      await recallMemory({...request(BUDGET), traceContext: createRuntimeTraceContext("recall-budget", "recall-budget")})
      expect(events.find(event => event.kind === "memory_recall_end")?.payload.fallback).toBe(true)
    } finally { fallbackProvider(); stopTrace() }
  })
})
