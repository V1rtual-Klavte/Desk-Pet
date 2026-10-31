// 主回合入参与产物契约。
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ActiveMessageRequest, ThinkingEffort } from "@/services/agent/types"
import type { ProactiveTurnContext } from "@/services/proactive"
import type { SlashSkillAdmission } from "@/services/engine/slash"
import type { IngressEnvelope } from "@/services/engine/protocol"
import type { FailureKind } from "@/services/error/failure-kind"

/** 回合入参的公共面：两支（用户输入 / 技能准入）共用，正文来源不同。 */
interface PiAgentTurnBase {
  sessionId: string
  /**
   * 按文本工作的环节（显式计划、记忆召回）用它。技能准入传用户敲下的原文：
   * 正文由 Harness 从技能文件构造，宿主这里没有别的东西可以代表「这次输入是什么」。
   */
  userText: string
  /**
   * 输入已落盘（lane.accept 提交用户条目成立）之后的 UI 记账钩子：用户气泡与未回复计数
   * 只在条目提交进会话文件之后更新，预检失败、未获准入时不会先画一条不存在于会话里的气泡。
   */
  onInputAdmitted?: () => void | Promise<void>
  unansweredCount: number
  isActiveMessage?: boolean
  /** A per-turn capability policy, independent of proactive-message semantics. */
  toolMode?: "none"
  activeRequest?: ActiveMessageRequest
  turnContext?: ProactiveTurnContext
  runGeneration?: number
  turnId?: string
}

/** 用户输入支（现状形态）：正文与投递身份由调用方构造，空闲发送与忙碌投递共用同一形状。 */
export interface PiAgentInputTurn extends PiAgentTurnBase {
  /**
   * 本次投递的正文（`userInputMessage()` 或主动消息构造器的产物），随回合落盘。
   * 身份与来源标记因此对所有入口一致生效。
   */
  userPrompt: AgentMessage | AgentMessage[]
  /**
   * 停止后继续：把取回的暂停输入按原顺序作为本次投递内容（身份不合并、正文不重复追加）。
   */
  pausedMessages?: AgentMessage[]
  ingress?: IngressEnvelope
  skillAdmission?: undefined
}

/**
 * 技能准入支（`/skill <技能名> [额外指示]`）：宿主不提供正文 —— 那条 `role:"user"` 消息由 Pi 在
 * `accept` 内按技能文件构造（含技能文件的绝对路径）并提交，所以宿主也不再投递第二条正文，
 * 更不给它套 `deskpetEventId`：条目不是我们构造的，套一份身份只会造出查不到的假投递证据。
 * 互斥字段用 `undefined` 钉死（与 `HarnessAdmitSkillSpec` 的 `?: never` 同一口径）。
 */
export interface PiAgentSkillTurn extends PiAgentTurnBase {
  skillAdmission: SlashSkillAdmission
  userPrompt?: undefined
  pausedMessages?: undefined
  ingress?: undefined
}

export type PiAgentTurnInput = PiAgentInputTurn | PiAgentSkillTurn

/**
 * 回合在拿到模型回复之前就失败的结构化原因。
 *
 * 产品侧要的是「有兜底文案可显示」，报告侧要的是「这次失败属于哪一类」，两者不冲突：
 * 只返回兜底文案会让报告把 Provider 故障记成 assertion 失败，观测直接失效。
 * `kind` 与 Live Test 的 `ErrorKind` 同名，报告可直接照搬。
 */
export interface TurnFailure {
  kind: FailureKind
  message: string
}

export interface PiAgentTurnOutput {
  reply: string
  /** Multiple display bubbles derived from one committed assistant entry. */
  replyParts?: string[]
  /** True when the committed assistant entry intentionally contains no visible text. */
  silent?: boolean
  /** Runtime generation paired with any transient reveal schedule. */
  runGeneration?: number
  generationStartedAt?: number
  committedAssistantEntryId?: string
  /** 本回合提交的助手条目关联的截图路径（`deskpetImagePaths`）；宿主据此推实时界面消息。 */
  userImagePaths?: string[]
  humanized?: boolean
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  runtimeData?: { variables: Record<string, string> }
  activeCommit?: { operationId: string; triggerEntryId: string; assistantEntryId: string; text: string; timestamp: number; parts?: string[]; silent?: boolean; usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number } }
  /** Actual provider usage accrued before a failure; absence means unknown, never an estimate. */
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  /** 回合失败的真实分类；包括重试耗尽、准入失败与工具循环治理终止。 */
  failure?: TurnFailure
  /** 停止归还：未消费的补充消息 requestId（宿主决定重新排队或丢弃）。 */
  undelivered?: string[]
  /** 回合因显式停止（不是超时）结束；宿主不得在停止后自动继续剩余输入。 */
  abortedByStop?: boolean
  /**
   * 兜底/中断文案没能写进会话文件（只显示过，没有持久正文）——
   * 宿主据此区分「已持久化」与「界面看到过」，不要当成同一件事。
   */
  persistFailed?: boolean
}
