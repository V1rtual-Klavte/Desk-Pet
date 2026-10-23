import { defineTool } from "../policy"
import { getToolByName, listAll, register } from "../registry"
import { TOOL_POLICY_VERSION } from "../types"
import type { ToolContext } from "../types"
import { getActiveCard } from "@/services/personality"
import { collectMemorySources } from "@/services/agent/memory"
import { cancelCurrent, createRuntimeTraceContext, proactiveEvent } from "@/services/proactive"
import type { ProactiveOwner, ProactiveSourceRef, ProactiveTask } from "@/services/proactive"
import {
  acceptScheduleProposal, activeSchedulePeriods, changeUserTask, directScheduleAuthorization,
  nextSchedulePeriod, parseUserTaskDefinition, queryUserTasks, taskContentFingerprint, USER_TASK_OBSERVABLE_SIGNALS, validateTaskDefinition,
} from "@/services/user-tasks"
import type { ScheduleProposal, UserTaskDefinition } from "@/services/user-tasks"
import { taskDefinitionInputSchema } from "@/services/user-tasks/schema"
import { formatError } from "@/services/error"
import { isTaskReadCapability, taskCapabilityFingerprint } from "@/services/user-tasks/capabilities"
import { canonicalTaskContent, declineScheduleProposal, visibleScheduleProposals } from "@/services/user-tasks/proposals"
import { proactiveConfig } from "@/services/config"
import { proactiveFrequency, proactiveTierLimits } from "@/services/proactive/tiers"

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
function owner(ctx: ToolContext): ProactiveOwner {
  const card = getActiveCard()
  if (!ctx.sessionId || ctx.runGeneration === undefined || !card || !ctx.isCurrent?.()) throw new Error("用户任务必须绑定当前会话和运行代际")
  return { sessionId: ctx.sessionId, cardId: card.id, cardHash: card.hash, runGeneration: ctx.runGeneration }
}
function mergeTask(previous: unknown, changes: unknown): unknown {
  if (!object(changes)) return changes
  const result: Record<string, unknown> = object(previous) ? { ...previous } : {}
  for (const [key, value] of Object.entries(changes)) result[key] = object(value) ? mergeTask(result[key], value) : value
  return result
}
function changedPaths(value: unknown, prefix = ""): string[] {
  return object(value) ? Object.entries(value).flatMap(([key, child]) => changedPaths(child, prefix ? `${prefix}.${key}` : key)) : [prefix]
}
function targetTask(tasks: readonly ProactiveTask[], params: Record<string, unknown>): ProactiveTask {
  if (typeof params.taskId !== "string" || !Number.isInteger(params.expectedVersion)) throw new Error("修改须提供精确 taskId 和 expectedVersion")
  const task = tasks.find(row => row.id === params.taskId && row.version === params.expectedVersion)
  if (!task) throw new Error("目标缺失或版本已变化，请重新查询；不能猜选事项")
  return task
}
function firstWindow(definition: UserTaskDefinition, now: number): { from: number; until: number; awaitingEvent: boolean } | null {
  const schedule = definition.schedule
  let periods = activeSchedulePeriods(schedule, Math.max(now, schedule.validity.from))
  for (let index = 0; index < 400; index++) {
    for (const period of periods) {
      if (period.awaitingEvent) return { from: Math.max(now, period.from, schedule.validity.from), until: Math.min(period.until, schedule.validity.until ?? Infinity), awaitingEvent: true }
      const window = period.windows.find(row => row.until > now)
      if (window) return { from: window.from, until: window.until, awaitingEvent: false }
    }
    const last = periods[periods.length - 1]
    const next = last ? nextSchedulePeriod(schedule, last) : null
    if (!next) return null
    periods = [next]
  }
  return null
}
function sameSource(left: ProactiveSourceRef, right: ScheduleProposal["sourceVersions"][number]): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version && left.revision === right.revision && left.fingerprint === right.fingerprint
}

const queryTool = defineTool({ id: "local-schedule-query", name: "schedule_query",
  description: "分页查询当前用户/Card/会话可见的提醒、约定与执行型任务；支持精确 ID、状态与最近结果，返回稳定 cursor 和 id/version。只查询用户任务。",
  parameters: { type: "object", additionalProperties: false, properties: {
    operationId: { type: "string", description: "提交结果未知时按原操作身份对账，不重建任务" }, taskId: { type: "string" }, statuses: { type: "array", items: { type: "string", enum: ["active", "completed", "cancelled", "invalidated"] } },
    cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 }, includeResults: { type: "boolean" },
  } }, safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
  policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "passthrough" }, execution: { effect: "read", isolation: "shared_read", replay: "safe" }, context: { resultProjection: "preserve", historyCompaction: "summarize" } },
}, async (params, ctx) => {
  try {
    const frozen = owner(ctx)
    if (params.statuses !== undefined && (!Array.isArray(params.statuses) || !params.statuses.length || params.statuses.some(value => !["active", "completed", "cancelled", "invalidated"].includes(String(value))))) throw new Error("任务状态筛选无效")
    const result = await queryUserTasks({ owner: frozen, ...(typeof params.operationId === "string" ? { operationId: params.operationId } : {}), ...(typeof params.taskId === "string" ? { taskId: params.taskId } : {}),
      ...(Array.isArray(params.statuses) ? { statuses: params.statuses as ProactiveTask["state"][] } : {}),
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}), limit: Math.min(10, Math.max(1, Number(params.limit) || 2)), includeResults: params.includeResults === true })
    return { success: true, content: JSON.stringify(result) }
  } catch (error) { return { success: false, content: "", error: formatError(error) } }
})

const changeTool = defineTool({ id: "local-schedule-change", name: "schedule_change",
  description: "按本轮可信用户指示提议、创建、更新、改期、延后、完成或取消用户任务。task 是 {text,kind:reminder|agent_job,schedule,execution:{thinkingEffort:low|medium|high},work?,delivery?}。schedule 须含 calendar(IANA 时区+once/daily/weekly/monthly/yearly)、trigger(at/window/confirmed_anchor/observed_event)、count、minGapMinutes、validity、missedPolicy。propose 可用不完整草案；推断的关键参数须先提出具体安排并经用户确认，完整明确指令直接 create。update 仅改 task 中提供的字段。reschedule 更新 schedule 及事项锚；snooze 仅改 nextCheckinAt。complete 只用于用户明确报告现实事项完成。cancel 只停止提醒，不取消现实事项；拒绝未创建的提醒用 decline + proposalId，多提议短回复须先澄清。执行型任务首期仅只读能力；不提供任何系统调度或全局开关。",
  parameters: { type: "object", additionalProperties: false, properties: {
    action: { type: "string", enum: ["propose", "create", "update", "reschedule", "snooze", "complete", "cancel", "decline"] },
    proposalId: { type: "string" }, taskId: { type: "string" }, expectedVersion: { type: "integer", minimum: 1 },
    task: taskDefinitionInputSchema,
    nextCheckinAt: { type: "number", description: "仅 snooze 使用的未来 UTC 毫秒；不改变事项时间和有效期" },
    memoryItemId: { type: "string" }, expectedMemoryVersion: { type: "integer", minimum: 1 },
    eventAt: { type: "object", description: "记忆事项改期必须同步精确事项锚，day/localDate/timezone 或 minute/instant/timezone" }, dueAt: { type: "object" },
    targetAction: { type: "string", enum: ["update", "reschedule"], description: "propose 为现有任务形成提议时必须给出" },
  }, required: ["action"] }, safetyLevel: "NORMAL", source: "local", sourceId: "", actionCategory: "_default",
  policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "passthrough" }, execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" }, context: { resultProjection: "preserve", historyCompaction: "summarize" } },
}, async (params, ctx) => {
  try {
    const frozen = owner(ctx), now = Date.now(), action = String(params.action)
    if (!["propose", "create", "update", "reschedule", "snooze", "complete", "cancel", "decline"].includes(action)) throw new Error("不支持的用户任务 action")
    if (action === "decline" && [params.task, params.taskId, params.expectedVersion, params.eventAt, params.dueAt, params.memoryItemId, params.expectedMemoryVersion, params.targetAction].some(value => value !== undefined)) throw new Error("拒绝提议只接受 proposalId，不允许模型另选事项或修改内容")
    if (params.nextCheckinAt !== undefined && action !== "snooze") throw new Error("nextCheckinAt 仅可用于 snooze，事项改期须更新 schedule")
    if (["complete", "cancel"].includes(action) && (params.task !== undefined || params.eventAt !== undefined || params.dueAt !== undefined)) throw new Error("完成或取消不能同时修改安排")
    if (action === "create" && (params.taskId !== undefined || params.expectedVersion !== undefined)) throw new Error("新建不能指定已有任务身份")
    if (!ctx.trustedUserEventId) throw new Error("缺少本轮已提交可信用户事件")
    if (!ctx.operationId && !ctx.toolCallId) throw new Error("用户任务提交缺少稳定 operationId")
    const allSources = await collectMemorySources(frozen.sessionId)
    const sources = allSources.filter(source => source.eventId === ctx.trustedUserEventId)
    if (sources.length !== 1) throw new Error("本轮可信来源缺失或不唯一")
    const user = sources[0]!, evidence = user.evidence ?? ""
    if (action === "cancel" && !/取消|别再|不要再|不再|不用.*提醒|停止.*(?:提醒|任务)|删除.*(?:提醒|任务|约定)|\bcancel\b|\bstop\b.*\bremind/i.test(evidence)) throw new Error("取消须来自用户本轮明确指示")
    const userRefs: ProactiveSourceRef[] = allSources.map(source => ({ kind: "user_entry", id: source.sourceId, version: 1, revision: source.seq,
      scope: "session", scopeId: frozen.sessionId, fingerprint: `${source.sessionId}:${source.entryId}:${source.contentHash}`, validUntil: null }))
    const ref = userRefs.find(source => source.id === user.sourceId)!
    let sourceRefs: ProactiveSourceRef[] = [ref]
    if (params.memoryItemId !== undefined || params.expectedMemoryVersion !== undefined) {
      const memory = ctx.proactiveTurnContext?.memoryRefs.find(source => source.id === params.memoryItemId && source.version === params.expectedMemoryVersion && source.kind === "memory" && (source.validUntil === null || source.validUntil > now))
      if (!memory) throw new Error("记忆关联须匹配本轮冻结的有效 ID 和版本")
      sourceRefs.push(memory)
    }
    const declined = action === "decline" ? declineScheduleProposal(ctx.proactiveTurnContext?.scheduleProposals ?? [],
      typeof params.proposalId === "string" ? params.proposalId : undefined, frozen, evidence, now) : undefined
    if (declined) {
      const available = [...userRefs, ...(ctx.proactiveTurnContext?.memoryRefs ?? [])]
      for (const expected of declined.sourceVersions) {
        const matching = available.find(source => sameSource(source, expected) && (source.validUntil === null || source.validUntil > now))
        if (!matching) throw new Error("提议来源版本已变化或失效，请重新查询")
        if (matching.kind === "memory" && !sourceRefs.some(source => sameSource(source, expected))) sourceRefs.push(matching)
      }
    }
    const targetId = declined?.target?.taskId ?? (typeof params.taskId === "string" ? params.taskId : undefined)
    const state = await queryUserTasks({ owner: frozen, ...(targetId ? { taskId: targetId } : {}), statuses: ["active", "completed", "cancelled", "invalidated"], limit: 10 })
    const patch: Record<string, unknown> = {}
    let definition: UserTaskDefinition | undefined
    let first: ReturnType<typeof firstWindow> = null
    let limitations: string[] = []
    const target = declined ? (declined.target ? targetTask(state.tasks, declined.target) : undefined)
      : action !== "create" && (action !== "propose" || params.taskId !== undefined) ? targetTask(state.tasks, params) : undefined
    if (action === "cancel") {
      const proposals = visibleScheduleProposals(ctx.proactiveTurnContext?.scheduleProposals ?? [], frozen, now)
      const candidates = await queryUserTasks({ owner: frozen, statuses: ["active"], limit: 10 })
      const named = candidates.tasks.filter(task => {
        const purpose = typeof task.intent.text === "string" ? task.intent.text.replace(/^(?:请|帮我|提醒我|提醒|记得|按时|安排)+/g, "").trim() : ""
        return evidence.includes(task.id) || purpose.length >= 2 && evidence.includes(purpose)
      })
      if (!evidence.includes(target!.id) && (candidates.nextCursor ||
        (proposals.length > 0 || candidates.tasks.length > 1) && (named.length !== 1 || named[0]!.id !== target!.id))) {
        throw new Error("多个提醒或提议可能匹配，请先明确目标；拒绝提议须使用 decline")
      }
    }
    if (["create", "update", "reschedule", "propose"].includes(action)) {
      if (object(params.task) && params.task.authorization !== undefined) throw new Error("authorization 只能由运行时绑定")
      if (target && !parseUserTaskDefinition(target.intent)) throw new Error("该领域事项不能通过 rich task 更新；可延后、完成或取消")
      if (action === "reschedule" && (!object(params.task) || !object(params.task.schedule))) throw new Error("改期必须提供新的 schedule")
      if (target) for (const source of target.sourceRefs.filter(source => source.kind === "memory")) {
        if (source.validUntil !== null && source.validUntil <= now) throw new Error("原任务记忆来源已失效，请重新查询")
        if (!sourceRefs.some(existing => existing.kind === source.kind && existing.id === source.id)) sourceRefs.push(source)
      }
      const candidate = target ? mergeTask({ ...target.intent, authorization: undefined }, params.task) : structuredClone(params.task)
      if (object(candidate)) {
        if (candidate.delivery !== undefined && !object(candidate.delivery)) throw new Error("delivery 必须是对象")
        const delivery = object(candidate.delivery) ? candidate.delivery : {}
        if ((delivery.sessionId !== undefined && delivery.sessionId !== frozen.sessionId) || (delivery.cardId !== undefined && delivery.cardId !== frozen.cardId)
          || (delivery.cardHash !== undefined && delivery.cardHash !== frozen.cardHash)) throw new Error("交付目标必须属于当前会话和 Card")
        candidate.delivery = { windowMinutes: 15, expression: "按当前 Card 自然表达", ...delivery, sessionId: frozen.sessionId, cardId: frozen.cardId, cardHash: frozen.cardHash }
      }
      const frequency = proactiveFrequency(), limits = frequency === "off" ? null : proactiveTierLimits(frequency)
      const validation = validateTaskDefinition(candidate, { availableCapabilities: listAll().map(tool => tool.name), observableSignals: USER_TASK_OBSERVABLE_SIGNALS,
        deliveryConstraints: { enabled: frequency !== "off", dailySuccessLimit: limits?.dailySuccess ?? 0, cooldownMs: limits?.cooldownMs ?? 0,
          quietStartHour: proactiveConfig.quietStartHour, quietEndHour: proactiveConfig.quietEndHour, quietTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })
      if (action === "propose" && validation.status !== "ready") return { success: true, content: JSON.stringify({ ...validation, proposalId: ctx.toolCallId, definition: undefined }) }
      if (!validation.definition) return { success: false, content: JSON.stringify(validation), error: [...validation.missing, ...validation.errors].join("；") }
      definition = validation.definition
      limitations = validation.limitations
      let capabilityGrants: NonNullable<UserTaskDefinition["authorization"]>["capabilityGrants"] = []
      if (definition.kind === "agent_job") {
        const interactive = new Set(["ask_user", "plan", "agent_spawn", "schedule_change"])
        const unsupported = definition.work!.capabilities.filter(name => {
          const tool = getToolByName(name)
          return !tool || !isTaskReadCapability(tool) || interactive.has(name)
        })
        if (unsupported.length) return { success: false, content: JSON.stringify({ status: "needs_input", capabilities: unsupported }), error: "执行型任务首期仅支持已声明只读能力；副作用或交互需要新的用户授权" }
        capabilityGrants = definition.work!.capabilities.map(name => ({ toolName: name, descriptorHash: taskCapabilityFingerprint(getToolByName(name)!) }))
      }
      first = firstWindow(definition, now)
      if (!first || first.until <= now) {
        throw new Error(`安排没有未来有效窗口：calendar=${JSON.stringify(definition.schedule.calendar)} trigger=${JSON.stringify(definition.schedule.trigger)} validity=${JSON.stringify(definition.schedule.validity)}；请让触发时间落在 validity 内，或延长 validity.until`)
      }
      const proposalTarget: ScheduleProposal["target"] = target ? { taskId: target.id, expectedVersion: target.version,
        action: action === "propose" ? params.targetAction as "update" | "reschedule" : action as "update" | "reschedule" } : undefined
      if (proposalTarget && !["update", "reschedule"].includes(proposalTarget.action)) throw new Error("现有任务提议须指明 targetAction")
      if (action === "propose") {
        if (!ctx.toolCallId) throw new Error("提议缺少稳定调用身份")
        if (!ctx.isCurrent?.() || ctx.signal?.aborted) throw new Error("运行已失效")
        const proposal: Omit<ScheduleProposal, "assistantEntryId"> = { proposalId: ctx.toolCallId, definition, owner: frozen,
          contentFingerprint: taskContentFingerprint(definition), sourceVersions: sourceRefs.map(({ kind, id, version, revision, fingerprint }) => ({ kind, id, version, revision, fingerprint })),
          capabilityGrants,
          validUntil: Math.min(now + 7 * 86_400_000, definition.schedule.validity.until ?? Infinity), ...(proposalTarget ? { target: proposalTarget } : {}) }
        return { success: true, content: JSON.stringify({
          status: "needs_confirmation", proposal, firstWindow: first, limitations: validation.limitations,
          declineGuidance: "如果用户拒绝提醒，调用 schedule_change action=decline 并传入此 proposalId；保留现实事项，不要调用 memory_change cancel。存在多个提议且短回复未指明目标时先澄清。",
        }) }
      }
      const direct = directScheduleAuthorization(definition, evidence, now)
      const changes = changedPaths(params.task)
      const inferred = target ? direct.inferred.filter(path => path === "authorization" || changes.some(changed => path === changed || path.startsWith(`${changed}.`) || changed.startsWith(`${path}.`))) : direct.inferred
      const descriptorChanged = target && canonicalTaskContent(parseUserTaskDefinition(target.intent)?.authorization?.capabilityGrants ?? []) !== canonicalTaskContent(capabilityGrants)
      const needsProposal = params.proposalId !== undefined || descriptorChanged || (!direct.explicit && (!target || inferred.length > 0))
      let accepted: ScheduleProposal | undefined
      if (needsProposal) {
        accepted = acceptScheduleProposal(ctx.proactiveTurnContext?.scheduleProposals ?? [], typeof params.proposalId === "string" ? params.proposalId : undefined, frozen, definition, evidence, now, proposalTarget)
        if (canonicalTaskContent(accepted.capabilityGrants) !== canonicalTaskContent(capabilityGrants)) throw new Error("提议能力描述已变化，须重新确认")
        const available = [...userRefs, ...(ctx.proactiveTurnContext?.memoryRefs ?? [])]
        for (const expected of accepted.sourceVersions) {
          const matching = available.find(source => sameSource(source, expected) && (source.validUntil === null || source.validUntil > now))
          if (!matching) throw new Error("提议来源版本已变化或失效，请重新确认")
          if (!sourceRefs.some(source => sameSource(source, expected))) sourceRefs.push(matching)
        }
      }
      definition.authorization = { trustedUserEventId: ctx.trustedUserEventId, ...(accepted ? { proposalId: accepted.proposalId } : {}), contentFingerprint: taskContentFingerprint(definition),
        sourceVersions: sourceRefs.map(({ kind, id, version, revision, fingerprint }) => ({ kind, id, version, revision, fingerprint })), capabilityGrants }
      Object.assign(patch, { intent: definition, timezone: definition.schedule.calendar.timezone, ...(action === "reschedule" ? {} : { recurrence: null }), nextCheckinAt: first.awaitingEvent ? null : first.from,
        validUntil: definition.schedule.validity.until })
      if (action === "create") Object.assign(patch, { id: crypto.randomUUID(), scope: "session", scopeId: frozen.sessionId, sourceRefs, eventAt: params.eventAt ?? null, dueAt: params.dueAt ?? null })
      if (action === "reschedule") {
        if (target!.sourceRefs.some(source => source.kind === "memory") && params.eventAt === undefined && params.dueAt === undefined) throw new Error("记忆事项改期必须同步事项时间锚；仅延后提醒请用 snooze")
        if (params.eventAt !== undefined) patch.eventAt = params.eventAt
        if (params.dueAt !== undefined) patch.dueAt = params.dueAt
      } else if (params.eventAt !== undefined || params.dueAt !== undefined) {
        if (action !== "create") throw new Error("事项时间锚变更须使用 reschedule")
      }
    } else if (action === "snooze") {
      if (params.task !== undefined || params.eventAt !== undefined || params.dueAt !== undefined) throw new Error("延后只改变下次提醒时间")
      if (typeof params.nextCheckinAt !== "number" || !Number.isSafeInteger(params.nextCheckinAt) || params.nextCheckinAt <= now || (target!.validUntil !== null && params.nextCheckinAt >= target!.validUntil)) throw new Error("延后须在原有效期内使用合法未来时间")
      patch.nextCheckinAt = params.nextCheckinAt
    } else if (action === "complete" && (!/做完了|完成了|搞定了|已经.*(?:完|好)|标记.*完成|我.*(?:交了|结束了)/.test(evidence) || /(?:了吗|了么|了没|[?？])/.test(evidence))) throw new Error("完成须由用户明确报告现实事项完成，执行或送达不等于完成")
    if (!ctx.isCurrent?.() || ctx.signal?.aborted) throw new Error("运行已失效")
    cancelCurrent("task_governance_changed")
    const result = await changeUserTask({ operationId: ctx.operationId ?? ctx.toolCallId!, baseRevision: state.revision,
      action: declined && target ? "cancel" : action as "create" | "update" | "reschedule" | "snooze" | "complete" | "cancel" | "decline",
      owner: frozen, ...(target ? { taskId: target.id, expectedVersion: target.version } : {}), trustedUserEventId: ctx.trustedUserEventId, sourceRefs,
      ...(["complete", "cancel", "decline"].includes(action) ? {} : { taskPatch: patch }) })
    proactiveEvent(createRuntimeTraceContext(frozen.sessionId), "proactive_task", () => ({ operation: action, status: "committed", taskIds: result.task ? [result.task.id] : [], reason: "user_governance" }))
    return { success: true, content: JSON.stringify({ status: action === "create" && result.task ? "created" : "committed", ...result,
      ...(definition ? { arrangement: definition, firstWindow: first, limitations } : {}) }) }
  } catch (error) {
    if (ctx.sessionId) proactiveEvent(createRuntimeTraceContext(ctx.sessionId), "proactive_task", () => ({ operation: "governance", status: "failed", taskIds: [], reason: "validation_or_transaction_failed" }))
    return { success: false, content: "", error: formatError(error) }
  }
})

export function registerScheduleTools(): void { register(queryTool); register(changeTool) }
