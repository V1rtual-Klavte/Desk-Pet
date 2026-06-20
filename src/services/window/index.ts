// ==========================================
// 窗口监控模块 —— 统一导出
// ==========================================

export { initWindowListener } from "./listener";
export { checkWindowTiming, processTrigger, SAME_PAGE_COOLDOWN_SECONDS } from "./monitor";
export type { TriggerResult } from "./monitor";
export { generateActiveMessage } from "./active-context";
