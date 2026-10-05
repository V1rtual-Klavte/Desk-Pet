// ==========================================
// 窗口观察存储（Node 领域侧）
// ==========================================
//
// 本模块只持「最近一次观察 + 订阅者 + 乱序丢弃」，不 import Tauri/DOM：
// - 订阅入口在 `monitor.ts` 的 `initWindowObservation()`（领域引导调用一次）：
//   事件来自桥 `window-observed`（HostEventMap (a) 类，Rust monitor 双投）。

import { silentAccessConfig } from "@/services/config"
import { observeBehavior } from "@/services/behavior"
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

/** 卸载观察挂载时清空订阅者（旧 initWindowListener 的收尾语义，由 Node 侧接线复用）。 */
export function clearWindowObservationSubscribers(): void {
  subscribers.clear()
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
