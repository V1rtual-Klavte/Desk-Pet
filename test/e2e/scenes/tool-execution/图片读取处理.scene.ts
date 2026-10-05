import { deflateSync } from "node:zlib"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../../e2e/types"
import { MAX_IMAGE_EDGE, readImageProcessor } from "@/services/images"
import { executeToolDefinition, getToolByName } from "@/services/tool"
import { NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

/**
 * read 工具的图片处理器（te-21）。
 *
 * 处理器的完整语义（长边 > `MAX_IMAGE_EDGE`(1568) 的图等比重编码、BMP 转 PNG、小图原样
 * 直传、**任何处理失败都回退原图**并返回 `{ok:true}`）里，只有**回退侧**能在本宿主里执行：
 * 缩放与转码要求 `createImageBitmap`（解码）与 `OffscreenCanvas`（重编码），而 E2E Scene
 * runner 是 Node 进程，两个能力都不存在 —— `docs/current/tool-system.md` 如实登记了这条
 * 现状（「Node 进程没有画布/`createImageBitmap` 能力，这条处理链当前对图片一律回退原图并
 * 留痕」）。
 *
 * **可验证性边界（README「宿主能力对等」，与 `窗口信息三态` 同一模式）**：本场景只覆盖
 * 「任何输入都原字节、原 mime、无提示、`{ok:true}` 交出」这一当前唯一可执行的用户可见保证
 * （「图片不再消失」是这条链的核心）；缩放与 BMP 转换当前没有可执行入口，不假装覆盖。
 * `expectNoImageCodecBoundary` 把「位图能力不存在」钉成前置 —— 将来宿主按《原生宿主轻量化
 * 执行契约》把字节送 Rust 图片实现（或补上等价解码/编码）后，它会失败并提示把缩放与转换的
 * 断言按新能力重写回来。
 *
 * 夹具不再依赖画布：PNG 由 `node:zlib` 按 PNG 规范现场写字节（真 PNG，Pi `read.js` 的字节头
 * 探测与将来的解码重写都用得上），BMP 沿用按 Pi 判据手写的 24bpp 夹具。
 *
 * 接线的可观测部分另由 `expectReadToolWiringCarriesImagePart` 真实驱动一次：全字节 < 0x80 的
 * 24bpp BMP 夹具经**注册表里的** `write` 工具落盘（字符串通道下 UTF-8 编码与原字节一致，
 * 绕开了 `Uint8Array` 写入不受支持的缺口），再用注册表里的 `read` 工具读回 ——
 * `getToolByName("read")` 拿到的正是 `pi-tools.ts` 注册的那一份，删掉
 * `imageProcessor: readImageProcessor` 选项这条就红（Pi 只回一段「Image omitted」文本、
 * 图片 part 整个消失）。
 */

const PNG_MIME = "image/png"
const BMP_MIME = "image/bmp"
/** 接线夹具尺寸：小到 BMP 头里的 LE 数值字段都只占一个低字节，保证「每个字节 < 0x80」。 */
const WIRING_BMP_WIDTH = 4
const WIRING_BMP_HEIGHT = 4

/** CRC32（PNG 块的校验字段）：表驱动，多项式 0xEDB88320。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** PNG 块：长度 + 类型 + 载荷 + CRC32（CRC 覆盖类型与载荷）。 */
function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, payload.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(payload, 8)
  view.setUint32(8 + payload.length, crc32(bytes.subarray(4, 8 + payload.length)))
  return bytes
}

/**
 * 现场生成一张纯色 RGB PNG 夹具（`node:zlib`，不依赖画布）。
 *
 * 为什么不用画布：原生宿主不建 WebView，Scene runner 是 Node 进程，`OffscreenCanvas` 与
 * `document` 都不存在，画布夹具根本造不出来。这里按 PNG 规范直接写字节：签名 + IHDR +
 * IDAT（逐行 filter 0 的原始像素经 deflateSync）+ IEND，产出的是一张真 PNG。
 */
function pngFixture(width: number, height: number, color: readonly [number, number, number] = [0x30, 0x60, 0xc0]): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8                                  // 位深
  ihdr[9] = 2                                  // 颜色类型：真彩色 RGB
  ihdr[10] = 0                                 // 压缩：deflate
  ihdr[11] = 0                                 // 滤波：自适应
  ihdr[12] = 0                                 // 交错：无
  const rowSize = 1 + width * 3
  const raw = new Uint8Array(rowSize * height)
  for (let row = 0; row < height; row += 1) {
    const at = row * rowSize
    raw[at] = 0                                // 每行滤波类型 none
    for (let column = 0; column < width; column += 1) {
      const pixel = at + 1 + column * 3
      raw[pixel] = color[0]
      raw[pixel + 1] = color[1]
      raw[pixel + 2] = color[2]
    }
  }
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))]
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

/** 只读 IHDR 的宽高：核对夹具本身（不是产品断言），PNG 宽高在签名后的固定偏移 16/20。 */
function pngHeaderSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
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

function process(bytes: Uint8Array, mimeType: string, autoResizeImages: boolean) {
  return readImageProcessor(bytes, mimeType, { autoResizeImages }, BACKGROUND_CONTEXT)
}

/** 一次调用的成功结果；失败联合在这里直接判失败（本场景只有「连 base64 都编不出来」才该走到它）。 */
async function processed(bytes: Uint8Array, mimeType: string, autoResizeImages = true) {
  const result = await process(bytes, mimeType, autoResizeImages)
  if (!result.ok) throw new Error(`处理器返回失败联合（图片会整个消失）: ${result.message}`)
  return result
}

/** 回退侧的完整判据：mime 不变、字节一致、无处理提示（做了什么与报了什么必须对得上）。 */
function assertOriginalPassedThrough(
  label: string,
  result: { data: string; mimeType: string; hints: string[] },
  source: Uint8Array,
  mimeType: string,
): void {
  if (result.mimeType !== mimeType) throw new Error(`${label} 的 mime 被改动: ${result.mimeType}`)
  if (!sameBytes(fromBase64(result.data), source)) throw new Error(`${label} 没有原样交出字节（图片被改动或丢失）`)
  if (result.hints.length !== 0) throw new Error(`${label} 报了自己没做的处理: ${JSON.stringify(result.hints)}`)
}

export const 图片读取处理: SceneDef = {
  meta: {
    caseId: "tool-read-image-resize",
    module: "tool-execution",
    contractId: "te-21",
    description: "无位图能力时任何输入（超阈值/恰好阈值/小图/BMP/截断）都原字节、原 mime、无提示回退，read 工具接线仍交出图片 part",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "image", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "回退侧逐类核对与真实 read 工具接线",
    userText: "校验 read 工具的图片处理。",
    checks: [
      {
        type: "expectNoImageCodecBoundary",
        run: async () => {
          // 这条前置是本场景可验证范围的唯一依据：位图能力出现后，下面的「回退」断言
          // 不再成立，必须按新能力把缩放（只缩不放、等比、阈值两侧）与 BMP→PNG 写回来
          // （见文件头「可验证性边界」）。
          if (typeof OffscreenCanvas !== "undefined" || typeof createImageBitmap !== "undefined") {
            throw new Error("宿主已具备画布/位图能力：图片缩放与 BMP 转换的断言需要按新能力重写（当前场景只覆盖回退侧）")
          }
          // 夹具自身先自证：zlib PNG 写出的必须是声明尺寸的真 PNG（夹具错了，后续
          // 「原样直传」断言会失去意义）。
          const probe = pngFixture(8, 4)
          if (probe[0] !== 0x89 || probe[1] !== 0x50 || probe[2] !== 0x4e || probe[3] !== 0x47) {
            throw new Error("zlib PNG 夹具缺少 PNG 签名")
          }
          const size = pngHeaderSize(probe)
          if (size.width !== 8 || size.height !== 4) throw new Error(`zlib PNG 夹具的 IHDR 写错了: ${size.width}x${size.height}`)
        },
      },
      {
        type: "expectOversizedImagePassedThroughWithoutCodec",
        run: async () => {
          // 阈值数字是契约常量（全仓唯一定义点）：将来接入解码后，缩放判据按它重写。
          if (MAX_IMAGE_EDGE !== 1568) throw new Error(`长边阈值被改动: ${MAX_IMAGE_EDGE}`)
          const source = pngFixture(2400, 400)
          const result = await processed(source, PNG_MIME)
          assertOriginalPassedThrough("超阈值 PNG", result, source, PNG_MIME)
          // autoResizeImages=false 在当前能力下与缺省走同一条回退路径；接入解码后这一对
          // 才真正分化（关缩放字节必须不变），届时在这里补两侧断言。
          const disabled = await processed(source, PNG_MIME, false)
          assertOriginalPassedThrough("关闭缩放的超阈值 PNG", disabled, source, PNG_MIME)
        },
      },
      {
        type: "expectEdgeAndSmallImagesPassedThrough",
        run: async () => {
          // 恰好等于阈值不算超限：不论有没有解码能力，这一档都不该被重编码。
          const atEdge = pngFixture(MAX_IMAGE_EDGE, 500)
          const atEdgeResult = await processed(atEdge, PNG_MIME)
          assertOriginalPassedThrough(`长边恰好 ${MAX_IMAGE_EDGE} 的 PNG`, atEdgeResult, atEdge, PNG_MIME)

          // 小图同样原样直传（重编码只会掉保真、白烧 CPU）。
          const small = pngFixture(320, 200)
          const smallResult = await processed(small, PNG_MIME)
          assertOriginalPassedThrough("小图 PNG", smallResult, small, PNG_MIME)
        },
      },
      {
        type: "expectUndecodableImageFallsBackToOriginal",
        run: async () => {
          // 解码失败（PNG 头还在、数据被截断）也必须交出原图：ok 为真、mime 与字节都是原样。
          const broken = pngFixture(200, 100).slice(0, 64)
          const result = await processed(broken, PNG_MIME)
          assertOriginalPassedThrough("截断 PNG", result, broken, PNG_MIME)
        },
      },
      {
        type: "expectBmpPassedThroughWithoutCodec",
        run: async () => {
          // 无位图能力时 BMP 按原 mime 直插 —— 这是契约里已登记的回退风险（完全绕过 1568
          // 约束）；接入解码后 BMP 不论尺寸都必须转 PNG，届时按能力分支重写这条。
          const bmp = bmpFixture(200, 100)
          const result = await processed(bmp, BMP_MIME)
          assertOriginalPassedThrough("BMP", result, bmp, BMP_MIME)
        },
      },
      {
        type: "expectReadToolWiringCarriesImagePart",
        run: async () => {
          // 与前面各条不同：这一条不直接调处理器，而是驱动注册表里**真实接线**的那一份 read 工具
          // （`pi-tools.ts` 注册的 `pi-read`，name 为 read），夹具经真实写入路径落盘 —— 注册表里的
          // `write` 工具 → NativeExecutionEnv → Rust `file_write`。
          // 存在的理由：删掉 createReadTool 的 `imageProcessor` 选项时，Pi 只交回一段
          // 「Image omitted」文本、图片 part 整个消失，而直接调处理器的那些检查全都还是绿的。
          const fixture = bmpFixture(WIRING_BMP_WIDTH, WIRING_BMP_HEIGHT, [0x40, 0x40, 0x40])
          if (fixture.some(byte => byte >= 0x80)) {
            throw new Error("接线夹具不再满足「每个字节 < 0x80」的前提（字符串写入通道会改变字节），需重做夹具")
          }
          const env = new NativeExecutionEnv(await NativeExecutionEnv.defaultCwd())
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
            // 无位图能力的分支：原 mime + 原字节，且不得声称做过转换（做了什么与报了什么必须对得上）。
            const image = images[0]!
            if (image.mimeType !== BMP_MIME) throw new Error(`无位图能力时 read 工具报了别的 mime: ${image.mimeType}`)
            if (!sameBytes(fromBase64(image.data), fixture)) throw new Error("无位图能力时 read 工具没有原样交出图片字节")
            if (result.content.includes(`[BMP 已转为 ${PNG_MIME}]`)) throw new Error("无位图能力却声称完成了 BMP 转换")
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
