import { describe, expect, it } from "vitest"
import { activeSchedulePeriods, currentSchedulePeriod, nextSchedulePeriod, sampleSchedulePeriod } from "@/services/user-tasks/calendar"
import { validateTaskDefinition } from "@/services/user-tasks/validation"
import { acceptScheduleProposal, directScheduleAuthorization, taskContentFingerprint } from "@/services/user-tasks/proposals"
import type { ScheduleProposal, UserTaskDefinition } from "@/services/user-tasks/types"

const instant = Date.parse
function task(): UserTaskDefinition {
  return { text: "提醒起来走走", kind: "reminder", execution: { thinkingEffort: "low" }, schedule: {
    calendar: { frequency: "daily", timezone: "UTC" }, trigger: { kind: "at", time: "09:00" }, count: { kind: "fixed", value: 1, per: "day" },
    minGapMinutes: 0, validity: { from: instant("2026-01-01T00:00:00Z"), until: null }, missedPolicy: "within_window",
  } }
}

describe("用户安排日历与内容授权", () => {
  it("缺失时刻返回待澄清，非法时区/计数周期与未知字段拒绝 [schedule-definition-validation]", () => {
    const draft = task()
    expect(validateTaskDefinition({ ...draft, schedule: { ...draft.schedule, trigger: { kind: "at" } } })).toMatchObject({ status: "needs_clarification", missing: ["schedule.trigger.time"] })
    expect(validateTaskDefinition({ ...draft, schedule: { ...draft.schedule, calendar: { frequency: "daily", timezone: "GMT+8" } } })).toMatchObject({ status: "rejected" })
    expect(validateTaskDefinition({ ...draft, schedule: { ...draft.schedule, count: { kind: "fixed", value: 1, per: "week" } } })).toMatchObject({ status: "rejected" })
    expect(validateTaskDefinition({ ...draft, handler: "system.dreaming" })).toMatchObject({ status: "rejected", errors: ["task.handler: 未知字段"] })
  })
  it("周末起始的工作周日期筛选不会误判容量冲突 [schedule-filtered-period-validation]", () => {
    const definition = task()
    definition.schedule.calendar.weekdays = [1, 2, 3, 4, 5]
    definition.schedule.validity.from = instant("2026-10-18T00:00:00Z")
    expect(validateTaskDefinition(definition).status).toBe("ready")
  })
  it("一次/每周/月底/闰年安排按当地日历投影 [schedule-calendar-frequencies]", () => {
    const once = task().schedule
    once.calendar = { frequency: "once", timezone: "Asia/Shanghai", date: "2026-10-19" }
    once.count = { kind: "fixed", value: 1, per: "once" }
    const oncePeriod = currentSchedulePeriod(once, instant("2026-10-18T00:00:00Z"))
    expect(oncePeriod.windows[0]?.from).toBe(instant("2026-10-19T01:00:00Z"))
    expect(nextSchedulePeriod(once, oncePeriod)).toBeNull()
    const weekly = task().schedule
    weekly.calendar = { frequency: "weekly", timezone: "UTC", weekdays: [1, 5] }
    weekly.count = { kind: "fixed", value: 2, per: "week" }
    expect(currentSchedulePeriod(weekly, instant("2026-10-14T00:00:00Z")).windows.map(window => window.from)).toEqual([
      instant("2026-10-12T09:00:00Z"), instant("2026-10-16T09:00:00Z"),
    ])
    const monthly = task().schedule
    monthly.calendar = { frequency: "monthly", timezone: "UTC", dayOfMonth: 31 }
    monthly.count = { kind: "fixed", value: 1, per: "month" }
    expect(currentSchedulePeriod(monthly, instant("2028-02-01T00:00:00Z")).windows[0]?.localDate).toBe("2028-02-29")
    const yearly = { ...monthly, calendar: { frequency: "yearly" as const, timezone: "UTC", month: 2, dayOfMonth: 29 }, count: { kind: "fixed" as const, value: 1, per: "year" as const } }
    expect(currentSchedulePeriod(yearly, instant("2027-01-01T00:00:00Z")).windows[0]?.localDate).toBe("2027-02-28")
  })
  it("DST 缺时推进到首合法分钟，日周期保留23小时 [schedule-calendar-dst]", () => {
    const schedule = task().schedule
    schedule.calendar.timezone = "America/New_York"
    schedule.trigger = { kind: "at", time: "02:30" }
    const period = currentSchedulePeriod(schedule, instant("2026-03-08T12:00:00Z"))
    expect(period.windows[0]?.from).toBe(instant("2026-03-08T07:00:00Z"))
    expect(period.until - period.from).toBe(23 * 3_600_000)
  })
  it("跨午夜随机窗和固定点追赶都保留原周期身份 [schedule-cross-midnight-grace]", () => {
    const schedule = task().schedule
    schedule.trigger = { kind: "window", start: "23:00", end: "01:00", selection: "random" }
    const periods = activeSchedulePeriods(schedule, instant("2026-10-19T00:30:00Z"))
    expect(periods.map(period => period.key)).toEqual(["day:2026-10-18:UTC", "day:2026-10-19:UTC"])
    expect(periods[0]?.windows[0]).toEqual({ from: instant("2026-10-18T23:00:00Z"), until: instant("2026-10-19T01:00:00Z"), localDate: "2026-10-18" })
    schedule.trigger = { kind: "at", time: "23:59" }
    expect(activeSchedulePeriods(schedule, instant("2026-10-19T00:05:00Z"), 15 * 60_000).map(period => period.key)).toEqual(["day:2026-10-18:UTC", "day:2026-10-19:UTC"])
    schedule.calendar = { frequency: "once", timezone: "UTC", date: "2026-10-18" }
    expect(activeSchedulePeriods(schedule, instant("2026-10-19T00:05:00Z"), 15 * 60_000)).toHaveLength(1)
    expect(activeSchedulePeriods(schedule, instant("2026-10-19T00:14:00Z"), 15 * 60_000)).toEqual([])
  })
  it("随机整数包含上界，时间点满足窗口和最小间隔 [schedule-random-count-gap]", () => {
    const schedule = task().schedule
    schedule.trigger = { kind: "window", start: "18:00", end: "22:00", selection: "random" }
    schedule.count = { kind: "random", min: 1, max: 3, per: "day" }
    schedule.minGapMinutes = 30
    const draws = [0.999, 0, 0, 0]
    const sample = sampleSchedulePeriod(schedule, currentSchedulePeriod(schedule, instant("2026-10-18T00:00:00Z")), () => draws.shift()!)
    expect(sample.targetCount).toBe(3)
    expect(sample.instants).toEqual([instant("2026-10-18T18:00:00Z"), instant("2026-10-18T18:30:00Z"), instant("2026-10-18T19:00:00Z")])
    expect(sample.windowUntil).toBe(instant("2026-10-18T22:00:00Z"))
    expect(() => sampleSchedulePeriod(schedule, currentSchedulePeriod(schedule, instant("2026-10-18T00:00:00Z")), () => 1)).toThrow("[0, 1)")
  })
  it("最大次数容量冲突不能靠少抽签掩盖，零次须显式允许 [schedule-capacity-zero-count]", () => {
    const definition = task()
    definition.schedule.trigger = { kind: "window", start: "18:00", end: "18:30", selection: "random" }
    definition.schedule.count = { kind: "random", min: 1, max: 3, per: "day" }
    definition.schedule.minGapMinutes = 20
    expect(validateTaskDefinition(definition).status).toBe("conflict")
    definition.schedule.count = { kind: "random", min: 0, max: 1, per: "day" }
    expect(validateTaskDefinition(definition).status).toBe("rejected")
    definition.schedule.count.allowZero = true
    expect(validateTaskDefinition(definition).status).toBe("ready")
    const sampled = sampleSchedulePeriod(definition.schedule, currentSchedulePeriod(definition.schedule, instant("2026-10-18T00:00:00Z")), () => 0)
    expect(sampled.instants).toEqual([])
    expect(sampled.windowUntil).toBe(instant("2026-10-18T18:30:00Z"))
  })
  it("观察事件缺失时不能伪造触发或降级固定时刻 [schedule-observed-event-evidence]", () => {
    const definition = task()
    definition.schedule.trigger = { kind: "observed_event", event: "work_ended", signal: "working_to_idle", onUnavailable: "skip", offsetMinutes: 0, windowMinutes: 120, selection: "random" }
    expect(validateTaskDefinition(definition, { observableSignals: [] }).status).toBe("rejected")
    const now = instant("2026-10-18T18:00:00Z")
    const noEvent = currentSchedulePeriod(definition.schedule, now)
    expect(noEvent).toMatchObject({ awaitingEvent: true, windows: [] })
    expect(() => sampleSchedulePeriod(definition.schedule, noEvent, () => 0)).toThrow("观察事件尚未发生")
    const event = currentSchedulePeriod(definition.schedule, now, { event: "work_ended", signal: "working_to_idle", occurredAt: now })
    expect(event.windows).toEqual([{ from: now, until: now + 120 * 60_000, localDate: "2026-10-18" }])
    expect(sampleSchedulePeriod(definition.schedule, event, () => 0).windowUntil).toBe(instant("2026-10-18T20:00:00Z"))
  })
  it("观察事件以真实发生时刻归属周期：跨午夜不丢、同日两次不共用样本 [schedule-observed-event-period-identity]", () => {
    const definition = task()
    definition.schedule.trigger = { kind: "observed_event", event: "work_ended", signal: "working_to_idle", onUnavailable: "skip", offsetMinutes: 0, windowMinutes: 120, selection: "random" }
    const late = instant("2026-10-18T23:50:00Z")
    const event = { event: "work_ended" as const, signal: "working_to_idle" as const, occurredAt: late }
    const period = currentSchedulePeriod(definition.schedule, late, event)
    expect(period.key).toBe(`day:2026-10-18:UTC:event:${late}`)
    expect(period.windows[0]).toEqual({ from: late, until: late + 120 * 60_000, localDate: "2026-10-18" })
    const second = currentSchedulePeriod(definition.schedule, late + 60 * 60_000, { ...event, occurredAt: late + 60 * 60_000 })
    expect(second.key).not.toBe(period.key)
    definition.schedule.calendar = { frequency: "once", timezone: "UTC", date: "2026-10-18" }
    definition.schedule.count = { kind: "fixed", value: 1, per: "once" }
    expect(currentSchedulePeriod(definition.schedule, instant("2026-10-19T00:10:00Z"), event)).toMatchObject({
      key: `once:2026-10-18:UTC:event:${late}`, awaitingEvent: false,
      windows: [{ from: late, until: late + 120 * 60_000, localDate: "2026-10-18" }],
    })
  })
  it("当前额度、冷却与全静默窗口冲突不能被创建承诺掩盖 [schedule-delivery-feasibility]", () => {
    const definition = task(), constraints = { enabled: true, dailySuccessLimit: 10, cooldownMs: 3_000, quietStartHour: 23, quietEndHour: 9, quietTimezone: "UTC" }
    definition.schedule.trigger = { kind: "window", start: "18:00", end: "22:00", selection: "random" }
    definition.schedule.count = { kind: "fixed", value: 100, per: "day" }
    expect(validateTaskDefinition(definition, { deliveryConstraints: constraints }).status).toBe("conflict")
    definition.schedule.count = { kind: "fixed", value: 1, per: "day" }
    expect(validateTaskDefinition(definition, { deliveryConstraints: { ...constraints, enabled: false } }).status).toBe("needs_input")
    definition.schedule.trigger = { kind: "window", start: "00:00", end: "01:00", selection: "random" }
    expect(validateTaskDefinition(definition, { deliveryConstraints: constraints })).toMatchObject({ status: "conflict", errors: ["完整有效窗口全部落在静默时段，无法交付"] })
    definition.schedule.trigger = { kind: "window", start: "18:00", end: "18:01", selection: "random" }
    definition.schedule.count = { kind: "fixed", value: 3, per: "day" }
    expect(validateTaskDefinition(definition, { deliveryConstraints: { ...constraints, cooldownMs: 30_000 } }).status).toBe("conflict")
  })
  it("任务时区只定义安排，静默与每日额度沿实际系统本地时区核对 [schedule-delivery-cross-timezone]", () => {
    const definition = task()
    definition.schedule.calendar.timezone = "Asia/Shanghai"
    definition.schedule.trigger = { kind: "at", time: "09:00" }
    const constraints = { enabled: true, dailySuccessLimit: 10, cooldownMs: 3_000, quietStartHour: 23, quietEndHour: 9, quietTimezone: "America/New_York" }
    expect(validateTaskDefinition(definition, { deliveryConstraints: constraints }).status).toBe("ready")
    definition.schedule.trigger.time = "14:00"
    expect(validateTaskDefinition(definition, { deliveryConstraints: constraints }).status).toBe("conflict")
  })
  it("完整明确指令直接授权，缺失时间与推断目的需要具体提议 [proactive-recurrence-consent]", () => {
    const definition = task()
    expect(directScheduleAuthorization(definition, "每天09:00提醒起来走走")).toEqual({ explicit: true, inferred: [] })
    expect(directScheduleAuthorization(definition, "每天提醒起来走走").inferred).toEqual(["schedule.trigger.time"])
    expect(directScheduleAuthorization(definition, "每天09:00提醒吃药").inferred).toEqual(["text"])
  })
  it("短同意跨回合绑定提议内容、归属与目标版本 [proactive-recurrence-proposal-acceptance]", () => {
    const definition = task(), owner = { sessionId: "session-a", cardId: "card-a", cardHash: "hash-a", runGeneration: 1 }
    const proposal: ScheduleProposal = { proposalId: "proposal-a", assistantEntryId: "assistant-a", definition, owner, contentFingerprint: taskContentFingerprint(definition),
      sourceVersions: [{ kind: "user_entry", id: "source-a", version: 1, revision: 1, fingerprint: "source-hash" }], capabilityGrants: [], validUntil: 20_000 }
    expect(acceptScheduleProposal([proposal], "proposal-a", { ...owner, runGeneration: 2 }, definition, "好，就这样", 10_000).proposalId).toBe("proposal-a")
    expect(() => acceptScheduleProposal([proposal], "proposal-a", owner, { ...definition, text: "吃药" }, "好", 10_000)).toThrow("不一致")
    expect(() => acceptScheduleProposal([proposal], "proposal-a", { ...owner, cardHash: "changed" }, definition, "好", 10_000)).toThrow("没有匹配")
    expect(() => acceptScheduleProposal([proposal], "proposal-a", owner, definition, "好像可以试试", 10_000)).toThrow("没有匹配")
    expect(() => acceptScheduleProposal([proposal], "proposal-a", owner, definition, "好", 21_000)).toThrow("已过期")
    expect(() => acceptScheduleProposal([proposal], "proposal-a", owner, definition, "好", 10_000, { taskId: "task-b", expectedVersion: 2, action: "update" })).toThrow("目标或版本不一致")
  })
})
