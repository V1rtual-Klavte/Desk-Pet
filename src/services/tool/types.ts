// ==========================================
// ToolDef 类型定义 —— 工具系统统一接口
// ==========================================

/** 安全级别 */
export type SafetyLevel = "SAFE" | "NORMAL" | "DANGER" | "NOWAY"

/** 工具来源 */
export type ToolSource = "local" | "mcp"

/** 模式限制 */
export type ToolMode = "pet" | "assistant"

/** 轻量模式对 DANGER 能力的策略：`allow` 与「未声明即拒绝」是同一件事的两写，已收敛掉。 */
export type LightweightPolicy = "confirm" | "deny"

/** PermissionKernel 的最终裁决；passthrough 只允许规则层内部使用。 */
export type PermissionDecision = "allow" | "ask" | "deny"

/** 操作效果分类，风险等级描述影响程度，效果分类描述影响对象。 */
export type EffectClass = "read" | "local_mutation" | "process" | "external_side_effect"

// ── 工具策略（统一声明：权限 / 执行 / 投影 / 摘要）──

/**
 * 策略语义版本。策略字段含义变化时递增；恢复旧调用时按低版本保守读取，
 * 版本进入 policyHash，策略变化后旧授权失效。
 */
export const TOOL_POLICY_VERSION = 1

/**
 * 隔离级别。delegate 只用于宿主编排工具（子运行自己取许可）；
 * exclusive_effect 与其他执行互斥。
 */
export type ToolIsolation = "shared_read" | "exclusive_effect" | "delegate"

/** 副作用未知时的恢复重放资格；safe 不自动启用重试，由 Harness 恢复路径判定。 */
export type ToolReplay = "never" | "safe"

/** 请求视图投影：preserve 表示源结果按原样进入请求，不再被 L0 二次缩短。 */
export type ResultProjection = "preserve" | "reference"

/** 历史摘要：retain 表示该调用配对必须保留原文，压缩边界不得越过它。 */
export type HistoryCompaction = "summarize" | "retain"

/**
 * 工具完整策略。风险等级（safetyLevel / resolveSafetyLevel）与轻量模式策略
 * （lightweightPolicy）继续留在 ToolDef 顶层：那是风险维度，不是权限意见。
 */
export interface ToolPolicy {
  version: number
  permission: {
    /** 工具侧静态意见。passthrough 不是执行许可，必须由 PermissionKernel 收敛。 */
    defaultDecision: PermissionDecision | "passthrough"
  }
  execution: {
    effect: EffectClass
    isolation: ToolIsolation
    replay: ToolReplay
    /** 未声明时统一取现有 loopConfig.toolTimeoutMs。 */
    timeoutMs?: number
  }
  context: {
    resultProjection: ResultProjection
    historyCompaction: HistoryCompaction
  }
}

/** 工具操作类别（用于阶段文案匹配） */
export type ActionCategory =
  | "fs.read" | "fs.write"
  | "os.exec" | "os.info"
  | "net.fetch"
  | "app.launch"
  | "clip.read" | "clip.write"
  | "agent.call"
  | "_default"

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前模式 */
  mode: "pet" | "assistant"
  /** 当前 Pi 工具调用 ID */
  toolCallId?: string
  /** 稳定的单次操作标识，用于审计和幂等关联。 */
  operationId?: string
  /** 工具声明与安全策略的摘要。 */
  policyHash?: string
  /** Agent 取消/超时信号 */
  signal?: AbortSignal
  /** 工具执行中的完整快照更新 */
  onUpdate?: (partial: ToolResult) => void
  /** 权限确认必须绑定所属会话，子代理使用稳定 run id。 */
  sessionId?: string
  /** 当前会话运行代际；旧代际不得取得新授权。 */
  runGeneration?: number
  /** 确认等待后仍为当前回合的守卫。 */
  isCurrent?: () => boolean
}

/** 工具执行结果 */
export interface ToolResult {
  success: boolean
  content: string
  error?: string
  errorCode?: "not_found" | "denied" | "timeout" | "cancelled" | "failed"
  /** Pi 原生文本/图片结果；未提供时由 content 生成文本结果。 */
  contentParts?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >
  details?: unknown
}

export type ToolParameters = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/** 工具定义标准接口 */
export interface ToolDef {
  /** 全局唯一 ID */
  id: string
  /** 给模型的函数名 */
  name: string
  /** 模型看的描述 */
  description: string
  /** JSON Schema 参数 */
  parameters: ToolParameters
  /** 在 Schema 校验前兼容模型生成的旧参数形态。 */
  prepareArguments?: (args: unknown) => Record<string, unknown>
  /** 安全级别 */
  safetyLevel: SafetyLevel
  /** 根据本次参数动态提升/降低风险，主要用于统一 Bash。 */
  resolveSafetyLevel?: (params: Record<string, unknown>, ctx: ToolContext) => SafetyLevel
  /** 轻量模式对 DANGER 能力的策略；未声明在 pet 模式等同于 deny（助手模式不受它影响）。 */
  lightweightPolicy?: LightweightPolicy
  /** 来源 */
  source: ToolSource
  /** 来源 ID（local → 空, mcp/skill → server/skill ID） */
  sourceId: string
  /** 哪个模式可用 */
  mode: ToolMode
  /** 操作类别，只用于阶段文案匹配（§7.1），不决定并行、权限或压缩 */
  actionCategory: ActionCategory
  /** 权限 / 执行 / 投影 / 摘要的统一策略；缺策略视为注册错误。 */
  policy: ToolPolicy
  // 执行函数不是公开字段：经 `defineTool` 进入模块内 WeakMap（见 policy.ts），
  // 使「未经 defineTool 构造的定义」在结构上不可能携带执行体。
}

// ── 工具声明（给 AI 的 function schema）──

export interface ToolDeclaration {
  type: "function"
  function: {
    name: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/** 将 ToolDef 转为 AI 可用的声明 */
export function toToolDeclaration(tool: ToolDef): ToolDeclaration {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
