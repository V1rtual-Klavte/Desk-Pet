// Explicit performance runner; its temporary roots and artifacts stay under test/.
import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { pruneRetainedGroups } from "./report-retention.mjs"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_FILES = ["Cargo.lock", "crates/native-host/src/memory/benchmark.rs", "crates/native-host/src/memory/store.rs", "crates/native-host/src/memory/schema.rs", "crates/native-host/src/paths/mod.rs", "test/e2e/memory-performance.ts", "test/host/performance.ts", "scripts/memory-performance.mjs"]
function sourceHash() {
  const hash = createHash("sha256")
  for (const file of [...SOURCE_FILES].sort()) hash.update(readFileSync(join(repo, file)))
  return hash.digest("hex")
}

function processTreeSample(rootPid) {
  let processes
  if (process.platform === "win32") {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 5000 })
    processes = JSON.parse(raw)
    if (!Array.isArray(processes)) processes = [processes]
    processes = processes.map(p => ({ pid: Number(p.ProcessId), parent: Number(p.ParentProcessId), rssBytes: Number(p.WorkingSetSize), cpuMs: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 10000 }))
  } else {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8", timeout: 5000 })
    processes = raw.trim().split("\n").map(line => {
      const [pid, parent, rss, time] = line.trim().split(/\s+/)
      const parts = time.split(":").map(Number)
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
      return { pid: Number(pid), parent: Number(parent), rssBytes: Number(rss) * 1024, cpuMs: seconds * 1000 }
    })
  }
  const ids = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const p of processes) if (ids.has(p.parent) && !ids.has(p.pid)) { ids.add(p.pid); changed = true }
  }
  const members = processes.filter(p => ids.has(p.pid))
  return { recordedAt: new Date().toISOString(), rssBytes: members.reduce((n, p) => n + p.rssBytes, 0), members }
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: repo, env: { ...process.env, ...env }, stdio: "inherit" })
  const resources = []
  const timer = setInterval(() => {
    try { resources.push(processTreeSample(child.pid)) }
    catch (error) { resources.push({ recordedAt: new Date().toISOString(), error: error.message }) }
  }, 1000)
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
    return { code, resources }
  } finally { clearInterval(timer) }
}

const PERF_ROOT_MAX_AGE_MS = 3 * 60 * 60 * 1000

/**
 * 上次运行的残留回收：只认 memory-perf- 前缀 + 目录年龄 ≥3 小时 + 无存活 pid 标记。
 * 白名单前缀而不是「全删 + 排除清单」——.tmp 里有人工输入资产（如 proactive-calendar/），误删不可接受。
 */
function pruneStalePerfRoots(tmp) {
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith("memory-perf-")) continue
    const stale = join(tmp, name)
    const stats = statSync(stale)
    if (!stats.isDirectory() || Date.now() - stats.mtimeMs < PERF_ROOT_MAX_AGE_MS) continue
    const pidFile = join(stale, ".pid")
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); continue }                  // 进程还活着，不碰
        catch (error) { if (error.code === "EPERM") continue }  // 不可信号同样视为存活
      }
    }
    rmSync(stale, { recursive: true, force: true })
  }
}

/** 性能报告池的组键：每个日期戳文件自成一组（无卫星）。 */
function performanceReportGroupKey(name) {
  return /^\d{4}-\d{2}-\d{2}T[\dTZ.-]+\.json$/.test(name) ? name : null
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--")
  if (args.some(arg => !["--native-only", "--ipc-only"].includes(arg)) || args.includes("--native-only") && args.includes("--ipc-only")) throw new Error("用法: test:memory-performance [--native-only | --ipc-only]")
  const tmp = join(repo, "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  pruneStalePerfRoots(tmp)
  const root = mkdtempSync(join(tmp, "memory-perf-"))
  writeFileSync(join(root, ".pid"), `${process.pid}\n`)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const reports = join(repo, "test", "reports", "performance")
  mkdirSync(reports, { recursive: true })
  const baselineHash = sourceHash()
  const evidence = { schemaVersion: "desk-pet-performance-run/v1", timestamp: new Date().toISOString(), platform: process.platform, runs: [], limits: ["Process samples include build tools and descendants only; launchd-owned WebKit helpers may be absent", "Use report phase intervals to distinguish idle/runtime samples from compilation", "Debug IPC evidence and native release evidence have separate scopes", "Release WebView/IPC, complete application RSS, binary size delta and actual ChatPanel rendering require native acceptance evidence"] }
  let failed = false
  try {
    if (!args.includes("--ipc-only")) {
      const result = await run("cargo", ["test", "--manifest-path", "crates/native-host/Cargo.toml", "--release", "--lib", "memory::benchmark::tests::release_storage_benchmark", "--", "--ignored", "--exact", "--nocapture"], { DESKPET_MEMORY_PERF_ROOT: root })
      // Full test path is needed for --exact; the filtered name must execute one test.
      if (!existsSync(join(root, "native.json"))) throw new Error("Release benchmark 没有执行或没有产出 native.json")
      const native = JSON.parse(readFileSync(join(root, "native.json"), "utf8"))
      evidence.runs.push({ kind: "release-storage", ...result, report: native })
      if (result.code !== 0 || native.passed !== true) failed = true
    }
    if (!args.includes("--native-only")) {
      for (const mode of ["off", "light", "full"]) {
        const output = join(root, `${mode}-ipc.json`)
        const result = await run(process.execPath, ["scripts/e2e-test.mjs", "--performance", "--trace", mode, "--report", "json"], { DESKPET_E2E_ARTIFACT_COPY: output })
        evidence.runs.push({ kind: "debug-ipc", traceMode: mode, ...result, report: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null })
        if (result.code !== 0 || !existsSync(output)) failed = true
      }
    }
  } catch (error) {
    failed = true
    evidence.error = error.message
  } finally {
    evidence.sourceFiles = SOURCE_FILES
    evidence.sourceHash = baselineHash
    if (sourceHash() !== baselineHash) {
      failed = true
      evidence.sourceChangedDuringRun = true
    }
    evidence.passed = !failed
    const target = join(reports, `${stamp}.json`)
    let reportWritten = false
    try {
      writeFileSync(target, JSON.stringify(evidence, null, 2) + "\n")
      console.error(`[performance] ${failed ? "FAIL" : "PASS"} ${target}`)
      reportWritten = true
    } catch (error) {
      // 证据保全：报告写不出去就保留临时根（下次启动的年龄 + pid 清扫会兜底），
      // 把路径打给使用者，不静默丢。
      console.error(`[performance] 报告写出失败，临时根保留用于取证: ${root} (${error.message})`)
      failed = true
    }
    if (reportWritten) {
      rmSync(root, { recursive: true, force: true })
      try {
        pruneRetainedGroups(reports, { groupKey: performanceReportGroupKey })
      } catch (error) {
        console.error(`[performance] 保留淘汰失败（不影响本次结论）: ${error.message}`)
      }
    }
  }
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
