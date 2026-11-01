// ==========================================
// 计划工作单执行（L3）
// ==========================================
//
// 被测：executePlan 的步骤执行面。只替换 Provider；工具、子运行与结算都走真实路径。
// 钉住：依赖只认 complete（partial 不让路且不占请求）、格式修复只做一次、
// 修复仍失败按 partial 兜底、工具预算耗尽时 complete 被确定性降级。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { executePlan, formatPlanDeliverySummary, formatStepResults } from "@/services/engine/planner"
import { initPaths } from "@/services/paths"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { registerDefaultTools } from "@/services/tool/registry"

let root = ""
const registered: string[] = []
const PROBE = "plan_probe_read"

function stepComplete(summary: string): string {
  return JSON.stringify({ status: "complete", summary })
}
function stepPartial(summary: string, missing: string[]): string {
  return JSON.stringify({ status: "partial", summary, missing })
}

const scope = { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }

function callbacks(overrides: Partial<Parameters<typeof executePlan>[2]> = {}): Parameters<typeof executePlan>[2] {
  return {
    onStepStart: () => {},
    onStepDone: () => {},
    onStepFailed: async () => "continue" as const,
    onStepNotice: () => {},
    ...overrides,
  }
}

function probeTool(): void {
  const tool = defineTool({
    id: "plan-probe-read", name: PROBE, description: "计划执行只读探针",
    parameters: { type: "object", properties: {} }, safetyLevel: "SAFE",
    source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "passthrough" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "preserve", historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: "探针结果" }))
  register(tool)
  registered.push(tool.id)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-work-order-"))
  setTestDataRoot(root)
  await initPaths()
  await registerDefaultTools()
  probeTool()
})

afterEach(() => {
  for (const id of registered.splice(0)) unregister(id)
  rmSync(root, { recursive: true, force: true })
})

describe("计划工作单执行", () => {
  it("依赖步骤只有 complete 才放行：partial 让后续步骤未执行且不占请求 [plan-dependency-partial-blocked]", async () => {
    const provider = installFakeProvider([
      fakeText(stepPartial("只做了一半", ["还差最后一步"])),
      fakeText(stepComplete("独立步骤完成")),
    ])

    const result = await executePlan({
      summary: "依赖未满足", estimatedComplexity: 3,
      steps: [
        { id: 1, description: "产出前置", allowedTools: [PROBE], inputs: "用户目标", deliverable: "前置产出", acceptance: "前置完成" },
        { id: 2, description: "依赖前一步", dependsOn: [1], allowedTools: [PROBE], inputs: "前置产出", deliverable: "后续产出", acceptance: "后续完成" },
        { id: 3, description: "独立步骤", allowedTools: [PROBE], inputs: "用户目标", deliverable: "独立产出", acceptance: "独立完成" },
      ],
    }, {
      planId: "plan-dependency-partial", intent: "验证依赖只认 complete",
      scope, stepMaxToolCalls: 2, stepThinkingEffort: "low", onStepFailure: "continue",
    }, callbacks())

    // 请求账：第 1 步 1 次 + 第 3 步 1 次；阻塞的第 2 步 0 次。
    expect(provider.state.callCount, "阻塞步骤不该发子代理请求").toBe(2)
    expect(result.blockedSteps).toHaveLength(1)
    expect(result.blockedSteps[0]).toMatchObject({
      step: { id: 2 },
      dependencyStepIds: [1],
      reason: "依赖步骤 1（partial） 未完成",
    })
    expect(result.overallSuccess).toBe(false)
    expect(result.stepResults.map(item => item.step.id)).toEqual([1, 3])
    expect(result.stepResults[1]?.output.success, "独立步骤应照常成功").toBe(true)

    expect(formatStepResults(result)).toContain(
      'BLOCK 步骤 2 "依赖前一步" - 未执行（依赖步骤 1（partial） 未完成）',
    )
    expect(formatPlanDeliverySummary(result)).toContain(
      "- 步骤 2「依赖前一步」：未执行（依赖步骤 1（partial） 未完成）",
    )
    expect(provider.payloads[1]?.systemPrompt, "第 3 步的计划全貌没有如实标注未执行步骤")
      .toContain("2. [未执行（依赖未完成）] 依赖前一步（依赖 1）")
  })

  it("步骤回复不符合契约时只修复一次，修复成功按 complete 结算 [plan-step-format-repair-once]", async () => {
    const provider = installFakeProvider([
      fakeText("已经做完了"),
      fakeText(stepComplete("整理后的结论")),
    ])

    const result = await executePlan({
      summary: "格式修复", estimatedComplexity: 1,
      steps: [{ id: 1, description: "整理结论", allowedTools: [PROBE], inputs: "用户目标", deliverable: "结论", acceptance: "结论可读" }],
    }, {
      planId: "plan-repair-once", intent: "验证格式修复只做一次",
      scope, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort",
    }, callbacks())

    expect(provider.state.callCount, "原始请求 + 一次修复请求").toBe(2)
    expect(result.stepResults[0]?.outcome?.status).toBe("complete")
    expect(result.stepResults[0]?.outcome?.summary).toBe("整理后的结论")
    expect(result.stepResults[0]?.output.success).toBe(true)
    expect(result.stepResults[0]?.output.error, "修复成功后不应再留着契约错误").toBeUndefined()
    expect(result.overallSuccess).toBe(true)
  })

  it("修复仍不符合契约时按 partial 兜底并写明缺口 [plan-step-format-repair-gives-up]", async () => {
    const provider = installFakeProvider([
      fakeText("已经做完了"),
      fakeText("还是不合法"),
    ])

    const result = await executePlan({
      summary: "修复失败", estimatedComplexity: 1,
      steps: [{ id: 1, description: "整理结论", allowedTools: [PROBE], inputs: "用户目标", deliverable: "结论", acceptance: "结论可读" }],
    }, {
      planId: "plan-repair-gives-up", intent: "验证修复失败兜底",
      scope, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort",
    }, callbacks())

    expect(provider.state.callCount).toBe(2)
    const output = result.stepResults[0]?.output
    expect(result.stepResults[0]?.outcome?.status).toBe("partial")
    expect(result.stepResults[0]?.outcome?.missing).toContain("结构化结果不符合契约")
    expect(output?.success).toBe(false)
    expect(result.overallSuccess).toBe(false)
  })

  it("工具预算耗尽时 complete 被降级为 partial 并留证据 [plan-step-budget-exhausted-partial]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(PROBE, {}, "budget-call-1"),
      fakeToolCall(PROBE, {}, "budget-call-2"),
      fakeText(stepComplete("预算内完成")),
    ])

    const result = await executePlan({
      summary: "预算耗尽", estimatedComplexity: 1,
      steps: [{ id: 1, description: "反复调用探针", allowedTools: [PROBE], inputs: "用户目标", deliverable: "探针结果", acceptance: "调用完成" }],
    }, {
      planId: "plan-budget-exhausted", intent: "验证预算耗尽降级",
      scope, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort",
    }, callbacks())

    expect(provider.state.callCount, "越界调用软拒后仍应有一次收尾请求").toBe(3)
    const output = result.stepResults[0]?.output
    expect(result.stepResults[0]?.outcome?.status).toBe("partial")
    expect(result.stepResults[0]?.outcome?.missing).toContain("工具调用预算耗尽")
    expect(output?.evidence.toolBudgetExhausted === true, "预算耗尽的证据标记缺失").toBe(true)
    expect(output?.success).toBe(false)
    expect(result.overallSuccess).toBe(false)
  })
})
