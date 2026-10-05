// ==========================================
// 自动预览开关 × 模型请求投影（L3，契约 ci-06）
// ==========================================
//
// 开关只控制聊天历史的内联呈现，**绝不能**缩水模型看图：无论 appearance.chatImagePreview
// 开或关，hydrateImageMessages 都要从原路径读出真实图像 part，投影不改写原消息、不向
// 消息对象加图像数据（JSONL 只存 deskpetImagePaths 原路径）。
// 宿主内联预览（占位零预读 / 可见加载 / 关闭释放 / 晚到丢弃 / 查看器独立）不在本层：
// 由 crates/native-host/src/images/inline.rs 的 Rust 单测覆盖。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"

import { setTestDataRoot } from "../../host/node-ipc"
import { appearanceConfig, getOverride, setOverride } from "@/services/config"
import { getMessageImagePaths, hydrateImageMessages } from "@/services/images"

const KEY = "appearance.chatImagePreview"
const original = getOverride<unknown>(KEY)
/** 1×1 合法 PNG（与图片域其它夹具同源的最小图）。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
)
const PNG_BASE64 = PNG_BYTES.toString("base64")

let root = ""
let imagePath = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-chat-image-preview-projection-"))
  setTestDataRoot(root)
  mkdirSync(join(root, "images"), { recursive: true })
  imagePath = join(root, "images", "小图.png")
  writeFileSync(imagePath, PNG_BYTES)
})

afterEach(() => {
  setOverride(KEY, original)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 读模型里的用户图片消息：正文是文本 + deskpetImagePaths 原路径（不含任何图像数据）。 */
function userMessageWithImage(): AgentMessage {
  return { role: "user", content: "看看这张", deskpetImagePaths: [imagePath] } as unknown as AgentMessage
}

describe("聊天图片自动预览开关与模型请求投影", () => {
  it("开关开/关都保留请求投影里的图像与原消息形态 [chat-image-preview-request-projection-independent]", async () => {
    const message = userMessageWithImage()
    const originalShape = JSON.stringify(message)
    expect(originalShape, "被测消息里不应预置图像数据").not.toContain(PNG_BASE64)

    setOverride(KEY, false)
    const withPreviewOff = await hydrateImageMessages([message])
    setOverride(KEY, true)
    const withPreviewOn = await hydrateImageMessages([message])

    for (const [label, projected] of [["关闭", withPreviewOff], ["开启", withPreviewOn]] as const) {
      const first = projected[0]
      expect(first?.role, `${label}：投影第一条不是用户消息`).toBe("user")
      // 上面的断言已保证是用户消息；这里只做类型收窄（不是断言）。
      const content = (first as Extract<AgentMessage, { role: "user" }>).content
      expect(typeof content, `${label}：请求投影不应退化成纯文本`).not.toBe("string")
      const image = (content as Array<{ type: string; data?: string; mimeType?: string }>)
        .find(part => part.type === "image")
      expect(image, `${label}：模型请求投影缺少图像 part`).toBeDefined()
      expect(image!.mimeType, `${label}：图像 MIME 不是原文件类型`).toBe("image/png")
      expect(image!.data, `${label}：图像 part 不是原文件字节的编码`).toBe(PNG_BASE64)
      // 投影仍携带原路径（JSONL 持久形态不因开关变化）。
      expect((first as { deskpetImagePaths?: string[] }).deskpetImagePaths).toEqual([imagePath])
    }

    // 投影是临时视图：原消息不被改写、不新增图像数据，开关读取也不产生副作用。
    expect(JSON.stringify(message), "请求投影改写了原消息").toBe(originalShape)
    expect(getMessageImagePaths(message)).toEqual([imagePath])
    expect(appearanceConfig.chatImagePreview).toBe(true)
  })
})
