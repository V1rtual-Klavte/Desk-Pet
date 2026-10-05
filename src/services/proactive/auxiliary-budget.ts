import { getHostBridge } from "@/services/host"
import type {
  ProactiveAuxiliaryBudgetReserveRequest, ProactiveAuxiliaryBudgetReserveResponse,
  ProactiveAuxiliaryBudgetSettleRequest, ProactiveAuxiliaryBudgetSettleResponse,
} from "@/services/agent/memory/protocol"

/** Shared durable token accounting for bounded auxiliary model calls. */
export const reserveAuxiliaryBudget = (request: ProactiveAuxiliaryBudgetReserveRequest): Promise<ProactiveAuxiliaryBudgetReserveResponse> =>
  getHostBridge().request("proactive_auxiliary_budget_reserve", { request })

export const settleAuxiliaryBudget = (request: ProactiveAuxiliaryBudgetSettleRequest): Promise<ProactiveAuxiliaryBudgetSettleResponse> =>
  getHostBridge().request("proactive_auxiliary_budget_settle", { request })
