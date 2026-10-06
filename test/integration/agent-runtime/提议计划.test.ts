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
// ⑤ 计划步骤按 allowedTools 收窄工具面（子运行请求里只有 read，没有 bash）。
//
// 归属 L3（不是 L2）的理由：跑真实 agent loop、真工具执行（propose_plan → executePlan →
// 子运行）与真 JSONL 落盘，且 import `@/services/engine/harness`（规则 6 的 L2 禁入清单）。
// 只替换 Provider（fake 脚本）与执行许可（Node 宿主没有 Rust 许可内核），
// 确认面板用测试宿主的确定性应答（`test/host/plan-confirm-channel.ts`，与 L4 同一设施）。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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
import { planConfig } from "@/services/config"
import { initPaths } from "@/services/paths"

/** 工具名是线上契约（测试手写见证，不 import 实现常量）。 */
const TOOL = "propose_plan"
const PLAN_CALL_ID_ACCEPT = "plan-call-accept"
const PLAN_CALL_ID_DENY = "plan-call-deny"
const PLAN_CALL_ID_STEP = "plan-call-step"

let root = ""
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

beforeEach(() => {
  events = []
  // 测试宿主默认的 UI 发布口如实抛错（Node 没有事件总线）；这里换成记录器，
  // 让 deskpet-plan-* 进度/收尾事件可断言（产品侧 publish 的载荷原样记录）。
  setUiEventPublisher({ publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) } })
})

type Payload = { model: string; messages: readonly unknown[]; tools?: Array<{ name: string }> }

/** 某笔请求里指定工具的结果正文（toolResult 消息的 text 块）。 */
function toolResultTexts(payload: Payload | undefined, toolName: string): string[] {
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

const TWO_STEPS = [
  { title: "收集", description: "列出当前目录", allowedTools: ["read"] },
  { description: "汇总结果", allowedTools: ["read"] },
]

describe("提议计划", () => {
  it("用户确认后逐步执行并按既有格式返回结果（子运行真实执行、工具面按 allowedTools 收窄） [plan-tool-confirm-accept]", async () => {
    await standardSetup("deny", "auto")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_ACCEPT),
      fakeText("第一步完成：目录已列出"),
      fakeText("第二步完成：结果已汇总"),
      fakeText("计划都做完了"),
    ])

    const output = await runRuntimeTurn("帮我做一件需要确认的事")

    // 面板确认：测试通道按 planPolicy 应答，步骤数来自工具参数。
    expect(planRecords(), "确认请求没有携带模型给出的两步计划").toEqual([
      expect.objectContaining({ confirmed: true, mode: "auto", steps: 2 }),
    ])
    // 请求账：主回合 1 次 + 两个步骤子运行各 1 次 + 收尾回复 1 次。
    expect(provider.state.callCount, `请求账不对（期望 4，实际 ${provider.state.callCount}）`).toBe(4)
    // 第一步真的作为子运行执行了模型给的步骤文本（不是就地伪执行）。
    expect(payloadText(provider.payloads[1] as Payload | undefined), "第一个步骤的子运行没有拿到步骤描述")
      .toContain("列出当前目录")
    // 步骤工具面按 allowedTools 收窄：子运行请求里只有 read，没有 bash。
    expect((provider.payloads[1] as Payload | undefined)?.tools?.map(tool => tool.name) ?? [],
      "步骤子运行的工具面没有按 allowedTools 收窄").toEqual(["read"])

    // 执行结果按既有 formatStepResults 格式进入工具结果（含回读地址）。
    const results = toolResultTexts(provider.payloads[3] as Payload | undefined, TOOL)
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

    expect(output.failure, `回合以失败结算：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(output.reply, "回合没有以模型正文收尾").toContain("计划都做完了")
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

    // 记录落盘：步骤全部 skipped、计划 failed（与自动入口的用户拒绝同一归宿）。
    const record = planCheckpointStore.snapshot(`plan-${PLAN_CALL_ID_DENY}`)
    expect(record?.plan.state, "用户取消的计划没有落成 failed").toBe("failed")
    expect(record?.steps.map(step => step.state), "用户取消的步骤没有标 skipped").toEqual(["skipped", "skipped"])

    expect(output.reply, "回合没有以模型正文收尾").toContain("那我先不做了")
  }, 60_000)

  it("逐步确认模式：每步开工前都过既有步骤裁决面板 [plan-tool-step-gate]", async () => {
    await standardSetup("deny", "stepByStep")
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { summary: "两步计划", steps: TWO_STEPS }, PLAN_CALL_ID_STEP),
      fakeText("第一步完成"),
      fakeText("第二步完成"),
      fakeText("两步都过完了"),
    ])

    const output = await runRuntimeTurn("帮我逐步确认着做")

    expect(planRecords()[0], "逐步模式没有按 stepByStep 确认").toEqual(expect.objectContaining({ mode: "stepByStep", steps: 2 }))
    const gates = planInteractionRecords().filter(item => item.kind === "step_gate")
    expect(gates.map(item => item.decision), "逐步门没有逐步放行").toEqual(["continue", "continue"])
    const results = toolResultTexts(provider.payloads[3] as Payload | undefined, TOOL)
    expect(results[0], "逐步执行的结果没有按既有格式返回").toContain("[计划执行结果]")
    expect(output.reply).toContain("两步都过完了")
  }, 60_000)

  it("参数准入拒绝：不开面板、不落计划、理由点名到步 [plan-tool-admission-rejects]", async () => {
    await standardSetup("deny", "deny")
    const overLimit = Array.from({ length: planConfig.maxSteps + 1 }, (_, index) => ({ description: `第 ${index + 1} 件事` }))
    const provider = installFakeProvider([
      fakeToolCall(TOOL, { steps: [{ description: "", title: "" }] }, "plan-bad-1"),
      fakeToolCall(TOOL, { steps: [{ description: "查点东西", allowedTools: ["definitely_missing_tool"] }] }, "plan-bad-2"),
      fakeToolCall(TOOL, { steps: [{ description: "让子代理再提议", allowedTools: ["agent_spawn"] }] }, "plan-bad-3"),
      fakeToolCall(TOOL, { steps: overLimit }, "plan-bad-4"),
      fakeText("都收到错误了"),
    ])

    const output = await runRuntimeTurn("给我一连串坏计划")

    const last = provider.payloads[provider.payloads.length - 1] as Payload | undefined
    const results = toolResultTexts(last, TOOL)
    expect(results.length, "四次坏调用都应有工具结果").toBe(4)
    expect(results[0], "缺 description 的步骤没有被拒绝").toContain("缺少 description")
    expect(results[1], "不存在的工具名没有被拒绝").toContain("指定的工具不存在")
    expect(results[2], "派生型工具没有被拒绝（子代理不派生）").toContain("不可用于子代理")
    expect(results[3], "超过 maxSteps 的步骤没有被拒绝").toContain("步骤过多")
    // 关键否定：被拒绝的提议不得开面板、不得落计划、不得执行。
    expect(planRecords(), "被拒绝的提议仍然开了确认面板").toEqual([])
    expect(planProgress(), "被拒绝的提议仍产出了进度事件").toEqual([])
    expect(planEnds()).toEqual([])
    expect(output.reply).toContain("都收到错误了")
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
})
