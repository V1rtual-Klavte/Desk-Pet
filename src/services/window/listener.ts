import { type Ref } from "vue"
import { listen } from "@tauri-apps/api/event"
import { silentAccessConfig } from "@/services/config"
import { observeBehavior, startBehavior } from "@/services/behavior"
import { createLogger } from "@/services/logger"
import type { WindowObservation } from "./types"

const log = createLogger("WindowObservation")

let latestObservation: WindowObservation | null = null
let latestGeneration = 0
let latestSequence = 0
const subscribers = new Set<(observation: WindowObservation) => void>()

export function getLatestWindowObservation(): WindowObservation | null {
  return silentAccessConfig.enabled ? latestObservation : null
}

export function clearLatestWindowObservation(): void {
  latestObservation = null
}

export function subscribeWindowObservations(callback: (observation: WindowObservation) => void): () => void {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}

export function acceptWindowObservation(value: unknown): boolean {
  if (!isWindowObservation(value)) {
    log.warn("丢弃结构无效的 window-observed 载荷")
    return false
  }
  const observation = value
  if (!silentAccessConfig.enabled && observation.observationState !== "disabled") return false
  if (observation.monitorGeneration < latestGeneration
    || observation.monitorGeneration === latestGeneration && observation.sequence <= latestSequence) {
    log.debug("丢弃重复或乱序 observation", { generation: observation.monitorGeneration, sequence: observation.sequence })
    return false
  }
  if (observation.monitorGeneration !== latestGeneration) {
    latestGeneration = observation.monitorGeneration
    latestSequence = 0
  }
  latestSequence = observation.sequence
  latestObservation = observation.observationState === "disabled" ? null : observation
  void observeBehavior(observation)
  for (const callback of subscribers) {
    try { callback(observation) }
    catch (error) { log.error("window-observed subscriber failed", error instanceof Error ? error : undefined) }
  }
  return true
}

export async function initWindowListener(winSize: Ref<{ w: number; h: number }>): Promise<() => void> {
  const unlisten = await listen<WindowObservation>("window-observed", ({ payload }) => { acceptWindowObservation(payload) })
  if (silentAccessConfig.enabled) startBehavior()
  const observer = new ResizeObserver(() => { winSize.value = { w: window.innerWidth, h: window.innerHeight } })
  observer.observe(document.body)
  log.info("window-observed listener 已启动")
  return () => {
    unlisten()
    observer.disconnect()
    clearLatestWindowObservation()
    subscribers.clear()
  }
}

function isWindowObservation(value: unknown): value is WindowObservation {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<WindowObservation>
  const states = ["observed", "unavailable", "locked", "suspended", "disabled"]
  return (item.appId === null || typeof item.appId === "string")
    && (item.app === null || typeof item.app === "string")
    && (item.title === null || typeof item.title === "string")
    && Number.isSafeInteger(item.observedAt) && Number.isFinite(item.sampleMonoMs)
    && Number.isSafeInteger(item.monitorGeneration) && (item.monitorGeneration ?? -1) >= 0
    && Number.isSafeInteger(item.sequence) && (item.sequence ?? 0) > 0
    && states.includes(item.observationState ?? "")
    && (item.idleForMs === null || Number.isFinite(item.idleForMs))
    && typeof item.isPetVisible === "boolean" && typeof item.isPetForeground === "boolean"
}
