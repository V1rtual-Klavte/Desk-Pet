// ==========================================
// 宿主 → Node 请求面（W9b）—— 设置读写 / 宽度写回 / 编辑器 I/O
// ==========================================
//
// 归属 L2/L3 之间：请求处理器本身是「经桥读 CONFIG / Profile → 走既有保存路径」
// 的编排，用记录型假桥可观测到全部读写与回执；不启动 Harness、不用真实 Provider、
// 不 import 任何 IPC 模块（假桥即 @/services/host 的注入面）。
//
// 被测行为（W9b/W9c）：
//   · settings_read 的键 = CONFIG 路径（嵌套展开、标量数组 → 多行文本、缺键不补默认）；
//   · settings_commit 经既有 setOverride + flushConfig（写盘成功后才算提交），
//     数组字段回写还原，写盘先于状态推送；写盘失败如实抛出、不推送；
//   · set_chat_width 写回 general.popup.chatWidth（取整 + 夹到 schema 同域）；
//   · personality_cards 读 Card 注册表（不是 CONFIG 副本）；
//   · editor_load/editor_save 走 profile_file_read → 合并 → profile_file_write
//     （唯一写入路径），先落盘后重推舞台；失败不落配置、不推舞台；
//   · 回执：成功 ok=true；失败带结构化 code/message；未知方法如实报错。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { load as loadYaml } from "js-yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getAllOverrides, reloadConfig, setOverride } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import {
  HOST_REQUEST_EVENT,
  HOST_REQUEST_RESULT_METHOD,
  collectSettingsSnapshot,
  dispatchHostRequest,
  initHostRequestHandlers,
  normalizeSettingValue,
  __resetHostRequestHandlersForTest,
} from "@/services/native-ui"

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
  logging: { level: debug }
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
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
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

const PROFILE_YAML = `
meta: { name: Sugar Pink, description: 测试, version: 1 }
theme:
  parallax:
    layers:
      - { enabled: true, image: materials/L0/bg_base.png, sensitivity: 0.2, scale: 1, offsetX: 0, offsetY: 0, locked: false }
      - { enabled: true, image: materials/L2/body.png, sensitivity: 0.8, scale: 1, offsetX: 0, offsetY: 0, locked: false }
`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/** 最小合法 Card：frontmatter 的 id/name/description 逐项可断言（无前导空行，正则从 `---` 起）。 */
const DEMO_CARD = "---\nid: demo\nname: Demo\ndescription: 测试卡\nversion: 1\n---\n正文\n"

function fakeBridge(options: { failMethod?: string } = {}) {
  const calls: RecordedCall[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  let writtenConfig: string | null = null
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args: { ...args } })
      // 失败注入：命中的命令按结构化错误拒绝（与宿主错误同形），供失败路径断言。
      if (options.failMethod === method) {
        throw Object.assign(new Error(`测试假桥拒绝命令: ${method}`), { code: "IO" })
      }
      switch (method) {
        case "read_runtime_config":
          return CONFIG_YAML
        case "write_runtime_config":
          writtenConfig = String(args.content ?? "")
          return null
        case "profile_file_read":
          return new TextEncoder().encode(PROFILE_YAML)
        case "profile_file_write":
          return null
        case "personality_file_list":
          return ["demo.md"]
        case "personality_file_read":
          return new TextEncoder().encode(DEMO_CARD)
        default:
          return null
      }
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
  return { bridge, calls, listeners, writtenConfig: () => writtenConfig }
}

function recorded(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method)
}

function lastWrite(calls: RecordedCall[]): string {
  const writes = recorded(calls, "write_runtime_config")
  expect(writes.length).toBeGreaterThan(0)
  return String(writes[writes.length - 1].args.content)
}

beforeEach(() => {
  setHostBridge(null)
})

afterEach(() => {
  __resetHostRequestHandlersForTest()
  setHostBridge(null)
})

describe("设置读写请求面", () => {
  it("整表快照：键 = CONFIG 路径，嵌套展开、数组按多行文本、缺键不补默认值 [native-ui-settings-snapshot]", async () => {
    const { bridge } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    const snapshot = collectSettingsSnapshot()

    // 嵌套对象展开为点分键（与设置 schema 的键逐字一致）。
    expect(snapshot.values["general.popup.defaultSize.w"]).toBe(730)
    expect(snapshot.values["appearance.font.size"]).toBe(15)
    expect(snapshot.values["appearance.chatImagePreview"]).toBe(false)
    // 标量数组 → 多行文本（Multiline 控件的形状约定）。
    expect(snapshot.values["tools.bash.whitelist"]).toBe("ls\ncat")
    expect(snapshot.values["general.shortcut.macModifiers"]).toBe("Control\nCommand")
    // 对象数组（MCP 服务器列表）没有对应控件：不产出任何键。
    expect(Object.keys(snapshot.values).some((key) => key.startsWith("tools.mcp.servers"))).toBe(false)
    // 缺键不补默认值：CONFIG 里没有的路径不能在快照里凭空出现。
    expect("appearance.font.family" in snapshot.values).toBe(true)
    expect("general.desktop.pollingIntervalMs" in snapshot.values).toBe(false)
    // 值来自配置现值（getAllOverrides 是写入面的读法）。
    expect(snapshot.values["general.popup.chatWidth"]).toBe((getAllOverrides() as any).general.popup.chatWidth)
  })

  it("提交经既有写路径落盘：写盘先于状态推送，推送读的是提交后的新值 [native-ui-settings-commit]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await dispatchHostRequest("settings_commit", {
      changes: [
        { key: "appearance.chatImagePreview", value: true },
        { key: "general.popup.chatWidth", value: 260 },
      ],
    })

    const written = lastWrite(calls)
    const parsed = loadYaml(written) as any
    expect(parsed.appearance.chatImagePreview).toBe(true)
    expect(parsed.general.popup.chatWidth).toBe(260)

    // 写盘必须先于五条状态推送（先落盘、后刷新 UI）。
    const writeIndex = calls.findIndex((call) => call.method === "write_runtime_config")
    const pushIndex = calls.findIndex((call) => call.method === "apply_font_snapshot")
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(pushIndex).toBeGreaterThan(writeIndex)

    // 推送携带的是提交后的现值（不是提交前的旧值，也不是模板默认值）。
    const preview = recorded(calls, "configure_chat_image_preview")
    expect(preview).toHaveLength(1)
    expect(preview[0].args).toEqual({ enabled: true })

    // 快捷键推送同批执行（启动与设置保存共用 pushNativeUiState）；键来自 CONFIG 现值。
    const shortcut = recorded(calls, "configure_global_shortcut")
    expect(shortcut).toHaveLength(1)
    expect(shortcut[0].args.key).toBe("P")
  })

  it("数组字段回写形状互逆：多行文本 → 标量数组 [native-ui-settings-commit-array]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    // 先证明读法（数组 → 多行文本），再证明写法（多行文本 → 数组）可逆。
    expect(normalizeSettingValue("tools.bash.whitelist", "ls\ncat\n pwd ")).toEqual(["ls", "cat", "pwd"])
    expect(normalizeSettingValue("general.popup.chatWidth", "260")).toBe("260")

    await dispatchHostRequest("settings_commit", {
      changes: [{ key: "tools.bash.whitelist", value: "ls\ncat\npwd" }],
    })

    const parsed = loadYaml(lastWrite(calls)) as any
    expect(parsed.tools.bash.whitelist).toEqual(["ls", "cat", "pwd"])
  })

  it("人格卡切换不是普通 setOverride：字段缺失时报结构化失败 [native-ui-settings-commit-personality-guard]", async () => {
    const { bridge } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    // 空 Card id 不允许（不能关闭人格）：处理器拒绝，且不产生写盘调用。
    await expect(
      dispatchHostRequest("settings_commit", { changes: [{ key: "ai.personality.active", value: "" }] }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })
})

describe("分隔条宽度写回", () => {
  it("取整并夹到与设置 schema 相同的值域后落盘 [native-ui-chat-width-writeback]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await dispatchHostRequest("set_chat_width", { width: 333.6 })
    expect((loadYaml(lastWrite(calls)) as any).general.popup.chatWidth).toBe(334)

    const writesBefore = recorded(calls, "write_runtime_config").length
    await dispatchHostRequest("set_chat_width", { width: 5000 })
    const writes = recorded(calls, "write_runtime_config")
    expect(writes.length).toBeGreaterThan(writesBefore)
    expect((loadYaml(String(writes[writes.length - 1].args.content)) as any).general.popup.chatWidth).toBe(1000)

    await expect(dispatchHostRequest("set_chat_width", { width: Number.NaN })).rejects.toMatchObject({
      code: "CONFIG",
    })
  })
})

describe("图层编辑器 I/O", () => {
  it("载入：读既有 profile.yaml，层路径是 profiles 域内相对路径 [native-ui-editor-load]", async () => {
    const { bridge } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    const profile = (await dispatchHostRequest("editor_load", {})) as any
    expect(profile.profileId).toBe("sugar-pink")
    expect(profile.profileName).toBe("Sugar Pink")
    expect(profile.layers).toHaveLength(2)
    expect(profile.layers[1].path).toBe("sugar-pink/materials/L2/body.png")
    expect(profile.layers[1].name).toBe("body.png")
    expect(profile.effectEnabled).toBe(true)
    expect(profile.intensity).toBe(0.6)
  })

  it("保存：读-改-写 profile.yaml（既有无唯一写入路径），并重推舞台 [native-ui-editor-save]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await dispatchHostRequest("editor_save", {
      profileId: "sugar-pink",
      layers: [
        { path: "sugar-pink/materials/L0/bg_base.png", name: "bg_base.png", enabled: true, locked: false, sensitivity: 0.2, scale: 1, offsetXPercent: 1, offsetYPercent: 2 },
        { path: "sugar-pink/materials/L2/body.png", name: "body.png", enabled: false, locked: true, sensitivity: 0.9, scale: 1.5, offsetXPercent: -2, offsetYPercent: 0 },
      ],
      intensity: 1.4,
      effectEnabled: true,
    })

    // Profile 写入经唯一命令与域内相对路径（image 去掉 profileId 前缀）。
    const writes = recorded(calls, "profile_file_write")
    expect(writes).toHaveLength(1)
    expect(writes[0].args.profileId).toBe("sugar-pink")
    expect(writes[0].args.relativePath).toBe("profile.yaml")
    const saved = loadYaml(new TextDecoder().decode(writes[0].args.content as Uint8Array)) as any
    expect(saved.theme.parallax.layers[1]).toMatchObject({
      image: "materials/L2/body.png",
      enabled: false,
      locked: true,
      sensitivity: 0.9,
      scale: 1.5,
      offsetX: -2,
      offsetY: 0,
    })

    // 强度是 CONFIG 字段：变化时写回既有保存路径。
    expect((loadYaml(lastWrite(calls)) as any).appearance.parallax.intensity).toBe(1.4)

    // 舞台重推：值就是刚写盘的草稿（不依赖资源通道的 loader 缓存）。
    const stage = recorded(calls, "apply_stage_profile")
    expect(stage).toHaveLength(1)
    expect(stage[0].args.intensity).toBe(1.4)
    expect((stage[0].args.layers as any[]).map((layer) => layer.path)).toEqual([
      "sugar-pink/materials/L0/bg_base.png",
      "sugar-pink/materials/L2/body.png",
    ])

    // 顺序：profile.yaml 落盘 → 强度写回 CONFIG → 才重推舞台；后续任一步失败都不会
    // 发生后面的动作（见文件末尾的失败路径用例）。
    const profileWriteIndex = calls.findIndex((call) => call.method === "profile_file_write")
    const configWriteIndex = calls.findIndex((call) => call.method === "write_runtime_config")
    const stagePushIndex = calls.findIndex((call) => call.method === "apply_stage_profile")
    expect(profileWriteIndex).toBeGreaterThanOrEqual(0)
    expect(configWriteIndex).toBeGreaterThan(profileWriteIndex)
    expect(stagePushIndex).toBeGreaterThan(configWriteIndex)
  })

  it("保存缺 profileId 时如实失败，不产生任何写入 [native-ui-editor-save-reject]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await expect(dispatchHostRequest("editor_save", { profileId: "", layers: [] })).rejects.toMatchObject({
      code: "CONFIG",
    })
    expect(recorded(calls, "profile_file_write")).toHaveLength(0)
  })
})

describe("请求订阅与回执", () => {
  it("订阅宿主事件名；成功以 ok=true 回执，失败带结构化 code [native-ui-host-request-reply]", async () => {
    const { bridge, calls, listeners } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读
    initHostRequestHandlers()

    // 注册在唯一事件名上（与 Rust 侧常量成对）。
    expect(listeners.has(HOST_REQUEST_EVENT)).toBe(true)

    // 成功路径：settings_read 回执 ok=true（载荷 requestId 原样带回）。
    listeners.get(HOST_REQUEST_EVENT)!({ requestId: 11, method: "settings_read", args: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const replies = recorded(calls, HOST_REQUEST_RESULT_METHOD)
    const success = replies.find((call) => call.args.requestId === 11)
    expect(success?.args.ok).toBe(true)
    expect((success?.args.result as any).values["general.popup.chatWidth"]).toBe(220)

    // 失败路径：未知方法 → ok=false + 结构化 code/message（不静默吞）。
    listeners.get(HOST_REQUEST_EVENT)!({ requestId: 12, method: "no_such_request", args: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const failure = recorded(calls, HOST_REQUEST_RESULT_METHOD).find((call) => call.args.requestId === 12)
    expect(failure?.args.ok).toBe(false)
    expect((failure?.args.error as any).code).toBeDefined()
    expect(typeof (failure?.args.error as any).message).toBe("string")

    // 形状无效的信封：直接丢弃并留痕（不产生回执 —— 没有可用的 requestId）。
    const repliesBefore = recorded(calls, HOST_REQUEST_RESULT_METHOD).length
    listeners.get(HOST_REQUEST_EVENT)!({ method: "settings_read" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(recorded(calls, HOST_REQUEST_RESULT_METHOD).length).toBe(repliesBefore)
  })

  it("未知方法经分派口如实报错（不返回空结果冒充成功）[native-ui-host-request-unknown]", async () => {
    const { bridge } = fakeBridge()
    setHostBridge(bridge)
    await expect(dispatchHostRequest("definitely_not_a_method", {})).rejects.toThrow(/未知的宿主请求方法/)
  })
})

// ==========================================
// 失败路径（如实失败：不静默回退、不假报成功、失败不发生后续动作）
// ==========================================

describe("失败路径", () => {
  it("人格卡列表读的是 Card 注册表（不是 CONFIG 副本）[native-ui-personality-cards]", async () => {
    const { bridge } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读
    const { initCards } = await import("@/services/personality")
    await initCards()

    const payload = (await dispatchHostRequest("personality_cards", {})) as {
      active: string | null
      cards: Array<{ id: string; name: string; description: string }>
    }
    expect(payload.cards).toEqual([{ id: "demo", name: "Demo", description: "测试卡" }])
    // 注册表尚未激活任何 Card：如实返回 null，不假装有值。
    expect(payload.active).toBeNull()
  })

  it("无激活 Profile 时 editor_load 拒绝（PATH_NOT_FOUND，不返回空编辑器）[native-ui-editor-load-reject]", async () => {
    const { bridge, calls } = fakeBridge()
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    // 激活 id 置空（既有 getter 的取值路径）：没有 Profile 可载入，必须如实失败。
    setOverride("appearance.activeProfile", "")
    await expect(dispatchHostRequest("editor_load", {})).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    expect(recorded(calls, "profile_file_read")).toHaveLength(0)
  })

  it("Profile 写盘失败时 editor_save 如实抛出：不落 CONFIG、不推舞台 [native-ui-editor-save-write-failure]", async () => {
    const { bridge, calls } = fakeBridge({ failMethod: "profile_file_write" })
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await expect(
      dispatchHostRequest("editor_save", {
        profileId: "sugar-pink",
        layers: [
          { path: "sugar-pink/materials/L0/bg_base.png", name: "bg_base.png", enabled: true, locked: false, sensitivity: 0.2, scale: 1, offsetXPercent: 0, offsetYPercent: 0 },
        ],
        intensity: 1.4,
        effectEnabled: true,
      }),
    ).rejects.toMatchObject({ code: "IO" })

    // 失败在「强度写回 CONFIG」与「重推舞台」之前中止：两者都不发生。
    expect(recorded(calls, "write_runtime_config")).toHaveLength(0)
    expect(recorded(calls, "apply_stage_profile")).toHaveLength(0)
  })

  it("设置写盘失败时 settings_commit 如实抛出，且不发生任何状态推送 [native-ui-settings-commit-write-failure]", async () => {
    const { bridge, calls } = fakeBridge({ failMethod: "write_runtime_config" })
    setHostBridge(bridge)
    await reloadConfig()  // 幂等的 initConfig 不会回退前一用例写脏的 cfg；reload 让每个用例从假桥重读

    await expect(
      dispatchHostRequest("settings_commit", {
        changes: [{ key: "general.popup.chatWidth", value: 240 }],
      }),
    ).rejects.toMatchObject({ code: "IO" })

    // 写盘没成功 → 「写盘先于推送」的前提不成立：一条推送都不发。
    expect(recorded(calls, "configure_global_shortcut")).toHaveLength(0)
    expect(recorded(calls, "apply_font_snapshot")).toHaveLength(0)
    expect(recorded(calls, "configure_chat_image_preview")).toHaveLength(0)
  })
})
