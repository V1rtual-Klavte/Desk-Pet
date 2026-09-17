import { AgentSlotRegistry, agentSlots } from "@/services/engine/runtime"
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

        // 删除后重建不能把 generation/drainGeneration 退回 1，否则延迟 finally 能
        // 命中新 slot，错误结束新 run 或清空新 drainPromise（ABA）。
        const registry = new AgentSlotRegistry()
        const firstGeneration = registry.begin("aba-session")
        if (firstGeneration === undefined || !registry.end("aba-session", firstGeneration)) throw new Error("ABA 前置 run 无法结束")
        if (!registry.releaseWhenIdle("aba-session")) throw new Error("ABA 前置 slot 未释放")
        const recreatedGeneration = registry.begin("aba-session")
        if (recreatedGeneration === undefined || recreatedGeneration <= firstGeneration) {
          throw new Error(`slot 重建后 generation 回退: ${String(firstGeneration)} -> ${String(recreatedGeneration)}`)
        }
        if (registry.end("aba-session", firstGeneration)) throw new Error("重建前 generation 错误结束了新 slot")

        let releaseFirst!: () => void
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
        const firstDrain = registry.drain("aba-drain", async () => { await firstGate })
        registry.reset()
        let releaseSecond!: () => void
        const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
        const secondDrain = registry.drain("aba-drain", async () => { await secondGate })
        releaseFirst()
        await firstDrain
        if (registry.drain("aba-drain", async () => {}) !== secondDrain) {
          throw new Error("旧 drain finally 清空了重建 slot 的 drainPromise")
        }
        releaseSecond()
        await secondDrain
      },
    }],
  }],
}

export default 会话AgentSlot
