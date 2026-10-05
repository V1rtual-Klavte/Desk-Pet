/**
 * V1rtual-Desk-Pet runtime protocol types.
 *
 * This module intentionally has no business imports.  It is the shared
 * vocabulary for ingress, prompt snapshots and plans;
 * concrete stores and adapters live in their owning domains.
 * H-4：宿主队列（QueueEntry/QueueAck）随 RuntimeQueue 退役，投递语义由 Harness lane 承接。
 */

// ── 会话条目的宿主自定义类型（JSONL 条目的 customType）──
// 值即落盘形态：改名直接换值、不做兼容读取（旧数据可弃，不是缺陷）。

/** 欢迎语条目：宿主生成，读模型投影为聊天视图的 assistant 气泡，不进模型上下文。 */
export const DESKPET_GREETING_ENTRY = "deskpet.greeting"

/** 系统提示条目：宿主/运行时写的系统消息，读模型投影为 system 气泡，不进模型上下文。 */
export const DESKPET_SYSTEM_MESSAGE_ENTRY = "deskpet.system_message"

/** 请求快照条目：三档 PromptSnapshot 的落盘形态（快照协议见 PromptSnapshot）。 */
export const PROMPT_SNAPSHOT_ENTRY = "deskpet.prompt_snapshot"

/**
 * 提示词派生记录条目：一次派生（如压缩摘要）只留输入/输出 hash 与派生来源，
 * 不进模型消息流，也不落派生正文。
 */
export const PROMPT_REWRITE_ENTRY = "deskpet.prompt_rewrite"

/**
 * 压缩降级条目：压缩没落成（宿主摘要内核失败，或宿主钩子策略性 decline 了 manual/overflow
 * 压缩）时写的审计条目。
 *
 * 它证明的是「这次压缩为什么没落成」：上游通用英文摘要一旦提交就成为后续所有回合唯一的历史
 * 视图且不可回滚，宿主的取舍是显式 decline，代价必须留下可追溯的证据。内核失败用 `error`
 * 字段（用户面读同一字段报 failed），策略性拒绝用 `decline` 结构化记录（kind/trigger/数字）。
 * threshold 触发的 decline 不落条目（每个检查点都会重试的内部优化），只留统一日志。
 */
export const COMPACTION_DECLINED_ENTRY = "deskpet.compaction_declined"

/**
 * 召回失败条目：MemoryProvider 召回抛错、回合按空召回继续时写的审计条目。
 *
 * 降级继续是对的（长期记忆缺席不该让整轮对话起不来），但它改变了模型看到的上下文，
 * 必须留下可查的证据：否则「这轮为什么像失忆」既没有日志归属也没有持久痕迹。
 */
export const RECALL_FAILED_ENTRY = "deskpet.recall_failed"

export type MessageOrigin =
  | "user"
  | "assistant"
  | "tool"
  | "active"
  | "hook"
  | "queue"
  | "recovery"
  | "plan"
  | "memory"
  | "proactive"

export type QuerySource =
  | "chat"
  | "active_monitor"
  | "proactive"
  | "hook"
  | "queue"
  | "recovery"
  | "plan"

export type MessageTaint =
  | "trusted_user"
  | "system"
  | "untrusted_external"
  | "derived"

export type MessagePriority = "now" | "next" | "later"

export interface IngressEnvelope {
  schemaVersion: 1
  requestId: string
  sessionId: string
  parentRequestId?: string
  parentTurnId?: string
  origin: MessageOrigin
  querySource: QuerySource
  rawText: string
  normalizedText: string
  receivedAt: number
  priority: MessagePriority
  taint: MessageTaint
}

/**
 * 输入条目的来源标记：随用户消息一起落盘的「这条输入从哪来、算不算用户事实」。
 *
 * 与 `IngressEnvelope` 的分工：envelope 是入口处的当次形态（含 raw/normalized 正文、
 * 时间与父子关联），只活在内存里；标记是压进会话条目的稳定词汇，重建请求、投递证据链
 * 与记忆准入都只读它，不靠第二套来源字段。
 */
export interface InputSourceMark {
  origin: MessageOrigin
  querySource: QuerySource
  priority: MessagePriority
  taint: MessageTaint
  /** 是否允许进入长期记忆（用户本人可信输入才是；恢复续跑、系统与外部内容都不是）。 */
  eligibleForMemory: boolean
  /** 输入准入时冻结的 Card 身份；历史记录缺失时不能事后反推。 */
  cardId?: string
}

export type ContextLayer =
  | "static"
  | "dynamic"
  | "memory"
  | "transcript"
  | "ephemeral"

export interface ContextAllocation {
  layer: "static" | "tools" | "dynamic" | "memory" | "transcript" | "ephemeral"
  requested: number
  used: number
  /** 本层被整块淘汰的 token 数；没有淘汰时省略字段（不写 0）。 */
  dropped?: number
}

export interface ContextBlock {
  blockId: string
  layer: ContextLayer
  source: string
  text: string
  /** Persistence-safe snapshots clear text and retain this digest. */
  contentHash?: string
  priority: number
  tokenBudget?: number
  origin: MessageOrigin | "system"
  taint: MessageTaint
  sourceId?: string
  provenance?: string
  projectionVersion?: number
  memoryVersion?: string
}

export type PromptTransformReason =
  | "input_normalization"
  | "profile_rewrite"
  | "memory_recall"
  | "compaction"
  | "safety_redaction"
  | "budget"

export interface PromptTransform {
  transformId: string
  name: string
  inputHash: string
  outputHash: string
  reason: PromptTransformReason
  derivedFrom: string[]
  createdAt: number
}

/**
 * 宿主压缩钩子的审计槽：一次性调用（摘要内核）把这次压缩的产物/失败/拒绝写进它，
 * 由运行槽在 `compaction_end` 收口成审计条目（hook 内不能直接写 lane）。
 * `rewrite` 是压缩摘要的派生记录，失败路径用 `failure`；`decline` 是策略性拒绝的结构化原因
 * （素材为空 / 保留守卫 / 闸门装得下），**不写 failure** —— 两者语义不同：failure 会把手动
 * `/compact` 翻成可见失败，decline 只改审计面。`rewrite` 与 `decline` 用过即由槽清空。
 */
export interface CompactionAuditSink {
  rewrite?: PromptTransform
  failure?: string
  decline?: CompactionDeclineRecord
}

/** 压缩任务的触发方式：与 pi 的 compaction 任务 reason 同名（manual = 用户 `/compact`；overflow = 溢出恢复；threshold = 阈值检查点）。 */
export type CompactionTrigger = "manual" | "threshold" | "overflow"

/** 压缩被拒绝的分类：素材为空 / 必须保留原文的工具 / 级 3 闸门装得下 / 摘要内核失败。 */
export type CompactionDeclineKind = "empty_material" | "retained_tool" | "gate_fits" | "kernel_failure"

/**
 * 素材分段后仍无法覆盖的结构化数字（`CompactionOverflowError.detail` 的形状，唯一定义点在这里）：
 * `over_cap` 时 `needed` = 真实片数、`limit` = 片数上限（`used` = 同上限）；
 * `oversized_unit` 时 `used` = 单元自身成本 + overhead、`limit` = 硬输入上限。
 */
export interface CompactionOverflowDetail {
  readonly reason: "over_cap" | "oversized_unit"
  readonly needed: number
  readonly used: number
  readonly limit: number
}

/**
 * 压缩被拒绝的结构化留痕：decline 不是失败（不写 `failure`、不改用户可见文案），但「哪种原因、
 * 什么触发、关键数字多少」必须可诊断 —— pi 的 `declined` 终态不带 error，宿主钩子是唯一的原因出口。
 * 钩子每次拒绝都写进 `CompactionAuditSink.decline` 并留一条统一日志；槽按触发方式落审计条目
 * （manual / overflow；threshold 是每个检查点都会重试的内部优化，只留日志，见 harness-slot）。
 */
export interface CompactionDeclineRecord {
  readonly kind: CompactionDeclineKind
  readonly trigger: CompactionTrigger
  readonly sessionId?: string
  /** empty_material：为什么没有可安全摘要的范围（素材与保留窗口的现场读数）。 */
  readonly material?: {
    /** 过滤空助手消息后的待摘要条数（decline 时为 0）。 */
    readonly messagesToSummarize: number
    /** 同上，split-turn 前缀段条数。 */
    readonly turnPrefixMessages: number
    /** 被「无正文已完结助手」过滤丢掉的条数：>0 说明素材曾经非空，是滤空的。 */
    readonly droppedEmptyAssistant: number
    /** 保留区（retainedTail）的条数：全量落在保留窗口内就是它顶掉了摘要范围。 */
    readonly retainedMessages: number
    /** pi 估的压缩前上下文 tokens（estimateContextTokens 口径）。 */
    readonly tokensBefore: number
    /** 上游保留窗口（keepRecentTokens）：消息估算总量没越过它时切点停在开头。 */
    readonly keepRecentTokens: number
  }
  /** retained_tool：命中的必须保留原文的工具名（historyCompaction=retain）。 */
  readonly retainedTool?: { readonly toolName: string }
  /** gate_fits：级 1/2 投影后的估算、目标与生效层级。 */
  readonly gate?: { readonly tokens: number; readonly target: number; readonly level: number }
  /** kernel_failure：错误码 + over_cap/oversized_unit 的结构化数字。 */
  readonly failure?: { readonly code?: string; readonly overflow?: CompactionOverflowDetail }
}

export interface PromptToolSchema {
  name: string
  schemaHash: string
  policyHash: string
}

export interface PromptAgentMessage {
  id: string
  role: string
  origin?: MessageOrigin
  contentHash: string
}

export interface PromptLlmMessage {
  role: string
  contentHash: string
  toolCallId?: string
}

/**
 * 估算与实际 usage 的对账：同一请求在 provider_usage 快照上留下估算偏差。
 * 只留痕（超阈值 warn + trace），不改变任何预算判定。
 */
export interface PromptTokenDrift {
  estimated: number
  actual: number
  ratio: number
}

export interface PromptCacheInfo {
  sessionId?: string
  prefixHash?: string
  breakReason?: string
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 请求用途：回合、压缩、分支摘要、一次性文本请求。 */
export type PromptRequestPurpose = "turn" | "compaction" | "branch_summary" | "one_shot"

/** 本次请求的用途与上游 step/attempt；快照无法只靠 runId 回答「这是哪次请求」。 */
export interface PromptRequestContext {
  purpose: PromptRequestPurpose
  /** 上游 before_request 的 step（回合 "assistant"/"deferred"，压缩 "compaction"）。 */
  step?: "assistant" | "deferred" | "compaction" | "branch_summary"
  attempt?: number
}

/** Provider 请求参数（脱敏快照）：取不到的参数不写字段，不写假值。 */
export interface PromptRequestParams { maxTokens?: number; temperature?: number; imageCount?: number }

/** 计划步骤归属：步骤执行中把 stepId 更新进去。 */
export interface PromptPlanContext { planId: string; stepId?: string; version: number }

/** 回合开始冻结的能力：冻结值只来自 preflight，工具裁决逐请求累积。 */
export interface PromptCapabilityContext {
  skillsFingerprint?: string
  safetyMode: string
  toolDecisions: Array<{ toolName: string; decision: "allow" | "ask" | "deny"; reason?: string }>
}

/** 请求视图的换代归属：本分支已提交的压缩次数与最近一条压缩条目。 */
export interface PromptCompactionContext { count: number; lastEntryId?: string; summaryHash?: string }

export interface PromptSnapshot {
  schemaVersion: 1
  snapshotId: string
  requestId: string
  sessionId: string
  turnId: string
  runId: string
  captureStage: "transform_context" | "provider_payload" | "provider_usage"
  model: string
  provider: string
  thinkingLevel?: string
  systemBlocks: ContextBlock[]
  toolSchemas: PromptToolSchema[]
  agentMessages: PromptAgentMessage[]
  llmMessages: PromptLlmMessage[]
  transforms: PromptTransform[]
  estimatedInputTokens: number
  budget?: import("@/services/context").ContextBudget
  allocations?: ContextAllocation[]
  contextEpoch?: number
  actualInputTokens?: number
  actualOutputTokens?: number
  /** provider_usage 阶段的估算偏差对账；没有 usage 回执时不写。 */
  tokenDrift?: PromptTokenDrift
  /** 本次请求的用途与上游 step/attempt。 */
  request?: PromptRequestContext
  /** Provider payload 的稳定 hash（脱敏后序列化的 sha256）。 */
  payloadHash?: string
  /** systemPrompt 的脱敏 hash（跨阶段可比）。 */
  systemPromptHash?: string
  requestParams?: PromptRequestParams
  plan?: PromptPlanContext
  capabilities?: PromptCapabilityContext
  compaction?: PromptCompactionContext
  /** 槽代际：区分「同一会话被释放重建」前后的请求。 */
  generation?: number
  /** 内核整块淘汰的可选块（预算降级记录，T3.32 的内核产出）。 */
  budgetDrops?: import("@/services/context").ContextBudgetAdjustment[]
  cache: PromptCacheInfo
  redactions: string[]
  createdAt: number
}

export type PlanState = "admitting" | "running" | "paused" | "done" | "failed" | "interrupted"

export type PlanStepState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted"
  | "unknown_side_effect"

export type PlanEffectClass = "read_only" | "external_side_effect"

/**
 * 计划的唯一持久形态（`schemaVersion: 2`）。
 *
 * `summary`/`estimatedComplexity` 随记录落盘，恢复时不需要第二份 `PlanResult`。
 * `schemaVersion: 2` 的形态变更不做数据迁移，存量旧格式计划按不可恢复处理（旧数据可弃）。
 */
export interface PlanRecord {
  schemaVersion: 2
  planId: string
  sessionId: string
  rootTurnId: string
  state: PlanState
  summary: string
  estimatedComplexity: number
  version: number
  createdAt: number
  updatedAt: number
}

export interface PlanStepRecord {
  planId: string
  stepId: string
  title: string
  role?: string
  allowedTools?: string[]
  state: PlanStepState
  attempt: number
  effectClass: PlanEffectClass
  lastEventId?: string
  lastEventKind?: "tool_start" | "tool_end"
  /** 与 `effectClass` 同域：工具侧三档非只读 effect 在计划域塌缩为 external_side_effect。 */
  lastEventEffect?: PlanEffectClass
  updatedAt: number
}
