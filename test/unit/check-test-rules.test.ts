/**
 * 守卫自身的测试：契约要求「守卫自身要有测试，而不是假定生效」。
 *
 * 这里的每个正样本都必须**真的会被判违规**，另有合格样本证明不误伤。
 * 样本里的违规形状只能写进字符串/模板字面量 —— 扫描器会抹掉字符串内容与注释（见
 * scripts/check-test-rules.mjs 的 maskSource），所以本文件不会因为这些样本变红。
 * 少数样本的模块名要经变量拼进来：规则 3 / 6 判的就是**源码文本里的字面量**，
 * 完整写出来会让扫描器把本文件自己写的样本当成真违规。
 */
import { describe, it, expect } from "vitest"
// 扫描器是 Node 侧的 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// 按运行期契约导入，形状由下面的 ScanHit / Rule 钉住。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与形状检查照常生效。
import { scanSource, RULES } from "../../scripts/check-test-rules.mjs"

/** 扫描器的运行期契约（与 scripts/check-test-rules.mjs 的导出一致）。 */
type ScanHit = { file: string; line: number; rule: number; note: string }
type Rule = { id: number; desc: string }

const scan: (relPath: string, source: string) => ScanHit[] = scanSource
const rules: Rule[] = RULES

describe("测试纪律扫描器", () => {
  it("抓到 L2 里手写 throw 充当断言（规则 4）", () => {
    const hits = scan("test/unit/x.test.ts", `
      it("case [some-case]", () => {
        if (x !== 1) throw new Error("不对")
      })`)
    expect(hits.map(hit => hit.rule)).toContain(4)
  })

  it("抓到读源码文本后断言（规则 3）", () => {
    // 路径经变量拼入：本文件里不能出现 readFileSync("…src/….ts") 的完整字面量
    const sourcePath = "src" + "/example.ts"
    const hits = scan("test/unit/x.test.ts", `const body = readFileSync("${sourcePath}", "utf8")`)
    expect(hits.map(hit => hit.rule)).toContain(3)
  })

  it("抓到以 ?raw 读入源码文本（规则 3 的另一条路径）", () => {
    // 变量拼入的理由同上：完整字面量会让本文件被判违规
    const rawQuery = "?" + "raw"
    const hits = scan("test/unit/x.test.ts", `import card from "@/services/personality/stages.ts${rawQuery}"`)
    expect(hits.map(hit => hit.rule)).toContain(3)
  })

  it("夹具用 ?raw 读入不算违规（规则 3 不误伤）", () => {
    const rawQuery = "?" + "raw"
    const hits = scan("test/unit/x.test.ts", `import fixture from "../../fixtures/card.md${rawQuery}"`)
    expect(hits).toEqual([])
  })

  it("抓到无断言的 it（规则 5）", () => {
    const hits = scan("test/unit/x.test.ts", `
      it("case [some-case]", () => { doSomething() })`)
    expect(hits.map(hit => hit.rule)).toContain(5)
  })

  it("正则的 .test( 不是测试块（规则 5 不误伤）", () => {
    const hits = scan("test/unit/x.test.ts", `
      function matches(text: string): boolean {
        return /[ \\t]/.test(text)
      }`)
    expect(hits).toEqual([])
  })

  it("模块级辅助函数里的 throw 不算「充当断言」（规则 4 只判测试体内）", () => {
    const hits = scan("test/unit/x.test.ts", `
      function decode(source: string): string {
        if (!source) throw new Error("未闭合")
        return source
      }
      it("解码 [some-case]", () => {
        expect(decode("x")).toBe("x")
      })`)
    expect(hits).toEqual([])
  })

  it("抓到 L2 import 带 IPC 的模块：裸模块名与相对路径两种写法（规则 6）", () => {
    const bareSpecifier = "@" + "/services/session"
    const relativeSpecifier = "../../src/services" + "/session"
    expect(scan("test/unit/x.test.ts", `import { collect } from "${bareSpecifier}"`).map(hit => hit.rule)).toContain(6)
    expect(scan("test/unit/x.test.ts", `import { collect } from "${relativeSpecifier}"`).map(hit => hit.rule)).toContain(6)
  })

  it("L2 import 同域的纯子模块不算违规（规则 6 不误伤）", () => {
    const pureSpecifier = "@/services/tool" + "/registry"
    expect(scan("test/unit/x.test.ts", `import { register } from "${pureSpecifier}"`)).toEqual([])
  })

  it("import type 不算 import 带 IPC 的模块，行内 type 修饰符算（规则 6）", () => {
    const ipcSpecifier = "@" + "/services/session"
    expect(scan("test/unit/x.test.ts", `import type { PiSessionRepo } from "${ipcSpecifier}"`)).toEqual([])
    expect(
      scan("test/unit/x.test.ts", `import { type PiSessionRepo } from "${ipcSpecifier}"`).map(hit => hit.rule),
    ).toContain(6)
  })

  it("抓到 L3 使用真实 Provider（规则 7）", () => {
    const hits = scan("test/integration/x.test.ts", `
      it("回合 [some-case]", async () => {
        const model = getPiModel()
        expect(model).toBeTruthy()
      })`)
    expect(hits.map(hit => hit.rule)).toContain(7)
  })

  it("规则按层生效：6 只判 unit，7 只判 integration，互不串场", () => {
    const providerCall = "const model = " + "getPiModel()"
    const ipcImport = "import { collect } from " + JSON.stringify("@" + "/services/session")
    expect(scan("test/unit/x.test.ts", providerCall)).toEqual([])
    expect(scan("test/integration/x.test.ts", ipcImport)).toEqual([])
  })

  it("合格的测试零命中", () => {
    const hits = scan("test/unit/x.test.ts", `
      it("拒绝未注册变量 [variable-pool-unregistered]", () => {
        expect(batchWriteVars([{ name: "幽灵" }]).rejected).toEqual(["幽灵"])
      })`)
    expect(hits).toEqual([])
  })

  it("注释里的违规形状不算命中（判的是会被执行的代码，不是注释）", () => {
    const hits = scan("test/unit/x.test.ts", `
      it("注释样本 [some-case]", () => {
        // 不要写 throw new Error 当断言
        expect(add(1, 2)).toBe(3)
      })`)
    expect(hits).toEqual([])
  })

  it("规则表只收机制可判的 3/4/5/6/7（1/2 靠 review，8/9/10 由机制保证）", () => {
    expect(rules.map(rule => rule.id)).toEqual([3, 4, 5, 6, 7])
    for (const rule of rules) {
      expect(typeof rule.id).toBe("number")
      expect(rule.desc.length).toBeGreaterThan(0)
    }
  })

  it("命中带文件、行号与说明，能直接指到出问题的那一行", () => {
    const hits = scan("test/unit/x.test.ts", `
      it("case [some-case]", () => {
        expect(1).toBe(1)
        if (x !== 1) throw new Error("不对")
      })`)
    expect(hits).toEqual([
      {
        file: "test/unit/x.test.ts",
        line: 4,
        rule: 4,
        note: expect.stringContaining("throw new Error"),
      },
    ])
  })
})
