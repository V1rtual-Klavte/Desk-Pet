export type ObservationState = "observed" | "unavailable" | "locked" | "suspended" | "disabled"

/**
 * 系统 idle 超过该时长即归入空闲：不计活跃工作，也不作为「有可靠活跃信号」的证据。
 * 观察、画像与主动规则共用这一阈值（零依赖叶子，避免跨领域各存一份）。
 */
export const IDLE_ACTIVE_LIMIT_MS = 5 * 60_000

export interface WindowObservation {
  appId: string | null
  app: string | null
  title: string | null
  observedAt: number
  sampleMonoMs: number
  monitorGeneration: number
  sequence: number
  observationState: ObservationState
  idleForMs: number | null
  isPetVisible: boolean
  isPetForeground: boolean
}

export interface RuntimeActivity {
  isPetVisible: boolean
  isPetForeground: boolean
  observationState: "observed" | "locked" | "unavailable"
  idleForMs: number | null
  observedAt: number
}

export type AppCategory = "work" | "communication" | "media" | "development" | "browser" | "other" | "unknown"
