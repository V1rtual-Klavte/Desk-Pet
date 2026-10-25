#!/usr/bin/env node
/**
 * 聊天评测运行器（W2）：准备隔离根、拉起 debug 宿主、核对所有权与装载报告。
 *
 * 用法：
 *   node scripts/sim-eval-run.mjs prepare --case <caseId> --card <card.md> [--run-id <id>]
 *   node scripts/sim-eval-run.mjs start --run-id <id>
 *   node scripts/sim-eval-run.mjs status --run-id <id>
 *   node scripts/sim-eval-run.mjs stop --run-id <id>
 *
 * 只有一个宿主能拥有运行根：prepare 建根并写入合成 CONFIG / Card / seed.json，
 * start 拉起 `DESKPET_SIM_EVAL=1` 的 debug 宿主并等待 ready、控制通道 ready 与
 * seed-report；stop 只写 `stop.request`，宿主自己走产品退出序列。
 *
 * 本文件是开发工具（Node 脚本），不进产品构建；纯校验函数导出给 L2 单测。
 * 不读取真实 CONFIG、凭据或用户数据：Card 由调用方显式给出，凭据只 stage
 * `test/eval-models.local.json`（若存在）供运行期消费。
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildSyntheticConfig, writeSyntheticConfig } from "../test/host/native/synthetic-config.mjs"
import { buildNativeHost } from "../test/host/native/build.mjs"
import { hashCanonical, loadDataset } from "../test/sim/desk-pet-chat/dataset.mjs"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const RUNS_BASE = join(REPO_ROOT, "test", ".tmp")
const RUN_DIR_PREFIX = "sim-eval-"
const RUNNER_STATE_FILE = "runner.json"
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const READY_WAIT_MS = 90_000
const BRIDGE_WAIT_MS = 180_000
const STOP_WAIT_MS = 60_000
const POLL_MS = 250
const IS_WINDOWS = process.platform === "win32"

export const RUNNER_STATE_SCHEMA_VERSION = 1

// ── 纯校验 / 形状辅助（导出给单测）──

export function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`run-id 不合法（只允许 a-z0-9-，且以 a-z0-9 开头、最长 48）：${String(runId)}`)
  }
  return runId
}

export function makeRunId(now = new Date(), suffix = randomBytes(4).toString("hex")) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`
  return validateRunId(`${stamp}-${suffix}`)
}

export function runDirFor(runId, repoRoot = REPO_ROOT) {
  return join(repoRoot, "test", ".tmp", `${RUN_DIR_PREFIX}${validateRunId(runId)}`)
}

/** 与 `src/services/personality/loader.ts` 的 safeCardFileName 逐字一致（见单测的漂移对照）。 */
export function safeCardFileName(cardId) {
  return String(cardId).replace(/[^\w一-鿿-]/g, "_")
}

/** 与 loader 的 frontmatter 解析逐字一致：同一份 Card 必须得到同一个 id/name/version。 */
export function parseCardMeta(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { id: "unknown", name: "Unknown", description: "", version: 1 }
  const meta = { id: "", name: "", description: "", version: 1 }
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (!kv) continue
    const key = kv[1].trim()
    const value = kv[2].trim().replace(/^["']|["']$/g, "")
    if (key === "id") meta.id = value
    else if (key === "name") meta.name = value
    else if (key === "nameVar") meta.nameVar = value
    else if (key === "description") meta.description = value
    else if (key === "version") meta.version = parseInt(value, 10) || 1
  }
  return { ...meta, name: meta.name || meta.id }
}

/**
 * 运行期 CONFIG 覆盖：激活目标 Card / Profile，并关掉主动与静默了解。
 * 自动记忆整理（dreaming）保持开启 —— 纠正轮的自动抽取是 case 的真实链路。
 */
export function buildRunOverrides({ cardId, profileId }) {
  if (typeof cardId !== "string" || cardId.trim() === "") throw new Error("覆盖缺少 Card id")
  return {
    ai: {
      personality: { active: cardId },
      proactive: { frequency: "off" },
      silentAccess: { frequency: "off" },
    },
    ...(profileId ? { appearance: { activeProfile: profileId } } : {}),
  }
}

export function validateHostReady(raw, { runDir, pid }) {
  if (typeof raw !== "object" || raw === null) throw new Error("ready.json 不是对象")
  if (raw.schemaVersion !== 1) throw new Error(`ready.json schemaVersion=${String(raw.schemaVersion)} 不受支持`)
  for (const field of ["generation", "runDir", "dataRoot", "controlDir", "runtimeMode", "startedAt"]) {
    if (typeof raw[field] !== "string" || raw[field].trim() === "") throw new Error(`ready.json 缺少字段 ${field}`)
  }
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) throw new Error("ready.json 的 pid 非法")
  if (raw.pid !== pid) throw new Error(`ready.json pid=${raw.pid} 与本次子进程 ${pid} 不一致`)
  if (resolve(raw.runDir) !== resolve(runDir)) throw new Error("ready.json 的 runDir 与本次运行根不一致")
  const dataRoot = join(runDir, "data")
  if (resolve(raw.dataRoot) !== resolve(dataRoot)) throw new Error("ready.json 的 dataRoot 不在运行根下")
  if (resolve(raw.controlDir) !== resolve(join(dataRoot, "logs", "sim", "control"))) {
    throw new Error("ready.json 的 controlDir 与数据根不同源")
  }
  if (raw.runtimeMode !== "development") throw new Error(`ready.json runtimeMode=${raw.runtimeMode}，期望 development`)
  return raw
}

/** 控制通道 ready 必须指向同一宿主、同一运行根、同一 fixture 与 Card。 */
export function assertBridgeReady(event, expected) {
  if (typeof event !== "object" || event === null || event.type !== "ready") throw new Error("控制通道 ready 事件不是对象")
  if (event.generation !== expected.generation) throw new Error("控制通道 ready 的 generation 与宿主不一致")
  if (event.hostPid !== expected.hostPid) throw new Error("控制通道 ready 的 hostPid 与宿主不一致")
  if (typeof event.runDir !== "string" || resolve(event.runDir) !== resolve(expected.runDir)) {
    throw new Error("控制通道 ready 的 runDir 与本次运行根不一致")
  }
  if (event.cardId !== expected.cardId) throw new Error(`控制通道 ready 的 cardId=${String(event.cardId)}，期望 ${expected.cardId}`)
  const seed = event.seed
  if (typeof seed !== "object" || seed === null) throw new Error("控制通道 ready 缺少装载摘要")
  if (seed.fixtureId !== expected.fixtureId) throw new Error("控制通道 ready 的 fixtureId 不一致")
  if (seed.fixtureHash !== expected.fixtureHash) throw new Error("控制通道 ready 的 fixtureHash 不一致")
  if (seed.sessionId !== expected.sessionId) throw new Error("控制通道 ready 的会话不是 fixture 会话")
  if (seed.messageCount !== expected.messageCount) throw new Error("控制通道 ready 的消息数与 fixture 不一致")
  if (seed.status !== "seeded" && seed.status !== "reused") {
    throw new Error(`控制通道 ready 的装载状态=${String(seed.status)}`)
  }
  if (!Array.isArray(seed.memoryItemIds) || seed.memoryItemIds.length !== expected.memoryItemCount) {
    throw new Error("控制通道 ready 的初始记忆条数与 fixture 不一致")
  }
  if (event.sessionId !== seed.sessionId) throw new Error("控制通道 ready 的活跃会话不是 fixture 会话")
  return seed
}

/** seed.json 是 prepare 写下的装载输入；启动前核对它与 runner.json 仍是同一份。 */
export function validateSeedFile(raw, expected) {
  if (typeof raw !== "object" || raw === null) throw new Error("seed.json 不是对象")
  if (raw.schemaVersion !== 1) throw new Error(`seed.json schemaVersion=${String(raw.schemaVersion)} 不受支持`)
  if (raw.fixtureId !== expected.fixtureId) throw new Error("seed.json 的 fixtureId 与 runner.json 不一致")
  if (raw.fixtureHash !== expected.fixtureHash) throw new Error("seed.json 的 fixtureHash 与 runner.json 不一致")
  const card = raw.card
  if (typeof card !== "object" || card === null) throw new Error("seed.json 缺少 card")
  if (card.name !== expected.cardName) throw new Error("seed.json 的 Card 名称与 runner.json 不一致")
  if (card.activeId !== expected.cardId) throw new Error("seed.json 的 Card id 与 runner.json 不一致")
  const profile = raw.profile
  if (typeof profile !== "object" || profile === null || !("activeId" in profile)) {
    throw new Error("seed.json 缺少 profile.activeId")
  }
  if (profile.activeId !== expected.profileId) throw new Error("seed.json 的 Profile 与 runner.json 不一致")
  const fixture = raw.fixture
  if (typeof fixture !== "object" || fixture === null) throw new Error("seed.json 缺少 fixture")
  if (fixture.fixtureId !== expected.fixtureId) throw new Error("seed.json 的 fixture.fixtureId 不一致")
  const session = fixture.initialSession
  if (typeof session !== "object" || session === null || !Array.isArray(session.messages)) {
    throw new Error("seed.json 缺少 fixture.initialSession.messages")
  }
  if (session.id !== expected.sessionId) throw new Error("seed.json 的初始会话与 runner.json 不一致")
  if (session.messages.length !== expected.messageCount) throw new Error("seed.json 的消息数与 runner.json 不一致")
  const memory = fixture.initialMemory ?? []
  if (!Array.isArray(memory) || memory.length !== expected.memoryItemCount) {
    throw new Error("seed.json 的初始记忆数与 runner.json 不一致")
  }
  if (hashCanonical(fixture) !== expected.fixtureHash) {
    throw new Error("seed.json 的 fixture 内容与 runner.json 记录的 fixtureHash 不一致")
  }
  return raw
}

export function validateSeedReport(raw, expected) {
  if (typeof raw !== "object" || raw === null) throw new Error("seed-report.json 不是对象")
  if (raw.schemaVersion !== 1) throw new Error(`seed-report.json schemaVersion=${String(raw.schemaVersion)} 不受支持`)
  if (raw.status !== "seeded") throw new Error(`seed-report.json status=${String(raw.status)}，期望 seeded`)
  if (raw.fixtureId !== expected.fixtureId) throw new Error("seed-report 的 fixtureId 不一致")
  if (raw.fixtureHash !== expected.fixtureHash) throw new Error("seed-report 的 fixtureHash 不一致")
  if (raw.sessionId !== expected.sessionId) throw new Error("seed-report 的会话与 fixture 不一致")
  if (raw.generation !== expected.generation) throw new Error("seed-report 的 generation 与本次宿主不一致")
  if (raw.hostPid !== expected.hostPid) throw new Error("seed-report 的 hostPid 与本次宿主不一致")
  if (raw.messageCount !== expected.messageCount) throw new Error("seed-report 的消息数与 fixture 不一致")
  if (raw.userMessageCount !== expected.userMessageCount) throw new Error("seed-report 的用户消息数与 fixture 不一致")
  if (raw.sourceCount !== expected.userMessageCount) throw new Error("seed-report 的来源数与用户消息数不一致")
  if (!Number.isInteger(raw.revision) || raw.revision < 0) throw new Error("seed-report 字段 revision 非法")
  if (!Array.isArray(raw.memoryKeys) || raw.memoryKeys.length !== expected.memoryItemCount) {
    throw new Error("seed-report 的初始记忆键数与 fixture 不一致")
  }
  if (!Array.isArray(raw.memoryItemIds) || raw.memoryItemIds.length !== expected.memoryItemCount) {
    throw new Error("seed-report 的初始记忆条数与 fixture 不一致")
  }
  return raw
}

export function readJsonl(text) {
  return text.split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

export function latestBridgeReady(events) {
  return [...events].reverse().find(event => event?.type === "ready")
}

// ── 文件 / 进程辅助 ──

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    if (error instanceof SyntaxError) throw new Error(`不是合法 JSON：${path}`)
    throw error
  }
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tailFile(path, lines = 40) {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return ""
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options })
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）`)
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await sleep(POLL_MS)
  }
  throw new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）`)
}

function statePaths(runDir) {
  const dataRoot = join(runDir, "data")
  const controlDir = join(dataRoot, "logs", "sim", "control")
  return {
    dataRoot,
    controlDir,
    statePath: join(runDir, RUNNER_STATE_FILE),
    readyPath: join(runDir, "ready.json"),
    stopPath: join(runDir, "stop.request"),
    seedPath: join(runDir, "seed.json"),
    seedReportPath: join(runDir, "seed-report.json"),
    hostLogPath: join(runDir, "host.log"),
    outboxPath: join(controlDir, "outbox.jsonl"),
    configPath: join(dataRoot, "settings", "CONFIG.yaml"),
  }
}

function loadState(runId) {
  const runDir = runDirFor(runId)
  const paths = statePaths(runDir)
  const state = readJsonIfExists(paths.statePath)
  if (!state) throw new Error(`运行 ${runId} 还没有 prepare（缺少 ${paths.statePath}）`)
  if (state.schemaVersion !== RUNNER_STATE_SCHEMA_VERSION) {
    throw new Error(`runner.json schemaVersion=${String(state.schemaVersion)} 不受支持`)
  }
  if (state.runId !== runId) throw new Error(`runner.json 的 runId=${String(state.runId)} 与参数不一致`)
  return { runDir, paths, state }
}

function updateState(paths, state, patch) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() })
  writeJsonAtomic(paths.statePath, state)
  return state
}

function hostEnv(runDir, controlDir) {
  return {
    ...process.env,
    DESKPET_SIM_EVAL: "1",
    DESKPET_SIM_EVAL_RUN_DIR: runDir,
    DESKPET_SIM_CHAT: "1",
    DESKPET_SIM_CONTROL: controlDir,
  }
}

// ── prepare ──

function resolveCard({ meta, cardPath, fixture }) {
  if (!meta.id || meta.id === "unknown") throw new Error(`Card 缺少有效 id：${cardPath}`)
  if (meta.name !== fixture.card) {
    throw new Error(`Card 名称与 fixture 不一致：Card="${meta.name}"，fixture="${fixture.card}"`)
  }
  return {
    name: meta.name,
    id: meta.id,
    fileName: `${safeCardFileName(meta.id)}.md`,
    sourcePath: cardPath,
  }
}

function resolveProfile({ fixture, repoRoot }) {
  if (fixture.profile === "default") return null
  const manifest = join(repoRoot, "resources", "defaults", "profiles", fixture.profile, "profile.yaml")
  if (!existsSync(manifest)) {
    throw new Error(`fixture 要求的 Profile 不在随包资源里：${fixture.profile}（缺少 ${manifest}）`)
  }
  return fixture.profile
}

function stageEvalModels({ repoRoot, dataRoot }) {
  const staged = []
  for (const [name, required] of [["eval-models.json", true], ["eval-models.local.json", false]]) {
    const source = join(repoRoot, "test", name)
    if (!existsSync(source)) {
      if (required) console.warn(`[prepare] ${name} 不存在；被测模型将继承隔离副本配置`)
      continue
    }
    copyFileSync(source, join(dataRoot, name))
    staged.push(name)
  }
  return staged
}

async function prepare(options) {
  const repoRoot = REPO_ROOT
  if (!options.caseId) throw new Error("prepare 缺少 --case <caseId>")
  if (!options.card) throw new Error("prepare 缺少 --card <path>（fixture 需要的 Card 不被仓库跟踪）")
  const runId = options.runId ? validateRunId(options.runId) : makeRunId()
  const runDir = runDirFor(runId, repoRoot)
  if (existsSync(runDir)) {
    throw new Error(`运行根已存在，拒绝覆盖：${relative(repoRoot, runDir)}；请换 --run-id 或先确认并手动清理`)
  }

  const dataset = loadDataset({ repoRoot })
  if (dataset.errors.length > 0) {
    for (const problem of dataset.errors) {
      console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`)
    }
    throw new Error(`数据集有 ${dataset.errors.length} 个错误；prepare 不带着坏数据启动`)
  }
  const entry = dataset.cases.find(candidate => candidate.caseId === options.caseId)
  if (!entry) {
    throw new Error(`找不到用例：${options.caseId}；可用：${dataset.cases.map(candidate => candidate.caseId).join(", ") || "（无）"}`)
  }
  if (entry.fixture.loading?.mode !== "direct-seed") {
    throw new Error(`fixture.loading.mode=${String(entry.fixture.loading?.mode)}，本运行器只支持 direct-seed`)
  }

  const cardPath = resolve(options.card)
  if (!existsSync(cardPath)) throw new Error(`Card 文件不存在：${cardPath}`)
  const cardText = readFileSync(cardPath, "utf8")
  const meta = parseCardMeta(cardText)
  const card = resolveCard({ meta, cardPath, fixture: entry.fixture })
  const profileId = resolveProfile({ fixture: entry.fixture, repoRoot })

  const paths = statePaths(runDir)
  mkdirSync(join(paths.dataRoot, "settings"), { recursive: true })
  mkdirSync(join(paths.dataRoot, "personality", "cards"), { recursive: true })
  mkdirSync(paths.controlDir, { recursive: true })

  const configText = buildSyntheticConfig({
    repoRoot,
    overrides: buildRunOverrides({ cardId: card.id, profileId }),
  })
  writeSyntheticConfig(paths.dataRoot, configText)
  const stagedCardPath = join(paths.dataRoot, "personality", "cards", card.fileName)
  writeFileSync(stagedCardPath, cardText)
  const stagedModels = stageEvalModels({ repoRoot, dataRoot: paths.dataRoot })

  writeJsonAtomic(paths.seedPath, {
    schemaVersion: 1,
    fixtureId: entry.fixture.fixtureId,
    fixtureHash: entry.binding.fixtureHash,
    card: { name: card.name, activeId: card.id },
    profile: { activeId: profileId },
    fixture: entry.fixture,
  })

  const fixtureMessages = entry.fixture.initialSession.messages
  const expectedSeed = {
    sessionId: entry.fixture.initialSession.id,
    messageCount: fixtureMessages.length,
    userMessageCount: fixtureMessages.filter(message => message.role === "user").length,
    memoryItemCount: entry.fixture.initialMemory?.length ?? 0,
  }

  const now = new Date().toISOString()
  const state = {
    schemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    runId,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    caseId: entry.caseId,
    suiteId: entry.suiteId,
    label: entry.label,
    hashes: entry.binding,
    fixture: { id: entry.fixture.fixtureId, path: entry.fixturePath, hash: entry.binding.fixtureHash },
    expectedSeed,
    card: { ...card, sha256: sha256(cardText), stagedPath: relative(repoRoot, stagedCardPath) },
    profile: { activeId: profileId },
    runDir,
    dataRoot: paths.dataRoot,
    configPath: paths.configPath,
    controlDir: paths.controlDir,
    seedPath: paths.seedPath,
    seedReportPath: paths.seedReportPath,
    readyPath: paths.readyPath,
    stopPath: paths.stopPath,
    hostLogPath: paths.hostLogPath,
    stagedModels,
    hostPid: null,
    generation: null,
    hostStartedAt: null,
    bridgeReadyAt: null,
    stoppedAt: null,
    seed: null,
    lastError: null,
  }
  writeJsonAtomic(paths.statePath, state)

  console.log([
    `prepared ${runId}`,
    `  case: ${entry.caseId} (${entry.label.tier}/${entry.label.status}) specHash=${entry.binding.specHash}`,
    `  run: ${relative(repoRoot, runDir)}`,
    `  config: ${relative(repoRoot, paths.configPath)}`,
    `  card: ${card.name} (id=${card.id}, file=${card.fileName})`,
    `  profile: ${profileId ?? "继承 CONFIG 默认"}`,
    `  seed: ${expectedSeed.messageCount} 条消息 / ${expectedSeed.userMessageCount} 条用户来源 / ${expectedSeed.memoryItemCount} 条初始记忆`,
    `  eval-models: ${stagedModels.length > 0 ? stagedModels.join(", ") : "未 stage（全部继承）"}`,
    `next: node scripts/sim-eval-run.mjs start --run-id ${runId}`,
  ].join("\n"))
}

// ── start ──

function assertStartable(state, paths) {
  for (const [label, path] of [["ready.json", paths.readyPath], ["stop.request", paths.stopPath], ["seed-report.json", paths.seedReportPath]]) {
    if (existsSync(path)) throw new Error(`运行根已有 ${label}；拒绝再次启动（证据保留，请换新的 run-id）`)
  }
  if (state.status === "prepared") return
  if (state.status === "failed" && state.hostPid === null) return
  throw new Error(`运行状态 ${state.status} 不允许重新启动；请换新的 run-id`)
}

async function start(runId) {
  const { runDir, paths, state } = loadState(runId)
  assertStartable(state, paths)
  for (const [label, path] of [["CONFIG", paths.configPath], ["seed.json", paths.seedPath]]) {
    if (!existsSync(path)) throw new Error(`prepare 不完整：缺少 ${label}（${path}）`)
  }
  const stagedCardPath = join(REPO_ROOT, state.card.stagedPath)
  if (!existsSync(stagedCardPath)) throw new Error(`prepare 不完整：缺少 Card（${stagedCardPath}）`)
  validateSeedFile(readJsonIfExists(paths.seedPath), {
    fixtureId: state.fixture.id,
    fixtureHash: state.fixture.hash,
    cardName: state.card.name,
    cardId: state.card.id,
    profileId: state.profile.activeId,
    ...state.expectedSeed,
  })

  updateState(paths, state, { status: "starting", hostPid: null, lastError: null })

  let child
  try {
    console.log("[start] 暂存随包资源（dev:prepare）")
    runChecked("pnpm", ["run", "dev:prepare"], IS_WINDOWS ? { shell: true } : {})
    console.log("[start] 构建 debug 原生宿主")
    const binary = buildNativeHost()

    const fd = openSync(paths.hostLogPath, "a")
    try {
      child = spawn(binary, [], {
        cwd: REPO_ROOT,
        env: hostEnv(runDir, paths.controlDir),
        stdio: ["ignore", fd, fd],
        detached: true,
        windowsHide: true,
      })
    } finally {
      closeSync(fd)
    }
    if (!child.pid) throw new Error("原生宿主没有返回 pid")
    child.unref()
    updateState(paths, state, {
      status: "starting",
      hostPid: child.pid,
      hostStartedAt: new Date().toISOString(),
    })

    const ready = await waitFor("宿主 ready", READY_WAIT_MS, () => {
      if (!isAlive(child.pid)) {
        const tail = tailFile(paths.hostLogPath)
        throw new Error(`宿主在 ready 前退出（pid=${child.pid}）${tail ? `\n${tail}` : ""}`)
      }
      const raw = readJsonIfExists(paths.readyPath)
      return raw ? validateHostReady(raw, { runDir, pid: child.pid }) : undefined
    })
    updateState(paths, state, { generation: ready.generation })

    const expected = {
      generation: ready.generation,
      hostPid: child.pid,
      runDir,
      cardId: state.card.id,
      fixtureId: state.fixture.id,
      fixtureHash: state.fixture.hash,
      sessionId: state.expectedSeed.sessionId,
      messageCount: state.expectedSeed.messageCount,
      userMessageCount: state.expectedSeed.userMessageCount,
      memoryItemCount: state.expectedSeed.memoryItemCount,
    }
    const bridgeReady = await waitFor("控制通道 ready", BRIDGE_WAIT_MS, () => {
      if (!isAlive(child.pid)) {
        const tail = tailFile(paths.hostLogPath)
        throw new Error(`宿主在控制通道 ready 前退出（pid=${child.pid}）${tail ? `\n${tail}` : ""}`)
      }
      let text
      try { text = readFileSync(paths.outboxPath, "utf8") } catch (error) {
        if (error?.code === "ENOENT") return undefined
        throw error
      }
      const event = latestBridgeReady(readJsonl(text))
      return event ? assertBridgeReady(event, expected) : undefined
    })

    const report = await waitFor("seed-report.json", 10_000, () => {
      const raw = readJsonIfExists(paths.seedReportPath)
      return raw ? validateSeedReport(raw, expected) : undefined
    })

    updateState(paths, state, {
      status: "running",
      bridgeReadyAt: new Date().toISOString(),
      seed: {
        fixtureId: bridgeReady.fixtureId,
        fixtureHash: bridgeReady.fixtureHash,
        sessionId: bridgeReady.sessionId,
        messageCount: bridgeReady.messageCount,
        memoryItemIds: bridgeReady.memoryItemIds,
        status: bridgeReady.status,
        seededAt: report.seededAt,
      },
    })

    console.log([
      `running ${runId}`,
      `  host: pid=${child.pid} generation=${ready.generation}`,
      `  session: ${bridgeReady.sessionId}`,
      `  seed: ${bridgeReady.messageCount} 条消息 / ${report.sourceCount} 条来源 / ${bridgeReady.memoryItemIds.length} 条记忆 (${bridgeReady.status})`,
      `  control: ${paths.controlDir}`,
      `  chat: DESKPET_SIM_CONTROL=${JSON.stringify(paths.controlDir)} node scripts/desk-pet-chat.mjs ready`,
      `  stop: node scripts/sim-eval-run.mjs stop --run-id ${runId}`,
    ].join("\n"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { writeFileSync(paths.stopPath, `${new Date().toISOString()} ${message}\n`) } catch { /* 停不下来时保留原始错误 */ }
    const pid = child?.pid ?? state.hostPid
    if (pid) await waitForStopQuiet(pid, paths, STOP_WAIT_MS)
    updateState(paths, state, { status: "failed", lastError: message, stoppedAt: new Date().toISOString() })
    throw error
  }
}

async function waitForStopQuiet(pid, paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid) && !existsSync(paths.readyPath)) return true
    await sleep(POLL_MS)
  }
  console.warn(`[start] 宿主 pid=${pid} 在 ${Math.round(timeoutMs / 1000)}s 内未退出；未发送信号，证据保留`)
  return false
}

// ── stop ──

function writeStopRequest(paths, reason) {
  if (existsSync(paths.stopPath)) return false
  writeFileSync(paths.stopPath, `${new Date().toISOString()} ${reason}\n`)
  return true
}

async function stop(runId) {
  const { paths, state } = loadState(runId)
  const ready = readJsonIfExists(paths.readyPath)
  if (ready) validateHostReady(ready, { runDir: state.runDir, pid: ready.pid })
  if (ready && state.hostPid && ready.pid !== state.hostPid) {
    throw new Error(`ready.json pid=${ready.pid} 与 runner.json hostPid=${state.hostPid} 不一致`)
  }
  const pid = state.hostPid ?? ready?.pid ?? null

  if (!pid) {
    if (state.status !== "stopped") updateState(paths, state, { status: "stopped", stoppedAt: new Date().toISOString() })
    console.log(`${runId} 没有启动过宿主，无需停止`)
    return
  }

  if (!isAlive(pid)) {
    if (ready) {
      throw new Error(`宿主 pid=${pid} 已退出但 ready.json 还在；这是异常现场，不自动删除（请人工核对）`)
    }
    if (state.status !== "stopped") updateState(paths, state, { status: "stopped", stoppedAt: new Date().toISOString() })
    console.log(`${runId} 已停止（pid=${pid} 不存在）`)
    return
  }

  if (writeStopRequest(paths, "runner stop")) console.log(`${runId} 写入 stop.request，等待统一退出序列`)
  else console.log(`${runId} stop.request 已存在，继续等待退出`)
  const stopped = await waitForStopQuiet(pid, paths, STOP_WAIT_MS)
  if (!stopped) throw new Error(`宿主 pid=${pid} 在 ${Math.round(STOP_WAIT_MS / 1000)}s 内未停止；未发送信号`)
  updateState(paths, state, { status: "stopped", stoppedAt: new Date().toISOString() })
  console.log(`${runId} 已停止（pid=${pid}）`)
}

// ── status ──

function status(runId) {
  const { paths, state } = loadState(runId)
  const ready = readJsonIfExists(paths.readyPath)
  let readyError = null
  if (ready) {
    try { validateHostReady(ready, { runDir: state.runDir, pid: ready.pid }) } catch (error) { readyError = error.message }
  }
  const pid = state.hostPid ?? ready?.pid ?? null
  const alive = pid !== null && isAlive(pid)

  let bridge = null
  try {
    const event = latestBridgeReady(readJsonl(readFileSync(paths.outboxPath, "utf8")))
    if (event) {
      try {
        assertBridgeReady(event, {
          generation: ready?.generation ?? state.generation,
          hostPid: pid,
          runDir: state.runDir,
          cardId: state.card.id,
          fixtureId: state.fixture.id,
          fixtureHash: state.fixture.hash,
          ...state.expectedSeed,
        })
        bridge = { ready: true, sessionId: event.sessionId, cardId: event.cardId, seed: event.seed }
      } catch (error) {
        bridge = { ready: false, error: error.message, sessionId: event.sessionId ?? null }
      }
    }
  } catch (error) {
    bridge = { ready: false, error: error.message }
  }

  let seedReport = null
  let rawReport = null
  try {
    rawReport = readJsonIfExists(paths.seedReportPath)
  } catch (error) {
    seedReport = { ok: false, error: error.message }
  }
  if (rawReport) {
    try {
      validateSeedReport(rawReport, {
        fixtureId: state.fixture.id,
        fixtureHash: state.fixture.hash,
        generation: ready?.generation ?? state.generation,
        hostPid: pid,
        ...state.expectedSeed,
      })
      seedReport = { ok: true, sessionId: rawReport.sessionId, messageCount: rawReport.messageCount, memoryItemIds: rawReport.memoryItemIds }
    } catch (error) {
      seedReport = { ok: false, error: error.message }
    }
  }

  let phase
  if (state.status === "stopped") phase = "stopped"
  else if (ready && alive) phase = bridge?.ready ? "running" : "starting"
  else if (ready && !alive) phase = "crashed"
  else if (pid !== null && alive) phase = "starting"
  else if (pid !== null && !alive) phase = "crashed"
  else if (state.status === "failed") phase = "failed"
  else phase = "prepared"

  console.log(JSON.stringify({
    runId,
    phase,
    state: state.status,
    caseId: state.caseId,
    label: state.label,
    specHash: state.hashes.specHash,
    runDir: relative(REPO_ROOT, state.runDir),
    host: { pid, alive, ready: Boolean(ready), readyError, generation: ready?.generation ?? state.generation },
    bridge,
    seedReport,
    controlDir: state.controlDir,
    hostLog: relative(REPO_ROOT, paths.hostLogPath),
    lastError: state.lastError,
  }, null, 2))
}

// ── CLI ──

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--case" || arg === "--card" || arg === "--run-id") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`)
      options[arg === "--case" ? "caseId" : arg === "--card" ? "card" : "runId"] = value
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = [
  "用法：",
  "  node scripts/sim-eval-run.mjs prepare --case <caseId> --card <card.md> [--run-id <id>]",
  "  node scripts/sim-eval-run.mjs start --run-id <id>",
  "  node scripts/sim-eval-run.mjs status --run-id <id>",
  "  node scripts/sim-eval-run.mjs stop --run-id <id>",
].join("\n")

async function main(argv) {
  const [command, ...rest] = argv
  if (!command) {
    console.log(USAGE)
    process.exitCode = 1
    return
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE)
    return
  }
  const options = parseArgs(rest)
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (command === "prepare") return prepare(options)
  const runId = options.runId
  if (!runId) throw new Error(`${command} 缺少 --run-id <id>`)
  validateRunId(runId)
  if (command === "start") return start(runId)
  if (command === "status") return status(runId)
  if (command === "stop") return stop(runId)
  throw new Error(`未知命令：${command}\n${USAGE}`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
