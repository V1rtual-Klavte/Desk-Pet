// HTML 报告渲染器的基础设施自测。
//
// 不带 `[caseId]` 标记：标记只给承担契约覆盖点的测试用，基础设施自测带了会被 W4 的
// 跨层校验当成孤儿 caseId 判红（见 Task 10 的标记使用规则）。
//
// 断言的对象是渲染器的**产物文本**，不读源码：自包含、标识、默认展开这三条都是
// 产物可判的性质，改实现也应该继续成立。

import { describe, it, expect } from "vitest"
import { renderHtmlReport } from "../e2e/report-html"
import type { SceneResult, TestReport, TurnResult } from "../e2e/types"

function makeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    index: 1,
    description: "首轮对话",
    userText: "你好",
    assertions: [{ type: "reply-nonempty", pass: true }],
    duration: 1200,
    metrics: { duration: 1200, replyChars: 12, toolCalls: 0, retries: 0 },
    ...overrides,
  }
}

function makeScene(overrides: Partial<SceneResult> = {}): SceneResult {
  return {
    caseId: "demo-case",
    scene: "演示场景",
    module: "demo",
    contractId: "demo-point",
    suite: "regression",
    trial: 1,
    entry: "unit",
    status: "pass",
    turns: [makeTurn()],
    duration: 1300,
    ...overrides,
  }
}

function makeReport(overrides: Partial<TestReport> = {}): TestReport {
  return {
    schemaVersion: "desk-pet-live/v2",
    datasetVersion: "dataset-2026-09-29",
    runId: "run-1234",
    timestamp: "2026-09-29T00:00:00.000Z",
    options: { repeat: 1, strictContracts: false, report: "html" },
    environment: { userAgent: "node-test", platform: "darwin", commit: "abc1234" },
    datasetErrors: [],
    contracts: [],
    scenes: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      timeout: 0,
      totalDuration: 0,
      totalCases: 0,
      executedCases: 0,
      totalTrials: 0,
      plannedTrials: 0,
      executedTrials: 0,
      passRate: 0,
      passAtK: 0,
      passPowerK: 0,
    },
    ...overrides,
  }
}

/** 取顶部标识块里某个标识的值（`data-ident` 是标识的锚点，键名与归档文档引用的一致）。 */
function identValue(html: string, key: string): string | null {
  const match = new RegExp(`data-ident="${key}"[^>]*>([^<]*)</`).exec(html)
  return match ? match[1] : null
}

describe("HTML 报告：自包含", () => {
  it("产物里没有任何外部资源引用", () => {
    const html = renderHtmlReport(makeReport())

    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
    expect(html).not.toMatch(/https?:\/\//)
    // 空断言的反面：内联的 <style> 与 <script> 真的在，而不是「因为没有样式和脚本才没有外链」。
    expect(html).toContain("<style>")
    expect(html).toMatch(/<script>[\s\S]+<\/script>/)
  })

  it("数据里带 URL 时产物依然没有 http 字面量，且 URL 正文不丢", () => {
    const html = renderHtmlReport(makeReport({
      scenes: [makeScene({
        status: "fail",
        errorKind: "network",
        error: "请求 https://provider.example.com/v1/chat 超时",
      })],
    }))

    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('src="http')
    expect(html).not.toContain('href="http')
    // 证据本身要留在页面上（只是 `://` 写成字符实体，浏览器渲染结果不变）。
    expect(html).toContain("provider.example.com")
  })

  it("场景数据里的 HTML 被转义，不会变成可执行的标记", () => {
    const html = renderHtmlReport(makeReport({
      scenes: [makeScene({ scene: '<script>alert("x")</script>' })],
    }))

    expect(html).not.toContain('<script>alert("x")</script>')
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
  })
})

describe("HTML 报告：顶部可核对标识", () => {
  it("runId / commit / dataset / cases / trials 都在页面上且带得出值", () => {
    const report = makeReport({
      scenes: [
        makeScene({ caseId: "a", status: "pass" }),
        makeScene({ caseId: "b", status: "fail", trial: 2 }),
      ],
    })
    report.summary = { ...report.summary, totalCases: 2, executedCases: 2, totalTrials: 2, plannedTrials: 3, executedTrials: 2, skipped: 0 }
    const html = renderHtmlReport(report)

    expect(identValue(html, "runId")).toBe("run-1234")
    expect(identValue(html, "commit")).toBe("abc1234")
    expect(identValue(html, "dataset")).toBe("dataset-2026-09-29")
    expect(identValue(html, "cases")).toBe("2")
    expect(identValue(html, "trials")).toBe("2")
    // 计划/执行/跳过是同一行的补充说明，不能省 —— 否则「trials 6」看不出有几条没跑。
    expect(html).toContain("计划 3 · 执行 2 · 跳过 0")
  })

  it("commit 缺失时写「未记录」，不写 undefined", () => {
    const report = makeReport()
    report.environment = { userAgent: "node-test", platform: "darwin" }
    const html = renderHtmlReport(report)

    expect(identValue(html, "commit")).toBe("未记录")
    expect(html).not.toContain("undefined")
  })
})

describe("HTML 报告：默认展开", () => {
  it("失败/超时/跳过默认展开，通过默认收起", () => {
    const html = renderHtmlReport(makeReport({
      scenes: [
        makeScene({ caseId: "ok", status: "pass" }),
        makeScene({ caseId: "bad", status: "fail" }),
        makeScene({ caseId: "slow", status: "timeout" }),
        makeScene({ caseId: "skipped", status: "skip" }),
      ],
    }))

    expect(html).toMatch(/<details class="case" data-status="fail" open>/)
    expect(html).toMatch(/<details class="case" data-status="timeout" open>/)
    expect(html).toMatch(/<details class="case" data-status="skip" open>/)
    // 通过项必须是收起的那一种：`data-status="pass">` 后面直接跟 `>`，不带 open。
    expect(html).toMatch(/<details class="case" data-status="pass">/)
  })

  it("失败回合的断言差异进页面：期望、实际、错误都在", () => {
    const html = renderHtmlReport(makeReport({
      scenes: [makeScene({
        status: "fail",
        turns: [makeTurn({
          assertions: [{
            type: "pool-value",
            pass: false,
            error: "变量池取值不符",
            expected: "mood=happy",
            actual: "mood=neutral",
          }],
        })],
      })],
    }))

    expect(html).toContain("mood=happy")
    expect(html).toContain("mood=neutral")
    expect(html).toContain("变量池取值不符")
    expect(html).toContain('class="check check-fail"')
  })
})
