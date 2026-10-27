// ==========================================
// 聊天多试次 — trial 计划冻结、跨 attempt 聚合与报告
// ==========================================
//
// 只验证计划与聚合的判定层：不启宿主、不判分、不读凭据。
// 真实试次由 runner 采集；这里用最小 run／attempt 与显式构造的判分状态做反例。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeTrials } from "../../sim/desk-pet-chat/aggregate.mjs";
import {
  ChatEvidenceError,
  TRIAL_PLAN_FILE,
  beginChatAttempt,
  createChatRun,
  ensureTrialPlan,
  readChatRunEvidence,
  readTrialPlan,
  setChatRunPhase,
} from "../../sim/desk-pet-chat/evidence.mjs";
import { renderChatReport } from "../../sim/desk-pet-chat/report.mjs";
// @ts-expect-error TS7016 —— 开发脚本没有声明文件，运行期形状由本文件的断言钉住。
import { batchTrialId, batchTrialRunId, planTrialBatch } from "../../../scripts/sim-eval-run.mjs";

const START = "2026-10-27T09:00:00.000+08:00";
const REPORTED = "2026-10-27T10:00:00.000+08:00";
const CASE_ID = "multi-trial-case";
const QUALITY_RULE = "quality:humanizer-six-dimensions";
const HASH = `sha256:${"a".repeat(64)}`;
const JUDGE = { platform: "qoder", model: "judge/model-x", promptVersion: "judge-prompt@1" };
const OTHER_JUDGE = { platform: "qoder", model: "judge/model-y", promptVersion: "judge-prompt@1" };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-chat-trials-"));
  roots.push(root);
  return root;
}

function makeRun(reportsDir: string, name = "run-trials") {
  const { runDir } = createChatRun({
    reportsDir,
    evaluationRunId: name,
    createdAt: START,
    scope: { suiteIds: ["daily-companionship"], caseIds: [CASE_ID], purpose: "regression", holdout: false },
    budget: { trials: 5, messages: 20, tokens: 1000, minutes: 30, repairs: 0 },
  });
  setChatRunPhase(runDir, { phase: "collecting", updatedAt: START });
  return runDir;
}

function identity(repair: Record<string, unknown> | null = null) {
  return {
    code: { commit: "abc1234", sourceHash: HASH, dirty: false },
    inputs: { datasetHash: HASH, fixtureHash: HASH, cardHash: HASH, configHash: HASH },
    tools: { driverVersion: "driver-1", rubricVersion: "rubric-1", graderVersion: "grader-1" },
    host: { mode: "full-desktop", capabilities: ["chat", "memory", "session"] },
    platform: { os: "darwin", arch: "arm64" },
    runtime: { version: "22.22.3" },
    models: { requested: "provider/model-a" },
    budget: { trials: 5, messages: 20, tokens: 1000, minutes: 30, repairs: 0 },
    ...(repair ? { repair } : {}),
  } as any;
}

function makePlan(runDir: string, trialIds: string[], evaluationRunId = "run-trials") {
  return ensureTrialPlan({
    runDir,
    evaluationRunId,
    caseId: CASE_ID,
    trialIds,
    budgetTrials: 5,
    authorizationFingerprint: HASH,
    createdAt: START,
  }).plan;
}

function caseEntry() {
  return {
    caseId: CASE_ID,
    label: { tier: "silver", status: "pending" },
    case: {
      probes: [
        { id: "p-core", rubric: "answer.core", polarity: "required", critical: true },
        { id: "p-style", rubric: "humanizer.style", polarity: "required", critical: false },
      ],
      quality: { rubric: "humanizer-six-dimensions", rubricVersion: 1 },
    },
  } as any;
}

function judgeStatus(ruleStatuses: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const checks = [
    { ruleId: "p-core", rubric: "answer.core", status: ruleStatuses["p-core"] ?? "pass", reason: "核心结论", evidence: [{ ref: "dialogue:session-1#entry-1", excerpt: "回答" }] },
    { ruleId: "p-style", rubric: "humanizer.style", status: ruleStatuses["p-style"] ?? "pass", reason: "口吻自然", evidence: [{ ref: "dialogue:session-1#entry-1", excerpt: "回答" }] },
    { ruleId: QUALITY_RULE, rubric: "humanizer-six-dimensions", status: ruleStatuses[QUALITY_RULE] ?? "pass", reason: "质量规则", evidence: [{ ref: "dialogue:session-1#entry-1", excerpt: "回答" }] },
  ];
  return {
    evidence: "complete",
    execution: "completed",
    judge: JUDGE,
    checks,
    overall: { status: "pass", reason: "全部规则通过" },
    ...overrides,
  };
}

function attemptView(trialId: string, attemptId: string, ruleStatuses: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
  return {
    attemptId,
    trialId,
    repair: false,
    status: judgeStatus(ruleStatuses, overrides),
  };
}

function trialPlan(trialIds: string[]) {
  return {
    schemaVersion: 1,
    evaluationRunId: "run-trials",
    caseId: CASE_ID,
    plannedTrials: trialIds.length,
    trialIds,
    budgetTrials: 5,
    authorizationFingerprint: HASH,
    createdAt: START,
  } as any;
}

describe("批量 trial 计划", () => {
  it("默认按授权预算计划，拒绝超预算、回收集数与非正整数 [chat-trial-plan]", () => {
    expect(planTrialBatch({ budgetTrials: 5 })).toEqual({ plannedTrials: 5, existingAttempts: 0, newTrials: 5 });
    expect(planTrialBatch({ requestedTrials: 3, budgetTrials: 5 })).toEqual({ plannedTrials: 3, existingAttempts: 0, newTrials: 3 });
    expect(planTrialBatch({ requestedTrials: 5, existingAttempts: 2, budgetTrials: 5 })).toEqual({ plannedTrials: 5, existingAttempts: 2, newTrials: 3 });
    expect(() => planTrialBatch({ requestedTrials: 6, budgetTrials: 5 })).toThrow(/超过授权预算/);
    expect(() => planTrialBatch({ requestedTrials: 1, existingAttempts: 2, budgetTrials: 5 })).toThrow(/不能回收/);
    expect(() => planTrialBatch({ requestedTrials: 0, budgetTrials: 5 })).toThrow(/正整数/);
    expect(() => planTrialBatch({ requestedTrials: 2.5, budgetTrials: 5 })).toThrow(/正整数/);
    expect(() => planTrialBatch({ budgetTrials: 0 })).toThrow(/预算/);
    expect(() => planTrialBatch({ requestedTrials: 2, existingAttempts: -1, budgetTrials: 5 })).toThrow(/非负整数/);
  });

  it("派生稳定且不截断碰撞的 trial 与子运行 id [chat-trial-plan-ids]", () => {
    const evaluationRunId = `batch-${"x".repeat(50)}-a`;
    const other = `batch-${"x".repeat(50)}-b`;
    expect(evaluationRunId.length).toBeLessThanOrEqual(64);
    expect(batchTrialId(evaluationRunId, 1)).toBe(batchTrialId(evaluationRunId, 1));
    expect(batchTrialId(evaluationRunId, 1)).not.toBe(batchTrialId(evaluationRunId, 2));
    expect(batchTrialId(evaluationRunId, 1)).not.toBe(batchTrialId(other, 1));
    expect(batchTrialRunId(evaluationRunId, 1)).not.toBe(batchTrialRunId(other, 1));
    expect(batchTrialId(evaluationRunId, 9).length).toBeLessThanOrEqual(96);
    expect(batchTrialRunId(evaluationRunId, 9).length).toBeLessThanOrEqual(48);
    expect(() => batchTrialId(evaluationRunId, 0)).toThrow(/正整数/);
    expect(() => batchTrialRunId(evaluationRunId, 1.5)).toThrow(/正整数/);
  });

  it("trials.json 首次写入后冻结，重放同计划复用而不覆盖 [chat-trial-plan-frozen]", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    const first = ensureTrialPlan({
      runDir,
      evaluationRunId: "run-trials",
      caseId: CASE_ID,
      trialIds: ["t-1", "t-2", "t-3"],
      budgetTrials: 5,
      authorizationFingerprint: HASH,
      createdAt: START,
    });
    expect(first.created).toBe(true);
    expect(readTrialPlan(runDir)).toEqual(first.plan);
    const stored = readFileSync(join(runDir, TRIAL_PLAN_FILE), "utf8");

    const again = ensureTrialPlan({
      runDir,
      evaluationRunId: "run-trials",
      caseId: CASE_ID,
      trialIds: ["t-1", "t-2", "t-3"],
      budgetTrials: 5,
      authorizationFingerprint: HASH,
      createdAt: "2026-10-27T09:30:00.000+08:00",
    });
    expect(again.created).toBe(false);
    expect(again.plan.createdAt).toBe(START);
    expect(readFileSync(join(runDir, TRIAL_PLAN_FILE), "utf8")).toBe(stored);

    expect(() => ensureTrialPlan({
      runDir,
      evaluationRunId: "run-trials",
      caseId: CASE_ID,
      trialIds: ["t-1", "t-2"],
      budgetTrials: 5,
      authorizationFingerprint: HASH,
      createdAt: START,
    })).toThrow(/已冻结/);
    expect(() => ensureTrialPlan({
      runDir,
      evaluationRunId: "run-trials",
      caseId: CASE_ID,
      trialIds: ["t-1", "t-2", "t-4"],
      budgetTrials: 5,
      authorizationFingerprint: HASH,
      createdAt: START,
    })).toThrow(/trialIds 不能改写/);
  });

  it("篡改计划数量、预算或授权指纹会被读取时拒绝 [chat-trial-plan-tamper]", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    makePlan(runDir, ["t-1", "t-2"]);
    const path = join(runDir, TRIAL_PLAN_FILE);

    const cases: Array<[string, (plan: any) => void, RegExp]> = [
      ["trialIds 数量", (plan) => { plan.trialIds = ["t-1"]; }, /trialIds 数量/],
      ["重复 trialId", (plan) => { plan.trialIds = ["t-1", "t-1"]; }, /不能重复/],
      ["超预算", (plan) => { plan.plannedTrials = 6; plan.trialIds = ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"]; }, /超过授权预算/],
      ["授权指纹", (plan) => { plan.authorizationFingerprint = "not-a-hash"; }, /authorizationFingerprint/],
      ["未知字段", (plan) => { plan.extra = true; }, /未知字段/],
    ];
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const [label, change, expected] of cases) {
      const tampered = structuredClone(original);
      change(tampered);
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
      expect(() => readTrialPlan(runDir), label).toThrow(expected);
    }
  });

  it("证据视图按计划槽位读取 trialId，并把修复 attempt 单独标记 [chat-trial-plan-evidence]", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    makePlan(runDir, ["t-1", "t-2"]);
    beginChatAttempt({
      runDir,
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "t-1" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    beginChatAttempt({
      runDir,
      identity: identity({ ofRunId: "run-original", index: 1 }),
      expectedTrials: [{ caseId: CASE_ID, trialId: "t-repair" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    const evidence = readChatRunEvidence(runDir);
    expect(evidence.plan?.trialIds).toEqual(["t-1", "t-2"]);
    expect(evidence.attempts.map((attempt) => [attempt.trialId, attempt.repair, attempt.verification.status]))
      .toEqual([["t-1", false, "unsealed"], ["t-repair", true, "unsealed"]]);
  });
});

describe("多 trial 聚合", () => {
  it("全部计划 trial 的 critical 规则通过才判 pass，非 critical 不进总判定 [chat-trial-aggregate]", () => {
    const result = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2", "t-3"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", { "p-style": "fail" }),
        attemptView("t-3", "0003"),
      ],
    });

    expect(result.aggregation).toBe("trial-matrix-pass^k");
    expect(result.plan).toMatchObject({ source: "frozen", plannedTrials: 3 });
    expect(result.actualTrials).toBe(3);
    expect(result.missingTrials).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(result.criticalPassK).toMatchObject({ k: 3, status: "pass" });
    expect(result.overall.status).toBe("pass");
    expect(result.overall.reason).toContain("pass^3");
    const style = result.rules.find((rule: any) => rule.ruleId === "p-style")!;
    expect(style.critical).toBe(false);
    expect(style.counts.fail).toBe(1);
  });

  it("任一 trial 的 critical 规则 fail 直接判 fail，并指出 trial", () => {
    const result = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2", "t-3"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", { "p-core": "fail" }),
        attemptView("t-3", "0003"),
      ],
    });

    expect(result.overall.status).toBe("fail");
    expect(result.overall.reason).toContain("p-core");
    const core = result.rules.find((rule: any) => rule.ruleId === "p-core")!;
    expect(core.passK.status).toBe("fail");
    expect(core.passK.reason).toContain("t-2");
  });

  it("缺计划 trial、证据不完整、执行未完成或无判分都保持 inconclusive", () => {
    const missing = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2", "t-3"]),
      attempts: [attemptView("t-1", "0001"), attemptView("t-2", "0002")],
    });
    expect(missing.overall.status).toBe("inconclusive");
    expect(missing.gates.join("\n")).toContain("缺少计划 trial：t-3");

    const incomplete = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", {}, { evidence: "inconclusive" }),
      ],
    });
    expect(incomplete.overall.status).toBe("inconclusive");
    expect(incomplete.gates.join("\n")).toContain("t-2: 证据 inconclusive");

    const interrupted = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", {}, { execution: "interrupted" }),
      ],
    });
    expect(interrupted.overall.status).toBe("inconclusive");
    expect(interrupted.gates.join("\n")).toContain("t-2: 执行 interrupted");

    const ungraded = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", {}, { judge: null }),
      ],
    });
    expect(ungraded.overall.status).toBe("inconclusive");
    expect(ungraded.gates.join("\n")).toContain("t-2: 缺少 coding-agent judge 判分");
  });

  it("judge 身份不一致或 pass/fail 没有证据引用都不能算通过", () => {
    const judges = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002", {}, { judge: OTHER_JUDGE }),
      ],
    });
    expect(judges.overall.status).toBe("inconclusive");
    expect(judges.gates.join("\n")).toContain("judge 身份不一致");
    expect(judges.judge.consistent).toBe(false);

    const noRefs = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        {
          attemptId: "0002",
          trialId: "t-2",
          repair: false,
          status: {
            ...judgeStatus({}),
            checks: judgeStatus({}).checks.map((check: any) => ({ ...check, evidence: [] })),
          },
        },
      ],
    });
    expect(noRefs.overall.status).toBe("inconclusive");
    expect(noRefs.evidenceRefs.complete).toBe(false);
    expect(noRefs.gates.join("\n")).toContain("pass/fail 规则缺少证据引用");
  });

  it("修复 attempt 不占计划名额，也不覆盖同 trialId 的正式证据", () => {
    const result = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002"),
        { attemptId: "0003", trialId: "t-repair", repair: true, status: judgeStatus({ "p-core": "fail" }) },
      ],
    });
    expect(result.repairAttempts).toEqual([{ attemptId: "0003", trialId: "t-repair" }]);
    expect(result.actualTrials).toBe(2);
    expect(result.overall.status).toBe("pass");
  });

  it("计划外、重复与无法归属的 attempt 都进 gate，不能悄悄并入 pass^k", () => {
    const result = summarizeTrials({
      caseEntry: caseEntry(),
      plan: trialPlan(["t-1", "t-2"]),
      attempts: [
        attemptView("t-1", "0001"),
        attemptView("t-2", "0002"),
        attemptView("t-extra", "0003"),
        attemptView("t-1", "0004"),
        { attemptId: "0005", trialId: null, repair: false, status: judgeStatus({}) },
      ],
    });
    expect(result.extraTrials).toEqual([{ attemptId: "0003", trialId: "t-extra" }]);
    expect(result.duplicateTrials).toEqual(["t-1"]);
    expect(result.unattributed).toEqual([{ attemptId: "0005", trialId: null }]);
    expect(result.overall.status).toBe("inconclusive");
    expect(result.gates.join("\n")).toMatch(/计划外 trial/);
    expect(result.gates.join("\n")).toMatch(/同一 trialId 出现多个 attempt/);
    expect(result.gates.join("\n")).toMatch(/无法归属 trial/);
  });

  it("没有冻结计划时按实际 attempt 聚合，但明确标记不能证明计划完整性", () => {
    const result = summarizeTrials({
      caseEntry: caseEntry(),
      plan: null,
      attempts: [attemptView("t-1", "0001"), attemptView("t-2", "0002")],
    });
    expect(result.plan.source).toBe("actual");
    expect(result.overall.status).toBe("inconclusive");
    expect(result.gates.join("\n")).toContain("没有冻结的 trial 计划");
  });
});

describe("多 trial 报告", () => {
  it("报告先给聚合再按 attempt 展开，缺 trial 与未封存都保持原样", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    makePlan(runDir, ["t-1", "t-2", "t-3"]);
    for (const trialId of ["t-1", "t-2"]) {
      beginChatAttempt({
        runDir,
        identity: identity(),
        expectedTrials: [{ caseId: CASE_ID, trialId }],
        expectedSessions: ["session-1"],
        createdAt: START,
      });
    }
    setChatRunPhase(runDir, {
      phase: "blocked",
      updatedAt: START,
      pendingDecision: { kind: "trial_incomplete", reason: "t-3 缺证据" },
      nextAction: "补齐计划试次",
    });

    const markdown = renderChatReport({ runDir, generatedAt: REPORTED, dataset: null });
    expect(markdown).toContain("- trial 计划: 3 个（冻结于");
    expect(markdown).toContain("### 多 trial 聚合");
    expect(markdown).toContain("| trial | attempt | 证据 | 执行 | 单 trial 结论 |");
    expect(markdown).toContain("缺少计划 trial：t-3");
    expect(markdown).toContain("#### critical pass^k");
    expect(markdown).toContain("## Attempt 0001 — 证据 unsealed");
    expect(markdown).toContain("尚未封存：不构成可评分证据，也不能据此报告通过。");
    expect(markdown).not.toContain("总判定：pass");
  });

  it("没有冻结计划且只有一个 attempt 时不渲染多 trial 聚合段", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    beginChatAttempt({
      runDir,
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "t-1" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    const markdown = renderChatReport({ runDir, generatedAt: REPORTED, dataset: null });
    expect(markdown).toContain("- trial 计划: 未冻结");
    expect(markdown).not.toContain("### 多 trial 聚合");
  });
});

describe("ChatEvidenceError 形状", () => {
  it("计划错误保留稳定 code", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir);
    makePlan(runDir, ["t-1"]);
    try {
      ensureTrialPlan({
        runDir,
        evaluationRunId: "run-trials",
        caseId: CASE_ID,
        trialIds: ["t-2"],
        budgetTrials: 5,
        authorizationFingerprint: HASH,
        createdAt: START,
      });
      expect.unreachable("应当拒绝改写计划");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatEvidenceError);
      expect((error as ChatEvidenceError).code).toBe("plan.frozen");
    }
  });
});
