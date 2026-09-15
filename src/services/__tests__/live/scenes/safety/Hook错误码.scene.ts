import type { SceneDef } from "../../types"
import { Agent } from "@earendil-works/pi-agent-core"
import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult, StreamFn } from "@earendil-works/pi-agent-core"
import { contentText, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { fakeText, installFakeProvider } from "../../fake-provider"

interface ProbeOutcome {
  /** 探针工具是否真的执行过。fail-closed 语义要求它始终为 false。 */
  executed: boolean
  toolResultTexts: string[]
  toolResultErrors: boolean[]
}

/**
 * 用 faux provider 驱动一个只含探针工具的 Pi Agent，`beforeToolCall` 由用例注入。
 *
 * 这里直接跑 Pi 的 Agent 而不是 Desk-Pet 的运行时：被测的是 Pi 原生 hook 契约本身 ——
 * `pi/runtime.ts` 的整个工具门禁就挂在 `beforeToolCall` 上，它一旦不 fail-closed，
 * 安全策略就只是建议。
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

const scene: SceneDef = {
  meta: {
    caseId: "safety-hook-errors",
    module: "safety",
    contractId: "sf-10",
    description: "Pi 原生 beforeToolCall 门禁 fail-closed",
    depth: "deep",
    suite: "safety",
    tags: ["safety", "boundary", "error"],
  },
  setup: async () => { installFakeProvider([fakeText("Hook 门禁检查完成")]) },
  turns: [{
    index: 1,
    description: "验证 beforeToolCall 的 fail-closed 语义",
    userText: "检查 Hook 门禁。",
    checks: [{ type: "expectSafety", run: async () => {
      // 1) block：hook 拒绝时工具不得执行，且必须留下 error 工具结果与可诊断原因。
      const blocked = await runProbeAgent(async () => ({ block: true, reason: "blocked-by-hook" }))
      if (blocked.executed) throw new Error("beforeToolCall 返回 block 后探针工具仍被执行")
      if (!blocked.toolResultErrors.some(Boolean)) throw new Error("被拦截的调用没有产生 error 工具结果")
      if (!blocked.toolResultTexts.some(text => text.includes("blocked-by-hook"))) throw new Error("block 原因没有回传给模型")

      // 2) throw：hook 抛错时 Pi 同样 fail-closed（agent-loop 把异常转成 error 工具结果，工具不执行）。
      const thrown = await runProbeAgent(async () => { throw new Error("hook-boom") })
      if (thrown.executed) throw new Error("beforeToolCall 抛错后探针工具仍被执行")
      if (!thrown.toolResultErrors.some(Boolean)) throw new Error("抛错的 hook 没有产生 error 工具结果")
      if (!thrown.toolResultTexts.some(text => text.includes("hook-boom"))) throw new Error("hook 异常没有作为工具错误回传")
    } }],
  }],
}

export default scene
