// ==========================================
// 工具循环治理 —— 主回合取消计数上限、病理硬终止、软提示接线、子运行封顶保留
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 1）：
// ① 主聊天回合不再有工具调用计数上限：超过旧默认值（5）的 7 次调用全部执行、以模型正文自然收尾；
// ② 同参重复（键排序签名）连续第 5 次被硬终止：前 4 次真实执行、第 5 次在调用门记 blocked，
//    收尾走 Card 的 `toolLoopMaxRounds` 兜底文案；
// ③ 第 3 次同参调用只附软提示（工具结果正文里出现中性提示行）、回合不断连；阈值之前的结果
//    不带提示（正反对照，否则「提示恒在」或「提示从不来」都测不出来）；
// ④ 连续失败第 5 次在**结果侧**硬终止（after_tool 的 terminate 立即终止）：5 次都真实执行、
//    不再发第 6 次请求、收尾同样走兜底文案；
// ⑤ 软提示跨请求持续存在；多 text 块结果整条只拼一次；
// ⑥ 每回合重置：同一会话两个回合各 3 次同参调用都只停在软档（guard 不跨回合复用）；
// ⑦ 无人值守子运行保留计数封顶：runPiSubAgent 在 maxToolCalls 处停下（第 3 次调用不再执行）；
// ⑧ 子运行同吃病理检测：maxToolCalls=10（封顶够不着）时同参连续第 5 次在调用门被硬终止 ——
//    前 4 次真实执行、第 5 次不执行且不再发请求（去掉子运行这段接线、把硬阈值放宽、
//    或丢掉 block 的 terminate，三种改法都会红）。子运行的请求投影关闭，软提示不附进请求视图，
//    这条只钉硬终止的两条路径。
//
// 归属 L3（不是 L2）的理由：跑真实 agent loop、真工具执行与真 JSONL 落盘，且 import
// `@/services/engine/harness`（规则 6 的 L2 禁入清单）。只替换 Provider 与执行许可
// （Node 宿主没有 Rust 许可内核；与既有 L3 用例同形），工具与权限链其余部分照走真实路径。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { watch } from "vue"

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
import { runRuntimeTurn } from "./_runtime-turn"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { runPiSubAgent, resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { initPaths } from "@/services/paths"
import { initChat, sendMessage } from "@/services/agent/runner"
import { readPiSessionEntriesOnce } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"
import { resolveSimMessageReply } from "@/services/sim/chat-bridge"
import { getUiEventPublisher, setUiEventPublisher } from "@/services/host"
import { choiceState, resolveChoice } from "@/services/engine/choice-confirmation"
import { flushConfig, setOverride } from "@/services/config"

/** 探针工具名/ID：只读、无副作用，执行次数是「调用到底有没有真的发生」的独立观测面。 */
const PROBE_ID = "loop-governance-probe"
const PROBE_NAME = "loop_governance_probe"
/** 软提示的中性文案前缀（`tool-loop-guard` 的产出；这里是手写见证，不 import 实现常量）。 */
const NOTICE_MARKER = "工具循环检测"
const NOTICE_REPEATED_3 = "[工具循环检测：同一工具与参数已连续调用 3 次"
const FINAL_TEXT = "工具都跑完了"

let root = ""
let executions: string[] = []
let lateSuccess: Promise<void> | undefined

const probe: ToolDef = defineTool({
  id: PROBE_ID, name: PROBE_NAME, description: "循环治理测试探针（只读，不产生副作用）",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async args => {
  executions.push(JSON.stringify(args))
  if (args.late === true) await lateSuccess
  return { success: true, content: "探针结果" }
})

/** 失败探针：恒定返回 `success:false`（适配器与 after_tool 保留错误标记，喂失败连击）。 */
const FAILING_PROBE_ID = "loop-governance-failing-probe"
const FAILING_PROBE_NAME = "loop_governance_failing_probe"
const failingProbe: ToolDef = defineTool({
  id: FAILING_PROBE_ID, name: FAILING_PROBE_NAME, description: "循环治理测试失败探针（只读，恒定失败）",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async args => {
  executions.push(JSON.stringify(args))
  return { success: false, content: "", error: "探针恒定失败" }
})

/** 多 text 块探针：结果带两个 text 块，钉住软提示整条只拼一次。 */
const MULTI_PROBE_ID = "loop-governance-multi-probe"
const MULTI_PROBE_NAME = "loop_governance_multi_probe"
const multiProbe: ToolDef = defineTool({
  id: MULTI_PROBE_ID, name: MULTI_PROBE_NAME, description: "循环治理测试多块探针（只读）",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async args => {
  executions.push(JSON.stringify(args))
  return {
    success: true, content: "多块探针结果",
    contentParts: [{ type: "text", text: "第一块" }, { type: "text", text: "第二块" }],
  }
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-loop-governance-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  executions = []
  lateSuccess = undefined
  register(probe)
  register(failingProbe)
  register(multiProbe)
})

afterEach(() => {
  unregister(PROBE_ID)
  unregister(FAILING_PROBE_ID)
  unregister(MULTI_PROBE_ID)
  resetPiRuntimeProviderForTest()
})

/** 某笔请求里指定工具的结果正文（toolResult 消息的 text 块；请求视图的投影结果就在这里）。 */
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

/** 同一模型轮次的多个失败，参数各不相同，只触发失败连击。 */
function failingBatch(start: number, count: number, processText = "") {
  return fauxAssistantMessage([
    ...(processText ? [fauxText(processText)] : []),
    ...Array.from({ length: count }, (_, index) => fauxToolCall(FAILING_PROBE_NAME,
      { at: start + index }, { id: `mixed-fail-${start + index}` })),
  ], { stopReason: "toolUse" })
}

/** 模拟真实界面通道发送异常；不是用 throw 充当断言。 */
function publisherFailingOnChoiceStart(): () => void {
  const previous = getUiEventPublisher()
  setUiEventPublisher({ publish: async event => {
    if (event === "deskpet-choice-start") throw new Error("界面通道关闭")
  } })
  return () => setUiEventPublisher(previous)
}

describe("工具循环治理", () => {
  it("混合批次治理后已提交的诚实收尾正常交付，不追加兜底且失败工具仍留账 [tool-loop-governance-committed-final]", async () => {
    setOverride("ai.humanizer.enabled", false)
    await flushConfig()
    const closing = "这三项都没有保存，提醒功能当前已暂停。"
    const provider = installFakeProvider([failingBatch(1, 2), failingBatch(3, 3), fakeText(closing)])
    await initChat()
    const requestId = "mixed-governance-final"
    const output = await sendMessage("请创建三项提醒。", { requestId })
    expect(executions).toHaveLength(5)
    expect(provider.state.callCount).toBe(3)
    expect(output).toMatchObject({ outcome: "succeeded", reply: closing })
    expect(output.failure).toBeUndefined()
    expect(output.toolCalls.map(item => item.status)).toEqual(["error", "error", "error", "error", "error"])
    const receipt = await resolveSimMessageReply(getActiveSessionId(), requestId, output)
    expect(receipt).toMatchObject({ outcome: "succeeded", reply: closing, replyBinding: "request-response" })
    const entries = await readPiSessionEntriesOnce(getActiveSessionId())
    expect(entries.find(entry => entry.id === receipt.assistantEntryId)).toMatchObject({ type: "message", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: closing }],
      deskpetReplyEvidence: { outcome: "delivered" },
    } })
    const results = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === FAILING_PROBE_NAME)
    expect(results).toHaveLength(5)
    expect(results.every(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError)).toBe(true)
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
      && entry.message.content.some(part => part.type === "text" && part.text === getFallbackReply("toolLoopMaxRounds"))))
      .toHaveLength(0)
  }, 60_000)

  it("拟人化拒绝沉默产生的非空兜底不冒充模型收尾 [tool-loop-governance-presentation-fallback]", async () => {
    setOverride("ai.humanizer.enabled", true)
    await flushConfig()
    installFakeProvider([fakeText("<<SILENT>>"), failingBatch(1, 2), failingBatch(3, 3), fakeText("<<SILENT>>")])
    const initial = await runRuntimeTurn("先允许一次沉默。")
    expect(initial.silent).toBe(true)
    const output = await runRuntimeTurn("工具失败后仍需要有效收尾。")
    expect(output.failure?.kind).toBe("tool_loop")
    expect(output.reply).toBe(getFallbackReply("toolLoopMaxRounds"))
    const entries = await readPiSessionEntriesOnce(getActiveSessionId())
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
      && entry.message.content.some(part => part.type === "text" && part.text === getFallbackReply("silentRejected"))))
      .toHaveLength(1)
  }, 60_000)

  it("旧回合与工具过程有字也不能顶替空收尾，仍失败并且兜底只落一次 [tool-loop-governance-empty-final]", async () => {
    installFakeProvider([fakeText("上个回合的正文"), failingBatch(1, 2),
      failingBatch(3, 3, "正在处理这些提醒"), fakeText("   ")])
    await initChat()
    expect((await sendMessage("上一轮。", { requestId: "mixed-previous" })).outcome).toBe("succeeded")
    const output = await sendMessage("本轮。", { requestId: "mixed-empty-final" })
    expect(output.outcome).toBe("failed")
    expect(output.failure?.kind).toBe("tool_loop")
    expect(output.reply).toBe(getFallbackReply("toolLoopMaxRounds"))
    const entries = await readPiSessionEntriesOnce(getActiveSessionId())
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
      && entry.message.content.some(part => part.type === "text" && part.text === getFallbackReply("toolLoopMaxRounds"))))
      .toHaveLength(1)
  }, 60_000)

  it("治理后晚到成功不能重新放行新的工具调用，无有效收尾仍失败 [tool-loop-governance-blocks-next-tools]", async () => {
    let releaseLate!: () => void
    lateSuccess = new Promise<void>(resolve => { releaseLate = resolve })
    const previousPublisher = getUiEventPublisher()
    let failedTools = 0
    setUiEventPublisher({ publish: async (event, payload) => {
      const result = payload as { toolName?: string; success?: boolean }
      // 原生 tool_end 在 after_tool 之后发布：第五次错误被治理后才让同批成功返回。
      if (event === "tool-completed" && result.toolName === FAILING_PROBE_NAME && result.success === false) {
        failedTools += 1
        if (failedTools === 5) releaseLate()
      }
      await previousPublisher.publish(event, payload)
    } })
    const provider = installFakeProvider([
      fauxAssistantMessage([fauxToolCall(PROBE_NAME, { late: true }, { id: "late-success" }),
        ...Array.from({ length: 5 }, (_, at) => fauxToolCall(FAILING_PROBE_NAME, { at }, { id: `late-fail-${at}` }))],
      { stopReason: "toolUse" }),
      fakeToolCall(PROBE_NAME, { afterGovernance: true }, "after-governance"), fakeText("不应到达"),
    ])
    try {
      const output = await runRuntimeTurn("连续失败后再试另一个工具。")
      expect(failedTools).toBe(5)
      expect(executions).toHaveLength(6)
      expect(provider.state.callCount).toBe(2)
      expect(output.toolCallHistory.filter(item => item.status === "done")).toHaveLength(1)
      expect(output.toolCallHistory.filter(item => item.status === "error")).toHaveLength(5)
      expect(output.toolCallHistory.filter(item => item.status === "blocked")).toHaveLength(1)
      expect(output.failure?.kind).toBe("tool_loop")
      expect(output.reply).toBe(getFallbackReply("toolLoopMaxRounds"))
    } finally { releaseLate(); setUiEventPublisher(previousPublisher) }
  }, 60_000)

  it("真实提问的用户取消不凑成第五次技术失败，错误回执仍原样落盘 [tool-loop-ask-cancel-neutral]", async () => {
    await standardSetup("deny", "deny", "hold")
    setOverride("ai.humanizer.enabled", false)
    await flushConfig()
    const previousPublisher = getUiEventPublisher()
    setUiEventPublisher({ publish: async () => {} })
    const stop = watch(() => choiceState.pending.map(item => item.requestId).join("|"), () => {
      for (const item of [...choiceState.pending]) resolveChoice(item.requestId, { kind: "cancelled" })
    }, { flush: "sync" })
    const provider = installFakeProvider([
      ...Array.from({ length: 4 }, (_, at) => fakeToolCall(FAILING_PROBE_NAME, { at }, `before-cancel-${at}`)),
      fakeToolCall("ask_user", { question: "是否继续？", options: ["继续", "停止"] }, "cancel-neutral"),
      fakeText("你取消了选择，我先停在这里。"),
    ])
    try {
      const output = await runRuntimeTurn("询问后按用户决定处理。")
      expect(provider.state.callCount).toBe(6)
      expect(output.failure).toBeUndefined()
      expect(output.reply).toBe("你取消了选择，我先停在这里。")
      const entries = await readPiSessionEntriesOnce(getActiveSessionId())
      expect(entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === "ask_user")).toMatchObject({ message: { isError: true,
        details: { deskpetToolOutcome: "user_cancelled", errorCode: "user_cancelled", audit: { outcome: "cancelled" } },
      } })
    } finally { stop(); setUiEventPublisher(previousPublisher) }
  }, 60_000)

  it("真实提问取消保留已有失败，第五次技术错误仍终止 [tool-loop-ask-cancel-keeps-failures]", async () => {
    // 标准宿主的默认 choicePolicy=cancel，走真实选择通道的用户取消回执。
    const provider = installFakeProvider([
      ...Array.from({ length: 4 }, (_, at) => fakeToolCall(FAILING_PROBE_NAME, { at }, `cancel-keeps-${at}`)),
      fakeToolCall("ask_user", { question: "是否继续？", options: ["继续", "停止"] }, "cancel-keeps"),
      fakeToolCall(FAILING_PROBE_NAME, { at: 5 }, "fifth-failure"), fakeText("不应到达"),
    ])
    const output = await runRuntimeTurn("取消选择后还有一次工具错误。")
    expect(provider.state.callCount).toBe(6)
    expect(output.failure).toEqual({ kind: "tool_loop", message: "工具循环病理检测：工具连续失败 5 次，终止回合" })
    expect(output.toolCallHistory).toHaveLength(6)
  }, 60_000)

  it("真实提问发送失败仍算第五次技术失败，不按工具名豁免 [tool-loop-ask-delivery-failure-counted]", async () => {
    await standardSetup("deny", "deny", "hold")
    const restorePublisher = publisherFailingOnChoiceStart()
    const provider = installFakeProvider([
      ...Array.from({ length: 4 }, (_, at) => fakeToolCall(FAILING_PROBE_NAME, { at }, `before-emit-${at}`)),
      fakeToolCall("ask_user", { question: "是否继续？", options: ["继续", "停止"] }, "emit-failure"),
      fakeText("不应到达"),
    ])
    try {
      const output = await runRuntimeTurn("发起一次界面不可达的提问。")
      expect(provider.state.callCount).toBe(5)
      expect(output.failure?.kind).toBe("tool_loop")
      const entries = await readPiSessionEntriesOnce(getActiveSessionId())
      expect(entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === "ask_user")).toMatchObject({ message: { isError: true,
        details: { deskpetToolOutcome: "failure", errorCode: "failed" },
      } })
    } finally { restorePublisher() }
  }, 60_000)

  it("主回合不再有计数上限：7 次调用全部执行、以模型正文自然收尾 [tool-loop-main-no-count-cap]", async () => {
    const provider = installFakeProvider([
      ...Array.from({ length: 7 }, (_, at) => fakeToolCall(PROBE_NAME, { at: at + 1 }, `probe-call-${at + 1}`)),
      fakeText(FINAL_TEXT),
    ])

    const output = await runRuntimeTurn("多调几次工具再回答。")

    expect(executions.length, `7 次工具调用只执行了 ${executions.length} 次（计数上限疑似仍在生效）`).toBe(7)
    expect(provider.state.callCount, "请求数应为 7 次工具轮 + 1 次收尾（计数上限会在第 6 次前掐断）").toBe(8)
    expect(output.failure, `回合以失败结算：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(output.reply, "回合没有以模型正文收尾").toContain(FINAL_TEXT)
    expect(output.reply, "回合走了工具轮兜底文案（旧计数上限的收尾路径）").not.toBe(getFallbackReply("toolLoopMaxRounds"))
    expect(output.toolCallHistory.filter(item => item.status === "blocked"), "主回合出现了被拦下的调用").toEqual([])
  }, 60_000)

  it("同参重复第 5 次被硬终止：前 4 次真实执行、第 5 次记 blocked、收尾用工具轮兜底文案 [tool-loop-repeat-hard-termination]", async () => {
    const provider = installFakeProvider([
      ...Array.from({ length: 5 }, (_, at) => fakeToolCall(PROBE_NAME, { same: 1 }, `probe-call-${at + 1}`)),
      fakeText("不应到达的收尾正文"),
    ])

    const output = await runRuntimeTurn("重复调同一个工具。")

    expect(executions.length, "硬终止前应恰好执行 4 次（第 5 次在调用门被拦下）").toBe(4)
    expect(output.toolCallHistory.map(item => item.status),
      "工具历史的成败序列不对（前 4 次执行成功、第 5 次被拦）").toEqual(["done", "done", "done", "done", "blocked"])
    expect(provider.state.callCount, "硬终止后不应再有下一次请求").toBe(5)
    expect(output.reply, "硬终止收尾不是 Card 的工具轮兜底文案").toBe(getFallbackReply("toolLoopMaxRounds"))
    expect(output.failure).toEqual({ kind: "tool_loop", message: "工具循环病理检测：同一工具与参数连续调用 5 次，终止回合" })
    const entries = await readPiSessionEntriesOnce(getActiveSessionId())
    const fallback = entries.find(entry => entry.id === output.committedAssistantEntryId)
    expect(fallback).toMatchObject({ type: "message", message: {
      role: "assistant", content: [{ type: "text", text: getFallbackReply("toolLoopMaxRounds") }],
      deskpetReplyEvidence: { generatedText: "", outcome: "fallback", transformation: "none" },
    } })
  }, 60_000)

  it("连续失败第 5 次在结果侧硬终止：不再发下一次请求、收尾用工具轮兜底文案 [tool-loop-failure-hard-termination]", async () => {
    // 每次调用参数不同 ⇒ 只累计失败连击、不触发同参连击；第 5 条结果侧判定 hard。
    const provider = installFakeProvider([
      ...Array.from({ length: 5 }, (_, at) => fakeToolCall(FAILING_PROBE_NAME, { at: at + 1 }, `fail-call-${at + 1}`)),
      fakeText("不应到达的收尾正文"),
    ])

    await initChat()
    const output = await sendMessage("连续失败几次看看。")

    expect(executions.length, "5 次失败调用都应真实执行（失败连击的硬阈值在结果侧判定，不在调用门预拦）").toBe(5)
    expect(output.toolCalls.map(item => item.status),
      "工具历史应是 5 次失败（没有第 6 次被调用门拦下的记录）")
      .toEqual(["error", "error", "error", "error", "error"])
    // 区分力核心：结果侧 terminate 让回合在第 5 条结果后立即结束 —— 去掉 terminate 时
    // 模型会再拿到一次请求（本轮脚本给正文），这里会变成 6。
    expect(provider.state.callCount, "第 5 次失败后不应再发请求（结果侧 terminate 未生效？）").toBe(5)
    expect(output.reply, "硬终止收尾不是 Card 的工具轮兜底文案").toBe(getFallbackReply("toolLoopMaxRounds"))
    expect(output.outcome).toBe("failed")
    expect(output.failure).toEqual({ kind: "tool_loop", message: "工具循环病理检测：工具连续失败 5 次，终止回合" })
    const entries = await readPiSessionEntriesOnce(getActiveSessionId())
    const fallbacks = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
      && entry.message.content.some(part => part.type === "text" && part.text === getFallbackReply("toolLoopMaxRounds")))
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatchObject({ message: {
      deskpetReplyEvidence: { generatedText: "", outcome: "fallback", transformation: "none" },
    } })
  }, 60_000)

  it("同参第 3 次只附软提示且不断连；阈值之前的结果不带提示 [tool-loop-soft-notice]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(PROBE_NAME, { same: 1 }, "probe-call-1"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "probe-call-2"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "probe-call-3"),
      fakeToolCall(PROBE_NAME, { next: 2 }, "probe-call-4"),
      fakeText(FINAL_TEXT),
    ])

    const output = await runRuntimeTurn("先重复调两次再换一下。")

    expect(executions.length, "软提示不应终止回合（第 4 次调用应照常执行）").toBe(4)
    expect(output.reply, "回合没有以模型正文收尾").toContain(FINAL_TEXT)

    // 正对照：第 1 次调用之后的那笔请求里，结果正文不该带提示。
    const afterFirstCall = toolResultTexts(provider.payloads[1], PROBE_NAME)
    expect(afterFirstCall.length, "第 1 次调用后没有可判的工具结果").toBe(1)
    expect(afterFirstCall[0], "软阈值之前的结果不该带循环提示").not.toContain(NOTICE_MARKER)

    // 第 3 次调用之后的那笔请求：前两条不带提示、第 3 条带同参重复的软提示。
    const afterThirdCall = toolResultTexts(provider.payloads[3], PROBE_NAME)
    expect(afterThirdCall.length, "第 3 次调用后应有 3 条工具结果").toBe(3)
    expect(afterThirdCall[0], "第 1 条结果不该带提示").not.toContain(NOTICE_MARKER)
    expect(afterThirdCall[1], "第 2 条结果不该带提示").not.toContain(NOTICE_MARKER)
    expect(afterThirdCall[2], "第 3 条结果应带同参重复的软提示").toContain(NOTICE_REPEATED_3)

    // 跨请求持续存在：第 4 次调用之后的下一笔请求里，第 3 条结果仍带同一条软提示 ——
    // 投影后若清空 toolLoopNotices（或只让紧邻一笔请求看到提示），这条变红。
    const afterFourthCall = toolResultTexts(provider.payloads[4], PROBE_NAME)
    expect(afterFourthCall.length, "第 4 次调用后应有 4 条工具结果").toBe(4)
    expect(afterFourthCall[2], "软提示应跨请求持续存在（不是只给紧邻一笔请求看）").toContain(NOTICE_REPEATED_3)
  }, 60_000)

  it("多 text 块结果：循环软提示整条只拼一次（不逐块重复）[tool-loop-notice-multi-block-once]", async () => {
    const provider = installFakeProvider([
      fakeToolCall(MULTI_PROBE_NAME, { same: 1 }, "multi-call-1"),
      fakeToolCall(MULTI_PROBE_NAME, { same: 1 }, "multi-call-2"),
      fakeToolCall(MULTI_PROBE_NAME, { same: 1 }, "multi-call-3"),
      fakeText(FINAL_TEXT),
    ])

    const output = await runRuntimeTurn("重复调用多块工具。")

    expect(output.reply, "回合没有以模型正文收尾").toContain(FINAL_TEXT)
    const afterThirdCall = toolResultTexts(provider.payloads[3], MULTI_PROBE_NAME)
    expect(afterThirdCall.length, "第 3 次调用后应有 3 条结果").toBe(3)
    const third = afterThirdCall[2]!
    expect(third, "两个 text 块应都保留（第一块）").toContain("第一块")
    expect(third, "两个 text 块应都保留（第二块）").toContain("第二块")
    // 区分力核心：把「只拼一次」退化成逐 text 块拼接时，这里会数到 2。
    expect(third.split(NOTICE_MARKER).length - 1, "软提示整条结果只应出现一次（逐块拼会重复）").toBe(1)
  }, 60_000)

  it("每回合重置：同一会话两个回合各 3 次同参调用都只停在软档 [tool-loop-per-turn-reset]", async () => {
    const provider = installFakeProvider([
      // 第一回合：3 次同参 + 收尾正文。
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn1-call-1"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn1-call-2"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn1-call-3"),
      fakeText("第一回合收尾"),
      // 第二回合：同工具同参再来 3 次。
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn2-call-1"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn2-call-2"),
      fakeToolCall(PROBE_NAME, { same: 1 }, "turn2-call-3"),
      fakeText("第二回合收尾"),
    ])

    const first = await runRuntimeTurn("第一回合先重复三次。")
    const executionsAfterFirst = executions.length
    const second = await runRuntimeTurn("第二回合再来三次。")

    expect(executionsAfterFirst, "第一回合的 3 次调用都应执行（第 3 次只到软档）").toBe(3)
    // 区分力核心：guard 若被提升为模块级单例（跨回合复用计数），第二回合第 2 次调用就会
    // 撞上同参连击的第 5 次硬阈值 —— 执行数只剩 1、收尾变兜底文案，两条断言同时红。
    expect(executions.length - executionsAfterFirst,
      "第二回合应重新从零累计 3 次（跨回合复用 guard 时只会执行 1 次）").toBe(3)
    expect(first.reply, "第一回合没有以模型正文收尾").toContain("第一回合收尾")
    expect(second.reply, "第二回合没有以模型正文收尾（疑似跨回合累计触发硬终止）").toContain("第二回合收尾")
  }, 60_000)

  it("无人值守子运行保留计数封顶：runPiSubAgent 在 maxToolCalls 处停下 [tool-loop-subagent-cap-kept]", async () => {
    const provider = installFakeProvider([
      ...Array.from({ length: 4 }, (_, at) => fakeToolCall(PROBE_NAME, { at: at + 1 }, `sub-call-${at + 1}`)),
      fakeText("子代理不应继续"),
    ])

    const result = await runPiSubAgent({
      owner: { kind: "conversation", runId: crypto.randomUUID(), sessionId: "loop-subrun", runGeneration: 1, isCurrent: () => true },
      task: "连续调用探针。",
      tools: [probe],
      systemPrompt: "测试子代理",
      maxToolCalls: 2,
      timeoutMs: 30_000,
    })

    expect(executions.length, `子运行没有在 maxToolCalls=2 处停下（执行了 ${executions.length} 次）`).toBe(2)
    expect(result.toolCallsMade, "子运行的已执行工具数与封顶不一致").toBe(2)
    expect(provider.state.callCount, "封顶后不应请求第 4 次（第 3 次调用被拦下即终止）").toBe(3)
  }, 60_000)

  it("子运行同吃病理检测：同参第 5 次在调用门硬终止（先于 maxToolCalls 封顶） [tool-loop-subagent-guard]", async () => {
    // maxToolCalls=10 刻意大于硬阈值 5：计数封顶在这条用例里不可能替 guard 解释收口。
    // 三种变红方式：① 去掉子运行的 guard 接线 → 5 次全部执行、收尾步骤被消费（callCount 6）；
    // ② 硬阈值 5 放宽 → 执行数随阈值上浮；③ 丢掉 block 的 terminate → 第 5 次被拦但仍发
    // 下一次请求（callCount 6），执行数与 blocked 记录不变。
    const provider = installFakeProvider([
      ...Array.from({ length: 5 }, (_, at) => fakeToolCall(PROBE_NAME, { same: 1 }, `sub-guard-${at + 1}`)),
      fakeText("子代理不应继续"),
    ])

    const result = await runPiSubAgent({
      owner: { kind: "conversation", runId: crypto.randomUUID(), sessionId: "loop-subrun", runGeneration: 1, isCurrent: () => true },
      task: "重复调用同一个工具。",
      tools: [probe],
      systemPrompt: "测试子代理",
      maxToolCalls: 10,
      timeoutMs: 30_000,
    })

    expect(executions.length,
      `子运行同参第 5 次没有被调用门拦下（执行了 ${executions.length} 次；软档误终止会是 3，guard 缺失会是 5）`).toBe(4)
    expect(result.toolCallsMade, "子运行的已执行工具数应停在硬终止前的 4 次（第 5 次被 block，不计入）").toBe(4)
    expect(provider.state.callCount, "第 5 次同参调用被拦下后不应再发请求（guard 缺失或 terminate 丢失会到 6）").toBe(5)
  }, 60_000)
})
