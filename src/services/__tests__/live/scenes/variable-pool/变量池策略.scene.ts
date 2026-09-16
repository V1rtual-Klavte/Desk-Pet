import type { SceneDef } from "../../types"
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
  { scope: "card", name: "永久", type: "number", initial: 0, description: "永不重置", updateBy: "llm", persistent: true, min: 0, max: 100, reset: "never" },
  { scope: "card", name: "每日", type: "number", initial: 1, description: "每日重置", updateBy: "llm", persistent: true, min: 0, max: 100, reset: "daily" },
  { scope: "card", name: "会话", type: "number", initial: 0, description: "会话重置", updateBy: "llm", persistent: true, min: 0, max: 100, reset: "session" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, description: "未回复数", updateBy: "system", persistent: true, min: 0, max: 9, reset: "never" },
]

const unit = (caseId: string, contractId: string, description: string, run: () => void): SceneDef => ({
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
    userText: "检查重置策略。",
    checks: [{ type: "expectVariablePool", run: async () => run() }],
  }],
})

/** 建池并把三个策略变量都推到非 initial，作为「今天已经涨过」的基线 */
const seedDirty = (): void => {
  destroyPool()
  initVariablePool({ cardId: "test-card", variableDefs: DEFS })
  const result = batchWriteVars({ 永久: "9", 每日: "9", 会话: "9" })
  if (result.written.length !== 3) throw new Error(`前置写入失败: ${result.errors.join("; ")}`)
}

export const 永不重置策略 = unit("variable-reset-never", "vp-09", "reset=never 的变量不参与任何重置", () => {
  seedDirty()
  // 同时给「跨天」与「新会话」两个触发条件，never 仍必须纹丝不动
  const resetVars = applyResetPolicies(new Date(2098, 0, 1), true)

  if (resetVars.includes("永久")) throw new Error("reset=never 的变量被重置")
  if (getPoolSnapshot().card["永久"]?.value !== 9) throw new Error("reset=never 的值被改动")
})

export const 每日重置策略 = unit("variable-reset-daily", "vp-10", "reset=daily 按日期键重置且幂等", () => {
  // ⚠️ `lastDailyResetKey` 是模块级状态，跨场景、跨 trial 都不会复位，
  // 而且 `applyResetPolicies` 末尾**无条件**把它推进到传入的日期。
  // 所以不能假设「现在这个日期一定是新的」—— 先自己把键归一到 d1，
  // 再用 d2 验证换日行为，断言才与执行顺序、trial 次数都无关。
  const d1 = new Date(2099, 0, 1)
  const d2 = new Date(2099, 0, 2)
  applyResetPolicies(d1, false)

  seedDirty()
  const reset = applyResetPolicies(d2, false)

  if (!reset.includes("每日")) throw new Error(`跨天未重置 daily 变量: ${reset.join(", ")}`)
  if (getPoolSnapshot().card["每日"]?.value !== 1) {
    throw new Error(`daily 变量未回到 initial，实际 ${getPoolSnapshot().card["每日"]?.value}`)
  }
  // 同一日期键重复调用必须幂等
  if (applyResetPolicies(d2, false).length !== 0) throw new Error("同一日期重复调用不应再重置")
  // daily 只影响自己，不该顺手重置 session 变量
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("false 的 isNewSession 不该重置 session 变量")
})

export const 会话重置策略 = unit("variable-reset-session", "vp-11", "reset=session 仅在新会话时重置", () => {
  seedDirty()

  // isNewSession=false → 不重置
  const noop = applyResetPolicies(new Date(2099, 5, 1), false)
  if (noop.includes("会话")) throw new Error("非新会话时 session 变量被重置")
  if (getPoolSnapshot().card["会话"]?.value !== 9) throw new Error("非新会话时值被改动")

  // isNewSession=true → 重置（只看这个开关，不受 daily 的模块级状态影响）
  const reset = applyResetPolicies(new Date(2099, 5, 1), true)
  if (!reset.includes("会话")) throw new Error(`新会话未重置: ${reset.join(", ")}`)
  if (getPoolSnapshot().card["会话"]?.value !== 0) throw new Error("session 变量未回到 initial")
})

export const 交互变量更新 = unit("variable-interaction-update", "vp-12", "updateInteractionVar 写入 interaction 变量", () => {
  destroyPool()
  initVariablePool({ cardId: "test-card", variableDefs: DEFS })

  // 字符串数字要能强制转换（系统侧回调常传字符串）
  const ok = updateInteractionVar("unansweredCount", "3")
  if (!ok.success) throw new Error(`合法写入被拒: ${ok.error}`)
  const state = getPoolSnapshot().interaction["unansweredCount"]
  if (state?.value !== 3 || state?.updatedBy !== "system") {
    throw new Error(`写入结果不对: ${JSON.stringify(state)}`)
  }

  // 越界必须拒绝，且不能改坏已有值
  const over = updateInteractionVar("unansweredCount", 99)
  if (over.success) throw new Error("越界写入被放行")
  if (getPoolSnapshot().interaction["unansweredCount"]?.value !== 3) throw new Error("被拒的写入改动了变量")

  // 未注册的名字同样拒绝
  if (updateInteractionVar("不存在", 1).success) throw new Error("未注册的 interaction 变量被写入")
})
