// ==========================================
// 核心引擎 —— 会话引擎（状态机）
// 管理 Agent 状态流转: WAITING → PRE → PLANNING → GENERATING → EXECUTING
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("Session")

// ── Agent 状态 ──

export type AgentState =
  | "WAITING"     // 等待用户输入
  | "PRE"         // 预处理（slash命令/去重）
  | "PLANNING"    // Plan 步骤（助手模式复杂任务）
  | "GENERATING"  // AI 生成中
  | "EXECUTING"   // 执行工具中

// ── 会话 ──

export interface SessionState {
  agentState: AgentState
  /** 会话开始时间 */
  startedAt: number
  /** 本会话消息数 */
  messageCount: number
  /** 本会话工具调用数 */
  toolCallCount: number
  /** 上次活动时间 */
  lastActivityAt: number
}

let session: SessionState = {
  agentState: "WAITING",
  startedAt: Date.now(),
  messageCount: 0,
  toolCallCount: 0,
  lastActivityAt: Date.now(),
}

// ── 状态转换 ──

export function getState(): AgentState {
  return session.agentState
}

export function transition(to: AgentState): void {
  const from = session.agentState
  if (from === to) return
  log.debug(`状态: ${from} → ${to}`)
  session.agentState = to
  session.lastActivityAt = Date.now()
}

export function recordMessage(): void {
  session.messageCount++
  session.lastActivityAt = Date.now()
}

export function recordToolCall(): void {
  session.toolCallCount++
  session.lastActivityAt = Date.now()
}

export function getSession(): Readonly<SessionState> {
  return { ...session }
}

export function resetSession(): void {
  session = {
    agentState: "WAITING",
    startedAt: Date.now(),
    messageCount: 0,
    toolCallCount: 0,
    lastActivityAt: Date.now(),
  }
}

/** 会话是否超时（长时间不活动） */
export function isSessionStale(maxIdleMs: number = 3600000): boolean {
  return Date.now() - session.lastActivityAt > maxIdleMs
}
