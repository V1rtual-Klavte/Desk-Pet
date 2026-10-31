// 一次性文本调用的审计归属。
import type { RuntimeTraceContext } from "@/services/engine/protocol"

/** 一次性调用的审计归属：给出后请求快照与派生记录按会话落盘（不入模型消息流）。 */
export interface PiTextCallAudit {
  sessionId: string
  turnId?: string
  requestId?: string
  /** 派生来源（如触发这次一次性调用的 runId/planId）。 */
  derivedFrom?: string[]
  traceContext?: RuntimeTraceContext
}
