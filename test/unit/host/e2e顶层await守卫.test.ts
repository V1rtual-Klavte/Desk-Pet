/**
 * 守卫自身的测试：E2E bundle 的「无顶层 await」守卫（test/host/native/build.mjs）。
 *
 * 被测判据：模块顶层（含 if / try 等嵌套块、变量声明的 await 初始化、for await）的
 * await 必须被识别；函数体内的 await 不得误报；守卫接线（generateBundle 对 chunk
 * 调用 this.parse，命中即 this.error）必须生效。把实现改坏（walk 进入函数边界、
 * 不递归嵌套块、漏 for await、generateBundle 不 parse 或不调 error）时这些断言
 * 必须变红。这道守卫是 2026-10-05「222 个场景全部 setup failed: Cannot access
 * 'piTools' before initialization」的回归防线：单文件内联动态导入的 bundle 里，
 * 顶层 await 会让启动链的 microtask 在 piTools 等命名空间初始化前访问它们。
 */
import { describe, expect, it, vi } from "vitest"
// 守卫是 Node 侧的 ESM 构建工具（test/host/native/build.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与形状检查照常生效。
import { containsTopLevelAwait, noTopLevelAwaitGuard } from "../../host/native/build.mjs"

/** 手工 ESTree 片段：只保留守卫 walk 会触达的字段（type 判别 + 递归子节点）。 */
const awaitExpression = { type: "AwaitExpression", argument: { type: "CallExpression" } }
const plainCall = { type: "CallExpression" }

describe("containsTopLevelAwait 判定", () => {
  it("顶层 await 表达式与变量声明中的 await 都命中", () => {
    expect(containsTopLevelAwait({ type: "ExpressionStatement", expression: awaitExpression })).toBe(true)
    expect(
      containsTopLevelAwait({
        type: "VariableDeclaration",
        declarations: [{ type: "VariableDeclarator", id: { type: "Identifier" }, init: awaitExpression }],
      }),
    ).toBe(true)
  })

  it("if / try 等嵌套块里的顶层 await 命中（walk 不浅扫描）", () => {
    expect(
      containsTopLevelAwait({
        type: "IfStatement",
        test: plainCall,
        consequent: { type: "BlockStatement", body: [{ type: "ExpressionStatement", expression: awaitExpression }] },
        alternate: null,
      }),
    ).toBe(true)
  })

  it("for await 命中", () => {
    expect(
      containsTopLevelAwait({
        type: "ForOfStatement",
        await: true,
        left: { type: "VariableDeclaration", declarations: [] },
        right: plainCall,
        body: { type: "BlockStatement", body: [] },
      }),
    ).toBe(true)
  })

  it("函数体内的 await 不误报（声明 / 表达式 / 箭头函数）", () => {
    expect(
      containsTopLevelAwait({
        type: "FunctionDeclaration",
        id: { type: "Identifier" },
        params: [],
        body: { type: "BlockStatement", body: [{ type: "ExpressionStatement", expression: awaitExpression }] },
      }),
    ).toBe(false)
    expect(
      containsTopLevelAwait({
        type: "ExpressionStatement",
        expression: {
          type: "ArrowFunctionExpression",
          params: [],
          body: awaitExpression,
        },
      }),
    ).toBe(false)
  })

  it("普通代码（无 await）不命中", () => {
    expect(
      containsTopLevelAwait({
        type: "VariableDeclaration",
        declarations: [{ type: "VariableDeclarator", id: { type: "Identifier" }, init: plainCall }],
      }),
    ).toBe(false)
  })
})

describe("noTopLevelAwaitGuard 接线", () => {
  const chunk = { type: "chunk", code: "/* 产物文本；parse 由 fake context 提供 */" }

  it("chunk 顶层命中 await 时调用 this.error（构建失败）", () => {
    const guard = noTopLevelAwaitGuard()
    const error = vi.fn()
    const context = {
      parse: vi.fn(() => ({ type: "Program", body: [{ type: "ExpressionStatement", expression: awaitExpression }] })),
      error,
    }
    guard.generateBundle.call(context, {}, { "main.mjs": chunk })
    expect(context.parse).toHaveBeenCalledWith(chunk.code)
    expect(error).toHaveBeenCalledOnce()
    // 错误消息要指向修复方向（顶层 await 禁令的成因与出路），不只是「出错了」。
    const message = String(error.mock.calls[0]?.[0] ?? "")
    expect(message).toContain("main.mjs 顶层出现 await")
    expect(message).toContain("TDZ")
  })

  it("chunk 无顶层 await（await 全在函数内）时不报错", () => {
    const guard = noTopLevelAwaitGuard()
    const error = vi.fn()
    const context = {
      parse: () => ({
        type: "Program",
        body: [
          {
            type: "FunctionDeclaration",
            id: { type: "Identifier" },
            params: [],
            body: { type: "BlockStatement", body: [{ type: "ExpressionStatement", expression: awaitExpression }] },
          },
        ],
      }),
      error,
    }
    guard.generateBundle.call(context, {}, { "main.mjs": chunk })
    expect(error).not.toHaveBeenCalled()
  })

  it("非 chunk 产物（asset）不解析", () => {
    const guard = noTopLevelAwaitGuard()
    const parse = vi.fn()
    guard.generateBundle.call({ parse, error: vi.fn() }, {}, { "style.css": { type: "asset" } })
    expect(parse).not.toHaveBeenCalled()
  })
})
