// ==========================================
// read 工具的图片处理器（决策 10）
//   长边 > MAX_IMAGE_EDGE 的图等比重编码到长边 ≤ MAX_IMAGE_EDGE
//   BMP → PNG（不论尺寸）
//   小图原样（不需要缩放也不是 BMP 时不重编码）
//   任何处理失败交出原图 —— 图片不再消失
//
// 形状照安装版 Pi 的 `ReadImageProcessor`
// （node_modules/@earendil-works/pi-agent-core/dist/harness/tools/read.d.ts:15-26）：
// 4 参 `(bytes, mimeType, { autoResizeImages }, context)` + 判别式联合返回。
//
// 「失败回退原图」只能由本模块自己 base64 编码原图并返回 `{ok:true}`：Pi 收到 `{ok:false}`
// 时只把 message 拼进一段文本（同目录 read.js:24-29），图片 part 完全不出现。
//
// Pi 自己不缩放：`autoResizeImages` 只是它转交给处理器的开关（read.js:23），
// 换言之缩放规则全仓只有这一份，不存在第二套与之打架的实现。
// ==========================================

import type { Context, ReadImageProcessor, ReadImageProcessorResult } from "@earendil-works/pi-agent-core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ReadImage")

/** 长边上限（视觉输入的通行口径）。**全仓唯一阈值定义点**。 */
export const MAX_IMAGE_EDGE = 1568

/** BMP 判定只认 Pi 探测出的 mime（read.js:20 的 detectSupportedImageMimeType 已按字节头判完），
 *  不在这里重造第二份字节头规则。**全仓唯一 BMP 判定点**。 */
const BMP_MIME = "image/bmp"
/** BMP 的转换目标；另一种格式的图走缩放时沿用原 mime。 */
const PNG_MIME = "image/png"

type ImageCanvas = OffscreenCanvas | HTMLCanvasElement

/** 离屏画布优先；两者都没有（能力缺失）返回 undefined，由调用方走原图回退。 */
function createCanvas(width: number, height: number): ImageCanvas | undefined {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height)
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

/** 画布取 2d 上下文：离屏画布有 `convertToBlob`，文档画布只有 `toBlob`。
 *  用能力判定而不是 `instanceof OffscreenCanvas` —— 构造器不存在时 instanceof 会抛 ReferenceError。 */
function context2d(canvas: ImageCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return canvas.getContext("2d")
}

async function encodeCanvas(canvas: ImageCanvas, mimeType: string): Promise<Blob | undefined> {
  try {
    if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type: mimeType })
    const blob = await new Promise<Blob | null>(resolve => { canvas.toBlob(resolve, mimeType) })
    if (!blob) log.warn("画布未产出图片数据，原图直传:", { mimeType })
    return blob ?? undefined
  } catch (error) {
    log.warn("画布编码失败，原图直传:", { mimeType }, formatError(error))
    return undefined
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** 手工 base64（Pi 的 `encodeBase64` 不从包根导出）：逐个三元组拼字符串，
 *  不用 `btoa` + 展开运算符，避免大图触发参数长度/栈限制。 */
function encodeBase64(bytes: Uint8Array): string {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64_ALPHABET[first >> 2]
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    output += second === undefined ? "=" : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f]
  }
  return output
}

/** 解码只为拿尺寸与画布源，不是缩放规则；能力缺失或解码失败都返回 undefined 走原图回退。 */
async function decodeBitmap(bytes: Uint8Array, mimeType: string): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== "function") {
    log.warn("当前 WebView 没有 createImageBitmap，原图直传:", { mimeType })
    return undefined
  }
  try {
    // new Uint8Array(bytes) 只为把 ArrayBufferLike 视图收敛成 BlobPart 要求的 ArrayBuffer 视图
    return await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }))
  } catch (error) {
    log.warn("图片解码失败，原图直传:", { mimeType, bytes: bytes.byteLength }, formatError(error))
    return undefined
  }
}

interface EncodedImage {
  data: string
  mimeType: string
  width: number
  height: number
}

/** 画布重编码：缩放与 BMP→PNG 的唯一实现；目标 mime 由调用方给（BMP 转 PNG，其余沿用原 mime）。
 *  实际 mime 以 Blob 类型为准：画布不支持请求的编码类型时会自行产出 PNG，
 *  写死请求类型会造出「标签与字节不符」的图片。任何一步失败返回 undefined（原图回退）。 */
async function reencode(bitmap: ImageBitmap, targetMime: string, resize: boolean): Promise<EncodedImage | undefined> {
  // 只缩不放：resize 为假、或长边本来就没超阈值时 scale 为 1，尺寸不变
  const scale = resize ? Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height)) : 1
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = createCanvas(width, height)
  if (!canvas) {
    log.warn("当前环境没有可用画布，原图直传:", { targetMime })
    return undefined
  }
  const ctx = context2d(canvas)
  if (!ctx) {
    log.warn("画布 2d 上下文不可用，原图直传:", { targetMime })
    return undefined
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  const blob = await encodeCanvas(canvas, targetMime)
  if (!blob) return undefined
  // 标签与字节必须一致：画布没报告实际编码类型就宁可回退原图，猜一个类型等于给模型一张坏图
  if (!blob.type) {
    log.warn("画布未报告实际编码类型，原图直传:", { targetMime })
    return undefined
  }
  return { data: encodeBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type, width, height }
}

/** 原图回退：原字节按原 mime 编码交回去。
 *
 *  这条路径**有意不返回 `{ok:false}`**：Pi 拿到失败只输出一段文本（read.js:24-29），图片 part
 *  会彻底消失，用户与模型都以为「这张图不存在」。用户看得见图比看得见报错重要，所以任何失败
 *  （解码失败 / 画布不可用 / 编码失败）都降级为原图直传；根因留痕在 decodeBitmap / reencode /
 *  encodeCanvas 的 log.warn —— 本模块失败出口只有那几处。
 *  只有连 base64 都编不出来（没有任何图片数据可交）才如实返回 `{ok:false}`。 */
function originalImage(bytes: Uint8Array, mimeType: string): ReadImageProcessorResult {
  try {
    return { ok: true, data: encodeBase64(bytes), mimeType, hints: [] }
  } catch (error) {
    log.error("原图 base64 编码失败，只能如实报错:", { mimeType, bytes: bytes.byteLength }, formatError(error))
    return { ok: false, message: `无法编码图片数据（${mimeType}，${bytes.byteLength} 字节）` }
  }
}

export const readImageProcessor: ReadImageProcessor = async (bytes, mimeType, options, _context: Context) => {
  const isBmp = mimeType === BMP_MIME
  const bitmap = await decodeBitmap(bytes, mimeType)
  try {
    if (bitmap) {
      const resize = options.autoResizeImages && Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE
      if (isBmp || resize) {
        const encoded = await reencode(bitmap, isBmp ? PNG_MIME : mimeType, resize)
        if (encoded) {
          const hints: string[] = []
          if (isBmp) hints.push(`[BMP 已转为 ${encoded.mimeType}]`)
          if (resize) hints.push(`[已缩放 ${bitmap.width}x${bitmap.height} → ${encoded.width}x${encoded.height}]`)
          return { ok: true, data: encoded.data, mimeType: encoded.mimeType, hints }
        }
      }
      // 落到末尾有两类情形，输出相同（原图直传）：小图原样（不需要缩放也不是 BMP，
      // 重编码只会掉保真、白烧 CPU）与重编码失败（根因已在上面的 log.warn 留痕）
    }
  } catch (error) {
    log.warn("图片处理异常，原图直传:", { mimeType, bytes: bytes.byteLength }, formatError(error))
  } finally {
    bitmap?.close()
  }
  return originalImage(bytes, mimeType)
}
