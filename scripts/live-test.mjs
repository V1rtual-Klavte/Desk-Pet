import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const valueOptions = new Set(["--module", "--scene", "--case", "--tag", "--suite", "--repeat", "--report", "--contracts"])
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

// 参数要先解析：下面的 Contract 门禁需要知道自己是不是单模块运行
for (let index = 0; index < args.length; index++) {
  const option = args[index]
  if (flagOptions.has(option)) {
    env[`DESKPET_LIVE_TEST_${option.slice(2).toUpperCase()}`] = "1"
    continue
  }
  if (!valueOptions.has(option) || !args[index + 1]) continue
  env[`DESKPET_LIVE_TEST_${option.slice(2).toUpperCase().replace(/-/g, "_")}`] = args[++index]
}

/**
 * `--contracts=selected` 只校验 `--module` 选中的那一份 Contract。
 *
 * 默认仍是全量校验：「改了源码忘了刷 hash」正是这条门禁要挡的事。
 * 但单模块调试时会反复被别的模块的过期 hash 拦住（本轮就撞过一次），
 * 所以留一个显式开关，而不是把门禁默认放松。
 */
function selectedContractFile() {
  if ((env.DESKPET_LIVE_TEST_CONTRACTS ?? "all") !== "selected") return null
  const module = env.DESKPET_LIVE_TEST_MODULE
  if (!module) return null
  return `${module}.contract.ts`
}

function checkContractHashes() {
  const directory = join(process.cwd(), "src/services/__tests__/live/contracts")
  const only = selectedContractFile()
  const targets = readdirSync(directory).filter(name => name.endsWith(".contract.ts") && (!only || name === only))
  if (only && targets.length === 0) {
    throw new Error(`[STALE] 找不到 ${only}，--module 与 --contracts=selected 对不上`)
  }
  for (const file of targets) {
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

/**
 * 报告原先只写在一次性临时数据根里，随根一起删掉：CI 拿不到产物，
 * 也没法 diff 两次运行。清理之前先复制到稳定目录。
 *
 * 放用户主目录而不是仓库内：仓库侧要为此改 .gitignore，而报告是运行产物，
 * 不该出现在工作树里。保留最近 MAX_REPORTS 份，避免无限堆积。
 */
const REPORTS_DIR = join(homedir(), ".deskpet-live-test-reports")
const MAX_REPORTS = 20

function preserveReport() {
  if (!existsSync(resultPath)) return
  try {
    mkdirSync(REPORTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const extension = /\.json$/.test(resultPath) ? "json" : "txt"
    copyFileSync(resultPath, join(REPORTS_DIR, `${stamp}.${extension}`))
    const kept = readdirSync(REPORTS_DIR).filter(name => /\.(json|txt)$/.test(name)).sort()
    for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_REPORTS))) {
      rmSync(join(REPORTS_DIR, stale), { force: true })
    }
    console.error(`[LiveTest] 报告已留存: ${REPORTS_DIR}`)
  } catch (error) {
    // 留存失败不该影响测试结论本身
    console.error(`[LiveTest] 报告留存失败: ${error.message}`)
  }
}

function finalize(exitCode, reason) {
  if (finalized) return
  finalized = true
  if (timeout) clearTimeout(timeout)
  if (reason) console.error(`[LiveTest] ${reason}`)
  preserveReport()
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
