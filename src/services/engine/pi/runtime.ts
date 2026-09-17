// Desk-Pet's only multi-turn agent runtime. Pi owns the model/tool loop;
// Desk-Pet owns product state, safety, sessions, Card variables, and effects.

import { Agent } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, Message as PiMessage } from "@earendil-works/pi-ai"
import type { Message, ThinkingEffort, ToolCallRequest } from "@/services/agent/types"
import type { ContextBlock, IngressEnvelope, MessageTaint, PromptSnapshot, PromptTransform, SessionEvent } from "@/services/engine/runtime"
import { createMessageId } from "@/services/agent/types"
import { MemoryService, recallMemory, planCheckpointStore, planStepEffectClass, appendTranscriptMessage, finalizeTranscriptMessage, readContextView } from "@/services/agent/memory"
import { buildPrompt, contextBudget, CONTEXT_RATIOS, estimateRequestTokens, estimateContextTokens, estimateMessageTokens, ContextBudgetError, projectToolMessages } from "@/services/context"
import { compactSession, estimateTokens } from "@/services/engine/compactor"
import { bindRunningPlan, clearRunningPlan, notifyPlanEnd, requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import { executePlan, evaluateComplexity, formatStepResults, generatePlan } from "@/services/engine/planner"
import { recordMessage, recordToolCall, transition } from "@/services/engine/session"
import { getEffectiveThinkingEffort, updateRequestStats } from "@/services/debug"
import { getSkillsPromptBlock, getSkillCatalogFingerprint } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import { getPoolSnapshot, getSessionStart, applyResetPolicies, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { PetPersonalityMiddleware } from "@/services/personality/middleware"
import type { PersonalityEffect } from "@/services/personality/middleware"
import { getFallbackReply, getSimpleStage, getStagePrompt } from "@/services/personality/stages-cache"
import { generateReply, parseRuntimeData } from "@/services/reply"
import { authorizeToolExecution, invalidatePermissionScope } from "@/services/safety"
import { getActiveSessionId, pushMessage } from "@/services/session/store"
import { getToolByName, getToolsForMode } from "@/services/tool/registry"
import { executeToolDefinition, createSessionTranscriptTool, SESSION_TRANSCRIPT_TOOL, toToolDeclaration } from "@/services/tool"
import type { ActionCategory, ToolDef } from "@/services/tool/types"
import { aiConfig, generalConfig, loopConfig, planConfig, safetyConfig } from "@/services/config"
import { emit } from "@tauri-apps/api/event"
import { getPiModel, getPiRuntimeProviderOverride, piStream, toPiAgentThinkingLevel } from "./model-gateway"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { agentSlots, createPromptRewrite, createPromptSnapshot, createRuntimeTraceContext, publishRuntimeTrace } from "@/services/engine/runtime"
import { redactText, sha256Text, stableSerialize } from "@/services/engine/runtime"

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const log = createLogger("PiRuntime")

const lastSeenSessionStarts = new Map<string, number>()

/**
 * 向正在执行的回合插话，并把插话内容记入该回合所属会话。
 *
 * Pi 的语义是「本轮结束后注入」，不是立即中止 —— 当前批次里已经开始的工具会照常跑完，
 * 模型在下一轮才会看到这条消息并据此调整。
 *
 * @returns 是否有正在执行的回合可以接收插话
 */
export function deliverActiveTurn(sessionId: string, text: string, eventId?: string): "steered" | "followup" | undefined {
  return agentSlots.deliver(sessionId, text, eventId)
}

export interface PiAgentTurnInput {
  sessionId: string
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

/**
 * 回合在拿到模型回复之前就失败的结构化原因。
 *
 * 产品侧要的是「有兜底文案可显示」，报告侧要的是「这次失败属于哪一类」，两者不冲突：
 * 只返回兜底文案会让报告把 Provider 故障记成 assertion 失败，观测直接失效。
 * `kind` 与 Live Test 的 `ErrorKind` 同名，报告可直接照搬。
 */
export interface TurnFailure {
  kind: "timeout" | "auth" | "rate_limit" | "network" | "provider" | "unknown"
  message: string
}

export interface PiAgentTurnOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  effects: { expression: string; soundEvent: string | null }[]
  runtimeData?: { emotionKey: string | null; variables: Record<string, string> }
  /** 仅在重试耗尽、回复是兜底文案时出现 */
  failure?: TurnFailure
}

/** 把 Provider 的失败文案收敛成稳定分类 */
function classifyTurnFailure(message: string): TurnFailure["kind"] {
  const lower = message.toLowerCase()
  if (/timeout|timed out|超时/.test(lower)) return "timeout"
  if (/401|403|unauthor|invalid api key|api key/.test(lower)) return "auth"
  if (/429|rate limit|too many requests/.test(lower)) return "rate_limit"
  if (/enotfound|econnrefused|econnreset|network|fetch failed|dns/.test(lower)) return "network"
  if (/5\d\d|upstream|service unavailable|provider/.test(lower)) return "provider"
  return "unknown"
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
  signal?: AbortSignal
  allocations?: import("@/services/engine/runtime").ContextAllocation[]
  skillCatalogFingerprint?: string
  transientUserInput?: boolean
  model?: ReturnType<typeof getPiModel>
  rebuildContext?: (messages: Message[], summary: string) => ReturnType<typeof buildPrompt>
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
  finalMessageId?: string
}

/** Main pet turn. This replaces the deleted hand-written Agent Loop. */
export async function runPiAgentTurn(input: PiAgentTurnInput): Promise<PiAgentTurnOutput> {
  if (!input.sessionId.trim()) throw new Error("Pi Agent 回合缺少 sessionId")
  const { userText, chatMessages, unansweredCount, isActiveMessage } = input
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []
  const effects: PiAgentTurnOutput["effects"] = []

  const turnSessionId = input.sessionId
  const requestId = input.ingress?.requestId ?? `runtime-${input.turnId ?? crypto.randomUUID()}`
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const overrideModel = getPiRuntimeProviderOverride()?.model
  const model = overrideModel ? { ...overrideModel, contextWindow: Math.min(aiConfig.contextMaxTokens, overrideModel.contextWindow),
    maxTokens: contextBudget(Math.min(aiConfig.contextMaxTokens, overrideModel.contextWindow)).outputReserve } : getPiModel()
  const windowTokens = model.contextWindow
  const controller = new AbortController()
  const slotSignal = input.runGeneration === undefined ? undefined : agentSlots.signal(turnSessionId, input.runGeneration)
  const cancel = () => controller.abort(slotSignal?.reason)
  if (slotSignal?.aborted) cancel()
  else slotSignal?.addEventListener("abort", cancel, { once: true })
  const runSignal = controller.signal
  const deadline = Date.now() + loopConfig.turnTimeoutMs
  const runTimer = setTimeout(() => controller.abort(new Error("Agent 执行超时")), loopConfig.turnTimeoutMs)
  const runIsCurrent = () => !runSignal.aborted && (input.runGeneration === undefined
    || (agentSlots.snapshot(turnSessionId)?.generation === input.runGeneration && agentSlots.isRunning(turnSessionId)))
  const assertCurrent = () => { if (!runIsCurrent()) throw new Error("回合已取消或运行代际已失效") }
  refreshVariablePool()
  updateInteractionVar("unansweredCount", unansweredCount)
  const currentSessionStart = getSessionStart()
  const isNewSession = currentSessionStart !== lastSeenSessionStarts.get(turnSessionId)
  lastSeenSessionStarts.set(turnSessionId, currentSessionStart)
  applyResetPolicies(new Date(), isNewSession)
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const thinkingEffort = getEffectiveThinkingEffort()
  const frozenUserContext = { candyInstructions: MemoryService.getCandyInstructionsSync(),
    userProfileText: MemoryService.getUserProfileSync(),
    dynamicPrompt: `${formatPoolForPrompt(pool)}${thinkingEffort === "low" ? "\n[请快速简要回答]" : thinkingEffort === "high" ? "\n[请仔细深入思考]" : ""}` }
  try {
  assertCurrent()
  const { prepareConversationCapabilities } = await import("@/services/init")
  await prepareConversationCapabilities(mode, requestId)
  assertCurrent()
  const frozenTools = isActiveMessage ? [] : [...getToolsForMode(mode)]
  if (frozenTools.length) frozenTools.push(createSessionTranscriptTool(turnSessionId))
  recordMessage(turnSessionId)
  if (!isActiveMessage) await persistTurn(turnSessionId, "user", userText, `${requestId}:user`, runIsCurrent)
  else await persistRuntimeEvent(turnSessionId, userText, input.ingress)
  assertCurrent()
  let planStepContext = ""
  let planUserText = userText
  if (mode === "assistant" && planConfig.enabled) {
    const forcePlan = userText.startsWith("--plan")
    if (forcePlan) planUserText = userText.replace(/^--plan\s*/, "")
    const complexity = await evaluateComplexity(planUserText, planConfig.keywords)
    assertCurrent()
    if (complexity.score >= planConfig.complexityThreshold) {
      transition("PLANNING", turnSessionId)
      applyEffect(PetPersonalityMiddleware.wrap("planning"), effects)
      const plan = await generatePlan(planUserText, {
        cardId: card?.id ?? "neutral",
        cardRole: card?.sections.roleSetting ?? "",
        availableTools: getToolsForMode("assistant"),
        thinkingEffort: planConfig.thinkingEffort,
      })
      assertCurrent()
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
          notifyPlanEnd("cancelled")
          transition("WAITING", turnSessionId)
          const reply = getSimpleStage("planning") ?? "好的，已取消计划～"
          await persistTurn(turnSessionId, "assistant", reply, `${requestId}:failure`)
          return { reply, toolCallHistory, retriesUsed: 0, effects: [] }
        }
        await planCheckpointStore.transitionPlan(planId, "running")
        // 执行期登记中断通道，「终止执行」据此真正停下剩余步骤；
        // `finally` 保证任何退出路径都会清空登记，不给下一次计划留悬空引用
        const planAbort = new AbortController()
        bindRunningPlan(planAbort)
        const result = await executePlan(plan, {
          stepTimeoutMs: planConfig.stepTimeoutMs,
          stepMaxRounds: planConfig.stepMaxRounds,
          stepThinkingEffort: planConfig.stepThinkingEffort,
          maxSteps: planConfig.maxSteps,
          onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
          signal: planAbort.signal,
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
        }).finally(() => clearRunningPlan())
        await planCheckpointStore.transitionPlan(planId, result.overallSuccess ? "done" : "failed")
        // 收起 Plan 面板：没有这个事件时它只在两个按钮里被隐藏，跑完会一直挂着
        notifyPlanEnd(result.overallSuccess ? "done" : "failed")
        planStepContext = formatStepResults(result)
      }
    }
  }

  let memoryProjections = [] as import("@/services/agent/memory").MemoryProjection[]
  try {
    memoryProjections = await recallMemory({
      requestId,
      sessionId: turnSessionId,
      query: userText,
      tokenBudget: Math.floor(contextBudget(windowTokens, model.maxTokens).normalInputTarget * CONTEXT_RATIOS.memory),
    })
  } catch (error) {
    log.warn("MemoryProvider 召回失败，按空召回继续", formatError(error))
  }
  assertCurrent()
  const frozenContext = { ...frozenUserContext, skillsPromptBlock: getSkillsPromptBlock({ mode }) }
  const skillCatalogFingerprint = getSkillCatalogFingerprint() ?? undefined
  const rebuildContext = (messages: Message[], summary: string) => buildPrompt({
    ...frozenContext,
    recentMessages: projectToolMessages(messages, windowTokens, SESSION_TRANSCRIPT_TOOL), userText, unansweredCount, thinkingEffort, isActiveMessage,
    currentInputInTranscript: !isActiveMessage,
    memoryProjections, sessionSummary: summary, mode, contextMaxTokens: windowTokens, maxOutputTokens: model.maxTokens,
    tools: frozenTools.map(toToolDeclaration),
    ...(planStepContext ? { ephemeralText: planStepContext, ephemeralOrigin: "plan" as const } : {}),
  }, card, pool)
  let view = await readContextView(turnSessionId)
  // Initial preflight belongs to the host; Pi does not prepareNextTurn before request one.
  let context: ReturnType<typeof buildPrompt>
  while (true) {
    let budgetFailure: ContextBudgetError | undefined
    try { context = rebuildContext(view.messages, view.summary) }
    catch (error) { if (!(error instanceof ContextBudgetError)) throw error; budgetFailure = error }
    if (!budgetFailure && !context!.overNormalTarget) break
    const outcome = await compactSession({ sessionId: turnSessionId, mode, runGeneration: input.runGeneration ?? 0,
      contextMaxTokens: windowTokens, model, signal: runSignal, trigger: "preflight",
      isCurrent: runIsCurrent })
    if (outcome.status !== "committed") {
      if (budgetFailure) throw budgetFailure
      break // Failed summaries never discard history; a request below hard limit remains safe.
    }
    view = await readContextView(turnSessionId)
  }
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
  let finalMessageId: string | undefined
  for (let attempt = 0; attempt <= loopConfig.maxRetry; attempt++) {
    const result = await runPiLoop({
      userText,
      chatMessages: context!.recentMessages,
      systemPrompt: context!.systemPrompt,
      tools: frozenTools,
      model, signal: runSignal, skillCatalogFingerprint, rebuildContext, transientUserInput: isActiveMessage,
      maxToolCalls: loopConfig.maxToolCallsPerTurn,
      timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutReply: getFallbackReply("turnTimeout"),
      thinkingEffort,
      mode,
      sessionId: turnSessionId,
      exposeAsActiveAgent: true,
      runGeneration: input.runGeneration,
      effects,
      toolCallHistory,
      persistToolMessages: true,
      contextBlocks: context!.blocks, allocations: context!.allocations,
      promptTransforms,
      requestId,
      turnId: input.turnId,
      ingress: input.ingress,
    })
    if (!result.error) {
      rawReply = result.reply
      finalMessageId = result.finalMessageId
      retriesUsed = attempt
      break
    }
    // Replaying a failed model request is safe only before any side-effecting tool ran.
    const failureKind = classifyTurnFailure(result.error)
    if (result.toolCallsMade > 0 || attempt >= loopConfig.maxRetry
      || failureKind === "auth" || failureKind === "timeout" || Date.now() >= deadline) {
      transition("WAITING", turnSessionId)
      applyEffect(PetPersonalityMiddleware.wrap("error", { message: result.error }), effects)
      const reply = result.error.includes("上下文需要约") ? result.error : getFallbackReply("maxRetriesExhausted")
      await persistTurn(turnSessionId, "assistant", reply, `${requestId}:failure`)
      return {
        reply,
        toolCallHistory,
        retriesUsed: attempt,
        effects,
        // 产品照旧拿到可显示的兜底文案；报告侧拿到「这次不是模型答得不好，是根本没答成」
        failure: { kind: failureKind, message: result.error },
      }
    }
  }

  assertCurrent()
  const liveCard = getActiveCard()
  const cardIsCurrent = liveCard?.id === card?.id && liveCard?.hash === card?.hash && liveCard?.version === card?.version
  const processed = await generateReply(rawReply, card, { applyRuntimeData: cardIsCurrent })
  effects.push({ expression: processed.expression, soundEvent: processed.sound })
  if (cardIsCurrent && getActiveSessionId() === turnSessionId) emit("deskpet-expression", { expression: processed.expression }).catch(() => {})
  if (cardIsCurrent && getActiveSessionId() === turnSessionId && processed.sound) emit("deskpet-sound", { event: processed.sound }).catch(() => {})
  transition("WAITING", turnSessionId)
  if (finalMessageId) await finalizeTranscriptMessage(turnSessionId, finalMessageId, processed.text)
  else await persistTurn(turnSessionId, "assistant", processed.text, `${requestId}:assistant`)
  return { reply: processed.text, toolCallHistory, retriesUsed, effects, runtimeData: processed.runtimeData }
  } finally {
    clearTimeout(runTimer)
    slotSignal?.removeEventListener("abort", cancel)
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(requestId)
  }
}

/** New records keep complete transcript payloads; old deskpet-turn records remain readable. */
async function persistTurn(sessionId: string, role: "user" | "assistant", text: string, eventId: string, isCurrent?: () => boolean): Promise<void> {
  await appendTranscriptMessage(sessionId, { id: eventId, eventId, role, text, timestamp: Date.now(),
    origin: role, apiRoundId: `${eventId.replace(/:(user|assistant|failure)$/, "")}:1`, taint: role === "user" ? "trusted_user" : "derived" }, isCurrent)
}

/** 仅用于不进 transcript 的消息（当前只有主动搭话的 active 上下文）。 */
async function persistRuntimeEvent(sessionId: string, text: string, ingress?: IngressEnvelope): Promise<void> {
  if (!sessionId) return
  const event: SessionEvent = {
    schemaVersion: 1,
    eventId: `active-${ingress?.requestId ?? crypto.randomUUID()}-${Date.now()}`,
    sessionId,
    kind: "active_message",
    origin: "active",
    payload: {
      text,
      rawText: ingress?.rawText ?? text,
      normalizedText: ingress?.normalizedText ?? text.trim(),
      visibleToUser: false,
      persisted: true,
      eligibleForTranscript: false,
      eligibleForMemory: false,
      isMeta: true,
      taint: ingress?.taint ?? "derived" as MessageTaint,
      ...(ingress ? { querySource: ingress.querySource, priority: ingress.priority, requestId: ingress.requestId } : {}),
    },
    createdAt: Date.now(),
    idempotencyKey: `active:${ingress?.requestId ?? text}:${text}`,
  }
  const written = await MemoryService.appendSessionEventToSession(sessionId, event, text)
  if (!written) {
    await MemoryService.createSessionFile(sessionId)
    if (!await MemoryService.appendSessionEventToSession(sessionId, event, text)) throw new Error("主动上下文事件写入失败")
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
  const messageIds = new WeakMap<object, string>()
  let transcriptWrites = Promise.resolve()
  let persistenceError: unknown
  let apiRound = 0
  let contextError: unknown
  let requestSystemPrompt = input.systemPrompt
  let requestBlocks = input.contextBlocks
  let allocations = input.allocations
  let contextEpoch = 0
  let stoppedAtToolLimit = false
  const traceContext = createRuntimeTraceContext(input.sessionId, input.requestId, input.turnId)
  const runtimeProvider = getPiRuntimeProviderOverride()
  const model = input.model ?? runtimeProvider?.model ?? getPiModel()
  const snapshotTasks: Promise<void>[] = []
  let snapshotSequence = 0
  let latestTransformedMessages: AgentMessage[] = []

  const captureSnapshot = async (
    captureStage: PromptSnapshot["captureStage"],
    agentMessages: AgentMessage[],
    llmMessages: Array<{ role: string; content?: string; toolCallId?: string }>,
    usage?: AssistantMessage["usage"],
  ): Promise<void> => {
    const snapshotId = `${traceContext.runId}:${captureStage}:${++snapshotSequence}`
    // Tool rounds add messages after the initial builder. Refresh their allocation
    // from the exact request projection, without counting Pi usage/timestamps.
    const transient = agentMessages.filter(message => input.transientUserInput && message.role === "user" && !messageIds.has(message))
    const transientTokens = transient.reduce((n, message) => n + estimateMessageTokens(message), 0)
    const transcriptTokens = agentMessages.reduce((n, message) => n + estimateMessageTokens(message), 0) - transientTokens
    const snapshotAllocations = allocations?.map(allocation => {
      if (allocation.layer !== "transcript" && allocation.layer !== "ephemeral") return { ...allocation }
      const used = allocation.layer === "transcript" ? transcriptTokens
        : (requestBlocks ?? []).filter(block => block.layer === "ephemeral" && block.origin !== "active").reduce((n, block) => n + estimateContextTokens(block.text), 0) + transientTokens
      return { ...allocation, requested: used, used, borrowed: Math.max(0, used - allocation.assigned), dropped: 0 }
    })
    const toolSchemas = await Promise.all(input.tools.map(async tool => ({
      name: tool.name,
      schemaHash: await sha256Text(stableSerialize({ name: tool.name, description: tool.description, parameters: tool.parameters })),
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
      systemBlocks: requestBlocks ?? [{
        blockId: "static:sub-agent", layer: "static", source: "sub-agent",
        text: requestSystemPrompt, priority: 100, origin: "system", taint: "system",
      }],
      toolSchemas,
      agentMessages: agentMessages.map((message, index) => ({
        id: messageIds.get(message) ?? `agent:${index}`,
        origin: input.transientUserInput ? "active" : message.role === "toolResult" ? "tool" : message.role === "assistant" ? "assistant" : "user",
        role: message.role,
        content: stableSerialize(message),
      })),
      llmMessages,
      transforms: input.promptTransforms ?? [],
      actualInputTokens: usage?.input, actualOutputTokens: usage?.output,
      contextEpoch, budget: contextBudget(model.contextWindow, model.maxTokens), allocations: snapshotAllocations,
      cache: { sessionId: input.sessionId, prefixHash: await sha256Text(stableSerialize({
        model: model.id, provider: model.provider, thinking: input.thinkingEffort,
        blocks: (requestBlocks ?? []).filter(block => block.layer === "static"), toolSchemas, skillCatalogFingerprint: input.skillCatalogFingerprint,
      })), cacheReadTokens: usage?.cacheRead, cacheWriteTokens: usage?.cacheWrite },
      estimatedInputTokens: estimateRequestTokens(requestSystemPrompt, agentMessages, input.tools),
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

  const initialMessages = toPiMessages(input.chatMessages, model)
  input.chatMessages.filter(m => m.role !== "system").forEach((message, index) => {
    if (initialMessages[index]) messageIds.set(initialMessages[index]!, message.eventId ?? message.id)
  })
  const isCurrent = () => !input.exposeAsActiveAgent || input.runGeneration === undefined
    || agentSlots.snapshot(input.sessionId!)?.generation === input.runGeneration
  const flushTranscript = async () => { await transcriptWrites; if (persistenceError) throw persistenceError }
  const enqueueTranscript = (message: AgentMessage) => {
    if (!input.persistToolMessages || !input.sessionId || messageIds.has(message)) return
    if (input.transientUserInput && message.role === "user") return
    const id = (message as unknown as { deskpetEventId?: string }).deskpetEventId
      ?? `${traceContext.runId}:${apiRound}:${message.role}:${createMessageId()}`
    const appMessage = fromPiMessage(message, id, `${input.requestId ?? traceContext.runId}:${apiRound}`)
    if (!appMessage) return
    if (input.transientUserInput) appMessage.origin = "active"
    messageIds.set(message, id)
    transcriptWrites = transcriptWrites.then(() => appendTranscriptMessage(input.sessionId!, appMessage)).catch(error => {
      persistenceError = error
      agent.abort()
    })
    if (getActiveSessionId() === input.sessionId && (appMessage.role === "tool" || appMessage.toolCalls?.length)) pushMessage(appMessage)
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      thinkingLevel: toPiAgentThinkingLevel(input.thinkingEffort),
      tools: input.tools.map(tool => toPiTool(tool, input, toolsByName, toolCallHistory, effects)),
      messages: initialMessages,
    },
    streamFn: async (requestModel, context, options) => {
      await flushTranscript()
      if (contextError) throw contextError
      if (!isCurrent()) throw new Error("回合代际已失效")
      const budget = contextBudget(model.contextWindow, model.maxTokens)
      const used = estimateRequestTokens(requestSystemPrompt, context.messages, context.tools ?? [])
      if (used > budget.hardInputLimit) throw new ContextBudgetError(used, budget.hardInputLimit)
      return (runtimeProvider?.streamFn ?? piStream)(requestModel, { ...context, systemPrompt: requestSystemPrompt }, options)
    },
    convertToLlm: messages => messages.map(message => {
      const { deskpetEventId: _id, ...clean } = message as typeof message & { deskpetEventId?: string }
      return clean as PiMessage
    }),
    sessionId: input.sessionId,
    // Keep tool rounds deterministic; parallel execution is a separate optimization.
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
    transformContext: async (messages, signal) => {
      let prepared = messages
      if (input.persistToolMessages) prepared = prepared.map(message => {
        const id = messageIds.get(message)
        if (message.role !== "toolResult" || !id) return message
        const source: Message = { id, eventId: id, role: "tool", text: contentText(message.content), timestamp: message.timestamp }
        const projected = projectToolMessages([source], model.contextWindow, SESSION_TRANSCRIPT_TOOL)[0]!
        if (projected === source) return message
        const reduced = { ...message, content: [{ type: "text" as const, text: projected.text }] }
        messageIds.set(reduced, id)
        return reduced
      })
      try {
        await flushTranscript()
        const budget = contextBudget(model.contextWindow, model.maxTokens)
        const used = estimateRequestTokens(requestSystemPrompt, prepared, input.tools)
        if (input.persistToolMessages && input.sessionId && input.rebuildContext && used > budget.normalInputTarget) {
          await Promise.allSettled(snapshotTasks)
          // Only committed checkpoints authorize removal; unmapped/in-flight messages always stay.
          let outcome = await compactSession({ sessionId: input.sessionId, mode: input.mode,
            runGeneration: input.runGeneration ?? 0, trigger: "preflight", contextMaxTokens: model.contextWindow, model, signal, isCurrent })
          while (outcome.status === "committed") {
            const view = await readContextView(input.sessionId)
            contextEpoch = view.checkpoint?.contextEpoch ?? 0
            const retained = new Set(view.messages.map(m => m.eventId))
            prepared = prepared.filter(message => !messageIds.has(message) || retained.has(messageIds.get(message)))
            let budgetFailure: ContextBudgetError | undefined
            try {
              const next = input.rebuildContext(view.messages, view.summary)
              requestSystemPrompt = next.systemPrompt; requestBlocks = next.blocks; allocations = next.allocations
              if (!next.overNormalTarget) break
            } catch (error) {
              if (!(error instanceof ContextBudgetError)) throw error
              budgetFailure = error
            }
            outcome = await compactSession({ sessionId: input.sessionId, mode: input.mode, runGeneration: input.runGeneration ?? 0,
              trigger: "preflight", contextMaxTokens: model.contextWindow, model, signal, isCurrent })
            if (budgetFailure && outcome.status !== "committed") throw budgetFailure
          }
        }
      } catch (error) {
        contextError = error
      }
      latestTransformedMessages = prepared
      try { await captureSnapshot("transform_context", prepared, []) }
      catch (error) { log.warn("PromptSnapshot 采集失败", formatError(error)) }
      return prepared // Pi requires this hook never to reject; streamFn enforces any recorded error.
    },
    afterToolCall: async ({ result, isError }) => ({
      content: result.content,
      details: { ...(result.details && typeof result.details === "object" ? result.details : {}),
        origin: "tool", taint: "untrusted_external", isError },
      isError,
    }),
    beforeToolCall: async ({ toolCall, args }, signal) => {
      try { await flushTranscript() } catch (error) { return { block: true, reason: formatError(error), terminate: true } }
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

      recordToolCall(input.sessionId)
      const category = tool.actionCategory ?? "_default"
      transition("EXECUTING", input.sessionId)
      if (effects) applyEffect(PetPersonalityMiddleware.wrap("executing", { actionCategory: category, toolName: tool.name }), effects)
      emitToolEvent("tool-executing", { toolId: tool.name, toolName: tool.name })

      const toolArgs = args as Record<string, unknown>
      const permission = await authorizeToolExecution(tool, toolArgs, {
        mode: input.mode, sessionId: input.sessionId ?? traceContext.runId,
        runGeneration: input.runGeneration ?? 0, toolCallId: toolCall.id, signal,
        isCurrent: () => isCurrent() && (!input.sessionId || getActiveSessionId() === input.sessionId),
      })
      if (permission.decision !== "allow") {
        const reason = permission.reason ?? "操作未获授权"
        toolCallHistory.push({ toolName: tool.name, status: permission.request ? "denied" : "blocked", personalityMsg: reason })
        return { block: true, reason }
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
    if (event.type === "turn_start") apiRound++
    if (event.type === "message_end") enqueueTranscript(event.message)
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
  const abort = () => agent.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    if (input.signal?.aborted) throw new Error("回合已取消")
    transition("GENERATING", input.sessionId)
    const initial = agent.state.messages
    const last = initial[initial.length - 1]
    if (last?.role === "user") await agent.continue()
    else await agent.prompt(input.userText)
    await flushTranscript()
  } catch (error) {
    if (timedOut) {
      return { reply: input.timeoutReply ?? "", toolCallsMade, error: "Agent 执行超时" }
    }
    return { reply: "", toolCallsMade, error: formatError(error) }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    invalidatePermissionScope(input.sessionId ?? traceContext.runId, input.runGeneration ?? 0)
    await transcriptWrites
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
    return { reply: input.timeoutReply ?? "", toolCallsMade, error: "Agent 执行超时" }
  }

  const lastAssistant = [...agent.state.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant")
  if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
    return { reply: "", toolCallsMade, error: lastAssistant?.errorMessage || "Pi Agent 未返回有效回复" }
  }
  updateRequestStats({
    promptTokens: lastAssistant.usage.input,
    completionTokens: lastAssistant.usage.output,
    systemTokens: estimateContextTokens(requestSystemPrompt),
    conversationTokens: estimateTokens(input.chatMessages),
    toolCount: input.tools.length,
    toolNames: input.tools.map(tool => tool.name),
  })
  await captureSnapshot("provider_usage", latestTransformedMessages, [], lastAssistant.usage).catch(error => log.warn("usage 快照写入失败", formatError(error)))
  publishRuntimeTrace(traceContext, "provider_usage", { contextEpoch,
    inputTokens: lastAssistant.usage.input, outputTokens: lastAssistant.usage.output,
    cacheRead: lastAssistant.usage.cacheRead, cacheWrite: lastAssistant.usage.cacheWrite })
  return { reply: contentText(lastAssistant.content), toolCallsMade, finalMessageId: messageIds.get(lastAssistant) }
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
      let result: Awaited<ReturnType<typeof executeToolDefinition>>
      try {
        result = await executeToolDefinition(current, params as Record<string, unknown>, {
          sessionId: input.sessionId, runGeneration: input.runGeneration,
          isCurrent: () => input.runGeneration === undefined || agentSlots.snapshot(input.sessionId!)?.generation === input.runGeneration,
          mode: input.mode,
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
      content: toolCalls.length > 0 ? [...(message.text ? [{ type: "text" as const, text: message.text }] : []), ...toolCalls]
        : [{ type: "text" as const, text: message.text }],
      api: "openai-completions",
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: message.timestamp,
    })
  }
  return result
}

function fromPiMessage(message: AgentMessage, id: string, apiRoundId: string): Message | undefined {
  const identity = { id, eventId: id, apiRoundId, timestamp: "timestamp" in message ? message.timestamp : Date.now() }
  if (message.role === "user") return { ...identity, role: "user", text: typeof message.content === "string" ? message.content : contentText(message.content), origin: "user", taint: "trusted_user" }
  if (message.role === "assistant") {
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined
    const toolCalls = message.content.filter(part => part.type === "toolCall").map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
    return { ...identity, role: "assistant", text: parseRuntimeData(contentText(message.content)).text, origin: "assistant", taint: "derived",
      ...(toolCalls.length ? { toolCalls } : {}) }
  }
  if (message.role === "toolResult") return { ...identity, role: "tool", text: contentText(message.content),
    toolCallId: message.toolCallId, isError: message.isError, origin: "tool", taint: "untrusted_external" }
  return undefined
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
