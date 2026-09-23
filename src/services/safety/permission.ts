// ==========================================
// PermissionKernel —— 统一权限裁决与有身份的确认生命周期
// ==========================================

import { toolPolicyFingerprint } from "@/services/tool"
import type {
  EffectClass, PermissionDecision, ToolContext, ToolDef,
} from "@/services/tool"
import { safetyConfig } from "@/services/config"
import { getEffectiveSafetyMode } from "@/services/debug"
import { createLogger } from "@/services/logger"
import { redactText, sha256Text, stableSerialize } from "@/services/engine/runtime"
import { requestPermissionConfirm, cancelPermissionConfirm } from "./confirm"

const log = createLogger("Permission")

export type { EffectClass, PermissionDecision }
export type PermissionConfirmation = "allow_once" | "allow_session" | "deny"

/** 回合内冻结的权限策略：回合开始时取一次，回合中改设置从下一回合生效。 */
export interface PermissionPolicySnapshot {
  safetyMode: ReturnType<typeof getEffectiveSafetyMode>
  sessionTrustEnabled: boolean
}

/**
 * preflight 取一次策略快照；回合内所有裁决与 policyHash 只用它。
 *
 * 冻结的理由是身份一致：同一次确认的裁决与授权哈希必须来自同一份策略，
 * 否则回合中途改设置会让「确认时看到的风险」与「复用授权时的策略」不是同一件事。
 */
export function freezePermissionPolicy(): PermissionPolicySnapshot {
  return { safetyMode: getEffectiveSafetyMode(), sessionTrustEnabled: safetyConfig.sessionTrustEnabled }
}

export interface PermissionContext extends ToolContext {
  sessionId: string
  runGeneration: number
  toolCallId: string
  policy: PermissionPolicySnapshot
}

export interface PermissionRequest {
  requestId: string
  sessionId: string
  runGeneration: number
  toolCallId: string
  toolName: string
  inputHash: string
  policyHash: string
  expiresAt: number
  message: string
  parameterSummary: string
  effectClass: EffectClass
}

export interface PermissionResult {
  decision: PermissionDecision
  reason?: string
  request?: PermissionRequest
}

interface PermissionGrant {
  sessionId: string
  runGeneration: number
  toolName: string
  inputHash: string
  policyHash: string
  expiresAt: number
}

const CONFIRM_TTL_MS = 5 * 60 * 1000
let grants = new Map<string, PermissionGrant>()

function grantKey(grant: Pick<PermissionGrant, "sessionId" | "runGeneration" | "toolName" | "inputHash" | "policyHash">): string {
  return stableSerialize({ sessionId: grant.sessionId, runGeneration: grant.runGeneration, toolName: grant.toolName, inputHash: grant.inputHash, policyHash: grant.policyHash })
}

/** 效果分类只来自策略声明；actionCategory 不参与推导。 */
function effectClass(tool: ToolDef): EffectClass {
  return tool.policy.execution.effect
}

function parameterSummary(params: Record<string, unknown>): string {
  const sensitive = /(?:token|secret|password|api[_-]?key|authorization)/i
  const pairs = Object.entries(params).slice(0, 8).map(([key, value]) => {
    if (sensitive.test(key)) return `${key}=已隐藏`
    const text = typeof value === "string" ? value : stableSerialize(value)
    return `${key}=${redactText(text).text.slice(0, 160)}`
  })
  return pairs.length ? pairs.join("，") : "无参数"
}

function isUsableContext(ctx: PermissionContext): boolean {
  return Boolean(ctx.sessionId && ctx.toolCallId) && Number.isSafeInteger(ctx.runGeneration) && ctx.runGeneration >= 0 && !ctx.signal?.aborted && (ctx.isCurrent?.() ?? true)
}

function standardDecision(tool: ToolDef, params: Record<string, unknown>, ctx: PermissionContext): PermissionResult {
  const level = tool.resolveSafetyLevel?.(params, ctx) ?? tool.safetyLevel
  if (level === "NOWAY") return { decision: "deny", reason: "硬禁止操作" }
  if (tool.mode === "assistant" && ctx.mode !== "assistant") return { decision: "deny", reason: "当前模式不允许该工具" }
  if (level === "SAFE") return { decision: "allow" }

  const safetyMode = ctx.policy.safetyMode
  if (ctx.mode === "pet") {
    if (level === "NORMAL") return { decision: "allow" }
    if (tool.lightweightPolicy === "confirm") return { decision: "ask", reason: "轻量模式需要用户确认" }
    log.info("pet 模式非 confirm 的 DANGER 一律拒绝:", tool.name)
    return { decision: "deny", reason: "轻量模式不支持该风险操作" }
  }
  if (safetyMode === "let_me_tk") return { decision: "ask", reason: "保守安全策略要求确认" }
  if (level === "DANGER" && safetyMode === "just_do_it") return { decision: "allow" }
  return { decision: "ask", reason: `${level} 风险操作需要确认` }
}

async function policyHash(tool: ToolDef, params: Record<string, unknown>, ctx: PermissionContext): Promise<string> {
  // 静态策略身份与本次解析结果一起入 hash：策略或风险变化后旧授权自然失效。
  // 安全模式与信任开关取回合冻结值 —— hash 与裁决必须来自同一份策略快照。
  return sha256Text(stableSerialize({
    policy: toolPolicyFingerprint(tool),
    resolvedSafetyLevel: tool.resolveSafetyLevel?.(params, ctx) ?? tool.safetyLevel,
    safetyMode: ctx.policy.safetyMode, sessionTrustEnabled: ctx.policy.sessionTrustEnabled,
  }))
}

function validGrant(request: PermissionRequest): boolean {
  const key = grantKey(request)
  const grant = grants.get(key)
  if (!grant) return false
  if (grant.expiresAt <= Date.now()) {
    grants.delete(key)
    return false
  }
  return true
}

/**
 * 只做裁决，不展示 UI。passthrough 在此函数内必须被收敛，executor 永远得不到它。
 */
export async function evaluateToolPermission(
  tool: ToolDef,
  params: Record<string, unknown>,
  ctx: PermissionContext,
): Promise<PermissionResult> {
  if (!isUsableContext(ctx)) return { decision: "deny", reason: "会话、代际或取消状态无效" }
  const base = standardDecision(tool, params, ctx)
  if (base.decision === "deny") return base

  // 工具侧意见只有策略里的静态表态这一处来源。
  const toolDecision: PermissionDecision | "passthrough" = tool.policy.permission.defaultDecision
  if (toolDecision !== "allow" && toolDecision !== "ask" && toolDecision !== "deny" && toolDecision !== "passthrough") {
    return { decision: "deny", reason: "工具返回了无效权限结果" }
  }
  if (toolDecision === "deny") return { decision: "deny", reason: "工具专属策略拒绝" }
  // 独立约束取交集：标准 ask 不能被来源侧 allow 吞掉。
  const decision: PermissionDecision = base.decision === "ask" || toolDecision === "ask" ? "ask" : "allow"
  if (decision === "allow") return { decision }

  const inputHash = await sha256Text(stableSerialize(params))
  const currentPolicyHash = await policyHash(tool, params, ctx)
  const request: PermissionRequest = {
    requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: ctx.sessionId,
    runGeneration: ctx.runGeneration,
    toolCallId: ctx.toolCallId,
    toolName: tool.name,
    inputHash,
    policyHash: currentPolicyHash,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
    message: `“${tool.name}” 将执行 ${effectClass(tool)} 操作，需要你的确认。`,
    parameterSummary: parameterSummary(params),
    effectClass: effectClass(tool),
  }
  if (ctx.policy.sessionTrustEnabled && ctx.policy.safetyMode !== "let_me_tk" && validGrant(request)) return { decision: "allow" }
  return { decision: "ask", reason: base.reason, request }
}

/** 等待一次确认；取消、过期、关闭或旧代际一律返回 deny。 */
export async function awaitPermission(request: PermissionRequest, ctx: PermissionContext): Promise<PermissionConfirmation> {
  if (!isUsableContext(ctx) || request.expiresAt <= Date.now()) return "deny"
  return requestPermissionConfirm(request, ctx.signal)
}

/**
 * beforeToolCall 的生产入口：确认后重新读取参数/策略/代际，任何变化都不复用旧授权。
 */
export async function authorizeToolExecution(
  tool: ToolDef,
  params: Record<string, unknown>,
  ctx: PermissionContext,
): Promise<PermissionResult> {
  const first = await evaluateToolPermission(tool, params, ctx)
  if (first.decision !== "ask" || !first.request) return first
  const response = await awaitPermission(first.request, ctx)
  if (response === "deny") return { decision: "deny", reason: "用户拒绝、确认过期或确认已失效", request: first.request }

  const rechecked = await evaluateToolPermission(tool, params, ctx)
  if (!rechecked.request || rechecked.request.inputHash !== first.request.inputHash || rechecked.request.policyHash !== first.request.policyHash) {
    return { decision: "deny", reason: "确认期间参数或权限策略已变化" }
  }
  if (response === "allow_session" && ctx.policy.sessionTrustEnabled && ctx.policy.safetyMode !== "let_me_tk") {
    const grant: PermissionGrant = {
      sessionId: first.request.sessionId, runGeneration: first.request.runGeneration,
      toolName: first.request.toolName, inputHash: first.request.inputHash,
      policyHash: first.request.policyHash, expiresAt: first.request.expiresAt,
    }
    grants.set(grantKey(grant), grant)
  }
  return { decision: "allow" }
}

/** 会话取消、切换或恢复时主动使未过期授权失效。 */
export function invalidatePermissionScope(sessionId?: string, runGeneration?: number): void {
  cancelPermissionConfirm(sessionId, runGeneration)
  for (const [key, grant] of grants) {
    if ((sessionId === undefined || grant.sessionId === sessionId) && (runGeneration === undefined || grant.runGeneration === runGeneration)) grants.delete(key)
  }
}
