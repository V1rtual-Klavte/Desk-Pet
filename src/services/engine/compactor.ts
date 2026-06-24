// ==========================================
// 上下文压缩引擎 —— 增量/全量两级压缩
// ==========================================
//
// 增量压缩（触发：内存上下文 ≥ 95% contextMaxTokens）
//   未被摘要的新消息 → LLM 生成结构化摘要 → 合并已有摘要 → 写回 sessions/*.md
//
// 全量压缩（触发：sessions/*.md 本身过大）
//   整个会话内容 → LLM 全量重压 → 覆盖摘要 → 写回 sessions/*.md
//
// 压缩期间正常对话不受阻，摘要写入异步进行。
// ==========================================

import type { Message } from "@/services/agent/types"
import type { CompactionSummary } from "@/services/agent/memory"
import { MemoryService } from "@/services/agent/memory"
import { aiConfig, loopConfig, modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Compactor")

const COMPACT_THRESHOLD = 0.95

// ═══════════════════════════════════════════════════════════════
// 阈值判断
// ═══════════════════════════════════════════════════════════════

/** 估算消息列表的 token 数（字符/2.5） */
export function estimateTokens(msgs: Message[]): number {
  let total = 0
  for (const m of msgs) {
    total += m.text.length
    if (m.toolCalls) total += JSON.stringify(m.toolCalls).length
    if (m.thinking) total += m.thinking.length
  }
  return Math.ceil(total / 2.5)
}

/** 检查是否需要触发增量压缩 */
export function shouldCompact(estimatedUsage: number, totalBudget: number): boolean {
  return estimatedUsage / totalBudget >= COMPACT_THRESHOLD
}

// ═══════════════════════════════════════════════════════════════
// 内存压缩（简单截断）：保留最近 40%，旧消息替换为摘要占位
// ═══════════════════════════════════════════════════════════════

/**
 * 将消息列表压缩：保留最近 40%，其余替换为一条摘要消息。
 * 这步只做内存层面的消息替换，不调 LLM。
 */
export function compactMessages(messages: Message[]): Message[] {
  const keepCount = Math.max(1, Math.floor(messages.length * 0.4))
  const toKeep = messages.slice(messages.length - keepCount)

  if (messages.length === toKeep.length) return messages

  // 从上下文引擎获取已有摘要，注入为占位消息
  const existing = MemoryService.getCompactionSummarySync()
  const summaryText = existing
    || `[对话摘要] 之前 ${messages.length - keepCount} 轮对话已归档到 sessions/`

  const summaryMsg: Message = {
    id: `compact-${Date.now()}`,
    role: "tool",
    text: summaryText,
    timestamp: Date.now(),
    toolCallId: "context-compaction",
  }

  log.debug(`内存压缩: ${messages.length} → ${keepCount + 1} (裁剪 ${messages.length - keepCount} 条)`)
  return [summaryMsg, ...toKeep]
}

// ═══════════════════════════════════════════════════════════════
// 增量压缩：LLM 压缩未摘要的新消息 → 合并已有摘要
// ═══════════════════════════════════════════════════════════════

/**
 * 增量压缩：将未压缩的新消息发给 LLM，生成/合并结构化摘要。
 *
 * @param newMessages 未被摘要覆盖的新消息（完整 Message 列表）
 * @param existingSummary 已有摘要文本（null = 首次压缩）
 * @param userIntent 用户当前意图（从 input 取前 100 字）
 */
export async function compactIncremental(
  newMessages: Message[],
  existingSummary: string | null,
  userIntent: string,
): Promise<CompactionSummary | null> {
  const text = messagesToText(newMessages)
  if (text.length < 50) return null // 内容太少，不值得压缩

  const prompt = buildCompactionPrompt(text, existingSummary, userIntent)

  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()
    const resp = await provider.generateReply({
      messages: [{ id: "compact", role: "user", text: prompt, timestamp: Date.now() }],
      systemPrompt: "你是会话摘要助手。只输出 JSON，不要其他内容。严格遵循格式。",
      thinkingEffort: "low",
    })

    const summary = parseCompactionResponse(resp.text, existingSummary)
    if (!summary) return null

    // 写回 sessions/*.md
    await MemoryService.writeCompactionSummary({
      mainRequest: summary.mainRequest,
      keyTech: summary.keyTech,
      files: summary.files,
      problems: summary.problems,
      userMessages: summary.userMessages,
      tasks: summary.tasks,
      currentWork: summary.currentWork,
      nextSteps: summary.nextSteps,
    })

    log.info("增量压缩完成", "mainRequest:", summary.mainRequest.substring(0, 50))
    return summary
  } catch (e) {
    log.warn("LLM 压缩失败，使用简单截断", e instanceof Error ? e.message : String(e))
    return fallbackSummary(newMessages, existingSummary, userIntent)
  }
}

// ═══════════════════════════════════════════════════════════════
// 全量压缩：整个会话 md 重压
// ═══════════════════════════════════════════════════════════════

/**
 * 全量压缩：将整个 sessions/*.md 的对话内容发给 LLM 重新生成摘要。
 * 用于会话文件本身过大时彻底压缩。
 */
export async function compactFull(sessionContent: string): Promise<CompactionSummary | null> {
  const prompt = [
    "请将以下完整对话历史压缩为结构化摘要。只输出 JSON，不要其他内容。",
    "",
    '输出格式: {"mainRequest":"...","keyTech":["..."],"files":["..."],"problems":"...","userMessages":["最后几条用户消息"],"tasks":["..."],"currentWork":"...","nextSteps":"..."}',
    "",
    "规则:",
    "- mainRequest: 用户本轮主要想做什么（一句话）",
    "- keyTech: 涉及的技术关键词列表",
    "- files: 涉及的代码文件路径列表",
    "- problems: 遇到的问题及解决方式",
    "- userMessages: 用户的关键消息（≤5条）",
    "- tasks: 已完成/进行中的任务列表",
    "- currentWork: 当前正在做什么",
    "- nextSteps: 后续计划步骤",
    "",
    "=== 对话内容 ===",
    sessionContent.substring(0, 8000), // 限制长度防超 token
  ].join("\n")

  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()
    const resp = await provider.generateReply({
      messages: [{ id: "full-compact", role: "user", text: prompt, timestamp: Date.now() }],
      systemPrompt: "你是会话摘要助手。只输出 JSON，不要其他内容。",
      thinkingEffort: "medium",
    })

    const result = parseCompactionResponse(resp.text, null)
    if (!result) return null

    await MemoryService.writeCompactionSummary({
      mainRequest: result.mainRequest,
      keyTech: result.keyTech,
      files: result.files,
      problems: result.problems,
      userMessages: result.userMessages,
      tasks: result.tasks,
      currentWork: result.currentWork,
      nextSteps: result.nextSteps,
    })

    log.info("全量压缩完成")
    return result
  } catch (e) {
    log.warn("全量 LLM 压缩失败", e instanceof Error ? e.message : String(e))
    return null
  }
}

// ═══════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════

/** 将消息列表转为纯文本供 LLM 阅读 */
function messagesToText(msgs: Message[]): string {
  return msgs.map(m => {
    const label = m.role === "user" ? "用户" : m.role === "assistant" ? "糖糖" : "工具"
    const text = m.text.substring(0, 300)
    if (m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls.map(t => `${t.name}(${t.arguments.substring(0, 80)})`).join(", ")
      return `[${label}] ${text}\n  工具调用: ${calls}`
    }
    return `[${label}] ${text}`
  }).join("\n")
}

/** 构建增量压缩的 prompt */
function buildCompactionPrompt(newText: string, existingSummary: string | null, userIntent: string): string {
  const parts = [
    "将以下新增对话内容压缩为结构化摘要。只输出 JSON，不要其他内容。",
    "",
    '输出格式: {"mainRequest":"...","keyTech":["..."],"files":["..."],"problems":"...","userMessages":["最后几条用户消息"],"tasks":["..."],"currentWork":"...","nextSteps":"..."}',
    "",
  ]

  if (existingSummary) {
    parts.push(
      "=== 已有摘要 ===",
      existingSummary,
      "",
      "请将新增内容与已有摘要合并更新。",
      "",
    )
  }

  parts.push(
    `用户意图: ${userIntent.substring(0, 100)}`,
    "",
    "=== 新增对话 ===",
    newText.substring(0, 4000),
  )

  return parts.join("\n")
}

/** 解析 LLM 返回的 JSON 摘要 */
function parseCompactionResponse(
  raw: string,
  existingSummary: string | null,
): CompactionSummary | null {
  try {
    const jsonText = raw.replace(/```json\n?|```/g, "").trim()
    const json = JSON.parse(jsonText)

    const summary: CompactionSummary = {
      mainRequest: String(json.mainRequest ?? ""),
      keyTech: Array.isArray(json.keyTech) ? json.keyTech.map(String) : [],
      files: Array.isArray(json.files) ? json.files.map(String) : [],
      problems: String(json.problems ?? ""),
      userMessages: Array.isArray(json.userMessages) ? json.userMessages.map(String) : [],
      tasks: Array.isArray(json.tasks) ? json.tasks.map(String) : [],
      currentWork: String(json.currentWork ?? ""),
      nextSteps: String(json.nextSteps ?? ""),
      generatedAt: Date.now(),
    }

    // 合并已有摘要（简单追加非重复字段）
    if (existingSummary) {
      // 已有摘要内容直接拼接，由 LLM 端负责合并
    }

    return summary
  } catch (e) {
    log.warn("摘要 JSON 解析失败", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** LLM 压缩失败时的 fallback：从消息中简单提取 */
function fallbackSummary(
  msgs: Message[],
  _existingSummary: string | null,
  userIntent: string,
): CompactionSummary | null {
  const userMsgs = msgs.filter(m => m.role === "user")
  const files = extractFilePathsFromMessages(msgs)

  return {
    mainRequest: userIntent.substring(0, 100),
    keyTech: [],
    files,
    problems: "",
    userMessages: userMsgs.slice(-3).map(m => m.text.substring(0, 100)),
    tasks: [userIntent.substring(0, 100)],
    currentWork: userIntent.substring(0, 100),
    nextSteps: "",
    generatedAt: Date.now(),
  }
}

/** 从消息中提取文件路径（纯规则匹配，不做 AI） */
function extractFilePathsFromMessages(msgs: Message[]): string[] {
  const text = msgs.map(m => m.text).join(" ")
  const matches = text.match(/[\w/.\\-]+\.[\w]{1,6}/g)
  return matches ? [...new Set(matches)].slice(0, 5) : []
}

// ═══════════════════════════════════════════════════════════════
// 轮次结束后的压缩检测
// ═══════════════════════════════════════════════════════════════

/**
 * 轮次结束后调用：检测会话是否接近上限，触发增量压缩。
 * 不阻塞主流程，fire-and-forget。
 *
 * @param recentMessages 当前轮的消息列表
 * @param userIntent 用户意图文本
 */
export function compactOnHighUsage(recentMessages: Message[], userIntent: string): void {
  const session = MemoryService.session
  if (!session || session.turns.length < 3) return // 太少不压

  // 粗略估算：每轮平均 200 tokens
  const estimatedTokens = session.turns.length * 200 + recentMessages.length * 150
  const maxTokens = aiConfig.contextMaxTokens

  if (!shouldCompact(estimatedTokens, maxTokens)) return

  log.info("轮次结束压缩触发:", `~${estimatedTokens}/${maxTokens} tokens`, `(${session.turns.length} 轮)`)

  compactIncremental(
    recentMessages,
    MemoryService.getCompactionSummarySync() || null,
    userIntent,
  ).then(summary => {
    if (summary) log.info("EoT 压缩完成")
  }).catch(e => {
    log.warn("EoT 压缩失败", e instanceof Error ? e.message : String(e))
  })
}

// ═══════════════════════════════════════════════════════════════
// HMR
// ═══════════════════════════════════════════════════════════════
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("Compactor HMR 完成")
  })
}
