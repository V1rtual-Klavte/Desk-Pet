// ==========================================
// 变量池重置策略 —— 从 test/e2e/scenes/variable-pool/变量池策略.scene.ts 迁到 L2
// ==========================================
//
// 重置游标随 Card 的 `variables` 段持久化，本文件显式传参，不依赖跨用例残留。
// `destroyPool()` + `initVariablePool()`（不带游标）等价于「升级前数据 / 首次激活」：
// 两个游标都是 null，因此第一次 `applyResetPolicies` 必然视为陈旧。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import type { CardVariableDef } from "@/services/personality/types"
import {
  applyResetPolicies,
  batchWriteVars,
  destroyPool,
  getPoolSnapshot,
  initVariablePool,
  updateInteractionVar,
} from "@/services/personality/variable-pool"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "永久", type: "number", initial: 0, description: "永不重置", updateBy: "llm", min: 0, max: 100, reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", min: 0, max: 100, reset: "daily" },
  { scope: "card", name: "会话", type: "number", initial: 0, description: "会话重置", updateBy: "llm", min: 0, max: 100, reset: "session" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 9, reset: "never" },
]

/** 会话键 = SessionMeta.createdAt（毫秒），两个不同的会话 */
const SESSION_A = 1758000000000
const SESSION_B = 1758000001000

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-variable-pool-"))
  setTestDataRoot(root)
  destroyPool()
})

afterEach(() => {
  destroyPool()
  rmSync(root, { recursive: true, force: true })
})

/** 建池并把三个策略变量都推到非 initial，作为「今天已经涨过」的基线 */
const seedDirty = (): void => {
  destroyPool()
  initVariablePool({ cardId: "test-card", variableDefs: DEFS })
  const result = batchWriteVars({ 永久: "9", 每日: "9", 会话: "9" })
  expect(result.written, `前置写入失败: ${result.errors.join("; ")}`).toEqual(["永久", "每日", "会话"])
}

describe("变量池重置策略", () => {
  it("reset=never 的变量不参与任何重置 [variable-reset-never]", () => {
    seedDirty()
    // 同时给「跨天」与「新会话」两个触发条件，never 仍必须纹丝不动
    const resetVars = applyResetPolicies(new Date(2098, 0, 1), SESSION_A)

    expect(resetVars).not.toContain("永久")
    expect(getPoolSnapshot().card["永久"]?.value).toBe(9)
  })

  it("reset=daily 按日期键重置且幂等 [variable-reset-daily]", () => {
    const d1 = new Date(2099, 0, 1)
    const d2 = new Date(2099, 0, 2)

    seedDirty()
    // 游标缺省（首次激活 / 升级前数据）→ 视为陈旧，第一次调用即换日重置并推进游标
    expect(applyResetPolicies(d1, null)).toContain("每日")
    expect(getPoolSnapshot().card["每日"]?.value).toBe(1)

    // 同一日期键重复调用必须幂等（游标已推进到 d1）
    batchWriteVars({ 每日: "9" })
    expect(applyResetPolicies(d1, null)).toEqual([])

    // 换日 → 重置
    expect(applyResetPolicies(d2, null)).toContain("每日")
    expect(getPoolSnapshot().card["每日"]?.value).toBe(1)
    // daily 只影响自己，不该顺手重置 session 变量
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)
  })

  it("reset=session 仅在会话键变化时重置 [variable-reset-session]", () => {
    seedDirty()
    const d = new Date(2099, 5, 1)

    // sessionKey=null → 不做判定（不能凭空认定新会话）
    expect(applyResetPolicies(d, null)).not.toContain("会话")
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)

    // 首次拿到会话键（游标缺省）→ 判定为新会话并重置
    expect(applyResetPolicies(d, SESSION_A)).toContain("会话")
    expect(getPoolSnapshot().card["会话"]?.value).toBe(0)

    // 同一会话键重复调用必须幂等
    batchWriteVars({ 会话: "9" })
    expect(applyResetPolicies(d, SESSION_A)).toEqual([])
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)

    // 换会话 → 重置
    expect(applyResetPolicies(d, SESSION_B)).toContain("会话")
    expect(getPoolSnapshot().card["会话"]?.value).toBe(0)
  })

  it("updateInteractionVar 写入 interaction 变量 [variable-interaction-update]", () => {
    destroyPool()
    initVariablePool({ cardId: "test-card", variableDefs: DEFS })

    // 字符串数字要能强制转换（系统侧回调常传字符串）
    expect(updateInteractionVar("unansweredCount", "3").success).toBe(true)
    const state = getPoolSnapshot().interaction["unansweredCount"]
    expect(state?.value).toBe(3)
    expect(state?.updatedBy).toBe("system")

    // 越界必须拒绝，且不能改坏已有值
    expect(updateInteractionVar("unansweredCount", 99).success).toBe(false)
    expect(getPoolSnapshot().interaction["unansweredCount"]?.value).toBe(3)

    // 未注册的名字同样拒绝
    expect(updateInteractionVar("不存在", 1).success).toBe(false)
  })
})
