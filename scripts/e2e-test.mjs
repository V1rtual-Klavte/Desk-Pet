// E2E 启动脚本（Node 侧，负责构建、起 WebView、汇总报告）。
// 开发工具直接用 console：改走 logger 会污染 data_root/logs/deskpet.log
// 并引入 IPC 依赖 [保留已登记 §4.2]

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { extname, join, relative } from "node:path"
import { inspectTraceEvidence, retainTraceBundle, salvageTempTrace } from "./trace-evidence.mjs"
import { pruneReportArtifacts } from "./report-retention.mjs"
import { compareCaseIdLayers, extractContractCaseIds, formatCaseIdLayerIssues } from "./contract-layers.mjs"

const REPORTS_DIR = join(process.cwd(), "test", "reports")
const TRACES_DIR = join(REPORTS_DIR, "traces")

const args = process.argv.slice(2).filter(arg => arg !== "--")
// 这两份选项清单必须与 test/e2e/cli.ts 的 parseArgs 同步：漏一个 valueOption，
// 参数会被这里吞掉、浏览器侧收不到；漏一个 flagOption，模式不会进环境变量。
// 两边各有一行互指注释；不做机制化共享（cli.ts 是浏览器侧模块，本文件顶层有副作用、
// 不能被 import，重复清单是现状里代价最低的同步点）。
const valueOptions = new Set(["--module", "--scene", "--case", "--tag", "--suite", "--repeat", "--report", "--contracts", "--quality-seed", "--trace",
  "--bench-dataset", "--bench-split", "--bench-limit", "--bench-case", "--bench-seed", "--bench-judge", "--bench-judge-model"])
const flagOptions = new Set(["--strict", "--quality", "--performance", "--bench"])
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
 * 残留根的「有主」判据：根里的 `.pid`（数据根创建后立即写入 process.pid）对应的进程
 * 还活着。`process.kill(pid, 0)` 成功或 EPERM（进程存在但不可信号）都算存活，
 * 与 scripts/memory-performance.mjs 的 pruneStalePerfRoots 同一判定。
 * 没有 .pid（旧残留）或进程已死 → 无主，按残留处理。
 */
function liveOwnerPid(root) {
  const pidFile = join(root, ".pid")
  if (!existsSync(pidFile)) return undefined
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    return error.code === "EPERM" ? pid : undefined
  }
}

/**
 * L4 不能并行跑（占同一个 Vite/Tauri 端口），启动时已存在的 `e2e-*` 按有无存活主人分开处理：
 * 无主的是上次异常退出的残留（SIGKILL、进程被挂起后杀掉不会执行 finally，靠正常路径清理不住），
 * 抢救未结束场景后删除；有主的说明另一个 E2E 正在跑 —— 它的根绝不能当残留删掉，
 * 直接拒绝启动并指名 pid 与根名。
 */
function pruneStaleTempRoots() {
  for (const name of readdirSync(TEMP_ROOT_DIR)) {
    if (!name.startsWith("e2e-")) continue
    const stale = join(TEMP_ROOT_DIR, name)
    const owner = liveOwnerPid(stale)
    if (owner !== undefined) {
      console.error(`[E2E] 另一个 E2E 运行仍在进行（pid ${owner}，根 ${name}），先停止它再重跑`)
      process.exit(1)
    }
    // Capture the unfinished current scene before deleting an interrupted test root.
    // 抢救失败不中断整次启动：保留该根留待人工处理，继续清理其它残留。
    try {
      salvageTempTrace({ tempRoot: stale, reportsDir: TRACES_DIR, stamp: `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}` })
    } catch (error) {
      console.error(`[E2E] 残留根抢救失败，保留 ${name} 待人工处理: ${error.message}`)
      continue
    }
    rmSync(stale, { recursive: true, force: true })
  }
}
pruneStaleTempRoots()

const dataRoot = mkdtempSync(join(TEMP_ROOT_DIR, "e2e-"))
// 有主标记：并发启动的第二个 L4 据此区分「正在运行的根」与「可抢救删除的残留」，
// 不会把在跑者的数据根当残留删掉（判定见 pruneStaleTempRoots / liveOwnerPid）。
writeFileSync(join(dataRoot, ".pid"), `${process.pid}\n`)
const resultPath = join(dataRoot, "e2e-result.txt")
const configSource = CONFIG_FILES.find(name => existsSync(join(process.cwd(), name)))
if (!configSource) throw new Error("E2E 缺少完整配置种子")
mkdirSync(join(dataRoot, "settings"), { recursive: true })
copyFileSync(join(process.cwd(), configSource), join(dataRoot, "settings", "CONFIG.yaml"))
// 测试侧统一模型配置 stage（仓库常驻；缺失时告警，宿主按全部继承处理）。
const evalModelsSource = join(process.cwd(), "test", "eval-models.json")
if (existsSync(evalModelsSource)) copyFileSync(evalModelsSource, join(dataRoot, "eval-models.json"))
else console.error("[E2E] 缺少 test/eval-models.json，测试模型将全部继承仓库配置")
// 本地专属覆盖（凭据 / 临时指向；已 gitignore）：存在才 stage，只进隔离副本、不写回真实配置。
const evalModelsLocal = join(process.cwd(), "test", "eval-models.local.json")
if (existsSync(evalModelsLocal)) copyFileSync(evalModelsLocal, join(dataRoot, "eval-models.local.json"))
// 外部记忆基准：案例文件在开发者的 data-dir（默认 test/memory-bench/.data，可用
// --data-dir / DESKPET_BENCH_DATA_DIR 指定），这里按 upstream-lock.json 的目录映射
// stage 成隔离数据根的 bench/cases.json；宿主只读，不做运行期下载。
if (env.DESKPET_E2E_BENCH === "1") {
  const benchModuleDir = join(process.cwd(), "test", "memory-bench")
  const lock = JSON.parse(readFileSync(join(benchModuleDir, "upstream-lock.json"), "utf8"))
  const dataDir = env.DESKPET_BENCH_DATA_DIR?.trim() || join(benchModuleDir, ".data")
  const dataset = env.DESKPET_E2E_BENCH_DATASET
  const datasetEntry = dataset ? lock.datasets[dataset] : undefined
  const split = env.DESKPET_E2E_BENCH_SPLIT || datasetEntry?.defaultSplit
  const caseFile = datasetEntry?.splits?.[split]?.caseFile
  if (!caseFile) throw new Error(`[E2E] --bench-dataset/--bench-split 无效: ${dataset ?? "<empty>"}/${split ?? "<empty>"}`)
  const casePath = join(dataDir, caseFile)
  if (!existsSync(casePath)) {
    throw new Error(`[E2E] 缺少案例文件 ${casePath}；先安装：pnpm run test:memory-bench:prepare -- --dataset ${dataset}` +
      (env.DESKPET_BENCH_DATA_DIR ? ` --data-dir ${dataDir}` : ""))
  }
  mkdirSync(join(dataRoot, "bench"), { recursive: true })
  copyFileSync(casePath, join(dataRoot, "bench", "cases.json"))
}
env.DESKPET_E2E_DATA_ROOT = dataRoot
env.DESKPET_E2E_COMMIT = currentCommit()

let child
let finalized = false
let timeout
let stopping
let stopDeadline

function producerGroupAlive() {
  if (!child) return false
  // macOS may report EPERM for an already-exited group. Inspect membership without signalling unrelated processes.
  const groups = execFileSync("ps", ["-axo", "pgid="], {encoding:"utf8",timeout:5000})
  return groups.trim().split(/\s+/).some(group => Number(group) === child.pid)
}

function stopChild(signal = "SIGTERM") {
  if (!child) return
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error.code !== "ESRCH" && !(error.code === "EPERM" && !producerGroupAlive())) throw error
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  }
}

function requestStop(exitCode, reason) {
  if (stopping || finalized) return
  stopping = { exitCode, reason }
  if (timeout) clearTimeout(timeout)
  stopChild()
  // Keep the root intact until the producer has exited; an interrupted trace stays partial.
  stopDeadline = setTimeout(() => {
    stopChild("SIGKILL")
    setTimeout(() => finalizeStoppedProducer(), 250)
  }, 5_000)
}

function finalizeStoppedProducer() {
  if (process.platform === "win32") { finalize(stopping.exitCode, stopping.reason); return }
  if (!producerGroupAlive()) { finalize(stopping.exitCode, stopping.reason); return }
  // pnpm may exit before its grandchildren; wait for the whole isolated process group.
  if (!finalized) setTimeout(finalizeStoppedProducer, 100)
}

/**
 * 报告原先只写在一次性临时数据根里，随根一起删掉：CI 拿不到产物，
 * 也没法 diff 两次运行。清理之前先复制到仓库内的稳定目录（已在 .gitignore 忽略）。
 * 保留淘汰在 scripts/report-retention.mjs：组 = 报告 + 审阅/评分卫星；最近五组 + 200 MiB + 最新一组恒留。
 */

/**
 * 目标扩展名按 --report 声明的格式显式决定，不做内容嗅探。
 * WebView 侧经 `e2e_complete` 落盘的载荷固定是 `e2e-result.txt`，
 * 若按它推断，`--report html` 会被存成 `.txt`，双击进编辑器而不是浏览器。
 */
const REPORT_EXTENSIONS = { json: "json", html: "html" }

async function preserveReport() {
  let returnCode = 0
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  if (existsSync(join(dataRoot, "e2e-trace.jsonl"))) {
    if (existsSync(join(dataRoot, "e2e-manifest.json"))) {
      // bench 模式下逐题结果文件名不同；bundle 成员名由源文件名映射（trace-evidence.mjs）：
      // bench → `.memory-bench.jsonl`，记忆质量 → `.quality.jsonl`。
      const outcomesName = env.DESKPET_E2E_BENCH === "1" ? "memory-bench-outcomes.jsonl" : "memory-quality-outcomes.jsonl"
      // 正常路径不传 resultPath：根报告（test/reports/<stamp>.*）已是同一份字节，bundle 不再存第二份；
      // 抢救路径（salvageTempTrace）仍带 resultPath —— 中断时它是唯一留存。
      const bundle = retainTraceBundle({ reportsDir: TRACES_DIR, stamp, tracePath: join(dataRoot, "e2e-trace.jsonl"), manifestPath: join(dataRoot, "e2e-manifest.json"), qualityPath: join(dataRoot, outcomesName) })
      const integrity = await inspectTraceEvidence({ actualPath: bundle.tracePath, manifestPath: bundle.manifestPath })
      const { actual: _actual, manifestBody: _manifest, ...integritySummary } = integrity
      writeFileSync(join(TRACES_DIR, `trace-bundle-${stamp}.integrity.json`), JSON.stringify(integritySummary, null, 2) + "\n")
      if (integrity.status !== "complete") {
        const previewIssues = integrity.issues.slice(0, 10).join("; ")
        console.error(`[E2E] trace 不完整（共 ${integrity.issues.length} 项，完整记录见 integrity.json）: ${previewIssues}`)
        returnCode = 1
      }
    }
    else salvageTempTrace({ tempRoot: dataRoot, reportsDir: TRACES_DIR, stamp })
    console.error(`[E2E] trace 证据已留存: ${TRACES_DIR}`)
  }
  if (!existsSync(join(dataRoot, "e2e-trace.jsonl")) && !(env.DESKPET_E2E_PERFORMANCE === "1" && env.DESKPET_E2E_TRACE === "off")) {
    console.error("[E2E] 缺少 trace，不能作为完整验收证据")
    returnCode = 1
  }
  if (existsSync(resultPath)) {
    mkdirSync(REPORTS_DIR, { recursive: true })
    const extension = REPORT_EXTENSIONS[env.DESKPET_E2E_REPORT] ?? "txt"
    copyFileSync(resultPath, join(REPORTS_DIR, `${stamp}.${extension}`))
    const artifactCopy = env.DESKPET_E2E_ARTIFACT_COPY
    if (artifactCopy) {
      const rel = relative(TEMP_ROOT_DIR, artifactCopy)
      if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) throw new Error("评测副本必须位于 test/.tmp")
      const text = readFileSync(resultPath, "utf8")
      const payload = text.slice(text.indexOf("\n") + 1)
      JSON.parse(payload)
      writeFileSync(artifactCopy, payload)
    }
    pruneReportArtifacts(REPORTS_DIR)
    console.error(`[E2E] 报告已留存: ${REPORTS_DIR}`)
  }
  return returnCode
}

// ── 全量运行收尾的跨层 caseId 门禁 ──

/** 让某一层集合残缺或报告换协议的运行：这些情况下不做跨层对账。 */
const CASEID_GATE_SKIP_FILTERS = ["MODULE", "SCENE", "CASE", "TAG", "SUITE"]
const CASEID_GATE_SKIP_MODES = ["BENCH", "QUALITY", "PERFORMANCE"]

/**
 * 只有「全量运行」才判定跨层 caseId：过滤参数（--module / --scene / --case / --tag /
 * --suite）会让 L4 场景集不完整，--bench / --quality / --performance 是另一套数据集与
 * 报告协议 —— 对着残缺集合判 MISSING/ORPHAN 会成片误报，而误报会让下一个人放宽整条规则
 *（与 test/host/caseid-reporter.ts 对快层子集运行不判定的同一条判据）。
 */
function isFullLayerRun() {
  return CASEID_GATE_SKIP_FILTERS.every(name => !env[`DESKPET_E2E_${name}`])
    && CASEID_GATE_SKIP_MODES.every(name => env[`DESKPET_E2E_${name}`] !== "1")
}

/** 快层整层 caseId 报告（reporter 只在非过滤的全层运行里落盘；子集运行不落盘）。 */
function readCaseIdReport(name) {
  const file = join(REPORTS_DIR, name)
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(parsed)) throw new Error(`test/reports/${name} 不是 caseId 数组`)
  return parsed
}

/** 本次 L4 报告的 caseId 集合：只认真的跑过的场景（skip 不算覆盖，同快层纪律 8 的口径）。 */
function readL4CaseIds() {
  if (!existsSync(resultPath)) return undefined
  const text = readFileSync(resultPath, "utf8")
  const payload = text.slice(text.indexOf("\n") + 1)
  const report = JSON.parse(payload)
  if (!Array.isArray(report.scenes)) throw new Error("L4 报告缺少 scenes 数组")
  return report.scenes.filter(scene => scene.status !== "skip").map(scene => scene.caseId)
}

/**
 * 三层 caseId 汇总 vs 全部契约声明（scripts/contract-layers.mjs 的纯函数）：
 * missing（声明了没人实现）/ orphan（实现了没声明）/ duplicates（两层重复携带）任一命中即失败。
 * 契约声明经正则读取（与 checkContractHashes 同一读法），实现集合来自最近一次整层快层
 * 运行落盘的 caseids-*.json 与本次 L4 报告 —— 所以全量运行前要先跑快层（test:release 的顺序保证）。
 * 读不到任何一份集合都算「无法核对」，如实失败，不静默放行。
 */
function checkCrossLayerCaseIds() {
  try {
    const contractsDir = join(process.cwd(), "test", "contracts")
    const declared = readdirSync(contractsDir)
      .filter(name => name.endsWith(".contract.ts"))
      .flatMap(name => extractContractCaseIds(readFileSync(join(contractsDir, name), "utf8")))
    const implemented = {}
    for (const [layer, reportName] of [["unit", "caseids-unit.json"], ["integration", "caseids-integration.json"]]) {
      const ids = readCaseIdReport(reportName)
      if (!ids) {
        console.error(`[E2E] 跨层 caseId 校验失败：缺少 test/reports/${reportName}（整层集合）；先跑 node scripts/run-vitest-with-retry.mjs ${layer}`)
        return false
      }
      implemented[layer] = ids
    }
    const l4 = readL4CaseIds()
    if (!l4) {
      console.error("[E2E] 跨层 caseId 校验失败：本次没有 L4 报告，e2e 层集合无法核对")
      return false
    }
    implemented.e2e = l4
    const issues = formatCaseIdLayerIssues(compareCaseIdLayers({ declared, implemented }))
    if (issues.length > 0) {
      console.error(`[E2E] 跨层 caseId 校验失败（共 ${issues.length} 条）：`)
      for (const line of issues) console.error(`  ${line}`)
      return false
    }
    console.error(`[E2E] 跨层 caseId 校验通过：契约声明 ${new Set(declared).size} 个，unit ${implemented.unit.length} / integration ${implemented.integration.length} / e2e ${implemented.e2e.length} 个`)
    return true
  } catch (error) {
    console.error(`[E2E] 跨层 caseId 校验无法执行: ${error.message}`)
    return false
  }
}

async function finalize(exitCode, reason) {
  if (finalized) return
  finalized = true
  if (timeout) clearTimeout(timeout)
  if (stopDeadline) clearTimeout(stopDeadline)
  if (reason) console.error(`[E2E] ${reason}`)
  try {
    try {
      const finalAttestation = checkContractHashes()
      if (JSON.stringify(finalAttestation) !== JSON.stringify(hashAttestation)) throw new Error("源码证明与启动时不同")
    } catch (error) {
      exitCode = 1
      console.error(`[E2E] 运行期间源码发生变化，不能验收本次结果: ${error.message}`)
      const manifestPath = join(dataRoot, "e2e-manifest.json")
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
        writeFileSync(manifestPath, JSON.stringify({...manifest,complete:false,sourceChangedDuringRun:true}, null, 2) + "\n")
      }
    }
    if (await preserveReport()) exitCode = 1
    // 全量运行的跨层 caseId 门禁（过滤与特殊模式跳过，判据见 isFullLayerRun）。
    if (isFullLayerRun() && !checkCrossLayerCaseIds()) exitCode = 1
    rmSync(dataRoot, { recursive: true, force: true })
  } catch (error) {
    // A lost report is an infrastructure failure; preserve its source for recovery.
    console.error(`[E2E] 证据留存失败，临时根保留 ${dataRoot}: ${error.message}`)
    exitCode = 1
  }
  process.exit(exitCode)
}

process.once("SIGINT", () => requestStop(130, "收到 SIGINT，停止后留存隔离现场"))
process.once("SIGTERM", () => requestStop(143, "收到 SIGTERM，停止后留存隔离现场"))

child = spawn("pnpm", ["exec", "tauri", "dev", "--no-watch"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  detached: process.platform !== "win32",
})
timeout = setTimeout(() => {
  requestStop(1, "超过本次评测截止时间，停止后留存现场")
}, (env.DESKPET_E2E_QUALITY === "1" ? 480 : env.DESKPET_E2E_BENCH === "1" ? 480 : env.DESKPET_E2E_PERFORMANCE === "1" ? 30 : Math.max(30, Number(env.DESKPET_E2E_REPEAT ?? 1) * 10)) * 60 * 1000)

child.on("error", error => finalize(1, `无法启动 Tauri: ${error.message}`))
child.on("exit", (code, signal) => {
  if (stopping) { finalizeStoppedProducer(); return }
  const passed = existsSync(resultPath) && readFileSync(resultPath, "utf8").startsWith("PASS\n")
  const reason = passed ? undefined : existsSync(resultPath) ? "测试报告标记为失败" : `测试进程未生成结果文件 (exit=${code}, signal=${signal ?? "none"})`
  requestStop(passed ? 0 : 1, reason)
  finalizeStoppedProducer()
})
