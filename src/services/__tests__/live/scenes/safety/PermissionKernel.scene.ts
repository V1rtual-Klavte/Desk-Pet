import type { SceneDef } from "../../types"
import { authorizeToolExecution, awaitPermission, confirmState, evaluateToolPermission, freezePermissionPolicy, invalidatePermissionScope, resolvePermissionConfirm } from "@/services/safety"
import type { ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, TOOL_POLICY_VERSION } from "@/services/tool"

const context = (overrides: Partial<Parameters<typeof evaluateToolPermission>[2]> = {}) => ({
  mode: "assistant" as const,
  sessionId: "permission-test-session",
  runGeneration: 7,
  toolCallId: "permission-test-call",
  // 裁决与 policyHash 只认回合冻结的策略快照（真回合由 preflight 取，测试宿主按当前值取）。
  policy: freezePermissionPolicy(),
  ...overrides,
})

/** 策略默认只用最小合法声明；权限场景按需覆盖 permission 段。 */
const policy = (permission: ToolPolicy["permission"]): ToolPolicy => ({
  version: TOOL_POLICY_VERSION,
  permission,
  execution: { effect: "external_side_effect", isolation: "exclusive_effect", replay: "never" },
  context: { resultProjection: "reference", historyCompaction: "summarize" },
})

const tool = (overrides: Partial<ToolDef> = {}): ToolDef => defineTool({
  id: "permission-test", name: "permission_test", description: "permission test",
  parameters: { type: "object", properties: {} }, safetyLevel: "NORMAL",
  source: "local", sourceId: "", mode: "assistant", actionCategory: "_default",
  policy: policy({ defaultDecision: "passthrough" }),
  ...overrides,
}, async () => ({ success: true, content: "ok" }))

const scene = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth: "deep", suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查权限内核。", checks: [{ type: "expectSafety", run }] }],
})

export const passthrough终裁 = scene("permission-passthrough-final", "sf-11", "MCP passthrough 必须由 PermissionKernel 终裁", async () => {
  const result = await evaluateToolPermission(tool({
    source: "mcp", sourceId: "remote",
    policy: policy({ defaultDecision: "passthrough" }),
  }), { target: "remote" }, context())
  if (result.decision !== "ask" || !result.request) throw new Error("MCP passthrough 未收敛为 ask")
})

export const deny优先 = scene("permission-deny-first", "sf-12", "硬禁止优先于来源 allow", async () => {
  const result = await evaluateToolPermission(tool({
    safetyLevel: "NOWAY", policy: policy({ defaultDecision: "allow" }),
  }), { path: "/" }, context())
  if (result.decision !== "deny") throw new Error("NOWAY 被工具 allow 绕过")

  // 工具侧静态 allow 是「一条意见」，不是许可：只读工具对每个路径都声明 allow，
  // 参数级风险仍必须由标准决策兜住（NORMAL 在助手模式下无论安全模式如何都是 ask）。
  const downgraded = await evaluateToolPermission(tool({
    safetyLevel: "NORMAL", policy: policy({ defaultDecision: "allow" }),
  }), { path: "/tmp/notes.md" }, context({ toolCallId: "allow-cannot-downgrade" }))
  if (downgraded.decision !== "ask") throw new Error("工具策略 allow 把标准决策的 ask 降级为放行")
})

export const 身份失效拒绝 = scene("permission-identity-invalid", "sf-13", "缺失或已失效会话身份时 fail closed", async () => {
  const missing = await evaluateToolPermission(tool(), {}, context({ sessionId: "" }))
  const stale = await evaluateToolPermission(tool(), {}, context({ isCurrent: () => false }))
  if (missing.decision !== "deny" || stale.decision !== "deny") throw new Error("无效身份没有被拒绝")
})

export const 会话授权精确复用 = scene("permission-session-grant", "sf-14", "allow_session 仅复用同会话同代际同参数同策略授权", async () => {
  invalidatePermissionScope("permission-test-session", 7)
  const protectedTool = tool({ safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }) })
  const first = authorizeToolExecution(protectedTool, { target: "same" }, context())
  if ((await first).decision !== "allow") throw new Error("allow_session 没有放行本次调用")
  const reused = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-call" }))
  const changedInput = await evaluateToolPermission(protectedTool, { target: "different" }, context({ toolCallId: "different-input" }))
  const changedGeneration = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-generation", runGeneration: 8 }))
  if (reused.decision !== "allow" || changedInput.decision !== "ask" || changedGeneration.decision !== "ask") {
    throw new Error("会话授权没有按会话、代际、参数和策略精确约束")
  }
  // 策略指纹变化后旧授权必须失效：这里只改一个与裁决无关的策略维度（请求投影），
  // 基础决策仍是 SAFE 放行 —— 若授权只看会话/参数，它会被错误复用成 allow。
  const changedPolicyTool = tool({
    safetyLevel: "SAFE",
    policy: { ...policy({ defaultDecision: "ask" }), context: { resultProjection: "preserve", historyCompaction: "summarize" } },
  })
  const changedPolicy = await evaluateToolPermission(changedPolicyTool, { target: "same" }, context({ toolCallId: "changed-policy" }))
  if (changedPolicy.decision !== "ask") throw new Error("工具策略变化后旧会话授权仍被复用")
})

export const 已取消确认拒绝 = scene("permission-aborted-confirm", "sf-15", "已取消的确认不得重新挂起或放行", async () => {
  const controller = new AbortController()
  const result = await evaluateToolPermission(tool({ safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }) }), {}, context())
  if (!result.request) throw new Error("没有生成可取消的确认请求")
  controller.abort()
  if (await awaitPermission(result.request, context({ signal: controller.signal })) !== "deny") throw new Error("已取消确认没有立即拒绝")
})

export default passthrough终裁

会话授权精确复用.meta.confirmPolicy = "approve"
