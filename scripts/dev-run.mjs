#!/usr/bin/env node
/**
 * 构建并启动 debug 原生宿主 —— `pnpm dev` 的第二步（第一步是 `dev:prepare`）。
 *
 * 职责边界：宿主自己经 crates/native-host/src/main.rs 的 DEV_RESOURCE_SUBDIR 解析
 * dev 资源根，本脚本只做「cargo build → 运行 target/debug/native-host」；平台差异
 * （.exe 后缀、信号退出码）只在这一处收口，package.json 里不写平台分支。
 *
 * 追加参数原样转交宿主（如 `pnpm dev -- --smoke`）；退出码透传，信号终止按
 * 128+signal 惯例换算，方便脚本化调用。
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const BINARY = join(
  REPO_ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "native-host.exe" : "native-host",
)
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

function fail(message) {
  console.error(`dev: ${message}`)
  process.exit(1)
}

const build = spawnSync("cargo", ["build", "-p", "native-host", "--bin", "native-host"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
})
if (build.error) fail(`cargo 启动失败：${build.error.message}`)
if (build.status !== 0) fail(`cargo build 失败（退出码 ${build.status}）`)
if (!existsSync(BINARY)) fail(`cargo build 成功但找不到产物：${BINARY}`)

const extraArgs = process.argv.slice(2)
console.log(`dev: 启动原生宿主（debug）：${BINARY}${extraArgs.length > 0 ? ` ${extraArgs.join(" ")}` : ""}`)
console.log("dev: Ctrl-C 结束运行")

const child = spawn(BINARY, extraArgs, { cwd: REPO_ROOT, stdio: "inherit" })
child.on("error", error => fail(`启动失败：${error.message}`))
child.on("exit", (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : (SIGNAL_EXIT_CODES[signal] ?? 1))
})
