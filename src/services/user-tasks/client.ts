import { getHostBridge } from "@/services/host"
import type { ScheduleChangeRequest, ScheduleChangeResponse, ScheduleQueryRequest, ScheduleQueryResponse } from "@/services/scheduler/protocol"
import { internalScheduler } from "@/services/scheduler/kernel"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

export type UserTaskChange = ScheduleChangeResponse & { action: ScheduleChangeRequest["action"] }
const listeners = new Set<(change: UserTaskChange) => void>()
const log = createLogger("UserTasks")
/** Notification only; persisted task state stays in Rust. */
export function subscribeUserTaskChanges(listener: (change: UserTaskChange) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const queryUserTasks = (request: ScheduleQueryRequest): Promise<ScheduleQueryResponse> => getHostBridge().request("schedule_query", { request })
/** A deleted session/Card must not leave an active task that can still execute or deliver. */
export async function invalidateOwnerTasks(request: { sessionId?: string; cardId?: string; cardHash?: string; operationId?: string }): Promise<number> {
  const result = await getHostBridge().request("scheduler_state", { request: {
    operation: "owner_invalidate",
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.cardId ? { cardId: request.cardId } : {}),
    ...(request.cardHash ? { cardHash: request.cardHash } : {}),
    operationId: request.operationId ?? crypto.randomUUID(),
    now: Date.now(),
  } })
  return "invalidated" in result ? result.invalidated : 0
}
export async function changeUserTask(request: ScheduleChangeRequest): Promise<ScheduleChangeResponse> {
  let result: ScheduleChangeResponse
  try { result = await getHostBridge().request("schedule_change", { request }) }
  catch (error) {
    // A transport failure does not prove the transaction failed. Read the exact durable receipt first.
    const query = await queryUserTasks({owner:request.owner,operationId:request.operationId}).catch(recoveryError=>{
      log.warn("任务提交回执尚无法对账:",formatError(recoveryError));return undefined
    })
    if(query?.operationReceipt?.status!=="committed"||!query.operationReceipt.result)throw error
    result=query.operationReceipt.result
  }
  internalScheduler.wake("user_tasks")
  for (const listener of listeners) {
    try { listener({ ...result, action: request.action }) }
    catch (error) { log.warn("任务已提交，但变更通知处理失败:", formatError(error)) }
  }
  return result
}
