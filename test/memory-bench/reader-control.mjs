const SYSTEM_PROMPT = "Answer the user's question using only the supplied chat history. If the history does not contain the answer, say you do not know. Do not invent facts."
const NOTE_SYSTEM_PROMPT = "You extract concise reading notes from one chat session for a later answer. Include only information relevant to the question, preserve dates and roles when useful, and output empty when the session has no relevant information. Do not answer the question."

export function requireCompleteReaderOutput(result, stage = "reader") {
  if (result.stopReason !== "stop")
    throw new Error(`reader-control ${stage} 未完整结束：stopReason=${result.stopReason}`)
  const text = String(result.text ?? "").trim()
  if (!text) throw new Error(`reader-control ${stage} 返回空文本`)
  return text
}

/** Build privileged eval-only prompts from the oracle evidence sessions, omitting every gold-label field. */
export function buildReaderControlPrompts(caseDef, mode) {
  if (mode !== "direct" && mode !== "con") throw new TypeError(`Unknown reader-control mode: ${mode}`)
  const sessions = (caseDef.sessions ?? []).map(session => ({
    sessionId: session.sessionId,
    sessionDate: session.date ?? new Date(session.observedAt).toISOString(),
    turns: session.turns.map(turn => {
      if (turn.role !== "user" && turn.role !== "assistant") throw new Error(`Unknown LongMemEval role: ${turn.role}`)
      return { turnIndex: turn.turnIndex, role: turn.role, content: turn.content }
    }),
  }))
  const questionDate = String(caseDef.questionDate ?? "")
  const question = String(caseDef.question ?? "")
  const notePrompts = sessions.map(session => `I will give you a chat history between you and a user, as well as a question from the user. Write reading notes to extract all relevant information useful for answering the question. If no relevant information is found, output exactly "empty".\n\nChat History:\nSession Date: ${session.sessionDate}\nSession Content:\n${JSON.stringify(session)}\n\nQuestion Date: ${questionDate}\nQuestion: ${question}\n\nExtracted note (information relevant to answering the question):`)
  const directHistory = JSON.stringify(sessions)
  const noteHistory = JSON.stringify(sessions.map(session => ({
    sessionId: session.sessionId, sessionDate: session.sessionDate, note: "<extracted per-session note>",
  })))
  return {
    systemPrompt: SYSTEM_PROMPT,
    noteSystemPrompt: NOTE_SYSTEM_PROMPT,
    sessions,
    notePrompts,
    finalPrompt(history) {
      const content = history ?? (mode === "direct" ? directHistory : noteHistory)
      return mode === "direct"
        ? `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\nHistory Chats:\n\n${content}\n\nCurrent Date: ${questionDate}\nQuestion: ${question}\nAnswer:`
        : `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\nHistory Chats:\n\n${content}\n\nCurrent Date: ${questionDate}\nQuestion: ${question}\nAnswer (step by step):`
    },
  }
}
