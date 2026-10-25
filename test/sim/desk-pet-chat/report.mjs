import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_RETENTION_MAX_BYTES,
  CHAT_RETENTION_MAX_GROUPS,
  ChatEvidenceError,
  listChatRuns,
  readChatRunEvidence,
} from "./evidence.mjs";

/** 人读视图与聊天运行池保留策略；结论只引用已封存证据，不反向定义 oracle。 */

const ACTIVE_PHASES = new Set([
  "preparing", "awaiting_gold_review", "ready", "running", "collecting",
  "grading", "awaiting_result_review", "repairing", "blocked",
]);

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

function renderAttempt(attempt) {
  const lines = [];
  const label = attempt.manifest ? attempt.verification.status ?? "unknown" : "unsealed";
  lines.push(`### attempt ${attempt.attemptId} — 证据 ${label}`);
  if (!attempt.manifest) {
    lines.push("", "尚未封存：不构成可评分证据，也不能据此报告通过。", "");
    return lines;
  }
  const manifest = attempt.manifest;
  lines.push(
    "",
    `- outcome: ${manifest.outcome}`,
    `- 封存时间: ${manifest.sealedAt}`,
    `- 请求模型 / 实际模型: ${manifest.models?.requested ?? "?"} / ${manifest.models?.actual ?? "?"}`,
    `- 源码哈希: ${manifest.sourceHash}`,
    `- 会话: ${manifest.evidence?.dialogue?.sessions?.join(", ") || "（无）"}`,
    `- 对话条数: ${manifest.evidence?.dialogue?.messageCount ?? "未知"}`,
    `- trace 块数 / orphan 数: ${manifest.evidence?.trace?.chunkCount ?? "未知"} / ${manifest.evidence?.trace?.orphanCount ?? "未知"}`,
    `- 完整性: ${manifest.integrity?.status ?? "unknown"}`,
    "- 完整性记录:",
    formatIssues([...(attempt.verification.integrityIssues ?? []), ...(attempt.verification.issues ?? [])]),
    "",
    "产物:",
    ...(manifest.artifacts?.length
      ? manifest.artifacts.map((artifact) => `- ${artifact.role} \`${artifact.path}\` ${artifact.sha256}`)
      : ["- 无"]),
    "",
    "判分版本:",
    ...(attempt.grades.length
      ? attempt.grades.map((grade) => `- ${grade.gradeId} · ${grade.authority} · rubric ${grade.rubricVersion} · ${grade.createdAt} · 绑定 ${grade.attemptManifestSha256}`)
      : ["- 尚无可信判分"]),
    "",
    "人工裁决:",
    ...(attempt.reviews.length
      ? attempt.reviews.map((review) => `- ${review.reviewId} · ${review.verdict} · ${review.reviewer?.name ?? "?"} · ${review.createdAt} · 绑定 ${review.attemptManifestSha256}`)
      : ["- 尚无用户裁决"]),
    "",
    attempt.verification.status === "complete"
      ? "证据完整性通过；是否通过评测仍以检查器、评分与用户裁决为准。"
      : "证据不完整或存在未归属事件：不能判为通过，也不能用缺失数据推断产品失败。",
    "",
  );
  return lines;
}

export function renderChatReport({ runDir, generatedAt }) {
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
    "> 本报告由 run.json、attempt manifest、grades 与 reviews 重建；它不参与定义 oracle，也不作为业务真相。",
    "> 审计以封存证据和稳定哈希为准，不以本视图的措辞为准。",
    "",
    `## Attempts（${attempts.length}）`,
    "",
  ];
  if (attempts.length === 0) lines.push("尚无 attempt。", "");
  for (const attempt of attempts) lines.push(...renderAttempt(attempt));
  return `${lines.join("\n")}\n`;
}

export function writeChatReport({ runDir, generatedAt }) {
  const markdown = renderChatReport({ runDir, generatedAt });
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
