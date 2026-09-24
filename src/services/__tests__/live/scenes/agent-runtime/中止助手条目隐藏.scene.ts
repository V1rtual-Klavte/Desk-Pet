import type { Entry, StreamFn } from "@earendil-works/pi-agent-core"
import { fauxProvider } from "@earendil-works/pi-ai"
import type {
  AssistantMessage, AssistantMessageEventStream, Context, FauxModelDefinition, FauxResponseStep, Model, SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import { listen } from "@tauri-apps/api/event"
import { installPiRuntimeProviderForTest } from "@/services/engine/pi"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent/runner"
import { DESKPET_SYSTEM_MESSAGE_ENTRY } from "@/services/engine/runtime"
import { getActiveSessionId } from "@/services/session"
import { chatHistory } from "@/services/session/store"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall } from "../../fake-provider"
import { assistantTexts, entryMessageText, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 回合读模型显示语义（STATE-03 / FIX-48）：中止/出错的助手条目不进聊天视图；系统提示落盘可回读。
 *
 * 「半截气泡」的现场只能由**生成中途停止**造出来：停止落在工具执行期时，上游的取消路径只结算
 * 工具结果与操作终态，不提交助手条目；只有 `assistant.effect_pending`（生成在飞）被取消时，
 * 上游才把「已收到的部分内容」按 `stopReason: "error" | "aborted"` 提交成助手条目
 * （pi-agent-core 的 `recoverCancelledAssistantEffect` / `publishResponse` 的取消分支）。
 * 因此本场景按两段取证：
 *   ① 规范形状的那次停止（工具执行期间停止）—— 证明停止不是失败、宿主写下停止凭证；
 *   ② 流式输出途中停止 —— 制造出 error/aborted 的助手条目，核对它不进聊天视图（实时与重读）。
 *
 * 流式速度用 faux provider 的 `tokensPerSecond` 拉长（`installFakeProvider` 不暴露该选项）：
 * 只有生成长到「输出到一半」时，停止才落在 `assistant.effect_pending` 上。
 */
const STREAMING_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake" }
/** 生成速度：约 1 秒一块增量，停止窗口有秒级余量（不靠固定 sleep 抢时序，见 waitUntil）。 */
const TOKENS_PER_SECOND = 3
const STREAM_EVENT = "deskpet-assistant-stream"

const TOOL_NAME = "live_t313_abort_hide_wait"
const FIRST_TURN_TEXT = "开始一个会被停止的任务。"
const STREAMED_TURN_TEXT = "这条回复会在输出途中被停止。"
const CONFIRM_TURN_TEXT = "确认一下。"
const CONFIRM_REPLY = "确认完成"
const TURN_REPLY = "核对完成"

/** 被中止那次运行的「过程文案」：标记必须落在第一块增量里，之后才是填充。 */
const MARKER = "半截气泡"
const PROCESS_TEXT = `${MARKER}${"这是停止后不该出现在聊天视图里的过程正文。".repeat(12)}`
/** 攒够这么多可见增量再停：生成确实在飞，且部分内容已进入提交路径。 */
const STREAM_WINDOW_CHARS = 60
/** 有界等待：等不到就是断言要说的那件事，由断言给出可读原因，不把失败拖成场景超时。 */
const STREAM_HEADER_MS = 30_000
const TURN_SETTLE_MS = 30_000
const ENTRY_LANDED_MS = 3_000

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let sessionId = ""
let stoppedDuringTool: boolean | undefined
let firstTurnReply: string | undefined
let streamedText = ""
let streamWindowOpened = false
let stoppedDuringStream = false
let secondTurnReply: string | undefined
/** 逐次请求的正文投影：核对系统提示没有进模型上下文。 */
let payloads: string[] = []

function installStreamingProvider(responses: FauxResponseStep[]): ReturnType<typeof installPiRuntimeProviderForTest> {
  const fake = fauxProvider({
    api: "faux",
    provider: "deskpet-fake",
    models: [STREAMING_MODEL],
    // 流式增量：没有它整个响应在一个微任务里结束，不存在「输出到一半」的窗口。
    tokensPerSecond: TOKENS_PER_SECOND,
  })
  fake.setResponses(responses)
  const model = fake.getModel()
  if (!model) throw new Error("fake provider 未创建 model")
  const captured: string[] = []
  payloads = captured
  return installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
      captured.push(context.messages.map(message => JSON.stringify(message.content)).join("\n"))
      options?.onPayload?.({ model: requestModel.id, messages: context.messages, tools: context.tools }, requestModel)
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
}

/** 有界轮询：到点返回 false，把超时交给调用方给出可读原因。 */
async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>(resolve => { setTimeout(resolve, 25) })
  }
  return predicate()
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) }),
  ])
}

/** 中止/出错的助手条目：本覆盖点的观测对象（按 role 收窄，正文取原始条目）。 */
type AssistantEntry = Extract<Entry, { type: "message" }> & { message: AssistantMessage }

function abortedAssistantEntries(entries: readonly Entry[]): AssistantEntry[] {
  return entries.filter((entry): entry is AssistantEntry =>
    entry.type === "message" && entry.message.role === "assistant"
    && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted"))
}

function systemMessageEntries(entries: readonly Entry[]): Extract<Entry, { type: "custom" }>[] {
  return entries.filter((entry): entry is Extract<Entry, { type: "custom" }> =>
    entry.type === "custom" && entry.customType === DESKPET_SYSTEM_MESSAGE_ENTRY)
}

function entrySystemText(entry: Extract<Entry, { type: "custom" }>): string {
  return String((entry.data as { text?: unknown } | undefined)?.text ?? "")
}

export const 中止助手条目隐藏: SceneDef = {
  meta: {
    caseId: "runtime-aborted-assistant-hidden",
    module: "agent-runtime",
    contractId: "ar-14",
    description: "中止/出错的助手条目不进聊天视图（实时与重读一致），系统提示以 deskpet.system_message 落盘可回读且不进模型上下文",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "cancel", "stop", "persistence"],
  },
  setup: async () => {
    const restore = installStreamingProvider([
      fakeToolCall(TOOL_NAME),
      fakeText(PROCESS_TEXT),
      fakeText(CONFIRM_REPLY),
      fakeText(TURN_REPLY),
    ])
    // 监听在 setup 内完成取证并注销：不把监听器留给后面的场景（同一 WebView 复用）。
    const unlisten = await listen<{ sessionId?: string; delta?: string }>(STREAM_EVENT, event => {
      if (event.payload.delta) streamedText += event.payload.delta
    })
    try {
      await initChat()
      sessionId = getActiveSessionId()
      blocking = registerBlockingTool(TOOL_NAME)

      // ① 规范形状：工具执行期间停止（停止不是失败，宿主会写下「已停止本次回复」系统提示）。
      const firstTurn = sendMessage(FIRST_TURN_TEXT)
      await blocking.started
      stoppedDuringTool = (await stopActiveRun(sessionId)) !== undefined
      const settledFirst = await bounded(firstTurn, TURN_SETTLE_MS)
      firstTurnReply = settledFirst === undefined ? "timeout" : settledFirst.reply

      // ② 流式输出途中停止：取消落在 assistant.effect_pending 上，上游把部分内容按 error/aborted 提交成助手条目。
      streamedText = ""
      const secondTurn = sendMessage(STREAMED_TURN_TEXT)
      streamWindowOpened = await waitUntil(() => streamedText.length >= STREAM_WINDOW_CHARS, STREAM_HEADER_MS)
      stoppedDuringStream = (await stopActiveRun(sessionId)) !== undefined
      const settledSecond = await bounded(secondTurn, TURN_SETTLE_MS)
      secondTurnReply = settledSecond === undefined ? "timeout" : settledSecond.reply

      // ③ 再发一条普通消息：让停止写下的系统提示有机会落盘（审计条目在下一个 drive 收尾 flush）。
      await sendMessage(CONFIRM_TURN_TEXT)
    } finally {
      unlisten()
      restore()
    }
  },
  turns: [{
    index: 1,
    description: "核对中止条目对视图的可见性与系统提示的落盘",
    userText: "核对上面的停止证据。",
    checks: [{
      type: "expectAbortedAssistantHiddenAndSystemMessagePersisted",
      run: async () => {
        blocking?.dispose()
        // 场景前提：两次停止都真的命中运行中的槽，且流式那次确实产生了可见增量。
        if (!stoppedDuringTool) throw new Error("工具执行期间的停止没有命中运行中的槽：规范形状的现场不成立")
        if (firstTurnReply !== "") throw new Error(`主动停止不该有助手正文: ${JSON.stringify(firstTurnReply)}`)
        if (!stoppedDuringStream) throw new Error("流式输出途中的停止没有命中运行中的槽")
        if (secondTurnReply !== "") throw new Error(`流式期间的停止不该有助手正文: ${JSON.stringify(secondTurnReply)}`)
        if (!streamWindowOpened || streamedText.length < STREAM_WINDOW_CHARS) {
          throw new Error(`生成没有在流式窗口内产生可见增量（${streamedText.length} 字）：停止不在「输出到一半」的时刻`)
        }
        if (!streamedText.includes(MARKER)) {
          throw new Error(`流式增量不是脚本正文（缺 ${MARKER}）：fake provider 的脚本错位，本场景判定依据失效`)
        }

        // ① 原始条目里必须真的存在中止/出错的助手条目 —— 这是本覆盖点的观测对象。
        const entries = await sessionEntries(sessionId)
        const abortedEntries = abortedAssistantEntries(entries)
        if (abortedEntries.length === 0) {
          throw new Error("流式期间停止后会话里没有 error/aborted 的助手条目：半截气泡没有真的产生，本断言无观测对象")
        }
        const visible = await sessionMessages(sessionId)
        const viewIds = new Set(visible.map(message => message.id))
        const liveIds = new Set(chatHistory.map(message => message.id))
        for (const entry of abortedEntries) {
          if (viewIds.has(entry.id)) {
            throw new Error(`中止的助手条目进了读模型视图（重启后会冒出来）: ${entry.id}`)
          }
          if (liveIds.has(entry.id)) throw new Error(`中止的助手条目进了实时聊天视图: ${entry.id}`)
        }
        // 被中止的那条正文只能是脚本正文的前缀（半截），不能是别的回复或整段正文。
        const abortedTexts = abortedEntries
          .map(entry => entryMessageText(entry.message).trim())
          .filter(text => text.length > 0)
        if (abortedTexts.some(text => !PROCESS_TEXT.startsWith(text))) {
          throw new Error(`中止条目的正文不是被停止那次生成的前缀: ${JSON.stringify(abortedTexts)}`)
        }

        // ③ 助手正文里不含被中止那次运行的过程文案：实时视图与重读视图两条都不能漏。
        const visibleAssistant = assistantTexts(visible)
        const leakedToView = visibleAssistant.filter(text => {
          const trimmed = text.trim()
          return trimmed.length >= MARKER.length && PROCESS_TEXT.includes(trimmed)
        })
        if (leakedToView.length > 0) {
          throw new Error(`被中止的过程正文进了读模型视图: ${JSON.stringify(leakedToView)}`)
        }
        const leakedToLive = chatHistory
          .filter(message => message.role === "assistant")
          .map(message => message.text.trim())
          .filter(text => text.length >= MARKER.length && PROCESS_TEXT.includes(text))
        if (leakedToLive.length > 0) {
          throw new Error(`被中止的过程正文进了实时聊天视图: ${JSON.stringify(leakedToLive)}`)
        }

        // ② 系统提示以 deskpet.system_message 落盘，并经同一读模型投影成 system 消息（可回读）。
        // 落盘与投影是两条异步路径：有界等待条目落地，不用固定 sleep。
        let systemEntries = systemMessageEntries(entries)
        await waitUntil(() => systemEntries.length > 0, ENTRY_LANDED_MS)
        systemEntries = systemMessageEntries(await sessionEntries(sessionId))
        if (systemEntries.length === 0) throw new Error("停止后没有 deskpet.system_message 条目：系统提示只活在内存里")
        const persistedTexts = systemEntries.map(entrySystemText)
        const stopNotice = persistedTexts.find(text => text.includes("已停止本次回复"))
        if (stopNotice === undefined) {
          throw new Error(`系统提示条目里没有停止凭证: ${JSON.stringify(persistedTexts)}`)
        }
        const systemMessages = visible.filter(message => message.role === "system").map(message => message.text)
        if (!systemMessages.includes(stopNotice)) {
          throw new Error(`系统提示条目不能按读模型回读: ${JSON.stringify(systemMessages)} vs ${JSON.stringify(stopNotice)}`)
        }
        // 停止凭证不是模型回复：助手正文里不该出现同一条文案。
        if (visibleAssistant.some(text => text.includes("已停止本次回复"))) {
          throw new Error("停止凭证被写成了助手正文")
        }

        // 该条目不进模型上下文：停止之后仍发生过请求，最后一次请求的正文不含这条系统提示。
        const lastPayload = payloads[payloads.length - 1]
        if (lastPayload === undefined) throw new Error("没有采集到请求正文，无法核对系统提示是否进模型上下文")
        if (lastPayload.includes(stopNotice)) throw new Error("deskpet.system_message 条目进了模型上下文")

        if (userTexts(visible).filter(text => text === FIRST_TURN_TEXT).length !== 1) {
          throw new Error(`被停止的回合正文未恰好持久化一次: ${JSON.stringify(userTexts(visible))}`)
        }
      },
    }],
  }],
}

export default 中止助手条目隐藏
