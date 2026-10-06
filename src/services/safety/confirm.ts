// ==========================================
// 安全确认 UI 状态 —— Agent Loop 与确认面的桥接
// PermissionKernel 调用 requestPermissionConfirm() 返回 Promise
// 确认面观察 confirmState（原生 UI：native-ui/permission-confirm.ts 投影成
// deskpet-permission-confirm 事件并回收回执；测试宿主：confirm-channel 的同步 watcher）
// 用户选择 → resolveConfirm()/resolvePermissionConfirm() → Promise 完成 → Loop 继续
// ==========================================

import { reactive } from "vue"
import { createLogger } from "@/services/logger"
import { beginUserWait } from "@/services/engine/user-wait"
import type { EffectClass, PermissionConfirmation, PermissionRequest } from "./permission"

const log = createLogger("SafetyConfirm")

export interface ConfirmRequest {
  id: string
  message: string
  toolName: string
  sessionId: string
  runGeneration: number
  parameterSummary: string
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

/** Agent Loop 调用：等待用户确认（任何非确认归宿都按拒绝 fail-closed 结算）。 */
function settle(request: ConfirmRequest, decision: PermissionConfirmation): void {
  if (confirmState.pending?.id !== request.id) return
  confirmState.pending = null
  request.resolve(decision)
}

/**
 * PermissionKernel 使用的有身份确认入口。**等待本身没有超时**（2026-10-06 用户裁决：
 * 选择类弹窗不留超时，用户想多久想多久）—— 等待期间该会话的回合墙钟与工具超时停表
 *（`user-wait.ts`）。原先的 5 分钟超时在 2026-10-06 一并删除；它兼的职责（「面板没送到
 * 就没完没了」）改由**显式逃生口**承接，每一条都在各自的层上判定：
 *   · 确认事件发射失败 → 原生 UI 桥按拒绝立即结算（`native-ui/permission-confirm.ts`）；
 *   · 新请求顶掉旧请求（单槽语义）→ 旧请求按拒绝结算（本函数下一行）；
 *   · `signal` abort（用户停止回合 / 会话切换 / 回合失效）→ 按拒绝结算（下方 `abort`）；
 *   · 会话切换 / 关闭 / 恢复 → `invalidatePermissionScope` → `cancelPermissionConfirm` 按拒绝结算。
 * 它不管 UI 线程或进程的存活：面板由原生 UI 独立渲染与回收，回合等多久都不影响界面可用性；
 * 聊天列收起时面板随手投影保留，重新展开即可点按（不需要用倒计时替用户做决定）。
 */
export function requestPermissionConfirm(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionConfirmation> {
  if (signal?.aborted) return Promise.resolve("deny")
  return new Promise((resolve) => {
    // 单槽语义：新确认顶掉旧确认 —— 旧请求按拒绝结算（显式归宿，不静默丢弃）。
    if (confirmState.pending) settle(confirmState.pending, "deny")
    const id = request.requestId
    let settled = false
    // 等用户拍板：登记等待，挂起该会话的回合墙钟与工具超时（任何结算路径都会 release）。
    const releaseWait = beginUserWait(request.sessionId)
    const complete = (decision: PermissionConfirmation) => {
      if (settled) return
      settled = true
      releaseWait()
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
    signal?.addEventListener("abort", abort, { once: true })

    confirmState.pending = {
      id,
      message: request.message,
      toolName: request.toolName, sessionId: request.sessionId, runGeneration: request.runGeneration,
      parameterSummary: request.parameterSummary,
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
