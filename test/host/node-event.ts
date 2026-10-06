// ==========================================
// Node 适配层 —— UI 事件面（导出名与历史宿主 API 对齐）
// ==========================================
//
// Node 测试宿主没有窗口事件系统。订阅与发布**一律抛错**（`listen` / `emit`），不做
// 「订阅成功但永不触发」的空实现：那种假实现会让依赖事件的场景在 L3 静默挂死或静默
// 通过，比直接失败难查得多。撞上它的场景即是「属于 L4」的判据。
//
// 消费面：node-host-bridge.ts 把 `emit` 接在测试宿主的 UI 事件发布端口上（同样如实
// 抛错）；`listen` 由 node-ipc.test.ts 直接对账抛错口径。真要在 L3 验证事件驱动的
// 行为，需要补一个最小事件总线并连同消费者一起登记。
//
// 导出名与历史宿主 API（`@tauri-apps/api/event`）对齐：`listen` / `emit` / `UnlistenFn`。
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
