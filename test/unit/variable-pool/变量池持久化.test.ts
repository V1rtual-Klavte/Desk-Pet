// ==========================================
// 变量池持久化 —— 从 test/e2e/scenes/variable-pool/变量池持久化.scene.ts 迁到 L2
// ==========================================
//
// 用测试专属 cardId：L2 每个用例都指向自己的 mkdtemp 临时数据根，
// 落点仍是 `personality/stages/{cardId}.json`，不会碰到真实数据。
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
  loadCardVars,
  savePoolToDiskStrict,
  updateInteractionVar,
} from "@/services/personality/variable-pool"

const CARD_ID = "e2e-vars"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "亲密", type: "number", initial: 0, description: "亲密度", updateBy: "llm", min: 0, max: 10, reset: "never" },
  { scope: "card", name: "心情", type: "string", initial: "平静", description: "枚举变量", updateBy: "llm", enum: ["平静", "开心"], reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", min: 0, max: 100, reset: "daily" },
  { scope: "card", name: "会话", type: "number", initial: 0, description: "会话重置", updateBy: "llm", min: 0, max: 100, reset: "session" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 99, reset: "never" },
]

/** 会话键 = SessionMeta.createdAt（毫秒） */
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

describe("变量池持久化", () => {
  it("savePoolToDisk 写入 stages/{cardId}.json [variable-pool-save]", async () => {
    destroyPool()
    initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
    const written = batchWriteVars({ 亲密: "6", 心情: "开心" })
    expect(written.written).toEqual(["亲密", "心情"])
    // interaction 与 card 分开存放：写成非 initial 值才能证明这一段也真的落盘了
    expect(updateInteractionVar("unansweredCount", 4).success).toBe(true)

    // 换日 + 换会话：两个重置游标必须随同一次写盘落进 variables 段
    applyResetPolicies(new Date(2099, 0, 2), SESSION_A)
    await savePoolToDiskStrict()

    // 直接读回磁盘：这是唯一能证明「真的落盘了」的方式，看内存池等于自证
    const loaded = await loadCardVars(CARD_ID)
    expect(loaded).not.toBeNull()
    expect(loaded?.card["亲密"]?.value).toBe(6)
    expect(loaded?.card["心情"]?.value).toBe("开心")
    expect(loaded?.interaction["unansweredCount"]?.value).toBe(4)
    // 游标是 variables 段的一部分：不落盘则跨重启必然判错「今天已重置过」
    expect(loaded?.lastDailyResetKey).toBe("2099-01-02")
    expect(loaded?.sessionKey).toBe(SESSION_A)
  })

  it("loadCardVars 恢复持久化变量与重置游标 [variable-pool-load]", async () => {
    destroyPool()
    initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
    batchWriteVars({ 亲密: "4" })
    applyResetPolicies(new Date(2099, 3, 1), SESSION_A)
    // 游标推进后再写非 initial 值：每个落盘字段都要能把「从磁盘恢复」与「按 def 重建」区分开
    batchWriteVars({ 每日: "5", 会话: "5" })
    expect(updateInteractionVar("unansweredCount", 3).success).toBe(true)
    await savePoolToDiskStrict()

    // 模拟重启：完全销毁运行时状态，再从磁盘重建。
    // destroy 之后立刻确认内存态真的空了 —— 放到 initVariablePool 之后再查就查不出来了。
    destroyPool()
    expect(Object.keys(getPoolSnapshot().card)).toEqual([])

    const loaded = await loadCardVars(CARD_ID)
    expect(loaded).not.toBeNull()
    // new Date(2099, 3, 1) 是本地 2099-04-01（月份 0-based），游标键与传入日期自洽
    expect(loaded?.lastDailyResetKey).toBe("2099-04-01")
    expect(loaded?.sessionKey).toBe(SESSION_A)
    const restored = initVariablePool({
      cardId: CARD_ID,
      variableDefs: DEFS,
      prevCardStates: loaded?.card,
      prevInteractionStates: loaded?.interaction,
      lastDailyResetKey: loaded?.lastDailyResetKey,
      sessionKey: loaded?.sessionKey,
    })
    expect(restored.card["亲密"]?.value).toBe(4)
    expect(restored.card["每日"]?.value).toBe(5)
    expect(restored.card["会话"]?.value).toBe(5)
    expect(restored.interaction["unansweredCount"]?.value).toBe(3)

    // ① 同一天、同一会话键：两个游标都已应用 → 不重置
    batchWriteVars({ 每日: "9", 会话: "9" })
    expect(applyResetPolicies(new Date(2099, 3, 1), SESSION_A)).toEqual([])

    // ② 换日：daily 重置并推进游标；会话键未变所以 session 变量不动
    expect(applyResetPolicies(new Date(2099, 3, 2), SESSION_A)).toContain("每日")
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)
    await savePoolToDiskStrict()
    const afterDaily = await loadCardVars(CARD_ID)
    // new Date(2099, 3, 2) 是本地 2099-04-02，同一自洽规则（月份 0-based）
    expect(afterDaily?.lastDailyResetKey).toBe("2099-04-02")

    // ③ 升级前的旧数据（没有 lastDailyResetKey）：视为陈旧，重置一次
    destroyPool()
    initVariablePool({
      cardId: CARD_ID,
      variableDefs: DEFS,
      prevCardStates: afterDaily?.card,
      prevInteractionStates: afterDaily?.interaction,
    })
    batchWriteVars({ 每日: "9" })
    expect(applyResetPolicies(new Date(2099, 3, 2), null)).toContain("每日")
    expect(getPoolSnapshot().card["每日"]?.value).toBe(1)

    // ④ sessionKey 为 null → 不做 session 判定，值原样保留
    batchWriteVars({ 会话: "9" })
    expect(applyResetPolicies(new Date(2099, 3, 2), null)).toEqual([])
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)

    // ⑤ 会话键变化 → 重置，并把新游标落盘
    expect(applyResetPolicies(new Date(2099, 3, 2), SESSION_B)).toContain("会话")
    await savePoolToDiskStrict()
    expect((await loadCardVars(CARD_ID))?.sessionKey).toBe(SESSION_B)

    // 不存在的 cardId 必须返回 null，而不是抛错 —— 首次启动就是这条路径
    expect(await loadCardVars("e2e-never-written")).toBeNull()
  })
})
