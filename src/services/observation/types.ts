export type ObservationKind = "screenshot" | "file" | "window"

export interface UnderstandingRecord {
  sourceId: string
  kind: ObservationKind
  observedAt: number
  expiresAt: number
  summary: string
}

export interface TopicEvidence {
  topic: string
  weight: number
  sourceId: string
  observedAt: number
  cardId?: string
}

export interface UnderstandingSnapshot {
  revision: number
  generatedAt: number
  quality: "thin" | "ready" | "unavailable"
  observations: UnderstandingRecord[]
}

export interface TopicWeight {
  topic: string
  weight: number
}

export interface CommittedUserParticipation {
  sessionId: string
  entryId: string
  committedAt: number
  text: string
  committed: boolean
  origin: string
  taint: string
  eligibleForMemory: boolean
  cardId?: string
}
