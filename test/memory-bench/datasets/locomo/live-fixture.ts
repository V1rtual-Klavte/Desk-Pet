import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { userInputMessage } from "@/services/engine/runtime"
import { acquirePiSession, createPiSession, PI_LANE, releasePiSession } from "@/services/session"
import type { MemorySource } from "@/services/agent/memory"
import { getActiveCard, saveCardText } from "@/services/personality"
import { formatLocomoAnswerCard, LOCOMO_ANSWER_FORMAT, renderLocomoDialogueEntry } from "./fixture.mjs"

interface LocomoConversation {
  sampleId: string
  speakers: { a: string; b: string }
  sessions: Array<{ session: number; dateText: string | null; observedAt: number | null;
    turns: Array<{ speaker: string; diaId: string; text: string; blipCaption?: string }> }>
}

export interface LocomoSourceMeta {
  observedAt: number
  sessionId: string
  turnIndex: number
  diaId: string
  role: "user" | "assistant"
}

/** Both human participants retain their names. The fixed role adapter is not a product identity claim. */
export async function buildLocomoHistory(conversation: LocomoConversation, evidenceChars: number): Promise<{
  sources: MemorySource[]; meta: Map<string, LocomoSourceMeta>
}> {
  const { a, b } = conversation.speakers
  if (!a || !b || a === b) throw new Error(`LoCoMo ${conversation.sampleId}: invalid participant metadata`)
  const sources: MemorySource[] = []
  const meta = new Map<string, LocomoSourceMeta>()
  for (const session of conversation.sessions) {
    const fixture = await createPiSession(`bench-locomo-${conversation.sampleId}-${session.session}`)
    try {
      const handle = await acquirePiSession(fixture.id)
      const branch = await handle.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
      const sessionSources: MemorySource[] = []
      for (const [index, turn] of session.turns.entries()) {
        if (turn.speaker !== a && turn.speaker !== b)
          throw new Error(`LoCoMo ${conversation.sampleId}/${turn.diaId}: unknown participant ${turn.speaker}`)
        const role = turn.speaker === a ? "user" : "assistant"
        const observedAt = (session.observedAt ?? 0) + index * 1_000
        const eventId = `bench-locomo-${conversation.sampleId}-${turn.diaId}`
        const body = renderLocomoDialogueEntry({ ...turn, dateText: session.dateText })
        const message = role === "user"
          ? { ...userInputMessage(body, eventId, {
            origin: "user", querySource: "chat", priority: "now", taint: "trusted_user", eligibleForMemory: true,
          }), timestamp: observedAt }
          : fauxAssistantMessage(body, { timestamp: observedAt })
        const entryId = await branch.appendMessage(message, BACKGROUND_CONTEXT)
        const sourceId = `${conversation.sampleId}:${turn.diaId}`
        const sourceMeta: LocomoSourceMeta = { observedAt, sessionId: fixture.id, turnIndex: index, diaId: turn.diaId, role }
        meta.set(`conversation:${fixture.id}:${entryId}`, sourceMeta)
        meta.set(sourceId, sourceMeta)
        // Participant B is quoted dialogue, never admitted as the user's own fact.
        if (role === "user") sessionSources.push({ sourceId, sessionId: fixture.id, entryId, eventId,
          seq: 0, contentHash: "", evidence: body.slice(0, evidenceChars), sourceLength: body.length,
          eligibleForMemory: true, taint: "trusted_user", origin: "user", observedAt })
      }
      const entries = await handle.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)
      const seqById = new Map(entries.map(entry => [entry.id, entry.seq]))
      for (const source of sessionSources) {
        const seq = seqById.get(source.entryId)
        if (seq === undefined) throw new Error(`LoCoMo JSONL source not committed: ${source.sourceId}`)
        source.seq = seq
        sources.push(source)
      }
    } finally { await releasePiSession(fixture.id) }
  }
  return { sources, meta }
}

/** Only the isolated benchmark root's active Card is edited; restore even after a failed question. */
export async function installLocomoAnswerPolicy(): Promise<() => Promise<void>> {
  const card = getActiveCard()
  if (!card) throw new Error("LoCoMo answer policy requires an active Card")
  const { id, rawContent } = card
  const result = await saveCardText(id, formatLocomoAnswerCard(rawContent))
  if (!result.ok) throw new Error(`LoCoMo answer Card installation failed: ${result.message}`)
  if (getActiveCard()?.id !== id || !getActiveCard()?.sections.outputRules.includes(LOCOMO_ANSWER_FORMAT.prompt)) {
    const restored = await saveCardText(id, rawContent)
    throw new Error(`LoCoMo answer Card did not refresh in the active registry; restoration=${restored.ok}`)
  }
  return async () => {
    const restored = await saveCardText(id, rawContent)
    if (!restored.ok) throw new Error(`LoCoMo answer Card restoration failed: ${restored.message}`)
    if (getActiveCard()?.id !== id || getActiveCard()?.rawContent !== rawContent)
      throw new Error("LoCoMo answer Card restoration did not refresh in the active registry")
  }
}
