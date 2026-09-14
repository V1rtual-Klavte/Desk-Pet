import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
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
 */
export function installFakeProvider(responses: FauxResponseStep[]) {
  const fake = fauxProvider({
    api: "faux",
    provider: "deskpet-fake",
    models: [{ id: "deskpet-fake", name: "Desk-Pet Fake" }],
  })
  fake.setResponses(responses)
  const model = fake.getModel()
  if (!model) throw new Error("fake provider 未创建 model")
  const restore = installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
      options?.onPayload?.({ model: requestModel.id, messages: context.messages, tools: context.tools }, requestModel)
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
  return {
    state: fake.state,
    model,
    restore,
    appendResponses: (next: FauxResponseStep[]) => fake.appendResponses(next),
  }
}

export function fakeText(text: string): AssistantMessage {
  return fauxAssistantMessage(fauxText(text))
}

export function fakeToolCall(name: string, arguments_: Record<string, unknown> = {}, id = "fake-call-1"): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: "toolUse" })
}
