import { TODO_CONTEXT, type AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { CHAT_IMAGE_LIMITS, getMessageImagePaths, imageMime } from "./paths"
import { readImageProcessor } from "./processor"

const log = createLogger("ChatImages")

export async function loadRequestImage(path: string, signal?: AbortSignal): Promise<ImageContent> {
  signal?.throwIfAborted()
  // 桥已统一把 `file_read_binary` 的结果物化为 Uint8Array（BYTE_RESULT_METHODS），不再二次包装。
  const bytes = await getHostBridge().request("file_read_binary", { path, maxBytes: CHAT_IMAGE_LIMITS.maxBytes })
  signal?.throwIfAborted()
  const mimeType = imageMime(bytes)
  if (!mimeType) throw new Error("选择的文件不是受支持的图片")
  const result = await readImageProcessor(bytes, mimeType, { autoResizeImages: true }, TODO_CONTEXT)
  signal?.throwIfAborted()
  if (!result.ok) throw new Error(result.message)
  return { type: "image", data: result.data, mimeType: result.mimeType }
}

/** 只返回临时请求视图；绝不改写原消息或落盘图像编码。 */
export async function hydrateImageMessages(
  messages: AgentMessage[], options: { signal?: AbortSignal; supportsImages?: boolean } = {},
): Promise<AgentMessage[]> {
  const cache = new Map<string, Promise<ImageContent>>()
  const projected: AgentMessage[] = []
  for (const message of messages) {
    const paths = getMessageImagePaths(message)
    if (message.role !== "user" || !paths.length) { projected.push(message); continue }
    options.signal?.throwIfAborted()
    const original: (TextContent | ImageContent)[] = typeof message.content === "string"
      ? (message.content ? [{ type: "text", text: message.content }] : [])
      : [...message.content]
    if (options.supportsImages === false) {
      original.push({ type: "text", text: "[本轮模型不支持图片输入，无法查看附图]" })
    } else {
      for (const path of paths) {
        try {
          let loading = cache.get(path)
          if (!loading) { loading = loadRequestImage(path, options.signal); cache.set(path, loading) }
          original.push(await loading)
        } catch (error) {
          options.signal?.throwIfAborted()
          log.warn("图片路径读取失败，请求视图保留缺失说明:", formatError(error))
          original.push({ type: "text", text: "[附图原文件不可用，无法查看；不要推测图片内容]" })
        }
      }
    }
    projected.push({ ...message, content: original })
  }
  return projected
}
