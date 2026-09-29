// ==========================================
// Node 适配层 —— 顶替 @tauri-apps/api/event
// ==========================================
//
// Node 侧没有窗口事件系统。订阅**一律抛错**，不做「订阅成功但永不触发」的空实现：
// 那种假实现会让依赖事件的场景在 L3 静默挂死或静默通过，比直接失败难查得多。
// 真要在 L3 验证事件驱动的行为，需要在这里补一个最小事件总线，并连同消费者一起登记；
// 现状是零消费者，所以保持抛错（撞上它的场景即是「属于 L4」的判据）。
//
// 导出名与 @tauri-apps/api/event 对齐：`listen` / `emit` / `UnlistenFn`。
import { UnsupportedInNodeError } from "./unsupported"

/** @tauri-apps/api/event UnlistenFn */
export type UnlistenFn = () => void

/** @tauri-apps/api/event listen(event, handler) */
export async function listen(event: string, _handler: unknown): Promise<UnlistenFn> {
  throw new UnsupportedInNodeError(`event.listen(${event})`)
}

/** @tauri-apps/api/event emit(event, payload?) */
export async function emit(event: string, _payload?: unknown): Promise<void> {
  throw new UnsupportedInNodeError(`event.emit(${event})`)
}
