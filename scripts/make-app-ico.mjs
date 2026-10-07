#!/usr/bin/env node
/**
 * 由 `resources/icons/mascot-app-icon-1024.png` 生成 Windows 用的
 * `resources/icons/mascot-app-icon.ico`（exe 内嵌图标 / 安装器图标都用它）。
 *
 * 为什么要 exe 内嵌：`ui/platform/windows.rs` 按 `LoadIconW(module, 1)` 取应用图标
 * （资源 ID 1），取不到就回落系统默认图标 —— 任务栏、Alt-Tab、托盘全是默认那个。
 * cargo-packager 只把图标用在安装器与快捷方式上，**不会**写进 exe 的资源段，那一步
 * 必须由 `crates/native-host/build.rs` 在编译期做。
 *
 * ICO 用 PNG 内嵌条目（Vista 起支持，本产品最低 Windows 10）：不需要 BMP/DIB 转换，
 * 也就不需要 Pillow/ImageMagick 之类的额外依赖，只用 sips（macOS 自带）缩放。
 *
 * 用法：node scripts/make-app-ico.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SRC = join(ROOT, "resources", "icons", "mascot-app-icon-1024.png")
const OUT = join(ROOT, "resources", "icons", "mascot-app-icon.ico")
/** Windows 各档常用尺寸；256 是任务栏大图与「超大图标」视图的上限。 */
const SIZES = [16, 32, 48, 256]

const work = join(tmpdir(), `deskpet-ico-${process.pid}`)
mkdirSync(work, { recursive: true })

try {
  const images = SIZES.map((size) => {
    const png = join(work, `${size}.png`)
    execFileSync("sips", ["-z", String(size), String(size), SRC, "--out", png], { stdio: "ignore" })
    return { size, bytes: readFileSync(png) }
  })

  // ICONDIR（6 字节）+ ICONDIRENTRY × N（每个 16 字节）+ 各图像数据
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach((image, index) => {
    const at = index * 16
    // 256 在 ICO 目录项里用 0 表示
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at)
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板数（PNG 条目不用）
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // planes
    directory.writeUInt16LE(32, at + 6) // 位深
    directory.writeUInt32LE(image.bytes.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += image.bytes.length
  })

  writeFileSync(OUT, Buffer.concat([header, directory, ...images.map((image) => image.bytes)]))
  console.log(`make-app-ico: 已生成 ${OUT}（${SIZES.join("/")}，共 ${readFileSync(OUT).length} 字节）`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
