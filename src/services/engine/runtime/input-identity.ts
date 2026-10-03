/**
 * 输入身份与来源标记：投递到 lane 的用户消息带 `deskpetEventId = `${requestId}:user``，
 * 这是「这一条输入」在持久层的唯一主键 —— 会话条目、lane inbox 项与请求快照都按它对齐；
 * 同一条消息可带 `deskpetSource`（`InputSourceMark`），来源因此随输入一起落盘。
 *
 * 零依赖叶子：ingress、运行槽、投递证据查询与 token 分配共用，避免各处手写同一段字符串拼接/截取。
 * 这里只做身份换算、消息构造与消息形状判定；「是否已进入请求」这类归属仍由投递证据查询回答。
 *
 * `userInputMessage()` 是投递消息形状的唯一构造点：空闲回合的 prompt 与忙碌投递的 inbox
 * 消息都由它构造，所有入口的身份与标记口径一致（不再有无身份的裸字符串）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import type {
  IngressEnvelope,
  InputSourceMark,
  MessageOrigin,
  MessagePriority,
  MessageTaint,
  QuerySource,
} from "./types"

const USER_SUFFIX = ":user"

/** 由宿主 requestId 得到投递到 lane 的事件身份。 */
export function inputEventId(requestId: string): string {
  return `${requestId}${USER_SUFFIX}`
}

/** 从 lane 消息上取回投递事件身份；不是投递输入的消息（无身份 / 后缀不符）返回 undefined。 */
export function messageEventId(message: unknown): string | undefined {
  const eventId = (message as { deskpetEventId?: unknown } | null | undefined)?.deskpetEventId
  return typeof eventId === "string" && eventId.endsWith(USER_SUFFIX) ? eventId : undefined
}

/** 从 lane 消息上取回宿主 requestId；不是投递输入的消息返回 undefined。 */
export function messageRequestId(message: { deskpetEventId?: unknown }): string | undefined {
  const eventId = messageEventId(message)
  return eventId === undefined ? undefined : eventId.slice(0, -USER_SUFFIX.length)
}

/** 来源标记在消息上的字段名：与 `deskpetEventId` 并列，随条目一起持久化。 */
export const INPUT_SOURCE_FIELD = "deskpetSource"

/**
 * lane 消息的纯文本：字符串正文原样；结构化内容走 `contentText`；非文本形态返回 ""。
 * 排队视图与暂停输入的正文预览共用这一处实现，不再各自写一份分支。
 */
export function laneMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  return Array.isArray(content) ? contentText(content as Parameters<typeof contentText>[0]) : ""
}

/**
 * 由入口 ingress 投影出随消息落盘的来源标记（ingress 是唯一真相源）。
 *
 * `cardId` 是投递时刻冻结的 Card 身份：事后从「当前正在显示的 Card」反推会把
 * 切卡后的经历算到旧 Card 名下，所以它必须与输入同刻落盘。
 */
export function inputSourceMark(ingress: IngressEnvelope, cardId?: string): InputSourceMark {
  return {
    origin: ingress.origin,
    querySource: ingress.querySource,
    priority: ingress.priority,
    taint: ingress.taint,
    // 只有用户本人的可信输入能成为长期事实：主动消息、恢复续跑与外部内容都不行。
    eligibleForMemory: ingress.origin === "user" && ingress.taint === "trusted_user",
    ...(cardId ? { cardId } : {}),
  }
}

/**
 * 投递消息形状的唯一构造点：身份与来源标记挂在消息本身上，随 lane 事务一起落盘。
 *
 * 没有身份（`eventId` 为空）时不写 `deskpetEventId`，保持「非投递输入」语义；
 * 没有标记时不写 `deskpetSource` —— 读取方一律按可选处理（历史条目没有这个字段）。
 */
export function userInputMessage(text: string, eventId: string, mark?: InputSourceMark): AgentMessage {
  return {
    role: "user" as const,
    content: text,
    timestamp: Date.now(),
    ...(eventId ? { deskpetEventId: eventId } : {}),
    ...(mark ? { [INPUT_SOURCE_FIELD]: mark } : {}),
  }
}

/**
 * 从条目/消息上取回来源标记。只做形态核对，不枚举取值域（取值域由写入侧的类型保证）：
 * 旧数据没有该字段、或字段被别人写坏时返回 undefined，调用方按「没有标记」处理。
 */
export function inputSourceOf(message: { deskpetSource?: unknown }): InputSourceMark | undefined {
  const raw = message[INPUT_SOURCE_FIELD]
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.origin !== "string" || typeof record.querySource !== "string"
    || typeof record.priority !== "string" || typeof record.taint !== "string"
    || typeof record.eligibleForMemory !== "boolean") return undefined
  return {
    origin: record.origin as MessageOrigin,
    querySource: record.querySource as QuerySource,
    priority: record.priority as MessagePriority,
    taint: record.taint as MessageTaint,
    eligibleForMemory: record.eligibleForMemory,
    ...(typeof record.cardId === "string" ? { cardId: record.cardId } : {}),
  }
}

/** 主动搭话的自定义消息类型：投递形状的唯一构造点是 pi/runtime.ts 的 `createActiveMessage`。 */
const ACTIVE_MESSAGE_CUSTOM_TYPE = "deskpet.active_message"

/**
 * 尾随瞬时注记的自定义消息类型：构造点是 pi/runtime.ts 的 `createTurnNoteMessage`。
 *
 * 它由宿主在 `transform_context` 逐请求附加，**只存在于请求视图**，不落会话条目 ——
 * 因此必须与主动搭话一样归到瞬时输入，否则它的 token 会被记进 transcript 行，
 * 让「会话历史用了多少」这个读数虚高。
 */
export const TURN_NOTE_CUSTOM_TYPE = "deskpet.turn_note"

/** 请求视图中的记忆数据，不落 transcript，也不能再次提取为用户事实。 */
export const MEMORY_RECALL_CUSTOM_TYPE = "deskpet.memory_recall"

export function isMemoryRecallMessage(message: { role?: unknown; customType?: unknown } | undefined): boolean {
  return message?.role === "custom" && message.customType === MEMORY_RECALL_CUSTOM_TYPE
}

/**
 * 记忆召回块的唯一构造点（请求视图专用，不落会话条目）。
 *
 * 它带 `role: "custom"` 而不是 system：记忆是 derived 数据，不能升级成系统指令；
 * `eligibleForMemory=false` 保证召回内容不会被下一次整理当成用户事实重新提取。
 */
export function createMemoryRecallMessage(text: string): AgentMessage {
  return {
    role: "custom",
    customType: MEMORY_RECALL_CUSTOM_TYPE,
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

/**
 * 是否为「瞬时输入」消息：主动搭话、尾随瞬时注记（custom 消息）与带投递身份的用户输入。
 *
 * 这几类都是「这一回合投进来的输入」，不是会话历史的持久正文；transcript/ephemeral 的归属、
 * 以及跨这两个口径的 token 估算共用这一处判定（调用方不再各写一份 `role === "user"`）。
 * `options.isActiveMessage` 给「整轮都是主动搭话」的调用方一个显式声明（消息形状本身认不出来时用）。
 */
export function isTransientInputMessage(
  message: { role?: unknown; customType?: unknown; deskpetEventId?: unknown } | undefined,
  options?: { isActiveMessage?: boolean },
): boolean {
  if (message && message.role === "custom"
    && (message.customType === ACTIVE_MESSAGE_CUSTOM_TYPE || message.customType === TURN_NOTE_CUSTOM_TYPE
      || message.customType === MEMORY_RECALL_CUSTOM_TYPE)) return true
  if (message && message.role === "user" && typeof message.deskpetEventId === "string") return true
  return options?.isActiveMessage === true
}
