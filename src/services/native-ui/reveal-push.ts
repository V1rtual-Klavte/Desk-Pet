// ==========================================
// 分泡揭示推送（断链 D）—— Node → 原生宿主的 RevealProgress 事件
// ==========================================
//
// 真相源是 humanizer 调度器：本模块只把每次状态变化投影成 `deskpet-reveal-progress`
// 的线载荷（形状 = `HostEventMap` 条目 = Rust `ui/chat/model.rs::RevealProgress`，
// 逐字段同名 camelCase），经既有 UI 事件端口（`@/services/host` 的 `publishUiEvent`）
// 推给原生宿主；Rust 侧 `ChatUi::apply_reveal` 按 `revealed` 裁剪 `visible_parts`。
// 节奏不在这里重算，也不缓存第二份状态（`typingStartedAt` 是调度器内部的计时原点，
// 不进行载荷 —— Rust 没有该字段，消费端不重算节奏）。
//
// 频率与合并的裁定：**不合并、不节流**。调度器自身的节奏下限（`HUMANIZER_TIMING`：
// 泡间 ≥ minPartDelayMs、typing 至少 typingMinimumMs）决定了每次发布的间隔在数百毫秒
// 量级，且每次发布的语义都不同（逐泡推进 / typing 终态）—— 合并只会让「正在出现的泡」
// 被跳过。这与 W8a 流式增量的「有界合并」不矛盾：那条链合并的是同一条增量的文本，
// 可以任意拼接；这里合并会改变可见的逐泡节奏本身。渲染侧的合并由 Rust 刷新调度器
// 承担（`ui.rs` 的在途任务即合并），通道里的事件保持逐条按序。
//
// 失败语义：**best-effort**。UI 落后于真相源没关系，反过来不行 —— 推送失败/端口未注入
// 一律只留痕（warn），绝不向调度器抛出、不阻断揭示本身（调度器的 publish 另有
// try/catch 兜底，但错误必须在本模块显式收口，不允许变成无痕的吞掉）。
//
// 注册：`initNativeUiBridge` 在「宿主有事件通道」判定之后调用 `startRevealPush()`；
// 无事件通道的宿主（Node 测试宿主）在那之前已跳过 —— 没有原生 UI 就没有揭示消费方，
// 不为一个必然失败的推送挂订阅（那里 publish 会命中 `event.emit` 的 Unsupported）。

import { formatError } from "@/services/error"
import { publishUiEvent, type HostEventMap } from "@/services/host"
import { subscribe, type HumanizerRevealState } from "@/services/humanizer"
import { createLogger } from "@/services/logger"

const log = createLogger("NativeUi")

/** `deskpet-reveal-progress` 的线载荷（形状定义点 = `HostEventMap` 条目）。 */
export type RevealProgressPayload = HostEventMap["deskpet-reveal-progress"]

/**
 * 调度器状态 → 线载荷：逐字段取 `HumanizerRevealState` 中线上存在的六个字段。
 * 不取 `typingStartedAt`（调度器内部计时原点，Rust `RevealProgress` 没有该字段）。
 */
export function revealProgressPayload(state: HumanizerRevealState): RevealProgressPayload {
  return {
    sessionId: state.sessionId,
    messageId: state.messageId,
    runGeneration: state.runGeneration,
    revealed: state.revealed,
    partCount: state.partCount,
    typing: state.typing,
  }
}

let unsubscribe: (() => void) | undefined

/**
 * 订阅调度器并把每次揭示状态变化推给原生宿主（幂等；重复调用不叠加监听器）。
 *
 * 不做「只推当前活跃会话」的过滤：会话归属由消费端（Rust `apply_reveal` 按自身
 * 活跃会话）裁定，Node 侧不建第二份活跃判断；切会话时调度器的 `cancelSession`
 * 会把完成态照常推出去（既定语义：「切走即全显」）。
 */
export function startRevealPush(): void {
  if (unsubscribe) return
  unsubscribe = subscribe(state => {
    try {
      void publishUiEvent("deskpet-reveal-progress", revealProgressPayload(state)).catch(error => {
        log.warn("揭示进度推送失败（best-effort，不影响揭示节奏）:", formatError(error))
      })
    } catch (error) {
      // 端口未注入等同步抛：与异步失败同一归宿 —— 只留痕，不让订阅回调影响揭示。
      log.warn("揭示进度推送失败（best-effort，不影响揭示节奏）:", formatError(error))
    }
  })
}

/** 关停或测试拆卸：退订并允许再次 `startRevealPush()`。 */
export function stopRevealPush(): void {
  const stop = unsubscribe
  unsubscribe = undefined
  stop?.()
}

/** 测试拆卸。 */
export function __resetRevealPushForTest(): void {
  stopRevealPush()
}
