import { silentAccessFrequency } from "@/services/proactive/tiers"
import { formatError } from "@/services/error"
import { getHostBridge, HOST_EVENT_WINDOW_OBSERVED } from "@/services/host"
import { createLogger } from "@/services/logger"
import { isNoEventChannelError } from "@/services/native-ui"
import { acceptWindowObservation, clearLatestWindowObservation, clearWindowObservationSubscribers } from "./listener"
import { startBehavior, stopBehavior } from "@/services/behavior"
import { clearPresence } from "@/services/proactive/presence"
import type { RuntimeActivity } from "./types"

const log = createLogger("WindowMonitor")

/** 观察态不可用留痕的同因限频窗口：同一原因 10 分钟内只打一次，避免每次采样刷屏。 */
const OBSERVATION_GATE_WARN_INTERVAL_MS = 10 * 60_000

/** Node 侧观察订阅句柄（领域引导接线一次；退订后置回 null 允许重接）。 */
let bridgeUnsubscribe: (() => void) | null = null

/** 上次「观察态不可用」告警的状态与时刻；可用状态后由 getRuntimeActivity 清空重来。 */
let lastObservationWarnState: RuntimeActivity["screenState"] | null = null
let lastObservationWarnAt: number | null = null

/**
 * Node 侧观察接线（领域引导 `@/services/init` 调用一次）。
 *
 * - 订阅宿主双投的 `window-observed`（原生宿主迁移过程记录 §9.4 第 2 条：原生 UI 一腿 + 当前代际 Node 一腿）；
 * - 按静默了解档位（`ai.silentAccess.frequency`，off = 观察总闸关闭）应用观察总闸：
 *   `setMonitorEnabled` 是既有开关入口，内含 Rust 总闸请求与行为采集启停
 *   （`startBehavior`/`stopBehavior`），不另建第二入口。
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
      const unsubscribe = getHostBridge().subscribe(HOST_EVENT_WINDOW_OBSERVED, acceptWindowObservation)
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
  const monitorEnabled = silentAccessFrequency() !== "off"
  await setMonitorEnabled(monitorEnabled)
  log.info(`window-observed 已订阅；观察总闸${monitorEnabled ? "已开启" : "已关闭"}`)
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

/**
 * 「观察态不可用」告警的限频判定（纯函数，注入 now 便于单测；状态记忆由调用方持有）：
 *
 * - `observed` / `locked` 都算可用（locked 只是截图无意义，读取与主动消息照常）→ 不告警；
 * - 同一原因（同 state）距上次告警不满 10 分钟 → 不重复告警；
 * - 原因变化或已满 10 分钟 → 告警。
 *
 * 可用状态后的重置由包装处（getRuntimeActivity）负责，本函数无副作用。
 */
export function shouldWarnObservationGate(
  state: RuntimeActivity["screenState"],
  now: number,
  lastState: RuntimeActivity["screenState"] | null,
  lastAt: number | null,
): boolean {
  if (state === "observed" || state === "locked") return false
  if (lastState === state && lastAt !== null && now - lastAt < OBSERVATION_GATE_WARN_INTERVAL_MS) return false
  return true
}

/**
 * 运行活动快照。所有消费者共用本包装：观察态不可用时按同因 10 分钟限频留痕，
 * 文案带影响面，避免 `unavailable` 被静默吞掉（频率档位契约 Part 1.3）。
 */
export async function getRuntimeActivity(): Promise<RuntimeActivity> {
  const activity = await getHostBridge().request("get_runtime_activity", {})
  const now = Date.now()
  if (shouldWarnObservationGate(activity.screenState, now, lastObservationWarnState, lastObservationWarnAt)) {
    lastObservationWarnState = activity.screenState
    lastObservationWarnAt = now
    log.warn(`观察态不可用（${activity.screenState}）：依赖观察的主动机会与静默了解会被跳过`)
  } else if (activity.screenState === "observed" || activity.screenState === "locked") {
    // 观察恢复可用：清掉限频记忆，下一次不可用重新留痕（不被上一次同因窗口压掉）。
    lastObservationWarnState = null
    lastObservationWarnAt = null
  }
  return activity
}
