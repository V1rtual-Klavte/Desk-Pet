// ==========================================
// 上下文引擎 — 单次 Prompt 构建
// 角色内容上移到 system prompt，一步生成角色化回复
// ==========================================

import type { Message, ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { getToolDeclarations } from "@/services/tool/registry"
import { MemoryService } from "@/services/agent/memory"
import { aiConfig } from "@/services/config"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { formatAllRules } from "@/services/personality/must-rules"
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

// ── 统一 Prompt 构建 ──

export function buildPrompt(
  input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool,
): BuildContextOutput {
  const { thinkingEffort, isActiveMessage } = input
  const s = card?.sections

  // ── ① 角色设定 (WHO) ──
  let systemPrompt = ""
  if (s) {
    systemPrompt += `${s.roleSetting}\n\n${s.languageStyle}\n\n${s.outputRules}`
  } else {
    // 无 Card（neutral 兜底不应发生，但保留回退）
    systemPrompt = `你是一个桌面助手。准确、完整地回答用户问题。

要求:
- 使用 markdown 组织信息
- 技术问题给出具体方案，不要模糊
- 不会就说不知道，但尝试提供线索
- 回复长度按问题复杂度自然调整
`
  }

  // ── ② 情绪表达 (EMOTION) ──
  if (s && s.emotionMappings.length > 0) {
    systemPrompt += `\n\n${formatEmotionForPrompt(s.emotionMappings)}`
  }

  // ── ③ When 语气 ──
  if (s?.whenText) {
    systemPrompt += `\n\n[语气指引]\n${s.whenText}`
  }

  // ── ④ 行为准则 ──
  if (s && s.mustRules.all.length > 0) {
    systemPrompt += `\n\n${formatAllRules(s.mustRules)}`
  }

  // ── ⑤ 工具声明（先决定工具有哪些）──
  const tools = decideTools(isActiveMessage ?? false)

  // ── ⑥ 变量池（始终注入）──
  systemPrompt += `\n\n${formatPoolForPrompt()}`

  // ── ⑧ 记忆 ──
  const candy = MemoryService.getCandyInstructionsSync()
  const user = MemoryService.getUserProfileSync()
  const sess = MemoryService.getCompactionSummarySync()
  if (candy) systemPrompt += candy
  if (user) systemPrompt += user
  if (sess) systemPrompt += sess

  // ── ⑨ 工具提示 ──
  if (tools.length > 0) {
    systemPrompt += "\n\n你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
  } else {
    systemPrompt += "\n\n请简短口语化回复。"
  }

  if (thinkingEffort === "low") systemPrompt += "\n[请快速简要回答]"
  else if (thinkingEffort === "high") systemPrompt += "\n[请仔细深入思考]"

  return {
    systemPrompt, tools,
    estimatedSystemTokens: Math.ceil(systemPrompt.length / 2.5),
    contextMaxTokens: aiConfig.contextMaxTokens,
  }
}

// ── 工具决策 ──

function decideTools(isActive: boolean): ToolDeclaration[] {
  if (isActive) return []
  return getToolDeclarations()
}
