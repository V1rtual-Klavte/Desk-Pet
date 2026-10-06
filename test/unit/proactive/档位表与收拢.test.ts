// ==========================================
// 频率档位（src/services/proactive/tiers.ts）—— 读取期收拢与档位值表
// ==========================================
//
// 档位数值的冻结真相源是 `protocol.json` 的 `tiers` 表；这里按契约 §2.3 / §5.4 的
// 字面值钉住三域各档（任何被改动的数值都会红），并验证非法档位按读取期规则收拢为
// medium —— 收拢只发生在读取侧：不改写原值、不写盘。
// 例外：dreaming 档的 `dailyTokens` 已按 2026-10-06 用户裁决从三域表删除
// （「一天最多烧多少 token」取消），§5.4 的字面值不再含该字段。
import { describe, expect, it } from "vitest"
import {
  dreamingTierLimits,
  proactiveTierLimits,
  readFrequencyTier,
  silentTierLimits,
} from "@/services/proactive/tiers"

describe("档位读取期收拢", () => {
  it("合法四值原样返回", () => {
    expect(["off", "low", "medium", "high"].map(value => readFrequencyTier(value))).toEqual(["off", "low", "medium", "high"])
  })
  it("非法/缺失取值一律收拢为 medium", () => {
    expect(["ultra", "", 3, true, {}, undefined, null].map(value => readFrequencyTier(value))).toEqual(Array(7).fill("medium"))
  })
})

describe("档位值表", () => {
  it("主动消息三档与契约 §2.3 一致 [proactive-tier-table-frozen]", () => {
    expect(proactiveTierLimits("low")).toEqual({
      wakeMinMs: 7_200_000, wakeMaxMs: 18_000_000, dailySuccess: 2, dailyExpressionAttempts: 4,
      dailyPlanningAttempts: 3, dailyAuxiliaryAttempts: 2, minSuccessIntervalMs: 10_800_000,
      successIntervalSpreadMs: 7_200_000, dailyTokens: 8_000, staySeconds: 120, settleMs: 4_000,
      cooldownMs: 15_000, samePageCooldownMs: 20_000,
    })
    expect(proactiveTierLimits("medium")).toEqual({
      wakeMinMs: 1_800_000, wakeMaxMs: 5_400_000, dailySuccess: 6, dailyExpressionAttempts: 12,
      dailyPlanningAttempts: 8, dailyAuxiliaryAttempts: 4, minSuccessIntervalMs: 3_600_000,
      successIntervalSpreadMs: 7_200_000, dailyTokens: 24_000, staySeconds: 60, settleMs: 2_000,
      cooldownMs: 5_000, samePageCooldownMs: 7_800,
    })
    expect(proactiveTierLimits("high")).toEqual({
      wakeMinMs: 600_000, wakeMaxMs: 1_800_000, dailySuccess: 10, dailyExpressionAttempts: 20,
      dailyPlanningAttempts: 14, dailyAuxiliaryAttempts: 8, minSuccessIntervalMs: 1_800_000,
      successIntervalSpreadMs: 3_600_000, dailyTokens: 40_000, staySeconds: 30, settleMs: 1_000,
      cooldownMs: 3_000, samePageCooldownMs: 5_000,
    })
  })
  it("静默了解三档与契约 §2.3 一致", () => {
    expect(silentTierLimits("low")).toEqual({ minBatchGapMs: 7_200_000, idleRequiredMs: 7_200_000, dailyBatches: 4, maxReadsPerHour: 4 })
    expect(silentTierLimits("medium")).toEqual({ minBatchGapMs: 1_800_000, idleRequiredMs: 3_600_000, dailyBatches: 8, maxReadsPerHour: 8 })
    expect(silentTierLimits("high")).toEqual({ minBatchGapMs: 900_000, idleRequiredMs: 1_800_000, dailyBatches: 12, maxReadsPerHour: 12 })
  })
  it("记忆整理三档只含节奏两项（每日 token 上限已撤，2026-10-06 用户裁决）", () => {
    // 日 token 上限已从档位表删除（不再是任何门禁或观测阈值）：三档只剩空闲阈值与最小间隔。
    expect(dreamingTierLimits("low")).toEqual({ idleSeconds: 3_600, minIntervalMinutes: 240 })
    expect(dreamingTierLimits("medium")).toEqual({ idleSeconds: 1_800, minIntervalMinutes: 60 })
    expect(dreamingTierLimits("high")).toEqual({ idleSeconds: 600, minIntervalMinutes: 30 })
  })
})
