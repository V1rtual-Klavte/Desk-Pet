// ==========================================
// 分泡揭示推送（断链 D）—— 载荷形状 / 事件名 / 失败语义
// ==========================================
//
// 归属 L2 的依据：本模块是「订阅 humanizer 调度器 → 投影载荷 → 经 UI 事件端口发布」的
// 纯适配层，无回合、无落盘；记录型 publisher（setUiEventPublisher）即可观测「推了什么、
// 事件名是什么、失败时揭示是否照常」。调度器用真实单例，但用例只走**同步发布点**
// （enqueueCommitted 的首发与 revealAll 的完成态），不依赖计时器触发。
//
// 被测行为（断链 D）：
//   · 调度器每次状态变化 → 一条 `deskpet-reveal-progress`，载荷六字段与调度器一致
//     （typingStartedAt 不出线）；
//   · 重复 startRevealPush 幂等（不叠加订阅、不重复推送）；
//   · 推送到通道的失败不影响揭示本身（状态照常推进与回收）。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { afterEach, describe, expect, it } from "vitest"

import { setUiEventPublisher } from "@/services/host"
import { enqueueCommitted, getRevealState, resetHumanizerForTest, revealAll } from "@/services/humanizer"
import { revealProgressPayload, startRevealPush, __resetRevealPushForTest } from "@/services/native-ui"

interface RecordedPublish {
  event: string
  payload: unknown
}

afterEach(() => {
  __resetRevealPushForTest()
  resetHumanizerForTest()
  setUiEventPublisher(null)
})

describe("分泡揭示推送", () => {
  it("调度器状态变化逐条发布，载荷与调度器字段一致且不含 typingStartedAt [reveal-push-payload-shape]", async () => {
    const published: RecordedPublish[] = []
    setUiEventPublisher({
      publish: async (event, payload) => {
        published.push({ event, payload })
      },
    })
    startRevealPush()
    startRevealPush() // 幂等：第二次不得叠加第二条订阅

    enqueueCommitted({
      sessionId: "s-push",
      runGeneration: 3,
      messageId: "m-push",
      parts: ["第一泡", "第二泡"],
      isActiveMessage: false,
    })
    await Promise.resolve()

    // 首发 = held（revealed=0、typing=true），一条都不能变两/三条。
    expect(published).toEqual([
      {
        event: "deskpet-reveal-progress",
        payload: { sessionId: "s-push", messageId: "m-push", runGeneration: 3, revealed: 0, partCount: 2, typing: true },
      },
    ])

    revealAll("s-push", 3)
    await Promise.resolve()

    expect(published[1]).toEqual({
      event: "deskpet-reveal-progress",
      payload: { sessionId: "s-push", messageId: "m-push", runGeneration: 3, revealed: 2, partCount: 2, typing: false },
    })
    // 完成态推的是「全显」：状态已回收（下一拍快照不再裁剪）。
    expect(getRevealState("s-push", "m-push")).toBeUndefined()
  })

  it("投影只取线上六字段：typingStartedAt 是调度器内部计时原点，不出线 [reveal-push-field-projection]", () => {
    const payload = revealProgressPayload({
      sessionId: "s1",
      runGeneration: 7,
      messageId: "m1",
      revealed: 1,
      partCount: 2,
      typing: true,
      typingStartedAt: 123456,
    })
    expect(payload).toEqual({ sessionId: "s1", messageId: "m1", runGeneration: 7, revealed: 1, partCount: 2, typing: true })
    expect("typingStartedAt" in payload).toBe(false)
  })

  it("推送失败不阻断揭示：状态照常推进与回收，无未处理拒绝 [reveal-push-failure-non-blocking]", async () => {
    // 夹具按 UiEventPublisher 的失败契约表达失败（reject），不手写 throw 当断言。
    setUiEventPublisher({
      publish: () => Promise.reject(new Error("测试注入：通道关闭")),
    })
    startRevealPush()

    enqueueCommitted({
      sessionId: "s-fail",
      runGeneration: 1,
      messageId: "m-fail",
      parts: ["泡一", "泡二"],
      isActiveMessage: false,
    })
    await Promise.resolve()
    // 推送已经失败（上面 publisher 拒绝），但揭示状态仍在、且可以被完成。
    expect(getRevealState("s-fail", "m-fail")?.revealed).toBe(0)

    revealAll("s-fail", 1)
    await Promise.resolve()
    expect(getRevealState("s-fail", "m-fail")).toBeUndefined()
  })
})
