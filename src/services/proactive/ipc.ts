import { getHostBridge } from "@/services/host"
import type {
  ProactiveAttempt, ProactiveBudget, ProactiveChangeRequest, ProactiveChangeResponse,
  ProactiveClaimRequest, ProactiveClaimResponse, ProactiveControl, ProactiveDecision,
  ProactiveControlRequest,
  ProactiveQueryRequest, ProactiveQueryResponse, ProactiveReconcileRequest,
  ProactiveScanRequest, ProactiveScanResponse, ProactiveSettleRequest,
  ProactiveSourceRef, ProactiveTask, ProactiveValidateRequest, ProactiveValidateResponse,
} from "@/services/agent/memory/protocol"

export type {
  ProactiveAttempt, ProactiveBudget, ProactiveChangeRequest, ProactiveChangeResponse,
  ProactiveClaimRequest, ProactiveClaimResponse, ProactiveControl, ProactiveDecision,
  ProactiveControlRequest,
  ProactiveQueryRequest, ProactiveQueryResponse, ProactiveReconcileRequest,
  ProactiveScanRequest, ProactiveScanResponse, ProactiveSettleRequest,
  ProactiveSourceRef, ProactiveTask, ProactiveValidateRequest, ProactiveValidateResponse,
} from "@/services/agent/memory/protocol"
export { PROACTIVE_LIMITS } from "@/services/agent/memory/protocol"

export const scan = (request: ProactiveScanRequest): Promise<ProactiveScanResponse> => getHostBridge().request("proactive_scan", { request })
export const query = (request: ProactiveQueryRequest): Promise<ProactiveQueryResponse> => getHostBridge().request("proactive_query", { request })
export const change = (request: ProactiveChangeRequest): Promise<ProactiveChangeResponse> => getHostBridge().request("proactive_change", { request })
export const claim = (request: ProactiveClaimRequest): Promise<ProactiveClaimResponse> => getHostBridge().request("proactive_claim", { request })
export const validate = (request: ProactiveValidateRequest): Promise<ProactiveValidateResponse> => getHostBridge().request("proactive_validate", { request })
export const settle = (request: ProactiveSettleRequest): Promise<{ revision: number; status: ProactiveAttempt["status"] }> => getHostBridge().request("proactive_settle", { request })
export const reconcile = (request: ProactiveReconcileRequest): Promise<{ revision: number; status: ProactiveAttempt["status"] }> => getHostBridge().request("proactive_reconcile", { request })
// `control` 同时承载 patch（muteUntil / clearBehaviorSources，运行期状态）与档位投影
// `limits`（契约 §2.5，形如 ProactiveLimits 一整行）；enabled 已随开关并入档位删除。
export const control = (request: ProactiveControlRequest): Promise<ProactiveControl> => getHostBridge().request("proactive_control", { request })
export { reserveAuxiliaryBudget, settleAuxiliaryBudget } from "./auxiliary-budget"
