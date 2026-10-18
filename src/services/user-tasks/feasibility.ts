import { isQuietHour, localDayKey, localToInstant, shiftLocalDate } from "@/services/proactive/time"
import { currentSchedulePeriod, nextSchedulePeriod } from "./calendar"
import type { ScheduleDeliveryConstraints, ScheduleWindow, UserTaskDefinition } from "./types"

export function deliveryFeasibility(definition: UserTaskDefinition, constraints: ScheduleDeliveryConstraints): { status: "ready" | "needs_input" | "conflict"; errors: string[]; limitations: string[] } {
  const limitations = ["用户任务与主动消息共享每日成功额度和冷却；其他任务、应用关闭、静默或能力失效可能使目标次数未完成，不能保证送达次数"]
  if (!constraints.enabled) return { status: "needs_input", errors: ["主动交付当前已暂停；任务工具不能修改系统档位，请先由用户决定是否启用"], limitations }
  const schedule = definition.schedule, maximum = schedule.count.kind === "fixed" ? schedule.count.value : schedule.count.max
  if (schedule.trigger.kind === "observed_event") {
    if (maximum > constraints.dailySuccessLimit) return { status: "conflict", errors: ["事件任务最大次数超过现有每日成功额度"], limitations }
    limitations.push("事件发生时间尚未知，届时仍须核对静默窗口、剩余额度和冷却")
    return { status: "ready", errors: [], limitations }
  }
  const timezone = schedule.calendar.timezone
  const firstFiltered = schedule.calendar.dates?.find(day => localToInstant(day, "00:00", timezone) >= schedule.validity.from)
  const reference = schedule.calendar.frequency === "once" ? localToInstant(schedule.calendar.date!, "00:00", timezone) : firstFiltered ? localToInstant(firstFiltered, "00:00", timezone) : schedule.validity.from
  const full = { ...schedule, validity: { from: 0, until: null } }
  let period = currentSchedulePeriod(full, reference)
  for (let index = 0; !period.windows.length && index < 400; index++) {
    const next = nextSchedulePeriod(full, period)
    if (!next) break
    period = next
  }
  const speech = (window: ScheduleWindow): Array<{ from: number; until: number }> => {
    const end = window.fixed ? window.from + (definition.delivery?.windowMinutes ?? 15) * 60_000 : window.until
    const result: Array<{ from: number; until: number }> = []
    const quietTimezone = constraints.quietTimezone
    const endDay = localDayKey(end - 1, quietTimezone)
    for (let day = localDayKey(window.from, quietTimezone); day <= endDay; day = shiftLocalDate(day, 1)) for (let hour = 0; hour < 24; hour++) {
      if (isQuietHour(hour, constraints.quietStartHour, constraints.quietEndHour)) continue
      const from = Math.max(window.from, localToInstant(day, `${String(hour).padStart(2, "0")}:00`, quietTimezone))
      const until = Math.min(end, localToInstant(hour === 23 ? shiftLocalDate(day, 1) : day, `${String((hour + 1) % 24).padStart(2, "0")}:00`, quietTimezone))
      if (from < until) result.push({ from, until })
    }
    return result
  }
  let total = 0, nextAt = -Infinity
  const days = new Map<string, number>(), gap = Math.max(1, schedule.minGapMinutes * 60_000, constraints.cooldownMs)
  for (const window of period.windows) {
    let fixedUsed = false
    for (const segment of speech(window)) {
      for (let at = Math.max(segment.from, nextAt); at < segment.until; at += gap) {
        const day = localDayKey(at, constraints.quietTimezone), used = days.get(day) ?? 0
        if (used >= constraints.dailySuccessLimit) break
        days.set(day, used + 1); total++; nextAt = at + gap
        if (window.fixed) { fixedUsed = true; break }
        if (total >= maximum) break
      }
      if (fixedUsed || total >= maximum) break
    }
    if (total >= maximum) break
  }
  return maximum > total ? { status: "conflict", errors: [total === 0 ? "完整有效窗口全部落在静默时段，无法交付" : "最大次数超出现有每日成功额度、冷却或静默后窗口容量"], limitations }
    : { status: "ready", errors: [], limitations }
}
