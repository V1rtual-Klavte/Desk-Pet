// Pi 原生工具（read/write/edit/bash）→ ToolDef 的唯一工厂。
//
// 策略由调用方显式声明：适配器不推导权限、不补并行资格，也不带缺省值。
// 权限终裁不在这里：before_tool 钩子（runtime 侧）负责 PermissionKernel / 次数上限，
// handler 只执行已放行的工具。

import {
  TODO_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core"
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  AgentToolResult,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core"
import type {
  ActionCategory, LightweightPolicy, SafetyLevel, ToolContext, ToolDef, ToolParameters, ToolPolicy, ToolResult,
} from "../types"
import { defineTool } from "../policy"

/** Pi 工具需要的声明：风险与阶段类别留在 ToolDef 顶层，完整策略单独传。 */
export interface HarnessToolMetadata {
  id: string
  safetyLevel: SafetyLevel
  actionCategory: ActionCategory
  policy: ToolPolicy
  resolveSafetyLevel?: ToolDef["resolveSafetyLevel"]
  lightweightPolicy?: LightweightPolicy
}

function toToolResult(result: AgentToolResult<unknown>): ToolResult {
  const contentParts = result.content.map(part => part.type === "text"
    ? { type: "text" as const, text: part.text }
    : { type: "image" as const, data: part.data, mimeType: part.mimeType })
  return {
    success: true,
    content: contentParts.filter(part => part.type === "text").map(part => part.text).join("\n"),
    contentParts,
    details: result.details,
  }
}

function invocation(toolCallId: string): AgentHarnessToolInvocation {
  return {
    invocationId: toolCallId,
    operationId: toolCallId,
    turnId: toolCallId,
    async getMemo() { return undefined },
    async setMemo() {},
  }
}

export function adaptHarnessTool(
  tool: AgentHarnessTool<{ env: ExecutionEnv }>,
  createEnv: (context: ToolContext) => ExecutionEnv,
  metadata: HarnessToolMetadata,
): ToolDef {
  return defineTool({
    id: metadata.id,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as ToolParameters,
    prepareArguments: tool.prepareArguments as ((args: unknown) => Record<string, unknown>) | undefined,
    source: "local",
    sourceId: "pi-harness",
    mode: "pet",
    safetyLevel: metadata.safetyLevel,
    actionCategory: metadata.actionCategory,
    resolveSafetyLevel: metadata.resolveSafetyLevel,
    lightweightPolicy: metadata.lightweightPolicy,
    policy: metadata.policy,
  }, async (params, ctx) => {
    const toolCallId = ctx.toolCallId ?? crypto.randomUUID()
    const context = ctx.signal ? withAbortSignal(ctx.signal, TODO_CONTEXT) : TODO_CONTEXT
    const result = await tool.execute(
      toolCallId,
      params,
      partial => ctx.onUpdate?.(toToolResult(partial)),
      { env: createEnv(ctx) },
      invocation(toolCallId),
      context,
    )
    return toToolResult(result)
  })
}
