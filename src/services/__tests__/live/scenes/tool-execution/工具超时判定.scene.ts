import type { SceneDef } from "../../types"
import type { ToolResult } from "@/services/tool"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { executeToolDefinition } from "@/services/tool/router"

/**
 * 超时与取消的账只有一份判定顺序：超时（定时器置位，同时会 abort）→ 取消（外部 signal）→ error。
 *
 * 旧实现有两个定时器，且 catch 里靠文案匹配（`errMsg.includes("超时")`）分超时：探针在超时后
 * 按取消收场（返回 `errorCode: "cancelled"`）时，这条账会被记成取消。这里用同一个工具钉两条账：
 * 定时器到点记 timeout，外部已取消的 signal 记 cancelled —— 两者不得互换。
 */
const ID = "live-timeout-probe"
const NAME = "live_timeout_probe"

const probe = defineTool({
  id: ID, name: NAME, description: "超时判定探针",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "process", isolation: "exclusive_effect", replay: "never", timeoutMs: 50 },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (_params, ctx) => {
  // 只等 abort（超时由 router 的定时器触发）：等待必须立刻结束，否则结算会挂住场景。
  await new Promise<void>(resolve => {
    if (ctx.signal?.aborted) resolve()
    else ctx.signal?.addEventListener("abort", () => resolve(), { once: true })
  })
  return { success: false, content: "", error: "工具已取消", errorCode: "cancelled" }
})

/** 取该次调用的审计账；形状不对时直接抛错，避免断言读到 undefined 也算过。 */
function auditOf(result: ToolResult): { operationId?: unknown; outcome?: unknown } {
  const details = result.details
  if (!details || typeof details !== "object" || !("audit" in details)) throw new Error("工具结果缺少审计账")
  return (details as { audit: { operationId?: unknown; outcome?: unknown } }).audit
}

export const 工具超时判定: SceneDef = {
  meta: {
    caseId: "tool-timeout-outcome-single", module: "tool-execution", contractId: "te-10",
    description: "超时与取消的判定顺序唯一：定时器到点记 timeout，外部取消记 cancelled，判定不靠错误文案",
    depth: "shallow", suite: "safety", entry: "unit", tags: ["tool-execution", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "同一探针在超时与取消下的两条账",
    userText: "检查工具超时判定。",
    checks: [{
      type: "expectTimeoutOutcome",
      run: async () => {
        register(probe)
        try {
          // ① 50ms 超时：调用失败，账记 timeout —— 探针自己返回的 cancelled 错误码不改写这条账。
          const timedOut = await executeToolDefinition(probe, {}, { toolCallId: "timeout-probe" })
          const timeoutAudit = auditOf(timedOut)
          if (timedOut.success) throw new Error("超时的调用被判成功")
          if (timeoutAudit.outcome !== "timeout") throw new Error(`超时的账不是 timeout: ${String(timeoutAudit.outcome)}`)
          if (timedOut.errorCode !== "timeout") throw new Error(`超时的错误码不是 timeout: ${String(timedOut.errorCode)}`)

          // ② 一次调用只有一条审计：operationId 是本条调用的，账是终局判定（不是 cancelled）。
          if (timeoutAudit.operationId !== "timeout-probe") {
            throw new Error(`审计 operationId 不是本次调用: ${String(timeoutAudit.operationId)}`)
          }

          // ③ 外部已取消的 signal：账记 cancelled，取消不得被判成超时。
          const controller = new AbortController()
          controller.abort()
          const cancelled = await executeToolDefinition(probe, {}, { toolCallId: "cancelled-probe", signal: controller.signal })
          const cancelledAudit = auditOf(cancelled)
          if (cancelledAudit.outcome !== "cancelled") throw new Error(`取消的账不是 cancelled: ${String(cancelledAudit.outcome)}`)
          if (cancelledAudit.operationId !== "cancelled-probe") throw new Error("取消的审计 operationId 不是本次调用")
          if (cancelled.errorCode !== "cancelled") throw new Error(`取消的错误码不是 cancelled: ${String(cancelled.errorCode)}`)
        } finally {
          unregister(ID)
        }
      },
    }],
  }],
}

export default 工具超时判定
