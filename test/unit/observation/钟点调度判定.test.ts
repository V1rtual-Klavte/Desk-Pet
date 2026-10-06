// ==========================================
// 钟点调度判定（src/services/proactive/schedule.ts）—— 静默了解与记忆整理共用的固定钟点触发
// ==========================================
//
// 2026-10-06 用户裁决：两链从空闲触发改为固定钟点触发，钟点表是每日轮数上限的唯一来源。
// 判定是纯函数（注入 now / lastAttemptAt），本文件逐项见证：
//   · 到点触发：钟点后 15 分钟追赶窗口内、该钟点本轮未跑过；
//   · 未到点：窗口右界起、表外钟点、窗口边界前一刻；
//   · 同钟点已跑不再跑：尝试时刻不早于钟点起点；未来时间戳按已跑处理（fail-closed）；
//   · 静默时段（23–9）排除：表内不出现静默小时，凌晨任何档位都不触发；
//   · 三档表逐项：低 12/20、中 10/14/18/22、高 9/11/13/15/17/19，两域同表。
// 全部通过本地 Date 构造取时刻，不依赖测试机时区。
import { describe, expect, it } from "vitest"
import { SCHEDULE_CATCHUP_MS, scheduledSlotDue } from "@/services/proactive/schedule"
import { dreamingTierLimits, silentTierLimits } from "@/services/proactive/tiers"

/** 本地时刻（2026-10-06 固定日期），返回毫秒时间戳。 */
const at = (hour: number, minute: number, second = 0): number => new Date(2026, 9, 6, hour, minute, second, 0).getTime()

describe("钟点调度判定", () => {
  it("到点触发：追赶窗口内且该钟点未跑过 [observation-scheduled-slot-table]", () => {
    const hours = silentTierLimits("medium").hours
    expect(scheduledSlotDue(hours, at(10, 0, 0), 0), "钟点起点不触发").toBe(true)
    expect(scheduledSlotDue(hours, at(10, 14, 59), 0), "追赶窗口末端不触发").toBe(true)
    expect(scheduledSlotDue(hours, at(10, 5), at(9, 30)), "上一次尝试早于钟点起点仍应触发").toBe(true)
    // 同表两域（第 4 个钟点 22:00 同理）
    expect(scheduledSlotDue(hours, at(22, 7), 0)).toBe(true)
  })

  it("未到点不触发：窗口右界、表外钟点、窗口前一刻", () => {
    const hours = silentTierLimits("medium").hours
    expect(SCHEDULE_CATCHUP_MS).toBe(15 * 60_000)
    expect(scheduledSlotDue(hours, at(10, 15, 0), 0), "窗口右界（恰满 15 分钟）不应触发").toBe(false)
    expect(scheduledSlotDue(hours, at(10, 30), 0), "钟点半小时后不应触发").toBe(false)
    expect(scheduledSlotDue(hours, at(9, 59, 59), 0), "钟点前一刻不应触发").toBe(false)
    expect(scheduledSlotDue(hours, at(12, 0), 0), "12:00 是低档钟点，中档不应触发").toBe(false)
    expect(scheduledSlotDue(hours, at(11, 59), at(10, 3)), "两钟点之间不应触发").toBe(false)
  })

  it("同钟点已跑不再跑：尝试时刻不早于钟点起点即算跑过", () => {
    const hours = silentTierLimits("high").hours
    const slotStart = at(9, 0)
    expect(scheduledSlotDue(hours, at(9, 3), slotStart), "钟点起点上跑的算本钟点已跑").toBe(false)
    expect(scheduledSlotDue(hours, at(9, 3), slotStart + 60_000), "本钟点窗口内跑过不再跑").toBe(false)
    expect(scheduledSlotDue(hours, at(9, 3), slotStart - 1), "上一钟点跑过不挡本钟点").toBe(true)
    expect(scheduledSlotDue(hours, at(9, 3), at(9, 10)), "未来时间戳（时钟回拨）按已跑处理").toBe(false)
  })

  it("静默时段（23–9）排除：表内时钟点均落在 9–22，凌晨任何档位不触发", () => {
    const rows = [
      silentTierLimits("low"), silentTierLimits("medium"), silentTierLimits("high"),
      dreamingTierLimits("low"), dreamingTierLimits("medium"), dreamingTierLimits("high"),
    ]
    for (const row of rows) {
      expect(row.hours.every(hour => hour >= 9 && hour <= 22), `钟点表含静默小时：${JSON.stringify(row.hours)}`).toBe(true)
      for (const quietHour of [23, 0, 3, 8]) {
        expect(scheduledSlotDue(row.hours, at(quietHour, 5), 0), `${quietHour} 点不应触发`).toBe(false)
      }
    }
  })

  it("三档表逐项：钟点表两域同表，每日轮数 2/4/6 即上限", () => {
    const hourRows = [
      ["low", [12, 20]], ["medium", [10, 14, 18, 22]], ["high", [9, 11, 13, 15, 17, 19]],
    ] as const
    for (const [tier, hours] of hourRows) {
      expect(silentTierLimits(tier).hours, `静默了解 ${tier} 钟点表`).toEqual(hours)
      expect(dreamingTierLimits(tier).hours, `记忆整理 ${tier} 钟点表`).toEqual(hours)
      // 每个钟点的追赶窗口内都触发一次：表就是每日轮数上限的来源（低 2 / 中 4 / 高 6）。
      const triggers = hours.filter(hour => scheduledSlotDue(hours, at(hour, 3), 0))
      expect(triggers, `${tier} 钟点表未逐项触发`).toEqual(hours)
    }
    const rounds = ["low", "medium", "high"] as const
    expect(rounds.map(tier => silentTierLimits(tier).hours.length), "每日轮数上限").toEqual([2, 4, 6])
  })
})
