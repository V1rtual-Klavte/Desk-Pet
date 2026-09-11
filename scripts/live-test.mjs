import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const valueOptions = new Set(["--module", "--scene", "--case", "--tag", "--suite", "--repeat", "--report"])
const flagOptions = new Set(["--strict"])
const env = { ...process.env, DESKPET_LIVE_TEST: "1" }

function sha256(parts) {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}

function currentCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim() }
  catch { return "unknown" }
}

function checkContractHashes() {
  const directory = join(process.cwd(), "src/services/__tests__/live/contracts")
  for (const file of readdirSync(directory).filter(name => name.endsWith(".contract.ts"))) {
    const content = readFileSync(join(directory, file), "utf8")
    const hashMatch = content.match(/sourceHash:\s*"([0-9a-f]*)"/)
    const filesMatch = content.match(/sourceFiles:\s*\[([\s\S]*?)\]/)
    const files = [...(filesMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1])
    const actual = sha256([...files].sort().map(source => readFileSync(join(process.cwd(), source), "utf8")))
    const expected = hashMatch?.[1] ?? ""
    if (!expected || expected !== actual) {
      throw new Error(`[STALE] ${file}: sourceHash=${expected || "<empty>"}, current=${actual}; 请重新运行 /analyze test`)
    }
  }
}

try { checkContractHashes() } catch (error) {
  console.error(`[LiveTest] Contract 校验失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

for (let index = 0; index < args.length; index++) {
  const option = args[index]
  if (flagOptions.has(option)) {
    env[`DESKPET_LIVE_TEST_${option.slice(2).toUpperCase()}`] = "1"
    continue
  }
  if (!valueOptions.has(option) || !args[index + 1]) continue
  env[`DESKPET_LIVE_TEST_${option.slice(2).toUpperCase().replace(/-/g, "_")}`] = args[++index]
}

const dataRoot = mkdtempSync(join(homedir(), ".deskpet-live-test-"))
const resultPath = join(dataRoot, "live-test-result.txt")
env.DESKPET_LIVE_TEST_DATA_ROOT = dataRoot
env.DESKPET_LIVE_TEST_COMMIT = currentCommit()

let child
let finalized = false
let timeout

function stopChild(signal = "SIGTERM") {
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal)
}

function finalize(exitCode, reason) {
  if (finalized) return
  finalized = true
  if (timeout) clearTimeout(timeout)
  if (reason) console.error(`[LiveTest] ${reason}`)
  rmSync(dataRoot, { recursive: true, force: true })
  process.exit(exitCode)
}

process.once("SIGINT", () => { stopChild("SIGTERM"); finalize(130, "收到 SIGINT，已清理隔离数据目录") })
process.once("SIGTERM", () => { stopChild("SIGTERM"); finalize(143, "收到 SIGTERM，已清理隔离数据目录") })

child = spawn("pnpm", ["exec", "tauri", "dev", "--no-watch"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
})
timeout = setTimeout(() => {
  stopChild("SIGTERM")
  finalize(1, "超过 10 分钟未结束，终止测试进程")
}, 10 * 60 * 1000)

child.on("error", error => finalize(1, `无法启动 Tauri: ${error.message}`))
child.on("exit", (code, signal) => {
  const passed = existsSync(resultPath) && readFileSync(resultPath, "utf8").startsWith("PASS\n")
  if (!passed && !finalized) {
    const suffix = existsSync(resultPath) ? "测试报告标记为失败" : `测试进程未生成结果文件 (exit=${code}, signal=${signal ?? "none"})`
    finalize(1, suffix)
    return
  }
  finalize(0)
})
