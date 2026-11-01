// ==========================================
// 工作单与结构化产出的纯解析/格式化（L2）
// ==========================================
//
// 被测：plan/work-order 的 parseStepOutcome / parsePlanVerification / formatWorkOrder /
// stepOutcomeFromReply。这一层只做「读模型输出」与「写子代理任务块」，不碰宿主、会话或工具，
// 因此归 L2。断言全部手写期望值，不拿被测函数的输出反推期望。
import { describe, expect, it } from "vitest"

import {
  formatWorkOrder,
  parsePlanVerification,
  parseStepOutcome,
  stepOutcomeFromReply,
} from "@/services/engine/plan/work-order"

describe("工作单解析", () => {
  it("```json 围栏与裸 JSON 都能解析，顶层不是对象则拒绝 [work-order-parse-json-shapes]", () => {
    const fenced = parseStepOutcome([
      "前缀说明",
      "```json",
      JSON.stringify({ status: "partial", summary: "围栏内的产出", missing: ["待补"] }),
      "```",
      "后缀说明",
    ].join("\n"))
    expect(fenced.ok, "```json 围栏里的合法产出没有被解析").toBe(true)
    if (fenced.ok) {
      expect(fenced.value).toEqual({ status: "partial", summary: "围栏内的产出", missing: ["待补"] })
    }

    const bare = parseStepOutcome(JSON.stringify({ status: "complete", summary: "裸 JSON 产出" }))
    expect(bare.ok, "裸 JSON 没有被解析").toBe(true)
    if (bare.ok) expect(bare.value).toMatchObject({ status: "complete", summary: "裸 JSON 产出" })

    // 数组里不套对象：套对象的数组会被花括号段捞取成合法对象，到不了顶层数组的拒绝分支。
    const array = parseStepOutcome("[1, 2, 3]")
    expect(array.ok, "顶层数组应被拒绝").toBe(false)
    if (!array.ok) expect(array.reason).toContain("顶层必须是对象")

    const scalar = parseStepOutcome("42")
    expect(scalar.ok, "顶层标量应被拒绝").toBe(false)
  })

  it("complete 与缺口/未达成验收互斥，改成 partial 后合法 [work-order-complete-contradiction]", () => {
    const withMissing = parseStepOutcome(JSON.stringify({
      status: "complete", summary: "看起来完成", missing: ["还有缺口"],
    }))
    expect(withMissing.ok, "complete 携带 missing 应判不合法").toBe(false)
    if (!withMissing.ok) expect(withMissing.reason).toContain("missing")

    const withUnmet = parseStepOutcome(JSON.stringify({
      status: "complete", summary: "看起来完成",
      acceptance: [{ item: "配置文件已写回", met: false }],
    }))
    expect(withUnmet.ok, "complete 携带未达成验收应判不合法").toBe(false)
    if (!withUnmet.ok) expect(withUnmet.reason).toContain("验收")

    const asPartial = parseStepOutcome(JSON.stringify({
      status: "partial", summary: "只完成一半",
      acceptance: [{ item: "配置文件已写回", met: false }],
      missing: ["写回失败"],
    }))
    expect(asPartial.ok, "同样的缺口在 partial 下应合法").toBe(true)
    if (asPartial.ok) {
      expect(asPartial.value.status).toBe("partial")
      expect(asPartial.value.missing).toEqual(["写回失败"])
      expect(asPartial.value.acceptance).toEqual([{ item: "配置文件已写回", met: false }])
    }
  })

  it("摘要超过 2000 字符被截断，数组最多保留 20 条 [work-order-caps]", () => {
    const long = "长".repeat(2000) + "尾巴"
    const parsed = parseStepOutcome(JSON.stringify({
      status: "partial",
      summary: long,
      artifacts: Array.from({ length: 25 }, (_, index) => `artifact-${index + 1}.txt`),
    }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.summary).toHaveLength(2000)
      expect(parsed.value.summary.endsWith("尾巴"), "超过上限的尾部没有被截掉").toBe(false)
      expect(parsed.value.artifacts).toHaveLength(20)
      expect(parsed.value.artifacts?.[0]).toBe("artifact-1.txt")
      expect(parsed.value.artifacts?.[19]).toBe("artifact-20.txt")
    }
  })

  it("核验结果只接受三档结论，缺省数组补空、合法输入原样返回 [work-order-verification-shape]", () => {
    const badVerdict = parsePlanVerification(JSON.stringify({ verdict: "done", summary: "完成" }))
    expect(badVerdict.ok, "非枚举 verdict 应被拒绝").toBe(false)
    if (!badVerdict.ok) expect(badVerdict.reason).toContain("verdict 必须是 pass / partial / fail 之一")

    const noSummary = parsePlanVerification(JSON.stringify({ verdict: "pass" }))
    expect(noSummary.ok, "缺少 summary 应被拒绝").toBe(false)
    if (!noSummary.ok) expect(noSummary.reason).toContain("summary 不能为空")

    const defaults = parsePlanVerification(JSON.stringify({ verdict: "fail", summary: "没有达成" }))
    expect(defaults.ok).toBe(true)
    if (defaults.ok) {
      expect(defaults.value).toEqual({
        verdict: "fail", reasons: [], missing: [], drift: [], summary: "没有达成",
      })
    }

    const full = {
      verdict: "partial", reasons: ["只完成一半"], missing: ["第二项"], drift: ["改了范围"], summary: "部分通过",
    }
    const parsed = parsePlanVerification(JSON.stringify(full))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(full)
  })

  it("formatWorkOrder 固定段落与缺省占位 [work-order-format]", () => {
    const rendered = formatWorkOrder({
      description: "读取配置",
      allowedTools: ["read", "write"],
      dependsOn: [1, 2],
      inputs: "上一版的配置",
      deliverable: "配置检查结论",
      acceptance: "读到全部配置\n指出不合法项",
    })

    for (const line of [
      "## 本步工作单",
      "任务: 读取配置",
      "需要的输入: 上一版的配置",
      "交付物: 配置检查结论",
      "验收标准:",
      "- 读到全部配置",
      "- 指出不合法项",
      "明确不做:",
      "- 无",
      "允许工具: read、write",
      "依赖步骤: 1、2",
    ]) {
      expect(rendered, `工作单缺少「${line}」`).toContain(line)
    }

    const restricted = formatWorkOrder({
      description: "只读配置",
      allowedTools: ["read"],
      inputs: "配置文件",
      deliverable: "配置内容",
      acceptance: "读到配置",
      nonGoals: "不改写文件",
    })
    expect(restricted).toContain("- 不改写文件")
    expect(restricted, "有明确不做时不应再出现占位「- 无」").not.toContain("- 无")
    expect(restricted).toContain("依赖步骤: 无")
  })

  it("非 JSON 正文兜底为 partial，并写明契约缺口 [work-order-fallback-outcome]", () => {
    const outcome = stepOutcomeFromReply("不是 JSON，只是一段说明", "兜底摘要")
    expect(outcome.status).toBe("partial")
    expect(outcome.summary).toBe("兜底摘要")
    expect(outcome.missing).toEqual(["结构化结果不符合契约"])
  })
})
