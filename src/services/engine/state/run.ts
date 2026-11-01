// 运行契约：宿主创建、槽填充，供结算与结构操作共享。
import type {
  AgentHarnessStreamOptionsPatch, AgentMessage, AgentToolResult, CompactResult,
  CompactionPreparation, JsonValue, OperationResultRecord, SettledAssistantMessage, UsageRow,
} from "@earendil-works/pi-agent-core"
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import type { CompactionAuditSink, RuntimeTraceContext } from "@/services/engine/protocol"

/** 回合内共享的聚合状态：由宿主创建，槽在事件处理中填充。 */
export interface HarnessRunState {
  /**
   * 本回合是否命中工具循环治理（同参连击 / 失败连击的硬阈值，或预算耗尽后的收尾生成仍继续调工具；
   * 后续工具一律拦截。主回合若有已提交的终态收尾则正常交付，否则走 `toolLoopMaxRounds` 兜底）。
   */
  stoppedByToolGovernance: boolean
  /**
   * 工具调用计次上限已命中（软着陆）：越界调用被拒，但运行仍允许一次收尾生成；
   * 只有收尾生成里再次调用工具才置 `stoppedByToolGovernance` 并硬终止。
   * 子运行据此把 `toolBudgetExhausted` 交给业务侧（预算耗尽不算 complete）。
   */
  toolBudgetExhausted: boolean
  /** 由命中治理的分支记录真实原因，不从 Card 兜底台词反推。 */
  toolGovernanceReason?: string
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
  finalAssistant?: AssistantMessage
  /** 最近一次不带工具调用的 assistant（结算候选）。 */
  finalPlainAssistant?: AssistantMessage
  /** Durable JSONL entry identity paired with the final assistant message. */
  finalAssistantEntryId?: string
  /**
   * 本回合 show_to_user 截图的落盘路径（afterTool 从工具结果 details 取回）。
   * 提交链在最终助手消息落条目之前把它们并入条目（`deskpetImagePaths`）与结算回传；
   * 被取消/失败的回合不会走到提交，状态随回合丢弃。
   */
  pendingUserImages?: string[]
  /** 已并入提交条目的用户可见截图路径（结算回传给宿主推界面）。 */
  attachedUserImages?: string[]
  /** Actual request usage observed from Harness events; absent means unknown. */
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
}

export function createHarnessRunState(): HarnessRunState {
  return { stoppedByToolGovernance: false, toolBudgetExhausted: false, toolCallsMade: 0, retriesUsed: 0, undelivered: [] }
}

/** 宿主注入的行为：权限、结果元数据、投影与观测。 */
export interface HarnessRunHooks {
  beforeTool?: (input: {
    toolCallId: string
    toolName: string
    args: Record<string, JsonValue>
    signal?: AbortSignal
  }) => Promise<{ block: { reason: string; terminate?: boolean } } | undefined> | { block: { reason: string; terminate?: boolean } } | undefined
  /**
   * `terminate: true` 经上游 `after_tool` 的结果合流进工具结果：本批工具全部带该标记时，
   * Harness 在当前批次后结束运行、不再发起下一次请求（`includeFinalAssistant: false`，
   * 运行以 completed 收口，由结算的治理兜底文案收尾）。单个批次里有未终止的调用时不生效。
   */
  afterTool?: (input: {
    toolCallId: string
    toolName: string
    args: Record<string, JsonValue>
    content: AgentToolResult<unknown>["content"]
    details?: JsonValue
    isError: boolean
  }) => { details?: JsonValue; isError?: boolean; terminate?: boolean } | undefined
  transformContext?: (input: {
    messages: AgentMessage[]
    systemPrompt: string
    signal?: AbortSignal
  }) => Promise<{ messages?: AgentMessage[] } | undefined> | { messages?: AgentMessage[] } | undefined
  /**
   * 压缩决策钩子：返回自定义 CompactResult（宿主摘要内核）或 decline 跳过。
   * 摘要内核失败必须在钩子内转成 decline（宿主不落上游通用摘要）；`compactionAudit`
   * 承载这次压缩的成败，由槽在 `compaction_end` 收口成审计条目。
   */
  beforeCompaction?: (input: {
    reason: "manual" | "threshold" | "overflow"
    preparation: CompactionPreparation
    signal?: AbortSignal
    /** 上游 hook 调用带的运行身份（压缩请求归属用）。 */
    runId: string
  }) => Promise<{ decline?: boolean; compaction?: CompactResult } | undefined> | { decline?: boolean; compaction?: CompactResult } | undefined
  /** 本回合/本次结构操作的压缩审计槽：钩子工厂的产出写在这里，供 compaction_end 读。 */
  compactionAudit?: CompactionAuditSink
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
  traceContext?: RuntimeTraceContext
  traceBridgeState?: { linkedNativeRunIds: Set<string>; firstTextGenerated: boolean }
}

/** 宿主注入的 UI/统计消费点；事件在 Harness 交付线上按序 await。 */
export interface HarnessRunSinks {
  onTurnStart?: () => void
  /** 流式正文增量（只含 text_delta 且已去掉 RUNTIME_DATA 起止后的内容）；只更新瞬时展示。 */
  onAssistantDelta?: (delta: string) => void
  /**
   * 当前 assistant 消息的流式缓冲结束（message_end / 新消息 start 帧 / 运行收尾）。
   *
   * 每条 assistant 消息边界都会调用一次，**含没有任何可见增量的消息**：实现方必须幂等，
   * 并在这里清空过滤状态（只清「没有增量就不上报」会让过滤器永久停在停止态）。
   */
  onAssistantStreamEnd?: () => void
  onAssistantMessage?: (message: AssistantMessage, entryId: string | undefined) => void | Promise<void>
  onToolResultMessage?: (message: ToolResultMessage, entryId: string | undefined) => void | Promise<void>
  onToolEnd?: (toolName: string, isError: boolean) => void
  /** Harness RetryPolicy 开始一次重试等待；`attempt` 是从 1 起算的序号。 */
  onRetry?: (attempt: number) => void
  onUsage?: (row: UsageRow, totals: Usage) => void | Promise<void>
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

export const ABORT_REASON_TIMEOUT = "timeout"
export const ABORT_REASON_USER = "user"
export const ABORT_REASON_DISPOSE = "dispose"
export type HarnessAbortReason = typeof ABORT_REASON_TIMEOUT | typeof ABORT_REASON_USER | typeof ABORT_REASON_DISPOSE
