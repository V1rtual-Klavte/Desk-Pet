import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetInputHash, formatExpectation } from "./dataset.mjs";
import {
  CHAT_RETENTION_MAX_BYTES,
  CHAT_RETENTION_MAX_GROUPS,
  ChatEvidenceError,
  listChatRuns,
  readAttemptTimeline,
  readChatRunEvidence,
} from "./evidence.mjs";
import { loadJudgingContext, resolveProbeWindow, summarizeAttemptStatus } from "./judging.mjs";

/**
 * 同源报告：结论卡、规则对照、时间线与原始证据都从封存证据、判分包、判分记录和当前数据集重建；
 * 报告不参与定义 oracle，不手写分数表，也不把缺失证据推断成产品失败。
 */

const ACTIVE_PHASES = new Set([
  "preparing", "awaiting_gold_review", "ready", "running", "collecting",
  "grading", "awaiting_judge", "repairing", "blocked",
]);
const TIMELINE_MAX_LINES = 240;
const TEXT_MAX_CHARS = 240;
const TRACE_TEXT_MAX_CHARS = 80;
const TRACE_SUMMARY_KEYS = ["toolName", "status", "decision", "reason", "name", "taskId", "mode", "kind", "count"];
const ASSISTANT_CAP = 40;

function assertTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ChatEvidenceError("time.invalid", `generatedAt 必须是 ISO 时间：${String(value)}`);
  }
}

function inline(value) {
  return JSON.stringify(value ?? null);
}

function formatIssues(issues) {
  return issues.length ? issues.map((issue) => `  - ${issue}`).join("\n") : "  - 无";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(value, limit = TEXT_MAX_CHARS) {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function hashPrefix(value) {
  return typeof value === "string" && value.length > 19 ? `${value.slice(0, 19)}…` : (value ?? "未知");
}

function stateSummary(state) {
  if (!isRecord(state)) return "缺失";
  const sessions = Array.isArray(state.sessions) ? state.sessions.length : 0;
  const memory = isRecord(state.memory)
    ? `${Array.isArray(state.memory.items) ? state.memory.items.length : 0} 条记忆（complete=${String(state.memory.complete)}）`
    : "无记忆快照";
  const issues = Array.isArray(state.issues) ? state.issues.length : 0;
  return `${sessions} 个会话；${memory}；issues=${issues}；complete=${String(state.complete ?? "unknown")}`;
}

function resolveCaseEntry({ dataset, manifest }) {
  const caseId = manifest?.expectedTrials?.[0]?.caseId ?? null;
  if (!dataset) return { entry: null, issue: "未提供当前数据集：只显示执行与证据层，不重建检查与复核结论" };
  if (!caseId) return { entry: null, issue: "manifest 未声明 caseId" };
  const entry = dataset.cases?.find((candidate) => candidate.caseId === caseId);
  if (!entry) return { entry: null, issue: `当前数据集不含用例 ${caseId}` };
  const startedHash = manifest.identity?.inputs?.datasetHash ?? null;
  const sealedHash = manifest.inputHashes?.datasetHash ?? null;
  const currentHash = datasetInputHash(dataset, entry);
  if ((startedHash && startedHash !== currentHash) || (sealedHash && sealedHash !== currentHash)) {
    return {
      entry: null,
      issue: `数据集自采集后已变更（${startedHash ?? sealedHash} → ${currentHash}），不按当前规格重建检查结论`,
    };
  }
  return { entry, issue: null };
}

function renderConclusion({ attempt, run, caseEntry, caseIssue, status }) {
  const manifest = attempt.manifest;
  const lines = [
    "### 结论卡",
    "",
    `- case：${manifest.expectedTrials?.[0]?.caseId ?? "未知"} / trial ${manifest.expectedTrials?.[0]?.trialId ?? "未知"}`,
    `- 标签：${caseEntry ? `${caseEntry.label?.tier ?? "unknown"} / ${caseEntry.label?.status ?? "unknown"}` : "未知（未绑定当前数据集）"}`,
    `- 范围：${inline(run.scope)}`,
    `- 宿主：${manifest.identity?.host?.mode ?? "未知"}；${manifest.identity?.platform?.os ?? "?"}/${manifest.identity?.platform?.arch ?? "?"}；Node ${manifest.identity?.runtime?.version ?? "?"}`,
    `- 请求模型 / 实际模型：${manifest.models?.requested ?? "?"} / ${manifest.models?.actual ?? "?"}`,
    `- 执行 / 证据：${manifest.outcome} / ${manifest.integrity?.status ?? "unknown"}`,
  ];
  if (status) {
    const { required, forbidden, critical } = status.check.counts;
    const judge = status.judge
      ? `${status.judge.platform} / ${status.judge.model} / ${status.judge.promptVersion}（${status.judge.gradeId}）`
      : "尚无判分";
    const spot = status.spotCheck.status === "checked"
      ? `已抽查 ${status.spotCheck.checked}/${status.spotCheck.total}（一致 ${status.spotCheck.agreements}，不一致 ${status.spotCheck.disagreements}）`
      : "未抽查（可选，不阻塞）";
    lines.push(
      `- 规则：${status.check.status}（必需 ${required.pass}/${required.total} 通过，禁止项 ${forbidden.pass}/${forbidden.total} 通过，关键 ${critical.pass}/${critical.total} 通过）`,
      `- 判分者：${judge}`,
      `- 抽查：${spot}`,
      `- 总判定：${status.overall.status} — ${status.overall.reason}`,
      `- 聚合规则：${status.aggregation}；gold=${String(status.gold)}`,
    );
  } else {
    lines.push(`- 结论：${caseIssue ?? (attempt.verification.status === "complete" ? "未重建规则与判分结论" : "证据未达到完整可评分状态，不能判为通过")}`);
  }
  if (caseEntry?.case?.oracle?.allowedAlternatives?.length) {
    lines.push(`- 允许的替代：${caseEntry.case.oracle.allowedAlternatives.join("；")}`);
  }
  lines.push("");
  return lines;
}

function renderCheck({ check, probe, context, spot }) {
  const target = check.probeId ?? "quality";
  const rubric = check.rubric ? ` · ${check.rubric}` : "";
  const lines = [
    `- **${target}** — ${check.status}（${check.polarity}${check.critical ? " · critical" : ""}${rubric}${probe ? `；题型 ${probe.questionType}` : ""}）`,
  ];
  const expectation = probe ? formatExpectation(probe.expectation) : "";
  if (expectation) lines.push(`  - 期望：${expectation}`);
  if (probe) {
    const window = resolveProbeWindow({ context, probe });
    if (window.replies.length === 0) {
      lines.push(`  - 实际：该规则使用${probe.window === "state" ? "状态" : "回复"}证据${window.reason ? `（${window.reason}）` : "，见原始证据"}`);
    } else {
      lines.push("  - 实际：");
      for (const reply of window.replies.slice(0, ASSISTANT_CAP)) {
        lines.push(`    - [${reply.sessionId}:${reply.entryId}] ${clip(reply.text)}`);
      }
      if (window.replies.length > ASSISTANT_CAP) lines.push(`    - …另有 ${window.replies.length - ASSISTANT_CAP} 条，见原始证据`);
    }
  } else {
    const replies = context.messages.filter((message) => message.origin === "assistant");
    lines.push("  - 实际（全部助手回复）：");
    for (const reply of replies.slice(0, ASSISTANT_CAP)) {
      lines.push(`    - [${reply.sessionId}:${reply.entryId}] ${clip(reply.text)}`);
    }
    if (replies.length > ASSISTANT_CAP) lines.push(`    - …另有 ${replies.length - ASSISTANT_CAP} 条，见原始证据`);
  }
  lines.push(`  - 判分理由：${check.reason}`);
  if (check.evidence.length > 0) {
    lines.push(`  - 证据：${check.evidence.map((item) => `${item.ref}｜${clip(item.excerpt, 120)}`).join("；")}`);
  }
  if (spot) {
    lines.push(`  - 用户抽查：${spot.verdict} · ${spot.agreement}${spot.reason ? `（${spot.reason}）` : ""} · ${spot.reviewId}`);
  }
  return lines.join("\n");
}

function renderCheckLayer({ status, caseEntry, context }) {
  if (!status) return [];
  const spotByRule = new Map(status.spotCheck.rules.map((rule) => [rule.ruleId, rule]));
  const lines = ["### 检查对照", "", `- 聚合：${status.aggregation}；仅按同一份封存证据与判分记录重建，未在报告里另算分数。`, `- 判分：全部适用规则由独立 coding-agent judge 判定；用户抽查为可选核对，不改变总判定。`, ""];
  const probes = new Map(caseEntry.case.probes.map((probe) => [probe.id, probe]));
  for (const check of status.checks) {
    lines.push(renderCheck({
      check,
      probe: probes.get(check.probeId) ?? null,
      context,
      spot: spotByRule.get(check.ruleId) ?? null,
    }), "");
  }
  return lines;
}

function tracePayloadSummary(payload) {
  if (!isRecord(payload)) return "";
  const parts = [];
  for (const key of TRACE_SUMMARY_KEYS) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${clip(value, TRACE_TEXT_MAX_CHARS)}`);
    }
  }
  return parts.length > 0 ? `；${parts.join(" ")}` : "";
}

function renderTimeline(timeline) {
  if (timeline.messages.length === 0 && timeline.events.length === 0) {
    return ["### 时间线", "", ...timeline.dialogueIssues.map((issue) => `- ${issue}`), "- 无可展示的时间线事件。", ""];
  }
  const items = [
    ...timeline.messages.map((message) => ({
      at: Number(message.at) || 0,
      order: 0,
      seq: message.seq,
      line: `- #${message.seq} ${message.role}（${message.origin}）[${message.sessionId}:${message.entryId}]：${clip(message.text)}`,
    })),
    ...timeline.events.map((record) => ({
      at: Number(record.event?.createdAt) || 0,
      order: 1,
      seq: record.seq,
      line: `- trace #${record.seq} ${record.event?.kind ?? "unknown"}${record.orphan ? "（orphan）" : ""}${record.trialId ? ` · trial=${record.trialId}` : ""}${tracePayloadSummary(record.event?.payload)}`,
    })),
  ].sort((left, right) => left.at - right.at || left.order - right.order || left.seq - right.seq);
  const lines = ["### 时间线", ""];
  if (items.length <= TIMELINE_MAX_LINES) {
    lines.push(...items.map((item) => item.line));
  } else {
    const half = Math.floor(TIMELINE_MAX_LINES / 2);
    lines.push(
      ...items.slice(0, half).map((item) => item.line),
      `- …省略 ${items.length - TIMELINE_MAX_LINES} 条，完整事件见 trace.jsonl`,
      ...items.slice(-half).map((item) => item.line),
    );
  }
  if (timeline.dialogueIssues.length > 0) {
    lines.push("", "对话读取问题：", ...timeline.dialogueIssues.map((issue) => `- ${issue}`));
  }
  lines.push("");
  return lines;
}

function renderRawEvidence({ attempt, context, timeline }) {
  const manifest = attempt.manifest;
  const lines = [
    "### 原始证据",
    "",
    `- 对话：${manifest.evidence?.dialogue?.messageCount ?? "未知"} 条；会话 ${manifest.evidence?.dialogue?.sessions?.join(", ") || "（无）"}`,
    `- trace：${timeline.trace.chunkCount} 块；${timeline.events.length} 事件；dropped=${timeline.trace.droppedCount}；complete=${String(timeline.trace.complete)}`,
    `- 状态：before=${stateSummary(context?.before)}；after=${stateSummary(context?.after)}`,
    `- capture：${context?.capture ? `complete=${String(context.capture.complete)}；issues=${Array.isArray(context.capture.issues) ? context.capture.issues.length : "未知"}` : "缺失"}`,
    `- 源码哈希：${manifest.sourceHash}`,
    "",
    "产物:",
    ...(manifest.artifacts?.length
      ? manifest.artifacts.map((artifact) => `- ${artifact.role} \`${artifact.path}\` ${artifact.sha256}`)
      : ["- 无"]),
    "",
    "判分记录:",
    ...(attempt.grades.length
      ? attempt.grades.map((grade) => `- ${grade.gradeId} · ${grade.authority} · rubric ${grade.rubricVersion} · ${grade.createdAt} · judge ${grade.summary?.judge?.model ?? "?"} · packet ${grade.summary?.packetId ?? "?"} · 绑定 ${grade.attemptManifestSha256}`)
      : ["- 尚无可信判分"]),
    "",
    "用户抽查:",
    ...(attempt.reviews.length
      ? attempt.reviews.map((review) => `- ${review.reviewId} · ${review.kind ?? "spot-check"} · ${review.verdict} · ${review.reviewer?.name ?? "?"} · ${review.createdAt} · 绑定 ${review.gradeId ?? "?"}`)
      : ["- 未抽查（可选）"]),
    "",
    `原始入口：\`${join(attempt.attemptDir, "dialogue.jsonl")}\`、\`${join(attempt.attemptDir, "trace.jsonl")}\`、\`${join(attempt.attemptDir, "state")}\`、\`${join(attempt.attemptDir, "artifacts")}\``,
    "",
  ];
  return lines;
}

function renderAttempt({ attempt, run, dataset }) {
  const lines = [];
  const label = attempt.manifest ? attempt.verification.status ?? "unknown" : "unsealed";
  lines.push(`## Attempt ${attempt.attemptId} — 证据 ${label}`, "");
  if (!attempt.manifest) {
    lines.push("尚未封存：不构成可评分证据，也不能据此报告通过。", "");
    return lines;
  }
  const manifest = attempt.manifest;
  const { entry: caseEntry, issue: caseIssue } = resolveCaseEntry({ dataset, manifest });
  let context = null;
  let status = null;
  if (caseEntry && attempt.verification.status === "complete") {
    try {
      context = loadJudgingContext({ attemptDir: attempt.attemptDir, caseEntry });
      status = summarizeAttemptStatus({
        caseEntry,
        context,
        grades: attempt.grades,
        reviews: attempt.reviews,
      });
    } catch (error) {
      lines.push(`- 检查层重建失败：${error instanceof Error ? error.message : String(error)}`, "");
    }
  }
  lines.push(...renderConclusion({ attempt, run, caseEntry, caseIssue, status }));
  lines.push(
    `- 封存时间：${manifest.sealedAt}`,
    `- manifest：${hashPrefix(manifest.manifestSha256)}`,
    "",
  );
  const integrityIssues = [...(attempt.verification.integrityIssues ?? []), ...(attempt.verification.issues ?? [])];
  if (integrityIssues.length > 0) {
    lines.push("证据完整性问题:", formatIssues(integrityIssues), "");
  }
  if (status && context) {
    lines.push(...renderCheckLayer({ status, caseEntry, context }));
    const timeline = readAttemptTimeline(attempt.attemptDir);
    lines.push(...renderTimeline(timeline));
    lines.push(...renderRawEvidence({ attempt, context, timeline }));
  } else if (attempt.verification.status === "complete") {
    const timeline = readAttemptTimeline(attempt.attemptDir);
    lines.push(...renderTimeline(timeline));
    lines.push(...renderRawEvidence({ attempt, context, timeline }));
  } else {
    lines.push("### 原始证据", "", `- 原始入口：\`${attempt.attemptDir}\``, "");
  }
  lines.push(
    attempt.verification.status === "complete"
      ? "证据完整性通过；结论由独立 coding-agent judge 按冻结判分包判定，用户抽查为可选且不阻塞。"
      : "证据不完整或存在未归属事件：不能判为通过，也不能用缺失数据推断产品失败。",
    "",
  );
  return lines;
}

export function renderChatReport({ runDir, generatedAt, dataset = null }) {
  assertTimestamp(generatedAt);
  const { run, workflow, attempts } = readChatRunEvidence(runDir);
  const lines = [
    `# 聊天评测运行 ${run.evaluationRunId}`,
    "",
    `- 创建顺序: ${run.createdOrder}`,
    `- 创建时间: ${run.createdAt}`,
    `- 当前阶段: ${workflow.phase}`,
    `- 待用户决定: ${inline(workflow.pendingDecision)}`,
    `- 下一步: ${workflow.nextAction ?? "（未记录）"}`,
    `- 范围: ${inline(run.scope)}`,
    `- 初始预算: ${inline(run.budget)}`,
    `- 基线: ${inline(run.baseline)}`,
    `- 报告生成时间: ${generatedAt}`,
    "",
    "> 本报告由 run.json、attempt manifest、dialogue、trace、grades 与 reviews 重建；它不参与定义 oracle，也不作为业务真相。",
    "> 四层顺序固定为结论卡、检查对照、时间线、原始证据；缺失或未判分的状态保持原样，不补写通过。",
    "> 判分由独立 coding-agent judge 按冻结判分包执行；用户抽查可选，只记录覆盖与一致性。",
    "> 审计以封存证据和稳定哈希为准，不以本视图的措辞为准。",
    "",
  ];
  if (attempts.length === 0) lines.push("尚无 attempt。", "");
  for (const attempt of attempts) lines.push(...renderAttempt({ attempt, run, dataset }));
  return `${lines.join("\n")}\n`;
}

export function writeChatReport({ runDir, generatedAt, dataset = null }) {
  const markdown = renderChatReport({ runDir, generatedAt, dataset });
  const path = join(runDir, "report.md");
  const pending = `${path}.pending`;
  writeFileSync(pending, markdown);
  renameSync(pending, path);
  return { path, markdown };
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
  }
  return total;
}

/**
 * 聊天池只按创建顺序保留五组；活跃／待审组即使超出份数也不淘汰，空间不够时整轮阻塞，
 * 不做「删了旧证据还是放不下」的部分删除。其他池（通用报告／trace bundle）政策不变。
 */
export function planChatRetention({ reportsDir, maxGroups = CHAT_RETENTION_MAX_GROUPS, maxBytes = CHAT_RETENTION_MAX_BYTES, protect = [] }) {
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) throw new ChatEvidenceError("retention.groups", "maxGroups 必须是正整数");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ChatEvidenceError("retention.bytes", "maxBytes 必须是正整数");
  const explicit = new Set(protect);
  const runs = listChatRuns(reportsDir).map((entry) => ({
    ...entry,
    bytes: directoryBytes(entry.runPath),
    protected: explicit.has(entry.evaluationRunId) || ACTIVE_PHASES.has(entry.workflow?.phase ?? ""),
  })).sort((a, b) => (b.run.createdOrder ?? 0) - (a.run.createdOrder ?? 0) || b.evaluationRunId.localeCompare(a.evaluationRunId));
  const kept = [];
  const evicted = [];
  for (const [index, entry] of runs.entries()) {
    if (index < maxGroups || entry.protected) kept.push(entry);
    else evicted.push(entry);
  }
  const reasons = [];
  let keptBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  if (keptBytes > maxBytes) {
    const newest = runs[0];
    const extra = [...kept].reverse().filter((entry) => entry !== newest && !entry.protected);
    for (const entry of extra) {
      if (keptBytes <= maxBytes) break;
      kept.splice(kept.indexOf(entry), 1);
      evicted.push(entry);
      keptBytes -= entry.bytes;
    }
    if (keptBytes > maxBytes) {
      reasons.push(`保留组占用 ${keptBytes} 字节，超过上限 ${maxBytes}；受保护或最新证据不能删除`);
      return {
        blocked: true,
        reasons,
        kept: kept.map((entry) => entry.evaluationRunId),
        evicted: [],
        keptBytes,
      };
    }
  }
  if (kept.length > maxGroups) reasons.push(`${kept.length - maxGroups} 个受保护运行超出五回上限，按保护优先保留`);
  return {
    blocked: false,
    reasons,
    kept: kept.map((entry) => entry.evaluationRunId),
    evicted: evicted.map((entry) => entry.evaluationRunId),
    keptBytes,
    evictedPaths: evicted.map((entry) => entry.runPath),
  };
}

export function pruneChatRuns({ reportsDir, maxGroups = CHAT_RETENTION_MAX_GROUPS, maxBytes = CHAT_RETENTION_MAX_BYTES, protect = [] }) {
  const plan = planChatRetention({ reportsDir, maxGroups, maxBytes, protect });
  if (plan.blocked) return plan;
  for (const path of plan.evictedPaths ?? []) {
    if (!existsSync(path)) continue;
    if (!existsSync(join(path, "run.json"))) continue;
    rmSync(path, { recursive: true, force: true });
  }
  return { ...plan, evictedPaths: undefined };
}
