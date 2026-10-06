// ==========================================
// Dreaming —— 离线整理：Light → Review → 自动 Publish
// ==========================================
//
// Review 的产物只在 Rust 事务提交前落成 prepared staging 候选；
// 作业完成时由 memory_dreaming_commit 复核并自动写进 active，面板只做事后治理。
//
// 来源分两区（2026-10-06 用户裁决「方案 b」），同一批只处理一类、互不混池：
// - 用户事实：来源 origin=user（会话 JSONL 的可信用户输入），Review 走模型、产出候选；
// - 系统观察：来源 origin=derived_behavior（行为画像的稳定结论 + 静默了解的观察摘要），
//   Review 是**确定性映射**——结论文本与观察摘要都原样成为正文，模型不参与改写或演绎观察，
//   token 预算不参与这一区；同一结论槽位的新版本带 supersedesId 覆盖旧条目，了解条目在
//   有界窗口（见 sources 的 UNDERSTANDING_MAX_ENTRIES）内按最旧优先被新观察覆盖。
//
// 资源边界（与《记忆系统运行时契约》§7.2 同源）：
// - 每批来源数与正文长度都有界，超出的留给下一批，不做「一次全库重算」；
// - 单条来源过大不截断内容，直接标记 oversized 交给用户挑选片段；
// - 日 token 上限已撤除（2026-10-06 用户裁决，与主动链同批口径：「一天最多几次」保留、
//   「一天最多烧多少 token」取消）：定时调度器不再查 token 账做门禁，批次不再因 token 账
//   被中止；token 的预留/结算照记进作业账本，只作观测账；
// - 模型调用走 completePiText(purpose="memory")，与主回合共用认证、取消与用量口径；
//   模型取辅助模型（ai.auxModel，留空跟随聊天模型）。

import { completePiText, resolvePiAuxModel } from "@/services/engine/harness"
import { estimateContextTokens } from "@/services/context/budget"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { memoryConfig } from "@/services/config"
import { scheduledSlotDue } from "@/services/proactive/schedule"
import { dreamingTier, dreamingTierLimits } from "@/services/proactive/tiers"
import { createRuntimeTraceContext, hasRuntimeTraceSubscribers, publishRuntimeTrace } from "@/services/engine/runtime/trace"
import { conclusionSlotOf, isDerivedBehaviorSource, understandingSourceOf, UNDERSTANDING_ALIAS_LABEL, UNDERSTANDING_ALIAS_PREFIX, UNDERSTANDING_MAX_ENTRIES } from "./sources"
import { DRAFT_SUMMARY_CHARS } from "./draft"
import { refreshMemoryCount } from "./index"
import {
  addMemoryCandidates, cancelMemoryJob, checkpointMemoryJob, commitMemoryDreamingJob, memoryJobSources,
  memoryList, memoryStatus, pendingMemorySourceCount, reserveMemoryDreamingBudget, resumeMemoryJob,
  settleMemoryDreamingBudget, startMemoryJob,
} from "./ipc"
import type { MemoryCandidateDraft, MemoryDraft, MemoryItem, MemoryJob, MemorySource } from "./ipc"

const log = createLogger("MemoryDreaming")

/** 单批来源上界：批大小是资源边界，不是调优旋钮。 */
const MAX_SOURCES_PER_BATCH = 20
/** 单条来源正文上界：超过它不截断，整条标 oversized 交给用户。 */
const MAX_SOURCE_CHARS = 1_200
const MAX_BATCHES_PER_RUN = 3
/** 评审输出上限的防呆下限；未配置时按模型输出预算自动推导（见 runDreamingSweep）。 */
const REVIEW_MAX_TOKENS_FLOOR = 256
const LEASE_OWNER = "memory-dreaming"
const IDLE_TICK_MS = 15_000

/**
 * 派生结论（系统观察）的记忆形态：kind=fact 的可复算结论，权重低于用户事实默认值（5），
 * 永不 pinned（Rust 侧同样拒绝带 pinned 的派生候选，双保险）。
 */
const DERIVED_KIND = "fact" as const
const DERIVED_IMPORTANCE = 4
const DERIVED_CONFIDENCE = 0.5
/** 槽位别名前缀：下一版结论靠它找回同槽位在库条目（冲突收敛 = 版本 + supersede 覆盖）。 */
export const BEHAVIOR_SLOT_ALIAS_PREFIX = "behavior-slot:"
/** 槽位的中文别名（memory_query 的关键词面）。 */
const DERIVED_SLOT_LABELS: Record<string, string> = {
  rhythm: "作息节律",
  apps: "常用应用",
  focus: "专注习惯",
  activity: "使用节奏",
}

/**
 * 库内整理（无新来源时的合并）边界：
 * - 单次最多合并 3 组、单组最多吸收 4 条旧条目（后者与 Rust `SUPERSEDES_MAX` 和
 *   protocol.json 的 `maxItems` 同值）；
 * - Review 输入封顶 24 条摘要、每分组最多给 8 条（组够大时也只看最近的）；
 * - 合并正文 800 字符上限：超限整组丢弃（宁可少合并，不做静默截断）。
 */
const MAX_MERGE_GROUPS_PER_SWEEP = 3
const MAX_MERGE_GROUP_ITEMS = 4
const MERGE_INPUT_MAX_ITEMS = 24
const MERGE_COHORT_ITEMS = 8
const MERGE_CONTENT_MAX_CHARS = 800

/** 库内整理的候选分组：同 origin 区内、同 scope、同 kind 的在库条目。 */
export interface MergeCohort {
  key: string
  scope: MemoryDraft["scope"]
  scopeId?: string
  kind: MemoryDraft["kind"]
  items: MemoryItem[]
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
/** 上一次自动整理尝试时刻（仅内存节流，不新增记账文件；跨重启的重复由前置水位查询兜住）。 */
let lastSweepRunAt = 0
let sweepController: AbortController | null = null
let sweepRun: Promise<unknown> | null = null
function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

export interface DreamingOutcome {
  status: "completed" | "empty" | "cancelled" | "failed"
  jobId?: string
  sourcesProcessed: number
  candidatesAdded: number
  publishedCount: number
  oversized: string[]
  budget?: { localDate: string; reservedTokens: number; usedTokens: number }
  message?: string
}

const REVIEW_SYSTEM_PROMPT = [
  "你负责把用户本人说过的话整理成长期记忆候选。",
  "只输出 JSON，不要解释，不要 markdown 代码块。",
  '输出形如 {"candidates":[{"sourceIds":["..."],"content":"...","summary":"...","kind":"fact|preference|episode|working","scope":"user|card|session","aliases":["..."],"pinned":false,"importance":0-10,"confidence":0-1,"reason":"..."}]}。',
  "规则：",
  "1. 只记录用户本人的陈述。朋友的偏好、假设、举例、引用、翻译内容都不算用户事实。",
  "2. 每条候选必须带至少一个来源 id，且只能用输入里出现过的 id。",
  "3. 记忆种类与范围：kind 取 fact=用户陈述的事实 / preference=稳定偏好 / episode=具体经历 / working=明确待办或约定；scope 取 user=跨会话适用（缺省）/ card=只属于当前角色的互动 / session=只属于当前会话。",
  "4. 称呼、稳定的表达偏好可以置 pinned=true；一次性的经历或临时安排置 false。",
  "5. 有明显时效的说法写 expiresAt（毫秒时间戳，可省略）；不要把临时状态写成永久偏好。",
  "6. kind=working 只用于用户明确的待办或约定（临时让你做的事不算），必须带 workingState：open|completed|cancelled（拿不准就 open）。",
  "7. 只有用户明确表达、跨会话仍然成立的事实或偏好才值得记录：要能从原话直接读出来（如「我习惯…」「我喜欢…」「以后都…」这类明确表述）。",
  "8. 请求句不是偏好：「帮我 / 看看 / 猜猜 / 查一下 / 截个图」这类当场需求，即使重复几次也只说明在聊天或测试，不记；调试与测试性质的任务（让你临时建个文件、试试某功能）不记。",
  "9. 同一批输入里，同一类内容最多产出一条候选；没有新信息就少产出。",
  "10. 没有值得长期记住或更新的内容时返回空数组 —— 空数组是常见且正确的输出，不要为了「有产出」硬写（宁可少记不可滥记）。",
].join("\n")

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`
}

const KINDS = new Set(["fact", "preference", "episode", "working"])
const SCOPES = new Set(["user", "card", "session"])
const WORKING_STATES = new Set(["open", "completed", "cancelled"])

/** 单次 Review 的超时：随输出预算放大（按每分钟至少 8k tokens 估），30s 起、180s 封顶。 */
function reviewTimeoutMs(outputBudget: number): number {
  return Math.min(180_000, Math.max(30_000, Math.ceil(Math.max(1, outputBudget) / 8_000) * 60_000))
}

/**
 * 校验模型返回的候选：来源必须落在本批、枚举必须合法、正文不能为空。
 * 任何一条不合法就整条丢弃 —— 宁可少记，也不能让模型编的来源进库。
 */
export function parseReviewCandidates(
  raw: string,
  batch: readonly MemorySource[],
): { draft: MemoryDraft; reason?: string }[] {
  const allowed = new Set(batch.map(source => source.sourceId))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)?.candidates) ? (asRecord(parsed)!.candidates as unknown[]) : []
  const out: { draft: MemoryDraft; reason?: string }[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (!record) continue
    const content = typeof record.content === "string" ? record.content.trim() : ""
    const kind = typeof record.kind === "string" ? record.kind : ""
    const scope = typeof record.scope === "string" ? record.scope : ""
    const sourceIds = Array.isArray(record.sourceIds)
      ? record.sourceIds.filter((id): id is string => typeof id === "string")
      : []
    if (!content || !KINDS.has(kind) || !SCOPES.has(scope)) continue
    if (sourceIds.length === 0 || sourceIds.some(id => !allowed.has(id))) continue
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === "string").slice(0, 8)
      : []
    const pinned = record.pinned === true
    // kind=working 必须带状态：模型漏写时默认 open（条目不关闭），非法值不猜测完成态。
    const workingState = kind === "working"
      ? (typeof record.workingState === "string" && WORKING_STATES.has(record.workingState) ? record.workingState : "open")
      : undefined
    // 只有称呼类的稳定事实才允许 pinned，避免模型把所有东西都塞进核心画像。
    const cardId = batch.find(source => sourceIds.includes(source.sourceId))?.cardId
    out.push({
      draft: {
        content,
        summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : content.slice(0, DRAFT_SUMMARY_CHARS),
        kind: kind as MemoryDraft["kind"],
        scope: scope as MemoryDraft["scope"],
        ...(scope === "card" && cardId ? { scopeId: cardId } : {}),
        aliases,
        pinned: pinned && kind === "fact",
        importance: typeof record.importance === "number" ? Math.min(10, Math.max(0, record.importance)) : 5,
        confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
        observedAt: Date.now(),
        ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {}),
        ...(workingState ? { workingState: workingState as MemoryDraft["workingState"] } : {}),
        sourceIds,
      },
      ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 400) } : {}),
    })
    // card 范围的候选必须能落到具体 Card，否则降级成 user 范围而不是编一个 scopeId。
    const last = out[out.length - 1]!
    if (last.draft.scope === "card" && !last.draft.scopeId) {
      last.draft.scope = "user"
    }
  }
  return out
}

function buildReviewPrompt(batch: readonly MemorySource[]): string {
  return JSON.stringify({
    now: Date.now(),
    sources: batch.map(source => ({
      id: source.sourceId,
      said: (source.evidence ?? "").slice(0, MAX_SOURCE_CHARS),
      at: source.observedAt,
      cardId: source.cardId ?? null,
    })),
  })
}

/**
 * 派生批次的确定性 Review：结论文本原样沉淀，不经模型。
 *
 * 「系统观察」允许被读写的是画像层已经算好的结论本身；把这个文本再交给模型改写或演绎，
 * 等于让模型替观察下结论。判据（窗口、画像字段、取整口径）由行为画像域写进结论正文，
 * 这里只做形状映射与同槽位覆盖。
 */
export function buildDerivedCandidates(
  batch: readonly MemorySource[],
  previousBySlot: ReadonlyMap<string, string>,
): MemoryDraft[] {
  const drafts: MemoryDraft[] = []
  for (const source of batch) {
    const slot = conclusionSlotOf(source)
    const content = (source.evidence ?? "").trim()
    if (!slot || !content) continue
    const previous = previousBySlot.get(slot)
    drafts.push({
      content,
      summary: content.slice(0, DRAFT_SUMMARY_CHARS),
      kind: DERIVED_KIND,
      scope: "user",
      aliases: [`${BEHAVIOR_SLOT_ALIAS_PREFIX}${slot}`, `行为画像·${DERIVED_SLOT_LABELS[slot] ?? slot}`],
      pinned: false,
      importance: DERIVED_IMPORTANCE,
      confidence: DERIVED_CONFIDENCE,
      observedAt: source.observedAt,
      sourceIds: [source.sourceId],
      ...(previous ? { supersedesId: previous } : {}),
    })
  }
  return drafts
}

/** 在库派生条目按槽位/了解身份索引：正文只读一次；同槽位多条时取列表序第一条（版本覆盖应保证唯一）。 */
interface DerivedOwners {
  /** 结论槽位 → 在库条目 id（同槽位新结论用它覆盖）。 */
  slots: Map<string, string>
  /** 在库了解条目：身份集合（同文本不重复沉淀）与按最旧优先排定的覆盖目标。 */
  understanding: { identities: Set<string>; idsOldestFirst: string[] }
}

async function derivedOwners(): Promise<DerivedOwners> {
  const slots = new Map<string, string>()
  const identities = new Set<string>()
  const understandingItems: Array<{ id: string; observedAt: number }> = []
  for (const item of await memoryList("user", undefined, 500)) {
    if (!isDerivedBehaviorSource(item)) continue
    for (const alias of item.draft.aliases) {
      if (alias.startsWith(BEHAVIOR_SLOT_ALIAS_PREFIX)) {
        const slot = alias.slice(BEHAVIOR_SLOT_ALIAS_PREFIX.length)
        if (slot && !slots.has(slot)) slots.set(slot, item.id)
      } else if (alias.startsWith(UNDERSTANDING_ALIAS_PREFIX)) {
        const identity = alias.slice(UNDERSTANDING_ALIAS_PREFIX.length)
        if (!identity) continue
        identities.add(identity)
        understandingItems.push({ id: item.id, observedAt: item.draft.observedAt ?? item.updatedAt })
      }
    }
  }
  understandingItems.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
  return { slots, understanding: { identities, idsOldestFirst: understandingItems.map(entry => entry.id) } }
}

/**
 * 一次整理作业内的了解池状态（跨批共享）：候选分多批时，上限与覆盖目标必须按整次作业
 * 记账 —— 只看数据库的已提交状态会把同一批候选算两次（容量超发、同一旧条目被两个候选
 * 覆盖，后者静默失效、库里悄悄多出条目）。
 */
export interface UnderstandingPoolState {
  /** 已沉淀/本作业已产出的了解身份（同一文本不重复沉淀，幂等兜底）。 */
  identities: Set<string>
  /** 可覆盖的在库了解条目 id（按最旧优先）；本作业已用掉的前缀不重复使用。 */
  idsOldestFirst: readonly string[]
  /** 本作业已占用的纯新增名额。 */
  plannedNew: number
  /** 本作业已占用的覆盖游标。 */
  evictionCursor: number
}

/**
 * 了解观察的确定性候选：观察摘要文本**原样**沉淀，模型不参与改写或演绎。
 *
 * 有界策略（数字与依据见 sources 的 `UNDERSTANDING_MAX_ENTRIES`）：
 * - 同一批同一文本只产出一条；已在库或本作业已产出的身份（别名
 *   `behavior-understanding:<hash16>` 命中）不再产出；
 * - 在库了解条目不足上限时，新候选按最新优先纯新增；
 * - 达到上限时，多出的新观察按**最旧优先**逐个携带 supersedesId 覆盖旧条目（一个候选覆盖
 *   一条旧条目，且同一次作业内不重复使用同一目标；旧条目的正文/版本/来源链完整保留）；
 *   可覆盖目标用尽后，再多的旧观察不再产出候选 —— 「最新窗口优先」的有界口径，
 *   不静默改写也不无界堆积。
 * 状态就地推进（`pool`），保证上限与覆盖目标跨批一致。
 */
export function buildUnderstandingCandidates(
  batch: readonly MemorySource[],
  pool: UnderstandingPoolState,
): MemoryDraft[] {
  const seen = new Set<string>()
  const sources = batch
    .filter(source => {
      const identity = understandingSourceOf(source)
      if (!identity || seen.has(identity) || pool.identities.has(identity)) return false
      seen.add(identity)
      return true
    })
    // 最新优先：容量不足时先保住最新的观察，覆盖目标再从最旧的旧条目开始。
    .sort((left, right) => right.observedAt - left.observedAt || left.sourceId.localeCompare(right.sourceId))
  const remainingSlots = Math.max(0, UNDERSTANDING_MAX_ENTRIES - pool.idsOldestFirst.length - pool.plannedNew)
  const remainingTargets = Math.max(0, pool.idsOldestFirst.length - pool.evictionCursor)
  const plain = Math.min(sources.length, remainingSlots)
  const replaceable = Math.min(sources.length - plain, remainingTargets)
  const drafts: MemoryDraft[] = []
  let createdPlain = 0
  let createdReplacements = 0
  sources.forEach((source, index) => {
    if (index >= plain + replaceable) return
    const content = (source.evidence ?? "").trim()
    const identity = understandingSourceOf(source)
    if (!content || !identity) return
    let supersedesId: string | undefined
    if (index >= plain) {
      supersedesId = pool.idsOldestFirst[pool.evictionCursor + createdReplacements]
      if (!supersedesId) return
      createdReplacements += 1
    } else {
      createdPlain += 1
    }
    pool.identities.add(identity)
    drafts.push({
      content,
      summary: content.slice(0, DRAFT_SUMMARY_CHARS),
      kind: DERIVED_KIND,
      scope: "user",
      aliases: [`${UNDERSTANDING_ALIAS_PREFIX}${identity}`, UNDERSTANDING_ALIAS_LABEL],
      pinned: false,
      importance: DERIVED_IMPORTANCE,
      confidence: DERIVED_CONFIDENCE,
      observedAt: source.observedAt,
      sourceIds: [source.sourceId],
      ...(supersedesId ? { supersedesId } : {}),
    })
  })
  pool.plannedNew += createdPlain
  pool.evictionCursor += createdReplacements
  return drafts
}

/** 候选指纹即 id：同一条提案重跑时原地更新，不会堆积重复候选；两类来源共用这一处。 */
async function candidatePayloads(
  entries: readonly { draft: MemoryDraft; reason?: string }[],
): Promise<MemoryCandidateDraft[]> {
  const payloads: MemoryCandidateDraft[] = []
  for (const entry of entries) {
    const payloadHash = await sha256(stable({ draft: entry.draft }))
    payloads.push({
      id: `cand-${payloadHash.slice(0, 24)}`,
      draft: entry.draft,
      payloadHash,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })
  }
  return payloads
}

/** 两区来源类别：用户事实 / 系统观察（派生）。新作业一次只驱动一类，互不混池。 */
type SourceClass = "user" | "derived_behavior"

/**
 * 库内整理的候选分组：同 origin 区内、同 scope+kind 的在库 active 条目，两条以上才值得
 * 交给 Review 看。只收用户区 —— 派生区由确定性通道处理（了解条目的文本改写是红线禁止的
 * 演绎面，结论条目每槽位唯一、本来就没有可合并对象）。
 * 排除项：pinned（用户确认过的核心画像不动）、working（事项生命周期归 complete/cancel 管）、
 * 已过期条目（expiresAt 已过）、无来源条目（无法取来源并集，异常数据不参与）。
 */
export function mergeCohorts(items: readonly MemoryItem[], now = Date.now()): MergeCohort[] {
  const groups = new Map<string, MergeCohort>()
  for (const item of items) {
    const { pinned, kind, scope, expiresAt, scopeId, sourceIds } = item.draft
    if (item.origin !== "user" || pinned || kind === "working") continue
    if (expiresAt != null && expiresAt <= now) continue
    if (sourceIds.length === 0) continue
    const key = `${scope}\u0000${scopeId ?? ""}\u0000${kind}`
    const cohort = groups.get(key) ?? { key, scope, ...(scopeId ? { scopeId } : {}), kind, items: [] }
    cohort.items.push(item)
    groups.set(key, cohort)
  }
  const selected: MergeCohort[] = []
  let budget = MERGE_INPUT_MAX_ITEMS
  for (const cohort of [...groups.values()].filter(group => group.items.length >= 2).sort((left, right) => left.key.localeCompare(right.key))) {
    if (budget <= 0) break
    const items = cohort.items
      .sort((left, right) => (right.draft.observedAt ?? right.updatedAt) - (left.draft.observedAt ?? left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, Math.min(MERGE_COHORT_ITEMS, budget))
    budget -= items.length
    selected.push({ ...cohort, items })
  }
  return selected
}

const MERGE_SYSTEM_PROMPT = [
  "你负责整理记忆库里已有的条目：把重复、同类或已被更新说法取代的旧条目合并成更少、更准的条目。",
  "只输出 JSON，不要解释，不要 markdown 代码块。",
  '输出形如 {"merges":[{"itemIds":["...","..."],"content":"...","summary":"...","reason":"..."}]}。',
  "规则：",
  "1. 每组必须用输入 groups 里出现过的条目 id，同一组内至少 2 条、最多 4 条；不同组不能共用一个 id。",
  "2. 同一组只能包含输入里同一个分组（同 scope、同类型）的条目；不要把不同分组的条目并成一组。",
  "3. 合并正文只保留这些条目本来表达的事实/偏好/经历：可以合并措辞、去掉重复，相互矛盾时以更新时间较新的条目为准（更新过时）；不得引入任何条目里没有的新事实，不得推断，不得把内容写成别的来源。",
  "4. 一组里内容相互独立、合并没有意义时不要合并；没有值得合并的组时返回空数组 —— 空数组是常见且正确的输出，不要为了「有产出」硬写。",
  "5. 最多给 3 组：宁可少合并，不要乱合并。",
].join("\n")

function buildMergePrompt(cohorts: readonly MergeCohort[]): string {
  return JSON.stringify({
    now: Date.now(),
    groups: cohorts.map(cohort => ({
      scope: cohort.scope,
      kind: cohort.kind,
      items: cohort.items.map(item => ({
        id: item.id,
        content: item.draft.content.slice(0, 400),
        summary: item.draft.summary.slice(0, 200),
        observedAt: item.draft.observedAt ?? item.updatedAt,
      })),
    })),
  })
}

/**
 * 校验模型返回的合并组：id 只认输入同一分组、至少两条且不重复、正文非空且有界。
 * 任何一条不合法就整组丢弃（宁可少合并）。来源并集、旧条目 supersede、范围与来源类别
 * 复核都在 Rust 发布事务完成（见 `publish_candidates`），这里不重复造第二套判定。
 */
export function parseMergeCandidates(raw: string, cohorts: readonly MergeCohort[]): MemoryDraft[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)?.merges) ? (asRecord(parsed)!.merges as unknown[]) : []
  const cohortByItem = new Map<string, MergeCohort>()
  for (const cohort of cohorts) for (const item of cohort.items) cohortByItem.set(item.id, cohort)
  const used = new Set<string>()
  const drafts: MemoryDraft[] = []
  for (const entry of list) {
    if (drafts.length >= MAX_MERGE_GROUPS_PER_SWEEP) break
    const record = asRecord(entry)
    if (!record) continue
    const content = typeof record.content === "string" ? record.content.trim() : ""
    if (!content || content.length > MERGE_CONTENT_MAX_CHARS) continue
    const itemIds = Array.isArray(record.itemIds) ? record.itemIds.filter((id): id is string => typeof id === "string") : []
    if (itemIds.length < 2 || itemIds.length > MAX_MERGE_GROUP_ITEMS) continue
    const unique = [...new Set(itemIds)]
    if (unique.length !== itemIds.length || unique.some(id => used.has(id))) continue
    const cohort = cohortByItem.get(unique[0]!)
    if (!cohort || unique.some(id => cohortByItem.get(id) !== cohort)) continue
    const items = unique.map(id => cohort.items.find(item => item.id === id)!)
    const sourceIds = [...new Set(items.flatMap(item => item.draft.sourceIds))]
    if (sourceIds.length === 0) continue
    const expiresAt = items.map(item => item.draft.expiresAt).filter((value): value is number => typeof value === "number")
    unique.forEach(id => used.add(id))
    drafts.push({
      content,
      summary: typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim().slice(0, DRAFT_SUMMARY_CHARS)
        : content.slice(0, DRAFT_SUMMARY_CHARS),
      kind: cohort.kind,
      scope: cohort.scope,
      ...(cohort.scopeId ? { scopeId: cohort.scopeId } : {}),
      // 别名取并集（有界）：旧条目的查询面不因合并断掉。
      aliases: [...new Set(items.flatMap(item => item.draft.aliases))].slice(0, 8),
      pinned: false,
      importance: Math.max(...items.map(item => item.draft.importance)),
      confidence: Math.min(...items.map(item => item.draft.confidence)),
      observedAt: Math.max(...items.map(item => item.draft.observedAt ?? item.updatedAt)),
      // 有时效的条目合并后仍保留时效（取最晚到期），不把临时内容洗成永久事实。
      ...(expiresAt.length ? { expiresAt: Math.max(...expiresAt) } : {}),
      sourceIds,
      supersedesIds: unique,
    })
  }
  return drafts
}

interface ReviewJobInput {
  options: { signal?: AbortSignal; automatic?: boolean; resumeJobId?: string }
  /** 驱动哪一区来源；`null` = 恢复的旧作业不分类（水位按会话隔离，两区互不吞并）。 */
  sourceClass: SourceClass | null
  started: MemoryJob
  resumedBatchOffset: number
}

function emptyOutcome(message: string): DreamingOutcome {
  return { status: "empty", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message }
}

/** 一次 Review 作业（单类来源）：Light 已在作业外登记，这里产出 staging 候选并自动 Publish。 */
async function runReviewJob(input: ReviewJobInput): Promise<DreamingOutcome> {
  const { options, sourceClass, started } = input
  const jobId = started.id
  const traceContext = hasRuntimeTraceSubscribers() ? createRuntimeTraceContext(undefined, jobId) : undefined
  const traceStartedAt = traceContext ? (typeof performance === "undefined" ? Date.now() : performance.now()) : 0
  let sourcesProcessed = 0
  let candidatesAdded = 0
  let candidateCount = 0
  let publishedCount = 0
  let reservedTokens = 0
  let usedTokens = 0
  const today = localDate()
  let revision = started.revision
  const processedSourceIds: string[] = []
  const oversized: string[] = []
  /** 派生区在库条目索引（本作业只读一次；了解池的跨批记账状态就地推进）。 */
  let derivedState: { slots: Map<string, string>; understanding: UnderstandingPoolState } | null = null

  if (traceContext) publishRuntimeTrace(traceContext, "memory_extraction_start", () => ({ jobId, revision, phase: started.phase, sourceClass: sourceClass ?? "mixed" }))
  const finish = (status: DreamingOutcome["status"], outcome: Omit<DreamingOutcome, "status" | "jobId">, reason?: string): DreamingOutcome => {
    if (traceContext) publishRuntimeTrace(traceContext, "memory_extraction_end", () => ({
      jobId, revision, status, candidateCount, sourceIds: processedSourceIds,
      sourceCount: sourcesProcessed,
      durationMs: (typeof performance === "undefined" ? Date.now() : performance.now()) - traceStartedAt,
      ...(reason ? { reason } : {}),
    }))
    return { status, jobId, ...outcome }
  }

  try {
    // 输出预算按模型窗口推导一次快照（reasoning 的 thinking 也计入），显式配置只作更小的上限；
    // 同一轮内预留与调用共用同一个模型与预算，避免中途改配置造成账目口径不一致。
    // 模型按需解析：纯系统观察批次不过模型，没有可用模型时也不应被它拖住。
    let auxModel: ReturnType<typeof resolvePiAuxModel> | undefined

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      if (options.signal?.aborted) {
        await cancelMemoryJob(jobId).catch(error => log.warn("取消整理作业失败:", formatError(error)))
        return finish("cancelled", { sourcesProcessed, candidatesAdded, publishedCount, oversized }, "signal_aborted")
      }
      const pending = await memoryJobSources(jobId, sourceClass ?? undefined)
      if (pending.length === 0) break
      // 分区：同一批只处理一类来源（用户事实 / 系统观察）。新作业由 sourceClass 冻结；
      // 恢复的旧作业没有类别记录，按首条来源的类别成批处理（水位按会话隔离）。
      const derivedBatch = sourceClass === "derived_behavior"
        || (sourceClass === null && isDerivedBehaviorSource(pending[0]!))
      const pool = sourceClass === null
        ? pending.filter(source => isDerivedBehaviorSource(source) === derivedBatch)
        : pending
      const batchSources = pool.slice(0, MAX_SOURCES_PER_BATCH)
      const usable = batchSources.filter(source => {
        const text = source.evidence ?? ""
        if ((source.sourceLength ?? text.length) > MAX_SOURCE_CHARS * 4) {
          oversized.push(source.sourceId)
          return false
        }
        return true
      })
      if (usable.length === 0) break

      if (derivedBatch) {
        // 确定性 Review：结论文本与了解摘要都原样沉淀、不经模型改写，也不占 token 预算/预留。
        // 了解池状态跨批共享：上限与覆盖目标按整次作业记账（见 UnderstandingPoolState）。
        if (!derivedState) {
          const owners = await derivedOwners()
          derivedState = {
            slots: owners.slots,
            understanding: {
              identities: owners.understanding.identities,
              idsOldestFirst: owners.understanding.idsOldestFirst,
              plannedNew: 0,
              evictionCursor: 0,
            },
          }
        }
        const drafts = [
          ...buildDerivedCandidates(usable, derivedState.slots),
          // 了解观察的选择面向本次作业的**全部待处理来源**（不只当前批切片）：
          // 批切片只是处理顺序，窗口应看整批 —— 跨批时状态会记住已占用的名额与覆盖目标。
          ...buildUnderstandingCandidates(pool, derivedState.understanding),
        ]
        candidateCount += drafts.length
        if (drafts.length > 0) {
          candidatesAdded += await addMemoryCandidates(jobId, await candidatePayloads(drafts.map(draft => ({ draft }))))
        }
      } else {
        auxModel ??= resolvePiAuxModel()
        const { contextWindow, maxTokens: outputBudget } = auxModel
        const configuredReviewMaxTokens = memoryConfig.dreamingReviewMaxTokens
        const reviewMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
          Math.min(configuredReviewMaxTokens ?? outputBudget, outputBudget))
        const userText = buildReviewPrompt(usable)
        // 单批再按真实剩余窗口收紧：输入 + 输出 + 余量必须留在窗口内，避免大输入把输出逼到截断。
        const inputTokens = estimateContextTokens(userText)
        const reserveMargin = Math.max(512, Math.floor(contextWindow * .02))
        const batchMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
          Math.min(reviewMaxTokens, contextWindow - inputTokens - reserveMargin))
        const reservation = inputTokens + batchMaxTokens
        if (options.automatic) {
          // 预留只记账（reserved 增量 + 租约行），不再按日 token 总量准入，
          // 也不再用返回值中止批次（2026-10-06 用户裁决；容量边界靠批数与单批预算）。
          const reservationId = `${jobId}:${input.resumedBatchOffset + batch}`
          await reserveMemoryDreamingBudget(reservationId, today, reservation)
          reservedTokens += reservation
        }
        const result = await completePiText({
          purpose: "memory",
          // 辅助模型在这里冻结（ai.auxModel；留空即聊天模型）：整理作业与子代理同款模型。
          model: auxModel,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          userText,
          maxTokens: batchMaxTokens,
          timeoutMs: reviewTimeoutMs(batchMaxTokens),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(traceContext ? { traceContext } : {}),
        })
        const actualUsage = result.usage.input + result.usage.output
        usedTokens += actualUsage
        if (options.automatic) {
          await settleMemoryDreamingBudget(`${jobId}:${input.resumedBatchOffset + batch}`, today, reservation, actualUsage)
          reservedTokens -= reservation
        }
        const parsed = parseReviewCandidates(result.text, usable)
        candidateCount += parsed.length
        if (parsed.length > 0) {
          candidatesAdded += await addMemoryCandidates(jobId, await candidatePayloads(parsed))
        }
      }
      sourcesProcessed += usable.length
      processedSourceIds.push(...usable.map(source => source.sourceId))
      const checkpoint = await checkpointMemoryJob(jobId, usable[usable.length - 1]!.sourceId, LEASE_OWNER)
      revision = checkpoint.revision
      if (pool.length <= MAX_SOURCES_PER_BATCH) break
    }

    // Candidate rows are only an internal, hash-checked staging area. There is no
    // review screen: the finished job commits all eligible candidates atomically.
    const current = await memoryStatus()
    const committedRevision = await commitMemoryDreamingJob(jobId, current.revision)
    if (candidateCount > 0) {
      publishedCount = candidateCount
      await refreshMemoryCount()
    }
    const status = sourcesProcessed === 0 && candidatesAdded === 0 ? "empty" : "completed"
    return finish(status, { sourcesProcessed, candidatesAdded, publishedCount, oversized, budget: { localDate: today, reservedTokens, usedTokens }, message: `revision ${committedRevision}` })
  } catch (error) {
    log.error("整理失败:", formatError(error))
    await cancelMemoryJob(jobId).catch(cancelError => log.warn("失败后取消作业也失败:", formatError(cancelError)))
    return finish("failed", { sourcesProcessed, candidatesAdded, publishedCount, oversized, message: formatError(error) }, "operation_failed")
  }
}

/** 两相（用户事实 / 系统观察）的结果合并：状态取最坏，计数求和。 */
function mergeDreamingOutcomes(outcomes: readonly DreamingOutcome[]): DreamingOutcome {
  const rank: Record<DreamingOutcome["status"], number> = { empty: 0, completed: 1, cancelled: 2, failed: 3 }
  let status: DreamingOutcome["status"] = "empty"
  let sourcesProcessed = 0
  let candidatesAdded = 0
  let publishedCount = 0
  let reservedTokens = 0
  let usedTokens = 0
  const oversized: string[] = []
  const messages: string[] = []
  let jobId: string | undefined
  let localDate: string | undefined
  for (const outcome of outcomes) {
    if (rank[outcome.status] > rank[status]) status = outcome.status
    sourcesProcessed += outcome.sourcesProcessed
    candidatesAdded += outcome.candidatesAdded
    publishedCount += outcome.publishedCount
    oversized.push(...outcome.oversized)
    if (outcome.message) messages.push(outcome.message)
    jobId ??= outcome.jobId
    if (outcome.budget) {
      reservedTokens += outcome.budget.reservedTokens
      usedTokens += outcome.budget.usedTokens
      localDate ??= outcome.budget.localDate
    }
  }
  return {
    status,
    ...(jobId ? { jobId } : {}),
    sourcesProcessed,
    candidatesAdded,
    publishedCount,
    oversized,
    ...(localDate ? { budget: { localDate, reservedTokens, usedTokens } } : {}),
    ...(messages.length ? { message: messages.join("；") } : {}),
  }
}

/**
 * 无新来源时的库内整理（合并重复/合并同类/更新过时，用户已批「允许合并与更新」）。
 *
 * - 前置保护不变：只有两区水位之后都没有新来源时才走这一步（新来源优先）；
 * - 廉价早退：一次有界列举后没有「同 origin 区内、同 scope、同 kind、≥2 条」的分组时，
 *   零写返回（不创建作业、不动预算、不调模型）；
 * - 只在用户区合并：派生区由确定性通道处理（了解条目的文本改写是红线禁止的演绎面、
 *   结论条目每槽位唯一），跨区合并在结构上没有路径；
 * - 全自动：模型只产出分组与合并正文；来源并集、旧条目 supersede、范围/类别复核都在
 *   Rust 发布事务（`publish_candidates`）完成，冲突按 MEMORY_CONFLICT 如实失败，无人工门。
 * - 模型调用走与 Review 同一条通道（aux 模型 + purpose="memory"），实际用量照记；
 *   这里不为它开 memory_extraction trace（作业身份在候选通过校验后才创建）。
 */
async function runMergeSweep(options: ReviewJobInput["options"]): Promise<DreamingOutcome> {
  try {
    const items = await memoryList(undefined, undefined, 500)
    const cohorts = mergeCohorts(items)
    if (cohorts.length === 0) {
      return emptyOutcome("水位之后没有新的可整理来源；库里也没有可合并的条目")
    }
    const auxModel = resolvePiAuxModel()
    const { contextWindow, maxTokens: outputBudget } = auxModel
    const configuredReviewMaxTokens = memoryConfig.dreamingReviewMaxTokens
    const reviewMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
      Math.min(configuredReviewMaxTokens ?? outputBudget, outputBudget))
    const userText = buildMergePrompt(cohorts)
    const inputTokens = estimateContextTokens(userText)
    const reserveMargin = Math.max(512, Math.floor(contextWindow * .02))
    const batchMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
      Math.min(reviewMaxTokens, contextWindow - inputTokens - reserveMargin))
    const today = localDate()
    const reservationId = `merge:${crypto.randomUUID()}`
    const reservation = inputTokens + batchMaxTokens
    if (options.automatic) await reserveMemoryDreamingBudget(reservationId, today, reservation)
    const result = await completePiText({
      purpose: "memory",
      model: auxModel,
      systemPrompt: MERGE_SYSTEM_PROMPT,
      userText,
      maxTokens: batchMaxTokens,
      timeoutMs: reviewTimeoutMs(batchMaxTokens),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (options.automatic) {
      await settleMemoryDreamingBudget(reservationId, today, reservation, result.usage.input + result.usage.output)
    }
    if (options.signal?.aborted) {
      return { status: "cancelled", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "signal_aborted" }
    }
    const drafts = parseMergeCandidates(result.text, cohorts)
    if (drafts.length === 0) return emptyOutcome("库里没有值得合并的条目")
    const started = await startMemoryJob("review")
    if (started.phase !== "review") {
      await cancelMemoryJob(started.id, LEASE_OWNER)
        .catch(error => log.warn("非 Review 作业取消失败:", formatError(error)))
      return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
    }
    await addMemoryCandidates(started.id, await candidatePayloads(drafts.map(draft => ({ draft }))))
    const current = await memoryStatus()
    const committedRevision = await commitMemoryDreamingJob(started.id, current.revision)
    await refreshMemoryCount()
    return {
      status: "completed", jobId: started.id, sourcesProcessed: 0,
      candidatesAdded: drafts.length, publishedCount: drafts.length, oversized: [],
      message: `revision ${committedRevision}`,
    }
  } catch (error) {
    log.error("库内合并整理失败:", formatError(error))
    return { status: "failed", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: formatError(error) }
  }
}

/** 开一个 Review 作业并跑到收口（新作业阶段恒为 review，`job_start` 只接受 light|review）。 */
async function runClassSweep(sourceClass: SourceClass, options: ReviewJobInput["options"]): Promise<DreamingOutcome> {
  const started = await startMemoryJob("review")
  if (started.phase !== "review") {
    // 生产路径不会到这里（phase 是我们传的）；留一条如实失败，不驱动非 Review 作业。
    await cancelMemoryJob(started.id, LEASE_OWNER)
      .catch(error => log.warn("非 Review 作业取消失败:", formatError(error)))
    return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
  }
  return runReviewJob({ options, sourceClass, started, resumedBatchOffset: 0 })
}

/**
 * 一次整理：Light（登记来源）→ Review（产出 staging 候选）→ 自动 Publish。
 *
 * 两区来源各自成作业（用户事实 / 系统观察）：前置查询按类别分开（`memory_pending_source_count`
 * 的 origin 参数），有输入的类别才开作业；恢复既有作业（resumeJobId）不经前置查询。
 * 两区水位之后都没有新来源时不整段跳过，而是转入库内整理（`runMergeSweep`：同 origin 区内
 * 合并重复/同类/过时条目，用户已批「允许合并与更新」；没有可合并分组时零写早退）。
 * 返回合并后的计数，用于面板展示与报告。
 */
export async function runDreamingSweep(options: { signal?: AbortSignal; automatic?: boolean; resumeJobId?: string } = {}): Promise<DreamingOutcome> {
  if (!memoryConfig.enabled) return emptyOutcome("记忆功能已关闭")

  if (options.resumeJobId) {
    const started = await resumeMemoryJob(options.resumeJobId, LEASE_OWNER)
    if (started.phase !== "review") {
      await cancelMemoryJob(options.resumeJobId, LEASE_OWNER)
        .catch(error => log.warn("继续非 Review 作业后取消失败:", formatError(error)))
      return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
    }
    return runReviewJob({ options, sourceClass: null, started, resumedBatchOffset: started.processed ?? 0 })
  }

  // 前置查询在开作业之前：Light 先登记来源（新来源没登记，水位判定永远为「无」），
  // 再按类别问 Rust「水位之后还有没有待处理来源」。两区都没有 → 不开 Review 作业：
  // 转入库内整理（runMergeSweep），没有可合并分组时一次列举后零写早退、只留一条 debug。
  // 手动入口走同一条前置查询：Review 的输入只有这些来源，没有输入时开作业必然空跑
  // （提交也只会提交本 job 的候选，见 memory_dreaming_commit 的 job 归属），
  // outcome 仍是 empty，只是不再产生垃圾作业行；回报文案如实说明。
  let userPending = 0
  let derivedPending = 0
  try {
    const { collectAllMemorySources, collectBehaviorMemorySources, collectUnderstandingMemorySources } = await import("./sources")
    await collectAllMemorySources()
    // 稳定结论与用户来源同批登记；非 reliable 档返回空、不登记任何来源。
    await collectBehaviorMemorySources()
    // 静默了解的观察摘要也进派生区（同 origin 分池）；档位 off 或没有观察时返回空、不登记。
    await collectUnderstandingMemorySources()
    userPending = await pendingMemorySourceCount("user")
    derivedPending = await pendingMemorySourceCount("derived_behavior")
  } catch (error) {
    log.error("整理前的来源收集失败:", formatError(error))
    return { status: "failed", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: formatError(error) }
  }

  const outcomes: DreamingOutcome[] = []
  if (userPending > 0) outcomes.push(await runClassSweep("user", options))
  if (derivedPending > 0) outcomes.push(await runClassSweep("derived_behavior", options))
  if (outcomes.length === 0) {
    // 没有新来源时才做库内整理（合并/更新已有条目，用户已批「允许合并与更新」）；
    // 库里没有可合并分组时一次列举后零写早退（见 runMergeSweep）。
    log.debug("水位之后没有待处理来源，转入库内整理检查")
    return runMergeSweep(options)
  }
  return mergeDreamingOutcomes(outcomes)
}

/**
 * 定时模式的轻量调度器（2026-10-06 用户裁决：固定钟点，不再要求系统空闲）：
 * 只负责触发可取消的离线作业，作业完成后由 Rust 事务自动提交。
 * 状态保存在本模块仅作为节流（最近一次尝试时刻；不是第二份记账文件）；
 * 真正的租约、游标和候选正文都在 Rust 库里。
 *
 * 触发判定（与静默了解共用 `proactive/schedule.ts` 的同一张钟点表，各自独立记账）：
 * - 档位语义 = 每天的钟点数（低 2 / 中 4 / 高 6，钟点表在 `proactive/protocol.json`）；
 * - 到点：本地时刻落在钟点表的追赶窗口内，且该钟点本轮未尝试过；
 * - 最小间隔防重：距上一轮未满 `minIntervalMinutes` 不开（钟点间隔已大于它，这里是兜底）；
 * - 单飞：上一轮未收口不开下一轮；
 * - 开跑前先查「水位之后有无待处理来源」，没有就跳过（runDreamingSweep 内，debug 一条）。
 * 档位 off = 本调度器早退（不自动跑），手动入口 `action.memorySweep` 不受档位影响。
 */
export function startIdleDreamingScheduler(): () => void {
  if (sweepTimer) return () => stopIdleDreamingScheduler()
  const tick = (): void => {
    const tier = dreamingTier()
    if (tier === "off" || !memoryConfig.enabled) return
    if (sweepRun) return
    const now = Date.now()
    const limits = dreamingTierLimits(tier)
    if (!scheduledSlotDue(limits.hours, now, lastSweepRunAt)) return
    if (now - lastSweepRunAt < Math.max(1, limits.minIntervalMinutes) * 60_000) return
    lastSweepRunAt = now
    const controller = new AbortController()
    sweepController = controller
    const run = runDreamingSweep({ automatic: true, signal: controller.signal })
      .catch(error => log.warn("定时记忆整理失败:", formatError(error)))
      .finally(() => {
        if (sweepRun === run) {
          sweepRun = null
          sweepController = null
        }
      })
    sweepRun = run
  }
  sweepTimer = setInterval(tick, IDLE_TICK_MS)
  tick()
  return () => stopIdleDreamingScheduler()
}

export function stopIdleDreamingScheduler(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  sweepController?.abort(new Error("应用正在关停"))
}

export async function stopIdleDreamingSchedulerAndWait(): Promise<void> {
  stopIdleDreamingScheduler()
  await sweepRun
}
