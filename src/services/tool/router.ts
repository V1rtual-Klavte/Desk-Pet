// ==========================================
// 工具路由器 —— 按 source 分派到不同执行器
// Local → 直接 handler / MCP → MCP client / Skill → runner
// ==========================================

import type { ToolDef, ToolResult, ToolContext } from "./types"
import { getToolByName } from "./registry"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolRouter")

/** 执行工具调用 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = getToolByName(toolName)
  if (!tool) {
    return { success: false, content: "", error: `工具未注册: ${toolName}` }
  }

  const timeout = tool.timeoutMs ?? loopConfig.toolTimeoutMs

  try {
    log.debug("执行工具:", toolName, "| params:", JSON.stringify(params).substring(0, 100))

    const result = await withTimeout(
      tool.handler(params, ctx),
      timeout,
      `工具执行超时 (${timeout}ms): ${toolName}`,
    )

    if (result.success) {
      // 截断过长结果
      const truncated = result.content.length > 50000
        ? result.content.substring(0, 50000) + "\n...(结果已截断)"
        : result.content
      log.debug("工具完成:", toolName, "| 结果:", truncated.substring(0, 100))
      return { ...result, content: truncated }
    }

    log.warn("工具失败:", toolName, "|", result.error)
    return result
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    log.error("工具异常:", toolName, "|", errMsg)
    return { success: false, content: "", error: errMsg }
  }
}

/** 带超时的 Promise */
function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
