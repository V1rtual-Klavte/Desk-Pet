// ==========================================
// Hook 错误码 —— 从 test/e2e/scenes/safety/Hook错误码.scene.ts 迁到 L2（W3）
// ==========================================
//
// 归属（按 import + 实测）：被测对象是 Pi 原生 `beforeToolCall` 契约本身 ——
// 用例自建 faux provider 驱动 `pi-agent-core` 的 Agent，运行内核的工具门禁复用同一语义
// （Harness `before_tool` ← Agent `beforeToolCall`）。全程没有 Desk-Pet 服务参与
// （原场景 setup 里的宿主 fake provider 只是场景 DSL 驱动回合的脚手架，迁走后不再需要），
// 不撞任何 IPC 命令，实测在 L2 跑通。
//
// 审视结论：照搬。block 与 throw 两个方向都是 fail-closed 的独立证据：
// 「工具不执行」+「留下 error 工具结果」+「原因回传给模型」，缺一即红。
import { describe, expect, it } from "vitest"
import { Agent } from "@earendil-works/pi-agent-core"
import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult, StreamFn } from "@earendil-works/pi-agent-core"
import { contentText, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai"

interface ProbeOutcome {
  /** 探针工具是否真的执行过。fail-closed 语义要求它始终为 false。 */
  executed: boolean
  toolResultTexts: string[]
  toolResultErrors: boolean[]
}

/**
 * 用 faux provider 驱动一个只含探针工具的 Pi Agent，`beforeToolCall` 由用例注入。
 */
async function runProbeAgent(
  beforeToolCall: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>,
): Promise<ProbeOutcome> {
  const fake = fauxProvider({ api: "faux", provider: "deskpet-fake", models: [{ id: "deskpet-fake", name: "Desk-Pet Fake" }] })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall("probe_tool", {}, { id: "probe-call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("探针回合结束")),
  ])
  const model = fake.getModel()
  let executed = false
  const probe: AgentTool<any> = {
    name: "probe_tool",
    label: "probe_tool",
    description: "探针工具：被执行即代表门禁失效",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => {
      executed = true
      return { content: [{ type: "text", text: "probe 已执行" }], details: {} }
    },
  }
  const agent = new Agent({
    initialState: { systemPrompt: "probe", model, tools: [probe], messages: [] },
    streamFn: ((requestModel, context, options) => fake.provider.streamSimple(requestModel, context, options)) as StreamFn,
    beforeToolCall: context => beforeToolCall(context),
  })
  await agent.prompt("请调用 probe_tool。")
  const toolResults = agent.state.messages.filter(
    (message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult",
  )
  return {
    executed,
    toolResultTexts: toolResults.map(message => contentText(message.content)),
    toolResultErrors: toolResults.map(message => message.isError === true),
  }
}

/**
 * 抛错的 hook —— 这是**被测输入**不是断言：门禁自身出故障时 Pi 必须 fail-closed。
 * 模块级具名而非内联匿名函数：它抛的是夹具的异常，写成内联会被纪律扫描器
 * 按「测试体内手写 throw」误判成断言（规则 4 的判据只看测试体，辅助函数放行）。
 */
const throwingHook = async (): Promise<BeforeToolCallResult | undefined> => {
  throw new Error("hook-boom")
}

describe("Hook 错误码", () => {
  it("Pi 原生 beforeToolCall 门禁 fail-closed（block 与抛错都不执行工具） [safety-hook-errors]", async () => {
    // 1) block：hook 拒绝时工具不得执行，且必须留下 error 工具结果与可诊断原因。
    const blocked = await runProbeAgent(async () => ({ block: true, reason: "blocked-by-hook" }))
    expect(blocked.executed, "beforeToolCall 返回 block 后探针工具仍被执行").toBe(false)
    expect(blocked.toolResultErrors.some(Boolean), "被拦截的调用没有产生 error 工具结果").toBe(true)
    expect(blocked.toolResultTexts.some(text => text.includes("blocked-by-hook")), "block 原因没有回传给模型").toBe(true)

    // 2) throw：hook 抛错时 Pi 同样 fail-closed（agent-loop 把异常转成 error 工具结果，工具不执行）。
    const thrown = await runProbeAgent(throwingHook)
    expect(thrown.executed, "beforeToolCall 抛错后探针工具仍被执行").toBe(false)
    expect(thrown.toolResultErrors.some(Boolean), "抛错的 hook 没有产生 error 工具结果").toBe(true)
    expect(thrown.toolResultTexts.some(text => text.includes("hook-boom")), "hook 异常没有作为工具错误回传").toBe(true)
  })
})
