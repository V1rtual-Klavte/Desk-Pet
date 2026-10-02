import { beforeEach, describe, expect, it, vi } from "vitest"

const pushSystemMessage = vi.fn()
vi.mock("@/services/session", () => ({
  getActiveSessionId: () => "s-1",
  pushSystemMessage: (...args: unknown[]) => pushSystemMessage(...args),
}))

// 插件在 Node 测试环境没有 Tauri 宿主；模块顶层就 import 它们，不 mock 会在导入期炸。
// 真实行为由注入的 factory 覆盖，这两个 mock 只负责让模块可加载。
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }))

let dialogAnswer = true
// 声明 rest 参数：工厂里转发 `confirmDialog(...args)` 需要展开目标签名兼容 unknown[]。
const confirmDialog = vi.fn(async (..._args: unknown[]) => dialogAnswer)
vi.mock("@/services/dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}))

import {
  __setUpdatePortForTest,
  checkForUpdate,
  startUpdateCheck,
  type UpdatePortFactory,
} from "@/services/update"

function portWith(update: { version: string } | null) {
  const downloadAndInstall = vi.fn(async () => {})
  const relaunch = vi.fn(async () => {})
  const factory: UpdatePortFactory = {
    check: async () => (update ? { version: update.version, downloadAndInstall } : null),
    relaunch,
  }
  return { factory, downloadAndInstall, relaunch }
}

// 夹具放模块级：它是「上游检查抛错」的场景构造，不是测试体里的断言。
// 规则 4 只判测试体内部的 throw，夹具抛错在扫描器文档里明确属于例外。
function failingFactory(): UpdatePortFactory {
  return {
    check: async () => { throw new Error("endpoint unreachable") },
    relaunch: async () => {},
  }
}

beforeEach(() => {
  pushSystemMessage.mockClear()
  confirmDialog.mockClear()
  dialogAnswer = true
  __setUpdatePortForTest(null)
})

describe("checkForUpdate", () => {
  it("无新版本时不打扰用户", async () => {
    const { factory } = portWith(null)
    __setUpdatePortForTest(factory)
    expect(await checkForUpdate()).toBe("none")
    expect(pushSystemMessage).not.toHaveBeenCalled()
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it("有新版本时先落一条中性系统消息，再弹确认", async () => {
    const { factory, downloadAndInstall, relaunch } = portWith({ version: "0.16.0" })
    __setUpdatePortForTest(factory)
    expect(await checkForUpdate()).toBe("updated")

    expect(pushSystemMessage).toHaveBeenCalledTimes(1)
    const [text] = pushSystemMessage.mock.calls[0] as [string, string]
    expect(text).toContain("0.16.0")
    // 中性文案：不能出现角色口吻的招呼词
    expect(text).not.toMatch(/主人|人家|～|~/)
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    // 更新可用是正常事件，不是故障：必须显式关掉 confirmDialog 的默认危险样式
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ danger: false }),
    )
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it("用户选稍后则不下载，且同进程内不再重复提示", async () => {
    dialogAnswer = false
    const { factory, downloadAndInstall } = portWith({ version: "0.16.0" })
    __setUpdatePortForTest(factory)
    expect(await checkForUpdate()).toBe("skipped")
    expect(downloadAndInstall).not.toHaveBeenCalled()

    // 第二次检查：上游仍报有新版本，但不应再提示
    pushSystemMessage.mockClear()
    confirmDialog.mockClear()
    expect(await checkForUpdate()).toBe("none")
    expect(pushSystemMessage).not.toHaveBeenCalled()
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it("检查或下载抛错时不崩、返回 failed", async () => {
    __setUpdatePortForTest(failingFactory())
    expect(await checkForUpdate()).toBe("failed")
  })
})

describe("startUpdateCheck", () => {
  it("延迟到点才检查，且同一进程只启动一次", async () => {
    // 上游答「无新版本」：否则第一次检查后 prompted 会挡住第二次 checkForUpdate，
    // 即使调度守卫被删，check 也只被调用一次 —— 那样这条断言就判不了「只启动一次」。
    const { factory } = portWith(null)
    __setUpdatePortForTest(factory)
    const check = vi.spyOn(factory, "check")

    startUpdateCheck({ delayMs: 10 })
    startUpdateCheck({ delayMs: 10 })
    expect(check).not.toHaveBeenCalled() // 延迟未到，不检查

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(check).toHaveBeenCalledTimes(1)
  })
})
