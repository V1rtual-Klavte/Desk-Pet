// 场景共用的会话条目读取（H-4：正文真相源是 sessions/ 下的 JSONL entry）。
//
// 只复用生产读模型（readPiSessionEntries + messagesFromEntries），场景不另建解析器。

import type { Entry } from "@earendil-works/pi-agent-core"
import type { Message } from "@/services/agent/types"
import { readPiSessionEntries } from "@/services/session/repo"
import { messagesFromEntries } from "@/services/session/read-model"
import { getActiveSessionId } from "@/services/session/store"

/** 读取会话条目（默认当前活跃会话）。 */
export async function sessionEntries(sessionId?: string): Promise<Entry[]> {
  const id = sessionId ?? getActiveSessionId()
  if (!id) throw new Error("没有活跃会话")
  return readPiSessionEntries(id)
}

/** 条目 → 聊天视图消息（与 UI 同一条读模型）。 */
export async function sessionMessages(sessionId?: string): Promise<Message[]> {
  return messagesFromEntries(await sessionEntries(sessionId))
}

/**
 * 原始条目内消息的正文（字符串正文，或按读模型同口径拼接 text 块）。
 *
 * 读模型之外的断言需要它：「条目里有、视图里没有」这类对比必须看原始条目，
 * 不能拿投影后的 `Message[]` 反推。
 */
export function entryMessageText(message: { content: string | readonly { type?: string; text?: string }[] }): string {
  if (typeof message.content === "string") return message.content
  return message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("")
}

/** 用户消息正文（按条目顺序）。 */
export function userTexts(messages: Message[]): string[] {
  return messages.filter(message => message.role === "user").map(message => message.text)
}

/** 助手消息正文（按条目顺序）。 */
export function assistantTexts(messages: Message[]): string[] {
  return messages.filter(message => message.role === "assistant").map(message => message.text)
}

/** 某段正文出现次数；用于「恰好一次」断言。 */
export function countTexts(texts: string[], expected: string): number {
  return texts.filter(text => text.includes(expected)).length
}

/** 压缩条目（Harness compaction entry）。 */
export function compactionEntries(entries: Entry[]): Extract<Entry, { type: "compaction" }>[] {
  return entries.filter((entry): entry is Extract<Entry, { type: "compaction" }> => entry.type === "compaction")
}
