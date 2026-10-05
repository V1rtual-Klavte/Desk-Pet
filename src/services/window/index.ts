// ==========================================
// 窗口监控模块 —— 统一导出
// ==========================================

// 这里只留领域存储与 Node 侧接线：观察来源是桥事件 `window-observed`（HostEventRouter 双投），
// 订阅与观察总闸由 `initWindowObservation()` 在领域引导里接一次。
export {
  acceptWindowObservation,
  clearLatestWindowObservation,
  clearWindowObservationSubscribers,
  getLatestWindowObservation,
  subscribeWindowObservations,
} from "./listener"
export { getRuntimeActivity, initWindowObservation, setMonitorEnabled, disconnectWindowObservation, shouldWarnObservationGate } from "./monitor"
export type { AppCategory, ObservationState, RuntimeActivity, WindowObservation } from "./types"
