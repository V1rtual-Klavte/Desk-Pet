#!/usr/bin/env node
/**
 * 打包配置守卫：CI 的 bundle-config job 与本地 `pnpm run check:bundle` 共用同一实现。
 *
 * 只做**零编译、零依赖安装**的静态检查 —— Release 模式的 Rust 构建在 macOS runner 上
 * 按 10 倍计费，而绝大多数「打包悄悄烂掉」都是从配置漂移开始的（版本分叉、identifier
 * 不合法、productName 混入非 ASCII、随包 Node 锁定与实测分叉、发布闭包混进测试资产）。
 *
 * 检查对象：
 *   · 主对象 packaging/desktop.json（cargo-packager 的 --config 元数据）：
 *     productName ASCII、identifier 反向域名、version semver、binaries/resources 形状与包树安检；
 *   · 版本单一真相源：根 Cargo.toml 的 [workspace.package] version；
 *     投影点 package.json 与 packaging/desktop.json 必须与它一致；
 *   · packaging/node-runtime.json：随包 Node 的锁定与实测记录一致性。
 *
 * 检查项与失败含义由各问题的文案自述；操作入口见 .github/workflows/README.md，
 * 设计记录见《发布与打包契约 2026-10-02 基线》。本文件是执行机制，不是第二个定义点。
 *
 * 扫描的是文件文本与路径存在性：它保证「打包不会因为配置问题失败」，不保证产物可用。
 *
 * 用法：
 *   node scripts/check-bundle-config.mjs [tag] [--require-staging]
 *   · tag（如 v0.16.0）：额外校验三处 version 与 tag 一致；CI 里由 GITHUB_REF_TYPE=tag
 *     时的 GITHUB_REF_NAME 提供（resolveTag），手动可传位置参数。
 *   · --require-staging：要求 resources 的暂存 src（packaging/dist/**）必须存在。
 *     release.yml 在「Node 暂存 + build:harness」之后、打正式包之前用它；CI 的
 *     bundle-config job 不装依赖也不构建，checkout 里没有暂存目录，所以默认关闭。
 *
 * [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

const DESKTOP_CONF = "packaging/desktop.json"
const NODE_RUNTIME = "packaging/node-runtime.json"
const NPM_PACKAGE = "package.json"
const ROOT_CARGO = "Cargo.toml"
const VERSION_SET = "packaging/dist/version-set.json"

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NODE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/
/** 可打印 ASCII：productName 会进入产物文件名，超出这个范围的字符会被 GitHub 剥掉。 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/

/**
 * 发布闭包不得出现的路径段（测试 / trace 常驻资产的落点）。
 * 按「路径段相等」判断而不是子串包含，避免 latest、contest 这类合法名字被误伤。
 */
const FORBIDDEN_RESOURCE_SEGMENTS = new Set(["test", "tests", "traces", ".tmp"])

/** 读取 JSON 文件；缺失或坏 JSON 时记问题并返回 null。 */
function readJsonFile(rootDir, rel, problems) {
  const path = join(rootDir, rel)
  if (!existsSync(path)) {
    problems.push(`${rel} 不存在`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    problems.push(`${rel} 不是合法 JSON: ${error.message}`)
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * productName 纯可打印 ASCII 守卫。
 * v0.15.0 发布事故：中文 productName → 产物文件名带中文 → GitHub 上传时剥掉非 ASCII →
 * 发布侧的产物名匹配不上，更新清单被静默跳过：CI 全绿，用户永远收不到更新。
 * 换成 cargo-packager 后产物命名同样取自 productName，发布侧还要按这个文件名生成
 * update.json 的组件 URL（宿主 update 域校验 name 与制品一一对应），失配的后果不变。
 */
function checkProductName(conf, file, problems) {
  if (typeof conf.productName !== "string" || conf.productName.trim() === "") {
    problems.push(`${file} 的 productName 必须是非空字符串（产物按它命名）`)
    return
  }
  if (!PRINTABLE_ASCII.test(conf.productName.trim())) {
    problems.push(
      `${file} 的 productName ${JSON.stringify(conf.productName)} 含非 ASCII 字符：` +
      `产物按 productName 命名，非 ASCII 字符会进入产物文件名；` +
      `GitHub 上传时会剥掉它们，发布侧匹配不到自己的产物名，` +
      `就会静默跳过更新清单 update.json 的组件条目——` +
      `结果是 CI 全绿、用户永远收不到更新（v0.15.0 事故）。把 productName 改成纯 ASCII 名称；` +
      `窗口内标题来自界面资源，保持中文不受影响`,
    )
  }
}

function checkIdentifier(conf, file, problems) {
  if (typeof conf.identifier !== "string" || !IDENTIFIER.test(conf.identifier)) {
    problems.push(`${file} 的 identifier 必须是反向域名形式（如 com.v1rtual.deskpet），收到: ${JSON.stringify(conf.identifier)}`)
  }
}

/** 校验 version 字段本身是不是合法 semver；返回字符串或 null（不合法时已记问题）。 */
function checkVersionShape(conf, file, problems) {
  if (typeof conf.version !== "string" || !SEMVER.test(conf.version)) {
    problems.push(`${file} 的 version 必须是合法 semver，收到: ${JSON.stringify(conf.version)}`)
    return null
  }
  return conf.version
}

/**
 * 读取 package.json 的顶层 version。
 */
function readPackageVersion(rootDir, problems) {
  const parsed = readJsonFile(rootDir, NPM_PACKAGE, problems)
  if (parsed === null) return null
  return checkVersionShape(parsed, NPM_PACKAGE, problems)
}

/**
 * 行扫根 Cargo.toml 的 `[workspace.package]` 段，收集段内行首 version 行的值。
 * 段不存在返回 null；与 scripts/set-version.mjs 的 renderWorkspaceVersion 同一口径
 * （先定段边界、只在段内认「行首 version =」，不用「首个行首」兜底 —— 那不适用于
 * 分段结构的根文件，见原生宿主迁移过程记录 §9.4 第 33 条）。
 */
function scanWorkspacePackageSection(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  let inSection = false
  let sectionFound = false
  const versions = []
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) {
      inSection = header[1] === "workspace.package"
      if (inSection) sectionFound = true
      continue
    }
    if (inSection) {
      const match = /^version\s*=\s*"([^"]*)"\s*$/.exec(line)
      if (match) versions.push(match[1])
    }
  }
  return sectionFound ? versions : null
}

/** 读取应用版本的单一真相源：根 Cargo.toml `[workspace.package]` 段内的 version。 */
function readWorkspaceVersion(rootDir, problems) {
  const path = join(rootDir, ROOT_CARGO)
  if (!existsSync(path)) {
    problems.push(`${ROOT_CARGO} 不存在：无法确认应用版本的单一真相源`)
    return null
  }
  const versions = scanWorkspacePackageSection(readFileSync(path, "utf8"))
  if (versions === null) {
    problems.push(`${ROOT_CARGO} 里找不到 [workspace.package] 段（应用版本的单一真相源）`)
    return null
  }
  if (versions.length === 0) {
    problems.push(`${ROOT_CARGO} 的 [workspace.package] 段里找不到 version 行`)
    return null
  }
  if (versions.length > 1) {
    problems.push(`${ROOT_CARGO} 的 [workspace.package] 段里有多行 version（${versions.length} 行）`)
    return null
  }
  if (!SEMVER.test(versions[0])) {
    problems.push(`${ROOT_CARGO} 的 [workspace.package] version 不是合法 semver，收到: ${JSON.stringify(versions[0])}`)
    return null
  }
  return versions[0]
}

/**
 * cargo-packager 0.11.8 的 `binaries` 形状校验（schema: Binary = { path, main? }）。
 * `main: true` 必须恰好一个：`main_binary()` 找不到会直接报 MainBinaryNotFound 打包失败；
 * 多个则 `.find()` 取第一个，条目顺序一变主可执行文件就换人。
 */
function checkBinaries(conf, problems) {
  const binaries = conf.binaries
  if (!Array.isArray(binaries) || binaries.length === 0) {
    problems.push("binaries 必须是非空数组（cargo-packager 至少需要一个可执行文件）")
    return
  }
  let mainCount = 0
  for (const [index, bin] of binaries.entries()) {
    if (!isPlainObject(bin)) {
      problems.push(`binaries[${index}] 必须是 { path, main? } 对象（cargo-packager 不支持字符串简写）`)
      continue
    }
    if (typeof bin.path !== "string" || bin.path.trim() === "") {
      problems.push(`binaries[${index}].path 必须是非空字符串`)
    }
    if (bin.main !== undefined && typeof bin.main !== "boolean") {
      problems.push(`binaries[${index}].main 必须是布尔值，收到: ${JSON.stringify(bin.main)}`)
    }
    if (bin.main === true) mainCount += 1
  }
  if (mainCount !== 1) {
    problems.push(
      `binaries 里 main: true 的条目必须恰好一个（当前 ${mainCount} 个）：` +
      `cargo-packager 用它选主可执行文件，缺失会直接报 MainBinaryNotFound 打包失败，` +
      `多个则取第一个 —— 条目顺序一变主程序就换人`,
    )
  }
}

/** src 是否指向构建暂存（打包前才由暂存步骤产生；CI checkout 里必然不存在）。 */
function isStagingPath(src) {
  const normalized = src.replace(/\\/g, "/")
  return normalized === "dist" || normalized.startsWith("dist/") ||
    normalized === "../target" || normalized.startsWith("../target/")
}

/** 目录存在且为空。文件（readdirSync 抛 ENOTDIR）与非目录都返回 false。 */
function isEmptyDir(abs) {
  try {
    return readdirSync(abs).length === 0
  } catch {
    return false
  }
}

/**
 * resources 的形状与包树安检（cargo-packager 0.11.8 的 Resource：路径字符串或 { src, target }）。
 *
 * - 非暂存 src 必须存在：repo 内的资源被改名/移走时要在这里报，而不是打包时才炸；
 * - 暂存 src（`dist/`、`../target/`，都是 gitignore 的构建输出）默认不要求存在 ——
 *   CI 的 bundle-config job 不装依赖、不构建，checkout 里没有暂存目录，硬要求会把
 *   每一次 push 打红；requireStaging 打开时（打包 job / 本地打包前）才要求存在；
 * - 暂存目录存在但为空 = 包树少组件，属于必须提前拦下的静默故障，任何时候都报；
 * - 含 glob 的 src 无法静态判存在性，跳过（schema 明确支持 glob）；
 * - src / target 的任何路径段都不得命中测试 / trace 常驻资产（发布闭包不带 test/、traces/ 这类路径）。
 */
function checkResources(rootDir, conf, requireStaging, problems) {
  const resources = conf.resources
  if (resources === undefined || resources === null) return
  if (!Array.isArray(resources)) {
    problems.push("resources 必须是数组（路径字符串或 { src, target } 对象）")
    return
  }
  for (const [index, entry] of resources.entries()) {
    let src
    let target = null
    if (typeof entry === "string") {
      src = entry
    } else if (isPlainObject(entry) && typeof entry.src === "string") {
      src = entry.src
      if (typeof entry.target !== "string" || entry.target.trim() === "") {
        problems.push(`resources[${index}].target 必须是非空字符串`)
      } else {
        target = entry.target
      }
    } else {
      problems.push(`resources[${index}] 必须是路径字符串或 { src, target } 对象`)
      continue
    }
    if (typeof src !== "string" || src.trim() === "") {
      problems.push(`resources[${index}].src 必须是非空字符串`)
      continue
    }

    for (const [label, value] of [["src", src], ["target", target]]) {
      if (value === null) continue
      for (const segment of value.replace(/\\/g, "/").split("/").filter(Boolean)) {
        if (FORBIDDEN_RESOURCE_SEGMENTS.has(segment.toLowerCase())) {
          problems.push(
            `resources[${index}].${label} 指向 ${value}：发布闭包不得包含测试 / trace 常驻资产（命中路径段 ${segment}）`,
          )
        }
      }
    }

    if (/[*?[\]{}]/.test(src)) continue // glob：存在性只能等打包解析
    const abs = resolve(rootDir, "packaging", src)
    if (isStagingPath(src)) {
      if (existsSync(abs)) {
        if (isEmptyDir(abs)) {
          problems.push(`resources[${index}] 的暂存 src ${src} 是空目录：暂存步骤（build:harness / 取随包 Node）没产出内容，包树会缺组件`)
        }
      } else if (requireStaging) {
        problems.push(`resources[${index}] 的暂存 src ${src} 不存在：先跑暂存步骤（build:harness、取随包 Node 落 packaging/dist）再打包`)
      }
    } else if (!existsSync(abs)) {
      problems.push(`resources[${index}] 的 src 不存在（相对 packaging/ 解析）: ${src}`)
    }
  }
}

/** 收集 JSON 树里所有名为 key 的值（用于 verification.*.observedNodeVersion）。 */
function collectValues(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectValues(item, key, out)
  } else if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v)
      else collectValues(v, key, out)
    }
  }
  return out
}

/** a >= b，a/b 为 x.y.z 三段版本。 */
function semverGte(a, b) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return true
}

/**
 * packaging/node-runtime.json：随包 Node 的锁定与实测记录一致性。
 *
 * 这个文件被 crates/native-host 编译期嵌入（include_str!），监督器用它核对 Node
 * 自报版本 —— 锁定值与实测记录分叉，打包产物会在握手时被拒。只做静态一致性：
 * 不执行随包 Node（暂存在 CI checkout 里不存在）。
 */
function checkNodeRuntime(rootDir, problems) {
  const runtime = readJsonFile(rootDir, NODE_RUNTIME, problems)
  if (runtime === null) return null
  if (!isPlainObject(runtime)) {
    problems.push(`${NODE_RUNTIME} 的顶层必须是 JSON 对象`)
    return null
  }
  const nodeVersion = runtime.nodeVersion
  if (typeof nodeVersion !== "string" || !NODE_VERSION.test(nodeVersion)) {
    problems.push(`${NODE_RUNTIME} 的 nodeVersion 必须是 x.y.z 三段版本，收到: ${JSON.stringify(nodeVersion)}`)
    return runtime
  }
  if (runtime.nodeMajorLine !== Number(nodeVersion.split(".")[0])) {
    problems.push(
      `${NODE_RUNTIME} 的 nodeMajorLine ${JSON.stringify(runtime.nodeMajorLine)} 与 nodeVersion ${nodeVersion} 的主线号不一致`,
    )
  }
  const minimum = typeof runtime.minimumRequirement === "string" ? /^>=\s*(\d+\.\d+\.\d+)$/.exec(runtime.minimumRequirement) : null
  if (minimum === null) {
    problems.push(
      `${NODE_RUNTIME} 的 minimumRequirement 须为 ">=x.y.z" 形态（供静态核对），收到: ${JSON.stringify(runtime.minimumRequirement)}`,
    )
  } else if (!semverGte(nodeVersion, minimum[1])) {
    problems.push(
      `${NODE_RUNTIME} 锁定的 nodeVersion ${nodeVersion} 低于 minimumRequirement ${runtime.minimumRequirement}：随包 Node 不满足运行要求`,
    )
  }
  const observed = collectValues(runtime.verification, "observedNodeVersion")
  for (const value of observed) {
    if (value !== nodeVersion) {
      problems.push(
        `${NODE_RUNTIME} 的实测记录 observedNodeVersion ${JSON.stringify(value)} 与锁定 nodeVersion ${nodeVersion} 不一致：` +
        `锁定值被改过而没重验（按同目录 SHASUMS256.txt 校验哈希 + 实机跑一次后更新记录）`,
      )
    }
  }
  if (runtime.provisional !== false) {
    problems.push(
      `${NODE_RUNTIME}.provisional 不是 false：随包 Node 版本未定稿。完成发行包哈希校验与实机验证后置回 false 再打正式包`,
    )
  } else if (observed.length === 0) {
    problems.push(`${NODE_RUNTIME}.provisional 已是 false 但没有任何 observedNodeVersion 实测记录：先按 verification.method 验证再声明定稿`)
  }
  return runtime
}

/** 打包前暂存的版本集合必须与 Native/Node 两个版本投影一致。 */
function checkStagedVersionSet(rootDir, appVersion, nodeVersion, requireStaging, problems) {
  const path = join(rootDir, VERSION_SET)
  if (!existsSync(path)) {
    if (requireStaging) {
      problems.push(`${VERSION_SET} 不存在：先运行 .github/scripts/write-version-set.mjs，再打包`)
    }
    return
  }
  let bundle
  try {
    bundle = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    problems.push(`${VERSION_SET} 不是合法 JSON: ${error.message}`)
    return
  }
  if (!isPlainObject(bundle)) {
    problems.push(`${VERSION_SET} 顶层必须是对象`)
    return
  }
  if (bundle.app !== appVersion) {
    problems.push(`${VERSION_SET}.app ${JSON.stringify(bundle.app)} 与 ${DESKTOP_CONF}.version ${JSON.stringify(appVersion)} 不一致`)
  }
  if (typeof nodeVersion === "string" && bundle.node !== nodeVersion) {
    problems.push(`${VERSION_SET}.node ${JSON.stringify(bundle.node)} 与 ${NODE_RUNTIME}.nodeVersion ${JSON.stringify(nodeVersion)} 不一致`)
  }
  if (typeof bundle.harness !== "string" || !/^[a-f0-9]{64}$/.test(bundle.harness)) {
    problems.push(`${VERSION_SET}.harness 必须是 Harness bundle 的 SHA-256 小写十六进制值`)
  }
}

/**
 * 校验 rootDir 下的打包配置。
 * @param {string} rootDir 仓库根
 * @param {{ tag?: string | null, requireStaging?: boolean }} [options]
 *   tag 形如 `v0.15.0`：给了就要求三处 version 都与它一致。
 *   requireStaging 为 true 时要求 resources 的暂存 src 必须存在（打包 job / 本地打包前用）。
 *   默认 false —— CI 的 bundle-config job 不装依赖、不构建，checkout 里没有 gitignore 的
 *   暂存目录，默认硬要求会把每次 push 打红。
 * @returns {string[]} 问题清单，空数组 = 通过
 */
export function checkBundleConfig(rootDir, options = {}) {
  const requireStaging = options.requireStaging === true
  const problems = []

  const desktop = readJsonFile(rootDir, DESKTOP_CONF, problems)
  let desktopVersion = null
  if (desktop !== null && isPlainObject(desktop)) {
    checkProductName(desktop, DESKTOP_CONF, problems)
    checkIdentifier(desktop, DESKTOP_CONF, problems)
    desktopVersion = checkVersionShape(desktop, DESKTOP_CONF, problems)
    checkBinaries(desktop, problems)
    checkResources(rootDir, desktop, requireStaging, problems)
  } else if (desktop !== null) {
    problems.push(`${DESKTOP_CONF} 的顶层必须是 JSON 对象`)
  }

  const runtime = checkNodeRuntime(rootDir, problems)

  const packageVersion = readPackageVersion(rootDir, problems)
  const workspaceVersion = readWorkspaceVersion(rootDir, problems)

  // 版本一致性（契约 §8 的完成定义）：desktop.json 是打包实际消费的那份，作为对照基准；
  // 真相源（根 Cargo.toml 的 [workspace.package]）与投影（package.json）都要与它一致。
  // 手改任一处都要在这里被拦下。
  const versionSources = [
    { file: DESKTOP_CONF, version: desktopVersion },
    { file: NPM_PACKAGE, version: packageVersion },
    { file: ROOT_CARGO, version: workspaceVersion },
  ]
  const baseline = versionSources.find(entry => entry.version !== null)
  if (baseline !== undefined) {
    for (const { file, version } of versionSources) {
      if (file === baseline.file || version === null || version === baseline.version) continue
      problems.push(
        `${file} 的 version ${JSON.stringify(version)} 与 ${baseline.file} 的 version ${JSON.stringify(baseline.version)} 不一致：` +
        `先跑 pnpm run version:set ${baseline.version} 再打 tag`,
      )
    }
  }

  checkStagedVersionSet(rootDir, desktopVersion, runtime?.nodeVersion, requireStaging, problems)

  const tag = options.tag
  if (tag) {
    const tagVersion = String(tag).replace(/^v/, "")
    // 三处都要与 tag 一致，逐文件报出，不能只查某一处
    for (const { file, version } of versionSources) {
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
  // resolveTag 的契约不变（argv[2] 是第一个位置参数），这里先把 `--` 旗标滤掉，
  // 免得 `--require-staging` 被当成 tag。
  const args = process.argv.slice(2)
  const tag = resolveTag(process.env, process.argv.slice(0, 2).concat(args.filter(arg => !arg.startsWith("--"))))
  const requireStaging = args.includes("--require-staging")
  const problems = checkBundleConfig(REPO_ROOT, { tag, requireStaging })
  if (problems.length === 0) {
    console.log(`打包配置校验通过${tag ? `（tag ${tag}）` : ""}${requireStaging ? "（含暂存存在性）" : ""}`)
    return
  }
  console.error("打包配置校验失败：")
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
