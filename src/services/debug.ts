// ==========================================
// Debug 状态 —— 追踪模型用量、上下文利用率、工具清单
// 供原生 UI 的调试面板（输入区上拉抽屉）使用
// 用量取自 Provider 回报的 usage（failure 响应也算一次调用）；不填估算值冒充准确用量
// 上下文占用可由会话快照恢复（重启后不归零，见 restoreLastRequestStats）
// ==========================================

import { reactive } from "vue"
import type { Usage } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import type { PiTextPurpose } from "@/services/engine/harness"
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

/**
 * 会话级思考强度覆盖的原始读值（null = 无覆盖）。
 * 与 `getEffectiveThinkingEffort` 分开：调试条投影要同时展示「有没有覆盖」与生效值。
 */
export function getSessionThinkingEffortOverride(): ThinkingEffort | null {
  return _sessionThinkingEffort
}

// ── 会话级安全策略覆盖 ──
// null = 使用全局默认 (safety.mode)
export type SafetyMode = "just_do_it" | "tell_me" | "let_me_tk"
let _sessionSafetyMode: SafetyMode | null = null

/** 设置当前会话的安全策略覆盖 */
export function setSessionSafetyMode(mode: SafetyMode | null): void {
  _sessionSafetyMode = mode
}

/** 获取当前有效的安全策略：会话覆盖 > 全局默认 */
export function getEffectiveSafetyMode(): SafetyMode {
  return _sessionSafetyMode ?? (safetyConfig.mode as SafetyMode)
}

/**
 * 会话级安全策略覆盖的原始读值（null = 无覆盖）。
 * 与 `getEffectiveSafetyMode` 分开：调试条投影要同时展示「有没有覆盖」与生效值。
 */
export function getSessionSafetyModeOverride(): SafetyMode | null {
  return _sessionSafetyMode
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
  /** 上次请求的真实 prompt tokens = Provider input + cacheRead + cacheWrite（未回报时保留上次值） */
  lastPromptTokens: number
  /** 上次请求 completion tokens */
  lastCompletionTokens: number
  /** 上次请求 system prompt 估算 tokens */
  lastSystemTokens: number
  /** 上次请求携带的工具数 */
  lastToolCount: number
  /** 上次请求的工具名列表 */
  lastToolNames: string[]
  /**
   * 上下文利用率（真实 prompt 用量优先；Provider 未回报时退回估算）；
   * `null` = **未知**（本进程还没有过对话请求，也没有可从会话快照恢复的真实读数）——
   * 面板显示「—」，不显示 0%（0% 会谎报「上下文是空的」；重启恢复见 `restoreLastRequestStats`）。
   */
  lastContextUsage: number | null
  /** 上下文上限 (tokens) */
  contextMaxTokens: number
  /** 模型用量按 purpose 分列；总量与分项来自同一份累计，不另算旁路 */
  usage: Record<UsagePurpose, PurposeUsage>

  /** 当前已注册工具列表（面板「注册明细」展开与引导序列判据消费） */
  registeredTools: { name: string; source: string }[]
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
  lastContextUsage: null,
  contextMaxTokens: aiConfig.contextMaxTokens,
  usage: {
    main: emptyPurposeUsage(),
    compaction: emptyPurposeUsage(),
    planner: emptyPurposeUsage(),
    memory: emptyPurposeUsage(),
    stages: emptyPurposeUsage(),
    observation: emptyPurposeUsage(),
    topic: emptyPurposeUsage(),
  },

  registeredTools: [],
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

/**
 * 更新上次请求统计（主回合逐请求展示；累计用量走 recordModelUsage）。
 *
 * **真实用量优先、估算兜底**（2026-10-05 修复「token 计算有问题」）：
 * - Provider 回执的 `input` 是**缓存未命中**部分（pi-ai 归一：`input = prompt_tokens − cached`，
 *   见 openai-completions `parseChunkUsage`），真实 prompt 总量 = input + cacheRead + cacheWrite。
 *   只取 input 会把带缓存命中的请求低估一个数量级（实测样本：DeepSeek input=731 / cacheRead=12160）；
 * - 上下文占比以真实 prompt 总量为分子；Provider 未回报（全 0 行）时才退回
 *   `lastSystemTokens + conversationTokens` 估算——deepseek 等正常路径恒有点位回报，
 *   估算只服务失败/未回报行；
 * - 0 不覆盖好值：未回报行保留上一次的真实 `lastPromptTokens`（覆盖成 0 会让「上次请求」
 *   这一格与占比一起失真）。
 */
export function updateRequestStats(opts: {
  promptTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  completionTokens?: number
  systemTokens?: number
  toolCount?: number
  toolNames?: string[]
  conversationTokens?: number
}) {
  // 真实 prompt 总量（本轮回执）：input + 缓存读 + 缓存写；三者都缺省 = 未回报。
  const realPrompt = (opts.promptTokens ?? 0) + (opts.cacheReadTokens ?? 0) + (opts.cacheWriteTokens ?? 0)
  if (realPrompt > 0) debug.lastPromptTokens = realPrompt
  if (opts.completionTokens !== undefined) debug.lastCompletionTokens = opts.completionTokens
  if (opts.systemTokens !== undefined) debug.lastSystemTokens = opts.systemTokens
  if (opts.toolCount !== undefined) {
    debug.lastToolCount = opts.toolCount
    debug.lastToolNames = opts.toolNames ?? []
  }
  // 占比：真实 prompt 用量优先；拿不到才退回 (system + conversation) 估算。
  const estimated = debug.lastSystemTokens + (opts.conversationTokens ?? 0)
  const basis = realPrompt > 0 ? realPrompt : estimated
  debug.lastContextUsage = contextUsagePercent(basis)
}

/**
 * 上下文占比的唯一计算点（实时与重启恢复两条路径共用 —— 口径不许有第二份）。
 * 分母取 contextMaxTokens（读不到好值时回落配置默认）。
 */
function contextUsagePercent(basis: number): number {
  const max = debug.contextMaxTokens > 0 ? debug.contextMaxTokens : aiConfig.contextMaxTokens
  return Math.round((basis / max) * 100)
}

/**
 * 从会话快照恢复「最近一次对话请求」的上下文占用（重启恢复）。
 *
 * 背景（用户报告 2026-10-06）：`lastContextUsage` 只由对话请求刷新，重启后进程内存清空 →
 * 面板显示「上下文 0%」，看起来像当前会话的上下文是空的。真实读数其实持久在会话 JSONL
 * 的 provider_usage 快照里（证据源与选取纪律见 `readLastConversationPromptTokens`）。
 *
 * 新鲜度：恢复的是**最近一次对话请求的真实输入量**（与实时口径同义，不是「此刻」的估算）；
 * 恢复发生在引导期、中间没有新请求，所以它与重启前面板显示的数字一致。
 * 读不到真实读数（本会话没有过对话请求 / Provider 从未回报）时**保持 null**，如实显示
 * 「—」，不拿 0% 冒充。
 *
 * 已有本进程读数时不恢复（实时读数更新，不该被旧快照覆盖）。
 */
export async function restoreLastRequestStats(): Promise<void> {
  if (debug.lastContextUsage !== null) return
  // 动态 import 断开 debug ↔ session / harness 的静态环（runtime.ts 与 session 侧都静态
  // import 本模块；与 repo.ts 的「动态 import 避免静态环」同一手法）。
  const [{ readLastConversationPromptTokens }, { getActiveSessionId }] = await Promise.all([
    import("@/services/engine/harness/request-stats"),
    import("@/services/session"),
  ])
  const sessionId = getActiveSessionId()
  if (!sessionId) return
  const promptTokens = await readLastConversationPromptTokens(sessionId)
  if (promptTokens === undefined) return
  debug.lastPromptTokens = promptTokens
  debug.lastContextUsage = contextUsagePercent(promptTokens)
}

/** 刷新已注册工具统计 */
export async function refreshToolStats() {
  const { listAll } = await import("@/services/tool/registry")
  debug.registeredTools = listAll().map(t => ({ name: t.name, source: t.source }))
}

/** 初始化 debug 状态（工具列表 + 上下文上限 + 重启恢复的上次请求统计） */
export async function initDebug(): Promise<void> {
  debug.contextMaxTokens = aiConfig.contextMaxTokens
  await refreshToolStats()
  await restoreLastRequestStats()
}

if (typeof window !== "undefined") {
  (window as any).__debug = debug
  ;(window as any).__refreshTools = refreshToolStats
}
