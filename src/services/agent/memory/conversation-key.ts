// One canonical transcript event identity. The user entry owns the event; an
// assistant reply resolves its anchor back to that same owner, so a query hit on
// either side admits the complete group instead of orphaning one role.
export interface ConversationKeyEntry {
  sessionId: string
  entryId: string
  role: "user" | "assistant"
  eventId?: string | null
  anchorEntryId?: string | null
  anchorEventId?: string | null
}

export type ConversationKeyAliases = ReadonlyMap<string, string>

export function conversationKeyAliases(entries: readonly ConversationKeyEntry[]): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const entry of entries) {
    if (entry.role !== "user") continue
    aliases.set(`${entry.sessionId}:entry:${entry.entryId}`, entry.entryId)
    if (entry.eventId) aliases.set(`${entry.sessionId}:event:${entry.eventId}`, entry.entryId)
  }
  return aliases
}

export function conversationEventKey(entry: ConversationKeyEntry, aliases: ConversationKeyAliases = new Map()): string {
  const owner = entry.role === "user"
    ? entry.entryId
    : entry.anchorEntryId
      ? aliases.get(`${entry.sessionId}:entry:${entry.anchorEntryId}`) ?? entry.anchorEntryId
      : entry.anchorEventId
        ? aliases.get(`${entry.sessionId}:event:${entry.anchorEventId}`) ?? entry.anchorEventId
        : entry.entryId
  return `conversation:${entry.sessionId}:event:${owner}`
}
