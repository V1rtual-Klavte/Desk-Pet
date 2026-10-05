// ==========================================
// 主动控制 —— 领域侧（Node）：处理器登记 + 进程内状态分发
// ==========================================
//
// 拆分说明（原生宿主迁移过程记录 §9.4 第 7/35 条）：
// - 本文件只做领域侧：scanner 登记控制处理器，领域在状态变化时做**进程内**分发。
// - 跨窗口请求/应答协议（deskpet-proactive-control-request/-response/-state）
//   是纯 UI 窗口间协调（判据 (b)），不进 Node 图；原生 UI 的控制入口尚未接线到本处理器。
// - 控制数据（enabled/muteUntil）的真相源仍是 Rust SQLite（proactive_control 命令），
//   本通道不承载第二份长期状态。

import type { ProactiveControl } from "@/services/agent/memory/protocol"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ProactiveControl")

export type ProactiveControlHandler = (enabled?: boolean) => Promise<ProactiveControl>

let handler: ProactiveControlHandler | null = null

/** scanner 在 start() 时登记（stop() 时清空）。 */
export function setProactiveControlHandler(value: ProactiveControlHandler | null): void {
  handler = value
}

/** 处理一次控制请求；未登记处理器是接线错误（scanner 未启动），显式抛、不静默吞。 */
export async function handleProactiveControlRequest(enabled?: boolean): Promise<ProactiveControl> {
  if (!handler) throw new Error("主动控制处理器未登记：proactive scanner 尚未 start()")
  return handler(enabled)
}

const subscribers = new Set<(control: ProactiveControl) => void>()

/** 进程内订阅控制状态分发（UI 壳的广播桥用它把状态发给其它窗口）。 */
export function subscribeProactiveControl(listener: (control: ProactiveControl) => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

/** 控制状态变化后分发（proactive/index.ts 的 setEnabled 在命令成功后调用）。 */
export async function publishProactiveControl(control: ProactiveControl): Promise<void> {
  for (const listener of [...subscribers]) {
    try {
      listener(control)
    } catch (error) {
      log.warn("主动控制订阅者失败:", formatError(error))
    }
  }
}
