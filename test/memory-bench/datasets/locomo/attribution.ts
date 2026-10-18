// LoCoMo adapter-only speaker attribution.
//
// The benchmark keeps both human participants as named speakers, while the product
// is a 1:1 chat and has no `speaker:` transcript convention. The adapter knows the
// conversation's speaker mapping, so question-subject attribution belongs here,
// not in `src/services/agent/memory`.

import type { MemoryProjection } from "@/services/agent/memory"

export type LocomoSpeakerRole = "user" | "assistant"

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/['’]s\b/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

const PERSON_ENUMERATION_CUE =
  /\b(?:favorite|favourite|favorites|favourites|hobby|hobbies|activity|activities|dessert|desserts|food|foods|book|books|movie|movies|place|places|thing|things|item|items|like|likes|enjoy|enjoys|prefer|prefers|own|owns|made|make|makes|recommend|recommends|recommended)\b|(?:喜欢|最爱|爱好|活动|甜点|甜品|食物|书|电影|地方|东西|做过|推荐)/iu

/**
 * Map the person named by a possessive in the question to the LoCoMo role.
 * Speaker A is the adapter's user-fact channel, speaker B is conversation-only.
 * Non-person possessives (company's policies) and questions without a cue return
 * undefined, so the adapter leaves the projection set untouched.
 */
export function locomoQuestionSpeakerRole(
  question: string,
  speakers: { a: string; b: string },
): LocomoSpeakerRole | undefined {
  if (!PERSON_ENUMERATION_CUE.test(question)) return undefined
  const names = [
    ...[...question.matchAll(/([\p{L}][\p{L}\p{N}'’-]*)(?:'s|’s)\b/gu)].map(match => match[1]!),
    ...[...question.matchAll(/([\p{Script=Han}]{2,4})的/gu)].map(match => match[1]!),
  ].map(normalizeName).filter(Boolean)
  if (!names.length) return undefined
  const matches = (speaker: string) => {
    const normalized = normalizeName(speaker)
    if (!normalized) return false
    const speakerTokens = new Set(normalized.split(/\s+/u).filter(Boolean))
    return names.some(name => name === normalized
      || name.split(/\s+/u).some(token => speakerTokens.has(token)))
  }
  if (matches(speakers.b)) return "assistant"
  if (matches(speakers.a)) return "user"
  return undefined
}

/**
 * Benchmark-only post-filter: enumeration questions are about one participant's
 * items, so drop the other participant's conversation turns. Facts without a
 * conversation ref are left intact.
 */
export function filterLocomoEnumerationProjections(
  projections: readonly MemoryProjection[],
  role: LocomoSpeakerRole,
): MemoryProjection[] {
  return projections.filter(item => !item.conversation || item.conversation.role === role)
}
