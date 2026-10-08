import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"

function sha256(parts) {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}

/**
 * Validate Contract sourceHash declarations and return the exact attestation E2E passes to its runner.
 *
 * The hash intentionally matches the historical E2E implementation: sort sourceFiles, then
 * concatenate each UTF-8 file's text directly into SHA-256 without path names or separators.
 */
export function checkContractHashes({
  root = process.cwd(),
  contracts = "all",
  module,
} = {}) {
  const contractsDir = join(root, "test", "contracts")
  const only = contracts === "selected" && module ? `${module}.contract.ts` : null
  const targets = readdirSync(contractsDir)
    .filter(name => name.endsWith(".contract.ts") && (!only || name === only))
    .sort()
  if (only && targets.length === 0) {
    throw new Error(
      `[STALE] module=${module} contract=${only}: sourceHash=<missing>, current=<unavailable>; --module 与 --contracts=selected 对不上`,
    )
  }

  const attestation = {}
  const staleIssues = []
  for (const file of targets) {
    const contractPath = join(contractsDir, file)
    let content
    try {
      content = readFileSync(contractPath, "utf8")
    } catch {
      const moduleName = file.replace(/\.contract\.ts$/, "")
      staleIssues.push(
        `[STALE] module=${moduleName} contract=${file}: sourceHash=<unavailable>, current=<unavailable>; Contract 文件无法读取`,
      )
      continue
    }
    const moduleName = content.match(/^\s*module:\s*"([^"]+)"/m)?.[1]
      ?? file.replace(/\.contract\.ts$/, "")
    const expected = content.match(/sourceHash:\s*"([0-9a-f]*)"/)?.[1] ?? ""
    const filesMatch = content.match(/sourceFiles:\s*\[([\s\S]*?)\]/)
    const files = [...(filesMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1])
    let actual
    try {
      actual = sha256([...files].sort().map(source => readFileSync(join(root, source), "utf8")))
    } catch {
      staleIssues.push(
        `[STALE] module=${moduleName} contract=${file}: sourceHash=${expected || "<empty>"}, current=<unavailable>; 声明的 sourceFiles 无法读取`,
      )
      continue
    }
    if (!expected || expected !== actual) {
      staleIssues.push(
        `[STALE] module=${moduleName} contract=${file}: sourceHash=${expected || "<empty>"}, current=${actual}; 请重新运行 /analyze test`,
      )
      continue
    }
    attestation[moduleName] = actual
  }
  if (staleIssues.length > 0) throw new Error(staleIssues.join("\n"))
  return attestation
}

function parseArgs(args, env) {
  let contracts = env.DESKPET_E2E_CONTRACTS ?? "all"
  let module = env.DESKPET_E2E_MODULE
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--contracts" || arg === "--module") {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`)
      if (arg === "--contracts") contracts = value
      else module = value
      continue
    }
    if (arg.startsWith("--contracts=")) {
      contracts = arg.slice("--contracts=".length)
      continue
    }
    if (arg.startsWith("--module=")) {
      module = arg.slice("--module=".length)
      continue
    }
    throw new Error(`未知参数: ${arg}`)
  }
  if (contracts !== "all" && contracts !== "selected") {
    throw new Error("--contracts 只接受 all 或 selected")
  }
  return { contracts, module }
}

export function runContractHashCli(args = process.argv.slice(2), env = process.env) {
  try {
    const options = parseArgs(args, env)
    if (options.help) {
      console.log("用法: node scripts/check-contract-hashes.mjs [--contracts all|selected] [--module <name>]")
      return 0
    }
    const attestation = checkContractHashes(options)
    console.log(`[Contract] sourceHash 校验通过：${Object.keys(attestation).length} 个模块`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误"
    console.error(`[Contract] sourceHash 校验失败：${message}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (invokedPath === import.meta.url) {
  process.exitCode = runContractHashCli()
}
