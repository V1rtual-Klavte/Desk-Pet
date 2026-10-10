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
import { installPiRuntimeProviderForTest } from "@/services/engine/harness"

/** 时间片段的形态：与生产同形，但按形态写死、不复用生产实现（不用被测代码验证被测代码）。 */
const TURN_NOTE_PATTERN = /^\[当前时间\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/

/**
 * 记忆召回块的表头：与生产同形、按形态写死。它排在尾随注记之前，也是「这一回合新加的」
 * 内容之一，所以同样是场景判读「最后一条真实输入」时应当跳过的部分。
 */
const MEMORY_RECALL_HEADER = "[记忆与会话参考]"

/**
 * 请求视图里「最后一条真实输入」的文本：跳过宿主逐请求附加的尾随瞬时注记（当前时间）
 * 与记忆召回块。
 *
 * 注记落在消息数组最末（`createTurnNoteMessage`），而脚本按文本判别请求时依赖的是
 * 「最后一条就是这次投进来的输入」这条隐式约定 —— 不跳过它，判别会全部错位。
 * 注记在 Provider 层已经是 user 消息（`custom` 被投影掉了、`customType` 不再可见），
 * 所以这里只能按内容形态识别。
 *
 * 本函数是这条判读的**唯一实现**：此前 16 个场景各自写了一份「取最后一条」，注记落地后
 * 每一份都得记得跳过它 —— 同一处知识散在 16 个地方，漏一个就是一条难查的假失败。
 */
export function lastRequestText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const content = context.messages[index]?.content
    const text = typeof content === "string"
      ? content
      : (content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
    if (!TURN_NOTE_PATTERN.test(text) && !text.startsWith(MEMORY_RECALL_HEADER)) return text
  }
  return ""
}

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
   * 系统块与工具 schema 是否进去了、请求落在哪个模型上），而不是只断言回复非空。
   * `model` 是宿主解析出的模型 id —— 辅助模型路由（ai.auxModel）只在这里可观测。
   */
  const payloads: Array<{ model: string; systemPrompt: Context["systemPrompt"]; messages: Context["messages"]; tools: Context["tools"] }> = []
  const restore = installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
      payloads.push({ model: requestModel.id, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools })
      // 交出的 payload 要和真实 provider 的请求体同形：pi-ai 的 base options 会把生效的
      // maxTokens（调用方没给就用模型能力值）落成 max_tokens/max_completion_tokens，
      // 宿主 before_payload 才可能采集到请求参数（快照的 requestParams）。替身漏掉它，
      // 「payload 参数 → 快照」这条链路在 Live 宿主里就永远不可达。
      options?.onPayload?.({
        model: requestModel.id,
        messages: context.messages,
        tools: context.tools,
        max_tokens: options?.maxTokens ?? requestModel.maxTokens,
      }, requestModel)
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
