/** Persisted evidence paired with one assistant message; never a Provider prompt field. */
export interface DeskpetReplyEvidence {
  schemaVersion: 1
  /** Generated visible text after internal protocol stripping, before presentation transforms. */
  generatedText: string
  outcome: "delivered" | "silent" | "fallback" | "cancelled" | "error"
  humanizerEnabled: boolean
  transformation: "none" | "formatting"
}

/** Runtime validation for persisted JSON metadata consumed by evidence tooling. */
export function isDeskpetReplyEvidence(value: unknown): value is DeskpetReplyEvidence {
  if (typeof value !== "object" || value === null) return false
  const evidence = value as Record<string, unknown>
  const keys = Object.keys(evidence).sort()
  if (keys.join(",") !== "generatedText,humanizerEnabled,outcome,schemaVersion,transformation") return false
  return evidence.schemaVersion === 1
    && typeof evidence.generatedText === "string"
    && typeof evidence.outcome === "string"
    && ["delivered", "silent", "fallback", "cancelled", "error"].includes(evidence.outcome)
    && typeof evidence.humanizerEnabled === "boolean"
    && (evidence.transformation === "none" || evidence.transformation === "formatting")
}
