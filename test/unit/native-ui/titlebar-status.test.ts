// ==========================================
// 顶栏状态位推送（A2）—— 取值来源 / 去重 / 失败重试
// ==========================================
//
// 归属 L2 的依据：本模块是「渲染通知 → 经桥发一条命令」的纯适配层，无回合、无落盘；
// 记录型假桥即可观测「推了什么、什么时候推、失败后怎么处理」。**不 import
// `@/services/native-ui` 桶**（桶现在会带出会话/引擎图，L2 不需要）：只取
// `titlebar-status` 子模块与真值点 `@/services/titlebar`，层边界保持干净。
//
// 被测行为（A2）：
//   · 推的永远是**真值点仲裁后的最终文本**（优先级/释放回落都按既有仲裁走）；
//   · 同一文本不重复推（去重）；失败不更新去重位，下一次渲染自动重试；
//   · 未注册渲染监听时渲染照常（推送是可选消费方，不影响仲裁结果本身）。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { pushTitlebarStatus, __resetTitlebarStatusPushForTest } from "@/services/native-ui/titlebar-status"
import { releaseTitlebarStatus, setTitlebarRenderListener, setTitlebarStatus, titlebarLogo } from "@/services/titlebar"

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/**
 * 记录型假桥：记录**全部**命令（不只 `apply_titlebar_status` —— 下面用它钉
 * 「顶栏推送只走唯一通道」）；可注入失败（结构化错误码，与宿主同形）。
 */
function fakeBridge(options: { fail?: boolean } = {}) {
  const calls: RecordedCall[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args: { ...args } })
      if (method === "apply_titlebar_status" && options.fail) {
        throw Object.assign(new Error("测试假桥拒绝命令: apply_titlebar_status"), { code: "OTHER" })
      }
      return null
    },
    subscribe() {
      return () => undefined
    },
    async readBlob() {
      throw new Error("测试假桥不提供 blob")
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  return { bridge, calls }
}

/** 等异步推送落地（监听者是 fire-and-forget 的）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 已推送的文本序列（按发生顺序）。 */
function pushedTexts(calls: RecordedCall[]): unknown[] {
  return calls.filter((call) => call.method === "apply_titlebar_status").map((call) => call.args.text)
}

/** 本文件用过且未释放的 owner 名（afterEach 统一释放，避免跨用例污染真值点）。 */
const liveOwners = new Set<string>()

function useOwner(name: string): string {
  liveOwners.add(name)
  return name
}

function releaseOwner(name: string): void {
  if (liveOwners.delete(name)) releaseTitlebarStatus(name)
}

beforeEach(() => {
  setHostBridge(null)
  __resetTitlebarStatusPushForTest()
  setTitlebarRenderListener(null)
})

afterEach(() => {
  for (const owner of liveOwners) releaseTitlebarStatus(owner)
  liveOwners.clear()
  setTitlebarRenderListener(null)
  setHostBridge(null)
  __resetTitlebarStatusPushForTest()
})

describe("顶栏状态位推送", () => {
  it("推的是真值点仲裁后的最终文本：高优先级胜出、释放按优先级回落、同文本去重 [native-ui-titlebar-push-value]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)

    // 装配与 `initNativeUiBridge` 同款：挂渲染监听 + 补推当前文本。
    setTitlebarRenderListener((text) => {
      void pushTitlebarStatus(text).catch(() => undefined)
    })
    void pushTitlebarStatus(titlebarLogo.text).catch(() => undefined)
    await flush()
    // 缺省是**中性空闲文案**「就绪」：没有 owner（没有角色在活动）时不得回落成
    // 「配信中」——那会把空闲谎报成在线/在播。
    expect(pushedTexts(calls)).toEqual(["就绪"])
    expect(titlebarLogo.text).toBe("就绪")
    // 通道唯一性：顶栏文本只经 `apply_titlebar_status` 下发，不旁路到其它命令。
    expect([...new Set(calls.map((call) => call.method))]).toEqual(["apply_titlebar_status"])

    // 高层级 owner 改写 → 推最终文本。
    setTitlebarStatus(useOwner("probe-typing"), "正在输入…", 20)
    await flush()
    expect(pushedTexts(calls)).toEqual(["就绪", "正在输入…"])
    expect(titlebarLogo.text).toBe("正在输入…")

    // 低优先级 owner 写入：夺不走仲裁 → 最终文本不变 → 推送不发生。
    setTitlebarStatus(useOwner("probe-presence"), "在忙", 5)
    await flush()
    expect(pushedTexts(calls)).toEqual(["就绪", "正在输入…"])

    // 释放高层级 → 按既有仲裁回落到「在忙」，推送跟随。
    releaseOwner("probe-typing")
    await flush()
    expect(pushedTexts(calls)).toEqual(["就绪", "正在输入…", "在忙"])

    // 同文本的重写（与当前最终文本相同）不产生第二次推送。
    setTitlebarStatus(useOwner("probe-presence-2"), "在忙", 6)
    await flush()
    expect(pushedTexts(calls)).toEqual(["就绪", "正在输入…", "在忙"])

    // 释放全部 owner → 回落缺省并推送（与真值点初值同字面量）。
    releaseOwner("probe-presence")
    releaseOwner("probe-presence-2")
    await flush()
    expect(pushedTexts(calls)).toEqual(["就绪", "正在输入…", "在忙", "就绪"])
    expect(titlebarLogo.text).toBe("就绪")
  })

  it("推送失败如实抛出且不更新去重位：下一次渲染对同一文本自动重试 [native-ui-titlebar-push-retry]", async () => {
    const failing = fakeBridge({ fail: true })
    setHostBridge(failing.bridge)
    setTitlebarRenderListener((text) => {
      void pushTitlebarStatus(text).catch(() => undefined)
    })

    // 直接驱动推送单元：失败必须如实抛出（不静默吞掉宿主故障）。
    await expect(pushTitlebarStatus("甲")).rejects.toMatchObject({ code: "OTHER" })

    // 失败没有写去重位：渲染点再次给出同一文本时仍会重试（第二次尝试可见）。
    setTitlebarStatus(useOwner("probe"), "甲", 1)
    await flush()
    expect(pushedTexts(failing.calls)).toEqual(["甲", "甲"])

    // 换健康宿主后按当前文本继续（去重位只记成功推送过的文本）。
    const healthy = fakeBridge()
    setHostBridge(healthy.bridge)
    releaseOwner("probe")
    await flush()
    expect(pushedTexts(healthy.calls)).toEqual(["就绪"])
  })

  it("未注册渲染监听时渲染照常：真值点状态更新，不产生任何推送 [native-ui-titlebar-no-listener]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    setTitlebarRenderListener(null)

    setTitlebarStatus(useOwner("probe-solo"), "独自存在", 3)
    await flush()
    expect(titlebarLogo.text).toBe("独自存在")
    expect(pushedTexts(calls)).toEqual([])

    releaseOwner("probe-solo")
    await flush()
    expect(titlebarLogo.text).toBe("就绪")
    expect(pushedTexts(calls)).toEqual([])
  })
})
