import { randomUUID } from "node:crypto";
import {
  DATASET_SCHEMA_VERSION,
  DRIVER_HOST_METHOD_VALUES,
  PURPOSE_VALUES,
  hashCanonical,
} from "./dataset.mjs";

/**
 * 聊天评测工作流：授权、固定时钟、驱动进度、预算、同条件对照与留出使用记录。
 *
 * 边界（执行契约 W5）：
 * - 本模块只编排执行与运行有效性，不读探针／oracle，不判分，不写 gold 或用户抽查。
 * - 驱动包只接受 buildDriverPackage 的字段；检查点等待属于编排侧同步，不进入驱动包。
 * - 未知用量记 unknown，不按零处理；预算到界在下一步副作用前停止。
 * - 驱动进度是可变工作流记录，不复制业务状态；封存时作为产物进入 attempt。
 */

export const WORKFLOW_SCHEMA_VERSION = 1;
export const DRIVER_PROGRESS_SCHEMA_VERSION = 1;
export const AUTHORIZATION_SCHEMA_VERSION = 1;
export const AUTHORIZATION_DATA_SCOPE = "isolated";
export const DRIVER_PROGRESS_FILE = "driver-progress.json";
export const DRIVER_PACKAGE_FILE = "driver-package.json";
export const AUTHORIZATION_FILE = "authorization.json";
export const CLOCK_FILE = "clock.json";

export const DRIVER_STATUSES = Object.freeze(["pending", "running", "completed", "blocked"]);
export const DRIVER_STEP_STATUSES = Object.freeze(["completed", "failed"]);
export const CHECKPOINT_WAITS = Object.freeze([
  "assistant_message",
  "memory_extraction_end",
  "session_created",
  "host_readback",
]);
export const FIXED_CONDITION_FIELDS = Object.freeze([
  "caseIds",
  "suiteIds",
  "specHash",
  "contentHash",
  "fixtureHash",
  "driverHash",
  "oracleHash",
  "requestedModel",
  "actualModel",
  "hostMode",
  "hostCapabilities",
  "platform",
  "runtime",
  "driverVersion",
  "rubricVersion",
  "graderVersion",
  "judgePromptVersion",
]);
export const TARGET_CONDITION_FIELDS = Object.freeze([
  "commit",
  "sourceHash",
  "cardHash",
  "configHash",
]);

const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MESSAGE_OPERATION_FIELDS = Object.freeze([
  "operationId", "caseId", "trialId", "sessionId", "generation", "stepId",
]);
const MEMORY_JOB_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
const SECRET_KEY_PATTERN = /^(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|secret|password|credential|authorization)$/i;

export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkflowError(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail("schema.invalid", `${label} 必须是对象`);
}

function assertExactKeys(value, label, required, optional = []) {
  assertRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail("schema.invalid", `${label} 缺少字段：${missing.join(", ")}`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail("schema.invalid", `${label} 含未知字段：${extra.join(", ")}`);
}

function assertText(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail("schema.invalid", `${label} 必须是非空字符串`);
  return value;
}

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail("schema.invalid", `${label} 格式不合法：${String(value)}`);
  return value;
}

function assertInstant(value, label) {
  assertPattern(value, ISO_PATTERN, label);
  if (!Number.isFinite(Date.parse(value))) fail("schema.invalid", `${label} 不是可解析时间：${value}`);
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail("schema.invalid", `${label} 必须是正整数`);
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail("schema.invalid", `${label} 必须是非负整数`);
  return value;
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail("schema.invalid", `${label} 必须是数组`);
  if (!allowEmpty && value.length === 0) fail("schema.invalid", `${label} 不能为空`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") fail("schema.invalid", `${label}[${index}] 必须是非空字符串`);
  }
  return value;
}

function assertNoSecrets(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) fail("authorization.secret", `${label}.${key} 不允许携带凭据；授权文件只描述范围与预算`);
    assertNoSecrets(item, `${label}.${key}`);
  }
}

// ── 授权与预算 ──

export function validateAuthorization(raw, { caseIds, purpose }) {
  assertNoSecrets(raw, "authorization");
  assertExactKeys(raw, "authorization", [
    "schemaVersion", "approvedBy", "approvedAt", "scope", "budget", "holdout",
  ], ["notes"]);
  if (raw.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) {
    fail("authorization.version", `authorization.schemaVersion 必须是 ${AUTHORIZATION_SCHEMA_VERSION}`);
  }
  assertText(raw.approvedBy, "authorization.approvedBy");
  assertInstant(raw.approvedAt, "authorization.approvedAt");
  if (typeof raw.holdout !== "boolean") fail("authorization.holdout", "authorization.holdout 必须是布尔值");
  if (raw.notes !== undefined && (typeof raw.notes !== "string" || raw.notes.length > 1000)) {
    fail("authorization.notes", "authorization.notes 必须是不超过 1000 字的字符串");
  }

  assertExactKeys(raw.scope, "authorization.scope", ["caseIds", "purpose", "models", "data"]);
  const scopeCases = assertStringArray(raw.scope.caseIds, "authorization.scope.caseIds");
  if (new Set(scopeCases).size !== scopeCases.length) fail("authorization.scope", "authorization.scope.caseIds 含重复项");
  for (const caseId of scopeCases) assertPattern(caseId, CASE_ID_PATTERN, "authorization.scope.caseIds entry");
  for (const caseId of caseIds) {
    if (!scopeCases.includes(caseId)) fail("authorization.scope", `授权范围不包含用例 ${caseId}`);
  }
  if (!PURPOSE_VALUES.includes(raw.scope.purpose)) {
    fail("authorization.purpose", `authorization.scope.purpose 不在登记值域：${String(raw.scope.purpose)}`);
  }
  if (raw.scope.purpose !== purpose) {
    fail("authorization.purpose", `授权用途 ${raw.scope.purpose} 与套件治理用途 ${purpose} 不一致`);
  }
  const holdout = purpose === "holdout";
  if (raw.holdout !== holdout) {
    fail("authorization.holdout", holdout
      ? "留出套件必须在授权里显式 holdout: true"
      : "非留出套件不能声明 holdout: true");
  }
  const models = assertStringArray(raw.scope.models, "authorization.scope.models");
  if (new Set(models).size !== models.length) fail("authorization.scope", "authorization.scope.models 含重复项");
  if (raw.scope.data !== AUTHORIZATION_DATA_SCOPE) {
    fail("authorization.data", `authorization.scope.data 必须是 ${AUTHORIZATION_DATA_SCOPE}`);
  }

  assertExactKeys(raw.budget, "authorization.budget", ["messages", "tokens", "minutes", "trials", "repairs"]);
  const budget = {
    messages: assertPositiveInteger(raw.budget.messages, "authorization.budget.messages"),
    tokens: assertPositiveInteger(raw.budget.tokens, "authorization.budget.tokens"),
    minutes: assertPositiveInteger(raw.budget.minutes, "authorization.budget.minutes"),
    trials: assertPositiveInteger(raw.budget.trials, "authorization.budget.trials"),
    repairs: assertNonNegativeInteger(raw.budget.repairs, "authorization.budget.repairs"),
  };

  return {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    approvedBy: raw.approvedBy.trim(),
    approvedAt: raw.approvedAt,
    scope: {
      caseIds: [...scopeCases],
      purpose: raw.scope.purpose,
      models: [...models],
      data: AUTHORIZATION_DATA_SCOPE,
    },
    budget,
    holdout: raw.holdout,
    ...(raw.notes === undefined ? {} : { notes: raw.notes }),
  };
}

export function authorizationFingerprint(authorization) {
  return hashCanonical(authorization);
}

export function authorizeRequestedModels(authorization, requestedModels) {
  const models = Array.isArray(requestedModels) ? requestedModels : [requestedModels];
  for (const model of models) {
    if (typeof model !== "string" || model.trim() === "") fail("authorization.models", "请求模型身份为空，无法核对授权范围");
    if (!authorization.scope.models.includes(model)) {
      fail("authorization.models", `请求模型 ${model} 不在用户授权范围（${authorization.scope.models.join(", ")}）`);
    }
  }
  return true;
}

/** 多轮修复的授权：修复序号从 1 开始，且不超过授权冻结的修复次数。 */
export function assertRepairAllowed({ authorization, repairIndex }) {
  assertPositiveInteger(repairIndex, "repairIndex");
  if (repairIndex > authorization.budget.repairs) {
    fail("authorization.repairs", `修复序号 ${repairIndex} 超过授权修复次数 ${authorization.budget.repairs}`);
  }
  return true;
}

// ── 固定时钟 ──

/**
 * 固定时钟只支持整小时偏移，执行器用 `Etc/GMT∓N` 固定 Node 本地时区。
 * 半小时时区无法用 POSIX TZ 名称表达，直接拒绝而不是让本地日期悄悄偏移。
 */
export function timezoneForInstant(instant) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(instant);
  if (!match) fail("clock.format", `固定时钟必须是带偏移的 ISO 时间：${String(instant)}`);
  if (match[7] === "Z") return { offsetMinutes: 0, timezone: "UTC" };
  const sign = match[8] === "+" ? 1 : -1;
  const hours = Number(match[9]);
  const minutes = Number(match[10]);
  if (minutes !== 0) fail("clock.offset", `固定时钟只支持整小时时区偏移：${instant}`);
  if (hours > 14 || (hours === 14 && minutes !== 0)) fail("clock.offset", `时区偏移超出可用范围：${instant}`);
  const offsetMinutes = sign * hours * 60;
  return {
    offsetMinutes,
    timezone: offsetMinutes === 0 ? "UTC" : `Etc/GMT${offsetMinutes > 0 ? "-" : "+"}${Math.abs(hours)}`,
  };
}

export function buildClockFile({ base, reason }) {
  assertInstant(base, "clock.base");
  assertText(reason, "clock.reason");
  const { timezone } = timezoneForInstant(base);
  return { schemaVersion: 1, base, timezone, reason };
}

/** 读取时重新计算时区：文件里的 timezone 与 base 偏移不一致即拒绝（防止手改后本地日期漂移）。 */
export function validateClockFile(raw) {
  assertExactKeys(raw, "clock", ["schemaVersion", "base", "timezone", "reason"]);
  if (raw.schemaVersion !== 1) fail("clock.version", "clock.schemaVersion 必须是 1");
  const rebuilt = buildClockFile({ base: raw.base, reason: raw.reason });
  assertText(raw.timezone, "clock.timezone");
  if (raw.timezone !== rebuilt.timezone) {
    fail("clock.timezone", `clock.timezone=${raw.timezone} 与 base 偏移推出的 ${rebuilt.timezone} 不一致`);
  }
  return rebuilt;
}

// ── 驱动包 ──

/**
 * 驱动包只做结构校验：字段与驱动步骤必须来自 buildDriverPackage 的白名单。
 * 内容泄漏检查在判分包冻结时用完整数据集执行，这里不维护第二份词表。
 */
export function validateDriverPackage(raw) {
  assertExactKeys(raw, "driverPackage", ["schemaVersion", "caseId", "revision", "specHash", "userRole", "driver"]);
  if (raw.schemaVersion !== DATASET_SCHEMA_VERSION) {
    fail("driver.version", `driverPackage.schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`);
  }
  assertPattern(raw.caseId, CASE_ID_PATTERN, "driverPackage.caseId");
  assertPositiveInteger(raw.revision, "driverPackage.revision");
  assertPattern(raw.specHash, HASH_PATTERN, "driverPackage.specHash");

  assertExactKeys(raw.userRole, "driverPackage.userRole", [
    "knownFacts", "goal", "tone", "allowedActions", "mustNotReveal",
  ]);
  assertStringArray(raw.userRole.knownFacts, "driverPackage.userRole.knownFacts", { allowEmpty: true });
  assertText(raw.userRole.goal, "driverPackage.userRole.goal");
  assertText(raw.userRole.tone, "driverPackage.userRole.tone");
  assertStringArray(raw.userRole.allowedActions, "driverPackage.userRole.allowedActions");
  assertStringArray(raw.userRole.mustNotReveal, "driverPackage.userRole.mustNotReveal");

  if (!Array.isArray(raw.driver) || raw.driver.length === 0) fail("driver.steps", "driverPackage.driver 必须是非空数组");
  const ids = new Set();
  let previousAt = -Infinity;
  const steps = raw.driver.map((step, index) => {
    const label = `driverPackage.driver[${index}]`;
    assertRecord(step, label);
    const id = assertPattern(step.id, CASE_ID_PATTERN, `${label}.id`);
    if (ids.has(id)) fail("driver.steps", `driverPackage 含重复步骤 id：${id}`);
    ids.add(id);
    assertInstant(step.at, `${label}.at`);
    const at = Date.parse(step.at);
    if (at < previousAt) fail("driver.clock-order", `驱动步骤必须按 at 升序：${id}`);
    previousAt = at;
    if (step.kind === "message") {
      assertExactKeys(step, label, ["id", "kind", "text", "at"]);
      assertText(step.text, `${label}.text`);
      return { id, kind: "message", text: step.text, at: step.at };
    }
    if (step.kind === "host") {
      assertExactKeys(step, label, ["id", "kind", "method", "at"], ["args", "note"]);
      if (!DRIVER_HOST_METHOD_VALUES.includes(step.method)) {
        fail("driver.method", `${label}.method 未登记：${String(step.method)}`);
      }
      if (step.args !== undefined) assertRecord(step.args, `${label}.args`);
      if (step.note !== undefined) assertText(step.note, `${label}.note`);
      return {
        id,
        kind: "host",
        method: step.method,
        at: step.at,
        ...(step.args === undefined ? {} : { args: structuredClone(step.args) }),
        ...(step.note === undefined ? {} : { note: step.note }),
      };
    }
    return fail("driver.kind", `${label}.kind 必须是 message / host`);
  });
  return {
    schemaVersion: raw.schemaVersion,
    caseId: raw.caseId,
    revision: raw.revision,
    specHash: raw.specHash,
    userRole: structuredClone(raw.userRole),
    driver: steps,
  };
}

export function validateSyncPoints(raw) {
  if (!Array.isArray(raw)) fail("syncPoints.invalid", "checkpoints 必须是数组");
  const ids = new Set();
  return raw.map((point, index) => {
    const label = `checkpoints[${index}]`;
    assertExactKeys(point, label, ["id", "after", "wait"], ["note"]);
    const id = assertPattern(point.id, CASE_ID_PATTERN, `${label}.id`);
    if (ids.has(id)) fail("syncPoints.invalid", `checkpoints 含重复 id：${id}`);
    ids.add(id);
    assertPattern(point.after, CASE_ID_PATTERN, `${label}.after`);
    if (!CHECKPOINT_WAITS.includes(point.wait)) fail("syncPoints.wait", `${label}.wait 未登记：${String(point.wait)}`);
    if (point.note !== undefined) assertText(point.note, `${label}.note`);
    return { id, after: point.after, wait: point.wait, ...(point.note === undefined ? {} : { note: point.note }) };
  });
}

// ── 驱动进度 ──

export function createDriverProgress({ driverPackage, driverHash, budget, clockBase, startedAt }) {
  assertPattern(driverHash, HASH_PATTERN, "driverHash");
  assertInstant(clockBase, "clockBase");
  assertInstant(startedAt, "startedAt");
  return {
    schemaVersion: DRIVER_PROGRESS_SCHEMA_VERSION,
    caseId: driverPackage.caseId,
    revision: driverPackage.revision,
    specHash: driverPackage.specHash,
    driverHash,
    clockBase,
    index: 0,
    status: "pending",
    inFlight: null,
    blocked: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    budget: {
      messages: budget.messages,
      tokens: budget.tokens,
      minutes: budget.minutes,
      trials: budget.trials,
      repairs: budget.repairs,
    },
    usage: {
      messages: 0,
      tokens: 0,
      tokensCalls: 0,
      tokensReportedCalls: 0,
      tokensUnknown: false,
      startedAt: null,
      elapsedMinutes: 0,
      contextErrors: [],
    },
    steps: [],
  };
}

export function readDriverProgress(raw) {
  assertExactKeys(raw, "driverProgress", [
    "schemaVersion", "caseId", "revision", "specHash", "driverHash", "clockBase", "index",
    "status", "inFlight", "blocked", "createdAt", "updatedAt", "budget", "usage", "steps",
  ], ["totalSteps", "lastUsageStepId"]);
  if (raw.totalSteps !== undefined) assertPositiveInteger(raw.totalSteps, "driverProgress.totalSteps");
  if (raw.lastUsageStepId !== undefined) assertPattern(raw.lastUsageStepId, CASE_ID_PATTERN, "driverProgress.lastUsageStepId");
  if (raw.schemaVersion !== DRIVER_PROGRESS_SCHEMA_VERSION) {
    fail("driver.progress-version", `driver-progress.schemaVersion 必须是 ${DRIVER_PROGRESS_SCHEMA_VERSION}`);
  }
  assertPattern(raw.caseId, CASE_ID_PATTERN, "driverProgress.caseId");
  assertPositiveInteger(raw.revision, "driverProgress.revision");
  assertPattern(raw.specHash, HASH_PATTERN, "driverProgress.specHash");
  assertPattern(raw.driverHash, HASH_PATTERN, "driverProgress.driverHash");
  assertInstant(raw.clockBase, "driverProgress.clockBase");
  assertNonNegativeInteger(raw.index, "driverProgress.index");
  if (!DRIVER_STATUSES.includes(raw.status)) fail("driver.progress-status", `driverProgress.status 非法：${String(raw.status)}`);
  assertInstant(raw.createdAt, "driverProgress.createdAt");
  assertInstant(raw.updatedAt, "driverProgress.updatedAt");
  assertExactKeys(raw.budget, "driverProgress.budget", ["messages", "tokens", "minutes", "trials", "repairs"]);
  for (const key of ["messages", "tokens", "minutes", "trials"]) {
    assertPositiveInteger(raw.budget[key], `driverProgress.budget.${key}`);
  }
  assertNonNegativeInteger(raw.budget.repairs, "driverProgress.budget.repairs");
  assertExactKeys(raw.usage, "driverProgress.usage", [
    "messages", "tokens", "tokensCalls", "tokensReportedCalls", "tokensUnknown",
    "startedAt", "elapsedMinutes", "contextErrors",
  ]);
  assertNonNegativeInteger(raw.usage.messages, "driverProgress.usage.messages");
  assertNonNegativeInteger(raw.usage.tokens, "driverProgress.usage.tokens");
  assertNonNegativeInteger(raw.usage.tokensCalls, "driverProgress.usage.tokensCalls");
  assertNonNegativeInteger(raw.usage.tokensReportedCalls, "driverProgress.usage.tokensReportedCalls");
  if (typeof raw.usage.tokensUnknown !== "boolean") fail("driver.usage", "driverProgress.usage.tokensUnknown 必须是布尔值");
  if (raw.usage.startedAt !== null) assertInstant(raw.usage.startedAt, "driverProgress.usage.startedAt");
  if (typeof raw.usage.elapsedMinutes !== "number" || raw.usage.elapsedMinutes < 0) {
    fail("driver.usage", "driverProgress.usage.elapsedMinutes 必须是非负数");
  }
  if (!Array.isArray(raw.usage.contextErrors)) fail("driver.usage", "driverProgress.usage.contextErrors 必须是数组");
  if (raw.usage.contextErrors.length > 10) fail("driver.usage", "driverProgress.usage.contextErrors 超过 10 条");
  for (const [index, item] of raw.usage.contextErrors.entries()) {
    assertExactKeys(item, `driverProgress.usage.contextErrors[${index}]`, ["at", "stepId", "error"]);
    assertInstant(item.at, `driverProgress.usage.contextErrors[${index}].at`);
    assertText(item.stepId, `driverProgress.usage.contextErrors[${index}].stepId`);
    assertText(item.error, `driverProgress.usage.contextErrors[${index}].error`);
  }
  if (raw.inFlight !== null) {
    assertExactKeys(raw.inFlight, "driverProgress.inFlight", ["index", "stepId", "kind", "at", "startedAt"]);
    assertNonNegativeInteger(raw.inFlight.index, "driverProgress.inFlight.index");
    assertPattern(raw.inFlight.stepId, CASE_ID_PATTERN, "driverProgress.inFlight.stepId");
    if (!["message", "host"].includes(raw.inFlight.kind)) fail("driver.inflight", "driverProgress.inFlight.kind 非法");
    assertInstant(raw.inFlight.at, "driverProgress.inFlight.at");
    assertInstant(raw.inFlight.startedAt, "driverProgress.inFlight.startedAt");
  }
  if (raw.blocked !== null) {
    assertExactKeys(raw.blocked, "driverProgress.blocked", ["code", "message", "at"]);
    assertText(raw.blocked.code, "driverProgress.blocked.code");
    assertText(raw.blocked.message, "driverProgress.blocked.message");
    assertInstant(raw.blocked.at, "driverProgress.blocked.at");
  }
  if (!Array.isArray(raw.steps)) fail("driver.progress-steps", "driverProgress.steps 必须是数组");
  for (const [index, step] of raw.steps.entries()) {
    const label = `driverProgress.steps[${index}]`;
    assertExactKeys(step, label, [
      "index", "id", "kind", "at", "status", "startedAt", "completedAt", "clock", "result",
    ], ["error", "checkpoints"]);
    assertNonNegativeInteger(step.index, `${label}.index`);
    assertPattern(step.id, CASE_ID_PATTERN, `${label}.id`);
    if (!["message", "host"].includes(step.kind)) fail("driver.step", `${label}.kind 非法`);
    assertInstant(step.at, `${label}.at`);
    if (!DRIVER_STEP_STATUSES.includes(step.status)) fail("driver.step", `${label}.status 非法`);
    assertInstant(step.startedAt, `${label}.startedAt`);
    assertInstant(step.completedAt, `${label}.completedAt`);
    assertExactKeys(step.clock, `${label}.clock`, ["base", "now", "timezone"]);
    assertInstant(step.clock.base, `${label}.clock.base`);
    assertInstant(step.clock.now, `${label}.clock.now`);
    assertText(step.clock.timezone, `${label}.clock.timezone`);
    assertRecord(step.result, `${label}.result`);
    if (step.error !== undefined) assertText(step.error, `${label}.error`);
    if (step.checkpoints !== undefined) {
      if (!Array.isArray(step.checkpoints)) fail("driver.step", `${label}.checkpoints 必须是数组`);
      for (const [checkIndex, check] of step.checkpoints.entries()) {
        const checkLabel = `${label}.checkpoints[${checkIndex}]`;
        assertExactKeys(check, checkLabel, ["id", "wait", "status", "observedAt"], ["detail"]);
        assertPattern(check.id, CASE_ID_PATTERN, `${checkLabel}.id`);
        if (!CHECKPOINT_WAITS.includes(check.wait)) fail("driver.step", `${checkLabel}.wait 非法`);
        if (!["satisfied", "timeout"].includes(check.status)) fail("driver.step", `${checkLabel}.status 非法`);
        assertInstant(check.observedAt, `${checkLabel}.observedAt`);
        if (check.detail !== undefined) assertText(check.detail, `${checkLabel}.detail`);
      }
    }
  }
  return raw;
}

export function assertResumable(progress) {
  if (progress.status === "completed") return { resumable: false, reason: "驱动已完成" };
  if (progress.status === "blocked") {
    fail("driver.blocked", `驱动已阻塞：${progress.blocked?.message ?? "原因未记录"}；不能自动续跑`);
  }
  if (progress.inFlight) {
    fail(
      "driver.inflight",
      `步骤 ${progress.inFlight.stepId} 已开始但结果未知；副作用不得重放。`
      + "请核对会话与对话证据，必要时以新 attempt 修复。",
    );
  }
  return { resumable: true };
}

export function checkDriverBudget({ progress, now = Date.now() }) {
  const budget = progress.budget;
  if (progress.usage.messages >= budget.messages) {
    return { ok: false, code: "budget.messages", message: `消息预算已用尽（${progress.usage.messages}/${budget.messages}）` };
  }
  if (progress.usage.startedAt) {
    const elapsedMs = Math.max(0, now - Date.parse(progress.usage.startedAt));
    if (elapsedMs >= budget.minutes * 60_000) {
      return {
        ok: false,
        code: "budget.minutes",
        message: `时间预算已用尽（${(elapsedMs / 60_000).toFixed(1)}/${budget.minutes} 分钟）`,
      };
    }
  }
  if (progress.usage.tokens >= budget.tokens) {
    return { ok: false, code: "budget.tokens", message: `已知 token 用量已达预算（${progress.usage.tokens}/${budget.tokens}）` };
  }
  return { ok: true, warnings: progress.usage.tokensUnknown ? ["tokens.unknown"] : [] };
}

export function recordContextUsage(progress, usage, { at, stepId }) {
  if (!isRecord(usage)) return;
  const calls = Number(usage.calls);
  const reported = Number(usage.reported);
  const total = Number(usage.total);
  if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(reported) || !Number.isSafeInteger(total)) return;
  progress.usage.tokensCalls = calls;
  progress.usage.tokensReportedCalls = reported;
  progress.usage.tokens = Math.max(progress.usage.tokens, total);
  progress.usage.tokensUnknown = reported < calls;
  if (at) progress.updatedAt = at;
  if (stepId) progress.lastUsageStepId = stepId;
}

export function driverSummary(progress) {
  return {
    status: progress.status,
    index: progress.index,
    total: progress.totalSteps ?? null,
    completed: progress.steps.filter((step) => step.status === "completed").length,
    failed: progress.steps.filter((step) => step.status === "failed").length,
    inFlight: progress.inFlight ? progress.inFlight.stepId : null,
    blocked: progress.blocked,
    clockBase: progress.clockBase,
    lastClock: progress.steps.at(-1)?.clock?.base ?? progress.clockBase,
    usage: {
      messages: progress.usage.messages,
      tokens: progress.usage.tokens,
      tokensCalls: progress.usage.tokensCalls,
      tokensReportedCalls: progress.usage.tokensReportedCalls,
      tokensUnknown: progress.usage.tokensUnknown,
      elapsedMinutes: progress.usage.elapsedMinutes,
      contextErrors: progress.usage.contextErrors.length,
    },
  };
}

// ── 执行 ──

function assertPackageMatches(progress, driverPackage) {
  if (progress.caseId !== driverPackage.caseId || progress.specHash !== driverPackage.specHash) {
    fail("driver.binding", "驱动进度与驱动包的 caseId/specHash 不一致；不能续跑");
  }
}

/** 回执必须原样绑定本步 operation、trial、会话与宿主代际；缺项或错组不得当作请求结果。 */
function messageReceiptFor(step, response, operation) {
  const receipt = response.operation;
  if (!isRecord(receipt)) fail("driver.receipt", `消息步骤 ${step.id} 的回执缺少请求身份`);
  for (const field of MESSAGE_OPERATION_FIELDS) {
    if (typeof receipt[field] !== "string" || receipt[field].trim() === "") {
      fail("driver.receipt", `消息步骤 ${step.id} 的回执缺少 ${field}`);
    }
  }
  for (const field of ["operationId", "caseId", "stepId"]) {
    if (receipt[field] !== operation[field]) {
      fail("driver.receipt", `消息步骤 ${step.id} 的回执的 operation 与本步不一致（${field}）`);
    }
  }
  if (response.requestId !== receipt.operationId) {
    fail("driver.receipt", `消息步骤 ${step.id} 的 requestId 与 operation 不一致`);
  }
  if (receipt.sessionId !== response.sessionId) {
    fail("driver.receipt", `消息步骤 ${step.id} 的回执会话与响应会话不一致`);
  }
  return {
    operation: {
      operationId: receipt.operationId,
      caseId: receipt.caseId,
      trialId: receipt.trialId,
      sessionId: receipt.sessionId,
      generation: receipt.generation,
      stepId: receipt.stepId,
    },
    requestId: response.requestId,
    ...(typeof response.assistantEntryId === "string" && response.assistantEntryId.trim()
      ? { assistantEntryId: response.assistantEntryId } : {}),
    ...(isRecord(response.delivery) ? { delivery: structuredClone(response.delivery) } : {}),
  };
}

function stepResultFor(step, response, operation) {
  if (step.kind === "message") {
    if (!isRecord(response)) fail("driver.transport", `消息步骤 ${step.id} 没有返回回执`);
    const reply = typeof response.reply === "string" ? response.reply : "";
    assertText(response.sessionId, `消息步骤 ${step.id} 的 sessionId`);
    if (!["succeeded", "queued", "failed"].includes(response.outcome)) {
      fail("driver.transport", `消息步骤 ${step.id} 的 outcome 非法：${String(response.outcome)}`);
    }
    return {
      kind: "message",
      sessionId: response.sessionId,
      outcome: response.outcome,
      reply,
      toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
      ...messageReceiptFor(step, response, operation),
    };
  }
  if (!isRecord(response) || response.method !== step.method) {
    fail("driver.transport", `宿主步骤 ${step.id} 的回执与 method 不一致`);
  }
  return { kind: "host", method: response.method, result: response.result ?? null };
}

async function executeHostStep(step, transport) {
  const before = step.method === "chat_new_session" || step.method === "chat_switch_session"
    ? await transport.sessions()
    : null;
  const response = await transport.host(step.method, step.args ?? {});
  const after = step.method === "chat_new_session" || step.method === "chat_switch_session"
    ? await transport.sessions()
    : null;
  if (step.method === "chat_new_session") {
    if (!after?.active || after.active === before?.active) {
      fail("driver.session", `chat_new_session 没有产生新的活跃会话（步骤 ${step.id}）`);
    }
    return { ...response, result: { ...(isRecord(response.result) ? response.result : {}), createdSessionId: after.active } };
  }
  if (step.method === "chat_switch_session") {
    const target = step.args?.sessionId;
    if (typeof target !== "string" || target.trim() === "") fail("driver.args", `chat_switch_session 缺少 args.sessionId（步骤 ${step.id}）`);
    if (after?.active !== target) fail("driver.session", `chat_switch_session 未切到目标会话（步骤 ${step.id}）`);
    return { ...response, result: { ...(isRecord(response.result) ? response.result : {}), activeSessionId: after.active } };
  }
  if (step.method === "chat_stop" && (typeof step.args?.sessionId !== "string" || step.args.sessionId.trim() === "")) {
    fail("driver.args", `chat_stop 缺少 args.sessionId（步骤 ${step.id}）`);
  }
  if (step.method === "chat_slash_command") {
    const command = step.args?.command;
    if (typeof command !== "string" || !command.startsWith("/")) {
      fail("driver.args", `chat_slash_command 的 args.command 必须以 / 开头（步骤 ${step.id}）`);
    }
  }
  return response;
}

function readMemorySnapshot(state) {
  if (!isRecord(state)) fail("driver.memory", "memory_state 回执不是对象");
  const pendingSources = Number(state.pendingSources);
  const activeJobs = Array.isArray(state.activeJobs) ? state.activeJobs.length : Number.NaN;
  if (!Number.isSafeInteger(pendingSources) || !Number.isSafeInteger(activeJobs)) {
    fail("driver.memory", "memory_state 缺少 pendingSources/activeJobs 计数");
  }
  if (!Array.isArray(state.jobs)) fail("driver.memory", "memory_state 缺少 jobs 作业列表");
  const jobs = state.jobs.map(job => {
    if (!isRecord(job) || typeof job.id !== "string" || job.id.trim() === "" || typeof job.status !== "string") {
      fail("driver.memory", "memory_state 的作业条目缺少 id/status");
    }
    return { id: job.id, status: job.status };
  });
  return { pendingSources, activeJobs, jobs };
}

/** 消息等副作用之前抓取作业基线；只有基线之外的作业才算本轮真正发生的抽取。 */
async function captureMemoryBaseline(transport) {
  const snapshot = readMemorySnapshot(await transport.memoryState());
  return { jobIds: snapshot.jobs.map(job => job.id) };
}

async function waitForMemoryExtractionEnd({ transport, now, sleep, deadlineMs, pollMs, stableMs, baseline }) {
  const deadline = now() + deadlineMs;
  const knownJobIds = new Set(baseline.jobIds);
  const observations = [];
  const seenNewJobs = new Map();
  let stableSince = null;
  while (now() < deadline) {
    const state = readMemorySnapshot(await transport.memoryState());
    const newJobs = state.jobs.filter(job => !knownJobIds.has(job.id));
    for (const job of newJobs) seenNewJobs.set(job.id, job.status);
    const unfinishedNewJobs = [...seenNewJobs.values()].filter(status => !MEMORY_JOB_TERMINAL_STATUSES.includes(status));
    observations.push({
      at: new Date(now()).toISOString(),
      pendingSources: state.pendingSources,
      activeJobs: state.activeJobs,
      newJobs: newJobs.map(job => `${job.id}:${job.status}`),
    });
    // 空水位本身不证明抽取发生过：必须看到基线之后的新作业收口，且水位保持归零。
    if (seenNewJobs.size > 0 && unfinishedNewJobs.length === 0
      && state.pendingSources === 0 && state.activeJobs === 0) {
      stableSince ??= now();
      if (now() - stableSince >= stableMs) {
        const summary = [...seenNewJobs].map(([id, status]) => `${id}:${status}`).join("、");
        return {
          status: "satisfied",
          detail: `新抽取作业 ${summary}；pendingSources=0 activeJobs=0（${observations.length} 次观察）`,
          observations,
        };
      }
    } else {
      stableSince = null;
    }
    await sleep(pollMs);
  }
  const reason = seenNewJobs.size === 0
    ? "没有发现新抽取作业"
    : `新抽取作业 ${[...seenNewJobs].map(([id, status]) => `${id}:${status}`).join("、")} 未在期限内收口或水位未归零`;
  return {
    status: "timeout",
    detail: `等待自动记忆抽取结束超时：${reason}（${observations.length} 次观察）`,
    observations,
  };
}

async function satisfyCheckpoint({ checkpoint, record, transport, now, sleep, memoryWait, memoryBaseline }) {
  const observedAt = new Date(now()).toISOString();
  if (checkpoint.wait === "assistant_message") {
    if (record.result?.kind !== "message") {
      return { id: checkpoint.id, wait: checkpoint.wait, status: "timeout", observedAt, detail: "assistant_message 只适用于消息步骤" };
    }
    if (record.result.reply.trim() === "") {
      return { id: checkpoint.id, wait: checkpoint.wait, status: "timeout", observedAt, detail: "消息步骤没有取得助手回复" };
    }
    return { id: checkpoint.id, wait: checkpoint.wait, status: "satisfied", observedAt, detail: `回复 ${record.result.reply.length} 字` };
  }
  if (checkpoint.wait === "session_created") {
    const created = record.result?.result?.createdSessionId;
    if (record.result?.kind !== "host" || typeof created !== "string" || created === "") {
      return { id: checkpoint.id, wait: checkpoint.wait, status: "timeout", observedAt, detail: "步骤没有产生新会话" };
    }
    return { id: checkpoint.id, wait: checkpoint.wait, status: "satisfied", observedAt, detail: `新会话 ${created}` };
  }
  if (checkpoint.wait === "host_readback") {
    if (record.result?.kind !== "host") {
      return { id: checkpoint.id, wait: checkpoint.wait, status: "timeout", observedAt, detail: "host_readback 只适用于宿主步骤" };
    }
    return { id: checkpoint.id, wait: checkpoint.wait, status: "satisfied", observedAt, detail: "宿主回执已读回" };
  }
  if (!memoryBaseline) fail("driver.memory", `检查点 ${checkpoint.id} 缺少抽取基线`);
  const result = await waitForMemoryExtractionEnd({ transport, now, sleep, ...memoryWait, baseline: memoryBaseline });
  return { id: checkpoint.id, wait: checkpoint.wait, status: result.status, observedAt, detail: result.detail };
}

/**
 * 执行（或续跑）驱动。每步先推进固定时钟，再检查预算，最后才产生副作用。
 * 任一步失败或检查点超时都阻塞驱动，不自动重放已开始的步骤。
 */
export async function executeDriver({
  progress,
  driverPackage,
  syncPoints = [],
  transport,
  onProgress = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  memoryWait = { deadlineMs: 300_000, pollMs: 500, stableMs: 1_000 },
}) {
  const pkg = validateDriverPackage(driverPackage);
  validateSyncPoints(syncPoints);
  assertPackageMatches(progress, pkg);
  if (progress.status === "completed") return driverSummary(progress);
  assertResumable(progress);
  if (!isRecord(transport)) fail("driver.transport", "缺少驱动传输层");
  for (const method of ["clock", "message", "sessions", "host", "context", "memoryState"]) {
    if (typeof transport[method] !== "function") fail("driver.transport", `驱动传输层缺少 ${method}`);
  }
  if (!progress.usage.startedAt) progress.usage.startedAt = new Date(now()).toISOString();
  progress.status = "running";
  progress.totalSteps = pkg.driver.length;
  await onProgress(progress);

  for (let index = progress.index; index < pkg.driver.length; index += 1) {
    const step = pkg.driver[index];
    const budget = checkDriverBudget({ progress, now: now() });
    if (!budget.ok) {
      progress.status = "blocked";
      progress.blocked = { code: budget.code, message: budget.message, at: new Date(now()).toISOString() };
      progress.usage.elapsedMinutes = Number(((now() - Date.parse(progress.usage.startedAt)) / 60_000).toFixed(3));
      progress.updatedAt = progress.blocked.at;
      await onProgress(progress);
      fail("driver.budget", budget.message);
    }

    const clock = await transport.clock(step.at, `step:${step.id}`);
    if (!isRecord(clock) || typeof clock.base !== "string" || typeof clock.now !== "string" || typeof clock.timezone !== "string") {
      fail("driver.clock", `固定时钟回执不完整（步骤 ${step.id}）`);
    }
    if (Date.parse(clock.base) !== Date.parse(step.at)) {
      fail("driver.clock", `固定时钟没有推进到步骤时间：步骤 ${step.id} 要求 ${step.at}，实际 ${clock.base}`);
    }
    // 基线必须在副作用之前：之后出现的作业才可能是本步触发的抽取。
    const memoryBaseline = syncPoints.some((point) => point.after === step.id && point.wait === "memory_extraction_end")
      ? await captureMemoryBaseline(transport)
      : null;
    const startedAt = new Date(now()).toISOString();
    progress.inFlight = { index, stepId: step.id, kind: step.kind, at: step.at, startedAt };
    progress.updatedAt = startedAt;
    if (step.kind === "message") progress.usage.messages += 1;
    // 先落 inFlight 再发副作用：崩溃后下一步只能核对现场，不能重放。
    await onProgress(progress);

    const operation = step.kind === "message"
      ? { operationId: `op-${randomUUID()}`, caseId: progress.caseId, stepId: step.id }
      : null;
    let response;
    let record;
    try {
      response = step.kind === "message"
        ? await transport.message(step.text, operation)
        : await executeHostStep(step, transport);
      const result = stepResultFor(step, response, operation);
      if (step.kind === "message" && (response.outcome === "failed" || result.reply.trim() === "")) {
        const reason = response.failure
          ? `回合失败：${response.failure.kind ?? "unknown"}${response.failure.message ? ` / ${response.failure.message}` : ""}`
          : "消息步骤没有取得助手回复";
        fail("driver.message", `步骤 ${step.id} ${reason}`);
      }
      record = {
        index,
        id: step.id,
        kind: step.kind,
        at: step.at,
        status: "completed",
        startedAt,
        completedAt: new Date(now()).toISOString(),
        clock: { base: clock.base, now: clock.now, timezone: clock.timezone },
        result,
        checkpoints: [],
      };
    } catch (error) {
      record = {
        index,
        id: step.id,
        kind: step.kind,
        at: step.at,
        status: "failed",
        startedAt,
        completedAt: new Date(now()).toISOString(),
        clock: { base: clock.base, now: clock.now, timezone: clock.timezone },
        result: { kind: step.kind, error: error instanceof Error ? error.message : String(error) },
        error: error instanceof Error ? error.message : String(error),
      };
      progress.steps.push(record);
      progress.inFlight = null;
      progress.status = "blocked";
      progress.blocked = {
        code: error instanceof WorkflowError ? error.code : "driver.step",
        message: record.error,
        at: record.completedAt,
      };
      progress.usage.elapsedMinutes = Number(((now() - Date.parse(progress.usage.startedAt)) / 60_000).toFixed(3));
      progress.updatedAt = record.completedAt;
      await onProgress(progress);
      throw error;
    }

    progress.steps.push(record);
    progress.inFlight = null;
    progress.index = index + 1;
    progress.updatedAt = record.completedAt;

    const points = syncPoints.filter((point) => point.after === step.id);
    for (const checkpoint of points) {
      const check = await satisfyCheckpoint({ checkpoint, record, transport, now, sleep, memoryWait, memoryBaseline });
      record.checkpoints.push(check);
      if (check.status !== "satisfied") {
        progress.status = "blocked";
        progress.blocked = {
          code: "checkpoint.timeout",
          message: `${checkpoint.id}: ${check.detail}`,
          at: check.observedAt,
        };
        progress.updatedAt = check.observedAt;
        await onProgress(progress);
        fail("checkpoint.timeout", progress.blocked.message);
      }
    }

    try {
      const usage = await transport.context();
      recordContextUsage(progress, usage?.context?.usageTotal, { at: record.completedAt, stepId: step.id });
    } catch (error) {
      progress.usage.contextErrors.push({
        at: record.completedAt,
        stepId: step.id,
        error: error instanceof Error ? error.message : String(error),
      });
      progress.usage.tokensUnknown = true;
    }
    progress.usage.elapsedMinutes = Number(((now() - Date.parse(progress.usage.startedAt)) / 60_000).toFixed(3));
    await onProgress(progress);
  }

  progress.status = "completed";
  progress.updatedAt = new Date(now()).toISOString();
  progress.usage.elapsedMinutes = Number(((now() - Date.parse(progress.usage.startedAt)) / 60_000).toFixed(3));
  await onProgress(progress);
  return driverSummary(progress);
}

/** 把运行完成度转成采集收口语义：只有驱动完成且无阻塞才是 completed。 */
export function driverOutcome(progress) {
  if (progress.status === "completed") return { status: "completed", reason: null };
  if (progress.status === "blocked") {
    return { status: "interrupted", reason: progress.blocked?.message ?? "驱动阻塞" };
  }
  if (progress.inFlight) {
    return { status: "interrupted", reason: `步骤 ${progress.inFlight.stepId} 已开始但未返回` };
  }
  return { status: "interrupted", reason: `驱动未完成（status=${progress.status}）` };
}

// ── 同条件对照与留出 ──

export function conditionsFromRun({ run, manifest, judgePromptVersion = null }) {
  const identity = manifest?.identity;
  // 对照以 attempt 实际覆盖的用例为准：同一运行组可含多 case，基线 attempt 只落了其中一个。
  const attemptCases = Array.isArray(manifest?.expectedTrials)
    ? [...new Set(manifest.expectedTrials.map((trial) => trial?.caseId).filter(Boolean))].sort()
    : [];
  // 实际模型由封存时写在 manifest 顶层；identity.models 只是运行前的请求快照。
  const sealedModels = manifest?.models;
  return {
    caseIds: attemptCases.length ? attemptCases : [...(run.scope?.caseIds ?? [])].sort(),
    suiteIds: [...(run.scope?.suiteIds ?? [])].sort(),
    specHash: identity?.inputs?.specHash ?? null,
    contentHash: identity?.inputs?.contentHash ?? null,
    fixtureHash: identity?.inputs?.fixtureHash ?? null,
    driverHash: identity?.inputs?.driverHash ?? null,
    oracleHash: identity?.inputs?.oracleHash ?? null,
    requestedModel: sealedModels?.requested ?? null,
    actualModel: sealedModels?.actual ?? null,
    hostMode: identity?.host?.mode ?? null,
    hostCapabilities: [...(identity?.host?.capabilities ?? [])].sort(),
    platform: identity?.platform ? `${identity.platform.os}/${identity.platform.arch}` : null,
    runtime: identity?.runtime?.version ?? null,
    driverVersion: identity?.tools?.driverVersion ?? null,
    rubricVersion: identity?.tools?.rubricVersion ?? null,
    graderVersion: identity?.tools?.graderVersion ?? null,
    judgePromptVersion: judgePromptVersion ?? identity?.tools?.judgePromptVersion ?? null,
    commit: identity?.code?.commit ?? null,
    sourceHash: identity?.code?.sourceHash ?? null,
    cardHash: identity?.inputs?.cardHash ?? null,
    configHash: identity?.inputs?.configHash ?? null,
  };
}

function sameCondition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 同条件对照：固定项必须完全一致；目标代码／Card／配置的变化只记录，不改变可比性。
 * 缺失值记 unknown 而不是相等；actualModel 缺失时该对照不可直接归因。
 */
export function compareRunConditions({ candidate, baseline }) {
  const checks = [];
  const unknown = [];
  const issues = [];
  for (const field of FIXED_CONDITION_FIELDS) {
    const left = baseline.conditions?.[field] ?? null;
    const right = candidate.conditions?.[field] ?? null;
    if (left === null || right === null) {
      unknown.push(field);
      checks.push({ field, baseline: left, candidate: right, same: false, status: "unknown" });
      continue;
    }
    const same = sameCondition(left, right);
    checks.push({ field, baseline: left, candidate: right, same, status: same ? "same" : "different" });
    if (!same) issues.push(`固定条件不一致：${field}`);
  }
  if (unknown.length) issues.push(`缺少对照所需字段：${unknown.join(", ")}`);
  const targetChanges = [];
  for (const field of TARGET_CONDITION_FIELDS) {
    const left = baseline.conditions?.[field] ?? null;
    const right = candidate.conditions?.[field] ?? null;
    if (!sameCondition(left, right)) targetChanges.push({ field, baseline: left, candidate: right });
  }
  return {
    comparable: issues.length === 0,
    issues,
    unknown,
    checks,
    targetChanges,
    baselineRunId: baseline.evaluationRunId,
    candidateRunId: candidate.evaluationRunId,
  };
}

/** 留出是否已被使用：扫描全部运行组的不可变范围（含在途与待审）。 */
export function holdoutUsage({ runs, caseId }) {
  const uses = runs
    .filter((entry) => Array.isArray(entry.run?.scope?.caseIds) && entry.run.scope.caseIds.includes(caseId))
    .map((entry) => ({
      evaluationRunId: entry.evaluationRunId,
      createdAt: entry.run.createdAt ?? null,
      phase: entry.workflow?.phase ?? null,
      holdout: entry.run.scope?.holdout === true,
      purpose: entry.run.scope?.purpose ?? null,
    }));
  return { caseId, used: uses.length > 0, uses };
}
