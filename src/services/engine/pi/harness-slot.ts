// Desk-Pet 的 AgentHarness 运行槽（H-2：运行内核替换）。
//
// 每个 App 会话一个槽：一个 JsonlSessionRepo 会话 + 一条 "main" lane。
// Harness 承担模型/工具循环、持久 inbox（steer/followUp）、操作记录与取消收尾；
// 宿主只提供：冻结的 systemPrompt/工具集、before_tool 权限终裁、after_tool 结果元数据、
// transform_context 投影与 before_payload/after_response 观测。
//
// 代际与取消：代际在本槽内单调递增；取消走原生 lane.abort，未消费的 steer/followUp
// 以 nextRun 重新入队（持久、不丢、不自动继续），并把 requestId 归还给宿主。

import { AgentHarness, MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core"
import type {
  AgentHarnessStreamOptionsPatch,
  AgentLane,
  AgentMessage,
  AgentToolResult,
  CompactResult,
  CompactionPreparation,
  CompactionSettings,
  LaneQueuedItem,
  JsonlSessionMetadata,
  JsonValue,
  OperationResultRecord,
  SettledAssistantMessage,
  Session,
  UsageRow,
} from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import type { ToolDef } from "@/services/tool/types"
import type { HarnessToolRun } from "@/services/tool/pi/harness-tool-adapter"
import { toAgentHarnessTools } from "@/services/tool/pi/harness-tool-adapter"
import { setToolPermitLimit } from "@/services/tool/execution-permit"
import { ContextBudgetError, contextBudget, toHarnessEstimateTokens } from "@/services/context"
import { messageRequestId } from "@/services/engine/runtime"
import { conversationConfig, loopConfig } from "@/services/config"
import { PI_LANE } from "@/services/session/repo"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { createHarnessModels, resolvePiTurnModel, toPiAgentThinkingLevel } from "./model-gateway"
import type { PiModel } from "./model-gateway"

const log = createLogger("HarnessSlot")

/** 会话内唯一 lane：与 session 层共用 PI_LANE，不建第二个定义点。 */
export { PI_LANE as HARNESS_LANE } from "@/services/session/repo"

/**
 * 压缩续跑的审计条目：手动压缩后的续跑没有宿主回合（无结算、无 UI 推送），
 * 上游却仍会驱动它消费 lane inbox。它一旦被结算就不能再报「压缩完成」，
 * 必须留下可追溯的证据（与 PROMPT_SNAPSHOT_ENTRY 同层，不进模型消息流）。
 */
export const COMPACTION_CONTINUATION_ENTRY = "deskpet.compaction_continuation"

/** 回合内共享的聚合状态：由宿主创建，槽在事件处理中填充。 */
export interface HarnessRunState {
  stoppedAtToolLimit: boolean
  toolCallsMade: number
  retriesUsed: number
  /** transform_context 记录的当次请求判定；由网关在下一次请求取走（取走即清空）。 */
  contextError?: unknown
  /**
   * 本回合最近一次被取走的硬预算判定文案。硬预算超限改走 Harness 溢出恢复后，
   * 上游以「没有可摘要范围」declined 时回合会失败、失败文案是上游的；
   * 结算需要回到这条可解释的判定，才能告诉用户该缩短输入还是调窗口。
   */
  lastBudgetError?: string
  /** 上游对溢出压缩的终态：declined 表示这次硬预算超限没有可安全摘要的范围。 */
  overflowRecoveryDeclined?: boolean
  /** abort 归还的未消费消息（deskpetEventId → requestId）。 */
  undelivered: string[]
  usage?: Usage
  finalAssistant?: AssistantMessage
  /** 最近一次不带工具调用的 assistant（结算候选）。 */
  finalPlainAssistant?: AssistantMessage
}

export function createHarnessRunState(): HarnessRunState {
  return { stoppedAtToolLimit: false, toolCallsMade: 0, retriesUsed: 0, undelivered: [] }
}

/** 宿主注入的行为：权限、结果元数据、投影与观测。 */
export interface HarnessRunHooks {
  beforeTool?: (input: {
    toolCallId: string
    toolName: string
    args: Record<string, JsonValue>
    signal?: AbortSignal
  }) => Promise<{ block: { reason: string; terminate?: boolean } } | undefined> | { block: { reason: string; terminate?: boolean } } | undefined
  afterTool?: (input: {
    toolCallId: string
    toolName: string
    args: Record<string, JsonValue>
    content: AgentToolResult<unknown>["content"]
    details?: JsonValue
    isError: boolean
  }) => { details?: JsonValue; isError?: boolean } | undefined
  transformContext?: (input: {
    messages: AgentMessage[]
    systemPrompt: string
  }) => Promise<{ messages?: AgentMessage[] } | undefined> | { messages?: AgentMessage[] } | undefined
  /**
   * 压缩决策钩子：返回自定义 CompactResult（宿主摘要内核）或 decline 跳过。
   * 抛出异常由 Harness 记为 handler_error 并回退其默认摘要；不能在此静默丢覆盖。
   */
  beforeCompaction?: (input: {
    reason: "manual" | "threshold" | "overflow"
    preparation: CompactionPreparation
    signal?: AbortSignal
  }) => Promise<{ decline?: boolean; compaction?: CompactResult } | undefined> | { decline?: boolean; compaction?: CompactResult } | undefined
  /** 逐请求 streamOptions 补丁（超时/请求头）；Harness 的 SDK 内层重试保持关闭。 */
  beforeRequest?: (input: {
    step: "assistant" | "deferred" | "compaction" | "branch_summary"
    attempt: number
  }) => { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined
  afterResponse?: (message: SettledAssistantMessage, meta: {
    status?: number
    headers?: Record<string, string>
  }) => Promise<SettledAssistantMessage | undefined> | SettledAssistantMessage | undefined
  beforePayload?: (payload: unknown, model: Model<any>) => void
}

/**
 * 结构操作（手动压缩与它的续跑）的宿主面。
 *
 * 结构操作没有回合身份、没有工具、不进结算 —— 这不是第二套状态机：
 * 它只承载「systemPrompt + hooks + state」三样，用于让续跑也走宿主的投影/剥离/观测；
 * 任何回合语义（权限、工具、结算、UI 推送）都不得挂到这里。
 */
export interface HarnessStructuralHost {
  systemPrompt?: string
  hooks?: HarnessRunHooks
  state: HarnessRunState
}

/** 宿主注入的 UI/统计消费点；事件在 Harness 交付线上按序 await。 */
export interface HarnessRunSinks {
  onTurnStart?: () => void
  /** 流式正文增量（只含 text_delta 且已去掉 RUNTIME_DATA 起止后的内容）；只更新瞬时展示。 */
  onAssistantDelta?: (delta: string) => void
  /** 当前 assistant 消息的流式缓冲结束（message_end / 运行收尾）；瞬时展示据此清空。 */
  onAssistantStreamEnd?: () => void
  onAssistantMessage?: (message: AssistantMessage, entryId: string | undefined) => void | Promise<void>
  onToolResultMessage?: (message: ToolResultMessage, entryId: string | undefined) => void | Promise<void>
  onToolEnd?: (toolName: string, isError: boolean) => void
  onUsage?: (row: UsageRow, totals: Usage) => void | Promise<void>
}

export interface HarnessRunSpec {
  requestId: string
  turnId?: string
  model: PiModel
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  tools: readonly ToolDef[]
  toolRun: HarnessToolRun
  /** 多条消息用于「停止后继续」：把取回的暂停输入按原顺序一次性投递（身份不合并）。 */
  prompt: string | AgentMessage | AgentMessage[]
  timeoutMs: number
  hooks: HarnessRunHooks
  sinks?: HarnessRunSinks
  state: HarnessRunState
}

export type HarnessRunStatus =
  | "completed" | "failed" | "aborted" | "busy" | "invalid" | "closed" | "interrupted" | "faulted"

export interface HarnessRunResult {
  status: HarnessRunStatus
  record?: OperationResultRecord
  error?: string
  /** 由本槽的超时中止（区别于宿主显式停止）。 */
  timedOut: boolean
  /** 本次运行的停止来源；未停止时为 undefined。宿主据此区分用户主动停止与超时/释放。 */
  abortReason?: HarnessAbortReason
  /** 未消费的 steer/followUp：入参 requestId 与正文由宿主决定重新排队或丢弃。 */
  undelivered: string[]
  state: HarnessRunState
}

export type HarnessSlotState = "closed" | "idle" | "running" | "interrupted" | "faulted"
export type HarnessDeliveryPhase = "streaming" | "settling"
/**
 * 投递回执：steered/followup 会进入本次运行；deferred（nextRun）只随下一次运行消费。
 * 值与旧 QueueAckState 的 steered/followup 文案保持一致，UI 不需第二套词汇。
 */
export type HarnessDeliveryReceipt = "steered" | "followup" | "deferred"

export interface HarnessSlotSnapshot {
  sessionId: string
  generation: number
  state: HarnessSlotState
  hasLane: boolean
  deliveryPhase?: HarnessDeliveryPhase
  requestId?: string
  turnId?: string
  operationId?: string
  /** 已提交的压缩次数：请求视图的换代身份（旧 contextEpoch 的等价物，用于快照/审计）。 */
  contextEpoch: number
  /** lane 持久 inbox 的待消费项（真相源在会话文件；这里是最近一次 queue_update 的只读快照）。 */
  queued: HarnessQueuedItem[]
  interrupted?: { operationId: string; kind: "run" | "compaction" | "navigation"; startedAt: number; aborting: boolean }
}

/** 排队项的只读视图：UI 展示与撤回都以它为准，不在前端另存一份队列状态。 */
export interface HarnessQueuedItem {
  entryId: string
  kind: "steer" | "followUp" | "nextRun"
  text: string
  /** 投递时写入的宿主 requestId（`deskpetEventId` 的主键部分）；证据链按它关联输入。 */
  requestId?: string
}

/** lane 持久 inbox 的排队计数（按 kind）：压缩拒绝、排队视图共用同一明细。 */
export interface HarnessQueueCounts {
  steer: number
  followUp: number
  nextRun: number
}

/** 手动压缩（/compact）的终态；文案由调用方决定。 */
export interface HarnessCompactOutcome {
  status: "completed" | "declined" | "nothing" | "busy" | "pending" | "closed" | "failed"
  error?: string
  /** status=pending 时的排队明细：压缩续跑可能消费 lane inbox，不能只报「有排队」。 */
  queued?: HarnessQueueCounts
}

/** 单项撤回结果：与 lane.cancelQueued 的 kind 同名，unavailable 表示槽/通道不可用。 */
export type HarnessCancelQueuedKind = "cancelled" | "already_consumed" | "not_found" | "unavailable"

interface ActiveRun {
  spec: HarnessRunSpec
  operationId?: string
  deliveryPhase?: HarnessDeliveryPhase
}

const ABORT_REASON_TIMEOUT = "timeout"
const ABORT_REASON_USER = "user"
const ABORT_REASON_DISPOSE = "dispose"
export type HarnessAbortReason = typeof ABORT_REASON_TIMEOUT | typeof ABORT_REASON_USER | typeof ABORT_REASON_DISPOSE

/**
 * 单会话运行槽。同一时刻只允许一个 run；所有 lane 操作串行经过 Harness 的持久操作记录。
 * 打开失败的槽不静默重建（§8.7.4）：fault 后该会话停止驱动，需宿主显式处理。
 */
/**
 * 压缩设置：阈值与保留窗口都由本仓预算换算到上游估算口径，绝不照搬 Pi 的 16k/20k 默认值
 * （上游默认值只适配它自己的默认窗口）。
 *
 * Harness 的 `shouldCompact` 比的是它自己的 `estimateContextTokens`：有 provider usage 时
 * 前缀按真实 usage 计，本仓预算同样以真实 token 为目标口径，因此换算后阈值正好落在
 * normalInputTarget，保留窗口回到 normalInputTarget 的 40%（换算规则见
 * toHarnessEstimateTokens，不要再按 chars/4 反推因子）。
 */
export function compactionSettingsFor(window: number, maxOutput?: number): CompactionSettings {
  const budget = contextBudget(window, maxOutput)
  return {
    enabled: true,
    reserveTokens: Math.max(1, budget.window - toHarnessEstimateTokens(budget.normalInputTarget)),
    keepRecentTokens: toHarnessEstimateTokens(budget.keepRecentTokens),
  }
}

export class HarnessSlot {
  readonly sessionId: string
  generation = 0
  private state: HarnessSlotState = "closed"
  private openPromise?: Promise<void>
  private session?: Session
  private harness?: AgentHarness<undefined>
  private lane?: AgentLane
  private unsubscribes: Array<() => void> = []
  private activeRun?: ActiveRun
  private lastRunResult?: OperationResultRecord
  private interruptedInfo?: { operationId: string; kind: "run" | "compaction" | "navigation"; startedAt: number; aborting: boolean }
  private timer?: ReturnType<typeof setTimeout>
  private abortReason?: HarnessAbortReason
  private drainGeneration = 0
  private drainPromise?: Promise<void>
  private deliveryPhase?: HarnessDeliveryPhase
  private runIdentity?: { requestId: string; turnId?: string }
  /**
   * 结构操作（手动压缩与它的续跑）的宿主面；只在 `compact()` 的驱动窗口内存在。
   * 它不承载回合语义：权限/工具/结算/UI 推送一律不挂这里（见 HarnessStructuralHost）。
   */
  private structuralHost?: HarnessStructuralHost
  /** 最近一次冻结回合的 systemPrompt：结构操作缺宿主时也绝不用空串充当人格前缀。 */
  private lastSystemPrompt?: string
  /** 压缩操作进行中：期间的 usage 属于一次性摘要调用，不进主回合统计。 */
  private compactionActive = false
  /** 已提交的压缩次数（compaction entry 数 + 本次会话内新增）。 */
  private compactionEpoch = 0
  /** 已下发的压缩阈值去重键（reserveTokens:keepRecentTokens）。 */
  private compactionSettingsKey?: string
  /** 已下发的队列批量策略：按运行生效，运行开始前与配置对齐。 */
  private steeringMode: "all" | "one-at-a-time" = "all"
  private followUpMode: "all" | "one-at-a-time" = "one-at-a-time"
  /** 已下发给许可所有者的共享读上限；未下发过时为 undefined，首次 run 必定对齐。 */
  private toolPermitLimit?: number
  /** 正在流式输出的 assistant 消息是否已经产生过展示增量。 */
  private streamActive = false
  /** 最近一次 queue_update 的 lane 队列快照：用于核对「已投递但未消费」的输入。 */
  private pendingQueues: LaneQueuedItem[] = []
  /** requestId → lane inbox entryId：重投递前用它撤销仍未消费的项，保证用户正文恰好一次。 */
  private readonly pendingDeliveryEntries = new Map<string, string>()
  /** 停止归还的未消费消息：在回合收尾点（或没有在飞 run 时）以 nextRun 重新入队。 */
  private readonly requeuePending: AgentMessage[] = []
  /** 审计条目排队区：hook / 事件处理器只入队，drive 结束后由宿主写入（见 queueAuditEntry）。 */
  private readonly auditPending: Array<{ customType: string; data: JsonValue }> = []
  /**
   * 子运行归属（取消域级联）：子槽（计划步骤的子代理）不注册在会话表里，
   * 父槽是它们唯一的可达句柄 —— 父槽 abort/close/dispose 必须级联到它们。
   */
  private readonly children = new Set<HarnessSlot>()

  /** transient 槽使用内存会话（子代理/一次性驱动），不写聊天目录。 */
  constructor(sessionId: string, options: { transient?: boolean; generationSeed?: number } = {}) {
    this.sessionId = sessionId
    this.transient = options.transient === true
    // 注册表分配代际起点：槽被释放重建后代际不回退，旧 cleanup 不会命中新 run（ABA）。
    this.generation = options.generationSeed ?? 0
  }

  private readonly transient: boolean

  // ── 生命周期 ──

  /**
   * 打开/创建会话并附着 Harness；幂等。fault 后不静默重建（§8.7.4）。
   * 并发调用（预检期投递与回合启动）共享同一个在飞 Promise：同一会话不能附着两个 Harness。
   */
  async open(): Promise<void> {
    if (this.harness || this.state === "faulted") return
    this.openPromise ??= this.openOnce().finally(() => { this.openPromise = undefined })
    await this.openPromise
  }

  private async openOnce(): Promise<void> {
    if (this.harness || this.state === "faulted") return
    const ctx = TODO_CONTEXT
    if (this.transient) {
      const repo = new MemorySessionRepo()
      this.session = await repo.create({}, ctx)
    } else {
      // 会话句柄统一经 session 层缓存（同一 JSONL 只允许一个打开句柄，禁止并起第二个仓库实例）。
      const { acquirePiSession, getPiSessionRepo } = await import("@/services/session/repo")
      try {
        this.session = await acquirePiSession(this.sessionId)
      } catch (error) {
        log.warn("会话层没有该会话句柄，按 id 补建:", this.sessionId, formatError(error))
        this.session = await (await getPiSessionRepo()).create({ id: this.sessionId }, ctx)
      }
    }
    const compaction = this.compactionSettings(resolvePiTurnModel())
    this.steeringMode = conversationConfig.steeringMode
    this.followUpMode = conversationConfig.followUpMode
    const created = await AgentHarness.create({
      session: this.session,
      models: createHarnessModels({
        // 结构操作没有冻结的回合模型：取当前解析值（它与续跑发起时的设置一致）。
        model: () => this.activeRun?.spec.model ?? resolvePiTurnModel(),
        takeBlockedError: () => {
          const state = this.hostSpec().state
          const blocked = state.contextError
          state.contextError = undefined
          if (blocked instanceof ContextBudgetError) state.lastBudgetError = blocked.message
          return blocked instanceof Error ? blocked : undefined
        },
      }),
      model: resolvePiTurnModel(),
      tools: [],
      // 阈值/手动/溢出调度与一次性溢出恢复交给 Harness（§7）；阈值由现有预算推导（见 compactionSettings）。
      compaction: compaction.settings,
      // 由执行许可保证「纯读并行、效果互斥」：批次内调用可并发派发，
      // 真正执行前各自借用额度（Rust 应用级所有者），写类与其它执行互斥。
      toolExecution: "parallel",
      // 队列批量策略来自配置、按运行冻结（§3.1）：一条消息的身份不因批量而合并，
      // 下一个 run 开始前由 syncQueueModes 与当前配置对齐。
      steeringMode: this.steeringMode,
      followUpMode: this.followUpMode,
      // 空串会让模型丢掉人格与协议前缀，绝不能作兜底：回合 → 最近一次冻结 → 结构操作宿主，
      // 三者都没有才是真的缺少 prompt（如实报错，不上报一个「没人格」的请求）。
      systemPrompt: () => {
        const prompt = this.activeRun?.spec.systemPrompt ?? this.lastSystemPrompt ?? this.structuralHost?.systemPrompt
        if (prompt === undefined) {
          log.error("手动压缩缺少可用 systemPrompt:", this.sessionId)
          return ""
        }
        return prompt
      },
      retry: { enabled: loopConfig.maxRetry > 0, maxRetries: loopConfig.maxRetry, baseDelayMs: 1000 },
    }, ctx)
    this.harness = created.harness
    this.compactionSettingsKey = compaction.key
    this.compactionEpoch = await this.countCommittedCompactions()
    this.registerHooks()
    this.lane = await this.harness.lane(PI_LANE, ctx)
    this.subscribeEvents()
    if (created.open.length > 0) {
      // §8.7.3：createAgentHarness 只附着运行时；上次中断的操作默认暂停，由用户选择继续/丢弃。
      const open = created.open[0]!
      this.interruptedInfo = { operationId: open.operationId, kind: open.kind, startedAt: open.startedAt, aborting: open.aborting === true }
      if (this.state !== "running") this.state = "interrupted"
      this.markInterrupted(true)
      log.warn("检测到上次运行中断，等待用户选择继续或丢弃:", { sessionId: this.sessionId, ...this.interruptedInfo })
      return
    }
    // 不覆盖先 begin 后懒打开的 running 状态：代际所有权在 begin 时已确定。
    if (this.state !== "running") this.state = "idle"
  }

  private isUsable(): boolean {
    return this.harness !== undefined && this.state !== "closed" && this.state !== "faulted"
  }

  /**
   * 当前宿主面：有冻结回合时是它的 systemPrompt/hooks/state；否则是结构操作宿主
   * （手动压缩窗口内下发）。两者都没有时只有一份空 state —— 钩子缺失由调用点
   * 各自判定（before_tool 走 fail-closed），不在这里兜底成「有宿主」。
   */
  private hostSpec(): HarnessStructuralHost {
    const run = this.activeRun
    if (run) return { systemPrompt: run.spec.systemPrompt, hooks: run.spec.hooks, state: run.spec.state }
    return this.structuralHost ?? { state: createHarnessRunState() }
  }

  /**
   * 宿主镜像里是否还有未消费的用户消息（steer/followUp/nextRun）：**只读视图专用**
   * （槽被释放重建后镜像从空开始）。`compact()` 的准入改读 lane 真相（laneQueueCounts），
   * 不用它放行 —— 镜像为空不等于队列为空。
   */
  private hasQueuedMessages(): boolean {
    return this.pendingQueues.some(item => item.type === "message"
      && (item.kind === "steer" || item.kind === "followUp" || item.kind === "nextRun"))
  }

  /** 排队计数（按 kind）：压缩续跑会经 accept 消费整个 inbox，三类都要报出来。 */
  private queuedCounts(): HarnessQueueCounts {
    const count = (kind: "steer" | "followUp" | "nextRun") =>
      this.pendingQueues.filter(item => item.type === "message" && item.kind === kind).length
    return { steer: count("steer"), followUp: count("followUp"), nextRun: count("nextRun") }
  }

  /** 排队项只读视图：正文取排队消息本身，不是第二份状态。 */
  private queuedItems(): HarnessQueuedItem[] {
    return this.pendingQueues.flatMap(item => {
      if (item.type !== "message" || item.kind === "write") return []
      const requestId = messageRequestId(item.message as { deskpetEventId?: unknown })
      return [{
        entryId: item.entryId,
        kind: item.kind,
        text: queuedMessageText(item.message),
        ...(requestId ? { requestId } : {}),
      }]
    })
  }

  /**
   * lane 真相的排队计数；读失败返回 undefined（fail-closed，不上报空队列）。
   *
   * 宿主的 pendingQueues 只是最近一次 queue_update 的镜像：槽被释放重建后它从空开始，
   * 不能拿它判准入（会把「有排队项」当「没排队」）。
   */
  private async laneQueueCounts(): Promise<HarnessQueueCounts | undefined> {
    const queues = await this.readQueuesOnce()
    if (queues === undefined) return undefined
    const count = (kind: "steer" | "followUp" | "nextRun") =>
      queues.filter(item => item.type === "message" && item.kind === kind).length
    return { steer: count("steer"), followUp: count("followUp"), nextRun: count("nextRun") }
  }

  /** 一次性读取 lane 队列初值（watch → 读 snapshot.queues → 立即 unsubscribe）。 */
  private async readQueuesOnce(): Promise<LaneQueuedItem[] | undefined> {
    if (!this.lane) return undefined
    try {
      const handle = await this.lane.watch(TODO_CONTEXT)
      try {
        return handle.snapshot.queues
      } finally {
        // 只借初值：watch 句柄不能留在槽上（它是长期的转录订阅，读一次就还）。
        handle.unsubscribe()
      }
    } catch (error) {
      log.error("lane 队列读取失败:", this.sessionId, formatError(error))
      return undefined
    }
  }

  /** 压缩阈值由现有预算推导（§7）：窗口 − 正常输入目标 = 输出预留 + 协议开销 + 压缩余量。 */
  private compactionSettings(model: PiModel): { settings: CompactionSettings; key: string } {
    const settings = compactionSettingsFor(model.contextWindow, model.maxTokens)
    return { settings, key: `${settings.reserveTokens}:${settings.keepRecentTokens}` }
  }

  /** 模型窗口可能随设置变化：窗口改变时把新阈值下发给 Harness。 */
  private async syncCompactionSettings(model: PiModel): Promise<void> {
    if (!this.harness) return
    const { settings, key } = this.compactionSettings(model)
    if (key === this.compactionSettingsKey) return
    this.compactionSettingsKey = key
    await this.harness.setCompactionSettings(settings, TODO_CONTEXT)
  }

  /**
   * 队列批量策略按运行生效（§3.1）：只在下一次 run 开始前对齐，运行期间不改变
   * 已冻结的批量行为。改回默认只需改配置，不在这里重排已排队项。
   */
  private async syncQueueModes(): Promise<void> {
    if (!this.harness) return
    const steering = conversationConfig.steeringMode
    const followUp = conversationConfig.followUpMode
    if (steering === this.steeringMode && followUp === this.followUpMode) return
    this.steeringMode = steering
    this.followUpMode = followUp
    await this.harness.setSteeringMode(steering, TODO_CONTEXT)
    await this.harness.setFollowUpMode(followUp, TODO_CONTEXT)
  }

  /**
   * 共享读上限（`ai.loop.maxParallelTools`）同样按运行生效：下一次 run 开始前把当前配置
   * 下发给 Rust 许可所有者，运行期间不撤销已借出的额度。所有者始终是权威，槽只记下发值
   * 避免重复 IPC；下发失败沿用所有者当前上限，不因调优失败让整个 run 起不来。
   */
  private async syncToolPermitLimit(): Promise<void> {
    const limit = loopConfig.maxParallelTools
    if (limit === this.toolPermitLimit) return
    try {
      this.toolPermitLimit = await setToolPermitLimit(limit)
    } catch (error) {
      log.warn("共享读上限下发失败，沿用许可所有者当前上限:", formatError(error))
    }
  }

  /** 会话文件里已提交的压缩次数：请求视图换代身份（旧 contextEpoch 的等价物）。 */
  private async countCommittedCompactions(): Promise<number> {
    if (!this.session) return 0
    try {
      const entries = await this.session.findEntries({ order: "asc" }, TODO_CONTEXT)
      return entries.filter(entry => entry.type === "compaction").length
    } catch (error) {
      log.warn("压缩次数统计失败，按 0 计:", this.sessionId, formatError(error))
      return 0
    }
  }

  /** 同步「上次运行中断」状态到会话管理（UI 标签渲染依赖它）。 */
  private markInterrupted(interrupted: boolean): void {
    if (this.transient || !this.sessionId) return
    void import("@/services/session/manager")
      .then(({ setSessionInterrupted }) => setSessionInterrupted(this.sessionId, interrupted))
      .catch(error => log.warn("中断标记写入失败:", this.sessionId, formatError(error)))
  }

  /**
   * 子运行归属：注册后父槽的 abort/close 会级联到子槽。返回 detach 函数。
   * 子槽是父槽取消域的一部分 —— 只挂在会话表上的注册表索引不到它。
   */
  attachChild(child: HarnessSlot): () => void {
    this.children.add(child)
    return () => { this.children.delete(child) }
  }

  /** 只读的子槽快照：`abortAndWaitAll`/`dispose` 需要等它们也收尾。 */
  childSlots(): HarnessSlot[] {
    return [...this.children]
  }

  /** 显式关闭槽：关闭 Harness 与事件订阅，释放会话句柄。 */
  async close(): Promise<void> {
    // 取消域级联（子先父后）：父句柄先释放会让子运行在已关闭的会话上收尾。
    const children = [...this.children]
    const closed = await Promise.allSettled(children.map(child => child.close()))
    closed.forEach((result, index) => {
      if (result.status === "rejected") log.warn("子运行关闭失败:", { sessionId: children[index]!.sessionId }, formatError(result.reason))
    })
    if (!this.harness) {
      this.state = "closed"
      return
    }
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.clearTimer()
    const harness = this.harness
    this.harness = undefined
    this.lane = undefined
    this.session = undefined
    this.state = "closed"
    try {
      // harness.close 会关闭会话句柄；随后让 session 层缓存同步释放，避免留下已关闭句柄。
      await harness.close(TODO_CONTEXT)
    } catch (error) {
      log.warn("Harness 关闭失败", formatError(error))
    }
    if (!this.transient) {
      try {
        const { releasePiSession } = await import("@/services/session/repo")
        await releasePiSession(this.sessionId)
      } catch (error) {
        log.warn("会话句柄释放失败:", this.sessionId, formatError(error))
      }
    }
  }

  // ── 代际与状态（宿主运行所有权的唯一入口） ──

  begin(identity?: { requestId: string; turnId?: string }): number | undefined {
    // "closed" 是懒打开（首次回合）的初始状态，按空闲处理；真正失效只认 running/faulted。
    if (this.state === "running" || this.state === "faulted") return undefined
    const generation = ++this.generation
    this.state = "running"
    this.deliveryPhase = "streaming"
    this.runIdentity = identity
    this.abortReason = undefined
    return generation
  }

  /** 绑定本回合的 requestId/turnId（供快照与审计读取）。 */
  bindRun(generation: number, identity: { requestId: string; turnId?: string }): boolean {
    if (this.generation !== generation || this.state !== "running") return false
    this.runIdentity = identity
    return true
  }

  end(generation: number): boolean {
    if (this.generation !== generation) return false
    if (this.state === "running") this.state = this.interruptedInfo ? "interrupted" : this.harness ? "idle" : "closed"
    this.deliveryPhase = undefined
    return true
  }

  isRunning(): boolean {
    return this.state === "running"
  }

  /**
   * 槽的 lane 上是否还有未结算的操作（宿主回合之外的压缩、导航等结构操作）。
   *
   * `isRunning()` 只表示宿主回合所有权：手动压缩不 `begin`，压缩期间槽仍判空闲，
   * 单看它会把「压缩在飞」当「空闲」放行新输入。准入判定要用本方法；注册表的
   * `HarnessSlots.hasOpenOperation(sessionId)` 同时含 `isRunning`（唯一的「忙」定义）。
   *
   * 读失败 fail-closed：读不出 lane 真相时按「有操作」处理（宁可拒绝也不静默排队），
   * 并留下 warn —— 回退只需把 catch 分支改回 `return this.state === "running"`。
   */
  async hasOpenOperation(): Promise<boolean> {
    if (!this.lane) return this.state === "running"
    try {
      const info = await this.lane.inspectExecution(TODO_CONTEXT)
      return info.current !== null
    } catch (error) {
      log.warn("lane 操作状态读取失败，按有操作处理:", this.sessionId, formatError(error))
      return true
    }
  }

  /** 当前代际仍是所有者（未取消、未失效）。 */
  isCurrent(generation: number): boolean {
    return this.generation === generation && this.state === "running" && this.abortReason === undefined
  }

  deliveryMode(): "steer" | "followup" | undefined {
    if (this.state !== "running" || !this.lane) return undefined
    return this.deliveryPhase === "settling" ? "followup" : "steer"
  }

  async steer(text: string, deskpetEventId?: string, kindOverride?: "steer" | "followUp" | "nextRun"): Promise<HarnessDeliveryReceipt | undefined> {
    // 不要求运行已进入驱动：预检阶段的投递也进入 lane 持久 inbox（先 open 再投递），
    // 由本次或下一次运行消费；宿主不再保留自己的队列副本。
    if (this.state !== "running") return undefined
    if (!this.lane) {
      try {
        await this.open()
      } catch (error) {
        log.warn("投递前打开会话失败:", this.sessionId, formatError(error))
        return undefined
      }
    }
    if (this.state !== "running" || !this.lane) return undefined
    const kind = kindOverride ?? (this.deliveryPhase === "settling" ? "followUp" : "steer")
    const message = { role: "user" as const, content: text, timestamp: Date.now(), ...(deskpetEventId ? { deskpetEventId } : {}) }
    const result = kind === "steer"
      ? await this.lane.steer(message, undefined, TODO_CONTEXT)
      : kind === "followUp"
        ? await this.lane.followUp(message, undefined, TODO_CONTEXT)
        : await this.lane.nextRun(message, undefined, TODO_CONTEXT)
    if (!result.ok) {
      log.warn("投递补充消息失败:", { kind, error: result.error._tag })
      return undefined
    }
    // nextRun 不进入本次运行：宿主按「已排队，下一次运行处理」上报。
    return kind === "steer" ? "steered" : kind === "followUp" ? "followup" : "deferred"
  }

  snapshot(): HarnessSlotSnapshot {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      state: this.state,
      hasLane: this.lane !== undefined,
      deliveryPhase: this.deliveryPhase,
      requestId: this.runIdentity?.requestId,
      turnId: this.runIdentity?.turnId,
      operationId: this.activeRun?.operationId,
      contextEpoch: this.compactionEpoch,
      queued: this.queuedItems(),
      interrupted: this.interruptedInfo,
    }
  }

  // ── 排队单项撤回（PI-1） ──

  /**
   * 撤回一条仍在 lane 持久 inbox、尚未被消费的排队项。
   * already_consumed 表示正文已成为会话条目：不能报告撤回成功，也不能把它塞回队列。
   */
  async cancelQueued(entryId: string): Promise<HarnessCancelQueuedKind> {
    if (!this.lane) return "unavailable"
    let result: Awaited<ReturnType<AgentLane["cancelQueued"]>>
    try {
      result = await this.lane.cancelQueued(entryId, TODO_CONTEXT)
    } catch (error) {
      log.warn("撤回排队项失败:", { sessionId: this.sessionId, entryId }, formatError(error))
      return "unavailable"
    }
    if (!result.ok) return "unavailable"
    // 撤回成功的项不能再留在「待重投递」映射里，否则下一次重投递会拿着过期 entryId 去撤销。
    for (const [requestId, id] of this.pendingDeliveryEntries) {
      if (id === entryId) this.pendingDeliveryEntries.delete(requestId)
    }
    return result.value.kind
  }

  /**
   * 取出全部仍留在 lane inbox 的暂停项（nextRun）并撤回，返回原消息对象。
   * 供「停止后继续」重投递：撤回失败（已被消费 / 已不在）的项直接跳过 ——
   * 已进入正文的消息不能再投一次，宁可少投也不能重复追加用户正文。
   *
   * 注意这里只取出不投递：投递由宿主的下一回合承担，因此两者之间进程被杀会丢这几条
   * （已在 §1.1 记为实施边界）；投递未获接受时宿主按 nextRun 原样放回。
   */
  async takePausedMessages(): Promise<AgentMessage[]> {
    if (!this.lane) return []
    const paused = this.pendingQueues.flatMap(item =>
      item.type === "message" && item.kind === "nextRun" ? [{ entryId: item.entryId, message: item.message }] : [])
    const taken: AgentMessage[] = []
    for (const item of paused) {
      if (await this.cancelQueued(item.entryId) === "cancelled") taken.push(item.message)
    }
    return taken
  }

  /** 把取出的暂停消息按 nextRun 放回：投递未获接受时的回滚，持久且不自动继续。 */
  async requeuePausedMessages(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0 || !this.lane) return
    this.requeuePending.push(...messages)
    await this.flushRequeueQueue()
  }

  // ── 崩溃恢复入口（§8.7.3） ──

  getInterrupted(): HarnessSlotSnapshot["interrupted"] {
    return this.interruptedInfo
  }

  /** 继续：驱动上次未完成的操作用户可见的「继续」入口。 */
  async resumeInterrupted(spec: HarnessRunSpec): Promise<HarnessRunResult> {
    await this.open()
    if (!this.interruptedInfo || !this.lane) {
      return { status: "invalid", timedOut: false, undelivered: [], state: spec.state, error: "没有可继续的中断运行" }
    }
    if (!this.isRunning()) this.begin({ requestId: spec.requestId, turnId: spec.turnId })
    return this.execute(spec, "resume")
  }

  /** 丢弃：不重放未知副作用，按 aborted 收尾并归还未消费消息（输入仍以 nextRun 保留）。 */
  async discardInterrupted(): Promise<{ steer: string[]; followUp: string[] } | undefined> {
    await this.open()
    if (!this.interruptedInfo || !this.lane) return undefined
    const aborted = await this.lane.abort(TODO_CONTEXT)
    if (!aborted.ok) {
      // 丢弃失败必须保留中断状态：否则 UI 报「已丢弃」，实际运行从未停止、输入去向成谜。
      log.warn("丢弃中断运行失败，保留中断状态:", { sessionId: this.sessionId, tag: aborted.error._tag })
      return undefined
    }
    this.interruptedInfo = undefined
    this.state = "idle"
    this.markInterrupted(false)
    this.requeuePending.push(...aborted.value.steer, ...aborted.value.followUp)
    await this.flushRequeueQueue()
    return {
      steer: collectRequestIds(aborted.value.steer),
      followUp: collectRequestIds(aborted.value.followUp),
    }
  }

  // ── 手动压缩（/compact） ──

  /**
   * 驱动一次 `manual` 压缩：切点、会话提交与持久化都由 Harness 承担（§7/§8.5），
   * 摘要生成与续跑的投影/剥离由调用方经 host.hooks 提供。运行中不抢跑（LaneBusy 同义返回 busy）。
   *
   * 注意：压缩完成后 Harness 会再驱动一次续跑消费 lane 持久 inbox（nextRun 也在内）。
   * 那段续跑没有回合身份，但必须走宿主的 systemPrompt/投影/剥离，所以准入读 lane 真相：
   * 有排队项就拒绝并按 kind 报明细，由用户决定撤回还是等处理完（镜像为空不作为放行理由）。
   */
  async compact(
    host: Omit<HarnessStructuralHost, "state"> & { state?: HarnessRunState },
    options: { customInstructions?: string } = {},
  ): Promise<HarnessCompactOutcome> {
    await this.open()
    if (!this.isUsable() || !this.lane) return { status: "closed" }
    if (this.isRunning()) return { status: "busy" }
    const live = await this.laneQueueCounts()
    if (live === undefined) log.error("队列真相读取失败，按存在排队项拒绝手动压缩:", this.sessionId)
    const counts = live ?? this.queuedCounts()
    if (live === undefined || counts.steer + counts.followUp + counts.nextRun > 0) return { status: "pending", queued: counts }
    this.structuralHost = { systemPrompt: host.systemPrompt, hooks: host.hooks, state: host.state ?? createHarnessRunState() }
    try {
      const result = await this.lane.compact(
        options.customInstructions === undefined ? undefined : { customInstructions: options.customInstructions },
        TODO_CONTEXT,
      )
      if (!result.ok) {
        switch (result.error._tag) {
          case "LaneBusy": return { status: "busy" }
          case "NothingToCompact": return { status: "nothing" }
          case "Closed": return { status: "closed" }
        }
        return { status: "failed", error: "压缩未被接受" }
      }
      const record = result.value.compaction
      if (record.status === "declined") return { status: "declined" }
      if (record.status === "failed") return { status: "failed", error: record.error?.message ?? "压缩失败" }
      if (record.status === "aborted") return { status: "failed", error: record.error?.message ?? "压缩已取消" }
      const follow = result.value.run
      if (follow) {
        // 续跑没有宿主回合：它若已结算，压缩结果就不可能进入任何回合结算与 UI，
        // 不能报「压缩完成」。挂起的续跑更糟（不结算的操作会让后续准入恒判忙）：显式结算掉。
        const suspended = "status" in follow && follow.status === "suspended"
        if (suspended) {
          await this.lane.abort(TODO_CONTEXT)
          log.error("压缩续跑返回了不支持的延迟响应:", { sessionId: this.sessionId, operationId: follow.operationId })
          return { status: "failed", error: "压缩续跑返回了不支持的延迟响应" }
        }
        this.queueAuditEntry(COMPACTION_CONTINUATION_ENTRY, {
          sessionId: this.sessionId,
          operationId: follow.operationId,
          status: follow.status,
        })
        log.error("压缩续跑在无宿主回合的情况下已被结算:", { sessionId: this.sessionId, operationId: follow.operationId })
        return { status: "failed", error: "压缩续跑在无宿主回合的情况下已被结算，压缩结果未纳入回合结算" }
      }
      return { status: "completed" }
    } catch (error) {
      return { status: "failed", error: formatError(error) }
    } finally {
      this.structuralHost = undefined
    }
  }

  // ── 运行 ──

  /** 驱动一个回合直到 run_end；调用方已 begin，槽自身兜底登记代际。 */
  async run(spec: HarnessRunSpec): Promise<HarnessRunResult> {
    await this.open()
    if (this.interruptedInfo) {
      // §8.7.3：默认暂停并暴露状态；不由宿主动作触发时绝不自动重放。
      return { status: "interrupted", timedOut: false, undelivered: [], state: spec.state, error: "上次运行中断，等待选择继续或丢弃" }
    }
    if (this.state === "faulted") {
      return { status: "faulted", timedOut: false, undelivered: [], state: spec.state, error: "会话运行已故障，需宿主显式处理" }
    }
    if (!this.isUsable() || !this.lane) {
      return { status: "closed", timedOut: false, undelivered: [], state: spec.state }
    }
    if (!this.isRunning()) {
      const generation = this.begin({ requestId: spec.requestId, turnId: spec.turnId })
      if (generation === undefined) return { status: "busy", timedOut: false, undelivered: [], state: spec.state }
    }
    return this.execute(spec, "prompt")
  }

  /** 宿主显式停止：取消当前操作并归还未消费消息。 */
  async abort(reason: HarnessAbortReason = ABORT_REASON_USER): Promise<{ steer: string[]; followUp: string[] } | undefined> {
    const aborted = await this.abortSelf(reason)
    // 取消域级联：父槽停止后子运行不能继续跑（计划步骤的子代理就挂在父槽下）。
    // 一条失败不阻断其余，也仍然如实返回父槽自己的归还清单。
    const children = [...this.children]
    const settled = await Promise.allSettled(children.map(child => child.abort(reason)))
    settled.forEach((result, index) => {
      if (result.status === "rejected") log.warn("子运行停止失败:", { sessionId: children[index]!.sessionId }, formatError(result.reason))
    })
    return aborted
  }

  /** 停止自身 lane 上的在飞操作；返回归还清单（无操作或未被接受时为 undefined）。 */
  private async abortSelf(reason: HarnessAbortReason): Promise<{ steer: string[]; followUp: string[] } | undefined> {
    if (!this.lane) return undefined
    const aborted = await this.lane.abort(TODO_CONTEXT)
    if (!aborted.ok) {
      // 不能伪装成「停止成功但无归还项」：abort 未被接受时中断状态与归还列表都必须如实缺省。
      // 停止来源同样缺省 —— 先记 abortReason 再等结果会把槽钉死在「非当前」（isCurrent 恒 false）。
      log.warn("停止运行未被接受:", { sessionId: this.sessionId, reason, error: formatError(aborted.error) })
      return undefined
    }
    // 停止被接受后才记来源：它是 execute() 收尾派生 timedOut 的依据（超时路径必然走到这里，
    // 且 lane.abort 的 awaited 返回先于运行收尾，赋值不会晚于那次读取）。
    this.abortReason = reason
    // 未消费的 steer/followUp 已被 lane 从 inbox 移出：以 nextRun 重新入队（随会话持久），
    // 保证「停止归还」不丢用户输入、也不自动继续执行（§3.3.5）。
    // 有在飞 run 时由回合收尾点统一入队：否则会被 collectPendingDelivery 的队列清理覆盖。
    this.requeuePending.push(...aborted.value.steer, ...aborted.value.followUp)
    if (!this.activeRun) await this.flushRequeueQueue()
    const undelivered = collectRequestIds(aborted.value.steer).concat(collectRequestIds(aborted.value.followUp))
    this.hostSpec().state.undelivered.push(...undelivered)
    log.info("运行已停止:", { sessionId: this.sessionId, reason, undelivered: undelivered.length })
    return { steer: collectRequestIds(aborted.value.steer), followUp: collectRequestIds(aborted.value.followUp) }
  }

  /**
   * 等待 lane 空闲。失败不静默：返回 false，让收尾调用方知道自己带着未结束的运行继续。
   * 这是唯一的「等运行结束」入口，吞掉失败会让删除会话/释放槽在未收尾时静默推进。
   */
  async waitForIdle(): Promise<boolean> {
    if (!this.lane) return true
    // 等待前先读一次 lane 真相：槽已无在飞运行、lane 却还有未结算操作时，等待必然挂死
    // （它没有任何在飞的东西会把它推到终态）。这里把它变成如实失败，不伪装成「等到了」。
    const info = await this.lane.inspectExecution(TODO_CONTEXT).catch(error => {
      log.warn("lane 操作状态读取失败，跳过挂死预检:", { sessionId: this.sessionId }, formatError(error))
      return undefined
    })
    if (info && info.current !== null && !this.activeRun) {
      log.error("lane 仍有未结算操作但槽已无在飞运行，等待会挂死:", { sessionId: this.sessionId, operationId: info.current.id })
      return false
    }
    try {
      await this.lane.waitForIdle(TODO_CONTEXT)
      return true
    } catch (error) {
      log.warn("等待运行空闲失败:", { sessionId: this.sessionId, reason: this.abortReason }, formatError(error))
      return false
    }
  }

  // ── 会话数据读取（供 deskpet 工具与恢复核对） ──

  /** 读取一条工具结果条目的全文；条目不是 toolResult 时返回 undefined。 */
  async readToolResult(entryId: string): Promise<string | undefined> {
    await this.open()
    if (!this.session) return undefined
    const entry = await this.session.getEntry(entryId, TODO_CONTEXT)
    if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined
    return contentText(entry.message.content)
  }

  /**
   * 排队一条审计条目（customType deskpet.*），等本回 drive 结束后由宿主统一写入。
   *
   * 不能在 Harness 的 hook / 事件处理器里直接 await lane 写入：那些回调运行在 drive 内，
   * drive 提交阶段持有 lane 命令锁，而 drive 又在 await 回调返回，会永久循环等待。
   * 也不能交给 lane.runWhenIdle 兜底：那条路径与 waitForIdle 争抢 idleOwner，会让回合收尾悬空。
   */
  queueAuditEntry(customType: string, data: JsonValue): void {
    this.auditPending.push({ customType, data })
    // 没有在飞回合（一次性调用、子代理快照）时 lane 本就空闲，立即写入。
    if (!this.isRunning()) void this.flushAuditQueue()
  }

  /** 写入排队的审计条目；只在 lane 空闲时调用。失败只记录，不影响回合结算。 */
  private async flushAuditQueue(): Promise<void> {
    const lane = this.lane
    if (!lane || !this.auditPending.length) return
    const queued = this.auditPending.splice(0, this.auditPending.length)
    for (const item of queued) {
      try {
        await lane.appendCustomEntry(item.customType, item.data, TODO_CONTEXT)
      } catch (error) {
        log.warn("审计条目写入失败:", item.customType, formatError(error))
      }
    }
  }

  /** 兜底回复也属于会话记录：追加为普通 assistant 条目。 */
  async appendAssistantMessage(text: string): Promise<void> {
    await this.open()
    if (!this.lane) return
    const model = resolvePiTurnModel()
    await this.lane.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_SLOT_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    }, TODO_CONTEXT)
  }

  getIdleResult(): OperationResultRecord | undefined {
    return this.lastRunResult
  }

  // ── 内部 ──

  private async execute(spec: HarnessRunSpec, kind: "prompt" | "resume"): Promise<HarnessRunResult> {
    const run: ActiveRun = { spec }
    this.activeRun = run
    // 冻结的 systemPrompt 留底：回合结束后若还有结构性驱动（续跑/恢复），人格前缀不因
    // activeRun 被清而丢成空串。
    this.lastSystemPrompt = spec.systemPrompt
    this.abortReason = undefined
    this.clearTimer()
    this.timer = setTimeout(() => { void this.abort(ABORT_REASON_TIMEOUT) }, Math.max(1, spec.timeoutMs))
    try {
      const tools = toAgentHarnessTools(spec.tools, spec.toolRun)
      await this.harness!.setTools(tools, TODO_CONTEXT)
      await this.syncCompactionSettings(spec.model)
      await this.syncQueueModes()
      await this.syncToolPermitLimit()
      await this.lane!.setModel({ provider: spec.model.provider, modelId: spec.model.id }, TODO_CONTEXT)
      await this.lane!.setThinkingLevel(toPiAgentThinkingLevel(spec.thinkingEffort), TODO_CONTEXT)
      await this.lane!.setActiveTools(spec.tools.map(tool => tool.name), TODO_CONTEXT)

      const result = kind === "resume"
        ? await this.lane!.resume(TODO_CONTEXT)
        : typeof spec.prompt === "string"
          ? await this.lane!.prompt(spec.prompt, undefined, TODO_CONTEXT)
          : await this.lane!.prompt(spec.prompt, TODO_CONTEXT)
      if (!result.ok) {
        const tag = result.error._tag
        log.warn("Harness 操作未被接受:", { sessionId: this.sessionId, tag })
        if (tag === "LaneBusy") return { status: "busy", timedOut: false, undelivered: [], state: spec.state }
        if (tag === "Closed") return { status: "closed", timedOut: false, undelivered: [], state: spec.state }
        return { status: "invalid", timedOut: false, undelivered: [], state: spec.state, error: tag }
      }
      if ("status" in result.value && result.value.status === "suspended") {
        // 不启用 deferred：出现挂起说明 Provider 返回了未预期的 handle，按失败暴露。
        // 但必须把这个操作结算掉：只返回 failed 会让槽背着永不结算的 lane 操作，
        // 后续 waitForIdle 挂死、下一次运行永远被判忙。取消是结算（HN-08）。
        log.error("运行返回了未预期的延迟响应，已取消该操作:", { sessionId: this.sessionId, operationId: result.value.operationId })
        const cancelled = await this.lane!.abort(TODO_CONTEXT)
        // 取消未被接受就还是没结算：如实留 warn（收尾的 waitForIdle 预检也会报同一件事）。
        if (!cancelled.ok) {
          log.warn("挂起操作的取消未被接受:", { sessionId: this.sessionId, operationId: result.value.operationId, error: formatError(cancelled.error) })
        }
        await this.collectPendingDelivery(run)
        return {
          status: "failed",
          timedOut: this.abortReason === ABORT_REASON_TIMEOUT,
          undelivered: [...spec.state.undelivered],
          state: spec.state,
          error: "Provider 返回了不支持的延迟响应（已取消并结算该操作）",
        }
      }
      const record = result.value as OperationResultRecord
      run.operationId = record.operationId
      this.lastRunResult = record
      await this.collectPendingDelivery(run)
      if (this.interruptedInfo?.operationId === record.operationId) {
        this.interruptedInfo = undefined
        this.markInterrupted(false)
        if (this.state === "interrupted") this.state = this.harness ? "idle" : "closed"
      }
      return {
        // run 的终态只有 completed/failed/aborted；declined 只出现在 compaction/navigation。
        status: record.status === "declined" ? "aborted" : record.status,
        record,
        ...(record.error ? { error: record.error.message } : {}),
        timedOut: this.abortReason === ABORT_REASON_TIMEOUT,
        ...(this.abortReason ? { abortReason: this.abortReason } : {}),
        undelivered: [...spec.state.undelivered],
        state: spec.state,
      }
    } catch (error) {
      // Harness 驱动拒绝（例如上下文取消）或槽自身异常：不静默重建，交给宿主结算。
      await this.collectPendingDelivery(run)
      return {
        status: "failed",
        timedOut: this.abortReason === ABORT_REASON_TIMEOUT,
        ...(this.abortReason ? { abortReason: this.abortReason } : {}),
        undelivered: [...spec.state.undelivered],
        state: spec.state,
        error: formatError(error),
      }
    } finally {
      this.clearTimer()
      // drive 已结束、lane 空闲，这里才是写审计条目的安全点（hook 内写入必死锁）。
      await this.flushAuditQueue()
      // 运行收尾（含中止/失败）必须结束瞬时流式展示，不能让半截正文悬在 UI 上。
      this.endAssistantStream()
      this.activeRun = undefined
    }
  }

  /**
   * 回合结束后仍留在 lane inbox 的 steer/followUp 属于「已投递未消费」：
   * 记录 requestId 供宿主上报（§3.2 证据链），随后把停止归还的消息重新入队。
   */
  private async collectPendingDelivery(run: ActiveRun): Promise<void> {
    for (const item of this.pendingQueues) {
      if (item.type !== "message" || (item.kind !== "steer" && item.kind !== "followUp")) continue
      const eventId = (item.message as { deskpetEventId?: string }).deskpetEventId
      if (typeof eventId !== "string") continue
      const requestId = eventId.replace(/:user$/, "")
      if (!run.spec.state.undelivered.includes(requestId)) run.spec.state.undelivered.push(requestId)
      this.pendingDeliveryEntries.set(requestId, item.entryId)
    }
    // 不清空宿主镜像：lane 持久 inbox 里可能仍有本次运行不消费的项（nextRun 只留给下一次运行），
    // 清空会让 snapshot().queued 与持久真相源分叉。镜像只由 queue_update 事件更新。
    await this.flushRequeueQueue()
  }

  /** 把停止归还未消费的消息以 nextRun 重新入队（持久、消费即移出、不自动继续）。 */
  private async flushRequeueQueue(): Promise<void> {
    const pending = this.requeuePending.splice(0)
    if (pending.length === 0 || !this.lane) return
    let failed = 0
    for (const message of pending) {
      const result = await this.lane.nextRun(message, undefined, TODO_CONTEXT).catch(() => undefined)
      if (!result || !result.ok) failed++
    }
    if (failed > 0) log.warn("停止归还未消费消息失败:", { sessionId: this.sessionId, total: pending.length, failed })
  }

  /**
   * 撤销尚未被消费的投递（宿主按 deferred 重投递前调用）。
   * 返回 true 表示 lane 已确认撤回；already_consumed 返回 false（正文已成为条目，由调用方按已有证据处理）。
   */
  async cancelPendingDelivery(requestId: string): Promise<boolean> {
    const entryId = this.pendingDeliveryEntries.get(requestId)
    if (!entryId || !this.lane) return false
    const result = await this.lane.cancelQueued(entryId, TODO_CONTEXT)
    if (!result.ok) return false
    if (result.value.kind === "cancelled") {
      this.pendingDeliveryEntries.delete(requestId)
      return true
    }
    if (result.value.kind === "already_consumed") this.pendingDeliveryEntries.delete(requestId)
    return false
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 转发一条可展示的正文增量；只更新瞬时展示（§6），不落盘、不触发副作用。 */
  private publishAssistantDelta(delta: string): void {
    if (!delta) return
    this.streamActive = true
    this.activeRun?.spec.sinks?.onAssistantDelta?.(delta)
  }

  /** 结束当前 assistant 消息的瞬时展示；幂等，没有展示过增量时不上报。 */
  private endAssistantStream(): void {
    if (!this.streamActive) return
    this.streamActive = false
    this.activeRun?.spec.sinks?.onAssistantStreamEnd?.()
  }

  private registerHooks(): void {
    if (!this.harness) return
    const hooks = this.harness.hooks
    this.unsubscribes.push(
      hooks.on("before_tool", async (event, context) => {
        const beforeTool = this.hostSpec().hooks?.beforeTool
        if (!beforeTool) {
          // 没有宿主运行上下文（权限链不可用）时一律拒绝工具：fail-closed，不放行未受管的调用。
          // 结构操作的续跑没有工具宿主面（决策 §7 #29 A）：它走这条分支，不另开权限链。
          log.warn("无宿主运行上下文，工具调用被拒绝:", { sessionId: this.sessionId, toolName: event.toolName })
          return { block: { reason: "运行上下文不可用，工具调用被拒绝" } }
        }
        const decision = await beforeTool({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          // 门禁 signal：取消请求后权限等待要随之结束（对齐旧 beforeToolCall 的 signal）。
          signal: context.abortSignal,
        })
        return decision
      }),
      hooks.on("after_tool", (event) => {
        return this.hostSpec().hooks?.afterTool?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          content: event.content,
          details: event.details,
          isError: event.isError,
        })
      }),
      hooks.on("transform_context", async (event) => {
        return this.hostSpec().hooks?.transformContext?.({ messages: event.messages, systemPrompt: event.systemPrompt })
      }),
      hooks.on("before_compaction", async (event, context) => {
        // 运行期用回合钩子；/compact 等手动压缩没有 activeRun，用本次下发的结构操作钩子。
        const host = this.hostSpec().hooks?.beforeCompaction
        if (!host) return undefined
        return host({ reason: event.reason, preparation: event.preparation, signal: context.abortSignal })
      }),
      hooks.on("before_request", (event) => {
        const host = this.hostSpec().hooks?.beforeRequest
        if (!host) return undefined
        return host({ step: event.step, attempt: event.attempt })
      }),
      hooks.on("after_response", async (event) => {
        const message = await this.hostSpec().hooks?.afterResponse?.(event.message, { status: event.status, headers: event.headers })
        return message === undefined ? undefined : { message }
      }),
      hooks.on("before_payload", (event) => {
        this.hostSpec().hooks?.beforePayload?.(event.payload, event.model)
        return undefined
      }),
    )
  }

  private subscribeEvents(): void {
    if (!this.harness) return
    const events = this.harness.events
    this.unsubscribes.push(
      events.on("message_update", (event) => {
        const run = this.activeRun
        if (!run) return
        // 用 frame（按块偏移去重）而不是原始事件：恢复重放时不会重复展示已见过的分片。
        const frame = event.frame
        if (!frame) return
        // 新消息（或恢复流）开始：先清掉上一段瞬时展示。
        if (frame.type === "start") {
          this.endAssistantStream()
          return
        }
        // 只展示正文：thinking 与工具参数增量在这里被丢弃（§6）；压缩摘要不是流式路径。
        if (frame.type !== "text_delta") return
        this.publishAssistantDelta(frame.delta)
      }),
      events.on("message_end", async (event) => {
        const run = this.activeRun
        if (!run) return
        const message = event.message
        if (message.role === "assistant") {
          // 先结束瞬时缓冲，再交给提交路径推送真实消息（§6）。
          this.endAssistantStream()
          run.spec.state.finalAssistant = message
          await run.spec.sinks?.onAssistantMessage?.(message, event.entryId)
          return
        }
        if (message.role === "toolResult") {
          await run.spec.sinks?.onToolResultMessage?.(message, event.entryId)
        }
      }),
      events.on("turn_start", () => {
        const run = this.activeRun
        if (!run) return
        run.deliveryPhase = "streaming"
        this.deliveryPhase = "streaming"
        run.spec.sinks?.onTurnStart?.()
      }),
      events.on("turn_end", (event) => {
        const run = this.activeRun
        if (!run) return
        run.deliveryPhase = "settling"
        this.deliveryPhase = "settling"
        const message = event.message
        if (message.role !== "assistant") return
        const hasToolCalls = message.content.some(part => part.type === "toolCall")
        // 带 toolCall 的 assistant 只是过程节点，不能作为结算候选。
        if (!hasToolCalls) run.spec.state.finalPlainAssistant = message
      }),
      events.on("tool_end", (event) => {
        this.activeRun?.spec.sinks?.onToolEnd?.(event.toolName, event.isError)
      }),
      events.on("retry_start", () => {
        const run = this.activeRun
        if (run) run.spec.state.retriesUsed++
      }),
      events.on("usage", async (event) => {
        const run = this.activeRun
        if (!run || event.row.adjustment) return
        // 压缩摘要是一次性调用：用量已进入会话 totals，但不冒充主回复的逐请求统计（§6/§7）。
        if (this.compactionActive) return
        run.spec.state.usage = event.row.usage
        await run.spec.sinks?.onUsage?.(event.row, event.totals)
      }),
      events.on("compaction_start", () => {
        this.compactionActive = true
      }),
      events.on("compaction_end", (event) => {
        this.compactionActive = false
        // 已提交的压缩推进请求视图换代身份（旧 contextEpoch 的等价物）。
        if (event.status === "completed") this.compactionEpoch++
        // 溢出恢复的终态：declined 表示硬预算超限没有可安全摘要的范围，回合会失败；
        // 结算文案要回到本条判定（否则用户只看到上游的 decline 文案和兜底回复）。
        const run = this.activeRun
        if (run && event.reason === "overflow") run.spec.state.overflowRecoveryDeclined = event.status === "declined"
      }),
      events.on("queue_update", (event) => {
        this.pendingQueues = event.queues
      }),
      events.on("handler_error", (event) => {
        log.warn("Harness 处理器异常:", { hook: event.kind === "hook" ? event.hook : event.event, error: event.error })
      }),
      events.on("fault", (event) => {
        this.state = "faulted"
        log.error("Harness fault:", { sessionId: this.sessionId, code: event.code, message: event.message })
      }),
    )
  }

  // 供注册表使用的 drain 代际（沿用旧 runner 语义）。
  startDrain(worker: (generation: number) => Promise<void>): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    const generation = ++this.drainGeneration
    const run = worker(generation)
    this.drainPromise = run.finally(() => {
      if (this.drainGeneration === generation && this.drainPromise === run) this.drainPromise = undefined
    })
    return this.drainPromise
  }

  isDrainCurrent(generation: number): boolean {
    return this.drainGeneration === generation
  }
}

/** 从归还的消息里取回宿主 requestId（身份换算见 input-identity）。 */
function collectRequestIds(messages: AgentMessage[]): string[] {
  return messages.flatMap(message => {
    const requestId = messageRequestId(message as { deskpetEventId?: unknown })
    return requestId ? [requestId] : []
  })
}

/** 排队项的正文预览：排队消息以字符串正文投递，结构化内容回退到 contentText。 */
function queuedMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  return Array.isArray(content) ? contentText(content as Parameters<typeof contentText>[0]) : ""
}

const EMPTY_SLOT_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// ── 槽注册表 ──

/**
 * 每会话一个槽：运行所有权、投递与 drain 代际的唯一宿主定义点（H-4 起 RuntimeQueue/AgentSlot 已删除）。
 */
export class HarnessSlots {
  private readonly slots = new Map<string, HarnessSlot>()
  /** 已分配过的最大代际：新槽（含释放重建）从这里继续，保证单调不回退。 */
  private generationSeed = 0

  get(sessionId: string): HarnessSlot {
    let slot = this.slots.get(sessionId)
    if (!slot) {
      slot = new HarnessSlot(sessionId, { generationSeed: this.generationSeed })
      this.slots.set(sessionId, slot)
    }
    this.generationSeed = Math.max(this.generationSeed, slot.generation)
    return slot
  }

  peek(sessionId: string): HarnessSlot | undefined {
    return this.slots.get(sessionId)
  }

  begin(sessionId: string, identity?: { requestId: string; turnId?: string }): number | undefined {
    const generation = this.get(sessionId).begin(identity)
    if (generation !== undefined) this.generationSeed = Math.max(this.generationSeed, generation)
    return generation
  }

  bindRun(sessionId: string, generation: number, identity: { requestId: string; turnId?: string }): boolean {
    return this.peek(sessionId)?.bindRun(generation, identity) ?? false
  }

  end(sessionId: string, generation: number): boolean {
    return this.peek(sessionId)?.end(generation) ?? false
  }

  isRunning(sessionId: string): boolean {
    return this.peek(sessionId)?.isRunning() ?? false
  }

  /**
   * 唯一的「忙」定义：宿主回合所有权（`isRunning`）或 lane 操作在飞（含手动压缩）。
   * 没有槽的会话不算忙（还没打开，也就没有在飞操作）；读失败 fail-closed 见槽侧实现。
   */
  async hasOpenOperation(sessionId: string): Promise<boolean> {
    const slot = this.peek(sessionId)
    return slot ? (slot.isRunning() || await slot.hasOpenOperation()) : false
  }

  /** 当前代际仍是所有者（未取消、未失效）。 */
  isCurrent(sessionId: string, generation: number): boolean {
    return this.peek(sessionId)?.isCurrent(generation) ?? false
  }

  isAnyRunning(): boolean {
    return [...this.slots.values()].some(slot => slot.isRunning())
  }

  deliveryMode(sessionId: string): "steer" | "followup" | undefined {
    return this.peek(sessionId)?.deliveryMode()
  }

  snapshot(sessionId: string): HarnessSlotSnapshot | undefined {
    return this.peek(sessionId)?.snapshot()
  }

  getInterrupted(sessionId: string): HarnessSlotSnapshot["interrupted"] {
    return this.peek(sessionId)?.getInterrupted()
  }

  /** 撤销尚未被消费的投递（best-effort）；未打开过的会话没有待撤销项。 */
  async cancelPendingDelivery(sessionId: string, requestId: string): Promise<boolean> {
    return await this.peek(sessionId)?.cancelPendingDelivery(requestId) ?? false
  }

  /** 单项撤回（UI 排队视图）：没有槽的会话本来就没有可撤回项。 */
  async cancelQueued(sessionId: string, entryId: string): Promise<HarnessCancelQueuedKind> {
    const slot = this.peek(sessionId)
    return slot ? await slot.cancelQueued(entryId) : "not_found"
  }

  drain(sessionId: string, worker: (generation: number) => Promise<void>): Promise<void> {
    return this.get(sessionId).startDrain(worker)
  }

  isDrainCurrent(sessionId: string, generation: number): boolean {
    return this.peek(sessionId)?.isDrainCurrent(generation) ?? false
  }

  /** 释放空闲槽（会话切换/关闭时用）；运行中的槽不释放。 */
  releaseWhenIdle(sessionId: string): boolean {
    const slot = this.peek(sessionId)
    if (!slot || slot.isRunning()) return false
    this.slots.delete(sessionId)
    void slot.close()
    return true
  }

  /** 释放会话槽；返回是否在空闲状态下释放（false 表示带着未结束的运行继续，已 warn）。 */
  async dispose(sessionId: string): Promise<boolean> {
    const slot = this.peek(sessionId)
    if (!slot) return true
    await slot.abort(ABORT_REASON_DISPOSE).catch(error => {
      log.warn("释放会话槽时停止运行失败:", sessionId, formatError(error))
      return undefined
    })
    const idle = await slot.waitForIdle()
    // 子运行不注册在会话表里：abort 已级联到它们，这里再等它们收尾（句柄释放不能反序）。
    await Promise.allSettled(slot.childSlots().map(child => child.waitForIdle()))
    this.slots.delete(sessionId)
    await slot.close()
    return idle
  }

  async abortAndWaitAll(): Promise<void> {
    await Promise.allSettled([...this.slots.values()].map(async slot => {
      await slot.abort(ABORT_REASON_DISPOSE).catch(error => {
        log.warn("停止运行失败:", { sessionId: slot.snapshot().sessionId }, formatError(error))
        return undefined
      })
      await slot.waitForIdle()
      // 子槽（计划步骤的子代理）不在会话表里：不等它们收尾，隔离点会在子运行未结束时
      // 关掉文件句柄（resetAgentRuntimeForTest 的直接后果）。
      await Promise.allSettled(slot.childSlots().map(child => child.waitForIdle()))
    }))
  }

  async reset(): Promise<void> {
    const slots = [...this.slots.values()]
    this.slots.clear()
    await Promise.allSettled(slots.map(slot => slot.close()))
  }
}

export const harnessSlots = new HarnessSlots()
