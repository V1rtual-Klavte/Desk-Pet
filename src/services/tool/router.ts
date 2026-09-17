// ==========================================
// 工具路由器 —— 按 source 分派到不同执行器
// Local → 直接 handler / MCP → MCP client / Skill → runner
// ==========================================

import type { ToolDef, ToolResult, ToolContext } from "./types"
import { getToolByName } from "./registry"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { sha256Text, stableSerialize } from "@/services/engine/runtime"

const log = createLogger("ToolRouter")

/** 单个工具结果内联给模型的字符预算。 */
const MAX_INLINE_CHARS = 50000
const INLINE_TRUNCATION_NOTICE = "\n...(结果已截断)"

/**
 * 把工具结果压进内联预算。
 *
 * 必须同时处理 `contentParts` 的文本块：Pi 工具总是带 contentParts，
 * 而下游取的是 `contentParts ?? [{ text: content }]`，只截 content 等于没截。
 * 图片块不走字符预算 —— 那是 base64，按字符裁会直接破坏数据。
 */
function boundInlineOutput(result: ToolResult): ToolResult {
  const bounded = (text: string): string =>
    text.length > MAX_INLINE_CHARS ? text.substring(0, MAX_INLINE_CHARS) + INLINE_TRUNCATION_NOTICE : text
  const contentParts = result.contentParts?.map(part =>
    part.type === "text" ? { ...part, text: bounded(part.text) } : part,
  )
  return { ...result, content: bounded(result.content), ...(contentParts ? { contentParts } : {}) }
}

/** 执行工具调用 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = getToolByName(toolName)
  if (!tool) {
    return { success: false, content: "", error: `工具未注册: ${toolName}`, errorCode: "not_found" }
  }

  return executeToolDefinition(tool, params, ctx)
}

/** Execute the immutable definition selected for this run, even when settings change. */
export async function executeToolDefinition(tool: ToolDef, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const toolName = tool.name
  const timeout = tool.timeoutMs ?? loopConfig.toolTimeoutMs
  const operationId = ctx.toolCallId ?? `${toolName}:${Date.now()}`
  const policyHash = await sha256Text(stableSerialize({ actionCategory: tool.actionCategory, safetyLevel: tool.safetyLevel }))
  const audit = (result: ToolResult, outcome: string): ToolResult => ({
    ...result,
    details: { ...(result.details && typeof result.details === "object" ? result.details : {}), audit: { operationId, toolName, outcome, policyHash } },
  })

  try {
    if (ctx.signal?.aborted) return audit({ success: false, content: "", error: "工具执行已取消", errorCode: "cancelled" }, "cancelled")
    log.debug("执行工具:", toolName, "| params:", JSON.stringify(params).substring(0, 100))

    const controller = new AbortController()
    const abort = () => controller.abort(ctx.signal?.reason)
    ctx.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(`工具执行超时 (${timeout}ms): ${toolName}`)), timeout)
    let result: ToolResult
    try {
      const handler = tool.handler(params, { ...ctx, signal: controller.signal })
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort(new Error(`工具执行超时 (${timeout}ms): ${toolName}`))
          reject(new Error(`工具执行超时 (${timeout}ms): ${toolName}`))
        }, timeout)
      })
      try {
        result = await Promise.race([handler, timeoutPromise])
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    } finally {
      clearTimeout(timer)
      ctx.signal?.removeEventListener("abort", abort)
    }

    if (result.success) {
      const bounded = boundInlineOutput(result)
      log.debug("工具完成:", toolName, "| 结果:", bounded.content.substring(0, 100))
      return audit(bounded, "success")
    }

    log.warn("工具失败:", toolName, "|", result.error)
    return audit(result, "failed")
  } catch (e) {
    const errMsg = formatError(e)
    log.error("工具异常:", toolName, "|", errMsg)
    const outcome = ctx.signal?.aborted ? "cancelled" : errMsg.includes("超时") ? "timeout" : "error"
    return audit({ success: false, content: "", error: errMsg, errorCode: outcome === "cancelled" ? "cancelled" : outcome === "timeout" ? "timeout" : "failed" }, outcome)
  }
}
