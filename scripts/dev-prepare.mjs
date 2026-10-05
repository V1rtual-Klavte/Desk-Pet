#!/usr/bin/env node
/**
 * 开发资源暂存 —— `pnpm run dev:prepare`（`pnpm dev` 的前置步骤）。
 *
 * 目标：把工作区内的 dev 资源根摆成与打包闭包同形的三件套，供 debug 宿主按
 * `packaging/desktop.json` 的同名资源解析（node / harness / defaults）：
 *
 *   1) 随包 Node：`.github/scripts/stage-node.mjs` 按 packaging/node-runtime.json 的
 *      锁定版本暂存到 packaging/dist/node；已暂存且版本一致时跳过（不重复下载几十 MB）。
 *      stage-node 归发布流水线（release.yml 调用），本脚本只调用它、不搬它的落位。
 *   2) Harness 产物：`pnpm run build:harness`（命令定义单源在 package.json，产物落
 *      packaging/dist/harness/main.mjs）。
 *   3) defaults 可见化：在 dev 资源根建符号链接指回 `resources/defaults`（Windows 用
 *      目录 junction，不需要管理员权限/开发者模式）。用符号链接而不是复制：种子只有
 *      一个真相源，resources/defaults 的修改不会在 dev 资源根里留一份变旧的副本。
 *      打包路径不读 dist/defaults（packaging/desktop.json 的 resources 直接取
 *      ../resources/defaults），所以链接不影响产物。
 *
 * 落位单一真相源：dev 资源根只在 crates/native-host/src/main.rs 的 DEV_RESOURCE_SUBDIR
 * 定义一次，本脚本从该常量解析路径；其余写同一目录的命令定义（package.json 的
 * build:harness --outfile、.github/scripts/stage-node.mjs 的 DEST）在落地后逐项核验，
 * 对不上即报错并指名同步点。
 *
 * 幂等：可反复运行；只在暂存缺失（补建）与符号链接指错/悬空（重建）时改动内容。
 */

import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const MAIN_RS = join(REPO_ROOT, "crates", "native-host", "src", "main.rs")

function fail(message) {
  console.error(`dev:prepare: ${message}`)
  process.exit(1)
}

/** 运行子命令；非零退出即失败（错误正文由子命令自己输出）。 */
function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options })
  if (result.error) fail(`${label} 启动失败：${result.error.message}`)
  if (result.status !== 0) fail(`${label} 退出码 ${result.status}`)
}

/** dev 资源根：从 main.rs 的 DEV_RESOURCE_SUBDIR 派生（debug 资源解析的唯一真相源）。 */
function devResourceRoot() {
  const source = readFileSync(MAIN_RS, "utf8")
  const match = source.match(/const DEV_RESOURCE_SUBDIR: &str = "([^"]+)"/)
  if (match === null) fail(`在 ${MAIN_RS} 找不到 DEV_RESOURCE_SUBDIR 定义`)
  console.log(`dev:prepare: dev 资源根（DEV_RESOURCE_SUBDIR）= ${match[1]}`)
  return resolve(REPO_ROOT, match[1])
}

/** 暂存 Node 的可执行文件（与 main.rs 的 node_binary_path 同布局：macOS node/bin/node；Windows node/node.exe）。 */
function stagedNodeBinary(devRoot) {
  return process.platform === "win32"
    ? join(devRoot, "node", "node.exe")
    : join(devRoot, "node", "bin", "node")
}

/** 暂存 Node 自报版本（去 `v` 前缀）；缺失或跑不起来返回 null。 */
function stagedNodeVersion(binary) {
  if (!existsSync(binary)) return null
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" })
  if (result.error || result.status !== 0) return null
  return (result.stdout ?? "").trim().replace(/^v/, "")
}

function prepareNode(devRoot) {
  const runtime = JSON.parse(readFileSync(join(REPO_ROOT, "packaging", "node-runtime.json"), "utf8"))
  const locked = runtime.nodeVersion
  const binary = stagedNodeBinary(devRoot)
  if (stagedNodeVersion(binary) === locked) {
    console.log(`dev:prepare: 随包 Node v${locked} 已就绪，跳过暂存`)
    return
  }
  console.log(`dev:prepare: 暂存随包 Node（锁定版本 v${locked}，落 ${relative(REPO_ROOT, binary)}）`)
  run(process.execPath, [join(REPO_ROOT, ".github", "scripts", "stage-node.mjs")], "stage-node.mjs")
  const staged = stagedNodeVersion(binary)
  if (staged !== locked) {
    fail(
      `随包 Node 暂存后仍不落在 dev 资源根：期望 v${locked}，实测 ${staged ?? "缺失"}（${binary}）。\n` +
        "  dev 资源根由 crates/native-host/src/main.rs 的 DEV_RESOURCE_SUBDIR 决定；\n" +
        "  .github/scripts/stage-node.mjs 的 DEST 必须与它同指一处。",
    )
  }
  console.log(`dev:prepare: 随包 Node v${locked} 已就绪`)
}

function prepareHarness(devRoot) {
  // 命令定义单源在 package.json 的 build:harness；这里只触发并核验落位。
  console.log("dev:prepare: 构建 Harness 产物（pnpm run build:harness）")
  run("pnpm", ["run", "build:harness"], "pnpm run build:harness", {
    shell: process.platform === "win32",
  })
  const entry = join(devRoot, "harness", "main.mjs")
  if (!existsSync(entry)) {
    fail(
      `Harness 产物不在 dev 资源根：${entry}。\n` +
        "  package.json 的 build:harness --outfile 与 crates/native-host/src/main.rs 的\n" +
        "  DEV_RESOURCE_SUBDIR 必须同指一处（资源清单见 packaging/desktop.json）。",
    )
  }
  console.log(`dev:prepare: Harness 产物已就绪（${relative(REPO_ROOT, entry)}）`)
}

/** 符号链接是否已指向 source；悬空链接（existsSync 追随失败）返回 false。 */
function pointsAt(link, source) {
  return existsSync(link) && realpathSync(link) === realpathSync(source)
}

function prepareDefaults(devRoot) {
  const source = join(REPO_ROOT, "resources", "defaults")
  if (!existsSync(source)) fail(`随包种子目录不存在：${source}`)
  const link = join(devRoot, "defaults")
  // readdir 能列出悬空链接（existsSync 不能），据它判断条目是否已存在。
  const entries = existsSync(devRoot) ? readdirSync(devRoot) : []
  const present = entries.includes("defaults")
  if (present && !lstatSync(link).isSymbolicLink()) {
    fail(
      `${link} 已存在且不是符号链接；dev:prepare 只管理符号链接，不删除该目录。\n` +
        "  若是早前复制式预演的残留，手动移除后重跑 pnpm run dev:prepare。",
    )
  }
  if (present && pointsAt(link, source)) {
    console.log("dev:prepare: defaults 符号链接已存在且指向正确")
    return
  }
  if (present) rmSync(link, { force: true })
  if (process.platform === "win32") {
    // 目录 junction：目标须绝对路径；不需要管理员权限或开发者模式。
    symlinkSync(source, link, "junction")
  } else {
    // 相对目标：仓库整体移动后链接仍可用。
    symlinkSync(relative(dirname(link), source), link, "dir")
  }
  console.log("dev:prepare: defaults 符号链接已创建 → resources/defaults")
}

function main() {
  const devRoot = devResourceRoot()
  mkdirSync(devRoot, { recursive: true })
  prepareNode(devRoot)
  prepareHarness(devRoot)
  prepareDefaults(devRoot)
  console.log("dev:prepare: 完成（pnpm dev 将构建并启动 target/debug/native-host）")
}

main()
