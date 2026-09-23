// ── 场景口径：assistant 消息边界无条件重置瞬时展示过滤器（HN-04）──
//
// 反例形状：一条消息的正文以 `<RUNTIME_DATA>` 开头 —— 它的整段正文都被瞬时展示过滤器
// 挡下，一个可见增量都没有。旧实现只在「这条消息产生过可见增量」时才在消息边界上报结束，
// 于是过滤器一直停在 stopped；同一回合后面那条消息的正文因此一个字都进不了
// `deskpet-assistant-stream` —— 界面看不到，用户只看到回复突然"卡"在那里。
//
// 本场景用 fake provider 的**工具轮**造这个形状：消息 1 = 协议块开头的正文 + 工具调用，
// 消息 2 = 正常正文。断言两条：① 消息 2 的正文进入流式通道；② 协议块之后的内容没有泄漏。

import { listen } from "@tauri-apps/api/event"
import { initChat, sendMessage } from "@/services/agent/runner"
import { formatError } from "@/services/error"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeRuntimeDataHeadToolCall, fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const TOOL_NAME = "live_hn04_stream_probe"
const STREAM_EVENT = "deskpet-assistant-stream"
const USER_TEXT = "跑一次带工具轮的回合。"
/** 消息 1 的正文以协议块开头：整条消息没有任何可见增量。 */
const HIDDEN_TEXT = "第一段不应该被展示"
/** 消息 2 的正文：修复前过滤器停在 stopped，这段一个字都进不了流式通道。 */
const VISIBLE_TEXT = "第二段正文必须可见。"
const SETTLE_REPLY = "核对上一回合的流式证据。"

/**
 * 事件经 IPC 回环投递，断言前有界等待它落地（不赌「resolve 时事件已经排空」）。
 * 超时不在这里报错：等不到就是断言要说的那件事，由断言给出可读原因。
 */
const TOOL_ENTER_MS = 20_000
const TURN_SETTLE_MS = 60_000
const STREAM_DRAIN_MS = 5_000

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let streamDeltas: string[] = []
let deltasText = ""
let outputReply = ""
let turnError: string | undefined

/** 有界轮询：到点返回 false，由调用方给出可读原因，不把失败拖成场景超时。 */
async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
  return predicate()
}

export const 流式消息边界: SceneDef = {
  meta: {
    caseId: "runtime-stream-reset-tool-round",
    module: "agent-runtime",
    contractId: "ar-19",
    description: "消息 1 的可见增量为空时，消息 2 的正文仍被展示（过滤器在每条消息边界重置）",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "stream", "tool"],
  },
  setup: async () => {
    streamDeltas = []
    deltasText = ""
    outputReply = ""
    turnError = undefined
    blocking = registerBlockingTool(TOOL_NAME)
    installFakeProvider([
      // 消息 1：RUNTIME_DATA 开头（没有可见正文）+ 工具调用 —— 修复前 streamActive 保持 false
      fakeRuntimeDataHeadToolCall(`<RUNTIME_DATA>{}</RUNTIME_DATA>${HIDDEN_TEXT}`, TOOL_NAME),
      // 消息 2：工具轮之后的正文，必须进入流式通道
      fakeText(VISIBLE_TEXT),
      // 校验回合的响应（本场景的全部断言针对上面那次回合）
      fakeText(SETTLE_REPLY),
    ])
    // 监听在 setup 内完成取证并注销：不把监听器留给后面的场景（同一 WebView 复用）。
    const unlisten = await listen<{ sessionId?: string; delta?: string }>(STREAM_EVENT, event => {
      if (event.payload.delta) streamDeltas.push(event.payload.delta)
    })
    try {
      await initChat()
      let toolEntered = false
      void blocking.started.then(() => { toolEntered = true })
      const turn = sendMessage(USER_TEXT)
        .then(output => ({ output }), error => ({ error: formatError(error) }))
      if (!await waitUntil(() => toolEntered, TOOL_ENTER_MS)) {
        throw new Error(`工具没有在 ${TOOL_ENTER_MS}ms 内进入执行：fake provider 的脚本没有被取走`)
      }
      blocking.release()
      const settled = await Promise.race([
        turn,
        new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), TURN_SETTLE_MS) }),
      ])
      if (settled === undefined) turnError = `回合没有在 ${TURN_SETTLE_MS}ms 内结束`
      else if ("error" in settled) turnError = settled.error
      else outputReply = settled.output.reply
      await waitUntil(() => streamDeltas.join("").includes(VISIBLE_TEXT), STREAM_DRAIN_MS)
      deltasText = streamDeltas.join("")
    } finally {
      blocking.dispose()
      unlisten()
    }
  },
  turns: [{
    index: 1,
    description: "工具轮之后的消息正文仍进入流式通道",
    userText: "核对上一回合的流式展示证据。",
    checks: [{
      type: "expectStreamResetAcrossMessages",
      run: async () => {
        if (turnError !== undefined) throw new Error(`上一次回合没有正常结束: ${turnError}`)
        if (!outputReply.includes(VISIBLE_TEXT)) {
          throw new Error(`回合回复异常: ${JSON.stringify(outputReply)}`)
        }
        if (!deltasText.includes(VISIBLE_TEXT)) {
          throw new Error(`消息 2 的正文没有进入 ${STREAM_EVENT}（修复前为空）: ${JSON.stringify(streamDeltas)}`)
        }
        if (deltasText.includes(HIDDEN_TEXT)) {
          throw new Error("RUNTIME_DATA 之后的内容泄漏进了流式展示")
        }
      },
    }],
  }],
}

export default 流式消息边界
