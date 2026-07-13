// ==========================================
// 变量池测试 v2 — 四类变量 + Reset + Handler
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { CardVariableDef } from "@/services/personality/types"
import { ANGELKAWAII_DEFS } from "./helpers/fixtures"
import { expectVar } from "./helpers/assertions"

async function importVp() { return await import("@/services/personality/variable-pool") }

describe("系统变量 (System)", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  beforeEach(async () => { vi.resetModules(); vp = await importVp() })

  it("computeSystemVariables: 6 个变量正确", () => {
    const vars = vp.computeSystemVariables(new Date("2026-07-13T14:30:00"), "test")
    expect(vars.hour).toBe(14)
    expect(vars.minute).toBe(30)
    expect(vars.dayOfWeek).toBe(1)
    expect(vars.isNightTime).toBe(false)
    expect(vars.isWeekend).toBe(false)
    expect(vars.activeCardId).toBe("test")
  })

  it("深夜/凌晨/周末", () => {
    expect(vp.computeSystemVariables(new Date("2026-07-13T23:00:00"), "").isNightTime).toBe(true)
    expect(vp.computeSystemVariables(new Date("2026-07-13T04:00:00"), "").isNightTime).toBe(true)
    expect(vp.computeSystemVariables(new Date("2026-07-12T12:00:00"), "").isWeekend).toBe(true)
  })

  it("系统变量只读", () => {
    vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS })
    expect(vp.varWrite("hour", "99").success).toBe(false)
    expect(vp.varDelete("hour").success).toBe(false)
  })
})

describe("Card 变量 CRUD", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  beforeEach(async () => { vi.resetModules(); vp = await importVp(); vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS }) })

  it("初始化: 亲密度=3, 心情=平静, 夸过=false", () => {
    const pool = vp.getPoolSnapshot()
    expectVar(pool, "亲密度", 3)
    expectVar(pool, "心情", "平静")
    expectVar(pool, "用户今天是否夸过我", false)
  })

  it("从持久化恢复", async () => {
    vi.resetModules(); vp = await importVp()
    vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS, prevCardStates: { 亲密度: { value: 8, type: "number", updatedAt: Date.now(), updatedBy: "llm" } } })
    expectVar(vp.getPoolSnapshot(), "亲密度", 8)
  })

  it("拒绝非法持久化值(超出范围→回退initial)", async () => {
    vi.resetModules(); vp = await importVp()
    vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS, prevCardStates: { 亲密度: { value: 999, type: "number", updatedAt: Date.now(), updatedBy: "llm" } } })
    expectVar(vp.getPoolSnapshot(), "亲密度", 3)
  })

  it("varWrite number/string/boolean 成功", () => {
    expect(vp.varWrite("亲密度", "7").success).toBe(true)
    expect(vp.varWrite("心情", "开心").success).toBe(true)
    expect(vp.varWrite("用户今天是否夸过我", "true").success).toBe(true)
    const p = vp.getPoolSnapshot()
    expectVar(p, "亲密度", 7)
    expectVar(p, "心情", "开心")
    expectVar(p, "用户今天是否夸过我", true)
  })

  it("varWrite 拒绝: 超出范围/不在枚举/非boolean/未注册", () => {
    expect(vp.varWrite("亲密度", "999").success).toBe(false)
    expect(vp.varWrite("心情", "疯狂").success).toBe(false)
    expect(vp.varWrite("用户今天是否夸过我", "yes").success).toBe(false)
    expect(vp.varWrite("ghost", "42").success).toBe(false)
  })

  it("varDelete 重置到 initial", () => {
    vp.varWrite("亲密度", "10")
    expect(vp.varDelete("亲密度").success).toBe(true)
    expectVar(vp.getPoolSnapshot(), "亲密度", 3)
  })

  it("varRead/varList", () => {
    expect(vp.varRead("亲密度")!.value).toBe(3)
    expect(vp.varRead("ghost")).toBeNull()
    const sources = new Set(vp.varList().map(v => v.source))
    expect(sources.has("system")).toBe(true)
    expect(sources.has("card")).toBe(true)
    expect(sources.has("interaction")).toBe(true)
  })
})

describe("Interaction / Session / Reset", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  beforeEach(async () => { vi.resetModules(); vp = await importVp(); vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS }) })

  it("updateInteractionVar 写入+校验", () => {
    expect(vp.updateInteractionVar("unansweredCount", 5).success).toBe(true)
    expect(vp.getPoolSnapshot().interaction.unansweredCount).toBe(5)
    expect(vp.updateInteractionVar("unansweredCount", -1).success).toBe(false)
    expect(vp.varWrite("unansweredCount", "5").success).toBe(false)
  })

  it("Session 为空 + setSessionVars 注入", () => {
    expect(Object.keys(vp.getPoolSnapshot().session).length).toBe(0)
    vp.setSessionVars({ totalMessages: 42 })
    expect(vp.getPoolSnapshot().session.totalMessages).toBe(42)
  })

  it("reset=daily 同天不重置", () => {
    vp.varWrite("用户今天是否夸过我", "true")
    vp.applyResetPolicies(new Date(), false)
    expectVar(vp.getPoolSnapshot(), "用户今天是否夸过我", true)
  })

  it("reset=never 永不重置", () => {
    vp.varWrite("亲密度", "10")
    vp.applyResetPolicies(new Date(), true)
    expectVar(vp.getPoolSnapshot(), "亲密度", 10)
  })
})

describe("边界 & Handler", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  beforeEach(async () => { vi.resetModules(); vp = await importVp(); vp.initVariablePool({ cardId: "t", variableDefs: ANGELKAWAII_DEFS }) })

  it("destroyPool / snapshot-restore", () => {
    vp.varWrite("亲密度", "5")
    const snap = vp.snapshotVariablePoolState()
    vp.varWrite("亲密度", "9")
    vp.restoreVariablePoolState(snap)
    expectVar(vp.getPoolSnapshot(), "亲密度", 5)

    vp.destroyPool()
    expect(vp.snapshotVariablePoolState().currentCardId).toBeNull()
  })

  it("formatPoolForPrompt 完整", () => {
    vp.varWrite("心情", "开心")
    vp.setSessionVars({ k: "v" })
    const f = vp.formatPoolForPrompt()
    for (const s of ["[系统变量", "[Card变量", "[会话状态"]) expect(f).toContain(s)
    expect(f).not.toContain("undefined")
  })

  it("Handler 读/写/列/删", async () => {
    expect((await vp.buildVarReadHandler()({ name: "亲密度" })).content).toContain("3")
    expect((await vp.buildVarWriteHandler()({ name: "亲密度", value: "8" })).success).toBe(true)
    expect((await vp.buildVarWriteHandler()({ name: "心情", value: "疯狂" })).success).toBe(false)
    expect((await vp.buildVarListHandler()()).content).toContain("亲密度")
    vp.varWrite("亲密度", "6")
    expect((await vp.buildVarDeleteHandler()({ name: "亲密度" })).content).toContain("3")
  })
})
