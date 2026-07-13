// ==========================================
// Mock AI Controller — 可编程的 AI Provider
// 用于 Mock 模式下控制 Agent Loop 的 AI 行为
// ==========================================

import type { Message } from "@/services/agent/types"

export interface ToolCallDef {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface MockAIResponse {
  text?: string
  thinking?: string
  toolCalls?: ToolCallDef[]
}

export interface MockAIInput {
  messages: Message[]
  systemPrompt: string
  maxTokens: number
}

export interface MockAIScript {
  name: string
  match: (userText: string) => boolean
  respond: (input: MockAIInput) => MockAIResponse
}

// ── Script Builder ──

export class ScriptBuilder {
  private _name: string
  private _match: (text: string) => boolean = () => false
  private _responses: MockAIResponse[] = []
  private _responseIndex = 0

  constructor(name: string) { this._name = name }

  matching(pattern: RegExp | string): this {
    this._match = typeof pattern === "string"
      ? (text) => text.includes(pattern)
      : (text) => pattern.test(text)
    return this
  }

  matchingAny(): this { this._match = () => true; return this }

  respondText(text: string, thinking?: string): this {
    this._responses.push({ text, thinking }); return this
  }

  respondToolCall(toolName: string, args: Record<string, unknown>): this {
    this._responses.push({ toolCalls: [{ id: `call_${Date.now()}`, name: toolName, arguments: args }] })
    return this
  }

  respondToolThenText(toolName: string, args: Record<string, unknown>, text: string): this {
    this._responses.push({ toolCalls: [{ id: `call_${Date.now()}`, name: toolName, arguments: args }] })
    this._responses.push({ text }); return this
  }

  build(): MockAIScript {
    const responses = [...this._responses]
    const idx = { v: 0 }
    return {
      name: this._name, match: this._match,
      respond: () => responses[idx.v++] ?? responses[responses.length - 1] ?? { text: "" },
    }
  }
}

// ── Controller ──

export class MockAIController {
  private scripts: MockAIScript[] = []
  private defaultResponse: MockAIResponse = { text: "嗯嗯～Pちゃん说的对呢♡" }
  history: { input: MockAIInput; output: MockAIResponse }[] = []

  register(script: MockAIScript): void { this.scripts.push(script) }
  when(name: string): ScriptBuilder { return new ScriptBuilder(name) }

  setDefault(response: MockAIResponse): void { this.defaultResponse = response }

  findMatch(input: MockAIInput): MockAIResponse {
    const userText = input.messages[input.messages.length - 1]?.text ?? ""
    for (const script of this.scripts) {
      if (script.match(userText)) {
        const response = script.respond(input)
        this.history.push({ input, output: response })
        return response
      }
    }
    this.history.push({ input, output: this.defaultResponse })
    return this.defaultResponse
  }

  reset(): void { this.scripts = []; this.history = [] }
}

export const mockAIController = new MockAIController()
