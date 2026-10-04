import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { clearLatestWindowObservation } from "./listener"
import { startBehavior, stopBehavior } from "@/services/behavior"
import { clearPresence } from "@/services/proactive/presence"
import type { RuntimeActivity } from "./types"

const log = createLogger("WindowMonitor")

/**
 * 开关窗口观察。采样由 Rust 侧原生事件驱动，不再有轮询间隔参数：
 * `general.desktop.pollingIntervalMs` 已退役、运行期无消费者（键暂留 CONFIG.yaml，待统一批次删除）。
 */
export async function setMonitorEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    clearLatestWindowObservation()
    stopBehavior()
    clearPresence("window-observation", "monitor_disabled")
  }
  await invoke("set_monitor_enabled", { enabled })
  if (enabled) startBehavior()
  log.info(`窗口观察${enabled ? "已开启" : "已关闭"}`)
}

export async function getRuntimeActivity(): Promise<RuntimeActivity> {
  return invoke<RuntimeActivity>("get_runtime_activity")
}
