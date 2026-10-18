import { describe, expect, it } from "vitest"
import { answerIncludesEnumerationItem, enumerationAnswerSuffix, missingEnumerationItems } from "@/services/agent/memory"

describe("列项答案确定性补全", () => {
  it("只补主答遗漏的项目，保留已有项目 [memory-answer-enumeration-append]", () => {
    const answer = "John made coconut milk ice cream."
    const items = ["coconut milk ice cream", "dairy-free chocolate mousse", "chocolate and mixed-berry icecream"]

    expect(missingEnumerationItems(answer, items)).toEqual([
      "dairy-free chocolate mousse",
      "chocolate and mixed-berry icecream",
    ])
    expect(enumerationAnswerSuffix(missingEnumerationItems(answer, items), "What desserts has John made?"))
      .toBe("\n\nAlso: dairy-free chocolate mousse, chocolate and mixed-berry icecream.")
  })

  it("大小写、标点与 icecream/ice cream 变体不重复补 [memory-answer-enumeration-no-duplicate]", () => {
    const answer = "She enjoys HIKING, ice cream, and mixed-berry icecream."
    expect(missingEnumerationItems(answer, ["hiking", "ice cream", "mixed-berry icecream", "icecream"])).toEqual([])
    expect(answerIncludesEnumerationItem("Hiking!", "hiking")).toBe(true)
    expect(answerIncludesEnumerationItem("She likes ice cream.", "icecream")).toBe(true)
  })

  it("短词只按词边界匹配，不把 cheesecake 当成 cake [memory-answer-enumeration-short-word]", () => {
    expect(missingEnumerationItems("She baked a cheesecake.", ["cake"])).toEqual(["cake"])
    expect(missingEnumerationItems("She baked a cake.", ["cake"])).toEqual([])
    expect(missingEnumerationItems("I bought a notebook.", ["book"])).toEqual(["book"])
  })

  it("中文项目按去标点短语匹配，并使用中文补全后缀 [memory-answer-enumeration-cjk]", () => {
    const missing = missingEnumerationItems("约翰喜欢远足和冲浪。", ["远足", "冲浪", "露营"])
    expect(missing).toEqual(["露营"])
    expect(enumerationAnswerSuffix(missing, "约翰喜欢哪些户外活动？")).toBe("\n\n补充：露营。")
  })

  it("重复项目按来源顺序去重，空输入不产生补全 [memory-answer-enumeration-dedupe]", () => {
    expect(missingEnumerationItems("", ["cake", "Cake", "cake"])).toEqual(["cake"])
    expect(missingEnumerationItems("任意回答", [])).toEqual([])
    expect(enumerationAnswerSuffix([], "任意问题")).toBe("")
  })
})
