// ==========================================
// 召回预算 —— 从 test/e2e/scenes/memory/召回预算.scene.ts 迁到 L2
// ==========================================
//
// 场景口径：召回文本的 token 口径（MISS-05，P6 的预算穿透点）。
//
// 召回预算的消费者是 buildPrompt 的 memory 块（`memoryProjectionBlocks` 按 `projection.tokenBudget`
// 记账），所以「声明的预算」必须真的是「实际占用的 token」。旧的 `text.slice(0, budget * 4)` 用
// 「4 字符 = 1 token」这个中英通吃常数：中文下 1 字符 ≈ 1 token，声明 128 token 的召回实际能塞进
// 约 512 token，预算会计与请求用量直接脱钩。本场景注入超长中文召回文本，断言裁剪后的正文落在
// 请求预算内、被裁剪时显式标记（不静默截尾），且预算内的文本原样通过。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { estimateContextTokens } from "@/services/context"

/** 裁剪标记：与 `provider.ts` 的常量逐字一致（钉住「显式标记」这一形态本身）。 */
const TRUNCATION_MARK = "…[召回文本超出预算，已按 token 口径截断]"
const UNIT = "召回正文按 token 口径裁剪，超配时显式标记，不再用字符常数折算。"
/** 5000 字中文：旧口径会放过约 1250 token，远超下面声明的召回预算。 */
const CJK_TEXT = UNIT.repeat(Math.ceil(5_000 / UNIT.length))
const BUDGET = 128
/** 标记的 token 开销：显式开销不计入预算，但合计必须落在「预算 + 标记」的**紧**上界里。 */
const MARK_TOKENS = estimateContextTokens(TRUNCATION_MARK)

function projectionOf(text: string, tokenBudget: number) {
  return { sourceId: "recall-budget", memoryVersion: "1", provenance: "e2e", taint: "derived" as const, text, tokenBudget }
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
  it("召回正文按 token 口径裁剪，超配时显式标记 [memory-recall-token-budget]", async () => {
    expect(CJK_TEXT.length, `场景素材不足 5000 字: ${CJK_TEXT.length}`).toBeGreaterThanOrEqual(5_000)

    // 1. 超预算：正文被裁到预算内，并留下显式标记。
    const clipped = installMemoryProvider({ recall: async req => [projectionOf(CJK_TEXT, req.tokenBudget)] })
    let recalled: Awaited<ReturnType<typeof recallMemory>>
    try {
      recalled = await recallMemory(request(BUDGET))
    } finally { clipped() }
    expect(recalled.length, `超预算召回应返回一条裁剪后的投影，实际 ${recalled.length}`).toBe(1)
    const text = recalled[0]!.text
    expect(text, `裁剪没有显式标记: ${text.slice(-40)}`).toContain(TRUNCATION_MARK)
    // 标记是尾部标记（正文 = 前缀 + 标记），否则「切掉标记当正文」的读法不成立。
    expect(text.endsWith(TRUNCATION_MARK), `裁剪标记不在尾部: ${text.slice(-40)}`).toBe(true)
    const body = text.slice(0, -TRUNCATION_MARK.length)
    expect(body.length, "裁剪把召回正文清空了").toBeGreaterThan(0)
    // 正文是「原正文的前缀 + 落在预算内」：只判长度上界的话，从尾部取片或取错内容的实现照样绿。
    expect(CJK_TEXT.startsWith(body), "裁剪后的正文不是原正文的前缀").toBe(true)
    // 正文是「预算内的那一份」：旧口径会在这里放过约 512 个汉字（≈512 token）。
    expect(estimateContextTokens(body), `裁剪后的正文超出请求预算: ${estimateContextTokens(body)} > ${BUDGET}`)
      .toBeLessThanOrEqual(BUDGET)
    // 标记是显式开销，不计入预算（与 L0 的缩短标记同口径）。上界按标记的 **token** 开销算：
    // 拿字符数当余量会把这条断成松上界，多截几个 token 的实现也能过。
    expect(estimateContextTokens(text), `召回文本连标记一起超出「预算 + 标记开销」: ${estimateContextTokens(text)}`)
      .toBeLessThanOrEqual(BUDGET + MARK_TOKENS)

    // 2. 预算内：原样通过，不追加标记。
    const SHORT = "用户偏好简短回复"
    const passthrough = installMemoryProvider({ recall: async req => [projectionOf(SHORT, req.tokenBudget)] })
    let short: Awaited<ReturnType<typeof recallMemory>>
    try { short = await recallMemory(request(BUDGET)) } finally { passthrough() }
    expect(short[0]?.text, `预算内的召回文本被改动: ${short[0]?.text ?? "（没有返回）"}`).toBe(SHORT)

    // 3. 跨投影的预算会计不变：第一条吃满预算后，第二条被 remaining 拦下，正文总量不越界。
    const many = installMemoryProvider({ recall: async req => [projectionOf(CJK_TEXT, req.tokenBudget), projectionOf(CJK_TEXT, req.tokenBudget)] })
    let filled: Awaited<ReturnType<typeof recallMemory>>
    try { filled = await recallMemory(request(BUDGET)) } finally { many() }
    // 第二条被 remaining 拦下才谈得上「合计不越界」；一条都没返回时下面的上界断言会空转。
    expect(filled, `第一条吃满预算后仍返回了 ${filled.length} 条投影`).toHaveLength(1)
    const total = filled.reduce((sum, projection) => sum + estimateContextTokens(projection.text), 0)
    expect(total, `多条召回的合计超出预算: ${total}（投影 ${filled.length} 条）`)
      .toBeLessThanOrEqual(BUDGET + MARK_TOKENS * filled.length)

    // 默认空实现下行为不变，且注入的 provider 必须被收回。
    expect(getMemoryProvider(), "MemoryProvider 恢复未回到空实现").toBe(emptyMemoryProvider)
    expect((await recallMemory(request(BUDGET))).length, "空实现产生了召回").toBe(0)
  })
})
