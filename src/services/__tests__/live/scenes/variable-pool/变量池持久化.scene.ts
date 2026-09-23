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
 * 用测试专属 cardId，避免踩到真实 Card 的 `stages/{id}.json`。
 * Live Test 的 data_root 本身就是一次性临时目录（`$HOME/.deskpet-live-test-*`），
 * 场景之间也不会互相看见这个文件。
 */
const CARD_ID = "live-test-vars"

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

const unit = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: {
    caseId,
    module: "variable-pool",
    contractId,
    description,
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["variable-pool", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查变量池持久化。",
    checks: [{ type: "expectVariablePool", run: async () => run() }],
  }],
})

export const 变量池落盘 = unit("variable-pool-save", "vp-13", "savePoolToDisk 写入 stages/{cardId}.json", async () => {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  const written = batchWriteVars({ 亲密: "6", 心情: "开心" })
  if (written.written.length !== 2) throw new Error(`前置写入失败: ${written.errors.join("; ")}`)

  // 换日 + 换会话：两个重置游标必须随同一次写盘落进 variables 段
  applyResetPolicies(new Date(2099, 0, 2), SESSION_A)
  await savePoolToDiskStrict()

  // 直接读回磁盘：这是唯一能证明「真的落盘了」的方式，看内存池等于自证
  const loaded = await loadCardVars(CARD_ID)
  if (!loaded) throw new Error("落盘后读不到 stages 文件")
  if (loaded.card["亲密"]?.value !== 6) throw new Error(`亲密度未持久化: ${JSON.stringify(loaded.card["亲密"])}`)
  if (loaded.card["心情"]?.value !== "开心") throw new Error(`string 变量未持久化: ${JSON.stringify(loaded.card["心情"])}`)
  // interaction 变量与 card 变量分开存放，不能漏掉一边
  if (loaded.interaction["unansweredCount"]?.value !== 0) throw new Error("interaction 变量未持久化")
  // 游标是 variables 段的一部分：不落盘则跨重启必然判错「今天已重置过」
  if (loaded.lastDailyResetKey !== "2099-01-02") {
    throw new Error(`daily 游标未持久化: ${loaded.lastDailyResetKey}`)
  }
  if (loaded.sessionKey !== SESSION_A) throw new Error(`会话游标未持久化: ${loaded.sessionKey}`)
})

export const 变量池恢复 = unit("variable-pool-load", "vp-14", "loadCardVars 恢复持久化变量与重置游标", async () => {
  destroyPool()
  initVariablePool({ cardId: CARD_ID, variableDefs: DEFS })
  batchWriteVars({ 亲密: "4" })
  applyResetPolicies(new Date(2099, 3, 1), SESSION_A)
  await savePoolToDiskStrict()

  // 模拟重启：完全销毁运行时状态，再从磁盘重建。
  // destroy 之后立刻确认内存态真的空了 —— 放到 initVariablePool 之后再查就查不出来了。
  destroyPool()
  if (Object.keys(getPoolSnapshot().card).length !== 0) throw new Error("destroyPool 未清空内存池")

  const loaded = await loadCardVars(CARD_ID)
  if (!loaded) throw new Error("读不到已持久化的 stages 文件")
  if (loaded.lastDailyResetKey !== "2099-03-01" || loaded.sessionKey !== SESSION_A) {
    throw new Error(`重置游标未落盘: ${JSON.stringify({ lastDailyResetKey: loaded.lastDailyResetKey, sessionKey: loaded.sessionKey })}`)
  }
  const restored = initVariablePool({
    cardId: CARD_ID,
    variableDefs: DEFS,
    prevCardStates: loaded.card,
    prevInteractionStates: loaded.interaction,
    lastDailyResetKey: loaded.lastDailyResetKey,
    sessionKey: loaded.sessionKey,
  })
  if (restored.card["亲密"]?.value !== 4) throw new Error(`恢复后值不对: ${restored.card["亲密"]?.value}`)
  if (restored.card["每日"]?.value !== 1) throw new Error(`恢复后 daily 变量值不对: ${restored.card["每日"]?.value}`)
  if (restored.card["会话"]?.value !== 0) throw new Error(`恢复后 session 变量值不对: ${restored.card["会话"]?.value}`)

  // ① 同一天、同一会话键：两个游标都已应用 → 不重置
  batchWriteVars({ 每日: "9", 会话: "9" })
  if (applyResetPolicies(new Date(2099, 3, 1), SESSION_A).length !== 0) {
    throw new Error("同日同会话不应重置（重置游标未跨重启生效）")
  }

  // ② 换日：daily 重置并推进游标；会话键未变所以 session 变量不动
  const nextDay = applyResetPolicies(new Date(2099, 3, 2), SESSION_A)
  if (!nextDay.includes("每日")) throw new Error(`换日未重置 daily: ${nextDay.join(", ")}`)
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("换日不该重置 session 变量")
  await savePoolToDiskStrict()
  const afterDaily = await loadCardVars(CARD_ID)
  if (afterDaily?.lastDailyResetKey !== "2099-03-02") {
    throw new Error(`换日后的游标未落盘: ${afterDaily?.lastDailyResetKey}`)
  }

  // ③ 升级前的旧数据（没有 lastDailyResetKey）：视为陈旧，重置一次
  destroyPool()
  initVariablePool({
    cardId: CARD_ID,
    variableDefs: DEFS,
    prevCardStates: afterDaily?.card,
    prevInteractionStates: afterDaily?.interaction,
  })
  batchWriteVars({ 每日: "9" })
  const legacy = applyResetPolicies(new Date(2099, 3, 2), null)
  if (!legacy.includes("每日")) throw new Error("缺省游标的旧数据应把 daily 视为陈旧并重置一次")
  if (getPoolSnapshot().card["每日"]?.value !== 1) throw new Error("旧数据的 daily 未回到 initial")

  // ④ sessionKey 为 null → 不做 session 判定，值原样保留
  batchWriteVars({ 会话: "9" })
  if (applyResetPolicies(new Date(2099, 3, 2), null).length !== 0) {
    throw new Error("sessionKey=null 且游标已推进时不应触发任何重置")
  }
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("sessionKey=null 时 session 变量被改动")

  // ⑤ 会话键变化 → 重置，并把新游标落盘
  const newSession = applyResetPolicies(new Date(2099, 3, 2), SESSION_B)
  if (!newSession.includes("会话")) throw new Error(`换会话未重置: ${newSession.join(", ")}`)
  await savePoolToDiskStrict()
  const finalState = await loadCardVars(CARD_ID)
  if (finalState?.sessionKey !== SESSION_B) throw new Error(`会话游标未落盘: ${finalState?.sessionKey}`)

  // 不存在的 cardId 必须返回 null，而不是抛错 —— 首次启动就是这条路径
  if (await loadCardVars("live-test-never-written") !== null) {
    throw new Error("不存在的 cardId 应返回 null")
  }
})
