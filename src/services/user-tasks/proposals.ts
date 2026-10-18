import { createHash } from "node:crypto"
import type { ProactiveOwner } from "@/services/proactive/protocol"
import type { ScheduleProposal, UserTaskDefinition } from "./types"
import { localDayKey, shiftLocalDate } from "@/services/proactive/time"

export function canonicalTaskContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskContent).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(key => key !== "authorization")
    .map(key => `${JSON.stringify(key)}:${canonicalTaskContent((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
export function taskContentFingerprint(definition: UserTaskDefinition): string {
  return createHash("sha256").update(canonicalTaskContent(definition)).digest("hex")
}
export function isScheduleAcceptance(evidence: string): boolean {
  return /^(?:好|好的|可以|行|没问题|同意|照这个|按这个|就这样)(?:\s*[，,、]?\s*(?:就这样|按这个(?:安排|时间)?|按刚才的|照这个(?:安排)?|安排吧))?[。！!\s]*$/.test(evidence.trim())
}
export function acceptScheduleProposal(proposals: readonly ScheduleProposal[], proposalId: string | undefined,
  owner: ProactiveOwner, definition: UserTaskDefinition, evidence: string, now: number, target?: ScheduleProposal["target"]): ScheduleProposal {
  const proposal = proposals.find(row => row.proposalId === proposalId)
  if (!proposal || !proposal.assistantEntryId || !isScheduleAcceptance(evidence)
    || proposal.owner.sessionId !== owner.sessionId || proposal.owner.cardId !== owner.cardId || proposal.owner.cardHash !== owner.cardHash)
    throw new Error("本轮没有匹配且仍有效的明确安排提议")
  if (proposal.validUntil <= now) throw new Error("安排提议已过期")
  if (canonicalTaskContent(proposal.target) !== canonicalTaskContent(target)) throw new Error("提议目标或版本不一致")
  const fingerprint = taskContentFingerprint(definition)
  if (proposal.contentFingerprint !== fingerprint || proposal.contentFingerprint !== taskContentFingerprint(proposal.definition)) throw new Error("接受内容与提议不一致，关键参数变化须重新确认")
  return proposal
}

const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
function chineseNumber(value: number): string {
  if (value <= 10) return digits[value]!
  return `${value < 20 ? "" : digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`
}
function mentionsTime(evidence: string, value: string): boolean {
  if (evidence.includes(value) || evidence.includes(value.replace(":", "："))) return true
  const [hour, minute] = value.split(":").map(Number) as [number, number]
  const hours = [String(hour), chineseNumber(hour)]
  if (hour > 12 && /下午|晚上|晚间|傍晚|夜里/.test(evidence)) hours.push(String(hour - 12), chineseNumber(hour - 12))
  const suffix = minute === 0 ? "(?:点|时)(?:整|钟)?" : minute === 30 ? "(?:点|时)(?:半|30(?:分)?|三十分?)" : `(?:点|时)(?:${minute}|${chineseNumber(minute)})(?:分)?`
  return hours.some(part => new RegExp(`${part}${suffix}`).test(evidence))
}
function mentionsNumber(evidence: string, value: number): boolean {
  return new RegExp(`(?:${value}|${chineseNumber(value)})(?:次|分钟|分|到|至|[–—-])`).test(evidence)
}
/** Proves explicit syntactic schedule slots; missing/inferred slots require a content-bound proposal. */
export function directScheduleAuthorization(definition: UserTaskDefinition, evidence: string, referenceNow?: number): { explicit: boolean; inferred: string[] } {
  const inferred: string[] = []
  const { calendar, trigger, count, minGapMinutes, validity } = definition.schedule
  if (!/提醒|帮我|请|安排|记得|叫我|改为|改成|更新|改期/.test(evidence) || /(?:不要|别|不用|不必|停止|取消).{0,8}(?:提醒|安排|叫我)/.test(evidence)) inferred.push("authorization")
  const frequencyEvidence = { once: /提醒|安排|记得|帮我|请|到时/, daily: /每天|每日|每晚|每早/, weekly: /每周|每星期|每礼拜/, monthly: /每月/, yearly: /每年/ }
  if (!frequencyEvidence[calendar.frequency].test(evidence)) inferred.push("schedule.calendar.frequency")
  const purpose = definition.text.replace(/^(?:请|帮我|提醒我|提醒|记得|按时|安排)+/g, "").replace(/[\s，,。.!！?？]/g, "")
  if (purpose.length < 2 || !evidence.replace(/[\s，,。.!！?？]/g, "").includes(purpose)) inferred.push("text")
  if (calendar.frequency === "once" && calendar.date && !evidence.includes(calendar.date)) {
    const relative = /后天/.test(evidence) ? 2 : /明天|明晚/.test(evidence) ? 1 : /今天|今晚/.test(evidence) ? 0 : null
    if (referenceNow === undefined || relative === null || shiftLocalDate(localDayKey(referenceNow, calendar.timezone), relative) !== calendar.date) inferred.push("schedule.calendar.date")
  }
  if (calendar.weekdays) for (const weekday of calendar.weekdays) {
    if (!new RegExp(`(?:周|星期|礼拜)${["[日天]", "一", "二", "三", "四", "五", "六"][weekday]}`).test(evidence)
      && !(weekday >= 1 && weekday <= 5 && /周一(?:到|至|[–—-])(?:周)?五|星期一(?:到|至)(?:星期)?五/.test(evidence))) inferred.push("schedule.calendar.weekdays")
  }
  if (calendar.dayOfMonth !== undefined && !new RegExp(`(?:${calendar.dayOfMonth}|${chineseNumber(calendar.dayOfMonth)})(?:日|号)`).test(evidence)) inferred.push("schedule.calendar.dayOfMonth")
  if (calendar.month !== undefined && !new RegExp(`(?:${calendar.month}|${chineseNumber(calendar.month)})月`).test(evidence)) inferred.push("schedule.calendar.month")
  if (trigger.kind === "at" && !mentionsTime(evidence, trigger.time)) inferred.push("schedule.trigger.time")
  if (trigger.kind === "window") {
    if (!mentionsTime(evidence, trigger.start)) inferred.push("schedule.trigger.start")
    if (!mentionsTime(evidence, trigger.end)) inferred.push("schedule.trigger.end")
  }
  if (trigger.kind === "confirmed_anchor") inferred.push("schedule.trigger.anchor")
  if (trigger.kind === "observed_event") inferred.push("schedule.trigger.observation")
  if (trigger.kind !== "at" && trigger.selection === "random" && !/随机|随便选|任意(?:时间|时刻)/.test(evidence)) inferred.push("schedule.trigger.selection")
  if (count.kind === "random" && (!/随机|一到|一至|[一二三四五六七八九十\d](?:到|至|[–—-])[一二三四五六七八九十\d]/.test(evidence)
    || !mentionsNumber(evidence, count.min) || !mentionsNumber(evidence, count.max))) inferred.push("schedule.count")
  if (count.kind === "fixed" && count.value !== 1 && !mentionsNumber(evidence, count.value)) inferred.push("schedule.count")
  if (count.kind === "random" && count.min === 0 && !/零次|0次|可以不|不提醒/.test(evidence)) inferred.push("schedule.count.allowZero")
  if (minGapMinutes > 0 && !(minGapMinutes === 30 && /(?:间隔|隔|至少).*半小时/.test(evidence))
    && !new RegExp(`(?:间隔|隔|至少).*?(?:${minGapMinutes}|${chineseNumber(minGapMinutes)})(?:分|分钟)`).test(evidence)) inferred.push("schedule.minGapMinutes")
  if (validity.until !== null && !/截止|直到|到.*(?:为止|结束)|仅|只在/.test(evidence)) inferred.push("schedule.validity.until")
  if (definition.kind === "agent_job" && !/帮我|请|整理|查|搜索|分析|生成|收集|执行/.test(evidence)) inferred.push("work")
  if (definition.work?.inputs.some(input => !evidence.includes(input))) inferred.push("work.inputs")
  return { explicit: inferred.length === 0 && !isScheduleAcceptance(evidence), inferred: [...new Set(inferred)] }
}
