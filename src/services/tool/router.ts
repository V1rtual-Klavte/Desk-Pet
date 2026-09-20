// ==========================================
// 工具路由器 —— 按 source 分派到不同执行器
// Local → 直接 handler / MCP → MCP client / Skill → runner
// ==========================================

import type { ToolDef, ToolResult, ToolContext } from "./types"
import { getToolByName } from "./registry"
import { toolPolicyHash } from "./policy"
import { acquireToolPermit, releaseToolPermit } from "./execution-permit"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

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
  const timeout = tool.policy.execution.timeoutMs ?? loopConfig.toolTimeoutMs
  const operationId = ctx.toolCallId ?? `${toolName}:${Date.now()}`
  const policyHash = ctx.policyHash ?? await toolPolicyHash(tool)
  const audit = (result: ToolResult, outcome: string): ToolResult => ({
    ...result,
    details: { ...(result.details && typeof result.details === "object" ? result.details : {}), audit: { operationId, toolName, outcome, policyHash } },
  })

  try {
    if (ctx.signal?.aborted) return audit({ success: false, content: "", error: "工具执行已取消", errorCode: "cancelled" }, "cancelled")
    log.debug("执行工具:", toolName, "| params:", JSON.stringify(params).substring(0, 100))

    // 有界执行许可：纯读共享并发上限，效果独占；delegate 交给子运行各自取（§5.1）。
    const acquisition = await acquireToolPermit(tool, ctx)
    if (acquisition.kind === "cancelled") {
      return audit({ success: false, content: "", error: "工具执行已取消", errorCode: "cancelled" }, "cancelled")
    }
    const lease = acquisition.kind === "granted" ? acquisition.lease : undefined
    // 排队不能成为绕过检查的通道：拿到额度后重新核对取消与代际。
    if (ctx.signal?.aborted || (ctx.isCurrent && !ctx.isCurrent())) {
      if (lease) await releaseToolPermit(lease)
      return audit({ success: false, content: "", error: "工具执行已取消", errorCode: "cancelled" }, "cancelled")
    }

    const controller = new AbortController()
    const abort = () => controller.abort(ctx.signal?.reason)
    ctx.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(`工具执行超时 (${timeout}ms): ${toolName}`)), timeout)
    let result: ToolResult
    try {
      // 许可挂在 handler 的真实结算上：外层超时只结束请求视图，
      // 不能因为等待超时就把仍在运行的写任务放开给下一次调用并发（§5.1）。
      const handler = (async () => {
        try {
          return await tool.handler(params, { ...ctx, signal: controller.signal })
        } finally {
          if (lease) await releaseToolPermit(lease)
        }
      })()
      handler.catch(() => { /* 超时后仍会结算；这里只避免未处理的拒绝 */ })
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
