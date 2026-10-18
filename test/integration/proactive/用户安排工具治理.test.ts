// L3：真实工具注册/执行/参数治理；只替换宿主事务与已提交来源读取，不启动原生宿主。
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProactiveTask } from "@/services/proactive/protocol"
import type { ToolContext } from "@/services/tool/types"
import type { UserTaskDefinition } from "@/services/user-tasks/types"

const state = vi.hoisted(() => ({ evidence: "", eventId: "event-a", sources: [] as Array<Record<string, unknown>>, tasks: [] as Array<Record<string, unknown>>, changes: [] as Array<Record<string, unknown>>, request: vi.fn() }))
vi.mock("@/services/logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock("@/services/config", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/config")>()
  return { ...actual, proactiveConfig: { ...actual.proactiveConfig, frequency: "high", quietStartHour: 0, quietEndHour: 0 } }
})
vi.mock("@/services/host", () => ({ getHostBridge: () => ({ request: state.request }) }))
vi.mock("@/services/personality", () => ({ getActiveCard: () => ({ id: "card-a", hash: "hash-a" }), getActivePersonalityId: () => "card-a" }))
vi.mock("@/services/agent/memory", () => ({ collectMemorySources: async () => state.sources }))
vi.mock("@/services/proactive", () => ({ cancelCurrent() {}, createRuntimeTraceContext: () => ({}), proactiveEvent() {} }))
vi.mock("@/services/user-tasks/runtime", () => ({ startUserTaskRuntime() {}, stopUserTaskRuntime() {} }))

import { clearAll, getToolByName, register } from "@/services/tool/registry"
import { defineTool, getToolHandler } from "@/services/tool/policy"
import { TOOL_POLICY_VERSION } from "@/services/tool/types"
import { registerScheduleTools } from "@/services/tool/local-extra/schedule"
import { taskContentFingerprint } from "@/services/user-tasks/proposals"
import { taskCapabilityFingerprint } from "@/services/user-tasks/capabilities"

const now = Date.parse("2026-10-18T12:00:00Z")
function definition(): UserTaskDefinition {
  return { text: "提醒起来走走", kind: "reminder", execution: { thinkingEffort: "low" }, schedule: {
    calendar: { frequency: "daily", timezone: "UTC" }, trigger: { kind: "at", time: "18:00" }, count: { kind: "fixed", value: 1, per: "day" },
    minGapMinutes: 0, validity: { from: now, until: null }, missedPolicy: "within_window",
  } }
}
function source(eventId: string, evidence: string, seq = 1) {
  return { sourceId: `source-${eventId}`, sessionId: "session-a", entryId: `entry-${eventId}`, eventId, seq, contentHash: `hash-${eventId}`, evidence }
}
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { toolCallId: "call-a", operationId: "operation-a", trustedUserEventId: state.eventId, sessionId: "session-a", runGeneration: 1, isCurrent: () => true, ...overrides }
}
async function invoke(params: Record<string, unknown>, ctx = context()) {
  const tool = getToolByName("schedule_change")!
  return getToolHandler(tool)!(params, ctx)
}
function persisted(value: UserTaskDefinition, until: number | null = null): ProactiveTask {
  return { id: "task-a", version: 2, scope: "session", scopeId: "session-a", sourceRefs: [], intent: value as unknown as Record<string, unknown>, eventAt: null, dueAt: null,
    nextCheckinAt: now + 1_000, validUntil: until, timezone: "UTC", recurrence: null, state: "active", createdAt: now - 1_000, updatedAt: now }
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(Date, "now").mockReturnValue(now)
  clearAll(); registerScheduleTools()
  state.evidence = "每天18:00提醒起来走走"; state.eventId = "event-a"; state.sources = [source(state.eventId, state.evidence)]; state.tasks = []; state.changes = []
  state.request.mockReset().mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "schedule_query") return { revision: 7, tasks: state.tasks.filter(task => args.request.taskId === undefined || task.id === args.request.taskId), nextCursor: null }
    if (command === "schedule_change") {
      state.changes.push(args.request)
      const patch = (args.request.taskPatch ?? {}) as Record<string, unknown>
      return { revision: 8, task: { ...state.tasks[0], ...patch, id: args.request.taskId ?? patch.id, version: 3 } }
    }
    throw new Error(`unexpected_host_command:${command}`)
  })
})

describe("用户安排工具治理", () => {
  it("只注册新工具名，系统控制 action 在事务前被拒绝 [schedule-tool-surface]", async () => {
    expect(getToolByName("proactive_query")).toBeUndefined()
    expect(getToolByName("proactive_change")).toBeUndefined()
    const result = await invoke({ action: "control", muteUntil: now + 1_000 })
    expect(result.success).toBe(false)
    expect(state.changes).toEqual([])
  })
  it("未完成草案返回缺失时刻且不创建，完整指令直接提交冻结归属 [schedule-propose-create-closure]", async () => {
    const draft = definition()
    const incomplete = await invoke({ action: "propose", task: { ...draft, schedule: { ...draft.schedule, trigger: { kind: "at" } } } })
    expect(JSON.parse(incomplete.content)).toMatchObject({ status: "needs_clarification", missing: ["schedule.trigger.time"] })
    expect(state.changes).toEqual([])
    const created = await invoke({ action: "create", task: definition() })
    expect(JSON.parse(created.content).status).toBe("created")
    const patch = state.changes[0]!.taskPatch as { intent: UserTaskDefinition; recurrence: unknown; nextCheckinAt: number }
    expect(patch.intent.delivery).toEqual({ sessionId: "session-a", cardId: "card-a", cardHash: "hash-a", windowMinutes: 15, expression: "按当前 Card 自然表达" })
    expect(patch.intent.authorization).toMatchObject({ trustedUserEventId: "event-a", contentFingerprint: taskContentFingerprint(patch.intent), capabilityGrants: [] })
    expect(patch.recurrence).toBeNull()
    expect(patch.nextCheckinAt).toBe(Date.parse("2026-10-18T18:00:00Z"))
  })
  it("短同意仅接受真实提议，参数和来源变化分别阻止提交 [schedule-proposal-source-binding]", async () => {
    state.sources = [source("event-a", "晚上提醒起来走走")]
    const proposed = await invoke({ action: "propose", task: definition() })
    const proposal = { ...JSON.parse(proposed.content).proposal, assistantEntryId: "assistant-a" }
    state.eventId = "event-b"; state.sources.push(source("event-b", "好，就这样", 2))
    const turn = { text: "", taskRefs: [], memoryRefs: [], scheduleProposals: [proposal] }
    const accepted = await invoke({ action: "create", task: definition(), proposalId: "call-a" }, context({ proactiveTurnContext: turn }))
    expect(accepted.success).toBe(true)
    expect(state.changes).toHaveLength(1)
    expect((state.changes[0]!.taskPatch as { intent: UserTaskDefinition }).intent.authorization?.sourceVersions.map(ref => ref.id)).toEqual(["source-event-b", "source-event-a"])
    const changed = await invoke({ action: "create", task: { ...definition(), schedule: { ...definition().schedule, trigger: { kind: "at", time: "19:00" } } }, proposalId: "call-a" }, context({ proactiveTurnContext: turn }))
    expect(changed.success).toBe(false)
    state.sources[0]!.contentHash = "changed-source-hash"
    const stale = await invoke({ action: "create", task: definition(), proposalId: "call-a" }, context({ proactiveTurnContext: turn }))
    expect(stale.success).toBe(false)
    expect(stale.error).toContain("来源版本")
    expect(state.changes).toHaveLength(1)
  })
  it("延后只提交提醒投影，保留事项时间与原有效期 [proactive-recurrence-snooze-validity]", async () => {
    state.tasks = [persisted(definition(), now + 3_600_000) as unknown as Record<string, unknown>]
    const result = await invoke({ action: "snooze", taskId: "task-a", expectedVersion: 2, nextCheckinAt: now + 1_800_000 })
    expect(result.success).toBe(true)
    expect(state.changes[0]!.taskPatch).toEqual({ nextCheckinAt: now + 1_800_000 })
    expect((await invoke({ action: "snooze", taskId: "task-a", expectedVersion: 2, nextCheckinAt: now + 3_600_000 })).success).toBe(false)
    expect((await invoke({ action: "snooze", taskId: "task-a", expectedVersion: 2, nextCheckinAt: now + 1_000, task: { schedule: {} } })).success).toBe(false)
    expect(state.changes).toHaveLength(1)
  })
  it("完成/取消不携带任务补丁，改期不携带 recurrence [schedule-patch-shape]", async () => {
    state.tasks = [persisted(definition()) as unknown as Record<string, unknown>]
    state.evidence = "我已经完成了这件事"; state.sources = [source(state.eventId, state.evidence)]
    const done = await invoke({ action: "complete", taskId: "task-a", expectedVersion: 2 })
    expect(done.success).toBe(true)
    expect(state.changes[0]!.taskPatch).toBeUndefined()

    state.evidence = "取消这个提醒"; state.sources = [source(state.eventId, state.evidence)]
    const cancelled = await invoke({ action: "cancel", taskId: "task-a", expectedVersion: 2 })
    expect(cancelled.success).toBe(true)
    expect(state.changes[1]!.taskPatch).toBeUndefined()

    state.evidence = "每天提醒起来走走，改成19:00"; state.sources = [source(state.eventId, state.evidence)]
    const rescheduled = await invoke({ action: "reschedule", taskId: "task-a", expectedVersion: 2,
      task: { schedule: { ...definition().schedule, trigger: { kind: "at", time: "19:00" } } } })
    expect(rescheduled.success).toBe(true)
    const patch = state.changes[2]!.taskPatch as Record<string, unknown>
    expect(patch.recurrence).toBeUndefined()
    expect(patch.intent).toBeDefined()
  })
  it("明确只读MCP可持久授权，未声明或破坏性提示不能准入 [schedule-mcp-capability-grants]", async () => {
    const mcp = defineTool({ id: "mcp-news", name: "mcp_news_search", description: "新闻搜索", parameters: { type: "object", properties: { query: { type: "string" } } }, source: "mcp", sourceId: "news", safetyLevel: "DANGER", actionCategory: "_default",
      mcpAnnotations: { readOnlyHint: true, destructiveHint: false }, policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "passthrough" }, execution: { effect: "external_side_effect", isolation: "exclusive_effect", replay: "never" }, context: { resultProjection: "reference", historyCompaction: "summarize" } } }, async () => ({ success: true, content: "news" }))
    register(mcp)
    const job: UserTaskDefinition = { ...definition(), text: "整理新闻", kind: "agent_job", work: { goal: "整理新闻", inputs: [], capabilities: [mcp.name], output: "三条摘要及来源", completion: "找到三条已核验新闻" } }
    state.sources = [source("event-a", "每天18:00帮我整理新闻")]
    expect((await invoke({ action: "create", task: job })).success).toBe(true)
    const grant = (state.changes[0]!.taskPatch as { intent: UserTaskDefinition }).intent.authorization?.capabilityGrants
    expect(grant).toEqual([{ toolName: mcp.name, descriptorHash: taskCapabilityFingerprint(mcp) }])
    register(defineTool({ ...mcp, mcpAnnotations: { readOnlyHint: true, destructiveHint: true } }, async () => ({ success: true, content: "unused" })))
    const rejected = await invoke({ action: "create", task: job })
    expect(rejected.success).toBe(false)
    expect(JSON.parse(rejected.content).status).toBe("needs_input")
    expect(state.changes).toHaveLength(1)
  })
  it("提交结果未知时读取原operationId回执且不重复创建 [schedule-unknown-commit-recovery]",async()=>{
    const result={revision:9,task:{id:"committed-task",version:1}} as unknown as import("@/services/scheduler/protocol").ScheduleChangeResponse
    state.request.mockReset()
    state.request.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
      if(command==="schedule_change")return Promise.reject(new Error("connection closed after commit"))
      if(command==="schedule_query"&&args.request.operationId==="stable-operation")return {revision:9,tasks:[],nextCursor:null,operationReceipt:{operationId:"stable-operation",status:"committed",result}}
      return Promise.reject(new Error("unexpected recovery request"))
    })
    const {changeUserTask}=await import("@/services/user-tasks/client")
    const recovered=await changeUserTask({owner:{sessionId:"session-a",cardId:"card-a",cardHash:"hash-a",runGeneration:1},operationId:"stable-operation",baseRevision:8,action:"create",trustedUserEventId:"event-a",sourceRefs:[],taskPatch:{}})
    expect(recovered).toEqual(result)
    expect(state.request.mock.calls.map(call=>call[0])).toEqual(["schedule_change","schedule_query"])
    expect(state.request.mock.calls[1]![1].request.operationId).toBe("stable-operation")
  })

})
