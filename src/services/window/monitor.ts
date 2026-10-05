import { silentAccessConfig } from "@/services/config"
import { formatError } from "@/services/error"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { isNoEventChannelError } from "@/services/native-ui"
import { acceptWindowObservation, clearLatestWindowObservation, clearWindowObservationSubscribers } from "./listener"
import { startBehavior, stopBehavior } from "@/services/behavior"
import { clearPresence } from "@/services/proactive/presence"
import type { RuntimeActivity } from "./types"

const log = createLogger("WindowMonitor")

/** Node 侧观察订阅句柄（领域引导接线一次；退订后置回 null 允许重接）。 */
let bridgeUnsubscribe: (() => void) | null = null

/**
 * Node 侧观察接线（领域引导 `@/services/init` 调用一次）。
 *
 * - 订阅宿主双投的 `window-observed`（原生宿主迁移过程记录 §9.4 第 2 条：原生 UI 一腿 + 当前代际 Node 一腿）；
 * - 按 `ai.silentAccess.enabled` 应用观察总闸：`setMonitorEnabled` 是既有开关入口，
 *   内含 Rust 总闸请求与行为采集启停（`startBehavior`/`stopBehavior`），不另建第二入口。
 *
 * 幂等：重复调用复用同一订阅，不叠加监听器（引导本身的进程内单次闩是第一道保证，
 * 这里的句柄是第二道）。返回退订句柄（幂等）：只解除 Node 侧订阅并清空观察存储与
 * 订阅者，不改 Rust 总闸；引导是进程级的、没有卸载点，句柄由本模块持有，语义上不泄漏监听器。
 *
 * 没有事件通道的宿主（无原生 UI 请求面，如 Node 测试宿主）跳过订阅与总闸并留痕后返回
 * 空退订；桥未注入/已断开等其它错误照旧向上抛（不降级、不掩盖）。
 */
export async function initWindowObservation(): Promise<() => void> {
  if (!bridgeUnsubscribe) {
    try {
      const unsubscribe = getHostBridge().subscribe("window-observed", acceptWindowObservation)
      bridgeUnsubscribe = () => {
        unsubscribe()
        clearLatestWindowObservation()
        clearWindowObservationSubscribers()
        bridgeUnsubscribe = null
      }
    } catch (error) {
      // 没有事件通道的宿主（无原生 UI 请求面，如 Node 测试宿主）：观察没有来源，
      // 跳过订阅与总闸并留痕（判据与 native-ui 的桥跳过同源：isNoEventChannelError）；
      // 桥未注入/已断开等其它错误照旧向上抛，不在这里掩盖。
      if (!isNoEventChannelError(error)) throw error
      log.warn(`窗口观察接线跳过：宿主没有事件通道（${formatError(error)}）`)
      return () => {}
    }
  }
  await setMonitorEnabled(silentAccessConfig.enabled)
  log.info(`window-observed 已订阅；观察总闸${silentAccessConfig.enabled ? "已开启" : "已关闭"}`)
  return bridgeUnsubscribe
}

/** 关停时解除当前 Node 代际订阅，避免 flush 期间继续接收观察事件。 */
export function disconnectWindowObservation(): void {
  bridgeUnsubscribe?.()
}

/**
 * 开关窗口观察。采样由 Rust 侧原生事件驱动，不再有轮询间隔参数：
 * `general.desktop.pollingIntervalMs` 已退役并随该批次从 CONFIG 模板、类型定义与原生
 * 设置窗 schema 一并删除。
 */
export async function setMonitorEnabled(enabled: boolean): Promise<boolean> {
  let behaviorFlushed = true
  if (!enabled) {
    clearLatestWindowObservation()
    behaviorFlushed = await stopBehavior()
    clearPresence("window-observation", "monitor_disabled")
  }
  await getHostBridge().request("set_monitor_enabled", { enabled })
  if (enabled) startBehavior()
  log.info(`窗口观察${enabled ? "已开启" : "已关闭"}`)
  return behaviorFlushed
}

export async function getRuntimeActivity(): Promise<RuntimeActivity> {
  return getHostBridge().request("get_runtime_activity", {})
}
