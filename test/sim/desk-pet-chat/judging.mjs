// ==========================================
// 聊天评测判分 — 冻结判分包、独立 coding-agent judge 与可选用户抽查
// ==========================================
//
// 运行器只负责：把封存证据与当前 case 冻结成判分包、校验 judge 回填的裁决、
// 追加只读判分记录。模型调用不在运行器内发生，也不读取任何凭据。
// 所有探针（含 humanizer 质量规则）都由独立 coding-agent judge 判定；
// 用户抽查是可选项，只记录覆盖与一致性，不阻塞、不改写判分结论。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATASET_SCHEMA_VERSION,
  RUBRIC_SPECS,
  datasetInputHash,
  formatExpectation,
  hashCanonical,
} from "./dataset.mjs";
import { CHAT_GRADER_VERSION, appendGrade, appendReview, verifySealedAttempt } from "./evidence.mjs";

export const JUDGING_SCHEMA_VERSION = 1;
export const JUDGE_PACKET_SCHEMA_VERSION = 1;
export const VERDICTS_SCHEMA_VERSION = 1;
export const JUDGE_PROMPT_VERSION = "chat-judge@3";
export const JUDGE_RUBRIC_VERSION = JUDGE_PROMPT_VERSION;
export const JUDGE_AUTHORITY = "coding-agent-judge";
/** 只有这些执行平台的回填才算 coding-agent 权威；API 客户端跑同样的 prompt 也不算。 */
export const CODING_AGENT_PLATFORMS = Object.freeze(["claude-code", "codex", "qoder"]);
export const AGGREGATION_RULE = "judge-all-rules";

export const CHECK_STATUSES = Object.freeze(["pass", "fail", "inconclusive", "not_applicable"]);
export const EXECUTION_STATUSES = Object.freeze(["completed", "failed", "cancelled", "blocked"]);
export const EVIDENCE_STATUSES = Object.freeze(["complete", "incomplete", "invalid"]);
export const JUDGE_VERDICTS = Object.freeze(["pass", "fail", "inconclusive"]);
export const SPOT_CHECK_AGREEMENTS = Object.freeze(["agree", "disagree"]);

const PACKET_DIR = "judge-packets";
const PACKET_ID_PATTERN = /^packet-[a-z0-9][a-z0-9._-]*$/;
const REVIEW_ID_PREFIX = "spot";
const QUALITY_DIMENSIONS = [
  "自然口语",
  "角色一致",
  "不服务腔、不说教",
  "不暴露程序或模型身份",
  "不解释自己刚说过的话",
  "不索取回应或追问",
];
const INTERNAL_TERMS = Object.freeze([
  "probe", "rubric", "oracle", "spechash", "oraclehash", "checkpoint",
  "gold", "silver", "humanizer", "dataset", "judge packet",
]);
const MAX_EVIDENCE_EXCERPT = 180;

export class JudgingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JudgingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new JudgingError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function assertIsoTimestamp(value, label) {
  if (!isIsoTimestamp(value)) fail("time.invalid", `${label} 必须是 ISO 时间：${String(value)}`);
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function excerpt(text, limit = MAX_EVIDENCE_EXCERPT) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function compactTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("time.invalid", `时间不合法：${String(value)}`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").toLowerCase();
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("json.invalid", `${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readState(attemptDir, name) {
  const path = join(attemptDir, "state", `${name}.json`);
  if (!existsSync(path)) return { value: null, issue: `state/${name}.json 缺失` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), issue: null };
  } catch {
    return { value: null, issue: `state/${name}.json 不是合法 JSON` };
  }
}

function readDialogue(attemptDir) {
  const path = join(attemptDir, "dialogue.jsonl");
  const messages = [];
  const issues = [];
  if (!existsSync(path)) return { messages, issues: ["dialogue.jsonl 缺失"] };
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) !== "") issues.push("dialogue.jsonl 最后一行未完整换行");
  let expectedSeq = 1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      issues.push(`dialogue 第 ${expectedSeq} 条不是合法 JSON`);
      continue;
    }
    if (record.seq !== expectedSeq) issues.push(`dialogue 序号不连续：期望 ${expectedSeq}，实际 ${String(record.seq)}`);
    expectedSeq += 1;
    if (!["user", "assistant"].includes(record.role)) issues.push(`dialogue 第 ${String(record.seq)} 条角色非法`);
    if (typeof record.text !== "string" || !record.text.trim()) issues.push(`dialogue 第 ${String(record.seq)} 条正文为空`);
    if (!["fixture", "driver", "assistant"].includes(record.origin)) {
      issues.push(`dialogue 第 ${String(record.seq)} 条来源非法`);
    }
    if (!Number.isSafeInteger(record.at)) issues.push(`dialogue 第 ${String(record.seq)} 条时间非法`);
    messages.push(record);
  }
  return { messages, issues };
}

function readVersionedRecords(attemptDir, dir) {
  const path = join(attemptDir, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      // 损坏的判分／抽查记录不能被静默跳过：跳过等于把可能存在的失败洗成通过。
      let record;
      try {
        record = JSON.parse(readFileSync(join(path, name), "utf8"));
      } catch {
        fail("records.corrupt", `${dir}/${name} 不是合法 JSON`);
      }
      if (!isRecord(record)) fail("records.corrupt", `${dir}/${name} 不是对象`);
      return record;
    });
}

function latestRecord(records) {
  return [...records].sort((left, right) => {
    const diff = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return diff !== 0 ? diff : String(right.gradeId ?? right.reviewId ?? "").localeCompare(String(left.gradeId ?? left.reviewId ?? ""));
  })[0] ?? null;
}

function deriveEvidenceStatus(verification) {
  if (!verification.manifest) return "incomplete";
  if (verification.issues.length > 0) return "invalid";
  const integrity = verification.manifest.integrity?.status;
  if (integrity === "complete") return "complete";
  if (integrity === "inconclusive" || integrity === "incomplete") return "incomplete";
  return "invalid";
}

function deriveExecutionStatus(manifest) {
  if (!manifest) return "blocked";
  if (manifest.outcome === "completed") return "completed";
  if (manifest.outcome === "failed") return "failed";
  if (manifest.outcome === "interrupted") return "cancelled";
  return "blocked";
}

function addedSessionIds({ before, after, messages }) {
  const beforeIds = new Set((before?.sessions ?? []).map((session) => session.sessionId));
  const known = new Map();
  for (const session of after?.sessions ?? []) {
    if (!beforeIds.has(session.sessionId)) {
      known.set(session.sessionId, { sessionId: session.sessionId, createdAt: Number(session.createdAt) || 0 });
    }
  }
  for (const message of messages) {
    if (!beforeIds.has(message.sessionId) && !known.has(message.sessionId)) {
      known.set(message.sessionId, { sessionId: message.sessionId, createdAt: Number(message.at) || 0 });
    }
  }
  return [...known.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId))
    .map((session) => session.sessionId);
}

function mapDriverSteps({ caseEntry, messages, before, after }) {
  const driverMessages = messages.filter((message) => message.origin === "driver");
  const listedSteps = caseEntry.case.driver;
  const newSessions = addedSessionIds({ before, after, messages });
  const issues = [];
  const steps = [];
  let messageCursor = 0;
  let sessionCursor = 0;
  for (const step of listedSteps) {
    if (step.kind === "message") {
      let matchIndex = -1;
      for (let index = messageCursor; index < driverMessages.length; index += 1) {
        if (driverMessages[index].text === step.text) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex === -1) {
        issues.push({ code: "driver.message-missing", stepId: step.id, message: `驱动消息未在对话中找到：${step.id}` });
        steps.push({ stepId: step.id, kind: "message", step, message: null, sessionId: null, startSeq: null, endSeq: null });
        continue;
      }
      if (matchIndex > messageCursor) {
        issues.push({ code: "driver.message-order", stepId: step.id, message: `驱动消息之前出现未声明的用户消息：${step.id}` });
      }
      const message = driverMessages[matchIndex];
      messageCursor = matchIndex + 1;
      steps.push({
        stepId: step.id,
        kind: "message",
        step,
        message,
        sessionId: message.sessionId,
        startSeq: message.seq,
        endSeq: null,
      });
      continue;
    }
    if (step.method === "chat_new_session") {
      const sessionId = newSessions[sessionCursor] ?? null;
      sessionCursor += 1;
      if (sessionId === null) {
        issues.push({ code: "driver.session-missing", stepId: step.id, message: `驱动新建的会话未出现在采集范围：${step.id}` });
      }
      steps.push({ stepId: step.id, kind: "host", step, message: null, sessionId, startSeq: null, endSeq: null });
      continue;
    }
    steps.push({ stepId: step.id, kind: "host", step, message: null, sessionId: null, startSeq: null, endSeq: null });
  }
  if (messageCursor < driverMessages.length) {
    issues.push({ code: "driver.message-extra", stepId: null, message: "对话中存在驱动未声明的用户消息" });
  }
  if (sessionCursor !== newSessions.length) {
    issues.push({ code: "driver.session-extra", stepId: null, message: "采集到驱动未声明的新会话" });
  }
  const lastSeq = messages.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0);
  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index];
    if (current.startSeq === null) continue;
    let nextSeq = null;
    for (let lookahead = index + 1; lookahead < steps.length; lookahead += 1) {
      if (Number.isSafeInteger(steps[lookahead].startSeq)) {
        nextSeq = steps[lookahead].startSeq;
        break;
      }
    }
    current.endSeq = nextSeq === null ? lastSeq : Math.max(current.startSeq, nextSeq - 1);
  }
  const stepsById = new Map(steps.map((step) => [step.stepId, step]));
  return { steps, stepsById, issues, attributionValid: issues.length === 0, newSessions };
}

export function loadJudgingContext({ attemptDir, caseEntry }) {
  const verification = verifySealedAttempt(attemptDir);
  const manifest = verification.manifest ?? null;
  const dialogue = readDialogue(attemptDir);
  const before = readState(attemptDir, "before");
  const after = readState(attemptDir, "after");
  const capture = readState(attemptDir, "capture");
  const mapping = mapDriverSteps({
    caseEntry,
    messages: dialogue.messages,
    before: before.value,
    after: after.value,
  });
  return {
    attemptDir,
    manifest,
    verification,
    evidenceStatus: deriveEvidenceStatus(verification),
    executionStatus: deriveExecutionStatus(manifest),
    messages: dialogue.messages,
    dialogueIssues: dialogue.issues,
    before: before.value,
    after: after.value,
    capture: capture.value,
    beforeIssue: before.issue,
    afterIssue: after.issue,
    captureIssue: capture.issue,
    steps: mapping.steps,
    stepsById: mapping.stepsById,
    mappingIssues: mapping.issues,
    attributionValid: mapping.attributionValid,
    newSessions: mapping.newSessions,
  };
}

function repliesForStep({ messages, step }) {
  if (!step?.message || !Number.isSafeInteger(step.endSeq)) return [];
  return messages.filter((message) => (
    message.origin === "assistant"
    && message.sessionId === step.sessionId
    && message.seq > step.message.seq
    && message.seq <= step.endSeq
  ));
}

export function resolveProbeWindow({ context, probe }) {
  const step = context.stepsById.get(probe.after);
  if (!step) {
    return { ok: false, empty: true, replies: [], step: null, reason: `未找到驱动步骤：${probe.after}` };
  }
  if (probe.window === "state") {
    if (!context.after) {
      return { ok: false, empty: true, replies: [], step, reason: "after 状态快照缺失" };
    }
    return { ok: true, empty: false, replies: [], step, reason: null };
  }
  if (!step.message) {
    return { ok: false, empty: true, replies: [], step, reason: `驱动步骤未对应到对话消息：${probe.after}` };
  }
  if (probe.window === "last-assistant") {
    const replies = repliesForStep({ messages: context.messages, step });
    return { ok: true, empty: replies.length === 0, replies, step, reason: null };
  }
  if (probe.window === "all-assistant") {
    const replies = context.messages.filter((message) => (
      message.origin === "assistant" && message.seq <= step.endSeq
    ));
    return { ok: true, empty: replies.length === 0, replies, step, reason: null };
  }
  return { ok: false, empty: true, replies: [], step, reason: `未知探针窗口：${String(probe.window)}` };
}

function verifyDatasetBinding({ context, dataset, caseEntry }) {
  if (!context.manifest) fail("attempt.unsealed", "attempt 尚未封存，不能判分");
  const current = datasetInputHash(dataset, caseEntry);
  const started = context.manifest.identity?.inputs?.datasetHash;
  const sealed = context.manifest.inputHashes?.datasetHash;
  if (started !== current || (sealed !== null && sealed !== undefined && sealed !== current)) {
    fail("dataset.stale", "数据集在采集后已变更，旧证据不能按当前 oracle 判分");
  }
  return current;
}

function dialogueRef(message) {
  return `dialogue:${message.sessionId}:${message.entryId}`;
}

function allowedEvidenceRefs({ context }) {
  const refs = context.messages.map(dialogueRef);
  for (const name of ["before", "after", "capture"]) {
    if (context[name]) refs.push(`state:${name}`);
  }
  refs.push("trace:trace.jsonl");
  for (const artifact of context.manifest?.artifacts ?? []) {
    refs.push(`artifact:${artifact.path}`);
  }
  return unique(refs);
}

function messagesByRef(context) {
  return new Map(context.messages.map((message) => [dialogueRef(message), message]));
}

export function checkDriverNoOracleLeak({ dataset, caseEntry }) {
  const suite = dataset?.suites?.find((candidate) => candidate.suiteId === caseEntry.suiteId);
  const needles = [
    caseEntry.caseId,
    caseEntry.suiteId,
    caseEntry.fixture?.fixtureId,
    caseEntry.case.familyId,
    ...(suite?.caseIds ?? []),
    ...caseEntry.case.probes.map((probe) => probe.id),
    ...RUBRIC_SPECS.map((rubric) => rubric.id),
    ...caseEntry.case.evidence.map((item) => item.id),
    ...caseEntry.case.checkpoints.map((item) => item.id),
    caseEntry.case.quality.rubric,
    caseEntry.binding.specHash,
    caseEntry.binding.oracleHash,
    caseEntry.binding.driverHash,
    caseEntry.binding.fixtureHash,
    ...caseEntry.case.userRole.mustNotReveal,
    ...INTERNAL_TERMS,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  const violations = [];
  for (const step of caseEntry.case.driver) {
    const text = [step.text, step.note, step.args ? JSON.stringify(step.args) : ""]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!text) continue;
    for (const needle of needles) {
      if (text.includes(needle.toLowerCase())) {
        violations.push({ stepId: step.id, term: needle });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function assertDriverNoOracleLeak({ dataset, caseEntry }) {
  const result = checkDriverNoOracleLeak({ dataset, caseEntry });
  if (!result.ok) {
    const details = unique(result.violations.map((item) => `${item.stepId} 含 ${item.term}`)).join("；");
    fail("driver.oracle-leak", `驱动文本泄露评测内部信息：${details}`);
  }
}

function stepWindow({ window, probe }) {
  return {
    mode: probe.window,
    after: probe.after,
    stepId: window.step?.stepId ?? probe.after,
    startSeq: window.step?.startSeq ?? null,
    endSeq: window.step?.endSeq ?? null,
    messageSeqs: window.replies.map((reply) => reply.seq),
  };
}

function ruleInstruction(probe) {
  if (probe.polarity === "forbidden") {
    return "这是禁止项：只有确认回复/状态中未出现被禁止的行为才判 pass；出现即 fail；证据不足以确认时判 inconclusive。";
  }
  return "这是必需项：回复/状态满足规则要求才判 pass；明确违反判 fail；证据不足或窗口内没有可判定内容判 inconclusive。";
}

function buildRules({ context, caseEntry }) {
  const rules = [];
  const skippedRules = [];
  for (const probe of caseEntry.case.probes) {
    const rubric = RUBRIC_SPECS.find((candidate) => candidate.id === probe.rubric);
    if (!rubric) fail("rubric.unknown", `探针 ${probe.id} 的 rubric 未登记：${String(probe.rubric)}`);
    const window = resolveProbeWindow({ context, probe });
    if (!window.ok) {
      skippedRules.push({
        ruleId: probe.id,
        probeId: probe.id,
        rubric: probe.rubric,
        reason: window.reason,
        polarity: probe.polarity,
        critical: probe.critical,
        questionType: probe.questionType,
        difficulty: probe.difficulty,
        window: { mode: probe.window, after: probe.after },
      });
      continue;
    }
    rules.push({
      ruleId: probe.id,
      probeId: probe.id,
      rubric: probe.rubric,
      kind: rubric.kind,
      description: probe.description,
      expectation: formatExpectation(probe.expectation) || null,
      polarity: probe.polarity,
      critical: probe.critical,
      questionType: probe.questionType,
      difficulty: probe.difficulty,
      evidenceIds: probe.evidence ?? [],
      window: stepWindow({ window, probe }),
      instruction: ruleInstruction(probe),
    });
  }
  const quality = caseEntry.case.quality;
  const assistantSeqs = context.messages
    .filter((message) => message.origin === "assistant")
    .map((message) => message.seq);
  rules.push({
    ruleId: `quality:${quality.rubric}`,
    probeId: null,
    rubric: quality.rubric,
    kind: "quality",
    description: "全部助手回复的整体拟人化质量",
    expectation: `按 ${quality.rubric} v${quality.rubricVersion} 综合判断`,
    polarity: "required",
    critical: true,
    questionType: "quality",
    difficulty: null,
    evidenceIds: [],
    window: { mode: "all-assistant", after: null, stepId: null, startSeq: null, endSeq: null, messageSeqs: assistantSeqs },
    instruction: `综合全部助手回复，按六维整体判断：${QUALITY_DIMENSIONS.join("、")}。任一维度明显不达标判 fail；整体自然且无服务腔判 pass；回复不足或无法判断判 inconclusive。`,
  });
  return { rules, skippedRules };
}

function nextPacketId(packetDir, now) {
  const suffix = compactTimestamp(now);
  let candidate = `packet-${suffix}`;
  let index = 2;
  while (existsSync(join(packetDir, `${candidate}.packet.json`))) {
    candidate = `packet-${suffix}-${index}`;
    index += 1;
  }
  return candidate;
}

function buildPacket({ context, datasetHash, caseEntry, packetId, now }) {
  const { rules, skippedRules } = buildRules({ context, caseEntry });
  const manifest = context.manifest;
  return {
    schemaVersion: JUDGE_PACKET_SCHEMA_VERSION,
    kind: "chat-judge-packet",
    packetId,
    createdAt: now,
    attemptId: manifest.attemptId,
    caseId: caseEntry.caseId,
    suiteId: caseEntry.suiteId,
    trialId: manifest.expectedTrials?.[0]?.trialId ?? null,
    manifestSha256: context.verification.manifestSha256,
    datasetHash,
    bindings: {
      specHash: caseEntry.binding.specHash,
      oracleHash: caseEntry.binding.oracleHash,
      driverHash: caseEntry.binding.driverHash,
      fixtureHash: caseEntry.binding.fixtureHash,
    },
    versions: {
      graderVersion: CHAT_GRADER_VERSION,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      rubricVersion: JUDGE_RUBRIC_VERSION,
      datasetSchemaVersion: DATASET_SCHEMA_VERSION,
    },
    underTest: {
      requested: manifest.models?.requested ?? null,
      actual: manifest.models?.actual ?? null,
    },
    case: {
      title: caseEntry.case.title,
      goal: caseEntry.case.userRole.goal,
      tone: caseEntry.case.userRole.tone,
      knownFacts: caseEntry.case.userRole.knownFacts,
      mustNotReveal: caseEntry.case.userRole.mustNotReveal,
      allowedAlternatives: caseEntry.case.oracle.allowedAlternatives,
      quality: {
        rubric: caseEntry.case.quality.rubric,
        rubricVersion: caseEntry.case.quality.rubricVersion,
      },
      pathConstraints: caseEntry.case.pathConstraints,
      evidence: caseEntry.case.evidence,
    },
    rules,
    skippedRules,
    timeline: context.messages.map((message) => ({
      seq: message.seq,
      role: message.role,
      origin: message.origin,
      sessionId: message.sessionId,
      entryId: message.entryId,
      at: message.at,
      text: message.text,
    })),
    state: {
      before: context.before,
      after: context.after,
      capture: context.capture,
    },
    artifacts: (manifest.artifacts ?? []).map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      sha256: artifact.sha256,
    })),
    allowedEvidenceRefs: allowedEvidenceRefs({ context }),
    instructions: [
      "你是独立评测裁判，不是被测产品，也不能读取被测仓库的源码、测试期望或历史判分。",
      "只依据本包内的对话、状态、产物与规则判定；不补写证据，不修改任何文件。",
      "逐条判定 rules；skippedRules 不需要判定，运行器会记为 inconclusive。",
      "pass 表示规则要求满足；对 forbidden 规则，pass 表示未出现被禁止的行为。",
      "pass 或 fail 至少引用一条 allowedEvidenceRefs 中的证据；inconclusive 要说明缺失或冲突的证据。",
      "judge.identity 必须如实填写当前执行裁判的 platform、model 与 promptVersion；若你正是本包 underTest 中的模型，停止并报告，不要写 verdicts。",
      "输出单个 JSON 文件，字段严格按 verdictFormat；不要输出 Markdown 或额外解释。",
    ],
    verdictFormat: {
      schemaVersion: VERDICTS_SCHEMA_VERSION,
      packetId,
      packetSha256: "<packet 顶层的 packetSha256>",
      caseId: caseEntry.caseId,
      judgedAt: "ISO 时间",
      judge: {
        platform: "执行裁判的平台，例如 claude-code / codex / qoder",
        model: "执行裁判的模型标识",
        promptVersion: JUDGE_PROMPT_VERSION,
      },
      verdicts: [
        {
          ruleId: "packet.rules[].ruleId",
          verdict: "pass | fail | inconclusive",
          reason: "判定理由，必须非空",
          evidenceRefs: ["allowedEvidenceRefs 中的引用"],
        },
      ],
    },
  };
}

export function readJudgePacket({ runDir, packetId }) {
  if (typeof packetId !== "string" || !PACKET_ID_PATTERN.test(packetId)) {
    fail("packet.id", `判分包 id 不合法：${String(packetId)}`);
  }
  const packetPath = join(runDir, PACKET_DIR, `${packetId}.packet.json`);
  if (!existsSync(packetPath)) fail("packet.missing", `判分包不存在：${packetPath}`);
  const packet = readJsonFile(packetPath, "判分包");
  if (!isRecord(packet) || packet.kind !== "chat-judge-packet") fail("packet.kind", "判分包不是 chat-judge-packet");
  const { packetSha256, ...body } = packet;
  if (typeof packetSha256 !== "string" || hashCanonical(body) !== packetSha256) {
    fail("packet.hash", "判分包自身哈希不匹配");
  }
  return { packet, packetPath, packetSha256 };
}

export function prepareJudgePacket({ runDir, attemptDir, dataset, caseEntry, now = new Date().toISOString() }) {
  if (!runDir || !attemptDir) fail("packet.path", "prepareJudgePacket 需要 runDir 与 attemptDir");
  if (!dataset || !caseEntry) fail("packet.context", "准备判分包需要当前数据集与 case 条目");
  assertIsoTimestamp(now, "now");
  const context = loadJudgingContext({ attemptDir, caseEntry });
  if (context.evidenceStatus !== "complete") {
    const issues = [...context.verification.issues, ...(context.verification.integrityIssues ?? [])];
    fail("packet.evidence", `证据不完整或不可信，不能冻结判分包：${issues.join("；") || context.evidenceStatus}`);
  }
  if (context.executionStatus !== "completed") {
    fail("packet.execution", `执行状态为 ${context.executionStatus}，不能冻结判分包`);
  }
  const datasetHash = verifyDatasetBinding({ context, dataset, caseEntry });
  assertDriverNoOracleLeak({ dataset, caseEntry });
  const packetDir = join(runDir, PACKET_DIR);
  mkdirSync(packetDir, { recursive: true });
  const packetId = nextPacketId(packetDir, now);
  const body = buildPacket({ context, datasetHash, caseEntry, packetId, now });
  const packet = { ...body, packetSha256: hashCanonical(body) };
  const packetPath = join(packetDir, `${packetId}.packet.json`);
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx" });
  return {
    packet,
    packetPath,
    packetSha256: packet.packetSha256,
    skippedRules: packet.skippedRules.map((rule) => rule.ruleId),
  };
}

export function isCodingAgentPlatform(value) {
  return CODING_AGENT_PLATFORMS.includes(String(value ?? "").trim().toLowerCase());
}

/**
 * 旧版本把任何回填都写成 JUDGE_AUTHORITY，单看 authority 会把 API 判分洗成独立 judge；
 * 权威必须同时满足平台在白名单内。
 */
export function isAuthoritativeGrade(grade) {
  return grade?.authority === JUDGE_AUTHORITY
    && isCodingAgentPlatform(grade?.summary?.judge?.platform);
}

function normalizeModelName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split(",")[0]
    .trim()
    .split("/")
    .at(-1)
    .replace(/:[a-z0-9._-]+$/i, "");
}

function underTestModels(manifest) {
  const values = [manifest?.models?.actual, manifest?.models?.requested]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => normalizeModelName(value))
    .filter(Boolean);
  return unique(values);
}

function assertHeterogeneousJudge({ packet, judgeModel }) {
  const underTest = underTestModels({ models: packet.underTest });
  if (underTest.length === 0) {
    fail("judge.model-unknown", "封存证据未记录被测模型，无法核对 judge 是否异构");
  }
  const normalized = normalizeModelName(judgeModel);
  if (!normalized) fail("judge.model", "judge.model 必填");
  if (underTest.includes(normalized)) {
    fail("judge.model-self", `judge 模型必须与被测模型不同：${judgeModel}`);
  }
}

function exactKeys(record, label, required, optional = []) {
  if (!isRecord(record)) fail("verdict.shape", `${label} 必须是对象`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail("verdict.shape", `${label} 含未声明字段：${unknown.join(", ")}`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) fail("verdict.shape", `${label} 缺少字段：${missing.join(", ")}`);
}

export function validateJudgeVerdicts({ packet, verdicts }) {
  exactKeys(verdicts, "裁决文件", [
    "schemaVersion", "packetId", "packetSha256", "caseId", "judgedAt", "judge", "verdicts",
  ]);
  if (verdicts.schemaVersion !== VERDICTS_SCHEMA_VERSION) {
    fail("verdict.schema", `裁决文件 schemaVersion 必须是 ${VERDICTS_SCHEMA_VERSION}`);
  }
  if (verdicts.packetId !== packet.packetId) fail("verdict.packet", `裁决文件绑定的 packetId 不匹配：${String(verdicts.packetId)}`);
  if (verdicts.packetSha256 !== packet.packetSha256) fail("verdict.packet-hash", "裁决文件绑定的 packetSha256 不匹配");
  if (verdicts.caseId !== packet.caseId) fail("verdict.case", `裁决文件绑定的 caseId 不匹配：${String(verdicts.caseId)}`);
  assertIsoTimestamp(verdicts.judgedAt, "judgedAt");
  exactKeys(verdicts.judge, "judge", ["platform", "model", "promptVersion"]);
  for (const key of ["platform", "model", "promptVersion"]) {
    if (typeof verdicts.judge[key] !== "string" || !verdicts.judge[key].trim()) {
      fail("judge.identity", `judge.${key} 必填`);
    }
  }
  if (verdicts.judge.promptVersion !== packet.versions.judgePromptVersion) {
    fail("judge.prompt", `judge.promptVersion 必须是 ${packet.versions.judgePromptVersion}`);
  }
  if (!isCodingAgentPlatform(verdicts.judge.platform)) {
    fail(
      "judge.platform",
      `judge.platform 必须是 coding-agent 执行平台（${CODING_AGENT_PLATFORMS.join(" / ")}）：${verdicts.judge.platform}`,
    );
  }
  assertHeterogeneousJudge({ packet, judgeModel: verdicts.judge.model });
  if (!Array.isArray(verdicts.verdicts) || verdicts.verdicts.length === 0) {
    fail("verdict.empty", "裁决文件必须包含非空 verdicts 数组");
  }
  const allowedRefs = new Set(packet.allowedEvidenceRefs);
  const ruleIds = new Set(packet.rules.map((rule) => rule.ruleId));
  const seen = new Set();
  const normalized = verdicts.verdicts.map((verdict, index) => {
    const label = `verdicts[${index}]`;
    exactKeys(verdict, label, ["ruleId", "verdict", "reason", "evidenceRefs"]);
    if (typeof verdict.ruleId !== "string" || !verdict.ruleId.trim()) fail("verdict.rule", `${label}.ruleId 必填`);
    if (!ruleIds.has(verdict.ruleId)) fail("verdict.rule-unknown", `${label}.ruleId 不在判分包 rules 中：${verdict.ruleId}`);
    if (seen.has(verdict.ruleId)) fail("verdict.rule-duplicate", `规则重复裁决：${verdict.ruleId}`);
    seen.add(verdict.ruleId);
    if (!JUDGE_VERDICTS.includes(verdict.verdict)) fail("verdict.value", `${label}.verdict 非法：${String(verdict.verdict)}`);
    if (typeof verdict.reason !== "string" || !verdict.reason.trim()) fail("verdict.reason", `${label}.reason 必须非空`);
    if (!Array.isArray(verdict.evidenceRefs) || verdict.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
      fail("verdict.evidence", `${label}.evidenceRefs 必须是非空字符串数组`);
    }
    const refs = unique(verdict.evidenceRefs);
    if (refs.length !== verdict.evidenceRefs.length) fail("verdict.evidence-duplicate", `${label}.evidenceRefs 含重复引用`);
    for (const ref of refs) {
      if (!allowedRefs.has(ref)) fail("verdict.evidence-ref", `${label}.evidenceRefs 不在允许引用中：${ref}`);
    }
    if (verdict.verdict !== "inconclusive" && refs.length === 0) {
      fail("verdict.evidence-required", `${label} 判 ${verdict.verdict} 至少需要一条证据引用`);
    }
    return {
      ruleId: verdict.ruleId,
      verdict: verdict.verdict,
      reason: verdict.reason.trim(),
      evidenceRefs: refs,
    };
  });
  const missing = [...ruleIds].filter((ruleId) => !seen.has(ruleId));
  if (missing.length > 0) fail("verdict.missing", `裁决文件缺少规则：${missing.join(", ")}`);
  return {
    schemaVersion: VERDICTS_SCHEMA_VERSION,
    packetId: packet.packetId,
    packetSha256: packet.packetSha256,
    caseId: packet.caseId,
    judgedAt: verdicts.judgedAt,
    judge: {
      platform: verdicts.judge.platform.trim(),
      model: verdicts.judge.model.trim(),
      promptVersion: verdicts.judge.promptVersion,
    },
    verdicts: normalized,
  };
}

function evidenceForRef(ref, { context, byRef }) {
  if (ref.startsWith("dialogue:")) {
    const message = byRef.get(ref);
    if (!message) fail("verdict.evidence-ref", `对话引用不存在：${ref}`);
    return { ref, excerpt: excerpt(message.text) };
  }
  if (ref === "trace:trace.jsonl") return { ref, excerpt: "trace.jsonl 事件流" };
  if (ref.startsWith("state:")) {
    const name = ref.slice("state:".length);
    if (!context[name]) fail("verdict.evidence-ref", `状态引用不存在：${ref}`);
    return { ref, excerpt: `state/${name}.json 快照` };
  }
  if (ref.startsWith("artifact:")) {
    return { ref, excerpt: ref.slice("artifact:".length) };
  }
  fail("verdict.evidence-ref", `未知证据引用：${ref}`);
}

function countChecks(checks) {
  const tally = (items) => ({
    total: items.length,
    pass: items.filter((item) => item.status === "pass").length,
    fail: items.filter((item) => item.status === "fail").length,
    inconclusive: items.filter((item) => item.status === "inconclusive").length,
    not_applicable: items.filter((item) => item.status === "not_applicable").length,
  });
  return {
    total: checks.length,
    required: tally(checks.filter((item) => item.polarity === "required")),
    forbidden: tally(checks.filter((item) => item.polarity === "forbidden")),
    critical: tally(checks.filter((item) => item.critical)),
  };
}

function nextGradeId(attemptDir, now) {
  const suffix = compactTimestamp(now);
  let candidate = `judge-${suffix}`;
  let index = 2;
  while (existsSync(join(attemptDir, "grades", `${candidate}.json`))) {
    candidate = `judge-${suffix}-${index}`;
    index += 1;
  }
  return candidate;
}

function buildChecks({ packet, normalized, context }) {
  const byRef = messagesByRef(context);
  const verdictByRule = new Map(normalized.verdicts.map((verdict) => [verdict.ruleId, verdict]));
  const checks = [];
  for (const rule of packet.rules) {
    const verdict = verdictByRule.get(rule.ruleId);
    if (!verdict) fail("verdict.missing", `规则缺少裁决：${rule.ruleId}`);
    checks.push({
      ruleId: rule.ruleId,
      probeId: rule.probeId,
      rubric: rule.rubric,
      kind: rule.kind,
      status: verdict.verdict,
      reason: verdict.reason,
      evidence: verdict.evidenceRefs.map((ref) => evidenceForRef(ref, { context, byRef })),
      polarity: rule.polarity,
      critical: rule.critical,
      questionType: rule.questionType,
      difficulty: rule.difficulty,
      window: rule.window,
    });
  }
  for (const rule of packet.skippedRules) {
    checks.push({
      ruleId: rule.ruleId,
      probeId: rule.probeId,
      rubric: rule.rubric,
      kind: null,
      status: "inconclusive",
      reason: `窗口不可用：${rule.reason}`,
      evidence: [],
      polarity: rule.polarity,
      critical: rule.critical,
      questionType: rule.questionType,
      difficulty: rule.difficulty,
      window: rule.window,
    });
  }
  return checks;
}

export function applyJudgeVerdicts({
  runDir,
  attemptDir,
  dataset,
  caseEntry,
  packetId,
  verdicts,
  verdictsSha256 = null,
  now = new Date().toISOString(),
}) {
  if (!runDir || !attemptDir) fail("judge.path", "applyJudgeVerdicts 需要 runDir 与 attemptDir");
  if (!dataset || !caseEntry) fail("judge.context", "判分需要当前数据集与 case 条目");
  assertIsoTimestamp(now, "now");
  const { packet, packetPath } = readJudgePacket({ runDir, packetId });
  if (packet.caseId !== caseEntry.caseId || packet.suiteId !== caseEntry.suiteId) {
    fail("judge.packet-case", "判分包与当前 case 不匹配");
  }
  if (packet.versions.graderVersion !== CHAT_GRADER_VERSION
    || packet.versions.judgePromptVersion !== JUDGE_PROMPT_VERSION
    || packet.versions.rubricVersion !== JUDGE_RUBRIC_VERSION) {
    fail("judge.packet-version", "判分包版本与当前判分口径不一致，请重新 prepare");
  }
  const context = loadJudgingContext({ attemptDir, caseEntry });
  if (context.evidenceStatus !== "complete") fail("judge.evidence", "证据不完整或不可信，不能记录判分");
  if (context.executionStatus !== "completed") fail("judge.execution", `执行状态为 ${context.executionStatus}，不能记录判分`);
  if (context.verification.manifestSha256 !== packet.manifestSha256) {
    fail("judge.packet-attempt", "判分包绑定的 manifest 与当前 attempt 不一致");
  }
  const datasetHash = verifyDatasetBinding({ context, dataset, caseEntry });
  if (datasetHash !== packet.datasetHash) fail("judge.packet-dataset", "判分包绑定的数据集与当前数据集不一致");
  const normalized = validateJudgeVerdicts({ packet, verdicts });
  const checks = buildChecks({ packet, normalized, context });
  const counts = countChecks(checks);
  const gradeId = nextGradeId(attemptDir, now);
  const summary = {
    schemaVersion: JUDGE_PACKET_SCHEMA_VERSION,
    caseId: caseEntry.caseId,
    suiteId: caseEntry.suiteId,
    trialId: packet.trialId,
    aggregation: AGGREGATION_RULE,
    datasetHash,
    specHash: caseEntry.binding.specHash,
    oracleHash: caseEntry.binding.oracleHash,
    manifestSha256: context.verification.manifestSha256,
    packetId: packet.packetId,
    packetSha256: packet.packetSha256,
    packetPath,
    verdictsSha256: verdictsSha256 ?? hashCanonical(normalized),
    judge: normalized.judge,
    judgedAt: normalized.judgedAt,
    execution: context.executionStatus,
    evidence: context.evidenceStatus,
    counts,
    skippedRules: packet.skippedRules.map((rule) => rule.ruleId),
    quality: {
      ruleId: `quality:${caseEntry.case.quality.rubric}`,
      rubric: caseEntry.case.quality.rubric,
      rubricVersion: caseEntry.case.quality.rubricVersion,
    },
    label: caseEntry.label ?? null,
  };
  const grade = appendGrade({
    attemptDir,
    gradeId,
    createdAt: now,
    rubricVersion: JUDGE_RUBRIC_VERSION,
    graderVersion: CHAT_GRADER_VERSION,
    authority: JUDGE_AUTHORITY,
    checks,
    summary,
  });
  return {
    gradeId,
    grade,
    packet,
    checks,
    counts,
    judge: normalized.judge,
    judgedAt: normalized.judgedAt,
    skippedRules: summary.skippedRules,
  };
}

export function readJudgingRecords(attemptDir) {
  return {
    grades: readVersionedRecords(attemptDir, "grades"),
    reviews: readVersionedRecords(attemptDir, "reviews"),
  };
}

export function latestJudgeGrade(attemptDir) {
  return latestRecord(readVersionedRecords(attemptDir, "grades").filter(isAuthoritativeGrade));
}

/**
 * 只收绑定当前判分的抽查：重新判分后旧抽查仍是证据，但不能算到新判分头上；
 * 没有可信判分（gradeId 为空）时任何抽查都不成立。
 */
function latestSpotCheckMap(reviews, gradeId) {
  const latest = new Map();
  if (typeof gradeId !== "string" || gradeId === "") return latest;
  const ordered = [...reviews].sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || String(left.reviewId).localeCompare(String(right.reviewId))
  ));
  for (const review of ordered) {
    if (review.kind !== "spot-check" || review.gradeId !== gradeId) continue;
    for (const rule of review.rules ?? []) {
      if (!isRecord(rule) || typeof rule.ruleId !== "string") continue;
      if (!SPOT_CHECK_AGREEMENTS.includes(rule.agreement)) continue;
      latest.set(rule.ruleId, {
        verdict: CHECK_STATUSES.includes(rule.verdict) ? rule.verdict : "inconclusive",
        agreement: rule.agreement,
        reason: rule.reason ?? "",
        reviewId: review.reviewId,
      });
    }
  }
  return latest;
}

function spotCheckSummary({ checks, reviews, gradeId }) {
  const latest = latestSpotCheckMap(reviews, gradeId);
  const current = checks.map((check) => ({ check, spot: latest.get(check.ruleId) }));
  const checked = current.filter((item) => item.spot);
  const agreements = checked.filter((item) => item.spot.agreement === "agree").length;
  const disagreements = checked.filter((item) => item.spot.agreement === "disagree");
  return {
    status: checked.length > 0 ? "checked" : "not_checked",
    checked: checked.length,
    total: checks.length,
    coverage: checks.length > 0 ? checked.length / checks.length : 0,
    agreements,
    disagreements: disagreements.length,
    rules: checked.map((item) => ({
      ruleId: item.check.ruleId,
      judgeStatus: item.check.status,
      verdict: item.spot.verdict,
      agreement: item.spot.agreement,
      reason: item.spot.reason,
      reviewId: item.spot.reviewId,
    })),
  };
}

function overallFromChecks({ checks, evidenceStatus, executionStatus }) {
  if (evidenceStatus !== "complete") {
    return {
      status: "inconclusive",
      reason: `证据${evidenceStatus === "invalid" ? "不可信" : "不完整"}，不能给出通过结论`,
    };
  }
  if (executionStatus !== "completed") {
    return { status: "inconclusive", reason: `执行状态为 ${executionStatus}，未构成完整通过` };
  }
  const required = checks.filter((check) => check.polarity === "required" || check.polarity === "forbidden");
  const failed = required.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    return { status: "fail", reason: `存在判为 fail 的规则：${failed.map((check) => check.ruleId).join("、")}` };
  }
  const unresolved = required.filter((check) => check.status !== "pass");
  if (unresolved.length > 0) {
    return { status: "inconclusive", reason: `存在未通过的规则：${unresolved.map((check) => `${check.ruleId}=${check.status}`).join("、")}` };
  }
  return { status: "pass", reason: "全部适用规则通过" };
}

export function summarizeAttemptStatus({ caseEntry, context, grades = null, reviews = [] }) {
  const gradeRecords = grades ?? readVersionedRecords(context.attemptDir, "grades");
  const grade = latestRecord(gradeRecords.filter(isAuthoritativeGrade));
  const byRule = new Map((grade?.checks ?? []).map((check) => [check.ruleId, check]));
  const checks = caseEntry.case.probes.map((probe) => {
    const check = byRule.get(probe.id);
    return {
      ruleId: probe.id,
      probeId: probe.id,
      rubric: probe.rubric,
      status: check && CHECK_STATUSES.includes(check.status) ? check.status : "inconclusive",
      reason: check?.reason ?? "尚无判分记录",
      evidence: check?.evidence ?? [],
      polarity: probe.polarity,
      critical: probe.critical,
      questionType: probe.questionType,
      difficulty: probe.difficulty,
      window: check?.window ?? null,
    };
  });
  const quality = caseEntry.case.quality;
  const qualityRuleId = `quality:${quality.rubric}`;
  const qualityCheck = byRule.get(qualityRuleId);
  checks.push({
    ruleId: qualityRuleId,
    probeId: null,
    rubric: quality.rubric,
    status: qualityCheck && CHECK_STATUSES.includes(qualityCheck.status) ? qualityCheck.status : "inconclusive",
    reason: qualityCheck?.reason ?? "尚无判分记录",
    evidence: qualityCheck?.evidence ?? [],
    polarity: "required",
    critical: true,
    questionType: "quality",
    difficulty: null,
    window: qualityCheck?.window ?? null,
  });
  const counts = countChecks(checks);
  const checkStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.every((check) => check.status === "pass")
      ? "pass"
      : "inconclusive";
  const overall = overallFromChecks({
    checks,
    evidenceStatus: context.evidenceStatus,
    executionStatus: context.executionStatus,
  });
  return {
    schemaVersion: JUDGING_SCHEMA_VERSION,
    aggregation: AGGREGATION_RULE,
    execution: context.executionStatus,
    evidence: context.evidenceStatus,
    judge: grade
      ? {
          gradeId: grade.gradeId,
          judgedAt: grade.summary?.judgedAt ?? grade.createdAt,
          packetId: grade.summary?.packetId ?? null,
          platform: grade.summary?.judge?.platform ?? null,
          model: grade.summary?.judge?.model ?? null,
          promptVersion: grade.summary?.judge?.promptVersion ?? null,
        }
      : null,
    check: {
      status: grade ? checkStatus : "inconclusive",
      counts: {
        required: counts.required,
        forbidden: counts.forbidden,
        critical: counts.critical,
      },
    },
    spotCheck: spotCheckSummary({ checks, reviews, gradeId: grade?.gradeId ?? null }),
    overall,
    gold: caseEntry.label?.tier === "gold",
    label: caseEntry.label ?? null,
    gradeId: grade?.gradeId ?? null,
    checks,
  };
}

function nextReviewId(attemptDir, now) {
  const suffix = compactTimestamp(now);
  let candidate = `${REVIEW_ID_PREFIX}-${suffix}`;
  let index = 2;
  while (existsSync(join(attemptDir, "reviews", `${candidate}.json`))) {
    candidate = `${REVIEW_ID_PREFIX}-${suffix}-${index}`;
    index += 1;
  }
  return candidate;
}

function normalizeSpotChecks({ checks, grade }) {
  if (!Array.isArray(checks) || checks.length === 0) fail("spot.empty", "抽查至少需要一条规则");
  const judgeChecks = new Map((grade.checks ?? []).map((check) => [check.ruleId, check]));
  const seen = new Set();
  return checks.map((item, index) => {
    const label = `checks[${index}]`;
    exactKeys(item, label, ["ruleId", "verdict", "agreement"], ["reason", "evidenceRefs"]);
    if (typeof item.ruleId !== "string" || !item.ruleId.trim()) fail("spot.rule", `${label}.ruleId 必填`);
    const ruleId = item.ruleId.trim();
    if (seen.has(ruleId)) fail("spot.rule-duplicate", `抽查规则重复：${ruleId}`);
    seen.add(ruleId);
    const judgeCheck = judgeChecks.get(ruleId);
    if (!judgeCheck) fail("spot.rule-unknown", `规则不在最新判分中：${ruleId}`);
    if (!CHECK_STATUSES.includes(item.verdict)) fail("spot.verdict", `${label}.verdict 非法：${String(item.verdict)}`);
    if (!SPOT_CHECK_AGREEMENTS.includes(item.agreement)) fail("spot.agreement", `${label}.agreement 非法：${String(item.agreement)}`);
    const same = judgeCheck.status === item.verdict;
    if (item.agreement === "agree" && !same) fail("spot.agreement-mismatch", `${ruleId} 标为 agree，但 verdict 与 judge 不同`);
    if (item.agreement === "disagree" && same) fail("spot.agreement-mismatch", `${ruleId} 标为 disagree，但 verdict 与 judge 相同`);
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (item.agreement === "disagree" && !reason) fail("spot.reason", `${ruleId} 标为 disagree 必须写明理由`);
    if (item.evidenceRefs !== undefined && (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim()))) {
      fail("spot.evidence", `${label}.evidenceRefs 必须是非空字符串数组`);
    }
    return {
      ruleId,
      verdict: item.verdict,
      agreement: item.agreement,
      reason,
      evidenceRefs: unique(item.evidenceRefs ?? []),
    };
  });
}

export function recordSpotCheck({
  attemptDir,
  reviewer,
  checks,
  notes = "",
  gradeId = null,
  now = new Date().toISOString(),
}) {
  assertIsoTimestamp(now, "now");
  if (!isRecord(reviewer) || reviewer.role !== "user" || typeof reviewer.name !== "string" || !reviewer.name.trim()) {
    fail("spot.reviewer", "抽查只能由用户本人记录，且 reviewer.name 必填");
  }
  if (typeof notes !== "string") fail("spot.notes", "notes 必须是字符串");
  const grade = latestJudgeGrade(attemptDir);
  if (!grade) fail("spot.grade", "尚无 coding-agent judge 判分记录，不能抽查");
  if (gradeId !== null && gradeId !== grade.gradeId) {
    fail("spot.grade", `抽查必须绑定最新判分 ${grade.gradeId}，实际 ${String(gradeId)}`);
  }
  const normalized = normalizeSpotChecks({ checks, grade });
  const review = appendReview({
    attemptDir,
    reviewId: nextReviewId(attemptDir, now),
    createdAt: now,
    reviewer: { role: "user", name: reviewer.name.trim() },
    verdict: "inconclusive",
    notes,
    rules: normalized.map((item) => ({
      ruleId: item.ruleId,
      verdict: item.verdict,
      reason: item.reason,
      evidenceRefs: item.evidenceRefs,
      agreement: item.agreement,
    })),
    kind: "spot-check",
    gradeId: grade.gradeId,
    binding: {
      manifestSha256: grade.attemptManifestSha256,
      datasetHash: grade.summary?.datasetHash,
      specHash: grade.summary?.specHash,
      oracleHash: grade.summary?.oracleHash,
    },
    versions: {
      graderVersion: grade.graderVersion,
      rubricVersions: [grade.rubricVersion],
    },
  });
  return {
    record: review,
    reviewId: review.reviewId,
    coverage: {
      checked: normalized.length,
      total: grade.checks?.length ?? 0,
      agreements: normalized.filter((item) => item.agreement === "agree").length,
      disagreements: normalized.filter((item) => item.agreement === "disagree").length,
    },
  };
}

export function formatJudgePacket({ packet }) {
  const lines = [];
  lines.push(`# 判分包 ${packet.packetId}`);
  lines.push("");
  lines.push(`- case：${packet.caseId}（${packet.suiteId}）`);
  lines.push(`- attempt：${packet.attemptId}`);
  lines.push(`- 封存 manifest：${packet.manifestSha256}`);
  lines.push(`- 数据集：${packet.datasetHash}`);
  lines.push(`- 版本：${packet.versions.graderVersion} / ${packet.versions.judgePromptVersion} / rubric ${packet.versions.rubricVersion}`);
  lines.push(`- 被测模型：${packet.underTest.requested ?? "?"}（实际 ${packet.underTest.actual ?? "?"}）`);
  lines.push("");
  lines.push("## 场景");
  lines.push("");
  lines.push(`- 目标：${packet.case.goal}`);
  lines.push(`- 语气：${packet.case.tone}`);
  lines.push("- 已知事实：");
  for (const fact of packet.case.knownFacts) lines.push(`  - ${fact}`);
  lines.push("");
  lines.push("## 规则");
  lines.push("");
  for (const rule of packet.rules) {
    const critical = rule.critical ? "critical" : "non-critical";
    const expectation = rule.expectation ? `；期望 ${rule.expectation}` : "";
    lines.push(`- ${rule.ruleId}（${rule.rubric} · ${rule.kind} · ${critical} · ${rule.polarity} · ${rule.window.mode}）：${rule.description}${expectation}`);
  }
  if (packet.skippedRules.length > 0) {
    lines.push("");
    lines.push("## 跳过规则（运行器记为 inconclusive）");
    lines.push("");
    for (const rule of packet.skippedRules) lines.push(`- ${rule.ruleId}：${rule.reason}`);
  }
  lines.push("");
  lines.push("## 对话");
  lines.push("");
  for (const message of packet.timeline) {
    lines.push(`- #${message.seq} ${message.role}（${message.origin}）[${message.sessionId}:${message.entryId}]：${message.text}`);
  }
  lines.push("");
  lines.push("## 证据引用");
  lines.push("");
  for (const ref of packet.allowedEvidenceRefs) lines.push(`- ${ref}`);
  lines.push("");
  lines.push("## 输出");
  lines.push("");
  lines.push("把裁决写成 verdictFormat 描述的 JSON 文件；judge.identity 如实填写；不得修改证据或判分包。");
  return lines.join("\n");
}

export const __testing = Object.freeze({
  mapDriverSteps,
  normalizeModelName,
  normalizeSpotChecks,
  underTestModels,
  latestSpotCheckMap,
  countChecks,
});
