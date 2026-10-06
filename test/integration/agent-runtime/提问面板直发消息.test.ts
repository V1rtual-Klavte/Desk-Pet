// ==========================================
// 提问面板的未决边界 —— 用户不点面板、直接在输入框发消息
// ==========================================
//
// 被测语义（提问选择批次留下的未决边界：用户不点「其它」而是直发消息时，消息走 steer
// 排队而面板不会自动收起）：
// ① 有未结算的提问面板时用户直发消息：消息照常按 steer 投递进 lane 持久 inbox，
//    同时该会话的待答提问被取消 —— 面板收起（deskpet-choice-end），工具结果如实说明
//    「用户没在面板里选、直接发来了消息」，不冒充任何点选；直发消息随下一次请求到达模型。
// ② 没有提问面板时不受影响：直发消息照常 steered 入队、随下一次请求到达模型，
//    不产生任何 choice 事件。
// ③ 权限确认面板不被误伤：直发消息只取消提问通道的待答；权限确认走自己的单槽通道
//    （「当场确认」语义），原样待答、仍由它自己的回执结算。
//
// 归属 L3 的依据：从生产入口（`sendMessage`）驱动真 agent loop（真 JSONL 落盘、真运行槽），
// 只替换 Provider（fake 脚本）与执行许可（Node 宿主没有 Rust 许可内核）——与
// 回合入口准入配对.test.ts 同一形态。提问事件经 UI 事件端口记录（与原生面板同一份投影来源）。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

// 标准宿主应答器会把每一条权限确认立即按策略应答；「权限面板不被误伤」用例需要一条
// 真的停在待答的权限面板（产品里用户盯着它、却直接在输入框打字），因此在这里禁用它，
// 该用例自行按权限通道的口径结算。其余用例不经权限通道（ask_user 是 NORMAL 等级），
// 禁用不影响它们。
vi.mock("../../host/confirm-channel", () => ({
  resetConfirmChannel: () => {},
  confirmRecords: () => [],
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { sendMessage } from "@/services/agent/runner"
import { choiceState } from "@/services/engine/choice-confirmation"
import { confirmState, requestPermissionConfirm, resolvePermissionConfirm } from "@/services/safety"
import { setUiEventPublisher } from "@/services/host"
import { getActiveSessionId } from "@/services/session/store"
import { initSessions } from "@/services/session"
import { initPaths } from "@/services/paths"

/** 工具名是线上契约（测试手写见证，不 import 实现常量）。 */
const TOOL = "ask_user"
const ASK_PARAMS = { question: "喝什么？", options: ["咖啡", "茶"] }
const ASK_TEXT = "提问面板用例：先帮我想想喝什么"
const FIRST_TEXT = "提问面板用例：先开一个会被闸住的回合"
const STEER_TEXT = "提问面板用例：不用按钮了，我直接说 —— 想喝热的"
const FIRST_REPLY = "提问面板用例：首回合回复"
const FINAL_REPLY = "提问面板用例：好，按你说的来"
const CONSUMED_REPLY = "提问面板用例：收到你的补充，继续处理"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }

let dataRoot = ""
let restoreProvider: (() => void) | undefined
let events: Array<{ event: string; payload: Record<string, unknown> }> = []

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-choice-direct-reply-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  events = []
  // std 基线：计划门禁关闭、安全模式 tell_me；提问通道 "hold" = 待答留给用例（本文件自己
  // 制造「面板停在待答」的时刻——这正是要测的前提，默认的 "cancel" 会把面板立即收掉）。
  await standardSetup("deny", "deny", "hold")
  if (!getActiveSessionId()) await initSessions()
  setUiEventPublisher({
    publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) },
  })
})

afterEach(() => {
  restoreProvider?.()
  restoreProvider = undefined
})

/** Provider 载荷里的工具结果正文（按工具名过滤，与投影同形的字符串/文本块两种形态）。 */
function toolResultText(payload: { messages?: readonly unknown[] } | undefined, toolName: string): string {
  return (payload?.messages ?? []).flatMap(raw => {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || message.toolName !== toolName) return []
    return [typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => (part as { text?: string }).text ?? "").join("")
        : ""]
  }).join("\n")
}

/** Provider 载荷里的 user 角色正文（直发消息是否随某次请求到达模型）。 */
function userTextsInRequest(payload: { messages?: readonly unknown[] } | undefined): string[] {
  return (payload?.messages ?? []).flatMap(raw => {
    const message = raw as { role?: string; content?: unknown }
    if (message.role !== "user") return []
    return [typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => (part as { text?: string }).text ?? "").join("")
        : ""]
  })
}

/**
 * 闸门脚本：请求进入 Provider 时给出「回合确实在飞」的确定信号，响应扣到测试放行。
 * 与 回合入口准入配对.test.ts 的 gatedStep 同一约定（该助手不导出，这里按同形另写一份）；
 * 脚本被非目标请求取走 = 前提不成立，就地报错而不是靠后面的断言反推。
 */
function gatedStep(reply: string, expectedText: string) {
  let markEntered!: () => void
  let releaseGate!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const step: FauxResponseStep = (context, options) => {
    const text = lastRequestText(context)
    expect(text, `闸门脚本被非目标请求取走: ${text.slice(0, 60)}`).toContain(expectedText)
    markEntered()
    return (async () => {
      const signal = options?.signal
      if (!signal) { await gate; return fakeText(reply) }
      await new Promise<void>(resolve => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", () => resolve(), { once: true })
        void gate.then(resolve)
      })
      return fakeText(reply)
    })()
  }
  return { step, entered, release: () => releaseGate() }
}

describe("提问面板与直发消息", () => {
  it("有未结算提问时直发消息：面板取消、工具结果如实回执、消息照常投递 [ask-tool-direct-reply-cancels-panel]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(TOOL, ASK_PARAMS, "direct-reply-1"),
      fakeText(FINAL_REPLY),
    ], FAKE_MODEL)
    restoreProvider = provider.restore

    // 首回合停在提问等待（choicePolicy=hold）：面板已发出、工具调用挂在等待上。
    const turn = sendMessage(ASK_TEXT)
    await vi.waitFor(
      () => expect(choiceState.pending.map(view => view.requestId), "提问面板没有出现，场景前提不成立").toEqual(["choice-direct-reply-1"]),
      { timeout: 10_000 },
    )
    expect(events.filter(entry => entry.event === "deskpet-choice-start").map(entry => entry.payload.requestId))
      .toContain("choice-direct-reply-1")

    // 用户不点面板、直接在输入框发消息：走生产入口的忙碌投递（steer）。
    const steered = await sendMessage(STEER_TEXT, { requestId: `request-${crypto.randomUUID()}` })
    expect(steered.outcome, "直发消息没有按排队投递").toBe("queued")
    expect(steered.delivery, "直发消息的投递归宿不是 steer").toBe("steered")

    // 面板随结算收起：待答视图清空 + 收尾事件按 requestId 发出（原生面板据此收起）。
    expect(choiceState.pending, "直发消息后提问面板仍在待答").toEqual([])
    expect(events.filter(entry => entry.event === "deskpet-choice-end").map(entry => entry.payload.requestId))
      .toContain("choice-direct-reply-1")

    // 回合带着工具结果继续，并消费直发消息后收尾。
    const output = await turn
    expect(output.failure, `回合没有正常收尾：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(output.reply, "回合没有以模型正文收尾").toContain(FINAL_REPLY)

    const second = provider.payloads[1]
    expect(second, "回合没有走到第二次 Provider 请求（工具结果未回到模型）").toBeDefined()
    const resultText = toolResultText(second, TOOL)
    expect(resultText, "工具结果没有如实说明「用户直接发来了消息」").toContain("直接发来了一条消息")
    expect(resultText, "工具结果冒充了面板点选").not.toContain("咖啡")
    expect(resultText, "工具结果冒充了面板点选").not.toContain("茶")
    expect(userTextsInRequest(second).some(text => text.includes(STEER_TEXT)),
      "直发消息没有随下一次请求到达模型").toBe(true)
  }, 30_000)

  it("没有提问面板时直发消息不受影响：照常按 steer 入队并到达模型 [ask-tool-direct-reply-no-panel]", async () => {
    const gate = gatedStep(FIRST_REPLY, FIRST_TEXT)
    const provider = installFakeProvider([
      gate.step,
      fakeText(CONSUMED_REPLY),
    ], FAKE_MODEL)
    restoreProvider = provider.restore

    const turn = sendMessage(FIRST_TEXT)
    await gate.entered

    const steered = await sendMessage(STEER_TEXT, { requestId: `request-${crypto.randomUUID()}` })
    expect(steered.outcome, "直发消息没有按排队投递").toBe("queued")
    expect(steered.delivery, "直发消息的投递归宿不是 steer").toBe("steered")
    // 关键否定：没有待答提问时，投递不得触发任何提问通道的收尾/取消。
    expect(choiceState.pending).toEqual([])
    expect(events.filter(entry => entry.event === "deskpet-choice-end"), "没有提问却发出了面板收起事件").toEqual([])

    gate.release()
    const output = await turn
    expect(output.failure, `回合没有正常收尾：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    // 直发消息在回合边界的下一次请求到达模型（入队照常被消费），回合按收尾脚本结束。
    const second = provider.payloads[1]
    expect(second, "回合没有走到消费排队输入的第二次请求").toBeDefined()
    expect(userTextsInRequest(second).some(text => text.includes(STEER_TEXT)),
      "直发消息没有随下一次请求到达模型").toBe(true)
    expect(output.reply, "回合没有以收尾脚本文本结束").toContain(CONSUMED_REPLY)
  }, 30_000)

  it("直发消息只取消提问：权限确认面板原样待答，仍由自己的通道结算 [ask-tool-direct-reply-keeps-permission]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(TOOL, ASK_PARAMS, "keep-perm-1"),
      fakeText(FINAL_REPLY),
    ], FAKE_MODEL)
    restoreProvider = provider.restore
    const sessionId = getActiveSessionId()

    const turn = sendMessage(ASK_TEXT)
    await vi.waitFor(
      () => expect(choiceState.pending.map(view => view.requestId), "提问面板没有出现，场景前提不成立").toEqual(["choice-keep-perm-1"]),
      { timeout: 10_000 },
    )

    // 权限确认面板（独立单槽通道）与提问面板同时停在待答：用户盯着权限面板时直接打字。
    const permission = requestPermissionConfirm({
      requestId: "perm-direct-reply-1",
      sessionId,
      runGeneration: 0,
      toolCallId: "perm-call-1",
      toolName: "probe_tool",
      inputHash: "input-hash",
      policyHash: "policy-hash",
      message: "通道自检：确认执行演示操作？",
      parameterSummary: "无参数",
      effectClass: "external_side_effect",
    })
    expect(confirmState.pending?.id, "场景前提：权限确认没有停在待答").toBe("perm-direct-reply-1")

    const steered = await sendMessage(STEER_TEXT, { requestId: `request-${crypto.randomUUID()}` })
    expect(steered.delivery, "直发消息没有按 steer 投递").toBe("steered")

    expect(choiceState.pending, "提问面板没有随直发消息取消").toEqual([])
    expect(confirmState.pending?.id, "直发消息把权限确认面板一起收起了").toBe("perm-direct-reply-1")

    // 收尾 1：权限面板由它自己的回执通道结算（这里按拒绝，fail-closed），不留悬挂等待。
    resolvePermissionConfirm("deny")
    await expect(permission, "权限确认没有由自己的通道结算").resolves.toBe("deny")
    // 收尾 2：回合带着工具结果与直发消息继续并按脚本结束。
    const output = await turn
    expect(output.failure, `回合没有正常收尾：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
  }, 30_000)
})
