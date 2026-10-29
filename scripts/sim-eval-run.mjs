#!/usr/bin/env node
/**
 * 聊天评测运行器（W2 隔离运行 / W3 采集封存 / W4 独立 judge 判分 / W5 固定时钟与驱动）：
 * 准备隔离根、拉起 debug 宿主、核对所有权与装载报告、按用例驱动步骤执行、封存证据，
 * 并在封存后冻结判分包、校验独立 coding-agent judge 的回填裁决、追加密封判分记录并生成同源报告。
 *
 * 用法：
 *   node scripts/sim-eval-run.mjs prepare --case <caseId> --card <card.md> --authorization <auth.json>
 *       [--run-id <id>] [--evaluation-run-id <id>] [--trial-id <id>] [--baseline <evaluationRunId>]
 *   node scripts/sim-eval-run.mjs prepare --repair-of <runId> [--run-id <id>] [--trial-id <id>]
 *   node scripts/sim-eval-run.mjs start --run-id <id>
 *   node scripts/sim-eval-run.mjs drive --run-id <id>
 *   node scripts/sim-eval-run.mjs status --run-id <id>
 *   node scripts/sim-eval-run.mjs finish --run-id <id> [--interrupted --reason <text>]
 *   node scripts/sim-eval-run.mjs batch --case <caseId> --card <card.md> --authorization <auth.json>
 *       [--trials <n>] [--evaluation-run-id <id>] [--baseline <evaluationRunId>]
 *   node scripts/sim-eval-run.mjs compare --run-id <id> [--baseline <evaluationRunId>] [--json]
 *   node scripts/sim-eval-run.mjs holdout --case <caseId> [--json]
 *   node scripts/sim-eval-run.mjs judge prepare --run-id <id> [--attempt-id <id>] [--json]
 *   node scripts/sim-eval-run.mjs judge view --run-id <id> [--packet-id <id>] [--json]
 *   node scripts/sim-eval-run.mjs judge apply --run-id <id> --verdicts <file.json> [--json]
 *   node scripts/sim-eval-run.mjs review show --run-id <id> [--attempt-id <id>] [--json]
 *   node scripts/sim-eval-run.mjs review spotcheck --run-id <id> --checks <file.json>
 *       [--reviewer-name <name>] [--notes <text>] [--json]
 *   node scripts/sim-eval-run.mjs report --run-id <id> [--json]
 *   node scripts/sim-eval-run.mjs stop --run-id <id>
 *   node scripts/sim-eval-run.mjs rescue --run-id <id> [--reason <text>]
 *
 * 只有一个宿主能拥有运行根：prepare 建根并写入合成 CONFIG / Card / seed.json / clock.json /
 * authorization.json / driver-package.json，start 拉起 `DESKPET_SIM_EVAL=1` 的 debug 宿主并等待
 * ready、控制通道 ready 与 seed-report，然后建立 attempt 并开始 trace 采集；drive 按驱动包逐步
 * 推进固定时钟、发送用户消息并等待检查点，进度写 driver-progress.json（可续跑，in-flight 不重放）；
 * finish 按驱动结果结束试次、收口采集、写对话证据、封存 attempt 并生成同源报告；batch 先冻结
 * trials.json 再串行执行多个独立试次（每个试次独立运行根与 attempt，失败占位不替换）；
 * judge prepare 只冻结判分包，judge view 只从已冻结判分包派生按取证窗口精简的读取件（判定字段
 * 原样继承，权威仍是原 packet 哈希），judge apply 只校验并记录外部 coding-agent judge 的裁决；review spotcheck 只记录
 * 用户本人的可选抽查；compare 只比较两次运行的固定条件；holdout 只报告留出用例的使用记录；
 * stop 只写 `stop.request`，宿主自己走产品退出序列并留下 exit.json；宿主没走完退出序列时
 * rescue 把已落盘的草稿按中断封存（不冒充完成），让证据有终点、repair 可继续。
 *
 * 本文件是开发工具（Node 脚本），不进产品构建；纯校验函数导出给 L2 单测。
 * 不读取真实 CONFIG、凭据或用户数据：Card 由调用方显式给出，凭据只 stage
 * `test/eval-models.local.json`（若存在）供运行期消费；证据只记录凭据哈希。
 * 运行器自身不调用任何模型 API，也不读取 judge 凭据；授权文件只描述范围与预算。
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { load as parseYaml } from "js-yaml"

import { buildSyntheticConfig, writeSyntheticConfig } from "../test/host/native/synthetic-config.mjs"
import { buildNativeHost } from "../test/host/native/build.mjs"
import { stageExternalAssets } from "../test/sim/desk-pet-chat/external/assets.mjs"
import { MEMORYARENA_CONFIGS } from "../test/sim/desk-pet-chat/external/memoryarena.mjs"
import {
  buildDriverPackage, datasetInputHash, hashCanonical, loadDataset, MANUAL_TRIGGER_HOST_METHODS,
} from "../test/sim/desk-pet-chat/dataset.mjs"
import {
  beginChatAttempt, CHAT_GRADER_VERSION, copyArtifact, createDialogueWriter, ensureChatRun, ensureTrialPlan,
  extendChatAttemptSessions, listAttemptIds, listChatRuns, readChatRun, readChatRunEvidence, readChatWorkflow,
  readTrialPlan, sealChatAttempt, setChatRunPhase, verifySealedAttempt,
} from "../test/sim/desk-pet-chat/evidence.mjs"
import {
  applyJudgeVerdicts, formatJudgePacket, JUDGE_PROMPT_VERSION, JUDGE_RUBRIC_VERSION, latestJudgeGrade,
  latestJudgePacket, loadJudgingContext, prepareJudgePacket, projectJudgeView, readJudgePacket,
  readJudgingRecords, recordSpotCheck, summarizeAttemptStatus,
} from "../test/sim/desk-pet-chat/judging.mjs"
import { pruneChatRuns, writeChatReport } from "../test/sim/desk-pet-chat/report.mjs"
import {
  assertRepairAllowed, authorizationFingerprint, authorizeRequestedModels,
  buildClockFile, compareRunConditions, conditionsFromRun, createDriverProgress,
  driverOutcome, driverSummary, executeDriver, holdoutUsage, readDriverProgress, validateAuthorization,
  validateClockFile, validateDriverPackage, validateSyncPoints,
} from "../test/sim/desk-pet-chat/workflow.mjs"

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const RUNS_BASE = join(REPO_ROOT, "test", ".tmp")
const RUN_DIR_PREFIX = "sim-eval-"
const RUNNER_STATE_FILE = "runner.json"
const CHAT_REPORTS_DIR = join(REPO_ROOT, "test", "reports", "chat")
const NODE_RUNTIME_FILE = join(REPO_ROOT, "packaging", "node-runtime.json")
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const EVALUATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TRIAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SUPPORTED_HOST_CAPABILITIES = new Set(["chat", "memory", "session", "tools"])
const READY_WAIT_MS = 90_000
const BRIDGE_WAIT_MS = 180_000
const CAPTURE_WAIT_MS = 180_000
const DRIVER_MESSAGE_WAIT_MS = 600_000
const SEED_REPORT_WAIT_MS = 10_000
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

/**
 * `exit.json` 是宿主统一退出序列的证明：绑定本次 pid，如实携带 flush 结果。
 * 缺文件、强杀或 flush 未完成都不能当成干净退出。
 */
export function validateHostExit(raw, { hostPid = null } = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("exit.json 不是对象")
  if (raw.schemaVersion !== RUNNER_STATE_SCHEMA_VERSION) {
    throw new Error(`exit.json schemaVersion=${String(raw.schemaVersion)} 不受支持`)
  }
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) throw new Error(`exit.json pid 不合法：${String(raw.pid)}`)
  if (hostPid !== null && raw.pid !== hostPid) {
    throw new Error(`exit.json pid=${raw.pid} 与 runner.json hostPid=${hostPid} 不一致`)
  }
  if (typeof raw.exitedAt !== "string" || Number.isNaN(Date.parse(raw.exitedAt))) {
    throw new Error(`exit.json exitedAt 不是 ISO 时间：${String(raw.exitedAt)}`)
  }
  if (raw.flush !== null) {
    if (typeof raw.flush !== "object" || Array.isArray(raw.flush)) throw new Error("exit.json flush 必须是对象或 null")
    if (typeof raw.flush.flushed !== "boolean") throw new Error("exit.json flush.flushed 必须是布尔值")
    if (!Number.isInteger(raw.flush.pending) || raw.flush.pending < 0) {
      throw new Error("exit.json flush.pending 必须是非负整数")
    }
    if (raw.flush.detail !== undefined && raw.flush.detail !== null && typeof raw.flush.detail !== "string") {
      throw new Error("exit.json flush.detail 必须是字符串或 null")
    }
  }
  if (typeof raw.interrupted !== "boolean") throw new Error("exit.json interrupted 必须是布尔值")
  if (typeof raw.forcedKill !== "boolean") throw new Error("exit.json forcedKill 必须是布尔值")
  if (typeof raw.detail !== "string") throw new Error("exit.json detail 必须是字符串")
  return {
    schemaVersion: raw.schemaVersion,
    pid: raw.pid,
    exitedAt: raw.exitedAt,
    flush: raw.flush
      ? { flushed: raw.flush.flushed, pending: raw.flush.pending, detail: raw.flush.detail ?? null }
      : null,
    interrupted: raw.interrupted,
    forcedKill: raw.forcedKill,
    detail: raw.detail,
  }
}

export function hostExitProblems(exit) {
  if (!exit) return ["宿主没有写出 exit.json（可能不是产品退出或被强杀）；无法核对关停 flush"]
  const problems = []
  if (!exit.flush) problems.push("宿主关停未收到 Node flush 报告")
  else if (!exit.flush.flushed) problems.push(`Node flush 未完成（pending=${exit.flush.pending}）：${exit.flush.detail ?? "无详情"}`)
  if (exit.interrupted) problems.push("宿主关停被标记为中断")
  if (exit.forcedKill) problems.push("宿主走了强杀路径")
  return problems
}

function readHostExit(path, { hostPid = null } = {}) {
  const raw = readJsonIfExists(path)
  return raw ? validateHostExit(raw, { hostPid }) : null
}

/** 读取并归一化关停证据；记录损坏也算证据问题，不让读取错误盖住关停收口失败。 */
function hostExitEvidence(path, hostPid) {
  let exit = null
  try {
    exit = readHostExit(path, { hostPid })
  } catch (error) {
    return { exit: null, problems: [`exit.json 不可用：${messageOf(error)}`] }
  }
  return { exit, problems: hostExitProblems(exit) }
}

/** 证据目录名与 attempt 绑定共用同一套字符集；点号只用于版本化运行 id。 */
export function validateEvaluationRunId(value) {
  if (typeof value !== "string" || !EVALUATION_ID_PATTERN.test(value)) {
    throw new Error(`evaluation-run-id 不合法（只允许 a-z0-9._-，且以 a-z0-9 开头、最长 64）：${String(value)}`)
  }
  return value
}

export function validateTrialId(value) {
  if (typeof value !== "string" || !TRIAL_ID_PATTERN.test(value)) {
    throw new Error(`trial-id 不合法（只允许 a-z0-9._-，且以 a-z0-9 开头、最长 96）：${String(value)}`)
  }
  return value
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
 * 运行期 CONFIG 覆盖：激活目标 Card / Profile，并关掉主动、静默了解与拟人化。
 * 自动记忆整理（dreaming）保持开启 —— 纠正轮的自动抽取是 case 的真实链路。
 * 拟人化默认关闭（2026-10-28 用户裁定）：分泡与标点清洗改写的是展示文本，
 * 会让「不超过 N 句」这类句数／长度观感偏离模型原样，判分读到的也就不是模型本身；
 * 需要测拟人化链路时用 `--humanizer` 显式打开。
 */
export function buildRunOverrides({ cardId, profileId, mcpServers, turnTimeoutMs, humanizerEnabled = false }) {
  if (typeof cardId !== "string" || cardId.trim() === "") throw new Error("覆盖缺少 Card id")
  return {
    ai: {
      personality: { active: cardId },
      proactive: { frequency: "off" },
      silentAccess: { frequency: "off" },
      humanizer: { enabled: humanizerEnabled === true },
      ...(turnTimeoutMs ? { loop: { turnTimeoutMs } } : {}),
    },
    ...(mcpServers ? { tools: { mcp: { servers: mcpServers } } } : {}),
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
  if (expected.clock) {
    const clock = event.clock
    if (typeof clock !== "object" || clock === null) throw new Error("控制通道 ready 缺少固定时钟")
    // 快照把基准归一成 UTC 表示；同一时刻只比较毫秒值，不比较字面偏移写法。
    if (!Number.isFinite(Date.parse(clock.base)) || Date.parse(clock.base) !== Date.parse(expected.clock.base)) {
      throw new Error("控制通道 ready 的时钟基准与运行根不一致")
    }
    if (clock.timezone !== expected.clock.timezone) throw new Error("控制通道 ready 的时钟时区与运行根不一致")
  }
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

function assertCaptureTarget(result, expected, label) {
  if (typeof result !== "object" || result === null) throw new Error(`${label} 缺少 result`)
  if (result.evaluationRunId !== expected.evaluationRunId) {
    throw new Error(`${label} 的 evaluationRunId=${String(result.evaluationRunId)}，期望 ${expected.evaluationRunId}`)
  }
  if (result.attemptId !== expected.attemptId) {
    throw new Error(`${label} 的 attemptId=${String(result.attemptId)}，期望 ${expected.attemptId}`)
  }
  if (typeof result.attemptDir !== "string" || resolve(result.attemptDir) !== resolve(expected.attemptDir)) {
    throw new Error(`${label} 的 attemptDir 与本次 attempt 不一致`)
  }
  return result
}

/** 采集开始快照不完整时禁止继续：后续证据不能建立在漏读的会话/记忆上。 */
export function validateCaptureStarted(event, expected) {
  if (typeof event !== "object" || event === null || event.type !== "capture_started") {
    throw new Error("控制通道没有返回 capture_started")
  }
  const result = assertCaptureTarget(event.result, expected, "capture_started")
  if (result.complete !== true) {
    const issues = Array.isArray(result.issues) ? result.issues : []
    throw new Error(`采集开始快照不完整：${issues.join("；") || "未知原因"}`)
  }
  return result
}

export function validateCaptureTrial(event, expected) {
  if (typeof event !== "object" || event === null || event.type !== "capture_trial") {
    throw new Error(`控制通道没有返回 capture_trial（${expected.phase}）`)
  }
  if (event.phase !== expected.phase) throw new Error(`capture_trial 阶段=${String(event.phase)}，期望 ${expected.phase}`)
  if (event.caseId !== expected.caseId) throw new Error("capture_trial 的 caseId 与本次用例不一致")
  if (event.trialId !== expected.trialId) throw new Error("capture_trial 的 trialId 与本次试次不一致")
  return event
}

/** 收口结果允许 incomplete（由封存显式记录），但必须属于同一 attempt，且带完整对话数组。 */
export function validateCaptureFinished(event, expected) {
  if (typeof event !== "object" || event === null || event.type !== "capture_finished") {
    throw new Error("控制通道没有返回 capture_finished")
  }
  const result = assertCaptureTarget(event.result, expected, "capture_finished")
  if (!Array.isArray(result.dialogue?.messages)) throw new Error("capture_finished 缺少完整对话数组")
  if (!Array.isArray(result.issues)) throw new Error("capture_finished 缺少 issues 数组")
  if (typeof result.complete !== "boolean") throw new Error("capture_finished 缺少 complete 标记")
  return result
}

const MESSAGE_OPERATION_FIELDS = Object.freeze([
  "operationId", "caseId", "trialId", "sessionId", "generation", "stepId",
])

/**
 * 驱动消息回执必须回显本次请求的完整操作身份：operation 六字段与请求逐项一致，
 * requestId 与 operationId 同源，响应会话就是 operation 会话。缺任何一项都不能
 * 把回复记到本步。
 */
export function validateMessageReceipt(event, operation) {
  if (typeof event !== "object" || event === null || event.type !== "message") {
    throw new Error("控制通道没有返回 message 回执")
  }
  const receipt = event.operation
  if (typeof receipt !== "object" || receipt === null) throw new Error("消息回执缺少请求身份 operation")
  for (const field of MESSAGE_OPERATION_FIELDS) {
    if (typeof receipt[field] !== "string" || receipt[field].trim() === "") {
      throw new Error(`消息回执的 operation 缺少 ${field}`)
    }
    if (receipt[field] !== operation?.[field]) {
      throw new Error(`消息回执的 ${field} 与请求不一致`)
    }
  }
  if (event.requestId !== receipt.operationId) {
    throw new Error("消息回执的 requestId 与 operation 不一致")
  }
  if (event.sessionId !== receipt.sessionId) {
    throw new Error("消息回执的 sessionId 与 operation 不一致")
  }
  if (!["succeeded", "queued", "failed"].includes(event.outcome)) {
    throw new Error(`消息回执的 outcome 非法：${String(event.outcome)}`)
  }
  return {
    sessionId: receipt.sessionId,
    reply: typeof event.reply === "string" ? event.reply : "",
    outcome: event.outcome,
    toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls : [],
    requestId: event.requestId,
    operation: Object.fromEntries(MESSAGE_OPERATION_FIELDS.map(field => [field, receipt[field]])),
    ...(typeof event.assistantEntryId === "string" && event.assistantEntryId.trim()
      ? { assistantEntryId: event.assistantEntryId } : {}),
    ...(event.delivery && typeof event.delivery === "object" ? { delivery: event.delivery } : {}),
    ...(event.failure ? { failure: event.failure } : {}),
  }
}

/** 只认主聊天请求的实际响应模型；后台抽取/主动链路不算本试次的被测模型。 */
export function extractActualModels(traceText) {
  const models = new Set()
  for (const line of readJsonl(traceText)) {
    // chunk 里的事件是 TraceRecord（归属字段 + event 正文），不是扁平的运行时事件。
    for (const record of line?.chunk?.events ?? []) {
      const event = record?.event
      if (event?.kind !== "provider_request_end") continue
      const payload = event.payload ?? {}
      if (payload.purpose !== "main") continue
      const model = payload.responseModel
      if (typeof model === "string" && model.trim()) models.add(model.trim())
    }
  }
  return [...models].sort()
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * 输入身份里的 CONFIG 哈希排除 `general.popup.fixedPosition`：宿主退出时会把窗口落点写回同一份
 * 隔离 CONFIG，位置不进入任何回合行为，却会把一次正常采集误判成输入漂移（integrity=inconclusive）。
 * 其余字段（模型、端点、阈值、卡与资源引用等）逐项照常绑定。
 */
export function stableConfigHash(configPath) {
  const config = parseYaml(readFileSync(configPath, "utf8")) ?? {}
  const popup = config?.general?.popup
  if (popup && typeof popup === "object") delete popup.fixedPosition
  return `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`
}

function gitOutput(args, repoRoot = REPO_ROOT) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`git ${args.join(" ")} 失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败（退出码 ${result.status}）：${(result.stderr ?? "").trim()}`)
  return result.stdout
}

/**
 * 源码身份覆盖工作区里所有会被 git 交付的文本：已跟踪 + 未忽略的新文件，
 * 按路径排序后连同内容一起哈希；构建产物、测试运行根和证据目录都被 ignore 排除。
 */
export function computeSourceHash(repoRoot = REPO_ROOT) {
  const files = gitOutput(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], repoRoot)
    .split("\0").filter(Boolean).sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file, "utf8")
    hash.update("\0")
    try {
      hash.update(readFileSync(join(repoRoot, file)))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      hash.update("\0missing\0")
    }
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function gitCommit() {
  const commit = gitOutput(["rev-parse", "HEAD"]).trim()
  if (!commit) throw new Error("git rev-parse HEAD 没有返回提交")
  return commit
}

function gitDirty() {
  return gitOutput(["status", "--porcelain"]).trim() !== ""
}

function nodeRuntimeVersion() {
  const pinned = readJsonIfExists(NODE_RUNTIME_FILE)
  if (typeof pinned?.nodeVersion !== "string" || !pinned.nodeVersion) {
    throw new Error(`随包 Node 版本未登记：${relative(REPO_ROOT, NODE_RUNTIME_FILE)}`)
  }
  return pinned.nodeVersion
}

/** 请求模型取隔离 CONFIG 的最终值（测试侧覆盖已由产品在 init 阶段刷写）；不读取凭据。 */
function readRequestedModel(configPath) {
  const config = parseYaml(readFileSync(configPath, "utf8")) ?? {}
  const provider = config?.ai?.provider
  const model = config?.ai?.model
  if (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim()) {
    throw new Error("隔离 CONFIG 缺少 ai.provider / ai.model，无法记录请求模型身份")
  }
  return `${provider.trim()}/${model.trim()}`
}

function inputHashes({ state }) {
  const dataset = loadDataset({ repoRoot: REPO_ROOT, root: state.datasetRoot, caseIds: [state.caseId] })
  const entry = dataset.cases.find(candidate => candidate.caseId === state.caseId)
  if (!entry) throw new Error(`数据集里找不到用例：${state.caseId}`)
  return {
    datasetHash: datasetInputHash(dataset, entry),
    fixtureHash: entry.binding.fixtureHash,
    cardHash: `sha256:${sha256File(join(REPO_ROOT, state.card.stagedPath))}`,
    configHash: stableConfigHash(state.configPath),
    specHash: state.hashes.specHash,
    contentHash: state.hashes.contentHash,
    driverHash: state.hashes.driverHash,
    oracleHash: state.hashes.oracleHash,
  }
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function nowIso() {
  return new Date().toISOString()
}

/** 控制命令按 id 回读；error 事件立即失败，避免把拒绝当成超时。 */
async function sendBridgeCommand(paths, event, expectedTypes, timeoutMs = CAPTURE_WAIT_MS) {
  const id = `runner-${event.type}-${randomBytes(6).toString("hex")}`
  appendFileSync(paths.inboxPath, `${JSON.stringify({ id, ...event })}\n`)
  return waitFor(`控制通道 ${event.type}`, timeoutMs, () => {
    let text
    try {
      text = readFileSync(paths.outboxPath, "utf8")
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
    const hit = [...readJsonl(text)].reverse().find(candidate =>
      candidate?.id === id && (candidate.type === "error" || expectedTypes.includes(candidate.type)))
    if (!hit) return undefined
    if (hit.type === "error") throw new Error(`控制通道拒绝 ${event.type}：${hit.error ?? "未知错误"}`)
    return hit
  })
}

function assertChatScope(run, state) {
  const cases = Array.isArray(run.scope?.caseIds) ? run.scope.caseIds : []
  const suites = Array.isArray(run.scope?.suiteIds) ? run.scope.suiteIds : []
  if (cases.length > 0 && !cases.includes(state.caseId)) {
    throw new Error(`运行组 ${run.evaluationRunId} 的范围不含用例 ${state.caseId}`)
  }
  if (suites.length > 0 && !suites.includes(state.suiteId)) {
    throw new Error(`运行组 ${run.evaluationRunId} 的范围不含套件 ${state.suiteId}`)
  }
  // 用途与留出标记决定证据能否被当作开发/校准/留出结论，必须与冻结的授权一致。
  if (run.scope?.purpose !== state.authorization.purpose) {
    throw new Error(`运行组用途=${String(run.scope?.purpose)} 与授权用途 ${state.authorization.purpose} 不一致`)
  }
  if (run.scope?.holdout !== state.authorization.holdout) {
    throw new Error("运行组的 holdout 标记与授权不一致")
  }
  if (run.baseline !== undefined && JSON.stringify(run.baseline) !== JSON.stringify(state.baseline)) {
    throw new Error("运行组的 baseline 与本次 prepare 不一致")
  }
}

/** 宿主停止前没有封存时，运行组必须显式 blocked；不得留下看似正常的「运行中」。 */
function markUnsealed(state, reason) {
  const chat = state?.chat
  if (!chat?.runDir || !chat.attemptDir) return false
  if (chat.sealedAt || existsSync(join(chat.attemptDir, "manifest.json"))) return false
  if (!existsSync(join(chat.runDir, "workflow.json"))) return false
  try {
    setChatRunPhase(chat.runDir, {
      phase: "blocked",
      updatedAt: nowIso(),
      nextAction: `采集未封存：${reason}；证据不完整，需重新采集（新 attempt 或新运行组）`,
    })
    return true
  } catch (error) {
    console.warn(`[chat] 标记运行组 blocked 失败：${messageOf(error)}`)
    return false
  }
}

/** attempt 身份绑定实际交付的源码、输入、工具、宿主、预算与驱动包；凭据只以哈希出现。 */
function buildAttemptIdentity(state, entry) {
  return {
    code: { commit: gitCommit(), sourceHash: computeSourceHash(), dirty: gitDirty() },
    inputs: inputHashes({ state }),
    tools: {
      driverVersion: entry.binding.driverHash,
      rubricVersion: JUDGE_RUBRIC_VERSION,
      graderVersion: CHAT_GRADER_VERSION,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
    },
    host: { mode: "full-desktop", capabilities: [...entry.case.precondition.hostCapabilities] },
    platform: { os: process.platform, arch: process.arch },
    runtime: { version: nodeRuntimeVersion() },
    models: { requested: readRequestedModel(state.configPath) },
    budget: { ...state.authorization.budget },
    authorization: {
      fingerprint: state.authorization.fingerprint,
      approvedBy: state.authorization.approvedBy,
      approvedAt: state.authorization.approvedAt,
    },
    clock: { base: state.clock.base, timezone: state.clock.timezone },
    driver: { hash: state.hashes.driverHash, steps: state.driver.steps, checkpoints: state.driver.checkpoints },
    repair: state.repair,
  }
}

/** 授权文件只描述范围与预算；读取后按当前用例与套件用途重新校验，不信任 runner.json。 */
function readAuthorizationFile(path, context) {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`授权文件不存在：${resolved}`)
  let raw
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"))
  } catch (error) {
    throw new Error(`授权文件不是合法 JSON：${messageOf(error)}`)
  }
  return validateAuthorization(raw, context)
}

function readDriverPackageFile(path, state) {
  const raw = readJsonIfExists(path)
  if (!raw) throw new Error(`驱动包不存在：${path}`)
  const driverPackage = validateDriverPackage(raw)
  if (driverPackage.caseId !== state.caseId) throw new Error("驱动包的 caseId 与运行不一致")
  if (driverPackage.specHash !== state.hashes.specHash) throw new Error("驱动包的 specHash 与运行不一致")
  if (hashCanonical({ userRole: driverPackage.userRole, driver: driverPackage.driver }) !== state.hashes.driverHash) {
    throw new Error("驱动包内容与 prepare 记录的 driverHash 不一致")
  }
  return driverPackage
}

/** 驱动检查点只属于编排侧：每个 after 必须对应驱动步骤，未知引用在 prepare 就失败。 */
function validateCheckpointBindings(syncPoints, driverPackage) {
  const stepIds = new Set(driverPackage.driver.map(step => step.id))
  for (const point of syncPoints) {
    if (!stepIds.has(point.after)) throw new Error(`检查点 ${point.id} 的 after=${point.after} 不对应任何驱动步骤`)
  }
  return syncPoints
}

/** 跨 prepare 的试次计数：同一运行组里已声明本用例的 attempt（含未封存草稿）。 */
function countCaseAttempts(runDir, caseId) {
  if (!existsSync(runDir)) return 0
  let count = 0
  for (const attemptId of listAttemptIds(runDir)) {
    for (const name of ["manifest.json", "manifest.json.pending"]) {
      const path = join(runDir, "attempts", attemptId, name)
      if (!existsSync(path)) continue
      const attempt = readJsonIfExists(path)
      if ((attempt?.expectedTrials ?? []).some(trial => trial.caseId === caseId)) count += 1
      break
    }
  }
  return count
}

/** 计划内的试次只统计非修复 attempt；修复是同一试次的证据替换，不占新的 trial 名额。 */
function listCaseTrialAttempts(runDir, caseId) {
  if (!existsSync(runDir)) return []
  const attempts = []
  for (const attemptId of listAttemptIds(runDir)) {
    const attemptDir = join(runDir, "attempts", attemptId)
    let record = null
    for (const name of ["manifest.json", "manifest.json.pending"]) {
      const path = join(attemptDir, name)
      if (!existsSync(path)) continue
      record = readJsonIfExists(path)
      break
    }
    if (!record) continue
    const trial = (record.expectedTrials ?? []).find(candidate => candidate.caseId === caseId)
    if (!trial) continue
    attempts.push({
      attemptId,
      trialId: trial.trialId,
      repair: Boolean(record.identity?.repair),
      sealed: existsSync(join(attemptDir, "manifest.json")),
    })
  }
  return attempts
}

/** 冻结计划按 trial 身份占用名额；同一 trialId 即使尚未封存也不能再次建立 attempt。 */
function findAttemptByTrialId(runDir, caseId, trialId) {
  return listCaseTrialAttempts(runDir, caseId).find(attempt => attempt.trialId === trialId) ?? null
}

export function planTrialBatch({ requestedTrials = null, existingAttempts = 0, budgetTrials }) {
  if (!Number.isInteger(budgetTrials) || budgetTrials < 1) {
    throw new Error(`授权预算 trials 必须是正整数：${String(budgetTrials)}`)
  }
  if (!Number.isInteger(existingAttempts) || existingAttempts < 0) {
    throw new Error(`已有 attempt 数必须是非负整数：${String(existingAttempts)}`)
  }
  const requested = requestedTrials === null || requestedTrials === undefined ? budgetTrials : requestedTrials
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`--trials 必须是正整数：${String(requestedTrials)}`)
  }
  if (requested > budgetTrials) {
    throw new Error(`--trials=${requested} 超过授权预算 trials=${budgetTrials}；扩大计划前先更新授权`)
  }
  if (requested < existingAttempts) {
    throw new Error(`--trials=${requested} 小于已有 attempt 数 ${existingAttempts}；计划不能回收已产生的试次`)
  }
  return { plannedTrials: requested, existingAttempts, newTrials: requested - existingAttempts }
}

function trialIdSuffix(evaluationRunId) {
  return createHash("sha256").update(evaluationRunId).digest("hex").slice(0, 8)
}

function trialIdBase(evaluationRunId, maxLength) {
  const base = evaluationRunId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return base.slice(0, maxLength).replace(/-+$/g, "") || "batch"
}

/** 计划槽位与子运行都用评价组 id 派生：续跑时不需要额外的映射文件，也不会截断碰撞。 */
export function batchTrialId(evaluationRunId, index) {
  validateEvaluationRunId(evaluationRunId)
  if (!Number.isInteger(index) || index < 1) throw new Error(`trial 序号必须是正整数：${String(index)}`)
  return validateTrialId(`trial-${trialIdBase(evaluationRunId, 40)}-${trialIdSuffix(evaluationRunId)}-${String(index).padStart(2, "0")}`)
}

export function batchTrialRunId(evaluationRunId, index) {
  validateEvaluationRunId(evaluationRunId)
  if (!Number.isInteger(index) || index < 1) throw new Error(`trial 序号必须是正整数：${String(index)}`)
  return validateRunId(`${trialIdBase(evaluationRunId, 28)}-${trialIdSuffix(evaluationRunId)}-t${String(index).padStart(2, "0")}`)
}

/** 计划冻结后只接受同一用例、同一授权与同一预算；批量子运行必须落在计划的 trialId 上。 */
function assertTrialPlanBinding(plan, { state, authorization }) {
  if (plan.caseId !== state.caseId) {
    throw new Error(`trial 计划的用例 ${plan.caseId} 与本次运行 ${state.caseId} 不一致`)
  }
  if (plan.evaluationRunId !== state.chat.evaluationRunId) {
    throw new Error(`trial 计划的运行组 ${plan.evaluationRunId} 与本次运行 ${state.chat.evaluationRunId} 不一致`)
  }
  if (plan.authorizationFingerprint !== authorizationFingerprint(authorization)) {
    throw new Error("trials.json 的授权指纹与当前授权不一致；计划只能按冻结授权执行")
  }
  if (plan.budgetTrials !== authorization.budget.trials) {
    throw new Error(`trials.json 的预算 trials=${plan.budgetTrials} 与当前授权 ${authorization.budget.trials} 不一致`)
  }
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
    clockPath: join(runDir, "clock.json"),
    authorizationPath: join(runDir, "authorization.json"),
    driverPackagePath: join(runDir, "driver-package.json"),
    driverProgressPath: join(runDir, "driver-progress.json"),
    hostLogPath: join(runDir, "host.log"),
    exitPath: join(runDir, "exit.json"),
    inboxPath: join(controlDir, "inbox.jsonl"),
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

export function validateExternalEnvironmentStep(step) {
  const { config, groupId, subtaskIndex } = step ?? {}
  if (!MEMORYARENA_CONFIGS.includes(config) || !Number.isSafeInteger(groupId) || groupId < 0
    || !Number.isSafeInteger(subtaskIndex) || subtaskIndex < (config === "group_travel_planner" ? -1 : 0)) {
    throw new Error("非法环境子任务身份")
  }
  return { config, groupId, subtaskIndex }
}

export function initialExternalEnvironmentStep(driver, mcpServer) {
  const steps = driver.filter(step => step.args?.externalEnvironmentStep !== undefined)
  if (!steps.length) return null
  if (!mcpServer || mcpServer.transport !== "stdio" || mcpServer.enabled !== true) {
    throw new Error("环境用例必须绑定已启用的 stdio MCP；请使用 dataset external run 或提供 --mcp-server")
  }
  if (driver[0] !== steps[0]) throw new Error("环境用例必须在首条消息前绑定初始子任务")
  const initial = validateExternalEnvironmentStep(steps[0].args.externalEnvironmentStep)
  for (const step of steps) {
    if (step.kind !== "host" || step.method !== "chat_new_session") throw new Error("环境切换只允许会话边界")
    const identity = validateExternalEnvironmentStep(step.args.externalEnvironmentStep)
    if (identity.config !== initial.config || identity.groupId !== initial.groupId) throw new Error("环境用例不能跨配置或任务组切换")
  }
  return initial
}

function hostEnv(runDir, controlDir, timezone, externalEnvironment) {
  return {
    ...process.env,
    DESKPET_SIM_EVAL: "1",
    DESKPET_SIM_EVAL_RUN_DIR: runDir,
    DESKPET_SIM_CHAT: "1",
    DESKPET_SIM_CONTROL: controlDir,
    ...(timezone ? { TZ: timezone } : {}),
    ...(externalEnvironment ? { DESKPET_MEMORYARENA_STEP_FILE: join(runDir, "external-environment.json") } : {}),
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

function stageEvalModels({ repoRoot, dataRoot, modelSettingsPath }) {
  const staged = []
  for (const [name, required] of [["eval-models.json", true], ["eval-models.local.json", false]]) {
    const source = name === "eval-models.local.json" && modelSettingsPath ? resolve(modelSettingsPath) : join(repoRoot, "test", name)
    if (!existsSync(source)) {
      if (required) console.warn(`[prepare] ${name} 不存在；被测模型将继承隔离副本配置`)
      continue
    }
    copyFileSync(source, join(dataRoot, name))
    staged.push(name)
  }
  return staged
}

/** prepare 与 batch 共用同一份用例前置校验；差别只在错误文案里的操作名。 */
function loadCaseForRun({ caseId, label, datasetRoot }) {
  if (!caseId) throw new Error(`${label} 需要 --case <caseId>`)
  const dataset = loadDataset({ repoRoot: REPO_ROOT, root: datasetRoot, caseIds: [caseId] })
  if (dataset.errors.length > 0) {
    for (const problem of dataset.errors) {
      console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`)
    }
    throw new Error(`数据集有 ${dataset.errors.length} 个错误；${label} 不带着坏数据启动`)
  }
  const entry = dataset.cases.find(candidate => candidate.caseId === caseId)
  if (!entry) {
    throw new Error(`找不到用例：${caseId}；可用：${dataset.cases.map(candidate => candidate.caseId).join(", ") || "（无）"}`)
  }
  const suite = dataset.suites.find(candidate => candidate.suiteId === entry.suiteId)
  if (!suite) throw new Error(`找不到套件：${entry.suiteId}`)
  if (entry.fixture.loading?.mode !== "direct-seed") {
    throw new Error(`fixture.loading.mode=${String(entry.fixture.loading?.mode)}，本运行器只支持 direct-seed`)
  }
  const unsupported = entry.case.precondition.hostCapabilities.filter(capability => !SUPPORTED_HOST_CAPABILITIES.has(capability))
  if (unsupported.length > 0) {
    throw new Error(`用例要求完整产品宿主未声明的能力：${unsupported.join(", ")}`)
  }
  return { dataset, entry, suite }
}

async function prepare(options) {
  const repoRoot = REPO_ROOT
  const repairing = options.repairOf ? loadState(validateRunId(options.repairOf)) : null
  if (repairing && options.evaluationRunId && options.evaluationRunId !== repairing.state.chat.evaluationRunId) {
    throw new Error("修复必须沿用原运行的 evaluation-run-id")
  }
  const caseId = options.caseId ?? repairing?.state.caseId
  if (!caseId) throw new Error("prepare 缺少 --case <caseId>（或 --repair-of <runId>）")
  if (repairing && options.caseId && options.caseId !== repairing.state.caseId) {
    throw new Error(`修复用例 ${options.caseId} 与原运行 ${repairing.state.caseId} 不一致`)
  }
  const runId = options.runId ? validateRunId(options.runId) : makeRunId()
  const runDir = runDirFor(runId, repoRoot)
  if (existsSync(runDir)) {
    throw new Error(`运行根已存在，拒绝覆盖：${relative(repoRoot, runDir)}；请换 --run-id 或先确认并手动清理`)
  }

  const datasetRoot = options.datasetRoot ?? repairing?.state.datasetRoot
  if (repairing && options.datasetRoot && resolve(REPO_ROOT, options.datasetRoot) !== resolve(REPO_ROOT, repairing.state.datasetRoot ?? "test/ideal-traces")) {
    throw new Error("修复必须沿用原运行的数据集目录")
  }
  const { dataset, entry, suite } = loadCaseForRun({ caseId, label: "prepare", datasetRoot })
  const purpose = suite.purpose
  const evaluationRunId = repairing
    ? repairing.state.chat.evaluationRunId
    : options.evaluationRunId ? validateEvaluationRunId(options.evaluationRunId) : validateEvaluationRunId(runId)
  const trialId = options.trialId ? validateTrialId(options.trialId) : validateTrialId(`trial-${runId}`)
  const datasetHash = datasetInputHash(dataset, entry)

  let authorization
  let card
  let cardText
  let profileId
  let baseline
  let repair = null
  if (repairing) {
    const original = repairing.state
    if (!original.chat?.sealedAt) {
      throw new Error(`原运行 ${original.runId} 尚未封存；修复只能针对已封存 attempt`)
    }
    if (!original.authorization || !original.clock) {
      throw new Error(`原运行 ${original.runId} 缺少授权/时钟记录（旧版准备）；不能作为同条件修复`)
    }
    for (const field of ["contentHash", "fixtureHash", "driverHash", "oracleHash", "specHash"]) {
      if (entry.binding[field] !== original.hashes[field]) {
        throw new Error(`数据集在修复前发生变化：${field} 不一致；不能作为同条件修复`)
      }
    }
    if (original.fixture.id !== entry.fixture.fixtureId) {
      throw new Error(`原运行的 fixture=${original.fixture.id} 与当前用例 ${entry.fixture.fixtureId} 不一致`)
    }
    if (options.card) {
      const providedPath = resolve(options.card)
      if (!existsSync(providedPath)) throw new Error(`Card 文件不存在：${providedPath}`)
      if (sha256(readFileSync(providedPath, "utf8")) !== original.card.sha256) {
        throw new Error("修复必须沿用原运行的 Card；--card 内容与原运行不一致")
      }
    }
    const originalStaged = join(repoRoot, original.card.stagedPath)
    if (!existsSync(originalStaged)) throw new Error(`原运行暂存的 Card 不存在：${originalStaged}`)
    cardText = readFileSync(originalStaged, "utf8")
    if (sha256(cardText) !== original.card.sha256) {
      throw new Error("原运行暂存的 Card 已被改动；不能按同条件修复")
    }
    card = resolveCard({ meta: parseCardMeta(cardText), cardPath: original.card.sourcePath, fixture: entry.fixture })
    if (card.id !== original.card.id || card.name !== original.card.name) {
      throw new Error("修复解析出的 Card 身份与原运行不一致")
    }
    profileId = original.profile.activeId
    if (profileId !== resolveProfile({ fixture: entry.fixture, repoRoot })) {
      throw new Error("修复的 Profile 与原运行不一致")
    }
    authorization = readAuthorizationFile(statePaths(repairing.runDir).authorizationPath, { caseIds: [caseId], purpose })
    const repairIndex = (original.repair?.index ?? 0) + 1
    assertRepairAllowed({ authorization, repairIndex })
    repair = { ofRunId: original.runId, index: repairIndex, evaluationRunId }
    baseline = original.baseline ?? null
  } else {
    if (!options.card) throw new Error("prepare 缺少 --card <path>（fixture 需要的 Card 不被仓库跟踪）")
    if (!options.authorization) {
      throw new Error("prepare 缺少 --authorization <file.json>（用户确认的用例范围、模型与预算）")
    }
    authorization = readAuthorizationFile(options.authorization, { caseIds: [caseId], purpose })
    const cardPath = resolve(options.card)
    if (!existsSync(cardPath)) throw new Error(`Card 文件不存在：${cardPath}`)
    cardText = readFileSync(cardPath, "utf8")
    card = resolveCard({ meta: parseCardMeta(cardText), cardPath, fixture: entry.fixture })
    profileId = resolveProfile({ fixture: entry.fixture, repoRoot })
    baseline = options.baselineId ? { evaluationRunId: validateEvaluationRunId(options.baselineId) } : null
    if (baseline?.evaluationRunId === evaluationRunId) {
      throw new Error("baseline 不能是本次运行的 evaluationRunId")
    }
    if (baseline && !existsSync(join(CHAT_REPORTS_DIR, baseline.evaluationRunId, "run.json"))) {
      throw new Error(`baseline 运行组不存在：${baseline.evaluationRunId}`)
    }
  }

  const clock = buildClockFile({ base: entry.fixture.clock, reason: `fixture:${entry.fixture.fixtureId}` })
  if (repairing && clock.base !== repairing.state.clock.base) {
    throw new Error("修复的固定时钟基准与原运行不一致")
  }
  const driverPackage = validateDriverPackage(buildDriverPackage(entry))
  const syncPoints = validateCheckpointBindings(validateSyncPoints(entry.case.checkpoints), driverPackage)

  const paths = statePaths(runDir)
  const externalMcpServer = options.mcpServer
    ? JSON.parse(readFileSync(resolve(options.mcpServer), "utf8"))
    : repairing?.state.externalMcpServer ?? null
  if (externalMcpServer && (externalMcpServer.transport !== "stdio" || externalMcpServer.enabled !== true)) {
    throw new Error("评测环境 MCP 必须是已启用的 stdio 服务")
  }
  if (repairing && options.mcpServer && hashCanonical(externalMcpServer) !== hashCanonical(repairing.state.externalMcpServer)) {
    throw new Error("修复必须沿用同一评测环境 MCP 服务")
  }
  const externalEnvironment = initialExternalEnvironmentStep(driverPackage.driver, externalMcpServer)
  mkdirSync(join(paths.dataRoot, "settings"), { recursive: true })
  mkdirSync(join(paths.dataRoot, "personality", "cards"), { recursive: true })
  mkdirSync(paths.controlDir, { recursive: true })
  const stagedInputs = stageExternalAssets(entry.case.source.upstream?.assets, { repoRoot, dataRoot: paths.dataRoot })
  if (externalEnvironment) writeJsonAtomic(join(runDir, "external-environment.json"), externalEnvironment)
  // 修复沿用原运行的拟人化开关，保证对照只差本次修复；新运行默认关闭，显式 --humanizer 才打开。
  const humanizerEnabled = repairing
    ? Boolean(parseYaml(readFileSync(repairing.state.configPath, "utf8"))?.ai?.humanizer?.enabled ?? true)
    : options.humanizer === true
  if (repairing && options.humanizer === true && humanizerEnabled !== true) {
    throw new Error("修复必须沿用原运行的拟人化开关；原运行未开启，不能为本次修复打开")
  }
  const configText = buildSyntheticConfig({
    repoRoot,
    overrides: buildRunOverrides({
      cardId: card.id, profileId, humanizerEnabled,
      ...(externalMcpServer ? { mcpServers: [externalMcpServer], turnTimeoutMs: Math.max(DRIVER_MESSAGE_WAIT_MS, authorization.budget.minutes * 60000) } : {}),
    }),
  })
  writeSyntheticConfig(paths.dataRoot, configText)
  const stagedCardPath = join(paths.dataRoot, "personality", "cards", card.fileName)
  writeFileSync(stagedCardPath, cardText)
  const modelSettingsPath = options.modelSettings ?? repairing?.state.modelSettingsPath ?? null
  const stagedModels = stageEvalModels({ repoRoot, dataRoot: paths.dataRoot, modelSettingsPath })

  writeJsonAtomic(paths.seedPath, {
    schemaVersion: 1,
    fixtureId: entry.fixture.fixtureId,
    fixtureHash: entry.binding.fixtureHash,
    card: { name: card.name, activeId: card.id },
    profile: { activeId: profileId },
    fixture: entry.fixture,
  })
  writeJsonAtomic(paths.clockPath, clock)
  writeJsonAtomic(paths.authorizationPath, authorization)
  writeJsonAtomic(paths.driverPackagePath, driverPackage)

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
    datasetHash,
    datasetRoot: relative(repoRoot, dataset.root),
    fixture: { id: entry.fixture.fixtureId, path: entry.fixturePath, hash: entry.binding.fixtureHash },
    expectedSeed,
    card: { ...card, sha256: sha256(cardText), stagedPath: relative(repoRoot, stagedCardPath) },
    profile: { activeId: profileId },
    authorization: {
      fingerprint: authorizationFingerprint(authorization),
      approvedBy: authorization.approvedBy,
      approvedAt: authorization.approvedAt,
      purpose: authorization.scope.purpose,
      models: [...authorization.scope.models],
      data: authorization.scope.data,
      holdout: authorization.holdout,
      budget: authorization.budget,
    },
    clock: { path: relative(repoRoot, paths.clockPath), ...clock },
    driver: {
      packagePath: relative(repoRoot, paths.driverPackagePath),
      progressPath: relative(repoRoot, paths.driverProgressPath),
      hash: entry.binding.driverHash,
      steps: driverPackage.driver.length,
      checkpoints: syncPoints.length,
      status: null,
      index: 0,
      usage: null,
    },
    syncPoints,
    deliverables: entry.case.deliverables ?? [],
    toolApproval: entry.case.precondition.toolApproval ?? null,
    baseline,
    repair,
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
    modelSettingsPath,
    stagedInputs,
    externalMcpServer,
    chat: {
      evaluationRunId,
      trialId,
      runDir: null,
      attemptId: null,
      attemptDir: null,
      identity: null,
      captureStartedAt: null,
      sealedAt: null,
      manifestSha256: null,
      integrity: null,
      reportPath: null,
      retention: null,
      driver: null,
      judgedAt: null,
      judging: null,
      reviewedAt: null,
      review: null,
    },
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
    `  evidence: chat/${evaluationRunId} trial=${trialId}`,
    `  run: ${relative(repoRoot, runDir)}`,
    `  config: ${relative(repoRoot, paths.configPath)}`,
    `  card: ${card.name} (id=${card.id}, file=${card.fileName})`,
    `  profile: ${profileId ?? "继承 CONFIG 默认"}`,
    `  seed: ${expectedSeed.messageCount} 条消息 / ${expectedSeed.userMessageCount} 条用户来源 / ${expectedSeed.memoryItemCount} 条初始记忆`,
    `  clock: ${clock.base} (${clock.timezone})`,
    `  authorization: ${authorization.approvedBy} @ ${authorization.approvedAt} · models=${authorization.scope.models.join(", ")}`
      + ` · budget messages=${authorization.budget.messages} tokens=${authorization.budget.tokens}`
      + ` minutes=${authorization.budget.minutes} trials=${authorization.budget.trials} repairs=${authorization.budget.repairs}`
      + ` · holdout=${authorization.holdout}`,
    `  driver: ${driverPackage.driver.length} 步 / ${syncPoints.length} 个检查点 · ${entry.binding.driverHash}`,
    ...((entry.case.deliverables ?? []).length > 0
      ? [`  deliverables: ${entry.case.deliverables
        .map(deliverable => `${deliverable.id}（${deliverable.role}）→ ${deliverable.path}`)
        .join("；")}`]
      : []),
    ...(entry.case.precondition.toolApproval
      ? [`  tool approval: ${entry.case.precondition.toolApproval}（驱动代替用户确认一次）`]
      : []),
    ...(repair ? [`  repair: #${repair.index} of ${repair.ofRunId}（复用同一 evaluationRunId）`] : []),
    ...(baseline ? [`  baseline: ${baseline.evaluationRunId}`] : []),
    `  eval-models: ${stagedModels.length > 0 ? stagedModels.join(", ") : "未 stage（全部继承）"}`,
    `next: node scripts/sim-eval-run.mjs start --run-id ${runId}`,
  ].join("\n"))
}

// ── 采集生命周期 ──

/**
 * 宿主 ready 之后才建立证据 attempt：先核对冻结的授权/数据集，再生成运行组与 attempt
 * 草稿，把授权、时钟与驱动包复制为只读输入证据，最后让产品侧读取 before 快照并开始
 * trace。before 不完整时立即失败，不把漏读当成空会话。
 */
async function startChatCapture({ paths, state, entry, dataset, createdAt }) {
  const evaluationRunId = state.chat.evaluationRunId
  const trialId = state.chat.trialId
  const currentDatasetHash = datasetInputHash(dataset, entry)
  if (currentDatasetHash !== state.datasetHash) {
    throw new Error(`数据集在 prepare 后发生变化（${state.datasetHash} → ${currentDatasetHash}）；请重新 prepare`)
  }
  for (const field of ["specHash", "contentHash", "fixtureHash", "driverHash", "oracleHash"]) {
    if (entry.binding[field] !== state.hashes[field]) {
      throw new Error(`数据集的 ${field} 在 prepare 后发生变化；请重新 prepare`)
    }
  }
  const authorization = readAuthorizationFile(paths.authorizationPath, {
    caseIds: [state.caseId],
    purpose: state.authorization.purpose,
  })
  if (authorizationFingerprint(authorization) !== state.authorization.fingerprint) {
    throw new Error("authorization.json 与 prepare 记录的授权指纹不一致")
  }
  // 请求模型取宿主 init 写回隔离 CONFIG 的最终值（测试侧覆盖已生效）；未授权就不建立 attempt。
  authorizeRequestedModels(authorization, readRequestedModel(paths.configPath))
  const identity = buildAttemptIdentity(state, entry)
  let runDir = null
  try {
    const chatRun = ensureChatRun({
      reportsDir: CHAT_REPORTS_DIR,
      evaluationRunId,
      createdAt,
      scope: {
        suiteIds: [state.suiteId],
        caseIds: [state.caseId],
        purpose: authorization.scope.purpose,
        holdout: authorization.holdout,
      },
      budget: authorization.budget,
      baseline: state.baseline,
    })
    runDir = chatRun.runDir
    assertChatScope(chatRun.run, state)
    const plan = readTrialPlan(runDir)
    if (plan) {
      assertTrialPlanBinding(plan, { state, authorization })
      if (!state.repair) {
        if (!plan.trialIds.includes(trialId)) {
          throw new Error(`trialId=${trialId} 不在冻结计划内（${plan.trialIds.join(", ")}）；批量运行必须按计划槽位建立 attempt`)
        }
        const used = findAttemptByTrialId(runDir, state.caseId, trialId)
        if (used) {
          throw new Error(`trialId=${trialId} 已由 attempt ${used.attemptId} 占用；计划试次不能被重放或替换`)
        }
      }
    }
    const priorAttempts = countCaseAttempts(runDir, state.caseId)
    if (!state.repair && priorAttempts >= authorization.budget.trials) {
      throw new Error(`试次预算已用尽（${priorAttempts}/${authorization.budget.trials}）；不建立新 attempt`)
    }
    setChatRunPhase(runDir, {
      phase: "running",
      updatedAt: createdAt,
      nextAction: `运行 node scripts/sim-eval-run.mjs drive --run-id ${state.runId} 执行驱动（trial ${trialId}）`,
    })
    const attempt = beginChatAttempt({
      runDir,
      identity,
      expectedTrials: [{ caseId: state.caseId, trialId }],
      expectedSessions: [state.expectedSeed.sessionId],
      createdAt,
    })
    const chat = {
      ...state.chat,
      runDir,
      attemptId: attempt.attempt.attemptId,
      attemptDir: attempt.attemptDir,
      identity,
    }
    updateState(paths, state, { chat })

    // 本次运行冻结的授权、时钟与驱动包作为 attempt 输入证据，封存时一起纳入哈希。
    for (const [name, sourcePath] of [
      ["authorization.json", paths.authorizationPath],
      ["clock.json", paths.clockPath],
      ["driver-package.json", paths.driverPackagePath],
    ]) {
      copyArtifact({ attemptDir: chat.attemptDir, name, sourcePath })
    }

    const expected = { evaluationRunId, attemptId: chat.attemptId, attemptDir: chat.attemptDir }
    const started = validateCaptureStarted(
      await sendBridgeCommand(paths, {
        type: "capture_start",
        attemptDir: chat.attemptDir,
        evaluationRunId,
        expectedTrials: [{ caseId: state.caseId, trialId }],
      }, ["capture_started"]),
      expected,
    )
    chat.captureStartedAt = started.startedAt
    updateState(paths, state, { chat })
    validateCaptureTrial(
      await sendBridgeCommand(paths, { type: "capture_begin", caseId: state.caseId, trialId }, ["capture_trial"]),
      { phase: "begin", caseId: state.caseId, trialId },
    )

    const driverPackage = readDriverPackageFile(paths.driverPackagePath, state)
    if (existsSync(paths.driverProgressPath)) {
      throw new Error("driver-progress.json 已存在；不覆盖已有驱动进度")
    }
    const progress = createDriverProgress({
      driverPackage,
      driverHash: state.hashes.driverHash,
      budget: authorization.budget,
      clockBase: state.clock.base,
      startedAt: nowIso(),
    })
    writeJsonAtomic(paths.driverProgressPath, progress)
    updateState(paths, state, {
      driver: { ...state.driver, status: progress.status, index: progress.index, usage: driverSummary(progress).usage },
    })
    return chat
  } catch (error) {
    const markedBlocked = state.chat.attemptDir ? markUnsealed(state, messageOf(error)) : false
    if (runDir && !markedBlocked) {
      try {
        setChatRunPhase(runDir, {
          phase: "blocked",
          updatedAt: nowIso(),
          nextAction: `采集未能开始：${messageOf(error)}`,
        })
      } catch { /* workflow 尚未创建时没有可标记的组；原始错误优先 */ }
    }
    throw error
  }
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
  // 启动前重新读取冻结输入：授权、时钟或驱动包被换过就不拉起宿主。
  const clock = validateClockFile(readJsonIfExists(paths.clockPath))
  if (clock.base !== state.clock.base || clock.timezone !== state.clock.timezone) {
    throw new Error("clock.json 与 runner.json 记录的固定时钟不一致")
  }
  const authorization = readAuthorizationFile(paths.authorizationPath, {
    caseIds: [state.caseId],
    purpose: state.authorization.purpose,
  })
  if (authorizationFingerprint(authorization) !== state.authorization.fingerprint) {
    throw new Error("authorization.json 与 runner.json 记录的授权指纹不一致")
  }
  const driverPackage = readDriverPackageFile(paths.driverPackagePath, state)
  const externalEnvironment = initialExternalEnvironmentStep(driverPackage.driver, state.externalMcpServer)

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
        env: hostEnv(runDir, paths.controlDir, clock.timezone, externalEnvironment),
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
      clock: { base: clock.base, timezone: clock.timezone },
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

    const report = await waitFor("seed-report.json", SEED_REPORT_WAIT_MS, () => {
      const raw = readJsonIfExists(paths.seedReportPath)
      return raw ? validateSeedReport(raw, expected) : undefined
    })

    const dataset = loadDataset({ repoRoot: REPO_ROOT, root: state.datasetRoot, caseIds: [state.caseId] })
    if (dataset.errors.length > 0) {
      for (const problem of dataset.errors) {
        console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`)
      }
      throw new Error(`数据集有 ${dataset.errors.length} 个错误；采集不带着坏数据开始`)
    }
    const entry = dataset.cases.find(candidate => candidate.caseId === state.caseId)
    if (!entry) throw new Error(`数据集里找不到用例：${state.caseId}`)

    const startedAt = nowIso()
    updateState(paths, state, {
      status: "running",
      bridgeReadyAt: startedAt,
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
    const chat = await startChatCapture({ paths, state, entry, dataset, createdAt: startedAt })

    console.log([
      `running ${runId}`,
      `  host: pid=${child.pid} generation=${ready.generation}`,
      `  session: ${bridgeReady.sessionId}`,
      `  seed: ${bridgeReady.messageCount} 条消息 / ${report.sourceCount} 条来源 / ${bridgeReady.memoryItemIds.length} 条记忆 (${bridgeReady.status})`,
      `  evidence: test/reports/chat/${chat.evaluationRunId}/attempts/${chat.attemptId} (trial ${chat.trialId})`,
      `  clock: ${state.clock.base} (${state.clock.timezone}) · driver ${state.driver.steps} 步 / ${state.driver.checkpoints} 个检查点`,
      `  authorization: ${state.authorization.approvedBy} · budget messages=${state.authorization.budget.messages}`
        + ` tokens=${state.authorization.budget.tokens} minutes=${state.authorization.budget.minutes}`
        + ` trials=${state.authorization.budget.trials} repairs=${state.authorization.budget.repairs}`,
      `  control: ${paths.controlDir}`,
      `  drive: node scripts/sim-eval-run.mjs drive --run-id ${runId}`,
      `  manual: DESKPET_SIM_CONTROL=${JSON.stringify(paths.controlDir)} node scripts/desk-pet-chat.mjs cmd capture_sessions`
        + `（评测内的聊天消息只接受 drive 操作身份）`,
      `  finish: node scripts/sim-eval-run.mjs finish --run-id ${runId}`,
      `  stop: node scripts/sim-eval-run.mjs stop --run-id ${runId}`,
    ].join("\n"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markUnsealed(state, `启动阶段失败：${message}`)
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

// ── drive ──

/** 驱动传输层只走控制通道：时钟、消息、会话、宿主方法、上下文用量、记忆水位、工具确认与提问应答。 */
function driverTransport(paths, identity, messageTimeoutMs = DRIVER_MESSAGE_WAIT_MS, externalEnvironment = false) {
  if (typeof identity?.trialId !== "string" || identity.trialId === "") {
    throw new Error("驱动传输缺少 trialId；不能发送没有试次身份的消息")
  }
  if (typeof identity?.generation !== "string" || identity.generation === "") {
    throw new Error("驱动传输缺少宿主代际；不能发送无法回溯的消息")
  }
  let activeSessionId = null
  const syncSessions = async () => {
    const event = await sendBridgeCommand(paths, { type: "sessions" }, ["sessions"], 30_000)
    activeSessionId = typeof event.active === "string" && event.active !== "" ? event.active : null
    return { active: event.active ?? null, sessions: Array.isArray(event.sessions) ? event.sessions : [] }
  }
  return {
    async clock(at, reason) {
      const event = await sendBridgeCommand(paths, { type: "clock", at, reason }, ["clock"], 30_000)
      return event.clock
    },
    async message(text, operation) {
      // 活跃会话随宿主步骤变化：每次发送前用上次同步的会话，首次使用先读一次列表。
      if (!activeSessionId) await syncSessions()
      if (!activeSessionId) throw new Error("驱动消息没有活跃会话")
      const expected = {
        operationId: operation.operationId,
        caseId: operation.caseId,
        stepId: operation.stepId,
        trialId: identity.trialId,
        sessionId: activeSessionId,
        generation: identity.generation,
      }
      const event = await sendBridgeCommand(
        paths, { type: "message", text, operation: expected }, ["message"], messageTimeoutMs,
      )
      return validateMessageReceipt(event, expected)
    },
    sessions: syncSessions,
    async host(method, args) {
      const { externalEnvironmentStep, ...hostArgs } = args ?? {}
      if (externalEnvironmentStep !== undefined) {
        if (!externalEnvironment || method !== "chat_new_session") throw new Error("环境切换只允许已绑定外部MCP的会话边界")
        writeJsonAtomic(join(dirname(paths.seedPath), "external-environment.json"), validateExternalEnvironmentStep(externalEnvironmentStep))
      }
      // 任务交付组件最长等待 300s，手工触发沿用消息级超时；其余宿主步骤保持采集超时。
      const timeoutMs = MANUAL_TRIGGER_HOST_METHODS.includes(method) ? DRIVER_MESSAGE_WAIT_MS : CAPTURE_WAIT_MS
      const event = await sendBridgeCommand(paths, { type: "host", method, args: hostArgs }, ["host"], timeoutMs)
      return { method: event.method, result: event.result ?? null }
    },
    async context() {
      const event = await sendBridgeCommand(paths, { type: "context" }, ["context"], 30_000)
      return { context: event.context }
    },
    async memoryState() {
      const event = await sendBridgeCommand(paths, { type: "memory_state" }, ["memory_state"], 30_000)
      return event.result
    },
    async confirm(action) {
      if (action?.action === "query") {
        const event = await sendBridgeCommand(paths, { type: "confirm" }, ["confirm"], 30_000)
        return { pending: event.pending ?? null }
      }
      if (action?.action === "resolve") {
        const event = await sendBridgeCommand(
          paths, { type: "confirm", decision: action.decision }, ["confirm"], 30_000,
        )
        if (event.requestId !== action.requestId || event.decision !== action.decision) {
          throw new Error(
            `确认回执与请求不一致：requestId=${String(event.requestId)} decision=${String(event.decision)}`
            + `（期望 ${action.requestId} / ${action.decision}）`,
          )
        }
        return { resolved: true, requestId: event.requestId, decision: event.decision }
      }
      throw new Error(`未知确认动作：${String(action?.action)}`)
    },
    async choice(action) {
      if (action?.action === "query") {
        const event = await sendBridgeCommand(paths, { type: "choice" }, ["choice"], 30_000)
        return { pending: event.pending ?? [] }
      }
      if (action?.action === "cancel") {
        const event = await sendBridgeCommand(paths, { type: "choice", action: "cancel" }, ["choice"], 30_000)
        if (event.requestId !== action.requestId || event.action !== "cancel") {
          throw new Error(
            `提问回执与请求不一致：requestId=${String(event.requestId)} action=${String(event.action)}`
            + `（期望 ${action.requestId} / cancel）`,
          )
        }
        return { resolved: true, requestId: event.requestId, action: "cancel" }
      }
      throw new Error(`未知提问动作：${String(action?.action)}`)
    },
  }
}

/**
 * 按驱动包推进（或续跑）本次采集。每步都能从 driver-progress.json 恢复；
 * 已开始但结果未知的步骤（inFlight）直接拒绝，不能重放副作用。
 */
async function drive(runId) {
  const { paths, state } = loadState(runId)
  const chat = state.chat
  if (!chat?.attemptDir || !chat.attemptId) throw new Error("本运行还没有开始采集；先 start")
  if (chat.sealedAt || existsSync(join(chat.attemptDir, "manifest.json"))) {
    throw new Error("attempt 已封存；不再执行驱动")
  }
  if (!state.hostPid || !isAlive(state.hostPid)) {
    throw new Error("宿主不在运行；驱动必须附着于正在采集的宿主，先 start")
  }
  // 每次驱动前重新核对授权与请求模型：授权文件或隔离 CONFIG 被换过就不推进。
  const authorization = readAuthorizationFile(paths.authorizationPath, {
    caseIds: [state.caseId],
    purpose: state.authorization.purpose,
  })
  if (authorizationFingerprint(authorization) !== state.authorization.fingerprint) {
    throw new Error("authorization.json 与 prepare 记录的授权指纹不一致")
  }
  authorizeRequestedModels(authorization, readRequestedModel(paths.configPath))
  const driverPackage = readDriverPackageFile(paths.driverPackagePath, state)
  if (!existsSync(paths.driverProgressPath)) {
    throw new Error("driver-progress.json 不存在；start 未完成采集初始化")
  }
  const progress = readDriverProgress(readJsonIfExists(paths.driverProgressPath))
  if (progress.clockBase !== state.clock.base) throw new Error("驱动进度的时钟基准与本次运行不一致")
  if (progress.driverHash !== state.hashes.driverHash) throw new Error("驱动进度的 driverHash 与本次运行不一致")

  const persist = async () => {
    writeJsonAtomic(paths.driverProgressPath, progress)
    const summary = driverSummary(progress)
    updateState(paths, state, {
      driver: { ...state.driver, status: progress.status, index: progress.index, usage: summary.usage },
      lastError: progress.blocked ? progress.blocked.message : null,
    })
    return summary
  }

  try {
    const summary = await executeDriver({
      progress,
      driverPackage,
      syncPoints: state.syncPoints,
      transport: driverTransport(paths, { trialId: chat.trialId, generation: state.generation }, state.externalMcpServer ? Math.max(DRIVER_MESSAGE_WAIT_MS, state.authorization.budget.minutes * 60000) : DRIVER_MESSAGE_WAIT_MS, Boolean(state.externalMcpServer)),
      dataRoot: state.dataRoot,
      toolApproval: state.toolApproval ?? null,
      onProgress: persist,
    })
    const final = await persist()
    const checkpoints = progress.steps.reduce((total, step) =>
      total + (step.checkpoints ?? []).filter(check => check.status === "satisfied").length, 0)
    console.log([
      `driven ${runId}`,
      `  driver: ${final.status} ${final.completed}/${final.total ?? driverPackage.driver.length} 步`
        + ` · 检查点 ${checkpoints} 个已满足`
        + `${final.confirmations ? ` · 工具确认 ${final.confirmations} 次` : ""}`
        + `${final.questions ? ` · 反问取消 ${final.questions} 次` : ""}`,
      `  clock: ${final.clockBase} → ${final.lastClock}`,
      `  usage: messages=${final.usage.messages}/${progress.budget.messages}`
        + ` tokens=${final.usage.tokens}/${progress.budget.tokens}`
        + `${final.usage.tokensUnknown ? "（部分回合未报告用量，按未知记录）" : ""}`
        + ` · ${final.usage.elapsedMinutes.toFixed(1)}/${progress.budget.minutes} 分钟`,
      ...(final.usage.contextErrors ? [`  context errors: ${final.usage.contextErrors}`] : []),
      `  next: node scripts/sim-eval-run.mjs finish --run-id ${runId}`,
    ].join("\n"))
    return summary
  } catch (error) {
    await persist()
    updateState(paths, state, { lastError: messageOf(error) })
    console.error(
      `[drive] 驱动停在 index=${progress.index}/${progress.totalSteps ?? driverPackage.driver.length}`
      + `（status=${progress.status}）：${messageOf(error)}\n`
      + `  不重放已开始步骤；核对现场后按中断收口：`
      + `node scripts/sim-eval-run.mjs finish --run-id ${runId} --interrupted --reason <text>`,
    )
    throw error
  }
}

// ── 判分 / 复核 / 报告 ──

/** 报告与判分加载同一份当前数据集；判分要求哈希未变，报告允许展示漂移原因。 */
function loadReportDataset(state) {
  const dataset = loadDataset({ repoRoot: REPO_ROOT, root: state.datasetRoot, caseIds: [state.caseId] })
  if (dataset.errors.length > 0) {
    return { dataset: null, error: `数据集有 ${dataset.errors.length} 个错误：${dataset.errors.map(problem => problem.message).join("；")}` }
  }
  if (!dataset.cases.some(candidate => candidate.caseId === state.caseId)) {
    return { dataset: null, error: `当前数据集不含用例 ${state.caseId}` }
  }
  return { dataset, error: null }
}

function loadCaseContext(state) {
  const loaded = loadReportDataset(state)
  if (loaded.error) throw new Error(loaded.error)
  const entry = loaded.dataset.cases.find(candidate => candidate.caseId === state.caseId)
  const currentHash = datasetInputHash(loaded.dataset, entry)
  if (currentHash !== state.datasetHash) {
    throw new Error(`数据集在 prepare 后发生变化（${state.datasetHash} → ${currentHash}）；旧证据不能按当前规格判分，请重新 prepare`)
  }
  return { dataset: loaded.dataset, entry }
}

function sealedAttemptFor(state, explicitAttemptId = null) {
  const chat = state.chat
  if (!chat?.runDir) throw new Error("本运行还没有建立运行组；先 prepare/start/finish")
  const attemptId = explicitAttemptId ?? chat.attemptId
  if (typeof attemptId !== "string" || !/^\d{4}$/.test(attemptId)) throw new Error(`attempt-id 不合法：${String(attemptId)}`)
  const attemptDir = join(chat.runDir, "attempts", attemptId)
  if (!existsSync(join(attemptDir, "manifest.json"))) {
    throw new Error(`attempt ${attemptId} 尚未封存；先运行 finish 收口采集`)
  }
  return { attemptId, attemptDir, verification: verifySealedAttempt(attemptDir) }
}

function setPhaseForRun(state, { phase, pendingDecision, nextAction, at = nowIso() }) {
  if (!state.chat?.runDir) throw new Error("本运行还没有建立运行组")
  return setChatRunPhase(state.chat.runDir, { phase, updatedAt: at, pendingDecision, nextAction })
}

function phaseAfterJudgeApply({ status }) {
  if (status.evidence !== "complete") {
    return {
      phase: "blocked",
      pendingDecision: { kind: "evidence_incomplete", reason: status.overall.reason },
      nextAction: "证据不完整或不可信：修复后重新采集；旧证据保持只读",
    }
  }
  if (status.overall.status === "pass") {
    return { phase: "completed", pendingDecision: null, nextAction: "评测闭环完成；可用 report 重新生成同源视图，抽查可选" }
  }
  if (status.overall.status === "fail") {
    return { phase: "repairing", pendingDecision: { kind: "repair_required", reason: status.overall.reason }, nextAction: "按失败证据修复后新开运行组" }
  }
  return { phase: "blocked", pendingDecision: { kind: "inconclusive", reason: status.overall.reason }, nextAction: "检查缺失证据或判分规则后重新 prepare/apply，不把待定写成通过" }
}

function readVerdictsInput(options) {
  if (!options.verdictsPath) {
    throw new Error("judge apply 需要 --verdicts <file.json>（独立 coding-agent judge 回填的裁决文件）")
  }
  const path = resolve(options.verdictsPath)
  if (!existsSync(path)) throw new Error(`裁决文件不存在：${path}`)
  const raw = readFileSync(path)
  let body
  try {
    body = JSON.parse(raw.toString("utf8"))
  } catch (error) {
    throw new Error(`裁决文件不是合法 JSON：${messageOf(error)}`)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("裁决文件必须是对象")
  return {
    body,
    path,
    sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  }
}

function readSpotCheckInput(options) {
  if (!options.checksPath) {
    throw new Error("review spotcheck 需要 --checks <file.json>（用户本人填写的抽查文件）")
  }
  const path = resolve(options.checksPath)
  if (!existsSync(path)) throw new Error(`抽查文件不存在：${path}`)
  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`抽查文件不是合法 JSON：${messageOf(error)}`)
  }
  const body = Array.isArray(raw) ? { checks: raw } : raw
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("抽查文件必须是对象或规则数组")
  const reviewerName = options.reviewerName ?? body.reviewer?.name
  if (typeof reviewerName !== "string" || !reviewerName.trim()) {
    throw new Error("抽查只能由用户本人记录：提供 --reviewer-name，或在文件中写 reviewer.name")
  }
  if (body.reviewer?.role && body.reviewer.role !== "user") {
    throw new Error("抽查 reviewer.role 必须是 user")
  }
  return {
    reviewer: { role: "user", name: reviewerName.trim() },
    checks: body.checks ?? [],
    notes: options.notes ?? body.notes ?? "",
  }
}

function writeReportAfterPhase(state, dataset, at) {
  const report = writeChatReport({ runDir: state.chat.runDir, generatedAt: at, dataset })
  state.chat.reportPath = relative(REPO_ROOT, report.path)
  return report
}

// ── finish ──

/**
 * 收口顺序固定：按驱动结果结束试次 → 收口 trace → 写对话证据 → 复制驱动进度 →
 * 冻结 manifest → 报告 → 淘汰 → 停宿主。只有驱动完成才允许正常收口；
 * 中断必须显式确认并带原因。任何一步失败都让运行组显式 blocked。
 */
async function finish(runId, options = {}) {
  const { paths, state } = loadState(runId)
  const chat = state.chat
  if (!chat?.runDir || !chat.attemptId || !chat.attemptDir) {
    throw new Error("本运行还没有开始采集；先 start，完成聊天后再 finish")
  }
  const attemptDir = chat.attemptDir
  if (chat.sealedAt || existsSync(join(attemptDir, "manifest.json"))) {
    throw new Error("attempt 已封存；不重复封存")
  }
  if (!existsSync(join(attemptDir, "manifest.json.pending"))) {
    throw new Error(`attempt 草稿不存在：${attemptDir}`)
  }
  if (!existsSync(paths.driverProgressPath)) {
    throw new Error("driver-progress.json 不存在；先 drive，确认驱动结果后才能收口")
  }
  const progress = readDriverProgress(readJsonIfExists(paths.driverProgressPath))
  const outcome = driverOutcome(progress)
  const interrupted = options.interrupted === true
  const reasonText = typeof options.reason === "string" ? options.reason.trim() : ""
  if (outcome.status !== "completed" && !(interrupted && reasonText !== "")) {
    throw new Error(
      `驱动未完成（${outcome.reason ?? "未知原因"}）；确认按中断收口请加 --interrupted --reason <text>`,
    )
  }
  const closeReason = outcome.status === "completed" ? null : reasonText || outcome.reason
  const pid = state.hostPid
  if (!pid || !isAlive(pid)) {
    markUnsealed(state, "宿主已退出，采集无法收口")
    updateState(paths, state, { status: "failed", lastError: "宿主不在运行，无法收口采集" })
    throw new Error(`宿主不在运行，无法收口采集；证据按未封存保留，用 rescue --run-id ${runId} 按中断封存`)
  }

  const expected = { evaluationRunId: chat.evaluationRunId, attemptId: chat.attemptId, attemptDir }
  try {
    validateCaptureTrial(
      await sendBridgeCommand(paths, {
        type: "capture_end",
        caseId: state.caseId,
        trialId: chat.trialId,
        status: outcome.status === "completed" ? "completed" : "failed",
        ...(closeReason ? { error: closeReason } : {}),
      }, ["capture_trial"]),
      { phase: "end", caseId: state.caseId, trialId: chat.trialId },
    )
    const finished = validateCaptureFinished(
      await sendBridgeCommand(paths, {
        type: "capture_finish",
        status: outcome.status === "completed" ? "completed" : "interrupted",
        ...(closeReason ? { reason: closeReason } : {}),
      }, ["capture_finished"]),
      expected,
    )

    // 正式对话证据由测试侧写入：产品只提供真实会话消息，不直接落证据文件。
    const dialogue = createDialogueWriter(attemptDir)
    try {
      for (const message of finished.dialogue.messages) dialogue.append(message)
    } finally {
      dialogue.close()
    }
    if (finished.dialogue.sessions.length > 0) {
      extendChatAttemptSessions({ attemptDir, sessionIds: finished.dialogue.sessions })
    }
    // 驱动进度是本次执行的编排证据：封存前复制进 attempt，随 manifest 一起校验。
    copyArtifact({ attemptDir, name: "driver-progress.json", sourcePath: paths.driverProgressPath })

    const tracePath = join(attemptDir, "trace.jsonl")
    const actualModels = existsSync(tracePath) ? extractActualModels(readFileSync(tracePath, "utf8")) : []
    const sealedAt = nowIso()
    const sealed = await sealChatAttempt({
      attemptDir,
      sealedAt,
      models: { actual: actualModels.length > 0 ? actualModels.join(",") : null },
      sourceHash: computeSourceHash(),
      inputs: inputHashes({ state }),
      outcome: outcome.status,
      issues: finished.issues,
      deliverables: state.deliverables ?? [],
      dataRoot: state.dataRoot,
    })

    const driver = driverSummary(progress)
    const phase = sealed.status === "complete" ? "grading" : "blocked"
    setChatRunPhase(chat.runDir, {
      phase,
      updatedAt: sealedAt,
      ...(phase === "grading"
        ? { pendingDecision: null }
        : { pendingDecision: { kind: "evidence_incomplete", reason: sealed.issues.join("；") || "证据不完整" } }),
      nextAction: phase === "grading"
        ? `运行 node scripts/sim-eval-run.mjs judge prepare --run-id ${runId} 冻结判分包`
        : "证据不完整：按 issues 修复后重新采集（新 attempt 或新运行组）",
    })
    const reportDataset = loadReportDataset(state)
    const report = writeChatReport({ runDir: chat.runDir, generatedAt: sealedAt, dataset: reportDataset.dataset })
    const retention = pruneChatRuns({ reportsDir: CHAT_REPORTS_DIR, protect: [chat.evaluationRunId] })
    const nextChat = {
      ...chat,
      sealedAt,
      manifestSha256: sealed.manifestSha256,
      integrity: { status: sealed.status, issues: sealed.issues },
      driver: { ...driver, outcome: outcome.status },
      reportPath: relative(REPO_ROOT, report.path),
      retention: {
        blocked: retention.blocked,
        reasons: retention.reasons,
        kept: retention.kept,
        evicted: retention.evicted,
      },
    }
    updateState(paths, state, {
      status: "finished",
      finishedAt: sealedAt,
      chat: nextChat,
      driver: { ...state.driver, status: progress.status, index: progress.index, usage: driver.usage },
    })

    let stopError = null
    let stopProblems = []
    try {
      const stopped = await stop(runId)
      stopProblems = stopped?.problems ?? []
    } catch (error) {
      stopError = messageOf(error)
      const fresh = loadState(runId)
      updateState(fresh.paths, fresh.state, { lastError: `封存完成但宿主停止失败：${stopError}` })
    }

    console.log([
      `${sealed.status === "complete" ? "sealed" : "sealed (incomplete)"} ${runId}`,
      `  evidence: test/reports/chat/${chat.evaluationRunId}/attempts/${chat.attemptId}`,
      `  driver: ${driver.status} ${driver.completed}/${driver.total ?? state.driver.steps} 步`
        + ` · outcome=${outcome.status}${closeReason ? `（${closeReason}）` : ""}`
        + `${driver.confirmations ? ` · 工具确认 ${driver.confirmations} 次` : ""}`
        + `${driver.questions ? ` · 反问取消 ${driver.questions} 次` : ""}`,
      `  outcome: ${outcome.status} / integrity=${sealed.status}`,
      `  dialogue: ${finished.dialogue.messageCount} 条 / 会话 ${finished.dialogue.sessions.join(", ") || "（无）"}`,
      ...(sealed.manifest.deliverables.length > 0
        ? [`  deliverables: ${sealed.manifest.deliverables
          .map(item => `${item.id}=${item.status}${item.bytes === undefined ? "" : `(${item.bytes}B)`}`)
          .join(" ")}`]
        : []),
      `  models: requested=${chat.identity?.models?.requested ?? "?"} actual=${actualModels.join(",") || "（未记录）"}`,
      `  usage: messages=${driver.usage.messages} tokens=${driver.usage.tokens}`
        + `${driver.usage.tokensUnknown ? "（含未知用量）" : ""}`,
      `  report: ${relative(REPO_ROOT, report.path)}`,
      `  next: ${phase === "grading" ? `node scripts/sim-eval-run.mjs judge prepare --run-id ${runId}` : "修复证据后重新采集（旧证据保持只读）"}`,
      `  retention: kept=${retention.kept.join(", ") || "（无）"}${retention.evicted.length ? ` evicted=${retention.evicted.join(", ")}` : ""}`,
      ...(retention.blocked ? [`  retention blocked: ${retention.reasons.join("；")}`] : []),
      ...(sealed.issues.length ? [`  issues:\n${sealed.issues.map(issue => `    - ${issue}`).join("\n")}`] : []),
      ...(stopProblems.length ? [`  shutdown:\n${stopProblems.map(problem => `    - ${problem}`).join("\n")}`] : []),
      ...(stopError ? [`  stop error: ${stopError}`] : []),
    ].join("\n"))
    if (sealed.status !== "complete" || outcome.status !== "completed" || stopError || stopProblems.length) {
      process.exitCode = 1
    }
  } catch (error) {
    markUnsealed(state, messageOf(error))
    updateState(paths, state, { lastError: messageOf(error) })
    throw error
  }
}

// ── rescue ──

/**
 * 故障救援：宿主没有走完产品退出序列时，把已落盘的 attempt 草稿按中断封存，
 * 让未完成证据有终点、`prepare --repair-of` 可以继续。救援绝不冒充完成：
 * 缺对话、缺 trace 封口、缺 exit.json 都写进 issues，封存结果保持 inconclusive。
 */
export async function rescueRun({ runDir, state, reason = null, now = new Date().toISOString() }) {
  const paths = statePaths(runDir)
  const pid = state.hostPid ?? null
  if (pid && isAlive(pid)) throw new Error(`宿主仍在运行（pid=${pid}）；先 stop 再救援`)
  const chat = state.chat
  if (!chat?.attemptDir || !chat.attemptId) {
    throw new Error("本运行没有建立 attempt；没有可救援的采集证据（运行组用 stop 收口）")
  }
  if (chat.sealedAt || existsSync(join(chat.attemptDir, "manifest.json"))) {
    throw new Error("attempt 已封存；无需救援（用 report／review 查看证据）")
  }
  const pendingPath = join(chat.attemptDir, "manifest.json.pending")
  if (!existsSync(pendingPath)) throw new Error(`attempt 草稿不存在：${pendingPath}；没有可封存的证据`)
  const pending = readJsonIfExists(pendingPath)
  const text = typeof reason === "string" && reason.trim() ? reason.trim() : "宿主已退出，采集未收口"
  const { exit, problems } = hostExitEvidence(paths.exitPath, pid)

  if (existsSync(paths.driverProgressPath)) {
    copyArtifact({ attemptDir: chat.attemptDir, name: "driver-progress.json", sourcePath: paths.driverProgressPath })
  }
  const tracePath = join(chat.attemptDir, "trace.jsonl")
  const actualModels = existsSync(tracePath) ? extractActualModels(readFileSync(tracePath, "utf8")) : []
  const issues = [
    `宿主退出前未完成采集收口，救援封存：${text}`,
    ...(existsSync(paths.readyPath) ? ["ready.json 仍存在：宿主未走完产品退出序列"] : []),
    ...problems.map(problem => `关停证据：${problem}`),
  ]
  const sealed = await sealChatAttempt({
    attemptDir: chat.attemptDir,
    sealedAt: now,
    models: { actual: actualModels.length > 0 ? actualModels.join(",") : null },
    sourceHash: computeSourceHash(),
    inputs: pending.identity?.inputs ?? null,
    outcome: "interrupted",
    issues,
    deliverables: state.deliverables ?? [],
    dataRoot: state.dataRoot,
  })
  setChatRunPhase(chat.runDir, {
    phase: "blocked",
    updatedAt: now,
    pendingDecision: { kind: "evidence_incomplete", reason: sealed.issues.join("；") || text },
    nextAction: "证据已按中断封存；修复后按新运行组或 prepare --repair-of 重新采集",
  })
  const report = writeChatReport({ runDir: chat.runDir, generatedAt: now, dataset: loadReportDataset(state).dataset })
  updateState(paths, state, {
    status: "rescued",
    lastError: `故障救援：${text}`,
    chat: {
      ...chat,
      sealedAt: now,
      manifestSha256: sealed.manifestSha256,
      integrity: { status: sealed.status, issues: sealed.issues },
      reportPath: relative(REPO_ROOT, report.path),
    },
    hostExit: exit,
  })
  return {
    status: sealed.status,
    issues: sealed.issues,
    manifestSha256: sealed.manifestSha256,
    reportPath: report.path,
    hostExit: exit,
    hostExitProblems: problems,
  }
}

// ── batch ──

const BATCH_STATE_FILE = "batch.json"
export const BATCH_RUN_SCHEMA_VERSION = 1

function runChild(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  if (result.error) throw new Error(`子命令 ${args[0]} 启动失败：${result.error.message}`)
  return result.status ?? 1
}

function assertBatchRun(run, { entry, authorization, baseline }) {
  const cases = Array.isArray(run.scope?.caseIds) ? run.scope.caseIds : []
  const suites = Array.isArray(run.scope?.suiteIds) ? run.scope.suiteIds : []
  if (cases.length > 0 && !cases.includes(entry.caseId)) {
    throw new Error(`运行组 ${run.evaluationRunId} 的范围不含用例 ${entry.caseId}`)
  }
  if (suites.length > 0 && !suites.includes(entry.suiteId)) {
    throw new Error(`运行组 ${run.evaluationRunId} 的范围不含套件 ${entry.suiteId}`)
  }
  if (run.scope?.purpose !== authorization.scope.purpose) {
    throw new Error(`运行组用途=${String(run.scope?.purpose)} 与授权用途 ${authorization.scope.purpose} 不一致`)
  }
  if (run.scope?.holdout !== authorization.holdout) {
    throw new Error("运行组的 holdout 标记与授权不一致")
  }
  if (JSON.stringify(run.budget) !== JSON.stringify(authorization.budget)) {
    throw new Error("运行组预算与当前授权不一致；同一证据组不能混用不同预算")
  }
  if (JSON.stringify(run.baseline ?? null) !== JSON.stringify(baseline)) {
    throw new Error("运行组 baseline 与本次批量不一致；续跑必须沿用原基线")
  }
}

function findRunStateForAttempt(attemptDir) {
  if (!existsSync(RUNS_BASE)) return null
  const target = resolve(attemptDir)
  for (const entry of readdirSync(RUNS_BASE, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_DIR_PREFIX)) continue
    const runDir = join(RUNS_BASE, entry.name)
    const state = readJsonIfExists(join(runDir, RUNNER_STATE_FILE))
    if (!state?.chat?.attemptDir) continue
    if (resolve(REPO_ROOT, state.chat.attemptDir) !== target) continue
    return { runId: state.runId, runDir, state }
  }
  return null
}

function driveFailureReason(runId) {
  try {
    const { paths } = loadState(runId)
    const progress = readDriverProgress(readJsonIfExists(paths.driverProgressPath))
    const outcome = driverOutcome(progress)
    if (outcome.status !== "completed" && outcome.reason) return outcome.reason
  } catch (error) {
    // 进度文件不可读时退回 runner 的最后错误；原始失败仍然优先于通用文案。
    console.warn(`[batch] 读取驱动结果失败：${messageOf(error)}`)
  }
  try {
    const { state } = loadState(runId)
    if (state.lastError) return state.lastError
  } catch (error) {
    console.warn(`[batch] 读取运行状态失败：${messageOf(error)}`)
  }
  return "驱动未完成，原因未记录"
}

function validateBatchRecord(previous, { evaluationRunId, plan }) {
  if (previous?.schemaVersion !== BATCH_RUN_SCHEMA_VERSION) {
    throw new Error(`batch.json 版本不支持：${String(previous?.schemaVersion)}`)
  }
  if (previous.evaluationRunId !== evaluationRunId) {
    throw new Error(`batch.json 的评价组 ${previous.evaluationRunId} 与本次 ${evaluationRunId} 不一致`)
  }
  if (previous.caseId !== plan.caseId) throw new Error("batch.json 的用例与冻结计划不一致")
  if (previous.plannedTrials !== plan.plannedTrials || !Array.isArray(previous.trials)
    || previous.trials.length !== plan.plannedTrials) {
    throw new Error("batch.json 的槽位数量与冻结计划不一致")
  }
  for (const [index, trialId] of plan.trialIds.entries()) {
    if (previous.trials[index]?.trialId !== trialId) {
      throw new Error(`batch.json 第 ${index + 1} 个槽位 ${String(previous.trials[index]?.trialId)} 与计划 ${trialId} 不一致`)
    }
  }
  const runIds = previous.trials.map(slot => slot.runId).filter(Boolean)
  if (new Set(runIds).size !== runIds.length) throw new Error("batch.json 的子运行 id 重复")
}

/** 上一次 prepare/start 没留下 attempt 时换一个未占用的子运行 id；有 attempt 的槽位永远复用原现场。 */
function resolveSlotRunId({ evaluationRunId, index, previousSlots }) {
  const base = batchTrialRunId(evaluationRunId, index)
  const last = [...previousSlots].reverse().find(slot => slot.index === index)?.runId
  if (!last) return base
  const lastDir = runDirFor(last)
  if (!existsSync(lastDir)) return last
  const state = readJsonIfExists(join(lastDir, RUNNER_STATE_FILE))
  if (state?.chat?.attemptId) return last
  if (state?.hostPid && isAlive(state.hostPid)) return last
  for (let retry = 2; ; retry += 1) {
    const candidate = validateRunId(`${base}-r${retry}`)
    if (!existsSync(runDirFor(candidate))) return candidate
  }
}

async function runBatchSlot({ slot, runDir, evaluationRunId, entry, authorizationPath, cardPath, baseline, datasetRoot, humanizer }) {
  const existing = findAttemptByTrialId(runDir, entry.caseId, slot.trialId)
  if (existing) {
    const attemptDir = join(runDir, "attempts", existing.attemptId)
    if (existing.sealed) {
      const manifest = readJsonIfExists(join(attemptDir, "manifest.json"))
      const located = findRunStateForAttempt(attemptDir)
      return {
        runId: located?.runId ?? slot.runId,
        attemptId: existing.attemptId,
        status: "sealed",
        outcome: manifest?.outcome ?? null,
        integrity: manifest?.integrity?.status ?? null,
        reason: null,
      }
    }
    // 计划槽位已被未封存 attempt 占用：不能替换，先停掉可能残留的宿主再记账。
    const located = findRunStateForAttempt(attemptDir)
    if (located?.state?.hostPid && isAlive(located.state.hostPid)) {
      console.log(`[batch] ${slot.trialId} 的宿主仍在运行（run=${located.runId}）；先停止`)
      await stop(located.runId)
    }
    return {
      runId: located?.runId ?? slot.runId,
      attemptId: existing.attemptId,
      status: "unsealed",
      outcome: null,
      integrity: null,
      reason: "计划槽位已有未封存 attempt；不替换，保持失败占位",
    }
  }

  const runId = slot.runId
  const trialRunDir = runDirFor(runId)
  if (existsSync(trialRunDir)) {
    throw new Error(
      `trial ${slot.trialId} 的运行根已存在但没有对应 attempt（${relative(REPO_ROOT, trialRunDir)}）；`
      + "请人工核对后换新的评价组",
    )
  }
  const args = [
    "prepare", "--case", entry.caseId, "--card", cardPath, "--authorization", authorizationPath,
    "--run-id", runId, "--evaluation-run-id", evaluationRunId, "--trial-id", slot.trialId,
  ]
  if (datasetRoot) args.push("--dataset-root", datasetRoot)
  if (humanizer) args.push("--humanizer")
  if (baseline) args.push("--baseline", baseline.evaluationRunId)
  if (runChild(args) !== 0) throw new Error(`trial ${slot.trialId} prepare 失败；批量中止（已保留现场）`)
  if (runChild(["start", "--run-id", runId]) !== 0) {
    throw new Error(`trial ${slot.trialId} start 失败；批量中止（已保留现场）`)
  }
  const driveStatus = runChild(["drive", "--run-id", runId])
  if (driveStatus === 0) {
    runChild(["finish", "--run-id", runId])
  } else {
    const reason = driveFailureReason(runId)
    console.warn(`[batch] ${slot.trialId} 驱动未完成：${reason}；按中断收口并保留占位`)
    runChild(["finish", "--run-id", runId, "--interrupted", "--reason", reason])
  }

  const after = loadState(runId).state
  const attemptDir = after.chat?.attemptDir ?? null
  const manifest = attemptDir ? readJsonIfExists(join(attemptDir, "manifest.json")) : null
  if (!manifest) {
    if (after.hostPid && isAlive(after.hostPid)) {
      try {
        await stop(runId)
      } catch (error) {
        throw new Error(`trial ${slot.trialId} 未能封存且宿主停止失败：${messageOf(error)}；批量中止`)
      }
    }
    return {
      runId,
      attemptId: after.chat?.attemptId ?? null,
      status: "unsealed",
      outcome: null,
      integrity: null,
      reason: after.lastError ?? "finish 未封存",
    }
  }
  return {
    runId,
    attemptId: after.chat.attemptId,
    status: "sealed",
    outcome: manifest.outcome ?? null,
    integrity: manifest.integrity?.status ?? null,
    reason: manifest.outcome === "completed" ? null : after.lastError ?? null,
  }
}

/**
 * 串行执行冻结计划里的每个槽位。计划在第一个试次之前写入 trials.json，失败或不完整的
 * 试次保持占位、不被替换；批量只负责采集与封存，不判分、不调用模型 API。
 */
async function batch(options = {}) {
  if (options.runId) throw new Error("batch 用 --evaluation-run-id 指定证据组；--run-id 只用于单个试次")
  const { dataset, entry, suite } = loadCaseForRun({ caseId: options.caseId, label: "batch", datasetRoot: options.datasetRoot })
  if (!options.card) throw new Error("batch 缺少 --card <path>（fixture 需要的 Card 不被仓库跟踪）")
  const cardPath = resolve(options.card)
  if (!existsSync(cardPath)) throw new Error(`Card 文件不存在：${cardPath}`)
  if (!options.authorization) {
    throw new Error("batch 缺少 --authorization <file.json>（用户确认的用例范围、模型与预算）")
  }
  const authorizationPath = resolve(options.authorization)
  const authorization = readAuthorizationFile(authorizationPath, { caseIds: [entry.caseId], purpose: suite.purpose })
  const fingerprint = authorizationFingerprint(authorization)
  const evaluationRunId = options.evaluationRunId
    ? validateEvaluationRunId(options.evaluationRunId)
    : validateEvaluationRunId(makeRunId())
  const existingRunPath = join(CHAT_REPORTS_DIR, evaluationRunId)
  const existingRun = existsSync(join(existingRunPath, "run.json")) ? readChatRun(existingRunPath) : null
  const baseline = options.baselineId
    ? { evaluationRunId: validateEvaluationRunId(options.baselineId) }
    : existingRun?.baseline ?? null
  if (baseline?.evaluationRunId === evaluationRunId) {
    throw new Error("baseline 不能是本次运行的 evaluationRunId")
  }
  if (baseline && !existsSync(join(CHAT_REPORTS_DIR, baseline.evaluationRunId, "run.json"))) {
    throw new Error(`baseline 运行组不存在：${baseline.evaluationRunId}`)
  }
  const requested = options.trials === undefined ? null : Number(options.trials)
  let plan = existingRun ? readTrialPlan(existingRunPath) : null
  let plannedTrials
  if (plan) {
    if (plan.caseId !== entry.caseId) {
      throw new Error(`冻结计划的用例 ${plan.caseId} 与本次 ${entry.caseId} 不一致`)
    }
    if (plan.authorizationFingerprint !== fingerprint) {
      throw new Error("trials.json 的授权指纹与当前授权不一致；计划只能按冻结授权执行")
    }
    if (plan.budgetTrials !== authorization.budget.trials) {
      throw new Error(`trials.json 的预算 trials=${plan.budgetTrials} 与当前授权 ${authorization.budget.trials} 不一致`)
    }
    if (requested !== null && requested !== plan.plannedTrials) {
      throw new Error(`trial 计划已冻结为 ${plan.plannedTrials} 个；不能用 --trials=${String(options.trials)} 改写`)
    }
    plannedTrials = plan.plannedTrials
  } else {
    if (existingRun && listCaseTrialAttempts(existingRunPath, entry.caseId).length > 0) {
      throw new Error("运行组已有 attempt 但未冻结 trial 计划；不能事后补建计划")
    }
    plannedTrials = planTrialBatch({
      requestedTrials: requested, existingAttempts: 0, budgetTrials: authorization.budget.trials,
    }).plannedTrials
  }

  const scope = {
    suiteIds: [entry.suiteId],
    caseIds: [entry.caseId],
    purpose: authorization.scope.purpose,
    holdout: authorization.holdout,
  }
  const createdAt = nowIso()
  const chatRun = ensureChatRun({
    reportsDir: CHAT_REPORTS_DIR, evaluationRunId, createdAt, scope, budget: authorization.budget, baseline,
  })
  const runDir = chatRun.runDir
  if (!chatRun.created) assertBatchRun(chatRun.run, { entry, authorization, baseline })
  const trialIds = plan ? plan.trialIds : Array.from({ length: plannedTrials }, (_, index) => batchTrialId(evaluationRunId, index + 1))
  plan = ensureTrialPlan({
    runDir, evaluationRunId, caseId: entry.caseId, trialIds,
    budgetTrials: authorization.budget.trials, authorizationFingerprint: fingerprint, createdAt,
  }).plan

  const batchPath = join(runDir, BATCH_STATE_FILE)
  const previous = existsSync(batchPath) ? readJsonIfExists(batchPath) : null
  if (previous) validateBatchRecord(previous, { evaluationRunId, plan })
  const previousSlots = previous?.trials ?? []
  const record = {
    schemaVersion: BATCH_RUN_SCHEMA_VERSION,
    evaluationRunId,
    caseId: entry.caseId,
    createdAt: previous?.createdAt ?? createdAt,
    updatedAt: createdAt,
    plannedTrials: plan.plannedTrials,
    status: "running",
    trials: plan.trialIds.map((trialId, index) => ({
      index: index + 1,
      trialId,
      runId: resolveSlotRunId({ evaluationRunId, index: index + 1, previousSlots }),
      attemptId: null,
      status: "pending",
      outcome: null,
      integrity: null,
      reason: null,
    })),
    nextAction: null,
  }
  writeJsonAtomic(batchPath, record)
  setChatRunPhase(runDir, {
    phase: "preparing",
    updatedAt: createdAt,
    pendingDecision: null,
    nextAction: `batch 串行执行 ${record.plannedTrials} 个 trial（计划已冻结，失败不替换）`,
  })

  console.log([
    `batch ${evaluationRunId} · ${entry.caseId}`,
    `  plan: ${plan.plannedTrials} trials（budget trials=${authorization.budget.trials}）`,
    `  evidence: ${relative(REPO_ROOT, runDir)}`,
    ...record.trials.map(slot => `  #${slot.index} ${slot.trialId} → run ${slot.runId}`),
  ].join("\n"))

  for (const slot of record.trials) {
    try {
      Object.assign(slot, await runBatchSlot({
        slot, runDir, evaluationRunId, entry, authorizationPath, cardPath, baseline,
        datasetRoot: dataset.root, humanizer: options.humanizer === true,
      }))
    } catch (error) {
      record.status = "blocked"
      record.nextAction = messageOf(error)
      writeJsonAtomic(batchPath, record)
      try {
        setChatRunPhase(runDir, {
          phase: "blocked",
          updatedAt: nowIso(),
          pendingDecision: { kind: "batch_aborted", reason: messageOf(error) },
          nextAction: `批量中止：${messageOf(error)}`,
        })
      } catch (phaseError) {
        console.warn(`[batch] 标记运行组 blocked 失败：${messageOf(phaseError)}`)
      }
      throw error
    }
    writeJsonAtomic(batchPath, record)
  }

  const complete = record.trials.every(slot =>
    slot.status === "sealed" && slot.outcome === "completed" && slot.integrity === "complete")
  record.status = complete ? "completed" : "incomplete"
  const gradableRuns = record.trials.filter(slot => slot.status === "sealed" && slot.integrity === "complete")
  const nextAction = complete
    ? `对每个子运行执行 judge prepare 并回填独立 coding-agent judge 裁决；之后用 report 查看 pass^k`
    : "存在未封存、未完成或证据不完整的试次：该槽位保持占位，pass^k 只能 inconclusive；核对后新开评价组"
  record.nextAction = nextAction
  writeJsonAtomic(batchPath, record)
  setChatRunPhase(runDir, {
    phase: complete ? "awaiting_judge" : "blocked",
    updatedAt: nowIso(),
    pendingDecision: complete ? null : { kind: "trial_incomplete", reason: nextAction },
    nextAction,
  })
  const report = writeChatReport({ runDir, generatedAt: nowIso(), dataset })
  console.log([
    `batch ${complete ? "collected" : "incomplete"} ${evaluationRunId}`,
    `  trials: ${record.trials.filter(slot => slot.status === "sealed").length}/${record.plannedTrials} 已封存`
      + ` · ${record.trials.filter(slot => slot.outcome === "completed").length} 执行完成`
      + ` · ${record.trials.filter(slot => slot.status === "unsealed").length} 未封存`,
    `  report: ${relative(REPO_ROOT, report.path)}`,
    ...record.trials.map(slot => `  #${slot.index} ${slot.trialId}: ${slot.status}`
      + `${slot.outcome ? ` · ${slot.outcome}` : ""}${slot.integrity ? ` · ${slot.integrity}` : ""}`
      + `${slot.reason ? `（${slot.reason}）` : ""}`),
    ...(gradableRuns.length > 0
      ? [`  judge: ${gradableRuns.map(slot => `${slot.trialId} → node scripts/sim-eval-run.mjs judge prepare --run-id ${slot.runId}`
        + `${slot.attemptId ? ` --attempt-id ${slot.attemptId}` : ""}`).join("\n         ")}`]
      : []),
    `  next: ${nextAction}`,
  ].join("\n"))
  if (!complete) process.exitCode = 1
  return record
}

// ── compare / holdout ──

function latestSealedAttemptForCase(runDir, caseId) {
  const attemptsDir = join(runDir, "attempts")
  for (const attemptId of listAttemptIds(runDir).reverse()) {
    const attemptDir = join(attemptsDir, attemptId)
    const manifestPath = join(attemptDir, "manifest.json")
    if (!existsSync(manifestPath)) continue
    const manifest = readJsonIfExists(manifestPath)
    if (!(manifest?.expectedTrials ?? []).some(trial => trial.caseId === caseId)) continue
    return { attemptId, attemptDir, manifest, verification: verifySealedAttempt(attemptDir) }
  }
  return null
}

/**
 * 同条件对照：候选与基线的固定条件必须一致；代码/Card/配置变化只记录。
 * 只比身份与输入哈希，不读探针或 oracle，也不产生分数。
 */
function compare(runId, options = {}) {
  const { state } = loadState(runId)
  if (!state.chat?.runDir || !state.chat.attemptDir) {
    throw new Error("本运行还没有采集；compare 只比较已封存的 attempt")
  }
  const baselineId = options.baselineId ?? state.baseline?.evaluationRunId
  if (!baselineId) throw new Error("compare 需要 --baseline <evaluationRunId>，或在 prepare 时声明 baseline")
  validateEvaluationRunId(baselineId)
  const candidateRun = readChatRun(state.chat.runDir)
  const candidate = sealedAttemptFor(state)
  if (candidate.verification.issues.length > 0 || candidate.verification.status !== "complete") {
    throw new Error(
      `候选证据不可用于对照：${candidate.verification.issues.join("；") || candidate.verification.status}`,
    )
  }

  const baselineDir = join(CHAT_REPORTS_DIR, baselineId)
  if (!existsSync(join(baselineDir, "run.json"))) throw new Error(`baseline 运行组不存在：${baselineId}`)
  const baselineRun = readChatRun(baselineDir)
  if (!Array.isArray(baselineRun.scope?.caseIds) || !baselineRun.scope.caseIds.includes(state.caseId)) {
    throw new Error(`baseline ${baselineId} 的范围不含用例 ${state.caseId}`)
  }
  const baselineAttempt = latestSealedAttemptForCase(baselineDir, state.caseId)
  if (!baselineAttempt) throw new Error(`baseline ${baselineId} 没有用例 ${state.caseId} 的已封存 attempt`)
  if (baselineAttempt.verification.issues.length > 0 || baselineAttempt.verification.status !== "complete") {
    throw new Error(
      `baseline 证据不可用于对照：${baselineAttempt.verification.issues.join("；") || baselineAttempt.verification.status}`,
    )
  }

  const result = compareRunConditions({
    candidate: {
      evaluationRunId: candidateRun.evaluationRunId,
      conditions: conditionsFromRun({ run: candidateRun, manifest: candidate.verification.manifest }),
    },
    baseline: {
      evaluationRunId: baselineRun.evaluationRunId,
      conditions: conditionsFromRun({ run: baselineRun, manifest: baselineAttempt.verification.manifest }),
    },
  })
  result.candidateAttemptId = candidate.attemptId
  result.baselineAttemptId = baselineAttempt.attemptId

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log([
      `compare ${result.candidateRunId} vs ${result.baselineRunId}`,
      `  comparable: ${result.comparable ? "yes" : "no"}`,
      ...(result.issues.length ? [`  issues:\n${result.issues.map(issue => `    - ${issue}`).join("\n")}`] : []),
      ...result.checks.map(check => `  ${check.status === "same" ? "=" : "≠"} ${check.field}:`
        + ` baseline=${JSON.stringify(check.baseline)} candidate=${JSON.stringify(check.candidate)}`),
      `  target changes: ${result.targetChanges.length === 0 ? "（无）" : result.targetChanges
        .map(change => `${change.field}: ${JSON.stringify(change.baseline)} → ${JSON.stringify(change.candidate)}`).join("；")}`,
    ].join("\n"))
  }
  if (!result.comparable) process.exitCode = 1
  return result
}

/** 留出用例是否已被任何运行组使用（含在途与待审）；只报告，不改变证据。 */
function holdout(options = {}) {
  if (!options.caseId) throw new Error("holdout 需要 --case <caseId>")
  const dataset = loadDataset({ repoRoot: REPO_ROOT, root: options.datasetRoot, caseIds: [options.caseId] })
  if (dataset.errors.length > 0) {
    throw new Error(`数据集有 ${dataset.errors.length} 个错误：${dataset.errors.map(problem => problem.message).join("；")}`)
  }
  if (!dataset.cases.some(entry => entry.caseId === options.caseId)) {
    throw new Error(`数据集里找不到用例：${options.caseId}`)
  }
  const usage = holdoutUsage({ runs: listChatRuns(CHAT_REPORTS_DIR), caseId: options.caseId })
  if (options.json) {
    console.log(JSON.stringify(usage, null, 2))
  } else {
    console.log([
      `holdout ${usage.caseId}: ${usage.used ? "已使用" : "未使用"}`,
      ...usage.uses.map(use => `  - ${use.evaluationRunId} @ ${use.createdAt ?? "?"}`
        + ` phase=${use.phase ?? "?"} purpose=${use.purpose ?? "?"} holdout=${use.holdout}`),
    ].join("\n"))
  }
  return usage
}

// ── judge / review / report ──

function ruleCountsLine(counts) {
  return `必需 ${counts.required.pass}/${counts.required.total}；禁止 ${counts.forbidden.pass}/${counts.forbidden.total}；关键 ${counts.critical.pass}/${counts.critical.total}`
}

function judgeIdentity(judge) {
  if (!judge) return "（无）"
  return `${judge.platform ?? "?"}/${judge.model ?? "?"} · ${judge.promptVersion ?? "?"}`
}

function spotCheckLine(spotCheck) {
  if (!spotCheck || spotCheck.status !== "checked") return "未抽查（可选，不阻塞）"
  return `${spotCheck.checked}/${spotCheck.total} 条（agree ${spotCheck.agreements} / disagree ${spotCheck.disagreements}）`
}

function loadAttemptStatus({ entry, attemptDir }) {
  const context = loadJudgingContext({ attemptDir, caseEntry: entry })
  const records = readJudgingRecords(attemptDir)
  return {
    context,
    records,
    status: summarizeAttemptStatus({
      caseEntry: entry,
      context,
      grades: records.grades,
      reviews: records.reviews,
    }),
  }
}

function judgePrepare(runId, options) {
  const { paths, state } = loadState(runId)
  const { dataset, entry } = loadCaseContext(state)
  const { attemptId, attemptDir } = sealedAttemptFor(state, options.attemptId ?? null)
  const now = nowIso()
  const prepared = prepareJudgePacket({
    runDir: state.chat.runDir,
    attemptDir,
    dataset,
    caseEntry: entry,
    now,
  })
  const packetPath = relative(REPO_ROOT, prepared.packetPath)
  const underTest = prepared.packet.underTest?.actual ?? prepared.packet.underTest?.requested
  const nextAction = `把判分包交给独立 coding-agent judge${underTest ? `（不得使用被测模型 ${underTest}）` : ""}逐条裁决，回填 verdicts JSON 后运行 judge apply --run-id ${runId} --verdicts <file.json>`
  setPhaseForRun(state, {
    phase: "awaiting_judge",
    pendingDecision: { kind: "judge_verdicts", packetId: prepared.packet.packetId, packetPath },
    nextAction,
    at: now,
  })
  const report = writeReportAfterPhase(state, dataset, now)
  updateState(paths, state, {
    lastError: null,
    chat: { ...state.chat, reportPath: relative(REPO_ROOT, report.path) },
  })
  if (options.json) {
    console.log(JSON.stringify({
      runId,
      attemptId,
      packetId: prepared.packet.packetId,
      packetPath,
      packetSha256: prepared.packetSha256,
      skippedRules: prepared.skippedRules,
      phase: "awaiting_judge",
      next: nextAction,
      report: relative(REPO_ROOT, report.path),
    }, null, 2))
    return
  }
  console.log(formatJudgePacket({ packet: prepared.packet }))
  console.log([
    "",
    `packet: ${packetPath}`,
    `report: ${relative(REPO_ROOT, report.path)}`,
    `next: ${nextAction}`,
  ].join("\n"))
}

/** 判分视图：从已冻结的判分包派生精简读取件，不改判定字段，也不覆盖已有视图。 */
function judgeView(runId, options) {
  const { state } = loadState(runId)
  const source = options.packetId
    ? readJudgePacket({ runDir: state.chat.runDir, packetId: options.packetId })
    : latestJudgePacket({ runDir: state.chat.runDir })
  const now = nowIso()
  const { view } = projectJudgeView({ packet: source.packet, packetSha256: source.packetSha256, now })
  const viewPath = source.packetPath.replace(/\.packet\.json$/, ".view.json")
  if (existsSync(viewPath)) {
    throw new Error(`判分视图已存在，拒绝覆盖：${relative(REPO_ROOT, viewPath)}`)
  }
  writeFileSync(viewPath, `${JSON.stringify(view, null, 2)}\n`, { flag: "wx" })
  const packetBytes = readFileSync(source.packetPath).length
  const viewBytes = readFileSync(viewPath).length
  if (options.json) {
    console.log(JSON.stringify({
      runId,
      attemptId: source.packet.attemptId,
      packetId: source.packet.packetId,
      packetPath: relative(REPO_ROOT, source.packetPath),
      packetSha256: source.packetSha256,
      viewPath: relative(REPO_ROOT, viewPath),
      viewSha256: view.viewSha256,
      packetBytes,
      viewBytes,
      inlinedSeqs: view.projection.inlinedSeqs,
      omittedSections: view.projection.omittedSections.map((item) => item.section),
    }, null, 2))
    return
  }
  console.log([
    `packet: ${relative(REPO_ROOT, source.packetPath)}（${packetBytes} 字节）`,
    `view:   ${relative(REPO_ROOT, viewPath)}（${viewBytes} 字节）`,
    `内联回合: ${view.projection.inlinedSeqs.length}；省略段落: ${view.projection.omittedSections.map((item) => item.section).join("、") || "（无）"}`,
    `next: 判分员按 view 逐条裁决，回填 verdicts 的 packetId 与 packetSha256 取 view 顶层同名字段`,
  ].join("\n"))
}

function judgeApply(runId, options) {
  const { paths, state } = loadState(runId)
  const { dataset, entry } = loadCaseContext(state)
  const { attemptId, attemptDir } = sealedAttemptFor(state, options.attemptId ?? null)
  const input = readVerdictsInput(options)
  const packetId = input.body.packetId
  if (typeof packetId !== "string" || !packetId.trim()) {
    throw new Error("裁决文件必须包含 packetId（取自 judge prepare 冻结的判分包）")
  }
  const now = nowIso()
  const applied = applyJudgeVerdicts({
    runDir: state.chat.runDir,
    attemptDir,
    dataset,
    caseEntry: entry,
    packetId,
    verdicts: input.body,
    verdictsSha256: input.sha256,
    now,
  })
  const { status } = loadAttemptStatus({ entry, attemptDir })
  const transition = phaseAfterJudgeApply({ status })
  setPhaseForRun(state, { ...transition, at: now })
  const report = writeReportAfterPhase(state, dataset, now)
  const judging = {
    judgedAt: now,
    attemptId,
    gradeId: applied.gradeId,
    packetId,
    judge: applied.judge,
    counts: applied.counts,
    skippedRules: applied.skippedRules,
    overall: status.overall,
    spotCheck: status.spotCheck,
  }
  updateState(paths, state, {
    lastError: null,
    chat: { ...state.chat, judgedAt: now, judging, reportPath: relative(REPO_ROOT, report.path) },
  })
  if (options.json) {
    console.log(JSON.stringify({
      runId,
      attemptId,
      gradeId: applied.gradeId,
      packetId,
      judge: applied.judge,
      counts: applied.counts,
      skippedRules: applied.skippedRules,
      check: status.check,
      overall: status.overall,
      spotCheck: status.spotCheck,
      phase: transition.phase,
      next: transition.nextAction,
      report: relative(REPO_ROOT, report.path),
    }, null, 2))
  } else {
    console.log([
      `judged ${runId} / attempt ${attemptId}`,
      `  judge: ${judgeIdentity(applied.judge)} · grade ${applied.gradeId}`,
      `  rules: ${ruleCountsLine(applied.counts)}`,
      ...(applied.skippedRules.length ? [`  skipped: ${applied.skippedRules.join("、")}（inconclusive）`] : []),
      `  overall: ${status.overall.status} — ${status.overall.reason}`,
      `  spot check: ${spotCheckLine(status.spotCheck)}`,
      `  phase: ${transition.phase}`,
      `  next: ${transition.nextAction}`,
      `  report: ${relative(REPO_ROOT, report.path)}`,
    ].join("\n"))
  }
}

function reviewShow(runId, options) {
  const { state } = loadState(runId)
  if (!state.chat?.runDir) throw new Error("本运行还没有建立运行组")
  const { entry } = loadCaseContext(state)
  const { attemptId, attemptDir } = sealedAttemptFor(state, options.attemptId ?? null)
  const { status } = loadAttemptStatus({ entry, attemptDir })
  const grade = latestJudgeGrade(attemptDir)
  const payload = {
    runId,
    attemptId,
    evidence: status.evidence,
    execution: status.execution,
    grade: grade ? {
      gradeId: grade.gradeId,
      packetId: grade.summary?.packetId ?? null,
      judgedAt: grade.summary?.judgedAt ?? grade.createdAt,
      judge: grade.summary?.judge ?? null,
      skippedRules: grade.summary?.skippedRules ?? [],
      path: relative(REPO_ROOT, join(attemptDir, "grades", `${grade.gradeId}.json`)),
    } : null,
    check: status.check,
    overall: status.overall,
    spotCheck: status.spotCheck,
    report: state.chat.reportPath ?? null,
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log([
    `review ${runId} / attempt ${attemptId}`,
    `  evidence: ${status.evidence}；execution: ${status.execution}`,
    ...(grade ? [
      `  grade: ${grade.gradeId} · packet ${grade.summary?.packetId ?? "?"}`,
      `  judge: ${judgeIdentity(grade.summary?.judge)} · ${grade.summary?.judgedAt ?? grade.createdAt}`,
    ] : ["  grade: 尚无可信判分"]),
    `  check: ${status.check.status}；${ruleCountsLine(status.check.counts)}`,
    ...(grade?.summary?.skippedRules?.length ? [`  skipped: ${grade.summary.skippedRules.join("、")}（inconclusive）`] : []),
    `  overall: ${status.overall.status} — ${status.overall.reason}`,
    `  spot check: ${spotCheckLine(status.spotCheck)}`,
    ...status.spotCheck.rules.map(item => `    - ${item.ruleId}: judge=${item.judgeStatus} / 用户=${item.verdict}（${item.agreement}）${item.reason ? ` — ${item.reason}` : ""}`),
    `  report: ${state.chat.reportPath ?? "（未生成）"}`,
    "",
    "规则：",
    ...status.checks.map(check => `  - ${check.ruleId}: ${check.status} — ${check.reason}`),
  ].join("\n"))
}

function reviewSpotCheck(runId, options) {
  const { paths, state } = loadState(runId)
  const { dataset, entry } = loadCaseContext(state)
  const { attemptId, attemptDir } = sealedAttemptFor(state, options.attemptId ?? null)
  const input = readSpotCheckInput(options)
  const now = nowIso()
  const applied = recordSpotCheck({
    attemptDir,
    reviewer: input.reviewer,
    checks: input.checks,
    notes: input.notes,
    gradeId: options.gradeId ?? null,
    now,
  })
  const { status } = loadAttemptStatus({ entry, attemptDir })
  const report = writeReportAfterPhase(state, dataset, now)
  const workflow = readChatWorkflow(state.chat.runDir)
  const review = {
    reviewedAt: now,
    reviewId: applied.reviewId,
    gradeId: applied.record.gradeId,
    coverage: applied.coverage,
    overall: status.overall,
    spotCheck: status.spotCheck,
    reportPath: relative(REPO_ROOT, report.path),
  }
  updateState(paths, state, {
    lastError: null,
    chat: { ...state.chat, reviewedAt: now, review, reportPath: relative(REPO_ROOT, report.path) },
  })
  if (options.json) {
    console.log(JSON.stringify({
      runId,
      attemptId,
      reviewId: applied.reviewId,
      gradeId: applied.record.gradeId,
      coverage: applied.coverage,
      spotCheck: status.spotCheck,
      overall: status.overall,
      phase: workflow.phase,
      reviewPath: relative(REPO_ROOT, join(attemptDir, "reviews", `${applied.reviewId}.json`)),
      report: relative(REPO_ROOT, report.path),
    }, null, 2))
    return
  }
  console.log([
    `spot-checked ${runId} / attempt ${attemptId}`,
    `  review: ${applied.reviewId} · grade ${applied.record.gradeId}`,
    `  coverage: ${applied.coverage.checked}/${applied.coverage.total}（agree ${applied.coverage.agreements} / disagree ${applied.coverage.disagreements}）`,
    `  overall: ${status.overall.status} — ${status.overall.reason}（抽查不改变自动判分）`,
    `  phase: ${workflow.phase}（不变）`,
    `  review record: ${relative(REPO_ROOT, join(attemptDir, "reviews", `${applied.reviewId}.json`))}`,
    `  report: ${relative(REPO_ROOT, report.path)}`,
  ].join("\n"))
}

function reportCommand(runId, options) {
  const { paths, state } = loadState(runId)
  if (!state.chat?.runDir) throw new Error("本运行还没有建立运行组；没有可渲染的报告")
  const loaded = loadReportDataset(state)
  if (loaded.error) console.warn(`[report] ${loaded.error}；报告只显示证据层`)
  const now = nowIso()
  const report = writeReportAfterPhase(state, loaded.dataset, now)
  updateState(paths, state, { chat: { ...state.chat, reportPath: relative(REPO_ROOT, report.path) } })
  const workflow = readChatWorkflow(state.chat.runDir)
  if (options.json) {
    console.log(JSON.stringify({
      runId,
      report: relative(REPO_ROOT, report.path),
      phase: workflow.phase,
      pendingDecision: workflow.pendingDecision,
      nextAction: workflow.nextAction,
      dataset: loaded.dataset ? "current" : "unavailable",
      datasetError: loaded.error,
    }, null, 2))
    return
  }
  console.log([
    `report ${runId}`,
    `  path: ${relative(REPO_ROOT, report.path)}`,
    `  phase: ${workflow.phase}`,
    `  pending: ${JSON.stringify(workflow.pendingDecision ?? null)}`,
    `  next: ${workflow.nextAction ?? "（未记录）"}`,
    ...(loaded.error ? [`  dataset: ${loaded.error}；报告只显示证据层`] : []),
  ].join("\n"))
}

function judgeCommand(runId, action, options) {
  if (action === "prepare") return judgePrepare(runId, options)
  if (action === "view") return judgeView(runId, options)
  if (action === "apply") return judgeApply(runId, options)
  throw new Error(`未知 judge 子命令：${String(action)}；可用 prepare|view|apply`)
}

function reviewCommand(runId, action, options) {
  if (action === "show") return reviewShow(runId, options)
  if (action === "spotcheck") return reviewSpotCheck(runId, options)
  throw new Error(`未知 review 子命令：${String(action)}；可用 show|spotcheck`)
}

// ── stop ──

function writeStopRequest(paths, reason) {
  if (existsSync(paths.stopPath)) return false
  writeFileSync(paths.stopPath, `${new Date().toISOString()} ${reason}\n`)
  return true
}

async function stop(runId) {
  const { paths, state } = loadState(runId)
  if (state.chat?.attemptDir && !state.chat.sealedAt && !existsSync(join(state.chat.attemptDir, "manifest.json"))) {
    if (markUnsealed(state, "runner stop 时采集仍未封存")) {
      updateState(paths, state, { lastError: "宿主停止前采集未封存；运行组已标记 blocked" })
    }
  }
  const ready = readJsonIfExists(paths.readyPath)
  if (ready) validateHostReady(ready, { runDir: state.runDir, pid: ready.pid })
  if (ready && state.hostPid && ready.pid !== state.hostPid) {
    throw new Error(`ready.json pid=${ready.pid} 与 runner.json hostPid=${state.hostPid} 不一致`)
  }
  const pid = state.hostPid ?? ready?.pid ?? null

  if (!pid) {
    if (state.status !== "stopped") updateState(paths, state, { status: "stopped", stoppedAt: new Date().toISOString() })
    console.log(`${runId} 没有启动过宿主，无需停止`)
    return { pid: null, hostExit: null, problems: [] }
  }

  if (!isAlive(pid)) {
    if (ready) {
      throw new Error(
        `宿主 pid=${pid} 已退出但 ready.json 还在；这是异常现场，不自动删除（请人工核对；`
        + `未封存的采集用 rescue --run-id ${runId} 封存）`,
      )
    }
    const { exit, problems } = hostExitEvidence(paths.exitPath, pid)
    if (state.status !== "stopped") {
      updateState(paths, state, {
        status: "stopped",
        stoppedAt: new Date().toISOString(),
        hostExit: exit,
        ...(problems.length ? { lastError: `宿主已退出，但关停证据不完整：${problems.join("；")}` } : {}),
      })
    }
    console.log(`${runId} 已停止（pid=${pid} 不存在）`)
    if (problems.length) console.warn(`${runId} 关停证据：${problems.join("；")}`)
    return { pid, hostExit: exit, problems }
  }

  if (writeStopRequest(paths, "runner stop")) console.log(`${runId} 写入 stop.request，等待统一退出序列`)
  else console.log(`${runId} stop.request 已存在，继续等待退出`)
  const stopped = await waitForStopQuiet(pid, paths, STOP_WAIT_MS)
  if (!stopped) throw new Error(`宿主 pid=${pid} 在 ${Math.round(STOP_WAIT_MS / 1000)}s 内未停止；未发送信号`)
  const { exit, problems } = hostExitEvidence(paths.exitPath, pid)
  updateState(paths, state, {
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    hostExit: exit,
    ...(problems.length ? { lastError: `宿主关停未干净：${problems.join("；")}` } : {}),
  })
  console.log(`${runId} 已停止（pid=${pid}）`)
  if (problems.length) console.warn(`${runId} 关停未干净：${problems.join("；")}`)
  return { pid, hostExit: exit, problems }
}

async function stopCommand(runId) {
  const result = await stop(runId)
  if (result?.problems?.length) process.exitCode = 1
}

/** 救援是显式的人工裁决：只封存草稿，不重启宿主，也不推进驱动。 */
async function rescueCommand(runId, options = {}) {
  const { runDir, state } = loadState(runId)
  const result = await rescueRun({ runDir, state, reason: options.reason ?? null })
  console.log([
    `rescued ${runId}（${result.status}）`,
    `  evidence: ${relative(REPO_ROOT, state.chat.attemptDir)}`,
    `  manifest: ${result.manifestSha256}`,
    `  report: ${relative(REPO_ROOT, result.reportPath)}`,
    `  hostExit: ${result.hostExit ? "已记录" : "缺失"}`,
    ...(result.issues.length ? [`  issues:\n${result.issues.map(issue => `    - ${issue}`).join("\n")}`] : []),
    "  next: 修复后按新运行组或 prepare --repair-of 重新采集",
  ].join("\n"))
  if (result.status !== "complete") process.exitCode = 1
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

  let driver = state.driver ?? null
  try {
    if (existsSync(paths.driverProgressPath)) {
      const progress = readDriverProgress(readJsonIfExists(paths.driverProgressPath))
      driver = { ...driverSummary(progress), steps: state.driver.steps, checkpoints: state.driver.checkpoints }
    }
  } catch (error) {
    driver = { ...(state.driver ?? {}), error: messageOf(error) }
  }

  let holdout = null
  try {
    holdout = holdoutUsage({ runs: listChatRuns(CHAT_REPORTS_DIR), caseId: state.caseId })
  } catch (error) {
    holdout = { error: messageOf(error) }
  }

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

  let chat = null
  let chatError = null
  if (state.chat?.runDir && existsSync(join(state.chat.runDir, "run.json"))) {
    try {
      const workflow = readChatWorkflow(state.chat.runDir)
      const manifestPath = state.chat.attemptDir ? join(state.chat.attemptDir, "manifest.json") : null
      const manifest = manifestPath && existsSync(manifestPath) ? readJsonIfExists(manifestPath) : null
      chat = {
        evaluationRunId: state.chat.evaluationRunId,
        trialId: state.chat.trialId,
        runDir: relative(REPO_ROOT, state.chat.runDir),
        phase: workflow.phase,
        attemptId: state.chat.attemptId,
        attemptDir: state.chat.attemptDir ? relative(REPO_ROOT, state.chat.attemptDir) : null,
        evidence: manifest ? {
          status: manifest.integrity?.status ?? "unknown",
          outcome: manifest.outcome,
          sealedAt: manifest.sealedAt,
          manifestSha256: manifest.manifestSha256,
        } : null,
        report: state.chat.reportPath ?? null,
        retention: state.chat.retention ?? null,
        judgedAt: state.chat.judgedAt ?? null,
        judging: state.chat.judging ?? null,
        reviewedAt: state.chat.reviewedAt ?? null,
        review: state.chat.review ?? null,
      }
    } catch (error) {
      chatError = messageOf(error)
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
    authorization: state.authorization ?? null,
    clock: state.clock ?? null,
    driver,
    baseline: state.baseline ?? null,
    repair: state.repair ?? null,
    holdout,
    host: { pid, alive, ready: Boolean(ready), readyError, generation: ready?.generation ?? state.generation },
    hostExit: state.hostExit ?? null,
    bridge,
    seedReport,
    chat,
    ...(chatError ? { chatError } : {}),
    controlDir: state.controlDir,
    hostLog: relative(REPO_ROOT, paths.hostLogPath),
    lastError: state.lastError,
  }, null, 2))
}

// ── CLI ──

function parseArgs(argv) {
  const options = {}
  const names = {
    "--dataset-root": "datasetRoot",
    "--mcp-server": "mcpServer",
    "--model-settings": "modelSettings",
    "--case": "caseId",
    "--card": "card",
    "--authorization": "authorization",
    "--run-id": "runId",
    "--evaluation-run-id": "evaluationRunId",
    "--trial-id": "trialId",
    "--trials": "trials",
    "--attempt-id": "attemptId",
    "--packet-id": "packetId",
    "--baseline": "baselineId",
    "--repair-of": "repairOf",
    "--reason": "reason",
    "--verdicts": "verdictsPath",
    "--checks": "checksPath",
    "--grade-id": "gradeId",
    "--reviewer-name": "reviewerName",
    "--notes": "notes",
  }
  const flags = new Set(["--json", "--interrupted", "--humanizer"])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (flags.has(arg)) {
      options[arg.slice(2)] = true
      continue
    }
    if (names[arg]) {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`)
      options[names[arg]] = value
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = [
  "用法：",
  "  node scripts/sim-eval-run.mjs prepare --case <caseId> --card <card.md> --authorization <auth.json>",
  "      [--run-id <id>] [--evaluation-run-id <id>] [--trial-id <id>] [--baseline <evaluationRunId>] [--humanizer]",
  "  node scripts/sim-eval-run.mjs prepare --repair-of <runId> [--run-id <id>] [--trial-id <id>]",
  "  node scripts/sim-eval-run.mjs start --run-id <id>",
  "  node scripts/sim-eval-run.mjs drive --run-id <id>",
  "  node scripts/sim-eval-run.mjs status --run-id <id>",
  "  node scripts/sim-eval-run.mjs finish --run-id <id> [--interrupted --reason <text>]",
  "  node scripts/sim-eval-run.mjs batch --case <caseId> --card <card.md> --authorization <auth.json>",
  "      [--trials <n>] [--evaluation-run-id <id>] [--baseline <evaluationRunId>] [--humanizer]",
  "  node scripts/sim-eval-run.mjs compare --run-id <id> [--baseline <evaluationRunId>] [--json]",
  "  node scripts/sim-eval-run.mjs holdout --case <caseId> [--json]",
  "  node scripts/sim-eval-run.mjs judge prepare --run-id <id> [--attempt-id <id>] [--json]",
  "  node scripts/sim-eval-run.mjs judge view --run-id <id> [--packet-id <id>] [--json]",
  "  node scripts/sim-eval-run.mjs judge apply --run-id <id> --verdicts <file.json> [--attempt-id <id>] [--json]",
  "  node scripts/sim-eval-run.mjs review show --run-id <id> [--attempt-id <id>] [--json]",
  "  node scripts/sim-eval-run.mjs review spotcheck --run-id <id> --checks <file.json>",
  "      [--attempt-id <id>] [--grade-id <id>] [--reviewer-name <name>] [--notes <text>] [--json]",
  "  node scripts/sim-eval-run.mjs report --run-id <id> [--json]",
  "  node scripts/sim-eval-run.mjs stop --run-id <id>",
  "  node scripts/sim-eval-run.mjs rescue --run-id <id> [--reason <text>]",
  "",
  "prepare 需要用户显式给出的授权文件（用例范围、模型、预算、是否留出），并写入固定时钟",
  "与驱动包；start 只拉起宿主并开始采集；drive 按驱动包推进固定时钟与消息，进度可续跑，",
  "已开始但结果未知的步骤不重放；finish 只按驱动结果收口，驱动未完成时必须显式",
  "--interrupted --reason。batch 先在运行组冻结 trials.json，再按计划串行准备、启动、驱动与",
  "封存每个试次；失败或不完整的试次保持占位，不自动替换，也不自动判分。",
  "新运行的合成 CONFIG 默认关闭拟人化（ai.humanizer.enabled=false），评测读到的就是模型原样；",
  "需要测拟人化链路本身时加 --humanizer，修复沿用原运行的开关。",
  "compare 只比较两次运行的固定条件，holdout 只报告留出使用记录。",
  "stop 只写 stop.request 并核对宿主留下的 exit.json（flush 未完成、强杀、中断都会报出）；",
  "宿主没走完退出序列时 rescue 把已落盘的草稿按中断封存，证据保持 inconclusive。",
  "",
  "judge prepare 只冻结判分包；judge view 只为已冻结的判分包写出精简读取件，不改变判定要求；",
  "judge apply 只校验并记录独立 coding-agent judge 的回填裁决，",
  "运行器不调用模型 API、不读取 judge 凭据。review spotcheck 只记录用户本人的可选抽查，",
  "不改变自动判分，也不阻塞流程。",
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
  const hasAction = command === "judge" || command === "review"
  const subAction = hasAction ? rest[0] : null
  const options = parseArgs(hasAction ? rest.slice(1) : rest)
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (command === "prepare") return prepare(options)
  if (command === "batch") return batch(options)
  if (command === "holdout") return holdout(options)
  const runId = options.runId
  if (!runId) throw new Error(`${command} 缺少 --run-id <id>`)
  validateRunId(runId)
  if (command === "start") return start(runId)
  if (command === "drive") return drive(runId)
  if (command === "status") return status(runId)
  if (command === "finish") return finish(runId, options)
  if (command === "compare") return compare(runId, options)
  if (command === "judge") return judgeCommand(runId, subAction, options)
  if (command === "review") return reviewCommand(runId, subAction, options)
  if (command === "report") return reportCommand(runId, options)
  if (command === "stop") return stopCommand(runId)
  if (command === "rescue") return rescueCommand(runId, options)
  throw new Error(`未知命令：${command}\n${USAGE}`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
