import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxModelDefinition,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type Context,
  type Model,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import { installPiRuntimeProviderForTest } from "@/services/engine/pi"

/**
 * 可重复、无网络的 Pi provider。场景只提供响应脚本，真实 Agent/Tool loop 仍照常执行。
 *
 * `definition` 缺省时用 faux 的默认窗口（128k）。按预算推导载荷的场景（例如压缩场景）
 * 显式声明窗口，让场景口径与生效窗口一致，不依赖 faux 的默认值。
 */
export function installFakeProvider(responses: FauxResponseStep[], definition?: FauxModelDefinition) {
  const fake = fauxProvider({
    api: "faux",
    provider: "deskpet-fake",
    models: [definition ?? { id: "deskpet-fake", name: "Desk-Pet Fake" }],
  })
  fake.setResponses(responses)
  const model = fake.getModel()
  if (!model) throw new Error("fake provider 未创建 model")
  /**
   * 逐次请求的真实投影：场景据此断言发出去的是什么（工具结果有没有被缩短、
   * 系统块与工具 schema 是否进去了），而不是只断言回复非空。
   */
  const payloads: Array<{ messages: Context["messages"]; tools: Context["tools"] }> = []
  const restore = installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
      payloads.push({ messages: context.messages, tools: context.tools })
      options?.onPayload?.({ model: requestModel.id, messages: context.messages, tools: context.tools }, requestModel)
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
  return {
    state: fake.state,
    model,
    restore,
    payloads,
    appendResponses: (next: FauxResponseStep[]) => fake.appendResponses(next),
  }
}

export function fakeText(text: string): AssistantMessage {
  return fauxAssistantMessage(fauxText(text))
}

export function fakeToolCall(name: string, arguments_: Record<string, unknown> = {}, id = "fake-call-1"): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: "toolUse" })
}

/**
 * 「正文以 RUNTIME_DATA 开头 + 工具调用」的消息：HN-04 的复现形状 —— 这条消息没有任何
 * 可见增量（正文整体被瞬时展示过滤器挡下），但仍然是工具轮的一环。
 */
export function fakeRuntimeDataHeadToolCall(
  text: string, name: string, arguments_: Record<string, unknown> = {}, id = "fake-call-1",
): AssistantMessage {
  return fauxAssistantMessage([fauxText(text), fauxToolCall(name, arguments_, { id })], { stopReason: "toolUse" })
}
