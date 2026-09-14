import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
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
    streamFn: fake.provider.streamSimple.bind(fake.provider),
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
