import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { vi } from "vitest"
import { getHostBridge } from "@/services/host"
import type { SchedulerSlotRecord, SchedulerStateRequest } from "@/services/scheduler/protocol"

/**
 * Explicit L3 fixture for TS scheduling consumers only. The generic Node host continues
 * rejecting scheduler_state: native SQLite transactions/owner admission remain L4 behavior.
 * A file survives module reloads so restart tests exercise the consumer's durable claim flow.
 */
export function installSchedulerSlotFixture(
  path: string,
  extra?: (method: string, args?: unknown, options?: unknown) => Promise<unknown> | undefined,
) {
  const read = (): SchedulerSlotRecord[] => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SchedulerSlotRecord[] : []
  const bridge = getHostBridge() as unknown as { request: (method: string, args?: unknown, options?: unknown) => Promise<unknown> }
  const request = bridge.request.bind(bridge)
  const spy = vi.spyOn(bridge, "request").mockImplementation(async (method, args, options) => {
    const handled = extra?.(method, args, options)
    if (handled !== undefined) return handled
    if (method !== "scheduler_state") return request(method, args, options)
    const body = (args as { request: SchedulerStateRequest }).request
    if (body.operation !== "slot_get" && body.operation !== "slot_claim" && body.operation !== "slot_settle") return request(method, args, options)
    const rows = read()
    const sameKey = rows.filter(row => row.key === body.key)
    let saved = body.slotId ? sameKey.find(row => row.slotId === body.slotId) : sameKey.sort((a, b) => b.scheduledAt - a.scheduledAt)[0]
    let claimed = false
    if (body.operation === "slot_claim" && !sameKey.some(row => row.scheduledAt >= body.scheduledAt)) {
      saved = { key: body.key, slotId: body.slotId, scheduledAt: body.scheduledAt, timezone: body.timezone,
        status: "claimed", revision: 1, lastAttemptAt: body.now, businessRef: body.businessRef ?? null, updatedAt: body.now }
      rows.push(saved)
      claimed = true
      writeFileSync(path, JSON.stringify(rows), "utf8")
    } else if (body.operation === "slot_settle") {
      if (!saved || saved.revision !== body.expectedRevision || !["claimed", "started", "unresolved"].includes(saved.status) || body.status === "started" && saved.status !== "claimed") throw new Error("scheduler_slot_fixture_revision_conflict")
      saved.status = body.status
      saved.revision++
      saved.updatedAt = body.now
      saved.businessRef = body.businessRef ?? saved.businessRef
      writeFileSync(path, JSON.stringify(rows), "utf8")
    }
    return { operation: body.operation, slot: saved ?? null, lastAttemptAt: rows.some(row => row.key === body.key) ? Math.max(...rows.filter(row => row.key === body.key).map(row => row.lastAttemptAt)) : null, claimed }
  })
  return { read, restore: () => spy.mockRestore() }
}
