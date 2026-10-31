// 子代理内核：delegation、Plan、主动与定时工作共用的唯一子运行出口。
// 纯搬移自 harness/runtime.ts（T1.5 抽出 harness 原语），不改变行为。

import { contentText } from "@earendil-works/pi-ai"
import { SUB_AGENT_DEFAULT_MAX_TOOL_CALLS, SUB_AGENT_DEFAULT_TIMEOUT_MS } from "@/services/agent/timeouts"
import { createRuntimeTraceContext, redactText } from "@/services/engine/protocol"
import type { HarnessRunHooks, PiAgentTurnOutput, PiSubAgentEvidence, PiSubAgentInput, PiSubAgentOutput } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { listAll } from "@/services/tool"
import type { HarnessToolRun } from "@/services/tool"
import { resolvePiAuxModel, toPiReasoningLevel } from "./model-gateway"
import { HarnessSlot } from "./slot"
import { createTurnKernel } from "./turn-kernel"
import type { TurnKernel } from "./turn-kernel"
import { createTurnSpec } from "./turn-spec"

// 日志分类沿用原 runtime.ts 的 PiRuntime：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/** Only actual successful tool receipts supply source references; never assistant prose. */
function childResultSourceUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const match of text.slice(0, 65_536).matchAll(/https?:\/\/[^\s<>"'`\\]+/g)) {
    if (urls.size >= 32) break
    const candidate = match[0].replace(/[),.;\]}]+$/, "")
    if (candidate.length > 2048 || redactText(candidate).text !== candidate) continue
    try {
      const url = new URL(candidate)
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|auth|(?:api[_-]?)?key|signature/i.test(key))) continue
      urls.add(url.href)
    } catch { /* A malformed URL is untrusted receipt text, not a source reference; the full tool receipt stays with its owner. */ }
  }
  return [...urls]
}

/** Publication dates require structured fields on the same actual receipt object as its URL. */
function childResultSources(content: Parameters<NonNullable<HarnessRunHooks["afterTool"]>>[0]["content"]): Array<{ url: string; publishedAt?: string }> {
  const sources = new Map<string, { url: string; publishedAt: string }>()
  let visited = 0
  const visit = (value: unknown, depth: number): void => {
    if (++visited > 256 || depth > 6 || !value || typeof value !== "object") return
    if (Array.isArray(value)) { for (const item of value.slice(0, 64)) visit(item, depth + 1); return }
    const row = value as Record<string, unknown>
    const rawUrl = typeof row.url === "string" ? row.url : typeof row.link === "string" ? row.link : undefined
    const date = row.publishedAt ?? row.published_at ?? row.datePublished ?? row.pubDate
    if (rawUrl && /^https?:\/\/[^\s]+$/.test(rawUrl) && typeof date === "string" && date.length <= 100) {
      const publishedAt = Date.parse(date)
      const url = childResultSourceUrls(rawUrl)[0]
      if (url && Number.isFinite(publishedAt) && publishedAt >= 0 && sources.size < 32) sources.set(url, { url, publishedAt: new Date(publishedAt).toISOString() })
    }
    for (const nested of Object.values(row).slice(0, 64)) visit(nested, depth + 1)
  }
  for (const part of content) {
    if (part.type !== "text" || part.text.length > 65_536) continue
    try { visit(JSON.parse(part.text), 0) }
    catch { /* Non-JSON receipt text still supplies URL evidence, but cannot establish a publication date. */ }
  }
  return [...sources.values()]
}

/** Sole child-run kernel for delegation, Plan, proactive and durable scheduled work. */
export async function runPiSubAgent(input: PiSubAgentInput): Promise<PiSubAgentOutput> {
  const owner = input.owner
  if (!owner?.runId || !owner.sessionId || typeof owner.isCurrent !== "function" || !["conversation", "plan", "proactive", "scheduled"].includes(owner.kind)) throw new Error("子运行必须绑定有效 owner")
  const requestId = `sub-agent-${owner.runId}`
  const evidence: PiSubAgentEvidence = { tools: [], incomplete: [], unconfirmedEffects: false }
  const audit = { ...(owner.kind === "plan" ? { planId: owner.planId, stepId: owner.stepId } : {}), ...input.audit, sessionId: input.audit?.sessionId ?? owner.sessionId, runId: owner.runId, requestId, ownerKind: owner.kind }
  let output: PiSubAgentOutput = { status: "failed", success: false, reply: "", toolCallsMade: 0, evidence, audit }
  const history: PiAgentTurnOutput["toolCallHistory"] = []
  const thinkingEffort = input.thinkingEffort ?? "low"
  const maxToolCalls = input.maxToolCalls ?? SUB_AGENT_DEFAULT_MAX_TOOL_CALLS
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + (input.timeoutMs ?? SUB_AGENT_DEFAULT_TIMEOUT_MS))
  const generation = owner.kind === "scheduled" ? owner.taskVersion : owner.runGeneration
  const background = input.permissionMode
    ? input.permissionMode === "background"
    : owner.kind === "scheduled" || owner.kind === "proactive"
  const current = () => !owner.signal?.aborted && owner.isCurrent()
  let slot: HarnessSlot | undefined
  let kernel: TurnKernel | undefined
  let detach: (() => void) | undefined
  let needsInput = false
  let permissionFailure: string | undefined
  const abortFromOwner = () => {
    void slot?.abort().catch(error => log.warn("子运行停止失败:", { runId: owner.runId }, formatError(error)))
  }
  try {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("子运行 owner 的版本或代际无效")
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) throw new Error("子运行 maxToolCalls 必须是非负整数")
    if (!Number.isFinite(deadlineAt)) throw new Error("子运行 deadline 必须有效")
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) throw new Error("子运行 maxOutputTokens 必须是正整数")
    if (!current()) return output = { ...output, status: "cancelled", error: "子运行 owner 已失效或取消" }
    if (deadlineAt <= Date.now()) return output = { ...output, status: "timed_out", error: "子运行已超过 deadline" }
    if (owner.kind === "scheduled" && (owner.authorization.taskId !== owner.taskId || owner.authorization.taskVersion !== owner.taskVersion || !owner.authorization.reference)) throw new Error("任务 owner 与持久授权不匹配")

    // Freeze model before any capability await; all callers share auxiliary-model routing.
    const baseModel = resolvePiAuxModel()
    const model = input.maxOutputTokens === undefined ? baseModel : { ...baseModel, maxTokens: Math.min(baseModel.maxTokens, input.maxOutputTokens) }
    const reasoningLevel = toPiReasoningLevel(thinkingEffort)
    const mappedReasoning = reasoningLevel && model.thinkingLevelMap && reasoningLevel in model.thinkingLevelMap ? model.thinkingLevelMap[reasoningLevel] : reasoningLevel
    const adaptation = thinkingEffort === "auto" ? "server_default" : model.reasoning && mappedReasoning !== null ? "native" : "unsupported"
    output.resolved = {
      modelId: model.id, provider: model.provider, requestedThinkingEffort: thinkingEffort,
      ...(reasoningLevel ? { reasoningLevel, reasoningParameter: mappedReasoning } : {}),
      thinkingAdaptation: adaptation, deadlineAt, maxToolCalls, maxOutputTokens: model.maxTokens, toolNames: [],
    }
    if (owner.kind === "scheduled" && adaptation === "unsupported") throw new Error(`模型 ${model.id} 不支持要求的思考档位 ${thinkingEffort}`)

    // MCP is borrowed by this run, including failures during acquisition, and always released below.
    const requested = input.tools.filter(tool => tool.policy.execution.isolation !== "delegate" &&
      (owner.kind !== "proactive" || tool.source !== "mcp" && tool.safetyLevel === "SAFE" && !tool.resolveSafetyLevel && tool.policy.execution.effect === "read"))
    const { acquireMcpServer } = await import("@/services/tool/mcp")
    const unavailableServers = new Set<string>()
    for (const server of new Set(requested.filter(tool => tool.source === "mcp").map(tool => tool.sourceId))) {
      if (!current()) return output = { ...output, status: "cancelled", error: "子运行 owner 已失效或取消" }
      const borrowed = await acquireMcpServer(server, requestId)
      if (!borrowed.success) { unavailableServers.add(server); evidence.incomplete.push(`MCP ${server}: ${borrowed.error ?? "连接失败"}`) }
    }
    const registry = new Map(listAll().map(tool => [tool.id, tool]))
    const tools = requested.flatMap(tool => {
      const actual = registry.get(tool.id)
      if (tool.source === "mcp" && unavailableServers.has(tool.sourceId)) return []
      return actual && actual.name === tool.name && actual.policy.execution.isolation !== "delegate" ? [actual] : []
    })
    const names = new Set(tools.map(tool => tool.name))
    const missing = (input.capabilities?.requiredToolNames ?? []).filter(name => !names.has(name))
    if (missing.length) throw new Error(`指定的工具不存在或不可用: ${missing.join("、")}`)
    output.resolved.toolNames = [...names]
    if (!current()) return output = { ...output, status: "cancelled", error: "子运行 owner 已失效或取消" }
    if (deadlineAt <= Date.now()) return output = { ...output, status: "timed_out", error: "子运行能力准备超过 deadline" }

    // 失败回执可能已经在执行端留下效果：不只外部系统，写盘与进程同样有副作用。
    // 只读工具失败没有可确认的效果，不算缺口；工具解析不到时按最保守处理。
    const failureMayHaveEffects = (toolName: string) =>
      tools.find(tool => tool.name === toolName)?.policy.execution.effect !== "read"
    const toolRun: HarnessToolRun = {
      sessionId: owner.sessionId, runGeneration: generation, isCurrent: current, history,
      pendingFailures: new Map(),
      ...((owner.kind === "conversation" || owner.kind === "plan") && owner.trustedUserEventId ? { trustedUserEventId: owner.trustedUserEventId } : {}),
      ...(owner.kind === "scheduled" ? { taskAuthorization: owner.authorization } : {}),
      permissionMode: background ? "background" : "interactive",
      onToolStart: async (toolName, toolCallId) => {
        evidence.tools.push({ toolName, toolCallId, status: "running" })
        await input.onToolStart?.(toolName, toolCallId)
      },
      onToolDone: async (toolName, toolCallId, success) => {
        const row = evidence.tools.find(item => item.toolCallId === toolCallId)
        if (row) row.status = success ? "done" : "error"
        if (!success && failureMayHaveEffects(toolName)) evidence.unconfirmedEffects = true
        await input.onToolDone?.(toolName, toolCallId, success)
      },
    }
    const traceContext = createRuntimeTraceContext(owner.sessionId, requestId)
    traceContext.runId = owner.runId
    kernel = createTurnKernel({
      sessionId: owner.sessionId, requestId, traceContext, model, thinkingEffort, systemPrompt: input.systemPrompt,
      tools, transientUserInput: false, persistSnapshots: input.audit !== undefined,
      ...(owner.kind === "plan" ? { plan: { planId: owner.planId, stepId: owner.stepId, version: 1 } } : {}),
      generation, toolRun,
    })
    slot = new HarnessSlot(`subagent-${owner.runId}`, { transient: true })
    if (owner.kind === "conversation" || owner.kind === "plan") detach = owner.parentSlot?.attachChild(slot)
    owner.signal?.addEventListener("abort", abortFromOwner, { once: true })
    if (!current()) return output = { ...output, status: "cancelled", error: "子运行 owner 已失效或取消" }
    const result = await slot.run(createTurnSpec(kernel, {
      prompt: input.task, timeoutMs: Math.max(1, deadlineAt - Date.now()), maxToolCalls,
      projectToolResults: false, runGeneration: generation, isPermissionCurrent: current, invisible: true,
      providerAdmission: {
        maxOutputTokens: model.maxTokens,
        beforeProvider: async reservation => current() && Date.now() < deadlineAt && (await input.beforeProvider?.(reservation) ?? true),
      },
      onPermissionDecision: (toolName, toolCallId, permission) => {
        if (permission.decision === "allow") return
        if (permission.decision === "ask") needsInput = true
        else permissionFailure = permission.reason ?? "子运行工具被权限策略拒绝"
        evidence.tools.push({ toolName, toolCallId, status: permission.decision, ...(permission.reason ? { reason: permission.reason } : {}) })
      },
      onChildToolResult: ({ toolName, toolCallId, content, isError }) => {
        const row: PiSubAgentEvidence["tools"][number] = evidence.tools.find(item => item.toolCallId === toolCallId) ?? { toolName, toolCallId, status: isError ? "error" : "done" }
        if (!evidence.tools.includes(row)) evidence.tools.push(row)
        row.status = isError ? "error" : "done"
        row.completedAt = Date.now()
        // 与 onToolDone 同一判据：结果侧也记一次，避免某个执行适配路径漏掉失败回执。
        if (isError && failureMayHaveEffects(toolName)) evidence.unconfirmedEffects = true
        if (!isError) {
          row.sourceUrls = childResultSourceUrls(contentText(content))
          row.sources = childResultSources(content)
        }
      },
      ...(input.disableAutomaticCompaction ? { disableAutomaticCompaction: true } : {}),
    }))
    output.toolCallsMade = kernel.state.toolCallsMade
    if (kernel.state.usage) output.usage = { ...kernel.state.usage }
    for (const row of history) {
      if (!evidence.tools.some(item => item.toolName === row.toolName && item.status === row.status)) evidence.tools.push({ toolName: row.toolName, status: row.status })
    }
    if (!current() || result.status === "aborted" && !result.timedOut) return output = { ...output, status: "cancelled", error: result.error ?? "子运行已取消" }
    if (result.timedOut || Date.now() >= deadlineAt) return output = { ...output, status: "timed_out", error: result.error ?? "Agent 执行超时" }
    if (needsInput) return output = { ...output, status: "needs_input", error: "任务需要额外授权或用户输入" }
    if (permissionFailure) return output = { ...output, status: "failed", error: permissionFailure }
    if (result.status !== "completed") return output = { ...output, error: result.error ?? "Pi Agent 未返回有效回复" }
    const finalAssistant = kernel.state.finalPlainAssistant ?? kernel.state.finalAssistant
    const reply = finalAssistant ? contentText(finalAssistant.content) : ""
    const raw = kernel.rawTextForSettledReply(reply)
    output = { ...output, status: "completed", reply, ...(raw !== reply ? { rawReply: raw } : {}) }
    if (!reply.trim() || kernel.state.stoppedByToolGovernance) {
      output.error = kernel.state.stoppedByToolGovernance ? "子运行达到工具治理上限，工作未完成" : "子运行没有返回结果"
      evidence.incomplete.push(output.error)
      return output
    }
    if (input.outputContract?.kind === "json") {
      try { output.artifact = JSON.parse(reply) }
      catch { output.error = "子运行结果不符合 JSON 产物契约"; return output }
    }
    const accepted = await input.outputContract?.validate?.({ reply, artifact: output.artifact, evidence }) ?? true
    if (!current()) return output = { ...output, status: "cancelled", error: "子运行 owner 已失效或取消" }
    output.success = accepted === true
    if (!output.success) output.error = typeof accepted === "string" ? accepted : "子运行产物未通过验收"
    return output
  } catch (error) {
    log.warn("子运行失败:", { runId: owner.runId, owner: owner.kind }, formatError(error))
    output.error = formatError(error)
    if (!current()) output.status = "cancelled"
    else if (Date.now() >= deadlineAt) output.status = "timed_out"
    return output
  } finally {
    owner.signal?.removeEventListener("abort", abortFromOwner)
    try { await slot?.close() }
    catch (error) { output.success = false; output.status = "failed"; output.error = formatError(error); log.warn("子运行槽释放失败:", { runId: owner.runId }, formatError(error)) }
    detach?.()
    const { releaseMcpOwner } = await import("@/services/tool")
    try { await releaseMcpOwner(requestId) }
    catch (error) { output.success = false; output.status = "failed"; output.error = formatError(error); log.warn("子运行 MCP owner 释放失败:", { runId: owner.runId }, formatError(error)) }
  }
}
