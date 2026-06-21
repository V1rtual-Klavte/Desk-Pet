// ==========================================
// Debug 状态 —— 追踪 token 消耗、上下文利用率、工具注册数
// 供 ChatPanel 底部状态栏 + SettingsPanel 预览使用
// ==========================================

import { reactive } from "vue"
import type { ToolDeclaration } from "@/services/agent/types"
import { aiConfig } from "@/services/config"

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

  registeredToolCount: 0,
  registeredTools: [],
  registeredSkillCount: 0,
  registeredMcpCount: 0,
})

/** 更新上次请求统计 */
export function updateRequestStats(opts: {
  promptTokens?: number
  completionTokens?: number
  systemTokens?: number
  toolCount?: number
  toolNames?: string[]
  conversationTokens?: number
}) {
  if (opts.promptTokens !== undefined) debug.lastPromptTokens = opts.promptTokens
  if (opts.completionTokens !== undefined) debug.lastCompletionTokens = opts.completionTokens
  if (opts.systemTokens !== undefined) debug.lastSystemTokens = opts.systemTokens
  if (opts.toolCount !== undefined) {
    debug.lastToolCount = opts.toolCount
    debug.lastToolNames = opts.toolNames ?? []
  }
  const conv = opts.conversationTokens ?? 0
  const total = debug.lastSystemTokens + conv
  debug.lastContextUsage = debug.contextMaxTokens > 0
    ? Math.round((total / debug.contextMaxTokens) * 100)
    : 0
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
