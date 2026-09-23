import { describeInputDelivery } from "@/services/engine/pi"
import { inputSourceOf, messageRequestId } from "@/services/engine/runtime"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

const IDLE_TEXT = "空闲路径的一句话"
const REQUEST_ID = "runtime-idle-input-identity"
const INPUT_EVENT_ID = `${REQUEST_ID}:user`

let idleStage: string | undefined

/** 读一次阶段；读取失败（`ok:false`）在本场景按「读不到」处理（等待循环会重试）。 */
async function readStage(sessionId: string): Promise<string | undefined> {
  const lookup = await describeInputDelivery(sessionId, REQUEST_ID)
  return lookup.ok ? lookup.evidence?.stage : undefined
}

export const 空闲输入身份: SceneDef = {
  meta: {
    caseId: "runtime-idle-input-identity",
    module: "agent-runtime",
    contractId: "ar-12",
    description: "空闲发送的用户输入也带持久身份与来源标记：条目按 requestId 反查得到 deskpetEventId 与 deskpetSource，投递证据链对空闲路径同样走到 request_prepared（拿到回执则为 responded）",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "delivery-intent", "identity", "persistence", "memory-boundary"],
  },
  setup: async () => {
    installFakeProvider([fakeText("收到啦，慢慢说。"), fakeText("确认完成")])
    await initChat()
    const sessionId = getActiveSessionId()
    await sendMessage(IDLE_TEXT, { requestId: REQUEST_ID })
    // 快照在回合收尾后异步落盘：等一小会儿再核对，不把写入时序当成能力缺失。
    for (let attempt = 0; attempt < 40; attempt++) {
      const stage = await readStage(sessionId)
      if (stage === "request_prepared" || stage === "responded") break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    idleStage = await readStage(sessionId)
  },
  turns: [{
    index: 1,
    description: "核对空闲输入的条目身份、来源标记与投递证据",
    userText: "确认一下空闲路径的身份。",
    checks: [{
      type: "expectIdleInputIdentityPersisted",
      run: async () => {
        const entries = await sessionEntries()
        const idleUser = entries.flatMap(entry => entry.type === "message" ? [entry.message] : [])
          .find(message => message.role === "user"
            && (message as { deskpetEventId?: unknown }).deskpetEventId === INPUT_EVENT_ID)
        if (!idleUser) {
          throw new Error(`会话条目里没有身份为 ${INPUT_EVENT_ID} 的用户消息：空闲输入仍是裸字符串`)
        }
        // 身份按生产读法回读：宿主 requestId 能从条目反查出来（证据链按它关联这条输入）。
        const roundTrip = messageRequestId(idleUser as { deskpetEventId?: unknown })
        if (roundTrip !== REQUEST_ID) {
          throw new Error(`条目身份不能反查回 ${REQUEST_ID}，实际 ${String(roundTrip)}`)
        }
        const source = inputSourceOf(idleUser as { deskpetSource?: unknown })
        if (!source) throw new Error("用户条目没有 deskpetSource 来源标记")
        if (source.taint !== "trusted_user") {
          throw new Error(`来源标记 taint 应为 trusted_user，实际 ${source.taint}`)
        }
        if (source.eligibleForMemory !== true) {
          throw new Error(`来源标记 eligibleForMemory 应为 true，实际 ${String(source.eligibleForMemory)}`)
        }
        if (idleStage !== "request_prepared" && idleStage !== "responded") {
          throw new Error(`空闲输入的证据链应至少到 request_prepared，实际 ${String(idleStage)}`)
        }
      },
    }],
  }],
}

export default 空闲输入身份
