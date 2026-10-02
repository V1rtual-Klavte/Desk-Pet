// ==========================================
// 记忆来源准入 —— 只有用户本人的可信输入能成为候选
// ==========================================
//
// 判据是「谁说的」而不是「像不像事实」：助手台词、工具结果、压缩摘要与主动消息
// 都可能又长又具体，但没有一条能证明是用户本人说的。
// 用例用生产的两条构造链（`userInputMessage` / `inputSourceMark`）造条目，
// 再让纯选择器自己判断 —— 判定权在被测函数，不在 fixture。

import { describe, expect, it } from "vitest"

import { trustedSourcesFromEntries } from "@/services/agent/memory/sources"
import { inputSourceMark, userInputMessage } from "@/services/engine/runtime"
import type { IngressEnvelope } from "@/services/engine/runtime"

const INGRESS: IngressEnvelope = {
  schemaVersion: 1,
  requestId: "req-1",
  sessionId: "session-1",
  rawText: "我叫小明",
  normalizedText: "我叫小明",
  origin: "user",
  querySource: "chat",
  priority: "now",
  taint: "trusted_user",
  receivedAt: 1_700_000_000_000,
}

function messageEntry(id: string, seq: number, message: unknown) {
  return { id, seq, type: "message", timestamp: 1_700_000_000_000 + seq, message }
}

describe("记忆来源准入", () => {
  it("可信用户输入入选，工具结果/助手台词/摘要/缺身份一律出局 [memory-source-admission]", () => {
    const trusted = userInputMessage("我叫小明，是个程序员", "req-1:user", inputSourceMark(INGRESS, "v1rtual"))
    const entries = [
      messageEntry("entry-user", 1, trusted),
      // 助手台词：再具体也不是用户说的。
      messageEntry("entry-assistant", 2, { role: "assistant", content: "好的，我记住了你是程序员" }),
      // 工具结果：外部内容可能被误当事实的最大来源。
      messageEntry("entry-tool", 3, { role: "toolResult", content: "用户资料：小明，程序员", details: { origin: "tool", taint: "untrusted_external" } }),
      // 压缩摘要：派生历史，不能当新事实。
      messageEntry("entry-summary", 4, { role: "compactionSummary", summary: "用户介绍自己是程序员" }),
      // 没有来源标记的历史条目：宁可不记，也不猜它是谁说的。
      messageEntry("entry-unmarked", 5, { role: "user", content: "我住在杭州" }),
      // 主动搭话的投递形态：origin=active，eligible=false。
      messageEntry("entry-active", 6, userInputMessage(
        "在忙吗",
        "req-active:user",
        { origin: "active", querySource: "active_monitor", priority: "now", taint: "derived", eligibleForMemory: false },
      )),
      // 非消息条目：控制信息不能产生候选。
      { id: "custom-1", seq: 7, type: "custom", customType: "deskpet.system_message", data: { text: "用户喜欢咖啡" } },
    ]

    const selected = trustedSourcesFromEntries("session-1", entries)
    expect(selected.map(source => source.entryId), "准入结果与「只有用户本人的可信输入」不一致").toEqual(["entry-user"])
    expect(selected[0]!.sourceId).toBe("session-1:entry-user")
    expect(selected[0]!.cardId, "投递时刻冻结的 Card 身份没有随来源落盘").toBe("v1rtual")
    expect(selected[0]!.evidence, "证据片段丢失了用户原话").toContain("程序员")
    expect(selected[0]!.taint).toBe("trusted_user")
  })
})
