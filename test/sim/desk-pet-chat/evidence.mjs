import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { hashCanonical } from "./dataset.mjs";
import { inspectTraceEvidence } from "../../../scripts/trace-evidence.mjs";

/**
 * 测试侧聊天评测证据：运行身份、事务性 attempt 封存、只读证据与版本化判分/裁决。
 * 产品服务不得 import 本模块；本模块只读产品产出的会话、trace 与产物。
 */

export const CHAT_EVIDENCE_SCHEMA_VERSION = 1;
export const CHAT_RUN_SCHEMA_VERSION = 1;
export const CHAT_ATTEMPT_SCHEMA_VERSION = 1;
export const CHAT_RETENTION_MAX_GROUPS = 5;
export const CHAT_RETENTION_MAX_BYTES = 200 * 1024 * 1024;
export const CHAT_RUN_PHASES = Object.freeze([
  "preparing", "awaiting_gold_review", "ready", "running", "collecting", "grading",
  "awaiting_result_review", "repairing", "completed", "blocked", "cancelled",
]);
export const DIALOGUE_ORIGINS = Object.freeze(["fixture", "driver", "assistant"]);
export const ATTEMPT_OUTCOMES = Object.freeze(["completed", "failed", "interrupted"]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ATTEMPT_ID_PATTERN = /^\d{4}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DIALOGUE_KEYS = new Set(["seq", "role", "text", "sessionId", "entryId", "at", "origin"]);
const TRACE_MANIFEST = "trace.manifest.json";
const DIALOGUE_FILE = "dialogue.jsonl";
const TRACE_FILE = "trace.jsonl";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_PENDING = "manifest.json.pending";
const READ_ONLY_ENTRIES = new Set([DIALOGUE_FILE, TRACE_FILE, TRACE_MANIFEST, MANIFEST_FILE]);

export class ChatEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChatEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChatEvidenceError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashBytes(bytes) {
  return `sha256:${sha256(bytes)}`;
}

export function hashFile(path) {
  return `sha256:${sha256(readFileSync(path))}`;
}

/** trace 校验器沿用裸 hex；证据索引统一带 sha256: 前缀，两处口径不混用。 */
function shaHexFile(path) {
  return sha256(readFileSync(path));
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("id.invalid", `${label} 必须是 [a-z0-9][a-z0-9._-]*：${String(value)}`);
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail("hash.invalid", `${label} 必须是 sha256:<64 hex>：${String(value)}`);
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail("time.invalid", `${label} 必须是带时区的 ISO 时间：${String(value)}`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail("shape.invalid", `${label} 必须是对象`);
  return value;
}

/** 证据文件只读；grades/reviews 保持可写，否则后续裁决无处追加。 */
function freezeEvidenceFiles(attemptDir, paths) {
  if (process.platform === "win32") return;
  for (const path of paths) chmodSync(join(attemptDir, path), 0o444);
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  const pending = `${path}.pending`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(pending, bytes);
  renameSync(pending, path);
}

function writeExclusive(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function listRunDirs(reportsDir) {
  if (!existsSync(reportsDir)) return [];
  const runs = [];
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runPath = join(reportsDir, entry.name);
    if (!existsSync(join(runPath, "run.json"))) continue;
    runs.push({ evaluationRunId: entry.name, runPath, run: readJsonFile(join(runPath, "run.json")) });
  }
  return runs.sort((a, b) => (a.run.createdOrder ?? 0) - (b.run.createdOrder ?? 0) || a.evaluationRunId.localeCompare(b.evaluationRunId));
}

export function createChatRun({ reportsDir, evaluationRunId, createdAt, scope, budget, baseline = null }) {
  assertId(evaluationRunId, "evaluationRunId");
  assertTimestamp(createdAt, "createdAt");
  assertRecord(scope, "scope");
  assertRecord(budget, "budget");
  mkdirSync(reportsDir, { recursive: true });
  const runDir = join(reportsDir, evaluationRunId);
  const createdOrder = listRunDirs(reportsDir).reduce((max, item) => Math.max(max, item.run.createdOrder ?? 0), 0) + 1;
  const run = {
    schemaVersion: CHAT_RUN_SCHEMA_VERSION,
    evaluationRunId,
    createdOrder,
    createdAt,
    scope,
    budget,
    baseline,
  };
  mkdirSync(runDir);
  writeJsonAtomic(join(runDir, "run.json"), run);
  writeJsonAtomic(join(runDir, "workflow.json"), {
    schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
    evaluationRunId,
    phase: "preparing",
    updatedAt: createdAt,
    attempts: [],
    pendingDecision: null,
  });
  return { runDir, run };
}

/** 运行器可能在宿主启动后才知道采集范围；同一 evaluationRunId 只建一次运行组。 */
export function ensureChatRun({ reportsDir, evaluationRunId, createdAt, scope, budget, baseline = null }) {
  assertId(evaluationRunId, "evaluationRunId");
  const runDir = join(reportsDir, evaluationRunId);
  if (existsSync(join(runDir, "run.json"))) {
    const run = readChatRun(runDir);
    return { runDir, run, created: false };
  }
  return { ...createChatRun({ reportsDir, evaluationRunId, createdAt, scope, budget, baseline }), created: true };
}

export function listChatRuns(reportsDir) {
  return listRunDirs(reportsDir).map(({ evaluationRunId, runPath, run }) => ({
    evaluationRunId,
    runPath,
    run,
    workflow: existsSync(join(runPath, "workflow.json")) ? readChatWorkflow(runPath) : null,
  }));
}

export function readChatRun(runDir) {
  const path = join(runDir, "run.json");
  if (!existsSync(path)) fail("run.missing", `run.json 不存在：${runDir}`);
  const run = readJsonFile(path);
  if (run.schemaVersion !== CHAT_RUN_SCHEMA_VERSION) fail("run.schema", `不支持的 run schema：${run.schemaVersion}`);
  return run;
}

export function readChatWorkflow(runDir) {
  const path = join(runDir, "workflow.json");
  if (!existsSync(path)) fail("workflow.missing", `workflow.json 不存在：${runDir}`);
  const workflow = readJsonFile(path);
  if (workflow.schemaVersion !== CHAT_EVIDENCE_SCHEMA_VERSION) fail("workflow.schema", `不支持的 workflow schema：${workflow.schemaVersion}`);
  return workflow;
}

export function setChatRunPhase(runDir, { phase, updatedAt, pendingDecision, nextAction }) {
  if (!CHAT_RUN_PHASES.includes(phase)) fail("phase.invalid", `未知阶段：${String(phase)}`);
  assertTimestamp(updatedAt, "updatedAt");
  const workflow = readChatWorkflow(runDir);
  writeJsonAtomic(join(runDir, "workflow.json"), {
    ...workflow,
    phase,
    updatedAt,
    ...(pendingDecision === undefined ? {} : { pendingDecision }),
    ...(nextAction === undefined ? {} : { nextAction }),
  });
  return readChatWorkflow(runDir);
}

function validateIdentity(identity) {
  assertRecord(identity, "identity");
  const { code, inputs, tools, host, platform, runtime, models, budget } = identity;
  for (const [value, label] of [
    [code, "identity.code"], [inputs, "identity.inputs"], [tools, "identity.tools"],
    [host, "identity.host"], [platform, "identity.platform"], [runtime, "identity.runtime"],
    [models, "identity.models"], [budget, "identity.budget"],
  ]) assertRecord(value, label);
  if (typeof code.commit !== "string" || !code.commit) fail("identity.commit", "identity.code.commit 必填");
  assertHash(code.sourceHash, "identity.code.sourceHash");
  if (typeof code.dirty !== "boolean") fail("identity.dirty", "identity.code.dirty 必须是布尔值");
  for (const key of ["datasetHash", "fixtureHash", "cardHash", "configHash"]) assertHash(inputs[key], `identity.inputs.${key}`);
  for (const key of ["driverVersion", "rubricVersion", "graderVersion"]) {
    if (typeof tools[key] !== "string" || !tools[key]) fail("identity.tools", `identity.tools.${key} 必填`);
  }
  if (typeof host.mode !== "string" || !host.mode) fail("identity.host", "identity.host.mode 必填");
  if (!Array.isArray(host.capabilities) || host.capabilities.some((item) => typeof item !== "string")) {
    fail("identity.host", "identity.host.capabilities 必须是字符串数组");
  }
  if (typeof platform.os !== "string" || typeof platform.arch !== "string") fail("identity.platform", "identity.platform 必须含 os/arch");
  if (typeof runtime.version !== "string" || !runtime.version) fail("identity.runtime", "identity.runtime.version 必填");
  if (typeof models.requested !== "string" || !models.requested) fail("identity.models", "identity.models.requested 必填");
  if (models.actual !== undefined && models.actual !== null && typeof models.actual !== "string") fail("identity.models", "identity.models.actual 必须是字符串或 null");
  return identity;
}

function readAttemptIndex(attemptsDir) {
  if (!existsSync(attemptsDir)) return { ids: [], trialIds: new Set() };
  const ids = [];
  const trialIds = new Set();
  for (const entry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ATTEMPT_ID_PATTERN.test(entry.name)) continue;
    ids.push(entry.name);
    const manifestPath = join(attemptsDir, entry.name, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    for (const trial of readJsonFile(manifestPath).expectedTrials ?? []) trialIds.add(trial.trialId);
  }
  return { ids, trialIds };
}

export function beginChatAttempt({ runDir, attemptId, identity, expectedTrials, expectedSessions, createdAt }) {
  const run = readChatRun(runDir);
  validateIdentity(identity);
  assertTimestamp(createdAt, "createdAt");
  if (!Array.isArray(expectedTrials) || expectedTrials.length === 0) fail("trials.empty", "expectedTrials 不能为空");
  const trials = expectedTrials.map((trial) => {
    assertRecord(trial, "expectedTrials entry");
    assertId(trial.caseId, "expectedTrials.caseId");
    if (typeof trial.trialId !== "string" || !trial.trialId) fail("trial.invalid", "expectedTrials.trialId 必填");
    return { caseId: trial.caseId, sceneId: trial.caseId, trialId: trial.trialId };
  });
  if (new Set(trials.map((trial) => trial.trialId)).size !== trials.length) fail("trial.duplicate", "同一 attempt 内 trialId 重复");
  if (!Array.isArray(expectedSessions) || expectedSessions.length === 0) fail("sessions.empty", "expectedSessions 不能为空");
  const sessions = [...new Set(expectedSessions.map((id) => assertId(id, "expectedSessions entry")))];
  const attemptsDir = join(runDir, "attempts");
  mkdirSync(attemptsDir, { recursive: true });
  const index = readAttemptIndex(attemptsDir);
  const nextId = String(index.ids.reduce((max, id) => Math.max(max, Number(id)), 0) + 1).padStart(4, "0");
  const resolvedId = attemptId === undefined ? nextId : attemptId;
  if (!ATTEMPT_ID_PATTERN.test(resolvedId)) fail("attempt.invalid", `attemptId 必须是四位序号：${String(resolvedId)}`);
  const duplicate = trials.find((trial) => index.trialIds.has(trial.trialId));
  if (duplicate) fail("trial.duplicate", `trialId 已在同运行组使用：${duplicate.trialId}`);
  const attemptDir = join(attemptsDir, resolvedId);
  mkdirSync(attemptDir);
  for (const dir of ["state", "artifacts", "grades", "reviews"]) mkdirSync(join(attemptDir, dir));
  const attempt = {
    schemaVersion: CHAT_ATTEMPT_SCHEMA_VERSION,
    evaluationRunId: run.evaluationRunId,
    attemptId: resolvedId,
    createdAt,
    identity,
    expectedTrials: trials,
    expectedSessions: sessions,
    status: "collecting",
  };
  writeJsonAtomic(join(attemptDir, MANIFEST_PENDING), attempt);
  return { attemptDir, attempt };
}

/**
 * 驱动可能新建会话，采集结束时才知道完整范围；封存前必须把这些会话补进声明，
 * 否则封存会以「收集到未声明会话」判为不完整。已封存的 attempt 不再接受追加。
 */
export function extendChatAttemptSessions({ attemptDir, sessionIds }) {
  if (existsSync(join(attemptDir, MANIFEST_FILE))) fail("attempt.sealed", "attempt 已封存，不能追加会话范围");
  const pendingPath = join(attemptDir, MANIFEST_PENDING);
  if (!existsSync(pendingPath)) fail("attempt.missing", "attempt 草稿不存在");
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) fail("sessions.empty", "sessionIds 不能为空");
  const attempt = readJsonFile(pendingPath);
  const merged = [...new Set([
    ...(attempt.expectedSessions ?? []),
    ...sessionIds.map((id) => assertId(id, "sessionIds entry")),
  ])];
  const next = { ...attempt, expectedSessions: merged };
  writeJsonAtomic(pendingPath, next);
  return next;
}

export function createDialogueWriter(attemptDir) {
  const path = join(attemptDir, DIALOGUE_FILE);
  const fd = openSync(path, "wx");
  let seq = 0;
  let lastAt = -Infinity;
  let closed = false;
  function append(message) {
    if (closed) fail("dialogue.closed", "dialogue writer 已关闭");
    assertRecord(message, "dialogue message");
    const extra = Object.keys(message).filter((key) => !DIALOGUE_KEYS.has(key));
    if (extra.length) fail("dialogue.keys", `对话正文只允许白名单字段，拒绝：${extra.join(", ")}`);
    const role = message.role;
    if (role !== "user" && role !== "assistant") fail("dialogue.role", `未知角色：${String(role)}`);
    if (typeof message.text !== "string" || !message.text.trim()) fail("dialogue.text", "对话正文不能为空");
    assertId(message.sessionId, "dialogue.sessionId");
    if (typeof message.entryId !== "string" || !message.entryId) fail("dialogue.entryId", "对话条目必须带稳定 entryId");
    const at = typeof message.at === "string" ? Date.parse(message.at) : message.at;
    if (!Number.isFinite(at) || !Number.isSafeInteger(at)) fail("dialogue.at", "对话时间必须是毫秒时间戳或 ISO 时间");
    if (at < lastAt) fail("dialogue.order", "对话时间不得倒退");
    if (!DIALOGUE_ORIGINS.includes(message.origin)) fail("dialogue.origin", `未知来源：${String(message.origin)}`);
    lastAt = at;
    seq += 1;
    const record = {
      seq, role, text: message.text, sessionId: message.sessionId, entryId: message.entryId,
      at, origin: message.origin,
    };
    writeSync(fd, `${JSON.stringify(record)}\n`);
    return record;
  }
  function close() {
    if (closed) return;
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
  }
  return { path, append, close };
}

export function createTraceWriter(attemptDir) {
  const path = join(attemptDir, TRACE_FILE);
  const fd = openSync(path, "wx");
  let chunkSeq = 0;
  let complete = false;
  let closed = false;
  function appendChunk(chunk) {
    if (closed) fail("trace.closed", "trace writer 已关闭");
    assertRecord(chunk, "trace chunk");
    if (complete) fail("trace.complete", "complete 边界之后不得再写 chunk");
    if (chunk.chunkSeq !== chunkSeq + 1) fail("trace.seq", `chunkSeq 必须连续：期望 ${chunkSeq + 1}，实际 ${String(chunk.chunkSeq)}`);
    if (!Array.isArray(chunk.events) || chunk.eventCount !== chunk.events.length) fail("trace.events", "chunk eventCount 与事件数组不一致");
    if (!Number.isSafeInteger(chunk.droppedCount) || chunk.droppedCount < 0) fail("trace.dropped", "droppedCount 必须是非负整数");
    const contentSha256 = sha256(Buffer.from(JSON.stringify(chunk)));
    writeSync(fd, `${JSON.stringify({ chunk, contentSha256 })}\n`);
    fsyncSync(fd);
    chunkSeq += 1;
    if (chunk.boundary?.kind === "complete") complete = true;
    return { chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true };
  }
  function close() {
    if (closed) return;
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
  }
  return { path, appendChunk, close, get complete() { return complete; }, get chunkCount() { return chunkSeq; } };
}

export function writeStateSnapshot({ attemptDir, name, value }) {
  assertId(name, "state name");
  const path = join(attemptDir, "state", `${name}.json`);
  writeExclusive(path, value);
  return path;
}

export function writeArtifact({ attemptDir, name, bytes }) {
  assertId(basename(name), "artifact name");
  const target = join(attemptDir, "artifacts", basename(name));
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fd = openSync(target, "wx");
  try {
    writeSync(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return target;
}

export function copyArtifact({ attemptDir, name, sourcePath }) {
  return writeArtifact({ attemptDir, name, bytes: readFileSync(sourcePath) });
}

function readDialogue(path, expectedSessions) {
  const issues = [];
  const messages = [];
  if (!existsSync(path)) return { issues: ["dialogue.jsonl 缺失"], messages, sessions: [] };
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) !== "") issues.push("dialogue.jsonl 最后一行未完整换行");
  let expectedSeq = 1;
  let lastAt = -Infinity;
  const entryIds = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { issues.push(`dialogue 第 ${expectedSeq} 条不是合法 JSON`); continue; }
    const extra = Object.keys(record).filter((key) => !DIALOGUE_KEYS.has(key));
    if (extra.length) issues.push(`dialogue 第 ${expectedSeq} 条含隐藏字段：${extra.join(", ")}`);
    if (record.seq !== expectedSeq) issues.push(`dialogue 序号不连续：期望 ${expectedSeq}，实际 ${String(record.seq)}`);
    expectedSeq += 1;
    const entryKey = `${record.sessionId}\0${record.entryId}`;
    if (entryIds.has(entryKey)) issues.push(`dialogue 条目重复引用：${record.sessionId}/${record.entryId}`);
    entryIds.add(entryKey);
    if (!["user", "assistant"].includes(record.role)) issues.push(`dialogue 第 ${record.seq} 条角色非法`);
    if (typeof record.text !== "string" || !record.text.trim()) issues.push(`dialogue 第 ${record.seq} 条正文为空`);
    if (!DIALOGUE_ORIGINS.includes(record.origin)) issues.push(`dialogue 第 ${record.seq} 条来源非法`);
    if (!Number.isSafeInteger(record.at) || record.at < lastAt) issues.push(`dialogue 第 ${record.seq} 条时间非法或倒退`);
    else lastAt = record.at;
    messages.push(record);
  }
  const sessions = [...new Set(messages.map((message) => message.sessionId))].filter(Boolean);
  for (const sessionId of expectedSessions) if (!sessions.includes(sessionId)) issues.push(`声明的会话未被收集：${sessionId}`);
  for (const sessionId of sessions) if (!expectedSessions.includes(sessionId)) issues.push(`收集到未声明会话：${sessionId}`);
  return { issues, messages, sessions };
}

function collectArtifacts(attemptDir) {
  const issues = [];
  const entries = readdirSync(attemptDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!["state", "artifacts", "grades", "reviews"].includes(entry.name)) issues.push(`未声明的证据目录：${entry.name}/`);
      continue;
    }
    if (!READ_ONLY_ENTRIES.has(entry.name) && entry.name !== MANIFEST_PENDING) issues.push(`未声明的证据文件：${entry.name}`);
  }
  const files = [];
  function walk(dir, role) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, role);
      else files.push({ path: relative(attemptDir, path).split("\\").join("/"), role, bytes: statSync(path).size, sha256: hashFile(path) });
    }
  }
  walk(join(attemptDir, "state"), "state");
  walk(join(attemptDir, "artifacts"), "artifact");
  return { issues, files };
}

function scanTraceChunks(path) {
  if (!existsSync(path)) return { chunkCount: 0, complete: false, droppedCount: 0 };
  let chunkCount = 0;
  let complete = false;
  let droppedCount = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.chunk) {
        chunkCount += 1;
        droppedCount += Number.isSafeInteger(parsed.chunk.droppedCount) ? parsed.chunk.droppedCount : 0;
        if (parsed.chunk.boundary?.kind === "complete") complete = true;
      }
    } catch { /* 损坏行由 inspectTraceEvidence 统一报告 */ }
  }
  return { chunkCount, complete, droppedCount };
}

export async function sealChatAttempt({
  attemptDir, sealedAt, models, sourceHash, inputs, outcome = "completed", issues: extraIssues = [],
}) {
  if (existsSync(join(attemptDir, MANIFEST_FILE))) fail("attempt.sealed", "attempt 已封存，不能重复封存");
  const pendingPath = join(attemptDir, MANIFEST_PENDING);
  if (!existsSync(pendingPath)) fail("attempt.missing", "attempt 草稿不存在");
  const attempt = readJsonFile(pendingPath);
  assertTimestamp(sealedAt, "sealedAt");
  if (!ATTEMPT_OUTCOMES.includes(outcome)) fail("outcome.invalid", `未知 outcome：${String(outcome)}`);
  const issues = [...extraIssues];
  assertRecord(models, "models");
  if (typeof models.actual !== "string" || !models.actual) issues.push("实际响应模型身份缺失");
  if (typeof sourceHash !== "string" || !sourceHash) issues.push("封存时未提供最终源码哈希");
  else if (sourceHash !== attempt.identity.code.sourceHash) issues.push("封存时源码哈希与采集开始不一致");
  if (!isRecord(inputs)) issues.push("封存时未提供最终输入哈希");
  else {
    for (const key of ["datasetHash", "fixtureHash", "cardHash", "configHash"]) {
      if (typeof inputs[key] !== "string" || !HASH_PATTERN.test(inputs[key])) issues.push(`封存时 inputs.${key} 不是 sha256 哈希`);
      else if (inputs[key] !== attempt.identity.inputs[key]) issues.push(`输入哈希与采集开始不一致：${key}`);
    }
  }
  if (outcome !== "completed") issues.push(`attempt outcome=${outcome}，证据不构成完整通过`);

  const dialogue = readDialogue(join(attemptDir, DIALOGUE_FILE), attempt.expectedSessions);
  issues.push(...dialogue.issues);

  const tracePath = join(attemptDir, TRACE_FILE);
  const traceManifestPath = join(attemptDir, TRACE_MANIFEST);
  const traceScan = scanTraceChunks(tracePath);
  let traceInspection = { status: "inconclusive", issues: ["trace.jsonl 缺失"], orphanCount: undefined };
  if (existsSync(tracePath)) {
    writeJsonAtomic(traceManifestPath, {
      schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
      evaluationRunId: attempt.evaluationRunId,
      attemptId: attempt.attemptId,
      expectedTrials: attempt.expectedTrials,
      complete: traceScan.complete,
      artifactHashes: { traceSha256: shaHexFile(tracePath) },
    });
    traceInspection = await inspectTraceEvidence({
      actualPath: tracePath,
      manifestPath: traceManifestPath,
      wantedEvidence: [],
    });
    issues.push(...traceInspection.issues);
    if (traceInspection.orphanCount) issues.push(`存在 ${traceInspection.orphanCount} 个未归属 orphan 事件，需复核`);
  } else {
    writeJsonAtomic(traceManifestPath, {
      schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
      evaluationRunId: attempt.evaluationRunId,
      attemptId: attempt.attemptId,
      expectedTrials: attempt.expectedTrials,
      complete: false,
      artifactHashes: {},
    });
  }

  const collected = collectArtifacts(attemptDir);
  issues.push(...collected.issues);
  const baseArtifacts = [];
  for (const [file, role] of [[DIALOGUE_FILE, "dialogue"], [TRACE_FILE, "trace"], [TRACE_MANIFEST, "trace-manifest"]]) {
    const path = join(attemptDir, file);
    if (existsSync(path)) baseArtifacts.push({ path: file, role, bytes: statSync(path).size, sha256: hashFile(path) });
  }
  const artifacts = [...baseArtifacts, ...collected.files].sort((a, b) => a.path.localeCompare(b.path));
  const uniqueIssues = [...new Set(issues)];
  const status = uniqueIssues.length === 0 && traceInspection.status === "complete" ? "complete" : "inconclusive";
  const manifestBody = {
    schemaVersion: CHAT_ATTEMPT_SCHEMA_VERSION,
    evaluationRunId: attempt.evaluationRunId,
    attemptId: attempt.attemptId,
    createdAt: attempt.createdAt,
    sealedAt,
    identity: attempt.identity,
    inputHashes: isRecord(inputs) ? inputs : null,
    models: { requested: attempt.identity.models.requested, actual: models.actual ?? null },
    sourceHash: attempt.identity.code.sourceHash,
    outcome,
    expectedTrials: attempt.expectedTrials,
    expectedSessions: attempt.expectedSessions,
    evidence: {
      dialogue: { messageCount: dialogue.messages.length, sessions: dialogue.sessions },
      trace: {
        chunkCount: traceScan.chunkCount,
        droppedCount: traceScan.droppedCount,
        orphanCount: traceInspection.orphanCount ?? null,
      },
    },
    artifacts,
    integrity: { status, issues: uniqueIssues },
  };
  const manifest = { ...manifestBody, manifestSha256: hashCanonical(manifestBody) };
  writeJsonAtomic(join(attemptDir, MANIFEST_FILE), manifest);
  freezeEvidenceFiles(attemptDir, [DIALOGUE_FILE, TRACE_FILE, TRACE_MANIFEST, MANIFEST_FILE, ...collected.files.map((file) => file.path)]
    .filter((file) => existsSync(join(attemptDir, file))));
  const runDir = resolve(attemptDir, "..", "..");
  const workflow = readChatWorkflow(runDir);
  const previous = workflow.attempts.filter((item) => item.attemptId !== attempt.attemptId);
  writeJsonAtomic(join(runDir, "workflow.json"), {
    ...workflow,
    updatedAt: sealedAt,
    attempts: [...previous, {
      attemptId: attempt.attemptId,
      sealedAt,
      status,
      outcome,
      manifestSha256: manifest.manifestSha256,
    }].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
  });
  return { manifest, status, issues: uniqueIssues, manifestSha256: manifest.manifestSha256 };
}

export function readSealedAttempt(attemptDir) {
  const path = join(attemptDir, MANIFEST_FILE);
  if (!existsSync(path)) fail("attempt.unsealed", `manifest.json 不存在：${attemptDir}`);
  return readJsonFile(path);
}

export function verifySealedAttempt(attemptDir) {
  const issues = [];
  let manifest;
  try { manifest = readSealedAttempt(attemptDir); }
  catch (error) { return { status: "inconclusive", issues: [error.message] }; }
  const { manifestSha256, ...body } = manifest;
  if (hashCanonical(body) !== manifestSha256) issues.push("manifest 自身哈希不匹配");
  for (const artifact of manifest.artifacts ?? []) {
    const path = join(attemptDir, artifact.path);
    if (!existsSync(path)) { issues.push(`证据文件缺失：${artifact.path}`); continue; }
    if (hashFile(path) !== artifact.sha256) issues.push(`证据文件哈希不匹配：${artifact.path}`);
  }
  const known = new Set([MANIFEST_FILE, ...manifest.artifacts?.map((artifact) => artifact.path) ?? []]);
  function walk(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!prefix && ["grades", "reviews"].includes(entry.name)) continue;
        if (!prefix && !["state", "artifacts"].includes(entry.name)) issues.push(`封存后出现未声明目录：${rel}/`);
        walk(path, rel);
      } else if (!known.has(rel) && !(prefix === "" && entry.name === MANIFEST_PENDING)) {
        issues.push(`封存后出现未声明文件：${rel}`);
      }
    }
  }
  walk(attemptDir, "");
  const status = issues.length ? "inconclusive" : manifest.integrity?.status ?? "inconclusive";
  return {
    status,
    issues,
    integrityIssues: manifest.integrity?.issues ?? [],
    manifest,
    manifestSha256: manifest.manifestSha256,
  };
}

function safeRecordId(id, label) {
  return assertId(id, label);
}

function assertSealedForDecision(attemptDir) {
  const verified = verifySealedAttempt(attemptDir);
  if (verified.issues.length > 0) fail("attempt.tampered", `封存证据不可信：${verified.issues.join("；")}`);
  return verified;
}

export function appendGrade({ attemptDir, gradeId, createdAt, rubricVersion, graderVersion, authority, checks, summary }) {
  safeRecordId(gradeId, "gradeId");
  assertTimestamp(createdAt, "createdAt");
  if (typeof rubricVersion !== "string" || !rubricVersion) fail("grade.rubric", "rubricVersion 必填");
  if (typeof graderVersion !== "string" || !graderVersion) fail("grade.grader", "graderVersion 必填");
  if (!["deterministic", "api-judge", "human"].includes(authority)) fail("grade.authority", `未知判分权威：${String(authority)}`);
  if (!Array.isArray(checks)) fail("grade.checks", "checks 必须是数组");
  assertRecord(summary, "summary");
  const verified = assertSealedForDecision(attemptDir);
  if (verified.status !== "complete") fail("grade.inconclusive", "证据不完整，不能生成正式判分");
  const record = {
    schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
    gradeId,
    attemptManifestSha256: verified.manifestSha256,
    createdAt,
    rubricVersion,
    graderVersion,
    authority,
    checks,
    summary,
  };
  const path = join(attemptDir, "grades", `${gradeId}.json`);
  if (existsSync(path)) fail("grade.duplicate", `判分版本已存在，不覆盖：${gradeId}`);
  writeExclusive(path, record);
  return record;
}

export function appendReview({ attemptDir, reviewId, createdAt, reviewer, verdict, notes = "", evidenceRefs = [], decisions = [] }) {
  safeRecordId(reviewId, "reviewId");
  assertTimestamp(createdAt, "createdAt");
  assertRecord(reviewer, "reviewer");
  if (reviewer.role !== "user") fail("review.authority", "人工裁决只能由用户本人记录");
  if (typeof reviewer.name !== "string" || !reviewer.name) fail("review.reviewer", "reviewer.name 必填");
  if (!["pass", "fail", "inconclusive"].includes(verdict)) fail("review.verdict", `未知裁决：${String(verdict)}`);
  const verified = assertSealedForDecision(attemptDir);
  if (verdict === "pass" && verified.status !== "complete") fail("review.inconclusive", "证据不完整，不能给出通过裁决");
  const record = {
    schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
    reviewId,
    attemptManifestSha256: verified.manifestSha256,
    createdAt,
    reviewer: { role: "user", name: reviewer.name },
    verdict,
    notes,
    evidenceRefs,
    decisions,
  };
  const path = join(attemptDir, "reviews", `${reviewId}.json`);
  if (existsSync(path)) fail("review.duplicate", `裁决版本已存在，不覆盖：${reviewId}`);
  writeExclusive(path, record);
  return record;
}

function readVersionedDir(attemptDir, dir) {
  const path = join(attemptDir, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJsonFile(join(path, name)));
}

export function listAttemptIds(runDir) {
  const attemptsDir = join(runDir, "attempts");
  if (!existsSync(attemptsDir)) return [];
  return readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ATTEMPT_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 报告与保留策略共同使用的只读视图；报告不得绕过这里自行解释证据。 */
export function readChatRunEvidence(runDir) {
  const run = readChatRun(runDir);
  const workflow = readChatWorkflow(runDir);
  const attempts = listAttemptIds(runDir).map((attemptId) => {
    const attemptDir = join(runDir, "attempts", attemptId);
    const manifestPath = join(attemptDir, MANIFEST_FILE);
    const manifest = existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
    return {
      attemptId,
      attemptDir,
      manifest,
      verification: manifest ? verifySealedAttempt(attemptDir) : { status: "unsealed", issues: ["attempt 尚未封存"] },
      grades: readVersionedDir(attemptDir, "grades"),
      reviews: readVersionedDir(attemptDir, "reviews"),
    };
  });
  return { run, workflow, attempts };
}
