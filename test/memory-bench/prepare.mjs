// ==========================================
// memory-bench 数据安装器：锁定版本 → 一行命令下载到开发者指定目录
// ==========================================
//
// 数据集不进仓库：版本锁定的载体是进 git 的小文件 —— `upstream-lock.json`（URL / 固定 revision /
// SHA-256 / 目录映射）与 `licenses/`（上游许可原文）。原始数据与转换后的案例文件一律落在
// data-dir（默认可弃缓存，见下），由本脚本按锁文件逐字节校验后安装。
//
// data-dir 解析优先级：
//   1. `--data-dir <目录>`
//   2. 环境变量 `DESKPET_BENCH_DATA_DIR`
//   3. 默认 `test/memory-bench/.data/`（已 gitignore；仓库内唯一允许的缓存位置）
// 目录布局（相对 data-dir，映射在 upstream-lock.json）：
//   raw/      上游原始文件
//   cases/    转换后的案例文件（runner 实际读取）
//   reference/ 官方判分脚本参考件与许可原文副本（审计用）
//
// 用法：
//   pnpm run test:memory-bench:prepare                          # 安装全部三个数据集（oracle，不含 S）
//   pnpm run test:memory-bench:prepare -- --data-dir /data/bench
//   node test/memory-bench/prepare.mjs --dataset longmemeval --split s      # 可选：S-cleaned（277MB）
//   node test/memory-bench/prepare.mjs --verify [--data-dir …]              # 校验缓存/产物/许可，不下载
//   node test/memory-bench/prepare.mjs --offline                            # 只用已有缓存
// 开发工具直接用 console（不引入 logger/IPC 依赖）。

import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { buildLongMemEvalFile, validateLongMemEvalFile } from "./datasets/longmemeval/importer.mjs"
import { buildLocomoFile, validateLocomoFile } from "./datasets/locomo/importer.mjs"
import { buildMemoryBankFile, validateMemoryBankFile } from "./datasets/memorybank/importer.mjs"

export const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const LOCK_PATH = join(MODULE_DIR, "upstream-lock.json")
export const BENCH_DATA_ENV = "DESKPET_BENCH_DATA_DIR"
export const DEFAULT_DATA_DIR = join(MODULE_DIR, ".data")

export function readLock() { return JSON.parse(readFileSync(LOCK_PATH, "utf8")) }

/** data-dir 优先级：--data-dir > DESKPET_BENCH_DATA_DIR > test/memory-bench/.data。 */
export function resolveDataDir({ dataDir, env = process.env } = {}) {
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim()
  if (typeof env[BENCH_DATA_ENV] === "string" && env[BENCH_DATA_ENV].trim()) return env[BENCH_DATA_ENV].trim()
  return DEFAULT_DATA_DIR
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

async function ensureDownload(entry, dataDir, { force = false, offline = false } = {}) {
  const cachePath = join(dataDir, entry.path)
  if (existsSync(cachePath) && !force) {
    const actual = sha256File(cachePath)
    if (actual === entry.sha256) return cachePath
    throw new Error(`缓存 ${entry.path} 的 SHA-256 与锁文件不符（${actual}）。\n` +
      `上游可能已变更（锁定 revision ${entry.revision}）：先人工核对再更新 upstream-lock.json，或删除该文件后重装。`)
  }
  if (offline) throw new Error(`离线模式缺少缓存 ${entry.path}；请先联网运行 prepare`)
  mkdirSync(dirname(cachePath), { recursive: true })
  const temp = `${cachePath}.download`
  console.log(`[memory-bench] 下载 ${entry.url}`)
  const response = await fetch(entry.url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`下载失败 ${entry.url}: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
  const actual = sha256File(temp)
  if (actual !== entry.sha256) {
    throw new Error(`${entry.path} SHA-256 不符：期望 ${entry.sha256}，实际 ${actual}（已丢弃下载文件）。` +
      `上游内容与锁定 revision 不一致，请人工核对。`)
  }
  renameSync(temp, cachePath)
  return cachePath
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")) }

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
  console.log(`[memory-bench] 写出 ${path}`)
}

function upstreamOf(lock, downloadName) {
  const entry = lock.downloads[downloadName]
  return { source: entry.url.split("/").slice(0, 5).join("/"), url: entry.url, revision: entry.revision,
    file: entry.path.split("/").at(-1), fileSha256: entry.sha256, bytes: entry.bytes }
}

function licenseOf(lock, licenseName) {
  const license = lock.licenses[licenseName]
  return { spdx: license.spdx, attribution: license.attribution,
    ...(license.nonCommercial ? { nonCommercial: true } : {}),
    revision: license.revision, licenseFileSha256: lock.downloads[license.download].sha256,
    repoFile: license.repoFile }
}

function verifyRepoLicenseCopy(lock, licenseName) {
  const license = lock.licenses[licenseName]
  const repoPath = join(MODULE_DIR, license.repoFile)
  if (!existsSync(repoPath)) throw new Error(`仓库内缺少许可原文副本 ${license.repoFile}（许可证合规红线，必须随源码保留）`)
  const actual = sha256File(repoPath)
  const expected = lock.downloads[license.download].sha256
  if (actual !== expected) throw new Error(`仓库内 ${license.repoFile} 与上游许可原文不一致（${actual} != ${expected}）；不要编辑该文件`)
}

async function installDataset(lock, dataset, split, options) {
  const dataDir = resolveDataDir(options)
  const datasetEntry = lock.datasets[dataset]
  if (!datasetEntry) throw new Error(`未登记的数据集: ${dataset}（可用: ${Object.keys(lock.datasets).join(" / ")}）`)
  const resolvedSplit = split ?? datasetEntry.defaultSplit
  const splitEntry = datasetEntry.splits[resolvedSplit]
  if (!splitEntry) throw new Error(`数据集 ${dataset} 没有 split ${resolvedSplit}（可用: ${Object.keys(datasetEntry.splits).join(" / ")}）`)
  verifyRepoLicenseCopy(lock, splitEntry.license)
  const upstream = upstreamOf(lock, splitEntry.downloads[0])
  const license = licenseOf(lock, splitEntry.license)
  let file
  if (dataset === "longmemeval") {
    const rawPath = await ensureDownload(lock.downloads[splitEntry.downloads[0]], dataDir, options)
    const raw = readJson(rawPath)
    let caseIds
    if (resolvedSplit === "s") {
      // S 与 oracle 用同一批题号（两档可比）；oracle 尚未安装时按默认策略重新选题。
      const oracleFile = join(dataDir, lock.datasets.longmemeval.splits.oracle.caseFile)
      caseIds = existsSync(oracleFile) ? readJson(oracleFile).cases.map(item => item.questionId) : undefined
      if (!caseIds) console.log("[memory-bench] 未安装 oracle 子集，S 将按默认选择策略重新选题（建议先装 oracle）")
    }
    file = buildLongMemEvalFile(raw, { split: resolvedSplit, splitSlug: resolvedSplit, caseIds, upstream, license })
    const errors = validateLongMemEvalFile(file)
    if (errors.length) throw new Error(`LongMemEval ${resolvedSplit} 转换校验失败:\n${errors.join("\n")}`)
    console.log(`[memory-bench] LongMemEval ${resolvedSplit}: ${file.cases.length} 题 / 弃权 ${file.selection.abstentionCount} / 覆盖 ${Object.keys(file.selection.countsByType).length} 类`)
  } else if (dataset === "locomo") {
    const rawPath = await ensureDownload(lock.downloads[splitEntry.downloads[0]], dataDir, options)
    file = buildLocomoFile(readJson(rawPath), { upstream, license })
    const errors = validateLocomoFile(file)
    if (errors.length) throw new Error(`LoCoMo 转换校验失败:\n${errors.join("\n")}`)
    console.log(`[memory-bench] LoCoMo: ${file.conversations.length} 段对话 / ${file.cases.length} 题`)
  } else if (dataset === "memorybank") {
    const [personasPath, probingPath] = await Promise.all(splitEntry.downloads.map(name => ensureDownload(lock.downloads[name], dataDir, options)))
    const probingLines = readFileSync(probingPath, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line))
    file = buildMemoryBankFile(readJson(personasPath), probingLines, { upstream, license })
    const errors = validateMemoryBankFile(file)
    if (errors.length) throw new Error(`MemoryBank 转换校验失败:\n${errors.join("\n")}`)
    console.log(`[memory-bench] MemoryBank cn: ${file.personas.length} 角色 / ${file.cases.length} 题`)
  } else {
    throw new Error(`未登记的转换器: ${dataset}`)
  }
  const target = join(dataDir, splitEntry.caseFile)
  writeJson(target, file)
  return target
}

/** 审计参考件（官方判分脚本、许可原文副本）也按锁文件装到 data-dir，保证判分口径可追溯。 */
async function installReferences(lock, options) {
  const dataDir = resolveDataDir(options)
  for (const entry of Object.values(lock.downloads)) {
    if (!entry.path.startsWith("reference/")) continue
    await ensureDownload(entry, dataDir, options)
  }
}

function validateCaseFile(file) {
  if (file.dataset === "longmemeval") return validateLongMemEvalFile(file)
  if (file.dataset === "locomo") return validateLocomoFile(file)
  if (file.dataset === "memorybank") return validateMemoryBankFile(file)
  return [`未知 dataset: ${file.dataset}`]
}

function verify(lock, options) {
  const dataDir = resolveDataDir(options)
  let failures = 0
  console.log(`[verify] data-dir: ${dataDir}`)
  for (const [name, license] of Object.entries(lock.licenses)) {
    try { verifyRepoLicenseCopy(lock, name) ; console.log(`[verify] 仓库许可副本 ${license.repoFile} 通过`) }
    catch (error) { console.error(`[verify] ${error.message}`); failures += 1 }
  }
  for (const [name, entry] of Object.entries(lock.downloads)) {
    const cachePath = join(dataDir, entry.path)
    if (!existsSync(cachePath)) { console.log(`[verify] 缓存缺失（按需安装）: ${entry.path}`); continue }
    const actual = sha256File(cachePath)
    if (actual !== entry.sha256) { console.error(`[verify] ${entry.path} SHA-256 不符: ${actual}`); failures += 1 }
    else console.log(`[verify] ${entry.path} SHA-256 通过`)
  }
  for (const [dataset, datasetEntry] of Object.entries(lock.datasets)) {
    for (const [split, splitEntry] of Object.entries(datasetEntry.splits)) {
      const casePath = join(dataDir, splitEntry.caseFile)
      if (!existsSync(casePath)) { console.log(`[verify] 案例文件未安装: ${dataset}/${split}（${splitEntry.caseFile}）`); continue }
      const file = readJson(casePath)
      const errors = validateCaseFile(file)
      if (file.importTransformVersion !== splitEntry.transformVersion) errors.push(`importTransformVersion=${file.importTransformVersion}，锁文件为 ${splitEntry.transformVersion}`)
      if (errors.length) { console.error(`[verify] ${casePath} 校验失败:\n${errors.join("\n")}`); failures += 1 }
      else console.log(`[verify] ${casePath} 通过（${file.cases.length} 题）`)
    }
  }
  return failures
}

function parseArgs(argv) {
  const options = { dataset: undefined, split: undefined, all: false, verify: false, offline: false,
    force: false, dataDir: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === "--all") options.all = true
    else if (option === "--verify") options.verify = true
    else if (option === "--offline") options.offline = true
    else if (option === "--force-download") options.force = true
    else if (option === "--dataset") options.dataset = argv[++index]
    else if (option === "--split") options.split = argv[++index]
    else if (option === "--data-dir") options.dataDir = argv[++index]
    else throw new Error(`无法识别的参数: ${option}`)
  }
  if (options.dataDir !== undefined && !options.dataDir) throw new Error("--data-dir 需要目录参数")
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const lock = readLock()
  if (options.verify) {
    process.exit(verify(lock, options) === 0 ? 0 : 1)
  }
  const runOptions = { dataDir: options.dataDir, force: options.force, offline: options.offline }
  await installReferences(lock, runOptions)
  if (options.dataset) {
    const target = await installDataset(lock, options.dataset, options.split, runOptions)
    console.log(`[memory-bench] 安装完成: ${target}`)
    return
  }
  // 默认安装全部三集（longmemeval 默认 oracle；S 用 --dataset longmemeval --split s 单独安装）
  for (const [dataset, datasetEntry] of Object.entries(lock.datasets))
    await installDataset(lock, dataset, datasetEntry.defaultSplit, runOptions)
  const dataDir = resolveDataDir(options)
  console.log(`[memory-bench] 全部安装完成（data-dir: ${dataDir}）。运行示例：`)
  console.log(`  pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split oracle --bench-limit 5 --report json`)
  if (dataDir !== DEFAULT_DATA_DIR) console.log(`  自定义目录请同时导出环境变量或在每次运行时保持同一 --data-dir：DESKPET_BENCH_DATA_DIR=${dataDir}`)
}

main().catch(error => {
  console.error(`[memory-bench] prepare 失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
