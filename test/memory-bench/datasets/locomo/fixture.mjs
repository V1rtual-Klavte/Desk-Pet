/** Render one original LoCoMo human turn as a traceable JSONL message body. */
export function renderLocomoDialogueEntry({ speaker, dateText, text, blipCaption }) {
  const caption = typeof blipCaption === "string" && blipCaption.length > 0
    ? `\n[shared image caption] ${blipCaption}` : ""
  return `speaker: ${speaker}\nsession_date: ${dateText ?? "unknown"}\n${text}${caption}`
}

/** One predeclared output policy for every question; no QA/category/gold inputs. */
export const LOCOMO_ANSWER_FORMAT = {
  id: "uniform-english-short-answer",
  prompt: "For this evaluation, the visible answer must be a concise English phrase, without greetings or explanations. These task-specific language and length requirements take precedence over the Card's general conversational style. Use exact words from the conversation whenever possible. Include all items, dates, numbers and qualifications needed to answer the question completely; do not omit required information merely to be brief. If the available evidence is insufficient to answer, reply exactly: No information available. Do not invent missing facts. Keep following the system's reply-metadata protocol; that metadata is not part of the visible answer.",
}

/** Uniform task context, independent of answer/category/evidence labels. */
export function formatLocomoQuestion(question) {
  return `Answer using our conversation history:\n${question}`
}

export function formatLocomoAnswerCard(rawCard) {
  if (rawCard.includes(LOCOMO_ANSWER_FORMAT.prompt)) return rawCard
  const heading = /^# 输出规则\s*$/mu
  return heading.test(rawCard)
    ? rawCard.replace(heading, headingText => `${headingText}\n\n${LOCOMO_ANSWER_FORMAT.prompt}`)
    : `${rawCard}\n\n# 输出规则\n${LOCOMO_ANSWER_FORMAT.prompt}\n`
}
