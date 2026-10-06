// ==========================================
// 工具路由器 —— 按 source 分派到不同执行器
// Local → 直接 handler / MCP → MCP client / Skill → runner
// ==========================================

import type { ToolDef, ToolResult, ToolContext } from "./types"
import { getToolHandler, toolPolicyHash } from "./policy"
import { acquireToolPermit, releaseToolPermit } from "./execution-permit"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
// 用户等待的预算豁免（零依赖叶子）：等待期间挂起本工具的超时计时器，见下方执行段注释。
import { createPausableDeadline, isUserWaiting, subscribeUserWait } from "@/services/engine/user-wait"

const log = createLogger("ToolRouter")

/** Execute the immutable definition selected for this run, even when settings change. */
export async function executeToolDefinition(tool: ToolDef, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const toolName = tool.name
  // 未声明取全局档；`null` 是**显式声明**的「本计时器不设执行超时」（等用户做决定的交互工具，
  // 或死线由执行端承载、到点转后台的工具 —— 见 `ToolPolicy.execution.timeoutMs`）——
  // 不能用 `??`：那会把 null 当成缺省。
  const declaredTimeout = tool.policy.execution.timeoutMs
  const timeout = declaredTimeout === undefined ? loopConfig.toolTimeoutMs : declaredTimeout
  const operationId = ctx.toolCallId ?? `${toolName}:${Date.now()}`
  const policyHash = ctx.policyHash ?? await toolPolicyHash(tool)
  const startedAt = Date.now()
  // 审计带时间：耗时 + 本次生效预算（null = 本计时器不管）。超时归因（「真超时还是别的」）
  // 从这里与失败日志一起可查，不再只有结局名。
  const audit = (result: ToolResult, outcome: string): ToolResult => ({
    ...result,
    details: { ...(result.details && typeof result.details === "object" ? result.details : {}), audit: { operationId, toolName, outcome, policyHash, timeoutMs: timeout, elapsedMs: Date.now() - startedAt } },
  })
  // 超时只是结束「请求视图」；底层结算（settlement）可能仍在跑并晚到（bash 转后台、
  // MCP 取消确认等）。晚到的成功不会被采用，但要留痕 —— 否则「超时后到底完成了没有」
  // 又是一条答不上来的问题（见 tool-timeout-audit.md §5.2）。
  let settlement: Promise<ToolResult> | undefined

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
      settlement = (async () => {
        try {
          return await handler(params, { ...ctx, signal: controller.signal })
        } finally {
          if (lease) await releaseToolPermit(lease)
        }
      })()
      settlement.catch(error => log.error("工具结算失败（超时后仍会结算）:", toolName, formatError(error)))
      if (timeout === null) {
        // 显式不设执行超时（等用户做决定的工具）：归宿只来自用户动作 / 取消信号 /
        // 会话生命周期；外层兜底是回合墙钟（等待期同样被豁免）。
        result = await settlement
      } else {
        let rejectTimeout: ((error: Error) => void) | undefined
        const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
        // 用户等待豁免（与回合墙钟同一实现）：等待期间挂起计时器，结束后按剩余预算续算 ——
        // 用户在决策面板上思考的时间不算本工具的执行时间，不被倒计时打断
        // （2026-10-06 用户裁决：选择类弹窗不留超时，包括被外层预算包着的这段等待）。
        const deadline = createPausableDeadline(() => {
          timedOut = true
          const error = new Error(`工具执行超时 (${timeout}ms): ${toolName}`)
          controller.abort(error)
          rejectTimeout?.(error)
        })
        let unsubscribeWait: (() => void) | undefined
        if (ctx.sessionId) {
          unsubscribeWait = subscribeUserWait(ctx.sessionId, waiting => {
            if (waiting) deadline.hold()
            else deadline.resume()
          })
        }
        deadline.start(timeout)
        // 工具起表时该会话可能已在等待（同批次的另一个工具正开着面板）：以挂起态起步。
        if (ctx.sessionId && isUserWaiting(ctx.sessionId)) deadline.hold()
        try {
          result = await Promise.race([settlement, timeoutPromise])
        } finally {
          unsubscribeWait?.()
          deadline.cancel()
        }
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

    log.warn("工具失败:", toolName, "| 耗时:", Date.now() - startedAt, "ms | 预算:", timeout, "ms |", result.error)
    return audit(result, "failed")
  } catch (e) {
    const errMsg = formatError(e)
    log.error("工具异常:", toolName, "| 耗时:", Date.now() - startedAt, "ms | 预算:", timeout, "ms |", errMsg)
    if (timedOut && settlement) {
      // 超时后底层仍可能完成结算：成功的晚到结果不会被采用，但要留痕（拒绝路径已由
      // 上面的 settlement.catch 留痕，这里只补成功一侧，不重复报）。
      void settlement.then(
        late => log.warn("工具在超时后仍完成结算（结果未被采用）:", toolName, "| 耗时:", Date.now() - startedAt, "ms | success:", late.success),
        () => {},
      )
    }
    // 下游执行端自带的超时（如 bash 转后台：执行端返回的 ExecutionError code=timeout 经
    // Pi 工具以 `cause` 挂在抛出的 Error 上）也要归类为 timeout —— 否则审计里它与普通失败
    // 无法区分（tool-timeout-audit.md §5）。读取 `cause` 对其它错误是安全 no-op。
    const downstreamTimeout = !timedOut && !ctx.signal?.aborted && errorCode((e as { cause?: unknown } | null)?.cause) === "timeout"
    // 判定顺序唯一：本计时器超时（定时器置位，同时会 abort）→ 取消（外部 signal）→
    // 下游超时（执行端结算）→ error。
    const outcome = timedOut || downstreamTimeout ? "timeout" : ctx.signal?.aborted ? "cancelled" : "error"
    return audit({ success: false, content: "", error: errMsg, errorCode: outcome === "cancelled" ? "cancelled" : outcome === "timeout" ? "timeout" : "failed" }, outcome)
  }
}
