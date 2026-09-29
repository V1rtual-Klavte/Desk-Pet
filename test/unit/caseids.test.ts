// 基础设施自测：收集器自身。**不带 `[caseId]` 标记** —— 标记只给承担契约覆盖点的
// 测试用，守卫/收集器/渲染器的自测不构成覆盖，带标记会被跨层校验当成「孤儿 caseId」。
import { describe, it, expect } from "vitest"
import { extractCaseId, assertNoDuplicates } from "../host/caseids"

describe("caseId 提取", () => {
  it("从测试全名末尾的方括号标记里取 caseId", () => {
    expect(extractCaseId("变量池 > 未注册变量拒绝 [variable-pool-unregistered]"))
      .toBe("variable-pool-unregistered")
  })

  it("标记后只允许空白（vitest 全名可能带尾随换行）", () => {
    expect(extractCaseId("变量池 > 未注册变量拒绝 [variable-pool-unregistered] \n"))
      .toBe("variable-pool-unregistered")
  })

  it("没有标记时返回 undefined，不拿文件名或测试名去猜", () => {
    expect(extractCaseId("变量池 > 未注册变量拒绝")).toBe(undefined)
  })

  it("标记不在末尾（后面还有文字或标点）时返回 undefined", () => {
    expect(extractCaseId("[not-an-anchor] 后面还有文字")).toBe(undefined)
    expect(extractCaseId("场景 [some-id]。")).toBe(undefined)
  })

  it("名字里有多个方括号标记时只取末尾那个", () => {
    // 输入本身必须带两个标记，这条才测得到「取末尾」而不是「取第一个」。
    expect(extractCaseId("场景 [不是锚点] [real-case-id]")).toBe("real-case-id")
  })

  it("拒绝非小写 kebab-case 形态（大写/下划线/空格/中文/全角括号/空标记）", () => {
    expect(extractCaseId("场景 [Variable_Pool]")).toBe(undefined)
    expect(extractCaseId("场景 [foo bar]")).toBe(undefined)
    expect(extractCaseId("场景 [变量池]")).toBe(undefined)
    expect(extractCaseId("场景 【variable-pool】")).toBe(undefined)
    expect(extractCaseId("场景 []")).toBe(undefined)
  })

  it("接受数字开头的 id，与 dataset.ts 的 caseId 形状保持同一字母表", () => {
    expect(extractCaseId("场景 [1st-case]")).toBe("1st-case")
  })
})

describe("caseId 重复检测", () => {
  it("重复 caseId 报错，错误信息里列出重复的具体 id", () => {
    expect(() => assertNoDuplicates(["variable-pool-a", "variable-pool-b", "variable-pool-a"]))
      .toThrowError(/variable-pool-a/)
  })

  it("多个重复 id 全部列出，而不是只报第一个", () => {
    expect(() => assertNoDuplicates(["a", "b", "a", "b"])).toThrowError(/a, b/)
  })

  it("无重复时不报错", () => {
    expect(() => assertNoDuplicates(["a", "b", "c"])).not.toThrow()
  })
})
