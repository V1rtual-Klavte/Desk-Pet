// ==========================================
// 核心引擎 —— Agent Loop
// 统一的 Agent 循环：请求 AI → 解析 → 中间件 → 安全 → 执行 → 回注 → 循环
// 轻量和助手模式共用同一套 Loop
// ==========================================

import type { Message } from "@/services/agent/types"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { buildContext, shouldCompact, compactMessages } from "@/services/context/builder"
import { executeTool } from "@/services/tool/router"
import { getToolByName } from "@/services/tool/registry"
import { checkSafety } from "@/services/safety/checker"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import type { PersonalityEffect } from "@/services/personality/middleware"
import { decideThinkingEffort, resetToolCallCount, incrementToolCallCount } from "./thinking"
import { planStep } from "./plan"
import { transition, recordMessage, recordToolCall } from "./session"
import { loopConfig, modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { emit } from "@tauri-apps/api/event"
import { updateRequestStats } from "@/services/debug"
import { MemoryService } from "@/services/agent/memory"

const log = createLogger("AgentLoop")

export interface AgentLoopInput {
  userText: string
  chatMessages: Message[]
  unansweredCount: number
  isActiveMessage?: boolean
  isRetry?: boolean
}

export interface AgentLoopOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  /** 各阶段人格效果（表情+音效），供 UI 驱动 */
  effects: { expression: string; soundEvent: string | null }[]
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const { userText, chatMessages, unansweredCount, isActiveMessage, isRetry } = input
  const toolCallHistory: AgentLoopOutput["toolCallHistory"] = []
  const effects: AgentLoopOutput["effects"] = []
  const startTime = Date.now()
  let retriesUsed = 0
  let lastError: Error | null = null

  resetToolCallCount()
  recordMessage()

  // ── 记录用户轮次到 SESSION_MEMORY ──
  MemoryService.recordTurn("user", userText)

  const thinkingEffort = decideThinkingEffort(userText, isActiveMessage ?? false, isRetry ?? false)
  const ctx = buildContext({ recentMessages: chatMessages, userText, unansweredCount, thinkingEffort, isActiveMessage })

  // ── Plan 步骤（助手模式 + 复杂任务）──
  const plan = planStep(userText, thinkingEffort, ctx.tools.map((t: any) => t.function.name))
  if (plan.triggered) {
    ctx.systemPrompt += plan.hint
    applyEffect(PetPersonalityMiddleware.wrap("planning"), effects)
  }

  // ── 人格中间件: thinking ──
  const thinkingEffect = PetPersonalityMiddleware.wrap("thinking")
  applyEffect(thinkingEffect, effects)

  const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
  const provider = new OpenAICompatibleProvider()

  const maxRounds = loopConfig.maxToolCallsPerTurn
  const maxRetry = loopConfig.maxRetry + 1 // +1 = initial attempt + retries
  const turnTimeout = loopConfig.turnTimeoutMs

  // ── 主循环（含 retry）──
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (attempt > 0) {
      retriesUsed = attempt
      log.warn("重试", attempt, "/", loopConfig.maxRetry, lastError?.message ?? "")
    }

    try {
      const result = await runLoopIteration({
        provider, ctx, chatMessages, maxRounds, startTime, turnTimeout, toolCallHistory, thinkingEffort, effects, userText,
      })
      transition("WAITING")
      // ── 记录助理轮次 + 后台补记忆 ──
      MemoryService.recordTurn("assistant", result.reply)
      if (modeConfig.assistant) {
        MemoryService.forkMemorySupplement(
          `用户: ${userText.substring(0, 200)}\n糖糖: ${result.reply.substring(0, 200)}`
        )
      }
      const doneEffect = PetPersonalityMiddleware.wrap("done", {
        toolName: toolCallHistory.length > 0 ? toolCallHistory[toolCallHistory.length - 1]?.toolName : undefined,
      })
      applyEffect(doneEffect, effects)
      return { ...result, retriesUsed, effects }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt >= maxRetry - 1) {
        log.error("所有重试耗尽")
        transition("WAITING")
        const errEffect = PetPersonalityMiddleware.wrap("error", { message: "啊...信号不太好，等会儿再试试？" })
        applyEffect(errEffect, effects)
        return {
          reply: "（唔…试了好几次都失败了，等一下再找我哦～）",
          toolCallHistory,
          retriesUsed,
          effects,
        }
      }
    }
  }

  transition("WAITING")
  return { reply: "（唔…出了点问题…）", toolCallHistory, retriesUsed, effects }
}

// ── 单轮 Loop 执行 ──

async function runLoopIteration(opts: {
  provider: any
  ctx: any
  chatMessages: Message[]
  maxRounds: number
  startTime: number
  turnTimeout: number
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  thinkingEffort: string
  effects: { expression: string; soundEvent: string | null }[]
  userText: string
}): Promise<{ reply: string; toolCallHistory: typeof opts.toolCallHistory }> {
  const { provider, ctx, chatMessages, maxRounds, startTime, turnTimeout, toolCallHistory, thinkingEffort, effects, userText } = opts
  const loopMessages: Message[] = [...chatMessages]
  let finalReply = ""
  let roundCount = 0

  transition("GENERATING")

  while (roundCount < maxRounds) {
    if (Date.now() - startTime > turnTimeout) {
      log.warn("Agent Loop 总轮次超时")
      finalReply = "（唔…处理时间太长了，等下再说哦～）"
      break
    }

    roundCount++

    const response = await provider.generateReply({
      messages: loopMessages,
      systemPrompt: ctx.systemPrompt,
      tools: roundCount === 1 ? ctx.tools : undefined,
      thinkingEffort,
      streamEnabled: loopConfig.streamEnabled,
    })

    const { text, toolCalls, thinking } = response
    const usage = (response as any).usage

    // 更新 debug 状态（含会话 tokens 占比）
    const convTokens = estimateTokens(loopMessages)
    updateRequestStats({
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      systemTokens: ctx.estimatedSystemTokens,
      conversationTokens: convTokens,
      toolCount: roundCount === 1 ? ctx.tools.length : 0,
      toolNames: roundCount === 1 ? ctx.tools.map((t: any) => t.function.name) : [],
    })

    // ── 上下文压缩检测 ──
    if (shouldCompact(ctx.estimatedSystemTokens + convTokens, ctx.contextMaxTokens)) {
      const before = loopMessages.length
      const compacted = compactMessages(loopMessages, ctx.systemPrompt)
      loopMessages.length = 0
      loopMessages.push(...compacted)
      // ★ 生成结构化摘要写入 SESSION_MEMORY.md
      const userMsgs = compacted.filter(m => m.role === "user").map(m => m.text)
      MemoryService.writeCompactionSummary({
        mainRequest: userMsgs[userMsgs.length - 1]?.substring(0, 100) || userText.substring(0, 100),
        keyTech: extractTechKeywords(compacted.map(m => m.text).join(" ")),
        files: extractFilePaths(compacted.map(m => m.text).join(" ")),
        problems: "",
        userMessages: userMsgs.slice(-3),
        currentWork: userText.substring(0, 100),
        nextSteps: "",
      })
      log.info("上下文已压缩 + 结构摘要:", before, "→", compacted.length, "条消息")
    }

    if (toolCalls.length === 0) {
      finalReply = text
      log.info("AI 回复:", text.substring(0, 80))
      break
    }

    log.info("AI 工具调用:", toolCalls.map((t: { name: string }) => t.name).join(", "))

    transition("EXECUTING")

    const assistantMsg: Message = {
      id: createMessageId(),
      role: "assistant",
      text: text || "",
      toolCalls,
      thinking,
      timestamp: Date.now(),
    }
    loopMessages.push(assistantMsg)

    let allAllowed = true
    for (const tc of toolCalls) {
      incrementToolCallCount()
      recordToolCall()

      const params = parseArgs(tc.arguments)
      const tool = getToolByName(tc.name)

      // ── 人格中间件: executing ──
      const execEffect = PetPersonalityMiddleware.wrap("executing", { toolName: tc.name })
      applyEffect(execEffect, effects)
      emitToolEvent("tool-executing", { toolId: tc.name, toolName: tc.name, personalityHint: tool?.personalityHint?.executing }).catch(() => {})

      if (!tool) {
        toolCallHistory.push({ toolName: tc.name, status: "error", personalityMsg: `不认识 ${tc.name} 呢…` })
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: `工具不存在: ${tc.name}` })))
        emitToolEvent("tool-completed", { toolId: tc.name, toolName: tc.name, success: false }).catch(() => {})
        continue
      }

      // ── 安全校验 ──
      const safetyResult = checkSafety(tool, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (!safetyResult.allowed) {
        allAllowed = false
        const blockedEffect = PetPersonalityMiddleware.wrap("blocked", { toolName: tc.name })
        applyEffect(blockedEffect, effects)
        toolCallHistory.push({
          toolName: tc.name, status: "blocked",
          personalityMsg: safetyResult.personalityMessage ?? blockedEffect.userMessage ?? undefined,
        })
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({
          toolCallId: tc.id, content: "",
          error: safetyResult.personalityMessage ?? "被安全策略拦截",
        })))
        continue
      }

      // ── 执行工具 ──
      const result = await executeTool(tc.name, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (result.success) {
        const doneEffect = PetPersonalityMiddleware.wrap("done", { toolName: tc.name })
        applyEffect(doneEffect, effects)
        toolCallHistory.push({
          toolName: tc.name, status: "done",
          personalityMsg: tool.personalityHint?.done ?? "完成啦～",
        })
      } else {
        const errEffect = PetPersonalityMiddleware.wrap("error", { toolName: tc.name, message: result.error })
        applyEffect(errEffect, effects)
        toolCallHistory.push({ toolName: tc.name, status: "error" })
      }

      loopMessages.push(createToolMessage(tc.id,
        result.success ? result.content : `Error: ${result.error}`))
      emitToolEvent("tool-completed", {
        toolId: tc.name, toolName: tc.name,
        success: result.success,
        personalityHint: result.success ? tool.personalityHint?.done : undefined,
      }).catch(() => {})
    }

    if (!allAllowed && !text) {
      finalReply = toolCallHistory
        .filter(h => h.status === "blocked" && h.personalityMsg)
        .map(h => h.personalityMsg)
        .join("\n") || "唔…这些操作现在不能做呢～"
      break
    }
  }

  if (!finalReply && roundCount >= maxRounds) {
    try {
      const summaryReq = await provider.generateReply({
        messages: loopMessages,
        systemPrompt: ctx.systemPrompt + "\n\n请基于以上工具执行结果，用简短口语化中文总结。",
        thinkingEffort: "low",
      })
      finalReply = summaryReq.text || "搞定啦～"
    } catch {
      finalReply = "（处理完了…但结果有点复杂呢～）"
    }
  }

  return { reply: finalReply, toolCallHistory }
}

/** 估算消息列表的 token 数（简单按字符/2.5估算） */
function estimateTokens(msgs: Message[]): number {
  let total = 0
  for (const m of msgs) {
    total += m.text.length
    if (m.toolCalls) total += JSON.stringify(m.toolCalls).length
    if (m.thinking) total += m.thinking.length
  }
  return Math.ceil(total / 2.5)
}

/** 从文本中提取技术关键词 */
function extractTechKeywords(text: string): string[] {
  const techTerms = [
    "MySQL", "PostgreSQL", "SQLite", "Redis", "Docker", "Kubernetes", "React", "Vue",
    "TypeScript", "JavaScript", "Python", "Rust", "Go", "Java", "C++", "CSS", "HTML",
    "API", "REST", "GraphQL", "JSON", "YAML", "Git", "Linux", "macOS", "Windows",
    "索引", "查询优化", "B+树", "事务", "锁", "并发", "缓存", "消息队列",
    "Nginx", "Apache", "Node.js", "Express", "Next.js", "Tauri", "Vite",
    "数据库", "前端", "后端", "部署", "测试", "调试", "重构", "算法",
  ]
  return techTerms.filter(t => text.toLowerCase().includes(t.toLowerCase())).slice(0, 5)
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/[\w/.\\-]+\.[\w]{1,6}/g)
  return matches ? [...new Set(matches)].slice(0, 5) : []
}

/** 将人格效果收集到列表，并发射 expression 事件供 UI 响应 */
function applyEffect(effect: PersonalityEffect, effects: { expression: string; soundEvent: string | null }[]): void {
  effects.push({ expression: effect.expression, soundEvent: effect.soundEvent })
  // 发射 expression 事件给 StreamView
  emit("deskpet-expression", { expression: effect.expression }).catch(() => {})
  if (effect.soundEvent) {
    emit("deskpet-sound", { event: effect.soundEvent }).catch(() => {})
  }
}

function parseArgs(args: string): Record<string, unknown> {
  try { return JSON.parse(args) } catch { return {} }
}

async function emitToolEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await emit(event, payload)
  } catch {
    // 事件发送静默失败，不影响主流程
  }
}
