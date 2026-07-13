// ==========================================
// Mock AI Provider — 拦截 Agent Loop 中的 AI 调用
// ==========================================

import { mockAIController } from "./mock-ai-controller"
import type { MockAIResponse } from "./mock-ai-controller"

/**
 * Mock OpenAICompatibleProvider
 * 在 vitest 中通过 vi.mock 替换真实的 Provider
 */
export class MockOpenAICompatibleProvider {
  async generateReply(input: {
    messages: { id: string; role: string; text: string; timestamp: number }[]
    systemPrompt: string
    maxTokens: number
  }): Promise<MockAIResponse & { finishReason?: string }> {
    const response = mockAIController.findMatch({
      messages: input.messages as any,
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens,
    })

    const hasToolCalls = response.toolCalls && response.toolCalls.length > 0

    return {
      text: hasToolCalls ? undefined : (response.text || ""),
      thinking: response.thinking,
      toolCalls: response.toolCalls?.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
      finishReason: hasToolCalls ? "tool_calls" : "stop",
    } as any
  }
}
