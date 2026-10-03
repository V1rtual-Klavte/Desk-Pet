// ==========================================
// 窗口监控模块 —— 统一导出
// ==========================================

export { acceptWindowObservation, clearLatestWindowObservation, getLatestWindowObservation, initWindowListener, subscribeWindowObservations } from "./listener"
export { getRuntimeActivity, setMonitorEnabled } from "./monitor"
export type { AppCategory, ObservationState, RuntimeActivity, WindowObservation } from "./types"
