// ==========================================
// ToolDef 类型定义 —— 工具系统统一接口
// ==========================================

/** 安全级别 */
export type SafetyLevel = "SAFE" | "NORMAL" | "DANGER" | "NOWAY"

/** 工具来源 */
export type ToolSource = "local" | "mcp" | "skill"

/** 模式限制 */
export type ToolMode = "pet" | "assistant"

export type LightweightPolicy = "allow" | "confirm" | "deny"

/** PermissionKernel 的最终裁决；passthrough 只允许规则层内部使用。 */
export type PermissionDecision = "allow" | "ask" | "deny"
export type ToolCheckResult = PermissionDecision | "passthrough"

/** 操作效果分类，风险等级描述影响程度，效果分类描述影响对象。 */
export type EffectClass = "read" | "local_mutation" | "process" | "external_side_effect"

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
  /** 轻量模式对 DANGER 能力的策略；未设置时保持拒绝。 */
  lightweightPolicy?: LightweightPolicy
  /** 来源 */
  source: ToolSource
  /** 来源 ID（local → 空, mcp/skill → server/skill ID） */
  sourceId: string
  /** 哪个模式可用 */
  mode: ToolMode
  /** 操作类别，用于阶段文案匹配（§7.1） */
  actionCategory: ActionCategory
  /** 本次工具效果分类，未声明时由 PermissionKernel 按 actionCategory 推导。 */
  effectClass?: EffectClass
  /**
   * 来源/工具专属的权限规则。passthrough 不是执行许可，必须由
   * PermissionKernel 继续收敛为 allow / ask / deny。
   */
  permissionCheck?: (params: Record<string, unknown>, ctx: ToolContext) => ToolCheckResult | Promise<ToolCheckResult>
  /** 执行函数 */
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
  /** 超时（ms），默认 loop.toolTimeoutMs */
  timeoutMs?: number
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
