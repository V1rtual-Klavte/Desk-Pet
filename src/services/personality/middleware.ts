// ==========================================
// 人格中间件 —— 横切所有 Agent 阶段的角色化表达
// 不参与 Agent 执行逻辑，只影响 UI 展示（表情/音效/角色话术）
// ==========================================

import type { PersonalityCard } from "./types"
import { getActiveCard, getSystemPrompt as getPersonaPrompt } from "./registry"
import { getBoundaryLevel } from "./boundary"
import { createLogger } from "@/services/logger"

const log = createLogger("PersonaMW")

// ── Agent 阶段定义 ──

export type AgentStage =
  | "thinking"   // 收到消息，准备思考
  | "planning"   // Plan 步骤进行中
  | "generating" // AI 生成中
  | "executing"  // 执行工具
  | "blocked"    // 安全拦截
  | "error"      // 出错
  | "done"       // 完成回复
  | "idle"       // 空闲

/** 阶段上下文 */
export interface StageContext {
  /** 当前正在执行或已完成的操作名称（executing/done/blocked 阶段） */
  toolName?: string
  /** 附加消息 */
  message?: string
  /** 边界值 */
  boundaryLevel?: number
}

/** 阶段人格效果 */
export interface PersonalityEffect {
  /** 展示给用户的角色化提示（null 表示不展示） */
  userMessage: string | null
  /** 角色表情 ID */
  expression: string
  /** 音效事件 key（null 表示不播放） */
  soundEvent: string | null
  /** 边界值变化 */
  boundaryDelta: number
}

// ── 各阶段默认表情 ──

const STAGE_EXPRESSIONS: Record<AgentStage, string> = {
  thinking: "smile",
  planning: "business",
  generating: "smile",
  executing: "business",
  blocked: "gaoo",
  error: "sleepy",
  done: "chu",
  idle: "idle",
}

// ── 各阶段默认音效 ──

const STAGE_SOUNDS: Partial<Record<AgentStage, string>> = {
  thinking: undefined,
  planning: undefined,
  generating: undefined,
  executing: undefined,
  blocked: undefined,
  error: undefined,
  done: "reply",
  idle: undefined,
}

// ── 工具→角色化文案映射 ──

const TOOL_PERSONALITY_MAP: Record<string, { executing?: string; done?: string; blocked?: string }> = {
  "file_read":    { executing: "让我读读这个文件...", done: "读完啦～", blocked: "唔…这个文件不能读呢～" },
  "file_list":    { executing: "让我看看这里面有什么...", done: "看到了～", blocked: "这个目录不能看哦～" },
  "file_search":  { executing: "帮你找找...", done: "找到了！", blocked: "唔…这里不能搜呢～" },
  "file_write":   { executing: "帮你写下来...", done: "写好啦～", blocked: "这个文件不能写哦～" },
  "bash_exec":    { executing: "让我来处理...", done: "搞定！", blocked: "这个命令不能执行呢～" },
  "system_info":  { executing: "检查一下电脑状态...", done: "嗯嗯了解了～" },
  "http_get":     { executing: "帮你上网查查...", done: "查到了～" },
  "app_open":     { executing: "帮你打开...", done: "打开了～" },
  "_default":     { executing: "让我用工具处理一下...", done: "完成啦～" },
}

// ── 中间件实现 ──

export const PetPersonalityMiddleware = {
  /**
   * 包裹 Agent 阶段，返回人格化效果。
   * 此方法纯计算，无副作用，不修改任何状态。
   */
  wrap(stage: AgentStage, ctx: StageContext = {}): PersonalityEffect {
    const card = getActiveCard()
    const boundary = ctx.boundaryLevel ?? getBoundaryLevel()

    // 表情：优先从人格卡 stage 逻辑获取，无则回退默认
    const expression = STAGE_EXPRESSIONS[stage] || "idle"

    // 音效
    const soundEvent = STAGE_SOUNDS[stage] ?? null

    // 用户消息
    let userMessage: string | null = null
    let boundaryDelta = 0

    switch (stage) {
      case "thinking":
        // 通常不显示，但超长思考时可提示
        userMessage = null
        break

      case "planning":
        userMessage = "嗯...让我想想怎么帮你～"
        break

      case "generating":
        userMessage = null // 流式文本已在展示
        break

      case "executing": {
        const hint = ctx.toolName ? TOOL_PERSONALITY_MAP[ctx.toolName] : undefined
        userMessage = hint?.executing ?? TOOL_PERSONALITY_MAP._default.executing ?? null
        break
      }

      case "blocked": {
        const hint = ctx.toolName ? TOOL_PERSONALITY_MAP[ctx.toolName] : undefined
        userMessage = hint?.blocked ?? "唔...这个我不能做呢～"
        boundaryDelta = 0
        break
      }

      case "error":
        userMessage = ctx.message ?? "啊...信号不太好～"
        break

      case "done": {
        const hint = ctx.toolName ? TOOL_PERSONALITY_MAP[ctx.toolName] : undefined
        // 完成工具调用后显示完成文案
        if (hint?.done) userMessage = hint.done
        boundaryDelta = 0
        break
      }

      case "idle":
        userMessage = null
        break
    }

    return { userMessage, expression, soundEvent, boundaryDelta }
  },

  /**
   * 获取当前人格的完整 System Prompt（含边界提示）。
   * 由 ContextEngine 调用，组合到上下文。
   */
  getSystemPrompt(unansweredCount?: number): string {
    return getPersonaPrompt(unansweredCount)
  },

  /**
   * 获取当前人格卡（null = 默认人格）。
   */
  getActiveCard(): PersonalityCard | null {
    return getActiveCard()
  },
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("人格中间件 HMR 完成")
  })
}
