import { harnessSlots } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 会话运行槽: SceneDef = {
  meta: {
    caseId: "session-harness-slot-generation",
    module: "agent-runtime",
    contractId: "ar-04",
    description: "主回合由会话运行槽持有，代际单调且旧代际无法结束新 run",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "session", "generation", "boundary"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("运行槽回合完成")])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "完成生产回合并验证代际所有权",
    userText: "验证会话运行槽。",
    checks: [{
      type: "expectHarnessSlotGenerationGuard",
      run: async () => {
        provider?.restore()
        provider = undefined
        const sessionId = getActiveSessionId()
        const completed = harnessSlots.snapshot(sessionId)
        if (!completed || completed.state !== "idle" || !completed.hasLane) {
          throw new Error(`回合结束后的槽异常: ${JSON.stringify(completed)}`)
        }
        const oldGeneration = completed.generation
        const nextGeneration = harnessSlots.begin(sessionId)
        if (nextGeneration === undefined || nextGeneration <= oldGeneration) {
          throw new Error(`新代际未推进: ${oldGeneration} -> ${String(nextGeneration)}`)
        }
        if (harnessSlots.isRunning(sessionId) !== true) throw new Error("begin 后槽不是 running")
        if (harnessSlots.end(sessionId, oldGeneration)) throw new Error("旧代际错误结束了新 run")
        if (harnessSlots.isRunning(sessionId) !== true) throw new Error("旧代际清理后新 run 已丢失")
        if (!harnessSlots.end(sessionId, nextGeneration)) throw new Error("当前代际无法正常结束")

        // 释放空闲槽后重建：代际在注册表层继续单调，旧 cleanup 的 end 不能命中新 run（ABA）。
        if (!harnessSlots.releaseWhenIdle(sessionId)) throw new Error("空闲槽未释放")
        const recreatedGeneration = harnessSlots.begin(sessionId)
        if (recreatedGeneration === undefined || recreatedGeneration <= nextGeneration) {
          throw new Error(`槽重建后代际回退: ${String(nextGeneration)} -> ${String(recreatedGeneration)}`)
        }
        if (harnessSlots.end(sessionId, nextGeneration)) throw new Error("重建前的旧代际错误结束了新 run")
        if (!harnessSlots.end(sessionId, recreatedGeneration)) throw new Error("重建后的代际无法正常结束")

        // drain 代际：同一槽上并发 drain 只保留一个 worker，旧 finally 不清空新 drain。
        let releaseFirst!: () => void
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
        const firstDrain = harnessSlots.drain(sessionId, async () => { await firstGate })
        if (harnessSlots.drain(sessionId, async () => {}) !== firstDrain) {
          throw new Error("并发 drain 未复用同一 worker")
        }
        releaseFirst()
        await firstDrain

        // 空闲槽上的停止请求必须如实失败：不能返回「已停止、无归还项」的空成功，
        // 否则一次从未发生的停止会被上报成成功（lane.abort 的 NoActiveOperation 分支）。
        const openSlot = harnessSlots.get(sessionId)
        if (await openSlot.abort() !== undefined) {
          throw new Error("空闲槽上的停止不应报告已归还项")
        }
        if (harnessSlots.isRunning(sessionId)) throw new Error("空闲槽停止后不应处于运行态")

        harnessSlots.releaseWhenIdle(sessionId)
      },
    }],
  }],
}

export default 会话运行槽
