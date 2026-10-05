// Native 更新命令与 SettingsHostRequest 的边界。
// 更新真相源与安装流程在 Rust Native UpdatePort；设置窗 checkUpdate 是原生本地 action，
// 不伪装成已经存在的 Node update UI 服务或 HostRequest 方法。

import { afterEach, describe, expect, it } from "vitest"

import { getHostBridge, setHostBridge } from "@/services/host"
import type { HostBridge, HostCommandMap } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"

type UpdateResponse = HostCommandMap["update_check"]["result"]

function installBridge(responses: Partial<Record<keyof HostCommandMap, unknown>> = {}, fail?: keyof HostCommandMap) {
  const calls: (keyof HostCommandMap)[] = []
  const bridge = {
    async request(method: keyof HostCommandMap) {
      calls.push(method)
      if (method === fail) throw Object.assign(new Error(`${method} failed`), { code: "NETWORK" })
      return responses[method]
    },
    subscribe: () => () => {},
    readBlob: async () => new Uint8Array(),
    releaseBlob: async () => {},
  } as unknown as HostBridge
  setHostBridge(bridge)
  return calls
}

afterEach(() => setHostBridge(null))

describe("Native update command boundary", () => {
  it("update_check returns the signed Native candidate or null [native-update-check-command]", async () => {
    const calls = installBridge({ update_check: null })
    const result = await getHostBridge().request("update_check", {})
    expect(result).toBeNull()
    expect(calls).toEqual(["update_check"])
  })

  it("Native install commands keep their HostCommandMap names and response shapes [native-update-command-map]", async () => {
    const candidate: UpdateResponse = { version: "0.17.0", notes: "candidate" }
    const calls = installBridge({ update_check: candidate })
    expect(await getHostBridge().request("update_check", {})).toEqual(candidate)
    await getHostBridge().request("update_download_and_install", {})
    await getHostBridge().request("app_restart", {})
    expect(calls).toEqual(["update_check", "update_download_and_install", "app_restart"])
  })

  it("HostRequest does not route Native Settings action or update command through Node [native-update-settings-request-boundary]", async () => {
    // The settings UI's `action.checkUpdate` is handled by Rust SettingsPort; it is not a
    // CONFIG setting and must not be sent as a Node settings_commit/HostRequest action.
    await expect(dispatchHostRequest("action.checkUpdate", {})).rejects.toMatchObject({ code: "OTHER" })
    await expect(dispatchHostRequest("update_check", {})).rejects.toMatchObject({ code: "OTHER" })
  })
})
