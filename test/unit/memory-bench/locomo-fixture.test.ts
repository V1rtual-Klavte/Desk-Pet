import { describe, expect, it } from "vitest"

import { formatLocomoAnswerCard, renderLocomoDialogueEntry } from "../../memory-bench/datasets/locomo/fixture.mjs"

describe("LoCoMo dialogue fixture", () => {
  it("keeps speaker and session date outside unchanged dialogue, with caption as separate marked text [bench-locomo-dialogue-fixture]", () => {
    const original = "I saw the sign: speaker: someone else"
    expect(renderLocomoDialogueEntry({ speaker: "Carla", dateText: "1:56 pm on 8 May, 2023",
      text: original, blipCaption: "two people by a car" })).toBe(
      `speaker: Carla\nsession_date: 1:56 pm on 8 May, 2023\n${original}\n[shared image caption] two people by a car`,
    )
  })

  it("adds one uniform answer policy while preserving the Card and complete-answer obligation [bench-locomo-answer-format]", () => {
    const raw = "---\nid: test-card\n---\n# 角色设定\nBe helpful.\n# 输出规则\nKeep original rules.\n# 变量定义\noriginal variables"
    const formatted = formatLocomoAnswerCard(raw)
    expect(formatted).toContain("# 角色设定\nBe helpful.")
    expect(formatted).toContain("# 输出规则\n\nFor this evaluation,")
    expect(formatted).toContain("reply exactly: No information available")
    expect(formatted).toContain("do not omit required information merely to be brief")
    expect(formatted).toContain("Keep original rules.\n# 变量定义\noriginal variables")
    expect(formatLocomoAnswerCard(formatted)).toBe(formatted)
    expect(formatLocomoAnswerCard("# 角色设定\nBe helpful.")).toContain("# 输出规则\nFor this evaluation,")
  })
})
