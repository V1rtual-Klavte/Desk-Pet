// 每回合的 Harness 运行规格：权限、投影、观测与 UI/统计消费点在 createTurnSpec 一处接线；
// 以及对话回合的工具面装配。由原回合运行模块抽出（T1.5）。

import type { AgentMessage, SettledAssistantMessage } from "@earendil-works/pi-agent-core"
import type { ActiveMessageRequest, ProactiveOwner, ProviderReservation } from "@/services/agent/types"
import { publishRuntimeTrace, redactText, sha256Text, stableSerialize } from "@/services/engine/protocol"
import type { CompactionAuditSink, MemoryCitationEntryData, RuntimeTraceContext } from "@/services/engine/protocol"
import type { HarnessRunHooks, HarnessRunState } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { HOST_EVENT_TOOL_EXECUTING } from "@/services/host"
import { createLogger } from "@/services/logger"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { authorizeToolExecution } from "@/services/safety"
import type { PermissionResult } from "@/services/safety"
import { createEnableToolsTool, createTranscriptTool, defaultActiveToolNames, listAll, preservedToolNames, readHarnessToolOutcome } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { readScreenshotToolDetails, SCREENSHOT_TOOL_NAME } from "@/services/tool/local/screenshot-details"
import { createCompactionHook, createLadderGateBuilder } from "./compaction-hook"
import { providerMessages } from "./message-adapters"
import { createRequestOptionsPatch, createRequestViewHook, createRuntimeDataStripHook, extractRequestParams, extractToolNames } from "./request-view"
import type { HarnessRunSpec, HarnessSlot } from "./slot"
import { emitToolStageTitlebar, emitUiEvent } from "./titlebar"
import { ToolLoopGuard, toolLoopBlockReason, toolLoopNotice } from "./tool-loop-guard"
import type { FocusedMemoryEvidence } from "@/services/agent/memory"
import type { TurnKernel } from "./turn-kernel"
import { createTurnSinks } from "./turn-sinks"

// 日志分类沿用拆分前的 `PiRuntime`：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/**
 * 收集 `screenshot` 工具（show_to_user=true）落盘的截图路径。
 *
 * 只认名字与 details 契约都对得上的成功结果：工具在返回结果前已完成文件落盘，
 * 因此宿主拿到路径时文件一定在磁盘上（先文件、后条目）。
 */
function collectScreenshotResult(state: HarnessRunState, toolName: string, details: unknown, isError: boolean): void {
  if (isError || toolName !== SCREENSHOT_TOOL_NAME) return
  const shot = readScreenshotToolDetails(details)
  if (!shot?.showToUser) return
    ; (state.pendingUserImages ??= []).push(shot.screenshotPath)
}

/**
 * 提交前把本回合待展示的截图路径并入最终助手消息（`deskpetImagePaths`，与用户图片同字段名）。
 *
 * 只在最终消息（不带工具调用）上并入：带工具调用的消息是过程节点，提前并入会让同一张图
 * 出现在多条条目上。取消/出错的回合根本走不到提交链，因此不会留下「有图无条目」或
 * 「有正文无图」的半条消息；错误/中止帧也不并入（那类条目不进聊天视图）。
 */
function attachUserImages(message: SettledAssistantMessage, state: HarnessRunState): SettledAssistantMessage {
  const pending = state.pendingUserImages
  if (!pending || pending.length === 0) return message
  if (message.stopReason === "error" || message.stopReason === "aborted") return message
  if (message.content.some(part => part.type === "toolCall")) return message
  const paths = pending.splice(0, pending.length)
  state.attachedUserImages = paths
  return { ...message, deskpetImagePaths: paths } as SettledAssistantMessage
}

/** 每回合的 Harness 运行规格；权限、投影、观测与 UI/统计消费点都在这里接线。 */
export function createTurnSpec(kernel: TurnKernel, options: {
  prompt: string | AgentMessage | AgentMessage[]
  /** 默认激活面（⊆ kernel.tools）：主对话回合收窄，省略 = 全量（子代理 / 计划步骤）。 */
  activeToolNames?: readonly string[]
  timeoutMs: number
  /**
   * 工具调用次数硬上限；**只给无人值守的子运行**（计划步骤 / 主动规划 / agent 子代理）。
   * 主聊天回合不传：自然出口 = 模型不再调工具，兜底防线是 `ToolLoopGuard` 的病理检测
   * （同参重复 / 连续失败），另有上下文预算、用户取消与 `maxRetry`（契约 Part 1）。
   */
  maxToolCalls?: number
  projectToolResults: boolean
  humanizerEnabled?: boolean
  taskReply?: boolean
  understanding?: { text: string; sourceId: string; revision: number }
  isPermissionCurrent: () => boolean
  runGeneration: number
  activeRequest?: ActiveMessageRequest
  activeOwner?: ProactiveOwner
  activeIsCurrent?: () => Promise<boolean>
  /**
   * 地址目录 thunk：投影 hook 与压缩 hook 共用同一份（`() => slot.addressRefs()`），
   * 两个消费点各自在需要的时刻 await，任何一处都不在构造期提前取值。
   */
  addressRefs?: () => Promise<ReadonlyMap<string, string>>
  /** 记忆召回块（只有主回合传）：headroom-aware 取数 thunk 与渲染在投影 hook 同处完成。 */
  memory?: { recall: (availableTokens: number) => Promise<FocusedMemoryEvidence>; traceContext: RuntimeTraceContext; question: string; onCitations?: (citations: Pick<MemoryCitationEntryData, "itemIds" | "conversationRefs">) => void }
  /**
   * 子运行（规划 / 计划步骤 / 子代理）对聊天界面**不可见**：过程消息、工具结果与流式
   * 草稿都不进活跃会话的可见列表与瞬时尾巴。子运行槽是内存临时的、什么都不落盘，
   * 推出去的气泡会在下一次读模型重载时整体消失（2026-10-06 真机的「几条 AI 消息闪一下
   * 就没了」）；过程可见性由顶栏过程文案承担（阶段提示与工具过程照常发）。
   */
  invisible?: boolean
  /** 调度/规划类子运行：拒绝隐式压缩的模型调用（透传进 spec，由槽在压缩挂点读取）。 */
  disableAutomaticCompaction?: boolean
  /**
   * 子运行的 provider 准入（请求发出前的最后一道）。规划器的 claim 挂在它上面：
   * 缺这条转发，规划子运行会**每个 tick 真发一次请求**且从不 claim/结算
   * （2026-10-06 根因取证；参数类型缺字段 + 调用点用 spread ⇒ 静默丢弃）。
   */
  providerAdmission?: { beforeProvider: (reservation: ProviderReservation) => Promise<boolean>; maxOutputTokens: number }
  onPermissionDecision?: (toolName: string, toolCallId: string, permission: PermissionResult) => void
  onChildToolResult?: (result: Parameters<NonNullable<HarnessRunHooks["afterTool"]>>[0]) => void
}): HarnessRunSpec {
  const state = kernel.state
  const toolsByName = new Map(kernel.tools.map(tool => [tool.name, tool]))
  // preserve 名单：投影 hook 与级 3 闸门/retain 判定同一份来源（`kernel.tools`），只算一次。
  const preserveToolNames = preservedToolNames(kernel.tools)
  // 压缩审计槽：摘要内核的成败写在这里，由槽在 compaction_end 收口成 deskpet.* 条目。
  const compactionAudit: CompactionAuditSink = {}
  let toolCallsUsed = 0
  // 病理检测：每回合新建（重置点就是这里），喂入工具调用与结果，产出软提示 / 硬终止判据。
  const loopGuard = new ToolLoopGuard()
  /**
   * 已判定的循环软提示（toolCallId → 附加行）；投影期由 `applyLevels` 读出、附到该结果的正文。
   * 回合级内存态：不落盘、不进会话条目（提示只存在于请求视图）。
   */
  const toolLoopNotices = new Map<string, string>()
  const stripReply = createRuntimeDataStripHook({
    recordSettledReply: (raw, stripped, humanized) => kernel.recordSettledReply(raw, stripped, humanized),
    humanizer: {
      enabled: options.humanizerEnabled ?? kernel.humanizerEnabled ?? false,
      sessionId: kernel.sessionId,
      fallbackReply: kernel.silentRejectedReply ?? getFallbackReply("silentRejected"),
      // 只有真正的计划/任务步骤走 task；普通聊天即使调过工具也仍是 casual，
      // 否则任何一次工具调用都会把闲聊压成一条（2026-10-20 实机）。
      flow: () => options.activeRequest ? "casual"
        : (options.taskReply ?? kernel.taskReply) ? "task" : "casual",
      traceContext: kernel.traceContext,
    },
  })
  const hooks: HarnessRunHooks = {
    beforeTool: async ({ toolCallId, toolName, args, signal }) => {
      const tool = toolsByName.get(toolName)
      // 治理一旦命中就保持关闭：混合批次晚到的成功不能重新放行后续工具。
      if (state.stoppedByToolGovernance) {
        kernel.toolRun.history.push({ toolName, status: "blocked" })
        return { block: { reason: state.toolGovernanceReason ?? "工具循环治理终止", terminate: true } }
      }
      // 计数硬上限只服务无人值守的子运行（主回合不传 maxToolCalls）。
      if (options.maxToolCalls !== undefined && toolCallsUsed >= options.maxToolCalls) {
        state.stoppedByToolGovernance = true
        state.toolGovernanceReason = `工具调用次数达到上限 (${options.maxToolCalls})`
        kernel.toolRun.history.push({ toolName, status: "blocked" })
        return { block: { reason: state.toolGovernanceReason, terminate: true } }
      }
      // 病理检测在调用门（权限之前）：同参连击到硬阈值就整回合优雅终止；失败连击的硬阈值
      // 在结果侧已经终止（afterTool 的 terminate），这里兜住「本批未整体终止仍有后续调用」的窗口。
      const loop = loopGuard.noteCall(toolName, args)
      if (loop.level === "hard") {
        state.stoppedByToolGovernance = true
        state.toolGovernanceReason = toolLoopBlockReason(loop.reason)
        kernel.toolRun.history.push({ toolName, status: "blocked" })
        return { block: { reason: state.toolGovernanceReason, terminate: true } }
      }
      if (loop.level === "soft") toolLoopNotices.set(toolCallId, toolLoopNotice(loop.reason))
      toolCallsUsed++
      state.toolCallsMade = toolCallsUsed
      if (!tool) {
        kernel.toolRun.history.push({ toolName, status: "error" })
        return { block: { reason: `工具 ${toolName} 不可用` } }
      }
      emitUiEvent(HOST_EVENT_TOOL_EXECUTING, { toolId: tool.name, toolName: tool.name })
      emitToolStageTitlebar(kernel.sessionId, kernel.generation, "executing")
      publishRuntimeTrace(kernel.traceContext, "permission_asked", () => ({ toolName: tool.name, source: "authorization_request" }), { toolCallId })
      const permission = await authorizeToolExecution(tool, args as Record<string, unknown>, {
        sessionId: kernel.sessionId ?? kernel.traceContext.runId,
        runGeneration: options.runGeneration,
        toolCallId,
        signal,
        isCurrent: options.isPermissionCurrent,
        // 回合冻结的策略：回合中改安全模式不改变本回合的裁决与 policyHash。
        policy: kernel.policy,
        ...(kernel.toolRun.taskAuthorization ? { taskAuthorization: kernel.toolRun.taskAuthorization } : {}),
        ...(kernel.toolRun.permissionMode ? { permissionMode: kernel.toolRun.permissionMode } : {}),
      })
      options.onPermissionDecision?.(tool.name, toolCallId, permission)
      publishRuntimeTrace(kernel.traceContext, "permission_decided", () => ({ toolName: tool.name, decision: permission.decision, source: "authorization_outcome" }), { toolCallId })
      // 能力冻结的逐请求一半：本次裁决（含拒绝理由）折进快照的 capabilities.toolDecisions。
      kernel.capabilities.toolDecisions.push({
        toolName: tool.name,
        decision: permission.decision,
        ...(permission.reason ? { reason: permission.reason } : {}),
      })
      if (permission.decision !== "allow") {
        const reason = permission.reason ?? "操作未获授权"
        kernel.toolRun.history.push({ toolName: tool.name, status: permission.request ? "denied" : "blocked", personalityMsg: reason })
        return { block: { reason, ...(kernel.toolRun.permissionMode === "background" ? { terminate: true } : {}) } }
      }
      return undefined
    },
    afterTool: result => {
      const { toolCallId, toolName, details, isError } = result
      options.onChildToolResult?.(result)
      // show_to_user 的截图路径在这里进入回合状态，由提交链并入最终助手条目。
      collectScreenshotResult(state, toolName, details, isError)
      // 用户主动取消不算技术失败，也不清洗已有失败；SDK/权限/界面故障仍按失败累计。
      const outcome = isError && readHarnessToolOutcome(details) === "user_cancelled"
        ? "user_cancelled" : isError ? "failure" : "success"
      const loop = loopGuard.noteResult(outcome)
      if (loop.level !== "none") {
        const notice = toolLoopNotice(loop.reason)
        const pending = toolLoopNotices.get(toolCallId)
        toolLoopNotices.set(toolCallId, pending ? `${pending}\n${notice}` : notice)
      }
      const detailsPatch = {
        ...(details && typeof details === "object" ? details as Record<string, unknown> : {}),
        origin: "tool", taint: "untrusted_external", isError,
      }
      // 失败连击到硬阈值：结果侧经 `after_tool` 的 `terminate` 立即终止 —— 本批工具全部带该
      // 标记时上游在当前批次后结束运行、不再发下一次请求（运行仍以 completed 收口，但没有
      // 收尾助手消息）。混合批次若仍产生已提交的终态收尾，主回合交付该正文；
      // 没有有效收尾才按 tool_loop 失败落盘兜底，工具失败与子运行工作验收不受影响。
      if (loop.level === "hard") {
        state.stoppedByToolGovernance = true
        state.toolGovernanceReason = toolLoopBlockReason(loop.reason)
        return { details: detailsPatch, isError, terminate: true }
      }
      return { details: detailsPatch, isError }
    },
    transformContext: createRequestViewHook({
      projectToolResults: options.projectToolResults,
      toolsByName,
      preserveToolNames,
      model: kernel.model,
      supportsImages: kernel.model.input.includes("image"),
      ...(options.understanding ? { understanding: options.understanding } : {}),
      ...(kernel.humanizerEnabled && kernel.sessionId ? { silenceGuardSessionId: kernel.sessionId } : {}),
      state,
      captureSnapshot: kernel.captureSnapshot,
      snapshotTasks: kernel.snapshotTasks,
      latestMessages: messages => { kernel.latestMessages = messages },
      ...(options.addressRefs ? { addressRefs: options.addressRefs } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.activeRequest && options.activeOwner && options.activeRequest.beforeGenerate ? {
        activeAdmission: {
          owner: options.activeOwner,
          beforeGenerate: options.activeRequest.beforeGenerate,
          maxOutputTokens: kernel.model.maxTokens,
        },
      } : {}),
      // 子运行的 provider 准入：与 activeAdmission 并列，二者互斥使用（规划器走这条）。
      ...(options.providerAdmission ? { providerAdmission: options.providerAdmission } : {}),
      // 循环软提示与投影同一份（回合级），读数/闸门与最终视图保持一致。
      toolLoopNotices,
    }),
    beforeCompaction: createCompactionHook({
      model: kernel.model, tools: kernel.tools,
      sessionId: kernel.sessionId, audit: compactionAudit,
      // 闸门只在投影开着（工具结果走阶梯）时接：子代理不投影工具结果（projectToolResults:
      // false），按「级 1/2 会压下去」的前提估算会误判「装得下」。
      ...(options.projectToolResults ? {
        systemPrompt: kernel.systemPrompt,
        // 与投影 hook 同一个 measure（`createLadderGateBuilder` 内部走 `createLadderMeasure`）。
        buildGate: createLadderGateBuilder({
          systemPrompt: kernel.systemPrompt, model: kernel.model,
          tools: kernel.tools, preserveToolNames, toolLoopNotices,
        }),
      } : {}),
      ...(options.addressRefs ? { addressRefs: options.addressRefs } : {}),
    }),
    compactionAudit,
    // 记当次请求归属：payload 采集据此区分「本回合的请求」与「压缩/分支摘要的一次性请求」。
    beforeRequest: createRequestOptionsPatch((step, attempt) => { kernel.currentRequest = { step, attempt } }),
    afterResponse: async (message, meta) => {
      publishRuntimeTrace(kernel.traceContext, "provider_response", () => ({
        model: kernel.model.id,
        api: kernel.model.api,
        status: meta.status,
        headerNames: Object.keys(meta.headers ?? {}).sort(),
      }))
      if (options.activeRequest && options.activeOwner && options.activeIsCurrent
        && !await options.activeIsCurrent()) {
        // Explicit final guard: a stale active reply must never reach the native commit path or retry.
        return {
          ...message,
          content: [],
          stopReason: "error",
          errorMessage: "PROACTIVE_OWNER_STALE",
        }
      }
      // 提交前剥离 RUNTIME_DATA：条目是真相源，但正文块不进入后续请求与展示。
      const stripped = await stripReply(message, meta)
      if (stripped === undefined) return undefined
      // 最后并入本回合的展示截图路径：文件已落盘，条目在这里带上 deskpetImagePaths。
      return attachUserImages(stripped, state)
    },
    beforePayload: (payload, payloadModel) => {
      const step = kernel.currentRequest?.step
      // 压缩/分支摘要的 payload 属于一次性摘要请求，不是本回合的对话请求：不写归属错误的 provider_payload。
      if (step === "compaction" || step === "branch_summary") return
      const safePayload = redactText(stableSerialize(payload))
      kernel.requestParams = extractRequestParams(payload)
      kernel.requestToolNames = extractToolNames(payload)
      const task = sha256Text(safePayload.text)
        .then(async payloadHash => {
          kernel.payloadHash = payloadHash
          await kernel.captureSnapshot("provider_payload", kernel.latestMessages, providerMessages(payload))
          publishRuntimeTrace(kernel.traceContext, "provider_payload", () => ({
            model: payloadModel.id,
            api: payloadModel.api,
            payloadHash,
            redactions: safePayload.redactions,
          }))
        })
        .catch(error => log.error("provider_payload 快照采集失败:", formatError(error)))
      kernel.snapshotTasks.push(task)
    },
  }
  return {
    requestId: kernel.requestId,
    turnId: kernel.turnId,
    model: kernel.model,
    thinkingEffort: kernel.thinkingEffort,
    systemPrompt: kernel.systemPrompt,
    tools: kernel.tools,
    ...(options.activeToolNames ? { activeToolNames: options.activeToolNames } : {}),
    toolRun: kernel.toolRun,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs,
    hooks,
    sinks: createTurnSinks(kernel, options.invisible !== true),
    state,
    traceContext: kernel.traceContext,
    traceRequestInfo: () => kernel.currentRequest,
    ...(options.activeRequest ? { disableAutomaticCompaction: true } : {}),
    // 调用方声明（子运行）与主回合口径取或：任何一侧要求就压掉隐式压缩调用。
    ...(options.disableAutomaticCompaction ? { disableAutomaticCompaction: true } : {}),
  }
}

/**
 * 对话回合的工具面装配（主回合与恢复续跑共用）：全量冻结（`setTools` 持全量，Pi 会校验
 * 激活集 ⊆ 全量）+ 结果回读工具 + 取用入口；默认激活集由 `defaultActiveToolNames` 唯一判定，
 * 未默认激活的工具（含全部 MCP 工具）由 enable_tools 在本回合按需加入（`addedToolNames` 渐进披露）。
 */
export function assembleConversationTools(slot: HarnessSlot, windowTokens: number): { tools: ToolDef[]; activeToolNames: string[] } {
  const tools: ToolDef[] = [...listAll()]
  tools.push(createTranscriptTool(entryId => slot.readToolResult(entryId), { windowTokens }))
  // 取用入口只在确有未激活工具时挂载：没有任何这类工具时它无事可做，白占一份 schema。
  if (defaultActiveToolNames(tools).length < tools.length) tools.push(createEnableToolsTool({ tools }))
  return { tools, activeToolNames: defaultActiveToolNames(tools) }
}
