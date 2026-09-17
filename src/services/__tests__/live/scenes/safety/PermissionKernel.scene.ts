import type { SceneDef } from "../../types"
import { authorizeToolExecution, awaitPermission, confirmState, evaluateToolPermission, invalidatePermissionScope, resolvePermissionConfirm } from "@/services/safety"
import type { ToolDef } from "@/services/tool"

const context = (overrides: Partial<Parameters<typeof evaluateToolPermission>[2]> = {}) => ({
  mode: "assistant" as const,
  sessionId: "permission-test-session",
  runGeneration: 7,
  toolCallId: "permission-test-call",
  ...overrides,
})

const tool = (overrides: Partial<ToolDef> = {}): ToolDef => ({
  id: "permission-test", name: "permission_test", description: "permission test",
  parameters: { type: "object", properties: {} }, safetyLevel: "NORMAL",
  source: "local", sourceId: "", mode: "assistant", actionCategory: "_default",
  handler: async () => ({ success: true, content: "ok" }),
  ...overrides,
})

const scene = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth: "deep", suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查权限内核。", checks: [{ type: "expectSafety", run }] }],
})

export const passthrough终裁 = scene("permission-passthrough-final", "sf-11", "MCP passthrough 必须由 PermissionKernel 终裁", async () => {
  const result = await evaluateToolPermission(tool({
    source: "mcp", sourceId: "remote", effectClass: "external_side_effect",
    permissionCheck: () => "passthrough",
  }), { target: "remote" }, context())
  if (result.decision !== "ask" || !result.request) throw new Error("MCP passthrough 未收敛为 ask")
})

export const deny优先 = scene("permission-deny-first", "sf-12", "硬禁止优先于来源 allow", async () => {
  const result = await evaluateToolPermission(tool({
    safetyLevel: "NOWAY", permissionCheck: () => "allow",
  }), { path: "/" }, context())
  if (result.decision !== "deny") throw new Error("NOWAY 被工具 allow 绕过")
})

export const 身份失效拒绝 = scene("permission-identity-invalid", "sf-13", "缺失或已失效会话身份时 fail closed", async () => {
  const missing = await evaluateToolPermission(tool(), {}, context({ sessionId: "" }))
  const stale = await evaluateToolPermission(tool(), {}, context({ isCurrent: () => false }))
  if (missing.decision !== "deny" || stale.decision !== "deny") throw new Error("无效身份没有被拒绝")
})

export const 会话授权精确复用 = scene("permission-session-grant", "sf-14", "allow_session 仅复用同会话同代际同参数同策略授权", async () => {
  invalidatePermissionScope("permission-test-session", 7)
  const protectedTool = tool({ safetyLevel: "SAFE", permissionCheck: () => "ask" })
  const first = authorizeToolExecution(protectedTool, { target: "same" }, context())
  if ((await first).decision !== "allow") throw new Error("allow_session 没有放行本次调用")
  const reused = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-call" }))
  const changedInput = await evaluateToolPermission(protectedTool, { target: "different" }, context({ toolCallId: "different-input" }))
  const changedGeneration = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-generation", runGeneration: 8 }))
  if (reused.decision !== "allow" || changedInput.decision !== "ask" || changedGeneration.decision !== "ask") {
    throw new Error("会话授权没有按会话、代际、参数和策略精确约束")
  }
})

export const 已取消确认拒绝 = scene("permission-aborted-confirm", "sf-15", "已取消的确认不得重新挂起或放行", async () => {
  const controller = new AbortController()
  const result = await evaluateToolPermission(tool({ safetyLevel: "SAFE", permissionCheck: () => "ask" }), {}, context())
  if (!result.request) throw new Error("没有生成可取消的确认请求")
  controller.abort()
  if (await awaitPermission(result.request, context({ signal: controller.signal })) !== "deny") throw new Error("已取消确认没有立即拒绝")
})

export default passthrough终裁

会话授权精确复用.meta.confirmPolicy = "approve"
