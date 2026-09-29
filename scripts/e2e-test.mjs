// E2E 启动脚本（Node 侧，负责构建、起 WebView、汇总报告）。
// 开发工具直接用 console：改走 logger 会污染 data_root/logs/deskpet.log
// 并引入 IPC 依赖 [保留已登记 §4.2]

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { extname, join, relative } from "node:path"

const args = process.argv.slice(2)
const valueOptions = new Set(["--module", "--scene", "--case", "--tag", "--suite", "--repeat", "--report", "--contracts"])
const flagOptions = new Set(["--strict"])
const env = { ...process.env, DESKPET_E2E: "1" }

function sha256(parts) {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}

function currentCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim() }
  catch (error) {
    // 开发工具不接 logger（会污染 data_root/logs/deskpet.log 并引入 IPC 依赖）
    console.warn("[e2e] git rev-parse HEAD 失败，报告里的 commit 记为 unknown：", error instanceof Error ? error.message : String(error))
    return "unknown"
  }
}

// 参数要先解析：下面的 Contract 门禁需要知道自己是不是单模块运行
for (let index = 0; index < args.length; index++) {
  const option = args[index]
  if (flagOptions.has(option)) {
    env[`DESKPET_E2E_${option.slice(2).toUpperCase()}`] = "1"
    continue
  }
  if (!valueOptions.has(option) || !args[index + 1]) continue
  env[`DESKPET_E2E_${option.slice(2).toUpperCase().replace(/-/g, "_")}`] = args[++index]
}

/**
 * `--contracts=selected` 只校验 `--module` 选中的那一份 Contract。
 *
 * 默认仍是全量校验：「改了源码忘了刷 hash」正是这条门禁要挡的事。
 * 但单模块调试时会反复被别的模块的过期 hash 拦住（本轮就撞过一次），
 * 所以留一个显式开关，而不是把门禁默认放松。
 */
function selectedContractFile() {
  if ((env.DESKPET_E2E_CONTRACTS ?? "all") !== "selected") return null
  const module = env.DESKPET_E2E_MODULE
  if (!module) return null
  return `${module}.contract.ts`
}

/**
 * Contract 预检：逐份重算 sourceFiles 的 hash 并和声明的 sourceHash 比对。
 *
 * 通过时返回「模块 → 预检 hash」的证明：浏览器读不到源码，只能核对这份证明
 * （contract-checker.ts）。没有证明或与契约声明不一致，浏览器侧判为 stale，
 * 所以绕过本脚本直接跑 Tauri 不会得到一份看起来通过的报告。
 */
function checkContractHashes() {
  const directory = join(process.cwd(), "test/contracts")
  const only = selectedContractFile()
  const targets = readdirSync(directory).filter(name => name.endsWith(".contract.ts") && (!only || name === only))
  if (only && targets.length === 0) {
    throw new Error(`[STALE] 找不到 ${only}，--module 与 --contracts=selected 对不上`)
  }
  const attestation = {}
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
    // 键取契约里声明的 module，与浏览器侧 collectContracts 的键一致。
    // 取不到就退回文件名：浏览器找不到证明会判 stale，而不是误判为通过。
    const moduleName = content.match(/^\s*module:\s*"([^"]+)"/m)?.[1] ?? file.replace(/\.contract\.ts$/, "")
    attestation[moduleName] = actual
  }
  return attestation
}

let hashAttestation
try {
  hashAttestation = checkContractHashes()
} catch (error) {
  console.error(`[E2E] Contract 校验失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
env.DESKPET_E2E_SOURCE_HASHES = JSON.stringify(hashAttestation)

// ── 种子与配置摘要（报告 environment.seedHash）──

/** 随包种子的来源目录；运行时资源由 Rust 首次初始化时从这里拷贝。 */
const SEED_DIR = "src-tauri/resources/defaults"
/**
 * 只有文本种子参与摘要。png/ttf 素材不影响 Live 断言（也不进 Prompt），
 * 而体积是文本种子的几千倍 —— 摘要要能对比两次运行，不是完整备份校验和。
 */
const SEED_TEXT_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".json", ".txt"])
/** 开发构建按此顺序取第一个存在的配置（与 paths.rs 的 config_file 选择一致）。 */
const CONFIG_FILES = ["CONFIG-DEV.yaml", "CONFIG.yaml"]
/**
 * 凭据键名。命中即把值替换为 <redacted>，摘要因此能区分模型、参数与种子的变化，
 * 却不包含、也不能反推 apiKey 之类的凭据（本地 CONFIG-DEV.yaml 常带真实 key）。
 */
const CREDENTIAL_KEY = /(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|authorization|credential|private[_-]?key|bearer)/i

function collectFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectFiles(full, out)
    else out.push(full)
  }
  return out
}

function redactCredentials(text) {
  return text.split("\n").map(line => {
    const assignment = line.match(/^(\s*(?:-\s*)?["']?[\w.-]+["']?\s*:\s*)(\S.*)$/)
    if (assignment && CREDENTIAL_KEY.test(assignment[1])) return `${assignment[1]}"<redacted>"`
    return line.replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s"']+/gi, "$1<redacted>")
  }).join("\n")
}

function hashSeedFile(file) {
  const content = readFileSync(file)
  // 文本按脱敏后的内容算；万一混入二进制，按原始字节算（不做字符串替换）
  const payload = content.includes(0) ? content : Buffer.from(redactCredentials(content.toString("utf8")), "utf8")
  return sha256([payload])
}

/**
 * 种子与配置摘要。覆盖本次运行真正读到的输入：
 * 文本形式的 Card / Profile / Skill 种子，加上开发构建实际加载的那份 CONFIG。
 * 缺文件只报警，不阻断运行 —— 摘要缺失会如实表现为报告里的 seedHash 为空。
 */
function computeSeedHash() {
  const parts = []
  for (const file of collectFiles(join(process.cwd(), SEED_DIR))) {
    if (!SEED_TEXT_EXTENSIONS.has(extname(file))) continue
    parts.push(`${relative(process.cwd(), file)}\0${hashSeedFile(file)}`)
  }
  for (const name of CONFIG_FILES) {
    const file = join(process.cwd(), name)
    if (existsSync(file)) {
      parts.push(`${name}\0${hashSeedFile(file)}`)
      break
    }
  }
  if (parts.length === 0) {
    console.error(`[E2E] seedHash 未生成：${SEED_DIR} 与 ${CONFIG_FILES.join(" / ")} 都不存在`)
    return undefined
  }
  return sha256(parts.sort())
}

const seedHash = computeSeedHash()
if (seedHash) env.DESKPET_E2E_SEED_HASH = seedHash

/**
 * 临时数据根落在 `test/.tmp/` 下，**不放仓库外**。
 *
 * 契约规定「测试只有一个根目录 `test/`：不把任何一层的产物放到仓库外」—— 临时数据根
 * 也是这一层的产物（它承载整个 data_root：sessions/ logs/ personality/ …）。
 * 放在仓库内还有个实际好处：跑挂了（被 kill、被窗口挂起）留下的残留在 `git status`
 * 与目录里看得见，不会像以前那样默默堆在家目录 —— 2026-09-29 实测：窗口最小化冻住后
 * 杀进程，`~/.deskpet-e2e-nGiEOq` 就留在那儿没人知道。
 */
const TEMP_ROOT_DIR = join(process.cwd(), "test", ".tmp")
mkdirSync(TEMP_ROOT_DIR, { recursive: true })
/**
 * L4 不能并行跑（占同一个 Vite/Tauri 端口），所以启动时已存在的 `e2e-*` 一律是上次的残留。
 * 直接清掉：异常退出（SIGKILL、进程被挂起后杀掉）不会执行 finally，靠正常路径清理不住。
 */
function pruneStaleTempRoots() {
  for (const name of readdirSync(TEMP_ROOT_DIR)) {
    if (name.startsWith("e2e-")) rmSync(join(TEMP_ROOT_DIR, name), { recursive: true, force: true })
  }
}
pruneStaleTempRoots()

const dataRoot = mkdtempSync(join(TEMP_ROOT_DIR, "e2e-"))
const resultPath = join(dataRoot, "e2e-result.txt")
env.DESKPET_E2E_DATA_ROOT = dataRoot
env.DESKPET_E2E_COMMIT = currentCommit()

let child
let finalized = false
let timeout

function stopChild(signal = "SIGTERM") {
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal)
}

/**
 * 报告原先只写在一次性临时数据根里，随根一起删掉：CI 拿不到产物，
 * 也没法 diff 两次运行。清理之前先复制到仓库内的稳定目录（已在 .gitignore 忽略）。
 */
const REPORTS_DIR = join(process.cwd(), "test", "reports")
/**
 * 保留策略按体积而不是份数：单份报告可达 11 MB，只按份数上限不封顶磁盘占用。
 * 按 mtime 从新到旧累加，超过上限即淘汰更旧的。
 */
const REPORTS_MAX_BYTES = 200 * 1024 * 1024

/**
 * 目标扩展名按 --report 声明的格式显式决定，不做内容嗅探。
 * WebView 侧经 `e2e_complete` 落盘的载荷固定是 `e2e-result.txt`，
 * 若按它推断，`--report html` 会被存成 `.txt`，双击进编辑器而不是浏览器。
 */
const REPORT_EXTENSIONS = { json: "json", html: "html" }

function pruneReportsBySize() {
  const entries = readdirSync(REPORTS_DIR)
    .filter(name => /\.(json|txt|html)$/.test(name))
    .map(name => {
      const stats = statSync(join(REPORTS_DIR, name))
      return { name, size: stats.size, mtimeMs: stats.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  let totalBytes = 0
  for (const [index, entry] of entries.entries()) {
    totalBytes += entry.size
    // 最新一份始终保留：哪怕它单独就超过上限，也不能删掉刚跑出来的报告
    if (index > 0 && totalBytes > REPORTS_MAX_BYTES) {
      rmSync(join(REPORTS_DIR, entry.name), { force: true })
    }
  }
}

function preserveReport() {
  if (!existsSync(resultPath)) return
  try {
    mkdirSync(REPORTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const extension = REPORT_EXTENSIONS[env.DESKPET_E2E_REPORT] ?? "txt"
    copyFileSync(resultPath, join(REPORTS_DIR, `${stamp}.${extension}`))
    pruneReportsBySize()
    console.error(`[E2E] 报告已留存: ${REPORTS_DIR}`)
  } catch (error) {
    // 留存失败不该影响测试结论本身
    console.error(`[E2E] 报告留存失败: ${error.message}`)
  }
}

function finalize(exitCode, reason) {
  if (finalized) return
  finalized = true
  if (timeout) clearTimeout(timeout)
  if (reason) console.error(`[E2E] ${reason}`)
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
