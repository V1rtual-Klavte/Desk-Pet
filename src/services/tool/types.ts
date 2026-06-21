// ==========================================
// ToolDef 类型定义 —— 工具系统统一接口
// ==========================================

/** 安全级别 */
export type SafetyLevel = "SAFE" | "NORMAL" | "DANGER" | "NOWAY"

/** 工具来源 */
export type ToolSource = "local" | "mcp" | "skill"

/** 模式限制 */
export type ToolMode = "pet" | "assistant"

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前模式 */
  mode: "pet" | "assistant"
  /** 会话已信任（助手模式安全） */
  sessionTrusted: boolean
}

/** 工具执行结果 */
export interface ToolResult {
  success: boolean
  content: string
  error?: string
}

/** 人格化文案 */
export interface PersonalityHint {
  executing?: string
  done?: string
  blocked?: string
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
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
  /** 安全级别 */
  safetyLevel: SafetyLevel
  /** 来源 */
  source: ToolSource
  /** 来源 ID（local → 空, mcp/skill → server/skill ID） */
  sourceId: string
  /** 哪个模式可用 */
  mode: ToolMode
  /** 执行函数 */
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
  /** 超时（ms），默认 loop.toolTimeoutMs */
  timeoutMs?: number
  /** 人格化文案 */
  personalityHint?: PersonalityHint
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
      required: string[]
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
