// ==========================================
// 发送投递归宿推送 —— 载荷投影 / 订阅幂等 / best-effort 失败语义
// ==========================================
//
// 归属 L2 的依据：本模块是「订阅 ingress 观察器 → 投影线载荷 → 经 UI 事件端口发布」的
// 纯适配层，无回合、无落盘；记录型 publisher（`setUiEventPublisher`）即可观测「推了什么、
// 事件名是什么、失败时投递是否照常」。观察器的**注册边界**用记录型替身捕获：真实
// `@/services/agent` 会拉起 pi runtime 与会话链路，不属于 L2 的观测面；事件由测试直接
// 喂给回调 —— 与 reveal-push 用例只走同步发布点同一纪律。
//
// 被测行为：
//   · 有 `delivery` 才发、无 `delivery`（空闲回合/直接拒绝）不发；
//   · 载荷只取线上三字段（`HostEventMap["deskpet-send-outcome"]` 的形状）；
//   · 订阅幂等：重复 start 不叠加监听器；stop 退订后可再次 start；
//   · best-effort：发布失败（异步拒绝 / 端口未注入的同步抛）只留痕 —— 不向观察器抛、
//     不阻断后续投递。

import { afterEach, describe, expect, it, vi } from "vitest"

import { setUiEventPublisher } from "@/services/host"
import {
  sendOutcomePayload,
  startSendOutcomePush,
  stopSendOutcomePush,
  __resetSendOutcomePushForTest,
} from "@/services/native-ui/send-outcome-push"

/** 与 `UserIngressObserverEvent` 同域的最小形状（类型只用于测试侧驱动，不加载实现模块）。 */
interface ObserverEvent {
  sessionId: string
  requestId: string
  delivery?: "steered" | "followup" | "deferred"
}

/**
 * 记录型观察器注册点：捕获 `startSendOutcomePush` 注册的回调并记录 start/stop 次数。
 * `vi.hoisted` 让状态先于 mock 工厂与模块导入存在（mock 工厂会被提升到 import 之前）。
 */
const agentMock = vi.hoisted(() => {
  const state = {
    observers: [] as Array<(event: unknown) => void | Promise<void>>,
    registerCalls: 0,
    unsubscribeCalls: 0,
  }
  return state
})

vi.mock("@/services/agent", () => ({
  registerUserIngressObserver: (observer: (event: unknown) => void | Promise<void>) => {
    agentMock.registerCalls += 1
    agentMock.observers.push(observer)
    return () => {
      agentMock.unsubscribeCalls += 1
      agentMock.observers = agentMock.observers.filter(item => item !== observer)
    }
  },
}))

/** 已注册的观察器（先断言存在再取用，注册缺失直接红在原因上）。 */
async function deliver(event: ObserverEvent): Promise<void> {
  expect(agentMock.observers, "订阅没有注册（startSendOutcomePush 未生效）").toHaveLength(1)
  await agentMock.observers[0]!(event)
}

/** 等 fire-and-forget 的发布微任务落地。 */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  __resetSendOutcomePushForTest()
  setUiEventPublisher(null)
  agentMock.observers = []
  agentMock.registerCalls = 0
  agentMock.unsubscribeCalls = 0
})

describe("投递归宿载荷投影", () => {
  it("有 delivery 才产出，且只取线上三字段", () => {
    expect(sendOutcomePayload({ sessionId: "s1", requestId: "r1" })).toBeUndefined()
    expect(sendOutcomePayload({ sessionId: "s1", requestId: "r1", delivery: "steered" })).toEqual({
      sessionId: "s1",
      requestId: "r1",
      delivery: "steered",
    })
    // 三个值域成员逐个可投影（线载荷与 HarnessDeliveryReceipt 逐字同域）。
    expect(sendOutcomePayload({ sessionId: "s2", requestId: "r2", delivery: "followup" })?.delivery).toBe("followup")
    expect(sendOutcomePayload({ sessionId: "s3", requestId: "r3", delivery: "deferred" })?.delivery).toBe("deferred")
  })

  it("无 delivery 的事件不发线载荷（空闲回合没有可回执的投递）", async () => {
    const published: Array<{ event: string; payload: unknown }> = []
    setUiEventPublisher({
      publish: async (event, payload) => {
        published.push({ event, payload })
      },
    })
    startSendOutcomePush()

    await deliver({ sessionId: "s-idle", requestId: "r-idle" })
    await flush()
    expect(published, "无 delivery 不应发布任何事件").toHaveLength(0)
  })

  it("有 delivery 的事件发布一条 deskpet-send-outcome，载荷与线格式逐字段一致", async () => {
    const published: Array<{ event: string; payload: unknown }> = []
    setUiEventPublisher({
      publish: async (event, payload) => {
        published.push({ event, payload })
      },
    })
    startSendOutcomePush()

    await deliver({ sessionId: "s-busy", requestId: "r-busy", delivery: "followup" })
    await flush()

    expect(published).toEqual([
      {
        event: "deskpet-send-outcome",
        payload: { sessionId: "s-busy", requestId: "r-busy", delivery: "followup" },
      },
    ])
  })
})

describe("订阅生命周期", () => {
  it("重复 start 幂等（不叠加监听器）；stop 退订后可再次 start", () => {
    startSendOutcomePush()
    startSendOutcomePush()
    expect(agentMock.registerCalls, "第二次 start 不应再注册观察器").toBe(1)
    expect(agentMock.observers).toHaveLength(1)

    stopSendOutcomePush()
    expect(agentMock.unsubscribeCalls, "stop 应退订已注册的观察器").toBe(1)
    expect(agentMock.observers).toHaveLength(0)

    startSendOutcomePush()
    expect(agentMock.registerCalls, "退订后 start 应重新注册").toBe(2)
    expect(agentMock.observers).toHaveLength(1)
  })

  it("模块加载本身不注册观察器：没有 start 就没有订阅（无原生 UI 不挂必然失败的推送）", () => {
    // 判别力：若订阅被挪到模块顶层（import 即注册），无事件通道的宿主也会挂上发布；
    // 这条断言会红在「加载即有观察器」上。
    expect(agentMock.registerCalls).toBe(0)
    expect(agentMock.observers).toHaveLength(0)
  })
})

describe("best-effort 失败语义（不阻断投递）", () => {
  it("发布异步拒绝只留痕：观察器不抛、不吞后续投递", async () => {
    let fail = true
    const accepted: string[] = []
    setUiEventPublisher({
      publish: async (_event, payload) => {
        // 夹具按 UiEventPublisher 的失败契约表达失败（reject），不在测试体里手写 throw。
        if (fail) return Promise.reject(new Error("测试注入：通道关闭"))
        accepted.push((payload as { requestId: string }).requestId)
      },
    })
    startSendOutcomePush()

    // 第一次投递的发布被拒绝：观察器仍不得向投递路径抛（实现里是 void ...catch）。
    await expect(
      deliver({ sessionId: "s-fail", requestId: "r-fail", delivery: "deferred" }),
    ).resolves.toBeUndefined()
    await flush()
    expect(accepted).toEqual([])

    // 通道恢复后，后续投递照常发布 —— 一次失败不把订阅打断。
    fail = false
    await deliver({ sessionId: "s-ok", requestId: "r-ok", delivery: "steered" })
    await flush()
    expect(accepted).toEqual(["r-ok"])
  })

  it("事件端口未注入（同步抛）同样只留痕，观察器不抛", async () => {
    setUiEventPublisher(null)
    startSendOutcomePush()

    await expect(
      deliver({ sessionId: "s-noport", requestId: "r-noport", delivery: "steered" }),
    ).resolves.toBeUndefined()
  })
})
