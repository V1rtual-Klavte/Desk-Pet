// ==========================================
// 思考强度决策引擎 —— 根据任务复杂度自动选择推理深度
// auto: 分析用户输入 → 返回 low/medium/high
// 手动: 使用配置的固定值
// ==========================================

import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Thinking")

// ── 任务复杂度判断关键词 ──

/** 关键程度 → 触发 high（多步推理） */
const HIGH_KEYWORDS = [
  "分析", "整理", "总结", "重构", "优化", "修复", "调试",
  "修改", "创建", "部署", "迁移", "配置",
  "代码", "项目", "系统", "数据库",
]

/** 关键程度 → 触发 medium（单步工具） */
const MEDIUM_KEYWORDS = [
  "帮我", "查看", "打开", "搜索", "找一下", "查一下",
  "看看", "文件", "文件夹", "桌面", "下载",
  "天气", "时间", "日期", "运行",
  "命令", "信息", "状态",
]

// ── 工具调用计数历史（用于 auto 模式下动态升级）──
let toolCallCountInTurn = 0

export function resetToolCallCount(): void {
  toolCallCountInTurn = 0
}

export function incrementToolCallCount(): void {
  toolCallCountInTurn++
}

export function getToolCallCount(): number {
  return toolCallCountInTurn
}

// ── 决策函数 ──

/**
 * 根据任务上下文决定思考强度。
 * @param userText 用户输入文本
 * @param isActiveMessage 是否为窗口主动搭话
 * @param isRetry 是否为错误重试
 * @returns 思考强度
 */
export function decideThinkingEffort(
  userText: string,
  isActiveMessage: boolean = false,
  isRetry: boolean = false,
): ThinkingEffort {
  const configured = aiConfig.thinkingEffort

  // 手动模式：直接使用配置值
  if (configured !== "auto") {
    return configured
  }

  // ── auto 模式 ──

  // 错误重试 → high
  if (isRetry) {
    log.debug("auto → high (重试)")
    return "high"
  }

  // 窗口主动搭话 → low
  if (isActiveMessage) {
    log.debug("auto → low (主动搭话)")
    return "low"
  }

  // 工具调用 ≥2 轮 → high
  if (toolCallCountInTurn >= 2) {
    log.debug("auto → high (多轮工具调用)")
    return "high"
  }

  // 关键词检测
  const text = userText
  const hasHigh = HIGH_KEYWORDS.some(kw => text.includes(kw))
  if (hasHigh) {
    log.debug("auto → high (复杂任务关键词)")
    return "high"
  }

  const hasMedium = MEDIUM_KEYWORDS.some(kw => text.includes(kw))
  if (hasMedium) {
    log.debug("auto → medium (工具请求关键词)")
    return "medium"
  }

  // 默认 → low（闲聊快速响应）
  log.debug("auto → low (闲聊)")
  return "low"
}

/**
 * 获取对应思考强度的 thinking budget（tokens）。
 */
export function getThinkingBudget(effort: ThinkingEffort): number {
  switch (effort) {
    case "low": return aiConfig.thinkingBudget.low
    case "medium": return aiConfig.thinkingBudget.medium
    case "high": return aiConfig.thinkingBudget.high
    default: return aiConfig.thinkingBudget.medium
  }
}

// ── F12 调试 ──
if (typeof window !== "undefined") {
  (window as any).__thinking = {
    decide: decideThinkingEffort,
    reset: resetToolCallCount,
    count: getToolCallCount,
  }
}
