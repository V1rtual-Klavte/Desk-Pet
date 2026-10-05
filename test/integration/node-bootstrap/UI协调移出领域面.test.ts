// ==========================================
// 纯 UI 的窗口间协调已移出 Node 领域面（解除包）
// ==========================================
//
// 归属 L3 的依据：断言依赖领域 barrel 的真实装配面（memory / proactive / observation /
// window 都会拉起各自的领域模块），并验证记忆 revision 的进程内分发 —— 不是纯逻辑 L2。
//
// 被测行为（原生宿主迁移过程记录 §9.4 第 7/35 条）：
//   · 旧壳的跨窗口协调入口（Tauri 实现）不再出现在领域 barrel 上，已搬去 src/ui/；
//   · 领域侧保留可用的本地路径：记忆 revision 的进程内分发不依赖任何 UI 通道
//     （跨窗口广播归 src/ui/memory-revision.ts，Node 里所有提交都发生在本进程）。

import { describe, expect, it } from "vitest"

import { publishMemoryRevision, subscribeMemoryRevision } from "@/services/agent/memory"

describe("UI 协调与领域边界", () => {
  it("旧壳跨窗口协调入口不在领域 barrel 面（已搬去 src/ui/） [ui-coordination-outside-domain-barrels]", async () => {
    const memory = await import("@/services/agent/memory")
    expect("initMemoryRevisionSync" in memory).toBe(false)

    const proactive = await import("@/services/proactive")
    expect("requestProactiveControl" in proactive).toBe(false)

    const observation = await import("@/services/observation")
    expect("initObservationGovernance" in observation).toBe(false)
    expect("stopObservationGovernance" in observation).toBe(false)

    const window = await import("@/services/window")
    expect("initWindowListener" in window).toBe(false)
  })

  it("记忆 revision 的领域分发不依赖 UI 通道（订阅 → 本地分发 → 退订） [memory-revision-local-dispatch]", async () => {
    const seen: number[] = []
    const stop = subscribeMemoryRevision(async revision => { seen.push(revision) })
    await publishMemoryRevision(7)
    expect(seen).toEqual([7])

    stop()
    await publishMemoryRevision(8)
    expect(seen).toEqual([7])
  })
})
