import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { MemoryService, parseSessionEventDocument } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"

// deskpet-event 是新会话消息的唯一持久化记录。历史 deskpet-turn 只供兼容读取，
// 新回合不能双写两种格式，否则重载会把同一句话重放两次。
const USER_ONE = "先记个暗号：紫水晶七号，等下我要考你。"
const USER_TWO = "再补一个暗号：柠檬四号。"
// 生产入口可能保留启动问候；所以只按本场景回复原文精确计数。
const REPLY_ONE = "暗号记下了。"
const REPLY_TWO = "又记下一个啦。"

let provider: ReturnType<typeof installFakeProvider> | undefined

function decodeRecords(raw: string, marker: "deskpet-turn" | "deskpet-event"): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  for (const match of raw.matchAll(new RegExp(`<!--\\s*${marker}:([^\\s]+)\\s*-->`, "g"))) {
    try {
      const decoded: unknown = JSON.parse(decodeURIComponent(match[1]))
      if (decoded && typeof decoded === "object") records.push(decoded as Record<string, unknown>)
    } catch { /* 损坏记录由 parseSessionEventDocument 的 issues 统一报告 */ }
  }
  return records
}

/** 读回当前会话原文；写入是异步的，先等 pending 写入落盘。 */
async function readSessionRaw(): Promise<string> {
  await MemoryService.flushSessionWrites()
  const sessionId = MemoryService.sessionId
  const filename = (await MemoryService.listSessionFiles()).find(file => file.sessionId === sessionId)?.filename
  if (!filename) throw new Error(`未找到当前会话文件: ${sessionId}`)
  const raw = await MemoryService.loadArchivedSession(filename)
  if (!raw) throw new Error(`会话原文读取为空: ${filename}`)
  return raw
}

function assertSingleMessageEvent(raw: string, role: "user" | "assistant", text: string): void {
  const kind = `${role}_message`
  const count = decodeRecords(raw, "deskpet-event")
    .filter(record => record.kind === kind && (record.payload as { text?: unknown } | undefined)?.text === text).length
  if (count !== 1) throw new Error(`"${text}" 落了 ${count} 条 ${kind}，期望 1 条`)
}

/** 新回合不得再写 deskpet-turn：两个协议同时写会把正文重放两次。 */
function assertNoLegacyTurn(raw: string, role: "user" | "assistant", text: string): void {
  const count = decodeRecords(raw, "deskpet-turn").filter(record => record.role === role && record.text === text).length
  if (count > 0) throw new Error(`"${text}" 被同时写成 ${count} 条 deskpet-turn（双写回归）`)
}

/** 从新消息事件重载的 user_message：每句话恰好 1 条，总数与预期一致。 */
function assertUserMessageProjection(raw: string, expected: string[]): void {
  const parsed = parseSessionEventDocument(raw, MemoryService.sessionId)
  if (parsed.issues.length > 0) throw new Error(`会话文件出现损坏记录: ${parsed.issues.map(issue => issue.code).join(",")}`)
  const projected = parsed.events.filter(event => event.kind === "user_message")
  for (const text of expected) {
    const count = projected.filter(event => String(event.payload.text) === text).length
    if (count !== 1) throw new Error(`"${text}" 投影出 ${count} 条 user_message，期望 1 条`)
  }
  if (projected.length !== expected.length) throw new Error(`user_message 投影总数 ${projected.length}，期望 ${expected.length}`)
}

export const 消息单次写入: SceneDef = {
  meta: {
    caseId: "memory-single-message-write",
    module: "memory",
    contractId: "mm-18",
    description: "消息事件单次写入：一句话只有一条 deskpet-event，不双写 legacy turn",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "session", "production-entry"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText(REPLY_ONE), fakeText(REPLY_TWO)])
    await initChat()
  },
  turns: [
    { index: 1, description: "首个回合后只留一条消息事件", userText: USER_ONE, checks: [
      { type: "expectSingleMessageWrite", run: async () => {
        if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
        const raw = await readSessionRaw()
        assertSingleMessageEvent(raw, "user", USER_ONE)
        assertSingleMessageEvent(raw, "assistant", REPLY_ONE)
        assertNoLegacyTurn(raw, "user", USER_ONE)
        assertNoLegacyTurn(raw, "assistant", REPLY_ONE)
        assertUserMessageProjection(raw, [USER_ONE])
      } },
    ] },
    { index: 2, description: "第二回合后历史消息不重复追加", userText: USER_TWO, checks: [
      { type: "expectNoDuplicateMessageWrite", run: async () => {
        const raw = await readSessionRaw()
        assertSingleMessageEvent(raw, "user", USER_ONE)
        assertSingleMessageEvent(raw, "user", USER_TWO)
        assertSingleMessageEvent(raw, "assistant", REPLY_ONE)
        assertSingleMessageEvent(raw, "assistant", REPLY_TWO)
        assertNoLegacyTurn(raw, "user", USER_ONE)
        assertNoLegacyTurn(raw, "user", USER_TWO)
        assertNoLegacyTurn(raw, "assistant", REPLY_ONE)
        assertNoLegacyTurn(raw, "assistant", REPLY_TWO)
        assertUserMessageProjection(raw, [USER_ONE, USER_TWO])
      } },
    ] },
  ],
}

export default 消息单次写入
