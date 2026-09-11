// ==========================================
// 通用提示 Dialog —— 服务层与 UI 的桥接
//
// 与 services/safety/confirm.ts 同一模式：
//   服务层 showDialog() 返回 Promise 并挂起请求
//   UI 组件监听 dialogState 渲染
//   用户关闭 → closeDialog() → Promise 完成
//
// 用途：需要让用户**看见结果**的操作反馈（成功含路径、失败含原因）。
// 纯错误上报请走 services/error 的 reportError（会落日志 + 弹覆盖层）。
// ==========================================

import { reactive } from "vue"

export type DialogKind = "success" | "error" | "info"

export interface DialogRequest {
  id: string
  kind: DialogKind
  title: string
  /** 一句话结论 */
  message: string
  /** 补充详情，如完整文件路径；等宽字体展示并默认选中 */
  detail?: string
  /** 提供则显示「复制」按钮，复制这段文本 */
  copyText?: string
  /** 提供则渲染成「取消 / 确定」确认框，而非单纯的通知框 */
  confirm?: { resolve: (accepted: boolean) => void; okLabel: string; danger?: boolean }
  resolve: () => void
}

export const dialogState = reactive({
  pending: null as DialogRequest | null,
})

export interface ShowDialogOptions {
  kind?: DialogKind
  title: string
  message: string
  detail?: string
  copyText?: string
}

/** 弹一个提示，返回的 Promise 在用户关闭后完成 */
export function showDialog(options: ShowDialogOptions): Promise<void> {
  return new Promise((resolve) => {
    // 同一时刻只保留一个：新提示直接顶掉旧的，避免堆叠
    dialogState.pending?.resolve()
    dialogState.pending = {
      id: Math.random().toString(36).slice(2, 10),
      kind: options.kind ?? "info",
      title: options.title,
      message: options.message,
      detail: options.detail,
      copyText: options.copyText,
      resolve,
    }
  })
}

export function showSuccess(message: string, options: { title?: string; detail?: string } = {}): Promise<void> {
  return showDialog({
    kind: "success",
    title: options.title ?? "操作成功",
    message,
    detail: options.detail,
    copyText: options.detail,
  })
}

export function showFailure(message: string, options: { title?: string; detail?: string } = {}): Promise<void> {
  return showDialog({
    kind: "error",
    title: options.title ?? "操作失败",
    message,
    detail: options.detail,
    copyText: options.detail,
  })
}

/**
 * 危险操作前的二次确认。
 * 返回 true = 用户确认；false = 取消或关闭。
 */
export function confirmDialog(
  message: string,
  options: { title?: string; detail?: string; okLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    dialogState.pending?.resolve()
    dialogState.pending = {
      id: Math.random().toString(36).slice(2, 10),
      kind: options.danger === false ? "info" : "error",
      title: options.title ?? "请确认",
      message,
      detail: options.detail,
      confirm: {
        okLabel: options.okLabel ?? "确定",
        danger: options.danger !== false,
        resolve,
      },
      // 走 closeDialog 时按「取消」处理
      resolve: () => resolve(false),
    }
  })
}

/** UI 组件调用：用户关闭（确认框里等价于取消） */
export function closeDialog(): void {
  const pending = dialogState.pending
  dialogState.pending = null
  pending?.resolve()
}

/** UI 组件调用：用户点了确认 / 取消 */
export function resolveConfirm(accepted: boolean): void {
  const pending = dialogState.pending
  dialogState.pending = null
  pending?.confirm?.resolve(accepted)
  pending?.resolve()
}
