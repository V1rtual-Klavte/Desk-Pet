// ==========================================
// When 引擎测试 — AST 解析 + 求值 + 规则优先级
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"
import { AME_WHEN_RULES } from "./helpers/fixtures"
import { expectWhenRule } from "./helpers/assertions"
import type { CardVariableDef } from "@/services/personality/types"
import type { VariablePool } from "@/services/personality/variable-pool"

async function importVp() { return await import("@/services/personality/variable-pool") }
async function importWe() { return await import("@/services/personality/when-engine") }

function makePool(overrides: {
  system?: Record<string, unknown>; card?: Record<string, unknown>; interaction?: Record<string, unknown>
} = {}): VariablePool {
  return {
    system: { hour: 14, minute: 30, dayOfWeek: 1, isNightTime: false, isWeekend: false, activeCardId: "", ...overrides.system },
    card: { score: 0, status: "idle", ...overrides.card },
    interaction: { unansweredCount: 0, ...overrides.interaction },
    session: {},
  }
}

describe("When 引擎基本求值", () => {
  let we: Awaited<ReturnType<typeof importWe>>
  beforeEach(async () => { vi.resetModules(); we = await importWe() })

  it("字面量 true", () => { expect(we.evaluateWhen("true", makePool())).toBe(true) })
  it("number 比较", () => {
    const p = makePool({ card: { score: 50 } })
    expect(we.evaluateWhen("score > 30", p)).toBe(true)
    expect(we.evaluateWhen("score < 30", p)).toBe(false)
    expect(we.evaluateWhen("score == 50", p)).toBe(true)
  })
  it("string 比较", () => {
    const p = makePool({ card: { status: "active" } })
    expect(we.evaluateWhen('status == "active"', p)).toBe(true)
    expect(we.evaluateWhen('status != "idle"', p)).toBe(true)
  })
  it("AND/OR 组合", () => {
    const p = makePool({ card: { score: 80, status: "active" } })
    expect(we.evaluateWhen('score > 50 AND status == "active"', p)).toBe(true)
    expect(we.evaluateWhen('score > 90 AND status == "active"', p)).toBe(false)
    expect(we.evaluateWhen('score > 90 OR status == "active"', p)).toBe(true)
  })
  it("括号优先级", () => {
    const p = makePool({ card: { score: 30 }, interaction: { unansweredCount: 3 } })
    expect(we.evaluateWhen('(score > 50 OR unansweredCount >= 3) AND status == "idle"', p)).toBe(true)
  })
  it("不存在变量→false", () => { expect(we.evaluateWhen("ghost == 1", makePool())).toBe(false) })
  it("系统变量 hour", () => {
    expect(we.evaluateWhen("hour >= 10", makePool({ system: { hour: 14 } }))).toBe(true)
  })
})

describe("When 引擎规则优先级 (ame)", () => {
  let we: Awaited<ReturnType<typeof importWe>>
  beforeEach(async () => { vi.resetModules(); we = await importWe() })

  it("unansweredCount=0 → 默认", () => {
    expectWhenRule(we.evaluateWhenEngine(AME_WHEN_RULES, makePool({ interaction: { unansweredCount: 0 } })), "默认")
  })
  it("unansweredCount=1 → 轻微提醒", () => {
    expectWhenRule(we.evaluateWhenEngine(AME_WHEN_RULES, makePool({ interaction: { unansweredCount: 1 } })), "轻微提醒")
  })
  it("unansweredCount=3 → 长时间沉默", () => {
    expectWhenRule(we.evaluateWhenEngine(AME_WHEN_RULES, makePool({ interaction: { unansweredCount: 3 } })), "长时间沉默")
  })
  it("hour=23 → 深夜执勤", () => {
    expectWhenRule(we.evaluateWhenEngine(AME_WHEN_RULES, makePool({ system: { hour: 23 }, interaction: { unansweredCount: 0 } })), "深夜执勤")
  })
  it("无规则命中→null", () => {
    expect(we.evaluateWhenEngine([{ name: "n", when: "hour == 0", tone: "" }], makePool({ system: { hour: 14 } }))).toBeNull()
  })
})

describe("When 引擎变量池联动", () => {
  let we: Awaited<ReturnType<typeof importWe>>
  let vp: Awaited<ReturnType<typeof importVp>>

  beforeEach(async () => {
    vi.resetModules(); we = await importWe(); vp = await importVp()
    const defs: CardVariableDef[] = [
      { scope: "card", name: "mood", type: "string", initial: "neutral", enum: ["neutral", "happy", "angry"], updateBy: "llm", persistent: true, reset: "never", description: "" },
      { scope: "card", name: "trust", type: "number", initial: 0, min: 0, max: 10, updateBy: "llm", persistent: true, reset: "never", description: "" },
    ]
    vp.initVariablePool({ cardId: "t", variableDefs: defs })
  })

  it("var_write → When 切换", () => {
    const rules = [
      { name: "happy", when: 'mood == "happy" AND trust >= 5', tone: "开心" },
      { name: "default", when: "true", tone: "普通" },
    ]
    expectWhenRule(we.evaluateWhenEngine(rules, vp.getPoolSnapshot()), "default")
    vp.varWrite("mood", "happy")
    vp.varWrite("trust", "7")
    expectWhenRule(we.evaluateWhenEngine(rules, vp.getPoolSnapshot()), "happy")
  })
})
