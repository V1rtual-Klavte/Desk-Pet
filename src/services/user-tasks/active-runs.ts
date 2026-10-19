import type { ProactiveOwner } from "@/services/proactive/protocol"

/**
 * Lightweight ownership index for in-flight scheduled work. Kept free of
 * engine/harness imports so session/Card deletion paths can cancel work without
 * loading the agent runtime (and L2 Card tests stay in their layer).
 */
const runs = new Map<string, { controller: AbortController; owner: ProactiveOwner }>()

export function trackRun(key: string, controller: AbortController, owner: ProactiveOwner): void {
  runs.set(key, { controller, owner })
}

export function untrackRun(key: string): void {
  runs.delete(key)
}

export function activeRunEntries(): IterableIterator<[string, { controller: AbortController; owner: ProactiveOwner }]> {
  return runs.entries()
}

export function cancelRuns(predicate: (owner: ProactiveOwner) => boolean, reason = "任务所属会话或 Card 已失效"): void {
  for (const { controller, owner } of runs.values()) {
    if (predicate(owner)) controller.abort(new Error(reason))
  }
}

export function cancelAllRuns(reason = "任务调度停止"): void {
  for (const { controller } of runs.values()) controller.abort(new Error(reason))
}
