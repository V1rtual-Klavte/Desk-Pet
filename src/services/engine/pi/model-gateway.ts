// Pi AI gateway for Desk-Pet's OpenAI-compatible provider configuration.
//
// 这里是「Desk-Pet 配置 → pi-ai 调用」的唯一出口：主链路（runtime.ts）用
// piStream，一次性文本调用（planner / 压缩 / 记忆 / 阶段文案）用 completePiText。
// 两者共用同一套模型解析、reasoning 映射与网络防护。

import { contentText, createAssistantMessageEventStream, createModels, createProvider } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type { AssistantMessage, AssistantMessageEventStream, Context, Message as PiMessage, Model, Models, MutableModels, Provider, SimpleStreamOptions, StopReason, ThinkingContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig } from "@/services/config"
import { recordModelUsage } from "@/services/debug"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { contextBudget, ContextBudgetError, contextWindowError, estimateDriftRatio, estimateRequestTokens } from "@/services/context"
import { PROMPT_SNAPSHOT_ENTRY, createPromptSnapshot, redactText, sha256Text } from "@/services/engine/runtime"
import type { PromptSnapshot, PromptSnapshotInput } from "@/services/engine/runtime"
import type { HarnessSlotSnapshot } from "./harness-slot"
import { PROVIDER_TIMEOUT_MS, createProviderFetchGuard, validateProviderUrl } from "./net-guard"

const log = createLogger("PiGateway")

/**
 * 非推理模型 + low 思考时的兜底提示。
 * 旧 provider 对 LM Studio / Ollama 这类不认 reasoning_effort 的端点追加过它，
 * 保留是为了不改变这些用户的既有体验。仅对 `model.reasoning === false` 生效。
 */
const NON_REASONING_LOW_EFFORT_HINT = "\n\n[请快速简要回答，不需要过多思考]"

interface PiGateway {
  signature: string
  model: Model<any>
  models: MutableModels
  fetch: typeof fetch
}

/** 已冻结的 pi-ai 模型快照，避免一次性调用在中途重新读取设置。 */
export type PiModel = Model<any>

let gatewayCache: PiGateway | undefined
const modelGateways = new WeakMap<Model<any>, PiGateway>()

function configuredProviderId(): string {
  return aiConfig.provider.trim().toLowerCase() || "openai-compatible"
}

function builtinProvider(providerId: string): Provider | undefined {
  if (providerId === "deepseek") return deepseekProvider()
  if (providerId === "openai") return openaiProvider()
  return undefined
}

function createConfiguredGateway(): PiGateway {
  const providerId = configuredProviderId()
  const url = validateProviderUrl(aiConfig.endpoint)
  // Existing local-server configurations accept a bare host; custom API paths are preserved.
  if (url.pathname === "/" && ["openai", "ollama", "lmstudio", "lm-studio"].includes(providerId)) url.pathname = "/v1"
  const endpoint = url.toString().replace(/\/+$/, "")
  const configuredKey = aiConfig.apiKey
  const requireApiKey = aiConfig.requireApiKey
  const signature = JSON.stringify([
    providerId, endpoint, configuredKey, aiConfig.requireApiKey,
    aiConfig.model, aiConfig.contextMaxTokens,
  ])
  if (gatewayCache?.signature === signature) return gatewayCache

  const builtin = builtinProvider(providerId)
  const catalog = builtin?.getModels().find(model => model.id === aiConfig.model)
  const model: Model<any> = {
    ...catalog,
    id: aiConfig.model,
    name: aiConfig.model,
    api: catalog?.api ?? "openai-completions",
    provider: providerId,
    baseUrl: endpoint,
    reasoning: catalog?.reasoning ?? false,
    input: catalog?.input ?? ["text"],
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.min(aiConfig.contextMaxTokens, catalog?.contextWindow ?? aiConfig.contextMaxTokens),
    // ReplyGenerator only keeps 500 characters; leave headroom for reasoning and RUNTIME_DATA.
    maxTokens: contextBudget(Math.min(aiConfig.contextMaxTokens, catalog?.contextWindow ?? aiConfig.contextMaxTokens)).outputReserve,
  }
  const provider = createProvider({
    id: providerId,
    name: providerId,
    baseUrl: endpoint,
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        async check() {
          return configuredKey || !requireApiKey ? { type: "api_key", source: "Desk-Pet config" } : undefined
        },
        async resolve() {
          const apiKey = configuredKey || (!requireApiKey ? "local-openai-compatible" : "")
          return apiKey ? { auth: { apiKey }, source: "Desk-Pet config" } : undefined
        },
      },
    },
    models: [model],
    api: catalog && builtin ? builtin : openAICompletionsApi(),
  })
  const models = createModels()
  models.setProvider(provider)
  gatewayCache = { signature, model, models, fetch: createProviderFetchGuard(endpoint) }
  modelGateways.set(model, gatewayCache)
  return gatewayCache
}

export function getPiModel(): Model<any> {
  return createConfiguredGateway().model
}

export function toPiAgentThinkingLevel(effort: ThinkingEffort | undefined): "off" | "low" | "medium" | "high" {
  switch (effort) {
    case "low": return "low"
    case "medium": return "medium"
    case "high": return "high"
    default: return "off"
  }
}

/**
 * Desk-Pet 的思考强度 → pi-ai 的 `reasoning` 档位。
 * `auto` 返回 undefined：不指定档位，由模型自己决定（对齐旧 provider 不传 reasoning_effort 的行为）。
 */
export function toPiReasoningLevel(effort: ThinkingEffort | undefined): ThinkingLevel | undefined {
  switch (effort) {
    case "low": return "low"
    case "medium": return "medium"
    case "high": return "high"
    default: return undefined
  }
}

export function piStream(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const gateway = modelGateways.get(model) ?? createConfiguredGateway()
  return gateway.models.streamSimple(model, context, {
    ...options,
    // 网络防护挂在 fetch 上：协议白名单与响应体上限对主链路同样生效。
    // 不支持外部传入 fetch —— 边界只有一处，不接受绕过。
    fetch: gateway.fetch,
    // Harness owns retry budgets; avoid multiplying SDK retries by turn retries.
    maxRetries: 0,
  })
}

// ── Harness 注入面 ──

/**
 * 主回合的模型解析（Harness 与 ContextKernel 共用的唯一入口）。
 * 测试注入的 model 优先，其余走配置网关；contextWindow 与 maxTokens 收敛到本项目的预算口径。
 */
export function resolvePiTurnModel(): PiModel {
  const overrideModel = piRuntimeProviderOverride?.model
  let model: PiModel
  if (overrideModel) {
    const window = Math.min(aiConfig.contextMaxTokens, overrideModel.contextWindow)
    model = { ...overrideModel, contextWindow: window, maxTokens: contextBudget(window).outputReserve }
  } else {
    model = getPiModel()
  }
  // 低于下限的窗口没有可用的压缩切点：在模型解析这个唯一入口报错，
  // 不让回合静默跑在坏预算上（设置页保存时同样会拒绝）。
  const issue = contextWindowError(model.contextWindow)
  if (issue) throw new Error(issue)
  return model
}

export interface HarnessModelsOptions {
  /** 本回合冻结的模型（或读取器）；缺省取测试注入或配置模型。 */
  model?: PiModel | (() => PiModel | undefined)
  /**
   * 取走 `transform_context` 记录的当次请求判定。有值时以下一次请求的响应上报，
   * 而不是同步抛出 —— Harness 的驱动状态机不接受 streamSimple 抛异常（会 fault 整条 lane）。
   *
   * 取走即清空：判定绑定当次请求视图。硬预算超限触发溢出恢复后，Harness 会压缩再重试，
   * 重试请求重新执行 `transform_context` 得到新判定；残留旧判定会让重试被同一条错误挡住。
   */
  takeBlockedError?: () => Error | undefined
}

/**
 * Harness 需要的 Models 薄包装：只覆盖 getModel 与 streamSimple，其余方法直通底层网关。
 *
 * - `getModel` 保证本回合冻结的模型身份总能解析：测试注入的 model 不在网关目录里，
 *   但 Harness 用它做 configuration 校验（identity → model）。
 * - `streamSimple` 委托 piStream（NetGuard fetch、maxRetries: 0）或测试注入的 streamFn；
 *   Harness 每次请求传入的 signal/sessionId/telemetryContext 与其余 streamOptions 原样透传。
 */
export function createHarnessModels(options: HarnessModelsOptions = {}): Models {
  const base = createConfiguredGateway().models
  const resolveModel = (): PiModel => {
    if (options.model === undefined) return resolvePiTurnModel()
    return typeof options.model === "function" ? options.model() ?? resolvePiTurnModel() : options.model
  }
  return new Proxy(base, {
    get(target, property) {
      if (property === "getModel") {
        return (provider: string, id: string) => {
          const resolved = resolveModel()
          return provider === resolved.provider && id === resolved.id ? resolved : target.getModel(provider, id)
        }
      }
      if (property === "streamSimple") {
        return (model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
          const blocked = options.takeBlockedError?.()
          if (blocked) return blockedAssistantStream(model, blocked)
          return toAssistantStream((piRuntimeProviderOverride?.streamFn ?? piStream)(model, context, streamOptions), model)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as Models
}

/**
 * 本地拒绝的 Provider 响应：Harness 会把它结算为失败回合，错误文案原样上报。
 *
 * 硬预算拒绝改走上游的一次性溢出恢复。上游只在响应上判溢出
 * （pi-agent-core `harness/runtime/drive/response.js:115-118`：
 * `isContextOverflow(...) || isRecoverableLength(...)`）：本地拒绝先于请求发生，没有真实
 * provider 文案可以命中 `isContextOverflow` 的正则，而伪造一条命中正则的文案会把用户可见
 * 错误文案绑到上游正则上。改用结构化那条判据 —— `isRecoverableLength` 只要求
 * 「stopReason 为 length 且 usage.output 低于本次请求的输出上限」，正是本地拒绝的语义：
 * 窗口里没有生成空间，输出为 0。命中后 Harness 会 `prepareOverflowCompaction` → 宿主
 * `before_compaction` 摘要 → 单事务提交 → 带 `overflowRecoveryUsed` 重试一次；
 * 恢复用尽或没有可摘要范围时照旧按错误结算，文案不变。
 *
 * 其余投影错误保持 stopReason=error（普通失败路径），不冒充溢出。
 */
function blockedAssistantStream(model: Model<any>, error: Error): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  stream.end({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_GATEWAY_USAGE,
    stopReason: error instanceof ContextBudgetError ? "length" : "error",
    errorMessage: error.message,
    timestamp: Date.now(),
  })
  return stream
}

/**
 * Harness 要求 streamSimple 同步返回消息流；测试注入的 StreamFn 允许返回 Promise。
 * 出现 Promise 时桥接成同步流，避免 Harness 驱动状态机拿到不可迭代对象而 fault。
 */
function toAssistantStream(
  result: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  model: Model<any>,
): AssistantMessageEventStream {
  if (!(result instanceof Promise)) return result
  const bridged = createAssistantMessageEventStream()
  const fail = (error: unknown) => bridged.end({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_GATEWAY_USAGE,
    stopReason: "error",
    errorMessage: formatError(error),
    timestamp: Date.now(),
  })
  void result.then(async stream => {
    try {
      for await (const event of stream) bridged.push(event)
      bridged.end(await stream.result())
    } catch (error) {
      fail(error)
    }
  }, fail)
  return bridged
}

const EMPTY_GATEWAY_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// ── Live Test provider 注入点 ──

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

/** 当前生效的测试 provider；未注入时为 undefined（生产路径）。 */
export function getPiRuntimeProviderOverride(): PiRuntimeProviderOverride | undefined {
  return piRuntimeProviderOverride
}

// ── 一次性文本调用 ──

/** 一次性调用的用途；用量统计按它单列，不从主回合统计里消失。 */
export type PiTextPurpose = "planner" | "compaction" | "memory" | "stages"

/** 一次性调用的审计归属：给出后请求快照与派生记录按会话落盘（不入模型消息流）。 */
export interface PiTextCallAudit {
  sessionId: string
  turnId?: string
  requestId?: string
  /** 派生来源（如触发这次一次性调用的 runId/planId）。 */
  derivedFrom?: string[]
}

export interface PiTextCallInput {
  /** 调用用途：进入按 purpose 分列的用量统计，也用于日志。 */
  purpose: PiTextPurpose
  systemPrompt: string
  userText: string
  thinkingEffort?: ThinkingEffort
  /** 上游取消会与总超时合并，任何一个触发都终止请求。 */
  signal?: AbortSignal
  /** 调用方在 preflight 冻结的模型；提供后不得重新读取运行时配置。 */
  model?: PiModel
  maxTokens?: number
  /** 总时限，默认 PROVIDER_TIMEOUT_MS */
  timeoutMs?: number
  /** 审计归属：有会话可归属时给出，这次请求就进快照体系（无归属的调用不落证据）。 */
  audit?: PiTextCallAudit
}

export interface PiTextCallResult {
  text: string
  /** 拼接后的 thinking 块；stages 需要 text+thinking 合并解析 */
  thinking?: string
  usage: Usage
  stopReason: StopReason
  durationMs: number
}

/**
 * 槽的只读快照（代际与换代身份）。
 *
 * 动态导入 harness-slot：静态导入会形成 `harness-slot → model-gateway → harness-slot` 的模块环
 * （槽在 create 时要用本模块的 createHarnessModels）。
 */
async function readSlotSnapshot(sessionId: string): Promise<HarnessSlotSnapshot | undefined> {
  const { harnessSlots } = await import("./harness-slot")
  return harnessSlots.peek(sessionId)?.snapshot()
}

/**
 * 一次性请求快照的落盘。
 *
 * 槽存在时只入队（本函数在 Provider 调用线程上被 await，而 drive 提交阶段持有 lane 命令锁，
 * 直接写 lane 会与其互等）；槽未打开时（此时 lane 空闲、没有在飞 drive）直接落盘，
 * 不因「没人 flush」丢掉一次性请求的证据。
 */
async function persistAuditSnapshot(sessionId: string, purpose: PiTextPurpose, snapshot: PromptSnapshot): Promise<void> {
  const { harnessSlots } = await import("./harness-slot")
  const slot = harnessSlots.peek(sessionId)
  if (slot) {
    slot.queueAuditEntry(PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
    return
  }
  try {
    const { appendPiSessionCustomEntry } = await import("@/services/session/repo")
    await appendPiSessionCustomEntry(sessionId, PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
  } catch (error) {
    log.error("一次性请求快照落盘失败:", { sessionId, purpose }, formatError(error))
  }
}

function thinkingText(content: AssistantMessage["content"]): string {
  return content
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n")
}

/**
 * 一次性（无工具、无多轮）的文本补全，替代已删除的旧 OpenAI-compatible Provider 实现。
 *
 * 三个刻意的语义决策：
 * 1. 自己检查 `stopReason`：pi-ai 的失败是「正常结束 + stopReason=error/aborted」，
 *    不检查就会把失败当成空回复交给调用方。
 * 2. 自己用 AbortController 兜总时限：`timeoutMs` 只是 SDK 的请求超时（收到响应头就清），
 *    SSE 断在半路不会触发。abort 文案沿用旧 provider 的「Provider 请求超时或已取消」。
 * 3. 不写 updateRequestStats：这是一次性旁路调用，不属于 transcript，混进主回合的 last/上下文统计
 *    只会污染主链路的 token/工具计数。用量按 purpose 记进分列统计（含失败响应），既不冒充主回复
 *    统计，也不从总消耗里消失。给出 `audit` 归属后请求前后各写一档 PromptSnapshot（条目落在
 *    归属会话里，`one-shot:<purpose>` 身份与主回合的可区分），没给归属就不落证据。
 */
export async function completePiText(input: PiTextCallInput): Promise<PiTextCallResult> {
  const startedAt = Date.now()
  const timeoutMs = input.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const override = piRuntimeProviderOverride
  const model = input.model ?? override?.model ?? getPiModel()
  const streamFn = override?.streamFn ?? piStream
  const outputBudget = contextBudget(model.contextWindow, model.maxTokens).outputReserve
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new Error("maxTokens 必须是正整数")
  }
  const maxTokens = input.maxTokens === undefined ? outputBudget : Math.min(input.maxTokens, outputBudget)

  let systemPrompt = input.systemPrompt
  if (input.thinkingEffort === "low" && !model.reasoning) systemPrompt += NON_REASONING_LOW_EFFORT_HINT

  const requestBudget = contextBudget(model.contextWindow, maxTokens)
  const estimatedInput = estimateRequestTokens(systemPrompt, [{ role: "user", content: input.userText }])
  if (estimatedInput > requestBudget.hardInputLimit) throw new ContextBudgetError(estimatedInput, requestBudget.hardInputLimit)

  // 一次性请求的审计归属：purpose/step 进 request，块与消息用 one-shot:* 身份
  // （比笼统的 "one_shot" 更细，审计可按用途分组）。
  const audit = input.audit
  const slotSnapshot = audit ? await readSlotSnapshot(audit.sessionId) : undefined
  const oneShot = (captureStage: PromptSnapshot["captureStage"], extra: Partial<PromptSnapshotInput> = {}): PromptSnapshotInput => ({
    snapshotId: `one-shot:${input.purpose}:${startedAt}:${captureStage}`,
    requestId: audit!.requestId ?? `one-shot-${startedAt}`,
    sessionId: audit!.sessionId,
    turnId: audit!.turnId ?? `one-shot-${startedAt}`,
    runId: audit!.derivedFrom?.[0] ?? `one-shot-${startedAt}`,
    captureStage,
    model: model.id,
    provider: model.provider,
    systemBlocks: [{
      blockId: `one-shot:${input.purpose}`, layer: "static", source: input.purpose,
      text: systemPrompt, priority: 100, origin: "system", taint: "system",
    }],
    toolSchemas: [],
    agentMessages: [{ id: `one-shot:${input.purpose}:0`, role: "user", content: input.userText }],
    llmMessages: [{ role: "user", content: input.userText }],
    transforms: [],
    estimatedInputTokens: estimatedInput,
    request: {
      purpose: input.purpose === "compaction" ? "compaction" : "one_shot",
      ...(input.purpose === "compaction" ? { step: "compaction" as const } : {}),
    },
    requestParams: { maxTokens },
    generation: slotSnapshot?.generation ?? 0,
    // 未知的换代基数不写 0（那会谎称请求视图未换代）。
    ...(input.purpose === "compaction" && slotSnapshot?.contextEpoch !== undefined
      ? { compaction: { count: slotSnapshot.contextEpoch } }
      : {}),
    ...extra,
  })
  if (audit) {
    // 请求前先落一档 payload 快照：一次性调用没有回合，证据只能由自己留下。
    const payloadSnapshot = await createPromptSnapshot(oneShot("provider_payload"))
    await persistAuditSnapshot(audit.sessionId, input.purpose, payloadSnapshot)
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(input.signal?.reason ?? new Error("Provider 请求已取消"))
  if (input.signal?.aborted) abortFromCaller()
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Provider 请求超时")), timeoutMs)
  try {
    // 不把已取消的 signal 交给可能忽略它的 provider/fake stream，避免取消后仍发起请求。
    if (controller.signal.aborted) throw new Error("Provider 请求超时或已取消")
    const messages: PiMessage[] = [{ role: "user", content: input.userText, timestamp: startedAt }]
    // StreamFn 允许返回 Promise（pi-agent-core 的签名），先 await 拿到流本身。
    const stream = await streamFn(model, { systemPrompt, messages }, {
      signal: controller.signal,
      // 头阶段超时双保险；总时限仍然由上面的 AbortController 兜底。
      timeoutMs,
      reasoning: toPiReasoningLevel(input.thinkingEffort),
      // 所有一次性调用与主上下文使用相同的输出预留；调用方只能再收紧。
      maxTokens,
    })
    const message = await stream.result()
    // 响应一到就记用量：失败/截断的响应同样产生成本，不能只计成功调用。
    // Provider 未回报时这里只累加次数（recordModelUsage 不把全 0 当准确值）。
    recordModelUsage(input.purpose, message.usage)
    // 第二档证据（provider_usage）同样在失败响应上采集：估算偏差与实际 usage 的对账不能只在成功路径存在。
    if (audit) {
      const text = contentText(message.content)
      const ratio = estimateDriftRatio(estimatedInput, message.usage.input)
      const summaryHash = input.purpose === "compaction" && text.length > 0
        ? await sha256Text(redactText(text).text)
        : undefined
      const usageSnapshot = await createPromptSnapshot(oneShot("provider_usage", {
        actualInputTokens: message.usage.input,
        actualOutputTokens: message.usage.output,
        ...(ratio === undefined ? {} : {
          tokenDrift: { estimated: estimatedInput, actual: message.usage.input, ratio },
        }),
        cache: {
          sessionId: audit.sessionId,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
        },
        ...(summaryHash !== undefined && slotSnapshot?.contextEpoch !== undefined
          ? { compaction: { count: slotSnapshot.contextEpoch, summaryHash } }
          : {}),
      }))
      await persistAuditSnapshot(audit.sessionId, input.purpose, usageSnapshot)
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(controller.signal.aborted
        ? "Provider 请求超时或已取消"
        : message.errorMessage || "Provider 请求失败")
    }
    if (message.stopReason === "length") {
      throw new Error("Provider 输出达到长度上限，拒绝使用不完整结果")
    }

    const thinking = thinkingText(message.content)
    const result: PiTextCallResult = {
      text: contentText(message.content),
      ...(thinking ? { thinking } : {}),
      usage: message.usage,
      stopReason: message.stopReason,
      durationMs: Date.now() - startedAt,
    }
    log.debug(`[${input.purpose}] 完成: ${result.durationMs}ms, stop=${result.stopReason}, out=${result.usage.output}`)
    return result
  } catch (e) {
    log.warn(`[${input.purpose}] 失败 (${Date.now() - startedAt}ms):`, formatError(e))
    throw e
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abortFromCaller)
  }
}
