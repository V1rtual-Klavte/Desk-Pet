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
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setOverrides } from "@/services/config"
import type { PlanExecutionResult, PlanResult, StepToolNotice } from "@/services/engine/planner"
import { executePlan, formatPlanDeliverySummary, formatStepResults, generatePlan } from "@/services/engine/planner"
import { listAll } from "@/services/tool"
import { registerDefaultTools } from "@/services/tool/registry"

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-planner-"))
  setTestDataRoot(root)
  // 判据要求的取值由本文件自己钉：L3 没有 standard-setup 兜底，也不能指望本机 CONFIG
  setOverrides({ "ai.plan.enabled": true })
  await registerDefaultTools()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("计划评估与执行", () => {
  it("失败后继续执行不抹掉失败，异常步骤也须结算 [plan-continue-keeps-failure]", async () => {
    for (const onStepFailure of ["continue", "ask"] as const) {
      for (const rejectNotice of [false, true]) {
        const provider = installFakeProvider([fakeText("第二步完成")])
        const completed: Array<{ id: number; success: boolean }> = []
        const asked: number[] = []
        const result = await executePlan({
          summary: "部分失败", estimatedComplexity: 2,
          steps: [
            { id: 1, description: "失败步骤", allowedTools: ["missing_plan_tool"] },
            { id: 2, description: "继续执行", allowedTools: ["read"] },
          ],
        }, {
          planId: "continue-failure", intent: "验证失败后继续执行",
          scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
          stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure,
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
      fakeText('```json\n{"summary":"两步搞定","estimatedComplexity":4,"steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"}]}\n```'),
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
          step: { id: 1, description: "读取配置" },
          output: { status: "completed", evidence: { tools: [], incomplete: [], unconfirmedEffects: false }, audit: { ownerKind: "plan", runId: "format-test", requestId: "format-test" }, reply: "配置已读取", toolCallsMade: 0, success: true },
          durationMs: 1234,
          resultEntryId: "entry-plan-step-1",
        },
        {
          step: { id: 2, description: "改写配置" },
          output: { status: "completed", evidence: { tools: [], incomplete: [], unconfirmedEffects: false }, audit: { ownerKind: "plan", runId: "format-test", requestId: "format-test" }, reply: "写失败：权限不足", toolCallsMade: 2, success: false, error: "权限不足" },
          durationMs: 500,
        },
      ],
      overallSuccess: false,
      totalSteps: 2,
      totalDurationMs: 1734,
    }

    const text = formatStepResults(result)

    // 成功与失败两条渲染分支都要被看见：只判失败侧等于没覆盖「完成态怎么渲染」
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
      "- 步骤 1「读取配置」：完成",
      "- 步骤 2「改写配置」：失败 - 权限不足",
    ].join("\n"))
    expect(delivery).not.toContain("entry-plan-step-1")
    expect(delivery).not.toContain("配置已读取")
    expect(delivery).not.toContain("请基于以上结果生成最终回复")
  })

  it("步骤交接：后一步拿到前一步的结果与回读地址 [plan-handoff]", async () => {
    const token = `token-${crypto.randomUUID()}`
    const provider = installFakeProvider([fakeText(`第一步产出 ${token}`), fakeText("第二步完成")])
    const execution = await executePlan({
      summary: "交接计划", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "产出令牌" },
        { id: 2, description: "消费令牌" },
      ],
    }, {
      planId: "handoff", intent: "验证步骤之间能交接结果",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "continue",
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
    // 前序块带正文与回读地址；没有地址就无法回到原文
    expect(second).toContain("## 前序步骤")
    expect(second).toContain(token)
    expect(second).toContain("entry-step-1")
    expect(second).toContain("plan_step_result")
    // 第一步没有前序块，不能凭空出现
    expect(first).not.toContain("## 前序步骤")
    // 执行结果里也带着回读地址（`formatStepResults` 与面板据此回读）
    expect(execution.stepResults[0]?.resultEntryId).toBe("entry-step-1")
  })

  it("步骤交接：失败步骤只给错误，不伪造产出 [plan-handoff-failure]", async () => {
    const provider = installFakeProvider([fakeText("第二步完成")])
    const execution = await executePlan({
      summary: "失败交接", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "缺工具步骤", allowedTools: ["missing_handoff_tool"] },
        { id: 2, description: "继续下一步" },
      ],
    }, {
      planId: "handoff-failure", intent: "验证失败步骤只交接错误",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "continue",
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
    expect(second).not.toContain("[done|unverified] 缺工具步骤")
    expect(second).not.toContain("entry-failed")
  })

  it("步骤交接：超长前序正文截断并标注 [plan-handoff-truncate]", async () => {
    const longReply = `开头-${"长".repeat(1600)}-结尾`
    const provider = installFakeProvider([fakeText(longReply), fakeText("第二步完成")])
    await executePlan({
      summary: "截断交接", estimatedComplexity: 2,
      steps: [
        { id: 1, description: "产出长文" },
        { id: 2, description: "消费长文" },
      ],
    }, {
      planId: "handoff-truncate", intent: "验证超长前序会截断",
      scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true },
      stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "continue",
    }, {
      onStepStart: () => {},
      onStepDone: () => "entry-long",
      onStepFailed: async () => "continue" as const,
      onStepNotice: () => {},
    })

    const second = provider.payloads[1]?.systemPrompt ?? ""
    expect(second).toContain("…（已截断）")
    expect(second).not.toContain(longReply)
    expect(second).not.toContain("-结尾")
  })

  it("executePlan 逐步执行并回调 [plan-execute-loop]", async () => {
    // 每一步的子代理都要一次模型回复；两步就准备两条。provider 句柄留着：工具面放大是不是真的
    // 发生，只能从发出去的请求里看
    const stepProvider = installFakeProvider([fakeText("第一步完成"), fakeText("第二步完成")])

    const plan: PlanResult = {
      steps: [
        { id: 1, description: "第一步" },
        { id: 2, description: "第二步" },
      ],
      summary: "两步计划",
      estimatedComplexity: 3,
    }

    const started: number[] = []
    const done: number[] = []
    const notices: StepToolNotice[] = []
    const execution = await executePlan(
      plan,
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
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

    // 未限定 allowedTools = 工具面放大到全部已注册工具，必须逐步骤报告（不静默）
    expect(notices).toEqual([{ kind: "unbounded_tools" }, { kind: "unbounded_tools" }])
    // 放大是真的发生，不是只发了一条 notice：两步的子代理请求都要带上「除派生型工具外的
    // 全部已注册工具」。期望集合按注册表现取（判定读每个工具自己的 isolation，不写死名单），
    // 派生型工具到不了子代理（runPiSubAgent 是唯一剥离点），请求里出现即放大面被说错。
    expect(stepProvider.payloads).toHaveLength(2)
    const registered = listAll()
    const derived = registered.filter(tool => tool.policy.execution.isolation === "delegate").map(tool => tool.name)
    // 前提：剥离侧至少有一个派生型工具，否则下面的比较退化成「全量相等」，失去意义；
    // 末段还要用 agent_spawn 这个名字（名字能解析到，但到不了子代理）
    expect(derived).toContain("agent_spawn")
    const amplified = registered.filter(tool => !derived.includes(tool.name)).map(tool => tool.name)
    for (const [index, payload] of stepProvider.payloads.entries()) {
      const sent = (payload.tools ?? []).map(tool => tool.name)
      // 集合相等同时覆盖两个方向：派生型工具一个都没漏出去，已注册工具一个都没少
      expect([...sent].sort(), `第 ${index + 1} 步的子代理工具面`).toEqual([...amplified].sort())
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
      { steps: [{ id: 1, description: "用不存在的工具干活", allowedTools: ["live_missing_tool_probe"] }], summary: "缺工具", estimatedComplexity: 1 },
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
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
      { steps: [{ id: 1, description: "派个子代理去干活", allowedTools: ["agent_spawn"] }], summary: "派生工具", estimatedComplexity: 1 },
      { planId: "integration-plan", intent: "测试计划目标", scope: { sessionId: "plan-test", runGeneration: 1, isCurrent: () => true }, stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
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
