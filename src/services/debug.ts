// ==========================================
// Debug 状态 —— 追踪模型用量、上下文利用率、工具注册数
// 供 ChatPanel 底部状态栏（DebugBar）使用
// 用量取自 Provider 回报的 usage（failure 响应也算一次调用）；不填估算值冒充准确用量
// ==========================================

import { reactive } from "vue"
import type { Usage } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import type { PiTextPurpose } from "@/services/engine/pi"
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
  /** 模型用量按 purpose 分列；总量与分项来自同一份累计，不另算旁路 */
  usage: Record<UsagePurpose, PurposeUsage>

  /** 当前已注册工具总数 */
  registeredToolCount: number
  /** 当前已注册工具列表 */
  registeredTools: { name: string; source: string; mode: string }[]
  /** 已注册 MCP 工具数 */
  registeredMcpCount: number
}

/** 用量分项：主回合（含工具轮）与一次性文本调用。 */
export type UsagePurpose = "main" | PiTextPurpose

export interface PurposeUsage {
  /** 已完成的模型调用次数（含 Provider 未回报 usage 的失败响应）。 */
  calls: number
  /** Provider 明确回报 usage 的次数；未回报的调用不计入下列 token 数。 */
  reported: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Provider 回报的 totalTokens 之和（已含缓存口径，不重复相加）。 */
  total: number
}

function emptyPurposeUsage(): PurposeUsage {
  return { calls: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export const debug = reactive<DebugState>({
  lastPromptTokens: 0,
  lastCompletionTokens: 0,
  lastSystemTokens: 0,
  lastToolCount: 0,
  lastToolNames: [],
  lastContextUsage: 0,
  contextMaxTokens: aiConfig.contextMaxTokens,
  usage: {
    main: emptyPurposeUsage(),
    compaction: emptyPurposeUsage(),
    planner: emptyPurposeUsage(),
    memory: emptyPurposeUsage(),
    stages: emptyPurposeUsage(),
  },

  registeredToolCount: 0,
  registeredTools: [],
  registeredMcpCount: 0,
})

/**
 * 记录一次模型调用的用量。
 *
 * 单一写入点：运行时按请求的逐请求 usage 记 `main`，`completePiText` 按调用用途记
 * 一次性 purpose。Provider 未回报 usage（全 0）的调用只累加次数，不把 0 当准确值。
 */
export function recordModelUsage(purpose: UsagePurpose, usage: Usage): void {
  const bucket = debug.usage[purpose]
  bucket.calls += 1
  if (usage.input === 0 && usage.output === 0 && usage.totalTokens === 0) return
  bucket.reported += 1
  bucket.input += usage.input
  bucket.output += usage.output
  bucket.cacheRead += usage.cacheRead
  bucket.cacheWrite += usage.cacheWrite
  bucket.total += usage.totalTokens
}

/** 全部分项相加得到的总量视图；与分项同源，不从别处另算。 */
export function usageGrandTotal(): PurposeUsage {
  const total = emptyPurposeUsage()
  for (const bucket of Object.values(debug.usage)) {
    total.calls += bucket.calls
    total.reported += bucket.reported
    total.input += bucket.input
    total.output += bucket.output
    total.cacheRead += bucket.cacheRead
    total.cacheWrite += bucket.cacheWrite
    total.total += bucket.total
  }
  return total
}

/** 更新上次请求统计（主回合逐请求展示；累计用量走 recordModelUsage） */
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
  // ★ 上下文占比 = (system + conversation) / max，用最后已知值
  const conv = opts.conversationTokens ?? 0
  const max = debug.contextMaxTokens > 0 ? debug.contextMaxTokens : aiConfig.contextMaxTokens
  const total = debug.lastSystemTokens + conv
  debug.lastContextUsage = Math.round((total / max) * 100)
}

/** 刷新已注册工具统计 */
export async function refreshToolStats() {
  const { listAll, toolCount, getToolsForMode } = await import("@/services/tool/registry")
  const all = listAll()
  debug.registeredToolCount = toolCount()
  debug.registeredTools = all.map(t => ({ name: t.name, source: t.source, mode: t.mode }))
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
