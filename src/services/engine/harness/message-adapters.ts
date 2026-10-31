// Pi 消息形态适配：阶梯条目/投影、RUNTIME_DATA 剥离、主动/注记/观测消息构造与读回映射。
// 纯搬移自 harness/runtime.ts（T1.5 抽出 harness 原语），不改变行为。

import type { AgentMessage, JsonValue, SettledAssistantMessage } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type { ActiveMessageRequest, Message } from "@/services/agent/types"
import { annotateToolResultText, projectToolResultText, toolResultAddress } from "@/services/context"
import type { ToolResultLadderEntry } from "@/services/context"
import type { IngressEnvelope } from "@/services/engine/protocol"
import { stableSerialize, TURN_NOTE_CUSTOM_TYPE } from "@/services/engine/protocol"
import { parseRuntimeData } from "@/services/reply"
import { isAssistantEntryVisible } from "@/services/session"
import { SESSION_TRANSCRIPT_TOOL } from "@/services/tool"

/**
 * 回读地址解析（投影期唯一一处）：条目保持全文，缩短/清空只改视图、不动存档
 * （请求视图与摘要素材同口径）；地址无条件标注（A-1）。
 *
 * `resultProjection=preserve` 的结果**禁止二次处理：不缩短、不清空，但同样带地址** —— 地址
 * 标注不在此列（D-W2-5 的 2026-09-27 裁定：preserve 只挡升档处理，不挡地址标注）。
 *
 * `addressRefs` 给的是展示用前缀，目录里没有该 id 时退回完整条目 id（完整 id 永远可读，A-4）；
 * 取不到 `details.deskpetEntryId` 的结果按无地址形态如实投影，不写假 eventId。
 * 目录读取失败的兜底在投影 hook（退回完整 id）——契约是「拒绝时一致」，见那里的一次性 warn。
 */
function resolveToolResultAddress(message: { details?: unknown }, addressRefs?: ReadonlyMap<string, string>): string | undefined {
  const entryId = toolResultAddress(message)
  return entryId ? addressRefs?.get(entryId) ?? entryId : undefined
}

/**
 * 阶梯条目的 Pi 消息形态适配器：只取 `role === "toolResult"` 的消息，正文用 `contentText`
 * （与投影改写的正文同一份），地址用 `resolveToolResultAddress`。
 *
 * `resultProjection=preserve` 的条目同样在这里取地址：它们不进候选集（判定侧过滤），
 * 但地址标注照走 —— 不缩短、不清空，但同样带地址（D-W2-5 的 2026-09-27 裁定）。
 *
 * 消息形态适配只有这一处 —— 投影 hook 与级 3 闸门（T3.05）共用同一份产出，
 * `compactor.ts` 不抽第二份（durable `Message` 形态在 W4 的素材投影里）。
 */
export function toolResultLadderEntries(
  messages: readonly AgentMessage[],
  addressRefs?: ReadonlyMap<string, string>,
): ToolResultLadderEntry[] {
  const entries: ToolResultLadderEntry[] = []
  messages.forEach((message, index) => {
    if (message.role !== "toolResult") return
    const address = resolveToolResultAddress(message, addressRefs)
    entries.push({
      index, toolName: message.toolName, text: contentText(message.content),
      ...(address === undefined ? {} : { address }),
    })
  })
  return entries
}

/**
 * 阶梯分级方案在 Pi 消息数组上的唯一投影实现：把 `plan.levels` 应用成请求视图。
 *
 * 级 1/2 经 `projectToolResultText` 的唯一实现（无第二套文案；级 2 的「有地址」硬前提
 * 由它兜底，这里不重判）。未进计划的条目（级 0）与 `resultProjection=preserve` 的工具
 * （分页读取、写类结果）**禁止二次处理：不缩短、不清空，但地址无条件标注**（A-1）—— 写入
 * 回执被摘要吃掉后也需要可捞的地址（D-W2-5 的 2026-09-27 裁定：preserve 只挡升档处理，
 * 不挡地址标注）。
 * 未注册的历史工具不在 `preserveToolNames` 里，按可处理结果对待（与投影 hook 的候选集同一口径）。
 *
 * 改写只作用于 text 块：图片等非 text 块按原顺序留在原位（整块重建会丢掉 `pi-read` 的
 * 图片结果，且回读也救不回）。纯函数：不改入参，未改动的消息原样返回；判据的 `measure`
 * 也走本函数，估算因此恒等于最终请求视图，不存在第二份投影口径。
 *
 * `toolLoopNotices` 按 toolCallId 取该结果的循环软提示（`tool-loop-guard` 的产出，回合级内存态）：
 * 与地址通知同一出口、同一档位规则附着，不在投影之外另加消息。**每条结果只附一次** ——
 * 多 text 块的结果只在最后一个 text 块上拼软提示（逐块拼会重复 N 次）；没有 text 块则无处可附。
 */
export function applyLevels(
  messages: readonly AgentMessage[],
  levels: ReadonlyMap<number, 1 | 2>,
  windowTokens: number,
  preserveToolNames: ReadonlySet<string>,
  addressRefs?: ReadonlyMap<string, string>,
  toolLoopNotices?: ReadonlyMap<string, string>,
): AgentMessage[] {
  return messages.map((message, index) => {
    if (message.role !== "toolResult") return message
    const level = levels.get(index) ?? 0
    const preserve = preserveToolNames.has(message.toolName)
    const address = resolveToolResultAddress(message, addressRefs)
    const loopNotice = toolLoopNotices?.get(message.toolCallId)
    let lastTextIndex = -1
    message.content.forEach((part, partIndex) => { if (part.type === "text") lastTextIndex = partIndex })
    let changed = false
    const content = message.content.map((part, partIndex) => {
      if (part.type !== "text") return part
      const notice = partIndex === lastTextIndex ? loopNotice : undefined
      const text = preserve || level === 0
        ? annotateToolResultText(part.text, address, SESSION_TRANSCRIPT_TOOL, notice)
        : projectToolResultText(part.text, address, windowTokens, SESSION_TRANSCRIPT_TOOL, level, notice)
      if (text === part.text) return part
      changed = true
      return { ...part, text }
    })
    return changed ? { ...message, content } : message
  })
}

/** 提交前剥离 RUNTIME_DATA；thinking 等其它块保持原样。 */
export function stripRuntimeData(message: SettledAssistantMessage): SettledAssistantMessage {
  let changed = false
  const content = message.content.map(part => {
    if (part.type !== "text") return part
    const { text } = parseRuntimeData(part.text)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? { ...message, content } : message
}

/**
 * 主动搭话以自定义消息投递：模型看到内容，记录里不是用户事实。
 * 与 `userInputMessage()` 并列的另一种投递条目形状 —— 调用方（runner 的主动消息入口）构造，
 * 两者各自只有一处定义，不互相复制字段。
 */
export function createActiveMessage(text: string, active: ActiveMessageRequest, ingress: IngressEnvelope, runGeneration: number): AgentMessage {
  return {
    role: "custom",
    customType: "deskpet.active_message",
    content: text,
    display: false,
    details: {
      requestId: active.requestId,
      attemptId: active.attemptId,
      ruleId: active.ruleId,
      intent: active.intent,
      expectsReply: active.expectsReply,
      sourceRefs: active.sourceRefs as unknown as JsonValue,
      occurrenceIds: [...active.occurrenceIds],
      cardId: active.owner.cardId,
      cardHash: active.owner.cardHash,
      runGeneration,
      querySource: ingress.querySource,
      taint: "derived",
      visibleToUser: false,
      eligibleForTranscript: false,
      eligibleForMemory: false,
    },
    timestamp: Date.now(),
  }
}

/**
 * 尾随瞬时注记：附在请求视图**最末**，不进 system prompt、不落会话条目。
 *
 * 落点由前缀缓存决定：缓存只在第一个差异处之前命中，而 system prompt 整体排在会话正文
 * 之前 —— 每回合变化的内容（当前时间；将来的召回）留在 system prompt 里，就会把缓存断在
 * 正文上游，让整个会话正文每轮重新计费。贴在消息数组末尾时，差异点落在「本来就是新的」
 * 那一段，不额外损失任何缓存。
 *
 * `eligibleForTranscript` / `eligibleForMemory` 与主动搭话同口径：模型看得到内容，
 * 但它既不是会话历史，也不能成为用户事实（`isTransientInputMessage` 据此把它归到 ephemeral）。
 */
export function createTurnNoteMessage(text: string): AgentMessage {
  return {
    role: "custom",
    customType: TURN_NOTE_CUSTOM_TYPE,
    content: text,
    display: false,
    details: {
      taint: "derived",
      visibleToUser: false,
      eligibleForTranscript: false,
      eligibleForMemory: false,
    },
    timestamp: Date.now(),
  }
}

/** Observation data enters only the request projection and is explicitly untrusted. */
export function createUnderstandingMessage(input: { text: string; sourceId: string; revision: number }): AgentMessage {
  return {
    role: "custom",
    customType: "deskpet.understanding",
    content: input.text,
    display: false,
    details: {
      sourceId: input.sourceId,
      revision: input.revision,
      origin: "observation",
      taint: "untrusted_external",
      visibleToUser: false,
      eligibleForTranscript: false,
      eligibleForMemory: false,
    },
    timestamp: Date.now(),
  }
}

export function providerMessages(payload: unknown): Array<{ role: string; content?: string; toolCallId?: string }> {
  if (!payload || typeof payload !== "object") return []
  const messages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap(message => {
    if (!message || typeof message !== "object") return []
    const record = message as Record<string, unknown>
    if (typeof record.role !== "string") return []
    return [{
      role: record.role,
      content: stableSerialize(record.content ?? ""),
      ...(typeof record.tool_call_id === "string" ? { toolCallId: record.tool_call_id } : {}),
    }]
  })
}

export function fromPiMessage(message: AgentMessage, id: string): Message | undefined {
  const identity = { id, eventId: id, timestamp: "timestamp" in message ? message.timestamp : Date.now() }
  if (message.role === "user") return { ...identity, role: "user", text: typeof message.content === "string" ? message.content : contentText(message.content) }
  if (message.role === "assistant") {
    // 出错/中止的助手帧没有可展示正文，丢掉是刻意的丢帧判定 —— 放行只会得到与正文相反的空气泡。
    // 与重放路径（读模型）共用 isAssistantEntryVisible 一条判定，不能只改这一处。
    if (!isAssistantEntryVisible(message)) return undefined
    const toolCalls = message.content.filter(part => part.type === "toolCall").map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
    return {
      ...identity, role: "assistant", text: parseRuntimeData(contentText(message.content)).text,
      ...(toolCalls.length ? { toolCalls } : {})
    }
  }
  if (message.role === "toolResult") return {
    ...identity, role: "tool", text: contentText(message.content),
    toolCallId: message.toolCallId, isError: message.isError
  }
  // §4.2 保留：未知角色同样丢弃 —— 只有 user/assistant/toolResult 三种能映射成应用消息。
  return undefined
}

/** Completed empty assistant rows are durable silence evidence, not Provider conversation turns. */
export function isCompletedEmptyAssistant(message: AgentMessage): boolean {
  if (message.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "length")) return false
  const hasVisibleText = message.content.some(part => part.type === "text" && part.text.trim().length > 0)
  const hasToolCall = message.content.some(part => part.type === "toolCall")
  return !hasVisibleText && !hasToolCall
}
