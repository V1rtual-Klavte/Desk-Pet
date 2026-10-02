#!/usr/bin/env node
/**
 * 打包配置守卫：CI 的 bundle-config job 与本地 `pnpm run check:bundle` 共用同一实现。
 *
 * 只做**零编译、零依赖安装**的静态检查 —— Release 模式的 Rust 构建在 macOS runner 上
 * 按 10 倍计费，而绝大多数「打包悄悄烂掉」都是从配置漂移开始的（图标丢了、targets
 * 写死成某个平台的目标、identifier 不合法、三处版本号或与 tag 分叉）。
 *
 * 检查项与失败含义见《发布与打包契约》§3.1；本文件是那张表的执行机制，不是第二个定义点。
 *
 * 扫描的是文件文本与路径存在性：它保证「打包不会因为配置问题失败」，不保证产物可用。
 *
 * [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

const CONF = "src-tauri/tauri.conf.json"
const NPM_PACKAGE = "package.json"
const CARGO_MANIFEST = "src-tauri/Cargo.toml"
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/

/** 各平台合法的 bundle target。`"all"` 由 host OS 决定候选集，永远合法。 */
const KNOWN_TARGETS = new Set([
  "app", "dmg", "nsis", "msi", "deb", "rpm", "appimage", "updater",
])

function checkTargets(targets, problems) {
  if (targets === "all") return
  if (Array.isArray(targets) && targets.length > 0 && targets.every(t => KNOWN_TARGETS.has(t))) {
    // 合法但不够平台中立：单平台目标列表在另一个平台会被过滤成空集
    problems.push(
      `bundle.targets 写成了具体目标 ${JSON.stringify(targets)}：` +
      `Tauri 会按 host OS 过滤，换平台可能过滤成空集而出不了包。改用 "all"，并在 CI 用 --bundles 裁产物`,
    )
    return
  }
  problems.push(`bundle.targets 不合法: ${JSON.stringify(targets)}（应为 "all" 或已知目标的数组）`)
}

/** 读取 package.json 的顶层 version；文件缺失、JSON 坏或字段非法时记问题并返回 null。 */
function readPackageVersion(rootDir, problems) {
  const path = join(rootDir, NPM_PACKAGE)
  if (!existsSync(path)) {
    problems.push(`${NPM_PACKAGE} 不存在`)
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    problems.push(`${NPM_PACKAGE} 不是合法 JSON: ${error.message}`)
    return null
  }
  const version = parsed.version
  if (typeof version !== "string" || !SEMVER.test(version)) {
    problems.push(`${NPM_PACKAGE} 的 version 不是合法 semver，收到: ${JSON.stringify(version)}`)
    return null
  }
  return version
}

/**
 * 读取 Cargo.toml `[package]` 段的 version。
 * `[package]` 的 version 一定在行首；[dependencies] 里的嵌套 version 不是行首，
 * 所以 `/^version\s*=/m` 只会命中前者（与 scripts/set-version.mjs 同一口径）。
 */
function readCargoVersion(rootDir, problems) {
  const path = join(rootDir, CARGO_MANIFEST)
  if (!existsSync(path)) {
    problems.push(`${CARGO_MANIFEST} 不存在`)
    return null
  }
  const match = readFileSync(path, "utf8").match(/^version\s*=\s*"([^"]*)"/m)
  if (!match) {
    problems.push(`${CARGO_MANIFEST} 里找不到 [package] 的 version 行`)
    return null
  }
  if (!SEMVER.test(match[1])) {
    problems.push(`${CARGO_MANIFEST} 的 version 不是合法 semver，收到: ${JSON.stringify(match[1])}`)
    return null
  }
  return match[1]
}

/**
 * 校验 rootDir 下的打包配置。
 * @param {string} rootDir 仓库根
 * @param {{ tag?: string | null }} [options] tag 形如 `v0.15.0`；给了就要求三处 version 都与它一致
 * @returns {string[]} 问题清单，空数组 = 通过
 */
export function checkBundleConfig(rootDir, options = {}) {
  const problems = []
  const confPath = join(rootDir, CONF)

  if (!existsSync(confPath)) {
    return [`${CONF} 不存在`]
  }
  let conf
  try {
    conf = JSON.parse(readFileSync(confPath, "utf8"))
  } catch (error) {
    return [`${CONF} 不是合法 JSON: ${error.message}`]
  }

  if (!conf.productName || typeof conf.productName !== "string") {
    problems.push("productName 必须是非空字符串（安装包与窗口都在用它）")
  }
  const confVersionOk = typeof conf.version === "string" && SEMVER.test(conf.version)
  if (!confVersionOk) {
    problems.push(`version 必须是合法 semver，收到: ${JSON.stringify(conf.version)}`)
  }
  if (!conf.identifier || !IDENTIFIER.test(conf.identifier)) {
    problems.push(`identifier 必须是反向域名形式（如 com.v1rtual.deskpet），收到: ${JSON.stringify(conf.identifier)}`)
  }

  const bundle = conf.bundle ?? {}
  if (bundle.active !== true) {
    problems.push("bundle.active 不是 true：打包会被整体跳过")
  }
  checkTargets(bundle.targets, problems)

  const icons = bundle.icon
  if (!Array.isArray(icons) || icons.length === 0) {
    problems.push("bundle.icon 必须是非空数组")
  } else {
    for (const icon of icons) {
      if (!existsSync(join(rootDir, "src-tauri", icon))) {
        problems.push(`bundle.icon 指向的文件不存在: src-tauri/${icon}`)
      }
    }
  }

  const pubkey = conf.plugins?.updater?.pubkey
  if (typeof pubkey !== "string" || pubkey.trim() === "") {
    problems.push("plugins.updater.pubkey 为空：updater 装了也永远验不过签名，先跑 tauri signer generate")
  }

  // 版本号三处一致（契约 §8 的完成定义）。tauri.conf.json 是打包实际写进产物的那份，
  // 作为对照基准；package.json 与 Cargo.toml 是它的投影，手改任一处都要在这里被拦下。
  const packageVersion = readPackageVersion(rootDir, problems)
  const cargoVersion = readCargoVersion(rootDir, problems)
  const otherVersions = [
    { file: NPM_PACKAGE, version: packageVersion },
    { file: CARGO_MANIFEST, version: cargoVersion },
  ]
  if (confVersionOk) {
    for (const { file, version } of otherVersions) {
      if (version !== null && version !== conf.version) {
        problems.push(
          `${file} 的 version ${JSON.stringify(version)} 与 ${CONF} 的 version ${JSON.stringify(conf.version)} 不一致：` +
          `先跑 pnpm run version:set ${conf.version} 再打 tag`,
        )
      }
    }
  }

  const tag = options.tag
  if (tag) {
    const tagVersion = String(tag).replace(/^v/, "")
    // 三处都要与 tag 一致，逐文件报出，不能只查 tauri.conf.json
    const allVersions = [
      { file: CONF, version: confVersionOk ? conf.version : null },
      ...otherVersions,
    ]
    for (const { file, version } of allVersions) {
      if (version !== null && version !== tagVersion) {
        problems.push(
          `tag ${tag} 与 ${file} 的 version ${JSON.stringify(version)} 不一致：` +
          `先跑 pnpm run version:set ${tagVersion} 再打 tag`,
        )
      }
    }
  }

  return problems
}

/**
 * 解析本次运行要校验的 tag。
 *
 * GitHub Actions 在任何触发下都会设置 `GITHUB_REF_NAME`（push 时是分支名、pull_request 时是
 * `123/merge`），所以**不能**直接把它当 tag —— 只有 `GITHUB_REF_TYPE === "tag"` 时它才是 tag。
 * 本地手动跑可用第一个位置参数指定 tag。
 * @param {Record<string, string | undefined>} env
 * @param {string[]} argv
 * @returns {string | null}
 */
export function resolveTag(env, argv) {
  if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME
  return argv[2] ?? null
}

function main() {
  const tag = resolveTag(process.env, process.argv)
  const problems = checkBundleConfig(REPO_ROOT, { tag })
  if (problems.length === 0) {
    console.log(`打包配置校验通过${tag ? `（tag ${tag}）` : ""}`)
    return
  }
  console.error("打包配置校验失败：")
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
