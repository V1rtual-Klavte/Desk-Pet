#!/usr/bin/env node
/**
 * 随包 Node 暂存 —— 只被 .github/workflows/release.yml 调用（CI 的 bundle-config job
 * 不装依赖、不构建，也不暂存；resources 的暂存存在性由 check:bundle --require-staging 守）。
 *
 * 流程：按 packaging/node-runtime.json 的锁定版本从 nodejs.org/dist 取平台发行包 →
 * 用同目录 SHASUMS256.txt 校验 SHA-256 → 按发行闭包 prune → 落 packaging/dist/node
 * （packaging/desktop.json 的 resources 暂存 src）。
 *
 * 闭包口径（node-runtime.json 的 distribution.closure）：保留 bin/node、npm/npx
 * 与 lib/node_modules 下的 CLI 实现、LICENSE；排除 include/（C 头文件）、share/（man 等）、
 * npm 自带 docs/man 与 corepack（无消费者，2026-10-06 裁撤）。
 * 注意 cargo-packager 复制资源时会把 bin/npm|npx 符号链接**展开**成普通副本、
 * 相对 require 失效 —— 调用要走 `node lib/node_modules/npm/bin/npm-cli.js`（W4 按此解析），
 * release.yml 另在打包后的 .app 里恢复这两条符号链接。
 *
 * 平台映射：darwin→darwin/arm64|x64（.tar.gz），Windows→win/x64（.zip，node.exe 在根部）。
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const DEST = join(REPO_ROOT, "packaging", "dist", "node")

function fail(message) {
  console.error(`stage-node: ${message}`)
  process.exit(1)
}

function targetOf() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return { platform: "darwin", arch: "arm64", ext: "tar.gz" }
    if (process.arch === "x64") return { platform: "darwin", arch: "x64", ext: "tar.gz" }
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { platform: "win", arch: "x64", ext: "zip" }
  }
  return fail(`不支持的平台/架构：${process.platform}/${process.arch}`)
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function runRuntime(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true })
  if (result.error || result.status !== 0) {
    fail(`${label} 执行失败：${result.error?.message ?? `退出码 ${result.status}`}`)
  }
  return (result.stdout ?? "").trim()
}

/** 在每个原生 runner 上核实解包后的二进制与 CLI，不能只凭归档文件名推断 ABI。 */
function verifyRuntime(root, runtime) {
  const binary = process.platform === "win32" ? join(root, "node.exe") : join(root, "bin", "node")
  const observedVersion = runRuntime(binary, ["--version"], "随包 Node --version").replace(/^v/, "")
  if (observedVersion !== runtime.nodeVersion) {
    fail(`随包 Node 自报版本 ${observedVersion} 与锁定版本 ${runtime.nodeVersion} 不一致`)
  }

  const abi = runRuntime(binary, ["-p", "process.versions.modules"], "读取 NODE_MODULE_VERSION")
  if (abi !== String(runtime.modulesAbi)) {
    fail(`随包 Node 的 NODE_MODULE_VERSION=${abi} 与 node-runtime.json 锁定值 ${runtime.modulesAbi} 不一致`)
  }
  const napi = runRuntime(binary, ["-p", "process.versions.napi"], "读取 N-API 版本")
  if (!/^\d+$/.test(napi) || Number(napi) < 1) fail(`随包 Node 返回无效 N-API 版本：${JSON.stringify(napi)}`)

  const npmCli = [join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(root, "node_modules", "npm", "bin", "npm-cli.js")]
    .find(existsSync)
  const npxCli = [join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"), join(root, "node_modules", "npm", "bin", "npx-cli.js")]
    .find(existsSync)
  if (!npmCli || !npxCli) fail("随包 Node 发行闭包缺少 npm-cli.js 或 npx-cli.js")
  for (const [label, cli] of [["npm", npmCli], ["npx", npxCli]]) {
    const version = runRuntime(binary, [cli, "--version"], `随包 ${label} CLI`)
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`随包 ${label} CLI 返回无效版本：${JSON.stringify(version)}`)
  }
  console.log(`stage-node: runtime verified node=${observedVersion} modules=${abi} napi=${napi}`)
}

function extract(archive, ext, destDir) {
  let result
  if (ext === "tar.gz") {
    result = spawnSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "inherit" })
  } else {
    // Windows zip：用系统 PowerShell（Git Bash 自带的 GNU tar 解不了 zip；7-Zip 在新镜像上不再保证存在）
    result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${destDir}'`],
      { stdio: "inherit" },
    )
  }
  if (result.error) fail(`解包失败：${result.error.message}`)
  if (result.status !== 0) fail(`解包退出码 ${result.status}`)
}

async function main() {
  const runtime = JSON.parse(readFileSync(join(REPO_ROOT, "packaging", "node-runtime.json"), "utf8"))
  const version = runtime.nodeVersion
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`node-runtime.json 的 nodeVersion 非法: ${JSON.stringify(version)}`)
  }
  const { platform, arch, ext } = targetOf()
  const artifact = `node-v${version}-${platform}-${arch}.${ext}`
  const base = `https://nodejs.org/dist/v${version}`

  console.log(`stage-node: 取 ${artifact}`)
  const sums = await fetch(`${base}/SHASUMS256.txt`)
  if (!sums.ok) fail(`SHASUMS256.txt 拉取失败: HTTP ${sums.status}`)
  const entry = (await sums.text())
    .split("\n")
    .map(line => line.trim().split(/\s+/))
    .find(parts => parts[1] === artifact)
  if (entry === undefined) fail(`SHASUMS256.txt 里找不到 ${artifact}`)
  const expected = entry[0].toLowerCase()

  // 归档放稳定路径（`packaging/.cache`，已 gitignore）：CI 按 node-runtime.json 的指纹
  // 缓存它，命中就不再下载 —— Windows runner 上拉这 ~50MB 要一分钟上下。
  // **复用是安全的**：不论来自缓存还是刚下载，下面都对着 SHASUMS256.txt 重算 SHA-256，
  // 不符即重新下载、仍不符才失败（缓存残缺/上游重发都会走这条）。
  const archiveDir = join(REPO_ROOT, "packaging", ".cache")
  const archive = join(archiveDir, artifact)

  const work = mkdtempSync(join(tmpdir(), "deskpet-node-"))
  let actual
  try {
    actual = existsSync(archive) ? sha256File(archive) : null
    if (actual === expected) {
      console.log(`stage-node: 复用归档缓存 ${archive}`)
    } else {
      if (actual !== null) console.log(`stage-node: 归档缓存校验不符（实测 ${actual}），重新下载`)
      const coverage = await fetch(`${base}/${artifact}`)
      if (!coverage.ok) fail(`${artifact} 拉取失败: HTTP ${coverage.status}`)
      if (coverage.body === null) fail(`${artifact} 响应没有 body`)
      mkdirSync(archiveDir, { recursive: true })
      writeFileSync(archive, Buffer.from(await coverage.arrayBuffer()))
      actual = sha256File(archive)
    }
    if (actual !== expected) fail(`SHA-256 不符：SHASUMS256.txt 声明 ${expected}，实测 ${actual}`)
    // darwin-arm64 另有实测记录（node-runtime.json），两处对不上说明上游重发过或记录漂移
    const recorded = runtime.verification?.darwinArm64?.sha256
    if (platform === "darwin" && arch === "arm64" && recorded && recorded !== actual) {
      fail(`darwin-arm64 实测记录 sha256 ${recorded} 与本次下载 ${actual} 不一致`)
    }

    extract(archive, ext, work)

    const extracted = join(work, `node-v${version}-${platform}-${arch}`)
    if (!existsSync(extracted)) fail(`解包后找不到 ${extracted}`)
    // node.exe 在 Windows zip 根部、unix 在 bin/；两者都要能判出可执行文件存在
    if (!existsSync(join(extracted, "bin", "node")) && !existsSync(join(extracted, "node.exe"))) {
      fail("解包结果里找不到 node 可执行文件")
    }

    verifyRuntime(extracted, runtime)

    rmSync(DEST, { recursive: true, force: true })
    cpSync(extracted, DEST, { recursive: true, verbatimSymlinks: true })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  // prune：闭包排除项（存在才删；Windows zip 布局不同，逐路径 force 删）
  rmSync(join(DEST, "include"), { recursive: true, force: true })
  rmSync(join(DEST, "share"), { recursive: true, force: true })
  // npm 自带 docs/man（纯文档）与 corepack（yarn/pnpm 的包管理器，本产品无消费者：
  // MCP stdio server 只经 node + npm/npx CLI 调用），2026-10-06 起一并裁掉。
  for (const npmDir of [join(DEST, "lib", "node_modules", "npm"), join(DEST, "node_modules", "npm")]) {
    rmSync(join(npmDir, "docs"), { recursive: true, force: true })
    rmSync(join(npmDir, "man"), { recursive: true, force: true })
  }
  for (const corepackPath of [
    join(DEST, "bin", "corepack"),
    join(DEST, "lib", "node_modules", "corepack"),
    join(DEST, "node_modules", "corepack"),
  ]) {
    rmSync(corepackPath, { recursive: true, force: true })
  }

  const npmCli = [join(DEST, "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(DEST, "node_modules", "npm", "bin", "npm-cli.js")]
    .find(existsSync)
  if (!npmCli) {
    fail("暂存结果里找不到 npm（发行闭包缺组件）")
  }
  // 裁剪后实测一次 npm CLI（不只看目录存在）：docs/man/corepack 的删除不得破坏运行。
  const stagedNode = process.platform === "win32" ? join(DEST, "node.exe") : join(DEST, "bin", "node")
  const npmVersion = runRuntime(stagedNode, [npmCli, "--version"], "裁剪后随包 npm CLI")
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) fail(`裁剪后随包 npm CLI 返回无效版本：${JSON.stringify(npmVersion)}`)
  console.log(`stage-node: ${artifact}（sha256 ${actual}）已落 packaging/dist/node；裁剪后 npm ${npmVersion}`)
}

await main()
