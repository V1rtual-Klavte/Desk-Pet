// ==========================================
// 权限确认的 UI 桥（请求下发 + 回执回收）
// ==========================================
//
// Node 领域里没有 in-process 面板：`safety/confirm.ts` 的 `confirmState` 是**进程内单槽**
// （确认请求的读模型）；原生宿主形态下 UI 在另一进程，
// 因此这里把它投影成冻结事件矩阵里的 `deskpet-permission-confirm`（方向 1，Node → UI），
// 用户选择经 `UiReceiptMap` 的 `deskpet-permission-confirm-resolved`（方向 2，UI → Node）
// 回到 `resolvePermissionConfirm`。两条方向的形状定义点都在 `src/services/host/types.ts`
// 与 `ui-events.ts`，本模块只搬运，不新造结构。
//
// 为什么观察 `confirmState.pending` 而不是在 `requestPermissionConfirm` 里直接发布：
//   · 事件只在**有事件通道的宿主**装配（`initNativeUiBridge` 的成功路径）——
//     无原生 UI 的宿主（Node 测试宿主）不为必然失败的推送挂观察，也不给 L2/L3 日志
//     制造每次确认一条的噪声；测试宿主自己的应答通道（`test/host/confirm-channel.ts`）
//     观察的是同一份 `confirmState`，两条适配面互不冲突；
//   · 与测试宿主确认通道同一条既有模式：领域持有单槽，适配器负责投影与应答。
// 与进程内 `confirmState` 路径**并存不冲突**：这里只多一条投影，不建第二条授权判定 ——
// 权限终裁仍在 PermissionKernel（`safety/permission.ts`），
// `resolvePermissionConfirm` 也只结算既有单槽（身份不匹配即丢弃，结算域只结算一次）。
//
// 失败语义：
//   · 请求下发失败（UI 收不到本次确认）→ 立即按拒绝结算（fail-closed）：等待本身没有
//     超时（2026-10-06 用户裁决），「送不到」是显式逃生口 —— 不能让回合悬挂在一个
//     谁也没看见的请求上；
//   · 回执的 decision 取值非法（协议违规）→ 丢弃并留痕，不结算（不让非法取值
//     有把待确认请求结算成非拒绝决定的机会）；
//   · 回执与当前待确认请求身份不匹配（迟到/重复/未知）→ 丢弃（no-op），
//     与计划回执同一条「未知/重复 key 不复活结算」的可靠性语义。
//
// 装配：`initNativeUiBridge` 在「宿主有事件通道」判定之后调用 `startPermissionConfirmBridge()`
// （幂等；无事件通道的宿主在上方已跳过）。

import { watch } from "vue"

import { formatError } from "@/services/error"
import { publishUiEvent, subscribeUiReceipt } from "@/services/host"
import type { HostEventMap } from "@/services/host"
import { createLogger } from "@/services/logger"
import { confirmState, resolvePermissionConfirm } from "@/services/safety"
import type { ConfirmRequest } from "@/services/safety"

const log = createLogger("NativeUi")

/** `deskpet-permission-confirm` 的线载荷（形状定义点 = `HostEventMap` 条目）。 */
export type PermissionConfirmPayload = HostEventMap["deskpet-permission-confirm"]

/** 待确认单槽 → 线载荷：逐字段投影，不做任何判定或默认值补齐。 */
export function permissionConfirmPayload(pending: ConfirmRequest): PermissionConfirmPayload {
  return {
    requestId: pending.id,
    message: pending.message,
    toolName: pending.toolName,
    sessionId: pending.sessionId,
    runGeneration: pending.runGeneration,
    parameterSummary: pending.parameterSummary,
    effectClass: pending.effectClass,
    inputHash: pending.inputHash,
    policyHash: pending.policyHash,
    toolCallId: pending.toolCallId,
  }
}

let stopWatcher: (() => void) | undefined
let stopReceipts: (() => void) | undefined

/**
 * 装配权限确认桥（幂等；重复调用不叠加监听）。
 *
 * 请求方向用同步 watch：面板请求与 `confirmState.pending = …` 同轮发出，不给
 * 「确认请求已写入、事件还没发」留窗口。`immediate` 兜住「装配前已有待确认请求」
 * 的窗口期（正常引导顺序下不可达，只是防御）。
 */
export function startPermissionConfirmBridge(): void {
  if (!stopWatcher) {
    stopWatcher = watch(
      () => confirmState.pending,
      (pending) => {
        if (!pending) return
        // 下发失败 = 面板根本没送到：按拒绝立即结算（fail-closed）—— 确认的等待本身没有
        // 超时（2026-10-06 用户裁决），「送不到」就必须有显式归宿，不能把回合悬挂在
        // 一个谁也没看见的请求上。身份先核对：等待期间确认可能已被替换/结算，
        // 结算域只结算一次，不误伤新请求。
        const settleDenyOnDeliveryFailure = (error: unknown) => {
          log.warn("权限确认请求下发失败（等不到界面应答），按拒绝结算:", formatError(error))
          if (confirmState.pending?.id === pending.id) resolvePermissionConfirm("deny")
        }
        try {
          void publishUiEvent("deskpet-permission-confirm", permissionConfirmPayload(pending))
            .catch(settleDenyOnDeliveryFailure)
        } catch (error) {
          // 端口未注入等同步抛：与异步失败同一归宿 —— 结算后绝不让投影失败反噬确认流程
          //（watch 是同步 flush，同步抛会沿着 confirmState 赋值把 requestPermissionConfirm
          // 的 Promise 一起炸掉；这里先结算掉再返回，异常不出这个回调）。
          settleDenyOnDeliveryFailure(error)
        }
      },
      { flush: "sync", immediate: true },
    )
  }

  if (!stopReceipts) {
    // 回执回收：身份先于结算校验 —— 不匹配（迟到/重复/未知）一律丢弃。
    stopReceipts = subscribeUiReceipt("deskpet-permission-confirm-resolved", (payload) => {
      const decision = payload?.decision
      if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") {
        log.warn("权限回执的 decision 取值非法（协议违规），已丢弃:", String(decision))
        return
      }
      if (confirmState.pending?.id !== payload.requestId) {
        // 结算语义由 safety/confirm.ts 拥有（settle 只结算一次）：不匹配即丢弃，
        // 迟到/重复的回执不复活结算，也不把旧决定套到新的待确认请求上。
        log.debug("权限回执与当前待确认请求不匹配（迟到/重复/未知），已丢弃")
        return
      }
      resolvePermissionConfirm(decision)
    })
  }
}

/** 关停或测试拆卸：退订并允许再次装配。 */
export function stopPermissionConfirmBridge(): void {
  const stopWatcherNow = stopWatcher
  const stopReceiptsNow = stopReceipts
  stopWatcher = undefined
  stopReceipts = undefined
  stopWatcherNow?.()
  stopReceiptsNow?.()
}

/** 测试隔离。 */
export function __resetPermissionConfirmBridgeForTest(): void {
  stopPermissionConfirmBridge()
}
