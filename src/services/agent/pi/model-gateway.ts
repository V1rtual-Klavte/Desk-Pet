// Pi AI gateway for Desk-Pet's OpenAI-compatible provider configuration.

import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig } from "@/services/config"

function normalizeBaseUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "")
  return base.endsWith("/v1") ? base : `${base}/v1`
}

function isReasoningModel(): boolean {
  const name = aiConfig.model.toLowerCase()
  const endpoint = aiConfig.endpoint.toLowerCase()
  return name.includes("reason") || name.includes("o1") || name.includes("o3") || name.includes("o4") || endpoint.includes("deepseek")
}

export function getPiModel(): Model<"openai-completions"> {
  return {
    id: aiConfig.model,
    name: aiConfig.model,
    api: "openai-completions",
    provider: aiConfig.provider as Model<"openai-completions">["provider"],
    baseUrl: normalizeBaseUrl(aiConfig.endpoint),
    reasoning: isReasoningModel(),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: aiConfig.contextMaxTokens,
    // ReplyGenerator only keeps 500 characters; leave headroom for reasoning and RUNTIME_DATA.
    maxTokens: Math.min(4096, Math.max(1024, Math.floor(aiConfig.contextMaxTokens / 4))),
  }
}

export function toPiAgentThinkingLevel(effort: ThinkingEffort | undefined): "off" | "low" | "medium" | "high" {
  switch (effort) {
    case "low": return "low"
    case "medium": return "medium"
    case "high": return "high"
    default: return "off"
  }
}

export function piStream(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  return streamSimple(model as Model<"openai-completions">, context, {
    ...options,
    // pi-ai requires a non-empty key even for local OpenAI-compatible endpoints.
    apiKey: aiConfig.apiKey || "local-openai-compatible",
  })
}
