// ==========================================
// Agent Loop v4 — 变量池 + When + Phase1/2 + 情绪剥离
// 每次用户消息: Phase1(能力) + Phase2(风格) 固定 2 次 LLM 调用
// chatHistory: 用户消息 + Phase1工具链 + Phase2回复
// ==========================================

import type { Message } from "@/services/agent/types"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { buildCapabilityPrompt, buildStylePrompt, summarizeToolCalls } from "@/services/context/builder"
import { executeTool } from "@/services/tool/router"
import { getToolByName } from "@/services/tool/registry"
import { checkSafety, trustToolInSession } from "@/services/safety/checker"
import { requestConfirm } from "@/services/safety/confirm"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import type { PersonalityEffect } from "@/services/personality/middleware"
import { getActiveCard } from "@/services/personality/registry"
import { refreshVariablePool, getPoolSnapshot, savePoolToDisk, updateInteractionVar, applyResetPolicies, getSessionStart } from "@/services/personality/variable-pool"
import { evaluateWhenEngine } from "@/services/personality/when-engine"
import { stripEmotionTag, resolveEmotion } from "@/services/personality/emotion"
import { getEffectiveThinkingEffort, updateRequestStats } from "@/services/debug"
import { transition, recordMessage, recordToolCall } from "./session"
import { pushMessage, chatHistory } from "@/services/session/store"
import { loopConfig, modeConfig, personalityConfig, replyConfig } from "@/services/config"
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
  const pool = refreshVariablePool()

  // 同步旧 session unansweredCount 到变量池 interaction 变量
  updateInteractionVar("unansweredCount", unansweredCount)

  // 应用 reset 策略：新会话触发 reset=session，日期变化触发 reset=daily
  const currentSessionStart = getSessionStart()
  const isNewSession = currentSessionStart !== lastSeenSessionStart
  if (isNewSession) lastSeenSessionStart = currentSessionStart
  applyResetPolicies(new Date(), isNewSession)

  const card = getActiveCard()

  let activeTone = ""
  if (card) {
    const hit = evaluateWhenEngine(card.sections.whenRules, pool)
    activeTone = hit?.tone ?? "正常交流，保持角色设定"
  }

  const thinkingEffort = getEffectiveThinkingEffort()
  const personalityEnabled = personalityConfig.enabled && card !== null

  // ═══ 1. Phase1: 能力层 ═══
  const capCtx = buildCapabilityPrompt(
    { recentMessages: chatMessages, userText, unansweredCount, thinkingEffort, isActiveMessage },
    card, getPoolSnapshot(),
  )

  log.info(`\n${"═".repeat(50)}\n  【Phase1 能力层 Prompt】Tools=${capCtx.tools.length} tokens≈${capCtx.estimatedSystemTokens}\n${"═".repeat(50)}\n${capCtx.systemPrompt}\n${"─".repeat(50)}`)
  applyEffect(PetPersonalityMiddleware.wrap("thinking"), effects)

  const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
  const provider = new OpenAICompatibleProvider()

  const maxRounds = loopConfig.maxToolCallsPerTurn
  const maxRetry = loopConfig.maxRetry + 1
  const turnTimeout = loopConfig.turnTimeoutMs

  let phase1Reply = ""
  let emotionTag: string | null = null

  // ── Phase1 工具循环 ──
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (attempt > 0) retriesUsed = attempt
    try {
      const result = await runPhase1Loop({
        provider, systemPrompt: capCtx.systemPrompt, tools: capCtx.tools,
        chatMessages, maxRounds, startTime, turnTimeout, toolCallHistory,
        thinkingEffort, effects, userText,
      })
      phase1Reply = result.reply
      break
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (attempt >= maxRetry - 1) {
        log.error("Phase1 重试耗尽")
        transition("WAITING")
        const errEffect = PetPersonalityMiddleware.wrap("error", { message: "啊...信号不太好～" })
        applyEffect(errEffect, effects)
        return { reply: "（唔…试了好几次都失败了…）", toolCallHistory, retriesUsed, effects }
      }
    }
  }

  // ═══ 2. 无角色 = 直接返回 ═══
  if (!personalityEnabled || !card) {
    transition("WAITING")
    savePoolToDisk()
    MemoryService.recordTurn("assistant", phase1Reply)
    compactOnHighUsage(chatMessages, userText)
    const doneEffect = PetPersonalityMiddleware.wrap("done", { actionCategory: "_default" })
    applyEffect(doneEffect, effects)
    return { reply: phase1Reply, toolCallHistory, retriesUsed, effects }
  }

  // ═══ 3. Phase2: 风格化 ═══
  const toolSummary = summarizeToolCalls(toolCallHistory)
  const styleCtx = buildStylePrompt({
    card, rawReply: phase1Reply, userText, pool: getPoolSnapshot(), toolCallSummary: toolSummary,
  })

  log.info(`\n${"═".repeat(50)}\n  【Phase2 风格层 Prompt】\n${"═".repeat(50)}\n${styleCtx.systemPrompt}\n${"─".repeat(50)}\n  【Phase2 User Message】\n${"─".repeat(50)}\n${styleCtx.userMessage}\n${"─".repeat(50)}`)

  let finalReply = phase1Reply
  let success = false

  for (let attempt = 0; attempt <= replyConfig.phase2Retry; attempt++) {
    try {
      if (replyConfig.streamEnabled) {
        // 流式 — 首个 token 立即剥离情绪标签
        let firstTokenBuf = ""
        let tagStripped = false
        const raw = await provider.generateReplyStream(
          {
            messages: [
              { id: createMessageId(), role: "user" as const, text: styleCtx.userMessage, timestamp: Date.now() },
            ],
            systemPrompt: styleCtx.systemPrompt,
            thinkingEffort: replyConfig.phase2ThinkingEffort as any,
          },
          (token) => {
            if (!tagStripped) {
              firstTokenBuf += token
              const parsed = stripEmotionTag(firstTokenBuf)
              if (parsed.emotionKey !== null || firstTokenBuf.length > 25) {
                tagStripped = true
                if (parsed.emotionKey) emotionTag = parsed.emotionKey
                if (parsed.text) emit("reply-token", { token: parsed.text })
              }
            } else {
              emit("reply-token", { token })
            }
          },
        )
        // 流式完成后统一剥离（确保 emotionTag 有值）
        if (!tagStripped) {
          const parsed = stripEmotionTag(raw)
          finalReply = parsed.text
          emotionTag = parsed.emotionKey
        } else {
          const parsed = stripEmotionTag(raw)
          finalReply = parsed.text
          if (!emotionTag) emotionTag = parsed.emotionKey
        }
      } else {
        const result = await provider.generateReply({
          messages: [
            { id: createMessageId(), role: "user" as const, text: styleCtx.userMessage, timestamp: Date.now() },
          ],
          systemPrompt: styleCtx.systemPrompt,
          thinkingEffort: replyConfig.phase2ThinkingEffort as any,
        })
        const parsed = stripEmotionTag(result.text)
        finalReply = parsed.text
        emotionTag = parsed.emotionKey
      }
      success = true
      break
    } catch (e) {
      if (attempt < replyConfig.phase2Retry) {
        applyEffect(PetPersonalityMiddleware.wrap("retry"), effects)
      }
    }
  }

  // ═══ 4. 收尾 ═══
  const emoMappings = card.sections.emotionMappings
  const resolved = resolveEmotion(emotionTag, emoMappings)
  effects.push({ expression: resolved.expression, soundEvent: resolved.sound })
  emit("deskpet-expression", { expression: resolved.expression }).catch(() => {})
  if (resolved.sound) emit("deskpet-sound", { event: resolved.sound }).catch(() => {})

  transition("WAITING")
  MemoryService.recordTurn("assistant", finalReply)
  compactOnHighUsage(chatMessages, userText)

  savePoolToDisk()

  return { reply: finalReply, toolCallHistory, retriesUsed, effects }
}

// ── Phase1 工具循环 ──

async function runPhase1Loop(opts: {
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
      finalReply = "（处理时间太长了…）"
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
      const tool = getToolByName(tc.name)

      const cat = tool?.actionCategory ?? "_default"
      applyEffect(PetPersonalityMiddleware.wrap("executing", { actionCategory: cat, toolName: tc.name }), effects)
      emitToolEvent("tool-executing", { toolId: tc.name, toolName: tc.name })

      if (!tool) {
        toolCallHistory.push({ toolName: tc.name, status: "error" })
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: `工具不存在: ${tc.name}` })))
        continue
      }

      const safetyResult = checkSafety(tool, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (!safetyResult.allowed) {
        applyEffect(PetPersonalityMiddleware.wrap("blocked", { actionCategory: cat, toolName: tc.name }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "blocked" })
        loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: safetyResult.personalityMessage ?? "被拦截" })))
        continue
      }

      if (safetyResult.needsConfirm && safetyResult.confirmMessage) {
        const approved = await requestConfirm(tc.name, safetyResult.confirmMessage)
        if (!approved) {
          toolCallHistory.push({ toolName: tc.name, status: "denied" })
          loopMessages.push(createToolMessage(tc.id, JSON.stringify({ toolCallId: tc.id, content: "", error: "用户取消" })))
          continue
        }
        if (tool.safetyLevel === "NORMAL") trustToolInSession(tc.name)
      }

      const result = await executeTool(tc.name, params, {
        mode: modeConfig.assistant ? "assistant" : "pet",
        sessionTrusted: false,
      })

      if (result.success) {
        applyEffect(PetPersonalityMiddleware.wrap("done", { actionCategory: cat, toolName: tc.name }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "done" })
      } else {
        applyEffect(PetPersonalityMiddleware.wrap("error", { actionCategory: cat, toolName: tc.name, message: result.error }), effects)
        toolCallHistory.push({ toolName: tc.name, status: "error" })
      }

      loopMessages.push(createToolMessage(tc.id, result.success ? result.content : `Error: ${result.error}`))
      pushMessage(createToolMessage(tc.id, result.success ? result.content : `Error: ${result.error}`)) // 持久化
      emitToolEvent("tool-completed", { toolId: tc.name, toolName: tc.name, success: result.success })
    }
  }

  if (!finalReply && roundCount >= maxRounds) {
    finalReply = "（处理完成，但结果太复杂了…）"
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
