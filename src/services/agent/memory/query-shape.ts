// Shared local query cues; no model call or runtime dependencies.
import { MEMORY_LIMITS } from "./protocol"

export const MEMORY_QUERY_STOP_WORDS: ReadonlySet<string> = new Set(MEMORY_LIMITS.query.englishStopWords)

export type MemoryRecallIntent = "none" | "lookup" | "overview" | "explanation" | "procedure" | "advice" | "count"

export interface MemoryTimeConstraint {
  basis: "record" | "event"
  start?: number
  end?: number
  calendarDate?: { year?: number; month: number; day: number }
}

export type MemoryAspectCategory = "activity" | "food" | "book"

/** Ordinal event questions need the matching occurrence, not merely a same-topic hit. */
export type MemoryTemporalOrder = "first" | "second" | "third" | "last"

export interface LocalMemoryQueryShape {
  recallIntent: MemoryRecallIntent
  sourceRoles: Array<"user" | "assistant">
  entities: string[]
  evidenceNeeds: string[]
  /** Everyday categories whose concrete vocabulary is often absent from the question. */
  aspectCategories?: MemoryAspectCategory[]
  timeConstraint?: MemoryTimeConstraint
  temporalOrder?: MemoryTemporalOrder
}

export interface DerivedMemoryQueryPlan extends LocalMemoryQueryShape {
  originalQuery: string
  queries: string[]
  rewriteStatus: "not_needed"
  /** Local entity/aspect fan-out kept separate from model rewrites. */
  aspectQueries?: string[]
}

type MemoryAspectLanguage = "zh" | "en"

const MEMORY_ASPECT_CUES: Record<Exclude<MemoryRecallIntent, "none">, Record<MemoryAspectLanguage, readonly string[]>> = {
  lookup: { zh: ["记录", "经历", "前后文"], en: ["said", "mentioned", "told"] },
  overview: { zh: ["记录", "话题", "经历"], en: ["records", "talked about", "discussed"] },
  explanation: { zh: ["原因", "为什么", "因为"], en: ["reason", "because", "why"] },
  procedure: { zh: ["步骤", "方法", "过程"], en: ["steps", "process", "method"] },
  advice: { zh: ["偏好", "经历", "建议"], en: ["preferences", "enjoy", "suggest"] },
  count: { zh: ["次数", "经历", "时间"], en: ["times", "once", "twice"] },
}

const MEMORY_EVIDENCE_CUES: Record<string, Record<MemoryAspectLanguage, readonly string[]>> = {
  preferences: { zh: ["偏好", "喜欢"], en: ["favorite", "like", "enjoy", "prefer"] },
  reason: { zh: ["原因", "因为"], en: ["because", "reason"] },
  steps: { zh: ["步骤", "方法"], en: ["steps", "process"] },
  count: { zh: ["次数", "经历"], en: ["times", "once"] },
  coverage: { zh: ["记录", "话题"], en: ["records", "talked about"] },
}

/**
 * Generic everyday vocabulary for questions whose answer terms usually do not
 * appear in the question itself. These are search hypotheses only; a term with
 * no corpus hit simply contributes no candidate, and it is never asserted as a
 * fact. The lists stay short and category-level rather than transcript-specific.
 */
const MEMORY_ASPECT_SEEDS: Record<MemoryAspectCategory, Record<MemoryAspectLanguage, readonly string[]>> = {
  activity: {
    en: ["hiking", "surfing", "camping", "swimming", "running", "cycling", "fishing", "skiing", "climbing", "yoga"],
    zh: ["徒步", "冲浪", "露营", "游泳", "跑步", "骑行", "钓鱼", "滑雪", "爬山", "瑜伽"],
  },
  food: {
    en: ["cake", "icecream", "ice cream", "chocolate", "cookie", "pie", "dessert", "mousse", "pizza", "pasta"],
    zh: ["蛋糕", "冰淇淋", "巧克力", "饼干", "甜点", "披萨", "面食"],
  },
  book: {
    en: ["book", "novel", "author", "fiction", "fantasy", "history"],
    zh: ["书", "小说", "作者", "历史", "科幻"],
  },
}

const MEMORY_ASPECT_CATEGORY_TESTS: ReadonlyArray<{ category: MemoryAspectCategory; test: RegExp }> = [
  { category: "activity", test: /\b(?:activities|hobbies|sports|outdoor|exercise|pastimes)\b|(?:活动|爱好|运动|户外)/iu },
  { category: "food", test: /\b(?:foods?|desserts?|snacks?|meals?|dishes?|treats?)\b|(?:食物|甜点|零食|菜)/iu },
  { category: "book", test: /\b(?:books?|authors?|novels?)\b|(?:书|作者|小说)/iu },
]

function detectAspectCategories(query: string): MemoryAspectCategory[] {
  return MEMORY_ASPECT_CATEGORY_TESTS.filter(item => item.test.test(query)).map(item => item.category)
}

function aspectSeedTerms(categories: readonly MemoryAspectCategory[], language: MemoryAspectLanguage): string[] {
  return [...new Set(categories.flatMap(category => MEMORY_ASPECT_SEEDS[category][language]))]
}

function aspectLanguage(entities: readonly string[]): MemoryAspectLanguage {
  return entities.some(entity => /[\p{Script=Han}]/u.test(entity)) ? "zh" : "en"
}

/** Shared aspect cues for local fan-out and coverage follow-up searches. */
export function memoryAspectCues(shape: Pick<LocalMemoryQueryShape, "recallIntent" | "evidenceNeeds" | "entities">): string[] {
  const language = aspectLanguage(shape.entities)
  const cues: string[] = []
  // Answer obligations first: a reason/count need must not be crowded out by
  // generic intent cues when the facet budget is bounded.
  for (const need of shape.evidenceNeeds) cues.push(...(MEMORY_EVIDENCE_CUES[need]?.[language] ?? []))
  if (shape.recallIntent !== "none") cues.push(...MEMORY_ASPECT_CUES[shape.recallIntent][language])
  return [...new Set(cues)].slice(0, 5)
}

/** Only multi-entity or multi-aspect questions pay for extra lexical facets. */
function shouldDeriveAspectSubqueries(shape: LocalMemoryQueryShape): boolean {
  if (shape.recallIntent === "none" || shape.entities.length === 0) return false
  if (shape.recallIntent !== "lookup") return true
  return shape.entities.length >= 2
    || shape.evidenceNeeds.some(need => need !== "specific_fact" && need !== "source")
}

function selectAspectAnchors(entities: readonly string[], language: MemoryAspectLanguage): string[] {
  if (language === "en") {
    const named = entities.filter(entity => /^\p{Lu}/u.test(entity))
    if (named.length > 0) return named.slice(0, 2)
  }
  return entities.slice(0, 2)
}

/**
 * Deterministic entity/aspect fan-out: pair each named entity with the other
 * content facets, then add intent-specific cues. The original query stays the
 * primary RRF anchor; these only add independent lexical channels.
 */
export function deriveAspectSubqueries(shape: LocalMemoryQueryShape): string[] {
  if (!shouldDeriveAspectSubqueries(shape)) return []
  const language = aspectLanguage(shape.entities)
  const cues = memoryAspectCues(shape)
  const anchors = selectAspectAnchors(shape.entities, language)
  const seedTerms = aspectSeedTerms(shape.aspectCategories ?? [], language)
  if (anchors.length === 0 || (cues.length === 0 && seedTerms.length === 0)) return []
  const anchorSet = new Set(anchors)
  const aspects = shape.entities.filter(entity => !anchorSet.has(entity))
  const result: string[] = []
  const seen = new Set<string>()
  const addQuery = (value: string): void => {
    const query = value.trim()
    const key = query.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
    if (!query || seen.has(key)) return
    seen.add(key)
    result.push(query)
  }
  const add = (entity: string, aspect: string): void => {
    if (aspect.trim()) addQuery(`${entity} ${aspect}`)
  }
  // Category questions spend two slots on entity×aspect pairs and reserve the
  // rest for concrete vocabulary (an activity/food term often appears without
  // the person's name in the same turn). Other questions keep the cue budget.
  const aspectLimit = seedTerms.length > 0 ? 2 : cues.length > 0 ? 6 - Math.min(2, cues.length) : 6
  for (const anchor of anchors) {
    for (const aspect of aspects.slice(0, 3)) {
      if (result.length >= aspectLimit) break
      add(anchor, aspect)
    }
    if (result.length >= aspectLimit) break
  }
  if (seedTerms.length === 0) {
    for (const cue of cues) {
      for (const anchor of anchors) {
        if (result.length >= 6) break
        add(anchor, cue)
      }
    }
  }
  for (const seed of seedTerms) {
    if (result.length >= 6) break
    addQuery(seed)
  }
  return result.length >= 2 ? result.slice(0, 6) : []
}

export function hasExplicitRewriteHint(query: string): boolean {
  return hasConversationHistoryContext(query) || hasThirdPersonHistoryIntent(query)
    || /(?:刚才|刚刚|之前|以前|上次|前面|提过|说过|我们聊过|某天聊了什么|那天聊了什么|你还记得|那个(?:偏好|习惯|东西|人|事情)?|那件事|那位|这件事|我喜欢|我的偏好|用户偏好|我的习惯|个人资料|画像|remember|previous|earlier|what did i (?:say|tell you)|my preference|about me)/iu.test(query)
}

const CONVERSATION_HISTORY_CONTEXT = /\b(?:using|from|according to|based on) (?:our |the |previous |past )?(?:conversation|chat) (?:history|records)\b|根据(?:我们(?:的)?|之前的|过去的)?(?:聊天|对话)(?:记录|历史)/iu

function hasConversationHistoryContext(query: string): boolean { return CONVERSATION_HISTORY_CONTEXT.test(query) }

export function hasExplicitConversationReference(query: string): boolean {
  return /\bwhat did (?:i|we|you|[\p{Lu}][\p{L}'’-]*) (?:say|tell|discuss|mention)\b.{0,40}\bin\b|(?:那次|那段|这段|那个|这个)(?:会话|对话|聊天)/iu.test(query)
}

/** Personal actions and plans, not every third-person/general-knowledge question. */
export function hasThirdPersonHistoryIntent(query: string): boolean {
  return /\b(?:[Ww]hat|[Ww]hich|[Ww]hen|[Ww]here|[Ww]hy|[Hh]ow)\b.{0,70}\b(?:did|has|had) (?:[\p{Lu}][\p{L}'’-]*|he|she|they)\b.{0,100}\b(?:recommend|suggest|say|tell|mention|share|paint|see|seen|feel|felt|attend|buy|bought|choose|chosen|visit|travel|start|finish)\b/u.test(query)
    || /\b(?:[Ww]hen|[Ww]here|[Ww]hat)\b.{0,70}\b(?:is|was|are|were) (?:[\p{Lu}][\p{L}'’-]*|he|she|they)\b.{0,80}\b(?:planning|going|hoping)\b/u.test(query)
    || /(?:他|她|他们|她们|[\p{Script=Han}]{2,4})(?:之前|以前|上次|曾经|当时|过去)[^。？！?！]{0,60}(?:什么|哪|何时|怎么|如何|为什么|多少)/u.test(query)
}

const SOCIAL_ACKNOWLEDGEMENT = /^(?:你好|嗨|哈喽|hello|hi|谢谢|感谢|好的|好|收到|明白|知道了|嗯|ok|okay|got it|thanks|thank you)[!！?？。，,.\s]*$/iu
const SHORT_FOLLOWUP = /(?:这|那|它|他|她|然后|接下来|这个|那个|呢|再说|继续|\b(?:that|this|it|those|them|and then|what about|how about)\b)/iu
const PERSONAL_HISTORY_QUESTION = /(?:\b(?:what|which|when|where|how|who)\b.{0,140}\b(?:did you|did we|did i|have you|have we|have i|had i|i (?:was|am|earned|spent|bought|started|attended|took|have)|my)\b|\b(?:did you|did we|have you|have we)\b.{0,100}\b(?:recommend(?:ed)?|suggest(?:ed)?|mention(?:ed)?|say|said|tell|told|choose|decide)\b|\bwhat did i (?:say|tell|choose)\b|\bwhat (?:is|are|was|were) my\b|\bwhat do i\b|\bmy (?:favorite|favourite|preference|habit|usual|choice|plan|address|birthday|name)\b|我的(?:偏好|习惯|选择|安排|名字|地址|生日)|我(?:平时|通常|之前|上次).{0,12}(?:喜欢|选择|说过|告诉过)|我们(?:之前|上次|当时).{0,12}(?:决定|选定|说过)|你(?:刚才|之前|上次|当时).{0,12}(?:推荐|建议|提到|说过|告诉过))/iu
const PERSONAL_ADVICE = /(?:\b(?:recommend|suggest)\b.{0,100}\b(?:for me|i|my)\b|\b(?:i['’]ve|i have|i am|i['’]m)\b.{0,100}\b(?:trouble|struggling|advice|tips|recommend)\b|给我.{0,12}(?:推荐|建议)|(?:我|我的).{0,24}(?:困扰|遇到问题|不太顺利|有何建议|怎么办))/iu
const PAST_RECOMMENDATION = /(?:我(?:曾经|之前|以前|上次).{0,24}(?:推荐|建议)|你(?:曾经|之前|以前|上次).{0,24}(?:推荐|建议)|\bwhat did you recommend\b|\byou (?:previously|last time) recommended\b)/iu
const PERSONAL_EVENT_QUESTION = /(?:\b(?:how many|how much|why|how|what|which|when|where|who)\b.{0,140}\b(?:did i|have i|had i|was i|did we|have we|had we|were we)\b|\b(?:what steps|which steps)\b.{0,100}\b(?:did i take|have i taken|did we take|have we taken)\b)/iu
const FIRST_PERSON_CHINESE_QUESTION = /我(?:的)?[^。？！?！]{0,100}(?:什么|哪些|哪(?:个|些|档|种|部|本|次|里|儿|时)|什么时候|何时|为什么|为何|怎么|如何|多少|几(?:次|个|部|本|种|件|年|月|天)?|是否|吗|呢)/u
const CURRENT_ADVICE_REQUEST = /(?:我(?:应该|该|要不要|该不该)|给我.{0,12}(?:推荐|建议)|(?:what should i|what do you recommend|can you recommend|could you recommend|any advice|any tips))/iu

/** A personal hypothetical, rather than every general-knowledge question containing would. */
function hasPersonalHypotheticalCue(query: string): boolean {
  const namedActor = /\b[Ww]ould\s+([\p{Lu}][\p{L}'’-]*)\b/u.exec(query)?.[1]
  const personalActor = /\bwould\s+(?:i|we|he|she|they|the user)\b/iu.test(query)
    || Boolean(namedActor && !MEMORY_QUERY_STOP_WORDS.has(namedActor.toLowerCase()))
  const choice = /\b(?:enjoy|like|prefer|choose|pursue|study|want|consider|accept|avoid|moving|move|interested|willing|likely)\b|\bopen to\b/iu.test(query)
  return (personalActor && choice)
    || /[我他她](?:们)?[^。？！?！]{0,80}(?:会不会|可能会|是否可能|愿不愿意|是否愿意|是否适合)[^。？！?！]{0,60}(?:喜欢|考虑|选择|学习|参加|搬|适合|更想|倾向)/u.test(query)
}

/** Personal history and advice require recall even when a few keyword facts already match. */
export function hasPersonalRecallIntent(query: string): boolean {
  return PERSONAL_HISTORY_QUESTION.test(query) || PERSONAL_ADVICE.test(query) || CURRENT_ADVICE_REQUEST.test(query)
    || hasPersonalHypotheticalCue(query)
}

const TEMPORAL_ORDINAL_CUES: ReadonlyArray<{ order: MemoryTemporalOrder; test: RegExp }> = [
  { order: "first", test: /\b(?:first|1st)\s+time\b|第一次|首次/iu },
  { order: "second", test: /\b(?:second|2nd)\s+time\b|第二次/iu },
  { order: "third", test: /\b(?:third|3rd)\s+time\b|第三次/iu },
  { order: "last", test: /\b(?:last|latest|most recent)\s+time\b|最后一次|最近一次/iu },
]

/** "the second time" must select the matching occurrence, not just any Tokyo mention. */
function detectTemporalOrder(text: string): MemoryTemporalOrder | undefined {
  return TEMPORAL_ORDINAL_CUES.find(item => item.test.test(text))?.order
}

/** Derive a conservative, deterministic retrieval plan from the user's exact wording. */
export function deriveLocalMemoryQueryShape(query: string, before?: number): LocalMemoryQueryShape {
  const text = query.trim()
  const datedConversationOverview = isDatedConversationOverview(text)
  const explicitRecall = datedConversationOverview || hasConversationHistoryContext(text) || hasThirdPersonHistoryIntent(text)
    || /(?:曾经分享过|分享过|推(?:过|荐过)|推过荐|推荐过|建议过|提过|说过|告诉过|记录|聊过|某天聊了什么|那天聊了什么|之前聊了什么|上次聊了什么|记得|回忆|我(?:之前|以前|上次|曾经)|我们(?:之前|以前|上次|曾经)|what did (?:you|we|i)|did you (?:recommend|suggest|mention|say)|have we discussed|previously shared)/iu.test(text)
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
  const inference = memoryEvidenceReviewKind(text, recallIntent) === "inference"
  const contextualSource = hasExplicitConversationReference(text)
  // A plural what/which question asks for a set of items, not one fact. This
  // signal lets the renderer keep every directly named item across sessions.
  const enumeration = recallIntent === "lookup" && !inference && (
    /\b(?:what|which)\b[^?]{0,80}\b\w+s\b/iu.test(text)
    || /\b(?:list|all|every|several)\b/iu.test(text)
    || /(?:哪些|有什么|列出|所有|全部)/u.test(text)
  )
  const evidenceNeeds = recallIntent === "none" ? [] : [
    ...(count ? ["count"] : []),
    ...(procedure ? ["steps"] : []),
    ...(explanation ? ["reason"] : []),
    ...(overview ? ["coverage"] : []),
    ...(advice || inference ? ["preferences"] : []),
    ...(inference ? ["reason"] : []),
    ...(contextualSource ? ["source"] : []),
    ...(enumeration ? ["enumeration"] : []),
    ...(!count && !procedure && !explanation && !advice && !overview && !inference ? ["specific_fact"] : []),
  ]
  const timeConstraint = parseTimeConstraint(text, before)
  const aspectCategories = detectAspectCategories(text)
  const temporalOrder = detectTemporalOrder(text)
  return {
    recallIntent, sourceRoles, entities, evidenceNeeds,
    ...(aspectCategories.length > 0 ? { aspectCategories } : {}),
    ...(timeConstraint ? { timeConstraint } : {}),
    ...(temporalOrder ? { temporalOrder } : {}),
  }
}

export function deriveMemoryQueryPlan(originalQuery: string, before?: number): DerivedMemoryQueryPlan {
  const shape = deriveLocalMemoryQueryShape(originalQuery, before)
  const aspectQueries = deriveAspectSubqueries(shape)
  return {
    originalQuery,
    queries: originalQuery.trim() ? [originalQuery] : [],
    rewriteStatus: "not_needed",
    ...shape,
    ...(aspectQueries.length > 0 ? { aspectQueries } : {}),
  }
}

// A derived attribute is not a literal lookup: the answer often requires a
// common-sense mapping (Stamford -> Connecticut, Mount Talkeetna -> Alaska).
const DERIVED_LOCATION_ATTRIBUTE = /\b(?:which|what)\s+(?:us\s+)?(?:state|country|city|region|province|county|nationality|language)\b|\b(?:which|what)\s+\w+\s+(?:state|country|city|region)\b/iu
const DERIVED_LOCATION_ATTRIBUTE_ZH = /(?:哪个|哪一|什么)(?:州|国家|城市|地区|省|国籍|语言)/u
const LOCATION_VERIFICATION = /\b(?:does|do|did|is|are|was|were|has|have)\s+[^?]{0,80}\b(?:live|living|from|born|raised|grow(?:n)?\s+up|located|based|reside|residing)\b/iu
const LOCATION_VERIFICATION_ZH = /(?:是不是|是否|有没有)[^。？！?！]{0,40}(?:住在|居住在|来自|出生于|家在)/u
const POTENTIAL_ACTION = /\b(?:can|could|should|might|may)\s+[^?]{0,100}\b(?:do|try|help|improve|change|deal|handle|make|reduce|manage|accommodate|fit|arrange|adjust)\b/iu
const POTENTIAL_ACTION_ZH = /(?:可以|能|应该|可能)[^。？！?！]{0,60}(?:怎么|如何|做|尝试|改善|缓解|改变|安排|调整)/u

/** The retrieval plan and reader share one distinction between history and inference. */
export function memoryEvidenceReviewKind(query: string, intent?: MemoryRecallIntent): "count" | "inference" | undefined {
  if (intent === "count") {
    if (/\b(?:times?|visits?|trips?)\s+(?:a|per|each|every)\s+(?:day|week|month|year)\b|\bper\s+(?:day|week|month|year)\b|每(?:天|周|月|年|个?星期)/iu.test(query)) return undefined
    return /\b(?:times?|occasions?|visits?|trips?|events?|experiences?)\b|(?:几次|多少次|次数|经历)/iu.test(query) ? "count" : undefined
  }
  // "What did X say" is a direct historical quote, not an inference.
  if (/\b(?:what|whether)\s+(?:did|has|had)\b.{0,80}\b(?:say|said|mention|mentioned|tell|told)\b|(?:说过|明确表示过|提到过)/iu.test(query)) return undefined
  // Advice questions ask for a bounded recommendation from preferences,
  // constraints and counterexamples; they share the inference path.
  if (intent === "advice") return "inference"
  if (DERIVED_LOCATION_ATTRIBUTE.test(query) || DERIVED_LOCATION_ATTRIBUTE_ZH.test(query)
    || LOCATION_VERIFICATION.test(query) || LOCATION_VERIFICATION_ZH.test(query)
    || POTENTIAL_ACTION.test(query) || POTENTIAL_ACTION_ZH.test(query)) return "inference"
  return /\b(?:would|likely)\b|(?:可能会|是否可能|会不会|愿不愿意|是否愿意|是否适合)/iu.test(query) ? "inference" : undefined
}

function isDatedConversationOverview(query: string): boolean {
  const calendar = findCalendarDate(query)
  if (!calendar || !isRecordDateQuestion(query, calendar.index, calendar.length)) return false
  return isConversationOverviewQuestion(withoutCalendarDate(query, calendar.index, calendar.length))
}

function extractEntities(query: string): string[] {
  const chineseNormalized = query.replace(CONVERSATION_HISTORY_CONTEXT, " ")
    .replace(/[？?！!，,。；;：:“”"'‘’()（）\[\]【】]/gu, " ")
    .replace(/(?:放在哪里|放哪儿|在哪里|哪儿|是什么|哪些|哪类|怎么做|怎么用|如何做|为什么|原因|几(?:本|个|次|件|条|种|项)|多少).*$/u, " ")
    .replace(/(?:我(?:们)?|你|曾经|之前|以前|上次|某天|什么|怎么|如何|为什么|原因|推荐过|推荐|建议过|建议|分享过|分享|告诉过|告诉|说过|说|提过|聊过|记得|回忆|总结|概括|所有|全部|有哪些|多少|几个|几次|的|了|吗|呢|啊|嘛)/gu, " ")
  const normalized = chineseNormalized.replace(/\b(?:recommend(?:ed)?|suggest(?:ed)?|share(?:d)?|tell|told|say|said|discuss(?:ed)?|all|list|summari[sz]e|many|much|steps?|process|reason|advice|tips)\b/giu, " ")
    .split(/\s+/u)
    .map(value => value.trim())
    .filter(value => [...value].length >= 2 && !MEMORY_QUERY_STOP_WORDS.has(value.toLowerCase()))
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
