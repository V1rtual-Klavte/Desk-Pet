export type ObservationKind = "screenshot" | "file" | "dir" | "window"

export interface UnderstandingRecord {
  sourceId: string
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
