import { getHostBridge } from "@/services/host"
import { scheduledSlotDue, SCHEDULE_CATCHUP_MS } from "@/services/proactive/schedule"
import type { SchedulerSlotKey, SchedulerSlotRecord } from "./protocol"

export function nextFixedWake(hours: readonly number[], now: number): number | null {
  if (!hours.length) return null
  if (scheduledSlotDue(hours, now, 0)) return now + 60_000
  const date = new Date(now)
  for (let day = 0; day <= 1; day++) {
    for (const hour of [...hours].sort((a, b) => a - b)) {
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + day, hour).getTime()
      if (candidate > now) return candidate
    }
  }
  return null
}
export async function dueFixedSlot(key: SchedulerSlotKey, hours: readonly number[], minGap: number, now = Date.now()): Promise<{slotId: string; scheduledAt: number; timezone: string} | undefined> {
  if (!scheduledSlotDue(hours, now, 0)) return
  const date = new Date(now)
  const scheduledAt = now - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const slotId = `${timezone}:${scheduledAt}`
  const result = await getHostBridge().request("scheduler_state", { request: { operation: "slot_get", key, slotId } })
  if (!("slot" in result) || result.slot || (result.lastAttemptAt !== null && now - result.lastAttemptAt < minGap)) return
  return {slotId, scheduledAt, timezone}
}
export async function claimFixedSlot(key: SchedulerSlotKey, slot: {slotId:string;scheduledAt:number;timezone:string}, businessRef?: string): Promise<SchedulerSlotRecord | undefined> {
  const now = Date.now()
  if (now < slot.scheduledAt || now >= slot.scheduledAt + SCHEDULE_CATCHUP_MS) return
  const result = await getHostBridge().request("scheduler_state", { request: {operation:"slot_claim", key, ...slot, ...(businessRef ? {businessRef} : {}), operationId:crypto.randomUUID(), now} })
  return "slot" in result && result.claimed ? result.slot ?? undefined : undefined
}
export async function settleFixedSlot(slot: SchedulerSlotRecord, status: "succeeded"|"failed"|"unresolved", businessRef?: string): Promise<void> {
  await getHostBridge().request("scheduler_state", {request:{operation:"slot_settle",key:slot.key,slotId:slot.slotId,expectedRevision:slot.revision,status,...(businessRef?{businessRef}:{}),operationId:crypto.randomUUID(),now:Date.now()}})
}
