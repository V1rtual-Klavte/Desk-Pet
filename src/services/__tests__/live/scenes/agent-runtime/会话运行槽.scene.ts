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
        if (!await harnessSlots.releaseWhenIdle(sessionId)) throw new Error("空闲槽未释放")
        const recreatedGeneration = harnessSlots.begin(sessionId)
        if (recreatedGeneration === undefined || recreatedGeneration <= nextGeneration) {
          throw new Error(`槽重建后代际回退: ${String(nextGeneration)} -> ${String(recreatedGeneration)}`)
        }
        if (harnessSlots.end(sessionId, nextGeneration)) throw new Error("重建前的旧代际错误结束了新 run")
        if (!harnessSlots.end(sessionId, recreatedGeneration)) throw new Error("重建后的代际无法正常结束")

        // 空闲槽上的停止请求必须如实失败：不能返回「已停止、无归还项」的空成功，
        // 否则一次从未发生的停止会被上报成成功（lane.abort 的 NoActiveOperation 分支）。
        const openSlot = harnessSlots.ensure(sessionId)
        if (await openSlot.abort() !== undefined) {
          throw new Error("空闲槽上的停止不应报告已归还项")
        }
        if (harnessSlots.isRunning(sessionId)) throw new Error("空闲槽停止后不应处于运行态")

        // 空闲回收的请求位（HN-05）：忙槽上的释放请求不被丢弃 —— 本次返回 false 且槽仍在，
        // 由宿主声明的回合终点 end() 收口后才真正删除并关闭（放在停止断言之后：
        // 那一条要的是「槽有 lane 但没有在飞操作」的现场，本段会把槽删掉）。
        const busyGeneration = harnessSlots.begin(sessionId)
        if (busyGeneration === undefined) throw new Error("begin 未分配新代际")
        if (await harnessSlots.releaseWhenIdle(sessionId)) throw new Error("运行中的槽不应被立即释放")
        if (!harnessSlots.snapshot(sessionId)) throw new Error("忙槽上的释放请求把槽丢掉了（应登记到槽上等收口）")
        if (!harnessSlots.end(sessionId, busyGeneration)) throw new Error("运行中的槽不能按本代际结束")
        if (harnessSlots.snapshot(sessionId)) throw new Error("回合终点收口后空闲槽仍未被释放")
      },
    }],
  }],
}

export default 会话运行槽
