export type ObservationState = "observed" | "unavailable" | "locked" | "suspended" | "disabled"

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
