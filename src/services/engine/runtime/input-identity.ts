/**
 * 输入身份与来源标记：投递到 lane 的用户消息带 `deskpetEventId = `${requestId}:user``，
 * 这是「这一条输入」在持久层的唯一主键 —— 会话条目、lane inbox 项与请求快照都按它对齐；
 * 同一条消息可带 `deskpetSource`（`InputSourceMark`），来源因此随输入一起落盘。
 *
 * 零依赖叶子：ingress、运行槽与投递证据查询共用，避免各处手写同一段字符串拼接/截取。
 * 这里只做身份换算与消息构造，不做归属判断（「是否已进入请求」由投递证据查询回答）。
 *
 * `userInputMessage()` 是投递消息形状的唯一构造点：空闲回合的 prompt 与忙碌投递的 inbox
 * 消息都由它构造，所有入口的身份与标记口径一致（不再有无身份的裸字符串）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core"
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
export function messageEventId(message: { deskpetEventId?: unknown }): string | undefined {
  const eventId = message.deskpetEventId
  return typeof eventId === "string" && eventId.endsWith(USER_SUFFIX) ? eventId : undefined
}

/** 从 lane 消息上取回宿主 requestId；不是投递输入的消息返回 undefined。 */
export function messageRequestId(message: { deskpetEventId?: unknown }): string | undefined {
  const eventId = messageEventId(message)
  return eventId === undefined ? undefined : eventId.slice(0, -USER_SUFFIX.length)
}

/** 来源标记在消息上的字段名：与 `deskpetEventId` 并列，随条目一起持久化。 */
export const INPUT_SOURCE_FIELD = "deskpetSource"

/** 由入口 ingress 投影出随消息落盘的来源标记（ingress 是唯一真相源）。 */
export function inputSourceMark(ingress: IngressEnvelope): InputSourceMark {
  return {
    origin: ingress.origin,
    querySource: ingress.querySource,
    priority: ingress.priority,
    taint: ingress.taint,
    // 只有用户本人的可信输入能成为长期事实：主动消息、恢复续跑与外部内容都不行。
    eligibleForMemory: ingress.origin === "user" && ingress.taint === "trusted_user",
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
  }
}
