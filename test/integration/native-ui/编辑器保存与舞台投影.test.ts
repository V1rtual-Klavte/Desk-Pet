// ==========================================
// 编辑器保存写盘与舞台/预览一致性（nui-37）
// ==========================================
//
// 归属 L3 的依据：本用例要**真实写盘** —— `editor_save` 经 `profile_file_read` →
// 合并 → `profile_file_write` 落 隔离数据根里的 profile.yaml，再把强度写回
// CONFIG；断言读的是磁盘事实。L2 的同名覆盖（`host-requests.test.ts`）用记录型
// 假桥只看「发了什么命令」，证明不了真的落盘、也证明不了舞台快照与回读视图一致。
//
// 唯一被替换的命令是 `apply_stage_profile`：Node 测试宿主没有原生 UI（命令未登记，
// 命中即抛 UnsupportedInNodeError），而「舞台快照的值」正是本条要断言的产品产出；
// 拦在桥边界记录下来，其余命令（Profile 文件读写 / CONFIG 读写）全部委托真实
// Node 适配层落盘。原生 UI 的预览绘制与 promote（`Stage::apply_preview` 等）不在
// 这里：E2E 宿主按设计不建原生 UI，见未完成总表 §9 的边界说明。
//
// 被测行为：
//   · editor_save 读-改-写 profile.yaml（保留无关段）、image 去 profileId 前缀、
//     空素材层写空串；强度变化写回 CONFIG、`effectEnabled` 只随载荷回报不写回；
//   · 顺序：profile.yaml 落盘 → CONFIG 强度写回 → 才推舞台；
//   · 舞台快照 = 刚落盘的草稿（空素材层不推），开关/基准宽取 getter 现值；
//   · 编辑器未改值时，主窗舞台快照（loader 投影）与编辑器回读视图逐层同构；
//   · 保存后回读同样与舞台快照同构，且 loader 缓存收敛到磁盘。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { load as loadYaml } from "js-yaml"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig, reloadConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import type { EditorProfilePayload, StageLayerPayload } from "@/services/host/types"
import { dispatchHostRequest, pushStageProfile } from "@/services/native-ui"
import { initPaths } from "@/services/paths"
import {
  activateProfile,
  ensureProfileLoaded,
  getActiveProfile,
  initProfiles,
  invalidateAllProfileCaches,
} from "@/services/profile"

const PROFILE_ID = "sugar-pink"

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
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: ${PROFILE_ID}
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

/** 两层的夹具 Profile；`custom` 是本编辑器不认识的段，读-改-写必须保留。 */
const PROFILE_YAML = `
meta: { name: Sugar Pink, description: 隔离数据根夹具, version: 1 }
theme:
  parallax:
    layers:
      - { enabled: true, image: materials/L0/bg.png, sensitivity: 0.2, scale: 1, offsetX: 1, offsetY: 2, locked: false }
      - { enabled: false, image: materials/L2/body.png, sensitivity: 0.9, scale: 1.5, offsetX: -2, offsetY: 0, locked: true }
custom:
  keep: 编辑器无关的段
`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

interface StagePayload {
  layers: StageLayerPayload[]
  effectEnabled: boolean
  intensity: number
  popupWidth: number
}

/**
 * 记录型宿主桥：`apply_stage_profile` 只记录成功应答（Node 测试宿主没有原生 UI），
 * 其余命令原样委托 Node 适配层 —— Profile/CONFIG 的读写都是真实文件 I/O。
 */
function createRecordingBridge() {
  const inner = new NodeHostBridge()
  const calls: RecordedCall[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>, options?: unknown) {
      calls.push({ method, args })
      if (method === "apply_stage_profile") return null
      return (inner as unknown as { request(m: string, a: unknown, o?: unknown): Promise<unknown> })
        .request(method, args, options)
    },
    subscribe: inner.subscribe.bind(inner),
    readBlob: inner.readBlob.bind(inner),
    releaseBlob: inner.releaseBlob.bind(inner),
  } as unknown as HostBridge
  return { bridge, calls }
}

let root = ""
let recorder: ReturnType<typeof createRecordingBridge>

function callsOf(method: string): RecordedCall[] {
  return recorder.calls.filter(call => call.method === method)
}

function stagePayload(): StagePayload {
  const calls = callsOf("apply_stage_profile")
  expect(calls, "一次保存只应推一次舞台快照").toHaveLength(1)
  return calls[0]!.args as unknown as StagePayload
}

function diskProfile(): Record<string, any> {
  return loadYaml(readFileSync(join(root, "profiles", PROFILE_ID, "profile.yaml"), "utf8")) as Record<string, any>
}

function diskConfig(): Record<string, any> {
  return loadYaml(readFileSync(join(root, "settings", "CONFIG.yaml"), "utf8")) as Record<string, any>
}

/** 舞台层与编辑器回读层同一套字段（舞台没有 locked）；用于跨投影同构断言。 */
function stageShape(layer: EditorProfilePayload["layers"][number]): StageLayerPayload {
  return {
    path: layer.path,
    enabled: layer.enabled,
    sensitivity: layer.sensitivity,
    scale: layer.scale,
    offsetXPercent: layer.offsetXPercent,
    offsetYPercent: layer.offsetYPercent,
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-editor-save-"))
  setTestDataRoot(root)
  mkdirSync(join(root, "profiles", PROFILE_ID), { recursive: true })
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  writeFileSync(join(root, "profiles", PROFILE_ID, "profile.yaml"), PROFILE_YAML, "utf8")
  recorder = createRecordingBridge()
  setHostBridge(recorder.bridge)
  await initPaths()
  await initConfig()
  await initProfiles()
})

beforeEach(async () => {
  // 每个用例从同一份磁盘夹具出发：CONFIG 与 Profile 都刚被上一轮改写。
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  writeFileSync(join(root, "profiles", PROFILE_ID, "profile.yaml"), PROFILE_YAML, "utf8")
  recorder.calls.length = 0
  await reloadConfig()
  invalidateAllProfileCaches()
  expect(await ensureProfileLoaded(PROFILE_ID), "夹具 Profile 未能从隔离数据根加载").not.toBeNull()
  expect(activateProfile(PROFILE_ID), "夹具 Profile 未能激活").toBe(true)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("编辑器保存写盘与舞台/预览一致性", () => {
  it("编辑器未改值时主窗舞台快照与编辑器回读视图逐层同构 [native-ui-editor-untouched-consistency]", async () => {
    const editor = (await dispatchHostRequest("editor_load", {})) as EditorProfilePayload

    await pushStageProfile()
    const stage = stagePayload()

    // 夹具现值独立写明：两侧投影同时写错时，这组字面量仍会红。
    expect(stage.effectEnabled).toBe(true)
    expect(stage.intensity).toBe(0.6)
    expect(stage.popupWidth).toBe(730)
    expect(stage.layers.map(layer => [layer.path, layer.enabled, layer.sensitivity, layer.scale, layer.offsetXPercent, layer.offsetYPercent])).toEqual([
      [`${PROFILE_ID}/materials/L0/bg.png`, true, 0.2, 1, 1, 2],
      [`${PROFILE_ID}/materials/L2/body.png`, false, 0.9, 1.5, -2, 0],
    ])

    // 未改值 = 预览（editor_load）与主窗（loader → 舞台）同构。
    expect(editor.profileId).toBe(PROFILE_ID)
    expect(editor.intensity).toBe(0.6)
    expect(editor.effectEnabled).toBe(true)
    expect(stage.layers).toEqual(editor.layers.filter(layer => layer.path !== "").map(stageShape))

    expect(getActiveProfile()?.theme.parallax.layers.map(layer => layer.image)).toEqual([
      "materials/L0/bg.png",
      "materials/L2/body.png",
    ])
  })

  it("保存经隔离数据根真实落盘，舞台快照与回读视图一致 [native-ui-editor-save-persist]", async () => {
    const before = (await dispatchHostRequest("editor_load", {})) as EditorProfilePayload
    expect(before.layers, "保存前应读到夹具的两层").toHaveLength(2)

    await dispatchHostRequest("editor_save", {
      profileId: PROFILE_ID,
      layers: [
        { path: `${PROFILE_ID}/materials/L0/bg_base.png`, name: "bg_base.png", enabled: true, locked: false, sensitivity: 0.25, scale: 1.1, offsetXPercent: 3, offsetYPercent: -4 },
        { path: `${PROFILE_ID}/materials/L2/body.png`, name: "body.png", enabled: false, locked: true, sensitivity: 0.85, scale: 1.6, offsetXPercent: -5, offsetYPercent: 6 },
        { path: "", name: "", enabled: true, locked: false, sensitivity: 1.2, scale: 1, offsetXPercent: 0, offsetYPercent: 0 },
      ],
      intensity: 1.4,
      effectEnabled: false,
    })

    // 1) 磁盘是事实来源：层逐字段写回、image 去 profileId 前缀、无关段保留。
    const saved = diskProfile()
    expect(saved.meta.name).toBe("Sugar Pink")
    expect(saved.custom).toEqual({ keep: "编辑器无关的段" })
    expect(saved.theme.parallax.layers).toEqual([
      { enabled: true, image: "materials/L0/bg_base.png", sensitivity: 0.25, scale: 1.1, offsetX: 3, offsetY: -4, locked: false },
      { enabled: false, image: "materials/L2/body.png", sensitivity: 0.85, scale: 1.6, offsetX: -5, offsetY: 6, locked: true },
      { enabled: true, image: "", sensitivity: 1.2, scale: 1, offsetX: 0, offsetY: 0, locked: false },
    ])

    // 2) 强度是 CONFIG 字段，落盘；effectEnabled 只随载荷回报，不写回总开关。
    const config = diskConfig()
    expect(config.appearance.parallax.intensity).toBe(1.4)
    expect(config.appearance.effectMode).toBe("parallax")

    // 3) 顺序：profile.yaml 落盘 → CONFIG 强度写回 → 才推舞台。
    const order = recorder.calls
      .filter(call => ["profile_file_write", "write_runtime_config", "apply_stage_profile"].includes(call.method))
      .map(call => call.method)
    expect(order).toEqual(["profile_file_write", "write_runtime_config", "apply_stage_profile"])

    // 4) 舞台快照 = 刚写盘的草稿：空素材层不推，开关/基准宽取 getter 现值。
    const stage = stagePayload()
    expect(stage.effectEnabled).toBe(true)
    expect(stage.intensity).toBe(1.4)
    expect(stage.popupWidth).toBe(730)
    expect(stage.layers).toEqual([
      { path: `${PROFILE_ID}/materials/L0/bg_base.png`, enabled: true, sensitivity: 0.25, scale: 1.1, offsetXPercent: 3, offsetYPercent: -4 },
      { path: `${PROFILE_ID}/materials/L2/body.png`, enabled: false, sensitivity: 0.85, scale: 1.6, offsetXPercent: -5, offsetYPercent: 6 },
    ])

    // 5) 保存后回读与舞台快照同构；loader 缓存也收敛到磁盘（主窗下一次推送一致）。
    const after = (await dispatchHostRequest("editor_load", {})) as EditorProfilePayload
    expect(after.intensity).toBe(1.4)
    expect(after.layers.map(layer => [layer.path, layer.enabled, layer.locked, layer.sensitivity, layer.scale, layer.offsetXPercent, layer.offsetYPercent])).toEqual([
      [`${PROFILE_ID}/materials/L0/bg_base.png`, true, false, 0.25, 1.1, 3, -4],
      [`${PROFILE_ID}/materials/L2/body.png`, false, true, 0.85, 1.6, -5, 6],
      ["", true, false, 1.2, 1, 0, 0],
    ])
    expect(stage.layers).toEqual(after.layers.filter(layer => layer.path !== "").map(stageShape))
    expect(getActiveProfile()?.theme.parallax.layers).toEqual(saved.theme.parallax.layers)
  })
})
