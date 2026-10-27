/**
 * 多 trial 聚合：只消费已封存 attempt 的单 trial 判分状态，不重新判分、不改写证据。
 *
 * 口径：
 * - critical 规则按 pass^k：计划内全部 trial 都通过才算通过；任一 trial fail 判 fail；
 *   缺 trial、证据不完整、执行未完成、无判分、judge 身份缺失或不一致、pass/fail 规则
 *   没有证据引用都保持 inconclusive。
 * - 非 critical 规则只展示分布，不参与总判定。
 * - 计划由 trials.json 冻结；失败或不完整的 trial 继续占位，不能被新 trial 替换。
 */

export const TRIAL_AGGREGATION_SCHEMA_VERSION = 1;
export const TRIAL_AGGREGATION_RULE = "trial-matrix-pass^k";
export const TRIAL_CHECK_STATUSES = Object.freeze([
  "pass", "fail", "inconclusive", "not_applicable", "missing",
]);

const CHECK_STATUS_SET = new Set(TRIAL_CHECK_STATUSES);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkStatus(check) {
  const status = check?.status;
  return CHECK_STATUS_SET.has(status) ? status : "inconclusive";
}

function ruleList(caseEntry) {
  if (!caseEntry) return [];
  const rules = caseEntry.case.probes.map((probe) => ({
    ruleId: probe.id,
    rubric: probe.rubric,
    polarity: probe.polarity,
    critical: Boolean(probe.critical),
  }));
  const quality = caseEntry.case.quality;
  rules.push({
    ruleId: `quality:${quality.rubric}`,
    rubric: quality.rubric,
    polarity: "required",
    critical: true,
  });
  return rules;
}

function normalizeAttempt(attempt) {
  const status = isRecord(attempt.status) ? attempt.status : null;
  return {
    attemptId: typeof attempt.attemptId === "string" ? attempt.attemptId : null,
    trialId: typeof attempt.trialId === "string" && attempt.trialId ? attempt.trialId : null,
    repair: attempt.repair === true,
    status,
    evidence: status?.evidence ?? attempt.evidence ?? "missing",
    execution: status?.execution ?? attempt.execution ?? "missing",
    judge: status?.judge ?? null,
    checks: Array.isArray(status?.checks) ? status.checks : [],
    attemptIssues: Array.isArray(attempt.issues) ? attempt.issues : [],
  };
}

function emptyCounts() {
  const counts = { pass: 0, fail: 0, inconclusive: 0, not_applicable: 0, missing: 0 };
  return counts;
}

function countStatus(counts, status) {
  counts[status] += 1;
}

function formatList(items, limit = 6) {
  if (items.length <= limit) return items.join("、");
  return `${items.slice(0, limit).join("、")}…（共 ${items.length} 项）`;
}

function slotIssues(slot) {
  if (!slot.attemptId) return ["计划中的 trial 未产生 attempt"];
  const issues = [...slot.attemptIssues];
  if (!slot.status) issues.push("无法重建判分状态（未封存或数据集不匹配）");
  if (slot.evidence !== "complete") issues.push(`证据 ${slot.evidence}`);
  if (slot.execution !== "completed") issues.push(`执行 ${slot.execution}`);
  if (!slot.judge) issues.push("缺少 coding-agent judge 判分");
  return issues;
}

function rulePassK({ cells, slots }) {
  const fails = cells.filter((cell) => cell.status === "fail");
  if (fails.length > 0) {
    return {
      status: "fail",
      reason: `存在 fail：${formatList(fails.map((cell) => cell.trialId))}`,
    };
  }
  const unresolved = [];
  for (const [index, cell] of cells.entries()) {
    const slot = slots[index];
    if (!slot.attemptId) unresolved.push(`${cell.trialId}=missing`);
    else if (slot.evidence !== "complete") unresolved.push(`${cell.trialId}=evidence:${slot.evidence}`);
    else if (slot.execution !== "completed") unresolved.push(`${cell.trialId}=execution:${slot.execution}`);
    else if (!slot.judge) unresolved.push(`${cell.trialId}=judge-missing`);
    else if (cell.status !== "pass") unresolved.push(`${cell.trialId}=${cell.status}`);
    else if (cell.evidenceRefs === 0) unresolved.push(`${cell.trialId}=no-evidence-ref`);
  }
  if (unresolved.length > 0) {
    return { status: "inconclusive", reason: `未全部通过：${formatList(unresolved)}` };
  }
  return { status: "pass", reason: `全部 ${cells.length} 个 trial 通过` };
}

function judgeSummary(slots, issues) {
  const byIdentity = new Map();
  for (const slot of slots) {
    if (!slot.attemptId || !slot.judge) continue;
    const identity = {
      platform: slot.judge.platform ?? null,
      model: slot.judge.model ?? null,
      promptVersion: slot.judge.promptVersion ?? null,
    };
    if (!identity.platform || !identity.model || !identity.promptVersion) {
      issues.push(`${slot.trialId}: judge 身份不完整`);
    }
    const key = JSON.stringify(identity);
    const entry = byIdentity.get(key) ?? { ...identity, trials: [] };
    entry.trials.push(slot.trialId);
    byIdentity.set(key, entry);
  }
  const identities = [...byIdentity.values()];
  if (slots.some((slot) => slot.attemptId && !slot.judge)) {
    issues.push("judge 身份缺失：存在未判分的 trial");
  }
  if (identities.length > 1) {
    issues.push(`judge 身份不一致：${identities.map((entry) => `${entry.model ?? "?"}/${entry.platform ?? "?"}/${entry.promptVersion ?? "?"}`).join(" vs ")}`);
  }
  return {
    consistent: identities.length === 1 && !slots.some((slot) => slot.attemptId && !slot.judge),
    identities,
  };
}

/**
 * @param {object} options
 * @param {object|null} options.caseEntry 当前数据集用例；为 null 时不重建规则，只报告计划与证据缺口
 * @param {object|null} options.plan trials.json 冻结计划
 * @param {Array<object>} options.attempts 每个 attempt 的只读视图与单 trial 判分状态
 */
export function summarizeTrials({ caseEntry, plan = null, attempts = [] }) {
  const normalized = attempts.map(normalizeAttempt);
  const nonRepair = normalized.filter((attempt) => !attempt.repair);
  const repairs = normalized.filter((attempt) => attempt.repair);
  const byTrialId = new Map();
  const duplicateTrials = [];
  const unattributed = [];
  for (const attempt of nonRepair) {
    if (!attempt.trialId) {
      unattributed.push({ attemptId: attempt.attemptId, trialId: null });
      continue;
    }
    if (byTrialId.has(attempt.trialId)) duplicateTrials.push(attempt.trialId);
    else byTrialId.set(attempt.trialId, attempt);
  }

  const plannedTrialIds = plan ? [...plan.trialIds] : nonRepair
    .filter((attempt) => attempt.trialId)
    .sort((left, right) => String(left.attemptId).localeCompare(String(right.attemptId)))
    .map((attempt) => attempt.trialId);
  const plannedSet = new Set(plannedTrialIds);
  const missingTrials = plannedTrialIds.filter((trialId) => !byTrialId.has(trialId));
  const extraTrials = nonRepair
    .filter((attempt) => attempt.trialId && !plannedSet.has(attempt.trialId))
    .map((attempt) => ({ attemptId: attempt.attemptId, trialId: attempt.trialId }));

  const slots = plannedTrialIds.map((trialId) => {
    const attempt = byTrialId.get(trialId) ?? null;
    return {
      trialId,
      attemptId: attempt?.attemptId ?? null,
      status: attempt?.status ?? null,
      evidence: attempt?.evidence ?? "missing",
      execution: attempt?.execution ?? "missing",
      judge: attempt?.judge ?? null,
      attemptIssues: attempt?.attemptIssues ?? [],
      checks: attempt?.checks ?? [],
    };
  });

  const gates = [];
  if (!plan) gates.push("没有冻结的 trial 计划：按实际 attempt 聚合，不能证明计划完整性");
  if (plan && caseEntry && plan.caseId !== caseEntry.caseId) {
    gates.push(`冻结计划用例 ${plan.caseId} 与当前用例 ${caseEntry.caseId} 不一致`);
  }
  if (missingTrials.length > 0) gates.push(`缺少计划 trial：${formatList(missingTrials)}`);
  if (extraTrials.length > 0) gates.push(`存在计划外 trial：${formatList(extraTrials.map((entry) => entry.trialId))}`);
  if (duplicateTrials.length > 0) gates.push(`同一 trialId 出现多个 attempt：${formatList([...new Set(duplicateTrials)])}`);
  if (unattributed.length > 0) gates.push(`存在无法归属 trial 的 attempt：${formatList(unattributed.map((entry) => entry.attemptId))}`);
  for (const slot of slots) {
    if (!slot.attemptId) continue;
    const issues = slotIssues(slot);
    for (const issue of issues) gates.push(`${slot.trialId}: ${issue}`);
  }
  const judge = judgeSummary(slots, gates);

  const rules = ruleList(caseEntry).map((rule) => {
    const cells = slots.map((slot) => {
      const check = slot.checks.find((candidate) => candidate?.ruleId === rule.ruleId) ?? null;
      return {
        trialId: slot.trialId,
        attemptId: slot.attemptId,
        status: checkStatus(check),
        reason: check?.reason ?? (slot.attemptId ? "缺少该规则判分" : "缺少计划 trial"),
        evidenceRefs: Array.isArray(check?.evidence) ? check.evidence.length : 0,
      };
    });
    const counts = emptyCounts();
    for (const cell of cells) countStatus(counts, cell.status);
    const passK = rulePassK({ cells, slots });
    return { ...rule, cells, counts, passK };
  });

  const missingRefs = [];
  for (const rule of rules) {
    for (const cell of rule.cells) {
      if ((cell.status === "pass" || cell.status === "fail") && cell.evidenceRefs === 0) {
        missingRefs.push(`${cell.trialId}/${rule.ruleId}`);
      }
    }
  }
  if (missingRefs.length > 0) {
    gates.push(`pass/fail 规则缺少证据引用：${formatList(missingRefs)}`);
  }

  const criticalRules = rules.filter((rule) => rule.critical);
  let overall;
  if (!caseEntry) {
    overall = { status: "inconclusive", reason: "缺少当前数据集用例：不重建 critical pass^k 结论" };
  } else if (gates.length > 0) {
    overall = { status: "inconclusive", reason: gates.join("；") };
  } else if (criticalRules.some((rule) => rule.passK.status === "fail")) {
    overall = {
      status: "fail",
      reason: `critical 规则存在 fail：${criticalRules.filter((rule) => rule.passK.status === "fail").map((rule) => rule.ruleId).join("、")}`,
    };
  } else if (criticalRules.length === 0) {
    overall = { status: "inconclusive", reason: "没有 critical 规则可计算 pass^k" };
  } else if (criticalRules.every((rule) => rule.passK.status === "pass")) {
    overall = { status: "pass", reason: `全部 ${plannedTrialIds.length} 个 trial 的 critical 规则通过（pass^${plannedTrialIds.length}）` };
  } else {
    overall = {
      status: "inconclusive",
      reason: `critical 规则未全部通过：${criticalRules.filter((rule) => rule.passK.status !== "pass").map((rule) => `${rule.ruleId}=${rule.passK.status}`).join("、")}`,
    };
  }

  return {
    schemaVersion: TRIAL_AGGREGATION_SCHEMA_VERSION,
    aggregation: TRIAL_AGGREGATION_RULE,
    plan: {
      source: plan ? "frozen" : "actual",
      plannedTrials: plannedTrialIds.length,
      trialIds: plannedTrialIds,
      ...(plan ? { budgetTrials: plan.budgetTrials, createdAt: plan.createdAt } : {}),
    },
    actualTrials: nonRepair.length,
    repairAttempts: repairs.map((attempt) => ({ attemptId: attempt.attemptId, trialId: attempt.trialId })),
    slots: slots.map((slot) => ({
      trialId: slot.trialId,
      attemptId: slot.attemptId,
      evidence: slot.evidence,
      execution: slot.execution,
      judge: slot.judge,
      overall: slot.status?.overall ?? null,
      issues: slotIssues(slot),
    })),
    missingTrials,
    extraTrials,
    unattributed,
    duplicateTrials: [...new Set(duplicateTrials)],
    rules,
    criticalPassK: {
      k: plannedTrialIds.length,
      status: overall.status,
      reason: overall.reason,
      rules: criticalRules.map((rule) => ({
        ruleId: rule.ruleId,
        status: rule.passK.status,
        reason: rule.passK.reason,
      })),
    },
    judge,
    evidenceRefs: { complete: missingRefs.length === 0, missing: missingRefs },
    gates,
    overall,
  };
}
