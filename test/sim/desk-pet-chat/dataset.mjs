import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * 结构化聊天评测数据集：候选内容、fixture、驱动、探针与用户审批的绑定关系。
 *
 * gold 只能由用户针对当前 specHash 的审批记录产生，本模块不提供写审批的能力。
 * 驱动包只含 userRole + driver；探针、检查点、证据与评分不能进入驱动包。
 */

export const DATASET_SCHEMA_VERSION = 3;
export const QUESTION_TYPES_SCHEMA_VERSION = 1;
export const DEFAULT_DATASET_ROOT = "test/ideal-traces";
export const DEFAULT_CATEGORIES_PATH = "test/sim/desk-pet-chat/categories.json";
export const DEFAULT_QUESTION_TYPES_PATH = "test/sim/desk-pet-chat/question-types.json";

export const PURPOSE_VALUES = Object.freeze(["development", "calibration", "holdout", "regression"]);
export const SOURCE_KIND_VALUES = Object.freeze(["ideal", "confirmed-issue", "requirement"]);
export const HOST_CAPABILITY_VALUES = Object.freeze(["chat", "memory", "session"]);
export const TIME_MODE_VALUES = Object.freeze(["real", "fixed"]);
export const MEMORY_KIND_VALUES = Object.freeze(["fact", "preference", "episode", "working"]);
export const MEMORY_SCOPE_VALUES = Object.freeze(["user", "card", "session"]);
export const FIXTURE_PREPARATION_VALUES = Object.freeze(["seed_session", "seed_memory", "seed_card", "seed_profile"]);
export const FIXTURE_LOADING_MODE_VALUES = Object.freeze(["direct-seed", "real-chain"]);
export const PROBE_DIFFICULTY_LEVELS = Object.freeze([1, 2, 3, 4, 5]);
export const DRIVER_HOST_METHOD_VALUES = Object.freeze([
  "chat_new_session",
  "chat_switch_session",
  "chat_stop",
  "chat_slash_command",
  "memory_dreaming_sweep",
]);
export const CHECKPOINT_WAIT_VALUES = Object.freeze([
  "assistant_message",
  "memory_extraction_end",
  "session_created",
  "host_readback",
]);
export const EVIDENCE_KIND_VALUES = Object.freeze([
  "session_entry",
  "memory_before_after",
  "trace_event",
  "host_readback",
  "artifact",
]);
export const QUALITY_RUBRIC_VALUES = Object.freeze(["humanizer-six-dimensions"]);
export const CALIBRATION_VALUES = Object.freeze(["uncalibrated", "calibrated"]);
export const REVIEW_ROLE_VALUES = Object.freeze(["user"]);
export const FEEDBACK_SOURCE_VALUES = Object.freeze(["session_message"]);
export const DECISION_VALUES = Object.freeze(["approved", "rejected"]);
export const ORACLE_CHECK_KIND_VALUES = Object.freeze(["result", "path", "source", "temporal", "delivery", "semantic"]);
export const PROBE_WINDOW_VALUES = Object.freeze(["last-assistant", "state", "all-assistant"]);
export const PROBE_POLARITY_VALUES = Object.freeze(["required", "forbidden"]);
export const REVIEW_AUTHORITY_VALUES = Object.freeze(["deterministic", "api-judge", "human"]);
export const REVIEW_ASSISTANT_VALUES = Object.freeze(["coding-agent"]);

function deriveCheckerAuthority(id, kind) {
  if (kind !== "semantic") return "deterministic";
  return id.startsWith("humanizer.") ? "human" : "api-judge";
}

function deriveCheckerAssistants(id, kind) {
  return kind === "semantic" && id.startsWith("humanizer.") ? ["coding-agent"] : [];
}

const CHECKER_DEFINITIONS = Object.freeze([
  { id: "answer.current-frequency", kind: "result", description: "回答当前运动频率" },
  { id: "answer.history-running", kind: "result", description: "回答实习前经常跑步" },
  { id: "answer.history-cycling", kind: "result", description: "回答实习前还经常骑车" },
  { id: "answer.food-choice-recall", kind: "result", description: "回答用户当时选了酸奶" },
  { id: "answer.corrects-false-premise", kind: "semantic", description: "用户给出与已知事实冲突的前提时纠正前提，不顺着错误前提回答" },
  { id: "answer.no-fabrication", kind: "semantic", description: "编造未被记录或无法确认的事情" },
  { id: "memory-source.correction-entry", kind: "source", description: "纠正事实来自本轮用户消息" },
  { id: "session.cross-session-answer", kind: "path", description: "新会话能引用纠正后的事实" },
  { id: "chat.correction-acknowledged", kind: "semantic", description: "接住纠正的新事实，不否认、不复述旧结论" },
  { id: "humanizer.casual-tone", kind: "semantic", description: "语气自然、口语化，符合角色" },
  { id: "humanizer.tech-banter", kind: "semantic", description: "接技术梗时口语化，不讲课、不装懂" },
  { id: "humanizer.short-confirmation", kind: "semantic", description: "对短确认只作同档短回应，不追加新话题" },
  { id: "humanizer.food-return", kind: "semantic", description: "用自足的口语接住返场，不索取回应" },
  { id: "answer.no-temporal-swap", kind: "temporal", description: "把实习前与当前的频率对调" },
  { id: "answer.no-cycling-temporal-swap", kind: "temporal", description: "把以前经常骑车说成现在仍常骑" },
  { id: "memory-source.no-fixture-as-update", kind: "source", description: "把 fixture 初始记忆当作本轮用户更新" },
  { id: "humanizer.no-service-tone", kind: "semantic", description: "出现助手腔、服务腔或未被请求的总结式建议" },
  { id: "humanizer.no-meta-role", kind: "semantic", description: "打破角色说自己是程序、AI 或模型" },
  { id: "humanizer.no-self-explanation", kind: "semantic", description: "解释自己的玩笑或刚说过的话" },
  { id: "humanizer.no-unsolicited-advice", kind: "semantic", description: "主动给建议、说教或催促" },
  { id: "driver.no-oracle-leak", kind: "delivery", description: "驱动过程泄露探针、评分或 fixture 信息" },
]);

export const ORACLE_CHECKER_SPECS = Object.freeze(
  CHECKER_DEFINITIONS.map((checker) =>
    Object.freeze({
      ...checker,
      authority: deriveCheckerAuthority(checker.id, checker.kind),
      assistants: Object.freeze(deriveCheckerAssistants(checker.id, checker.kind)),
    }),
  ),
);

const ORACLE_CHECKER_MAP = new Map(ORACLE_CHECKER_SPECS.map((checker) => [checker.id, checker]));
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const APPROVAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CASE_FILE_SUFFIX = ".case.json";
const FORBIDDEN_EMBEDDED_KEYS = new Set([
  "label",
  "labels",
  "status",
  "approval",
  "approvals",
  "gold",
  "silver",
  "tier",
  "reviewStatus",
  "reviewedAt",
  "approvalId",
]);

export class DatasetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DatasetError";
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function clone(value) {
  return structuredClone(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new DatasetError("schema.invalid", `${label} 必须是对象`);
}

function assertExactKeys(value, label, required, optional = []) {
  assertRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new DatasetError("schema.unknown-key", `${label} 含未登记字段：${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new DatasetError("schema.missing-key", `${label} 缺少字段：${key}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DatasetError("schema.invalid", `${label} 必须是非空字符串`);
  }
  return value;
}

function assertOptionalString(value, label) {
  if (value !== undefined) assertNonEmptyString(value, label);
}

function assertPattern(value, pattern, label) {
  assertNonEmptyString(value, label);
  if (!pattern.test(value)) throw new DatasetError("schema.invalid", `${label} 格式无效：${value}`);
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DatasetError("schema.invalid", `${label} 必须是正整数`);
  }
  return value;
}

function assertIntegerInRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatasetError("schema.invalid", `${label} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DatasetError("schema.invalid", `${label} 必须是带时区的 ISO 时间：${String(value)}`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new DatasetError("schema.invalid", `${label} 必须是 ${allowed.join(" / ")} 之一：${String(value)}`);
  }
  return value;
}

function assertStringArray(value, label, { allowEmpty = false, unique = false } = {}) {
  if (!Array.isArray(value)) throw new DatasetError("schema.invalid", `${label} 必须是数组`);
  if (!allowEmpty && value.length === 0) throw new DatasetError("schema.invalid", `${label} 不能为空`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new DatasetError("schema.invalid", `${label}[${index}] 必须是非空字符串`);
    }
    if (unique) {
      if (seen.has(item)) throw new DatasetError("schema.invalid", `${label} 含重复值：${item}`);
      seen.add(item);
    }
  }
  return value;
}

function assertSubset(values, allowed, label) {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new DatasetError("schema.invalid", `${label} 含未登记值：${String(value)}`);
    }
  }
}

function scanEmbeddedLabels(value, path, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanEmbeddedLabels(item, `${path}[${index}]`, label));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_EMBEDDED_KEYS.has(key)) {
      throw new DatasetError(
        "case.embedded-label",
        `${label} 不能内嵌审批或分级字段（${nestedPath}）；分级只能由审批绑定计算`,
      );
    }
    scanEmbeddedLabels(nested, nestedPath, label);
  }
}

function normalizeCategories(input) {
  if (!Array.isArray(input)) {
    throw new DatasetError("dataset.categories-invalid", "categories 必须是数组");
  }
  const seen = new Set();
  return input.map((item, index) => {
    const category = typeof item === "string" ? { id: item } : item;
    assertRecord(category, `categories[${index}]`);
    const id = category.id;
    assertPattern(id, CASE_ID_PATTERN, `categories[${index}].id`);
    if (seen.has(id)) throw new DatasetError("dataset.categories-invalid", `categories 含重复 id：${id}`);
    seen.add(id);
    return { ...category, id };
  });
}

function normalizeQuestionTypes(input, categoryIds) {
  const label = "题型注册表";
  assertExactKeys(input, label, ["schemaVersion", "families", "questionTypes"]);
  if (input.schemaVersion !== QUESTION_TYPES_SCHEMA_VERSION) {
    throw new DatasetError("schema.version", `${label}.schemaVersion 必须是 ${QUESTION_TYPES_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.families) || input.families.length === 0) {
    throw new DatasetError("dataset.question-types-invalid", `${label}.families 必须是非空数组`);
  }
  const familyIds = new Set();
  const families = input.families.map((family, index) => {
    assertExactKeys(family, `${label}.families[${index}]`, ["id", "name", "goal"]);
    assertPattern(family.id, CASE_ID_PATTERN, `${label}.families[${index}].id`);
    if (familyIds.has(family.id)) {
      throw new DatasetError("dataset.question-types-invalid", `${label}.families 含重复 id：${family.id}`);
    }
    familyIds.add(family.id);
    assertNonEmptyString(family.name, `${label}.families[${index}].name`);
    assertNonEmptyString(family.goal, `${label}.families[${index}].goal`);
    return { id: family.id, name: family.name, goal: family.goal };
  });

  if (!Array.isArray(input.questionTypes) || input.questionTypes.length === 0) {
    throw new DatasetError("dataset.question-types-invalid", `${label}.questionTypes 必须是非空数组`);
  }
  const knownCategories = categoryIds === undefined ? null : new Set(categoryIds);
  const typeIds = new Set();
  const coveredCategories = new Set();
  const questionTypes = input.questionTypes.map((type, index) => {
    assertExactKeys(type, `${label}.questionTypes[${index}]`, ["id", "family", "name", "goal", "capabilities"]);
    assertPattern(type.id, CASE_ID_PATTERN, `${label}.questionTypes[${index}].id`);
    if (typeIds.has(type.id)) {
      throw new DatasetError("dataset.question-types-invalid", `${label}.questionTypes 含重复 id：${type.id}`);
    }
    typeIds.add(type.id);
    if (!familyIds.has(type.family)) {
      throw new DatasetError(
        "dataset.question-types-invalid",
        `${label}.questionTypes[${index}].family 未登记：${String(type.family)}`,
      );
    }
    assertNonEmptyString(type.name, `${label}.questionTypes[${index}].name`);
    assertNonEmptyString(type.goal, `${label}.questionTypes[${index}].goal`);
    assertStringArray(type.capabilities, `${label}.questionTypes[${index}].capabilities`, { unique: true });
    if (knownCategories) {
      for (const capability of type.capabilities) {
        if (!knownCategories.has(capability)) {
          throw new DatasetError(
            "dataset.question-type-capability-unknown",
            `${label}.questionTypes[${index}].capabilities 含未登记分类：${capability}`,
          );
        }
        coveredCategories.add(capability);
      }
    }
    return {
      id: type.id,
      family: type.family,
      name: type.name,
      goal: type.goal,
      capabilities: [...type.capabilities],
    };
  });

  if (knownCategories) {
    const uncovered = categoryIds.filter((categoryId) => !coveredCategories.has(categoryId));
    if (uncovered.length > 0) {
      throw new DatasetError(
        "dataset.question-type-capability-uncovered",
        `${label} 未覆盖分类：${uncovered.join(", ")}`,
      );
    }
  }
  return { families, questionTypes };
}

function validateProbe(probe, label, driverById, evidenceIds, questionTypeIds) {
  assertExactKeys(
    probe,
    label,
    ["id", "after", "window", "checker", "questionType", "polarity", "critical", "difficulty", "description"],
    ["evidence"],
  );
  assertPattern(probe.id, CASE_ID_PATTERN, `${label}.id`);
  assertNonEmptyString(probe.after, `${label}.after`);
  const step = driverById.get(probe.after);
  if (!step) {
    throw new DatasetError("schema.invalid", `${label}.after 未指向驱动步骤：${String(probe.after)}`);
  }
  assertEnum(probe.window, PROBE_WINDOW_VALUES, `${label}.window`);
  const checker = ORACLE_CHECKER_MAP.get(probe.checker);
  if (!checker) {
    throw new DatasetError("case.oracle-unknown-checker", `${label}.checker 未登记：${String(probe.checker)}`);
  }
  assertPattern(probe.questionType, CASE_ID_PATTERN, `${label}.questionType`);
  if (questionTypeIds !== undefined && !questionTypeIds.has(probe.questionType)) {
    throw new DatasetError(
      "case.question-type-unknown",
      `${label}.questionType 未登记：${String(probe.questionType)}`,
    );
  }
  assertEnum(probe.polarity, PROBE_POLARITY_VALUES, `${label}.polarity`);
  if (typeof probe.critical !== "boolean") {
    throw new DatasetError("schema.invalid", `${label}.critical 必须是布尔值`);
  }
  assertIntegerInRange(
    probe.difficulty,
    PROBE_DIFFICULTY_LEVELS[0],
    PROBE_DIFFICULTY_LEVELS[PROBE_DIFFICULTY_LEVELS.length - 1],
    `${label}.difficulty`,
  );
  assertNonEmptyString(probe.description, `${label}.description`);
  if (probe.window === "last-assistant" && step.kind !== "message") {
    throw new DatasetError(
      "schema.invalid",
      `${label}.window=last-assistant 只能跟在用户消息步骤之后：${probe.after}`,
    );
  }
  if (probe.evidence !== undefined) {
    assertStringArray(probe.evidence, `${label}.evidence`, { unique: true });
    for (const evidenceId of probe.evidence) {
      if (!evidenceIds.has(evidenceId)) {
        throw new DatasetError("schema.invalid", `${label}.evidence 指向未登记证据：${evidenceId}`);
      }
    }
  }
  return checker;
}

function validateDriverStep(step, label) {
  assertRecord(step, label);
  if (step.kind === "message") {
    assertExactKeys(step, label, ["id", "kind", "text"], ["at"]);
    assertPattern(step.id, CASE_ID_PATTERN, `${label}.id`);
    assertNonEmptyString(step.text, `${label}.text`);
    if (step.at !== undefined) assertIsoTimestamp(step.at, `${label}.at`);
    return { id: step.id, kind: "message", at: step.at };
  }
  if (step.kind === "host") {
    assertExactKeys(step, label, ["id", "kind", "method"], ["args", "note", "at"]);
    assertPattern(step.id, CASE_ID_PATTERN, `${label}.id`);
    assertEnum(step.method, DRIVER_HOST_METHOD_VALUES, `${label}.method`);
    if (step.args !== undefined) assertRecord(step.args, `${label}.args`);
    assertOptionalString(step.note, `${label}.note`);
    if (step.at !== undefined) assertIsoTimestamp(step.at, `${label}.at`);
    return { id: step.id, kind: "host", at: step.at };
  }
  throw new DatasetError("schema.invalid", `${label}.kind 必须是 message / host：${String(step.kind)}`);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;
}

function omitKeys(record, keys) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

export function computeCaseBinding(caseSpec, fixture) {
  const contentHash = hashCanonical(omitKeys(caseSpec, ["revision", "governance"]));
  const fixtureHash = hashCanonical(fixture);
  const driverHash = hashCanonical({ userRole: caseSpec.userRole, driver: caseSpec.driver });
  const oracleHash = hashCanonical({
    probes: caseSpec.probes,
    oracle: caseSpec.oracle,
    checkpoints: caseSpec.checkpoints,
    pathConstraints: caseSpec.pathConstraints,
    evidence: caseSpec.evidence,
    quality: caseSpec.quality,
  });
  const specHash = hashCanonical({ contentHash, fixtureHash, driverHash, oracleHash });
  return { contentHash, fixtureHash, driverHash, oracleHash, specHash };
}

function approvalMatches(binding, approval) {
  return ["contentHash", "fixtureHash", "driverHash", "oracleHash", "specHash"]
    .every((field) => approval.binding[field] === binding[field]);
}

function describeMismatches(binding, approvedBinding) {
  return ["contentHash", "fixtureHash", "driverHash", "oracleHash", "specHash"]
    .filter((field) => approvedBinding[field] !== binding[field])
    .map((field) => ({ field, approved: approvedBinding[field], current: binding[field] }));
}

function latestApproval(approvals) {
  return [...approvals].sort((left, right) => {
    const timeDiff = Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt);
    return timeDiff !== 0 ? timeDiff : right.approvalId.localeCompare(left.approvalId);
  })[0];
}

export function resolveCaseLabel(binding, approvals) {
  const matching = approvals.filter((approval) => approvalMatches(binding, approval));
  if (matching.length > 0) {
    const latest = latestApproval(matching);
    return {
      tier: latest.decision === "approved" ? "gold" : "silver",
      status: latest.decision === "approved" ? "approved" : "rejected",
      approvalId: latest.approvalId,
      reviewedAt: latest.reviewedAt,
      mismatches: [],
    };
  }
  if (approvals.length > 0) {
    const latest = latestApproval(approvals);
    return {
      tier: "silver",
      status: "stale",
      approvalId: latest.approvalId,
      reviewedAt: latest.reviewedAt,
      mismatches: describeMismatches(binding, latest.binding),
    };
  }
  return { tier: "silver", status: "pending", approvalId: null, reviewedAt: null, mismatches: [] };
}

export function validateCaseSpec(spec, { categoryIds, questionTypeIds } = {}) {
  const label = "Case";
  assertExactKeys(spec, label, [
    "schemaVersion",
    "caseId",
    "revision",
    "familyId",
    "title",
    "categories",
    "questionTypes",
    "source",
    "precondition",
    "userRole",
    "driver",
    "probes",
    "checkpoints",
    "oracle",
    "pathConstraints",
    "evidence",
    "quality",
    "governance",
  ]);
  scanEmbeddedLabels(spec, "", label);
  if (spec.schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new DatasetError("schema.version", `${label}.schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`);
  }
  assertPattern(spec.caseId, CASE_ID_PATTERN, `${label}.caseId`);
  assertPositiveInteger(spec.revision, `${label}.revision`);
  assertPattern(spec.familyId, CASE_ID_PATTERN, `${label}.familyId`);
  assertNonEmptyString(spec.title, `${label}.title`);

  assertStringArray(spec.categories, `${label}.categories`, { unique: true });
  if (categoryIds !== undefined) {
    const known = new Set(categoryIds);
    for (const category of spec.categories) {
      if (!known.has(category)) {
        throw new DatasetError("case.category-unknown", `${label}.categories 含未登记分类：${category}`);
      }
    }
  }

  assertStringArray(spec.questionTypes, `${label}.questionTypes`, { unique: true });
  const knownQuestionTypes = questionTypeIds === undefined ? undefined : new Set(questionTypeIds);
  if (knownQuestionTypes) {
    for (const questionType of spec.questionTypes) {
      if (!knownQuestionTypes.has(questionType)) {
        throw new DatasetError(
          "case.question-type-unknown",
          `${label}.questionTypes 含未登记题型：${questionType}`,
        );
      }
    }
  }

  assertExactKeys(spec.source, `${label}.source`, ["kind", "ref", "excerpt"], ["note"]);
  if (spec.source.kind === "actual") {
    throw new DatasetError(
      "case.actual-source",
      `${label}.source.kind 不能是 actual：实际输出不是期望答案，不能作为 oracle 来源`,
    );
  }
  assertEnum(spec.source.kind, SOURCE_KIND_VALUES, `${label}.source.kind`);
  assertNonEmptyString(spec.source.ref, `${label}.source.ref`);
  assertNonEmptyString(spec.source.excerpt, `${label}.source.excerpt`);
  assertOptionalString(spec.source.note, `${label}.source.note`);

  assertExactKeys(spec.precondition, `${label}.precondition`, [
    "card",
    "profile",
    "fixtureId",
    "time",
    "hostCapabilities",
  ]);
  assertNonEmptyString(spec.precondition.card, `${label}.precondition.card`);
  assertNonEmptyString(spec.precondition.profile, `${label}.precondition.profile`);
  assertPattern(spec.precondition.fixtureId, CASE_ID_PATTERN, `${label}.precondition.fixtureId`);
  assertExactKeys(spec.precondition.time, `${label}.precondition.time`, ["mode"]);
  assertEnum(spec.precondition.time.mode, TIME_MODE_VALUES, `${label}.precondition.time.mode`);
  assertStringArray(spec.precondition.hostCapabilities, `${label}.precondition.hostCapabilities`, { unique: true });
  assertSubset(spec.precondition.hostCapabilities, HOST_CAPABILITY_VALUES, `${label}.precondition.hostCapabilities`);

  assertExactKeys(spec.userRole, `${label}.userRole`, [
    "knownFacts",
    "goal",
    "tone",
    "allowedActions",
    "mustNotReveal",
  ]);
  assertStringArray(spec.userRole.knownFacts, `${label}.userRole.knownFacts`, { unique: true });
  assertNonEmptyString(spec.userRole.goal, `${label}.userRole.goal`);
  assertNonEmptyString(spec.userRole.tone, `${label}.userRole.tone`);
  assertStringArray(spec.userRole.allowedActions, `${label}.userRole.allowedActions`, { unique: true });
  assertStringArray(spec.userRole.mustNotReveal, `${label}.userRole.mustNotReveal`, { unique: true });

  if (!Array.isArray(spec.driver) || spec.driver.length === 0) {
    throw new DatasetError("schema.invalid", `${label}.driver 必须是非空数组`);
  }
  const driverIds = new Set();
  spec.driver.forEach((step, index) => {
    const info = validateDriverStep(step, `${label}.driver[${index}]`);
    if (driverIds.has(info.id)) throw new DatasetError("schema.invalid", `${label}.driver 含重复 id：${info.id}`);
    driverIds.add(info.id);
  });
  if (spec.precondition.time.mode === "fixed") {
    let previousAt = 0;
    spec.driver.forEach((step, index) => {
      if (step.at === undefined) {
        throw new DatasetError(
          "case.clock-missing",
          `${label}.driver[${index}].at 在 fixed 模式下必填：${step.id}`,
        );
      }
      const at = Date.parse(step.at);
      if (at < previousAt) {
        throw new DatasetError("case.clock-order", `${label}.driver 必须按 at 升序：${step.id}`);
      }
      previousAt = at;
    });
  }

  if (!Array.isArray(spec.checkpoints) || spec.checkpoints.length === 0) {
    throw new DatasetError("schema.invalid", `${label}.checkpoints 必须是非空数组`);
  }
  const checkpointIds = new Set();
  const checkpointKeys = new Set();
  spec.checkpoints.forEach((checkpoint, index) => {
    assertExactKeys(checkpoint, `${label}.checkpoints[${index}]`, ["id", "after", "wait"], ["note"]);
    assertPattern(checkpoint.id, CASE_ID_PATTERN, `${label}.checkpoints[${index}].id`);
    if (checkpointIds.has(checkpoint.id)) {
      throw new DatasetError("schema.invalid", `${label}.checkpoints 含重复 id：${checkpoint.id}`);
    }
    checkpointIds.add(checkpoint.id);
    if (!driverIds.has(checkpoint.after)) {
      throw new DatasetError("schema.invalid", `${label}.checkpoints[${index}].after 未指向驱动步骤：${checkpoint.after}`);
    }
    assertEnum(checkpoint.wait, CHECKPOINT_WAIT_VALUES, `${label}.checkpoints[${index}].wait`);
    const checkpointKey = `${checkpoint.after}:${checkpoint.wait}`;
    if (checkpointKeys.has(checkpointKey)) {
      throw new DatasetError(
        "schema.invalid",
        `${label}.checkpoints 对同一驱动步骤重复声明等待事件：${checkpoint.after} / ${checkpoint.wait}`,
      );
    }
    checkpointKeys.add(checkpointKey);
    assertOptionalString(checkpoint.note, `${label}.checkpoints[${index}].note`);
  });

  assertExactKeys(spec.oracle, `${label}.oracle`, ["allowedAlternatives"]);
  assertStringArray(spec.oracle.allowedAlternatives, `${label}.oracle.allowedAlternatives`, { allowEmpty: true });

  assertExactKeys(spec.pathConstraints, `${label}.pathConstraints`, [
    "requiredOrder",
    "forbiddenSideEffects",
    "allowedToolSubstitutions",
  ]);
  assertStringArray(spec.pathConstraints.requiredOrder, `${label}.pathConstraints.requiredOrder`, { unique: true });
  let cursor = -1;
  for (const stepId of spec.pathConstraints.requiredOrder) {
    if (!driverIds.has(stepId)) {
      throw new DatasetError("schema.invalid", `${label}.pathConstraints.requiredOrder 含未知步骤：${stepId}`);
    }
    const index = spec.driver.findIndex((step) => step.id === stepId);
    if (index <= cursor) {
      throw new DatasetError("schema.invalid", `${label}.pathConstraints.requiredOrder 必须按驱动顺序排列：${stepId}`);
    }
    cursor = index;
  }
  assertStringArray(spec.pathConstraints.forbiddenSideEffects, `${label}.pathConstraints.forbiddenSideEffects`, {
    allowEmpty: true,
  });
  assertStringArray(spec.pathConstraints.allowedToolSubstitutions, `${label}.pathConstraints.allowedToolSubstitutions`, {
    allowEmpty: true,
  });

  if (!Array.isArray(spec.evidence) || spec.evidence.length === 0) {
    throw new DatasetError("schema.invalid", `${label}.evidence 必须是非空数组`);
  }
  const evidenceIds = new Set();
  spec.evidence.forEach((entry, index) => {
    assertExactKeys(entry, `${label}.evidence[${index}]`, ["id", "kind", "source", "description"]);
    assertPattern(entry.id, CASE_ID_PATTERN, `${label}.evidence[${index}].id`);
    if (evidenceIds.has(entry.id)) {
      throw new DatasetError("schema.invalid", `${label}.evidence 含重复 id：${entry.id}`);
    }
    evidenceIds.add(entry.id);
    assertEnum(entry.kind, EVIDENCE_KIND_VALUES, `${label}.evidence[${index}].kind`);
    assertNonEmptyString(entry.source, `${label}.evidence[${index}].source`);
    assertNonEmptyString(entry.description, `${label}.evidence[${index}].description`);
  });

  if (!Array.isArray(spec.probes) || spec.probes.length === 0) {
    throw new DatasetError("schema.invalid", `${label}.probes 必须是非空数组`);
  }
  const driverById = new Map(spec.driver.map((step) => [step.id, step]));
  const probeIds = new Set();
  const checkerPolarities = new Map();
  const requiredKinds = [];
  let criticalRequired = 0;
  spec.probes.forEach((probe, index) => {
    const checker = validateProbe(
      probe,
      `${label}.probes[${index}]`,
      driverById,
      evidenceIds,
      knownQuestionTypes,
    );
    if (probeIds.has(probe.id)) {
      throw new DatasetError("schema.invalid", `${label}.probes 含重复 id：${probe.id}`);
    }
    probeIds.add(probe.id);
    const polarities = checkerPolarities.get(checker.id) ?? new Set();
    polarities.add(probe.polarity);
    checkerPolarities.set(checker.id, polarities);
    if (probe.polarity === "required") {
      requiredKinds.push(checker.kind);
      if (probe.critical) criticalRequired += 1;
    }
  });
  const declaredQuestionTypes = new Set(spec.questionTypes);
  const probeQuestionTypes = new Set(spec.probes.map((probe) => probe.questionType));
  const unusedQuestionTypes = [...declaredQuestionTypes].filter((id) => !probeQuestionTypes.has(id));
  const undeclaredQuestionTypes = [...probeQuestionTypes].filter((id) => !declaredQuestionTypes.has(id));
  if (unusedQuestionTypes.length > 0 || undeclaredQuestionTypes.length > 0) {
    const details = [
      unusedQuestionTypes.length > 0 ? `未使用：${unusedQuestionTypes.join(", ")}` : null,
      undeclaredQuestionTypes.length > 0 ? `未声明：${undeclaredQuestionTypes.join(", ")}` : null,
    ].filter(Boolean);
    throw new DatasetError(
      "case.question-types-mismatch",
      `${label}.questionTypes 必须等于探针题型集合（${details.join("；")}）`,
    );
  }
  if (criticalRequired === 0) {
    throw new DatasetError(
      "case.probe-no-critical",
      `${label}.probes 至少需要一个 critical 的 required 探针`,
    );
  }
  if (!requiredKinds.some((kind) => kind !== "semantic")) {
    throw new DatasetError(
      "case.oracle-nondeterministic",
      `${label}.probes 至少需要一个非 semantic 的 required 确定性探针`,
    );
  }
  for (const [checkerId, polarities] of checkerPolarities) {
    if (polarities.size > 1) {
      throw new DatasetError(
        "case.probe-contradiction",
        `${label}.probes 对同一 checker 同时要求并禁止：${checkerId}`,
      );
    }
  }

  assertExactKeys(spec.quality, `${label}.quality`, [
    "rubric",
    "rubricVersion",
    "calibration",
    "authority",
    "assistants",
  ]);
  assertEnum(spec.quality.rubric, QUALITY_RUBRIC_VALUES, `${label}.quality.rubric`);
  assertPositiveInteger(spec.quality.rubricVersion, `${label}.quality.rubricVersion`);
  assertEnum(spec.quality.calibration, CALIBRATION_VALUES, `${label}.quality.calibration`);
  assertEnum(spec.quality.authority, REVIEW_AUTHORITY_VALUES, `${label}.quality.authority`);
  assertStringArray(spec.quality.assistants, `${label}.quality.assistants`, { allowEmpty: true, unique: true });
  assertSubset(spec.quality.assistants, REVIEW_ASSISTANT_VALUES, `${label}.quality.assistants`);
  if (spec.quality.authority !== "human" && spec.quality.assistants.length > 0) {
    throw new DatasetError(
      "case.quality-assistants",
      `${label}.quality.assistants 只在 human 权威下使用：${spec.quality.assistants.join(", ")}`,
    );
  }
  if (spec.quality.rubric === "humanizer-six-dimensions") {
    if (spec.quality.authority !== "human") {
      throw new DatasetError(
        "case.quality-authority",
        `${label}.quality.authority 必须是 human：拟人化评分只由用户本人判定`,
      );
    }
    if (!spec.quality.assistants.includes("coding-agent")) {
      throw new DatasetError(
        "case.quality-assistants",
        `${label}.quality.assistants 必须包含 coding-agent：可提供建议，但不产生 pass/fail`,
      );
    }
  }
  const humanProbes = spec.probes.filter(
    (probe) => ORACLE_CHECKER_MAP.get(probe.checker)?.authority === "human",
  );
  if (humanProbes.length > 0 && spec.quality.authority !== "human") {
    throw new DatasetError(
      "case.quality-authority",
      `${label}.quality.authority 必须是 human：用例含 human 权威探针（${humanProbes.map((probe) => probe.id).join(", ")}）`,
    );
  }

  assertExactKeys(spec.governance, `${label}.governance`, ["purpose", "unresolvedPoints", "notes"]);
  assertEnum(spec.governance.purpose, PURPOSE_VALUES, `${label}.governance.purpose`);
  assertStringArray(spec.governance.unresolvedPoints, `${label}.governance.unresolvedPoints`, { allowEmpty: true });
  assertStringArray(spec.governance.notes, `${label}.governance.notes`, { allowEmpty: true });

  return spec;
}

export function validateFixtureSpec(spec, { expectedFixtureId } = {}) {
  const label = "Fixture";
  assertExactKeys(spec, label, [
    "schemaVersion",
    "fixtureId",
    "card",
    "profile",
    "clock",
    "loading",
    "initialSession",
    "initialMemory",
    "allowedPreparation",
  ]);
  scanEmbeddedLabels(spec, "", label);
  if (spec.schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new DatasetError("schema.version", `${label}.schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`);
  }
  assertPattern(spec.fixtureId, CASE_ID_PATTERN, `${label}.fixtureId`);
  if (expectedFixtureId !== undefined && spec.fixtureId !== expectedFixtureId) {
    throw new DatasetError("fixture.id-mismatch", `${label}.fixtureId 与文件名不一致：${spec.fixtureId} != ${expectedFixtureId}`);
  }
  assertNonEmptyString(spec.card, `${label}.card`);
  assertNonEmptyString(spec.profile, `${label}.profile`);
  assertIsoTimestamp(spec.clock, `${label}.clock`);
  assertExactKeys(spec.loading, `${label}.loading`, ["mode", "note"]);
  assertEnum(spec.loading.mode, FIXTURE_LOADING_MODE_VALUES, `${label}.loading.mode`);
  assertNonEmptyString(spec.loading.note, `${label}.loading.note`);
  assertStringArray(spec.allowedPreparation, `${label}.allowedPreparation`, { unique: true });
  assertSubset(spec.allowedPreparation, FIXTURE_PREPARATION_VALUES, `${label}.allowedPreparation`);

  assertExactKeys(spec.initialSession, `${label}.initialSession`, ["id", "title", "messages"]);
  assertPattern(spec.initialSession.id, CASE_ID_PATTERN, `${label}.initialSession.id`);
  assertNonEmptyString(spec.initialSession.title, `${label}.initialSession.title`);
  if (!Array.isArray(spec.initialSession.messages) || spec.initialSession.messages.length === 0) {
    throw new DatasetError("schema.invalid", `${label}.initialSession.messages 必须是非空数组`);
  }
  const messageIds = new Set();
  const userMessageIds = new Set();
  let previousAt = 0;
  spec.initialSession.messages.forEach((message, index) => {
    assertExactKeys(message, `${label}.initialSession.messages[${index}]`, ["id", "role", "content", "at"]);
    assertPattern(message.id, CASE_ID_PATTERN, `${label}.initialSession.messages[${index}].id`);
    if (messageIds.has(message.id)) {
      throw new DatasetError("schema.invalid", `${label}.initialSession.messages 含重复 id：${message.id}`);
    }
    messageIds.add(message.id);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new DatasetError("schema.invalid", `${label}.initialSession.messages[${index}].role 必须是 user / assistant`);
    }
    if (message.role === "user") userMessageIds.add(message.id);
    assertNonEmptyString(message.content, `${label}.initialSession.messages[${index}].content`);
    assertIsoTimestamp(message.at, `${label}.initialSession.messages[${index}].at`);
    const at = Date.parse(message.at);
    if (at < previousAt) {
      throw new DatasetError("schema.invalid", `${label}.initialSession.messages 必须按时间升序排列`);
    }
    previousAt = at;
  });
  if (userMessageIds.size === 0) {
    throw new DatasetError("schema.invalid", `${label}.initialSession 至少需要一条用户消息`);
  }

  if (!Array.isArray(spec.initialMemory)) {
    throw new DatasetError("schema.invalid", `${label}.initialMemory 必须是数组`);
  }
  const memoryIds = new Set();
  spec.initialMemory.forEach((memory, index) => {
    assertExactKeys(memory, `${label}.initialMemory[${index}]`, [
      "id",
      "kind",
      "scope",
      "origin",
      "content",
      "source",
      "validFrom",
      "validUntil",
    ]);
    assertPattern(memory.id, CASE_ID_PATTERN, `${label}.initialMemory[${index}].id`);
    if (memoryIds.has(memory.id)) {
      throw new DatasetError("schema.invalid", `${label}.initialMemory 含重复 id：${memory.id}`);
    }
    memoryIds.add(memory.id);
    assertEnum(memory.kind, MEMORY_KIND_VALUES, `${label}.initialMemory[${index}].kind`);
    assertEnum(memory.scope, MEMORY_SCOPE_VALUES, `${label}.initialMemory[${index}].scope`);
    if (memory.origin !== "user") {
      throw new DatasetError(
        "fixture.origin-not-user",
        `${label}.initialMemory[${index}].origin 必须是 user：fixture 不能伪造派生行为记忆`,
      );
    }
    assertNonEmptyString(memory.content, `${label}.initialMemory[${index}].content`);
    assertExactKeys(memory.source, `${label}.initialMemory[${index}].source`, ["sessionId", "messageId"]);
    if (memory.source.sessionId !== spec.initialSession.id) {
      throw new DatasetError(
        "fixture.source-session",
        `${label}.initialMemory[${index}].source.sessionId 必须指向 initialSession：${memory.source.sessionId}`,
      );
    }
    if (!messageIds.has(memory.source.messageId)) {
      throw new DatasetError(
        "fixture.source-message",
        `${label}.initialMemory[${index}].source.messageId 不存在：${memory.source.messageId}`,
      );
    }
    if (!userMessageIds.has(memory.source.messageId)) {
      throw new DatasetError(
        "fixture.source-message",
        `${label}.initialMemory[${index}].source.messageId 必须指向用户消息`,
      );
    }
    assertIsoTimestamp(memory.validFrom, `${label}.initialMemory[${index}].validFrom`);
    if (memory.validUntil !== null) {
      assertIsoTimestamp(memory.validUntil, `${label}.initialMemory[${index}].validUntil`);
      if (Date.parse(memory.validUntil) <= Date.parse(memory.validFrom)) {
        throw new DatasetError("schema.invalid", `${label}.initialMemory[${index}].validUntil 必须晚于 validFrom`);
      }
    }
  });
  if (spec.initialMemory.length > 0 && !spec.allowedPreparation.includes("seed_memory")) {
    throw new DatasetError("fixture.preparation", `${label}.allowedPreparation 缺少 seed_memory`);
  }
  if (spec.allowedPreparation.includes("seed_memory") && spec.initialMemory.length === 0) {
    throw new DatasetError("fixture.preparation", `${label}.allowedPreparation 声明 seed_memory，但 initialMemory 为空`);
  }
  if (spec.loading.mode === "direct-seed" && !spec.allowedPreparation.includes("seed_session")) {
    throw new DatasetError(
      "fixture.loading",
      `${label}.loading.mode=direct-seed 需要 allowedPreparation 含 seed_session`,
    );
  }
  if (spec.loading.mode === "real-chain") {
    const seeded = spec.allowedPreparation.filter((item) => item === "seed_session" || item === "seed_memory");
    if (seeded.length > 0) {
      throw new DatasetError(
        "fixture.loading",
        `${label}.loading.mode=real-chain 不能同时声明 ${seeded.join(", ")}：初始状态必须由真实链路建立`,
      );
    }
  }
  return spec;
}

export function validateCaseAgainstFixture(caseSpec, fixture) {
  if (caseSpec.precondition.fixtureId !== fixture.fixtureId) {
    throw new DatasetError(
      "fixture.id-mismatch",
      `Case.precondition.fixtureId 与 fixture 不一致：${caseSpec.precondition.fixtureId} != ${fixture.fixtureId}`,
    );
  }
  if (caseSpec.precondition.card !== fixture.card) {
    throw new DatasetError("fixture.card-mismatch", `Case.precondition.card 与 fixture 不一致：${fixture.card}`);
  }
  if (caseSpec.precondition.profile !== fixture.profile) {
    throw new DatasetError("fixture.profile-mismatch", `Case.precondition.profile 与 fixture 不一致：${fixture.profile}`);
  }
  if (caseSpec.precondition.time.mode === "fixed") {
    const firstStep = caseSpec.driver[0];
    if (firstStep?.at === undefined || Date.parse(firstStep.at) < Date.parse(fixture.clock)) {
      throw new DatasetError(
        "case.clock-before-fixture",
        `Case 的固定时钟起点早于 fixture.clock：${String(firstStep?.at)} < ${fixture.clock}`,
      );
    }
  }
}

function validateReviewer(reviewer) {
  assertExactKeys(reviewer, "reviewer", ["role", "name"]);
  assertEnum(reviewer.role, REVIEW_ROLE_VALUES, "reviewer.role");
  assertNonEmptyString(reviewer.name, "reviewer.name");
}

function validateFeedbackSource(feedbackSource) {
  assertExactKeys(feedbackSource, "feedbackSource", ["kind", "sessionId", "messageId", "quote"]);
  assertEnum(feedbackSource.kind, FEEDBACK_SOURCE_VALUES, "feedbackSource.kind");
  assertNonEmptyString(feedbackSource.sessionId, "feedbackSource.sessionId");
  assertNonEmptyString(feedbackSource.messageId, "feedbackSource.messageId");
  assertNonEmptyString(feedbackSource.quote, "feedbackSource.quote");
}

export function validateApprovalRecord(spec, { expectedApprovalId, expectedCaseId, expectedSuiteId } = {}) {
  const label = "Approval";
  assertExactKeys(spec, label, [
    "schemaVersion",
    "approvalId",
    "caseId",
    "suiteId",
    "revision",
    "decision",
    "reviewer",
    "reviewedAt",
    "feedbackSource",
    "binding",
    "notes",
  ], ["supersedes"]);
  if (spec.schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new DatasetError("schema.version", `${label}.schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`);
  }
  assertPattern(spec.approvalId, APPROVAL_ID_PATTERN, `${label}.approvalId`);
  if (expectedApprovalId !== undefined && spec.approvalId !== expectedApprovalId) {
    throw new DatasetError("approval.id-mismatch", `${label}.approvalId 与文件名不一致：${spec.approvalId} != ${expectedApprovalId}`);
  }
  assertPattern(spec.caseId, CASE_ID_PATTERN, `${label}.caseId`);
  if (expectedCaseId !== undefined && spec.caseId !== expectedCaseId) {
    throw new DatasetError("approval.case-mismatch", `${label}.caseId 与目标用例不一致：${spec.caseId} != ${expectedCaseId}`);
  }
  assertPattern(spec.suiteId, CASE_ID_PATTERN, `${label}.suiteId`);
  if (expectedSuiteId !== undefined && spec.suiteId !== expectedSuiteId) {
    throw new DatasetError("approval.suite-mismatch", `${label}.suiteId 与套件不一致：${spec.suiteId}`);
  }
  assertPositiveInteger(spec.revision, `${label}.revision`);
  assertEnum(spec.decision, DECISION_VALUES, `${label}.decision`);
  validateReviewer(spec.reviewer);
  assertIsoTimestamp(spec.reviewedAt, `${label}.reviewedAt`);
  validateFeedbackSource(spec.feedbackSource);
  assertExactKeys(spec.binding, `${label}.binding`, [
    "contentHash",
    "fixtureHash",
    "driverHash",
    "oracleHash",
    "specHash",
  ]);
  for (const field of ["contentHash", "fixtureHash", "driverHash", "oracleHash", "specHash"]) {
    if (typeof spec.binding[field] !== "string" || !HASH_PATTERN.test(spec.binding[field])) {
      throw new DatasetError("approval.hash-invalid", `${label}.binding.${field} 不是 sha256:<hex>`);
    }
  }
  const expectedSpecHash = hashCanonical({
    contentHash: spec.binding.contentHash,
    fixtureHash: spec.binding.fixtureHash,
    driverHash: spec.binding.driverHash,
    oracleHash: spec.binding.oracleHash,
  });
  if (spec.binding.specHash !== expectedSpecHash) {
    throw new DatasetError("approval.hash-mismatch", `${label}.binding.specHash 与四个分量哈希不一致`);
  }
  if (typeof spec.notes !== "string") {
    throw new DatasetError("schema.invalid", `${label}.notes 必须是字符串`);
  }
  if (spec.decision === "rejected" && spec.notes.trim() === "") {
    throw new DatasetError("approval.rejection-reason", `${label} 拒绝时必须写明原因（notes）`);
  }
  if (spec.supersedes !== undefined) {
    assertPattern(spec.supersedes, APPROVAL_ID_PATTERN, `${label}.supersedes`);
  }
  return spec;
}

function compactTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/\D/g, "").slice(0, 14);
}

function createApprovalRecord({ entry, decision, reviewer, feedbackSource, reviewedAt, notes = "" }) {
  const time = compactTimestamp(reviewedAt);
  const shortHash = entry.binding.specHash.slice(7, 15);
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    approvalId: `approval-${entry.caseId}-${time}-${shortHash}`,
    caseId: entry.caseId,
    suiteId: entry.suiteId,
    revision: entry.case.revision,
    decision,
    reviewer: clone(reviewer),
    reviewedAt,
    feedbackSource: clone(feedbackSource),
    binding: clone(entry.binding),
    notes,
  };
}

export function applyReviewDecisions({ entries, decisions, reviewer, feedbackSource, reviewedAt }) {
  const errors = [];
  const reject = (error) => {
    errors.push(issue(error.code ?? "approval.invalid", error.message));
  };

  if (!Array.isArray(entries)) {
    reject(new DatasetError("schema.invalid", "entries 必须是数组"));
  }
  if (!Array.isArray(decisions)) {
    reject(new DatasetError("schema.invalid", "decisions 必须是数组"));
  }
  try {
    validateReviewer(reviewer);
  } catch (error) {
    reject(error);
  }
  try {
    validateFeedbackSource(feedbackSource);
  } catch (error) {
    reject(error);
  }
  try {
    assertIsoTimestamp(reviewedAt, "reviewedAt");
  } catch (error) {
    reject(error);
  }

  const entryByCase = new Map();
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      if (!isRecord(entry?.case) || typeof entry.case.caseId !== "string" || !isRecord(entry.binding)) {
        reject(new DatasetError("schema.invalid", `entries[${index}] 缺少 case / binding`));
        return;
      }
      if (entryByCase.has(entry.case.caseId)) {
        reject(new DatasetError("approval.duplicate-entry", `entries 含重复用例：${entry.case.caseId}`));
        return;
      }
      entryByCase.set(entry.case.caseId, entry);
    });
  }

  const seenDecisions = new Set();
  const prepared = [];
  if (Array.isArray(decisions)) {
    decisions.forEach((decision, index) => {
      try {
        assertExactKeys(decision, `decisions[${index}]`, ["caseId", "decision"], ["notes"]);
        assertPattern(decision.caseId, CASE_ID_PATTERN, `decisions[${index}].caseId`);
        assertEnum(decision.decision, DECISION_VALUES, `decisions[${index}].decision`);
        if (decision.notes !== undefined && typeof decision.notes !== "string") {
          throw new DatasetError("schema.invalid", `decisions[${index}].notes 必须是字符串`);
        }
        if (decision.decision === "rejected" && !(decision.notes ?? "").trim()) {
          throw new DatasetError("approval.rejection-reason", `decisions[${index}] 拒绝时必须写明原因`);
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (seenDecisions.has(decision.caseId)) {
        reject(new DatasetError("approval.duplicate-decision", `decisions 含重复用例：${decision.caseId}`));
        return;
      }
      seenDecisions.add(decision.caseId);
      const entry = entryByCase.get(decision.caseId);
      if (!entry) {
        reject(new DatasetError("approval.unknown-case", `decisions 指向未知用例：${decision.caseId}`));
        return;
      }
      prepared.push({ entry, decision });
    });
  }

  if (errors.length > 0) return { records: [], errors };
  const records = prepared.map(({ entry, decision }) =>
    createApprovalRecord({
      entry,
      decision: decision.decision,
      reviewer,
      feedbackSource,
      reviewedAt,
      notes: decision.notes ?? "",
    }),
  );
  return { records, errors: [] };
}

export function buildDriverPackage(entry) {
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    caseId: entry.caseId,
    revision: entry.case.revision,
    specHash: entry.binding.specHash,
    userRole: clone(entry.case.userRole),
    driver: clone(entry.case.driver),
  };
}

export function buildReviewPackage(entry, approvals = entry.approvals ?? []) {
  const binding = entry.binding;
  const label = resolveCaseLabel(binding, approvals);
  const approvalHistory = [...approvals]
    .map((approval) => ({
      approvalId: approval.approvalId,
      decision: approval.decision,
      reviewedAt: approval.reviewedAt,
      reviewer: clone(approval.reviewer),
      feedbackSource: clone(approval.feedbackSource),
      notes: approval.notes,
      supersedes: approval.supersedes ?? null,
      matching: approvalMatches(binding, approval),
      mismatches: describeMismatches(binding, approval.binding),
    }))
    .sort((left, right) => Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt));
  const { difficultyCounts } = tallyProbeAxes(entry.case.probes);

  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    suiteId: entry.suiteId,
    caseId: entry.caseId,
    revision: entry.case.revision,
    title: entry.case.title,
    purpose: entry.case.governance.purpose,
    label,
    binding: clone(binding),
    questionTypes: clone(entry.case.questionTypes),
    difficultyCounts: Object.fromEntries(
      PROBE_DIFFICULTY_LEVELS.map((level) => [String(level), difficultyCounts.get(level) ?? 0]),
    ),
    trustBoundary: {
      driverPackageFields: ["schemaVersion", "caseId", "revision", "specHash", "userRole", "driver"],
      excludedFromDriver: [
        "questionTypes",
        "probes",
        "checkpoints",
        "oracle",
        "pathConstraints",
        "evidence",
        "quality",
        "governance",
        "source",
        "approvalHistory",
      ],
      probeWindowScope: "driver-only",
      note: "探针窗口只统计 driver 产生的助手回复，不含 fixture 预置消息；审批回执必须来自用户的真实会话消息，本工具只校验结构与哈希，不证明审批人身份。",
    },
    candidate: clone(entry.case),
    fixture: {
      fixtureId: entry.fixture.fixtureId,
      hash: binding.fixtureHash,
      loading: clone(entry.fixture.loading),
      content: clone(entry.fixture),
    },
    approvalHistory,
    unresolvedPoints: clone(entry.case.governance.unresolvedPoints),
  };
}

const TIER_LABELS = {
  gold: "gold（用户已按当前版本批准）",
  silver: "silver（未获批或审批已过期）",
};

const STATUS_LABELS = {
  approved: "approved（最近一次匹配审批为批准）",
  rejected: "rejected（最近一次匹配审批为拒绝）",
  stale: "stale（审批绑定的是旧版本）",
  pending: "pending（尚无审批）",
};

function tallyProbeAxes(probes) {
  const questionTypeCounts = new Map();
  const authorityCounts = new Map();
  const difficultyCounts = new Map(PROBE_DIFFICULTY_LEVELS.map((level) => [level, 0]));
  for (const probe of probes) {
    questionTypeCounts.set(probe.questionType, (questionTypeCounts.get(probe.questionType) ?? 0) + 1);
    const authority = ORACLE_CHECKER_MAP.get(probe.checker)?.authority ?? "unknown";
    authorityCounts.set(authority, (authorityCounts.get(authority) ?? 0) + 1);
    difficultyCounts.set(probe.difficulty, (difficultyCounts.get(probe.difficulty) ?? 0) + 1);
  }
  return { questionTypeCounts, authorityCounts, difficultyCounts };
}

function formatProbe(probe) {
  const checker = ORACLE_CHECKER_MAP.get(probe.checker);
  const critical = probe.critical ? "critical" : "non-critical";
  const evidence = probe.evidence?.length ? `；证据：${probe.evidence.join("、")}` : "";
  const description = probe.description.replace(/[。；;]\s*$/, "");
  const assistants = checker?.assistants?.length ? `；建议 ${checker.assistants.join("、")}` : "";
  return `- ${probe.id}（${critical} · ${probe.polarity} · ${probe.window} @ ${probe.after} · 题型 ${probe.questionType} · 难度 L${probe.difficulty}）${probe.checker} [${checker?.kind ?? "unknown"} · ${checker?.authority ?? "unknown"}${assistants}]：${description}${evidence}`;
}

export function formatReviewPackage(review) {
  const lines = [];
  lines.push(`# 候选审阅：${review.title}（${review.caseId}）`);
  lines.push("");
  lines.push(`- 套件：${review.suiteId}`);
  lines.push(`- 修订：r${review.revision}`);
  lines.push(`- 用途：${review.purpose}`);
  lines.push(`- 当前标签：${TIER_LABELS[review.label.tier]} · ${STATUS_LABELS[review.label.status]}`);
  lines.push(`- specHash：${review.binding.specHash}`);
  lines.push("");
  lines.push("## 场景与来源");
  lines.push("");
  lines.push(`- 类型：${review.candidate.source.kind}`);
  lines.push(`- 来源：${review.candidate.source.ref}`);
  lines.push(`- 原文：${review.candidate.source.excerpt}`);
  if (review.candidate.source.note) lines.push(`- 说明：${review.candidate.source.note}`);
  lines.push("");
  lines.push("## 前置");
  lines.push("");
  lines.push(`- Card：${review.candidate.precondition.card}`);
  lines.push(`- Profile：${review.candidate.precondition.profile}`);
  lines.push(`- Fixture：${review.fixture.fixtureId}（${review.fixture.hash}）`);
  lines.push(`- Fixture 装载：${review.fixture.loading.mode}（${review.fixture.loading.note}）`);
  lines.push(`- 时间模式：${review.candidate.precondition.time.mode}`);
  lines.push(`- 宿主能力：${review.candidate.precondition.hostCapabilities.join("、")}`);
  lines.push("");
  const { questionTypeCounts, authorityCounts, difficultyCounts } = tallyProbeAxes(review.candidate.probes);
  lines.push("## 题型与评审权威");
  lines.push("");
  lines.push(`- 用例题型（${review.candidate.questionTypes.length}）：${review.candidate.questionTypes.join("、")}`);
  lines.push(
    `- 探针分布：${review.candidate.questionTypes
      .map((id) => `${id} ${questionTypeCounts.get(id) ?? 0}`)
      .join(" · ")}`,
  );
  lines.push(
    `- 难度分布：${PROBE_DIFFICULTY_LEVELS.map(
      (level) => `L${level} ${difficultyCounts.get(level) ?? 0}`,
    ).join(" · ")}`,
  );
  lines.push(
    `- 评审权威：${REVIEW_AUTHORITY_VALUES.map(
      (authority) => `${authority} ${authorityCounts.get(authority) ?? 0}`,
    ).join(" · ")}`,
  );
  if ((authorityCounts.get("human") ?? 0) > 0) {
    lines.push(
      "- human 权威只由用户本人判定；coding agent 只能提供建议，不产生 pass/fail 或 gold。自动化运行遇到 human 探针应停在 pending。",
    );
  }
  lines.push("");
  lines.push("## 用户角色");
  lines.push("");
  lines.push(`- 目标：${review.candidate.userRole.goal}`);
  lines.push(`- 语气：${review.candidate.userRole.tone}`);
  lines.push("- 已知事实：");
  for (const fact of review.candidate.userRole.knownFacts) lines.push(`  - ${fact}`);
  lines.push("");
  lines.push("## 驱动步骤");
  lines.push("");
  for (const step of review.candidate.driver) {
    const at = step.at ? ` [${step.at}]` : "";
    if (step.kind === "message") {
      lines.push(`- ${step.id}${at}：发送消息「${step.text}」`);
    } else {
      const note = step.note ? `（${step.note}）` : "";
      lines.push(`- ${step.id}${at}：宿主命令 ${step.method}${note}`);
    }
  }
  lines.push("");
  lines.push("## 检查点");
  lines.push("");
  for (const checkpoint of review.candidate.checkpoints) {
    const note = checkpoint.note ? `（${checkpoint.note}）` : "";
    lines.push(`- ${checkpoint.id}：${checkpoint.after} 之后等待 ${checkpoint.wait}${note}`);
  }
  lines.push("");
  lines.push("## 探针");
  lines.push("");
  const criticalProbes = review.candidate.probes.filter((probe) => probe.critical).length;
  lines.push(`共 ${review.candidate.probes.length} 条，其中关键 ${criticalProbes} 条。`);
  for (const probe of review.candidate.probes) {
    lines.push(formatProbe(probe));
  }
  if (review.candidate.oracle.allowedAlternatives.length > 0) {
    lines.push("");
    lines.push("### Oracle 允许的替代表达");
    for (const alternative of review.candidate.oracle.allowedAlternatives) lines.push(`- ${alternative}`);
  }
  lines.push("");
  lines.push("## 路径约束");
  lines.push("");
  lines.push(`- 必需顺序：${review.candidate.pathConstraints.requiredOrder.join(" → ")}`);
  for (const effect of review.candidate.pathConstraints.forbiddenSideEffects) lines.push(`- 禁止副作用：${effect}`);
  for (const substitution of review.candidate.pathConstraints.allowedToolSubstitutions) {
    lines.push(`- 允许替代：${substitution}`);
  }
  lines.push("");
  lines.push("## 证据");
  lines.push("");
  for (const evidence of review.candidate.evidence) {
    lines.push(`- ${evidence.id} [${evidence.kind}]：${evidence.description}（${evidence.source}）`);
  }
  lines.push("");
  lines.push("## 质量评分");
  lines.push("");
  lines.push(
    `- ${review.candidate.quality.rubric} v${review.candidate.quality.rubricVersion}，校准状态：${review.candidate.quality.calibration}`,
  );
  const qualityAssistants = review.candidate.quality.assistants.length > 0
    ? `（assistants：${review.candidate.quality.assistants.join("、")}；仅建议，不产生 pass/fail）`
    : "";
  lines.push(`- 评审权威：${review.candidate.quality.authority}${qualityAssistants}`);
  lines.push("");
  lines.push("## 未解决点");
  lines.push("");
  if (review.unresolvedPoints.length === 0) lines.push("- 无");
  for (const point of review.unresolvedPoints) lines.push(`- ${point}`);
  lines.push("");
  lines.push("## 信任边界");
  lines.push("");
  lines.push(`- 驱动包字段：${review.trustBoundary.driverPackageFields.join("、")}`);
  lines.push(`- 驱动包不包含：${review.trustBoundary.excludedFromDriver.join("、")}`);
  lines.push(`- ${review.trustBoundary.note}`);
  lines.push("");
  lines.push("## 审批历史");
  lines.push("");
  if (review.approvalHistory.length === 0) {
    lines.push("- 无审批记录，当前只能是 silver。");
  } else {
    for (const approval of review.approvalHistory) {
      const matchLabel = approval.matching ? "绑定当前版本" : "绑定旧版本";
      lines.push(
        `- ${approval.approvalId}：${approval.decision} · ${approval.reviewedAt} · ${matchLabel}`,
      );
      lines.push(`  - 审批人：${approval.reviewer.name}（${approval.reviewer.role}）`);
      lines.push(
        `  - 反馈来源：${approval.feedbackSource.sessionId}/${approval.feedbackSource.messageId}「${approval.feedbackSource.quote}」`,
      );
      if (approval.notes) lines.push(`  - 备注：${approval.notes}`);
      for (const mismatch of approval.mismatches) {
        lines.push(`  - ${mismatch.field}：批准 ${mismatch.approved} / 当前 ${mismatch.current}`);
      }
    }
  }
  return lines.join("\n");
}

export function summarizeDataset(dataset) {
  const caseList = Array.isArray(dataset.cases) ? dataset.cases : [];
  const suiteList = Array.isArray(dataset.suites) ? dataset.suites : [];
  const categoryIds = Array.isArray(dataset.categories) ? dataset.categories.map((category) => category.id) : [];
  const categoryCounts = Object.fromEntries(categoryIds.map((id) => [id, 0]));
  const questionTypeIds = Array.isArray(dataset.questionTypes)
    ? dataset.questionTypes.map((questionType) => questionType.id)
    : [];
  const questionTypeCounts = Object.fromEntries(questionTypeIds.map((id) => [id, 0]));
  const caseQuestionTypeCounts = Object.fromEntries(questionTypeIds.map((id) => [id, 0]));
  const authorityCounts = Object.fromEntries(REVIEW_AUTHORITY_VALUES.map((authority) => [authority, 0]));
  const difficultyCounts = Object.fromEntries(PROBE_DIFFICULTY_LEVELS.map((level) => [String(level), 0]));
  const statusCounts = { approved: 0, rejected: 0, stale: 0, pending: 0 };
  const suiteCounts = new Map(
    suiteList.map((suite) => [
      suite.suiteId,
      {
        suiteId: suite.suiteId,
        purpose: suite.purpose,
        caseCount: 0,
        goldCount: 0,
        silverCount: 0,
        probeCount: 0,
        criticalProbeCount: 0,
      },
    ]),
  );

  let goldCount = 0;
  let silverCount = 0;
  let probeCount = 0;
  let criticalProbeCount = 0;
  for (const entry of caseList) {
    if (entry.label.tier === "gold") goldCount += 1;
    else silverCount += 1;
    statusCounts[entry.label.status] += 1;
    for (const category of new Set(entry.case.categories)) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
    for (const questionType of new Set(entry.case.questionTypes ?? [])) {
      caseQuestionTypeCounts[questionType] = (caseQuestionTypeCounts[questionType] ?? 0) + 1;
    }
    const probes = Array.isArray(entry.case.probes) ? entry.case.probes : [];
    const criticalProbes = probes.filter((probe) => probe.critical).length;
    for (const probe of probes) {
      questionTypeCounts[probe.questionType] = (questionTypeCounts[probe.questionType] ?? 0) + 1;
      const authority = ORACLE_CHECKER_MAP.get(probe.checker)?.authority;
      if (authority) authorityCounts[authority] = (authorityCounts[authority] ?? 0) + 1;
      difficultyCounts[String(probe.difficulty)] = (difficultyCounts[String(probe.difficulty)] ?? 0) + 1;
    }
    probeCount += probes.length;
    criticalProbeCount += criticalProbes;
    const suiteCount = suiteCounts.get(entry.suiteId);
    if (suiteCount) {
      suiteCount.caseCount += 1;
      if (entry.label.tier === "gold") suiteCount.goldCount += 1;
      else suiteCount.silverCount += 1;
      suiteCount.probeCount += probes.length;
      suiteCount.criticalProbeCount += criticalProbes;
    }
  }

  return {
    suiteCount: suiteList.length,
    caseCount: caseList.length,
    goldCount,
    silverCount,
    probeCount,
    criticalProbeCount,
    statusCounts,
    categoryCounts,
    questionTypeCounts,
    caseQuestionTypeCounts,
    authorityCounts,
    difficultyCounts,
    suites: [...suiteCounts.values()],
  };
}

function findFiles(directory, predicate, acc = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) findFiles(fullPath, predicate, acc);
    else if (predicate(entry.name)) acc.push(fullPath);
  }
  return acc;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new DatasetError("dataset.invalid-json", `无法解析 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function displayPath(repoRoot, filePath) {
  return relative(repoRoot, filePath);
}

function validateSuiteSpec(spec) {
  const label = "Suite";
  assertExactKeys(spec, label, ["schemaVersion", "suiteId", "revision", "purpose", "title", "caseIds"]);
  if (spec.schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new DatasetError("schema.version", `${label}.schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`);
  }
  assertPattern(spec.suiteId, CASE_ID_PATTERN, `${label}.suiteId`);
  assertPositiveInteger(spec.revision, `${label}.revision`);
  assertEnum(spec.purpose, PURPOSE_VALUES, `${label}.purpose`);
  assertNonEmptyString(spec.title, `${label}.title`);
  assertStringArray(spec.caseIds, `${label}.caseIds`, { unique: true });
  for (const caseId of spec.caseIds) assertPattern(caseId, CASE_ID_PATTERN, `${label}.caseIds[]`);
  return spec;
}

export function loadDataset(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, "../../.."));
  const root = resolve(repoRoot, options.root ?? DEFAULT_DATASET_ROOT);
  const errors = [];
  const warnings = [];
  const suites = [];
  const cases = [];
  const approvals = [];
  const approvalsById = new Map();
  const fixtureCache = new Map();
  const declaredCaseIds = new Map();

  let categories = [];
  let categoriesPath = null;
  try {
    if (options.categories !== undefined) {
      categories = normalizeCategories(options.categories);
    } else {
      categoriesPath = resolve(repoRoot, options.categoriesPath ?? DEFAULT_CATEGORIES_PATH);
      const raw = readJson(categoriesPath);
      if (!isRecord(raw) || !Array.isArray(raw.categories)) {
        throw new DatasetError("dataset.categories-invalid", "分类清单必须包含 categories 数组");
      }
      categories = normalizeCategories(raw.categories);
    }
  } catch (error) {
    const errorPath = categoriesPath ?? repoRoot;
    errors.push(
      issue(
        error.code ?? "dataset.categories-invalid",
        `分类清单不可用：${error instanceof Error ? error.message : String(error)}`,
        { file: displayPath(repoRoot, errorPath) },
      ),
    );
  }
  const categoryIds = categories.length > 0 ? categories.map((category) => category.id) : undefined;

  let questionTypeFamilies = [];
  let questionTypes = [];
  let questionTypesPath = null;
  try {
    if (options.questionTypes !== undefined) {
      ({ families: questionTypeFamilies, questionTypes } = normalizeQuestionTypes(options.questionTypes, categoryIds));
    } else {
      questionTypesPath = resolve(repoRoot, options.questionTypesPath ?? DEFAULT_QUESTION_TYPES_PATH);
      const raw = readJson(questionTypesPath);
      ({ families: questionTypeFamilies, questionTypes } = normalizeQuestionTypes(raw, categoryIds));
    }
  } catch (error) {
    const errorPath = questionTypesPath ?? repoRoot;
    errors.push(
      issue(
        error.code ?? "dataset.question-types-invalid",
        `题型注册表不可用：${error instanceof Error ? error.message : String(error)}`,
        { file: displayPath(repoRoot, errorPath) },
      ),
    );
  }
  const questionTypeIds =
    questionTypes.length > 0 ? questionTypes.map((questionType) => questionType.id) : undefined;

  if (!existsSync(root)) {
    errors.push(issue("dataset.root-missing", `数据集目录不存在：${displayPath(repoRoot, root)}`, {
      file: displayPath(repoRoot, root),
    }));
    return {
      schemaVersion: DATASET_SCHEMA_VERSION,
      repoRoot,
      root,
      categoriesPath: categoriesPath ? displayPath(repoRoot, categoriesPath) : null,
      categories,
      questionTypesPath: questionTypesPath ? displayPath(repoRoot, questionTypesPath) : null,
      questionTypeFamilies,
      questionTypes,
      suites,
      cases,
      approvals,
      errors,
      warnings,
    };
  }

  const suiteFiles = findFiles(root, (name) => name === "suite.json").sort();
  if (suiteFiles.length === 0) {
    errors.push(issue("dataset.no-suites", `数据集目录下没有 suite.json：${displayPath(repoRoot, root)}`));
  }

  for (const suitePath of suiteFiles) {
    const suiteDir = dirname(suitePath);
    const displaySuitePath = displayPath(repoRoot, suitePath);
    let suiteSpec;
    try {
      suiteSpec = validateSuiteSpec(readJson(suitePath));
    } catch (error) {
      errors.push(
        issue(error.code ?? "suite.invalid", error.message, { file: displaySuitePath, suiteId: undefined }),
      );
      continue;
    }
    if (suites.some((suite) => suite.suiteId === suiteSpec.suiteId)) {
      errors.push(
        issue("dataset.duplicate-suite", `套件 id 重复：${suiteSpec.suiteId}`, {
          file: displaySuitePath,
          suiteId: suiteSpec.suiteId,
        }),
      );
      continue;
    }

    const suite = { ...suiteSpec, path: displaySuitePath };
    suites.push(suite);

    const duplicateCaseIds = new Set();
    for (const caseId of suiteSpec.caseIds) {
      if (declaredCaseIds.has(caseId)) {
        duplicateCaseIds.add(caseId);
        errors.push(
          issue(
            "dataset.duplicate-case-id",
            `用例 id 跨套件重复：${caseId}（已属于 ${declaredCaseIds.get(caseId)}）`,
            { file: displaySuitePath, suiteId: suiteSpec.suiteId, caseId },
          ),
        );
      } else {
        declaredCaseIds.set(caseId, suiteSpec.suiteId);
      }
    }

    const casesDir = join(suiteDir, "cases");
    const caseFileById = new Map();
    if (!existsSync(casesDir)) {
      errors.push(
        issue("dataset.missing-cases-dir", `套件缺少 cases 目录：${displayPath(repoRoot, casesDir)}`, {
          file: displaySuitePath,
          suiteId: suiteSpec.suiteId,
        }),
      );
    } else {
      for (const name of readdirSync(casesDir).sort()) {
        if (!name.endsWith(CASE_FILE_SUFFIX)) continue;
        const caseId = name.slice(0, -CASE_FILE_SUFFIX.length);
        if (!suiteSpec.caseIds.includes(caseId)) {
          errors.push(
            issue("dataset.orphan-case", `未被 suite.json 引用的用例文件：${name}`, {
              file: displayPath(repoRoot, join(casesDir, name)),
              suiteId: suiteSpec.suiteId,
              caseId,
            }),
          );
          continue;
        }
        caseFileById.set(caseId, join(casesDir, name));
      }
    }

    const suiteEntries = [];
    for (const caseId of suiteSpec.caseIds) {
      if (duplicateCaseIds.has(caseId)) continue;
      const casePath = caseFileById.get(caseId);
      if (!casePath) {
        errors.push(
          issue("dataset.missing-case", `suite.json 声明的用例文件不存在：${caseId}`, {
            file: displaySuitePath,
            suiteId: suiteSpec.suiteId,
            caseId,
          }),
        );
        continue;
      }
      try {
        const caseSpec = validateCaseSpec(readJson(casePath), { categoryIds, questionTypeIds });
        if (caseSpec.caseId !== caseId) {
          throw new DatasetError(
            "case.id-mismatch",
            `Case.caseId 与文件名不一致：${caseSpec.caseId} != ${caseId}`,
          );
        }
        if (caseSpec.governance.purpose !== suiteSpec.purpose) {
          throw new DatasetError(
            "suite.purpose-mismatch",
            `Case.governance.purpose（${caseSpec.governance.purpose}）必须与套件 purpose（${suiteSpec.purpose}）一致`,
          );
        }

        const fixturePath = join(suiteDir, "fixtures", `${caseSpec.precondition.fixtureId}.json`);
        let fixture;
        if (fixtureCache.has(fixturePath)) {
          const cached = fixtureCache.get(fixturePath);
          if (cached.error) continue;
          fixture = cached.fixture;
        } else {
          try {
            if (!existsSync(fixturePath)) {
              throw new DatasetError(
                "fixture.missing",
                `fixture 文件不存在：${displayPath(repoRoot, fixturePath)}`,
              );
            }
            fixture = validateFixtureSpec(readJson(fixturePath), {
              expectedFixtureId: caseSpec.precondition.fixtureId,
            });
            fixtureCache.set(fixturePath, { fixture });
          } catch (error) {
            fixtureCache.set(fixturePath, { error });
            throw error;
          }
        }
        validateCaseAgainstFixture(caseSpec, fixture);

        const binding = computeCaseBinding(caseSpec, fixture);
        const entry = {
          caseId: caseSpec.caseId,
          suiteId: suiteSpec.suiteId,
          casePath: displayPath(repoRoot, casePath),
          fixturePath: displayPath(repoRoot, fixturePath),
          case: caseSpec,
          fixture,
          binding,
          approvals: [],
          label: resolveCaseLabel(binding, []),
        };
        cases.push(entry);
        suiteEntries.push(entry);
      } catch (error) {
        errors.push(
          issue(error.code ?? "case.invalid", error.message, {
            file: displayPath(repoRoot, casePath),
            suiteId: suiteSpec.suiteId,
            caseId,
          }),
        );
      }
    }

    const approvalsDir = join(suiteDir, "approvals");
    const suiteApprovals = [];
    if (existsSync(approvalsDir)) {
      for (const name of readdirSync(approvalsDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const approvalPath = join(approvalsDir, name);
        const approvalId = name.slice(0, -".json".length);
        try {
          const record = validateApprovalRecord(readJson(approvalPath), {
            expectedApprovalId: approvalId,
            expectedSuiteId: suiteSpec.suiteId,
          });
          if (approvalsById.has(record.approvalId)) {
            throw new DatasetError(
              "approval.duplicate-id",
              `审批 id 重复：${record.approvalId}（已存在于 ${approvalsById.get(record.approvalId).suiteId}）`,
            );
          }
          if (!suiteSpec.caseIds.includes(record.caseId)) {
            throw new DatasetError("approval.unknown-case", `审批指向本套件未声明的用例：${record.caseId}`);
          }
          const target = suiteEntries.find((entry) => entry.caseId === record.caseId);
          if (!target) {
            throw new DatasetError("approval.unknown-case", `审批目标用例未能载入：${record.caseId}`);
          }
          const entryRecord = { ...record, suiteId: suiteSpec.suiteId, path: displayPath(repoRoot, approvalPath) };
          approvalsById.set(record.approvalId, entryRecord);
          approvals.push(entryRecord);
          suiteApprovals.push(entryRecord);
          target.approvals.push(record);
        } catch (error) {
          errors.push(
            issue(error.code ?? "approval.invalid", error.message, {
              file: displayPath(repoRoot, approvalPath),
              suiteId: suiteSpec.suiteId,
            }),
          );
        }
      }
    }

    for (const record of suiteApprovals) {
      if (record.supersedes === undefined) continue;
      const superseded = approvalsById.get(record.supersedes);
      if (!superseded || superseded.suiteId !== suiteSpec.suiteId || superseded.caseId !== record.caseId) {
        errors.push(
          issue("approval.unknown-supersedes", `审批 ${record.approvalId} 的 supersedes 未指向本用例的既有审批`, {
            file: record.path,
            suiteId: suiteSpec.suiteId,
            caseId: record.caseId,
          }),
        );
      }
    }
  }

  for (const entry of cases) {
    entry.label = resolveCaseLabel(entry.binding, entry.approvals);
    for (const approval of entry.approvals) {
      if (approvalMatches(entry.binding, approval)) continue;
      const fields = describeMismatches(entry.binding, approval.binding).map((mismatch) => mismatch.field);
      warnings.push(
        issue(
          "approval.stale",
          `审批 ${approval.approvalId} 绑定的是旧版本（${fields.join(", ")}）`,
          { suiteId: entry.suiteId, caseId: entry.caseId, file: approval.path },
        ),
      );
    }
  }

  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    repoRoot,
    root,
    categoriesPath: categoriesPath ? displayPath(repoRoot, categoriesPath) : null,
    categories,
    questionTypesPath: questionTypesPath ? displayPath(repoRoot, questionTypesPath) : null,
    questionTypeFamilies,
    questionTypes,
    suites,
    cases,
    approvals,
    errors,
    warnings,
  };
}
