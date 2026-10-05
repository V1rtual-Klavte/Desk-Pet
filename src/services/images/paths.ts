// 资源 URL 经端口取用（Node 侧等 W7 的原生资源通道）；
// invoke 走 HostBridge。本模块不 import 任何 @tauri-apps。
import { getHostBridge, getResourceUrlResolver } from "@/services/host"
import limits from "./limits.json"

export const CHAT_IMAGE_LIMITS = Object.freeze(limits)

/** 路径元数据是持久形态；图像字节只在请求投影时读取。 */
export function getMessageImagePaths(message: unknown): string[] {
  const value = (message as { deskpetImagePaths?: unknown } | null)?.deskpetImagePaths
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && path.length > 0) : []
}

export function chatImageUrl(path: string): string { return getResourceUrlResolver().toResourceUrl(path) }

export async function prepareImagePaths(paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return []
  return getHostBridge().request("validate_chat_images", { paths: [...paths] })
}

export async function pickChatImages(): Promise<string[]> {
  return getHostBridge().request("pick_chat_images", {})
}

/** 判据认文件头，扩展名只参与原生文件选择器过滤。 */
export function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return undefined
}

