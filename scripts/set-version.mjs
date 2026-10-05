#!/usr/bin/env node
/**
 * 发版版本号统一入口。
 *
 * 单一真相源（W10a 起）：根 Cargo.toml 的 `[workspace.package] version`；
 * 成员 crate（crates/native-host）以 `version.workspace = true` 继承。
 * 本脚本把全部投影点写成与真相源一致：
 *   · package.json
 *   · packaging/desktop.json（cargo-packager 的 --config 元数据；它**不会**自动读
 *     Cargo 版本，不显式同步就会打出版本号错的包）
 *
 * AGENTS.md 的口径是「发布版本以 Git tag 为准」，仓库里的这些是它的投影；
 * 本脚本负责让投影保持一致，CI 侧由 scripts/check-bundle-config.mjs 校验 ——
 * 忘了同步会在 tag 构建时被拦下，而不是产出一个版本号不对的安装包。
 *
 * 用法：pnpm run version:set 0.15.0
 * 只接受合法 semver。先把全部目标读入内存并渲染好，全部成功才落盘，
 * 所以「最后一处失败」不会留下前面几处被改坏的工作区。
 *
 * [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 版本目标：真相源在前，投影点随后。最终三处 —— 根 Cargo.toml（[workspace.package]）、
 * package.json、packaging/desktop.json；其余投影点已随 src-tauri 一并删除。
 */
export const VERSION_TARGETS = [
  { file: "Cargo.toml", render: renderWorkspaceVersion },
  { file: "package.json", render: renderJsonVersion },
  { file: "packaging/desktop.json", render: renderJsonVersion },
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

/**
 * 只改根 Cargo.toml `[workspace.package]` 段内的 version 行（单一真相源的渲染器）。
 *
 * 刻意不用「首个行首 version =」口径：根文件是虚拟清单，没有 [package]，首个行首匹配
 * 会失配；将来文件里出现其它行首 version（分段的根文件常见）还会误伤。这正是未完成
 * 原生宿主迁移过程记录 §9.4 第 33 条登记的地雷。
 * 段不存在、段内没有 version、或段内有多行 version（TOML 重复键）都直接报错，
 * 绝不静默不改。
 */
function renderWorkspaceVersion(content, version, file) {
  const lines = content.split("\n")
  let inSection = false
  let sectionFound = false
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    // 表头识别刻意宽松（含引号表名与行尾注释），只用于切换段边界；
    // 多行数组里按行出现的裸 `[...]` 元素理论上会误判边界，但那种误判的后果是
    // 「找不到 version 行」直接报错，而不是改错行 —— 宁可报错也不静默误伤。
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(lines[i])
    if (header) {
      inSection = header[1] === "workspace.package"
      if (inSection) sectionFound = true
      continue
    }
    if (inSection && /^version\s*=\s*"[^"]*"\s*$/.test(lines[i])) hits.push(i)
  }
  if (!sectionFound) {
    throw new Error(`${file} 里找不到 [workspace.package] 段（应用版本单一真相源）`)
  }
  if (hits.length === 0) {
    throw new Error(`${file} 的 [workspace.package] 段里找不到 version 行`)
  }
  if (hits.length > 1) {
    throw new Error(`${file} 的 [workspace.package] 段里有多行 version（${hits.length} 行），无法判断该改哪一行`)
  }
  // 原地替换值，保留行尾空白（如 CRLF 的 \r）与缩进
  lines[hits[0]] = lines[hits[0]].replace(/^version\s*=\s*"[^"]*"/, `version = "${version}"`)
  return lines.join("\n")
}

/**
 * 把 rootDir 下全部版本目标统一写成 version。
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
    console.log(`  3. git tag v${version} && git push && git push origin v${version}`)
    console.log("     （tag 是轻量标签，--follow-tags 推不上去；发版流程见 .github/workflows/README.md）")
  } catch (error) {
    console.error(`版本号统一失败: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
