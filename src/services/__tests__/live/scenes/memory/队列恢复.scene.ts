import { installFakeProvider, fakeText } from "../../fake-provider"
import { RuntimeQueue } from "@/services/engine/runtime"
import { getRuntimeQueueSnapshot, initChat, recoverRuntimeQueue, resetRuntimeQueueForTest } from "@/services/agent/runner"
import { MemoryService, queueAckEvent, queueEntryEvent, parseSessionEventDocument, serializeSessionEvent, sessionTurnStore } from "@/services/agent/memory"
import type { SceneDef } from "../../types"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 队列恢复: SceneDef = {
  meta: {
    caseId: "queued-recovery",
    module: "memory",
    contractId: "mm-14",
    description: "重启后 queued 事件可恢复且 requestId 不重复投递",
    depth: "deep",
    suite: "regression",
    tags: ["queue", "recovery", "boundary", "error"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("恢复场景完成")])
    await initChat()
    const sessionId = MemoryService.sessionId
    const persistedEntry = {
      queueId: "queue-startup-recovery-1", sessionId, turnId: "turn-startup-recovery-1",
      requestId: "request-startup-recovery-1", priority: "now" as const, deliveryMode: "prompt" as const,
      sequence: 9001, enqueuedAt: 1, ackState: "persisted" as const, attempt: 0,
    }
    await MemoryService.appendSessionEventToSession(sessionId, queueEntryEvent(persistedEntry), "queued")
    const inFlightEntry = {
      queueId: "queue-startup-inflight-1", sessionId, turnId: "turn-startup-inflight-1",
      requestId: "request-startup-inflight-1", priority: "next" as const, deliveryMode: "prompt" as const,
      sequence: 9002, enqueuedAt: 2, ackState: "persisted" as const, attempt: 1,
    }
    await MemoryService.appendSessionEventToSession(sessionId, queueEntryEvent(inFlightEntry), "queued")
    await MemoryService.appendSessionEventToSession(
      sessionId,
      queueAckEvent(inFlightEntry, { queueId: inFlightEntry.queueId, turnId: inFlightEntry.turnId, state: "dispatched" }),
      "queue dispatched",
    )
    await sessionTurnStore.append({
      schemaVersion: 1,
      turnId: inFlightEntry.turnId,
      sessionId,
      requestId: inFlightEntry.requestId,
      role: "user",
      origin: "user",
      state: "queued",
      attempt: 1,
      idempotencyKey: `turn:${inFlightEntry.requestId}`,
      createdAt: inFlightEntry.enqueuedAt,
      updatedAt: inFlightEntry.enqueuedAt,
    })
    await sessionTurnStore.transition(inFlightEntry.turnId, "running")
    await resetRuntimeQueueForTest()
    const recovered = await recoverRuntimeQueue()
    if (recovered.requeued !== 1) throw new Error("启动扫描未重新入队 persisted 请求")
    if (recovered.quarantined !== 1) throw new Error("启动扫描未隔离 dispatched 请求")
    if (!getRuntimeQueueSnapshot().some(entry => entry.requestId === persistedEntry.requestId)) {
      throw new Error("启动扫描后的队列快照缺少请求")
    }
    if (getRuntimeQueueSnapshot().some(entry => entry.requestId === inFlightEntry.requestId)) {
      throw new Error("未知副作用请求不应自动重试")
    }
    const recoveredTurn = (await MemoryService.loadSessionEvents(sessionId))
      .filter(event => event.turnId === inFlightEntry.turnId && event.kind === "turn_state")
      .map(event => (event.payload as { record?: { state?: string } }).record?.state)
    if (recoveredTurn[recoveredTurn.length - 1] !== "unknown_side_effect") {
      throw new Error(`进行中 turn 未隔离未知副作用: ${recoveredTurn.join(",")}`)
    }
  },
  turns: [{ index: 1, description: "模拟 queued 恢复和幂等", userText: "验证 queued 恢复。", checks: [
    { type: "expectQueuedRecovery", run: async () => {
      if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
      const queue = new RuntimeQueue()
      const entry = queue.enqueue({
        queueId: "queue-recovery-1", sessionId: "session-recovery", turnId: "turn-recovery",
        requestId: "request-recovery", priority: "now", deliveryMode: "prompt", enqueuedAt: 1,
      })
      const raw = serializeSessionEvent(queueEntryEvent(entry)).join("\n")
      const parsed = parseSessionEventDocument(`## 对话记录\n${raw}`, entry.sessionId)
      if (parsed.events.length !== 1 || parsed.events[0]?.kind !== "queue_state") throw new Error("queued 事件无法恢复解析")
      const reserved = queue.reserve(entry.sessionId)
      if (!reserved) throw new Error("queued 事件未能 reserve")
      const requeued = queue.requeue(entry.queueId)
      if (requeued?.state !== "requeued") throw new Error("requeued 回执缺失")
      const recovered = queue.reserve(entry.sessionId)
      if (!recovered || recovered.attempt !== 2) throw new Error("requeued 事件未能再次投递")
      const ack = queue.acknowledge(entry.queueId, "accepted")
      if (!ack || ack.state !== "accepted") throw new Error("恢复后的 accepted 回执缺失")
      const ackRaw = serializeSessionEvent(queueAckEvent(recovered, ack)).join("\n")
      if (!ackRaw.includes("accepted")) throw new Error("accepted 事件无法序列化")
      if (queue.enqueue({ ...entry, enqueuedAt: 2 }).sequence !== entry.sequence) throw new Error("requestId 幂等失败")
    } },
  ] }],
}

export default 队列恢复
