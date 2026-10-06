// ==========================================
// 原生 UI 状态推送（W9b）—— 推送时机 / 值来源 / 失败语义
// ==========================================
//
// 归属 L2 的依据：本模块是「读配置门面 → 组装载荷 → 经桥发命令」的纯适配层，
// 无回合、无落盘副作用（写盘只发生在 CONFIG 房间的守恒路径里，由别的用例覆盖）；
// 记录型假桥（setHostBridge）即可观测「推了什么、推给谁、值从哪来」。
//
// 被测行为（W9b/W9c）：
//   · 启动入口一次推十条，值只经现有 getter（不复制默认值）；
//   · 全局快捷键的 modifiers 按平台选（`@/services/env` 的 isMacOS 经 mock 固定）；
//   · 无激活 Profile 时舞台推送如实跳过（不推空层列表清空舞台）；
//   · 推送失败如实汇总（不抛、不阻断引导），每条失败带方法名。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { initConfig, setOverride, userConfig, appearanceConfig, generalConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import {
  buildStageLayers,
  notifyActiveProfileChanged,
  pushChatImagePreview,
  pushChatPanel,
  pushFontSnapshot,
  pushGlobalShortcut,
  pushNativeUiState,
  sendStageProfile,
  setActiveProfileListener,
} from "@/services/native-ui"

/**
 * 平台判断固定为可控状态：`@/services/env` 在 Node 里靠 `navigator.platform`
 * 探测（等价于本机平台），直接断言会变成「哪台机器跑哪条分支」；mock 只替换
 * 这一个具名导出，测试里显式指定 macOS / Windows 两个分支。
 */
const envState = vi.hoisted(() => ({ isMacOS: false }))

vi.mock("@/services/env", () => ({
  get isMacOS() {
    return envState.isMacOS
  },
}))

/** 假 CONFIG：所有值都刻意不同于内置模板，用来证明推送读的是「配置现值」。 */
const CONFIG_YAML = `
general:
  popup:
    mode: fixed
    autoPopupOnMessage: true
    defaultSize: { w: 812, h: 470 }
    chatWidth: 287
  shortcut:
    key: J
    macModifiers: [Command, Shift]
    winModifiers: [Alt, Shift]
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
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: test-profile
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: Songti SC, size: 17 }
  chatImagePreview: true
`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/** 记录型假桥：request 记录并成功应答；subscribe 记下监听器；不提供 blob。 */
function fakeBridge(options: { failAll?: boolean } = {}) {
  const calls: RecordedCall[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args })
      if (options.failAll) throw new Error(`测试假桥拒绝命令: ${method}`)
      if (method === "read_runtime_config") return CONFIG_YAML
      return null
    },
    subscribe(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    async readBlob() {
      throw new Error("测试假桥不提供 blob")
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  return { bridge, calls, listeners }
}

function recorded(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method)
}

beforeEach(() => {
  // 注入发生在 import 领域模块之后也无妨：所有取用都经 getHostBridge() 在调用时解析。
  setHostBridge(null)
  envState.isMacOS = false
})

afterEach(() => {
  setHostBridge(null)
})

describe("原生 UI 状态推送", () => {
  it("全局快捷键推送：modifiers 按平台取 getter 现值（含默认值不在此复制）[native-ui-push-shortcut]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    // 平台分支由 mock 显式指定，不依赖测试机：
    // macOS 取 general.shortcut.macModifiers，Windows 取 winModifiers。
    envState.isMacOS = true
    await pushGlobalShortcut()
    envState.isMacOS = false
    await pushGlobalShortcut()

    const sent = recorded(calls, "configure_global_shortcut")
    expect(sent).toHaveLength(2)
    // 期望值就是假 CONFIG 里写下的现值（与内置默认值不同：键 P / [Control,Command] /
    // [Control,Alt]），证明值来自 CONFIG 而不是代码里的默认值副本。
    expect(sent[0].args).toEqual({ key: "J", modifiers: ["Command", "Shift"] })
    expect(sent[1].args).toEqual({ key: "J", modifiers: ["Alt", "Shift"] })
  })

  it("字体推送只经外观 getter（族名与字号就是配置现值）[native-ui-push-font]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await pushFontSnapshot()

    const sent = recorded(calls, "apply_font_snapshot")
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toEqual({
      family: appearanceConfig.fontFamily,
      size: appearanceConfig.fontSize,
    })
    // 现值与模板默认不同：证明没有「复制默认值」的实现路径。
    expect(sent[0].args).toEqual({ family: "Songti SC", size: 17 })
  })

  it("聊天列宽度推送经配置门面取值（不复制默认值）[native-ui-push-chat-panel]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await pushChatPanel()

    const sent = recorded(calls, "set_chat_panel")
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toEqual({ open: null, width: userConfig.chatWidth })
    expect(sent[0].args.width).toBe(287)
  })

  it("聊天图片自动预览推送经 getter（含默认 false 的唯一出处）[native-ui-push-chat-preview]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await pushChatImagePreview()

    const sent = recorded(calls, "configure_chat_image_preview")
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toEqual({ enabled: appearanceConfig.chatImagePreview })
    expect(sent[0].args.enabled).toBe(true)
  })

  it("舞台层映射：profiles 域内相对路径 + 过滤无素材层（z 序不变）[native-ui-push-stage-layers]", () => {
    const layers = buildStageLayers("demo", [
      { enabled: true, image: "materials/L0/bg.png", sensitivity: 0.2, scale: 1, offsetX: 1, offsetY: 2 },
      { enabled: false, image: "", sensitivity: 0.5, scale: 1, offsetX: 0, offsetY: 0 },
      { enabled: true, image: "/materials/L2/body.png", sensitivity: 0.8, scale: 1.5, offsetX: -3, offsetY: 4 },
    ])
    expect(layers).toEqual([
      { path: "demo/materials/L0/bg.png", enabled: true, sensitivity: 0.2, scale: 1, offsetXPercent: 1, offsetYPercent: 2 },
      { path: "demo/materials/L2/body.png", enabled: true, sensitivity: 0.8, scale: 1.5, offsetXPercent: -3, offsetYPercent: 4 },
    ])
  })

  it("舞台推送带上 getter 的开关/强度/基准宽（编辑器保存路径复用同一发送口）[native-ui-push-stage-args]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    await sendStageProfile(
      [{ path: "demo/materials/L0/bg.png", enabled: true, sensitivity: 0.2, scale: 1, offsetXPercent: 0, offsetYPercent: 0 }],
      1.25,
    )

    const sent = recorded(calls, "apply_stage_profile")
    expect(sent).toHaveLength(1)
    expect(sent[0].args.layers).toHaveLength(1)
    expect(sent[0].args.effectEnabled).toBe(userConfig.effectMode === "parallax")
    expect(sent[0].args.intensity).toBe(1.25)
    expect(sent[0].args.popupWidth).toBe(generalConfig.defaultPopupSize.w)
    expect(sent[0].args.popupWidth).toBe(812)
  })

  it("无激活 Profile 时舞台推送跳过，不推空层列表 [native-ui-push-stage-skip-no-profile]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    // 本测试进程没有经资源通道装载过 Profile（getActiveProfile() 为 null）：
    // 推空层会把正在显示的舞台清空，所以必须如实跳过。
    const { pushStageProfile } = await import("@/services/native-ui")
    await pushStageProfile()

    expect(recorded(calls, "apply_stage_profile")).toHaveLength(0)
  })

  it("启动入口一次推十条；失败如实汇总且不抛出（不阻断引导）[native-ui-push-failure-summary]", async () => {
    const failing = fakeBridge({ failAll: true })
    setHostBridge(failing.bridge)

    // 失败全部被汇总为返回值/warn：调用方（领域引导）不被推送失败打断。
    const failures = await pushNativeUiState()
    const methods = failures.map((failure) => failure.method)
    expect(methods).toContain("configure_global_shortcut")
    expect(methods).toContain("apply_font_snapshot")
    expect(methods).toContain("set_chat_panel")
    expect(methods).toContain("configure_chat_image_preview")
    // 失败项带原始错误（不吞原因、不假报成功）。
    for (const failure of failures) {
      expect(failure.error).toBeInstanceOf(Error)
    }

    const healthy = fakeBridge()
    setHostBridge(healthy.bridge)
    await initConfig()
    const ok = await pushNativeUiState()
    expect(ok).toEqual([])
    expect(recorded(healthy.calls, "configure_global_shortcut")).toHaveLength(1)
    expect(recorded(healthy.calls, "apply_font_snapshot")).toHaveLength(1)
    expect(recorded(healthy.calls, "configure_chat_image_preview")).toHaveLength(1)
    expect(recorded(healthy.calls, "set_chat_panel")).toHaveLength(1)
  })

  it("Profile 激活信号：只通知已注册监听者，注销后不再触发 [native-ui-active-profile-signal]", () => {
    const hits: number[] = []
    setActiveProfileListener(() => hits.push(1))
    notifyActiveProfileChanged()
    expect(hits).toEqual([1])

    setActiveProfileListener(null)
    notifyActiveProfileChanged()
    expect(hits).toEqual([1])
  })

  it("设置改动经既有门面读取：字体改动后推送携带新值[native-ui-push-follows-getter]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await initConfig()

    setOverride("appearance.font.size", 21)
    await pushFontSnapshot()

    const sent = recorded(calls, "apply_font_snapshot")
    expect(sent[sent.length - 1].args.size).toBe(appearanceConfig.fontSize)
    expect(sent[sent.length - 1].args.size).toBe(21)
  })
})
