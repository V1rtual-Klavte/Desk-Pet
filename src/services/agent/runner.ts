// ==========================================
// Agent 运行器 —— sendMessage / initChat
// Phase 2: 接入 Agent Loop + 中间件 + 工具系统
// ==========================================

import { getActiveCard } from "@/services/personality"
import { runAgentLoop } from "@/services/engine/agent-loop"
import { preProcess } from "@/services/engine/preprocessor"
import { generateReply } from "@/services/reply/generator"
import { transition, getState } from "@/services/engine/session"
import {
  chatHistory, unansweredCount,
  pushUserMessage, pushAssistantMessage,
  getContextMessages, initWelcome, resetUnanswered,
  initSessions, getActiveSessionId,
} from "@/services/session"
import { loadMessages, saveMessages } from "@/services/session/persistence"
import { updateSessionMessageCount } from "@/services/session/manager"
import { createAssistantMessage } from "@/services/agent/types"
import { isAIGenerating, setAIGenerating } from "@/services/cooldown"
import { createLogger } from "@/services/logger"

const log = createLogger("Agent")

/** 工具调用历史（供 UI 展示人格化过程） */
export const toolCallHistory = {
  entries: [] as { toolName: string; status: string; personalityMsg?: string }[],
  clear() { this.entries.splice(0, this.entries.length) },
  push(e: { toolName: string; status: string; personalityMsg?: string }) { this.entries.push(e) },
}

/** 初始化聊天 */
export async function initChat(welcomeText?: string): Promise<void> {
  const card = getActiveCard()
  if (card) {
    log.info("当前人格:", card.name, "| ID:", card.id)
  } else {
    log.info("当前人格: 默认")
  }

  // 初始化会话（扫描 sessions/ 目录 + localStorage 缓存）
  const sessions = await initSessions()
  log.info("会话已恢复:", sessions.length, "个, 活跃:", getActiveSessionId())

  if (welcomeText) {
    initWelcome(welcomeText)
  } else if (card?.firstMessage) {
    initWelcome(card.firstMessage)
  }
}

/**
 * 发送用户消息并获取 AI 回复。
 * Phase 2: 使用 Agent Loop（支持工具调用多轮）。
 *
 * ★ 绑定会话：入口捕获 sessionId，异步回复回来时校验。
 *   若会话已切换，回复存入原会话 localStorage + session 文件，不污染当前 chatHistory。
 */
export async function sendMessage(text: string): Promise<{
  reply: string
  toolCallsMade: number
  personalityEffect: { expression: string; soundEvent: string | null }
}> {
  // ★ 入口绑定会话 ID（防止异步回复错位到其他会话）
  const originSessionId = getActiveSessionId()

  // 并发锁
  if (isAIGenerating()) {
    log.warn("AI 生成中，拒绝用户消息并发请求")
    return {
      reply: "（糖糖正在想事情，等一下再发哦～）",
      toolCallsMade: 0,
      personalityEffect: { expression: "idle", soundEvent: null },
    }
  }

  setAIGenerating(true)

  try {
    // ── Step 1: 预处理 ──
    transition("PRE")
    const preResult = await preProcess(text)

    if (preResult.handled) {
      if (preResult.response) {
        // slash 命令输出 → 以系统消息推送
        const { pushSystemMessage } = await import("@/services/session/messages");
        pushSystemMessage(preResult.response)
        transition("WAITING")
        return {
          reply: preResult.response,
          toolCallsMade: 0,
          personalityEffect: { expression: "idle", soundEvent: null },
        }
      }
      transition("WAITING")
      return {
        reply: "",
        toolCallsMade: 0,
        personalityEffect: { expression: "idle", soundEvent: null },
      }
    }

    pushUserMessage(preResult.text)
    resetUnanswered()

    // ── Step 3: 进入 Generating 状态 ──
    transition("GENERATING")

    // ── Step 4: 运行 Agent Loop ──
    toolCallHistory.clear()
    const result = await runAgentLoop({
      userText: preResult.text,
      chatMessages: getContextMessages(),
      unansweredCount: unansweredCount.value,
      isActiveMessage: false,
      isRetry: false,
    })

    // ── Step 5: 后处理 ──
    const processed = generateReply(result.reply, { maxLength: 500 })

    // ── Step 6: 提取人格效果（agent-loop 已收集）──
    const lastEffect = result.effects.length > 0
      ? result.effects[result.effects.length - 1]
      : { expression: "smile", soundEvent: "reply" }

    // 记录工具调用历史
    if (result.toolCallHistory.length > 0) {
      toolCallHistory.entries.push(...result.toolCallHistory)
    }

    // ★ 会话校验：若等待 AI 回复期间用户切了会话，回复存入原会话
    if (getActiveSessionId() !== originSessionId) {
      log.warn("sendMessage: 会话已切换，回复存入原会话", originSessionId)
      // 从 localStorage 加载原会话消息，追加 assistant 回复，写回
      const originMsgs = loadMessages(originSessionId)
      originMsgs.push(createAssistantMessage(processed))
      saveMessages(originSessionId, originMsgs)
      updateSessionMessageCount(originSessionId)
      // 写入原会话的 sessions/*.md
      const { MemoryService } = await import("@/services/agent/memory")
      await MemoryService.recordTurnToSession(originSessionId, "assistant", processed)
    } else {
      pushAssistantMessage(processed)
    }

    transition("WAITING")
    return {
      reply: processed,
      toolCallsMade: result.toolCallHistory.length,
      personalityEffect: {
        expression: lastEffect.expression,
        soundEvent: lastEffect.soundEvent,
      },
    }
  } catch (e) {
    log.error("sendMessage 失败", e instanceof Error ? e : undefined)
    const fallback = "（唔…信号不太好，等会儿再试试？）"
    // ★ 同样校验会话
    if (getActiveSessionId() !== originSessionId) {
      const originMsgs = loadMessages(originSessionId)
      originMsgs.push(createAssistantMessage(fallback))
      saveMessages(originSessionId, originMsgs)
    } else {
      pushAssistantMessage(fallback)
    }
    transition("WAITING")
    return {
      reply: fallback,
      toolCallsMade: 0,
      personalityEffect: { expression: "sleepy", soundEvent: null },
    }
  } finally {
    setAIGenerating(false)
  }
}

// ── 为主动搭话提供便捷入口 ──

export async function sendActiveMessage(userText: string): Promise<string> {
  const result = await runAgentLoop({
    userText,
    chatMessages: getContextMessages(),
    unansweredCount: unansweredCount.value,
    isActiveMessage: true,
  })
  return result.reply
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("Agent 内核 HMR 完成")
  })
}
