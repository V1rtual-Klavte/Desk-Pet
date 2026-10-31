// 槽的只读快照与受理凭据。
import type { HarnessDeliveryPhase, HarnessQueuedItem } from "./queue"

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
