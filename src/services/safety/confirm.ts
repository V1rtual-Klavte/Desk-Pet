// ==========================================
// 安全确认 UI 状态 —— Agent Loop 与 ChatPanel 的桥接
// Agent Loop 调用 requestConfirm() 返回 Promise
// ChatPanel 监听 confirmState 渲染弹窗
// 用户点击 → resolveConfirm() → Promise 完成 → Loop 继续
// ==========================================

import { reactive } from "vue"

export interface ConfirmRequest {
  id: string
  message: string
  toolName: string
  resolve: (approved: boolean) => void
}

export const confirmState = reactive({
  pending: null as ConfirmRequest | null,
})

/** Agent Loop 调用：等待用户确认 */
export function requestConfirm(toolName: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.pending = {
      id: Math.random().toString(36).slice(2, 10),
      message,
      toolName,
      resolve,
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
