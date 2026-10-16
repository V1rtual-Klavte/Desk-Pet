import { describe, expect, it } from "vitest"

import { formatLocomoAnswerCard, formatLocomoQuestion, renderLocomoDialogueEntry } from "../../memory-bench/datasets/locomo/fixture.mjs"

describe("LoCoMo dialogue fixture", () => {
  it("adds the same history context to every unchanged question [bench-locomo-question-context]", () => {
    expect(formatLocomoQuestion("Which book did Nora recommend?"))
      .toBe("Answer using our conversation history:\nWhich book did Nora recommend?")
    expect(formatLocomoQuestion("Would Eli enjoy classical music?"))
      .toBe("Answer using our conversation history:\nWould Eli enjoy classical music?")
  })
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
    expect(formatted).toContain("Include every requested item, date, number and necessary qualification")
    expect(formatted).toContain("separate multiple items with commas")
    expect(formatted).toContain("Express counts with digits")
    expect(formatted).toContain("Preserve negation, uncertainty and likelihood")
    expect(formatted).toContain("the hypothetical event need not have occurred")
    expect(formatted).toContain("hearing about or reacting to someone else's event does not establish that premise")
    expect(formatted).toContain("Keep original rules.\n# 变量定义\noriginal variables")
    expect(formatLocomoAnswerCard(formatted)).toBe(formatted)
    expect(formatLocomoAnswerCard("# 角色设定\nBe helpful.")).toContain("# 输出规则\nFor this evaluation,")
  })
})
