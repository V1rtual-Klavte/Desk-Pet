// ==========================================
// 后台命令完成通知 —— 宿主事件订阅与投递（带 IPC 的接线半边）
// ==========================================
//
// 载荷类型、结构校验与中性文案在零依赖叶子 `./background-notice.ts`（L2 直测）；
// 本模块只做一件事：领域引导（`src/services/init.ts`）订阅桥事件 `bash-background-finished`，
// 把完成结果写进发起会话的聊天系统消息（`pushSystemMessage` —— 唯一既有展示通道，
// 不新造 UI；会话不活跃时消息落库，切回该会话即可见）。

import { getHostBridge } from "@/services/host"
import { isNoEventChannelError } from "@/services/native-ui"
import { pushSystemMessage } from "@/services/session"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { formatBackgroundFinishedNotice, parseBackgroundFinishedPayload } from "./background-notice"

const log = createLogger("BackgroundCmd")

let unsubscribe: (() => void) | undefined

/**
 * 领域引导接线（`src/services/init.ts` 调用一次）：订阅宿主的后台命令结束事件。
 * 重复引导不叠加监听器（与 `initWindowObservation` 的既有口径一致）。
 */
export function initBackgroundCommandNotifier(): void {
  if (unsubscribe) return
  try {
    unsubscribe = getHostBridge().subscribe("bash-background-finished", payload => {
      const finished = parseBackgroundFinishedPayload(payload)
      if (!finished) {
        log.warn("丢弃结构无效的 bash-background-finished 载荷")
        return
      }
      if (!finished.sessionId) {
        // 没有会话归属就没有展示位：如实留痕，不猜一个会话塞进去。
        log.warn("后台命令结束事件没有会话归属，完成通知无处展示:", finished.executionId)
        return
      }
      pushSystemMessage(formatBackgroundFinishedNotice(finished), finished.sessionId)
    })
  } catch (error) {
    // 没有事件通道的宿主（无原生 UI 请求面，如 Node 测试宿主）：没有来源，跳过并留痕；
    // 判据与 window-observation 的接线同源（isNoEventChannelError）；其余错误照旧上抛。
    if (!isNoEventChannelError(error)) throw error
    log.warn(`后台命令完成通知接线跳过：宿主没有事件通道（${formatError(error)}）`)
    return
  }
  log.info("后台命令完成通知已订阅")
}

/** 卸载（测试与将来重连用；生产随进程退出）。 */
export function disconnectBackgroundCommandNotifier(): void {
  unsubscribe?.()
  unsubscribe = undefined
}
