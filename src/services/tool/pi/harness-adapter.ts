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
import type { ToolContext, ToolDef, ToolParameters, ToolResult } from "../types"

type ToolMetadata = Pick<ToolDef, "id" | "safetyLevel" | "actionCategory">

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
  metadata: ToolMetadata,
): ToolDef {
  return {
    ...metadata,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as ToolParameters,
    prepareArguments: tool.prepareArguments as ((args: unknown) => Record<string, unknown>) | undefined,
    source: "local",
    sourceId: "pi-harness",
    mode: "pet",
    async handler(params, ctx) {
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
    },
  }
}
