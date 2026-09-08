import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const allowed = new Set(["--module", "--scene", "--tag", "--report"])
const env = { ...process.env, DESKPET_LIVE_TEST: "1" }

function checkContractHashes() {
  const dir = join(process.cwd(), "src/services/__tests__/live/contracts")
  for (const file of readdirSync(dir).filter(name => name.endsWith(".contract.ts"))) {
    const content = readFileSync(join(dir, file), "utf8")
    const hashMatch = content.match(/sourceHash:\s*"([0-9a-f]*)"/)
    const filesMatch = content.match(/sourceFiles:\s*\[([\s\S]*?)\]/)
    const files = [...(filesMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1])
    const actual = createHash("sha256")
    for (const source of [...files].sort()) actual.update(readFileSync(join(process.cwd(), source), "utf8"))
    const expected = hashMatch?.[1] ?? ""
    const current = actual.digest("hex")
    if (!expected || expected !== current) {
      throw new Error(`[STALE] ${file}: sourceHash=${expected || "<empty>"}, current=${current}; 请重新运行 /analyze test`)
    }
  }
}

try { checkContractHashes() } catch (error) {
  console.error(`[LiveTest] Contract 校验失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i]) || !args[i + 1]) continue
  const key = args[i].slice(2).toUpperCase().replace(/-/g, "_")
  env[`DESKPET_LIVE_TEST_${key}`] = args[++i]
}

const dataRoot = mkdtempSync(join(homedir(), ".deskpet-live-test-"))
env.DESKPET_LIVE_TEST_DATA_ROOT = dataRoot
const resultPath = join(dataRoot, "live-test-result.txt")
const seedStages = join(process.cwd(), "data", "desk-pet", "personality", "stages")
if (existsSync(seedStages)) {
  mkdirSync(join(dataRoot, "personality"), { recursive: true })
  cpSync(seedStages, join(dataRoot, "personality", "stages"), { recursive: true })
}

const child = spawn("pnpm", ["exec", "tauri", "dev", "--no-watch"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
})
const timeout = setTimeout(() => {
  console.error("[LiveTest] 超过 10 分钟未结束，终止测试进程")
  child.kill("SIGTERM")
}, 10 * 60 * 1000)

child.on("exit", (code, signal) => {
  clearTimeout(timeout)
  let passed = false
  if (existsSync(resultPath)) {
    passed = readFileSync(resultPath, "utf-8").startsWith("PASS\n")
  } else {
    console.error(`[LiveTest] 测试进程未生成结果文件 (exit=${code}, signal=${signal ?? "none"})`)
  }
  rmSync(dataRoot, { recursive: true, force: true })
  process.exit(passed ? 0 : 1)
})
