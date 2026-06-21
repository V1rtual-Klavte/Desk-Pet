// ==========================================
// Agent 服务 —— 调用 Provider、统一错误处理、离线回退
// Phase 2: 适配新的 Provider 接口 (GenerateRequest/GenerateResponse)
// ==========================================

import type { Message, AIProvider, GenerateRequest, GenerateResponse } from "./types"
import { aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("AgentSvc")

export class AIService {
  private provider: AIProvider
  private fallbackReplies: string[]

  constructor(provider: AIProvider, fallbackReplies?: string[]) {
    this.provider = provider
    this.fallbackReplies = fallbackReplies ?? aiConfig.fallbackReplies
  }

  setProvider(provider: AIProvider): void {
    this.provider = provider
  }

  /** 调用 AI 生成回复（兼容旧接口） */
  async generateReply(messages: Message[], systemPrompt: string): Promise<string> {
    if (!aiConfig.configured) return this.randomFallback()
    try {
      const response = await this.provider.generateReply({
        messages,
        systemPrompt,
      })
      return response.text
    } catch (e) {
      log.error("Provider error:", e instanceof Error ? e.message : String(e))
      return `（网络连接异常）${e instanceof Error ? " " + e.message : ""}`
    }
  }

  randomFallback(): string {
    return this.fallbackReplies[Math.floor(Math.random() * this.fallbackReplies.length)]
  }
}
