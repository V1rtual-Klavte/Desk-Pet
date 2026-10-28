import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * 结构化聊天评测数据集：候选内容、fixture、驱动、探针与用户审批的绑定关系。
 *
 * gold 只能由用户针对当前 specHash 的审批记录产生；writeApprovalRecords 只校验结构与哈希并写盘，
 * 不证明审批人身份，也不代替用户判断内容质量。
 * 驱动包只含 userRole + driver；探针、检查点、证据与评分不能进入驱动包。
 */

export const DATASET_SCHEMA_VERSION = 4;
export const QUESTION_TYPES_SCHEMA_VERSION = 1;
export const DEFAULT_DATASET_ROOT = "test/ideal-traces";
export const DEFAULT_CATEGORIES_PATH = "test/sim/desk-pet-chat/categories.json";
export const DEFAULT_QUESTION_TYPES_PATH = "test/sim/desk-pet-chat/question-types.json";

export const PURPOSE_VALUES = Object.freeze(["development", "calibration", "holdout", "regression"]);
export const SOURCE_KIND_VALUES = Object.freeze(["ideal", "confirmed-issue", "requirement", "external"]);
export const HOST_CAPABILITY_VALUES = Object.freeze(["chat", "memory", "session", "tools"]);
export const TIME_MODE_VALUES = Object.freeze(["real", "fixed"]);
export const MEMORY_KIND_VALUES = Object.freeze(["fact", "preference", "episode", "working"]);
export const MEMORY_SCOPE_VALUES = Object.freeze(["user", "card", "session"]);
export const FIXTURE_PREPARATION_VALUES = Object.freeze(["seed_session", "seed_memory", "seed_card", "seed_profile"]);
export const FIXTURE_LOADING_MODE_VALUES = Object.freeze(["direct-seed", "real-chain"]);
export const EXTERNAL_ASSET_MAX_BYTES = 128 * 1024 * 1024;
export const PROBE_DIFFICULTY_LEVELS = Object.freeze([1, 2, 3, 4, 5]);
/** 评测驱动直接调用组件入口的手工触发，不代表自然受理、调度或实际 UI 显示。 */
export const MANUAL_TRIGGER_HOST_METHODS = Object.freeze(["sim_proactive_tick", "sim_task_deliver"]);
export const DRIVER_HOST_METHOD_VALUES = Object.freeze([
  "chat_new_session",
  "chat_switch_session",
  "chat_stop",
  "chat_slash_command",
  "memory_dreaming_sweep",
  ...MANUAL_TRIGGER_HOST_METHODS,
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
export const REVIEW_ROLE_VALUES = Object.freeze(["user"]);
export const FEEDBACK_SOURCE_VALUES = Object.freeze(["session_message"]);
export const DECISION_VALUES = Object.freeze(["approved", "rejected"]);
export const ORACLE_CHECK_KIND_VALUES = Object.freeze(["result", "path", "source", "temporal", "delivery", "semantic"]);
export const PROBE_WINDOW_VALUES = Object.freeze(["last-assistant", "state", "all-assistant", "artifact"]);
export const TOOL_APPROVAL_VALUES = Object.freeze(["allow-once"]);
export const PROBE_POLARITY_VALUES = Object.freeze(["required", "forbidden"]);
export const PROBE_FREQUENCY_VALUES = Object.freeze([
  "once-weekly",
  "frequent",
  "thrice-weekly",
  "frequent-or-thrice-weekly",
]);
export const PROBE_TEMPORAL_VALUES = Object.freeze(["current", "past"]);
export const PROBE_EXPECTATION_KIND_VALUES = Object.freeze([
  "none",
  "fact",
  "cross-session",
  "temporal-scope",
  "subjects",
  "session-source",
  "deliverable",
  "external-result",
]);

const RUBRIC_DEFINITIONS = Object.freeze([
  { id: "external.expected-result", kind: "semantic", expectation: "external-result", description: "根据锁定的上游参考答案与判据核对实际结果；适配结果不冒充官方分数" },
  { id: "answer.fact-recall", kind: "semantic", expectation: "fact", description: "回答包含探针声明的事实（主语、频率或选择）" },
  { id: "answer.cross-session-recall", kind: "semantic", expectation: "cross-session", description: "新会话回答满足必需的跨会话事实，并至少满足一项允许的历史事实" },
  { id: "answer.corrects-false-premise", kind: "semantic", expectation: "none", description: "用户给出与已知事实冲突的前提时纠正前提，不顺着错误前提回答" },
  { id: "answer.no-fabrication", kind: "semantic", expectation: "none", description: "编造未被记录或无法确认的事情" },
  { id: "answer.temporal-scope", kind: "temporal", expectation: "temporal-scope", description: "在指定时间范围内出现探针禁止的事实，构成相对时序错误" },
  { id: "answer.no-stale-choice", kind: "semantic", expectation: "none", description: "把已被用户更新掉的旧选择当作当前或最终选择" },
  { id: "memory-source.correction-entry", kind: "source", expectation: "subjects", description: "纠正事实来自本轮用户消息，且记忆主语匹配声明" },
  { id: "memory-source.no-fixture-as-update", kind: "source", expectation: "subjects", description: "把 fixture 初始记忆当作本轮用户更新" },
  { id: "session.answer-in-new-session", kind: "path", expectation: "session-source", description: "回答发生在驱动新建的会话，且与事实来源会话不同" },
  { id: "chat.correction-acknowledged", kind: "semantic", expectation: "none", description: "接住纠正的新事实，不否认、不复述旧结论" },
  { id: "delivery.artifact-exists", kind: "delivery", expectation: "deliverable", description: "声明的交付产物已写入且内容完整（未被截断）" },
  { id: "delivery.artifact-content", kind: "delivery", expectation: "deliverable", description: "交付产物内容满足声明的包含／不包含要求" },
  { id: "chat.delivery-acknowledged", kind: "delivery", expectation: "none", description: "回复告知产物已生成或说明未完成" },
  { id: "reply.no-oracle-leak", kind: "delivery", expectation: "none", description: "回复中泄露探针、评分、fixture 或评测内部信息" },
]);

export const RUBRIC_SPECS = Object.freeze(RUBRIC_DEFINITIONS.map((rubric) => Object.freeze({ ...rubric })));

const RUBRIC_MAP = new Map(RUBRIC_SPECS.map((rubric) => [rubric.id, rubric]));
const RUBRIC_WINDOW_PINS = new Map([
  ["session.answer-in-new-session", "last-assistant"],
  ["answer.cross-session-recall", "last-assistant"],
  ["memory-source.correction-entry", "state"],
  ["memory-source.no-fixture-as-update", "state"],
  ["delivery.artifact-exists", "artifact"],
  ["delivery.artifact-content", "artifact"],
]);
const DELIVERY_ARTIFACT_RUBRICS = new Set(["delivery.artifact-exists", "delivery.artifact-content"]);
const MESSAGE_PLACEHOLDERS = new Set(["dataRoot"]);
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

/** 交付路径必须是数据根下的相对 POSIX 路径；拒绝绝对路径、盘符、反斜杠与空段、.、..。 */
function assertDeliverablePath(value, label) {
  assertNonEmptyString(value, label);
  if (value.includes("\\")) {
    throw new DatasetError("case.deliverable-path", `${label} 必须使用 / 分隔：${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments[0].includes(":")) {
    throw new DatasetError("case.deliverable-path", `${label} 不能是绝对路径或包含空段、.、..：${value}`);
  }
  return value;
}

/** Four braces escape a literal pair, preserving upstream TeX/JSON without new placeholders. */
export function escapeDriverText(text) { return text.replaceAll("{{", "{{{{").replaceAll("}}", "}}}}"); }

export function renderMessageTemplate(text, { dataRoot, label = "驱动消息" } = {}) {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("{{{{", index)) { result += "{{"; index += 4; continue; }
    if (text.startsWith("}}}}", index)) { result += "}}"; index += 4; continue; }
    if (text.startsWith("{{", index)) {
      const end = text.indexOf("}}", index + 2);
      const name = end < 0 ? "" : text.slice(index + 2, end);
      if (end < 0) throw new DatasetError("case.placeholder-unknown", `${label} 含不完整的占位符：${text.slice(index)}`);
      if (!MESSAGE_PLACEHOLDERS.has(name)) throw new DatasetError("case.placeholder-unknown", `${label} 含未登记占位符：{{${name}}}`);
      if (typeof dataRoot !== "string" || !dataRoot.trim()) throw new DatasetError("driver.data-root", "驱动消息使用了 {{dataRoot}}，但本次运行没有数据根");
      result += dataRoot;
      index = end + 2;
      continue;
    }
    if (text.startsWith("}}", index)) throw new DatasetError("case.placeholder-unknown", `${label} 含不完整的占位符`);
    result += text[index++];
  }
  return result;
}

function assertMessagePlaceholders(text, label) { renderMessageTemplate(text, { dataRoot: "validation-root", label }); }

function scanEmbeddedLabels(value, path, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanEmbeddedLabels(item, `${path}[${index}]`, label));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    // expectation 子树由 validateExpectation 逐字段精确校验，允许使用 subject.label 表达主语；
    // 其余任何位置仍禁止内嵌审批或分级字段。
    if (key === "expectation") continue;
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

function assertSubject(value, label) {
  assertExactKeys(value, label, ["label", "aliases"]);
  assertNonEmptyString(value.label, `${label}.label`);
  assertStringArray(value.aliases, `${label}.aliases`, { allowEmpty: true, unique: true });
  for (const alias of value.aliases) {
    if (alias === value.label) {
      throw new DatasetError("schema.expectation-alias", `${label}.aliases 不能重复 label：${alias}`);
    }
  }
  return value;
}

function assertFrequency(value, label) {
  return assertEnum(value, PROBE_FREQUENCY_VALUES, label);
}

function assertTemporal(value, label) {
  return assertEnum(value, PROBE_TEMPORAL_VALUES, label);
}

function assertFact(value, label) {
  assertRecord(value, label);
  assertEnum(value.kind, ["frequency", "choice"], `${label}.kind`);
  if (value.kind === "frequency") {
    assertExactKeys(value, label, ["kind", "subject", "frequency", "temporal"]);
    assertSubject(value.subject, `${label}.subject`);
    assertFrequency(value.frequency, `${label}.frequency`);
    assertTemporal(value.temporal, `${label}.temporal`);
    return value;
  }
  assertExactKeys(value, label, ["kind", "value", "aliases"]);
  assertNonEmptyString(value.value, `${label}.value`);
  assertStringArray(value.aliases, `${label}.aliases`, { allowEmpty: true, unique: true });
  for (const alias of value.aliases) {
    if (alias === value.value) {
      throw new DatasetError("schema.expectation-alias", `${label}.aliases 不能重复 value：${alias}`);
    }
  }
  return value;
}

function assertFactArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new DatasetError("schema.invalid", `${label} 必须是数组`);
  if (!allowEmpty && value.length === 0) throw new DatasetError("schema.invalid", `${label} 不能为空`);
  value.forEach((fact, index) => assertFact(fact, `${label}[${index}]`));
  return value;
}

function assertSubjectList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DatasetError("schema.invalid", `${label} 必须是非空数组`);
  }
  const seen = new Set();
  value.forEach((subject, index) => {
    assertSubject(subject, `${label}[${index}]`);
    for (const term of [subject.label, ...subject.aliases]) {
      if (seen.has(term)) {
        throw new DatasetError("schema.expectation-alias", `${label} 含跨主语重复别名：${term}`);
      }
      seen.add(term);
    }
  });
  return value;
}

function assertSourceStep({ sourceStep, label, driverById, driverIndexById, afterStepId }) {
  assertNonEmptyString(sourceStep, label);
  const step = driverById.get(sourceStep);
  if (!step || step.kind !== "message") {
    throw new DatasetError("case.expectation-source", `${label} 必须指向驱动消息步骤：${String(sourceStep)}`);
  }
  const sourceIndex = driverIndexById.get(sourceStep);
  const afterIndex = driverIndexById.get(afterStepId);
  if (!(sourceIndex < afterIndex)) {
    throw new DatasetError("case.expectation-order", `${label} 必须早于探针步骤：${sourceStep} / ${afterStepId}`);
  }
  return sourceStep;
}

function assertNewSessionBefore({ driver, driverIndexById, afterStepId, label }) {
  const afterIndex = driverIndexById.get(afterStepId);
  const found = driver.some((step, index) => (
    index < afterIndex && step.kind === "host" && step.method === "chat_new_session"
  ));
  if (!found) {
    throw new DatasetError(
      "case.expectation-session",
      `${label} 之前必须有 chat_new_session 驱动步骤：${afterStepId}`,
    );
  }
}

function validateExpectation({ probe, rubric, driver, driverById, driverIndexById, label, deliverableIds }) {
  if (rubric.expectation === "none") {
    if (probe.expectation !== undefined) {
      throw new DatasetError(
        "schema.expectation-unexpected",
        `${label}.expectation 不适用于 ${rubric.id}：该规则不接受声明式期望`,
      );
    }
    return null;
  }
  if (probe.expectation === undefined) {
    throw new DatasetError(
      "schema.expectation-missing",
      `${label}.expectation 必填：${rubric.id} 需要声明主语、频率或时间关系`,
    );
  }
  const expectationLabel = `${label}.expectation`;
  assertRecord(probe.expectation, expectationLabel);
  if (rubric.expectation === "external-result") {
    assertExactKeys(probe.expectation, expectationLabel, ["referenceAnswers", "criteria"]);
    assertStringArray(probe.expectation.referenceAnswers, `${expectationLabel}.referenceAnswers`, { allowEmpty: true });
    assertStringArray(probe.expectation.criteria, `${expectationLabel}.criteria`, { allowEmpty: true });
    if (probe.expectation.referenceAnswers.length + probe.expectation.criteria.length === 0) {
      throw new DatasetError("schema.expectation-missing", `${expectationLabel} 至少需要上游参考答案或明确判据`);
    }
    return probe.expectation;
  }
  if (rubric.expectation === "fact") {
    assertExactKeys(probe.expectation, expectationLabel, ["fact"]);
    assertFact(probe.expectation.fact, `${expectationLabel}.fact`);
    return probe.expectation;
  }
  if (rubric.expectation === "cross-session") {
    assertExactKeys(probe.expectation, expectationLabel, ["sourceStep", "requiredFacts"], ["anyOfFacts"]);
    assertSourceStep({
      sourceStep: probe.expectation.sourceStep,
      label: `${expectationLabel}.sourceStep`,
      driverById,
      driverIndexById,
      afterStepId: probe.after,
    });
    assertFactArray(probe.expectation.requiredFacts, `${expectationLabel}.requiredFacts`);
    if (probe.expectation.anyOfFacts !== undefined) {
      assertFactArray(probe.expectation.anyOfFacts, `${expectationLabel}.anyOfFacts`);
    }
    assertNewSessionBefore({
      driver,
      driverIndexById,
      afterStepId: probe.after,
      label: expectationLabel,
    });
    return probe.expectation;
  }
  if (rubric.expectation === "temporal-scope") {
    assertExactKeys(probe.expectation, expectationLabel, ["forbidden"]);
    if (!Array.isArray(probe.expectation.forbidden) || probe.expectation.forbidden.length === 0) {
      throw new DatasetError("schema.invalid", `${expectationLabel}.forbidden 必须是非空数组`);
    }
    probe.expectation.forbidden.forEach((rule, index) => {
      const ruleLabel = `${expectationLabel}.forbidden[${index}]`;
      assertExactKeys(rule, ruleLabel, ["subject", "frequency", "temporal"]);
      assertSubject(rule.subject, `${ruleLabel}.subject`);
      assertFrequency(rule.frequency, `${ruleLabel}.frequency`);
      assertTemporal(rule.temporal, `${ruleLabel}.temporal`);
    });
    return probe.expectation;
  }
  if (rubric.expectation === "subjects") {
    assertExactKeys(probe.expectation, expectationLabel, ["subjects"]);
    assertSubjectList(probe.expectation.subjects, `${expectationLabel}.subjects`);
    return probe.expectation;
  }
  if (rubric.expectation === "session-source") {
    assertExactKeys(probe.expectation, expectationLabel, ["sourceStep"]);
    assertSourceStep({
      sourceStep: probe.expectation.sourceStep,
      label: `${expectationLabel}.sourceStep`,
      driverById,
      driverIndexById,
      afterStepId: probe.after,
    });
    assertNewSessionBefore({
      driver,
      driverIndexById,
      afterStepId: probe.after,
      label: expectationLabel,
    });
    return probe.expectation;
  }
  if (rubric.expectation === "deliverable") {
    assertExactKeys(probe.expectation, expectationLabel, ["deliverableId"], ["contains", "notContains"]);
    assertNonEmptyString(probe.expectation.deliverableId, `${expectationLabel}.deliverableId`);
    if (!deliverableIds?.has(probe.expectation.deliverableId)) {
      throw new DatasetError(
        "case.deliverable-unknown",
        `${expectationLabel}.deliverableId 未在 Case.deliverables 声明：${probe.expectation.deliverableId}`,
      );
    }
    const hasContains = probe.expectation.contains !== undefined;
    const hasNotContains = probe.expectation.notContains !== undefined;
    if (rubric.id === "delivery.artifact-exists") {
      if (hasContains || hasNotContains) {
        throw new DatasetError(
          "schema.expectation-unexpected",
          `${expectationLabel} 不适用于 ${rubric.id}：存在性规则不接受内容词表`,
        );
      }
      return probe.expectation;
    }
    if (!hasContains && !hasNotContains) {
      throw new DatasetError(
        "schema.expectation-missing",
        `${expectationLabel} 至少声明 contains 或 notContains：${rubric.id}`,
      );
    }
    if (hasContains) assertStringArray(probe.expectation.contains, `${expectationLabel}.contains`, { unique: true });
    if (hasNotContains) {
      assertStringArray(probe.expectation.notContains, `${expectationLabel}.notContains`, { unique: true });
    }
    return probe.expectation;
  }
  throw new DatasetError("schema.expectation-kind", `${label}.expectation 类型未实现：${String(rubric.expectation)}`);
}

function validateProbe(probe, label, driver, driverById, driverIndexById, evidenceIds, questionTypeIds, deliverableIds) {
  assertExactKeys(
    probe,
    label,
    ["id", "after", "window", "rubric", "questionType", "polarity", "critical", "difficulty", "description"],
    ["evidence", "expectation"],
  );
  assertPattern(probe.id, CASE_ID_PATTERN, `${label}.id`);
  assertNonEmptyString(probe.after, `${label}.after`);
  const step = driverById.get(probe.after);
  if (!step) {
    throw new DatasetError("schema.invalid", `${label}.after 未指向驱动步骤：${String(probe.after)}`);
  }
  assertEnum(probe.window, PROBE_WINDOW_VALUES, `${label}.window`);
  const rubric = RUBRIC_MAP.get(probe.rubric);
  if (!rubric) {
    throw new DatasetError("case.oracle-unknown-rubric", `${label}.rubric 未登记：${String(probe.rubric)}`);
  }
  if (probe.window === "artifact") {
    if (!DELIVERY_ARTIFACT_RUBRICS.has(rubric.id)) {
      throw new DatasetError("case.artifact-window", `${label}.window=artifact 只适用于交付产物规则：${rubric.id}`);
    }
    if (!deliverableIds || deliverableIds.size === 0) {
      throw new DatasetError("case.deliverable-undeclared", `${label}.window=artifact 需要 Case.deliverables 声明产物`);
    }
  }
  validateExpectation({ probe, rubric, driver, driverById, driverIndexById, label, deliverableIds });
  if (RUBRIC_WINDOW_PINS.has(rubric.id) && probe.window !== RUBRIC_WINDOW_PINS.get(rubric.id)) {
    throw new DatasetError(
      "case.rubric-window",
      `${label}.window 必须是 ${RUBRIC_WINDOW_PINS.get(rubric.id)}：${rubric.id}`,
    );
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
  return rubric;
}

function validateDriverStep(step, label) {
  assertRecord(step, label);
  if (step.kind === "message") {
    assertExactKeys(step, label, ["id", "kind", "text"], ["at"]);
    assertPattern(step.id, CASE_ID_PATTERN, `${label}.id`);
    assertNonEmptyString(step.text, `${label}.text`);
    assertMessagePlaceholders(step.text, `${label}.text`);
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

function bindingWithFixtureHash(caseSpec, fixtureHash) {
  const contentHash = hashCanonical(omitKeys(caseSpec, ["revision", "governance"]));
  const driverHash = hashCanonical({ userRole: caseSpec.userRole, driver: caseSpec.driver });
  const oracleHash = hashCanonical({
    probes: caseSpec.probes,
    oracle: caseSpec.oracle,
    checkpoints: caseSpec.checkpoints,
    pathConstraints: caseSpec.pathConstraints,
    evidence: caseSpec.evidence,
    deliverables: caseSpec.deliverables,
  });
  const specHash = hashCanonical({ contentHash, fixtureHash, driverHash, oracleHash });
  return { contentHash, fixtureHash, driverHash, oracleHash, specHash };
}

export function computeCaseBinding(caseSpec, fixture) {
  return bindingWithFixtureHash(caseSpec, hashCanonical(fixture));
}

/** 数据集输入哈希覆盖分类、题型注册表、套件、用例与 fixture，忽略读取路径等运行期噪声。 */
export function datasetInputHash(dataset, entry) {
  return hashCanonical({
    schemaVersion: dataset.schemaVersion,
    categories: dataset.categories,
    questionTypes: { families: dataset.questionTypeFamilies, questionTypes: dataset.questionTypes },
    suite: dataset.suites.find(suite => suite.suiteId === entry.suiteId) ?? null,
    case: entry.case,
    fixture: entry.fixture,
  });
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

export function validateExternalAsset(asset) {
  const label = "ExternalAsset";
  assertExactKeys(asset, label, ["sourcePath", "targetPath", "sha256", "bytes"]);
  for (const key of ["sourcePath", "targetPath"]) {
    assertNonEmptyString(asset[key], `${label}.${key}`);
    if (/^(?:[a-z]:|[\\/])/i.test(asset[key]) || asset[key].split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new DatasetError("asset.path", `${label}.${key} 必须是无越界分量的相对路径`);
  }
  if (!asset.targetPath.startsWith("inputs/") || !/^sha256:[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > EXTERNAL_ASSET_MAX_BYTES) throw new DatasetError("asset.binding", "附件目标、散列或大小非法");
  return asset;
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
    "governance",
  ], ["deliverables"]);
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

  assertExactKeys(spec.source, `${label}.source`, ["kind", "ref", "excerpt"], ["note", "upstream"]);
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
  if (spec.source.kind === "external") {
    const upstream = spec.source.upstream;
    assertExactKeys(upstream, `${label}.source.upstream`, [
      "dataset", "id", "revision", "split", "sha256", "license", "protocol", "adaptationNotes",
    ], ["assets"]);
    for (const key of ["dataset", "id", "split", "license"]) {
      assertNonEmptyString(upstream[key], `${label}.source.upstream.${key}`);
    }
    if (!/^[a-f0-9]{40}$/.test(upstream.revision)) {
      throw new DatasetError("case.external-revision", `${label}.source.upstream.revision 必须是固定的 40 位 commit`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(upstream.sha256)) {
      throw new DatasetError("case.external-hash", `${label}.source.upstream.sha256 必须绑定已导入的原始数据`);
    }
    if (upstream.protocol !== "adapted") {
      throw new DatasetError("case.external-protocol", `${label}.source.upstream.protocol 必须是 adapted；本运行器不产生官方榜单分数`);
    }
    assertStringArray(upstream.adaptationNotes, `${label}.source.upstream.adaptationNotes`, { allowEmpty: true });
    if (upstream.assets !== undefined) {
      if (!Array.isArray(upstream.assets)) throw new DatasetError("asset.shape", "外部附件必须是数组");
      upstream.assets.forEach(validateExternalAsset);
      if (new Set(upstream.assets.map(asset => asset.targetPath)).size !== upstream.assets.length) throw new DatasetError("asset.target", "外部附件目标重复");
    }
  } else if (spec.source.upstream !== undefined) {
    throw new DatasetError("case.external-source", `${label}.source.upstream 只适用于 external 来源`);
  }

  assertExactKeys(spec.precondition, `${label}.precondition`, [
    "card",
    "profile",
    "fixtureId",
    "time",
    "hostCapabilities",
  ], ["toolApproval"]);
  assertNonEmptyString(spec.precondition.card, `${label}.precondition.card`);
  assertNonEmptyString(spec.precondition.profile, `${label}.precondition.profile`);
  assertPattern(spec.precondition.fixtureId, CASE_ID_PATTERN, `${label}.precondition.fixtureId`);
  assertExactKeys(spec.precondition.time, `${label}.precondition.time`, ["mode"]);
  assertEnum(spec.precondition.time.mode, TIME_MODE_VALUES, `${label}.precondition.time.mode`);
  assertStringArray(spec.precondition.hostCapabilities, `${label}.precondition.hostCapabilities`, { unique: true });
  assertSubset(spec.precondition.hostCapabilities, HOST_CAPABILITY_VALUES, `${label}.precondition.hostCapabilities`);
  if (spec.precondition.toolApproval !== undefined) {
    assertEnum(spec.precondition.toolApproval, TOOL_APPROVAL_VALUES, `${label}.precondition.toolApproval`);
    if (!spec.precondition.hostCapabilities.includes("tools")) {
      throw new DatasetError("case.tool-approval", `${label}.precondition.toolApproval 需要 tools 宿主能力`);
    }
  }

  assertExactKeys(spec.userRole, `${label}.userRole`, [
    "knownFacts",
    "goal",
    "tone",
    "allowedActions",
    "mustNotReveal",
  ]);
  assertStringArray(spec.userRole.knownFacts, `${label}.userRole.knownFacts`, { allowEmpty: true, unique: true });
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
  const deliverableIds = new Set();
  const deliverablePaths = new Set();
  if (spec.deliverables !== undefined) {
    if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0) {
      throw new DatasetError("schema.invalid", `${label}.deliverables 必须是非空数组`);
    }
    if (!spec.precondition.hostCapabilities.includes("tools")) {
      throw new DatasetError("case.deliverables-capability", `${label}.deliverables 需要 tools 宿主能力`);
    }
    spec.deliverables.forEach((deliverable, index) => {
      const deliverableLabel = `${label}.deliverables[${index}]`;
      assertExactKeys(deliverable, deliverableLabel, ["id", "role", "path"], ["maxBytes"]);
      assertPattern(deliverable.id, CASE_ID_PATTERN, `${deliverableLabel}.id`);
      if (deliverableIds.has(deliverable.id)) {
        throw new DatasetError("schema.invalid", `${label}.deliverables 含重复 id：${deliverable.id}`);
      }
      deliverableIds.add(deliverable.id);
      assertNonEmptyString(deliverable.role, `${deliverableLabel}.role`);
      assertDeliverablePath(deliverable.path, `${deliverableLabel}.path`);
      if (deliverablePaths.has(deliverable.path)) {
        throw new DatasetError("case.deliverable-path", `${label}.deliverables 含重复路径：${deliverable.path}`);
      }
      deliverablePaths.add(deliverable.path);
      if (deliverable.maxBytes !== undefined) assertPositiveInteger(deliverable.maxBytes, `${deliverableLabel}.maxBytes`);
    });
  }
  const driverById = new Map(spec.driver.map((step) => [step.id, step]));
  const driverIndexById = new Map(spec.driver.map((step, index) => [step.id, index]));
  const probeIds = new Set();
  const rubricPolarities = new Map();
  let criticalRequired = 0;
  spec.probes.forEach((probe, index) => {
    const rubric = validateProbe(
      probe,
      `${label}.probes[${index}]`,
      spec.driver,
      driverById,
      driverIndexById,
      evidenceIds,
      knownQuestionTypes,
      deliverableIds,
    );
    if (probeIds.has(probe.id)) {
      throw new DatasetError("schema.invalid", `${label}.probes 含重复 id：${probe.id}`);
    }
    probeIds.add(probe.id);
    const polarities = rubricPolarities.get(rubric.id) ?? new Set();
    polarities.add(probe.polarity);
    rubricPolarities.set(rubric.id, polarities);
    if (probe.polarity === "required" && probe.critical) criticalRequired += 1;
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
  for (const [rubricId, polarities] of rubricPolarities) {
    if (polarities.size > 1) {
      throw new DatasetError(
        "case.probe-contradiction",
        `${label}.probes 对同一 rubric 同时要求并禁止：${rubricId}`,
      );
    }
  }
  const provenanceSteps = new Set(
    spec.probes
      .filter((probe) => probe.rubric === "session.answer-in-new-session")
      .map((probe) => probe.after),
  );
  for (const probe of spec.probes) {
    if (probe.rubric !== "answer.cross-session-recall") continue;
    if (!provenanceSteps.has(probe.after)) {
      throw new DatasetError(
        "case.cross-session-provenance",
        `${label}.probes 跨会话内容探针 ${probe.id} 缺少同一 after 的结构探针：${probe.after}`,
      );
    }
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

export function writeApprovalRecords({
  repoRoot = resolve(import.meta.dirname, "../../.."),
  datasetRoot = DEFAULT_DATASET_ROOT,
  entries,
  decisions,
  reviewer,
  feedbackSource,
  reviewedAt,
}) {
  const decisionResult = applyReviewDecisions({ entries, decisions, reviewer, feedbackSource, reviewedAt });
  if (decisionResult.errors.length > 0) {
    return { records: [], written: [], errors: decisionResult.errors };
  }

  const root = resolve(repoRoot, datasetRoot);
  if (!existsSync(root)) {
    return {
      records: [],
      written: [],
      errors: [issue("dataset.missing-root", `数据集目录不存在：${displayPath(repoRoot, root)}`)],
    };
  }

  const errors = [];
  const suiteDirs = new Map();
  for (const suitePath of findFiles(root, (name) => name === "suite.json")) {
    try {
      const suiteSpec = readJson(suitePath);
      if (isRecord(suiteSpec) && typeof suiteSpec.suiteId === "string") {
        suiteDirs.set(suiteSpec.suiteId, {
          dir: dirname(suitePath),
          caseIds: Array.isArray(suiteSpec.caseIds) ? suiteSpec.caseIds : [],
        });
      }
    } catch {
      // 无法解析的 suite 交由 loadDataset 报错，这里不重复记录。
    }
  }

  const targets = [];
  const seen = new Set();
  for (const record of decisionResult.records) {
    const suite = suiteDirs.get(record.suiteId);
    if (!suite) {
      errors.push(issue("approval.suite-missing", `审批目标套件不在数据集目录：${record.suiteId}`));
      continue;
    }
    if (!suite.caseIds.includes(record.caseId)) {
      errors.push(issue("approval.case-missing", `套件 ${record.suiteId} 未声明用例：${record.caseId}`));
      continue;
    }
    const filePath = join(suite.dir, "approvals", `${record.approvalId}.json`);
    if (seen.has(filePath)) {
      errors.push(issue("approval.duplicate-target", `同一审批目标重复：${record.approvalId}`));
      continue;
    }
    seen.add(filePath);
    if (existsSync(filePath)) {
      errors.push(issue("approval.exists", `审批已存在，拒绝覆盖：${displayPath(repoRoot, filePath)}`));
      continue;
    }
    targets.push({ record, filePath });
  }
  if (errors.length > 0) return { records: [], written: [], errors };

  const written = [];
  for (const { record, filePath } of targets) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      written.push({ approvalId: record.approvalId, path: displayPath(repoRoot, filePath) });
    } catch (error) {
      const code = error?.code === "EEXIST" ? "approval.exists" : "approval.write-failed";
      errors.push(issue(code, `写入审批失败（${record.approvalId}）：${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return {
    records: errors.length > 0 ? [] : decisionResult.records,
    written,
    errors,
  };
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
        "governance",
        "source",
        "deliverables",
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
  const difficultyCounts = new Map(PROBE_DIFFICULTY_LEVELS.map((level) => [level, 0]));
  for (const probe of probes) {
    questionTypeCounts.set(probe.questionType, (questionTypeCounts.get(probe.questionType) ?? 0) + 1);
    difficultyCounts.set(probe.difficulty, (difficultyCounts.get(probe.difficulty) ?? 0) + 1);
  }
  return { questionTypeCounts, difficultyCounts };
}

function formatSubject(subject) {
  return subject.aliases.length > 0 ? `${subject.label}（别名：${subject.aliases.join("、")}）` : subject.label;
}

function formatFact(fact) {
  if (fact.kind === "choice") {
    return `选择「${fact.value}」${fact.aliases.length > 0 ? `（别名：${fact.aliases.join("、")}）` : ""}`;
  }
  return `${formatSubject(fact.subject)} · ${fact.frequency} · ${fact.temporal}`;
}

/** 把探针的声明式 expectation 渲染成审阅可读文本，与检查器实现解耦。 */
export function formatExpectation(expectation) {
  if (!expectation) return "";
  if (expectation.referenceAnswers || expectation.criteria) {
    return JSON.stringify({ referenceAnswers: expectation.referenceAnswers, criteria: expectation.criteria });
  }
  if (expectation.deliverableId) {
    const parts = [`产物：${expectation.deliverableId}`];
    if (expectation.contains?.length) parts.push(`包含：${expectation.contains.join("、")}`);
    if (expectation.notContains?.length) parts.push(`不包含：${expectation.notContains.join("、")}`);
    return parts.join("；");
  }
  if (expectation.fact) return `事实：${formatFact(expectation.fact)}`;
  if (expectation.sourceStep && expectation.requiredFacts) {
    const anyOf = expectation.anyOfFacts?.length
      ? `；任一：${expectation.anyOfFacts.map(formatFact).join(" / ")}`
      : "";
    return `跨会话：来源步骤 ${expectation.sourceStep}；必需：${expectation.requiredFacts.map(formatFact).join("；")}${anyOf}`;
  }
  if (expectation.forbidden) {
    return `禁止：${expectation.forbidden.map(formatFact).join("；")}`;
  }
  if (expectation.subjects) {
    return `主语：${expectation.subjects.map(formatSubject).join("、")}`;
  }
  if (expectation.sourceStep) return `来源步骤：${expectation.sourceStep}`;
  return "";
}

function formatProbe(probe) {
  const rubric = RUBRIC_MAP.get(probe.rubric);
  const critical = probe.critical ? "critical" : "non-critical";
  const evidence = probe.evidence?.length ? `；证据：${probe.evidence.join("、")}` : "";
  const description = probe.description.replace(/[。；;]\s*$/, "");
  const expectation = formatExpectation(probe.expectation);
  const expectationText = expectation ? `；期望 ${expectation}` : "";
  return `- ${probe.id}（${critical} · ${probe.polarity} · ${probe.window} @ ${probe.after} · 题型 ${probe.questionType} · 难度 L${probe.difficulty}）${probe.rubric} [${rubric?.kind ?? "unknown"}]：${description}${expectationText}${evidence}`;
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
  if (review.candidate.precondition.toolApproval) {
    lines.push(`- 工具确认：${review.candidate.precondition.toolApproval}（评测驱动代替用户确认一次）`);
  }
  if (review.candidate.deliverables?.length) {
    lines.push(
      `- 交付产物：${review.candidate.deliverables
        .map((deliverable) => `${deliverable.id}（${deliverable.role}）→ ${deliverable.path}${deliverable.maxBytes ? ` ≤${deliverable.maxBytes}B` : ""}`)
        .join("；")}`,
    );
  }
  lines.push("");
  const { questionTypeCounts, difficultyCounts } = tallyProbeAxes(review.candidate.probes);
  lines.push("## 题型与判分");
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
  lines.push("- 判分：全部探针由独立 coding-agent judge 按结果判定；用户抽查可选，不阻塞。");
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
  const selectedCaseIds = options.caseIds === undefined ? null : new Set(options.caseIds);

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
      if (selectedCaseIds && !selectedCaseIds.has(caseId)) continue;
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
            fixtureCache.set(fixturePath, { fixture, hash: hashCanonical(fixture) });
          } catch (error) {
            fixtureCache.set(fixturePath, { error });
            throw error;
          }
        }
        validateCaseAgainstFixture(caseSpec, fixture);

        const binding = bindingWithFixtureHash(caseSpec, fixtureCache.get(fixturePath).hash);
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
          if (selectedCaseIds && !selectedCaseIds.has(record.caseId)) continue;
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
