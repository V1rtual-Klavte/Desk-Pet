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

/**
 * `get_runtime_activity` 命令的一次性运行活动快照。
 * `screenState` 是屏幕能力维度（`locked` = 锁屏：截图无意义但状态可知）；
 * 事件负载 `WindowObservation.observationState` 是监控生命周期维度（另含
 * suspended/disabled），两者语义不同，后者保持原名不做同步。
 */
export interface RuntimeActivity {
  isPetVisible: boolean
  isPetForeground: boolean
  screenState: "observed" | "locked" | "unavailable"
  idleForMs: number | null
  observedAt: number
}

export type AppCategory = "work" | "communication" | "media" | "development" | "browser" | "other" | "unknown"
