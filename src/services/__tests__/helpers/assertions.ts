// ==========================================
// 通用断言 — 可复用的测试检查
// ==========================================

import { expect } from "vitest"
import type { VariablePool } from "@/services/personality/variable-pool"

/** 检查 card 变量值 */
export function expectVar(pool: VariablePool, name: string, expected: unknown) {
  const val = pool.card[name]
  expect(val, `变量 ${name} 期望=${expected} 实际=${val}`).toBe(expected)
}

/** 检查 reply 不含异常内容 */
export function expectValidReply(reply: string) {
  expect(reply).toBeTruthy()
  expect(reply.length).toBeGreaterThan(0)
  expect(reply).not.toContain("undefined")
  expect(reply).not.toContain("NaN")
}

/** 检查 prompt 包含必要区域 */
export function expectPromptSections(prompt: string, sections: string[]) {
  for (const s of sections) {
    expect(prompt, `Prompt 应含 "${s}"`).toContain(s)
  }
}

/** 检查 When 规则命中 */
export function expectWhenRule(hitRule: { name: string } | null, expectedName: string) {
  expect(hitRule, `期望命中 "${expectedName}"`).not.toBeNull()
  expect(hitRule!.name).toBe(expectedName)
}

/** 检查 effects 包含指定 expression */
export function expectEffect(effects: { expression: string }[], expr: string) {
  const found = effects.some(e => e.expression === expr)
  expect(found, `effects 应包含 "${expr}"`).toBe(true)
}
