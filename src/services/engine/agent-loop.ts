// ==========================================
// Agent Loop v5 — 单次 LLM 调用 + generator 后处理
// 角色内容已内建到 system prompt，一步出角色化回复
// ==========================================

import type { Message } from "@/services/agent/types"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { buildPrompt } from "@/services/context/builder"
import { executeTool } from "@/services/tool/router"
import { getToolByName } from "@/services/tool/registry"
import { checkSafety, trustToolInSession } from "@/services/safety/checker"
import { requestConfirm } from "@/services/safety/confirm"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import type { PersonalityEffect } from "@/services/personality/middleware"
import { getActiveCard } from "@/services/personality/registry"
import { refreshVariablePool, getPoolSnapshot, savePoolToDisk, updateInteractionVar, applyResetPolicies, getSessionStart } from "@/services/personality/variable-pool"
import { getSimpleStage, getStagePrompt, getFallbackReply } from "@/services/personality/stages-cache"
import { getEffectiveThinkingEffort, updateRequestStats } from "@/services/debug"
import { generateReply } from "@/services/reply/generator"
import { transition, recordMessage, recordToolCall } from "./session"
import { pushMessage, chatHistory } from "@/services/session/store"
import { loopConfig, modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { emit } from "@tauri-apps/api/event"
import { MemoryService } from "@/services/agent/memory"
import { shouldCompact, compactMessages, estimateTokens, compactIncremental, compactOnHighUsage } from "./compactor"

const log = createLogger("AgentLoop")

/** 上次看到的会话开始时间，用于检测新会话（触发 reset=session） */
let lastSeenSessionStart = getSessionStart()

export interface AgentLoopInput {
  userText: string
  chatMessages: Message[]
  unansweredCount: number
  messageCount: number
  isActiveMessage?: boolean
  isRetry?: boolean
}

export interface AgentLoopOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  effects: { expression: string; soundEvent: string | null }[]
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const { userText, chatMessages, unansweredCount, messageCount, isActiveMessage } = input
  const toolCallHistory: AgentLoopOutput["toolCallHistory"] = []
  const effects: AgentLoopOutput["effects"] = []
  const startTime = Date.now()
  let retriesUsed = 0

  recordMessage()
  MemoryService.recordTurn("user", userText)

  // ═══ 0. 变量池 + When 引擎 ═══
  refreshVariablePool()

  // 同步旧 session unansweredCount 到变量池 interaction 变量
  updateInteractionVar("unansweredCount", unansweredCount)

  // 应用 reset 策略：新会话触发 reset=session，日期变化触发 reset=daily
  const currentSessionStart = getSessionStart()
  const isNewSession = currentSessionStart !== lastSeenSessionStart
  if (isNewSession) lastSeenSessionStart = currentSessionStart
  applyResetPolicies(new Date(), isNewSession)

  const card = getActiveCard() // v5: 永远非 null（neutral 兜底）

  const thinkingEffort = getEffectiveThinkingEffort()

  // ═══ 1. 统一 Prompt 构建（角色已内建） ═══
  const ctx = buildPrompt(
    { recentMessages: chatMessages, userText, unansweredCount, thinkingEffort, isActiveMessage },
    card, getPoolSnapshot(),
  )

  log.info(`\n${"═".repeat(50)}\n  【v5 System Prompt】Card=${card?.id ?? "neutral"} | Tools=${ctx.tools.length} tokens≈${ctx.estimatedSystemTokens}\n${"═".repeat(50)}\n${ctx.systemPrompt}\n${"─".repeat(50)}`)
  applyEffect(PetPersonalityMiddleware.wrap("thinking"), effects)

  const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
  const provider = new OpenAICompatibleProvider()

  const maxRounds = loopConfig.maxToolCallsPerTurn
  const maxRetry = loopConfig.maxRetry + 1
  const turnTimeout = loopConfig.turnTimeoutMs

  let rawReply = ""

  // ── 工具循环 ──
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (attempt > 0) retriesUsed = attempt
    try {
      const result = await runToolLoop({
        provider, systemPrompt: ctx.systemPrompt, tools: ctx.tools,
        chatMessages, maxRounds, startTime, turnTimeout, toolCallHistory,
        thinkingEffort, effects, userText,
      })
      rawReply = result.reply
      log.info(`LLM 输出 (${rawReply.length} chars):\n${rawReply.slice(0, 300)}${rawReply.length > 300 ? "…" : ""}`)
      break
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (attempt >= maxRetry - 1) {
        log.error("重试耗尽:", err.message)
        transition("WAITING")
        const errEffect = PetPersonalityMiddleware.wrap("error", { message: getSimpleStage("error") ?? "出了点问题" })
        applyEffect(errEffect, effects)
        return { reply: getFallbackReply("maxRetriesExhausted"), toolCallHistory, retriesUsed, effects }
      }
    }
  }

  // ═══ 2. Generator 后处理 ═══
  const processed = generateReply(rawReply, card)
  log.info(`Generator 后处理: emotionKey=${processed.emotionKey ?? "无"} expression=${processed.expression} sound=${processed.sound ?? "无"} textLen=${processed.text.length}`)

  effects.push({ expression: processed.expression, soundEvent: processed.sound })
  emit("deskpet-expression", { expression: processed.expression }).catch(() => {})
  if (processed.sound) emit("deskpet-sound", { event: processed.sound }).catch(() => {})

  transition("WAITING")
  MemoryService.recordTurn("assistant", processed.text)
  compactOnHighUsage(chatMessages, userText)

  savePoolToDisk()

  return { reply: processed.text, toolCallHistory, retriesUsed, effects }
}

// ── 工具循环 ──

async function runToolLoop(opts: {
  provider: any; systemPrompt: string; tools: any[]
  chatMessages: Message[]; maxRounds: number; startTime: number
  turnTimeout: number; toolCallHistory: any[]
  thinkingEffort: string; effects: any[]; userText: string
}): Promise<{ reply: string }> {
  const { provider, systemPrompt, tools, chatMessages, maxRounds, startTime, turnTimeout, toolCallHistory, thinkingEffort, effects, userText } = opts
  const loopMessages: Message[] = [...chatMessages]
  let finalReply = ""
  let roundCount = 0

  transition("GENERATING")

  while (roundCount < maxRounds) {
    if (Date.now() - startTime > turnTimeout) {
      finalReply = getFallbackReply("turnTimeout")
      break
    }
    roundCount++

    const response = await provider.generateReply({
      messages: loopMessages,
      systemPrompt,
      tools,
      thinkingEffort,
    })

    const { text, toolCalls, thinking } = response
    const convTokens = estimateTokens(loopMessages)
    updateRequestStats({
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      systemTokens: Math.ceil(systemPrompt.length / 2.5),
      conversationTokens: convTokens,
      toolCount: roundCount === 1 ? tools.length : 0,
      toolNames: roundCount === 1 ? tools.map((t: any) => t.function.name) : [],
    })

    if (shouldCompact(Math.ceil(systemPrompt.length / 2.5) + convTokens, 16000)) {
      const compacted = compactMessages(loopMessages)
      loopMessages.length = 0
      loopMessages.push(...compacted)
      compactIncremental(loopMessages, MemoryService.getCompactionSummarySync() || null, userText)
        .then(() => {}).catch(() => {})
    }

    if (toolCalls.length === 0) {
      finalReply = text
      break
    }

    transition("EXECUTING")

    const assistantMsg: Message = {
      id: createMessageId(), role: "assistant", text: text || "",
      toolCalls, thinking, timestamp: Date.now(),
    }
    loopMessages.push(assistantMsg)
    pushMessage(assistantMsg) // 持久化到 chatHistory

    for (const tc of toolCalls) {
      recordToolCall()
      const params = parseArgs(tc.arguments)
      log.info(`工具调用 [round ${roundCount}]: ${tc.name}(${JSON.stringify(params)})`)

      const tool = getToolByName(tc.name)

      const cat = tool?.actionCategory ?? "_default"
      applyEffect(PetPersonalityMiddleware.wrap("executing", { actionCategory: cat, toolName: tc.name }), effects)
      emitToolEvent("tool-executing", { toolId: tc.name, toolName: tc.name })

      if (!tool) {
        log.warn(`工具不存在: ${tc.name}`)
        toolCallHistory.push({ toolName: tc.name, status: "error" })
        const errPrefix = getSimpleStage("error") ?? "Error"
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: `${errPrefix}: 工具 ${tc.name} 不可用` })))
        continue
      }

      const safetyResult = checkSafety(tool, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (!safetyResult.allowed) {
        log.warn(`工具被安全拦截: ${tc.name} reason=${safetyResult.personalityMessage ?? "未知"}`)
        applyEffect(PetPersonalityMiddleware.wrap("blocked", { actionCategory: cat, toolName: tc.name }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "blocked" })
        const blockedMsg = safetyResult.personalityMessage ?? getStagePrompt("blocked", cat) ?? "操作被拦截"
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: blockedMsg })))
        continue
      }

      if (safetyResult.needsConfirm && safetyResult.confirmMessage) {
        const approved = await requestConfirm(tc.name, safetyResult.confirmMessage)
        if (!approved) {
          log.info(`工具被用户拒绝: ${tc.name}`)
          toolCallHistory.push({ toolName: tc.name, status: "denied" })
          const deniedMsg = getStagePrompt("blocked", cat) ?? "操作被拦截"
          loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: deniedMsg })))
          continue
        }
        if (tool.safetyLevel === "NORMAL") trustToolInSession(tc.name)
      }

      const result = await executeTool(tc.name, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (result.success) {
        log.info(`工具成功: ${tc.name} ✓ ${result.content?.slice(0, 80) ?? ""}`)
        applyEffect(PetPersonalityMiddleware.wrap("done", { actionCategory: cat, toolName: tc.name }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "done" })
      } else {
        log.warn(`工具失败: ${tc.name} ✗ ${result.error ?? "未知错误"}`)
        applyEffect(PetPersonalityMiddleware.wrap("error", { actionCategory: cat, toolName: tc.name, message: result.error }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "error" })
      }

      const errPrefix = getSimpleStage("error") ?? "Error"
      loopMessages.push(createToolMessage(tc.id, result.success ? result.content : `${errPrefix}: ${result.error}`))
      pushMessage(createToolMessage(tc.id, result.success ? result.content : `${errPrefix}: ${result.error}`)) // 持久化
      emitToolEvent("tool-completed", { toolId: tc.name, toolName: tc.name, success: result.success })
    }
  }

  if (!finalReply && roundCount >= maxRounds) {
    finalReply = getFallbackReply("toolLoopMaxRounds")
  }

  return { reply: finalReply }
}

// ── 辅助 ──

function applyEffect(effect: PersonalityEffect, effects: { expression: string; soundEvent: string | null }[]): void {
  effects.push({ expression: effect.expression, soundEvent: effect.soundEvent })
}

function parseArgs(args: string): Record<string, unknown> {
  try { return JSON.parse(args) } catch { return {} }
}

async function emitToolEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try { await emit(event, payload) } catch { /* 静默失败 */ }
}
