// ==========================================
// Context construction: assemble immutable blocks; kernel owns all selection.
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
import type { ContextBlock } from "@/services/engine/runtime"
import type { MemoryProjection } from "@/services/agent/memory"
import { buildContextKernel } from "./kernel"
import { contextBudget, estimateContextTokens, toolBudgetSchema, type ContextBudget } from "./budget"
import { createUserProfileProjection, memoryProjectionBlocks, profileProjectionBlock } from "./projection"

export interface BuildContextInput {
  recentMessages: Message[]
  /** Durable ingress already contains the current input, including after tool turns. */
  currentInputInTranscript?: boolean
  userText: string
  unansweredCount?: number
  thinkingEffort: ThinkingEffort
  isActiveMessage?: boolean
  memoryProjections?: MemoryProjection[]
  sessionSummary?: string
  ephemeralText?: string
  ephemeralOrigin?: "active" | "hook" | "recovery" | "plan"
  /** Run-preflight 冻结快照；调用方未提供时回退到当前配置与注册表。 */
  mode?: "pet" | "assistant"
  contextMaxTokens?: number
  maxOutputTokens?: number
  tools?: ToolDeclaration[]
  dynamicPrompt?: string
  candyInstructions?: string
  userProfileText?: string
  skillsPromptBlock?: string
}

export interface BuildContextOutput {
  systemPrompt: string
  tools: ToolDeclaration[]
  estimatedSystemTokens: number
  estimatedInputTokens: number
  contextMaxTokens: number
  budget: ContextBudget
  overNormalTarget: boolean
  staticPrefix: string
  sessionStatic: string
  turnDynamic: string
  blocks: ContextBlock[]
  recentMessages: Message[]
  inputTokenBudget: number
  budgetAdjustments: import("./kernel").ContextBudgetAdjustment[]
  allocations: import("@/services/engine/runtime").ContextAllocation[]
}

function cardStaticPrompt(card: PersonalityCard | null): string {
  const sections = card?.sections
  if (!sections) return `你是一个桌面助手。准确、完整地回答用户问题。\n\n要求:\n- 使用 markdown 组织信息\n- 技术问题给出具体方案，不要模糊\n- 不会就说不知道，但尝试提供线索\n- 回复长度按问题复杂度自然调整`
  const pieces = [sections.roleSetting, sections.languageStyle, sections.outputRules]
  // Card is frozen at run start: role, emotions, whenText and must rules all belong to the static prefix.
  if (sections.emotionMappings.length) pieces.push(formatEmotionForPrompt(sections.emotionMappings))
  if (sections.whenText) pieces.push(`[语气指引]\n${sections.whenText}`)
  if (sections.mustRules.all.length) pieces.push(formatAllRules(sections.mustRules))
  return pieces.filter(Boolean).join("\n\n")
}

function runtimeDynamicPrompt(pool: VariablePool, effort: ThinkingEffort): string {
  let prompt = formatPoolForPrompt(pool)
  if (effort === "low") prompt += "\n[请快速简要回答]"
  else if (effort === "high") prompt += "\n[请仔细深入思考]"
  return prompt
}

function decideTools(input: BuildContextInput): ToolDeclaration[] {
  if (input.isActiveMessage) return []
  return input.tools ?? getToolDeclarations(input.mode)
}

/** Builds complete, taint-preserving blocks. It never clips Card/CANDY/User/schema text. */
export function buildPrompt(input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool): BuildContextOutput {
  const mode = input.mode ?? "assistant"
  const contextMaxTokens = input.contextMaxTokens ?? aiConfig.contextMaxTokens
  const budget = contextBudget(contextMaxTokens, input.maxOutputTokens)
  const tools = decideTools(input)
  const candy = input.candyInstructions ?? MemoryService.getCandyInstructionsSync()
  const userProfile = input.userProfileText ?? MemoryService.getUserProfileSync()
  const profileProjection = createUserProfileProjection(userProfile)
  const toolProtocol = tools.length
    ? "你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
    : "请简短口语化回复。"
  const skillCatalog = tools.length ? (input.skillsPromptBlock ?? getSkillsPromptBlock({ mode })) : ""
  const toolSchemaSnapshot = tools.length ? JSON.stringify(tools.map(toolBudgetSchema)) : ""
  const dynamic = input.dynamicPrompt ?? runtimeDynamicPrompt(pool, input.thinkingEffort)

  const kernel = buildContextKernel([
    { blockId: "static:card", layer: "static", source: "personality-card", text: cardStaticPrompt(card), priority: 100, origin: "system", taint: "system" },
    { blockId: "static:candy", layer: "static", source: "CANDY.md", text: candy, priority: 99, origin: "system", taint: "system" },
    { blockId: "static:tool-protocol", layer: "static", source: "tool-protocol", text: toolProtocol, priority: 98, origin: "system", taint: "system" },
    // Provider sends declarations independently. This complete block only records their frozen budget/snapshot and stays out of systemPrompt.
    { blockId: "static:tool-schema", layer: "static", source: "tool-schema", text: toolSchemaSnapshot, priority: 97, origin: "system", taint: "system" },
    { blockId: "static:skill-catalog", layer: "static", source: "skill-catalog", text: skillCatalog, priority: 96, origin: "system", taint: "system" },
    { blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: dynamic, priority: 90, origin: "system", taint: "system" },
    profileProjectionBlock(profileProjection),
    // Summary remains derived session data; it never inherits CANDY's system-instruction taint.
    { blockId: "memory:session-summary", layer: "memory", source: "session-summary", text: input.sessionSummary ?? "", priority: 70, origin: "assistant", taint: "derived" },
    ...memoryProjectionBlocks(input.memoryProjections ?? []),
    { blockId: "transcript:history", layer: "transcript", source: "session", text: "", priority: 60, origin: "assistant", taint: "derived" },
    { blockId: `ephemeral:${input.ephemeralOrigin ?? (input.isActiveMessage ? "active" : "none")}`,
      layer: "ephemeral", source: input.ephemeralOrigin ?? (input.isActiveMessage ? "active_monitor" : "none"),
      text: input.ephemeralText ?? "", priority: 50,
      origin: input.ephemeralOrigin ?? (input.isActiveMessage ? "active" : "system"), taint: "derived" },
  ], input.recentMessages, contextMaxTokens, { budget, currentInput: input.currentInputInTranscript ? undefined : input.userText })

  return { systemPrompt: kernel.systemPrompt, tools, estimatedSystemTokens: estimateContextTokens(kernel.systemPrompt),
    estimatedInputTokens: kernel.estimatedInputTokens, contextMaxTokens, budget: kernel.budget, overNormalTarget: kernel.overNormalTarget,
    staticPrefix: kernel.staticPrefix, sessionStatic: kernel.sessionStatic, turnDynamic: kernel.turnDynamic,
    blocks: kernel.blocks, recentMessages: kernel.messages, inputTokenBudget: kernel.inputTokenBudget, budgetAdjustments: kernel.budgetAdjustments, allocations: kernel.allocations }
}
