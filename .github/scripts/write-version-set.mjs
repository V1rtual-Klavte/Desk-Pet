#!/usr/bin/env node
/**
 * 为同一 Native 发布包生成可核对的版本集合清单。
 *
 * cargo-packager 将此文件映射到 macOS Contents/Resources/version-set.json 与
 * Windows 安装根 version-set.json。更新 helper 会在替换前核对 app/node；harness
 * 的 SHA-256 记录随包保存，便于确认 JS bundle 确实随这组原生版本一起构建。
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const desktop = JSON.parse(readFileSync(join(ROOT, "packaging", "desktop.json"), "utf8"))
const runtime = JSON.parse(readFileSync(join(ROOT, "packaging", "node-runtime.json"), "utf8"))
const harnessPath = join(ROOT, "packaging", "dist", "harness", "main.mjs")
const outputPath = join(ROOT, "packaging", "dist", "version-set.json")

if (typeof desktop.version !== "string" || typeof runtime.nodeVersion !== "string") {
  throw new Error("desktop.json.version 与 node-runtime.json.nodeVersion 必须是字符串")
}
if (!existsSync(harnessPath)) {
  throw new Error(`Harness bundle 不存在：${harnessPath}`)
}

const harness = createHash("sha256").update(readFileSync(harnessPath)).digest("hex")
writeFileSync(outputPath, `${JSON.stringify({ app: desktop.version, node: runtime.nodeVersion, harness }, null, 2)}\n`)
console.log(`version-set: app=${desktop.version} node=${runtime.nodeVersion} harness=${harness}`)
