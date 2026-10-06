// ==========================================
// 稳定结论沉淀视图 —— 画像进入长期记忆的唯一出口（2026-10-06 方案 b）
// ==========================================
//
// 三条产品口径：
//  · 准入闸门：只有 reliable 档（≥3 个有效观察日 + 覆盖率 ≥60%）才产出结论，
//    其余状态返回空数组（不登记、不沉淀）；
//  · 只沉淀结论：文本带判据（画像字段与窗口），不落具体某天的工时、精确时间戳、
//    逐次应用切换细节（这些只留在画像域）；
//  · 可重验/可推翻：结论由当前 30 日滚动窗口重算 —— 新数据改写输入，文本随之变化
//    （版本收敛由整理侧完成，本文件只钉「输入变则结论变」）。
import { describe, expect, it } from "vitest"
import { buildSnapshot, emptyDaily } from "@/services/behavior/aggregate"
import { sedimentConclusions } from "@/services/behavior/conclusions"
import type { BehaviorDaily, BehaviorSnapshot } from "@/services/behavior/types"

const HOUR = 60 * 60_000
/** 覆盖率 6h/(6h+4h)=0.6，恰好落在 reliable 线上；3 个样本日满足天数门槛。 */
const COVERED_MS = 6 * HOUR
const UNOBSERVED_MS = 4 * HOUR

/** 三个有效观察日（2026-10-01 周四 / 10-02 周五 / 10-03 周六）。 */
function observedDays(shape: (day: BehaviorDaily, index: number) => void): BehaviorDaily[] {
  return ["2026-10-01", "2026-10-02", "2026-10-03"].map((date, index) => {
    const day = emptyDaily(date)
    day.coveredMs = COVERED_MS
    day.unobservedMs = UNOBSERVED_MS
    day.activeMs = 5 * HOUR
    day.idleMs = 1 * HOUR
    day.workSegments = 2
    day.workTotalMs = 50 * 60_000
    day.workLongestMs = 45 * 60_000
    shape(day, index)
    return day
  })
}

function snapshotOf(days: BehaviorDaily[]): BehaviorSnapshot {
  return buildSnapshot(days, Date.parse("2026-10-04T12:00:00"), 0, null)
}

/** 基线形状：工作日晚 19–22 点活跃、周六上午 10–13 点活跃、开发/浏览器为主、两个常用应用。 */
function baselineDays(): BehaviorDaily[] {
  return observedDays((day, index) => {
    const hours = index === 2 ? [10, 11, 12, 13] : [19, 20, 21, 22]
    for (const hour of hours) day.hourMs[hour] += 30 * 60_000
    day.categoryMs.development += 4 * HOUR
    day.categoryMs.browser += 2 * HOUR
    day.appMs["com.example.ide"] = (day.appMs["com.example.ide"] ?? 0) + 4 * HOUR
    day.appMs["com.example.browser"] = (day.appMs["com.example.browser"] ?? 0) + 2 * HOUR
  })
}

describe("稳定结论沉淀视图", () => {
  it("reliable 才产出结论，unavailable/insufficient 一律为空 [derived-behavior-reliable-gate]", () => {
    expect(snapshotOf(baselineDays()).quality.status, "基线数据不在 reliable 档（用例前提失效）").toBe("reliable")
    expect(sedimentConclusions(snapshotOf([])), "没有有效采集时间仍产出了结论").toEqual([])
    const twoDays = baselineDays().slice(0, 2)
    expect(snapshotOf(twoDays).quality.status).toBe("insufficient")
    expect(sedimentConclusions(snapshotOf(twoDays)), "不足 3 个有效观察日仍产出了结论").toEqual([])
    const lowCoverage = baselineDays().map(day => ({ ...day, unobservedMs: UNOBSERVED_MS + 1 }))
    expect(snapshotOf(lowCoverage).quality.status).toBe("insufficient")
    expect(sedimentConclusions(snapshotOf(lowCoverage)), "覆盖率低于 60% 仍产出了结论").toEqual([])
  })

  it("四组画像各出一条结论，文本带判据（窗口与画像字段）[derived-behavior-conclusion-criteria]", () => {
    const conclusions = sedimentConclusions(snapshotOf(baselineDays()))
    expect(conclusions.map(conclusion => conclusion.slot)).toEqual(["rhythm", "apps", "focus", "activity"])
    const rhythm = conclusions.find(conclusion => conclusion.slot === "rhythm")!
    // 期望值来自用例自己写入的钟点桶：工作日在 19–22 点投喂，最强 4 小时带 = 19–23 时；
    // 周六在 10–13 点投喂 = 10–14 时。
    expect(rhythm.text).toContain("工作日集中在 19–23 时")
    expect(rhythm.text).toContain("周末集中在 10–14 时")
    const apps = conclusions.find(conclusion => conclusion.slot === "apps")!
    expect(apps.text).toContain("开发")
    expect(apps.text).toContain("com.example.ide")
    const focus = conclusions.find(conclusion => conclusion.slot === "focus")!
    expect(focus.text).toContain("25 分钟") // 150 分钟 / 6 段
    expect(focus.text).toContain("45 分钟") // 最长段
    const activity = conclusions.find(conclusion => conclusion.slot === "activity")!
    expect(activity.text).toContain("50%") // 5h / (5h + 1h + 4h)
    for (const conclusion of conclusions) {
      expect(conclusion.text, `结论缺少判据（不可重验）: ${conclusion.text}`).toContain("判据")
      expect(conclusion.text).toContain("近30日画像窗口")
    }
  })

  it("原始账不进结论：没有日期、没有原始计数，逐日细节只留在画像域 [derived-behavior-not-raw-ledger]", () => {
    const days = baselineDays()
    // 哨兵值只可能出现在「把原始直方图/日账原样吐出来」的实现里。
    days[0]!.hourMs[3] = 123_456_789
    days[0]!.appMs["com.example.secret-title"] = 987_654_321
    const conclusions = sedimentConclusions(snapshotOf(days))
    const all = conclusions.map(conclusion => conclusion.text).join("\n")
    expect(all).not.toContain("123456789")
    expect(all).not.toContain("987654321")
    expect(all, "结论里出现了具体日期").not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(conclusions.length, "reliable 档的基线形状应产出 3 条以上结论（用例前提失效）").toBeGreaterThanOrEqual(3)
    expect(conclusions.length, "结论条数没有上界").toBeLessThanOrEqual(4)
    for (const conclusion of conclusions) {
      expect(conclusion.text.length, `单条结论过长: ${conclusion.text}`).toBeLessThanOrEqual(200)
    }
  })

  it("结论随滚动窗口重算：输入形状变化即产出新文本（可被推翻/修正）[derived-behavior-recompute]", () => {
    const before = sedimentConclusions(snapshotOf(baselineDays()))
    const moved = observedDays((day, index) => {
      const hours = index === 2 ? [14, 15, 16, 17] : [9, 10, 11, 12]
      for (const hour of hours) day.hourMs[hour] += 30 * 60_000
      day.categoryMs.development += 4 * HOUR
    })
    const after = sedimentConclusions(snapshotOf(moved))
    const rhythmBefore = before.find(conclusion => conclusion.slot === "rhythm")!.text
    const rhythmAfter = after.find(conclusion => conclusion.slot === "rhythm")!.text
    expect(rhythmAfter, "作息变了但结论文本没有变（不可推翻）").not.toBe(rhythmBefore)
    expect(rhythmAfter).toContain("9–13 时")
    // 同输入重算必须稳定（来源身份/幂等登记依赖这一条）。
    expect(sedimentConclusions(snapshotOf(baselineDays()))).toEqual(before)
  })
})
