// ==========================================
// 安全确认 UI 状态 —— Agent Loop 与确认面的桥接
// PermissionKernel 调用 requestPermissionConfirm() 返回 Promise
// 确认面观察 confirmState（原生 UI：native-ui/permission-confirm.ts 投影成
// deskpet-permission-confirm 事件并回收回执；测试宿主：confirm-channel 的同步 watcher）
// 用户选择 → resolveConfirm()/resolvePermissionConfirm() → Promise 完成 → Loop 继续
// ==========================================

import { reactive } from "vue"
import { createLogger } from "@/services/logger"
import type { EffectClass, PermissionConfirmation, PermissionRequest } from "./permission"

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
  sessionId: string
  runGeneration: number
  parameterSummary: string
  expiresAt: number
  /**
   * 展示用身份（原生 UI 面板的 effect 类别与策略/输入指纹短前缀）。**不做任何判定** ——
   * 权限终裁仍在 PermissionKernel，这里只是把确认请求的展示字段投影给 UI 观察者。
   */
  effectClass: EffectClass
  inputHash: string
  policyHash: string
  toolCallId: string
  resolve: (decision: PermissionConfirmation) => void
}

export const confirmState = reactive({
  pending: null as ConfirmRequest | null,
})

/** Agent Loop 调用：等待用户确认（超时按拒绝结算） */
function settle(request: ConfirmRequest, decision: PermissionConfirmation): void {
  if (confirmState.pending?.id !== request.id) return
  confirmState.pending = null
  request.resolve(decision)
}

/** PermissionKernel 使用的有身份确认入口。 */
export function requestPermissionConfirm(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionConfirmation> {
  if (signal?.aborted || request.expiresAt <= Date.now()) return Promise.resolve("deny")
  return new Promise((resolve) => {
    if (confirmState.pending) settle(confirmState.pending, "deny")
    const id = request.requestId
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const complete = (decision: PermissionConfirmation) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve(decision)
    }
    const abort = () => {
      if (confirmState.pending?.id === id) {
        confirmState.pending = null
        log.warn("确认因取消失效:", request.toolName)
      }
      complete("deny")
    }
    const remaining = Math.max(0, request.expiresAt - Date.now())
    timer = setTimeout(() => {
      if (confirmState.pending?.id === id) confirmState.pending = null
      log.warn(`确认超时（${remaining}ms），按拒绝处理:`, request.toolName)
      complete("deny")
    }, Math.min(CONFIRM_TIMEOUT_MS, remaining))
    signal?.addEventListener("abort", abort, { once: true })

    confirmState.pending = {
      id,
      message: request.message,
      toolName: request.toolName, sessionId: request.sessionId, runGeneration: request.runGeneration,
      parameterSummary: request.parameterSummary,
      expiresAt: request.expiresAt,
      // 展示用身份随待确认单槽一起投影（原生 UI 的面板请求从这里读，见 confirm.ts 头注释）。
      effectClass: request.effectClass, inputHash: request.inputHash,
      policyHash: request.policyHash, toolCallId: request.toolCallId,
      resolve: complete,
    }
  })
}

/** ChatPanel 调用：用户点击确认/取消 */
export function resolveConfirm(approved: boolean): void {
  resolvePermissionConfirm(approved ? "allow_session" : "deny")
}

/** 新 UI 使用：一次允许、会话内精确参数授权或拒绝。 */
export function resolvePermissionConfirm(decision: PermissionConfirmation): void {
  if (confirmState.pending) settle(confirmState.pending, decision)
}

export function cancelPermissionConfirm(sessionId?: string, runGeneration?: number): void {
  const pending = confirmState.pending
  if (pending && (sessionId === undefined || pending.sessionId === sessionId)
    && (runGeneration === undefined || pending.runGeneration === runGeneration)) settle(pending, "deny")
}
