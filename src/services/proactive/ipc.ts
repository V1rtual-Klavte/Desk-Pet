import { invoke } from "@tauri-apps/api/core"
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

export const scan = (request: ProactiveScanRequest): Promise<ProactiveScanResponse> => invoke("proactive_scan", { request })
export const query = (request: ProactiveQueryRequest): Promise<ProactiveQueryResponse> => invoke("proactive_query", { request })
export const change = (request: ProactiveChangeRequest): Promise<ProactiveChangeResponse> => invoke("proactive_change", { request })
export const claim = (request: ProactiveClaimRequest): Promise<ProactiveClaimResponse> => invoke("proactive_claim", { request })
export const validate = (request: ProactiveValidateRequest): Promise<ProactiveValidateResponse> => invoke("proactive_validate", { request })
export const settle = (request: ProactiveSettleRequest): Promise<{ revision: number; status: ProactiveAttempt["status"] }> => invoke("proactive_settle", { request })
export const reconcile = (request: ProactiveReconcileRequest): Promise<{ revision: number; status: ProactiveAttempt["status"] }> => invoke("proactive_reconcile", { request })
export const control = (request: ProactiveControlRequest): Promise<ProactiveControl> => invoke("proactive_control", { request })
