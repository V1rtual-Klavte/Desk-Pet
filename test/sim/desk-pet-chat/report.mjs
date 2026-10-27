import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeTrials } from "./aggregate.mjs";
import { datasetInputHash, formatExpectation, MANUAL_TRIGGER_HOST_METHODS } from "./dataset.mjs";
import {
  CHAT_RETENTION_MAX_BYTES,
  CHAT_RETENTION_MAX_GROUPS,
  ChatEvidenceError,
  listChatRuns,
  readAttemptTimeline,
  readChatRunEvidence,
} from "./evidence.mjs";
import {
  CODING_AGENT_PLATFORMS,
  isAuthoritativeGrade,
  loadJudgingContext,
  resolveProbeWindow,
  summarizeAttemptStatus,
} from "./judging.mjs";

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

function readManualTriggers(attempt) {
  const artifact = attempt.manifest?.artifacts?.find((entry) => entry.path === "artifacts/driver-package.json");
  if (!artifact) return [];
  let driverPackage;
  try {
    driverPackage = JSON.parse(readFileSync(join(attempt.attemptDir, artifact.path), "utf8"));
  } catch {
    // 驱动包仅是来源说明：解析失败不阻断证据报告，原始文件仍在 manifest 产物清单中。
    return [];
  }
  const steps = Array.isArray(driverPackage?.driver) ? driverPackage.driver : [];
  return [...new Set(steps
    .filter((step) => step?.kind === "host" && MANUAL_TRIGGER_HOST_METHODS.includes(step.method))
    .map((step) => step.method))];
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
  const manualTriggers = readManualTriggers(attempt);
  if (manualTriggers.length > 0) {
    lines.push(`- 手工触发：${manualTriggers.join("、")}（由评测驱动直接调用组件入口；不代表自然受理、调度或实际 UI 显示）`);
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
  const judgeLine = status.judge
    ? `- 判分：全部适用规则由独立 coding-agent judge（${status.judge.platform} / ${status.judge.model} / ${status.judge.promptVersion}）判定；用户抽查为可选核对，不改变总判定。`
    : "- 判分：尚无权威判分；只有 coding-agent 平台回填的裁决才作为结论，用户抽查为可选核对，不改变总判定。";
  const lines = ["### 检查对照", "", `- 聚合：${status.aggregation}；仅按同一份封存证据与判分记录重建，未在报告里另算分数。`, judgeLine, ""];
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
      ? attempt.grades.map((grade) => `- ${grade.gradeId} · ${grade.authority}${isAuthoritativeGrade(grade) ? "" : ` · 非权威（平台 ${grade.summary?.judge?.platform ?? "?"} 不在 coding-agent 白名单）`} · rubric ${grade.rubricVersion} · ${grade.createdAt} · judge ${grade.summary?.judge?.platform ?? "?"}/${grade.summary?.judge?.model ?? "?"} · packet ${grade.summary?.packetId ?? "?"} · 绑定 ${grade.attemptManifestSha256}`)
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

function buildAttemptView({ attempt, dataset }) {
  const { entry: caseEntry, issue: caseIssue } = resolveCaseEntry({ dataset, manifest: attempt.manifest });
  let context = null;
  let status = null;
  let error = null;
  if (caseEntry && attempt.verification.status === "complete") {
    try {
      context = loadJudgingContext({ attemptDir: attempt.attemptDir, caseEntry });
      status = summarizeAttemptStatus({
        caseEntry,
        context,
        grades: attempt.grades,
        reviews: attempt.reviews,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  const evidence = status?.evidence
    ?? (attempt.manifest ? (attempt.verification.status === "complete" ? "complete" : "incomplete") : "missing");
  return { attempt, caseEntry, caseIssue, context, status, error, evidence };
}

function tableCell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
}

function renderTrialTable(aggregate) {
  const lines = [
    "| trial | attempt | 证据 | 执行 | 单 trial 结论 |",
    "|---|---|---|---|---|",
  ];
  for (const slot of aggregate.slots) {
    lines.push([
      `| ${tableCell(slot.trialId)}`,
      tableCell(slot.attemptId),
      tableCell(slot.evidence),
      tableCell(slot.execution),
      slot.overall ? tableCell(`${slot.overall.status} — ${clip(slot.overall.reason, 80)}`) : "—",
    ].join(" | ") + " |");
  }
  return lines;
}

function renderRuleMatrix(aggregate) {
  const headers = aggregate.slots.map((slot, index) => tableCell(`#${index + 1}/${slot.attemptId ?? "缺失"}`));
  const lines = [
    `| 规则 | critical | ${headers.join(" | ")} | pass^k |`,
    `|---|---|${aggregate.slots.map(() => "---").join("|")}|---|`,
  ];
  for (const rule of aggregate.rules) {
    lines.push([
      `| ${tableCell(rule.ruleId)}`,
      rule.critical ? "yes" : "no",
      ...rule.cells.map((cell) => cell.status),
      rule.passK.status,
    ].join(" | ") + " |");
  }
  return lines;
}

function renderAggregate({ aggregate }) {
  const lines = [
    "### 多 trial 聚合",
    "",
    `- 计划：${aggregate.plan.plannedTrials} 个 trial（${aggregate.plan.source === "frozen" ? "运行前冻结" : "无冻结计划，按实际 attempt"}）；实际 ${aggregate.actualTrials} 个非修复 attempt`,
    `- 聚合规则：${aggregate.aggregation}`,
    `- 总判定：${aggregate.overall.status} — ${clip(aggregate.overall.reason)}`,
    "",
  ];
  if (aggregate.slots.length > 0) lines.push(...renderTrialTable(aggregate), "");
  if (aggregate.rules.length > 0) lines.push("#### 规则矩阵", "", ...renderRuleMatrix(aggregate), "");
  lines.push("#### critical pass^k", "");
  if (aggregate.criticalPassK.rules.length === 0) {
    lines.push("- 无 critical 规则可计算。");
  } else {
    for (const rule of aggregate.criticalPassK.rules) {
      lines.push(`- ${rule.ruleId}：${rule.status} — ${clip(rule.reason)}`);
    }
  }
  lines.push("");
  const nonCritical = aggregate.rules.filter((rule) => !rule.critical);
  if (nonCritical.length > 0) {
    lines.push("#### 非 critical 分布（仅展示，不参与总判定）", "");
    for (const rule of nonCritical) {
      const counts = rule.counts;
      lines.push(`- ${rule.ruleId}：pass=${counts.pass} fail=${counts.fail} inconclusive=${counts.inconclusive} not_applicable=${counts.not_applicable} missing=${counts.missing}`);
    }
    lines.push("");
  }
  const identity = aggregate.judge.identities.length === 1 ? aggregate.judge.identities[0] : null;
  lines.push(
    `- 判分者：${identity
      ? `一致（${identity.model ?? "?"} / ${identity.platform ?? "?"} / ${identity.promptVersion ?? "?"}）`
      : aggregate.judge.identities.length === 0
        ? "无判分身份"
        : `不一致（${aggregate.judge.identities.map((entry) => `${entry.model ?? "?"}/${entry.platform ?? "?"}/${entry.promptVersion ?? "?"}`).join(" vs ")}）`}`,
    `- 证据引用：${aggregate.evidenceRefs.complete ? "pass/fail 规则引用齐备" : `缺少 ${aggregate.evidenceRefs.missing.length} 条（${clip(aggregate.evidenceRefs.missing.join("、"), 160)}）`}`,
  );
  if (aggregate.gates.length > 0) {
    lines.push("", "门禁问题:", ...aggregate.gates.map((issue) => `- ${issue}`));
  }
  lines.push("");
  return lines;
}

function renderAttempt({ view, run }) {
  const { attempt, caseEntry, caseIssue, context, status, error } = view;
  const lines = [];
  const label = attempt.manifest ? attempt.verification.status ?? "unknown" : "unsealed";
  lines.push(`## Attempt ${attempt.attemptId} — 证据 ${label}`, "");
  if (!attempt.manifest) {
    lines.push("尚未封存：不构成可评分证据，也不能据此报告通过。", "");
    return lines;
  }
  const manifest = attempt.manifest;
  lines.push(...renderConclusion({ attempt, run, caseEntry, caseIssue, status }));
  if (error) lines.push(`- 检查层重建失败：${error}`, "");
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
    attempt.verification.status !== "complete"
      ? "证据不完整或存在未归属事件：不能判为通过，也不能用缺失数据推断产品失败。"
      : status?.judge
        ? "证据完整性通过；结论由独立 coding-agent judge 按冻结判分包判定，用户抽查为可选且不阻塞。"
        : "证据完整性通过；尚无权威判分，未形成质量结论（API 客户端判分不构成 coding-agent 权威）。",
    "",
  );
  return lines;
}

export function renderChatReport({ runDir, generatedAt, dataset = null }) {
  assertTimestamp(generatedAt);
  const { run, workflow, plan, attempts } = readChatRunEvidence(runDir);
  const views = attempts.map((attempt) => buildAttemptView({ attempt, dataset }));
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
    `- trial 计划: ${plan ? `${plan.plannedTrials} 个（冻结于 ${plan.createdAt}）` : "未冻结"}`,
    `- 报告生成时间: ${generatedAt}`,
    "",
    "> 本报告由 run.json、attempt manifest、dialogue、trace、grades 与 reviews 重建；它不参与定义 oracle，也不作为业务真相。",
    "> 多个 attempt 时先给多 trial 聚合，再按 attempt 展开结论卡、检查对照、时间线、原始证据；缺失或未判分的状态保持原样，不补写通过。",
    `> 判分只接受 coding-agent 平台回填的裁决（${CODING_AGENT_PLATFORMS.join(" / ")}）；API 客户端判分只保留为历史记录，不构成权威结论。`,
    "> 用户抽查可选，只记录覆盖与一致性。",
    "> 审计以封存证据和稳定哈希为准，不以本视图的措辞为准。",
    "",
  ];
  if (attempts.length === 0) lines.push("尚无 attempt。", "");
  if (plan || attempts.length > 1) {
    const aggregate = summarizeTrials({
      caseEntry: views.find((view) => view.caseEntry)?.caseEntry ?? null,
      plan,
      attempts: views.map((view) => ({
        attemptId: view.attempt.attemptId,
        trialId: view.attempt.trialId,
        repair: view.attempt.repair,
        status: view.status,
        evidence: view.evidence,
        execution: view.attempt.manifest?.outcome ?? "missing",
        issues: [
          ...(view.attempt.verification.issues ?? []),
          ...(view.error ? [view.error] : []),
        ],
      })),
    });
    lines.push(...renderAggregate({ aggregate }));
  }
  for (const view of views) lines.push(...renderAttempt({ view, run }));
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
