// ==========================================
// 变量池核心 —— 从 test/e2e/scenes/variable-pool/变量池核心.scene.ts 迁到 L2
// ==========================================
//
// 固定一套 defs，不依赖当前激活的 Card（沿用原场景注释的理由）：
// `initVariablePool` 接受任意 `variableDefs`，自带定义才能让断言与
// 「本机 data_root 里恰好是哪张卡」解耦 —— 否则换一台机器就红。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { getOverride, setOverride } from "@/services/config"
import type { CardVariableDef } from "@/services/personality/types"
import {
  batchWriteVars,
  computeSystemVariables,
  destroyPool,
  formatPoolForPrompt,
  getPoolSnapshot,
  getVariableRegistry,
  initVariablePool,
  refreshVariablePool,
  restoreVariablePoolState,
  snapshotVariablePoolState,
  updateInteractionVar,
} from "@/services/personality/variable-pool"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "系统写", type: "number", initial: 5, description: "只由系统写", updateBy: "system", min: 0, max: 100, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 999, reset: "never" },
]

let root = ""

beforeEach(() => {
  // 变量池本体是内存态；数据根只给 logger 的批量转发与（个别用例的）落盘用。
  root = mkdtempSync(join(tmpdir(), "deskpet-variable-pool-"))
  setTestDataRoot(root)
  destroyPool()
})

afterEach(() => {
  destroyPool()
  rmSync(root, { recursive: true, force: true })
})

const seed = (): void => {
  destroyPool()
  initVariablePool({ cardId: "test-card", variableDefs: DEFS })
}

describe("变量池核心", () => {
  it("computeSystemVariables 计算 6 个系统变量 [variable-system-vars]", () => {
    // 2026-01-03 是周六；23:05 落在夜间区间
    const vars = computeSystemVariables(new Date(2026, 0, 3, 23, 5), "yuki")
    expect(vars).toMatchObject({
      hour: 23,
      minute: 5,
      dayOfWeek: 6,
      isNightTime: true,
      isWeekend: true,
      activeCardId: "yuki",
    })

    // 边界：边界值必须落在同一侧，否则「夜里」的定义会随实现漂移
    expect(computeSystemVariables(new Date(2026, 0, 5, 22, 0), "x").isNightTime).toBe(false)
    expect(computeSystemVariables(new Date(2026, 0, 5, 23, 0), "x").isNightTime).toBe(true)
    expect(computeSystemVariables(new Date(2026, 0, 5, 8, 59), "x").isNightTime).toBe(true)
    expect(computeSystemVariables(new Date(2026, 0, 5, 9, 0), "x").isNightTime).toBe(false)
    expect(computeSystemVariables(new Date(2026, 0, 5, 12, 0), "x").isWeekend).toBe(false)
  })

  it("isNightTime 随 CONFIG 静默值走（同日静默与 start==end 不静默）[variable-night-time-config]", () => {
    const originalStart = getOverride<number>("ai.proactive.quietStartHour")
    const originalEnd = getOverride<number>("ai.proactive.quietEndHour")
    try {
      // 同日静默 12–14：只有 [12,14) 是夜里；旧 23–9 硬编码会给出相反结论
      setOverride("ai.proactive.quietStartHour", 12)
      setOverride("ai.proactive.quietEndHour", 14)
      expect(computeSystemVariables(new Date(2026, 0, 5, 13, 0), "x").isNightTime).toBe(true)
      expect(computeSystemVariables(new Date(2026, 0, 5, 23, 5), "x").isNightTime).toBe(false)
      // start == end = 不静默
      setOverride("ai.proactive.quietStartHour", 10)
      setOverride("ai.proactive.quietEndHour", 10)
      expect(computeSystemVariables(new Date(2026, 0, 5, 10, 0), "x").isNightTime).toBe(false)
    } finally {
      setOverride("ai.proactive.quietStartHour", originalStart)
      setOverride("ai.proactive.quietEndHour", originalEnd)
    }
  })

  it("initVariablePool 按 defs 建池 [variable-pool-init]", () => {
    seed()
    const pool = getPoolSnapshot()

    // 逐 def 断言初值与类型：只盯两个 initial=0 的变量会漏掉「初值被常数替换」的实现，
    // DEFS 里唯一非 0 的 `系统写=5` 与非空串的 `心情="平静"` 必须都被看见
    for (const def of DEFS) {
      const state = def.scope === "card" ? pool.card[def.name] : pool.interaction[def.name]
      expect(state, `${def.name} 未按 def 建池`).toBeDefined()
      expect(state?.value, `${def.name} 初值`).toBe(def.initial)
      expect(state?.type, `${def.name} 类型`).toBe(def.type)
    }
    expect(getVariableRegistry().map(d => d.name)).toEqual(DEFS.map(d => d.name))
  })

  it("refreshVariablePool 只重算系统变量 [variable-pool-refresh]", () => {
    seed()
    // 先推到非 initial：值停在 initial 时，「refresh 顺手按 defs 重建 card 变量」的实现照样全绿
    batchWriteVars({ 亲密: "7" })
    updateInteractionVar("unansweredCount", 3)

    const before = getPoolSnapshot()
    const next = refreshVariablePool({ activeCardId: "other-card" })

    expect(next.system.activeCardId).toBe("other-card")
    // 只动 system：card / interaction 的变量状态整体不变（值、来源、时间戳都不许动）
    expect(next.card["亲密"]).toEqual(before.card["亲密"])
    expect(next.interaction["unansweredCount"]).toEqual(before.interaction["unansweredCount"])
    expect(next.card["亲密"]?.value).toBe(7)
    // 不给参数时沿用**模块内的** currentCardId：refresh 只覆盖本次返回值，
    // 不会把入参写回全局状态，所以这里应回到 "test-card" 而不是 "other-card"
    expect(refreshVariablePool().system.activeCardId).toBe("test-card")
  })

  it("batchWriteVars 拒绝未注册变量 [variable-pool-unregistered]", () => {
    seed()
    const result = batchWriteVars({ 不存在的变量: "1" })

    expect(result.written).toEqual([])
    expect(result.errors.join("; ")).toContain("未注册")
    expect("不存在的变量" in getPoolSnapshot().card).toBe(false)
  })

  it("updateBy=system 的变量不可被 LLM 写 [variable-pool-system-readonly]", () => {
    seed()
    const result = batchWriteVars({ 系统写: "99" })

    expect(result.written).toEqual([])
    expect(result.errors.join("; ")).toContain("不可写")
    expect(getPoolSnapshot().card["系统写"]?.value).toBe(5)
  })

  it("formatPoolForPrompt 序列化三类变量 [variable-pool-prompt]", () => {
    seed()
    const text = formatPoolForPrompt(getPoolSnapshot())

    // 系统变量与 Card 变量段落恒定存在
    for (const section of ["[系统变量", "[Card变量"]) expect(text).toContain(section)
    // interaction 非空时才出现；本池里有 unansweredCount，所以这一段必须在
    expect(text).toContain("[互动状态")

    // Card 变量要把约束写进 prompt，否则模型不知道边界在哪
    expect(text).toContain("亲密")
    expect(text).toContain('心情="平静"')
    // "平静" 同时是变量当前值：只判它时，删掉 enum 注入的实现照样绿。
    // 唯一只能来自 enum 列表的证据是「开心」——非当前值的枚举项。
    expect(text).toContain("开心")

    // 段落占位符只在真的空段落出现；这里 interaction 非空，所以不该有 (空)
    expect(text).not.toContain("(空)")
  })

  it("snapshot 与 restore 往返 [variable-pool-snapshot]", () => {
    seed()
    batchWriteVars({ 亲密: "7" })
    const snapshot = snapshotVariablePoolState()
    expect(getPoolSnapshot().card["亲密"]?.value).toBe(7)

    // 破坏当前状态，再用快照恢复
    batchWriteVars({ 亲密: "1" })
    restoreVariablePoolState(snapshot)
    expect(getPoolSnapshot().card["亲密"]?.value).toBe(7)
    expect(getPoolSnapshot().card["亲密"]?.updatedBy).toBe("llm")

    // 人格切换失败的回滚必须连变量注册表一起还原（VAR-02）：
    // 只还原池会让后续写入按目标卡的 schema 校验、Prompt 里变量元数据整块消失
    initVariablePool({ cardId: "other-card", variableDefs: [] })
    restoreVariablePoolState(snapshot)
    expect(getVariableRegistry().map(d => d.name)).toEqual(DEFS.map(d => d.name))
    expect(getPoolSnapshot().system.activeCardId).toBe("test-card")
    expect(getPoolSnapshot().card["亲密"]?.value).toBe(7)
  })

  it("destroyPool 清空全部状态 [variable-pool-destroy]", () => {
    seed()
    batchWriteVars({ 亲密: "3" })
    destroyPool()

    expect(getVariableRegistry()).toEqual([])
    expect(Object.keys(getPoolSnapshot().card)).toEqual([])
    // 销毁后再写必须一律拒绝：registry 没了，所有名字都是「未注册」
    expect(batchWriteVars({ 亲密: "3" }).written).toEqual([])
  })

  it("持久化值不合法时回退 initial [variable-pool-invalid-restore]", () => {
    destroyPool()
    const stale = {
      亲密: { value: 999, type: "number" as const, updatedAt: 1, updatedBy: "llm" as const },
      心情: { value: "不在枚举里", type: "string" as const, updatedAt: 1, updatedBy: "llm" as const },
    }
    // 越界 number 与不在 enum 的 string 都必须被判为无效
    const pool = initVariablePool({ cardId: "test-card", variableDefs: DEFS, prevCardStates: stale })
    expect(pool.card["亲密"]?.value).toBe(0)
    expect(pool.card["心情"]?.value).toBe("平静")

    // 合法值仍要保留，否则「回退」会退化成「永远不恢复」
    const ok = initVariablePool({
      cardId: "test-card",
      variableDefs: DEFS,
      prevCardStates: { 亲密: { value: 7, type: "number", updatedAt: 1, updatedBy: "llm" } },
    })
    expect(ok.card["亲密"]?.value).toBe(7)
  })
})
