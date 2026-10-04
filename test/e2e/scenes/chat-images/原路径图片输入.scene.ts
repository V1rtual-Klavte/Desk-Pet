import { invoke } from "@tauri-apps/api/core"
import { initChat, sendMessage } from "@/services/agent"
import { setOverride } from "@/services/config"
import { getActiveSessionId } from "@/services/session"
import { runtimePath } from "@/services/paths"
import { chatImageUrl, getMessageImagePaths, prepareImagePaths } from "@/services/images"
import { messagesFromEntries } from "@/services/session/read-model"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../types"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
let path = ""
let requestId = ""
let rejectedExtraImages = false
let provider: ReturnType<typeof installFakeProvider>

export const 原路径图片输入: SceneDef = {
  meta: { caseId: "chat-image-path-production", module: "chat-images", contractId: "ci-01",
    description: "图片-only输入经生产sendMessage真实路径准入，原生JSONL只保存路径、模型收到图像；原文件删除后历史路径仍保留且请求明确缺失",
    depth: "deep", suite: "regression", entry: "production", tags: ["boundary", "error", "persistence", "image", "production-entry"] },
  setup: async () => {
    await initChat()
    setOverride("ai.humanizer.enabled", true)
    setOverride("ai.memory.enabled", false)
    const profileId = `image-fixture-${crypto.randomUUID()}`
    path = await runtimePath("profiles", profileId, "original.png")
    await invoke("profile_file_write", { profileId, relativePath: "original.png", content: [...atob(PNG)].map(character => character.charCodeAt(0)) })
    await prepareImagePaths([path])
    await new Promise<void>((resolve, reject) => {
      const preview = new Image()
      preview.onload = () => { if (preview.naturalWidth === 1 && preview.naturalHeight === 1) resolve(); else reject(new Error("真实WebView图片预览尺寸错误")) }
      preview.onerror = () => reject(new Error("原文件路径未被真实WebView成功解码预览"))
      preview.src = chatImageUrl(path)
    })
    requestId = crypto.randomUUID()
    rejectedExtraImages = false
    try { await prepareImagePaths([path, path, path, path, path]) }
    catch { rejectedExtraImages = true } // 拒绝是否产生由下方真实IPC断言核对，未启动任何聊天运行。
    provider = installFakeProvider([fakeText("看见这张小图了"), fakeText("原图不在了，没法再看")],
      { id: "deskpet-image-fake", name: "Image-capable Fake", input: ["text", "image"] })
    const result = await sendMessage("", { imagePaths: [path], requestId })
    if (result.outcome !== "succeeded") throw new Error(`图片-only输入未成功：${result.failure?.message ?? result.outcome}`)
    await invoke("file_remove", { path, recursive: false, force: false })
  },
  turns: [{ index: 1, description: "删除原文件后请求不得假装仍看见图片，重载保留原路径", userText: "再看一下刚才那张图",
    checks: [{ type: "expectImagePathNativeCommitAndMissingProjection", run: async () => {
      if (!rejectedExtraImages) throw new Error("原生图片准入未拒绝超过四张的输入")
      const entries = await sessionEntries()
      const users = entries.filter(entry => entry.type === "message" && entry.message.role === "user"
        && (entry.message as { deskpetEventId?: string }).deskpetEventId === `${requestId}:user`)
      if (users.length !== 1 || users[0].type !== "message") throw new Error(`图片输入落盘次数应为1，实际${users.length}`)
      const raw = users[0].message
      if (raw.role !== "user") throw new Error("图片身份条目不是用户输入")
      if (JSON.stringify(getMessageImagePaths(raw)) !== JSON.stringify([path])) throw new Error("JSONL没有原路径身份")
      if (typeof raw.content !== "string" || raw.content !== "") throw new Error("图片-only持久正文须为空文本，不能存图像编码")
      const serialized = JSON.stringify(entries)
      if (serialized.includes(PNG) || serialized.includes('"type":"image"')) throw new Error("图片编码泄露进持久会话")
      const first = provider.payloads[0]?.messages.find(message => message.role === "user"
        && Array.isArray(message.content) && message.content.some(part => part.type === "image"))
      if (!first || !Array.isArray(first.content)) throw new Error("真实Provider请求没有图像内容")
      const image = first.content.find(part => part.type === "image")
      if (!image || image.type !== "image" || image.mimeType !== "image/png" || image.data !== PNG) throw new Error("请求图片与原始1px PNG不一致")
      const last = provider.payloads[provider.payloads.length - 1]?.messages ?? []
      if (last.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"))) throw new Error("原文件删除后仍传出图像")
      const missing = last.flatMap(message => typeof message.content === "string" ? [message.content]
        : message.content.filter(part => part.type === "text").map(part => part.text))
      if (!missing.some(text => text === "[附图原文件不可用，无法查看；不要推测图片内容]")) throw new Error("缺失图片没有明确请求视图说明")
      const projected = await messagesFromEntries(entries, getActiveSessionId())
      const user = projected.find(message => message.eventId === `${requestId}:user`)
      if (JSON.stringify(user?.imagePaths) !== JSON.stringify([path])) throw new Error("重载丢失原路径")
      if (await invoke<boolean>("file_exists", { path })) throw new Error("测试原文件删除未生效")
    } }] }],
}
export default 原路径图片输入
