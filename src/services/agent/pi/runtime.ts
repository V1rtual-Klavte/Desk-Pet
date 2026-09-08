// Desk-Pet's only multi-turn agent runtime. Pi owns the model/tool loop;
// Desk-Pet owns product state, safety, sessions, Card variables, and effects.

import { Agent } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, Message as PiMessage } from "@earendil-works/pi-ai"
import type { Message, ThinkingEffort, ToolCallRequest } from "@/services/agent/types"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { MemoryService } from "@/services/agent/memory"
import { buildPrompt } from "@/services/context"
import { compactOnHighUsage, estimateTokens } from "@/services/engine/compactor"
import { requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import { executePlan, evaluateComplexity, formatStepResults, generatePlan } from "@/services/engine/planner"
import { recordMessage, recordToolCall, transition } from "@/services/engine/session"
import { getEffectiveThinkingEffort, updateRequestStats } from "@/services/debug"
import { getActiveCard } from "@/services/personality/registry"
import { getPoolSnapshot, getSessionStart, applyResetPolicies, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import type { PersonalityEffect } from "@/services/personality/middleware"
import { getFallbackReply, getSimpleStage, getStagePrompt } from "@/services/personality/stages-cache"
import { generateReply } from "@/services/reply"
import { checkSafety, requestConfirm, trustToolInSession } from "@/services/safety"
import { pushMessage } from "@/services/session/store"
import { getToolByName, getToolsForMode } from "@/services/tool/registry"
import { executeTool } from "@/services/tool/router"
import type { ToolDef } from "@/services/tool/types"
import { aiConfig, generalConfig, loopConfig, planConfig, safetyConfig } from "@/services/config"
import { emit } from "@tauri-apps/api/event"
import { getPiModel, piStream, toPiAgentThinkingLevel } from "./model-gateway"

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

let lastSeenSessionStart = getSessionStart()

export interface PiAgentTurnInput {
  userText: string
  chatMessages: Message[]
  unansweredCount: number
  messageCount: number
  isActiveMessage?: boolean
  isRetry?: boolean
}

export interface PiAgentTurnOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  effects: { expression: string; soundEvent: string | null }[]
}

export interface PiSubAgentInput {
  task: string
  tools: ToolDef[]
  systemPrompt: string
  maxRounds?: number
  timeoutMs?: number
  thinkingEffort?: ThinkingEffort
}

export interface PiSubAgentOutput {
  reply: string
  toolCallsMade: number
  success: boolean
  error?: string
}

interface PiLoopInput {
  userText: string
  chatMessages: Message[]
  systemPrompt: string
  tools: ToolDef[]
  maxToolCalls: number
  timeoutMs: number
  thinkingEffort: ThinkingEffort
  mode: "pet" | "assistant"
  effects?: PiAgentTurnOutput["effects"]
  toolCallHistory?: PiAgentTurnOutput["toolCallHistory"]
  persistToolMessages?: boolean
  timeoutReply?: string
}

interface PiLoopOutput {
  reply: string
  toolCallsMade: number
  error?: string
}

/** Main pet turn. This replaces the deleted hand-written Agent Loop. */
export async function runPiAgentTurn(input: PiAgentTurnInput): Promise<PiAgentTurnOutput> {
  const { userText, chatMessages, unansweredCount, isActiveMessage } = input
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []
  const effects: PiAgentTurnOutput["effects"] = []

  recordMessage()
  MemoryService.recordTurn("user", userText)

  refreshVariablePool()
  updateInteractionVar("unansweredCount", unansweredCount)
  const currentSessionStart = getSessionStart()
  const isNewSession = currentSessionStart !== lastSeenSessionStart
  if (isNewSession) lastSeenSessionStart = currentSessionStart
  applyResetPolicies(new Date(), isNewSession)

  const card = getActiveCard()
  const thinkingEffort = getEffectiveThinkingEffort()
  const context = buildPrompt(
    { recentMessages: chatMessages, userText, unansweredCount, thinkingEffort, isActiveMessage },
    card,
    getPoolSnapshot(),
  )

  let planStepContext = ""
  let planUserText = userText
  if (generalConfig.assistantMode && planConfig.enabled) {
    const forcePlan = userText.startsWith("--plan")
    if (forcePlan) planUserText = userText.replace(/^--plan\s*/, "")
    const complexity = await evaluateComplexity(planUserText, planConfig.keywords)
    if (complexity.score >= planConfig.complexityThreshold) {
      transition("PLANNING")
      applyEffect(PetPersonalityMiddleware.wrap("planning"), effects)
      const plan = await generatePlan(planUserText, {
        cardId: card?.id ?? "neutral",
        cardRole: card?.sections.roleSetting ?? "",
        availableTools: getToolsForMode("assistant"),
        thinkingEffort: planConfig.thinkingEffort,
      })
      if (plan.steps.length > 0) {
        let confirmed = safetyConfig.mode === "just_do_it"
        let stepMode: "auto" | "stepByStep" = "auto"
        if (!confirmed) {
          const result = await requestPlanConfirm(
            plan,
            safetyConfig.mode === "let_me_tk" ? { forceStepByStep: true } : undefined,
          )
          confirmed = result.confirmed
          stepMode = result.mode
        }
        if (!confirmed) {
          transition("WAITING")
          return { reply: getSimpleStage("planning") ?? "好的，已取消计划～", toolCallHistory, retriesUsed: 0, effects: [] }
        }
        const result = await executePlan(plan, {
          stepTimeoutMs: planConfig.stepTimeoutMs,
          stepMaxRounds: planConfig.stepMaxRounds,
          stepThinkingEffort: planConfig.stepThinkingEffort,
          maxSteps: planConfig.maxSteps,
          onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
        }, {
          onStepStart(step) { emit("deskpet-plan-progress", { step: step.id, total: plan.steps.length, desc: step.description, status: "running" }) },
          onStepDone(step, output) { emit("deskpet-plan-progress", { step: step.id, total: plan.steps.length, desc: step.description, status: output.success ? "done" : "failed" }) },
          onStepFailed: requestPlanStepDecision,
        })
        planStepContext = formatStepResults(result)
      }
    }
  }

  if (planStepContext) context.systemPrompt += `\n\n${planStepContext.slice(0, 4000)}`
  applyEffect(PetPersonalityMiddleware.wrap("thinking"), effects)

  let retriesUsed = 0
  let rawReply = ""
  for (let attempt = 0; attempt <= loopConfig.maxRetry; attempt++) {
    const result = await runPiLoop({
      userText,
      chatMessages,
      systemPrompt: context.systemPrompt,
      tools: isActiveMessage ? [] : getToolsForMode(),
      maxToolCalls: loopConfig.maxToolCallsPerTurn,
      timeoutMs: loopConfig.turnTimeoutMs,
      timeoutReply: getFallbackReply("turnTimeout"),
      thinkingEffort,
      mode: generalConfig.assistantMode ? "assistant" : "pet",
      effects,
      toolCallHistory,
      persistToolMessages: true,
    })
    if (!result.error) {
      rawReply = result.reply
      retriesUsed = attempt
      break
    }
    // Replaying a failed model request is safe only before any side-effecting tool ran.
    if (result.toolCallsMade > 0 || attempt >= loopConfig.maxRetry) {
      transition("WAITING")
      applyEffect(PetPersonalityMiddleware.wrap("error", { message: result.error }), effects)
      return { reply: getFallbackReply("maxRetriesExhausted"), toolCallHistory, retriesUsed: attempt, effects }
    }
  }

  const processed = await generateReply(rawReply, card)
  effects.push({ expression: processed.expression, soundEvent: processed.sound })
  emit("deskpet-expression", { expression: processed.expression }).catch(() => {})
  if (processed.sound) emit("deskpet-sound", { event: processed.sound }).catch(() => {})
  transition("WAITING")
  MemoryService.recordTurn("assistant", processed.text)
  compactOnHighUsage(chatMessages, userText)
  return { reply: processed.text, toolCallHistory, retriesUsed, effects }
}

/** Used by planning and fork/team agents. It shares the same Pi runtime, not a second loop. */
export async function runPiSubAgent(input: PiSubAgentInput): Promise<PiSubAgentOutput> {
  const result = await runPiLoop({
    userText: input.task,
    chatMessages: [],
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    maxToolCalls: input.maxRounds ?? 3,
    timeoutMs: input.timeoutMs ?? 60000,
    thinkingEffort: input.thinkingEffort ?? "low",
    mode: "pet",
  })
  return {
    reply: result.reply || getFallbackReply(result.error ? "subAgentFailed" : "subAgentDone"),
    toolCallsMade: result.toolCallsMade,
    success: !result.error,
    error: result.error,
  }
}

async function runPiLoop(input: PiLoopInput): Promise<PiLoopOutput> {
  const toolCallHistory = input.toolCallHistory ?? []
  const effects = input.effects
  const toolsByName = new Map(input.tools.map(tool => [tool.name, tool]))
  let toolCallsMade = 0
  const persistedMessageIds = new Set<string>()
  let stoppedAtToolLimit = false

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: getPiModel(),
      thinkingLevel: toPiAgentThinkingLevel(input.thinkingEffort),
      tools: input.tools.map(tool => toPiTool(tool, input, toolsByName, toolCallHistory, effects)),
      messages: toPiMessages(input.chatMessages),
    },
    streamFn: piStream,
    toolExecution: "sequential",
    // Current memory compaction is intentionally deferred to the next migration stage.
    transformContext: async (messages) => messages,
    beforeToolCall: async ({ toolCall, args }) => {
      const tool = toolsByName.get(toolCall.name)
      if (toolCallsMade >= input.maxToolCalls) {
        stoppedAtToolLimit = true
        toolCallHistory.push({ toolName: toolCall.name, status: "blocked" })
        return { block: true, reason: `工具调用次数达到上限 (${input.maxToolCalls})`, terminate: true }
      }
      toolCallsMade++
      if (!tool) {
        toolCallHistory.push({ toolName: toolCall.name, status: "error" })
        return { block: true, reason: `工具 ${toolCall.name} 不可用` }
      }

      recordToolCall()
      const category = tool.actionCategory ?? "_default"
      transition("EXECUTING")
      if (effects) applyEffect(PetPersonalityMiddleware.wrap("executing", { actionCategory: category, toolName: tool.name }), effects)
      emitToolEvent("tool-executing", { toolId: tool.name, toolName: tool.name })

      const safety = checkSafety(tool, args as Record<string, unknown>, { mode: input.mode, sessionTrusted: false })
      if (!safety.allowed) {
        const message = safety.personalityMessage ?? getStagePrompt("blocked", category) ?? "操作被拦截"
        if (effects) applyEffect(PetPersonalityMiddleware.wrap("blocked", { actionCategory: category, toolName: tool.name }), effects)
        toolCallHistory.push({ toolName: tool.name, status: "blocked", personalityMsg: message })
        return { block: true, reason: message }
      }
      if (safety.needsConfirm && safety.confirmMessage) {
        const approved = await requestConfirm(tool.name, safety.confirmMessage)
        if (!approved) {
          const message = getStagePrompt("blocked", category) ?? "操作被拦截"
          toolCallHistory.push({ toolName: tool.name, status: "denied", personalityMsg: message })
          return { block: true, reason: message }
        }
        if (tool.safetyLevel === "NORMAL") trustToolInSession(tool.name)
      }
      return undefined
    },
  })

  agent.subscribe((event) => {
    if (event.type === "message_end" && input.persistToolMessages) {
      persistPiMessage(event.message, persistedMessageIds)
    }
    if (event.type === "tool_execution_end") {
      emitToolEvent("tool-completed", {
        toolId: event.toolName,
        toolName: event.toolName,
        success: !event.isError,
      })
    }
  })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; agent.abort() }, input.timeoutMs)
  try {
    transition("GENERATING")
    const initial = agent.state.messages
    const last = initial[initial.length - 1]
    if (last?.role === "user") await agent.continue()
    else await agent.prompt(input.userText)
  } catch (error) {
    if (timedOut) {
      return input.timeoutReply
        ? { reply: input.timeoutReply, toolCallsMade }
        : { reply: "", toolCallsMade, error: "子代理执行超时" }
    }
    return { reply: "", toolCallsMade, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }

  if (stoppedAtToolLimit) {
    return { reply: getFallbackReply("toolLoopMaxRounds"), toolCallsMade }
  }

  if (timedOut) {
    return input.timeoutReply
      ? { reply: input.timeoutReply, toolCallsMade }
      : { reply: "", toolCallsMade, error: "子代理执行超时" }
  }

  const lastAssistant = [...agent.state.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant")
  if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
    return { reply: "", toolCallsMade, error: lastAssistant?.errorMessage || "Pi Agent 未返回有效回复" }
  }
  updateRequestStats({
    promptTokens: lastAssistant.usage.input,
    completionTokens: lastAssistant.usage.output,
    systemTokens: Math.ceil(input.systemPrompt.length / 2.5),
    conversationTokens: estimateTokens(input.chatMessages),
    toolCount: input.tools.length,
    toolNames: input.tools.map(tool => tool.name),
  })
  return { reply: contentText(lastAssistant.content), toolCallsMade }
}

function toPiTool(
  tool: ToolDef,
  input: PiLoopInput,
  toolsByName: Map<string, ToolDef>,
  history: PiAgentTurnOutput["toolCallHistory"],
  effects: PiAgentTurnOutput["effects"] | undefined,
): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // Pi validates plain JSON Schema too; Desk-Pet's schemas are already that subset.
    parameters: tool.parameters as any,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const current = toolsByName.get(tool.name)
      if (!current) throw new Error(`工具未注册: ${tool.name}`)
      const result = await executeTool(tool.name, params as Record<string, unknown>, { mode: input.mode, sessionTrusted: false })
      const category = current.actionCategory ?? "_default"
      if (result.success) {
        if (effects) applyEffect(PetPersonalityMiddleware.wrap("done", { actionCategory: category, toolName: tool.name }), effects)
        history.push({ toolName: tool.name, status: "done" })
        return { content: [{ type: "text", text: result.content }], details: result }
      }
      if (effects) applyEffect(PetPersonalityMiddleware.wrap("error", { actionCategory: category, toolName: tool.name, message: result.error }), effects)
      history.push({ toolName: tool.name, status: "error" })
      throw new Error(`${getSimpleStage("error") ?? "Error"}: ${result.error ?? "工具执行失败"}`)
    },
  }
}

function toPiMessages(messages: Message[]): PiMessage[] {
  const toolNames = new Map<string, string>()
  const result: PiMessage[] = []
  const model = getPiModel()
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") {
      result.push({ role: "user", content: message.text, timestamp: message.timestamp })
      continue
    }
    if (message.role === "tool") {
      result.push({
        role: "toolResult",
        toolCallId: message.toolCallId ?? message.id,
        toolName: toolNames.get(message.toolCallId ?? "") ?? "tool",
        content: [{ type: "text", text: message.text }],
        isError: false,
        timestamp: message.timestamp,
      })
      continue
    }
    const toolCalls = (message.toolCalls ?? []).map((toolCall) => {
      toolNames.set(toolCall.id, toolCall.name)
      return { type: "toolCall" as const, id: toolCall.id, name: toolCall.name, arguments: parseArgs(toolCall.arguments) }
    })
    result.push({
      role: "assistant",
      content: toolCalls.length > 0 ? toolCalls : [{ type: "text" as const, text: message.text }],
      api: "openai-completions",
      provider: model.provider,
      model: aiConfig.model,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: message.timestamp,
    })
  }
  return result
}

function persistPiMessage(message: AgentMessage, seen: Set<string>): void {
  if (message.role === "assistant") {
    const toolCalls = message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall")
    if (toolCalls.length === 0) return
    const id = toolCalls.map(call => call.id).join(":")
    if (seen.has(id)) return
    seen.add(id)
    const appMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      text: contentText(message.content),
      toolCalls: toolCalls.map((call): ToolCallRequest => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
      timestamp: message.timestamp,
    }
    pushMessage(appMessage)
    return
  }
  if (message.role === "toolResult") {
    const id = `tool:${message.toolCallId}`
    if (seen.has(id)) return
    seen.add(id)
    pushMessage(createToolMessage(message.toolCallId, contentText(message.content)))
  }
}

function parseArgs(args: string): Record<string, unknown> {
  try { return JSON.parse(args) } catch { return {} }
}

function applyEffect(effect: PersonalityEffect, effects: PiAgentTurnOutput["effects"]): void {
  effects.push({ expression: effect.expression, soundEvent: effect.soundEvent })
}

async function emitToolEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try { await emit(event, payload) } catch { /* UI event is best effort */ }
}
