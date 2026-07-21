// ==========================================
// 子代理轻量循环 —— fork/team 子 Agent 的执行引擎
// 不依赖人格中间件/思考强度/会话管理，精简高效
// ==========================================

import type { Message, ToolDeclaration, ToolCallRequest } from "@/services/agent/types"
import { createMessageId, createToolMessage } from "@/services/agent/types"
import { executeTool } from "@/services/tool/router"
import { getToolByName } from "@/services/tool/registry"
import { checkSafety } from "@/services/safety"
import { toToolDeclaration } from "@/services/tool/types"
import type { ToolDef } from "@/services/tool/types"
import { loopConfig } from "@/services/config"
import { getSimpleStage, getStagePrompt, getFallbackReply } from "@/services/personality/stages-cache"
import { createLogger } from "@/services/logger"

const log = createLogger("SubLoop")

export interface SubLoopInput {
  /** 用户任务描述 */
  task: string
  /** 可用工具列表 */
  tools: ToolDef[]
  /** System prompt（子代理人格/角色提示） */
  systemPrompt: string
  /** 最大工具调用轮数 */
  maxRounds?: number
  /** 总超时 ms */
  timeoutMs?: number
}

export interface SubLoopOutput {
  /** 最终回复文本 */
  reply: string
  /** 工具调用次数 */
  toolCallsMade: number
  /** 是否成功 */
  success: boolean
  error?: string
}

/**
 * 运行子代理循环。
 * 与主 Agent Loop 的区别：
 *  - 无人格中间件、无思考强度决策、无 Plan、无会话记录
 *  - 工具安全仍走统一入口
 *  - 支持多轮工具调用
 */
export async function runSubLoop(input: SubLoopInput): Promise<SubLoopOutput> {
  const { task, tools, systemPrompt, maxRounds = 3, timeoutMs = 60000 } = input
  const startTime = Date.now()

  const messages: Message[] = [
    { id: createMessageId(), role: "user", text: task, timestamp: Date.now() },
  ]

  const toolDeclarations: ToolDeclaration[] = tools.map(toToolDeclaration)
  let roundCount = 0
  let finalReply = ""
  let errorMsg: string | undefined

  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()

    while (roundCount < maxRounds) {
      if (Date.now() - startTime > timeoutMs) {
        errorMsg = "子代理执行超时"
        break
      }

      roundCount++

      const response = await provider.generateReply({
        messages,
        systemPrompt,
        tools: toolDeclarations.length > 0 ? toolDeclarations : undefined,
        thinkingEffort: "low", // 子代理用低强度省 token
      })

      const { text, toolCalls, thinking } = response

      // 无工具调用 → 最终回复
      if (toolCalls.length === 0) {
        finalReply = text
        break
      }

      log.debug("子代理工具调用:", toolCalls.map((t: ToolCallRequest) => t.name).join(", "))

      // 记录 assistant 消息
      messages.push({
        id: createMessageId(),
        role: "assistant",
        text: text || "",
        toolCalls,
        thinking,
        timestamp: Date.now(),
      })

      // 执行每个工具调用
      for (const tc of toolCalls) {
        const params = parseArgs(tc.arguments)
        const tool = getToolByName(tc.name)

        if (!tool) {
          const errPrefix = getSimpleStage("error") ?? "Error"
          messages.push(createToolMessage(tc.id,
            JSON.stringify({ toolCallId: tc.id, content: "", error: `${errPrefix}: 工具 ${tc.name} 不可用` })))
          continue
        }

        // 安全检查
        const safety = checkSafety(tool, params, { mode: "pet", sessionTrusted: false })
        if (!safety.allowed) {
          const cat = tool?.actionCategory ?? "_default"
          const blockedMsg = safety.personalityMessage ?? getStagePrompt("blocked", cat) ?? "操作被拦截"
          messages.push(createToolMessage(tc.id,
            JSON.stringify({ toolCallId: tc.id, content: "", error: blockedMsg })))
          continue
        }

        // 执行工具
        const result = await executeTool(tc.name, params, { mode: "pet", sessionTrusted: false })
        const errPrefix = getSimpleStage("error") ?? "Error"
        const toolResult = result.success
          ? result.content
          : `${errPrefix}: ${result.error}`
        messages.push(createToolMessage(tc.id, toolResult))
      }
    }

    // 循环结束但无最终回复 → 强制请求总结
    if (!finalReply && !errorMsg) {
      try {
        const summaryResp = await provider.generateReply({
          messages,
          systemPrompt: systemPrompt + "\n\n请基于以上工具执行结果，用简短中文总结。",
          thinkingEffort: "low",
        })
        finalReply = summaryResp.text || getFallbackReply("subAgentDone")
      } catch {
        finalReply = getFallbackReply("subAgentFailed")
      }
    }
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e)
    log.error("子代理循环异常:", errorMsg)
  }

  return {
    reply: errorMsg ? `子代理出错: ${errorMsg}` : finalReply || getFallbackReply("subAgentNoResult"),
    toolCallsMade: roundCount,
    success: !errorMsg,
    error: errorMsg,
  }
}

function parseArgs(args: string): Record<string, unknown> {
  try { return JSON.parse(args) } catch { return {} }
}
