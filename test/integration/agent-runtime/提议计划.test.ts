// ==========================================
// 提议计划（propose_plan）—— 模型走既有计划面板确认后由 executePlan 执行
// ==========================================
//
// 被测语义（用户 2026-10-06 裁决：需要确认的多步任务走桌宠自己的面板，不用 GUI 弹窗）：
// ① 用户确认（面板「开始」）→ 步骤由 `executePlan` 的子运行真实执行，结果按
//    `formatStepResults` 既有格式作为工具结果返回（含 plan_step_result 回读地址）；
//    确认走既有计划确认通道（测试宿主为 `plan-confirm-channel`，与生产同一结算入口）；
// ② 用户取消（面板「取消」）→ 一步都不执行、计划记录如实收尾（步骤全 skipped、计划 failed），
//    工具结果如实说明「未执行任何步骤」；
// ③ 逐步确认模式 → 每步开工前都过既有步骤裁决面板（step_gate 记录可观测）；
// ④ 参数准入拒绝（缺 description / 工具名不存在 / 派生型工具 / 超过 maxSteps）：
//    不开面板、不落计划、工具结果给出点名到步的拒绝理由；
// ⑤ 计划步骤按 allowedTools 收窄工具面（子运行请求里只有 read，没有 bash）；
// ⑥ just_do_it 跳过确认面板 → 不开面板直接执行，工具结果如实标注「未经面板确认」。
//
// 归属 L3（不是 L2）的理由：跑真实 agent loop、真工具执行（propose_plan → executePlan →
// 子运行）与真 JSONL 落盘，且 import `@/services/engine/harness`（规则 6 的 L2 禁入清单）。
// 只替换 Provider（fake 脚本）与执行许可（Node 宿主没有 Rust 许可内核），
// 确认面板用测试宿主的确定性应答（`test/host/plan-confirm-channel.ts`，与 L4 同一设施）。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { planInteractionRecords, planRecords } from "../../host/plan-confirm-channel"
import { runRuntimeTurn } from "./_runtime-turn"
import { setUiEventPublisher } from "@/services/host"
import { planCheckpointStore } from "@/services/engine"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getOverride, planConfig, setOverride } from "@/services/config"
import { initPaths } from "@/services/paths"
import { resumePlan } from "@/services/engine/runtime"
import { chatHistory, getActiveSessionId } from "@/services/session/store"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"

/** 工具名是线上契约（测试手写见证，不 import 实现常量）。 */
const TOOL = "propose_plan"
const PLAN_CALL_ID_ACCEPT = "plan-call-accept"
const PLAN_CALL_ID_DENY = "plan-call-deny"
const PLAN_CALL_ID_STEP = "plan-call-step"
const PLAN_CALL_ID_AUTO = "plan-call-auto"

let root = ""
const registered: string[] = []
/** 本用例内发布的 Node→UI 事件（plan-confirm-channel 只记录确认交互，进度事件由这里记录）。 */
let events: Array<{ event: string; payload: Record<string, unknown> }> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-tool-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  for (const id of registered.splice(0)) unregister(id)
})

beforeEach(() => {
  events = []
  // 测试宿主默认的 UI 发布口如实抛错（Node 没有事件总线）；这里换成记录器，
  // 让 deskpet-plan-* 进度/收尾事件可断言（产品侧 publish 的载荷原样记录）。
  setUiEventPublisher({ publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) } })
})

type Payload = { model: string; systemPrompt?: string; messages: readonly unknown[]; tools?: Array<{ name: string }> }

/** 某笔请求里指定工具的结果正文（toolResult 消息的 text 块）。 */
function toolResultTexts(payload: { messages: readonly unknown[] } | undefined, toolName: string): string[] {
  const texts: string[] = []
  for (const raw of payload?.messages ?? []) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || message.toolName !== toolName) continue
    texts.push(Array.isArray(message.content)
      ? message.content.map(part => {
        const block = part as { type?: string; text?: string }
        return block.type === "text" ? block.text ?? "" : ""
      }).join("\n")
      : String(message.content ?? ""))
  }
  return texts
}

/** 一笔请求里所有消息的文本（用于确认子运行任务文本，不强绑消息条数/尾部注记形状）。 */
function payloadText(payload: Payload | undefined): string {
  return (payload?.messages ?? []).map(raw => {
    const content = (raw as { content?: unknown }).content
    return typeof content === "string" ? content
      : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("\n") : ""
  }).join("\n")
}

function planProgress(): Array<{ stepId: unknown; status: unknown }> {
  return events.filter(entry => entry.event === "deskpet-plan-progress")
    .map(entry => ({ stepId: entry.payload.stepId, status: entry.payload.status }))
}

function planEnds(): unknown[] {
  return events.filter(entry => entry.event === "deskpet-plan-end").map(entry => entry.payload.reason)
}

/** 步骤产出契约：只有 complete 才会让计划判完成，核验器也才会运行。 */
function stepComplete(summary: string): string {
  return JSON.stringify({ status: "complete", summary })
}
/** 不关心成功、但不想触发一次修复时用：合法 partial（会进失败门，但不再多一次修复请求）。 */
function stepPartial(summary: string, missing: string[]): string {
  return JSON.stringify({ status: "partial", summary, missing })
}
/** 计划核验器的确定性应答。 */
function planVerified(verdict: "pass" | "partial" | "fail", summary = "核验完成"): string {
  return JSON.stringify({ verdict, reasons: [], missing: [], drift: [], summary })
}

const TWO_STEPS = [
  { title: "收集", description: "列出当前目录", allowedTools: ["read"],
    inputs: "当前目录", deliverable: "目录清单", acceptance: "列出全部条目" },
  { description: "汇总结果", allowedTools: ["read"],
    inputs: "目录清单", deliverable: "汇总结论", acceptance: "结论覆盖清单" },
]

describe("提议计划", () => {
  it("普通输入直接交主模型，不因关键词或命令相似前缀先规划 [plan-model-entry]", async () => {
    for (const input of ["帮我分析和总结一下这段话", "你好呀", "/planet 是什么意思", "请解释 /plan 的作用"]) {
      await standardSetup("deny", "deny")
      setOverride("ai.plan.enabled", true)
      const provider = installFakeProvider([fakeText("直接回答这个问题")])
      const output = await runRuntimeTurn(input)
      expect(provider.state.callCount).toBe(1)
      expect(provider.payloads[0]?.tools?.map(tool => tool.name)).toContain(TOOL)
      expect(planRecords()).toEqual([])
      expect(output.reply).toContain("直接回答这个问题")
    }
  }, 60_000)

  it("显式 /plan 先生成并确认计划 [plan-force-trigger]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.plan.enabled", true)
    const provider = installFakeProvider([
      fakeText(JSON.stringify({ summary: "显式计划", steps: [{ id: 1, description: "收集信息", allowedTools: ["read"],
        inputs: "用户目标", deliverable: "信息清单", acceptance: "覆盖目标要点" }] })),
      fakeText(stepComplete("信息已收集")),
      fakeText(planVerified("pass")),
      fakeText("显式计划已完成"),
    ])
    await initChat()
    const output = await sendMessage("/plan 帮我看看")
    expect(provider.state.callCount).toBe(4)
    // 规划器的权限面与步骤子代理一致：派生型工具（到不了子运行）不进入可用工具清单。
    const plannerPrompt = provider.payloads[0]?.systemPrompt ?? ""
    expect(plannerPrompt, "规划器提示没有要求每步显式声明工具").toContain("每个步骤都必须给出非空 allowedTools")
    expect(plannerPrompt, "派生型工具不应进入规划器可用工具清单").not.toContain("- propose_plan:")
    expect(plannerPrompt, "派生型工具不应进入规划器可用工具清单").not.toContain("- agent_spawn:")
    expect(plannerPrompt, "可用工具清单缺少普通工具").toContain("- read:")
    expect(planRecords()).toEqual([expect.objectContaining({ confirmed: true, steps: 1 })])
    expect(planEnds()).toEqual(["done"])
    expect(output.reply).toContain("显式计划已完成")
  }, 60_000)

  it("用户确认后逐步执行并按既有格式返回结果（子运行真实执行、工具面按 allowedTools 收窄） [plan-tool-confirm-accept]", async () => {
    await standardSetup("deny", "auto")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_ACCEPT),
      fakeText(stepComplete("第一步完成：目录已列出")),
      fakeText(stepComplete("第二步完成：结果已汇总")),
      fakeText(planVerified("pass")),
      fakeText("计划都做完了"),
    ])

    const output = await runRuntimeTurn("帮我做一件需要确认的事")

    // 面板确认：测试通道按 planPolicy 应答，步骤数来自工具参数。
    expect(planRecords(), "确认请求没有携带模型给出的两步计划").toEqual([
      expect.objectContaining({ confirmed: true, mode: "auto", steps: 2 }),
    ])
    // 请求账：主回合 1 次 + 两个步骤子运行各 1 次 + 核验 1 次 + 收尾回复 1 次。
    expect(provider.state.callCount, `请求账不对（期望 5，实际 ${provider.state.callCount}）`).toBe(5)
    // 第一步真的作为子运行执行了模型给的步骤文本（不是就地伪执行）。
    expect(payloadText(provider.payloads[1] as Payload | undefined), "第一个步骤的子运行没有拿到步骤描述")
      .toContain("列出当前目录")
    // 步骤工具面按 allowedTools 收窄：子运行请求里只有 read，没有 bash。
    expect((provider.payloads[1] as Payload | undefined)?.tools?.map(tool => tool.name) ?? [],
      "步骤子运行的工具面没有按 allowedTools 收窄").toEqual(["read"])

    // 执行结果按既有 formatStepResults 格式进入工具结果（含回读地址）。
    const results = toolResultTexts(provider.payloads[4] as Payload | undefined, TOOL)
    expect(results.length, "收尾请求里没有 propose_plan 的工具结果").toBe(1)
    const text = results[0]!
    expect(text, "工具结果不是既有计划结果格式").toContain("[计划执行结果]")
    expect(text, "步骤 1 没有记成完成").toContain('OK 步骤 1 "收集：列出当前目录"')
    expect(text, "步骤产出正文没有随结果返回").toContain("第一步完成：目录已列出")
    expect(text, "步骤 2 没有记成完成").toContain('OK 步骤 2 "汇总结果"')
    expect(text, "结果缺少 plan_step_result 回读地址（步骤原文应当可回读）").toContain("原文见 plan_step_result 条目")

    // 进度与收尾事件（面板按它们渲染执行态并收起）。
    expect(planProgress(), "计划步骤进度事件不对（面板会看不到执行过程）").toEqual([
      { stepId: "1", status: "running" }, { stepId: "1", status: "done" },
      { stepId: "2", status: "running" }, { stepId: "2", status: "done" },
    ])
    expect(planEnds(), "计划收尾事件不对").toEqual(["done"])
    // 计划记录落盘为完成态（崩溃恢复/面板读同一份记录）。
    expect(planCheckpointStore.snapshot(`plan-${PLAN_CALL_ID_ACCEPT}`)?.plan.state, "计划记录没有落成完成态").toBe("done")
    // 验收档落盘按证据闭环：两步都没有未确认效果与证据缺口 → verified（不证明业务正确）。
    const persisted = await planCheckpointStore.readStepResults(getActiveSessionId(), `plan-${PLAN_CALL_ID_ACCEPT}`)
    expect(persisted.map(item => item.acceptance).sort(), "步骤结果的验收档没有按证据闭环落盘").toEqual(["verified", "verified"])

    // 成功收尾取走交付暂存但不写系统消息：兜底摘要只在最终回复失败时出现。
    expect(
      chatHistory.some(message => message.role === "system" && message.text.includes("计划步骤已执行结束")),
      "成功回合不应留下交付兜底系统消息",
    ).toBe(false)
    expect(output.failure, `回合以失败结算：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(output.reply, "回合没有以模型正文收尾").toContain("计划都做完了")
  }, 60_000)

  it("计划目标绑定本轮可信用户原文，模型转述不能替换 [plan-intent-binding]", async () => {
    await standardSetup("deny", "auto")
    const callId = "plan-call-intent"
    const userText = "把资料收齐后给我结论"
    const provider = installFakeProvider([
      // 模型多给的 intent 不在工具参数里，也不能覆盖用户事实。
      fakeToolCall(TOOL, {
        summary: "模型摘要",
        intent: "模型改写的目标",
        steps: [{ description: "收集资料", allowedTools: ["read"],
          inputs: "用户目标", deliverable: "资料清单", acceptance: "资料覆盖目标" }],
      }, callId),
      fakeText(stepComplete("资料已收齐")),
      fakeText(planVerified("pass")),
      fakeText("结论如下"),
    ])

    const output = await runRuntimeTurn(userText, {
      // 可信用户事实只从宿主入口来：这条 L3 入口默认没有身份，这里补一份与生产同形的用户信封。
      ingress: {
        schemaVersion: 1,
        requestId: "req-plan-intent",
        origin: "user",
        querySource: "chat",
        rawText: userText,
        normalizedText: userText,
        receivedAt: Date.now(),
        priority: "now",
        taint: "trusted_user",
      },
    })

    const record = planCheckpointStore.snapshot(`plan-${callId}`)?.plan
    expect(record?.intent, "计划记录的目标不是本轮用户原文").toBe(userText)
    expect(record?.intent, "模型转述覆盖了用户目标").not.toContain("模型改写")
    const stepPayload = provider.payloads[1] as Payload | undefined
    // 计划目标随步骤系统提示下发（task 正文只是步骤描述）。
    const stepPrompt = stepPayload?.systemPrompt ?? ""
    expect(stepPrompt, "步骤子运行没有拿到用户原文").toContain(userText)
    expect(stepPrompt, "步骤子运行拿到了模型改写的目标").not.toContain("模型改写的目标")
    expect(stepPrompt, "步骤子运行把模型摘要当成了目标").not.toContain("模型摘要")
    expect(output.reply).toContain("结论如下")
  }, 60_000)

  it("主回合可按步骤结果地址读回完整产出 [plan-tool-result-readback]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    const callId = "plan-call-readback"
    const tail = `尾部标记-${crypto.randomUUID()}`
    const longReply = `开头-${"长".repeat(200)}-${tail}`
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "可回读计划", steps: [{ description: "产出长文", allowedTools: ["read"],
        inputs: "当前目录", deliverable: "长文产出", acceptance: "包含尾部标记" }] }, callId),
      fakeText(stepComplete(longReply)),
      fakeText(planVerified("pass")),
      context => {
        const planResult = toolResultTexts({ messages: context.messages }, TOOL)[0] ?? ""
        const match = planResult.match(/plan_step_result 条目 ([^\s）]+)/)
        expect(match, `提议计划的结果里没有步骤结果地址: ${planResult}`).not.toBeNull()
        // 用少一位的前缀而不是完整 id：计划步骤产出必须进同一个地址命名空间才可能解析到。
        // 不能拍脑袋截固定长度 —— UUIDv7 同毫秒条目的前 12 位可能完全相同，那会变成歧义而非前缀测试。
        return fakeToolCall("read_session_event", { eventId: match![1]!.slice(0, -1) }, "read-plan-result")
      },
      fakeText("步骤原文已取回"),
    ])

    const output = await runRuntimeTurn("跑一个可以回读的计划")

    expect(provider.state.callCount).toBe(5)
    // 步骤结果只带截断预览：完整正文要靠回读地址取回。
    const preview = toolResultTexts(provider.payloads[3] as Payload, TOOL)[0] ?? ""
    expect(preview).toContain("原文见 plan_step_result 条目")
    // 摘要字段属于模型可见结论，长摘要会随「摘要:」行出现；被截断的是「结果:」预览行。
    const previewLine = preview.split("\n").find(line => line.trim().startsWith("结果:")) ?? ""
    expect(previewLine, "结果预览没有被截断（完整正文应由回读地址取回）").not.toContain(tail)
    const readback = toolResultTexts(provider.payloads[4] as Payload, "read_session_event")[0] ?? ""
    expect(readback, "读回结果没有说明这是计划步骤产出").toContain("[计划步骤结果]")
    expect(readback, "读回结果没有带步骤标题").toContain("产出长文")
    expect(readback, "读回结果没有恢复被截断的尾部").toContain(tail)
    expect(output.reply).toContain("步骤原文已取回")
  }, 60_000)

  it("计划步骤跑完但最终回复失败：结果以系统消息交付 [plan-tool-delivery-fallback]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, "plan-call-delivery"),
      fakeText(stepComplete("第一步完成：目录已列出")),
      fakeText(stepComplete("第二步完成：结果已汇总")),
      fakeText(planVerified("pass")),
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "final reply failed" }),
    ])

    const output = await runRuntimeTurn("执行计划后最终回复失败")
    expect(output.failure, "用例没有走到最终回复失败").toBeDefined()

    // 结果不随最终回复一起消失：中性摘要作为系统消息落进会话，步骤正文与回读地址不进。
    const systemTexts = chatHistory.filter(message => message.role === "system").map(message => message.text)
    const delivery = systemTexts.find(text => text.includes("计划步骤已执行结束"))
    expect(delivery, "最终回复失败时计划结果没有作为系统消息交付").toBeDefined()
    expect(delivery).toContain("2/2 步完成")
    expect(delivery).toContain("步骤 1「收集：列出当前目录」：完成")
    expect(delivery).toContain("步骤 2「汇总结果」：完成")
    expect(delivery).not.toContain("第一步完成：目录已列出")
    expect(delivery).not.toContain("plan_step_result")
  }, 60_000)

  it("非只读工具失败时计划判失败、步骤不冒充完成 [plan-tool-effect-receipt]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    const tool = defineTool({
      id: "plan-tool-effect-probe", name: "plan_effect_write", description: "计划效果回执探针",
      parameters: { type: "object", properties: {} }, safetyLevel: "SAFE",
      source: "local", sourceId: "", actionCategory: "_default",
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "passthrough" },
        execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
        context: { resultProjection: "preserve", historyCompaction: "summarize" },
      },
    }, async () => ({ success: false, content: "", error: "写入中断" }))
    register(tool)
    registered.push(tool.id)
    const callId = "plan-call-effect"
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "写配置", steps: [{ description: "写入配置", allowedTools: [tool.name],
        inputs: "当前配置", deliverable: "写入后的配置", acceptance: "配置写入成功" }] }, callId),
      fakeToolCall(tool.name, {}, "effect-write-call"),
      fakeText(stepPartial("配置已经写好了", ["写入失败，执行效果未确认"])),
      fakeText("计划没有完成"),
    ])

    const output = await runRuntimeTurn("帮我写入配置")

    expect(output.failure, `回合失败：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(output.reply).toContain("计划没有完成")
    const record = planCheckpointStore.snapshot(`plan-${callId}`)
    expect(record?.plan.state, "未确认效果的失败步骤把计划洗成了成功").toBe("failed")
    expect(record?.steps.map(step => step.state)).toEqual(["partial"])
    const persisted = await planCheckpointStore.readStepResults(getActiveSessionId(), `plan-${callId}`)
    expect(persisted[0]?.acceptance, "失败步骤的验收档不应是 verified").toBe("unverified")
    const result = toolResultTexts(provider.payloads[3] as Payload, TOOL)[0]
    expect(result, "工具结果没有如实报告失败").toContain("整体结果：失败或未完成")
    expect(result, "工具结果没有说明效果未确认").toContain("未确认")
  }, 60_000)

  it("失败后选择继续，后续成功也保留工具、面板和持久计划的失败结果 [plan-tool-continue-failure]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    setOverride("ai.plan.onStepFailure", "ask")
    const callId = "plan-call-continue-failure"
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "失败后继续", steps: TWO_STEPS }, callId),
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request: step rejected" }),
      fakeText(stepComplete("第二步完成")),
      fakeText(planVerified("pass")),
      fakeText("第一步失败，第二步完成"),
    ])
    const output = await runRuntimeTurn("执行两步，失败时让我选择是否继续")
    expect(output.failure).toBeUndefined()
    expect(provider.state.callCount).toBe(5)
    expect(planInteractionRecords().filter(item => item.kind === "step_gate").map(item => item.decision)).toEqual(["continue"])
    expect(toolResultTexts(provider.payloads[4] as Payload, TOOL)[0]).toContain("整体结果：部分完成（1/2 步）")
    expect(provider.payloads[4]?.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: TOOL, isError: true }))
    expect(planEnds()).toEqual(["failed"])
    const record = planCheckpointStore.snapshot(`plan-${callId}`)
    expect(record?.plan.state).toBe("failed")
    expect(record?.steps.map(step => step.state)).toEqual(["failed", "done"])
  }, 60_000)

  it("恢复入口拒绝重放未处置的效果步骤且不请求模型 [plan-recovery-effect-guard]", async () => {
    await standardSetup("deny", "auto")
    const provider = installFakeProvider([fakeText("开始恢复检查")])
    await runRuntimeTurn("恢复检查")
    const sessionId = getActiveSessionId(), now = Date.now(), planId = "plan-effect-guard"
    await planCheckpointStore.create({ schemaVersion: 4, planId, sessionId, rootTurnId: planId, intent: "恢复检查",
      state: "running", summary: "恢复检查", estimatedComplexity: 1, version: 1, createdAt: now, updatedAt: now }, [
      { planId, stepId: "1", title: "已产生效果", allowedTools: ["write"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", state: "running", attempt: 1, effectClass: "external_side_effect", updatedAt: now },
    ])
    await planCheckpointStore.checkpointTool(planId, "1", "tool_start", "write", "effect-write", "external_side_effect")
    await planCheckpointStore.checkpointTool(planId, "1", "tool_end", "write", "effect-write", "external_side_effect", true)
    await planCheckpointStore.checkpointTool(planId, "1", "tool_end", "read", "later-read", "read_only", true)
    planCheckpointStore.reset()
    await planCheckpointStore.recover(sessionId)
    expect(await resumePlan(sessionId, planId)).toBeUndefined()
    expect(provider.state.callCount).toBe(1)
    expect(planCheckpointStore.snapshot(planId)?.steps[0]).toMatchObject({ state: "unknown_side_effect", attempt: 1 })
    expect(planEnds()).toEqual([])
  }, 60_000)

  it("同进程继续中断步骤先核对效果，明确重跑只增加一次尝试 [plan-resume-interrupted-step]", async () => {
    for (const hasEffect of [false, true]) {
      await standardSetup("deny", "auto")
      setOverride("ai.memory.enabled", false)
      // 请求账：初始回合 1 次 + 剩余步骤 1 次 + 计划级核验 1 次（恢复同样要核验）。
      const provider = installFakeProvider([
        fakeText("准备就绪"),
        fakeText(stepComplete("剩余步骤完成")),
        fakeText(planVerified("pass")),
      ])
      await runRuntimeTurn("准备就绪")
      const sessionId = getActiveSessionId(), now = Date.now(), planId = `plan-interrupted-${hasEffect}`
      await planCheckpointStore.create({ schemaVersion: 4, planId, sessionId, rootTurnId: planId, intent: "继续中断步骤",
        state: "running", summary: "继续中断步骤", estimatedComplexity: 1, version: 1, createdAt: now, updatedAt: now }, [
        { planId, stepId: "1", title: "核对剩余工作", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", state: "pending", attempt: 0, effectClass: "external_side_effect", updatedAt: now },
      ])
      await planCheckpointStore.transitionStep(planId, "1", "running")
      if (hasEffect) await planCheckpointStore.checkpointTool(planId, "1", "tool_start", "write", "interrupted-write", "external_side_effect")
      await planCheckpointStore.checkpointTool(planId, "1", "tool_end", "read", "interrupted-read", "read_only", true)
      await planCheckpointStore.transitionStep(planId, "1", "interrupted")
      await planCheckpointStore.transitionPlan(planId, "interrupted")
      const firstResume = await resumePlan(sessionId, planId)
      if (hasEffect) {
        expect(firstResume).toBeUndefined()
        expect(provider.state.callCount).toBe(1)
        expect(planCheckpointStore.snapshot(planId)?.steps[0]).toMatchObject({ state: "unknown_side_effect", attempt: 1 })
        await planCheckpointStore.resolveUnknownSideEffect(planId, "1", "retry")
        expect(await resumePlan(sessionId, planId)).toBeDefined()
      } else {
        expect(firstResume).toBeDefined()
      }
      // 两条路径（无副作用直接重跑 / 处置后重跑）都是「跑一步 + 核验一次」：
      // 初始回合 1、步骤 1、核验 1。核验没有 pass 结论时完成度不能顶替，计划会收成 failed。
      expect(provider.state.callCount).toBe(3)
      // payloads[1] 是步骤子运行、payloads[2] 是核验器；步骤提示只从 payloads[1] 取。
      expect(payloadText(provider.payloads[1] as Payload)).toContain("核对剩余工作")
      expect(planCheckpointStore.snapshot(planId)?.plan.state).toBe("done")
      expect(planCheckpointStore.snapshot(planId)?.steps[0]).toMatchObject({ state: "done", attempt: 2 })
    }
  }, 60_000)

  it("恢复执行从会话条目回读前序结果并交给后续步骤 [plan-resume-prior-from-disk]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    const token = `resume-token-${crypto.randomUUID()}`
    const provider = installFakeProvider([
      fakeText("准备就绪"),
      fakeText(stepComplete("第二步完成")),
      fakeText(planVerified("pass")),
    ])
    await runRuntimeTurn("准备就绪")
    const sessionId = getActiveSessionId(), now = Date.now(), planId = "plan-resume-prior"
    await planCheckpointStore.create({ schemaVersion: 4, planId, sessionId, rootTurnId: planId, intent: "恢复时交接前序结果",
      state: "interrupted", summary: "恢复交接", estimatedComplexity: 2, version: 1, createdAt: now, updatedAt: now }, [
      { planId, stepId: "1", title: "产出令牌", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", state: "done", attempt: 1, effectClass: "read_only", updatedAt: now },
      { planId, stepId: "2", title: "消费令牌", allowedTools: ["read"], inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", state: "pending", attempt: 0, effectClass: "read_only", updatedAt: now },
    ])
    // 结果只存在于会话条目里（进程内没有这次执行的结果对象），恢复时必须从盘上回读。
    const entryId = await planCheckpointStore.writeStepResult(sessionId, {
      planId, stepId: "1", title: "产出令牌", acceptance: "unverified", index: 0,
      success: true, durationMs: 10, toolCallsMade: 0, reply: `第一步产出 ${token}`, summaryHash: "resume-prior-hash",
    })
    expect(entryId).toBeTruthy()

    const resumed = await resumePlan(sessionId, planId)
    expect(resumed).toBeDefined()
    // 只跑剩余步骤：初始回合 1 次请求 + 第二步 1 次请求 + 计划级核验 1 次请求，已完成的步骤不重跑。
    // 恢复同样过核验：没有 pass 结论时完成度不能顶替核验，计划会收成 failed。
    expect(provider.state.callCount).toBe(3)
    // payloads[1] 是第二步本身、payloads[2] 是核验器（核验提示不复用步骤上下文）。
    expect((provider.payloads[1] as Payload | undefined)?.messages).toBeDefined()
    const stepPrompt = (provider.payloads[1] as Payload | undefined)?.systemPrompt ?? ""
    expect(stepPrompt).toContain(token)
    // 状态与摘要随盘上结果一起交接；地址不交接 —— 子运行读不到父会话条目。
    expect(stepPrompt).toContain("[complete] 产出令牌")
    expect(stepPrompt).not.toContain(entryId!)
    expect(stepPrompt).not.toContain("plan_step_result")

    const record = planCheckpointStore.snapshot(planId)
    expect(record?.plan.state).toBe("done")
    expect(record?.steps.map(step => step.state)).toEqual(["done", "done"])
    expect(record?.plan.completion).toBe("complete")
  }, 60_000)

  it("恢复执行的核验拿到完整计划与已定档步骤产出 [plan-resume-verification-full-plan]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    const token = `resume-verify-token-${crypto.randomUUID()}`
    const provider = installFakeProvider([
      fakeText("准备就绪"),
      fakeText(stepComplete("第二步完成")),
      fakeText(planVerified("pass")),
    ])
    await runRuntimeTurn("准备就绪")
    const sessionId = getActiveSessionId(), now = Date.now(), planId = "plan-resume-verify-full"
    await planCheckpointStore.create({ schemaVersion: 4, planId, sessionId, rootTurnId: planId, intent: "恢复时核验完整计划",
      state: "interrupted", summary: "恢复核验", estimatedComplexity: 2, version: 1, createdAt: now, updatedAt: now }, [
      { planId, stepId: "1", title: "产出令牌", allowedTools: ["read"], inputs: "输入一", deliverable: "令牌", acceptance: "令牌产出", state: "done", attempt: 1, effectClass: "read_only", updatedAt: now },
      { planId, stepId: "2", title: "消费令牌", allowedTools: ["read"], inputs: "输入二", deliverable: "结果", acceptance: "结果产出", state: "pending", attempt: 0, effectClass: "read_only", updatedAt: now },
    ])
    await planCheckpointStore.writeStepResult(sessionId, {
      planId, stepId: "1", title: "产出令牌", acceptance: "verified", index: 0,
      success: true, durationMs: 10, toolCallsMade: 0, reply: `第一步产出 ${token}`,
      outcome: { status: "complete", summary: `第一步产出 ${token}` },
      summaryHash: "resume-verify-hash",
    })

    expect(await resumePlan(sessionId, planId)).toBeDefined()
    // 初始回合 1 次 + 剩余步骤 1 次 + 计划级核验 1 次。
    expect(provider.state.callCount).toBe(3)
    // 核验必须看到整份计划：恢复只执行 pending/running，已定档步骤的工作单与产出同样是核验证据。
    const verifierPrompt = (provider.payloads[2] as Payload | undefined)?.systemPrompt ?? ""
    expect(verifierPrompt).toContain("## 原始目标")
    expect(verifierPrompt).toContain("恢复时核验完整计划")
    expect(verifierPrompt, "核验提示缺少已定档步骤的工作单").toContain("步骤 1「产出令牌」")
    expect(verifierPrompt).toContain("输入一")
    expect(verifierPrompt, "核验提示缺少已定档步骤的产出").toContain(token)
    expect(verifierPrompt, "已定档步骤被当成未执行").not.toContain("本次执行没有跑到这一步")
    expect(verifierPrompt, "核验提示缺少本次执行的步骤").toContain("步骤 2「消费令牌」")
    expect(verifierPrompt).toContain("输入二")

    expect(planCheckpointStore.snapshot(planId)?.steps.map(step => step.state)).toEqual(["done", "done"])
    expect(planCheckpointStore.snapshot(planId)?.plan.state, "核验通过且全部步骤完成后计划应落 done").toBe("done")
  }, 60_000)

  it("恢复执行的核验用本次产出覆盖同一步的盘上旧结果 [plan-resume-verification-current-wins]", async () => {
    await standardSetup("deny", "auto")
    setOverride("ai.memory.enabled", false)
    const oldToken = `resume-old-token-${crypto.randomUUID()}`
    const newToken = `resume-new-token-${crypto.randomUUID()}`
    const provider = installFakeProvider([
      fakeText("准备就绪"),
      fakeText(stepComplete(`本次产出 ${newToken}`)),
      fakeText(planVerified("pass")),
    ])
    await runRuntimeTurn("准备就绪")
    const sessionId = getActiveSessionId(), now = Date.now(), planId = "plan-resume-verify-current"
    // 结果已落盘、步骤状态还没定档就中断：恢复会把这一步重新执行，核验同时拿到两条同 id 记录。
    await planCheckpointStore.create({ schemaVersion: 4, planId, sessionId, rootTurnId: planId, intent: "恢复时覆盖旧产出",
      state: "interrupted", summary: "恢复覆盖", estimatedComplexity: 1, version: 1, createdAt: now, updatedAt: now }, [
      { planId, stepId: "1", title: "重跑步骤", allowedTools: ["read"], inputs: "输入", deliverable: "产出", acceptance: "产出可用", state: "pending", attempt: 0, effectClass: "read_only", updatedAt: now },
    ])
    await planCheckpointStore.writeStepResult(sessionId, {
      planId, stepId: "1", title: "重跑步骤", acceptance: "verified", index: 0,
      success: true, durationMs: 10, toolCallsMade: 0, reply: `上次产出 ${oldToken}`,
      outcome: { status: "complete", summary: `上次产出 ${oldToken}` },
      summaryHash: "resume-current-wins-hash",
    })

    expect(await resumePlan(sessionId, planId)).toBeDefined()
    expect(provider.state.callCount).toBe(3)
    const verifierPrompt = (provider.payloads[2] as Payload | undefined)?.systemPrompt ?? ""
    expect(verifierPrompt, "核验提示缺少本次执行的产出").toContain(newToken)
    expect(verifierPrompt, "核验沿用了同一步的盘上旧结果").not.toContain(oldToken)
    expect(planCheckpointStore.snapshot(planId)?.plan.state).toBe("done")
  }, 60_000)

  it("用户取消：一步都不执行、记录如实收尾、工具结果说明未执行任何步骤 [plan-tool-user-cancel]", async () => {
    await standardSetup("deny", "deny")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_DENY),
      fakeText("那我先不做了"),
    ])

    const output = await runRuntimeTurn("帮我做一件需要确认的事")

    expect(planRecords(), "确认请求没有到达面板").toEqual([
      expect.objectContaining({ confirmed: false, steps: 2 }),
    ])
    // 一步都没跑：请求账只有主回合与收尾（步骤执行会多出子运行请求）。
    expect(provider.state.callCount, "取消后仍发生了步骤执行（请求账多于 2）").toBe(2)
    expect(planProgress(), "取消的计划不该有步骤进度事件").toEqual([])
    expect(planEnds(), "取消后没有收起计划面板").toEqual(["cancelled"])

    const results = toolResultTexts(provider.payloads[1] as Payload | undefined, TOOL)
    expect(results.length, "收尾请求里没有 propose_plan 的工具结果").toBe(1)
    expect(results[0], "取消结果没有如实说明未执行").toContain("用户取消了计划确认")
    expect(results[0], "取消结果没有如实说明未执行").toContain("未执行任何步骤")
    expect(results[0], "取消结果谎报了执行结果").not.toContain("[计划执行结果]")

    // 记录落盘：步骤全部 skipped、计划 failed（与显式命令入口的用户拒绝同一归宿）。
    const record = planCheckpointStore.snapshot(`plan-${PLAN_CALL_ID_DENY}`)
    expect(record?.plan.state, "用户取消的计划没有落成 failed").toBe("failed")
    expect(record?.steps.map(step => step.state), "用户取消的步骤没有标 skipped").toEqual(["skipped", "skipped"])

    expect(output.reply, "回合没有以模型正文收尾").toContain("那我先不做了")
  }, 60_000)

  it("逐步确认模式：每步开工前都过既有步骤裁决面板 [plan-tool-step-gate]", async () => {
    await standardSetup("deny", "stepByStep")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_STEP),
      fakeText(stepComplete("第一步完成")),
      fakeText(stepComplete("第二步完成")),
      fakeText(planVerified("pass")),
      fakeText("两步都过完了"),
    ])

    const output = await runRuntimeTurn("帮我逐步确认着做")

    expect(planRecords()[0], "逐步模式没有按 stepByStep 确认").toEqual(expect.objectContaining({ mode: "stepByStep", steps: 2 }))
    const gates = planInteractionRecords().filter(item => item.kind === "step_gate")
    expect(gates.map(item => item.decision), "逐步门没有逐步放行").toEqual(["continue", "continue"])
    const results = toolResultTexts(provider.payloads[4] as Payload | undefined, TOOL)
    expect(results[0], "逐步执行的结果没有按既有格式返回").toContain("[计划执行结果]")
    expect(output.reply).toContain("两步都过完了")
  }, 60_000)

  it("参数准入拒绝：不开面板、不落计划、理由点名到步 [plan-tool-admission-rejects]", async () => {
    await standardSetup("deny", "deny")
    const overLimit = Array.from({ length: planConfig.maxSteps + 1 }, (_, index) => ({
      description: `第 ${index + 1} 件事`, inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", allowedTools: ["read"],
    }))
    const provider = installFakeProvider([
      // 其余必填字段给全，只留空 description：让自定义校验（而不是 schema）给出点名到步的理由。
      fakeToolCall(TOOL, { steps: [{ description: "", title: "", inputs: "测试输入", deliverable: "测试产出", acceptance: "测试通过", allowedTools: ["read"] }] }, "plan-bad-1"),
      fakeToolCall(TOOL, { steps: [{ description: "查点东西", allowedTools: ["definitely_missing_tool"],
        inputs: "查询目标", deliverable: "查询结果", acceptance: "查到了东西" }] }, "plan-bad-2"),
      fakeToolCall(TOOL, { steps: [{ description: "让子代理再提议", allowedTools: ["agent_spawn"],
        inputs: "用户目标", deliverable: "子计划", acceptance: "子计划可用" }] }, "plan-bad-3"),
      fakeToolCall(TOOL, { steps: overLimit }, "plan-bad-4"),
      fakeText("前四个都收到错误了"),
      // 连续失败 5 次会触发工具循环硬终止：依赖准入的坏调用放在下一回合，避免被治理截断。
      fakeToolCall(TOOL, { steps: [
        { description: "前置", allowedTools: ["read"], inputs: "用户目标", deliverable: "前置产出", acceptance: "前置完成" },
        { description: "依赖未来步骤", allowedTools: ["read"], inputs: "前置产出", deliverable: "后续产出", acceptance: "后续完成", dependsOn: [2] },
      ] }, "plan-bad-5"),
      fakeToolCall(TOOL, { steps: [
        { description: "前置", allowedTools: ["read"], inputs: "用户目标", deliverable: "前置产出", acceptance: "前置完成" },
        { description: "空依赖", allowedTools: ["read"], inputs: "前置产出", deliverable: "后续产出", acceptance: "后续完成", dependsOn: [] },
      ] }, "plan-bad-6"),
      fakeText("依赖错误也收到了"),
    ])

    await runRuntimeTurn("给我一连串坏计划")
    const output = await runRuntimeTurn("再来两个依赖有问题的计划")

    const last = provider.payloads[provider.payloads.length - 1] as Payload | undefined
    const results = toolResultTexts(last, TOOL)
    expect(results.length, "六次坏调用都应有工具结果").toBe(6)
    expect(results[0], "缺 description 的步骤没有被拒绝").toContain("缺少 description")
    expect(results[1], "不存在的工具名没有被拒绝").toContain("指定的工具不存在")
    expect(results[2], "派生型工具没有被拒绝（子代理不派生）").toContain("不可用于子代理")
    expect(results[3], "超过 maxSteps 的步骤没有被拒绝").toContain("步骤过多")
    expect(results[4], "前向依赖没有被拒绝").toContain("只能引用更早的步骤 id")
    expect(results[5], "空 dependsOn 没有被拒绝").toContain("dependsOn 必须是非空步骤 id 数组")
    // 关键否定：被拒绝的提议不得开面板、不得落计划、不得执行。
    expect(planRecords(), "被拒绝的提议仍然开了确认面板").toEqual([])
    expect(planProgress(), "被拒绝的提议仍产出了进度事件").toEqual([])
    expect(planEnds()).toEqual([])
    expect(output.reply).toContain("依赖错误也收到了")
  }, 60_000)

  it("Schema 层拒绝（steps 为空）同样不开面板 [plan-tool-schema-reject]", async () => {
    await standardSetup("deny", "deny")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { steps: [] }, "plan-schema-bad"),
      fakeText("知道了"),
    ])

    await runRuntimeTurn("给我一个空计划")

    const last = provider.payloads[provider.payloads.length - 1] as Payload | undefined
    const results = toolResultTexts(last, TOOL)
    expect(results.length, "空 steps 的工具调用应得到错误结果").toBe(1)
    expect(results[0], "空 steps 的错误没有指向工具参数校验").toContain(TOOL)
    expect(planRecords(), "空 steps 不应到达确认面板").toEqual([])
    expect(planProgress()).toEqual([])
  }, 60_000)

  it("just_do_it 跳过确认面板：直接执行、结果如实标注未经面板 [plan-tool-just-do-it]", async () => {
    await standardSetup("deny", "deny")
    // just_do_it 写进 CONFIG `ai.safety.mode`（2026-10-06 起安全模式只有这一条轴；
    // standardSetup 的配置隔离已把它钉在 tell_me）；用例结束按原值还原，避免残留
    // 影响后续需要确认通道的用例。
    const previousSafetyMode = getOverride<string>("ai.safety.mode")
    setOverride("ai.safety.mode", "just_do_it")
    try {
      const provider = installFakeProvider([
        fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_AUTO),
        fakeText(stepComplete("第一步完成：目录已列出")),
        fakeText(stepComplete("第二步完成：结果已汇总")),
        fakeText(planVerified("pass")),
        fakeText("没弹面板也做完了"),
      ])

      const output = await runRuntimeTurn("帮我做一件需要确认的事")

      // 策略点：just_do_it 跳过确认面板 —— 没有任何确认请求到达面板通道。
      expect(planRecords(), "just_do_it 下仍然开了确认面板").toEqual([])
      // 没有 PLAN_START 就没有面板：进度事件只会在宿主侧落成「找不到对应计划」。
      expect(planProgress(), "just_do_it 没有确认面板，不该发布进度事件").toEqual([])
      // 步骤仍真实执行（请求账：主回合 1 + 两个步骤子运行 + 核验 1 + 收尾 1）。
      expect(provider.state.callCount, `请求账不对（期望 5，实际 ${provider.state.callCount}）`).toBe(5)
      // 工具结果如实标注「未经面板确认」，并仍是既有计划结果格式。
      const results = toolResultTexts(provider.payloads[4] as Payload | undefined, TOOL)
      expect(results.length, "收尾请求里没有 propose_plan 的工具结果").toBe(1)
      expect(results[0], "结果没有如实标注未经面板确认").toContain("未经面板确认直接执行")
      expect(results[0], "结果不是既有计划结果格式").toContain("[计划执行结果]")
      // 记录落完成态、面板收起事件照发（没弹过面板也不留悬挂状态）。
      expect(planCheckpointStore.snapshot(`plan-${PLAN_CALL_ID_AUTO}`)?.plan.state, "自动模式执行完的计划没有落完成态").toBe("done")
      expect(planEnds(), "计划收尾事件不对").toEqual(["done"])
      expect(output.reply, "回合没有以模型正文收尾").toContain("没弹面板也做完了")
    } finally {
      setOverride("ai.safety.mode", previousSafetyMode)
    }
  }, 60_000)
})
