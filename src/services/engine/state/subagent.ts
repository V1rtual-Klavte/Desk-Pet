// 子运行契约：owner、证据与产物形状。
import type { ThinkingEffort, ProviderReservation } from "@/services/agent/types"
import type { RuntimeTraceContext } from "@/services/engine/protocol"
import type { TaskToolAuthorization, ToolDef } from "@/services/tool"

/**
 * 父槽只暴露「把子槽挂进取消域」这一项能力。
 * state 层不能 import harness 的 HarnessSlot；结构类型让真实槽在调用侧自然赋值。
 */
export interface PiSubAgentParentSlot {
  attachChild(child: unknown): () => void
}

/** Parent cancellation/permission identity shared by delegated and Plan work. */
export interface PiSubAgentScope {
  sessionId: string
  runGeneration: number
  trustedUserEventId?: string
  isCurrent: () => boolean
  signal?: AbortSignal
  parentSlot?: PiSubAgentParentSlot
}

/** Purpose and authority are bound by the host, never accepted from model arguments. */
export type PiSubAgentOwner =
  | (PiSubAgentScope & { kind: "conversation"; runId: string; parentRunId?: string })
  | (PiSubAgentScope & { kind: "plan"; runId: string; planId: string; stepId: string; parentRunId?: string })
  | (Omit<PiSubAgentScope, "trustedUserEventId" | "parentSlot"> & { kind: "proactive"; runId: string; cardId: string })
  | {
      kind: "scheduled"
      runId: string
      sessionId: string
      cardId: string
      taskId: string
      taskVersion: number
      occurrenceId: string
      authorization: TaskToolAuthorization
      isCurrent: () => boolean
      signal?: AbortSignal
    }

export interface PiSubAgentAudit {
  sessionId?: string
  planId?: string
  stepId?: string
  /** Business-owned result location; the kernel does not create a second transcript. */
  reference?: string
}

export interface PiSubAgentInput {
  owner: PiSubAgentOwner
  task: string
  tools: ToolDef[]
  systemPrompt: string
  capabilities?: { requiredToolNames?: readonly string[] }
  maxToolCalls?: number
  /** Caller override: scheduled work may prompt only when a human-facing confirm sink is mounted. */
  permissionMode?: "interactive" | "background"
  timeoutMs?: number
  deadlineAt?: number
  thinkingEffort?: ThinkingEffort
  maxOutputTokens?: number
  beforeProvider?: (reservation: ProviderReservation) => Promise<boolean>
  disableAutomaticCompaction?: boolean
  /** Runtime completion and acceptance are separate: this validator owns business success. */
  outputContract?: {
    kind: "text" | "json"
    validate?: (output: { reply: string; artifact?: unknown; evidence: PiSubAgentEvidence }) => boolean | string | Promise<boolean | string>
  }
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
  audit?: PiSubAgentAudit
}

export interface PiSubAgentEvidence {
  tools: Array<{ toolName: string; toolCallId?: string; status: string; reason?: string; sourceUrls?: string[]; sources?: Array<{ url: string; publishedAt?: string }>; completedAt?: number }>
  incomplete: string[]
  /** A failed/cancelled non-read call may have left effects before its receipt (local mutation / process / external). */
  unconfirmedEffects: boolean
  /** 工具调用预算耗尽：允许收尾生成，但任何产出都不得自称 complete（由 Harness 侧置位）。 */
  toolBudgetExhausted?: boolean
}

export interface PiSubAgentOutput {
  status: "completed" | "cancelled" | "timed_out" | "needs_input" | "failed"
  /** Business acceptance; completed alone only means the Harness ended. */
  success: boolean
  reply: string
  artifact?: unknown
  toolCallsMade: number
  evidence: PiSubAgentEvidence
  audit: PiSubAgentAudit & { runId: string; requestId: string; ownerKind: PiSubAgentOwner["kind"] }
  resolved?: {
    modelId: string
    provider: string
    requestedThinkingEffort: ThinkingEffort
    reasoningLevel?: string
    reasoningParameter?: string | null
    thinkingAdaptation: "native" | "server_default" | "unsupported"
    deadlineAt: number
    maxToolCalls: number
    maxOutputTokens: number
    toolNames: string[]
  }
  error?: string
  rawReply?: string
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  members?: Array<{ role: string; output: PiSubAgentOutput }>
}

// 一次性文本调用的审计归属。
/** 一次性调用的审计归属：给出后请求快照与派生记录按会话落盘（不入模型消息流）。 */
export interface PiTextCallAudit {
  sessionId: string
  turnId?: string
  requestId?: string
  /** 派生来源（如触发这次一次性调用的 runId/planId）。 */
  derivedFrom?: string[]
  traceContext?: RuntimeTraceContext
}
