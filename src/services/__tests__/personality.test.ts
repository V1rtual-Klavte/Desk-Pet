// ==========================================
// 人格/Card 测试 — 解析 + 变量定义提取
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"

async function importLoader() { return await import("@/services/personality/loader") }

describe("内置 Card", () => {
  let loader: Awaited<ReturnType<typeof importLoader>>

  beforeEach(async () => {
    vi.resetModules()
    loader = await importLoader()
    await new Promise(r => setTimeout(r, 500))
  })

  it("3 个内置 Card", () => {
    expect(loader.getCards().length).toBe(3)
  })

  it("每个 Card 有 id/name/version/sections/variableDefs", () => {
    for (const card of loader.getCards()) {
      expect(card.id).toBeTruthy()
      expect(card.name).toBeTruthy()
      expect(card.version).toBeGreaterThan(0)
      expect(card.sections.roleSetting).toBeTruthy()
      expect(card.sections.variableDefs).toBeDefined()
    }
  })

  it("angelkawaii: card + interaction 变量", () => {
    const card = loader.getCard("angelkawaii")!
    const cardVars = card.sections.variableDefs.filter(d => d.scope === "card")
    const intVars = card.sections.variableDefs.filter(d => d.scope === "interaction")
    expect(cardVars.length).toBeGreaterThan(0)
    expect(intVars.length).toBeGreaterThan(0)
  })

  it("ame: 当前任务数 + 上次任务类型", () => {
    const names = loader.getCard("ame")!.sections.variableDefs.map(d => d.name)
    expect(names).toContain("当前任务数")
    expect(names).toContain("上次任务类型")
  })

  it("所有 Card 有 when:true 兜底规则", () => {
    for (const card of loader.getCards()) {
      expect(card.sections.whenRules.some(r => r.when === "true"), `${card.id} 缺兜底`).toBe(true)
    }
  })

  it("angelkawaii 亲密度: number, 0..10, updateBy=llm", () => {
    const v = loader.getCard("angelkawaii")!.sections.variableDefs.find(d => d.name === "亲密度")!
    expect(v.type).toBe("number")
    expect(v.min).toBe(0)
    expect(v.max).toBe(10)
    expect(v.updateBy).toBe("llm")
  })

  it("所有 interaction 变量 updateBy=system", () => {
    for (const card of loader.getCards()) {
      for (const v of card.sections.variableDefs.filter(d => d.scope === "interaction")) {
        expect(v.updateBy).toBe("system")
      }
    }
  })
})
