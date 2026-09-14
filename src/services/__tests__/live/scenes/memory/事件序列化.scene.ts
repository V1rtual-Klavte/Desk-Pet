import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { parseSessionEventDocument, serializeSessionEvent } from "@/services/agent/memory"
import type { SessionEvent } from "@/services/engine/runtime"

export const 事件序列化: SceneDef = {
  meta: { caseId: "memory-event-serialization", module: "memory", contractId: "mm-09", description: "会话事件可读且无损序列化", depth: "shallow", suite: "regression", tags: ["memory", "error"] },
  setup: async () => { installFakeProvider([fakeText("事件序列化完成")]) },
  turns: [{ index: 1, description: "验证事件 round trip", userText: "验证事件序列化。", checks: [{ type: "expectEventRoundTrip", run: async () => {
    const event: SessionEvent = { schemaVersion: 1, eventId: "event-smoke", sessionId: "session-smoke", turnId: "turn-smoke", kind: "user_message", origin: "user", payload: { text: "保留原文", rawText: "原始\n换行" }, createdAt: Date.now(), idempotencyKey: "idem-smoke" }
    const raw = serializeSessionEvent(event).join("\n")
    const parsed = parseSessionEventDocument(`## 对话记录\n${raw}`, event.sessionId)
    const restored = parsed.events[0] as SessionEvent | undefined
    if (!restored || restored.eventId !== event.eventId || restored.payload.rawText !== "原始\n换行" || !raw.includes("保留原文")) throw new Error("事件序列化丢失字段")
  } }] }],
}

export default 事件序列化
