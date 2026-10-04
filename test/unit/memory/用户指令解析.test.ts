// ==========================================
// V1RTUAL 指令解析 —— 手写文件不能静默失效
// ==========================================
//
// 这个文件有两种真实来源：应用自己写的模板（带 `## 指令` 小节）与用户在外部
// 手写的整份正文（常常不留标题）。只认小节时，手写内容会变成空串——文件在、
// 读得到，指令却不进 prompt，且没有任何报错。这里把两种形态的产出都钉死。

import { describe, expect, it } from "vitest"

import { parseV1rtualInstructions } from "@/services/context/instructions"

describe("V1RTUAL 指令解析", () => {
  it("手写文件没有 `## 指令` 小节时整份正文都是指令", () => {
    expect(parseV1rtualInstructions("叫我小明"), "手写正文被当成空指令丢弃").toBe("叫我小明")
    expect(parseV1rtualInstructions("# 我的要求\n\n叫我小明\n用日语回复")).toBe("# 我的要求\n叫我小明\n用日语回复")
  })

  it("模板文件只取 `## 指令` 小节，标题、引用与更新时间都不进指令", () => {
    const generated = [
      "# V1RTUAL.md — 用户系统指令",
      "",
      "> 用户手写的系统级陪伴指令。",
      "",
      "---",
      "",
      "## 指令",
      "",
      "叫我小明",
      "",
      "_最后更新: 2026-10-03T00:00:00.000Z_",
      "",
    ].join("\n")
    expect(parseV1rtualInstructions(generated)).toBe("叫我小明")
  })

  it("小节之后的章节不算指令", () => {
    expect(parseV1rtualInstructions("## 指令\n\n叫我小明\n\n## 备注\n\n这段不该进 prompt\n")).toBe("叫我小明")
  })

  it("只有模板占位注释的种子文件产出空串，不把模板正文当指令", () => {
    const seed = "# V1RTUAL.md — 用户系统指令\n\n\
> 此文件中的指令会作为 System Prompt 的一部分注入。\n\
> 你可以在此写入对桌宠的行为要求。\n\n\
---\n\n\
## 指令\n\n\
<!-- 在此添加你的自定义指令，例如：叫我小明、用日语回复、喜欢简短回答等 -->\n    "
    expect(parseV1rtualInstructions(seed)).toBe("")
  })
})
