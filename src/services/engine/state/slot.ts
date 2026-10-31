// lane 持久 inbox 的只读视图与投递词汇。
/** 排队项的只读视图：UI 展示与撤回都以它为准，不在前端另存一份队列状态。 */
export interface HarnessQueuedItem {
  entryId: string
  kind: "steer" | "followUp" | "nextRun"
  text: string
  /** 投递时写入的宿主 requestId（`deskpetEventId` 的主键部分）；证据链按它关联输入。 */
  requestId?: string
}

/** lane 持久 inbox 的排队计数（按 kind）：压缩拒绝、排队视图共用同一明细。 */
export interface HarnessQueueCounts {
  steer: number
  followUp: number
  nextRun: number
}

/** 手动压缩（/compact）的终态；文案由调用方决定。 */
export interface HarnessCompactOutcome {
  status: "completed" | "declined" | "nothing" | "busy" | "pending" | "closed" | "failed"
  error?: string
  /** status=pending 时的排队明细：压缩续跑可能消费 lane inbox，不能只报「有排队」。 */
  queued?: HarnessQueueCounts
}

/** 单项撤回结果：与 lane.cancelQueued 的 kind 同名，unavailable 表示槽/通道不可用。 */
export type HarnessCancelQueuedKind = "cancelled" | "already_consumed" | "not_found" | "unavailable"

export type HarnessDeliveryPhase = "streaming" | "settling"
/**
 * 投递回执：steered/followup 会进入本次运行；deferred（nextRun）只随下一次运行消费。
 * 值与旧 QueueAckState 的 steered/followup 文案保持一致，UI 不需第二套词汇。
 */
export type HarnessDeliveryReceipt = "steered" | "followup" | "deferred"

// 槽的只读快照与受理凭据。

export type HarnessSlotState = "closed" | "idle" | "running" | "interrupted" | "faulted"

export interface HarnessSlotSnapshot {
  sessionId: string
  generation: number
  state: HarnessSlotState
  hasLane: boolean
  deliveryPhase?: HarnessDeliveryPhase
  requestId?: string
  turnId?: string
  operationId?: string
  /** 本分支已提交的压缩次数：请求视图的换代身份；基数未知时省略字段（不写 0）。 */
  contextEpoch?: number
  /** lane 持久 inbox 的待消费项（真相源在会话文件；这里是最近一次 queue_update 的只读快照）。 */
  queued: HarnessQueuedItem[]
  /**
   * `queued` 镜像是否可信：开槽时用 lane 的一次性读取播种，此后由 queue_update 全量覆盖。
   * false 表示这个镜像还没有初值（或播种失败），消费者按「未就绪」处理，不把空镜像当「没有排队项」。
   */
  queueMirrorReady: boolean
  interrupted?: { operationId: string; kind: "run" | "compaction" | "navigation"; startedAt: number; aborting: boolean }
}

/**
 * 回合受理凭据：`admit()` 的唯一产物、`endAdmission()` 的唯一入参。
 * 不透明句柄（调用方不解释字段），配对由类型与 Set 语义共同承载。
 */
export interface HarnessTurnAdmission {
  readonly admissionId: number
}
