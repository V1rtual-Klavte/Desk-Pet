// ==========================================
// 权限内核 PermissionKernel —— 从 test/e2e/scenes/safety/PermissionKernel.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的理由（按 import 判定）：原场景 import `@/services/tool`（defineTool /
// TOOL_POLICY_VERSION），工具 barrel 会带出执行许可（IPC），命中规则 6 的 L2 禁入清单。
// 裁决本体（`@/services/safety`）是纯逻辑，但它不构成 L2 的充分条件 —— 判定按 import，
// 不按「跑不跑得起来」。
//
// 审视结论：全部照搬。断言对象是 `evaluateToolPermission` / `authorizeToolExecution` /
// `awaitPermission` 的返回结果（decision / request 的身份与哈希 / 授权复用边界），
// 逐条能区分对错实现：
//   · sf-11/12/13/15 的探针显式给字面快照，不随本机 `ai.safety.mode` 漂移；
//   · sf-14 的唯一宿主依赖是确认通道 —— 原场景声明 `confirmPolicy: "approve"`，
//     这里等价地由 `resetConfirmChannel("approve")` 安装同一份宿主应答；
//     `first.decision === "allow"` 是产品结论（请求生成 → 等待 → 哈希复核 → 授权入账）。
// 配置前提：`sessionTrustEnabled` 与安全模式在 beforeEach 钉死 —— L3 没有 standard-setup 兜底。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resetConfirmChannel } from "../../host/confirm-channel"
import { setTestDataRoot } from "../../host/node-ipc"
import { setOverrides } from "@/services/config"
import {
  authorizeToolExecution,
  awaitPermission,
  evaluateToolPermission,
  freezePermissionPolicy,
  invalidatePermissionScope,
} from "@/services/safety"
import type { PermissionContext, PermissionPolicySnapshot } from "@/services/safety"
import { defineTool, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef, ToolPolicy } from "@/services/tool"

const context = (overrides: Partial<PermissionContext> = {}): PermissionContext => ({
  sessionId: "permission-test-session",
  runGeneration: 7,
  toolCallId: "permission-test-call",
  // 裁决与 policyHash 只认回合冻结的策略快照（真回合由 preflight 取，测试按当前值取）。
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

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-safety-kernel-"))
  setTestDataRoot(root)
  // 判据要求的取值由本文件自己钉：sf-14 的授权入账要求信任开关打开、模式不是 let_me_tk。
  setOverrides({ "ai.safety.mode": "tell_me", "ai.safety.sessionTrustEnabled": true })
  resetConfirmChannel("deny")
})

afterEach(() => {
  resetConfirmChannel("deny")
  rmSync(root, { recursive: true, force: true })
})

describe("权限内核 PermissionKernel", () => {
  it("MCP passthrough 必须由 PermissionKernel 终裁 [permission-passthrough-final]", async () => {
    // 发现侧把 MCP 工具声明为 DANGER（sf-21），所以默认安全模式下的收敛结果是 ask；
    // NORMAL 探针在新裁决表下会先被放行，证明不了「passthrough 被收敛」。
    const mcp = tool({ source: "mcp", sourceId: "remote", safetyLevel: "DANGER", policy: policy({ defaultDecision: "passthrough" }) })
    // 探针前提（非产品结论）：工具自己确实只表态 passthrough —— 下面的收敛不是工具换了个意见。
    expect(mcp.policy.permission.defaultDecision, "探针工具的权限意见不是 passthrough").toBe("passthrough")

    const result = await evaluateToolPermission(mcp, { target: "remote" }, context({
      policy: snapshot("tell_me"), toolCallId: "mcp-passthrough-ask",
    }))
    expect(result.decision, "MCP passthrough 未收敛为 ask").toBe("ask")
    expect(result.request).toBeDefined()

    // 收敛走的是裁决表而不是「passthrough 一律 ask」：同一份意见在 just_do_it 下收敛为 allow。
    const permissive = await evaluateToolPermission(mcp, { target: "remote" }, context({
      policy: snapshot("just_do_it"), toolCallId: "mcp-passthrough-allow",
    }))
    expect(permissive.decision, "just_do_it 下 MCP passthrough 未收敛为 allow").toBe("allow")
    expect(permissive.request).toBeUndefined()
  })

  it("硬禁止优先、ask 取交集、工具侧 deny 与表外意见一律拒绝 [permission-deny-first]", async () => {
    // ① NOWAY 优先于工具侧 allow。
    const noway = await evaluateToolPermission(tool({
      safetyLevel: "NOWAY", policy: policy({ defaultDecision: "allow" }),
    }), { path: "/" }, context())
    expect(noway.decision, "NOWAY 被工具 allow 绕过").toBe("deny")
    expect(noway.request).toBeUndefined()

    // ② 工具侧静态 allow 是「一条意见」，不是许可：DANGER 在默认安全模式下仍必须 ask
    //    （统一裁决表删掉了「NORMAL 在助手模式下必为 ask」这条旧路径，ask 只剩 DANGER
    //    与工具侧显式 ask 两个来源）。
    const downgraded = await evaluateToolPermission(tool({
      safetyLevel: "DANGER", policy: policy({ defaultDecision: "allow" }),
    }), { path: "/tmp/notes.md" }, context({ policy: snapshot("tell_me"), toolCallId: "allow-cannot-downgrade" }))
    expect(downgraded.decision, "工具策略 allow 把标准决策的 ask 降级为放行").toBe("ask")
    expect(downgraded.request).toBeDefined()

    // ③ 交集的反向：工具自己声明 ask 时，标准决策的 allow 不能把它吞成放行。
    const toolAsks = await evaluateToolPermission(tool({
      safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }),
    }), {}, context({ policy: snapshot("just_do_it"), toolCallId: "tool-ask-wins" }))
    expect(toolAsks.decision, "工具声明的独立 ask 被标准决策 allow 吞掉").toBe("ask")
    expect(toolAsks.request).toBeDefined()

    // ④ 工具侧 deny 直接拒绝（安全等级更低的 SAFE 也一样），且不生成确认请求。
    const toolDenies = await evaluateToolPermission(tool({
      safetyLevel: "SAFE", policy: policy({ defaultDecision: "deny" }),
    }), {}, context({ policy: snapshot("just_do_it"), toolCallId: "tool-deny-wins" }))
    expect(toolDenies.decision, "工具侧 deny 没有被直接执行").toBe("deny")
    expect(toolDenies.request).toBeUndefined()

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
    expect(invalid.decision, "表外权限意见没有被按 deny 处理").toBe("deny")
    expect(invalid.request).toBeUndefined()
  })

  it("缺失或已失效会话身份时 fail closed [permission-identity-invalid]", async () => {
    const missing = await evaluateToolPermission(tool(), {}, context({ sessionId: "" }))
    const stale = await evaluateToolPermission(tool(), {}, context({ isCurrent: () => false }))
    expect(missing.decision, "缺失会话身份的裁决没有被拒绝").toBe("deny")
    expect(stale.decision, "代际已失效的裁决没有被拒绝").toBe("deny")
  })

  it("allow_session 仅复用同会话同代际同参数同策略授权 [permission-session-grant]", async () => {
    // 原场景声明 `confirmPolicy: "approve"`；L3 等价地装同一份宿主应答（立即放行）。
    resetConfirmChannel("approve")
    invalidatePermissionScope("permission-test-session", 7)
    const protectedTool = tool({ safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }) })
    const first = await authorizeToolExecution(protectedTool, { target: "same" }, context())
    expect(first.decision, "allow_session 没有放行本次调用").toBe("allow")

    const reused = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-call" }))
    const changedInput = await evaluateToolPermission(protectedTool, { target: "different" }, context({ toolCallId: "different-input" }))
    const changedGeneration = await evaluateToolPermission(protectedTool, { target: "same" }, context({ toolCallId: "next-generation", runGeneration: 8 }))
    expect(reused.decision, "同会话同代际同参数的旧授权未被复用").toBe("allow")
    expect(changedInput.decision, "参数变化后旧授权仍被复用").toBe("ask")
    expect(changedGeneration.decision, "代际变化后旧授权仍被复用").toBe("ask")

    // 策略指纹变化后旧授权必须失效：这里只改一个与裁决无关的策略维度（请求投影），
    // 基础决策仍是 SAFE 放行 —— 若授权只看会话/参数，它会被错误复用成 allow。
    const changedPolicyTool = tool({
      safetyLevel: "SAFE",
      policy: { ...policy({ defaultDecision: "ask" }), context: { resultProjection: "preserve", historyCompaction: "summarize" } },
    })
    const changedPolicy = await evaluateToolPermission(changedPolicyTool, { target: "same" }, context({ toolCallId: "changed-policy" }))
    expect(changedPolicy.decision, "工具策略变化后旧会话授权仍被复用").toBe("ask")
  })

  it("已取消的确认不得重新挂起或放行 [permission-aborted-confirm]", async () => {
    const controller = new AbortController()
    const result = await evaluateToolPermission(tool({ safetyLevel: "SAFE", policy: policy({ defaultDecision: "ask" }) }), {}, context())
    expect(result.request, "没有生成可取消的确认请求").toBeDefined()
    controller.abort()
    const confirmation = await awaitPermission(result.request!, context({ signal: controller.signal }))
    expect(confirmation, "已取消确认没有立即拒绝").toBe("deny")
  })
})
