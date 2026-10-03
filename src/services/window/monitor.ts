import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { clearLatestWindowObservation } from "./listener"
import { startBehavior, stopBehavior } from "@/services/behavior"
import { clearPresence } from "@/services/proactive/presence"
import type { RuntimeActivity } from "./types"

const log = createLogger("WindowMonitor")

export async function setMonitorEnabled(enabled: boolean, pollingIntervalMs: number): Promise<void> {
  if (!enabled) {
    clearLatestWindowObservation()
    stopBehavior()
    clearPresence("window-observation", "monitor_disabled")
  }
  await invoke("set_monitor_enabled", { enabled, pollingIntervalMs })
  if (enabled) startBehavior()
  log.info(`窗口观察${enabled ? "已开启" : "已关闭"}`)
}

export async function getRuntimeActivity(): Promise<RuntimeActivity> {
  return invoke<RuntimeActivity>("get_runtime_activity")
}
