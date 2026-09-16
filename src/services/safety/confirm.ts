// ==========================================
// 安全确认 UI 状态 —— Agent Loop 与 ChatPanel 的桥接
// Agent Loop 调用 requestConfirm() 返回 Promise
// ChatPanel 监听 confirmState 渲染弹窗
// 用户点击 → resolveConfirm() → Promise 完成 → Loop 继续
// ==========================================

import { reactive } from "vue"
import { createLogger } from "@/services/logger"

const log = createLogger("SafetyConfirm")

/**
 * 等待用户确认的上限。
 *
 * 弹窗长在 `#chat` 里，聊天列被 `v-show` 收起时不可见也不可点；没有超时的话，
 * 这个 Promise 永远不结算，整个 agent 回合就永久挂在那里，只能靠重新展开聊天列救。
 * 超时按「拒绝」结算（fail-closed）：等不到人就不能当默认同意。
 */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

export interface ConfirmRequest {
  id: string
  message: string
  toolName: string
  resolve: (approved: boolean) => void
}

export const confirmState = reactive({
  pending: null as ConfirmRequest | null,
})

/** Agent Loop 调用：等待用户确认（超时按拒绝结算） */
export function requestConfirm(toolName: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2, 10)
    const timer = setTimeout(() => {
      // 只在这个 id 仍然是当前待确认项时才结算：期间用户可能已经点过、或换成了别的请求
      if (confirmState.pending?.id !== id) return
      confirmState.pending = null
      log.warn(`确认超时（${CONFIRM_TIMEOUT_MS}ms），按拒绝处理:`, toolName)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)

    confirmState.pending = {
      id,
      message,
      toolName,
      resolve: approved => {
        clearTimeout(timer)
        resolve(approved)
      },
    }
  })
}

/** ChatPanel 调用：用户点击确认/取消 */
export function resolveConfirm(approved: boolean): void {
  if (confirmState.pending) {
    confirmState.pending.resolve(approved)
    confirmState.pending = null
  }
}
