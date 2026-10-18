// L3：MCP adapter、真实工具descriptor与PermissionKernel；不连接外部MCP或Provider。
import { describe, expect, it } from "vitest"
import { McpClient } from "@/services/tool/mcp/client"
import { isTaskReadCapability, taskCapabilityFingerprint, taskCapabilityScopeAllows } from "@/services/user-tasks/capabilities"
import { evaluateToolPermission } from "@/services/safety/permission"
import type { UserTaskDefinition } from "@/services/user-tasks/types"

const client = new McpClient("news")
function tools(readOnlyHint?: boolean, destructiveHint?: boolean) {
  return client.toToolDefs("news", [{ name: "search", description: "检索公共新闻", annotations: { readOnlyHint, destructiveHint },
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, options: { type: "object", additionalProperties: false,
      properties: { paths: { type: "array", items: { type: "string" } }, url: { type: "string", format: "uri" } } } }, required: ["query"] } }])
}
function task(tool: ReturnType<typeof tools>[number]): UserTaskDefinition {
  return { text: "整理新闻", kind: "agent_job", execution: { thinkingEffort: "medium" },
    schedule: { calendar: { frequency: "daily", timezone: "UTC" }, trigger: { kind: "at", time: "18:00" }, count: { kind: "fixed", value: 1, per: "day" }, minGapMinutes: 0,
      validity: { from: 1, until: null }, missedPolicy: "within_window" },
    work: { goal: "整理新闻", inputs: ["/allowed"], capabilities: [tool.name], output: "摘要及来源", completion: "找到三条新闻" },
    authorization: { trustedUserEventId: "user-a", contentFingerprint: "task-hash", sourceVersions: [{ kind: "user_entry", id: "source-a", version: 1, revision: 1, fingerprint: "source-hash" }],
      capabilityGrants: [{ toolName: tool.name, descriptorHash: taskCapabilityFingerprint(tool) }] },
  }
}
describe("用户任务能力授权", () => {
  it("MCP读提示保留完整schema但不降低原风险、串行或不重放策略 [schedule-mcp-descriptor-preservation]", () => {
    const [tool] = tools(true, false)
    expect(tool!.parameters).toEqual({ type: "object", additionalProperties: false, properties: { query: { type: "string" }, options: { type: "object", additionalProperties: false,
      properties: { paths: { type: "array", items: { type: "string" } }, url: { type: "string", format: "uri" } } } }, required: ["query"] })
    expect(tool!.mcpAnnotations).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(tool!.safetyLevel).toBe("DANGER")
    expect(tool!.policy.execution).toMatchObject({ effect: "external_side_effect", isolation: "exclusive_effect", replay: "never" })
    expect(isTaskReadCapability(tool!)).toBe(true)
    expect(isTaskReadCapability(tools(undefined, false)[0]!)).toBe(false)
    expect(isTaskReadCapability(tools(true, true)[0]!)).toBe(false)
  })
  it("schema或读提示变化使授权描述hash变化，嵌套路径与私网URL均须受scope约束 [schedule-capability-scope-fingerprint]", () => {
    const tool = tools(true, false)[0]!, definition = task(tool)
    expect(taskCapabilityFingerprint({ ...tool, parameters: { ...tool.parameters, required: ["query", "options"] } })).not.toBe(taskCapabilityFingerprint(tool))
    expect(taskCapabilityFingerprint({ ...tool, mcpAnnotations: { readOnlyHint: true, destructiveHint: true } })).not.toBe(taskCapabilityFingerprint(tool))
    expect(taskCapabilityScopeAllows(tool, { query: "AI 新闻", options: { paths: ["/allowed/report.md"], url: "https://example.com/news" } }, definition)).toBe(true)
    expect(taskCapabilityScopeAllows(tool, { query: "AI 新闻", options: { paths: ["/allowed-else/report.md"] } }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, { options: [{ filePath: "/allowed/../secret" }] }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, { options: { url: "http://127.0.0.1/admin" } }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, { options: { url: "http://0x7f000001/admin" } }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, { options: { url: "https://192.168.1.3/status" } }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, { options: { url: "http://[::1]/" } }, definition)).toBe(false)
    expect(taskCapabilityScopeAllows(tool, {}, { ...definition, authorization: undefined })).toBe(false)
  })
  it("读提示不能直接授权，PermissionKernel仅接受精确持久任务grant且保留deny-first [schedule-capability-permission-kernel]", async () => {
    const tool = tools(true, false)[0]!, definition = task(tool)
    const base = { sessionId: "session-a", runGeneration: 1, toolCallId: "call-a", policy: { safetyMode: "tell_me" as const, sessionTrustEnabled: false }, isCurrent: () => true }
    expect((await evaluateToolPermission(tool, { query: "新闻" }, base)).decision).toBe("ask")
    const authorized = { ...base, taskAuthorization: { reference: "task-hash", taskId: "task-a", taskVersion: 1,
      authorize: async (candidate: typeof tool, params: Record<string, unknown>) => taskCapabilityScopeAllows(candidate, params, definition) } }
    expect((await evaluateToolPermission(tool, { query: "新闻" }, authorized)).decision).toBe("allow")
    expect((await evaluateToolPermission(tool, { options: { url: "http://localhost/" } }, authorized)).decision).toBe("ask")
    const denied = { ...tool, policy: { ...tool.policy, permission: { defaultDecision: "deny" as const } } }
    expect((await evaluateToolPermission(denied, { query: "新闻" }, authorized)).decision).toBe("deny")
  })
})
