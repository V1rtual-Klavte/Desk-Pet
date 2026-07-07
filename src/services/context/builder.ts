// ==========================================
// 上下文引擎 v4 — Phase1/Phase2 分离
// ==========================================

import type { Message, ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { getToolDeclarations } from "@/services/tool/registry"
import { MemoryService } from "@/services/agent/memory"
import { modeConfig, aiConfig } from "@/services/config"
import { formatPoolForPrompt, getPoolSnapshot } from "@/services/personality/variable-pool"
import { evaluateWhenEngine } from "@/services/personality/when-engine"
import { formatToolRules, formatAllRules } from "@/services/personality/must-rules"
import { formatEmotionForPrompt } from "@/services/personality/emotion"
import type { PersonalityCard } from "@/services/personality/types"
import type { VariablePool } from "@/services/personality/variable-pool"
import { createLogger } from "@/services/logger"

const log = createLogger("Context")

// ── 类型 ──

export interface BuildContextInput {
  recentMessages: Message[]
  userText: string
  unansweredCount?: number
  thinkingEffort: ThinkingEffort
  isActiveMessage?: boolean
}

export interface BuildContextOutput {
  systemPrompt: string; tools: ToolDeclaration[]
  estimatedSystemTokens: number; contextMaxTokens: number
}

export interface Phase1Output {
  systemPrompt: string; tools: ToolDeclaration[]
  estimatedSystemTokens: number; contextMaxTokens: number
}

export interface Phase2Input {
  card: PersonalityCard; rawReply: string; userText: string
  pool: VariablePool; toolCallSummary: string
}

export interface Phase2Output {
  systemPrompt: string; userMessage: string; thinkingEffort: string
}

const TOOL_KEYWORDS = ["帮我","查看","打开","搜索","找","整理","分析","检查","文件","文件夹","桌面","下载","代码","项目","系统","运行","执行","命令","天气","时间","日期"]

// ── Phase1: 零身份能力层 ──

export function buildCapabilityPrompt(
  input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool,
): Phase1Output {
  const { userText, thinkingEffort, isActiveMessage } = input

  let systemPrompt = `你是一个桌面助手。准确、完整地回答用户问题。

要求:
- 使用 markdown 组织信息
- 技术问题给出具体方案，不要模糊
- 不会就说不知道，但尝试提供线索
- 回复长度按问题复杂度自然调整
- 不需要 kaomoji 或颜文字，不需要扮演角色
- 不要自称，不要有名字`

  // 变量池
  systemPrompt += `\n\n${formatPoolForPrompt()}`

  // 必须遵守 (工具相关)
  if (card) systemPrompt += formatToolRules(card.sections.mustRules)

  // 记忆
  const candy = MemoryService.getCandyInstructionsSync()
  const user = MemoryService.getUserProfileSync()
  const sess = MemoryService.getCompactionSummarySync()
  if (candy) systemPrompt += candy
  if (user) systemPrompt += user
  if (sess) systemPrompt += sess

  // 工具
  const tools = decideTools(userText, isActiveMessage ?? false)

  systemPrompt += tools.length > 0
    ? "\n\n你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
    : "\n\n请简短口语化回复，不用 markdown。"

  if (thinkingEffort === "low") systemPrompt += "\n[请快速简要回答]"
  else if (thinkingEffort === "high") systemPrompt += "\n[请仔细深入思考]"

  return {
    systemPrompt, tools,
    estimatedSystemTokens: Math.ceil(systemPrompt.length / 2.5),
    contextMaxTokens: aiConfig.contextMaxTokens,
  }
}

// ── Phase2: 角色风格层 ──

export function buildStylePrompt(input: Phase2Input): Phase2Output {
  const { card, rawReply, userText, pool, toolCallSummary } = input
  const s = card.sections

  let systemPrompt = `${s.roleSetting}\n\n${s.languageStyle}\n\n${s.outputRules}`

  if (s.emotionMappings.length > 0) systemPrompt += `\n\n${formatEmotionForPrompt(s.emotionMappings)}`

  const hitRule = evaluateWhenEngine(s.whenRules, pool)
  if (hitRule) systemPrompt += `\n\n[当前状态]\n${hitRule.tone}`

  if (s.mustRules.all.length > 0) systemPrompt += `\n\n${formatAllRules(s.mustRules)}`

  systemPrompt += `\n\n${formatPoolForPrompt()}`

  let userMessage = `用户问: ${userText}`
  if (toolCallSummary) userMessage += `\n\n[执行过程]\n${toolCallSummary}`
  userMessage += `\n\n请用你的风格重新表达以下回复。保持信息完整，不要丢失关键信息（代码、数字、链接、步骤顺序等）。回复开头必须携带情绪标签 [emo:key]。\n\n${rawReply}`

  return { systemPrompt, userMessage, thinkingEffort: "low" }
}

export function summarizeToolCalls(history: { toolName: string; status: string }[]): string {
  if (history.length === 0) return ""
  return history.map(h => `- ${h.toolName}: ${h.status}`).join("\n")
}

// ── 工具决策 ──

function decideTools(userText: string, isActive: boolean): ToolDeclaration[] {
  if (isActive) return []
  if (!modeConfig.assistant) return getToolDeclarations("pet")
  if (!TOOL_KEYWORDS.some(kw => userText.includes(kw))) return []
  return getToolDeclarations()
}
