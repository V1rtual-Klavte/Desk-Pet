import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { MAX_IMAGE_EDGE, readImageProcessor } from "@/services/tool/local/image-processor"
import { executeToolDefinition, getToolByName } from "@/services/tool"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

/**
 * read 工具的图片处理器（te-21）。
 *
 * 长边 > `MAX_IMAGE_EDGE`(1568) 的图等比重编码到长边 ≤1568（只缩不放）、BMP 不论尺寸都转 PNG、
 * 小图且非 BMP 原样直传（字节一致）；**任何处理失败都回退原图**并返回 `{ok:true}` ——
 * 有意不返回 `{ok:false}`：Pi 收到失败只输出一段文本、图片 part 完全消失，用户与模型都会
 * 以为这张图不存在。
 *
 * 本场景直接调用生产处理器（`pi-tools.ts` 用 `createReadTool({imageProcessor: readImageProcessor,
 * autoResizeImages: true})` 接入它），夹具在 WebView 里现场生成：决定 mime 的字节头探测在 Pi
 * `read.js` 里，场景按它的判据造 BMP（`BM` + BITMAPINFOHEADER + 24bpp），所以传进去的
 * `image/bmp` 就是 read 工具会给的那个值。
 *
 * 接线的可观测部分另由 `expectReadToolWiringCarriesImagePart` 真实驱动一次：全字节 < 0x80 的
 * 24bpp BMP 夹具经**注册表里的** `write` 工具落盘（字符串通道下 UTF-8 编码与原字节一致，绕开了
 * `Uint8Array` 写入不受支持的缺口），再用注册表里的 `read` 工具读回 —— `getToolByName("read")`
 * 拿到的正是 `pi-tools.ts` 注册的那一份，删掉 `imageProcessor: readImageProcessor` 选项这条就红。
 * 仍未覆盖：`autoResizeImages: true` 这个字面本身不可观测（Pi `read.js` 缺省成 `options.autoResizeImages ?? true`，
 * 删掉选项行为不变）；被写成 `false` 才会改变行为，而那要一张超过阈值的夹具才能看见。
 */

const PNG_MIME = "image/png"
const BMP_MIME = "image/bmp"
/** 接线夹具尺寸：小到 BMP 头里的 LE 数值字段都只占一个低字节，保证「每个字节 < 0x80」。 */
const WIRING_BMP_WIDTH = 4
const WIRING_BMP_HEIGHT = 4

type CanvasLike = OffscreenCanvas | HTMLCanvasElement

/** 夹具画布：离屏优先，与生产处理器的环境判断同形（这里只用来造图片，不是被测逻辑）。 */
function createCanvas(width: number, height: number): CanvasLike | undefined {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height)
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: CanvasLike): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return canvas.getContext("2d")
}

/** 现场生成一张纯色 PNG 夹具。 */
async function pngFixture(width: number, height: number, color = "#3060c0"): Promise<Uint8Array> {
  const canvas = createCanvas(width, height)
  if (!canvas) throw new Error("本机 WebView 没有可用画布，无法生成图片夹具")
  const ctx = context2d(canvas)
  if (!ctx) throw new Error("画布 2d 上下文不可用，无法生成图片夹具")
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  const blob = "convertToBlob" in canvas
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise<Blob | null>(resolve => { canvas.toBlob(resolve, "image/png") })
  if (!blob || blob.type !== PNG_MIME) throw new Error(`画布没有产出 PNG 夹具: ${blob?.type ?? "null"}`)
  return new Uint8Array(await blob.arrayBuffer())
}

/** 24 位 BMP 夹具（4 字节行对齐、自下而上）：Pi `isBmp` 的判据全部命中。
 *  像素色可给：接线检查要一张**每个字节都 < 0x80** 的图（注释见 `expectReadToolWiringCarriesImagePart`）。 */
function bmpFixture(width: number, height: number, pixel: readonly [number, number, number] = [0x20, 0x80, 0xd0]): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const headerBytes = 14 + 40
  const bytes = new Uint8Array(headerBytes + pixelBytes)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)      // declaredFileSize
  view.setUint32(10, headerBytes, true)      // pixelDataOffset
  view.setUint32(14, 40, true)               // BITMAPINFOHEADER
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)                // planes
  view.setUint16(28, 24, true)               // bitsPerPixel
  view.setUint32(34, pixelBytes, true)       // biSizeImage
  view.setInt32(38, 2835, true)
  view.setInt32(42, 2835, true)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const at = headerBytes + row * rowSize + column * 3
      bytes[at] = pixel[0]                   // B
      bytes[at + 1] = pixel[1]               // G
      bytes[at + 2] = pixel[2]               // R
    }
  }
  return bytes
}

/** 字节 → 码位一一对应：全 < 0x80 的字节串经 JS 字符串写出时，UTF-8 编码与原字节一致。 */
function asciiString(bytes: Uint8Array): string {
  let text = ""
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]!)
  return text
}

/** 临时目录/文件操作的失败直接判场景失败（与 harness-storage 场景同一形态）。 */
function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

/** 处理器回传的 data 是 base64：解回字节才能核对「原样直传」这条判据。 */
function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

async function decodeSize(bytes: Uint8Array, mimeType: string): Promise<{ width: number; height: number } | undefined> {
  if (typeof createImageBitmap !== "function") return undefined
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }))
  } catch {
    // 解不出来就是「本机 WebView 不支持这种字节」：这个结果本身就是能力分支的判据，
    // 两条分支各自有断言（BMP 那条见 expectBmpBecomesPngOrFallsBackHonestly，其余处由
    // 「回传的图片解不出来」直接判失败），所以它不是被吞掉的失败，没有第二处留痕点。
    return undefined
  }
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

function process(bytes: Uint8Array, mimeType: string, autoResizeImages: boolean) {
  return readImageProcessor(bytes, mimeType, { autoResizeImages }, BACKGROUND_CONTEXT)
}

/** 一次调用的成功结果；失败联合在这里直接判失败（本场景只有「连 base64 都编不出来」才该走到它）。 */
async function processed(bytes: Uint8Array, mimeType: string, autoResizeImages = true) {
  const result = await process(bytes, mimeType, autoResizeImages)
  if (!result.ok) throw new Error(`处理器返回失败联合（图片会整个消失）: ${result.message}`)
  return result
}

export const 图片读取处理: SceneDef = {
  meta: {
    caseId: "tool-read-image-resize",
    module: "tool-execution",
    contractId: "te-21",
    description: "长边超阈值的图等比缩小、BMP 转 PNG、小图字节一致原样直传，处理失败回退原图而不是丢图",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "image", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "阈值两侧、BMP、原样直传与失败回退逐条核对",
    userText: "校验 read 工具的图片处理。",
    checks: [
      {
        type: "expectOversizedImageScaledToEdge",
        run: async () => {
          if (MAX_IMAGE_EDGE !== 1568) throw new Error(`长边阈值被改动: ${MAX_IMAGE_EDGE}`)
          const source = await pngFixture(2400, 400)
          const result = await processed(source, PNG_MIME)
          if (result.mimeType !== PNG_MIME) throw new Error(`缩放后的 mime 变成了 ${result.mimeType}`)
          const size = await decodeSize(fromBase64(result.data), result.mimeType)
          if (!size) throw new Error("回传的图片解不出来（不是有效图片字节）")
          if (size.width !== MAX_IMAGE_EDGE) throw new Error(`长边没有缩到 ${MAX_IMAGE_EDGE}: ${size.width}x${size.height}`)
          // 等比：只缩不放，高度按同一比例取整。
          const expectedHeight = Math.max(1, Math.round(400 * (MAX_IMAGE_EDGE / 2400)))
          if (size.height !== expectedHeight) throw new Error(`没有等比缩放: ${size.width}x${size.height}，应为 x${expectedHeight}`)
          // hints 里的「缩放前 → 缩放后」必须与真实字节一致（写死的提示不算证据）。
          const hint = `[已缩放 2400x400 → ${size.width}x${size.height}]`
          if (!result.hints.includes(hint)) throw new Error(`缩放提示与实际尺寸不符: ${JSON.stringify(result.hints)}`)
          if (sameBytes(fromBase64(result.data), source)) throw new Error("超限的图被原样交出（没有重编码）")
        },
      },
      {
        type: "expectEdgeAndSmallImagesPassedThrough",
        run: async () => {
          // 恰好等于阈值不算超限：不重编码，字节与原件一致。
          const atEdge = await pngFixture(MAX_IMAGE_EDGE, 500)
          const atEdgeResult = await processed(atEdge, PNG_MIME)
          if (!sameBytes(fromBase64(atEdgeResult.data), atEdge)) {
            throw new Error(`长边恰好 ${MAX_IMAGE_EDGE} 的图被重编码了（阈值判定用了 > 还是 >=？）`)
          }
          if (atEdgeResult.hints.length !== 0) throw new Error(`未处理的图带了提示: ${JSON.stringify(atEdgeResult.hints)}`)
          if (atEdgeResult.mimeType !== PNG_MIME) throw new Error(`原样直传改了 mime: ${atEdgeResult.mimeType}`)

          // 小图同样原样直传（重编码只会掉保真、白烧 CPU）。
          const small = await pngFixture(320, 200)
          const smallResult = await processed(small, PNG_MIME)
          if (!sameBytes(fromBase64(smallResult.data), small)) throw new Error("小图没有原样直传（字节不一致）")
          if (smallResult.hints.length !== 0) throw new Error(`小图带了提示: ${JSON.stringify(smallResult.hints)}`)
        },
      },
      {
        type: "expectJustAboveThresholdResized",
        run: async () => {
          // 阈值 +1 就必须缩：这是「边界值」的另一侧。
          const source = await pngFixture(MAX_IMAGE_EDGE + 1, 500)
          const result = await processed(source, PNG_MIME)
          const size = await decodeSize(fromBase64(result.data), result.mimeType)
          if (!size) throw new Error("回传的图片解不出来（不是有效图片字节）")
          if (size.width !== MAX_IMAGE_EDGE || size.height !== 500) {
            throw new Error(`超阈值 1 像素没有缩到 ${MAX_IMAGE_EDGE}x500: ${size.width}x${size.height}`)
          }
        },
      },
      {
        type: "expectResizeDisabledKeepsBytes",
        run: async () => {
          // autoResizeImages=false（Pi 侧开关）：不缩放也不重编码，尺寸与字节都不变。
          const source = await pngFixture(2400, 400)
          const result = await processed(source, PNG_MIME, false)
          if (!sameBytes(fromBase64(result.data), source)) throw new Error("关闭缩放后仍被重编码")
          if (result.hints.length !== 0) throw new Error(`关闭缩放后仍带提示: ${JSON.stringify(result.hints)}`)
          if (result.mimeType !== PNG_MIME) throw new Error(`关闭缩放后 mime 变了: ${result.mimeType}`)
        },
      },
      {
        type: "expectUndecodableImageFallsBackToOriginal",
        run: async () => {
          // 解码失败（PNG 头还在、数据被截断）也必须交出原图：ok 为真、mime 与字节都是原样。
          const broken = (await pngFixture(200, 100)).slice(0, 64)
          const result = await processed(broken, PNG_MIME)
          if (result.mimeType !== PNG_MIME) throw new Error(`回退路径改了 mime: ${result.mimeType}`)
          if (!sameBytes(fromBase64(result.data), broken)) throw new Error("解码失败时没有交出原图字节")
          if (result.hints.length !== 0) throw new Error(`回退路径不该带处理提示: ${JSON.stringify(result.hints)}`)
        },
      },
      {
        type: "expectBmpBecomesPngOrFallsBackHonestly",
        run: async () => {
          const bmp = bmpFixture(200, 100)
          const decodable = (await decodeSize(bmp, BMP_MIME)) !== undefined
          const result = await processed(bmp, BMP_MIME)
          const bytes = fromBase64(result.data)
          if (decodable) {
            // WebView 能解 BMP：不论尺寸都必须转成 PNG，且转换后的尺寸不变。
            if (result.mimeType !== PNG_MIME) throw new Error(`BMP 没有转成 PNG: ${result.mimeType}`)
            if (!result.hints.includes(`[BMP 已转为 ${PNG_MIME}]`)) throw new Error(`BMP 转换缺提示: ${JSON.stringify(result.hints)}`)
            const size = await decodeSize(bytes, result.mimeType)
            if (!size || size.width !== 200 || size.height !== 100) {
              throw new Error(`BMP 转换后尺寸变了: ${size ? `${size.width}x${size.height}` : "解不出来"}`)
            }
            if (sameBytes(bytes, bmp)) throw new Error("BMP 没有被重新编码（交出的还是 BMP 字节）")
          } else {
            // 本机 WebView 解不了 BMP：如实退回原图（原 mime + 原字节），既不消失也不冒充 PNG。
            if (result.mimeType !== BMP_MIME) throw new Error(`BMP 解不了却报了别的 mime: ${result.mimeType}`)
            if (!sameBytes(bytes, bmp)) throw new Error("BMP 解不了时没有交出原图字节")
            if (result.hints.length !== 0) throw new Error(`BMP 回退路径带了提示: ${JSON.stringify(result.hints)}`)
          }
        },
      },
      {
        type: "expectReadToolWiringCarriesImagePart",
        run: async () => {
          // 与前面各条不同：这一条不直接调处理器，而是驱动注册表里**真实接线**的那一份 read 工具
          // （`pi-tools.ts` 注册的 `pi-read`，name 为 read），夹具经真实写入路径落盘 —— 注册表里的
          // `write` 工具 → TauriExecutionEnv → Rust `file_write`。
          // 存在的理由：删掉 createReadTool 的 `imageProcessor` 选项时，Pi 只交回一段
          // 「Image omitted」文本、图片 part 整个消失，而直接调处理器的那些检查全都还是绿的。
          const fixture = bmpFixture(WIRING_BMP_WIDTH, WIRING_BMP_HEIGHT, [0x40, 0x40, 0x40])
          if (fixture.some(byte => byte >= 0x80)) {
            throw new Error("接线夹具不再满足「每个字节 < 0x80」的前提（字符串写入通道会改变字节），需重做夹具")
          }
          const env = new TauriExecutionEnv(await TauriExecutionEnv.defaultCwd())
          const root = fileOk(await env.createTempDir("deskpet-read-image-", BACKGROUND_CONTEXT))
          try {
            const target = fileOk(await env.joinPath([root, "probe.bmp"], BACKGROUND_CONTEXT))
            const write = getToolByName("write")
            if (!write) throw new Error("write 工具未注册：夹具进不了真实写入路径")
            const written = await executeToolDefinition(write, { path: target, content: asciiString(fixture) }, { toolCallId: "read-image-wiring-write" })
            if (!written.success) throw new Error(`夹具写入失败: ${written.error ?? ""}`)
            // 写入通道只收字符串：先按读取工具同一条 env 入口核对字节原样落地。不一致说明这条
            // 通道（或夹具前提）出了问题，与「read 接线没接上 imageProcessor」是两回事，不能混判。
            const landed = fileOk(await env.readBinaryFile(target, BACKGROUND_CONTEXT))
            if (!sameBytes(landed, fixture)) {
              throw new Error(`夹具经字符串写入后字节不一致（${landed.length} vs ${fixture.length}）：先查写入通道，别读成 read 接线结论`)
            }

            const read = getToolByName("read")
            if (!read) throw new Error("read 工具未注册：接线检查的前提不成立")
            const result = await executeToolDefinition(read, { path: target }, { toolCallId: "read-image-wiring-read" })
            if (!result.success) throw new Error(`真实 read 工具读取夹具失败: ${result.error ?? ""}`)
            const images = (result.contentParts ?? []).filter(
              (part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
            )
            if (images.length !== 1) {
              throw new Error(`真实 read 工具没有交出图片 part（imageProcessor 接线断了？）: ${JSON.stringify(result.contentParts)}`)
            }
            if (result.content.includes("Image omitted")) {
              throw new Error(`read 工具回了「图片已省略」（imageProcessor 没接上）: ${JSON.stringify(result.content)}`)
            }
            // 与直接调处理器那条同样的能力分支：WebView 能解 BMP 就必须转 PNG，解不了就如实退回原图。
            const image = images[0]!
            const bytes = fromBase64(image.data)
            if ((await decodeSize(fixture, BMP_MIME)) !== undefined) {
              if (image.mimeType !== PNG_MIME) throw new Error(`接线后的 read 工具没有把 BMP 转成 PNG: ${image.mimeType}`)
              if (!result.content.includes(`[BMP 已转为 ${PNG_MIME}]`)) {
                throw new Error(`接线后的 read 工具缺 BMP 转换提示: ${JSON.stringify(result.content)}`)
              }
              const size = await decodeSize(bytes, image.mimeType)
              if (!size || size.width !== WIRING_BMP_WIDTH || size.height !== WIRING_BMP_HEIGHT) {
                throw new Error(`接线转换出的 PNG 尺寸不对: ${size ? `${size.width}x${size.height}` : "解不出来"}`)
              }
            } else {
              if (image.mimeType !== BMP_MIME) throw new Error(`BMP 解不了时 read 工具报了别的 mime: ${image.mimeType}`)
              if (!sameBytes(bytes, fixture)) throw new Error("BMP 解不了时 read 工具没有原样交出图片字节")
            }
          } finally {
            // 尽力清理、不参与结论：残留只会是系统 temp 下的一个目录（不在任何数据根里），
            // 断言失败优先于清理结果上报，与 harness-storage 各场景同一形态。
            await env.remove(root, { recursive: true, force: true }, BACKGROUND_CONTEXT)
          }
        },
      },
    ],
  }],
}

export default 图片读取处理
