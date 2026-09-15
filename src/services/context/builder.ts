// ==========================================
// 上下文引擎 — 单次 Prompt 构建
// 角色内容上移到 system prompt，一步生成角色化回复
// ==========================================

import type { Message, ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { getToolDeclarations } from "@/services/tool/registry"
import { MemoryService } from "@/services/agent/memory"
import { aiConfig } from "@/services/config"
import { getSkillsPromptBlock } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { formatAllRules } from "@/services/personality/must-rules"
import { formatEmotionForPrompt } from "@/services/personality/emotion"
import type { PersonalityCard } from "@/services/personality/types"
import type { VariablePool } from "@/services/personality/variable-pool"
import { createLogger } from "@/services/logger"
import { buildContextKernel } from "./kernel"
import type { ContextBlock } from "@/services/engine/runtime"
import type { MemoryProjection } from "@/services/agent/memory"
import { createUserProfileProjection, memoryProjectionBlocks, profileProjectionBlock } from "./projection"

const log = createLogger("Context")

// ── 类型 ──

export interface BuildContextInput {
  recentMessages: Message[]
  userText: string
  unansweredCount?: number
  thinkingEffort: ThinkingEffort
  isActiveMessage?: boolean
  memoryProjections?: MemoryProjection[]
  ephemeralText?: string
  ephemeralOrigin?: "active" | "hook" | "recovery" | "plan"
}

export interface BuildContextOutput {
  systemPrompt: string; tools: ToolDeclaration[]
  estimatedSystemTokens: number; contextMaxTokens: number
  blocks: ContextBlock[]
  recentMessages: Message[]
  inputTokenBudget: number
  budgetAdjustments: import("./kernel").ContextBudgetAdjustment[]
}

// ── 统一 Prompt 构建 ──

export function buildPrompt(
  input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool,
): BuildContextOutput {
  const { thinkingEffort, isActiveMessage } = input
  const s = card?.sections

  // ── ① 角色设定 (WHO) ──
  let rolePrompt = ""
  if (s) {
    rolePrompt += `${s.roleSetting}\n\n${s.languageStyle}\n\n${s.outputRules}`
  } else {
    // 无 Card（neutral 兜底不应发生，但保留回退）
    rolePrompt = `你是一个桌面助手。准确、完整地回答用户问题。

要求:
- 使用 markdown 组织信息
- 技术问题给出具体方案，不要模糊
- 不会就说不知道，但尝试提供线索
- 回复长度按问题复杂度自然调整
`
  }

  // ── ② 情绪表达 (EMOTION) ──
  if (s && s.emotionMappings.length > 0) {
    rolePrompt += `\n\n${formatEmotionForPrompt(s.emotionMappings)}`
  }

  // ── ③ When 语气 ──
  if (s?.whenText) {
    rolePrompt += `\n\n[语气指引]\n${s.whenText}`
  }

  // ── ④ 行为准则 ──
  if (s && s.mustRules.all.length > 0) {
    rolePrompt += `\n\n${formatAllRules(s.mustRules)}`
  }

  // ── ⑤ 工具声明（先决定工具有哪些）──
  const tools = decideTools(isActiveMessage ?? false)

  // ── ⑥ 变量池（始终注入）──
  let dynamicPrompt = formatPoolForPrompt()

  // ── ⑧ 记忆 ──
  const candy = MemoryService.getCandyInstructionsSync()
  const user = MemoryService.getUserProfileSync()
  const sess = MemoryService.getCompactionSummarySync()
  const memoryPrompt = `${candy}${sess}`
  const profileProjection = createUserProfileProjection(user)

  // ── ⑨ 工具提示 ──
  if (tools.length > 0) {
    dynamicPrompt += "\n\n你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
    // Skill 清单只在有工具时注入：模型要靠 read 工具才能加载正文。
    dynamicPrompt += getSkillsPromptBlock()
  } else {
    dynamicPrompt += "\n\n请简短口语化回复。"
  }

  if (thinkingEffort === "low") dynamicPrompt += "\n[请快速简要回答]"
  else if (thinkingEffort === "high") dynamicPrompt += "\n[请仔细深入思考]"

  const kernel = buildContextKernel([
    { blockId: "static:card", layer: "static", source: "personality-card", text: rolePrompt, priority: 100, origin: "system", taint: "system" },
    { blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: dynamicPrompt, priority: 90, origin: "system", taint: "system" },
    profileProjectionBlock(profileProjection),
    { blockId: "memory:session", layer: "memory", source: "CANDY.md+session-summary", text: memoryPrompt, priority: 70, origin: "memory", taint: "derived" },
    ...memoryProjectionBlocks(input.memoryProjections ?? []),
    { blockId: "transcript:history", layer: "transcript", source: "session", text: "", priority: 60, origin: "assistant", taint: "derived" },
    {
      blockId: `ephemeral:${input.ephemeralOrigin ?? (isActiveMessage ? "active" : "none")}`,
      layer: "ephemeral",
      source: input.ephemeralOrigin ?? (isActiveMessage ? "active_monitor" : "none"),
      text: input.ephemeralText ?? (isActiveMessage ? input.userText : ""),
      priority: 50,
      origin: input.ephemeralOrigin ?? (isActiveMessage ? "active" : "system"),
      taint: "derived",
    },
  ], input.recentMessages, aiConfig.contextMaxTokens)

  return {
    systemPrompt: kernel.systemPrompt, tools,
    estimatedSystemTokens: Math.ceil(kernel.systemPrompt.length / 2.5),
    contextMaxTokens: aiConfig.contextMaxTokens,
    blocks: kernel.blocks,
    recentMessages: kernel.messages,
    inputTokenBudget: kernel.inputTokenBudget,
    budgetAdjustments: kernel.budgetAdjustments,
  }
}

// ── 工具决策 ──

function decideTools(isActive: boolean): ToolDeclaration[] {
  if (isActive) return []
  return getToolDeclarations()
}
