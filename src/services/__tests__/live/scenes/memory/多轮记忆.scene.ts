import type { SceneDef } from "../../types"
import type { SessionEvent } from "@/services/engine/runtime"
import { MemoryService } from "@/services/agent/memory"
import { flushSessionWrites } from "@/services/agent/memory/session-files"

// 真实写入路径（persistTurn）会为同一条消息先后落两条记录：deskpet-turn 保存完整正文，
// deskpet-event 追加协议事件，其预览行只有 300 字且时间戳只到秒。
// 重载时必须以 turn 记录为准，预览副本不能被当成第二条消息重放。
const MIXED_RECORD_PREFIX = "混合记录夹具："
const MIXED_RECORD_TEXT = `${MIXED_RECORD_PREFIX}${"甲".repeat(400)}`

function mixedRecordEvent(sessionId: string): SessionEvent {
  const eventId = "event-mixed-record"
  return {
    schemaVersion: 1, eventId, sessionId, kind: "assistant_message", origin: "assistant",
    payload: { text: MIXED_RECORD_TEXT }, createdAt: Date.now(), idempotencyKey: eventId,
  }
}

export const 多轮记忆: SceneDef = {
  meta: { caseId: "memory-multi-turn", module: "memory", contractId: "mm-08", description: "多轮对话后记忆正确存储", depth: "deep", suite: "regression", tags: ["memory", "boundary"] },
  turns: [
    { index: 1, description: "自我介绍", userText: "我叫小明，是个程序员。\n我平时主要写 TypeScript。",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 1) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
        { type: "expectStoredUserFact", run: async (ctx) => {
          if (!ctx.memory.sessionTurns.some(turn => turn.role === "user" && turn.text.includes("小明"))) {
            throw new Error("用户事实未写入会话工作记忆")
          }
        } },
        { type: "expectSessionFile", run: async () => {
          await flushSessionWrites()
          const turns = await MemoryService.loadSessionMessages(MemoryService.sessionId)
          if (!turns?.some(turn => turn.role === "user" && turn.text === "我叫小明，是个程序员。\n我平时主要写 TypeScript。")) {
            throw new Error("sessions/*.md 未保留用户消息的完整换行正文")
          }
        } },
        { type: "expectMixedRecordSingleReplay", run: async () => {
          const sessionId = MemoryService.sessionId
          await flushSessionWrites()
          await MemoryService.recordTurnToSession(sessionId, "assistant", MIXED_RECORD_TEXT)
          const stored = await MemoryService.appendSessionEventToSession(sessionId, mixedRecordEvent(sessionId), MIXED_RECORD_TEXT)
          if (!stored) throw new Error("混合记录的 deskpet-event 未落盘")
          await flushSessionWrites()
          const turns = await MemoryService.loadSessionMessages(sessionId)
          const matched = turns?.filter(turn => turn.text.startsWith(MIXED_RECORD_PREFIX)) ?? []
          if (matched.length !== 1) throw new Error(`混合记录重放为 ${matched.length} 条消息，期望 1 条`)
          if (matched[0].role !== "assistant") throw new Error(`混合记录 role=${matched[0].role}，期望 assistant`)
          if (matched[0].text !== MIXED_RECORD_TEXT) throw new Error("混合记录重放了 300 字预览副本而不是完整正文")
        } },
      ] },
    { index: 2, description: "回忆测试", userText: "你还记得我叫什么吗？",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 2) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
        { type: "expectStoredUserFact", run: async (ctx) => {
          if (!ctx.memory.sessionTurns.some(turn => turn.role === "user" && turn.text.includes("小明"))) {
            throw new Error("跨轮后用户事实未保留在会话工作记忆")
          }
        } },
        { type: "expectSessionReplay", run: async () => {
          await flushSessionWrites()
          const turns = await MemoryService.loadSessionMessages(MemoryService.sessionId)
          if (!turns || turns.filter(turn => turn.role === "user").length < 2) {
            throw new Error("多轮会话未能从 Markdown 完整重放")
          }
        } },
      ] },
  ],
}
export default 多轮记忆
