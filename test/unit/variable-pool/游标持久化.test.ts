// ==========================================
// 重置游标跨重启 —— 从 test/e2e/scenes/variable-pool/游标持久化.scene.ts 迁到 L2
// ==========================================
//
// 游标是「这个 daily/session 策略已经应用过」的持久凭据，落 `variables` 段；
// 只写不读（改动前的形态）会让 daily 变量每次重启都重新判一次，session 变量
// 则完全失去判定依据。两个用例都把重启做真：destroy → loadCardVars →
// initVariablePool（与 registry.prepareVariablePool 的透传同形）。
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
} from "@/services/personality/variable-pool"

const CARD_ID = "e2e-reset-cursors"

const DEFS: CardVariableDef[] = [
  { scope: "card", name: "永久", type: "number", initial: 0, description: "永不重置", updateBy: "llm", min: 0, max: 100, reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", min: 0, max: 100, reset: "daily" },
  { scope: "card", name: "会话", type: "number", initial: 0, description: "会话重置", updateBy: "llm", min: 0, max: 100, reset: "session" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", min: 0, max: 99, reset: "never" },
]

/** 会话键 = SessionMeta.createdAt（毫秒），两个不同的会话 */
const SESSION_A = 1758000000000
const SESSION_B = 1758000001000

const DAY_1 = new Date(2099, 3, 1)
const DAY_2 = new Date(2099, 3, 2)

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

/** 把三个策略变量推到非 initial，作为「已经涨过」的基线 */
function seedDirty(): void {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  const result = batchWriteVars({ 永久: "9", 每日: "9", 会话: "9" })
  expect(result.written, `前置写入失败: ${result.errors.join("; ")}`).toEqual(["永久", "每日", "会话"])
}

/** 重启：只从磁盘变量区重建运行时状态（与 registry.prepareVariablePool 同形） */
async function restartFromDisk(): Promise<void> {
  destroyPool()
  expect(Object.keys(getPoolSnapshot().card)).toEqual([])
  const loaded = await loadCardVars(CARD_ID)
  initVariablePool({
    cardId: CARD_ID,
    variableDefs: DEFS,
    prevCardStates: loaded?.card,
    prevInteractionStates: loaded?.interaction,
    lastDailyResetKey: loaded?.lastDailyResetKey,
    sessionKey: loaded?.sessionKey,
  })
}

describe("重置游标跨重启", () => {
  it("daily 游标跨重启：同日不重置、跨日重置一次并推进游标 [variable-pool-daily-cursor-restart]", async () => {
    seedDirty()
    // 游标缺省（首次激活 / 升级前数据）视为陈旧 → 换日重置一次并推进游标
    expect(applyResetPolicies(DAY_1, null)).toContain("每日")
    // 再推回 9：下一次判定如果误判「今天已重置过」，这个值就会留下来
    batchWriteVars({ 每日: "9" })
    await savePoolToDiskStrict()

    await restartFromDisk()
    expect((await loadCardVars(CARD_ID))?.lastDailyResetKey).toBe("2099-04-01")

    // ① 同一日期键，跨重启后也不该再重置
    expect(applyResetPolicies(DAY_1, null)).toEqual([])
    expect(getPoolSnapshot().card["每日"]?.value).toBe(9)

    // ② 换日 → 重置一次并推进游标
    expect(applyResetPolicies(DAY_2, null)).toContain("每日")
    expect(getPoolSnapshot().card["每日"]?.value).toBe(1)
    await savePoolToDiskStrict()
    expect((await loadCardVars(CARD_ID))?.lastDailyResetKey).toBe("2099-04-02")

    // ③ never 策略的变量在两个触发条件下都不动
    expect(getPoolSnapshot().card["永久"]?.value).toBe(9)

    // ④ 从未写过的 Card 必须给 null（按 Card 初始值重建）而不是抛错
    expect(await loadCardVars("e2e-cursors-never-written")).toBeNull()
  })

  it("session 游标按持久化 sessionKey 判定，null 不判定 [variable-pool-session-cursor]", async () => {
    seedDirty()
    // 首次拿到会话键（游标缺省）→ 判定为新会话并重置
    expect(applyResetPolicies(DAY_1, SESSION_A)).toContain("会话")
    batchWriteVars({ 会话: "9" })
    await savePoolToDiskStrict()

    await restartFromDisk()
    expect((await loadCardVars(CARD_ID))?.sessionKey).toBe(SESSION_A)

    // ① null 不判定：没有会话键时不能凭空认定「新会话」
    expect(applyResetPolicies(DAY_1, null)).toEqual([])
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)

    // ② 同一会话键跨重启幂等
    expect(applyResetPolicies(DAY_1, SESSION_A)).toEqual([])

    // ③ 换会话 → 重置一次并把新游标落盘
    expect(applyResetPolicies(DAY_1, SESSION_B)).toContain("会话")
    expect(getPoolSnapshot().card["会话"]?.value).toBe(0)
    await savePoolToDiskStrict()
    const after = await loadCardVars(CARD_ID)
    expect(after?.sessionKey).toBe(SESSION_B)

    // ④ 旧数据（文件里没有会话游标）+ sessionKey=null → 仍然什么都不做。
    // daily 游标照常透传，避免把「每日重置」误读成「会话判定」。
    destroyPool()
    initVariablePool({
      cardId: CARD_ID,
      variableDefs: DEFS,
      prevCardStates: after?.card,
      lastDailyResetKey: after?.lastDailyResetKey,
    })
    batchWriteVars({ 会话: "9" })
    expect(applyResetPolicies(DAY_1, null)).toEqual([])
    expect(getPoolSnapshot().card["会话"]?.value).toBe(9)
  })
})
