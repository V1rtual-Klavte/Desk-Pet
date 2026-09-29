// L4 窗口进度视图的**模型侧**测试。
//
// 分界：这里只测纯函数（计数、状态迁移、详情与文案整形）。DOM 写入、失败行默认
// 展开、汇总条配色这些只属于视图，由 L4 人工验证判据覆盖（契约「观测面」目标 1），
// 不做 DOM 模拟 —— 模拟出来的 DOM 不证明真窗口里看得见。
//
// 不带 `[caseId]` 标记：标记只给承担契约覆盖点的测试用（与 report-html.test.ts 同约定）。

import { describe, it, expect } from "vitest"
import {
  createProgressModel,
  formatDuration,
  formatSceneFailure,
  formatTraceEvents,
  renderSummary,
  statusIcon,
  STATUS_LABELS,
  type CaseStatus,
} from "../e2e/progress"

describe("进度模型：计数", () => {
  it("统计随事件推进，失败不减通过数", () => {
    const m = createProgressModel(3)
    m.start("a", "场景 A")
    m.pass("a", 120)
    m.start("b", "场景 B")
    m.fail("b", 80, "断言失败：期望 2 得到 1")
    expect(m.summary()).toMatchObject({ total: 3, passed: 1, failed: 1, remaining: 1 })
  })

  it("预期失败单独计数，不计入失败", () => {
    const m = createProgressModel(1)
    m.start("a", "场景 A")
    m.expectedFailure("a", 50)
    expect(m.summary()).toMatchObject({ failed: 0, expectedFailures: 1 })
  })

  it("已跑只数执行过的行，跳过的行从剩余里扣除", () => {
    const m = createProgressModel(4)
    m.plan("a", "a", "A")
    m.plan("b", "b", "B")
    m.plan("c", "c", "C")
    m.plan("d", "d", "D")
    m.start("a", "A")
    m.pass("a", 10)
    m.skip("b", "前序 trial 超时，未执行")
    const summary = m.summary()
    expect(summary.done).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.remaining).toBe(2)
  })

  it("同一 key 重复结算不重复计数，最后一次状态为准", () => {
    const m = createProgressModel(1)
    m.start("a", "场景 A")
    m.pass("a", 10)
    m.fail("a", 20, "第二份结果")
    expect(m.summary()).toMatchObject({ passed: 0, failed: 1, done: 1 })
  })

  it("事件引用的 key 未预登记时补一行，行序按首次出现", () => {
    const m = createProgressModel(2)
    m.pass("late", 5)
    m.plan("planned", "planned", "先跑的")
    expect(m.rows().map(row => row.key)).toEqual(["late", "planned"])
    expect(m.rows()[0]).toMatchObject({ caseId: "late", status: "pass", durationMs: 5 })
  })

  it("行键可以带 trial，同一 caseId 的多行互不覆盖", () => {
    const m = createProgressModel(2)
    m.plan("case#1", "case", "第一次")
    m.plan("case#2", "case", "第二次")
    m.start("case#1", "第一次")
    m.pass("case#1", 10)
    m.start("case#2", "第二次")
    m.fail("case#2", 20, "第二次失败")
    expect(m.summary()).toMatchObject({ passed: 1, failed: 1, total: 2 })
  })
})

describe("进度模型：耗时与详情", () => {
  it("耗时来自注入时钟，finish 后冻结", () => {
    let clock = 1_000
    const m = createProgressModel(1, () => clock)
    clock = 1_400
    expect(m.summary().durationMs).toBe(400)
    m.finish()
    clock = 9_000
    expect(m.summary().durationMs).toBe(400)
  })

  it("失败详情归一化：字符串、字符串数组、{lines} 都收成行", () => {
    const m = createProgressModel(3)
    m.fail("a", 1, "单行")
    m.fail("b", 2, ["第一行", "第二行"])
    m.fail("c", 3, { lines: ["结构体行"] })
    const lines = (key: string): string[] | undefined =>
      m.rows().find(row => row.key === key)?.detail?.lines
    expect(lines("a")).toEqual(["单行"])
    expect(lines("b")).toEqual(["第一行", "第二行"])
    expect(lines("c")).toEqual(["结构体行"])
  })

  it("空详情不建 detail，通过行没有 detail", () => {
    const m = createProgressModel(2)
    m.fail("a", 1, [])
    m.pass("b", 1)
    expect(m.rows()[0].detail).toBeUndefined()
    expect(m.rows()[1].detail).toBeUndefined()
  })
})

describe("失败详情整形", () => {
  const failingScene = {
    error: "场景超过 120000ms（第 2 轮执行中）",
    errorKind: "timeout",
    turns: [
      {
        index: 1,
        description: "首轮对话",
        errorKind: "assertion" as string | undefined,
        assertions: [
          { type: "reply-nonempty", pass: true },
          { type: "pool-value", pass: false, error: "变量池取值不符", expected: "mood=happy", actual: "mood=neutral" },
        ],
      },
    ],
  }

  it("断言差异带期望与实际，场景错误另起一行", () => {
    const lines = formatSceneFailure(failingScene)
    expect(lines.some(line => line.includes("pool-value") && line.includes("mood=happy") && line.includes("mood=neutral"))).toBe(true)
    expect(lines.some(line => line.includes("场景错误（timeout）"))).toBe(true)
  })

  it("没有失败断言时给出中性说明，不产出空数组", () => {
    const lines = formatSceneFailure({ turns: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("没有可展示的断言差异")
  })

  it("回合级错误在断言全过时也出现", () => {
    const lines = formatSceneFailure({
      turns: [{ index: 2, description: "工具轮", errorKind: "provider", assertions: [{ type: "reply-nonempty", pass: true }] }],
    })
    expect(lines.some(line => line.includes("回合错误：provider"))).toBe(true)
  })

  it("超长失败列表截断并说明还有多少行", () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({
      index: index + 1,
      description: `第 ${index + 1} 轮`,
      assertions: [{ type: "check", pass: false, error: `失败 ${index + 1}` }],
    }))
    const lines = formatSceneFailure({ turns })
    expect(lines).toHaveLength(21)
    expect(lines[lines.length - 1]).toContain("还有 10 行")
  })
})

describe("运行期事件序列整形", () => {
  const events = [
    { kind: "turn_start", createdAt: Date.parse("2026-09-29T10:00:00.000Z"), payload: { turn: 1 } },
    { kind: "tool_execution_start", createdAt: Date.parse("2026-09-29T10:00:01.250Z"), payload: { toolName: "read_file" } },
  ]

  it("逐条一行，带 kind，保留 payload", () => {
    const lines = formatTraceEvents(events)
    expect(lines[0]).toContain("事件序列：2 条")
    expect(lines[1]).toContain("turn_start")
    expect(lines[2]).toContain("tool_execution_start")
    expect(lines[2]).toContain("read_file")
  })

  it("截断的窗口在头部写明本场景总数", () => {
    const lines = formatTraceEvents(events, 137)
    expect(lines[0]).toContain("最近 2 条")
    expect(lines[0]).toContain("共 137 条")
  })

  it("没有事件时给出单一说明行", () => {
    const lines = formatTraceEvents([])
    expect(lines).toEqual(["事件序列：本场景没有运行期事件"])
  })

  it("超长 payload 截断，不整段刷屏", () => {
    const lines = formatTraceEvents([{ kind: "provider_payload", createdAt: 0, payload: { text: "x".repeat(1000) } }])
    expect(lines[1].length).toBeLessThan(300)
    expect(lines[1]).toContain("…")
  })

  it("循环引用的 payload 降级成显式标记，不抛异常", () => {
    const payload: Record<string, unknown> = {}
    payload.self = payload
    const lines = formatTraceEvents([{ kind: "provider_payload", createdAt: 0, payload }])
    expect(lines[1]).toContain("[payload 无法序列化]")
  })
})

describe("汇总条与状态文案", () => {
  it("汇总条含要求的六项，跳过只在真有时出现", () => {
    let clock = 0
    const m = createProgressModel(2, () => clock)
    m.start("a", "A")
    m.pass("a", 1500)
    clock = 1500
    const withoutSkip = renderSummary(m.summary())
    expect(withoutSkip).toContain("已跑 1/2")
    expect(withoutSkip).toContain("通过 1")
    expect(withoutSkip).toContain("失败 0")
    expect(withoutSkip).toContain("预期失败 0")
    expect(withoutSkip).toContain("剩余 1")
    expect(withoutSkip).toContain("耗时 1.5s")
    expect(withoutSkip).not.toContain("跳过")

    m.skip("b", "前序 trial 超时，未执行")
    expect(renderSummary(m.summary())).toContain("跳过 1")
  })

  it("耗时按量级换单位", () => {
    expect(formatDuration(940)).toBe("940ms")
    expect(formatDuration(12_500)).toBe("12.5s")
    expect(formatDuration(65_000)).toBe("1m5s")
  })

  it("每个状态有图标与中文标签，且图标互不相同", () => {
    const statuses: CaseStatus[] = ["pending", "running", "pass", "fail", "expected-failure", "skip"]
    const icons = statuses.map(statusIcon)
    expect(new Set(icons).size).toBe(statuses.length)
    for (const status of statuses) expect(STATUS_LABELS[status]).toBeTruthy()
  })
})
