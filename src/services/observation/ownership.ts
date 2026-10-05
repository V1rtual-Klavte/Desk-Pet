// ==========================================
// 观察治理 —— Node 领域侧：本地应用 + 非所有者窗口的路由端口
// ==========================================
//
// 拆分说明（原生宿主迁移过程记录 §9.4 第 7/35 条）：
// - 观察状态（静默了解/话题来源）的唯一所有者是 Node 领域。本文件提供**本地应用**：
//   清空静默了解、按来源失效话题；调用方（memory/behavior/session 域）在单所有者
//   模型下直接落到本进程。
// - 单 Node 架构下所有调用方都在本进程；路由端口保留给原生 UI 万一需要的间接入口，
//   不注入即本地应用。

import { applyTopicSourceInvalidation } from "./topics"
import { clearSilentUnderstandingOwned } from "./scheduler"

export type ObservationGovernanceOperation =
  | { action: "clear" }
  | { action: "invalidate_topics"; sessionId: string; entryIds: string[] }

/** 跨窗口路由注入点（原生 UI 是否需要待裁定；未注入时一律本地应用）。 */
export interface ObservationGovernanceRouter {
  route(operation: ObservationGovernanceOperation): Promise<void>
}

let router: ObservationGovernanceRouter | null = null

export function setObservationGovernanceRouter(value: ObservationGovernanceRouter | null): void {
  router = value
}

/**
 * 本地应用一次治理操作（本进程是观察状态所有者时）。
 * 参数校验：坏参数显式抛，不静默放过。
 */
export async function applyObservationGovernance(operation: ObservationGovernanceOperation): Promise<void> {
  if (operation.action === "clear") return clearSilentUnderstandingOwned()
  if (operation.sessionId.length === 0 || operation.entryIds.length === 0
    || operation.sessionId.length > 512 || operation.entryIds.length > 10_000
    || operation.entryIds.some(id => typeof id !== "string" || id.length === 0 || id.length > 256)) {
    throw new Error("观察来源失效参数无效")
  }
  await applyTopicSourceInvalidation(operation.sessionId, operation.entryIds)
}

/** 清空静默了解（非所有者窗口经路由，其余本地应用）。 */
export async function clearSilentUnderstanding(): Promise<void> {
  await (router ? router.route({ action: "clear" }) : applyObservationGovernance({ action: "clear" }))
}

/** 按来源失效话题（非所有者窗口经路由，其余本地应用）。 */
export async function invalidateTopicSources(sessionId: string, entryIds: string[]): Promise<void> {
  const operation: ObservationGovernanceOperation = { action: "invalidate_topics", sessionId, entryIds }
  await (router ? router.route(operation) : applyObservationGovernance(operation))
}
