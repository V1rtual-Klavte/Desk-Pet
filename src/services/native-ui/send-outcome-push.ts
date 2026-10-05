// ==========================================
// 发送投递归宿推送 —— Node → 原生宿主的 `deskpet-send-outcome` 事件
// ==========================================
//
// 真相源是投递准入（`src/services/agent/runner.ts` 的 post-commit ingress 观察器）：
// 忙碌投递在 `deliverActiveTurn` 返回回执的那一刻归宿就已确定（steered / followup /
// deferred，与 `HarnessDeliveryReceipt` 逐字同域），本模块只把回执投影成
// `deskpet-send-outcome` 的线载荷（形状 = `HostEventMap` 条目 = Rust
// `ui/chat/events.rs` 的镜像，逐字段同名 camelCase），经既有 UI 事件端口
// （`@/services/host` 的 `publishUiEvent`）推给原生宿主；Rust 侧 `ChatUi::apply_event`
// 按当前会话落进既有 notice 通道（4 秒自动收起），呈现旧壳 `DELIVERY_NOTES` 同文的中性回执。
//
// 为什么不开在 `chat_send` 的回执上：`chat_send` 是**非阻塞**提交（整回合结算，分钟级），
// 改成有界请求会稳定撞出假 TIMEOUT、并让 UI 主线程被堵 —— 归宿却早在投递准入时就已确定。
// 所以按「事实产生当刻单向发一条」处理；空闲整回合发送没有可回执的投递（无回执字段），
// 不发事件（与旧壳 `SendMessageResult.delivery` 只在忙碌投递返回的口径一致）。
//
// 失败语义：**best-effort**（同 reveal-push）。推送失败只留痕 warn，绝不向观察器抛、
// 不阻断投递本身；观察器按提交顺序被同步等待，这里不做任何节流或缓存。
//
// 注册：`initNativeUiBridge` 在「宿主有事件通道」判定之后调用 `startSendOutcomePush()`；
// 无事件通道的宿主（Node 测试宿主）在那之前已跳过 —— 没有原生 UI 就没有回执消费方，
// 不为一个必然失败的推送挂订阅。

import { formatError } from "@/services/error"
import { publishUiEvent, type HostEventMap } from "@/services/host"
import { registerUserIngressObserver, type UserIngressObserverEvent } from "@/services/agent"
import { createLogger } from "@/services/logger"

const log = createLogger("NativeUi")

/** `deskpet-send-outcome` 的线载荷（形状定义点 = `HostEventMap` 条目）。 */
export type SendOutcomePayload = HostEventMap["deskpet-send-outcome"]

/**
 * ingress 观察事件 → 线载荷：只取 `HostEventMap` 登记的三个字段；
 * 没有 `delivery`（空闲回合/直接拒绝）返回 undefined —— 没有归宿可回执，不发事件。
 */
export function sendOutcomePayload(event: UserIngressObserverEvent): SendOutcomePayload | undefined {
  if (!event.delivery) return undefined
  return {
    sessionId: event.sessionId,
    requestId: event.requestId,
    delivery: event.delivery,
  }
}

let unsubscribe: (() => void) | undefined

/** 订阅 ingress 观察器并把投递归宿推给原生宿主（幂等；重复调用不叠加监听器）。 */
export function startSendOutcomePush(): void {
  if (unsubscribe) return
  unsubscribe = registerUserIngressObserver(event => {
    const payload = sendOutcomePayload(event)
    if (!payload) return
    try {
      void publishUiEvent("deskpet-send-outcome", payload).catch(error => {
        log.warn("发送投递归宿推送失败（best-effort，不影响投递）:", formatError(error))
      })
    } catch (error) {
      // 端口未注入等同步抛：与异步失败同一归宿 —— 只留痕，不让观察器影响投递。
      log.warn("发送投递归宿推送失败（best-effort，不影响投递）:", formatError(error))
    }
  })
}

/** 关停或测试拆卸：退订并允许再次 `startSendOutcomePush()`。 */
export function stopSendOutcomePush(): void {
  const stop = unsubscribe
  unsubscribe = undefined
  stop?.()
}

/** 测试拆卸。 */
export function __resetSendOutcomePushForTest(): void {
  stopSendOutcomePush()
}
