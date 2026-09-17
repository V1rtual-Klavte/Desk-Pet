import type { SceneDef } from "../../types"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { appendTranscriptMessage, appendSessionEventToSession, commitCompaction, readContextView, updateSessionDocument } from "@/services/agent/memory"
import { compactSession } from "@/services/engine"
import { buildMessageRounds } from "@/services/context"
import type { Message } from "@/services/agent/types"
import type { SessionEvent } from "@/services/engine/runtime"
import { MemoryService } from "@/services/agent/memory"

const SESSION_ID = "session-20260917-090000"
const SUMMARY = JSON.stringify({
  intent: "继续讨论会话压缩的可靠提交", facts: ["用户要求完整正文继续保留在磁盘"], corrections: [],
  pending: ["验证 CAS 与取消不覆盖新会话版本"], continuity: ["本次使用 fake provider"], nextSteps: ["检查重载视图"],
})
const LONG = "压缩候选正文必须保留在磁盘中。".repeat(32)

let provider: ReturnType<typeof installFakeProvider> | undefined

function message(index: number, role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return {
    id: `compaction-${index}`,
    eventId: `compaction-${index}`,
    role,
    text,
    timestamp: 1_790_000_000_000 + index,
    origin: role === "user" ? "user" : role === "tool" ? "tool" : "assistant",
    taint: role === "user" ? "trusted_user" : "derived",
    ...extra,
  }
}

async function seedTranscript(): Promise<string[]> {
  await MemoryService.createSessionFile(SESSION_ID)
  const texts: string[] = []
  let index = 0
  for (let round = 0; round < 6; round++) {
    const user = `用户第 ${round} 轮：${LONG}${round}`
    const assistant = `助手第 ${round} 轮：${LONG}${round}`
    texts.push(user, assistant)
    await appendTranscriptMessage(SESSION_ID, message(index++, "user", user))
    await appendTranscriptMessage(SESSION_ID, message(index++, "assistant", assistant))
  }
  const toolCallId = "checkpoint-tool-call"
  const toolUser = `最后一轮工具任务：${LONG}`
  const toolResult = `工具结果：${LONG}`
  const toolAnswer = `工具后的完整答复：${LONG}`
  texts.push(toolUser, toolResult, toolAnswer)
  await appendTranscriptMessage(SESSION_ID, message(index++, "user", toolUser))
  await appendTranscriptMessage(SESSION_ID, message(index++, "assistant", "", {
    toolCalls: [{ id: toolCallId, name: "system_info", arguments: "{}" }],
  }))
  await appendTranscriptMessage(SESSION_ID, message(index++, "tool", toolResult, { toolCallId }))
  await appendTranscriptMessage(SESSION_ID, message(index++, "assistant", toolAnswer))
  return texts
}

async function rawSession(): Promise<string> {
  const file = (await MemoryService.listSessionFiles()).find(entry => entry.sessionId === SESSION_ID)
  if (!file) throw new Error("压缩场景会话文件不存在")
  const raw = await MemoryService.loadArchivedSession(file.filename)
  if (!raw) throw new Error("压缩场景无法读取会话原文")
  return raw
}

export const 压缩检查点: SceneDef = {
  meta: {
    caseId: "memory-compaction-checkpoint",
    module: "memory",
    contractId: "mm-19",
    description: "结构化压缩检查点的 CAS、取消、重载与完整 round 保留",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["memory", "compaction", "boundary", "error"],
  },
  setup: async () => {
    // 第一条供场景 runtime 回合消费；第二条是 compactSession 的结构化摘要。
    provider = installFakeProvider([fakeText("压缩场景运行完成"), fakeText(SUMMARY), fakeText("检查点重载后仍可继续对话")])
    await seedTranscript()
  },
  turns: [{
    index: 1,
    description: "提交检查点并验证旧摘要、取消和版本竞争不能改写会话",
    userText: "执行压缩检查点验证。",
    checks: [{
      type: "expectDurableCompactionCheckpoint",
      run: async () => {
        const before = await readContextView(SESSION_ID)
        const originalTexts = before.allMessages.map(item => item.text)
        const outcome = await compactSession({
          sessionId: SESSION_ID,
          mode: "assistant",
          runGeneration: 41,
          trigger: "preflight",
          contextMaxTokens: 4_096,
        })
        if (outcome.status !== "committed") {
          throw new Error(`压缩未提交: ${outcome.status} ${outcome.reason}`)
        }
        if ((provider?.state.callCount ?? 0) < 2) throw new Error("fake provider 未生成结构化摘要")

        const reloaded = await readContextView(SESSION_ID)
        if (!reloaded.checkpoint || !reloaded.summary.includes("历史参考数据")) throw new Error("重载后缺少有效压缩检查点")
        if (reloaded.allMessages.length !== before.allMessages.length || reloaded.messages.length >= reloaded.allMessages.length) {
          throw new Error(`压缩视图边界异常 all=${reloaded.allMessages.length} visible=${reloaded.messages.length}`)
        }
        const retainedOriginalTexts = new Set(reloaded.allMessages.map(item => item.text))
        for (const text of originalTexts) {
          if (text && !retainedOriginalTexts.has(text)) throw new Error("压缩删除了会话正文真相源")
        }
        const rawAfterCommit = await rawSession()
        if (!rawAfterCommit.includes("deskpet-event:") || !rawAfterCommit.includes("compaction-")) throw new Error("检查点没有持久化为 session event")

        // 被保留的 suffix 必须按完整 round 边界存在，尤其工具 call/result/answer 不能拆开。
        const retainedIds = new Set(reloaded.messages.map(item => item.eventId))
        for (const round of buildMessageRounds(reloaded.allMessages)) {
          const ids = round.messages.map(item => item.eventId)
          if (ids.some(id => retainedIds.has(id)) && !ids.every(id => retainedIds.has(id))) {
            throw new Error("压缩把一个完整工具 round 切开")
          }
        }

        const concurrent: SessionEvent = {
          schemaVersion: 1, eventId: "compaction-concurrent-write", sessionId: SESSION_ID,
          kind: "system_message", origin: "memory", payload: { text: "并发版本推进", eligibleForTranscript: false },
          createdAt: Date.now(), idempotencyKey: "compaction-concurrent-write",
        }
        const oldVersion = reloaded.version
        const staleCandidate = { ...outcome.checkpoint, compactionId: "compaction-stale-cas", expectedSessionVersion: oldVersion }
        if (!await appendSessionEventToSession(SESSION_ID, concurrent)) throw new Error("无法构造 CAS 竞争写入")
        if (await commitCompaction(staleCandidate, () => true)) throw new Error("过期 session version 错误提交了压缩结果")

        const beforeCancellation = await rawSession()
        const controller = new AbortController()
        controller.abort()
        const cancelled = await compactSession({
          sessionId: SESSION_ID,
          mode: "assistant",
          runGeneration: 42,
          trigger: "preflight",
          contextMaxTokens: 4_096,
          signal: controller.signal,
        })
        if (cancelled.status !== "stale") throw new Error(`取消后的压缩状态错误: ${cancelled.status}`)
        if (await rawSession() !== beforeCancellation) throw new Error("已取消压缩仍改写了会话文件")

        // 生成阶段失败/取消不会写 cutoff；手动压缩在切换标签后仍提交到捕获的 A。
        const switchedSessionId = "session-20260917-090002"
        await MemoryService.createSessionFile(switchedSessionId)
        await MemoryService.setActiveSession(SESSION_ID)
        const duringGeneration = new AbortController()
        const nestedProvider = installFakeProvider([
          fakeText('{"intent":"缺失必需字段"}'),
          () => { duringGeneration.abort(); return fakeText(SUMMARY) },
          async () => { await MemoryService.setActiveSession(switchedSessionId); return fakeText(SUMMARY) },
        ])
        try {
          const invalid = await compactSession({ sessionId: SESSION_ID, mode: "pet", runGeneration: 43, trigger: "manual", contextMaxTokens: 4_096 })
          if (invalid.status !== "failed" || await rawSession() !== beforeCancellation) throw new Error("非法摘要推进了 cutoff 或错误报告成功")
          const aborted = await compactSession({ sessionId: SESSION_ID, mode: "pet", runGeneration: 44, trigger: "manual", contextMaxTokens: 4_096, signal: duringGeneration.signal })
          if (aborted.status !== "stale" || await rawSession() !== beforeCancellation) throw new Error("生成期间取消仍提交了摘要")
          const switched = await compactSession({ sessionId: SESSION_ID, mode: "pet", runGeneration: 45, trigger: "manual", contextMaxTokens: 4_096 })
          if (switched.status !== "committed" || switched.checkpoint.summaryKind !== "companion") throw new Error("切换标签导致捕获的手动压缩目标失效")
          if ((await readContextView(switchedSessionId)).checkpoint) throw new Error("A 的压缩错误写入了当前 B 会话")
          const chained = await readContextView(SESSION_ID)
          if (chained.checkpoint?.contextEpoch !== outcome.checkpoint.contextEpoch + 1 || chained.allMessages.length !== before.allMessages.length) throw new Error("多次压缩的 hash 链或原文不完整")
        } finally {
          nestedProvider.restore()
          await MemoryService.setActiveSession(SESSION_ID)
        }

        // 历史 deskpet-turn 仍是完整会话正文来源；压缩读取不能只接受新 event 格式。
        const legacySessionId = "session-20260917-090001"
        await MemoryService.createSessionFile(legacySessionId)
        const legacyTurn = encodeURIComponent(JSON.stringify({ role: "user", text: "旧正文不能因压缩迁移丢失", timestamp: 1_790_000_000_999 }))
        const updatedLegacy = await updateSessionDocument(legacySessionId, raw => `${raw.trimEnd()}\n- [2026-09-17 09:00:00] **用户**: 旧正文不能因压缩迁移丢失\n  <!-- deskpet-turn:${legacyTurn} -->\n`)
        if (!updatedLegacy) throw new Error("无法写入 legacy compaction 测试会话")
        const legacyView = await readContextView(legacySessionId)
        if (legacyView.allMessages.length !== 1 || legacyView.allMessages[0]?.text !== "旧正文不能因压缩迁移丢失" || legacyView.checkpoint) {
          throw new Error("旧 deskpet-turn 不能被压缩读取链路恢复")
        }
        // legacy fixture 会临时切换 MemoryService 活跃会话；第二个 runtime turn 必须回到检查点会话。
        await MemoryService.setActiveSession(SESSION_ID)
      },
    }],
  }, {
    index: 2,
    description: "后续回合不丢失已提交的压缩视图",
    userText: "继续验证压缩后的会话。",
    checks: [{
      type: "expectCheckpointSurvivesNextTurn",
      run: async () => {
        const view = await readContextView(SESSION_ID)
        if (!view.checkpoint || view.messages.length >= view.allMessages.length) throw new Error("后续回合后压缩检查点或覆盖边界丢失")
        if ((provider?.state.callCount ?? 0) < 3) throw new Error("第二个 runtime 回合未使用 fake provider")
      },
    }],
  }],
}

export default 压缩检查点
