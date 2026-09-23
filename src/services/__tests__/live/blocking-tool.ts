// 场景共用的「阻塞工具」：release 前不返回，用于制造真实运行中的窗口。
//
// 工具同时观察 gate signal：取消路径必须立即结束，否则 abort 要等工具结算会死锁。

import type { ToolResult } from "@/services/tool"
import { register, unregister, defineTool, TOOL_POLICY_VERSION } from "@/services/tool"

export interface BlockingToolHandle {
  /** 工具已进入执行（只在第一次调用时 resolve）。 */
  started: Promise<void>
  /** 放行所有等待中的调用。 */
  release: () => void
  /** 注销工具；场景结束或断言阶段调用。 */
  dispose: () => void
}

/** 注册一个阻塞工具（name 就是模型看到的工具名）。 */
export function registerBlockingTool(name: string): BlockingToolHandle {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let releaseAll!: () => void
  const released = new Promise<void>(resolve => { releaseAll = resolve })
  const id = `live-block-${name}`
  register(defineTool({
    id,
    name,
    description: `Live Test blocking tool ${name}`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE",
    source: "local",
    sourceId: "",
    mode: "pet",
    actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async (_params, ctx): Promise<ToolResult> => {
    markStarted()
    await new Promise<void>(resolve => {
      void released.then(resolve)
      const signal = ctx.signal
      if (signal?.aborted) resolve()
      else signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    if (ctx.signal?.aborted) return { success: false, content: "", error: "工具已取消", errorCode: "cancelled" }
    return { success: true, content: "released" }
  }))
  return { started, release: releaseAll, dispose: () => unregister(id) }
}
