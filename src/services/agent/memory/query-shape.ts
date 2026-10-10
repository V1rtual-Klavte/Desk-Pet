// Shared local query cues; no model call or runtime dependencies.

export type MemoryRecallIntent = "none" | "lookup" | "overview" | "explanation" | "procedure" | "advice" | "count"

export interface MemoryTimeConstraint {
  basis: "record" | "event"
  start?: number
  end?: number
  calendarDate?: { year?: number; month: number; day: number }
}

export interface LocalMemoryQueryShape {
  recallIntent: MemoryRecallIntent
  sourceRoles: Array<"user" | "assistant">
  entities: string[]
  evidenceNeeds: string[]
  timeConstraint?: MemoryTimeConstraint
}

export interface DerivedMemoryQueryPlan extends LocalMemoryQueryShape {
  originalQuery: string
  queries: string[]
  rewriteStatus: "not_needed"
}

export function hasExplicitRewriteHint(query: string): boolean {
  return /(?:刚才|刚刚|之前|以前|上次|前面|提过|说过|我们聊过|某天聊了什么|那天聊了什么|你还记得|那个(?:偏好|习惯|东西|人|事情)?|那件事|那位|这件事|我喜欢|我的偏好|用户偏好|我的习惯|个人资料|画像|remember|previous|earlier|what did i (?:say|tell you)|my preference|about me)/iu.test(query)
}

const SOCIAL_ACKNOWLEDGEMENT = /^(?:你好|嗨|哈喽|hello|hi|谢谢|感谢|好的|好|收到|明白|知道了|嗯|ok|okay|got it|thanks|thank you)[!！?？。，,.\s]*$/iu
const SHORT_FOLLOWUP = /(?:这|那|它|他|她|然后|接下来|这个|那个|呢|再说|继续|\b(?:that|this|it|those|them|and then|what about|how about)\b)/iu
const PERSONAL_HISTORY_QUESTION = /(?:\b(?:what|which|when|where|how|who)\b.{0,140}\b(?:did you|did we|did i|have you|have we|have i|had i|i (?:was|am|earned|spent|bought|started|attended|took|have)|my)\b|\b(?:did you|did we|have you|have we)\b.{0,100}\b(?:recommend(?:ed)?|suggest(?:ed)?|mention(?:ed)?|say|said|tell|told|choose|decide)\b|\bwhat did i (?:say|tell|choose)\b|\bwhat (?:is|are|was|were) my\b|\bwhat do i\b|\bmy (?:favorite|favourite|preference|habit|usual|choice|plan|address|birthday|name)\b|我的(?:偏好|习惯|选择|安排|名字|地址|生日)|我(?:平时|通常|之前|上次).{0,12}(?:喜欢|选择|说过|告诉过)|我们(?:之前|上次|当时).{0,12}(?:决定|选定|说过)|你(?:刚才|之前|上次|当时).{0,12}(?:推荐|建议|提到|说过|告诉过))/iu
const PERSONAL_ADVICE = /(?:\b(?:recommend|suggest)\b.{0,100}\b(?:for me|i|my)\b|\b(?:i['’]ve|i have|i am|i['’]m)\b.{0,100}\b(?:trouble|struggling|advice|tips|recommend)\b|给我.{0,12}(?:推荐|建议)|(?:我|我的).{0,24}(?:困扰|遇到问题|不太顺利|有何建议|怎么办))/iu
const PAST_RECOMMENDATION = /(?:我(?:曾经|之前|以前|上次).{0,24}(?:推荐|建议)|你(?:曾经|之前|以前|上次).{0,24}(?:推荐|建议)|\bwhat did you recommend\b|\byou (?:previously|last time) recommended\b)/iu
const PERSONAL_EVENT_QUESTION = /(?:\b(?:how many|how much|why|how|what|which|when|where|who)\b.{0,140}\b(?:did i|have i|had i|was i|did we|have we|had we|were we)\b|\b(?:what steps|which steps)\b.{0,100}\b(?:did i take|have i taken|did we take|have we taken)\b)/iu
const FIRST_PERSON_CHINESE_QUESTION = /我(?:的)?[^。？！?！]{0,100}(?:什么|哪些|哪(?:个|些|档|种|部|本|次|里|儿|时)|什么时候|何时|为什么|为何|怎么|如何|多少|几(?:次|个|部|本|种|件|年|月|天)?|是否|吗|呢)/u
const CURRENT_ADVICE_REQUEST = /(?:我(?:应该|该|要不要|该不该)|给我.{0,12}(?:推荐|建议)|(?:what should i|what do you recommend|can you recommend|could you recommend|any advice|any tips))/iu

/** Personal history and advice require recall even when a few keyword facts already match. */
export function hasPersonalRecallIntent(query: string): boolean {
  return PERSONAL_HISTORY_QUESTION.test(query) || PERSONAL_ADVICE.test(query) || CURRENT_ADVICE_REQUEST.test(query)
}

/** Derive a conservative, deterministic retrieval plan from the user's exact wording. */
export function deriveLocalMemoryQueryShape(query: string, before?: number): LocalMemoryQueryShape {
  const text = query.trim()
  const datedConversationOverview = isDatedConversationOverview(text)
  const explicitRecall = datedConversationOverview || /(?:曾经分享过|分享过|推(?:过|荐过)|推过荐|推荐过|建议过|提过|说过|告诉过|记录|聊过|某天聊了什么|那天聊了什么|之前聊了什么|上次聊了什么|记得|回忆|我(?:之前|以前|上次|曾经)|我们(?:之前|以前|上次|曾经)|what did (?:you|we|i)|did you (?:recommend|suggest|mention|say)|have we discussed|previously shared)/iu.test(text)
  const personal = hasPersonalRecallIntent(text)
  const personalEvent = PERSONAL_EVENT_QUESTION.test(text)
  const personalQuestionText = text.replace(/(?:帮|告诉|给|发|问|提醒|替)我/gu, " ")
  const personalQuestion = FIRST_PERSON_CHINESE_QUESTION.test(personalQuestionText)
  const count = /(?:多少|几(?:次|件|个|本|条|项|种)|数量|一共|总共|次数|how many|how much|number of|count\b)/iu.test(text)
  const procedure = /(?:怎么(?:做|弄|用|操作|实现)|如何(?:做|使用|操作)|步骤|流程|办法|方法|过程|how to|how did i\b|how have i\b|steps?\b|process\b|procedure\b)/iu.test(text)
  const explanation = /(?:为什么|为何|原因|缘由|怎么会|what(?:'s| is) the reason|why\b|explain\b)/iu.test(text)
  const advice = !PAST_RECOMMENDATION.test(text) && (PERSONAL_ADVICE.test(text) || CURRENT_ADVICE_REQUEST.test(text))
  const overview = datedConversationOverview || /(?:总结|概括|整体|总体|所有|全部|有哪些|哪些|哪类|列出|回顾|梳理|聊了什么|讨论了什么|谈了什么|overview|summari[sz]e|list all|all of my)/iu.test(text)

  let recallIntent: MemoryRecallIntent = "none"
  if (explicitRecall || personal || personalEvent || personalQuestion) {
    recallIntent = count ? "count" : procedure ? "procedure" : explanation ? "explanation" : overview ? "overview" : advice ? "advice" : "lookup"
  }
  const sourceRoles: LocalMemoryQueryShape["sourceRoles"] = /我[^。？！?！]{0,20}(?:分享|说|经历)/u.test(text)
    ? ["user"]
    : /你[^。？！?！]{0,20}(?:推荐|解释|说)/u.test(text) ? ["assistant"] : ["user", "assistant"]
  const entities = extractEntities(text)
  const evidenceNeeds = recallIntent === "none" ? [] : [
    ...(count ? ["count"] : []),
    ...(procedure ? ["steps"] : []),
    ...(explanation ? ["reason"] : []),
    ...(overview ? ["coverage"] : []),
    ...(advice ? ["preferences"] : []),
    ...(!count && !procedure && !explanation && !advice && !overview ? ["specific_fact"] : []),
  ]
  const timeConstraint = parseTimeConstraint(text, before)
  return { recallIntent, sourceRoles, entities, evidenceNeeds, ...(timeConstraint ? { timeConstraint } : {}) }
}

export function deriveMemoryQueryPlan(originalQuery: string, before?: number): DerivedMemoryQueryPlan {
  return {
    originalQuery,
    queries: originalQuery.trim() ? [originalQuery] : [],
    rewriteStatus: "not_needed",
    ...deriveLocalMemoryQueryShape(originalQuery, before),
  }
}

function isDatedConversationOverview(query: string): boolean {
  const calendar = findCalendarDate(query)
  if (!calendar || !isRecordDateQuestion(query, calendar.index, calendar.length)) return false
  return isConversationOverviewQuestion(withoutCalendarDate(query, calendar.index, calendar.length))
}

function extractEntities(query: string): string[] {
  const chineseNormalized = query
    .replace(/[？?！!，,。；;：:“”"'‘’()（）\[\]【】]/gu, " ")
    .replace(/(?:放在哪里|放哪儿|在哪里|哪儿|是什么|哪些|哪类|怎么做|怎么用|如何做|为什么|原因|几(?:本|个|次|件|条|种|项)|多少).*$/u, " ")
    .replace(/(?:我(?:们)?|你|曾经|之前|以前|上次|某天|什么|怎么|如何|为什么|原因|推荐过|推荐|建议过|建议|分享过|分享|告诉过|告诉|说过|说|提过|聊过|记得|回忆|总结|概括|所有|全部|有哪些|多少|几个|几次|的|了|吗|呢|啊|嘛)/gu, " ")
  const normalized = chineseNormalized.replace(/\b(?:how|what|when|where|why|did|you|we|i|my|me|previously|recommend(?:ed)?|suggest(?:ed)?|share(?:d)?|tell|told|say|said|discuss(?:ed)?|remember|all|list|summari[sz]e|please|about|for|the|a|an|is|are|was|were|do|does|have|has|had|many|much|steps?|process|reason|advice|tips)\b/giu, " ")
    .split(/\s+/u)
    .map(value => value.trim())
    .filter(value => [...value].length >= 2)
  return [...new Set(normalized)].slice(0, 8)
}

function parseTimeConstraint(query: string, before?: number): MemoryTimeConstraint | undefined {
  const calendar = findCalendarDate(query)
  const explicitRecord = isExplicitRecordCue(query)
  const basis: MemoryTimeConstraint["basis"] = calendar
    ? isRecordDateQuestion(query, calendar.index, calendar.length) ? "record" : "event"
    : explicitRecord ? "record" : "event"
  if (calendar) {
    const { year, month, day } = calendar
    if (month >= 1 && month <= 12 && day >= 1 && day <= new Date(year ?? 2000, month, 0).getDate() && (year === undefined || (year >= 1 && year <= 9999))) {
      const date = { ...(year === undefined ? {} : { year }), month, day }
      const start = year === undefined || basis === "event" ? undefined : new Date(year, month - 1, day).getTime()
      const end = start === undefined ? undefined : new Date(year!, month - 1, day + 1).getTime()
      return { basis, ...(start === undefined ? {} : { start, end }), calendarDate: date }
    }
  }
  if (basis === "event" || before === undefined || !Number.isFinite(before) || !/(?:今天|昨天|前天|上周末|上周|上个月|去年|today|yesterday|last weekend|last week|last month|last year)/iu.test(query)) return undefined
  const date = new Date(before)
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const mondayOffset = date.getDay() === 0 ? -6 : 1 - date.getDay()
  const thisWeekStart = localDayStart(date, mondayOffset)
  let start: number
  let end: number
  if (/(?:上周末|last weekend)/iu.test(query)) { start = localDayStart(date, mondayOffset - 2); end = thisWeekStart }
  else if (/(?:前天)/u.test(query)) { start = localDayStart(date, -2); end = localDayStart(date, -1) }
  else if (/(?:昨天|yesterday)/iu.test(query)) { start = localDayStart(date, -1); end = startOfDay }
  else if (/(?:今天|today)/iu.test(query)) { start = startOfDay; end = localDayStart(date, 1) }
  else if (/(?:上周|last week)/iu.test(query)) { start = localDayStart(date, mondayOffset - 7); end = thisWeekStart }
  else if (/(?:上个月|last month)/iu.test(query)) { start = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime(); end = new Date(date.getFullYear(), date.getMonth(), 1).getTime() }
  else { start = new Date(date.getFullYear() - 1, 0, 1).getTime(); end = new Date(date.getFullYear(), 0, 1).getTime() }
  return { basis, start, end }
}

const ENGLISH_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

function findCalendarDate(query: string): { index: number; length: number; year?: number; month: number; day: number } | undefined {
  const numeric = /(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})(?:日|号)?/u.exec(query)
  if (numeric) return { index: numeric.index, length: numeric[0].length, ...(numeric[1] ? { year: Number(numeric[1]) } : {}), month: Number(numeric[2]), day: Number(numeric[3]) }
  const english = /\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/iu.exec(query)
  if (!english) return undefined
  return { index: english.index, length: english[0].length, ...(english[3] ? { year: Number(english[3]) } : {}), month: ENGLISH_MONTHS.indexOf(english[1]!.toLowerCase()) + 1, day: Number(english[2]) }
}

function isRecordDateQuestion(query: string, dateIndex: number, dateLength: number): boolean {
  const beforeDate = query.slice(0, dateIndex)
  const withoutDate = withoutCalendarDate(query, dateIndex, dateLength)
  if (isConversationOverviewQuestion(withoutDate)) return true
  // A past-tense question about what someone said/told/recommended on a date asks
  // for a record from that date. A statement such as "I said I would travel on..."
  // still falls through to the event-date guard below.
  if (/\bwhat did (?:i|we|you) (?:say|tell|mention|recommend|share)(?:\s+you)?\s*$/iu.test(beforeDate)) return true
  if (/(?:记录|记下|保存|写入|告诉|分享|推荐|提到|说过|said|told|shared|recommended)\p{L}*/iu.test(beforeDate)) return false
  const afterDate = query.slice(dateIndex + dateLength)
  const recallOfCommunication = /(?:记录|记下|保存|写入|告诉|分享|推荐|提到|说过|告诉过|分享过)[^。？！?！]{0,18}(?:什么|哪些|啥)/u.test(afterDate)
  const recordingAction = /(?:记录|记下|保存|写入)(?:了|过|的)?/u.test(afterDate)
  return recallOfCommunication || recordingAction
}

function withoutCalendarDate(query: string, dateIndex: number, dateLength: number): string {
  return `${query.slice(0, dateIndex)} ${query.slice(dateIndex + dateLength)}`
}

function isConversationOverviewQuestion(query: string): boolean {
  return /(?:聊|讨论|谈)(?:了|过)?[^。？！?！]{0,18}(?:什么|哪些|啥|话题|内容)|\bwhat did (?:we|i) (?:talk|discuss|chat) about\b/iu.test(query)
}

function isExplicitRecordCue(query: string): boolean {
  return /(?:记录|记下|保存|写入|告诉你|告诉(?:过|了)?|分享给你|分享(?:过|了)?|推荐(?:过|了)?|提到|提过|说过|说了|share|tell|recommend|say|shared|told|recommended|said)/iu.test(query)
    || /(?:聊|讨论|谈)(?:了|过)?[^。？！?！]{0,18}(?:什么|哪些|啥|话题|内容)|\bwhat did (?:we|i) (?:talk|discuss|chat) about\b|\b(?:we|i) (?:talked|discussed|chatted) about\b/iu.test(query)
}

function localDayStart(date: Date, offsetDays: number): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime()
}

export function hasAdaptiveQueryShape(query: string, recallIntent?: MemoryRecallIntent): boolean {
  const normalized = query.trim()
  if (!normalized || SOCIAL_ACKNOWLEDGEMENT.test(normalized)) return false
  const shortFollowup = [...normalized].length <= 100 && SHORT_FOLLOWUP.test(normalized)
  return shortFollowup || (recallIntent === undefined ? hasPersonalRecallIntent(normalized) : recallIntent !== "none")
}

export function hasAdaptiveRecallCue(
  query: string,
  context: readonly { role: "user" | "assistant"; text: string }[],
  recallIntent?: MemoryRecallIntent,
): boolean {
  const normalized = query.trim()
  if (SOCIAL_ACKNOWLEDGEMENT.test(normalized)) return false
  const shortFollowup = [...normalized].length <= 100 && context.length > 0 && SHORT_FOLLOWUP.test(normalized)
  const personalHistoryQuestion = recallIntent === undefined ? hasPersonalRecallIntent(normalized) : recallIntent !== "none"
  return shortFollowup || personalHistoryQuestion
}
