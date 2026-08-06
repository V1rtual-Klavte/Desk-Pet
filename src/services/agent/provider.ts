// ==========================================
// Agent Provider —— 统一 OpenAI 兼容 Provider
// 支持 DeepSeek / OpenAI / Ollama / LM Studio 等
// 支持工具调用 (function_call) + 思考强度参数
// ==========================================

import type { AIProvider, Message, GenerateRequest, GenerateResponse, APIMessage } from "./types"
import { parseAIResponse } from "@/services/engine/parser"
import { aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Provider")

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible"

  async generateReply(req: GenerateRequest): Promise<GenerateResponse> {
    const { messages, systemPrompt, tools, thinkingEffort } = req
    const { url, body } = buildRequestBody(messages, systemPrompt, tools, thinkingEffort, req.maxTokens)

    log.debug("请求 →", url, "| model:", aiConfig.model, "| tools:", tools?.length ?? 0)

    const res = await doFetch(url, body)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json()
    const parsed = parseAIResponse(data)
    if (!parsed.text && parsed.toolCalls.length === 0) {
      log.warn("响应正文为空:", summarizeEmptyResponse(data))
    }

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      thinking: parsed.thinking,
      usage: data.usage ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0),
        completionTokens: Number(data.usage.completion_tokens ?? 0),
      } : undefined,
    }
  }
}

// ── 请求构造 ──

function buildRequestBody(
  messages: Message[], systemPrompt: string,
  tools: GenerateRequest["tools"], thinkingEffort: GenerateRequest["thinkingEffort"],
  maxTokens?: number,
) {
  let base = aiConfig.endpoint.replace(/\/+$/, "")
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`

  const apiMessages: APIMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages.map(toAPIMessage),
  ]

  const bodyObj: Record<string, unknown> = {
    model: aiConfig.model, messages: apiMessages, stream: false,
  }

  if (maxTokens) { bodyObj.max_tokens = maxTokens }

  if (tools && tools.length > 0) { bodyObj.tools = tools; bodyObj.tool_choice = "auto" }

  if (thinkingEffort && thinkingEffort !== "auto") {
    if (aiConfig.model.includes("deepseek") || aiConfig.model.includes("o1") || aiConfig.model.includes("o3") || aiConfig.model.includes("o4")) {
      bodyObj.reasoning_effort = thinkingEffort
    }
  }

  if (thinkingEffort === "low" && !aiConfig.model.includes("deepseek") && !aiConfig.model.includes("o1") && !aiConfig.model.includes("o3") && !aiConfig.model.includes("o4")) {
    const sysMsg = apiMessages[0]
    if (sysMsg && sysMsg.role === "system" && typeof sysMsg.content === "string") {
      sysMsg.content += "\n\n[请快速简要回答，不需要过多思考]"
    }
  }

  return { url, body: JSON.stringify(bodyObj) }
}

function summarizeEmptyResponse(data: unknown): string {
  try {
    const choice = (data as any)?.choices?.[0]
    return JSON.stringify({
      finish_reason: choice?.finish_reason,
      message: choice?.message,
      delta: choice?.delta,
      usage: (data as any)?.usage,
      error: (data as any)?.error,
    }).slice(0, 1000)
  } catch {
    return "无法序列化响应"
  }
}

async function doFetch(url: string, body: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(aiConfig.apiKey ? { Authorization: "Bearer " + aiConfig.apiKey } : {}),
      },
      body,
    })
  } catch (e) {
    throw new Error(e instanceof TypeError ? `网络不可达 (${e.message})` : String(e))
  }
}

function toAPIMessage(m: Message): APIMessage {
  if (m.role === "tool") {
    return { role: "tool", content: m.text, tool_call_id: m.toolCallId }
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.text || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  return { role: m.role as "user" | "assistant" | "system", content: m.text }
}
