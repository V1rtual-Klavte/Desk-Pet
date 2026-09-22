// ==========================================
// 工具策略 —— 单一构造入口、校验、身份与摘要判定
//
// 所有工具（手写 / Pi 适配 / MCP）都经 defineTool 产出同一 ToolDef；
// 注册入口再校验一次，缺策略或不一致的声明属于注册错误，不做缺省猜测。
// ==========================================

import type {
  EffectClass, ExecutionMode, HistoryCompaction, ResultProjection, ToolContext, ToolDef,
  ToolIsolation, ToolPolicy, ToolReplay, ToolResult,
} from "./types"
import { TOOL_POLICY_VERSION } from "./types"
import { sha256Text, stableSerialize } from "@/services/engine/runtime"

/** 去掉 handler 的描述部分；ToolSpec 不是第二份注册模型。 */
export type ToolSpec = Omit<ToolDef, "handler">
export type ToolHandler = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

const EFFECTS: ReadonlySet<string> = new Set<EffectClass>(["read", "local_mutation", "process", "external_side_effect"])
const MODES: ReadonlySet<string> = new Set<ExecutionMode>(["parallel", "sequential"])
const ISOLATIONS: ReadonlySet<string> = new Set<ToolIsolation>(["shared_read", "exclusive_effect", "delegate"])
const REPLAYS: ReadonlySet<string> = new Set<ToolReplay>(["never", "safe"])
const PROJECTIONS: ReadonlySet<string> = new Set<ResultProjection>(["preserve", "reference"])
const COMPACTIONS: ReadonlySet<string> = new Set<HistoryCompaction>(["summarize", "retain"])
const DECISIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny", "passthrough"])

function fail(toolId: string, reason: string): never {
  throw new Error(`工具策略不完整: ${toolId || "<未知工具>"} — ${reason}`)
}

/**
 * 校验并冻结策略。约束来自设计协议 §4.1：
 * parallel 必须是只读能力，exclusive_effect 与 delegate 必须 sequential。
 */
export function validateToolPolicy(policy: ToolPolicy | undefined, toolId: string): ToolPolicy {
  if (!policy || typeof policy !== "object") fail(toolId, "缺少 policy")
  if (policy.version !== TOOL_POLICY_VERSION) fail(toolId, `策略版本不支持: ${String(policy.version)}`)

  const { permission, execution, context } = policy
  if (!permission || !execution || !context) fail(toolId, "permission / execution / context 必须齐全")
  if (!DECISIONS.has(permission.defaultDecision)) fail(toolId, `defaultDecision 无效: ${String(permission.defaultDecision)}`)
  if (permission.check !== undefined && typeof permission.check !== "function") fail(toolId, "permission.check 必须是函数")
  if (!EFFECTS.has(execution.effect)) fail(toolId, `execution.effect 无效: ${String(execution.effect)}`)
  if (!MODES.has(execution.mode)) fail(toolId, `execution.mode 无效: ${String(execution.mode)}`)
  if (!ISOLATIONS.has(execution.isolation)) fail(toolId, `execution.isolation 无效: ${String(execution.isolation)}`)
  if (!REPLAYS.has(execution.replay)) fail(toolId, `execution.replay 无效: ${String(execution.replay)}`)
  if (execution.timeoutMs !== undefined && !(Number.isFinite(execution.timeoutMs) && execution.timeoutMs > 0)) {
    fail(toolId, `execution.timeoutMs 无效: ${String(execution.timeoutMs)}`)
  }
  if (!PROJECTIONS.has(context.resultProjection)) fail(toolId, `context.resultProjection 无效: ${String(context.resultProjection)}`)
  if (!COMPACTIONS.has(context.historyCompaction)) fail(toolId, `context.historyCompaction 无效: ${String(context.historyCompaction)}`)

  // 并行只能是经宿主确认的只读能力；独占效果与委派必须串行。
  if (execution.mode === "parallel" && (execution.effect !== "read" || execution.isolation !== "shared_read")) {
    fail(toolId, "parallel 必须同时是 read + shared_read")
  }
  if (execution.isolation !== "shared_read" && execution.mode !== "sequential") {
    fail(toolId, `${execution.isolation} 必须 sequential`)
  }

  // 已经冻结说明通过过同一份校验：保持对象身份，注册表不与调用方共享可变副本。
  if (Object.isFrozen(policy) && Object.isFrozen(permission) && Object.isFrozen(execution) && Object.isFrozen(context)) {
    return policy
  }
  return Object.freeze({
    version: policy.version,
    permission: Object.freeze({ ...permission }),
    execution: Object.freeze({ ...execution }),
    context: Object.freeze({ ...context }),
  })
}

/** 唯一构造点：校验、冻结并冻结整个描述。 */
export function defineTool(spec: ToolSpec, handler: ToolHandler): ToolDef {
  const policy = validateToolPolicy(spec.policy, spec.id)
  return Object.freeze({ ...spec, policy, handler })
}

/**
 * 策略身份串（不含函数与运行时配置）。
 *
 * 函数不能靠 JSON 序列化形成身份，因此用显式字段与规则版本关联：
 * 策略、风险等级或阶段类别变化后，旧的会话授权不再复用。
 */
export function toolPolicyFingerprint(tool: ToolDef): string {
  const { policy } = tool
  return stableSerialize({
    toolId: tool.id,
    source: tool.source,
    sourceId: tool.sourceId,
    mode: tool.mode,
    policyVersion: policy.version,
    defaultDecision: policy.permission.defaultDecision,
    hasCheck: policy.permission.check !== undefined,
    effect: policy.execution.effect,
    executionMode: policy.execution.mode,
    isolation: policy.execution.isolation,
    replay: policy.execution.replay,
    resultProjection: policy.context.resultProjection,
    historyCompaction: policy.context.historyCompaction,
    safetyLevel: tool.safetyLevel,
    actionCategory: tool.actionCategory,
  })
}

/** 审计与运行上下文共用的策略 hash；只有一个实现。 */
export async function toolPolicyHash(tool: ToolDef): Promise<string> {
  return sha256Text(toolPolicyFingerprint(tool))
}

/** 声明了 historyCompaction=retain 的工具名集合。 */
export function retainedToolNames(tools: readonly ToolDef[]): Set<string> {
  return new Set(tools.filter(tool => tool.policy.context.historyCompaction === "retain").map(tool => tool.name))
}

/** 声明了 resultProjection=preserve 的工具名集合：结果在请求与摘要素材里都不得二次缩短。 */
export function preservedToolNames(tools: readonly ToolDef[]): Set<string> {
  return new Set(tools.filter(tool => tool.policy.context.resultProjection === "preserve").map(tool => tool.name))
}

/** 摘要范围里出现过的工具名（toolResult 消息与 assistant 的 toolCall 块）。 */
interface PolicyMessageLike {
  role: string
  toolName?: string
  content?: unknown
}

/**
 * 找出被摘要范围覆盖的 retain 工具调用。
 *
 * 连续完整轮 checkpoint 下，retain 轮次不能落在覆盖边界内；
 * 命中即不能推进边界，调用方必须 decline 或明确报告上下文不足。
 */
export function findRetainedToolCall(
  messages: readonly PolicyMessageLike[],
  retained: ReadonlySet<string>,
): string | undefined {
  if (retained.size === 0) return undefined
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolName === "string" && retained.has(message.toolName)) {
      return message.toolName
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue
      const block = part as { type?: unknown; name?: unknown }
      if (block.type === "toolCall" && typeof block.name === "string" && retained.has(block.name)) {
        return block.name
      }
    }
  }
  return undefined
}
