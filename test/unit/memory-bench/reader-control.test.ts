import { describe, expect, it } from "vitest"
import { buildReaderControlPrompts, requireCompleteReaderOutput } from "../../memory-bench/reader-control.mjs"

const oracleCase = {
  question: "When did I move?",
  questionDate: "2026/01/01 (Thu) 12:00",
  answer: "gold-answer-must-not-leak",
  answerSessionIds: ["gold-session"],
  has_answer: true,
  sessions: [{ sessionId: "gold-session", date: "2025-12-01", observedAt: 1764547200000,
    turns: [{ role: "user", content: "I moved in September.", turnIndex: 0, hasAnswer: true },
      { role: "assistant", content: "I remember.", turnIndex: 1 }] }],
}

describe("LongMemEval privileged reader controls", () => {
  it("排除答案与金标字段，生成输入只含 oracle sessions/问题 [bench-reader-control-gold-isolation]", () => {
    for (const mode of ["direct", "con"] as const) {
      const built = buildReaderControlPrompts(oracleCase, mode)
      const serialized = JSON.stringify({ sessions: built.sessions, notes: built.notePrompts, final: built.finalPrompt() })
      expect(serialized).not.toContain("gold-answer-must-not-leak")
      expect(serialized).not.toContain("answerSessionIds")
      expect(serialized).not.toContain("has_answer")
    }
  })

  it("按会话顺序保留 session 日期、完整轮次角色与 turn index [bench-reader-control-role-time-preservation]", () => {
    const built = buildReaderControlPrompts({ ...oracleCase, sessions: [
      ...oracleCase.sessions,
      { sessionId: "later-session", date: "2025-12-20", observedAt: 1766188800000,
        turns: [{ role: "assistant", content: "Earlier advice.", turnIndex: 2 },
          { role: "user", content: "Follow-up.", turnIndex: 3 }] },
    ] }, "direct")
    expect(built.sessions.map(session => session.sessionId)).toEqual(["gold-session", "later-session"])
    expect(built.sessions.map(session => session.sessionDate)).toEqual(["2025-12-01", "2025-12-20"])
    expect(built.sessions[1]?.turns).toEqual([
      { turnIndex: 2, role: "assistant", content: "Earlier advice." },
      { turnIndex: 3, role: "user", content: "Follow-up." },
    ])
    expect(built.finalPrompt()).toContain("Earlier advice.")
  })

  it("拒绝 length 截断与空输出，只接受完整 stop 输出 [bench-reader-control-output-failure]", () => {
    expect(() => requireCompleteReaderOutput({ stopReason: "length", text: "partial" }, "answer"))
      .toThrow(/stopReason=length/)
    expect(() => requireCompleteReaderOutput({ stopReason: "stop", text: "  " }, "answer"))
      .toThrow(/空文本/)
    expect(requireCompleteReaderOutput({ stopReason: "stop", text: "  complete answer  " }, "answer"))
      .toBe("complete answer")
  })
})
