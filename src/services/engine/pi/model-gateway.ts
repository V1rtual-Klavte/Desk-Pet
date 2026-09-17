// Pi AI gateway for Desk-Pet's OpenAI-compatible provider configuration.
//
// 这里是「Desk-Pet 配置 → pi-ai 调用」的唯一出口：主链路（runtime.ts）用
// piStream，一次性文本调用（planner / 压缩 / 记忆 / 阶段文案）用 completePiText。
// 两者共用同一套模型解析、reasoning 映射与网络防护。

import { contentText, createModels, createProvider } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type { AssistantMessage, Context, Message as PiMessage, Model, MutableModels, Provider, SimpleStreamOptions, StopReason, ThinkingContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { contextBudget, ContextBudgetError, estimateRequestTokens } from "@/services/context"
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

export interface PiTextCallInput {
  /** 调用用途，仅用于日志与未来路由；不参与请求构造 */
  purpose: "planner" | "compaction" | "memory" | "stages"
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
}

export interface PiTextCallResult {
  text: string
  /** 拼接后的 thinking 块；stages 需要 text+thinking 合并解析 */
  thinking?: string
  usage: Usage
  stopReason: StopReason
  durationMs: number
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
 * 3. 不写 PromptSnapshot、不写 updateRequestStats：这是一次性旁路调用，不属于 transcript，
 *    混进回合统计只会污染主链路的 token/工具计数。
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
