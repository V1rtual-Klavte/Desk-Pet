import type { SceneDef } from "../../types"
import { authorizeToolExecution, awaitPermission, confirmState, evaluateToolPermission, freezePermissionPolicy, invalidatePermissionScope, resolvePermissionConfirm } from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import type { ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, TOOL_POLICY_VERSION } from "@/services/tool"

const context = (overrides: Partial<Parameters<typeof evaluateToolPermission>[2]> = {}) => ({
  sessionId: "permission-test-session",
  runGeneration: 7,
  toolCallId: "permission-test-call",
  // 裁决与 policyHash 只认回合冻结的策略快照（真回合由 preflight 取，测试宿主按当前值取）。
  policy: freezePermissionPolicy(),
  ...overrides,
})

/**
 * 回合冻结快照的字面值：ask 探针要钉住的是裁决表，不跟本机 `ai.safety.mode` 漂移。
 * 信任开关按关闭给 —— 本文件断言的是裁决与交集，不是 allow_session 的复用（那是 sf-14）。
 */
const snapshot = (safetyMode: PermissionPolicySnapshot["safetyMode"]): PermissionPolicySnapshot => ({
  safetyMode, sessionTrustEnabled: false,
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
  source: "local", sourceId: "", actionCategory: "_default",
  policy: policy({ defaultDecision: "passthrough" }),
  ...overrides,
}, async () => ({ success: true, content: "ok" }))

const scene = (caseId: string, contractId: string, description: string, run: () => Promise<void>): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth: "deep", suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查权限内核。", checks: [{ type: "expectSafety", run }] }],
})

export const passthrough终裁 = scene("permission-passthrough-final", "sf-11", "MCP passthrough 必须由 PermissionKernel 终裁", async () => {
  // 发现侧把 MCP 工具声明为 DANGER（sf-21），所以默认安全模式下的收敛结果是 ask；
  // NORMAL 探针在新裁决表下会先被放行，证明不了「passthrough 被收敛」。
  const mcp = tool({ source: "mcp", sourceId: "remote", safetyLevel: "DANGER", policy: policy({ defaultDecision: "passthrough" }) })
  // 探针前提：工具自己确实只表态 passthrough —— 下面的收敛不是工具换了个意见。
  if (mcp.policy.permission.defaultDecision !== "passthrough") throw new Error("探针工具的权限意见不是 passthrough")
  const result = await evaluateToolPermission(mcp, { target: "remote" }, context({
    policy: snapshot("tell_me"), toolCallId: "mcp-passthrough-ask",
  }))
  if (result.decision !== "ask" || !result.request) throw new Error(`MCP passthrough 未收敛为 ask: ${result.decision}`)

  // 收敛走的是裁决表而不是「passthrough 一律 ask」：同一份意见在 just_do_it 下收敛为 allow。
  const permissive = await evaluateToolPermission(mcp, { target: "remote" }, context({
    policy: snapshot("just_do_it"), toolCallId: "mcp-passthrough-allow",
  }))
  if (permissive.decision !== "allow") throw new Error(`just_do_it 下 MCP passthrough 未收敛为 allow: ${permissive.decision}`)
})

export const deny优先 = scene("permission-deny-first", "sf-12", "硬禁止优先、ask 取交集、工具侧 deny 与表外意见一律拒绝", async () => {
  // ① NOWAY 优先于工具侧 allow。
  const result = await evaluateToolPermission(tool({
    safetyLevel: "NOWAY", policy: policy({ defaultDecision: "allow" }),
  }), { path: "/" }, context())
  if (result.decision !== "deny") throw new Error("NOWAY 被工具 allow 绕过")

  // ② 工具侧静态 allow 是「一条意见」，不是许可：DANGER 在默认安全模式下仍必须 ask
  //    （统一裁决表删掉了「NORMAL 在助手模式下必为 ask」这条旧路径，ask 只剩 DANGER
  //    与工具侧显式 ask 两个来源）。
  const downgraded = await evaluateToolPermission(tool({
    safetyLevel: "DANGER", policy: policy({ defaultDecision: "allow" }),
  }), { path: "/tmp/notes.md" }, context({ policy: snapshot("tell_me"), toolCallId: "allow-cannot-downgrade" }))
  if (downgraded.decision !== "ask" || !downgraded.request) {
    throw new Error(`工具策略 allow 把标准决策的 ask 降级为放行: ${downgraded.decision}`)
  }

  // ③ 交集的反向：工具自己声明 ask 时，标准决策的 allow 不能把它吞成放行。
  const toolAsks = await evaluateToolPermission(tool({
    safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }),
  }), {}, context({ policy: snapshot("just_do_it"), toolCallId: "tool-ask-wins" }))
  if (toolAsks.decision !== "ask" || !toolAsks.request) {
    throw new Error(`工具声明的独立 ask 被标准决策 allow 吞掉: ${toolAsks.decision}`)
  }

  // ④ 工具侧 deny 直接拒绝（安全等级更低的 SAFE 也一样），且不生成确认请求。
  const toolDenies = await evaluateToolPermission(tool({
    safetyLevel: "SAFE", policy: policy({ defaultDecision: "deny" }),
  }), {}, context({ policy: snapshot("just_do_it"), toolCallId: "tool-deny-wins" }))
  if (toolDenies.decision !== "deny" || toolDenies.request) {
    throw new Error(`工具侧 deny 没有被直接执行: ${toolDenies.decision}`)
  }

  // ⑤ 表外意见按 deny 处理：这条守的是未经类型检查的适配器（as 断言绕过 ToolDef），
  //    所以这里刻意绕开 defineTool（它的校验会先一步拒绝），手工拼一份带表外意见的定义。
  const outOfTable = {
    ...tool({ safetyLevel: "SAFE" }),
    policy: {
      ...policy({ defaultDecision: "passthrough" }),
      permission: { defaultDecision: "maybe" as unknown as ToolPolicy["permission"]["defaultDecision"] },
    },
  } as unknown as ToolDef
  const invalid = await evaluateToolPermission(outOfTable, {}, context({ toolCallId: "out-of-table" }))
  if (invalid.decision !== "deny" || invalid.request) {
    throw new Error(`表外权限意见没有被按 deny 处理: ${invalid.decision}`)
  }
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
