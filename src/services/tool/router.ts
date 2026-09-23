// ==========================================
// 工具路由器 —— 按 source 分派到不同执行器
// Local → 直接 handler / MCP → MCP client / Skill → runner
// ==========================================

import type { ToolDef, ToolResult, ToolContext } from "./types"
import { getToolHandler, toolPolicyHash } from "./policy"
import { acquireToolPermit, releaseToolPermit } from "./execution-permit"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolRouter")

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

  // 执行体只在 defineTool 的 WeakMap 里；取不到就是未经唯一构造入口的定义（注册入口已拦一层）。
  const handler = getToolHandler(tool)
  if (!handler) {
    log.error("工具没有执行体:", toolName)
    return audit({ success: false, content: "", error: `工具没有执行体: ${toolName}`, errorCode: "failed" }, "error")
  }

  // 超时由本函数的定时器置位：判定不靠错误文案，也不与取消混淆。
  let timedOut = false

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
    let result: ToolResult
    try {
      // 许可挂在 handler 的真实结算上：外层超时只结束请求视图，
      // 不能因为等待超时就把仍在运行的写任务放开给下一次调用并发（§5.1）。
      const settlement = (async () => {
        try {
          return await handler(params, { ...ctx, signal: controller.signal })
        } finally {
          if (lease) await releaseToolPermit(lease)
        }
      })()
      settlement.catch(error => log.error("工具结算失败（超时后仍会结算）:", toolName, formatError(error)))
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          controller.abort(new Error(`工具执行超时 (${timeout}ms): ${toolName}`))
          reject(new Error(`工具执行超时 (${timeout}ms): ${toolName}`))
        }, timeout)
      })
      try {
        result = await Promise.race([settlement, timeoutPromise])
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    } finally {
      ctx.signal?.removeEventListener("abort", abort)
    }

    if (result.success) {
      // 结果不在 router 里被裁：条目存全文，缩短只发生在请求层 L0（`context/tool-output.ts`），
      // 且那里带 eventId 回读地址。
      log.debug("工具完成:", toolName, "| 结果:", result.content.substring(0, 100))
      return audit(result, "success")
    }

    log.warn("工具失败:", toolName, "|", result.error)
    return audit(result, "failed")
  } catch (e) {
    const errMsg = formatError(e)
    log.error("工具异常:", toolName, "|", errMsg)
    // 判定顺序唯一：超时（定时器置位，同时会 abort）→ 取消（外部 signal）→ error。
    const outcome = timedOut ? "timeout" : ctx.signal?.aborted ? "cancelled" : "error"
    return audit({ success: false, content: "", error: errMsg, errorCode: outcome === "cancelled" ? "cancelled" : outcome === "timeout" ? "timeout" : "failed" }, outcome)
  }
}
