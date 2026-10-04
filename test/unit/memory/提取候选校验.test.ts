// ==========================================
// Review 候选规范化 —— 模型输出不能把整批整理打挂
//
// 背景：Review 提示词允许 kind=working，但 Rust 校验要求 working 必须带
// open/completed/cancelled 状态。模型漏写或写非法值时，若原样入库会让
// candidates_add 整批失败（记忆库不可用），整次 dreaming sweep 判失败。
// 这里钉住宿主的规范化：working 缺状态默认 open、非法值不猜完成态、
// 非 working 不携带事项状态；来源白名单仍由本层把关。
// ==========================================

import { describe, expect, it } from "vitest"

import { parseReviewCandidates } from "@/services/agent/memory/dreaming"
import type { MemorySource } from "@/services/agent/memory"

const SOURCE = {
  sourceId: "source-1",
  sessionId: "session-a",
  entryId: "entry-1",
  eventId: "event-1",
  seq: 1,
  contentHash: "hash-1",
  evidence: "用户说：明天要交作业",
  cardId: "card-a",
  taint: "trusted_user",
  origin: "user",
  eligibleForMemory: true,
  observedAt: 1,
} as unknown as MemorySource

describe("Review 候选规范化", () => {
  it("working 候选缺状态时默认 open，非法状态不猜完成态", () => {
    const missing = parseReviewCandidates(JSON.stringify({
      candidates: [{ sourceIds: ["source-1"], content: "明天要交作业", kind: "working", scope: "user" }],
    }), [SOURCE])
    expect(missing).toHaveLength(1)
    expect(missing[0]!.draft.workingState).toBe("open")

    const invalid = parseReviewCandidates(JSON.stringify({
      candidates: [{ sourceIds: ["source-1"], content: "作业交完了", kind: "working", scope: "user", workingState: "done" }],
    }), [SOURCE])
    expect(invalid[0]!.draft.workingState).toBe("open")

    const explicit = parseReviewCandidates(JSON.stringify({
      candidates: [{ sourceIds: ["source-1"], content: "作业交完了", kind: "working", scope: "user", workingState: "completed" }],
    }), [SOURCE])
    expect(explicit[0]!.draft.workingState).toBe("completed")
  })

  it("非 working 候选不携带事项状态，来源白名单外的候选整条丢弃", () => {
    const parsed = parseReviewCandidates(JSON.stringify({
      candidates: [
        { sourceIds: ["source-1"], content: "用户喜欢简洁的回复", kind: "preference", scope: "user", workingState: "open" },
        { sourceIds: ["ghost-source"], content: "编造来源的事实", kind: "fact", scope: "user" },
      ],
    }), [SOURCE])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.draft.kind).toBe("preference")
    expect("workingState" in parsed[0]!.draft).toBe(false)
  })
})
