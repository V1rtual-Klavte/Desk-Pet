// ── 场景口径：阶段状态行只发语义 key，文案由界面按当前 Card 取 ──
//
// 反例形状：内核不再持有台词，只发 `deskpet-stage-hint { sessionId, stage }`。
// ① 这条事件不发 → 状态行永远停在上一条工具提示上（「思考中」永远不出现）；
// ② 事件里塞的是硬编码文本而不是语义 key → Card 的定制语气静默失效，界面看不出差别。
// 两种都只有跑一次真实回合、从事件通道取证据才分得清。
//
// 本场景用生产入口跑一个无工具的普通回合，断言「回合开始发了 thinking 语义 key，
// 且负载里没有文案字段」；文案侧由 personality-card 的 stage-prompt-link 钉住。

import { listen } from "@tauri-apps/api/event"
import { initChat, sendMessage } from "@/services/agent/runner"
import { formatError } from "@/services/error"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const STAGE_EVENT = "deskpet-stage-hint"
const USER_TEXT = "随便聊一句。"
const REPLY = "好呀，聊什么呢？"
const SETTLE_REPLY = "核对上一回合的阶段状态行证据。"
/** 语义 key 白名单：负载里出现别的字符串就说明有人把台词塞回来了。 */
const STAGE_KEYS = ["thinking", "planning", "retry"]

const TURN_SETTLE_MS = 60_000
const HINT_DRAIN_MS = 5_000

/** 收到的事件负载，按到达顺序存（事件经 IPC 回环投递，断言前有界等待）。 */
let hints: Array<Record<string, unknown>> = []
let outputReply = ""
let turnError: string | undefined

/** 有界轮询：到点返回 false，由断言给出可读原因，不把失败拖成场景超时。 */
async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
  return predicate()
}

export const 阶段状态行: SceneDef = {
  meta: {
    caseId: "runtime-stage-hint-thinking",
    module: "agent-runtime",
    contractId: "ar-20",
    description: "回合开始经 deskpet-stage-hint 发出 thinking 语义 key，负载不含任何文案",
    depth: "shallow",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "stages"],
  },
  setup: async () => {
    hints = []
    outputReply = ""
    turnError = undefined
    installFakeProvider([
      fakeText(REPLY),
      // 校验回合自己也会发一条消息（场景 runner 按 turns[].userText 投递），它需要自己的响应。
      fakeText(SETTLE_REPLY),
    ])
    // 监听在 setup 内完成取证并注销：不把监听器留给后面的场景（同一 WebView 复用）。
    const unlisten = await listen<Record<string, unknown>>(STAGE_EVENT, event => {
      hints.push(event.payload)
    })
    try {
      await initChat()
      const settled = await Promise.race([
        sendMessage(USER_TEXT).then(
          output => ({ output }),
          error => ({ error: formatError(error) }),
        ),
        new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), TURN_SETTLE_MS) }),
      ])
      if (settled === undefined) turnError = `回合没有在 ${TURN_SETTLE_MS}ms 内结束`
      else if ("error" in settled) turnError = settled.error
      else outputReply = settled.output.reply
      await waitUntil(() => hints.length > 0, HINT_DRAIN_MS)
    } finally {
      unlisten()
    }
  },
  turns: [{
    index: 1,
    description: "核对阶段事件：语义 key 到达，且负载里没有任何文案",
    userText: "核对上一回合的阶段状态行证据。",
    checks: [{
      type: "expectStageHintSemanticKey",
      run: async () => {
        if (turnError) throw new Error(`回合没有正常结束: ${turnError}`)
        if (!outputReply.includes(REPLY)) throw new Error(`回合回复不是 fake provider 的脚本输出: ${JSON.stringify(outputReply)}`)
        if (hints.length === 0) throw new Error(`回合期间没有收到 ${STAGE_EVENT}：状态行会停在上一回合的提示上`)

        for (const payload of hints) {
          const stage = payload.stage
          if (typeof stage !== "string" || !STAGE_KEYS.includes(stage)) {
            throw new Error(`阶段事件携带了非语义 key: ${JSON.stringify(payload)}`)
          }
          // 负载只允许会话身份与语义 key：出现第三个字段通常就是把文案塞回来了。
          const extra = Object.keys(payload).filter(key => key !== "sessionId" && key !== "stage")
          if (extra.length > 0) {
            throw new Error(`阶段事件负载混入了文案字段: ${JSON.stringify(extra)}`)
          }
        }
        // 回合开始时必然是 thinking：没有 tool 轮的普通回合不该出现 planning / retry。
        const stages = hints.map(payload => payload.stage as string)
        if (!stages.includes("thinking")) throw new Error(`回合开始没有发 thinking: ${JSON.stringify(stages)}`)
        if (stages.includes("retry")) throw new Error(`没有失败重试的回合却发了 retry: ${JSON.stringify(stages)}`)
      },
    }],
  }],
}

export default 阶段状态行
