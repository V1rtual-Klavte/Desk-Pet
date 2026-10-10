// Shared local query cues; no model call or runtime dependencies.

export function hasExplicitRewriteHint(query: string): boolean {
  return /(?:刚才|刚刚|之前|以前|上次|前面|提过|说过|我们聊过|你还记得|那个(?:偏好|习惯|东西|人|事情)?|那件事|那位|这件事|我喜欢|我的偏好|用户偏好|我的习惯|个人资料|画像|remember|previous|earlier|what did i (?:say|tell you)|my preference|about me)/iu.test(query)
}

const SOCIAL_ACKNOWLEDGEMENT = /^(?:你好|嗨|哈喽|hello|hi|谢谢|感谢|好的|好|收到|明白|知道了|嗯|ok|okay|got it|thanks|thank you)[!！?？。，,.\s]*$/iu
const SHORT_FOLLOWUP = /(?:这|那|它|他|她|然后|接下来|这个|那个|呢|再说|继续|\b(?:that|this|it|those|them|and then|what about|how about)\b)/iu
const PERSONAL_HISTORY_QUESTION = /(?:\b(?:what|which|when|where|how|who)\b.{0,140}\b(?:did you|did we|did i|have you|have we|have i|had i|i (?:was|am|earned|spent|bought|started|attended|took|have)|my)\b|\b(?:did you|did we|have you|have we)\b.{0,100}\b(?:recommend(?:ed)?|suggest(?:ed)?|mention(?:ed)?|say|said|tell|told|choose|decide)\b|\bwhat did i (?:say|tell|choose)\b|\bwhat (?:is|are|was|were) my\b|\bwhat do i\b|\bmy (?:favorite|favourite|preference|habit|usual|choice|plan|address|birthday|name)\b|我的(?:偏好|习惯|选择|安排|名字|地址|生日)|我(?:平时|通常|之前|上次).{0,12}(?:喜欢|选择|说过|告诉过)|我们(?:之前|上次|当时).{0,12}(?:决定|选定|说过)|你(?:刚才|之前|上次|当时).{0,12}(?:推荐|建议|提到|说过|告诉过))/iu
const PERSONAL_ADVICE = /(?:\b(?:recommend|suggest)\b.{0,100}\b(?:for me|i|my)\b|\b(?:i['’]ve|i have|i am|i['’]m)\b.{0,100}\b(?:trouble|struggling|advice|tips|recommend)\b|给我.{0,12}(?:推荐|建议)|(?:我|我的).{0,24}(?:困扰|遇到问题|不太顺利|有何建议|怎么办))/iu

/** Personal history and advice require recall even when a few keyword facts already match. */
export function hasPersonalRecallIntent(query: string): boolean {
  return PERSONAL_HISTORY_QUESTION.test(query) || PERSONAL_ADVICE.test(query)
}

export function hasAdaptiveQueryShape(query: string): boolean {
  const normalized = query.trim()
  if (!normalized || SOCIAL_ACKNOWLEDGEMENT.test(normalized)) return false
  const shortFollowup = [...normalized].length <= 100 && SHORT_FOLLOWUP.test(normalized)
  return shortFollowup || hasPersonalRecallIntent(normalized)
}

export function hasAdaptiveRecallCue(
  query: string,
  context: readonly { role: "user" | "assistant"; text: string }[],
): boolean {
  const normalized = query.trim()
  if (SOCIAL_ACKNOWLEDGEMENT.test(normalized)) return false
  const shortFollowup = [...normalized].length <= 100 && context.length > 0 && SHORT_FOLLOWUP.test(normalized)
  const personalHistoryQuestion = hasPersonalRecallIntent(normalized)
  return shortFollowup || personalHistoryQuestion
}
