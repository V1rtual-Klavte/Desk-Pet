import { createHash } from "node:crypto"
import { captureProactiveOwner, initChat } from "@/services/agent/runner"
import { errorCode } from "@/services/error"
import { getHostBridge } from "@/services/host"
import type { ProactiveOwner, ProactiveSourceRef } from "@/services/proactive/protocol"
import type { SchedulerStateRequest } from "@/services/scheduler/protocol"
import { taskContentFingerprint } from "@/services/user-tasks"
import type { UserTaskDefinition } from "@/services/user-tasks"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import type { SceneDef } from "../../types"

let provider: ReturnType<typeof installFakeProvider> | undefined
let checkStorage: (() => Promise<void>) | undefined

async function expectNativeRejection(action: () => Promise<unknown>, code: "MEMORY" | "MEMORY_CONFLICT"): Promise<void> {
  let rejected: unknown
  try { await action() } catch (error) { rejected = error }
  if (!rejected || errorCode(rejected) !== code) throw new Error(`真实 Rust 命令应拒绝 ${code}，实际 ${errorCode(rejected) ?? "accepted"}`)
}

export const 统一调度持久账本: SceneDef = {
  meta: {
    caseId: "scheduler-native-durable-ledger",
    module: "proactive",
    contractId: "pr-18",
    description: "真实 Rust IPC 的用户任务隔离、周期样本不可改写、就绪产物与延后保版本、精确回执及晚到结果守卫；拒绝提醒保留现实事项并阻止重新派生",
    depth: "deep",
    suite: "safety",
    entry: "runtime",
    tags: ["scheduler", "persistence", "owner", "boundary", "error"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("调度账本检查完成，我们继续聊吧。")])
    await initChat()
    const owner = await captureProactiveOwner()
    if (!owner) throw new Error("持久账本场景缺少真实会话与 Card owner")
    const host = getHostBridge()
    const id = crypto.randomUUID(), taskId = `scheduler-scene-${id}`, sourceId = `scheduler-source-${id}`
    const entryId = `scheduler-entry-${id}`, eventId = `scheduler-event-${id}`
    const evidence = "每天 18:00–22:00 随机提醒起来走走，一到三次，至少间隔半小时。"
    const contentHash = createHash("sha256").update(evidence).digest("hex")
    const now = Date.now()
    await host.request("memory_register_sources", { sources: [{ sourceId, sessionId: owner.sessionId, entryId, eventId,
      seq: 1, contentHash, evidence, cardId: owner.cardId, observedAt: now, eligibleForMemory: true, origin: "user", taint: "trusted_user" }] })
    const reference: ProactiveSourceRef = { kind: "user_entry", id: sourceId, version: 1, revision: 1,
      scope: "session", scopeId: owner.sessionId, fingerprint: `${owner.sessionId}:${entryId}:${contentHash}`, validUntil: null }
    const definition: UserTaskDefinition = {
      kind: "reminder", text: "提醒起来走走",
      schedule: { calendar: { frequency: "daily", timezone: "UTC" },
        trigger: { kind: "window", start: "18:00", end: "22:00", selection: "random" },
        count: { kind: "random", min: 1, max: 3, per: "day" }, minGapMinutes: 30,
        validity: { from: now, until: null }, missedPolicy: "within_window" },
      execution: { thinkingEffort: "low" },
      delivery: { sessionId: owner.sessionId, cardId: owner.cardId, cardHash: owner.cardHash, windowMinutes: 15, expression: "自然提醒" },
    }
    const memoryStatus = await host.request("memory_status", {})
    const matterText = `活动事项-${id}`
    await host.request("memory_apply_change", { operationId: `matter-${id}`, baseRevision: memoryStatus.revision, action: "add",
      actor: "internal",
      draft: { content: matterText, summary: matterText, kind: "working", scope: "session", scopeId: owner.sessionId,
        aliases: [], pinned: false, importance: 0.7, confidence: 1, workingState: "open", sourceIds: [sourceId] } })
    const matter = (await host.request("memory_query", { query: matterText, scope: "session", scopeId: owner.sessionId, sessionId: owner.sessionId, limit: 10 })).find(item => item.draft.content === matterText)
    if (!matter) throw new Error("真实 Rust 未创建待提醒事项")
    const memoryRef: ProactiveSourceRef = { kind: "memory", id: matter.id, version: matter.version, revision: matter.version,
      scope: "session", scopeId: owner.sessionId, fingerprint: `${matter.id}:${matter.version}`, validUntil: null }
    const refs = [reference, memoryRef]
    definition.authorization = { trustedUserEventId: eventId, contentFingerprint: taskContentFingerprint(definition),
      sourceVersions: refs.map(({ kind, id, version, revision, fingerprint }) => ({ kind, id, version, revision, fingerprint })), capabilityGrants: [] }
    const snapshot = await host.request("schedule_query", { request: { owner, limit: 1 } })
    const created = await host.request("schedule_change", { request: { operationId: `create-${id}`, baseRevision: snapshot.revision,
      action: "create", owner, trustedUserEventId: eventId, sourceRefs: [reference], taskPatch: {
        id: taskId, scope: "session", scopeId: owner.sessionId, sourceRefs: refs, intent: definition,
        eventAt: null, dueAt: null, nextCheckinAt: now + 60_000, validUntil: null, timezone: "UTC", recurrence: null } } })
    if (!created.task || created.task.version !== 1) throw new Error("真实 Rust 未持久创建用户任务")
    const times = [now + 60_000, now + 31 * 60_000]
    const periodKey = `day-${id}`, occurrenceId = `${taskId}:v1:${periodKey}:0`, runId = `run-${id}`
    const state = (request: SchedulerStateRequest) => host.request("scheduler_state", { request })
    const period = { taskId, taskVersion: 1, periodKey, timezone: "UTC", from: now, until: now + 86_400_000, targetCount: 2, times }
    await state({ operation: "period_put", owner, operationId: `period-${id}`, now, period })
    const claimed = await state({ operation: "run_claim", owner, taskId, taskVersion: 1, occurrenceId, runId,
      leaseMs: 60_000, operationId: `claim-${id}`, now })
    if (!("run" in claimed) || !claimed.claimed || claimed.run?.runId !== runId) throw new Error("首次 occurrence 没有真实获得唯一运行身份")
    const ready = await state({ operation: "run_update", owner, taskId, taskVersion: 1, runId, expectedRevision: 1,
      status: "ready_to_deliver", artifact: { text: "提醒起来走走", evidence: [], audit: { source: "native-scene" } },
      operationId: `ready-${id}`, now: now + 1 })
    if (!("run" in ready) || ready.run?.status !== "ready_to_deliver") throw new Error("验收产物没有进入真实就绪账本")

    checkStorage = async () => {
      try {
        const again = await state({ operation: "period_get", owner, taskId, taskVersion: 1, periodKey })
        if (!("period" in again) || JSON.stringify(again.period?.times) !== JSON.stringify(times)) throw new Error("再次读取改变了周期样本")
        await expectNativeRejection(() => state({ operation: "period_put", owner, operationId: `resample-${id}`, now: now + 2,
          period: { ...period, times: [now + 59_000, times[1]!] } }), "MEMORY_CONFLICT")
        const duplicate = await state({ operation: "run_claim", owner, taskId, taskVersion: 1, occurrenceId,
          runId: `other-${id}`, leaseMs: 60_000, operationId: `duplicate-${id}`, now: now + 2 })
        if (!("run" in duplicate) || duplicate.claimed || duplicate.run?.runId !== runId || duplicate.run.status !== "ready_to_deliver") throw new Error("重复 occurrence 创建了第二次执行或丢失就绪产物")
        const beforeSnooze = await host.request("schedule_query", { request: { owner, taskId } })
        const snoozed = await host.request("schedule_change", { request: { operationId: `snooze-${id}`, baseRevision: beforeSnooze.revision,
          action: "snooze", owner, trustedUserEventId: eventId, sourceRefs: [reference], taskId, expectedVersion: 1,
          taskPatch: { nextCheckinAt: Date.now() + 120_000 } } })
        if (snoozed.task?.version !== 1) throw new Error("提醒延后错误改变了任务定义版本")
        const preserved = await state({ operation: "run_get", owner, taskId, taskVersion: 1, occurrenceId })
        if (!("run" in preserved) || preserved.run?.artifact?.text !== "提醒起来走走" || preserved.run.status !== "ready_to_deliver") throw new Error("延后丢失已完成产物")
        await expectNativeRejection(() => state({ operation: "run_update", owner, taskId, taskVersion: 1, runId,
          expectedRevision: 2, status: "delivered", attemptId: "missing", assistantEntryId: "missing",
          operationId: `forged-receipt-${id}`, now: now + 3 }), "MEMORY")
        const foreign: ProactiveOwner = { ...owner, sessionId: `other-${id}` }
        const hidden = await host.request("schedule_query", { request: { owner: foreign, taskId, includeResults: true } })
        if (hidden.tasks.length !== 0 || (hidden.recentResults?.length ?? 0) !== 0) throw new Error("用户任务或产物泄露到了其他会话")
        await expectNativeRejection(() => host.request("schedule_query", { request: { owner, operation: "slot_get" } as never }), "MEMORY")
        const latest = await host.request("schedule_query", { request: { owner, taskId } })
        await host.request("schedule_change", { request: { operationId: `cancel-${id}`, baseRevision: latest.revision,
          action: "cancel", owner, trustedUserEventId: eventId, sourceRefs: [reference], taskId, expectedVersion: 1 } })
        await expectNativeRejection(() => state({ operation: "run_update", owner, taskId, taskVersion: 1, runId,
          expectedRevision: 2, status: "ready_to_deliver", operationId: `late-${id}`, now: now + 4 }), "MEMORY_CONFLICT")
        const cancelled = await host.request("schedule_query", { request: { owner, taskId, statuses: ["cancelled"] } })
        if (cancelled.tasks.length !== 1 || cancelled.tasks[0]?.state !== "cancelled") throw new Error("取消状态未能从真实持久库分页查询")
        const preservedMatter = await host.request("memory_detail", { id: matter.id })
        if (preservedMatter?.version !== 1 || preservedMatter.draft.workingState !== "open") throw new Error("取消提醒改变了现实事项的版本或状态")
        const scanMatter = async () => {
          let targetCursor: string | undefined
          do {
            const scan = await host.request("proactive_scan", { request: { owner, now: Date.now(), localDate: new Date().toISOString().slice(0, 10), targetCursor, limit: 100 } })
            if (scan.memoryTargets.some(item => item.id === matter.id)) return true
            targetCursor = scan.nextTargetCursor ?? undefined
          } while (targetCursor)
          return false
        }
        if (await scanMatter()) throw new Error("拒绝提醒后事项仍进入自动派生候选")
        const renewedEvent = `renew-event-${id}`, renewedSource = `renew-source-${id}`, renewedEntry = `renew-entry-${id}`
        const renewedEvidence = "还是请你每天18:00提醒我起来走走"
        const renewedHash = createHash("sha256").update(renewedEvidence).digest("hex")
        await host.request("memory_register_sources", { sources: [{ sourceId: renewedSource, sessionId: owner.sessionId, entryId: renewedEntry,
          eventId: renewedEvent, seq: 2, contentHash: renewedHash, evidence: renewedEvidence, cardId: owner.cardId,
          observedAt: Date.now(), eligibleForMemory: true, origin: "user", taint: "trusted_user" }] })
        const renewedRef: ProactiveSourceRef = { ...reference, id: renewedSource, revision: 2, fingerprint: `${owner.sessionId}:${renewedEntry}:${renewedHash}` }
        const renew = async (stale: boolean) => {
          const sourceRefs = [renewedRef, stale ? { ...memoryRef, version: 99, revision: 99, fingerprint: `${matter.id}:99` } : memoryRef]
          const intent: UserTaskDefinition = { ...definition, authorization: { trustedUserEventId: renewedEvent,
            contentFingerprint: taskContentFingerprint(definition), capabilityGrants: [],
            sourceVersions: sourceRefs.map(({ kind, id, version, revision, fingerprint }) => ({ kind, id, version, revision, fingerprint })) } }
          const current = await host.request("schedule_query", { request: { owner, limit: 1 } })
          return host.request("schedule_change", { request: { operationId: `renew-${stale}-${id}`, baseRevision: current.revision,
            action: "create", owner, trustedUserEventId: renewedEvent, sourceRefs: [renewedRef], taskPatch: {
              id: `renewed-${stale}-${id}`, scope: "session", scopeId: owner.sessionId, sourceRefs, intent,
              eventAt: null, dueAt: null, nextCheckinAt: Date.now() + 60_000, validUntil: null, timezone: "UTC", recurrence: null } } })
        }
        await expectNativeRejection(() => renew(true), "MEMORY_CONFLICT")
        if (await scanMatter()) throw new Error("失败的新安排事务提前解除了提醒停用记录")
        const renewed = await renew(false)
        if (renewed.task?.state !== "active" || !await scanMatter()) throw new Error("用户重新明确安排后仍未解除提醒停用")
        const finalMatter = await host.request("memory_detail", { id: matter.id })
        if (finalMatter?.version !== 1 || finalMatter.draft.workingState !== "open") throw new Error("重新启用提醒改写了现实事项")
      } finally { provider?.restore() }
    }
  },
  turns: [{ index: 1, description: "核对真实 IPC 账本和拒绝边界，后续普通回合仍能响应", userText: "检查调度账本后继续聊天。",
    checks: [{ type: "expectSchedulerNativeDurabilityAndAuthority", run: async () => {
      if (!checkStorage || !provider || provider.payloads.length !== 1) throw new Error("场景未形成真实 Harness 回合与持久库前提")
      await checkStorage()
    } }] }],
}

export default 统一调度持久账本
