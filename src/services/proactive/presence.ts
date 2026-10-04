import { getPresenceStage } from "@/services/personality"
import { getBehaviorSnapshot, IDLE_ACTIVE_LIMIT_MS } from "@/services/behavior"
import { releaseTitlebarStatus, setTitlebarStatus } from "@/services/titlebar"
import type { WindowObservation } from "@/services/window"

export type PresenceState = "idle" | "working" | "resting"
export interface PresenceSnapshot {
  state: PresenceState
  reason: string
  changedAt: number
  expiresAt: number | null
  sourceOwner: string | null
  motion: { id: number; startedAt: number; expiresAt: number } | null
}

const PRESENCE_OWNER = "proactive-presence"
const PRESENCE_PRIORITY = 10
const WORKING_MS = 30 * 60_000
const MOTION_MS = 2_000
const MOTION_LIMIT_PER_HOUR = 2
let motionId = 0
let motionTimes: number[] = []
let motionTimer: ReturnType<typeof setTimeout> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let motionOwner: string | null = null
let snapshot: PresenceSnapshot = { state: "idle", reason: "default", changedAt: Date.now(), expiresAt: null, sourceOwner: null, motion: null }
const subscribers = new Set<(value: PresenceSnapshot) => void>()

function publish(): void {
  if (snapshot.state === "idle" && !snapshot.motion) releaseTitlebarStatus(PRESENCE_OWNER)
  else setTitlebarStatus(PRESENCE_OWNER, getPresenceStage(snapshot.state), PRESENCE_PRIORITY)
  for (const subscriber of subscribers) subscriber({ ...snapshot, motion: snapshot.motion && { ...snapshot.motion } })
}

export function getPresence(): PresenceSnapshot { return { ...snapshot, motion: snapshot.motion && { ...snapshot.motion } } }
export function subscribePresence(callback: (value: PresenceSnapshot) => void): () => void {
  subscribers.add(callback)
  callback(getPresence())
  return () => subscribers.delete(callback)
}

export function setPresence(state: PresenceState, options: { reason: string; sourceOwner: string; expiresAt?: number }): void {
  const now = Date.now()
  if (snapshot.sourceOwner && snapshot.sourceOwner !== options.sourceOwner) return
  snapshot = { state, reason: options.reason, changedAt: now, expiresAt: options.expiresAt ?? null, sourceOwner: options.sourceOwner, motion: snapshot.motion }
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  if (snapshot.expiresAt !== null) {
    const owner = options.sourceOwner
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      clearPresence(owner, "expired")
    }, Math.max(0, snapshot.expiresAt - now))
  }
  publish()
}

export function clearPresence(sourceOwner: string, reason = "released"): boolean {
  if (snapshot.sourceOwner !== sourceOwner) return false
  if (motionTimer) clearTimeout(motionTimer)
  if (expiryTimer) clearTimeout(expiryTimer)
  motionTimer = null
  expiryTimer = null
  if (motionOwner === sourceOwner) motionOwner = null
  snapshot = { state: "idle", reason, changedAt: Date.now(), expiresAt: null, sourceOwner: null, motion: null }
  publish()
  return true
}

export function observePresence(observation: WindowObservation, cardId?: string): PresenceSnapshot {
  const now = observation.observedAt
  if (observation.observationState !== "observed" || !observation.isPetVisible || !observation.appId) {
    clearPresence("window-observation", observation.observationState)
    return getPresence()
  }
  const behavior = getBehaviorSnapshot(now).focus
  const previousState = snapshot.state
  const systemIdle = observation.idleForMs !== null && observation.idleForMs >= IDLE_ACTIVE_LIMIT_MS
  // 事件驱动采样下只有前台变化才会再有观察，presence 因此不设到期时间：
  // 由下一条观察（状态矛盾/锁屏/关闭观察）显式释放，避免在安静但持续的
  // 工作片段里到期闪断。释放路径：clearPresence / stopPresence / 监控关闭。
  if (systemIdle) {
    setPresence("resting", { reason: "observed_idle", sourceOwner: "window-observation" })
  } else if ((behavior.currentCategory === "work" || behavior.currentCategory === "development")
    && behavior.currentContinuousMs >= WORKING_MS) {
    setPresence("working", { reason: "continuous_work_context", sourceOwner: "window-observation" })
  } else if (behavior.currentCategory === "media") {
    setPresence("resting", { reason: "observed_leisure_context", sourceOwner: "window-observation" })
  } else {
    clearPresence("window-observation", "context_changed")
  }
  if (snapshot.state !== "working" && snapshot.state !== previousState) requestBriefMotion(now)
  void cardId
  return getPresence()
}

/** 只请求桌面角色容器的一次轻微动作，不移动窗口或触发音频。 */
export function requestBriefMotion(now = Date.now(), owner = "window-observation"): PresenceSnapshot {
  motionTimes = motionTimes.filter((time) => now - time < 60 * 60_000)
  if (motionTimes.length >= MOTION_LIMIT_PER_HOUR || snapshot.state === "working") return getPresence()
  motionTimes.push(now)
  motionOwner = owner
  if (motionTimer) clearTimeout(motionTimer)
  snapshot = { ...snapshot, motion: { id: ++motionId, startedAt: now, expiresAt: now + MOTION_MS } }
  publish()
  motionTimer = setTimeout(() => {
    snapshot = { ...snapshot, motion: null }
    motionOwner = null
    motionTimer = null
    publish()
  }, MOTION_MS)
  return getPresence()
}

export function stopPresence(owner: string): void {
  if (snapshot.sourceOwner === owner) clearPresence(owner, "stopped")
  if (motionOwner === owner) {
    if (motionTimer) clearTimeout(motionTimer)
    motionTimer = null; motionOwner = null
    snapshot = { ...snapshot, motion: null }
    publish()
  }
}
