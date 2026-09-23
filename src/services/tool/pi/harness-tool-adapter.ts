// Desk-Pet ToolDef → AgentHarnessTool 适配器（H-2 运行内核替换）。
//
// 权限终裁不在这里：before_tool 钩子（runtime 侧）负责 PermissionKernel / 次数上限，
// execute 只执行已放行的工具；工具结果映射与失败语义由本适配器统一表达。

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core"
import type { ToolDef } from "../types"
import { executeToolDefinition } from "../router"
import { toolPolicyHash } from "../policy"
import { getSimpleStage } from "@/services/personality/stages-cache"

/** 一次工具调用所属回合的执行上下文；主回合与子代理共用。 */
export interface HarnessToolRun {
  mode: "pet" | "assistant"
  sessionId?: string
  runGeneration?: number
  /** 当前回合仍是代际所有者且未取消。 */
  isCurrent: () => boolean
  /** 回合级工具调用历史（返回给 UI/报告）。 */
  history: { toolName: string; status: string; personalityMsg?: string }[]
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
}

/** 把冻结的工具集转成 Harness 原生工具数组；每次 run 前用 setTools 注入。 */
export function toAgentHarnessTools(tools: readonly ToolDef[], run: HarnessToolRun): AgentHarnessTool<undefined>[] {
  return tools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // Pi validates plain JSON Schema too; Desk-Pet's schemas are already that subset.
    parameters: tool.parameters as never,
    prepareArguments: tool.prepareArguments,
    // 逐工具调度声明不再下发：批次调度只看 run 级 `toolExecution`，
    // 互斥由 `execution.isolation` + Rust `can_admit` 保证；重放资格仍来自策略声明。
    replay: tool.policy.execution.replay,
    async execute(toolCallId, params, onUpdate, _toolContext, invocation, context) {
      await run.onToolStart?.(tool.name, toolCallId)
      let toolSucceeded = false
      let result: Awaited<ReturnType<typeof executeToolDefinition>>
      try {
        result = await executeToolDefinition(tool, params as Record<string, unknown>, {
          mode: run.mode,
          sessionId: run.sessionId,
          runGeneration: run.runGeneration,
          isCurrent: run.isCurrent,
          toolCallId,
          operationId: invocation.invocationId,
          policyHash: await toolPolicyHash(tool),
          // Harness 的 gate signal 映射进现 handler 的 ToolContext.signal。
          signal: context.abortSignal,
          onUpdate: partial => onUpdate?.({
            content: partial.contentParts ?? [{ type: "text", text: partial.content }],
            details: partial.details,
          }),
        })
        toolSucceeded = result.success
      } finally {
        await run.onToolDone?.(tool.name, toolCallId, toolSucceeded)
      }
      if (result.success) {
        run.history.push({ toolName: tool.name, status: "done" })
        return {
          content: result.contentParts ?? [{ type: "text", text: result.content }],
          // deskpetEntryId 是工具结果的持久条目 id（invocationId 与保留的结果条目 id 相同），
          // transform_context 用它给被缩短的结果标注可回读地址。
          details: { ...(result.details && typeof result.details === "object" ? result.details : {}), deskpetEntryId: invocation.invocationId },
        }
      }
      run.history.push({ toolName: tool.name, status: "error" })
      throw new Error(`${getSimpleStage("error") ?? "Error"}: ${result.error ?? "工具执行失败"}`)
    },
  }))
}
