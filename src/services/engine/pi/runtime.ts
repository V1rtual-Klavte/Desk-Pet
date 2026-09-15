// Desk-Pet's only multi-turn agent runtime. Pi owns the model/tool loop;
// Desk-Pet owns product state, safety, sessions, Card variables, and effects.

import { Agent } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, Message as PiMessage, Model } from "@earendil-works/pi-ai"
import type { Message, ThinkingEffort, ToolCallRequest } from "@/services/agent/types"
import type { ContextBlock, IngressEnvelope, MessageOrigin, MessageTaint, PromptSnapshot, PromptTransform, SessionEvent } from "@/services/engine/runtime"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { MemoryService, emptyMemoryProvider, planCheckpointStore, planStepEffectClass } from "@/services/agent/memory"
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
import { checkSafety, isToolTrusted, requestConfirm, trustToolInSession } from "@/services/safety"
import { pushMessage } from "@/services/session/store"
import { getToolByName, getToolsForMode } from "@/services/tool/registry"
import { executeTool } from "@/services/tool/router"
import type { ActionCategory, ToolDef } from "@/services/tool/types"
import { aiConfig, generalConfig, loopConfig, planConfig, safetyConfig } from "@/services/config"
import { emit } from "@tauri-apps/api/event"
import { getPiModel, piStream, toPiAgentThinkingLevel } from "./model-gateway"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { agentSlots, createPromptRewrite, createPromptSnapshot, createRuntimeTraceContext, hookBus, publishRuntimeTrace } from "@/services/engine/runtime"
import { redactText, sha256Text, stableSerialize } from "@/services/engine/runtime"

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const log = createLogger("PiRuntime")

let lastSeenSessionStart = getSessionStart()

export interface PiRuntimeProviderOverride {
  model: Model<any>
  streamFn: StreamFn
}

let piRuntimeProviderOverride: PiRuntimeProviderOverride | undefined

/**
 * Live Test 专用 provider 注入点。生产启动不会调用它，默认仍走配置的 piStream。
 * 返回清理函数，避免 fake provider 泄漏到后续场景。
 */
export function installPiRuntimeProviderForTest(override: PiRuntimeProviderOverride): () => void {
  const previous = piRuntimeProviderOverride
  piRuntimeProviderOverride = override
  return () => { piRuntimeProviderOverride = previous }
}

export function resetPiRuntimeProviderForTest(): void {
  piRuntimeProviderOverride = undefined
}

/**
 * 向正在执行的回合插话，并把插话内容记入该回合所属会话。
 *
 * Pi 的语义是「本轮结束后注入」，不是立即中止 —— 当前批次里已经开始的工具会照常跑完，
 * 模型在下一轮才会看到这条消息并据此调整。
 *
 * @returns 是否有正在执行的回合可以接收插话
 */
export function deliverActiveTurn(sessionId: string, text: string): "steered" | "followup" | undefined {
  return agentSlots.deliver(sessionId, text)
}

export interface PiAgentTurnInput {
  sessionId?: string
  userText: string
  chatMessages: Message[]
  unansweredCount: number
  messageCount: number
  isActiveMessage?: boolean
  isRetry?: boolean
  ingress?: IngressEnvelope
  runGeneration?: number
  turnId?: string
}

export interface PiAgentTurnOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  effects: { expression: string; soundEvent: string | null }[]
  runtimeData?: { emotionKey: string | null; variables: Record<string, string> }
}

export interface PiSubAgentInput {
  task: string
  tools: ToolDef[]
  systemPrompt: string
  maxRounds?: number
  timeoutMs?: number
  thinkingEffort?: ThinkingEffort
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
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
  /** 传给 Pi 用于 Provider 端 prompt cache 的会话标识 */
  sessionId?: string
  /** 是否把本回合的 Agent 登记为「可插话」。主回合为真，子代理/规划步骤为假。 */
  exposeAsActiveAgent?: boolean
  runGeneration?: number
  effects?: PiAgentTurnOutput["effects"]
  toolCallHistory?: PiAgentTurnOutput["toolCallHistory"]
  persistToolMessages?: boolean
  timeoutReply?: string
  onToolStart?: PiSubAgentInput["onToolStart"]
  onToolDone?: PiSubAgentInput["onToolDone"]
  contextBlocks?: ContextBlock[]
  promptTransforms?: PromptTransform[]
  requestId?: string
  turnId?: string
  ingress?: IngressEnvelope
}

/**
 * 同一批次里可以并行执行的只读操作类别。
 * 其余类别（写入、执行、启动应用、子代理、Skill）都会把整批拉回串行。
 */
const PARALLEL_SAFE_CATEGORIES: ReadonlySet<ActionCategory> = new Set([
  "fs.read", "os.info", "net.fetch", "clip.read",
])

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
  const turnSessionId = input.sessionId || MemoryService.sessionId
  // 主动搭话的 userText 是系统拼的窗口上下文，不是用户输入。落盘会让会话主题
  // 提取拿它当首条用户消息，重载后还会显示成用户气泡并进入长期记忆。
  if (!isActiveMessage) await persistTurn(turnSessionId, "user", userText, input.ingress)
  else await persistRuntimeEvent(turnSessionId, "active", userText, input.ingress)

  refreshVariablePool()
  updateInteractionVar("unansweredCount", unansweredCount)
  const currentSessionStart = getSessionStart()
  const isNewSession = currentSessionStart !== lastSeenSessionStart
  if (isNewSession) lastSeenSessionStart = currentSessionStart
  applyResetPolicies(new Date(), isNewSession)

  const card = getActiveCard()
  const thinkingEffort = getEffectiveThinkingEffort()
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
        const now = Date.now()
        const planId = `plan-${input.ingress?.requestId ?? crypto.randomUUID()}`
        const rootTurnId = input.turnId ?? input.ingress?.parentTurnId ?? `turn-${input.ingress?.requestId ?? crypto.randomUUID()}`
        await planCheckpointStore.create({
          schemaVersion: 1,
          planId,
          sessionId: turnSessionId,
          rootTurnId,
          state: "admitting",
          agentIds: plan.steps.map(step => `${planId}:agent:${step.id}`),
          version: 1,
          createdAt: now,
          updatedAt: now,
        }, plan.steps.map(step => ({
          planId,
          stepId: String(step.id),
          agentId: `${planId}:agent:${step.id}`,
          title: step.description,
          dependsOn: (step.dependsOn ?? []).map(String),
          state: "pending",
          attempt: 0,
          idempotencyKey: `${planId}:step:${step.id}`,
          effectClass: planStepEffectClass(step.allowedTools),
          updatedAt: now,
        })))
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
          for (const step of plan.steps) await planCheckpointStore.transitionStep(planId, String(step.id), "skipped")
          await planCheckpointStore.transitionPlan(planId, "failed")
          transition("WAITING")
          const reply = getSimpleStage("planning") ?? "好的，已取消计划～"
          await persistTurn(turnSessionId, "assistant", reply)
          return { reply, toolCallHistory, retriesUsed: 0, effects: [] }
        }
        await planCheckpointStore.transitionPlan(planId, "running")
        const result = await executePlan(plan, {
          stepTimeoutMs: planConfig.stepTimeoutMs,
          stepMaxRounds: planConfig.stepMaxRounds,
          stepThinkingEffort: planConfig.stepThinkingEffort,
          maxSteps: planConfig.maxSteps,
          onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
        }, {
          async onStepStart(step) {
            await planCheckpointStore.transitionStep(planId, String(step.id), "running")
            emit("deskpet-plan-progress", { step: step.id, total: plan.steps.length, desc: step.description, status: "running" })
          },
          async onStepDone(step, output) {
            await planCheckpointStore.transitionStep(planId, String(step.id), output.success ? "done" : "failed")
            emit("deskpet-plan-progress", { step: step.id, total: plan.steps.length, desc: step.description, status: output.success ? "done" : "failed" })
          },
          onStepFailed: requestPlanStepDecision,
          onToolStart: (step, toolName, toolCallId) => planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId),
          onToolDone: (step, toolName, toolCallId, success) => planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, success),
        })
        await planCheckpointStore.transitionPlan(planId, result.overallSuccess ? "done" : "failed")
        planStepContext = formatStepResults(result)
      }
    }
  }

  const requestId = input.ingress?.requestId ?? `runtime-${input.turnId ?? turnSessionId}`
  const memoryProjections = await emptyMemoryProvider.recall({
    requestId,
    sessionId: turnSessionId,
    query: userText,
    tokenBudget: Math.floor(aiConfig.contextMaxTokens * 0.15),
  })
  const context = buildPrompt({
    recentMessages: chatMessages,
    userText,
    unansweredCount,
    thinkingEffort,
    isActiveMessage,
    memoryProjections,
    ...(planStepContext ? { ephemeralText: planStepContext.slice(0, 4000), ephemeralOrigin: "plan" as const } : {}),
  }, card, getPoolSnapshot())
  const promptTransforms: PromptTransform[] = []
  if (input.ingress && input.ingress.rawText !== userText) {
    promptTransforms.push(await createPromptRewrite({
      transformId: `rewrite-${requestId}`,
      name: "normalize_user_input",
      rawText: input.ingress.rawText,
      derivedText: userText,
      reason: "input_normalization",
      derivedFrom: [input.turnId ?? requestId],
    }))
  }
  applyEffect(PetPersonalityMiddleware.wrap("thinking"), effects)

  let retriesUsed = 0
  let rawReply = ""
  for (let attempt = 0; attempt <= loopConfig.maxRetry; attempt++) {
    const result = await runPiLoop({
      userText,
      chatMessages: context.recentMessages,
      systemPrompt: context.systemPrompt,
      tools: isActiveMessage ? [] : getToolsForMode(),
      maxToolCalls: loopConfig.maxToolCallsPerTurn,
      timeoutMs: loopConfig.turnTimeoutMs,
      timeoutReply: getFallbackReply("turnTimeout"),
      thinkingEffort,
      mode: generalConfig.assistantMode ? "assistant" : "pet",
      sessionId: turnSessionId,
      exposeAsActiveAgent: true,
      runGeneration: input.runGeneration,
      effects,
      toolCallHistory,
      persistToolMessages: true,
      contextBlocks: context.blocks,
      promptTransforms,
      requestId,
      turnId: input.turnId,
      ingress: input.ingress,
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
      const reply = getFallbackReply("maxRetriesExhausted")
      await persistTurn(turnSessionId, "assistant", reply)
      return { reply, toolCallHistory, retriesUsed: attempt, effects }
    }
  }

  const processed = await generateReply(rawReply, card)
  effects.push({ expression: processed.expression, soundEvent: processed.sound })
  emit("deskpet-expression", { expression: processed.expression }).catch(() => {})
  if (processed.sound) emit("deskpet-sound", { event: processed.sound }).catch(() => {})
  transition("WAITING")
  await persistTurn(turnSessionId, "assistant", processed.text)
  compactOnHighUsage(chatMessages, userText)
  return { reply: processed.text, toolCallHistory, retriesUsed, effects, runtimeData: processed.runtimeData }
}

async function persistTurn(sessionId: string, role: "user" | "assistant", text: string, ingress?: IngressEnvelope): Promise<void> {
  if (!sessionId || MemoryService.sessionId === sessionId) {
    MemoryService.recordTurn(role, text)
  } else {
    await MemoryService.recordTurnToSession(sessionId, role, text)
  }
  await persistRuntimeEvent(sessionId, role, text, ingress)
}

async function persistRuntimeEvent(sessionId: string, origin: MessageOrigin, text: string, ingress?: IngressEnvelope): Promise<void> {
  if (!sessionId) return
  const isActive = origin === "active"
  const event: SessionEvent = {
    schemaVersion: 1,
    eventId: `${origin}-${ingress?.requestId ?? crypto.randomUUID()}-${Date.now()}`,
    sessionId,
    kind: isActive ? "active_message" : origin === "assistant" ? "assistant_message" : "user_message",
    origin,
    payload: {
      text,
      rawText: ingress?.rawText ?? text,
      normalizedText: ingress?.normalizedText ?? text.trim(),
      visibleToUser: !isActive,
      persisted: true,
      eligibleForTranscript: !isActive,
      eligibleForMemory: origin === "user" && !isActive,
      isMeta: isActive,
      taint: ingress?.taint ?? (isActive ? "derived" : "trusted_user") as MessageTaint,
      ...(ingress ? { querySource: ingress.querySource, priority: ingress.priority, requestId: ingress.requestId } : {}),
    },
    createdAt: Date.now(),
    idempotencyKey: `${origin}:${ingress?.requestId ?? text}:${text}`,
  }
  const written = await MemoryService.appendSessionEventToSession(sessionId, event, text)
  if (!written) {
    await MemoryService.createSessionFile(sessionId)
    await MemoryService.appendSessionEventToSession(sessionId, event, text)
  }
}

async function persistPromptSnapshot(sessionId: string, snapshot: PromptSnapshot): Promise<void> {
  const event: SessionEvent = {
    schemaVersion: 1,
    eventId: `prompt-snapshot-${snapshot.snapshotId}`,
    sessionId,
    turnId: snapshot.turnId,
    kind: "prompt_snapshot",
    origin: "assistant",
    payload: { snapshot },
    createdAt: snapshot.createdAt,
    idempotencyKey: `prompt-snapshot:${snapshot.snapshotId}`,
  }
  await MemoryService.appendSessionEventToSession(sessionId, event)
}

function providerMessages(payload: unknown): Array<{ role: string; content?: string; toolCallId?: string }> {
  if (!payload || typeof payload !== "object") return []
  const messages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap(message => {
    if (!message || typeof message !== "object") return []
    const record = message as Record<string, unknown>
    if (typeof record.role !== "string") return []
    return [{
      role: record.role,
      content: stableSerialize(record.content ?? ""),
      ...(typeof record.tool_call_id === "string" ? { toolCallId: record.tool_call_id } : {}),
    }]
  })
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
    onToolStart: input.onToolStart,
    onToolDone: input.onToolDone,
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
  const traceContext = createRuntimeTraceContext(input.sessionId, input.requestId, input.turnId)
  const runtimeProvider = piRuntimeProviderOverride
  const model = runtimeProvider?.model ?? getPiModel()
  const snapshotTasks: Promise<void>[] = []
  let snapshotSequence = 0
  let latestTransformedMessages: AgentMessage[] = []

  const captureSnapshot = async (
    captureStage: PromptSnapshot["captureStage"],
    agentMessages: AgentMessage[],
    llmMessages: Array<{ role: string; content?: string; toolCallId?: string }>,
  ): Promise<void> => {
    const snapshotId = `${traceContext.runId}:${captureStage}:${++snapshotSequence}`
    const toolSchemas = await Promise.all(input.tools.map(async tool => ({
      name: tool.name,
      schemaHash: await sha256Text(stableSerialize(tool.parameters)),
      policyHash: await sha256Text(stableSerialize({ actionCategory: tool.actionCategory, safetyLevel: tool.safetyLevel })),
    })))
    const snapshot = await createPromptSnapshot({
      snapshotId,
      requestId: input.requestId ?? traceContext.runId,
      sessionId: input.sessionId ?? "sub-agent",
      turnId: input.turnId ?? input.requestId ?? traceContext.runId,
      runId: traceContext.runId,
      captureStage,
      model: model.id,
      provider: model.provider,
      thinkingLevel: input.thinkingEffort,
      systemBlocks: input.contextBlocks ?? [{
        blockId: "static:sub-agent", layer: "static", source: "sub-agent",
        text: input.systemPrompt, priority: 100, origin: "system", taint: "system",
      }],
      toolSchemas,
      agentMessages: agentMessages.map((message, index) => ({
        id: `agent:${index}`,
        role: message.role,
        content: stableSerialize(message),
      })),
      llmMessages,
      transforms: input.promptTransforms ?? [],
      estimatedInputTokens: Math.ceil(input.systemPrompt.length / 2.5) + estimateTokens(input.chatMessages),
    })
    publishRuntimeTrace(traceContext, "prompt_snapshot", {
      snapshotId,
      requestId: snapshot.requestId,
      turnId: snapshot.turnId,
      captureStage,
    })
    if (input.sessionId) {
      try {
        await persistPromptSnapshot(input.sessionId, snapshot)
      } catch (error) {
        log.warn(`PromptSnapshot 持久化失败: ${snapshot.snapshotId}`, formatError(error))
      }
    }
  }
  publishRuntimeTrace(traceContext, "agent_start", {
    toolCount: input.tools.length,
    mode: input.mode,
    thinkingEffort: input.thinkingEffort,
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      thinkingLevel: toPiAgentThinkingLevel(input.thinkingEffort),
      tools: input.tools.map(tool => toPiTool(tool, input, toolsByName, toolCallHistory, effects)),
      messages: toPiMessages(input.chatMessages, model),
    },
    streamFn: runtimeProvider?.streamFn ?? piStream,
    sessionId: input.sessionId,
    // P5 safety gates are not complete yet; keep tool rounds deterministic and paired.
    toolExecution: "sequential",
    onPayload: (payload, model) => {
      const safePayload = redactText(stableSerialize(payload))
      const task = sha256Text(safePayload.text)
        .then(async payloadHash => {
          await captureSnapshot("provider_payload", latestTransformedMessages, providerMessages(payload))
          publishRuntimeTrace(traceContext, "provider_payload", {
          model: model.id,
          api: model.api,
          payloadHash,
          redactions: safePayload.redactions,
          })
        })
        .catch(() => undefined)
      snapshotTasks.push(task)
      return undefined
    },
    onResponse: (response, model) => {
      publishRuntimeTrace(traceContext, "provider_response", {
        model: model.id,
        api: model.api,
        status: response.status,
        headerNames: Object.keys(response.headers).sort(),
      })
    },
    transformContext: async (messages) => {
      latestTransformedMessages = messages
      await captureSnapshot("transform_context", messages, [])
      return messages
    },
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
      const hook = await hookBus.emit({
        hookId: `${toolCall.id}:before`,
        name: "before_tool_call",
        sessionId: input.sessionId,
        turnId: input.turnId,
        taint: input.ingress?.taint ?? "derived",
        payload: { toolName: tool.name, toolCallId: toolCall.id, args },
      })
      if (hook.decision === "block") {
        toolCallHistory.push({ toolName: tool.name, status: "blocked" })
        return { block: true, reason: hook.reason ?? "工具调用被 Hook 拦截" }
      }
      transition("EXECUTING")
      if (effects) applyEffect(PetPersonalityMiddleware.wrap("executing", { actionCategory: category, toolName: tool.name }), effects)
      emitToolEvent("tool-executing", { toolId: tool.name, toolName: tool.name })

      const safety = checkSafety(tool, args as Record<string, unknown>, { mode: input.mode, sessionTrusted: isToolTrusted(tool.name) })
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
    const eventPayload: Record<string, unknown> = {}
    if ("message" in event && event.message && typeof event.message === "object") {
      const message = event.message as { role?: unknown }
      if (typeof message.role === "string") eventPayload.role = message.role
    }
    if ("toolName" in event && typeof event.toolName === "string") eventPayload.toolName = event.toolName
    if ("toolCallId" in event && typeof event.toolCallId === "string") eventPayload.toolCallId = event.toolCallId
    if ("isError" in event && typeof event.isError === "boolean") eventPayload.isError = event.isError
    publishRuntimeTrace(traceContext, event.type, eventPayload)
    if (input.exposeAsActiveAgent && input.sessionId && input.runGeneration !== undefined) {
      if (event.type === "turn_start") agentSlots.markDeliveryPhase(input.sessionId, input.runGeneration, "streaming")
      if (event.type === "turn_end") agentSlots.markDeliveryPhase(input.sessionId, input.runGeneration, "settling")
    }
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

  if (input.exposeAsActiveAgent && input.sessionId && input.runGeneration !== undefined) {
    agentSlots.attach(input.sessionId, input.runGeneration, agent)
  }

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
    return { reply: "", toolCallsMade, error: formatError(error) }
  } finally {
    clearTimeout(timer)
    await Promise.allSettled(snapshotTasks)
    publishRuntimeTrace(traceContext, "agent_end", {
      toolCallsMade,
      timedOut,
      stoppedAtToolLimit,
    })
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
    prepareArguments: tool.prepareArguments,
    executionMode: PARALLEL_SAFE_CATEGORIES.has(tool.actionCategory) ? "parallel" : "sequential",
    async execute(toolCallId, params, signal, onUpdate) {
      const current = toolsByName.get(tool.name)
      if (!current) throw new Error(`工具未注册: ${tool.name}`)
      await input.onToolStart?.(tool.name, toolCallId)
      let toolSucceeded = false
      let result: Awaited<ReturnType<typeof executeTool>>
      try {
        result = await executeTool(tool.name, params as Record<string, unknown>, {
          mode: input.mode,
          sessionTrusted: isToolTrusted(tool.name),
          toolCallId,
          operationId: toolCallId,
          policyHash: await sha256Text(stableSerialize({ actionCategory: current.actionCategory, safetyLevel: current.safetyLevel })),
          signal,
          onUpdate: partial => onUpdate?.({
            content: partial.contentParts ?? [{ type: "text", text: partial.content }],
            details: partial.details,
          }),
        })
        toolSucceeded = result.success
      } finally {
        await input.onToolDone?.(tool.name, toolCallId, toolSucceeded)
        void hookBus.emit({
          hookId: `${toolCallId}:after`,
          name: "after_tool_call",
          sessionId: input.sessionId,
          turnId: input.turnId,
          taint: input.ingress?.taint ?? "derived",
          payload: { toolName: tool.name, toolCallId, success: toolSucceeded },
        })
      }
      const category = current.actionCategory ?? "_default"
      if (result.success) {
        if (effects) applyEffect(PetPersonalityMiddleware.wrap("done", { actionCategory: category, toolName: tool.name }), effects)
        history.push({ toolName: tool.name, status: "done" })
        return {
          content: result.contentParts ?? [{ type: "text", text: result.content }],
          details: result.details ?? result,
        }
      }
      if (effects) applyEffect(PetPersonalityMiddleware.wrap("error", { actionCategory: category, toolName: tool.name, message: result.error }), effects)
      history.push({ toolName: tool.name, status: "error" })
      throw new Error(`${getSimpleStage("error") ?? "Error"}: ${result.error ?? "工具执行失败"}`)
    },
  }
}

function toPiMessages(messages: Message[], model = getPiModel()): PiMessage[] {
  const toolNames = new Map<string, string>()
  const result: PiMessage[] = []
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
        // 必须还原落盘时的 isError，否则重开会话后模型会把失败的工具调用当成成功。
        isError: message.isError ?? false,
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
    pushMessage(createToolMessage(message.toolCallId, contentText(message.content), message.isError))
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
