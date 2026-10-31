// V1rtual-Desk-Pet ToolDef → AgentHarnessTool 适配器（H-2 运行内核替换）。
//
// 权限终裁不在这里：before_tool 钩子（runtime 侧）负责 PermissionKernel / 次数上限，
// execute 只执行已放行的工具；工具结果映射与失败语义由本适配器统一表达。

import type { AgentHarnessTool, JsonValue } from "@earendil-works/pi-agent-core"
import type { TaskToolAuthorization, ToolDef } from "../types"
import { executeToolDefinition } from "../router"
import { toolPolicyHash } from "../policy"
import { createLogger } from "@/services/logger"

const log = createLogger("HarnessTool")

/** 适配器写入、槽的 after_tool 读取：保留失败语义，避免 SDK 的 throw 丢失结构化归宿。 */
type HarnessToolOutcome = "success" | "failure" | "user_cancelled"
export function readHarnessToolOutcome(details: unknown): HarnessToolOutcome | undefined {
  if (!details || typeof details !== "object") return undefined
  const outcome = (details as Record<string, unknown>).deskpetToolOutcome
  return outcome === "success" || outcome === "failure" || outcome === "user_cancelled" ? outcome : undefined
}

/** 只桥接 SDK throw 丢弃的元数据；原生成败仍由 SDK 的错误结果承载，消费后立即移除。 */
export function takeHarnessToolFailureDetails(run: HarnessToolRun, toolCallId: string): JsonValue | undefined {
  const details = run.pendingFailures.get(toolCallId)
  run.pendingFailures.delete(toolCallId)
  return details
}

/** 一次工具调用所属回合的执行上下文；主回合与子代理共用。 */
export interface HarnessToolRun {
  sessionId?: string
  runGeneration?: number
  trustedUserEventId?: string
  /** 本次可信用户输入的正文（宿主提供；主动消息与子运行不注入）。 */
  trustedUserText?: string
  taskAuthorization?: TaskToolAuthorization
  permissionMode?: "interactive" | "background"
  proactiveTurnContext?: import("@/services/proactive").ProactiveTurnContext
  /** 当前回合仍是代际所有者且未取消。 */
  isCurrent: () => boolean
  /** 回合级工具调用历史（返回给 UI/报告）。 */
  history: { toolName: string; status: string; personalityMsg?: string }[]
  /** execute → after_tool 的一次性元数据桥；不落独立存储、不参与答案或工作验收。 */
  pendingFailures: Map<string, Record<string, JsonValue>>
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
}

/** 把冻结的工具集转成 Harness 原生工具数组；每次 run 前用 setTools 注入。 */
export function toAgentHarnessTools(tools: readonly ToolDef[], run: HarnessToolRun): AgentHarnessTool<undefined>[] {
  // 渐进披露的兜底过滤面：Pi 在下一次 generation 校验 activeToolNames ⊆ setTools，
  // 名单外的名字会直接 configuration_failure 把整条运行带崩 —— 到这里为止只认本回合冻结集。
  const frozenNames = new Set(tools.map(tool => tool.name))
  return tools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // Pi validates plain JSON Schema too; V1rtual-Desk-Pet's schemas are already that subset.
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
          sessionId: run.sessionId,
          runGeneration: run.runGeneration,
          ...(run.trustedUserEventId ? { trustedUserEventId: run.trustedUserEventId } : {}),
          ...(run.trustedUserText ? { trustedUserText: run.trustedUserText } : {}),
          ...(run.taskAuthorization ? { taskAuthorization: run.taskAuthorization } : {}),
          ...(run.permissionMode ? { permissionMode: run.permissionMode } : {}),
          ...(run.proactiveTurnContext ? { proactiveTurnContext: run.proactiveTurnContext } : {}),
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
        // 渐进披露（enable_tools）：结果随附的工具名交给 Pi 的 addedToolNames，
        // 在工具批次落盘时并入本回合激活集。名单外的名字在这里拒绝并留痕（不静默）。
        const added = result.addedToolNames?.filter(name => {
          if (frozenNames.has(name)) return true
          log.warn("工具声明了本回合工具集之外的 addedToolNames，已忽略:", { tool: tool.name, name })
          return false
        })
        return {
          content: result.contentParts ?? [{ type: "text", text: result.content }],
          // deskpetEntryId 是工具结果的持久条目 id（invocationId 与保留的结果条目 id 相同），
          // transform_context 用它给被缩短的结果标注可回读地址。
          details: { ...(result.details && typeof result.details === "object" ? result.details : {}),
            deskpetEntryId: invocation.invocationId, deskpetToolOutcome: "success" },
          ...(added && added.length ? { addedToolNames: added } : {}),
        }
      }
      run.history.push({ toolName: tool.name, status: "error" })
      // 原生 throw 保证中止/钩子异常窗口仍是 isError=true；结构化原因由回合上下文
      // 一次性桥接到 after_tool，随后随同一条工具结果落盘，不从错误文案猜测取消归宿。
      const diagnostic = result.contentParts?.filter(part => part.type === "text").map(part => part.text).join("\n")
        || result.content
      run.pendingFailures.set(toolCallId, {
        ...(result.details && typeof result.details === "object" ? result.details as Record<string, JsonValue> : {}),
        // 失败结果不写回读地址：上游只用错误正文，错误分支带地址会违反记忆契约 mm-27。
        deskpetToolOutcome: result.errorCode === "user_cancelled" ? "user_cancelled" : "failure",
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      })
      throw new Error([`工具 ${tool.name} 失败：${result.error ?? "工具执行失败"}`, diagnostic]
        .filter(text => text.trim().length > 0).join("\n"))
    },
  }))
}
