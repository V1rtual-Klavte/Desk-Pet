// ==========================================
// settings_commit 的运行期重应用 —— 观察总闸 / 日志级别（旧 deskpet-settings-saved 的等价链）
// ==========================================
//
// 归属 L2/L3 之间（与 host-requests.test.ts 同层）：请求处理器本身是编排，用记录型假桥
// 观测「保存后哪些运行期值被重应用」；不启动 Harness、不用真实 Provider。
//
// 被测行为（修复「改开关后需重启才生效」）：
//   · 提交 ai.silentAccess.* 时重应用观察总闸（set_monitor_enabled 走既有开关入口，
//     且发生在写盘之后；档位「关」= 关闸）；
//   · 提交与 silentAccess 无关的键时不触碰观察总闸（重应用按变更键裁定，不做无关副作用）；
//   · 提交 general.logging.level 时重应用日志级别（下发 Rust 的 set_log_config）；
//   · 提交抽屉三条键（defaultDelivery / thinking.effort / safety.mode）时重推一次会话投影
//     （复用 pushSessionProjection：抽屉选中态来自投影，设置页改了要让抽屉即时跟上）；
//   · 重应用失败不回滚已保存的配置、不把保存判成失败（失败留痕可见）。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"

const CONFIG_YAML = `
general:
  popup:
    mode: cursor
    autoPopupOnMessage: false
    defaultSize: { w: 730, h: 450 }
    chatWidth: 220
  shortcut:
    key: P
    macModifiers: [Control, Command]
    winModifiers: [Control, Alt]
  logging: { level: info }
  errors: { overlay: auto }
ai:
  provider: test
  endpoint: http://127.0.0.1:0
  apiKey: ""
  requireApiKey: false
  model: test-model
  auxModel: ""
  contextMaxTokens: 131072
  thinking: { effort: auto }
  conversation: { defaultDelivery: steer, steeringMode: all, followUpMode: all }
  loop: { maxRetry: 3, subAgentRounds: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: true }
  memory: { enabled: false }
  proactive: { frequency: medium, quietStartHour: 23, quietEndHour: 9 }
  silentAccess: { frequency: off }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: sugar-pink
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

function fakeBridge(options: { failMethod?: string } = {}) {
  const calls: RecordedCall[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args: { ...args } })
      if (options.failMethod === method) {
        throw Object.assign(new Error(`测试假桥拒绝命令: ${method}`), { code: "IO" })
      }
      if (method === "read_runtime_config") return CONFIG_YAML
      return null
    },
    subscribe() {
      return () => {}
    },
    async readBlob() {
      throw new Error("测试假桥不提供 blob")
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  return { bridge, calls }
}

function recorded(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method)
}

beforeEach(() => {
  setHostBridge(null)
})

afterEach(() => {
  setHostBridge(null)
})

describe("settings_commit 的运行期重应用", () => {
  it("提交 ai.silentAccess.* 时重应用观察总闸，且发生在写盘之后 [native-ui-settings-reapply-monitor]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await dispatchHostRequest("settings_commit", {
      changes: [{ key: "ai.silentAccess.frequency", value: "off" }],
    })

    const monitor = recorded(calls, "set_monitor_enabled")
    expect(monitor).toHaveLength(1)
    expect(monitor[0].args).toEqual({ enabled: false })

    const writeIndex = calls.findIndex((call) => call.method === "write_runtime_config")
    const monitorIndex = calls.findIndex((call) => call.method === "set_monitor_enabled")
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(monitorIndex).toBeGreaterThan(writeIndex)
  })

  it("与 silentAccess 无关的提交不触碰观察总闸（按变更键裁定）[native-ui-settings-reapply-scoped]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await dispatchHostRequest("settings_commit", {
      changes: [{ key: "appearance.chatImagePreview", value: true }],
    })

    expect(recorded(calls, "set_monitor_enabled")).toHaveLength(0)
  })

  it("提交 general.logging.level 时重应用日志级别（下发宿主）[native-ui-settings-reapply-logging]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await dispatchHostRequest("settings_commit", {
      changes: [{ key: "general.logging.level", value: "warn" }],
    })

    const logConfig = recorded(calls, "set_log_config")
    expect(logConfig).toHaveLength(1)
    expect(typeof logConfig[0].args.level).toBe("number")
  })

  it("提交抽屉三条键时重推会话投影（设置页与抽屉两个面同刻一致）[native-ui-settings-reapply-drawer]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    for (const [key, value] of [
      ["ai.conversation.defaultDelivery", "followUp"],
      ["ai.thinking.effort", "high"],
      ["ai.safety.mode", "just_do_it"],
    ] as const) {
      calls.length = 0
      await dispatchHostRequest("settings_commit", { changes: [{ key, value }] })
      const writeIndex = calls.findIndex((call) => call.method === "write_runtime_config")
      const pushIndex = calls.findIndex((call) => call.method === "apply_chat_projection")
      expect(writeIndex, `${key} 应先落盘`).toBeGreaterThanOrEqual(0)
      expect(pushIndex, `${key} 保存后应重推一帧会话投影（抽屉选中态据此收敛）`).toBeGreaterThan(writeIndex)
      expect(recorded(calls, "apply_chat_projection").length, "一次保存只推一帧").toBe(1)
    }
  })

  it("提交无关键不重推会话投影（按变更键裁定，不放大副作用）[native-ui-settings-reapply-drawer-scoped]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await dispatchHostRequest("settings_commit", {
      changes: [{ key: "appearance.chatImagePreview", value: true }],
    })

    expect(recorded(calls, "apply_chat_projection")).toHaveLength(0)
  })

  it("重应用失败不回滚已保存的配置、不把保存判成失败 [native-ui-settings-reapply-failure]", async () => {
    const { bridge, calls } = fakeBridge({ failMethod: "set_monitor_enabled" })
    setHostBridge(bridge)
    await initConfig()

    // 保存本身成功（配置已写盘）：重应用失败只留痕，不抛出。
    await expect(
      dispatchHostRequest("settings_commit", {
        changes: [{ key: "ai.silentAccess.frequency", value: "off" }],
      }),
    ).resolves.toBeUndefined()
    expect(recorded(calls, "set_monitor_enabled")).toHaveLength(1)
    expect(recorded(calls, "write_runtime_config").length).toBeGreaterThan(0)
  })
})
