/**
 * 输入身份：投递到 lane 的用户消息带 `deskpetEventId = `${requestId}:user``，
 * 这是「这一条输入」在持久层的唯一主键 —— 会话条目、lane inbox 项与请求快照都按它对齐。
 *
 * 零依赖叶子：ingress、运行槽与投递证据查询共用，避免各处手写同一段字符串拼接/截取。
 * 这里只做身份换算，不做归属判断（「是否已进入请求」由投递证据查询回答）。
 */

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
