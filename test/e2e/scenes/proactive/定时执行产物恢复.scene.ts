import { captureProactiveOwner, initChat, sendMessage } from "@/services/agent/runner"
import { collectMemorySources } from "@/services/agent/memory"
import { getHostBridge } from "@/services/host"
import { stop as stopProactive } from "@/services/proactive"
import type { ProactiveOwner, ProactiveSourceRef } from "@/services/proactive"
import { internalScheduler } from "@/services/scheduler"
import type { SchedulerRunRecord } from "@/services/scheduler"
import { createNewSession, getActiveSessionId } from "@/services/session"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolContext } from "@/services/tool"
import { startUserTaskRuntime, stopUserTaskRuntime, taskCapabilityFingerprint, taskContentFingerprint } from "@/services/user-tasks"
import type { UserTaskDefinition } from "@/services/user-tasks"
import { fakeText, fakeToolCall, installFakeProvider } from "../../../host/fake-provider"
import { sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../types"

const PROBE_TOOL_ID = "scheduler-l4-readonly-probe"
const PROBE_TOOL_NAME = "scheduler_l4_readonly_probe"
const SOURCE_URL = "https://example.com/scheduler-material"
const RESULT_TEXT = "探针材料已整理。"
const COMPLETION = "成功读取一次探针材料并返回摘要和该资料链接"
const EXPECTED_TEXT = `${RESULT_TEXT}\n\n来源链接已于本轮获取，发布时间未核实。`
let provider: ReturnType<typeof installFakeProvider> | undefined
let savedRun: SchedulerRunRecord | undefined
let owner: ProactiveOwner | undefined
let taskId = "", currentSession = "", eventId = ""
let sourceRefs: ProactiveSourceRef[] = []
let probeCalls: Array<{ ownerSession: string | undefined; activeSession: string; taskId: string | undefined; version: number | undefined; mode: ToolContext["permissionMode"] }> = []
let beforeEntryIds: string[] = [], afterEntryIds: string[] = []

export const 定时执行产物恢复: SceneDef = {
  meta: {
    caseId: "scheduled-native-work-result",
    module: "proactive",
    contractId: "pr-18",
    description: "真实已提交用户来源创建执行任务，非活跃会话经统一调度启动真实子运行，保存工具/模型/用量证据且第二轮不重复执行",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["scheduler", "sub-agent", "artifact", "persistence", "owner", "boundary"],
  },
  setup: async () => {
    await stopProactive()
    await stopUserTaskRuntime()
    savedRun = undefined; owner = undefined; taskId = ""; sourceRefs = []; probeCalls = []
    const marker = crypto.randomUUID()
    const tool = defineTool({
      id: PROBE_TOOL_ID, name: PROBE_TOOL_NAME, description: "只读测试夹具资料，返回已存在的资料内容和链接",
      parameters: { type: "object", additionalProperties: false, properties: { topic: { type: "string", enum: ["scheduler-material"] } }, required: ["topic"] },
      safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "os.info",
      policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "allow" },
        execution: { effect: "read", isolation: "shared_read", replay: "safe" },
        context: { resultProjection: "preserve", historyCompaction: "summarize" } },
    }, async (params, ctx) => {
      if (params.topic !== "scheduler-material") return { success: false, content: "", error: "未知夹具资料" }
      probeCalls.push({ ownerSession: ctx.sessionId, activeSession: getActiveSessionId(), taskId: ctx.taskAuthorization?.taskId,
        version: ctx.taskAuthorization?.taskVersion, mode: ctx.permissionMode })
      return { success: true, content: JSON.stringify({ text: "探针材料描述：统一调度使用一个进程内定时器，各领域保留执行与交付裁决。", url: SOURCE_URL }) }
    })
    register(tool)
    provider = installFakeProvider([
      fakeText("已收到这次只读任务的指示。"),
      fakeToolCall(PROBE_TOOL_NAME, { topic: "scheduler-material" }, `probe-${marker}`),
      fakeText(JSON.stringify({ text: RESULT_TEXT, completed: true, criterion: COMPLETION, sources: [{ url: SOURCE_URL, title: "调度夹具资料" }] })),
      fakeText("后台工作已保存，我们继续当前会话。"),
    ], { id: "scheduler-l4-reasoning", name: "Scheduler L4 Reasoning", reasoning: true })
    try {
      await initChat()
      const userInstruction = `任务授权标记 ${marker}：请安排一次只读任务，读取调度探针资料，整理摘要和链接；思考档位 low，结果留在本会话等待我回来。`
      const committed = await sendMessage(userInstruction)
      if (committed.outcome !== "succeeded" || committed.persistFailed) throw new Error("真实用户指示未完成持久提交")
      owner = await captureProactiveOwner()
      if (!owner) throw new Error("执行任务场景没有真实会话/Card owner")
      // Read the source admitted from the actual JSONL ingress. No synthetic user
      // event or fabricated provenance is inserted into the owner's conversation.
      const sources = (await collectMemorySources(owner.sessionId)).filter(source => source.evidence === userInstruction)
      if (sources.length !== 1) throw new Error("真实用户指示没有形成唯一可信来源")
      const source = sources[0]!
      eventId = source.eventId
      sourceRefs = [{ kind: "user_entry", id: source.sourceId, version: 1, revision: source.seq, scope: "session", scopeId: owner.sessionId,
        fingerprint: `${source.sessionId}:${source.entryId}:${source.contentHash}`, validUntil: null }]
      const now = Date.now(), date = new Date(now).toISOString().slice(0, 10)
      const time = (instant: number) => new Date(instant).toISOString().slice(11, 16)
      const definition: UserTaskDefinition = {
        kind: "agent_job", text: "整理调度探针资料",
        schedule: { calendar: { frequency: "once", timezone: "UTC", date },
          trigger: { kind: "window", start: time(now), end: time(now + 30 * 60_000), selection: "spread" },
          count: { kind: "fixed", value: 1, per: "once" }, minGapMinutes: 0,
          validity: { from: now - 1000, until: now + 60 * 60_000 }, missedPolicy: "within_window" },
        execution: { thinkingEffort: "low" },
        work: { goal: "整理调度探针材料", inputs: [], capabilities: [PROBE_TOOL_NAME], output: "资料摘要和来源链接", completion: COMPLETION },
        delivery: { sessionId: owner.sessionId, cardId: owner.cardId, cardHash: owner.cardHash, windowMinutes: 15, expression: "根据已有产物自然表达" },
      }
      definition.authorization = { trustedUserEventId: eventId, contentFingerprint: taskContentFingerprint(definition),
        sourceVersions: sourceRefs.map(({ kind, id, version, revision, fingerprint }) => ({ kind, id, version, revision, fingerprint })),
        capabilityGrants: [{ toolName: PROBE_TOOL_NAME, descriptorHash: taskCapabilityFingerprint(tool) }] }
      taskId = `work-scene-${marker}`
      const host = getHostBridge()
      const snapshot = await host.request("schedule_query", { request: { owner, limit: 1 } })
      const created = await host.request("schedule_change", { request: { operationId: `create-work-${marker}`, baseRevision: snapshot.revision,
        action: "create", owner, trustedUserEventId: eventId, sourceRefs, taskPatch: {
          id: taskId, scope: "session", scopeId: owner.sessionId, sourceRefs, intent: definition,
          eventAt: null, dueAt: null, nextCheckinAt: now - 1000, validUntil: definition.schedule.validity.until, timezone: "UTC", recurrence: null } } })
      if (created.task?.version !== 1) throw new Error("真实 Rust 未创建执行任务")
      beforeEntryIds = (await sessionEntries(owner.sessionId)).map(entry => entry.id)
      currentSession = (await createNewSession()).id
      if (currentSession === owner.sessionId) throw new Error("场景未切到独立的非 owner 会话")
      startUserTaskRuntime()
      await internalScheduler.drain()
      let first = await host.request("scheduler_state", { request: { operation: "run_list", owner, taskId, limit: 10 } })
      const deadline = Date.now() + 10_000
      while ((!("runs" in first) || first.runs[0]?.status === "executing" || !first.runs.length) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
        first = await host.request("scheduler_state", { request: { operation: "run_list", owner, taskId, limit: 10 } })
      }
      if (!("runs" in first) || first.runs.length !== 1 || first.runs[0]?.status !== "ready_to_deliver") throw new Error(`真实调度与子运行没有形成唯一就绪产物: ${JSON.stringify(first)}`)
      savedRun = first.runs[0]
      const firstProviderCalls = provider.payloads.length
      internalScheduler.wake("user_tasks")
      await internalScheduler.drain()
      const recovered = await host.request("scheduler_state", { request: { operation: "run_get", owner, taskId, taskVersion: 1, occurrenceId: savedRun.occurrenceId } })
      if (!("run" in recovered) || recovered.run?.runId !== savedRun.runId || recovered.run.status !== "ready_to_deliver") throw new Error("再次调度没有恢复同一就绪身份")
      if (provider.payloads.length !== firstProviderCalls || probeCalls.length !== 1) throw new Error("已有产物的再次调度重复执行了模型或只读工具")
      if (firstProviderCalls !== 3) throw new Error(`应只有可信主回合及两次子运行请求，实际 ${firstProviderCalls}`)
      afterEntryIds = (await sessionEntries(owner.sessionId)).map(entry => entry.id)
    } catch (error) {
      provider.restore()
      throw error
    } finally {
      await stopUserTaskRuntime()
        unregister(PROBE_TOOL_ID)
    }
  },
  turns: [{ index: 1, description: "停止调度后从真实持久库复核产物、授权 owner、用量和审计证据", userText: "当前会话继续聊天，不重做后台工作。",
    checks: [{ type: "expectScheduledNativeWorkEvidenceAndRecovery", run: async () => {
      try {
        if (!provider || !owner || !savedRun) throw new Error("场景前置未形成真实持久化结果")
        if (getActiveSessionId() !== currentSession || owner.sessionId === currentSession) throw new Error("后台执行擅自切回了任务会话")
        if (probeCalls.length !== 1 || probeCalls[0]?.ownerSession !== owner.sessionId || probeCalls[0].activeSession !== currentSession
          || probeCalls[0].taskId !== taskId || probeCalls[0].version !== 1 || probeCalls[0].mode !== "background") throw new Error("真实工具没有绑定持久任务授权与后台 owner")
        if (JSON.stringify(beforeEntryIds) !== JSON.stringify(afterEntryIds)) throw new Error("后台子运行直接向原会话写入了消息")
        if (savedRun.artifact?.text !== EXPECTED_TEXT) throw new Error("持久产物不匹配验收通过的资料摘要和来源披露")
        const execution = savedRun.artifact.execution
        const usage = execution?.usage as { inputTokens?: number; outputTokens?: number } | undefined
        if (execution?.modelId !== "scheduler-l4-reasoning" || execution.requestedThinkingEffort !== "low" || execution.thinkingAdaptation !== "native"
          || !(usage?.inputTokens && usage.inputTokens > 0) || !(usage.outputTokens && usage.outputTokens > 0)) throw new Error("运行未持久保存真实模型、思考适配与用量")
        const audit = savedRun.artifact.audit
        if (audit?.ownerKind !== "scheduled" || audit.sessionId !== owner.sessionId || audit.runId !== savedRun.runId
          || audit.requestId !== `sub-agent-${savedRun.runId}` || audit.reference !== `scheduler_runs:${savedRun.runId}`) throw new Error("持久子运行审计身份不完整或与业务运行断开")
        const evidence = savedRun.artifact.evidence as Array<{ toolName?: string; status?: string; sourceUrls?: string[]; completedAt?: number }> | undefined
        const read = evidence?.find(call => call.toolName === PROBE_TOOL_NAME && call.status === "done")
        if (!read || JSON.stringify(read.sourceUrls) !== JSON.stringify([SOURCE_URL]) || typeof read.completedAt !== "number") throw new Error("资料链接没有来自真实成功的工具回执")
        if (provider.payloads.length !== 4 || probeCalls.length !== 1) throw new Error("普通聊天或停止后恢复触发了重复工作")
        const host = getHostBridge()
        const persisted = await host.request("scheduler_state", { request: { operation: "run_get", owner, taskId, taskVersion: 1, occurrenceId: savedRun.occurrenceId } })
        if (!("run" in persisted) || persisted.run?.artifact?.text !== EXPECTED_TEXT || persisted.run.status !== "ready_to_deliver") throw new Error("运行停止后真实就绪产物未保留")
        const snapshot = await host.request("schedule_query", { request: { owner, taskId } })
        await host.request("schedule_change", { request: { operationId: crypto.randomUUID(), baseRevision: snapshot.revision, action: "cancel",
          owner, trustedUserEventId: eventId, sourceRefs, taskId, expectedVersion: 1 } })
      } finally { provider?.restore() }
    } }] }],
}

export default 定时执行产物恢复
