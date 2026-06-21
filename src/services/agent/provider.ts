// ==========================================
// Agent Provider —— 统一 OpenAI 兼容 Provider
// 支持 DeepSeek / OpenAI / Ollama / LM Studio 等
// Phase 2: 支持工具调用 (function_call) + 思考强度参数
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

    const config = {
      endpoint: aiConfig.endpoint,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
    }

    let base = config.endpoint.replace(/\/+$/, "")
    const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`

    const apiMessages: APIMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages.map(toAPIMessage),
    ]

    const bodyObj: Record<string, unknown> = {
      model: config.model,
      messages: apiMessages,
    }

    if (tools && tools.length > 0) {
      bodyObj.tools = tools
      bodyObj.tool_choice = "auto"
    }

    // 思考强度 → 仅对支持 reasoning_effort 的模型传递参数
    if (thinkingEffort && thinkingEffort !== "auto") {
      if (config.model.includes("deepseek") || config.model.includes("o1") || config.model.includes("o3") || config.model.includes("o4")) {
        bodyObj.reasoning_effort = thinkingEffort
      }
    }

    // 非 reasoning 模型的 fallback：在 system prompt 中追加提示
    if (thinkingEffort === "low" && !config.model.includes("deepseek") && !config.model.includes("o1") && !config.model.includes("o3")) {
      const sysMsg = apiMessages[0]
      if (sysMsg && sysMsg.role === "system" && typeof sysMsg.content === "string") {
        sysMsg.content += "\n\n[请快速简要回答，不需要过多思考]"
      }
    }

    const body = JSON.stringify(bodyObj)
    log.debug("请求 →", url, "| model:", config.model, "| tools:", tools?.length ?? 0)

    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.apiKey,
        },
        body,
      })
    } catch (e) {
      const msg = e instanceof TypeError
        ? `网络不可达 (${e.message})，请检查 endpoint: ${url}`
        : String(e)
      throw new Error(msg)
    }

    if (!res.ok) {
      let detail = ""
      try { const err = await res.json(); detail = JSON.stringify(err) } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? " " + detail : ""}`)
    }

    const data = await res.json()

    // 使用统一的解析器
    const parsed = parseAIResponse(data)
    const usage = data.usage

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      thinking: parsed.thinking,
      usage: usage ? {
        promptTokens: Number(usage.prompt_tokens ?? 0),
        completionTokens: Number(usage.completion_tokens ?? 0),
      } : undefined,
    }
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
