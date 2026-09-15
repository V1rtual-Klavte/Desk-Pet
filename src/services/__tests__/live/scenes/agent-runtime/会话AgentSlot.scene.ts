import { agentSlots } from "@/services/engine/runtime"
import { getActiveSessionId } from "@/services/session"
import { initChat } from "@/services/agent/runner"
import { installFakeProvider, fakeText } from "../../fake-provider"
import type { SceneDef } from "../../types"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 会话AgentSlot: SceneDef = {
  meta: {
    caseId: "session-agent-slot-generation",
    module: "agent-runtime",
    contractId: "ar-04",
    description: "主回合由会话 AgentSlot 持有，旧 generation 无法结束新 run",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "session", "generation", "boundary"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("AgentSlot 回合完成")])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "完成生产回合并验证 generation 所有权",
    userText: "验证会话运行槽。",
    checks: [{
      type: "expectSessionSlotGenerationGuard",
      run: async () => {
        provider?.restore()
        provider = undefined
        const sessionId = getActiveSessionId()
        const completed = agentSlots.snapshot(sessionId)
        if (!completed || completed.state !== "idle" || !completed.hasAgent) {
          throw new Error(`回合结束后的 slot 异常: ${JSON.stringify(completed)}`)
        }
        const oldGeneration = completed.generation
        const nextGeneration = agentSlots.begin(sessionId)
        if (nextGeneration === undefined || nextGeneration <= oldGeneration) {
          throw new Error(`新 generation 未推进: ${oldGeneration} -> ${String(nextGeneration)}`)
        }
        if (agentSlots.end(sessionId, oldGeneration)) {
          throw new Error("旧 generation 错误结束了新 run")
        }
        if (!agentSlots.isRunning(sessionId)) throw new Error("旧 generation 清理后新 run 已丢失")
        if (!agentSlots.end(sessionId, nextGeneration)) throw new Error("当前 generation 无法正常结束")
      },
    }],
  }],
}

export default 会话AgentSlot
