// ==========================================
// Context construction: assemble immutable blocks. The kernel only does budget
// math and the hard-limit decision — the request view is owned by the Harness.
// ==========================================

import type { ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { listAll, toToolDeclaration } from "@/services/tool"
import { MemoryService } from "@/services/agent/memory"
import { aiConfig } from "@/services/config"
import { getSkillsPromptBlock } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { formatAllRules } from "@/services/personality/must-rules"
import type { PersonalityCard } from "@/services/personality/types"
import type { VariablePool } from "@/services/personality/variable-pool"
import type { ContextBlock } from "@/services/engine/runtime"
import type { MemoryProjection } from "@/services/agent/memory"
import { buildPromptBlocks } from "./kernel"
import type { ContextBudgetAdjustment } from "./kernel"
import { contextBudget, toolBudgetSchema, type ContextBudget } from "./budget"
import { createUserProfileProjection, memoryProjectionBlocks, profileProjectionBlock } from "./projection"

export interface BuildContextInput {
  unansweredCount?: number
  thinkingEffort: ThinkingEffort
  isActiveMessage?: boolean
  memoryProjections?: MemoryProjection[]
  sessionSummary?: string
  ephemeralText?: string
  ephemeralOrigin?: "active" | "hook" | "recovery" | "plan"
  /** Run-preflight 冻结快照；调用方未提供时回退到当前配置与注册表。 */
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
  estimatedInputTokens: number
  contextMaxTokens: number
  budget: ContextBudget
  staticPrefix: string
  turnDynamic: string
  blocks: ContextBlock[]
  inputTokenBudget: number
  /** 被整块淘汰的可选块（内核产出）：审计与快照读它，不再有第二轮借用计算。 */
  budgetDrops: ContextBudgetAdjustment[]
  allocations: import("@/services/engine/runtime").ContextAllocation[]
}

/**
 * RUNTIME_DATA 协议说明。解析侧是 `reply/generator.ts` 的 `RUNTIME_RE`，改动时两处必须对齐。
 * 只在 Card 声明了可被模型写入的变量时注入：没有可写目标时这段只是白占静态前缀。
 */
const RUNTIME_DATA_INSTRUCTION = `[回复元数据]
你的回复末尾必须附加一个 RUNTIME_DATA 区块，系统自动剥离，用户不可见。

格式：
<RUNTIME_DATA>
<变量名>: <值>
</RUNTIME_DATA>

- 每轮都必须附带该区块；Card 变量有变化时逐行写入（变量名: 新值），没有变化则留空区块`

function cardStaticPrompt(card: PersonalityCard | null): string {
  const sections = card?.sections
  if (!sections) return `你是一个桌面助手。准确、完整地回答用户问题。\n\n要求:\n- 使用 markdown 组织信息\n- 技术问题给出具体方案，不要模糊\n- 不会就说不知道，但尝试提供线索\n- 回复长度按问题复杂度自然调整`
  const pieces = [sections.roleSetting, sections.languageStyle, sections.outputRules]
  // RUNTIME_DATA 是模型写 Card 变量的唯一通道；Card 没有可写变量时不注入，省静态前缀。
  if (sections.variableDefs.some(def => def.scope === "card" && def.updateBy === "llm")) {
    pieces.push(RUNTIME_DATA_INSTRUCTION)
  }
  // Card is frozen at run start: role, whenText and must rules all belong to the static prefix.
  if (sections.whenText) pieces.push(`[语气指引]\n${sections.whenText}`)
  if (sections.mustRules.all.length) pieces.push(formatAllRules(sections.mustRules))
  return pieces.filter(Boolean).join("\n\n")
}

/** 聊天回合的思考强度提示（与一次性请求的提示刻意不同，各自用途见常量注释）。 */
export const CHAT_THINKING_HINTS: Record<"low" | "high", string> = {
  low: "\n[请快速简要回答]",
  high: "\n[请仔细深入思考]",
}

/**
 * 一次性调用（planner/compaction/memory/stages）在非推理模型 + low 时的兜底提示。
 *
 * 它替的是「端点不认 reasoning_effort」这件事，比聊天回合的提示多一句「不需要过多思考」；
 * 两个用途的文案必须保持不同，合并会让其中一边失去自己的语义。
 */
export const ONE_SHOT_LOW_EFFORT_HINT = "\n\n[请快速简要回答，不需要过多思考]"

/** 星期文案的唯一取用点，下标即 `Date.getDay()` 的口径（0 = 周日）。 */
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const

/**
 * 当前日期与时间的唯一取用点。**定长**：`[当前时间] YYYY-MM-DD HH:mm 周X`，恒为 26 字符
 * （约 11 tokens：非 ASCII 1 token/字符、ASCII 1/4 token），不随输入或窗口变化。
 *
 * 分钟精度足够：秒级不给出额外信息，只会让每个回合的请求视图都不同。
 */
function currentTimeNote(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `[当前时间] ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())} ${WEEKDAY_LABELS[now.getDay()]}`
}

/**
 * 变量池正文 + 思考强度后缀 + 当前时间的唯一拼接点（聊天动态提示与冻结上下文都走它）。
 *
 * 时间片段排在末尾：它每回合都变，排在它之后的内容会一起失去 Provider 的前缀缓存收益，
 * 而变量池正文在变量没变时是稳定的。它落在 dynamic 层的 `dynamic:runtime` 核心块里
 * （`buildPrompt`），定长规模，不会把核心块撑爆；也不进 static 前缀与 `cache.prefixHash`。
 */
export function composeDynamicPrompt(poolText: string, effort: ThinkingEffort): string {
  const withEffort = effort === "low" ? `${poolText}${CHAT_THINKING_HINTS.low}`
    : effort === "high" ? `${poolText}${CHAT_THINKING_HINTS.high}`
      : poolText
  return `${withEffort}\n${currentTimeNote()}`
}

function runtimeDynamicPrompt(pool: VariablePool, effort: ThinkingEffort): string {
  return composeDynamicPrompt(formatPoolForPrompt(pool), effort)
}

function decideTools(input: BuildContextInput): ToolDeclaration[] {
  if (input.isActiveMessage) return []
  return input.tools ?? listAll().map(toToolDeclaration)
}

/** Builds complete, taint-preserving blocks. It never clips Card/CANDY/User/schema text. */
export function buildPrompt(input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool): BuildContextOutput {
  const contextMaxTokens = input.contextMaxTokens ?? aiConfig.contextMaxTokens
  const budget = contextBudget(contextMaxTokens, input.maxOutputTokens)
  const tools = decideTools(input)
  const candy = input.candyInstructions ?? MemoryService.getCandyInstructionsSync()
  const userProfile = input.userProfileText ?? MemoryService.getUserProfileSync()
  const profileProjection = createUserProfileProjection(userProfile)
  const toolProtocol = tools.length
    ? "你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
    : "请简短口语化回复。"
  const skillCatalog = tools.length ? (input.skillsPromptBlock ?? getSkillsPromptBlock()) : ""
  const toolSchemaSnapshot = tools.length ? JSON.stringify(tools.map(toolBudgetSchema)) : ""
  const dynamic = input.dynamicPrompt ?? runtimeDynamicPrompt(pool, input.thinkingEffort)

  const kernel = buildPromptBlocks([
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
    { blockId: `ephemeral:${input.ephemeralOrigin ?? (input.isActiveMessage ? "active" : "none")}`,
      layer: "ephemeral", source: input.ephemeralOrigin ?? (input.isActiveMessage ? "active_monitor" : "none"),
      text: input.ephemeralText ?? "", priority: 50,
      origin: input.ephemeralOrigin ?? (input.isActiveMessage ? "active" : "system"), taint: "derived" },
  ], contextMaxTokens, { budget })

  return { systemPrompt: kernel.systemPrompt, tools,
    estimatedInputTokens: kernel.estimatedInputTokens, contextMaxTokens, budget: kernel.budget,
    staticPrefix: kernel.staticPrefix, turnDynamic: kernel.turnDynamic,
    blocks: kernel.blocks, inputTokenBudget: kernel.inputTokenBudget, budgetDrops: kernel.budgetDrops, allocations: kernel.allocations }
}
