// ==========================================
// 核心引擎 —— 解析器
// 解析 AI 输出：区分纯文本 / function_call / 思考内容
// ==========================================

import type { ToolCallRequest, ParsedAIOutput } from "@/services/agent/types"
import { createLogger } from "@/services/logger"

const log = createLogger("Parser")

/**
 * 解析 AI 响应体中的 content, tool_calls, reasoning_content
 */
export function parseAIResponse(data: Record<string, unknown>): ParsedAIOutput {
  const choice = (data.choices as Record<string, unknown>[])?.[0]
  if (!choice) {
    log.warn("AI 响应无 choices")
    return { text: "", toolCalls: [], finished: true }
  }

  const message = choice.message as Record<string, unknown> | undefined
  const delta = choice.delta as Record<string, unknown> | undefined

  // 流式 vs 非流式
  const msg = message || delta || {}
  const content = String(msg.content ?? "")
  const thinking = String(msg.reasoning_content ?? "")

  // 解析 tool_calls
  const rawToolCalls = msg.tool_calls as Record<string, unknown>[] | undefined
  const toolCalls: ToolCallRequest[] = []

  if (rawToolCalls) {
    for (const tc of rawToolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined
      if (fn && tc.id) {
        toolCalls.push({
          id: String(tc.id),
          name: String(fn.name ?? ""),
          arguments: String(fn.arguments ?? "{}"),
        })
      }
    }
  }

  // 检查 finished
  const finishReason = String(choice.finish_reason ?? "")

  return {
    text: content,
    toolCalls,
    thinking: thinking || undefined,
    finished: finishReason === "stop" || finishReason === "tool_calls" || finishReason === "length",
  }
}

/**
 * 并行解析 —— 将模型返回的 tool_calls 合并到已有列表
 * （用于流式累积 delta）
 */
export function mergeToolCalls(
  existing: ToolCallRequest[],
  newCalls: ToolCallRequest[],
): ToolCallRequest[] {
  const merged = [...existing]
  for (const nc of newCalls) {
    const idx = merged.findIndex(tc => tc.id === nc.id)
    if (idx >= 0) {
      // 累积 arguments（流式 delta 会逐块返回）
      merged[idx] = {
        ...merged[idx],
        arguments: merged[idx].arguments + nc.arguments,
      }
    } else {
      merged.push({ ...nc })
    }
  }
  return merged
}
