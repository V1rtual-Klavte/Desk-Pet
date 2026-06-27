// ==========================================
// Debug 状态 —— 追踪 token 消耗、上下文利用率、工具注册数
// 供 ChatPanel 底部状态栏 + SettingsPanel 预览使用
// ★ token/上下文数据持久化到会话 .md 文件，重启后自动恢复
// ==========================================

import { reactive } from "vue"
import type { ToolDeclaration } from "@/services/agent/types"
import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig, safetyConfig } from "@/services/config"

// ── 会话级思考强度覆盖 ──
// null = 使用全局默认 (ai.thinkingEffort)
let _sessionThinkingEffort: ThinkingEffort | null = null

/** 设置当前会话的思考强度覆盖 */
export function setSessionThinkingEffort(effort: ThinkingEffort | null): void {
  _sessionThinkingEffort = effort
}

/** 获取当前有效的思考强度：会话覆盖 > 全局默认 */
export function getEffectiveThinkingEffort(): ThinkingEffort {
  return _sessionThinkingEffort ?? (aiConfig.thinkingEffort as ThinkingEffort)
}

// ── 会话级安全策略覆盖 ──
// null = 使用全局默认 (safety.mode)
type SafetyMode = "just_do_it" | "tell_me" | "let_me_tk"
let _sessionSafetyMode: SafetyMode | null = null

/** 设置当前会话的安全策略覆盖 */
export function setSessionSafetyMode(mode: SafetyMode | null): void {
  _sessionSafetyMode = mode
}

/** 获取当前有效的安全策略：会话覆盖 > 全局默认 */
export function getEffectiveSafetyMode(): SafetyMode {
  return _sessionSafetyMode ?? (safetyConfig.mode as SafetyMode)
}

/** 重置会话思考强度 */
export function resetSessionThinkingEffort(): void {
  _sessionThinkingEffort = null
}

/** 重置会话安全策略 */
export function resetSessionSafetyMode(): void {
  _sessionSafetyMode = null
}

export interface DebugState {
  /** 上次请求 prompt tokens */
  lastPromptTokens: number
  /** 上次请求 completion tokens */
  lastCompletionTokens: number
  /** 上次请求 system prompt 估算 tokens */
  lastSystemTokens: number
  /** 上次请求携带的工具数 */
  lastToolCount: number
  /** 上次请求的工具名列表 */
  lastToolNames: string[]
  /** 上下文利用率 = (system+conversation) / max */
  lastContextUsage: number
  /** 上下文上限 (tokens) */
  contextMaxTokens: number
  /** 累计总 prompt tokens */
  totalPromptTokens: number
  /** 累计总 completion tokens */
  totalCompletionTokens: number

  /** 当前已注册工具总数 */
  registeredToolCount: number
  /** 当前已注册工具列表 */
  registeredTools: { name: string; source: string; mode: string }[]
  /** 已注册 Skill 数 */
  registeredSkillCount: number
  /** 已注册 MCP 工具数 */
  registeredMcpCount: number
}

export const debug = reactive<DebugState>({
  lastPromptTokens: 0,
  lastCompletionTokens: 0,
  lastSystemTokens: 0,
  lastToolCount: 0,
  lastToolNames: [],
  lastContextUsage: 0,
  contextMaxTokens: 16000,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,

  registeredToolCount: 0,
  registeredTools: [],
  registeredSkillCount: 0,
  registeredMcpCount: 0,
})

/** 更新上次请求统计 + 维护累计值 */
export function updateRequestStats(opts: {
  promptTokens?: number
  completionTokens?: number
  systemTokens?: number
  toolCount?: number
  toolNames?: string[]
  conversationTokens?: number
}) {
  if (opts.promptTokens !== undefined) {
    debug.lastPromptTokens = opts.promptTokens
    debug.totalPromptTokens += opts.promptTokens
  }
  if (opts.completionTokens !== undefined) {
    debug.lastCompletionTokens = opts.completionTokens
    debug.totalCompletionTokens += opts.completionTokens
  }
  if (opts.systemTokens !== undefined) debug.lastSystemTokens = opts.systemTokens
  if (opts.toolCount !== undefined) {
    debug.lastToolCount = opts.toolCount
    debug.lastToolNames = opts.toolNames ?? []
  }
  // ★ 上下文占比 = (system + conversation) / max，用最后已知值
  const conv = opts.conversationTokens ?? 0
  const max = debug.contextMaxTokens > 0 ? debug.contextMaxTokens : 16000
  const total = debug.lastSystemTokens + conv
  debug.lastContextUsage = Math.round((total / max) * 100)
}

/** 从 .md 文件元数据恢复 debug 统计 */
export function restoreDebugStats(stats: { totalPrompt?: number; totalCompletion?: number; lastContextUsage?: number }) {
  if (stats.totalPrompt !== undefined) debug.totalPromptTokens = stats.totalPrompt
  if (stats.totalCompletion !== undefined) debug.totalCompletionTokens = stats.totalCompletion
  if (stats.lastContextUsage !== undefined) debug.lastContextUsage = stats.lastContextUsage
}

/** 刷新已注册工具统计 */
export async function refreshToolStats() {
  const { listAll, toolCount, getToolsForMode } = await import("@/services/tool/registry")
  const all = listAll()
  debug.registeredToolCount = toolCount()
  debug.registeredTools = all.map(t => ({ name: t.name, source: t.source, mode: t.mode }))
  debug.registeredSkillCount = all.filter(t => t.source === "skill").length
  debug.registeredMcpCount = all.filter(t => t.source === "mcp").length
}

/** 初始化 debug 状态 */
export async function initDebug(): Promise<void> {
  debug.contextMaxTokens = aiConfig.contextMaxTokens
  await refreshToolStats()
}

if (typeof window !== "undefined") {
  (window as any).__debug = debug
  ;(window as any).__refreshTools = refreshToolStats
}
