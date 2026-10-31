// 回合内核：一次运行冻结的模型/能力/权限与快照接线；主回合与子代理复用同一内核。
// 纯搬移自 harness/runtime.ts（T1.5 抽出 harness 原语），不改变行为。

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Usage } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import { contextBudget, estimateDriftRatio, estimateRequestTokens, ESTIMATE_DRIFT_WARN_RATIO, projectMessageContent, totalInputTokens } from "@/services/context"
import type { ContextBudgetAdjustment } from "@/services/context"
import { createPromptSnapshot, createRuntimeTraceContext, isTransientInputMessage, messageEventId, PROMPT_SNAPSHOT_ENTRY, publishRuntimeTrace, refreshMessageAllocations, sha256Text, stableSerialize } from "@/services/engine/protocol"
import type { ContextAllocation, ContextBlock, PromptCapabilityContext, PromptPlanContext, PromptRequestContext, PromptRequestParams, PromptSnapshot, PromptTokenDrift, PromptTransform, RuntimeTraceContext } from "@/services/engine/protocol"
import { redactText } from "@/services/engine/protocol"
import { createHarnessRunState } from "@/services/engine/state"
import type { HarnessRunState } from "@/services/engine/state"
import type { HumanizedText } from "@/services/humanizer"
import { createLogger } from "@/services/logger"
import type { PersonalityCard } from "@/services/personality/types"
import { freezePermissionPolicy } from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import { toolPolicyHash } from "@/services/tool"
import type { HarnessToolRun, ToolDef } from "@/services/tool"
import { readContextEpoch } from "./delivery"
import type { PiModel } from "./model-gateway"
import { harnessSlots } from "./slot-registry"

// 日志分类沿用原 runtime.ts 的 PiRuntime：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/** 一次运行的宿主侧共享上下文；主回合与子代理复用同一套投影/快照/审计。 */
export interface TurnKernel {
  sessionId?: string
  requestId: string
  turnId?: string
  model: PiModel
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  tools: readonly ToolDef[]
  blocks: ContextBlock[]
  allocations?: ContextAllocation[]
  /** 内核整块淘汰的可选块（审计与快照用），不参与请求视图拼接。 */
  budgetDrops: ContextBudgetAdjustment[]
  promptTransforms: PromptTransform[]
  skillCatalogFingerprint?: string
  transientUserInput: boolean
  persistSnapshots: boolean
  toolRun: HarnessToolRun
  state: HarnessRunState
  card: PersonalityCard | null
  traceContext: RuntimeTraceContext
  latestMessages: AgentMessage[]
  snapshotTasks: Promise<void>[]
  snapshotSequence: number
  /** 本次请求的用途（默认回合；压缩/一次性请求在各自入口给出）。 */
  request: PromptRequestContext
  /** before_payload 从 Provider payload 取到的请求参数（脱敏快照用）。 */
  requestParams?: PromptRequestParams
  /**
   * before_payload 从 Provider payload 取到的当次工具名（DebugBar 的「本次请求工具」）。
   * 激活面收窄与回合内渐进披露都会改变实际工具面，以 payload 为准；取不到时不写。
   */
  requestToolNames?: string[]
  /** Provider payload 的稳定 hash；由 before_payload 采集后写进快照。 */
  payloadHash?: string
  /** 计划步骤归属（子代理按步骤传）。 */
  plan?: PromptPlanContext
  /** 回合开始冻结的能力：skillsFingerprint/safetyMode 冻结一次，工具裁决逐请求累积。 */
  capabilities: PromptCapabilityContext
  /** 回合开始冻结的权限策略：本回合所有裁决与 policyHash 只用它（改设置从下一回合生效）。 */
  policy: PermissionPolicySnapshot
  /** 槽代际：区分「同一会话被释放重建」前后的请求。 */
  generation: number
  humanizerEnabled?: boolean
  taskReply?: boolean
  silentRejectedReply?: string
  generationStartedAt?: number
  /** 上游 before_request 的当次 step/attempt；由它回答「这次 payload 属于哪次请求」。 */
  currentRequest?: { step: PromptRequestContext["step"]; attempt: number }
  /** 采集一档请求快照；带 usage 的一档同时给出估算偏差（provider_usage 的对账值）。 */
  captureSnapshot: (
    captureStage: PromptSnapshot["captureStage"],
    agentMessages: AgentMessage[],
    llmMessages: Array<{ role: string; content?: string; toolCallId?: string }>,
    usage?: Usage,
  ) => Promise<PromptTokenDrift | undefined>
  /**
   * 记录「原始正文 ↔ 剥离 RUNTIME_DATA 后正文」的配对。
   * afterResponse 会先剥离再提交，事件里拿到的最终助手消息已经没有标签，
   * 结算时直接解析会丢掉变量写入，所以必须在这里留底。
   */
  recordSettledReply: (raw: string, stripped: string, humanized?: HumanizedText) => void
  /** 取回与剥离后正文配对的原始正文；没有配对时原样返回。 */
  rawTextForSettledReply: (stripped: string) => string
  humanizedForSettledReply: (stripped: string) => HumanizedText | undefined
}

export interface TurnKernelOptions {
  sessionId?: string
  requestId: string
  turnId?: string
  model: PiModel
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  tools: readonly ToolDef[]
  blocks?: ContextBlock[]
  allocations?: ContextAllocation[]
  budgetDrops?: ContextBudgetAdjustment[]
  promptTransforms?: PromptTransform[]
  skillCatalogFingerprint?: string
  transientUserInput: boolean
  persistSnapshots: boolean
  toolRun: HarnessToolRun
  card?: PersonalityCard | null
  /** 请求用途（缺省为回合）。 */
  request?: PromptRequestContext
  /** 计划步骤归属（子代理按步骤传）。 */
  plan?: PromptPlanContext
  /** 槽代际（调用方在 preflight 冻结）。 */
  generation?: number
  /** Static style instruction and output transform are frozen together per run. */
  humanizerEnabled?: boolean
  /** Plan-produced context makes the final answer task-like even without local tool use. */
  taskReply?: boolean
  silentRejectedReply?: string
  traceContext?: RuntimeTraceContext
}

export function createTurnKernel(options: TurnKernelOptions): TurnKernel {
  const traceContext = options.traceContext ?? createRuntimeTraceContext(options.sessionId, options.requestId, options.turnId)
  const state = createHarnessRunState()
  // 权限策略在 preflight 冻结一次：裁决、授权哈希与快照的 capabilities 共用这一份快照。
  const policy = freezePermissionPolicy()
  const latestMessages: AgentMessage[] = []
  const snapshotTasks: Promise<void>[] = []
  let settledReply: { raw: string; stripped: string } | undefined
  let settledHumanized: HumanizedText | undefined
  const kernel: TurnKernel = {
    ...options,
    blocks: options.blocks ?? [],
    budgetDrops: options.budgetDrops ?? [],
    promptTransforms: options.promptTransforms ?? [],
    state,
    card: options.card ?? null,
    traceContext,
    latestMessages,
    snapshotTasks,
    snapshotSequence: 0,
    // 能力在 preflight 冻结一次：回合中改设置不改变本次请求的能力身份；safetyMode 与权限裁决同一份快照。
    request: options.request ?? { purpose: "turn" },
    policy,
    capabilities: {
      ...(options.skillCatalogFingerprint ? { skillsFingerprint: options.skillCatalogFingerprint } : {}),
      safetyMode: policy.safetyMode,
      toolDecisions: [],
    },
    generation: options.generation ?? 0,
    humanizerEnabled: options.humanizerEnabled ?? false,
    taskReply: options.taskReply ?? false,
    silentRejectedReply: options.silentRejectedReply,
    recordSettledReply: (raw, stripped, humanized) => {
      settledReply = { raw, stripped }
      settledHumanized = humanized
    },
    rawTextForSettledReply: stripped => settledReply?.stripped === stripped ? settledReply.raw : stripped,
    humanizedForSettledReply: stripped => settledReply?.stripped === stripped ? settledHumanized : undefined,
    captureSnapshot: async (captureStage, agentMessages, llmMessages, usage) => {
      const snapshotId = `${traceContext.runId}:${captureStage}:${++kernel.snapshotSequence}`
      // 工具轮会追加消息；用准确请求投影刷新分配，不计入 Pi usage/时间戳。
      // 瞬时输入的判定与归属只写在 refreshMessageAllocations 一处：主动消息（custom 消息）
      // 与投递的用户输入（带 deskpetEventId）都不属于会话历史行，要归到 ephemeral。
      const snapshotAllocations = options.allocations && refreshMessageAllocations(options.allocations, agentMessages, {
        transientInput: options.transientUserInput === true || agentMessages.some(message => isTransientInputMessage(message)),
        blocks: kernel.blocks,
      })
      const toolSchemas = await Promise.all(options.tools.map(async tool => ({
        name: tool.name,
        schemaHash: await sha256Text(stableSerialize({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        policyHash: await toolPolicyHash(tool),
      })))
      // 估算偏差的唯一计算点：这里同时拿到请求视图的估算与 Provider 回执的 usage。
      const estimatedInputTokens = estimateRequestTokens(options.systemPrompt, agentMessages, options.tools)
      // 对账必须用**真实输入量**（input + cacheRead + cacheWrite）：只比 `usage.input`
      // 会在缓存命中的请求上把偏差算大几十倍（见 totalInputTokens 的注释）。
      const actualInputTokens = usage ? totalInputTokens(usage) : undefined
      const ratio = usage ? estimateDriftRatio(estimatedInputTokens, actualInputTokens!) : undefined
      if (ratio !== undefined && ratio > ESTIMATE_DRIFT_WARN_RATIO) {
        log.warn("估算与实际 usage 偏差超过阈值:", { ratio, estimated: estimatedInputTokens, actual: actualInputTokens })
      }
      const tokenDrift: PromptTokenDrift | undefined = ratio === undefined
        ? undefined
        : { estimated: estimatedInputTokens, actual: actualInputTokens!, ratio }
      // 换代身份取槽内值（它就是 delivery.readContextEpoch 的产物）；未知时不写 compaction 子结构。
      const sessionEpoch = options.sessionId ? harnessSlots.snapshot(options.sessionId)?.contextEpoch : undefined
      // 最近一条压缩条目只在确实会写 compaction 时取一次：读失败就不写该字段。
      const lastCompactionEntryId = options.sessionId && sessionEpoch !== undefined
        ? (await readContextEpoch(options.sessionId))?.lastCompactionEntryId
        : undefined
      const snapshot = await createPromptSnapshot({
        snapshotId,
        requestId: options.requestId,
        sessionId: options.sessionId ?? "sub-agent",
        turnId: options.turnId ?? options.requestId,
        runId: traceContext.runId,
        captureStage,
        model: options.model.id,
        provider: options.model.provider,
        thinkingLevel: options.thinkingEffort,
        systemBlocks: kernel.blocks.length ? kernel.blocks : [{
          blockId: "static:sub-agent", layer: "static", source: "sub-agent",
          text: options.systemPrompt, priority: 100, origin: "system", taint: "system",
        }],
        toolSchemas,
        agentMessages: agentMessages.map((message, index) => ({
          // 投递输入的持久身份写进快照：request_prepared 才能按身份核对「这条输入进了这次请求」；
          // 位置号只作没有身份的消息（回合首条 prompt、工具结果）的回退。
          id: messageEventId(message as { deskpetEventId?: unknown }) ?? `agent:${index}`,
          origin: options.transientUserInput ? "active" : message.role === "toolResult" ? "tool" : message.role === "assistant" ? "assistant" : "user",
          role: message.role,
          // 与 token 估算共用同一投影：hash 只覆盖消息进入请求视图时携带的正文。
          content: projectMessageContent(message),
        })),
        llmMessages,
        transforms: kernel.promptTransforms,
        // 「这是哪次请求」：用途取内核冻结值，step/attempt 取上游逐请求（before_request）的当次值。
        request: { ...kernel.request, ...(kernel.currentRequest ?? {}) },
        systemPromptHash: await sha256Text(redactText(options.systemPrompt).text),
        // payload 的身份与参数只落在采集它的那一档（provider_payload）：内核字段跨档存活，
        // 无差别展开会让 provider_usage 声称自己带参数，更会让下一轮请求的 transform_context
        // 顶着上一份 payload 的 hash —— 它是「这次 payload 属于哪次请求」的答案，不能张冠李戴。
        // 取不到参数就不写（不写空对象冒充「参数已记录」）。
        ...(captureStage === "provider_payload" && kernel.payloadHash ? { payloadHash: kernel.payloadHash } : {}),
        ...(captureStage === "provider_payload" && kernel.requestParams && Object.keys(kernel.requestParams).length
          ? { requestParams: { ...kernel.requestParams } }
          : {}),
        ...(kernel.plan ? { plan: { ...kernel.plan } } : {}),
        capabilities: kernel.capabilities,
        generation: kernel.generation,
        budgetDrops: kernel.budgetDrops,
        // 真实输入量（含缓存命中/写入），与 tokenDrift.actual 同源 —— 见 totalInputTokens。
        actualInputTokens, actualOutputTokens: usage?.output,
        ...(tokenDrift ? { tokenDrift } : {}),
        // 请求视图换代身份：本分支已提交的压缩次数。读不到就不写（0 会谎称请求视图未换代）。
        contextEpoch: options.sessionId ? harnessSlots.snapshot(options.sessionId)?.contextEpoch : undefined,
        ...(sessionEpoch === undefined ? {} : {
          compaction: {
            count: sessionEpoch,
            ...(lastCompactionEntryId ? { lastCompactionEntryId } : {}),
          },
        }),
        budget: contextBudget(options.model.contextWindow, options.model.maxTokens),
        allocations: snapshotAllocations,
        cache: {
          sessionId: options.sessionId,
          prefixHash: await sha256Text(stableSerialize({
            model: options.model.id, provider: options.model.provider, thinking: options.thinkingEffort,
            blocks: kernel.blocks.filter(block => block.layer === "static"), toolSchemas,
            skillCatalogFingerprint: options.skillCatalogFingerprint,
          })),
          cacheReadTokens: usage?.cacheRead, cacheWriteTokens: usage?.cacheWrite,
        },
        estimatedInputTokens,
      })
      publishRuntimeTrace(traceContext, "prompt_snapshot", () => ({
        snapshotId,
        requestId: snapshot.requestId,
        turnId: snapshot.turnId,
        captureStage,
      }))
      if (options.persistSnapshots && options.sessionId) {
        // 只排队，不在此写入：本函数在 Harness hook / 事件处理器内被 await，
        // 那里直接写 lane 会与 drive 持有的命令锁循环等待（usage 事件必现死锁）。
        // 宿主在回合 drive 结束后统一 flush（HarnessSlot.flushAudit）。
        // 读路径不得创建槽（get() 会建槽并可能复活已删除的会话）：没有槽时把快照挂在
        // 注册表上，下次开槽转交（peek + queueAuditWithoutSlot），不丢证据。
        const slot = harnessSlots.peek(options.sessionId)
        if (slot) slot.queueAuditEntry(PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
        else harnessSlots.queueAuditWithoutSlot(options.sessionId, PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
      }
      return tokenDrift
    },
  }
  return kernel
}
