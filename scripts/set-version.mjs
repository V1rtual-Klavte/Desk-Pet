#!/usr/bin/env node
/**
 * 发版版本号统一入口：一次改三处（tauri.conf.json / Cargo.toml / package.json）。
 *
 * AGENTS.md 的口径是「发布版本以 Git tag 为准」，仓库里的三处是它的投影；
 * 本脚本负责让投影保持一致，CI 侧由 scripts/check-bundle-config.mjs 校验 ——
 * 忘了同步会在 tag 构建时被拦下，而不是产出一个版本号不对的安装包。
 *
 * 用法：pnpm run version:set 0.15.0
 * 只接受合法 semver。先把三处全部读入内存并渲染好，全部成功才落盘，
 * 所以「第三处失败」不会留下前两处被改坏的工作区。
 *
 * [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 三处版本号的相对路径与各自的改写函数。 */
export const VERSION_TARGETS = [
  { file: "src-tauri/tauri.conf.json", render: renderJsonVersion },
  { file: "src-tauri/Cargo.toml", render: renderCargoVersion },
  { file: "package.json", render: renderJsonVersion },
]

/** 校验并归一化版本号：接受 `v0.15.0` 形式，返回裸 semver。 */
export function parseVersion(input) {
  const text = String(input ?? "").trim().replace(/^v/, "")
  if (!SEMVER.test(text)) {
    throw new Error(`版本号必须是合法 semver（如 0.15.0 或 0.15.0-rc.1），收到: ${JSON.stringify(input)}`)
  }
  return text
}

function renderJsonVersion(content, version, file) {
  if (!/"version"\s*:\s*"[^"]*"/.test(content)) {
    throw new Error(`${file} 里找不到顶层 "version" 字段`)
  }
  // 只替换第一次出现，避免误伤嵌套的同名字段
  return content.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
}

function renderCargoVersion(content, version, file) {
  // Cargo.toml 里第一个行首 `version = ` 属于 [package]；[lib]/[dependencies] 的 version 不在行首
  if (!/^version\s*=\s*"[^"]*"/m.test(content)) {
    throw new Error(`${file} 里找不到 [package] 的 version 行`)
  }
  return content.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
}

/**
 * 把 rootDir 下三处版本号统一写成 version。
 * 返回被写入的相对路径数组；任一处渲染失败都抛错且**不写任何文件**。
 */
export function applyVersion(rootDir, version) {
  const plan = VERSION_TARGETS.map((target) => {
    const abs = join(rootDir, target.file)
    const before = readFileSync(abs, "utf8")
    return { abs, file: target.file, after: target.render(before, version, target.file) }
  })
  for (const item of plan) writeFileSync(item.abs, item.after)
  return plan.map((item) => item.file)
}

function main() {
  const raw = process.argv[2]
  if (!raw) {
    console.error("用法: pnpm run version:set <x.y.z>")
    process.exit(2)
  }
  try {
    const version = parseVersion(raw)
    const written = applyVersion(REPO_ROOT, version)
    for (const file of written) console.log(`  已更新 ${file} → ${version}`)
    console.log(`\n接下来：`)
    console.log(`  1. pnpm run test:types        # 同步 Cargo.lock 并确认编译`)
    console.log(`  2. git commit -am "chore(release): ${version}"`)
    console.log(`  3. git tag v${version} && git push --follow-tags`)
  } catch (error) {
    console.error(`版本号统一失败: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
