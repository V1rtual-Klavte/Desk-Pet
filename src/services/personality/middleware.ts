// ==========================================
// 人格中间件 v4 — stages 缓存 + actionCategory 匹配
// ==========================================

import { getActiveCard } from "./registry"
import { getStagePrompt, getSimpleStage } from "./stages-cache"
import { createLogger } from "@/services/logger"

const log = createLogger("PersonaMW")

export type AgentStage =
  | "thinking" | "planning" | "generating"
  | "executing" | "blocked" | "error" | "retry" | "done" | "idle"

export interface StageContext {
  toolName?: string
  actionCategory?: string
  message?: string
}

export interface PersonalityEffect {
  userMessage: string | null
  expression: string
  soundEvent: string | null
}

// ── 默认 ──

const DEFAULT_EXPRESSIONS: Record<AgentStage, string> = {
  thinking: "smile", planning: "business", generating: "smile",
  executing: "business", blocked: "gaoo", error: "sleepy",
  retry: "smile", done: "chu", idle: "idle",
}

const DEFAULT_SOUNDS: Partial<Record<AgentStage, string | null>> = {
  done: "reply",
}

// ── 中间件 ──

export const PetPersonalityMiddleware = {
  wrap(stage: AgentStage, ctx: StageContext = {}): PersonalityEffect {
    const expression = DEFAULT_EXPRESSIONS[stage] || "idle"
    const soundEvent = DEFAULT_SOUNDS[stage] ?? null
    let userMessage: string | null = null

    switch (stage) {
      case "thinking":
      case "generating":
      case "idle":
        userMessage = null
        break
      case "planning":
        userMessage = getSimpleStage("planning")
        break
      case "executing":
        userMessage = getStagePrompt("executing", ctx.actionCategory ?? "_default")
        break
      case "done":
        userMessage = getStagePrompt("done", ctx.actionCategory ?? "_default")
        break
      case "blocked":
        userMessage = getStagePrompt("blocked", ctx.actionCategory ?? "_default")
        break
      case "error":
        userMessage = ctx.message ?? getSimpleStage("error")
        break
      case "retry":
        userMessage = getSimpleStage("retry")
        break
    }

    return { userMessage, expression, soundEvent }
  },

  getSystemPrompt(): string {
    const card = getActiveCard()
    return card?.sections.roleSetting ?? ""
  },

  getActiveCard() { return getActiveCard() },
}
