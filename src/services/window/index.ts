// ==========================================
// 窗口监控模块 —— 统一导出
// ==========================================

export { getLastWindowChange, initWindowListener } from "./listener"
export type { WindowChangeSnapshot } from "./listener"
export { checkWindowTiming, processTrigger } from "./monitor"
export type { TriggerResult } from "./monitor"
