// ==========================================
// 提问选择（ask_user）的 UI 回执通道 —— Node 侧订阅与结算
// ==========================================
//
// 归属 L3 的依据：choice-confirmation 依赖会话域（活跃会话与系统消息），不属于纯逻辑的
// L2；fake 只替换 UI 端口实现（事件发布器 / 回执源），产品路径（提问 → emitUiEvent →
// 待答表 → settle）原样执行。
//
// 被测行为（用户 2026-10-06 裁决：选择弹窗的等待与逃生口）：
//   · 提问方向经发布端口发出 `deskpet-choice-start`（事件名与载荷原样）；
//   · 回执方向按 requestId 结算：picked / other / cancelled 三种取值各有归宿；
//     越界 index 与未知 requestId 丢弃（协议违规 / 迟到不回滚结算）；
//   · **没有等待超时**：假时钟推进 10 分钟仍待答（旧实现 5 分钟按 timeout 结算）；
//   · 逃生口（面板没送到/用户离开时的每一条归宿）：发布失败 → `emit_failed` 立即结算；
//     signal abort（用户停止回合/回合失效）→ `session_switched`；会话切换/关闭 →
//     `cancelSessionChoices`；同 requestId 重入 → 旧的那份结算掉，不悬挂。

import { beforeAll, describe, expect, it, vi } from "vitest"

import { setUiEventPublisher, setUiReceiptSource } from "@/services/host"
import {
  cancelSessionChoices,
  choiceState,
  initChoiceConfirmationReceipts,
  requestChoice,
  resolveChoice,
} from "@/services/engine/choice-confirmation"

/** 回执源假实现：记录订阅名，测试里手动触发。 */
const receiptHandlers = new Map<string, (payload: unknown) => void>()
setUiReceiptSource({
  subscribe: (event, listener) => {
    const handler = listener as unknown as (payload: unknown) => void
    receiptHandlers.set(event, handler)
    return () => { if (receiptHandlers.get(event) === handler) receiptHandlers.delete(event) }
  },
})

/** 发布器假实现：记录（不投递）所有 Node→UI 事件。 */
const published: Array<{ event: string; payload: Record<string, unknown> }> = []
function installRecordingPublisher(): void {
  published.length = 0
  setUiEventPublisher({
    publish: async (event, payload) => { published.push({ event, payload: payload as Record<string, unknown> }) },
  })
}
installRecordingPublisher()

/** 发布器假实现：投递失败（模拟 UI 通道关闭）。夹具在模块级定义，不充当断言。 */
const failingPublisher = {
  publish: async (): Promise<void> => { throw new Error("UI 通道已关闭") },
}

function receiveReceipt(payload: unknown): void {
  const handler = receiptHandlers.get("deskpet-choice-resolved")
  expect(handler, "回执源没有 deskpet-choice-resolved 的订阅（initChoiceConfirmationReceipts 未安装）").toBeDefined()
  handler?.(payload)
}

const ASK = (requestId: string, options: string[] = ["咖啡", "茶"]) =>
  requestChoice({ sessionId: "s-choice", requestId, question: "喝什么？", options })

beforeAll(() => {
  // harness 引导的等价物：订阅安装一次（幂等）。
  initChoiceConfirmationReceipts()
})

describe("提问选择的回执通道", () => {
  it("提问事件按冻结载荷发出，回执 picked 结算出选项原文 [choice-receipt-start-picked]", async () => {
    installRecordingPublisher()
    const pending = ASK("choice-c1")

    const start = published.find(entry => entry.event === "deskpet-choice-start")
    expect(start, "提问方向没有发出 deskpet-choice-start").toBeDefined()
    expect(start?.payload).toEqual({
      sessionId: "s-choice",
      requestId: "choice-c1",
      question: "喝什么？",
      options: ["咖啡", "茶"],
    })
    expect(choiceState.pending.map(view => view.requestId)).toEqual(["choice-c1"])

    receiveReceipt({ requestId: "choice-c1", result: { kind: "picked", index: 1 } })
    await expect(pending).resolves.toEqual({
      answered: true,
      answer: { kind: "picked", index: 1, option: "茶" },
    })
    expect(choiceState.pending, "结算后待答视图没有清空").toEqual([])
  })

  it("other 与 cancelled 各有归宿且不互相顶替 [choice-receipt-other-cancel]", async () => {
    installRecordingPublisher()
    const other = ASK("choice-other")
    receiveReceipt({ requestId: "choice-other", result: { kind: "other" } })
    await expect(other).resolves.toEqual({ answered: true, answer: { kind: "other" } })

    const cancel = ASK("choice-cancel")
    receiveReceipt({ requestId: "choice-cancel", result: { kind: "cancelled" } })
    await expect(cancel).resolves.toEqual({ answered: false, reason: "user" })
  })

  it("未知 requestId 与越界 index 丢弃：不结算、不误伤 [choice-receipt-invalid-dropped]", async () => {
    installRecordingPublisher()
    const pending = ASK("choice-probe")
    let settled: unknown = "pending"
    void pending.then(value => { settled = value })

    receiveReceipt({ requestId: "choice-unknown", result: { kind: "picked", index: 0 } })
    receiveReceipt({ requestId: "choice-probe", result: { kind: "picked", index: 99 } })
    await Promise.resolve()
    expect(settled, "未知身份/越界下标不该结算").toBe("pending")
    expect(choiceState.pending.map(view => view.requestId)).toEqual(["choice-probe"])

    // 收尾：用合法值结算，不留悬挂的待答。
    receiveReceipt({ requestId: "choice-probe", result: { kind: "picked", index: 0 } })
    await expect(pending).resolves.toEqual({
      answered: true,
      answer: { kind: "picked", index: 0, option: "咖啡" },
    })
  })

  it("没有等待超时：假时钟推进十分钟仍待答 [choice-no-wait-timeout]", async () => {
    installRecordingPublisher()
    vi.useFakeTimers()
    try {
      const pending = ASK("choice-hold")
      let settled: unknown = "pending"
      void pending.then(value => { settled = value })

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      expect(settled, "提问在 10 分钟后被超时结算了（选择弹窗不留超时）").toBe("pending")
      expect(choiceState.pending.map(view => view.requestId)).toEqual(["choice-hold"])

      receiveReceipt({ requestId: "choice-hold", result: { kind: "cancelled" } })
      await expect(pending).resolves.toEqual({ answered: false, reason: "user" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("发布失败按 emit_failed 立即结算并收起面板 [choice-emit-failure-settles]", async () => {
    setUiEventPublisher(failingPublisher)
    const outcome = await ASK("choice-emit-fail")
    expect(outcome).toEqual({ answered: false, reason: "emit_failed" })
    expect(choiceState.pending, "发射失败后仍有待答视图（请求已结算）").toEqual([])
    // 面板收起事件照发（best-effort；此处发布器失败，只验证不抛、请求已结算）。
    installRecordingPublisher()
  })

  it("signal abort 按 session_switched 结算并发收尾事件 [choice-signal-abort-settles]", async () => {
    installRecordingPublisher()
    const controller = new AbortController()
    const pending = requestChoice({
      sessionId: "s-choice",
      requestId: "choice-abort",
      question: "还继续吗？",
      options: ["继续", "停"],
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).resolves.toEqual({ answered: false, reason: "session_switched" })
    expect(
      published.some(entry => entry.event === "deskpet-choice-end" && entry.payload.requestId === "choice-abort"),
      "abort 后没有发出面板收起事件",
    ).toBe(true)
  })

  it("cancelSessionChoices 只取消该会话的待答并逐条写收尾事件 [choice-session-cancel]", async () => {
    installRecordingPublisher()
    const mine = ASK("choice-mine")
    const other = requestChoice({
      sessionId: "s-other",
      requestId: "choice-other-session",
      question: "别动我",
      options: ["甲", "乙"],
    })

    const cancelled = cancelSessionChoices("s-choice", "session_switched")
    expect(cancelled, "只应取消目标会话的一条").toBe(1)
    await expect(mine).resolves.toEqual({ answered: false, reason: "session_switched" })
    const ends = published.filter(entry => entry.event === "deskpet-choice-end")
    expect(ends.map(entry => entry.payload.requestId), "被取消的提问没有逐条收起").toEqual(["choice-mine"])

    // 别的会话的待答不受影响，收尾清理。
    expect(choiceState.pending.map(view => view.requestId)).toEqual(["choice-other-session"])
    resolveChoice("choice-other-session", { kind: "cancelled" })
    await expect(other).resolves.toEqual({ answered: false, reason: "user" })
  })

  it("同 requestId 重入把旧的那份结算掉，不给它留悬挂 [choice-same-id-reentry]", async () => {
    installRecordingPublisher()
    const first = ASK("choice-dup")
    const second = ASK("choice-dup")
    await expect(first).resolves.toEqual({ answered: false, reason: "session_switched" })

    receiveReceipt({ requestId: "choice-dup", result: { kind: "picked", index: 0 } })
    await expect(second).resolves.toEqual({
      answered: true,
      answer: { kind: "picked", index: 0, option: "咖啡" },
    })
  })
})
