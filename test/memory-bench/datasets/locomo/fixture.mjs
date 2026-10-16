/** Render one original LoCoMo human turn as a traceable JSONL message body. */
export function renderLocomoDialogueEntry({ speaker, dateText, text, blipCaption }) {
  const caption = typeof blipCaption === "string" && blipCaption.length > 0
    ? `\n[shared image caption] ${blipCaption}` : ""
  return `speaker: ${speaker}\nsession_date: ${dateText ?? "unknown"}\n${text}${caption}`
}

/** One predeclared output policy for every question; no QA/category/gold inputs. */
export const LOCOMO_ANSWER_FORMAT = {
  id: "uniform-english-short-answer",
  prompt: "For this evaluation, return only the complete answer as a short English phrase. Omit greetings, reasoning, evidence discussion, speaker attribution and facts not requested by the question. These task-specific language and length requirements take precedence over the Card's general conversational style. Use exact words from the conversation whenever possible. Include every requested item, date, number and necessary qualification. Express counts with digits (for example, 2 rather than twice). Preserve negation, uncertainty and likelihood; separate multiple items with commas. A when-question needs only the requested date or period; a who/what-question needs only the requested names or things. When asked for the name or title of a work, give only the title; omit its author, performer or creator unless that person is also requested. Do not add associated titles, dates, later plans or explanations unless asked. For a question about a past event, verify that the named person actually experienced that event; hearing about or reacting to someone else's event does not establish that premise. For a hypothetical preference or willingness question, use relevant personal evidence and retain a likely/unlikely qualification; the hypothetical event need not have occurred. Do not infer identity or diagnosis from silence. If the available evidence is insufficient to answer the question as asked, reply exactly: No information available. Do not substitute a related event or invent missing facts. Keep following the system's reply-metadata protocol; that metadata is not part of the visible answer.",
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
