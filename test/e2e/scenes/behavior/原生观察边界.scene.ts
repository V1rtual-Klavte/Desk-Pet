import { getHostBridge } from "@/services/host"
import type { SceneDef } from "../../types"
import { silentAccessConfig } from "@/services/config"

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

/**
 * 原生观察命令与运行活动快照（bh-06）。
 *
 * **可验证性边界（README「宿主能力对等」，与 `窗口信息三态` 同一模式）**：E2E 宿主不启动
 * monitor 工作线程（`crates/native-host/src/main.rs` 的 `run_e2e` 不调用
 * `spawn_monitor_thread`），`window-observed` 在宿主里没有事件源 —— 订阅者永远收不到事件。
 * 事件载荷协议（采样时间、generation/sequence、前后台与可见性、disabled 边界）因此没有
 * 可执行入口，本场景不假装覆盖，而是把「宿主不会发布任何观察事件」断言成前置：将来宿主在
 * e2e 分支接入事件源，这条前置会失败，提示把事件协议断言重写回来，而不是让「未收到事件」
 * 一侧悄悄永远成立（同 `窗口信息三态` 对「快照必须为 null」的处理）。
 *
 * 可执行的部分：启停两条命令被宿主接受、`get_runtime_activity` 独立快照的真实字段形状与
 * 隐私边界（不带 appId/app/title）—— 这些不依赖事件源。
 */

/** 边界观察窗口：宿主当前没有事件源，等这段只为在事件源将来出现时抓出「开始发布」的变化。 */
const BOUNDARY_WAIT_MS = 1200
/** 关闸后的边界观察窗口：disabled 边界事件同样应由工作线程发布，这里同样不该出现。 */
const DISABLED_WAIT_MS = 300
const POLL_MS = 50

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

export const 原生观察边界: SceneDef = {
  meta: {
    caseId: "behavior-native-observation", module: "behavior", contractId: "bh-06",
    description: "原生观察命令启停被宿主接受、运行活动快照带锁屏/idle/可见与前台且不携带窗口身份；E2E 宿主无事件源，事件协议按可验证性边界标注",
    depth: "deep", suite: "regression", entry: "runtime", tags: ["behavior", "boundary"],
  },
  setup: async () => {},
  turns: [{
    index: 1,
    description: "原生启停命令与独立运行活动快照符合跨平台协议",
    userText: "验证桌面观察边界。",
    checks: [{
      type: "expectNativeObservationProtocol",
      run: async () => {
        const enabledBefore = silentAccessConfig.frequency !== "off"
        const events: Observation[] = []
        const unlisten = getHostBridge().subscribe("window-observed", (payload) => { events.push(payload) })
        try {
          // ① 关闸命令被宿主接受（命令面存在且不报错；总闸状态本身在宿主里没有查询入口）。
          await getHostBridge().request("set_monitor_enabled", { enabled: false })

          // ② 独立运行活动快照：字段形状与隐私边界按协议核对（真实采样，不依赖事件源）。
          const activity = await getHostBridge().request("get_runtime_activity", {})
          if (typeof activity.isPetVisible !== "boolean" || typeof activity.isPetForeground !== "boolean") throw new Error("运行活动缺少桌宠可见/前台状态")
          if (!["observed", "locked", "unavailable"].includes(activity.screenState)) throw new Error(`运行活动状态非法: ${activity.screenState}`)
          if (!Number.isSafeInteger(activity.observedAt) || !(activity.idleForMs === null || Number.isFinite(activity.idleForMs))) throw new Error("运行活动时间或 idle 值非法")
          if ("title" in activity || "app" in activity || "appId" in activity) throw new Error("get_runtime_activity 不得携带窗口身份信息")

          // ③ 开闸命令同样被宿主接受。
          await getHostBridge().request("set_monitor_enabled", { enabled: true })

          // ④ 可验证性边界：宿主没有 monitor 工作线程，开闸也不会发布任何观察事件。
          // 事件源接入后这里会失败 —— 那正是提示按完整事件协议（采样时间/代际/序号/
          // 前后台/可见性/disabled 边界）重写本场景的信号，而不是把断言删掉。
          const boundaryDeadline = Date.now() + BOUNDARY_WAIT_MS
          while (Date.now() < boundaryDeadline) await sleep(POLL_MS)
          if (events.length !== 0) {
            throw new Error(`E2E 宿主不应有 window-observed 事件源，却收到 ${events.length} 条事件：宿主已接入事件源，本场景需重写为完整事件协议断言`)
          }

          // ⑤ 关闸：命令仍被接受，且 disabled 边界事件同样不该出现（它由工作线程发布）。
          await getHostBridge().request("set_monitor_enabled", { enabled: false })
          await sleep(DISABLED_WAIT_MS)
          if (events.length !== 0) throw new Error(`关闸后仍收到 ${events.length} 条观察事件：宿主已接入事件源，本场景需重写`)
        } finally {
          unlisten()
          await getHostBridge().request("set_monitor_enabled", { enabled: enabledBefore })
        }
      },
    }],
  }],
}

export default 原生观察边界
