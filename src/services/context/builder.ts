// ==========================================
// 上下文引擎 —— 每次请求前动态组装 SystemPrompt
// 组装顺序:
//   1. 人格 Prompt (card + boundary)
//   2. Memory 注入 (相关记忆 topK)
//   3. 工具声明 (按模式 + 任务类型)
//   4. 输出约束
//   5. 思考强度提示 (low/high)
// ==========================================

import type { Message, ToolDeclaration, ThinkingEffort } from "@/services/agent/types"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import { getToolDeclarations } from "@/services/tool/registry"
import { MemoryService } from "@/services/agent/memory"
import { modeConfig, aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Context")

export interface BuildContextInput {
  recentMessages: Message[]
  userText: string
  unansweredCount?: number
  thinkingEffort: ThinkingEffort
  isActiveMessage?: boolean
}

export interface BuildContextOutput {
  systemPrompt: string
  tools: ToolDeclaration[]
  estimatedSystemTokens: number
  contextMaxTokens: number
}

const COMPACT_THRESHOLD = 0.95

// ── 工具关键词（用于判断是否需要注入工具声明）──
const TOOL_KEYWORDS = [
  "帮我", "查看", "打开", "搜索", "找", "整理", "分析", "检查",
  "文件", "文件夹", "桌面", "下载", "代码", "项目", "系统",
  "运行", "执行", "命令", "天气", "时间", "日期",
]

/**
 * 动态组装 SystemPrompt + 工具声明。
 * 轻量模式：始终携带 6 个工具 (~150 tokens)
 * 助手模式：L0/L1/L2 三级注入
 */
export function buildContext(input: BuildContextInput): BuildContextOutput {
  const { userText, unansweredCount, thinkingEffort, isActiveMessage } = input

  // ── 1. 人格 Prompt (必须) ──
  const personaPrompt = PetPersonalityMiddleware.getSystemPrompt(unansweredCount)

  // ── 2. CANDY.md + User.md 注入 ──
  const candyBlock = MemoryService.getCandyInstructionsSync()
  const userBlock = MemoryService.getUserProfileSync()

  // ── 3. 会话记忆注入（压缩摘要）──
  const sessionBlock = MemoryService.getCompactionSummarySync()

  // ── 4. Memory 搜索注入 ──
  const memoryBlock = buildMemoryInjection(userText)

  // ── 4. 工具声明 (按模式 + 任务类型) ──
  const tools = decideToolInject(userText, isActiveMessage ?? false)

  // ── 4. 输出约束 ──
  const hasTools = tools.length > 0
  const formatConstraint = (hasTools
    ? "\n\n你可以使用上面列出的工具来完成任务。如果需要使用工具，请只输出工具调用，不要输出文本。完成所有工具调用后，基于结果给出简短友好的中文回复。可以加 kaomoji 表情，不要用 markdown。"
    : "\n\n请用简短的口语化中文回复，像在和朋友聊天一样。可以加 kaomoji 表情，不要用 markdown。")
    // ★ 覆盖人格卡的纯聊天倾向：你是助手，能回答任何问题，只是通过人设表达
    + "\n\n[重要] 你是一个会帮主人解决问题的桌面助手。无论主人问什么（技术、生活、知识、闲聊），你都要认真回答、帮助解决，用你的个性和语气表达出来。如果不会或不确定，诚实说不知道但试着帮忙。你不是只会撒娇的宠物，你是会思考、会用工具的伙伴♡"

  // ── 5. 思考强度提示 ──
  const thinkingHint = thinkingEffort === "low"
    ? "\n[请快速简要回答]"
    : thinkingEffort === "high"
      ? "\n[请仔细深入思考后回答]"
      : ""

  // ── 拼合 ──
  const systemPrompt = personaPrompt + candyBlock + userBlock + sessionBlock + memoryBlock + formatConstraint + thinkingHint
  const estimatedSystemTokens = Math.ceil(systemPrompt.length / 2.5)
  const contextMaxTokens = aiConfig.contextMaxTokens

  log.debug("上下文已构建 | systemPrompt:", estimatedSystemTokens, "tokens | tools:", tools.length, "| memory:", memoryBlock.length > 0 ? "yes" : "no")
  return { systemPrompt, tools, estimatedSystemTokens, contextMaxTokens }
}

// ── Memory 注入 ──

function buildMemoryInjection(userText: string): string {
  const relevant = MemoryService.search(userText, 3)
  if (relevant.length === 0) return ""

  const lines = relevant.map(e => `- ${e.content}`)
  return `\n\n[相关记忆]\n${lines.join("\n")}`
}

// ── 工具注入决策 ──

function decideToolInject(userText: string, isActiveMessage: boolean): ToolDeclaration[] {
  // 主动搭话：无论哪个模式都不带工具
  if (isActiveMessage) return []

  const isAssistant = modeConfig.assistant

  // 轻量模式：非主动搭话始终携带（只有 6 个）
  if (!isAssistant) {
    return getToolDeclarations("pet")
  }

  // 助手模式：按需分级
  if (!hasToolKeyword(userText)) return [] // L0: 闲聊
  const allTools = getToolDeclarations()
  return allTools // L1/L2: 有工具意图时全量
}

function hasToolKeyword(text: string): boolean {
  return TOOL_KEYWORDS.some(kw => text.includes(kw))
}

export function shouldCompact(estimatedUsage: number, totalBudget: number): boolean {
  return estimatedUsage / totalBudget >= COMPACT_THRESHOLD
}

/**
 * 压缩消息列表：将旧消息替换为摘要，释放 token 预算。
 * 保留最近 40% 消息，其余压缩为一条摘要。
 */
export function compactMessages(messages: Message[], systemPrompt: string): Message[] {
  const keepCount = Math.max(1, Math.floor(messages.length * 0.4))
  const toCompact = messages.slice(0, messages.length - keepCount)
  const toKeep = messages.slice(messages.length - keepCount)

  if (toCompact.length === 0) return messages

  // 从旧消息中提取关键信息生成摘要
  const summaryLines: string[] = []
  for (const m of toCompact) {
    if (m.role === "user") summaryLines.push(`用户: ${m.text.substring(0, 120)}`)
    else if (m.role === "assistant") summaryLines.push(`糖糖: ${m.text.substring(0, 120)}`)
    // tool 消息跳过
  }

  const compactedText = `[对话摘要] 之前的对话要点:\n${summaryLines.join("\n")}`

  const summaryMsg: Message = {
    id: `compact-${Date.now()}`,
    role: "tool",
    text: compactedText,
    timestamp: Date.now(),
    toolCallId: "context-compaction",
  }

  log.debug(`上下文压缩: ${messages.length} → ${keepCount + 1} (裁剪 ${toCompact.length} 条)`)
  return [summaryMsg, ...toKeep]
}
