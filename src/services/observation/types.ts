export type ObservationKind = "screenshot" | "file" | "dir" | "window"

export interface UnderstandingRecord {
  sourceId: string
  /** Hash of the stable artifact identity; never a copy of the path or observed text. */
  evidenceId?: string
  /** Hash of the observed input version; never counts as an independent source. */
  evidenceHash?: string
  kind: ObservationKind
  observedAt: number
  expiresAt: number
  summary: string
  /** 本批实际读取的路径（了解层审计，可回看 AI 读了什么）；截图/窗口来源没有。 */
  targets?: string[]
}

/** 一次宿主读取请求的目标（决策输出的宿主侧形态）。 */
export interface ReadTargetRequest {
  path: string
  kind: "dir" | "file"
}

/** 宿主逐目标的如实结果：status=skipped 时 detail 说明原因，不猜测、不崩整批。 */
export interface TargetReadResult {
  path: string
  kind: "dir" | "file"
  status: "read" | "listed" | "skipped"
  detail: string
  names?: string[]
  content?: string
}

export interface TopicEvidence {
  topic: string
  category: TopicCategory
  stance: TopicStance
  sensitivity: TopicSensitivity
  weight: number
  sourceId: string
  observedAt: number
  cardId?: string
}

export interface UnderstandingSnapshot {
  revision: number
  generatedAt: number
  quality: "thin" | "ready" | "unavailable"
  /** Number of visible observation rows; this is coverage, not independent evidence quality. */
  coverage: number
  independentSources: number
  observations: UnderstandingRecord[]
}

export type TopicCategory = "technology" | "work" | "study" | "hobby" | "daily_life" | "entertainment" | "other"
export type TopicStance = "asserted" | "neutral" | "negative" | "quoted" | "hypothetical" | "negated" | "uncertain"
export type TopicSensitivity = "none" | "sensitive" | "unknown"

export interface TopicWeight {
  topic: string
  weight: number
  /** Source stances remain attached so consumers can read this as participation, not preference. */
  stances: TopicStance[]
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
