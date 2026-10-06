// ==========================================
// 工具循环病理检测（tool-loop-guard）—— 连续失败 / 同参重复的软硬阈值与重置点
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 1；阈值来源 §1.1 的 Cline 默认值）：
// ① 连续失败：3 次软、5 次硬；一次成功打断连击；
// ② 同工具 + 同参数（键排序 JSON 签名）：连续 3 次软、5 次硬；出现不同签名即重置；
// ③ 阈值处不终止：第 3 次只到软（提示），第 4 次仍软，第 5 次才硬；
// ④ 每回合重置：重置点就是「新建实例」，新实例从零开始。
//
// 归属 L2（不是 L3）的理由：`tool-loop-guard` 是零依赖纯逻辑叶子（不触 IPC、不落盘），
// 按 test/README「该写在哪一层」的判定顺序直接落 L2，import 叶子路径（不在 L2 禁入清单）。
//
// 期望值口径：阈值 3/5 与原因计数按契约**手写**（不 import 实现常量）；判据整对象比对
// （`toEqual` 连 reason 的 kind/count 一起钉住）—— 把实现里的阈值改坏（3→2、5→4）、
// 把重置点删掉、或把签名比较退化成只比工具名，对应断言必须变红。

import { describe, expect, it } from "vitest"

import { ToolLoopGuard, toolCallSignature } from "@/services/engine/harness/tool-loop-guard"

const TOOL = "probe_tool"

describe("工具循环病理检测", () => {
  it("连续失败：前两次不动、第 3 次软、第 5 次硬；一次成功打断连击 [tool-loop-guard-failures]", () => {
    const guard = new ToolLoopGuard()
    expect(guard.noteResult(true), "第 1 次失败不应触发判据").toEqual({ level: "none" })
    expect(guard.noteResult(true), "第 2 次失败不应触发判据").toEqual({ level: "none" })

    expect(guard.noteResult(true), "第 3 次连续失败应到软提示")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 3 } })
    expect(guard.noteResult(true), "第 4 次仍应停在软档，不提前终止")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 4 } })
    expect(guard.noteResult(true), "第 5 次连续失败应到硬终止")
      .toEqual({ level: "hard", reason: { kind: "consecutive_failures", count: 5 } })

    // 一次成功打断连击：计数归零，重新累计到 3 才再软。
    expect(guard.noteResult(false), "成功之后不应仍带失败判据").toEqual({ level: "none" })
    expect(guard.noteResult(true)).toEqual({ level: "none" })
    expect(guard.noteResult(true)).toEqual({ level: "none" })
    expect(guard.noteResult(true), "打断后的第 3 次失败应重新到软档")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 3 } })
  })

  it("同参重复：键序不同算同一签名、第 3 次软、第 5 次硬；参数不同即重置 [tool-loop-guard-repeats]", () => {
    expect(toolCallSignature(TOOL, { a: 1, b: [2, { c: 3 }] }), "键排序签名对键序不稳定")
      .toBe(toolCallSignature(TOOL, { b: [2, { c: 3 }], a: 1 }))
    expect(toolCallSignature(TOOL, { a: 1 }), "不同工具名不应得到同一签名")
      .not.toBe(toolCallSignature("other_tool", { a: 1 }))

    const guard = new ToolLoopGuard()
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }), "第 1 次调用不应触发判据").toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { b: 2, a: 1 }), "键序不同的同参调用不应重置或提前触发").toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }), "同参连续第 3 次应到软提示")
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 3 } })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }), "第 4 次仍应停在软档")
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 4 } })

    // 参数不同 ⇒ 不同签名：连击重置，同工具不同参数连打三次也不触发。
    expect(guard.noteCall(TOOL, { a: 9, b: 2 }), "不同参数应重置同参连击").toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { a: 8, b: 2 })).toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { a: 7, b: 2 })).toEqual({ level: "none" })

    // 回到同一签名重新连续累计：第 5 次到硬终止。
    expect(guard.noteCall(TOOL, { a: 1, b: 2 })).toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 })).toEqual({ level: "none" })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }))
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 3 } })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }))
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 4 } })
    expect(guard.noteCall(TOOL, { a: 1, b: 2 }), "同参连续第 5 次应到硬终止")
      .toEqual({ level: "hard", reason: { kind: "repeated_call", count: 5 } })
  })

  it("失败连击的硬判据在下一次调用门可见；结果侧只报失败连击；同级取失败连击 [tool-loop-guard-mixed]", () => {
    const guard = new ToolLoopGuard()
    // 失败连击到硬（第 5 次），随后模型换了工具/参数：新的调用门仍应拿到硬判据（工具坏掉优先收手）。
    for (let at = 0; at < 5; at += 1) guard.noteResult(true)
    expect(guard.noteCall("another_tool", { fresh: true }), "失败连击已硬，换工具的调用门仍应硬")
      .toEqual({ level: "hard", reason: { kind: "consecutive_failures", count: 5 } })

    // 结果侧只报失败连击（同参连击的账在调用门记，不在结果侧合并）。构造**同参连击更强**的
    // 时刻（同参 5 次已硬 / 失败 3 次只到软）：noteResult 若改成返回 strongest()，
    // 下面第 1、2 条会报同参硬档、第 3 条也变硬 —— 三条断言同时钉住「结果侧不合并」。
    const resultSide = new ToolLoopGuard()
    for (let at = 0; at < 5; at += 1) {
      expect(resultSide.noteCall(TOOL, { same: 1 }).level, "前置：同参连击第 5 次应已到硬")
        .toBe(at === 4 ? "hard" : at >= 2 ? "soft" : "none")
    }
    expect(resultSide.noteResult(true), "结果侧第 1 次失败不应带入同参连击的硬判据")
      .toEqual({ level: "none" })
    expect(resultSide.noteResult(true), "结果侧第 2 次失败不应带入同参连击的硬判据")
      .toEqual({ level: "none" })
    expect(resultSide.noteResult(true), "结果侧第 3 次失败应只报失败连击的软档（不是同参硬档）")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 3 } })

    // 调用门上两条连击同为软（重复 4 次 / 失败 3 次）：同级取失败连击（既定优先序）。
    const tieBreak = new ToolLoopGuard()
    tieBreak.noteCall(TOOL, { same: 1 })
    tieBreak.noteCall(TOOL, { same: 1 })
    expect(tieBreak.noteCall(TOOL, { same: 1 }), "前置：同参连击已到软")
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 3 } })
    tieBreak.noteResult(true)
    tieBreak.noteResult(true)
    expect(tieBreak.noteResult(true), "前置：失败连击已到软")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 3 } })
    expect(tieBreak.noteCall(TOOL, { same: 1 }), "两条连击同为软时调用门应取失败连击")
      .toEqual({ level: "soft", reason: { kind: "consecutive_failures", count: 3 } })
  })

  it("每回合重置：新实例从零开始（同参连击与失败连击都不跨回合残留）[tool-loop-guard-reset]", () => {
    const first = new ToolLoopGuard()
    first.noteCall(TOOL, { same: 1 })
    first.noteCall(TOOL, { same: 1 })
    expect(first.noteCall(TOOL, { same: 1 }), "第 3 次同参调用应到软")
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 3 } })
    for (let at = 0; at < 5; at += 1) first.noteResult(true)

    // 下一回合是全新实例：同样的调用序列从零累计，不继承上一回合的连击。
    const second = new ToolLoopGuard()
    expect(second.noteCall(TOOL, { same: 1 }), "新回合不应继承同参连击").toEqual({ level: "none" })
    expect(second.noteCall(TOOL, { same: 1 })).toEqual({ level: "none" })
    expect(second.noteCall(TOOL, { same: 1 }), "新回合里的第 3 次同参调用应重新到软")
      .toEqual({ level: "soft", reason: { kind: "repeated_call", count: 3 } })
    expect(second.noteResult(true), "新回合不应继承失败连击").toEqual({ level: "none" })
  })
})
