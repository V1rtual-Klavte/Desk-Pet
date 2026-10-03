import { captureProactiveOwner, sendActiveMessage } from "@/services/agent/runner"
import type { ActiveMessageRequest, ActiveMessageResult, ProactiveOwner } from "@/services/agent/types"

/** Scheduler-facing expression port. It owns no locks, counters, or delivery state. */
export interface ActiveExpressionAdapter {
  captureOwner(): Promise<ProactiveOwner | undefined>
  express(request: ActiveMessageRequest): Promise<ActiveMessageResult>
}

export function createActiveExpressionAdapter(): ActiveExpressionAdapter {
  return {
    captureOwner: captureProactiveOwner,
    express: sendActiveMessage,
  }
}
