// ==========================================
// 上下文引擎 v5 — 单次 Prompt 构建
// 角色内容上移到 system prompt，一步生成角色化回复
// ==========================================

import type { Message, ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { getToolDeclarations } from "@/services/tool/registry"
import { MemoryService } from "@/services/agent/memory"
import { modeConfig, aiConfig } from "@/services/config"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { evaluateWhenEngine } from "@/services/personality/when-engine"
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

const TOOL_KEYWORDS = ["帮我", "查看", "打开", "搜索", "找", "整理", "分析", "检查", "文件", "文件夹", "桌面", "下载", "代码", "项目", "系统", "运行", "执行", "命令", "天气", "时间", "日期"]

// ── v5: 统一 Prompt 构建 ──

export function buildPrompt(
  input: BuildContextInput, card: PersonalityCard | null, pool: VariablePool,
): BuildContextOutput {
  const { userText, thinkingEffort, isActiveMessage } = input
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
  if (s) {
    const hitRule = evaluateWhenEngine(s.whenRules, pool)
    if (hitRule) systemPrompt += `\n\n[当前状态]\n${hitRule.tone}`
  }

  // ── ④ 行为准则 ──
  if (s && s.mustRules.all.length > 0) {
    systemPrompt += `\n\n${formatAllRules(s.mustRules)}`
  }

  // ── ⑤ 变量池 ──
  systemPrompt += `\n\n${formatPoolForPrompt()}`

  // ── ⑥ 变量操作规则 ──
  systemPrompt += `\n\n[变量操作规则]
- 系统变量（system）只读，不可写。
- 互动状态（interaction）只读，不可写。
- 会话状态（session）只读，不可写。
- 使用 var_read 读取变量，var_list 列出全部变量。`

  if (s) {
    const cardDefs = s.variableDefs.filter(d => d.scope === "card" && d.updateBy === "llm")
    if (cardDefs.length > 0) {
      systemPrompt += `\n- 以下 Card 变量可通过 var_write 更新: ${cardDefs.map(d => `${d.name}(${d.type})`).join(", ")}`
      systemPrompt += `\n- 如果用户本轮消息明确影响了某个 Card 变量，请调用 var_write 更新。`
      systemPrompt += `\n- 不要为了更新而更新；没有明确变化时不要写变量。`
      systemPrompt += `\n- 写入值必须符合变量的类型、范围（min/max）和可选值（enum）约束。`
    } else {
      systemPrompt += `\n- 当前 Card 无可写的 llm 变量，var_write/var_delete 不可用。`
    }
  } else {
    systemPrompt += `\n- 当前无激活 Card，var_write/var_delete 不可用。`
  }

  // ── ⑦ 记忆 ──
  const candy = MemoryService.getCandyInstructionsSync()
  const user = MemoryService.getUserProfileSync()
  const sess = MemoryService.getCompactionSummarySync()
  if (candy) systemPrompt += candy
  if (user) systemPrompt += user
  if (sess) systemPrompt += sess

  // ── ⑧ 工具声明 ──
  const tools = decideTools(userText, isActiveMessage ?? false)

  // 工具提示
  const hasVarWrite = tools.some(t => t.function.name === "var_write")
  const hasGeneralTools = tools.some(t => !t.function.name.startsWith("var_"))
  if (tools.length > 0) {
    if (hasGeneralTools && hasVarWrite) {
      systemPrompt += "\n\n你可以使用工具完成任务（包括 var_write 更新 Card 变量）。需要工具时只输出工具调用。完成后基于结果简短回复。"
    } else if (hasGeneralTools) {
      systemPrompt += "\n\n你可以使用工具完成任务。需要工具时只输出工具调用。完成后基于结果简短回复。"
    } else {
      systemPrompt += "\n\n你可以使用 var_read/var_list 查看变量状态。不需要工具时直接回复。"
    }
  } else {
    systemPrompt += "\n\n请简短口语化回复，不用 markdown。"
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

function decideTools(userText: string, isActive: boolean): ToolDeclaration[] {
  if (!modeConfig.assistant) {
    // Pet 模式：始终带工具，但主动搭话时只给变量只读工具
    const allTools = getToolDeclarations("pet")
    if (isActive) {
      const VAR_READONLY = ["var_read", "var_list"]
      return allTools.filter(t => VAR_READONLY.includes(t.function.name))
    }
    return allTools
  }
  if (isActive) return []
  if (!TOOL_KEYWORDS.some(kw => userText.includes(kw))) return []
  return getToolDeclarations()
}
