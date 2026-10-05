// ==========================================
// 原生 UI 桥接域（W9b；A2 增补会话面）—— Node ↔ 原生宿主的数据流
// ==========================================
//
// 覆盖三件事（细节见各模块文件头）：
//   1. **Node → 宿主的状态推送**（`pushes.ts` / `session-projection.ts` /
//      `titlebar-status.ts` / `reveal-push.ts` / `send-outcome-push.ts` /
//      `permission-confirm.ts`）：全局快捷键 / 字体 / 舞台 / 聊天列宽度 /
//      聊天图片自动预览 / 会话侧投影帧（标签+历史）/ 顶栏状态位文本 /
//      分泡揭示进度（断链 D）/ 发送投递归宿（投递准入回执）/ 权限确认请求 —— 值只经
//      现有类型化 getter 与读模型，不复制默认值、不建第二份 Store；
//   2. **宿主 → Node 的请求面**（`host-requests.ts` + `chat-intents.ts` +
//      `decision-intents.ts`）与**回执回收**（`permission-confirm.ts` 的
//      `deskpet-permission-confirm-resolved` 订阅）：设置读写、分隔条宽度写回、
//      人格卡列表、图层编辑器 I/O、会话标签与历史面板的五条 `chat_*` 意图、
//      决策类面板动作（计划恢复/丢弃、队列撤回、中断处置）—— 读写的真相源是
//      CONFIG / Profile / 会话仓库，Node 是唯一写者，原生 UI 只持快照与草稿
//      （执行契约 §3）。
//
// 引导：`initNativeUiBridge()` 由领域引导（`@/services/init` 的 `runDomainBootstrap`）
// 收口调用一次 —— 顺序与「启动握手后各推一次」一致：领域初始化完成（Profile/Card/
// CONFIG/会话都可用）后注册请求处理器并推送首帧状态。
//
// 没有原生端口的宿主：首推会失败并由 `pushNativeUiState` 汇总成一条 warn
// （详见 pushes.ts 文件头）。
//
// 没有事件通道的宿主（无原生 UI 请求面，如 Node 测试宿主）：`bridge.subscribe` 如实
// 抛错；本模块把「宿主没有事件通道」这一种错误识别为可选能力缺失，跳过注册与首推
// 并留痕（判据与理由见 `initNativeUiBridge`）。

export {
  buildStageLayers,
  pushChatImagePreview,
  pushChatPanel,
  pushFontSnapshot,
  pushGlobalShortcut,
  pushNativeUiState,
  pushStageProfile,
  sendStageProfile,
  type PushOutcome,
} from "./pushes"
export {
  notifyActiveProfileChanged,
  setActiveProfileListener,
} from "./active-profile-signal"
export {
  notifySessionChanged,
  setSessionChangedListener,
} from "./session-signal"
export {
  buildSessionProjection,
  markSessionHistoryResolved,
  pushSessionProjection,
  startTranscriptPush,
  stopTranscriptPush,
  __resetSessionProjectionForTest,
  __resetTranscriptPushForTest,
  type ProjectedHistorySession,
  type ProjectedMessage,
  type ProjectedSessionTab,
  type SessionProjectionPayload,
} from "./session-projection"
export { pushTitlebarStatus, __resetTitlebarStatusPushForTest } from "./titlebar-status"
export {
  revealProgressPayload,
  startRevealPush,
  stopRevealPush,
  __resetRevealPushForTest,
  type RevealProgressPayload,
} from "./reveal-push"
export {
  sendOutcomePayload,
  startSendOutcomePush,
  stopSendOutcomePush,
  __resetSendOutcomePushForTest,
  type SendOutcomePayload,
} from "./send-outcome-push"
export {
  permissionConfirmPayload,
  startPermissionConfirmBridge,
  stopPermissionConfirmBridge,
  __resetPermissionConfirmBridgeForTest,
  type PermissionConfirmPayload,
} from "./permission-confirm"
export {
  chatCloseSession,
  chatDeleteSession,
  chatNewSession,
  chatRequestSessionHistory,
  chatRestoreSession,
  runChatAfterReplyPush,
} from "./chat-intents"
export {
  chatAbortRunningPlan,
  chatContinueInterruptedRun,
  chatDiscardInterruptedRun,
  chatDiscardPausedInputs,
  chatDiscardPlan,
  chatResolveUnknownSideEffect,
  chatResumePausedInputs,
  chatResumePlan,
  chatWithdrawQueued,
} from "./decision-intents"
export {
  HOST_REQUEST_EVENT,
  HOST_REQUEST_RESULT_METHOD,
  collectSettingsSnapshot,
  dispatchHostRequest,
  initHostRequestHandlers,
  stopHostRequestHandlers,
  normalizeSettingValue,
  __resetHostRequestHandlersForTest,
} from "./host-requests"

import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { setTitlebarRenderListener, titlebarLogo } from "@/services/titlebar"
import { setActiveProfileListener } from "./active-profile-signal"
import { setSessionChangedListener } from "./session-signal"
import { pushSessionProjection, startTranscriptPush, stopTranscriptPush } from "./session-projection"
import { pushTitlebarStatus } from "./titlebar-status"
import { startRevealPush, stopRevealPush } from "./reveal-push"
import { startSendOutcomePush, stopSendOutcomePush } from "./send-outcome-push"
import { startPermissionConfirmBridge, stopPermissionConfirmBridge } from "./permission-confirm"
import { initHostRequestHandlers, stopHostRequestHandlers } from "./host-requests"
import { pushNativeUiState, pushStageProfile } from "./pushes"

const log = createLogger("NativeUi")

/**
 * 「宿主没有事件通道」的判据 —— 只认这一种错误身份，不做宽泛 catch：
 * Node 测试宿主（`test/host/node-host-bridge.ts`）没有事件总线，对 `subscribe`
 * 如实抛 `UnsupportedInNodeError`（`command = event.listen(<事件名>)`）。它是
 * 「该宿主没有原生 UI 请求面」的**特定信号**，不是宿主故障：桥未注入/已断开
 * （`HostBridgeUnavailableError`）与其它任何错误都不匹配，照旧向上抛。
 *
 * 观察域（`@/services/window` 的 `initWindowObservation`）对桥事件
 * `window-observed` 的订阅共用这一判据，保持「无事件通道宿主」的识别只有一份定义。
 */
export function isNoEventChannelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: unknown; command?: unknown }
  return (
    candidate.name === "UnsupportedInNodeError" &&
    typeof candidate.command === "string" &&
    candidate.command.startsWith("event.listen(")
  )
}

/**
 * 接好原生 UI 桥：注册宿主请求处理 + 启动首推。
 *
 * - 注册失败向上抛（桥未注入、集成错误）：那是引导接线错误，不允许降级；
 *   唯一例外是**宿主没有事件通道**（无 UI 的宿主本来就该跳过）—— 跳过注册与
 *   首推、留痕后继续引导，判据与理由见 `isNoEventChannelError` 与本函数内注释；
 * - 首推失败只留痕不抛（宿主可能没有原生端口；见 pushes.ts 文件头）。
 */
export async function initNativeUiBridge(): Promise<void> {
  try {
    initHostRequestHandlers()
  } catch (error) {
    if (!isNoEventChannelError(error)) throw error
    // 跳过是准确的，不是放行：没有事件通道 = 没有原生 UI —— 注册没有消费方、
    // 首推没有去处；除本判据外的错误一律向上抛，不在这里掩盖。
    // 留痕点：本 warn（NativeUi 前缀）即统一留痕点，根因随 formatError 原文带出。
    log.warn(`原生 UI 桥跳过：宿主没有事件通道（${formatError(error)}）`)
    return
  }
  // Profile 激活/层列表变化 → 重推舞台（注册早于激活时由这里补首推；见下）。
  setActiveProfileListener(() => {
    // 信号来自 loader 的激活路径（同步、尽力而为）：失败如实留痕，不向激活流程抛。
    void pushStageProfile().catch((error) => {
      log.warn(`Profile 激活后的舞台重推失败：${formatError(error)}`)
    })
  })
  // A2：会话读模型变化（新建/关闭/删除/恢复/切换/改名/中断标记）→ 重推会话侧投影帧。
  setSessionChangedListener(() => {
    void pushSessionProjection().catch((error) => {
      log.warn(`会话投影重推失败：${formatError(error)}`)
    })
  })
  // A2：顶栏渲染处（仲裁结果落定）→ 推最终文本；注册晚于渲染时由下面的补推兜住。
  setTitlebarRenderListener((text) => {
    void pushTitlebarStatus(text).catch((error) => {
      log.warn(`顶栏状态位推送失败：${formatError(error)}`)
    })
  })
  // 断链 D：humanizer 揭示状态变化 → `deskpet-reveal-progress`（Rust `ChatUi::apply_reveal`）。
  // 注册点在同一条「事件通道存在」判定之后：无通道宿主上面已跳过，不为必然失败的推送挂订阅。
  startRevealPush()
  // 发送投递归宿：ingress 提交当刻的回执 → `deskpet-send-outcome`（Rust 既有 notice 通道）。
  // 注册点与理由同 startRevealPush（没有原生 UI 就没有回执消费方）。
  startSendOutcomePush()
  // 正文侧：可见正文提交（chatHistory 变化）→ 重推整帧（标签 + 正文同帧；见
  // session-projection 文件头与触发时机）。注册点与理由同上。
  startTranscriptPush()
  // 权限确认桥：confirmState.pending → `deskpet-permission-confirm`（下发）+
  // `deskpet-permission-confirm-resolved`（回执回收）；注册点与理由同上（只有真 UI 才需要）。
  startPermissionConfirmBridge()
  await pushNativeUiState()
  // 启动首帧：会话标签/历史（失败只留痕，不阻断引导 —— 与 pushNativeUiState 同口径）。
  await pushSessionProjection().catch((error) => {
    log.warn(`会话投影首推失败：${formatError(error)}`)
  })
  // 顶栏补推：注册前可能已有 owner 写入过文本（未收到推送时宿主保持缺省，与 truth point 初值同字面量）。
  await pushTitlebarStatus(titlebarLogo.text).catch((error) => {
    log.warn(`顶栏状态位补推失败：${formatError(error)}`)
  })
}

/** 进程关停时解除所有 Node→Native UI 订阅与单播信号。 */
export function stopNativeUiBridge(): void {
  const stops = [
    stopHostRequestHandlers,
    stopTranscriptPush,
    stopRevealPush,
    stopSendOutcomePush,
    stopPermissionConfirmBridge,
    () => setActiveProfileListener(null),
    () => setSessionChangedListener(null),
    () => setTitlebarRenderListener(null),
  ]
  let failure: unknown
  for (const stop of stops) {
    try {
      stop()
    } catch (error) {
      if (failure === undefined) failure = error
    }
  }
  if (failure !== undefined) {
    throw Object.assign(new Error("Native UI 订阅清理失败"), { cause: failure })
  }
}
