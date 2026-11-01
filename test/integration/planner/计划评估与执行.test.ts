// ==========================================
// 计划评估与执行 —— 从 test/e2e/scenes/planner/计划评估与执行.scene.ts 迁到 L3
// ==========================================
//
// 归属按 import 判定，不按 entry 标签：原场景 import 了 `@/services/tool`
// （工具 barrel 会带出执行许可，属 IPC 入口），因此进 L3（test/integration/）而不是 L2。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { setOverrides } from "@/services/config"
import type { PlanExecutionResult, PlanResult, StepToolNotice } from "@/services/engine/planner"
import { executePlan, formatPlanDeliverySummary, formatStepResults, generatePlan } from "@/services/engine/planner"
import { defineTool, listAll, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { EffectClass } from "@/services/tool"
import { registerDefaultTools } from "@/services/tool/registry"

/** 步骤产出契约：只有 complete 才会让计划判完成，核验器也才会运行。 */
function stepComplete(summary: string): string {
  return JSON.stringify({ status: "complete", summary })
}

let root = ""
const registered: string[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-planner-"))
  setTestDataRoot(root)
  // 判据要求的取值由本文件自己钉：L3 没有 standard-setup 兜底，也不能指望本机 CONFIG
  setOverrides({ "ai.plan.enabled": true })
  await registerDefaultTools()
})

afterEach(() => {
  for (const id of registered.splice(0)) unregister(id)
  rmSync(root, { recursive: true, force: true })
})

/** 效果回执探针：执行必败，effect 决定失败回执是否可能留下未确认效果。 */
function effectProbe(name: string, effect: EffectClass): string {
  const tool = defineTool({
    id: `plan-effect-probe-${name}`, name, description: "计划步骤效果回执探针",
    parameters: { type: "object", properties: {} }, safetyLevel: "SAFE",
    source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "passthrough" },
      execution: { effect, isolation: effect === "read" ? "shared_read" : "exclusive_effect", replay: "never" },
      context: { resultProjection: "preserve", historyCompaction: "summarize" },
    },
  }, async () => ({ success: false, content: "", error: "工具失败：模拟" }))
  register(tool)
  registered.push(tool.id)
  return tool.name
}

describe("计划评估与执行", () => {
  it("失败后继续执行不抹掉失败，异常步骤也须结算 [plan-continue-keeps-failure]", async () => {
    for (const onStepFailure of ["continue", "ask"] as const) {
      for (const rejectNotice of [false, true]) {
        const provider = installFakeProvider([fakeText(stepComplete("第二步完成"))])
        const completed: Array<{ id: number; success: boolean }> = []
        const asked: number[] = []
        const result = await executePlan({
          summary: "部分失败", estimatedComplexity: 2,
          steps: [
            { id: 1, description: "失败步骤", allowedTools: ["missing_plan_tool"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
            { id: 2, description: "继续执行", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
          ],
        }, {
          planId: "continue-failure", intent: "验证失败后继续执行",
          scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
          stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure,
        }, {
          onStepStart: () => {},
          onStepDone: (step, output) => { completed.push({ id: step.id, success: output.success }) },
          onStepFailed: async step => { asked.push(step.id); return "continue" },
          onStepNotice: () => rejectNotice ? Promise.reject(new Error("通知失败")) : undefined,
        })
        expect(result.overallSuccess).toBe(false)
        expect(result.stepResults.map(item => item.output.success)).toEqual([false, true])
        expect(completed).toEqual([{ id: 1, success: false }, { id: 2, success: true }])
        expect(asked).toEqual(onStepFailure === "ask" ? [1] : [])
        expect(provider.payloads).toHaveLength(1)
        expect(formatStepResults(result)).toContain("部分完成（1/2 步）")
      }
    }
  })

  it("generatePlan 解析模型返回的步骤 [plan-generate]", async () => {
    installFakeProvider([
      fakeText('```json\n{"summary":"两步搞定","estimatedComplexity":4,"steps":[{"id":1,"description":"读取配置","allowedTools":["read"],"inputs":"当前配置","deliverable":"配置内容","acceptance":"读到完整配置"},{"id":2,"description":"改写配置","allowedTools":["read"],"inputs":"配置内容","deliverable":"修改后的配置","acceptance":"目标项已改写"}]}\n```'),
    ])

    const plan = await generatePlan("改一下配置", {
      cardId: "test-card",
      cardRole: "助手",
      availableTools: listAll(),
      thinkingEffort: "low",
      maxSteps: 8,
    })

    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.description).toBe("读取配置")
    expect(plan.steps[1]?.description).toBe("改写配置")
    expect(plan.summary).toBe("两步搞定")
    // 契约 pl-05 声称 estimatedComplexity 逐项落地：夹具给 4，而产品缺省值是 3 ——
    // 只有真的透传模型字段才会是 4，写死缺省值的实现过不了这条
    expect(plan.estimatedComplexity).toBe(4)
  })

  it("generatePlan 解析失败时降级为单步 [plan-generate-fallback]", async () => {
    // 模型返回纯文本而不是 JSON：必须给出可执行的降级计划，而不是抛错或空计划
    installFakeProvider([fakeText("我觉得直接做就行，没什么好拆的")])

    const plan = await generatePlan("随便看看", {
      cardId: "test-card",
      cardRole: "助手",
      availableTools: listAll(),
      thinkingEffort: "low",
      maxSteps: 8,
    })

    // 契约声称的是「降级为单步」：只判非空会让两步、甚至原计划残留都通过
    expect(plan.steps).toHaveLength(1)
    expect(plan.estimatedComplexity).toBe(1)
    expect(plan.steps[0]?.description).toBeTruthy()
    // 降级是用户可见的行为变化：生产段按这个标记发系统消息，丢了它用户会以为计划正常生成过
    expect(plan.degradedReason).toBe("json_parse_failed")
  })

  it("formatStepResults 输出可读文本与回读地址 [plan-format-steps]", () => {
    // 夹具必须是合法数据：PiSubAgentOutput 的 success / toolCallsMade 是必填字段。
    // 此前靠 `as unknown as` 绕过类型，`success=undefined` 让两步都按 FAIL 渲染 ——
    // 完成态（OK/完成）分支从未被合法数据覆盖过，所以夹具写成「一成一败」。
    const result: PlanExecutionResult = {
      stepResults: [
        {
          step: { id: 1, description: "读取配置", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
          output: { status: "completed", evidence: { tools: [], incomplete: [], unconfirmedEffects: false }, audit: { ownerKind: "plan", runId: "format-test", requestId: "format-test" }, reply: "配置已读取", toolCallsMade: 0, success: true },
          durationMs: 1234,
          resultEntryId: "entry-plan-step-1",
        },
        {
          step: { id: 2, description: "改写配置", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
          output: { status: "completed", evidence: { tools: [], incomplete: [], unconfirmedEffects: false }, audit: { ownerKind: "plan", runId: "format-test", requestId: "format-test" }, reply: "写失败：权限不足", toolCallsMade: 2, success: false, error: "权限不足" },
          durationMs: 500,
        },
      ],
      blockedSteps: [],
      overallSuccess: false,
      totalSteps: 2,
      totalDurationMs: 1734,
    }

    const text = formatStepResults(result)

    // 成功与失败两条渲染分支都要被看见：只判失败侧等于没覆盖「完成态怎么渲染」
    // 没有结构化产出时退回验收档口径：成功但没产出 = 未验收。
    expect(text).toContain('OK 步骤 1 "读取配置" - 完成（未验收）')
    expect(text).toContain('FAIL 步骤 2 "改写配置" - 失败')
    // 正文是截断预览，回读地址是模型与用户回到原文的唯一通道：有地址要标明、没有地址要如实说
    expect(text).toContain("配置已读取")
    expect(text).toContain("原文见")
    expect(text).toContain("entry-plan-step-1")
    expect(text).toContain("原文未落盘")
    // 错误正文不截断，原样进结果
    expect(text).toContain("错误: 权限不足")
    expect(text).toContain("请基于以上结果生成最终回复")

    // 最终回复失败时的兜底：中性陈述 + 每步结果，不回读地址、不夹带步骤正文、不要求再次生成。
    const delivery = formatPlanDeliverySummary(result)
    expect(delivery).toBe([
      "计划步骤已执行结束：1/2 步完成。",
      "- 步骤 1「读取配置」：完成（未验收）",
      "- 步骤 2「改写配置」：失败 - 权限不足",
    ].join("\n"))
    expect(delivery).not.toContain("entry-plan-step-1")
    expect(delivery).not.toContain("配置已读取")
    expect(delivery).not.toContain("请基于以上结果生成最终回复")

    // 成功但证据有缺口（例如必需的 MCP 连接失败）仍是成功步骤，但档位必须是未验收 ——
    // 不能因为正文非空就把证据缺口涂成「已核对」。
    const incomplete: PlanExecutionResult = {
      stepResults: [{
        step: { id: 3, description: "读取外部资料", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        output: { status: "completed", evidence: { tools: [], incomplete: ["MCP docs: 连接失败"], unconfirmedEffects: false }, audit: { ownerKind: "plan", runId: "format-test", requestId: "format-incomplete" }, reply: "已用本地资料回答", toolCallsMade: 0, success: true },
        durationMs: 10,
      }],
      blockedSteps: [],
      overallSuccess: true,
      totalSteps: 1,
      totalDurationMs: 10,
    }
    expect(formatStepResults(incomplete)).toContain('OK 步骤 3 "读取外部资料" - 完成（未验收）')
    expect(formatPlanDeliverySummary(incomplete)).toContain("- 步骤 3「读取外部资料」：完成（未验收）")
  })

  it("非只读工具失败不能被非空正文洗成完成 [plan-step-effect-receipt]", async () => {
    const baseConfig = {
      intent: "验证失败效果不能冒充完成",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 2, stepThinkingEffort: "low" as const,
      onStepFailure: "abort" as const,
    }
    // 非只读效果（写盘 / 进程 / 外部系统）的失败回执都可能已经产生效果：
    // 模型随后返回非空正文不能把这一步洗成完成。
    for (const effect of ["local_mutation", "process", "external_side_effect"] as const) {
      const tool = effectProbe(`fail_${effect}`, effect)
      installFakeProvider([fakeToolCall(tool, {}, `effect-${effect}`), fakeText(stepComplete("工具失败了，但我说已经完成"))])
      const execution = await executePlan({
        summary: "效果回执", estimatedComplexity: 1,
        steps: [{ id: 1, description: "执行可变更操作", allowedTools: [tool], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" }],
      }, { ...baseConfig, planId: `effect-${effect}` }, {
        onStepStart: () => {}, onStepDone: () => "entry-effect",
        onStepFailed: async () => "abort" as const, onStepNotice: () => {},
      })
      const output = execution.stepResults[0]!.output
      expect(output.success, `${effect} 失败后步骤被误判成功`).toBe(false)
      expect(output.evidence.unconfirmedEffects, `${effect} 失败没有记未确认效果`).toBe(true)
      expect(output.error, `${effect} 失败原因没有说明效果未确认`).toContain("未确认")
      expect(execution.overallSuccess, `${effect} 失败后计划仍判整体成功`).toBe(false)
      // 自称 complete 被确定性降级为 partial：渲染按结构化产出说「部分完成」，不是冒充完成。
      expect(formatStepResults(execution)).toContain('PART 步骤 1 "执行可变更操作" - 部分完成')
    }

    // 只读失败没有未确认效果：正文非空时步骤仍可完成 —— 这里核对的是证据闭环，
    // 不是「工具没报过错」。
    const readTool = effectProbe("fail_read", "read")
    installFakeProvider([fakeToolCall(readTool, {}, "effect-read"), fakeText(stepComplete("读取失败，已改走本地缓存"))])
    const readExecution = await executePlan({
      summary: "只读失败", estimatedComplexity: 1,
      steps: [{ id: 1, description: "读取配置", allowedTools: [readTool], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" }],
    }, { ...baseConfig, planId: "effect-read" }, {
      onStepStart: () => {}, onStepDone: () => "entry-read",
      onStepFailed: async () => "abort" as const, onStepNotice: () => {},
    })
    expect(readExecution.stepResults[0]?.output.success).toBe(true)
    expect(readExecution.stepResults[0]?.output.evidence.unconfirmedEffects).toBe(false)
    // 有结构化产出时按产出状态说「完成」，不再退回验收档文案。
    expect(formatStepResults(readExecution)).toContain('OK 步骤 1 "读取配置" - 完成 (')
  })

  it("步骤交接：后一步拿到前一步的结果摘要（不依赖回读地址） [plan-handoff]", async () => {
    const token = `token-${crypto.randomUUID()}`
    const provider = installFakeProvider([fakeText(stepComplete(`第一步产出 ${token}`)), fakeText(stepComplete("第二步完成"))])
    const execution = await executePlan({
      summary: "交接计划", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "产出令牌", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "消费令牌", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
    }, {
      planId: "handoff", intent: "验证步骤之间能交接结果",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "continue",
    }, {
      onStepStart: () => {},
      onStepDone: step => `entry-step-${step.id}`,
      onStepFailed: async () => "continue" as const,
      onStepNotice: () => {},
    })

    expect(provider.payloads).toHaveLength(2)
    const first = provider.payloads[0]?.systemPrompt ?? ""
    const second = provider.payloads[1]?.systemPrompt ?? ""
    // 原始目标对每一步可见
    expect(first).toContain("## 原始目标")
    expect(second).toContain("验证步骤之间能交接结果")
    // 前序块带状态与自包含摘要；子运行读不到父会话条目，不能给读不到的地址
    expect(second).toContain("## 前序步骤")
    expect(second).toContain("[complete] 产出令牌")
    expect(second).toContain(token)
    expect(second).not.toContain("entry-step-1")
    expect(second).not.toContain("plan_step_result")
    // 第一步没有前序块，不能凭空出现
    expect(first).not.toContain("## 前序步骤")
    // 执行结果里仍带着回读地址（主回合的 `formatStepResults` 与面板据此回读）
    expect(execution.stepResults[0]?.resultEntryId).toBe("entry-step-1")
  })

  it("步骤交接：失败步骤只给错误，不伪造产出 [plan-handoff-failure]", async () => {
    const provider = installFakeProvider([fakeText(stepComplete("第二步完成"))])
    const execution = await executePlan({
      summary: "失败交接", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "缺工具步骤", allowedTools: ["missing_handoff_tool"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "继续下一步", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
    }, {
      planId: "handoff-failure", intent: "验证失败步骤只交接错误",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "continue",
    }, {
      onStepStart: () => {},
      onStepDone: () => "entry-failed",
      onStepFailed: async () => "continue" as const,
      onStepNotice: () => {},
    })

    expect(execution.stepResults.map(item => item.output.success)).toEqual([false, true])
    expect(provider.payloads).toHaveLength(1)
    const second = provider.payloads[0]?.systemPrompt ?? ""
    expect(second).toContain("[failed] 缺工具步骤 — 失败：")
    expect(second).toContain("missing_handoff_tool")
    // 失败步骤没有成功标记，也不给半截正文或地址（避免下游把失败产出当结论）
    expect(second).not.toContain("[complete] 缺工具步骤")
    expect(second).not.toContain("entry-failed")
    expect(second).not.toContain("plan_step_result")
  })

  it("步骤交接：超长前序正文保留头尾并标注截断 [plan-handoff-truncate]", async () => {
    const longReply = `开头-${"长".repeat(1600)}-结尾`
    const provider = installFakeProvider([fakeText(stepComplete(longReply)), fakeText(stepComplete("第二步完成"))])
    await executePlan({
      summary: "截断交接", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "产出长文", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "消费长文", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
    }, {
      planId: "handoff-truncate", intent: "验证超长前序会截断",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "continue",
    }, {
      onStepStart: () => {},
      onStepDone: () => "entry-long",
      onStepFailed: async () => "continue" as const,
      onStepNotice: () => {},
    })

    const second = provider.payloads[1]?.systemPrompt ?? ""
    expect(second).toContain("…（已截断）")
    expect(second).not.toContain(longReply)
    // 结论常在尾部：截断必须保留结尾，而不是只留开头
    expect(second).toContain("开头-")
    expect(second).toContain("-结尾")
  })

  it("依赖未满足时未执行并说明原因 [plan-dependency-skip]", async () => {
    // 只有第三步会真的开工：第一步因缺工具失败，第二步依赖它必须被判为未执行。
    const provider = installFakeProvider([fakeText(stepComplete("第三步完成"))])
    const started: number[] = []
    const blockedCallbacks: Array<{ id: number; reason: string; deps: number[] }> = []
    const execution = await executePlan({
      summary: "依赖跳过", estimatedComplexity: 3,
      steps: [
        { id: 1, description: "缺工具步骤", allowedTools: ["missing_dependency_tool"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "依赖前一步", dependsOn: [1], allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 3, description: "独立步骤", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
    }, {
      planId: "dependency-skip", intent: "验证依赖未完成会跳过",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "continue",
    }, {
      onStepStart: step => { started.push(step.id) },
      onStepDone: () => {},
      onStepFailed: async () => "continue" as const,
      onStepBlocked: (step, reason, deps) => { blockedCallbacks.push({ id: step.id, reason, deps }) },
      onStepNotice: () => {},
    })

    // 未执行不是执行：不占 onStepStart、不发子代理请求；独立步骤照常跑
    expect(started).toEqual([1, 3])
    expect(provider.payloads).toHaveLength(1)
    expect(blockedCallbacks).toEqual([{ id: 2, reason: "依赖步骤 1（failed） 未完成", deps: [1] }])
    expect(execution.stepResults.map(item => item.step.id)).toEqual([1, 3])
    expect(execution.blockedSteps).toHaveLength(1)
    expect(execution.blockedSteps[0]).toMatchObject({ step: { id: 2 }, dependencyStepIds: [1] })
    expect(execution.overallSuccess).toBe(false)

    // 模型可见结果与用户可见交付都按步骤顺序说明未执行原因（不能只缺一步不说为什么）
    const text = formatStepResults(execution)
    expect(text).toContain('BLOCK 步骤 2 "依赖前一步" - 未执行（依赖步骤 1（failed） 未完成）')
    expect(text.indexOf("FAIL 步骤 1")).toBeLessThan(text.indexOf("BLOCK 步骤 2"))
    expect(text.indexOf("BLOCK 步骤 2")).toBeLessThan(text.indexOf("OK 步骤 3"))
    const delivery = formatPlanDeliverySummary(execution)
    expect(delivery).toContain("计划步骤已执行结束：1/3 步完成。")
    expect(delivery).toContain("- 步骤 2「依赖前一步」：未执行（依赖步骤 1（failed） 未完成）")

    // 后续步骤的计划全貌必须反映真实状态，而不是把未执行步骤当成待执行
    const thirdPrompt = provider.payloads[0]?.systemPrompt ?? ""
    expect(thirdPrompt).toContain("## 计划全貌")
    expect(thirdPrompt).toContain("1. [失败] 缺工具步骤")
    expect(thirdPrompt).toContain("2. [未执行（依赖未完成）] 依赖前一步（依赖 1）")
    expect(thirdPrompt).toContain("3. [当前] 独立步骤")
  })

  it("步骤提示包含全计划大纲与其他步骤状态 [plan-outline]", async () => {
    const provider = installFakeProvider([fakeText(stepComplete("第一步完成")), fakeText(stepComplete("第二步完成"))])
    const execution = await executePlan({
      summary: "大纲", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "先查资料", allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "再写结论", dependsOn: [1], allowedTools: [], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
    }, {
      planId: "outline", intent: "验证步骤能看到整份计划",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "continue",
    }, {
      onStepStart: () => {},
      onStepDone: () => {},
      onStepFailed: async () => "continue" as const,
      onStepNotice: () => {},
    })

    expect(provider.payloads).toHaveLength(2)
    // 依赖已满足时照常执行，大纲标明依赖关系
    expect(execution.overallSuccess).toBe(true)
    const first = provider.payloads[0]?.systemPrompt ?? ""
    expect(first).toContain("## 计划全貌")
    expect(first).toContain("1. [当前] 先查资料")
    expect(first).toContain("2. [待执行] 再写结论（依赖 1）")
    // 全貌是计划事实而非新指令：其他步骤明确不要执行
    expect(first).toContain("只执行当前步骤")
    const second = provider.payloads[1]?.systemPrompt ?? ""
    expect(second).toContain("1. [完成] 先查资料")
    expect(second).toContain("2. [当前] 再写结论（依赖 1）")
  })

  it("executePlan 逐步执行并回调 [plan-execute-loop]", async () => {
    // 每一步的子代理都要一次模型回复；两步就准备两条。provider 句柄留着：工具面是否按
    // allowedTools 收窄，只能从发出去的请求里看
    const stepProvider = installFakeProvider([fakeText(stepComplete("第一步完成")), fakeText(stepComplete("第二步完成"))])

    const plan: PlanResult = {
      steps: [
        { id: 1, description: "第一步", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
        { id: 2, description: "第二步", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" },
      ],
      summary: "两步计划",
      estimatedComplexity: 3,
    }

    const started: number[] = []
    const done: number[] = []
    const notices: StepToolNotice[] = []
    const execution = await executePlan(
      plan,
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort" },
      {
        onStepStart: step => { started.push(step.id) },
        onStepDone: step => { done.push(step.id) },
        onStepFailed: async () => "abort" as const,
        onStepNotice: (_step, notice) => { notices.push(notice) },
      },
    )

    // 计划里有几步就必须跑几步，且顺序不能乱
    expect(started).toEqual([1, 2])
    expect(done).toEqual([1, 2])
    expect(execution.stepResults).toHaveLength(2)
    expect(execution.overallSuccess).toBe(true)
    expect(execution.stepResults.map(item => item.output.status)).toEqual(["completed", "completed"])
    expect(execution.stepResults.map(item => item.output.audit.ownerKind)).toEqual(["plan", "plan"])
    expect(execution.stepResults.map(item => item.output.audit.planId)).toEqual(["integration-plan", "integration-plan"])

    // allowedTools 必填后执行器不再放大工具面：每个步骤请求里只出现自己声明的工具。
    expect(notices).toEqual([])
    expect(stepProvider.payloads).toHaveLength(2)
    for (const [index, payload] of stepProvider.payloads.entries()) {
      const sent = (payload.tools ?? []).map(tool => tool.name)
      expect(sent, `第 ${index + 1} 步的子代理工具面没有按 allowedTools 收窄`).toEqual(["read"])
    }

    // 指定的工具解析不到就不开工：拿剩下的工具跑等于这一步的权限面既不可信也不可复现。
    // 「解析不到」包含两种名字 —— 根本没注册，以及注册了但到不了子代理（派生型工具，
    // `isolation=delegate`，现为 agent_spawn 与 propose_plan）：后者在 runPiSubAgent 会被剥掉，等同于不存在，
    // 走同一条硬失败（planner.ts:428-443）。这里用的是前一种；后一种（真实的派生型工具名）
    // 在本场景末尾补齐。
    // 「不开工」不等于 onStepStart 不触发 —— 它表示「步骤进入执行、计时开始」（planner.ts:368），
    // 工具解析发生在那之后、runPiSubAgent 之前（executeStep，planner.ts:428-441），失败在括号内结账。
    // 真正的判据是一次模型请求都没发出去：一个响应都不给，真跑起来就只能拿到 Provider 的
    // 「No more faux responses queued」，而不是带工具名的解析错误。
    const missingProvider = installFakeProvider([])
    const missingNotices: StepToolNotice[] = []
    const missingStarted: number[] = []
    const missingDone: number[] = []
    const blocked = await executePlan(
      { steps: [{ id: 1, description: "用不存在的工具干活", allowedTools: ["live_missing_tool_probe"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" }], summary: "缺工具", estimatedComplexity: 1 },
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort" },
      {
        onStepStart: step => { missingStarted.push(step.id) },
        onStepDone: step => { missingDone.push(step.id) },
        onStepFailed: async () => "abort" as const,
        onStepNotice: (_step, notice) => { missingNotices.push(notice) },
      },
    )

    expect(missingNotices).toEqual([{ kind: "missing_tools", names: ["live_missing_tool_probe"] }])
    // 零请求 = 子代理一次都没起：没有请求就不可能跑出工具调用或正文。
    expect(missingProvider.payloads).toHaveLength(0)
    // 步骤仍要走完 onStepStart→onStepDone 的括号：宿主靠这一段写进度事件与耗时，
    // 失败证据（FIX-50 的 plan_step_result）就在 onStepDone 里落盘 —— 缺了它用户看不到产出。
    expect(missingStarted).toEqual([1])
    expect(missingDone).toEqual([1])
    expect(blocked.overallSuccess).toBe(false)
    const blockedOutput = blocked.stepResults[0]?.output
    expect(blockedOutput?.error).toContain("live_missing_tool_probe")
    expect(blockedOutput?.reply).toBe("")
    expect(blockedOutput?.toolCallsMade).toBe(0)
    expect(blocked.cancelled).toBeUndefined()

    // 第二种「解析不到」：名字能解析到工具，但它是派生型工具（`isolation=delegate`），
    // runPiSubAgent 是唯一剥离点 —— 到不了子代理手里，在这一步等同于不存在，必须和「根本没注册」
    // 走同一条硬失败，而不是拿剩下的工具开工（planner.ts 的 executeStep：判定读工具自己的策略
    // 声明，不在这里维护名单）。名字解析是 `getToolByName`，驱动的是 AI 调用的函数名
    // `agent_spawn`，不是工具 id `local-agent-spawn`。
    const derivedProvider = installFakeProvider([])
    const derivedNotices: StepToolNotice[] = []
    const derivedStarted: number[] = []
    const derivedDone: number[] = []
    const derivedBlocked = await executePlan(
      { steps: [{ id: 1, description: "派个子代理去干活", allowedTools: ["agent_spawn"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过" }], summary: "派生工具", estimatedComplexity: 1 },
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepMaxToolCalls: 1, stepThinkingEffort: "low", onStepFailure: "abort" },
      {
        onStepStart: step => { derivedStarted.push(step.id) },
        onStepDone: step => { derivedDone.push(step.id) },
        onStepFailed: async () => "abort" as const,
        onStepNotice: (_step, notice) => { derivedNotices.push(notice) },
      },
    )

    // 判据与上一段同款：如实报 missing_tools 且带上工具名；零请求 = 子代理一次都没起。
    expect(derivedNotices).toEqual([{ kind: "missing_tools", names: ["agent_spawn"] }])
    expect(derivedProvider.payloads).toHaveLength(0)
    expect(derivedStarted).toEqual([1])
    expect(derivedDone).toEqual([1])
    expect(derivedBlocked.overallSuccess).toBe(false)
    const derivedOutput = derivedBlocked.stepResults[0]?.output
    expect(derivedOutput?.error).toContain("agent_spawn")
    expect(derivedOutput?.reply).toBe("")
    expect(derivedOutput?.toolCallsMade).toBe(0)
    expect(derivedBlocked.cancelled).toBeUndefined()
  })
})
