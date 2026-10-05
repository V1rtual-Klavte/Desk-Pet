// ==========================================
// UI 事件端口 —— Node 领域 ↔ UI 的双向事件面（执行契约 §4.1/§4.2）
// ==========================================
//
// 方向划分（与 host/types.ts 末尾的 (a)/(b) 分类配套，原生宿主迁移过程记录 §9.4 第 1/7/35 条）：
//
// 1. **发布（Node → UI）**：Node 领域把读模型事件推给 UI（流式正文、阶段提示、工具状态、
//    run 状态、plan 进度……）。事件名与载荷形状**复用冻结的 `HostEventMap`**，本文件只收窄
//    生产者子集（`NodeUiEventName`），不新造第二份结构。
//    Node 实现走 `HostBridgeRuntime.publishEvent`（W2 运行时扩展面，原生宿主迁移过程记录 §9.4 第 23 条）。
//
// 2. **回执（UI → Node）**：UI 对 Node 提问的应答（计划确认/步骤裁决/权限确认）。这是**反向通道**，
//    不进 `HostEventMap`（那是 Node/宿主 → UI 的读模型矩阵）。回执在 Node 领域按 key 结算，
//    未知或重复的 key 一律 no-op —— 结算入口本身只结算一次（plan-confirmation 的 settle*）。
//    可靠性语义：UI 侧的提问有超时归宿（PLAN_CONFIRM_TIMEOUT_MS），回执迟到不复活结算；
//    传输不承诺重放（宿主与 Node 都不得为「可能没送达」的回执补发第二次裁决）。
//    回执源是 **Node 侧专属**（connectHostBridge 注册）。TODO(W5)：原生宿主需把原生 UI
//    发来的回执按同名事件投给 Node；线协议按事件名分发，领域侧订阅点已经就位。
//
// 3. **纯 UI 的窗口间协调**（设置窗↔主窗尺寸/保存、编辑器↔主窗 profile 更新、revision 同步、
//    主动控制、观察治理）**不在本文件、不在 Node 图**（原生宿主迁移过程记录 §9.4 第 7 条裁定）；单 Node 架构下
//    这类协调若仍需存在，由原生 UI 在其内部承接，不进 Node 事件矩阵。

import type { PlanConfirmResult } from "@/services/engine/plan-confirmation"
import { HostPortUnavailableError } from "./ports"
import type { HostEventMap } from "./types"

// ==========================================
// 发布：Node → UI
// ==========================================

/** `HostEventMap` 中生产者是 Node 领域的事件子集（宿主系统事件不在此列）。 */
export type NodeUiEventName =
  | "deskpet-assistant-stream"
  | "deskpet-assistant-stream-end"
  | "deskpet-stage-hint"
  | "tool-executing"
  | "tool-completed"
  | "deskpet-run-state"
  | "deskpet-send-outcome"
  | "deskpet-reveal-progress"
  | "deskpet-plan-start"
  | "deskpet-plan-progress"
  | "deskpet-plan-step-gate"
  | "deskpet-plan-end"
  | "deskpet-permission-confirm"

export interface UiEventPublisher {
  /** 发布一条 Node→UI 事件；投递失败以 reject 表达（调用方按各自归宿处理，不静默吞）。 */
  publish(event: NodeUiEventName, payload: unknown): Promise<void>
}

let publisher: UiEventPublisher | null = null

export function setUiEventPublisher(value: UiEventPublisher | null): void {
  publisher = value
}

export function getUiEventPublisher(): UiEventPublisher {
  if (!publisher) {
    throw new HostPortUnavailableError(
      "UiEventPublisher 尚未注入：bootstrap 必须先装配 UI 事件发布。" +
        "Node 侧在 connectHostBridge() 里注册（桥的 publishEvent）。",
    )
  }
  return publisher
}

/** 发布一条 UI 事件（载荷类型取自冻结的 HostEventMap）。 */
export function publishUiEvent<K extends NodeUiEventName>(
  event: K,
  payload: HostEventMap[K],
): Promise<void> {
  return getUiEventPublisher().publish(event, payload)
}

// ==========================================
// 回执：UI → Node
// ==========================================

/**
 * UI → Node 的应答矩阵。每条都是「UI 对 Node 某个提问/请求的回答」；
 * 新增一条时先在这里登记形状，再在 Node 消费点订阅。
 */
export type UiReceiptMap = {
  /** UI 结算一条待确认计划（面板确认/取消；与 PlanConfirmResult 同一形状定义点）。 */
  "deskpet-plan-confirm-resolved": { planId: string; result: PlanConfirmResult }
  /** UI 对步骤门（逐步前置/失败询问）给出裁决。 */
  "deskpet-plan-step-decision": { planId: string; decision: "continue" | "abort" }
  /**
   * UI 对一条权限确认请求（`HostEventMap["deskpet-permission-confirm"]`）的应答。
   * `requestId` 必须与当前待确认请求同一身份（`confirmState.pending.id`）：不匹配
   * （迟到/重复/未知）一律丢弃，结算语义由 `safety/confirm.ts` 拥有（只结算一次）。
   * 取值与 `PermissionConfirmation` 同域：`allow_once` / `allow_session` / `deny`。
   */
  "deskpet-permission-confirm-resolved": {
    requestId: string
    decision: "allow_once" | "allow_session" | "deny"
  }
}

export interface UiReceiptSource {
  /** 订阅 UI 回执；返回退订函数。注册失败应报错而非静默（与 HostBridge.subscribe 同款）。 */
  subscribe<K extends keyof UiReceiptMap>(
    event: K,
    listener: (payload: UiReceiptMap[K]) => void,
  ): () => void
}

let receiptSource: UiReceiptSource | null = null

export function setUiReceiptSource(source: UiReceiptSource | null): void {
  receiptSource = source
}

export function getUiReceiptSource(): UiReceiptSource {
  if (!receiptSource) {
    throw new HostPortUnavailableError(
      "UiReceiptSource 尚未注入：本环境没有 UI 回执通道。" +
        "Node 侧在 connectHostBridge() 里注册（桥的 subscribe）。",
    )
  }
  return receiptSource
}

/** 订阅一条 UI 回执（只在 Node 领域消费）。 */
export function subscribeUiReceipt<K extends keyof UiReceiptMap>(
  event: K,
  listener: (payload: UiReceiptMap[K]) => void,
): () => void {
  return getUiReceiptSource().subscribe(event, listener)
}
