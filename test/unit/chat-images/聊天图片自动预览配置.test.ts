// ==========================================
// 聊天图片自动预览开关 —— 配置面（L2，契约 ci-05）
// ==========================================
//
// 唯一字段 `appearance.chatImagePreview`（默认 false）的读取与保存路径：
// 读取只经 appearanceConfig.chatImagePreview，字段缺省按唯一默认值；保存用
// SettingsPanel.doSave 对这类开关的同一路径（setOverride 直写同一份 cfg）。
// 宿主侧行为（占位零预读 / 可见消息按需加载 / 关闭释放且晚到丢弃 / 查看器独立）
// 不在本层：由 crates/native-host/src/images/inline.rs 的 Rust 单测覆盖。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { appearanceConfig, getOverride, setOverride } from "@/services/config"

const KEY = "appearance.chatImagePreview"
/** 用例开始时的原始值（模板里是显式 false；缺省时是 undefined）。 */
const original = getOverride<unknown>(KEY)

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-chat-image-preview-config-"))
  setTestDataRoot(root)
})

afterEach(() => {
  // setOverride(undefined) 即「字段缺省」：读路径回落到唯一默认值，不留显式值。
  setOverride(KEY, original)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("聊天图片自动预览开关配置面", () => {
  it("字段缺省按唯一默认值 false 读取，显式值原样成立 [chat-image-preview-config-default]", () => {
    setOverride(KEY, undefined)
    expect(appearanceConfig.chatImagePreview, "缺省的可选字段必须按唯一默认值读取").toBe(false)

    setOverride(KEY, true)
    expect(appearanceConfig.chatImagePreview, "显式 true 被默认值覆盖").toBe(true)

    setOverride(KEY, false)
    expect(appearanceConfig.chatImagePreview, "显式 false 被默认值覆盖").toBe(false)
  })

  it("设置页保存路径写回同一 cfg 后读取立即生效 [chat-image-preview-save-immediate]", () => {
    // SettingsPanel.doSave 对该开关的保存映射就是 setOverride 直写（与 ci-05 的契约一致）。
    setOverride(KEY, true)
    expect(appearanceConfig.chatImagePreview, "保存后未读到新值").toBe(true)
    expect(getOverride<unknown>(KEY), "保存没有写回配置路径").toBe(true)

    setOverride(KEY, false)
    expect(appearanceConfig.chatImagePreview, "保存 false 后未立即生效（读取的不是同一份 cfg）").toBe(false)
  })
})
