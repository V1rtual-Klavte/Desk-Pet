import type { SceneDef } from "../../types"
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

/**
 * 重置游标的跨重启语义。
 *
 * 游标是「这个 daily/session 策略已经应用过」的持久凭据，落 `variables` 段；
 * 只写不读（改动前的形态）会让 daily 变量每次重启都重新判一次，session 变量
 * 则完全失去判定依据。两个场景都把重启做真：destroy → loadCardVars →
 * initVariablePool（与 registry.prepareVariablePool 的透传同形）。
 */
const CARD_ID = "live-test-reset-cursors"

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

const unit = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: {
    caseId,
    module: "variable-pool",
    contractId,
    description,
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error", "reset"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查重置游标。",
    checks: [{ type: "expectVariablePool", run: async () => run() }],
  }],
})

/** 把三个策略变量推到非 initial，作为「已经涨过」的基线 */
function seedDirty(): void {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  const result = batchWriteVars({ 永久: "9", 每日: "9", 会话: "9" })
  if (result.written.length !== 3) throw new Error(`前置写入失败: ${result.errors.join("; ")}`)
}

/** 重启：只从磁盘变量区重建运行时状态（与 registry.prepareVariablePool 同形） */
async function restartFromDisk(): Promise<void> {
  destroyPool()
  if (Object.keys(getPoolSnapshot().card).length !== 0) throw new Error("destroyPool 未清空内存池")
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

export const 每日游标跨重启 = unit("variable-pool-daily-cursor-restart", "vp-20", "daily 游标跨重启：同日不重置、跨日重置一次并推进游标", async () => {
  seedDirty()
  // 游标缺省（首次激活 / 升级前数据）视为陈旧 → 换日重置一次并推进游标
  const first = applyResetPolicies(DAY_1, null)
  if (!first.includes("每日")) throw new Error(`游标缺省时未重置 daily 变量: ${first.join(", ")}`)
  // 再推回 9：下一次判定如果误判「今天已重置过」，这个值就会留下来
  batchWriteVars({ 每日: "9" })
  await savePoolToDiskStrict()

  await restartFromDisk()
  if (await loadCardVars(CARD_ID).then(state => state?.lastDailyResetKey) !== "2099-04-01") {
    throw new Error("daily 游标未落盘，跨重启判定没有依据")
  }

  // ① 同一日期键，跨重启后也不该再重置
  if (applyResetPolicies(DAY_1, null).length !== 0) {
    throw new Error("同一天在重启后再次触发重置（daily 游标未从磁盘生效）")
  }
  if (getPoolSnapshot().card["每日"]?.value !== 9) throw new Error("同日不应改动 daily 变量")

  // ② 换日 → 重置一次并推进游标
  const next = applyResetPolicies(DAY_2, null)
  if (!next.includes("每日")) throw new Error(`跨日未重置 daily 变量: ${next.join(", ")}`)
  if (getPoolSnapshot().card["每日"]?.value !== 1) {
    throw new Error(`daily 变量未回到 initial: ${getPoolSnapshot().card["每日"]?.value}`)
  }
  await savePoolToDiskStrict()
  const after = await loadCardVars(CARD_ID)
  if (after?.lastDailyResetKey !== "2099-04-02") {
    throw new Error(`换日后的游标未落盘: ${after?.lastDailyResetKey}`)
  }

  // ③ never 策略的变量在两个触发条件下都不动
  if (getPoolSnapshot().card["永久"]?.value !== 9) throw new Error("reset=never 的变量被重置")

  // ④ 从未写过的 Card 必须给 null（按 Card 初始值重建）而不是抛错
  if (await loadCardVars("live-test-cursors-never-written") !== null) {
    throw new Error("不存在的 cardId 应返回 null")
  }
})

export const 会话游标按键判定 = unit("variable-pool-session-cursor", "vp-21", "session 游标按持久化 sessionKey 判定，null 不判定", async () => {
  seedDirty()
  // 首次拿到会话键（游标缺省）→ 判定为新会话并重置
  const first = applyResetPolicies(DAY_1, SESSION_A)
  if (!first.includes("会话")) throw new Error(`新会话键未重置: ${first.join(", ")}`)
  batchWriteVars({ 会话: "9" })
  await savePoolToDiskStrict()

  await restartFromDisk()
  const loaded = await loadCardVars(CARD_ID)
  if (loaded?.sessionKey !== SESSION_A) throw new Error(`会话游标未落盘: ${loaded?.sessionKey}`)

  // ① null 不判定：没有会话键时不能凭空认定「新会话」
  if (applyResetPolicies(DAY_1, null).length !== 0) {
    throw new Error("sessionKey 为 null 时触发了重置")
  }
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("sessionKey 为 null 时值被改动")

  // ② 同一会话键跨重启幂等
  if (applyResetPolicies(DAY_1, SESSION_A).length !== 0) {
    throw new Error("同一会话键在重启后再次触发重置（session 游标未从磁盘生效）")
  }

  // ③ 换会话 → 重置一次并把新游标落盘
  const next = applyResetPolicies(DAY_1, SESSION_B)
  if (!next.includes("会话")) throw new Error(`换会话未重置: ${next.join(", ")}`)
  if (getPoolSnapshot().card["会话"]?.value !== 0) throw new Error("session 变量未回到 initial")
  await savePoolToDiskStrict()
  const after = await loadCardVars(CARD_ID)
  if (after?.sessionKey !== SESSION_B) throw new Error(`会话游标未落盘: ${after?.sessionKey}`)

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
  if (applyResetPolicies(DAY_1, null).length !== 0) {
    throw new Error("缺省会话游标 + null 键触发了重置")
  }
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("缺省会话游标下 session 变量被改动")
})
