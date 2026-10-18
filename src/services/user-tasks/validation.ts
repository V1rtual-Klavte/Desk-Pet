import { localToInstant } from "@/services/proactive/time"
import { currentSchedulePeriod, nextSchedulePeriod, sampleSchedulePeriod, schedulePeriodUnit } from "./calendar"
import type { ScheduleSpec, ScheduleValidation, ScheduleValidationOptions, UserTaskDefinition } from "./types"
import { deliveryFeasibility } from "./feasibility"

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
function keys(row: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) errors.push(`${path}.${key}: 未知字段`)
}
function time(value: unknown): value is string { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) }
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  try { return Number(value.slice(0, 4)) >= 100 && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value } catch { return false }
}

/** Validation accepts drafts so propose can return concrete missing fields without scheduling them. */
export function validateTaskDefinition(value: unknown, options: ScheduleValidationOptions = {}): ScheduleValidation {
  const missing: string[] = [], errors: string[] = [], limitations: string[] = []
  if (!object(value)) return { status: "needs_clarification", missing: ["task"], errors, limitations }
  keys(value, ["text", "kind", "schedule", "execution", "work", "delivery", "authorization"], "task", errors)
  for (const field of ["text", "kind", "schedule", "execution"]) if (value[field] === undefined) missing.push(field)
  if (value.text !== undefined && (!text(value.text) || value.text.length > 1000)) errors.push("text: 需要 1–1000 字符的任务目的")
  if (value.kind !== undefined && value.kind !== "reminder" && value.kind !== "agent_job") errors.push("kind: 只支持 reminder 或 agent_job")
  if (value.execution !== undefined) {
    if (!object(value.execution)) errors.push("execution: 无效对象")
    else {
      keys(value.execution, ["thinkingEffort"], "execution", errors)
      if (value.execution.thinkingEffort === undefined) missing.push("execution.thinkingEffort")
      else if (!["low", "medium", "high"].includes(String(value.execution.thinkingEffort))) errors.push("execution.thinkingEffort: 无效档位")
    }
  }
  if (value.schedule !== undefined) {
    if (!object(value.schedule)) errors.push("schedule: 无效对象")
    else validateSchedule(value.schedule, missing, errors, limitations, options)
  }
  if (value.kind === "agent_job" && value.work === undefined) missing.push("work")
  if (value.kind === "reminder" && value.work !== undefined) errors.push("work: reminder 不执行工作")
  if (value.work !== undefined) {
    if (!object(value.work)) errors.push("work: 无效对象")
    else {
      keys(value.work, ["goal", "inputs", "capabilities", "output", "completion"], "work", errors)
      for (const key of ["goal", "output", "completion"]) {
        if (value.work[key] === undefined) missing.push(`work.${key}`)
        else if (!text(value.work[key])) errors.push(`work.${key}: 不能为空`)
      }
      for (const key of ["inputs", "capabilities"]) {
        if (value.work[key] === undefined) missing.push(`work.${key}`)
        else if (!strings(value.work[key])) errors.push(`work.${key}: 必须是非空字符串数组`)
      }
      if (strings(value.work.capabilities) && options.availableCapabilities) {
        for (const capability of value.work.capabilities) if (!options.availableCapabilities.includes(capability)) errors.push(`work.capabilities: 不支持 ${capability}`)
      }
    }
  }
  if (value.delivery !== undefined) {
    if (!object(value.delivery)) errors.push("delivery: 无效对象")
    else {
      keys(value.delivery, ["sessionId", "cardId", "cardHash", "windowMinutes", "expression"], "delivery", errors)
      for (const key of ["sessionId", "cardId", "cardHash", "expression"]) if (!text(value.delivery[key])) errors.push(`delivery.${key}: 不能为空`)
      if (!integer(value.delivery.windowMinutes, 1, 10080)) errors.push("delivery.windowMinutes: 需要 1–10080 分钟")
    }
  }
  if (value.authorization !== undefined) {
    const auth = value.authorization
    if (!object(auth)) errors.push("authorization: 无效对象")
    else {
      keys(auth, ["trustedUserEventId", "proposalId", "contentFingerprint", "sourceVersions", "capabilityGrants"], "authorization", errors)
      if (!text(auth.trustedUserEventId) || !text(auth.contentFingerprint) || !Array.isArray(auth.sourceVersions) || !auth.sourceVersions.length) errors.push("authorization: 缺少可信事件、参数指纹或来源版本")
      if (auth.proposalId !== undefined && !text(auth.proposalId)) errors.push("authorization.proposalId: 无效身份")
      if (Array.isArray(auth.sourceVersions)) for (const ref of auth.sourceVersions) {
        if (!object(ref) || !text(ref.kind) || !text(ref.id) || !integer(ref.version, 1, Number.MAX_SAFE_INTEGER)
          || !integer(ref.revision, 0, Number.MAX_SAFE_INTEGER) || !text(ref.fingerprint)) errors.push("authorization.sourceVersions: 来源版本无效")
      }
      if (!Array.isArray(auth.capabilityGrants)) errors.push("authorization.capabilityGrants: 缺少能力描述授权")
      else {
        for (const grant of auth.capabilityGrants) {
          if (!object(grant) || !text(grant.toolName) || typeof grant.descriptorHash !== "string" || !/^[a-f0-9]{64}$/.test(grant.descriptorHash)) errors.push("authorization.capabilityGrants: 无效能力描述授权")
          else keys(grant, ["toolName", "descriptorHash"], "authorization.capabilityGrants", errors)
        }
        const names = auth.capabilityGrants.filter(object).map(grant => grant.toolName)
        const capabilities = object(value.work) && strings(value.work.capabilities) ? value.work.capabilities : []
        if (new Set(names).size !== names.length || capabilities.length !== names.length || capabilities.some(name => !names.includes(name))) errors.push("authorization.capabilityGrants: 必须精确覆盖声明能力且不得重复")
      }
    }
  }
  if (errors.length || missing.length) return { status: errors.length ? "rejected" : "needs_clarification", missing, errors, limitations }
  const definition = structuredClone(value) as unknown as UserTaskDefinition
  definition.text = definition.text.trim()
  definition.schedule.calendar.weekdays?.sort((left, right) => left - right)
  definition.schedule.calendar.dates?.sort()
  // Structural capacity is checked at the maximum requested count; no random draw changes consent.
  const schedule = definition.schedule
  if (schedule.trigger.kind === "observed_event") {
    const maximum = schedule.count.kind === "fixed" ? schedule.count.value : schedule.count.max
    const capacity = schedule.trigger.windowMinutes === 0 ? 1 : 1 + Math.floor((schedule.trigger.windowMinutes * 60_000 - 1) / Math.max(1, schedule.minGapMinutes * 60_000))
    if (maximum > capacity) return { status: "conflict", missing, errors: ["事件窗口无法容纳最大次数与最小间隔"], limitations }
  }
  if (schedule.trigger.kind !== "observed_event") {
    const maximum = schedule.count.kind === "fixed" ? schedule.count.value : schedule.count.max
    const firstFilteredDate = schedule.calendar.dates?.find(day => localToInstant(day, "00:00", schedule.calendar.timezone) >= schedule.validity.from)
    const reference = schedule.calendar.frequency === "once" ? localToInstant(schedule.calendar.date!, "00:00", schedule.calendar.timezone)
      : firstFilteredDate ? localToInstant(firstFilteredDate, "00:00", schedule.calendar.timezone) : schedule.validity.from
    try {
      // A date/weekday filter may leave the current bucket empty; that is not a capacity conflict.
      const full = { ...schedule, validity: { from: 0, until: null }, count: { kind: "fixed" as const, value: maximum, per: schedulePeriodUnit(schedule) } }
      let period = currentSchedulePeriod(full, reference)
      for (let index = 0; !period.windows.length && index < 400; index++) {
        const next = nextSchedulePeriod(full, period)
        if (!next) break
        period = next
      }
      sampleSchedulePeriod(full, period, () => 0)
    } catch {
      return { status: "conflict", missing, errors: ["时间窗口无法容纳最大次数与最小间隔"], limitations }
    }
  }
  if (options.deliveryConstraints) {
    const feasible = deliveryFeasibility(definition, options.deliveryConstraints)
    limitations.push(...feasible.limitations)
    if (feasible.status !== "ready") return { status: feasible.status, missing, errors: feasible.errors, limitations }
  }
  return { status: "ready", definition, missing, errors, limitations }
}

function validateSchedule(row: Record<string, unknown>, missing: string[], errors: string[], limitations: string[], options: ScheduleValidationOptions): void {
  keys(row, ["calendar", "trigger", "count", "minGapMinutes", "validity", "missedPolicy"], "schedule", errors)
  for (const key of ["calendar", "trigger", "count", "minGapMinutes", "validity", "missedPolicy"]) if (row[key] === undefined) missing.push(`schedule.${key}`)
  if (row.calendar !== undefined) {
    if (!object(row.calendar)) errors.push("schedule.calendar: 无效对象")
    else {
      const calendar = row.calendar
      keys(calendar, ["frequency", "timezone", "date", "weekdays", "dayOfMonth", "month", "dates"], "schedule.calendar", errors)
      if (calendar.frequency === undefined) missing.push("schedule.calendar.frequency")
      else if (!["once", "daily", "weekly", "monthly", "yearly"].includes(String(calendar.frequency))) errors.push("schedule.calendar.frequency: 无效周期")
      if (calendar.timezone === undefined) missing.push("schedule.calendar.timezone")
      else try {
        if (!text(calendar.timezone)) throw new Error("missing")
        new Intl.DateTimeFormat("en", { timeZone: calendar.timezone }).format(0)
        if (/^[+-]/.test(calendar.timezone)) throw new Error("fixed offset")
      } catch { errors.push("schedule.calendar.timezone: 需要合法 IANA 时区") }
      if (calendar.frequency === "once" && calendar.date === undefined) missing.push("schedule.calendar.date")
      if (calendar.date !== undefined && (!date(calendar.date) || calendar.frequency !== "once")) errors.push("schedule.calendar.date: 仅 once 使用合法日期")
      if (calendar.frequency === "weekly" && calendar.weekdays === undefined) missing.push("schedule.calendar.weekdays")
      if (calendar.weekdays !== undefined && (!Array.isArray(calendar.weekdays) || !calendar.weekdays.length || calendar.weekdays.some(day => !integer(day, 0, 6)) || new Set(calendar.weekdays).size !== calendar.weekdays.length)) errors.push("schedule.calendar.weekdays: 星期需为 0–6 且不重复")
      if (["monthly", "yearly"].includes(String(calendar.frequency)) && calendar.dayOfMonth === undefined) missing.push("schedule.calendar.dayOfMonth")
      if (calendar.dayOfMonth !== undefined && (!integer(calendar.dayOfMonth, 1, 31) || !["monthly", "yearly"].includes(String(calendar.frequency)))) errors.push("schedule.calendar.dayOfMonth: 仅月/年周期使用 1–31")
      if (calendar.frequency === "yearly" && calendar.month === undefined) missing.push("schedule.calendar.month")
      if (calendar.month !== undefined && (!integer(calendar.month, 1, 12) || calendar.frequency !== "yearly")) errors.push("schedule.calendar.month: 仅年周期使用 1–12")
      if (calendar.dates !== undefined && (!Array.isArray(calendar.dates) || !calendar.dates.length || calendar.dates.some(day => !date(day)) || new Set(calendar.dates).size !== calendar.dates.length)) errors.push("schedule.calendar.dates: 日期筛选无效")
    }
  }
  if (row.trigger !== undefined) {
    if (!object(row.trigger)) errors.push("schedule.trigger: 无效对象")
    else {
      const trigger = row.trigger
      const allowed = trigger.kind === "at" ? ["kind", "time"] : trigger.kind === "window" ? ["kind", "start", "end", "selection"]
        : trigger.kind === "confirmed_anchor" ? ["kind", "anchor", "offsetMinutes", "windowMinutes", "selection"] : ["kind", "event", "signal", "onUnavailable", "offsetMinutes", "windowMinutes", "selection"]
      keys(trigger, allowed, "schedule.trigger", errors)
      if (trigger.kind === "at") {
        if (trigger.time === undefined) missing.push("schedule.trigger.time")
        else if (!time(trigger.time)) errors.push("schedule.trigger.time: 需要 HH:mm")
      }
      else if (trigger.kind === "window") {
        if (trigger.start === undefined) missing.push("schedule.trigger.start")
        else if (!time(trigger.start)) errors.push("schedule.trigger.start: 需要 HH:mm")
        if (trigger.end === undefined) missing.push("schedule.trigger.end")
        else if (!time(trigger.end)) errors.push("schedule.trigger.end: 需要 HH:mm")
        if (trigger.start !== undefined && trigger.start === trigger.end) errors.push("schedule.trigger: 窗口起止须不同；跨午夜按起始日期归属")
      } else if (trigger.kind === "confirmed_anchor") {
        if (trigger.anchor === undefined) missing.push("schedule.trigger.anchor")
        else if (!object(trigger.anchor)) errors.push("schedule.trigger.anchor: 无效对象")
        else {
          keys(trigger.anchor, ["id", "localTime"], "schedule.trigger.anchor", errors)
          if (trigger.anchor.id === undefined) missing.push("schedule.trigger.anchor.id")
          else if (!text(trigger.anchor.id)) errors.push("schedule.trigger.anchor.id: 需要已确认锚点 ID")
          if (trigger.anchor.localTime === undefined) missing.push("schedule.trigger.anchor.localTime")
          else if (!time(trigger.anchor.localTime)) errors.push("schedule.trigger.anchor.localTime: 需要 HH:mm")
        }
      } else if (trigger.kind === "observed_event") {
        if (trigger.event !== "work_ended" || trigger.signal !== "working_to_idle" || trigger.onUnavailable !== "skip") errors.push("schedule.trigger: 只支持明确接受失效跳过的工作状态转空闲推测信号")
        if (options.observableSignals && !options.observableSignals.includes(String(trigger.signal))) errors.push("schedule.trigger: 当前观察能力不支持该事件，不能退化成固定时刻")
        limitations.push("工作状态转空闲是推测信号，不是现实下班证明；观察关闭或失效时跳过")
      } else if (trigger.kind === undefined) missing.push("schedule.trigger.kind")
      else errors.push("schedule.trigger.kind: 无效触发方式")
      if (trigger.kind === "confirmed_anchor" || trigger.kind === "observed_event") {
        if (trigger.offsetMinutes === undefined) missing.push("schedule.trigger.offsetMinutes")
        else if (!integer(trigger.offsetMinutes, 0, 10080)) errors.push("schedule.trigger.offsetMinutes: 需要 0–10080 分钟")
        if (trigger.windowMinutes === undefined) missing.push("schedule.trigger.windowMinutes")
        else if (!integer(trigger.windowMinutes, 0, 1440)) errors.push("schedule.trigger.windowMinutes: 需要 0–1440 分钟")
      }
      if (["window", "confirmed_anchor", "observed_event"].includes(String(trigger.kind))) {
        if (trigger.selection === undefined) missing.push("schedule.trigger.selection")
        else if (!["random", "spread"].includes(String(trigger.selection))) errors.push("schedule.trigger.selection: 需要 random 或 spread")
      }
    }
  }
  if (row.count !== undefined) {
    if (!object(row.count)) errors.push("schedule.count: 无效对象")
    else {
      const count = row.count
      keys(count, count.kind === "fixed" ? ["kind", "value", "per"] : ["kind", "min", "max", "per", "allowZero"], "schedule.count", errors)
      if (count.kind === "fixed") {
        if (count.value === undefined) missing.push("schedule.count.value")
        else if (!integer(count.value, 1, 100)) errors.push("schedule.count.value: 次数需为 1–100")
      }
      else if (count.kind === "random") {
        if (count.min === undefined) missing.push("schedule.count.min")
        if (count.max === undefined) missing.push("schedule.count.max")
        if ((count.min !== undefined && !integer(count.min, count.allowZero === true ? 0 : 1, 100)) || (count.max !== undefined && !integer(count.max, 1, 100)) || Number(count.min) > Number(count.max)) errors.push("schedule.count: 随机整数范围无效，零次须明确允许")
        if (count.allowZero !== undefined && count.allowZero !== true) errors.push("schedule.count.allowZero: 只允许显式 true")
      } else if (count.kind === undefined) missing.push("schedule.count.kind")
      else errors.push("schedule.count.kind: 无效次数方式")
      if (count.per === undefined) missing.push("schedule.count.per")
      else if (object(row.calendar) && ["once", "daily", "weekly", "monthly", "yearly"].includes(String(row.calendar.frequency))
        && count.per !== { once: "once", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[row.calendar.frequency as "once"]) errors.push("schedule.count.per: 必须与日历周期一致")
    }
  }
  if (row.minGapMinutes !== undefined && !integer(row.minGapMinutes, 0, 10080)) errors.push("schedule.minGapMinutes: 需要 0–10080 分钟")
  if (row.validity !== undefined) {
    if (!object(row.validity)) errors.push("schedule.validity: 无效对象")
    else {
      keys(row.validity, ["from", "until"], "schedule.validity", errors)
      if (row.validity.from === undefined) missing.push("schedule.validity.from")
      if (row.validity.until === undefined) missing.push("schedule.validity.until")
      if ((row.validity.from !== undefined && (!finite(row.validity.from) || row.validity.from < 0))
        || (row.validity.until !== undefined && row.validity.until !== null && (!finite(row.validity.until) || row.validity.until <= Number(row.validity.from)))) errors.push("schedule.validity: 起止时间无效；长期有效须显式 until:null")
    }
  }
  if (row.missedPolicy !== undefined && !["within_window", "skip"].includes(String(row.missedPolicy))) errors.push("schedule.missedPolicy: 无效错过策略")
}

export function parseUserTaskDefinition(value: unknown): UserTaskDefinition | null {
  // Planner one-off intents remain their own valid domain objects; they are not rich user tasks.
  if (!object(value) || (value.kind !== "reminder" && value.kind !== "agent_job")) return null
  const result = validateTaskDefinition(value)
  return result.status === "ready" ? result.definition! : null
}

export function requireTaskDefinition(value: unknown, options?: ScheduleValidationOptions): UserTaskDefinition {
  const result = validateTaskDefinition(value, options)
  if (!result.definition) throw new Error([...result.missing.map(key => `${key}: 缺少参数`), ...result.errors].join("；"))
  return result.definition
}
