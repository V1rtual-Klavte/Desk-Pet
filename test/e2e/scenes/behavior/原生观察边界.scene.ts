import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { SceneDef } from "../../types"
import { desktopConfig, silentAccessConfig } from "@/services/config"

interface Observation {
  appId: string | null
  app: string | null
  title: string | null
  observedAt: number
  sampleMonoMs: number
  monitorGeneration: number
  sequence: number
  observationState: "observed" | "unavailable" | "locked" | "suspended" | "disabled"
  idleForMs: number | null
  isPetVisible: boolean
  isPetForeground: boolean
}

export const 原生观察边界: SceneDef = {
  meta: {
    caseId: "behavior-native-observation", module: "behavior", contractId: "bh-06",
    description: "原生观察命令启停稳定，系统活动与观察事件带完整采样时间、代际、序号、前台/可见性和锁屏状态",
    depth: "deep", suite: "regression", entry: "runtime", tags: ["behavior", "boundary"],
  },
  setup: async () => {},
  turns: [{
    index: 1,
    description: "原生启停事件与独立运行活动快照符合跨平台协议",
    userText: "验证桌面观察边界。",
    checks: [{
      type: "expectNativeObservationProtocol",
      run: async () => {
        const enabledBefore = silentAccessConfig.enabled
        const intervalBefore = desktopConfig.pollingIntervalMs
        const events: Observation[] = []
        let pendingPredicate: ((event: Observation) => boolean) | null = null
        let pendingResolve: ((event: Observation) => void) | null = null
        let pendingTimer: ReturnType<typeof setTimeout> | null = null
        const unlisten = await listen<Observation>("window-observed", ({ payload }) => {
          events.push(payload)
          if (pendingPredicate?.(payload) && pendingResolve) {
            if (pendingTimer) clearTimeout(pendingTimer)
            pendingTimer = null
            pendingPredicate = null
            const resolve = pendingResolve
            pendingResolve = null
            resolve(payload)
          }
        })
        const waitFor = (predicate: (event: Observation) => boolean) => {
          const existing = events.find(predicate)
          if (existing) return Promise.resolve(existing)
          return new Promise<Observation>((resolve, reject) => {
            pendingPredicate = predicate; pendingResolve = resolve
            pendingTimer = setTimeout(() => {
              pendingTimer = null; pendingPredicate = null; pendingResolve = null
              reject(new Error("等待 window-observed 事件超过 8 秒"))
            }, 8_000)
          })
        }
        try {
          await invoke("set_monitor_enabled", { enabled: false, pollingIntervalMs: 1_000 })
          const activity = await invoke<{
            isPetVisible: boolean; isPetForeground: boolean; observationState: "observed" | "locked" | "unavailable";
            idleForMs: number | null; observedAt: number
          }>("get_runtime_activity")
          if (typeof activity.isPetVisible !== "boolean" || typeof activity.isPetForeground !== "boolean") throw new Error("运行活动缺少桌宠可见/前台状态")
          if (!["observed", "locked", "unavailable"].includes(activity.observationState)) throw new Error(`运行活动状态非法: ${activity.observationState}`)
          if (!Number.isSafeInteger(activity.observedAt) || !(activity.idleForMs === null || Number.isFinite(activity.idleForMs))) throw new Error("运行活动时间或 idle 值非法")
          if ("title" in activity || "app" in activity || "appId" in activity) throw new Error("get_runtime_activity 不得携带窗口身份信息")

          const baselineGeneration = events.reduce((latest, event) => Math.max(latest, event.monitorGeneration), -1)
          const received = waitFor((event) => event.observationState !== "disabled" && event.monitorGeneration > baselineGeneration)
          await invoke("set_monitor_enabled", { enabled: true, pollingIntervalMs: 1_000 })
          const nativeActive = await received
          const disabledPromise = waitFor((event) => event.observationState === "disabled" && event.monitorGeneration > nativeActive.monitorGeneration)
          await invoke("set_monitor_enabled", { enabled: false, pollingIntervalMs: 1_000 })
          const disabled = await disabledPromise
          if (disabled.monitorGeneration <= nativeActive.monitorGeneration) {
            throw new Error("monitor 关闭没有发出更新代际的 disabled 边界事件")
          }
          const value = nativeActive
          if (!Number.isSafeInteger(value.observedAt) || !Number.isFinite(value.sampleMonoMs)) throw new Error("观察事件缺采样时间")
          if (!Number.isSafeInteger(value.monitorGeneration) || value.monitorGeneration < 0 || !Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error("观察事件缺 generation/sequence")
          if (!["observed", "unavailable", "locked", "suspended"].includes(value.observationState)) throw new Error(`观察状态非法: ${value.observationState}`)
          if (typeof value.isPetVisible !== "boolean" || typeof value.isPetForeground !== "boolean") throw new Error("观察事件缺桌宠可见/前台状态")
          if (!(value.idleForMs === null || Number.isFinite(value.idleForMs))) throw new Error("观察事件 idle 值非法")
          if (!(value.appId === null || typeof value.appId === "string") || !(value.app === null || typeof value.app === "string") || !(value.title === null || typeof value.title === "string")) throw new Error("观察事件窗口字段形状错误")
        } finally {
          if (pendingTimer) clearTimeout(pendingTimer)
          unlisten()
          await invoke("set_monitor_enabled", { enabled: enabledBefore, pollingIntervalMs: intervalBefore })
        }
      },
    }],
  }],
}

export default 原生观察边界
