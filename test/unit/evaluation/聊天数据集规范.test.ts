import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORACLE_CHECKER_SPECS,
  applyReviewDecisions,
  buildDriverPackage,
  buildReviewPackage,
  computeCaseBinding,
  formatReviewPackage,
  hashCanonical,
  loadDataset,
  resolveCaseLabel,
  summarizeDataset,
  validateApprovalRecord,
  validateCaseAgainstFixture,
  validateCaseSpec,
  validateFixtureSpec,
} from "../../sim/desk-pet-chat/dataset.mjs";

const realDataset = loadDataset();
const categoryIds = realDataset.categories.map((category) => category.id);
const questionTypeIds = realDataset.questionTypes.map((questionType) => questionType.id);
const reviewer = { role: "user" as const, name: "用户" };
const feedbackSource = {
  kind: "session_message" as const,
  sessionId: "review-session-1",
  messageId: "review-message-1",
  quote: "这个日常陪伴用例按当前内容可以冻结。",
};
const reviewedAt = "2026-10-24T22:00:00+08:00";

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-dataset-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function baseCase(): any {
  return structuredClone(realDataset.cases[0]!.case);
}

function baseFixture(): any {
  return structuredClone(realDataset.cases[0]!.fixture);
}

function makeEntry(caseSpec: any = baseCase(), fixture: any = baseFixture(), suiteId = "daily-companionship"): any {
  const binding = computeCaseBinding(caseSpec, fixture);
  return {
    caseId: caseSpec.caseId,
    suiteId,
    casePath: "",
    fixturePath: "",
    case: caseSpec,
    fixture,
    binding,
    approvals: [],
    label: resolveCaseLabel(binding, []),
  };
}

function approve(entry: any, overrides: Record<string, any> = {}) {
  const result = applyReviewDecisions({
    entries: [entry],
    decisions: [{ caseId: entry.caseId, decision: "approved" }],
    reviewer: overrides.reviewer ?? reviewer,
    feedbackSource: overrides.feedbackSource ?? feedbackSource,
    reviewedAt: overrides.reviewedAt ?? reviewedAt,
  });
  expect(result.errors).toEqual([]);
  expect(result.records).toHaveLength(1);
  return result.records[0];
}

function writeSuite(root: string, suiteId: string, caseSpec: any, fixture: any, purpose = "development") {
  const suiteDir = join(root, suiteId);
  mkdirSync(join(suiteDir, "cases"), { recursive: true });
  mkdirSync(join(suiteDir, "fixtures"), { recursive: true });
  writeFileSync(
    join(suiteDir, "suite.json"),
    JSON.stringify({
      schemaVersion: 3,
      suiteId,
      revision: 1,
      purpose,
      title: suiteId,
      caseIds: [caseSpec.caseId],
    }),
  );
  writeFileSync(
    join(suiteDir, "cases", `${caseSpec.caseId}.case.json`),
    JSON.stringify(caseSpec),
  );
  writeFileSync(
    join(suiteDir, "fixtures", `${fixture.fixtureId}.json`),
    JSON.stringify(fixture),
  );
}

describe("聊天评测数据集规范", () => {
  it("真实数据集为 schema v3，题型注册表覆盖全部分类，未审批候选只能是 silver", () => {
    const dataset = loadDataset();
    expect(dataset.errors).toEqual([]);
    expect(dataset.schemaVersion).toBe(3);
    expect(dataset.suites.map((suite) => suite.suiteId)).toEqual(["daily-companionship"]);
    expect(dataset.suites[0]!.schemaVersion).toBe(3);
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]!.caseId).toBe("saturday-companionship");
    expect(dataset.cases[0]!.suiteId).toBe("daily-companionship");
    expect(dataset.cases[0]!.case.schemaVersion).toBe(3);
    expect(dataset.cases[0]!.fixture.schemaVersion).toBe(3);
    expect(dataset.cases[0]!.case.categories).toEqual(["chat", "memory", "session", "humanizer"]);
    expect(dataset.cases[0]!.case.questionTypes).toEqual([
      "correction",
      "source",
      "style",
      "multi-turn",
      "cross-session",
      "temporal",
      "adversarial",
      "boundary",
    ]);
    expect(dataset.cases[0]!.case.source.kind).toBe("ideal");
    expect(dataset.cases[0]!.label).toEqual({
      tier: "silver",
      status: "pending",
      approvalId: null,
      reviewedAt: null,
      mismatches: [],
    });
    expect(dataset.approvals).toEqual([]);
    expect(dataset.questionTypesPath).toMatch(/question-types\.json$/);
    expect(dataset.questionTypeFamilies).toHaveLength(7);
    expect(dataset.questionTypes).toHaveLength(24);
    expect(dataset.questionTypes.map((questionType) => questionType.id)).toEqual(questionTypeIds);
    const coveredCategories = new Set(dataset.questionTypes.flatMap((questionType) => questionType.capabilities));
    for (const categoryId of categoryIds) expect(coveredCategories.has(categoryId)).toBe(true);
  });

  it("合并用例扩长为三会话多轮驱动，追问不泄露纠正答案，纠正结果不预置", () => {
    const entry = loadDataset().cases[0]!;
    const messageSteps = entry.case.driver.filter((step) => step.kind === "message");
    expect(messageSteps).toHaveLength(27);
    expect(messageSteps.map((step) => step.id)).toEqual([
      "correct-exercise",
      "tech-banter",
      "emoji-ack",
      "leave-to-play",
      "confirm",
      "return-food",
      "food-craving",
      "food-choice",
      "food-decision",
      "evening-work",
      "tired",
      "sleep",
      "morning",
      "ask-history",
      "trap",
      "clarify",
      "food-recall",
      "shopping-plan",
      "shopping-list",
      "chicken-banter",
      "cooking",
      "game",
      "goodbye",
      "c-leg-sore",
      "c-coworker-run",
      "summary",
      "close",
    ]);
    expect(entry.case.driver).toHaveLength(29);
    expect(entry.case.driver.map((step) => step.id)).toEqual([
      "correct-exercise",
      "tech-banter",
      "emoji-ack",
      "leave-to-play",
      "confirm",
      "return-food",
      "food-craving",
      "food-choice",
      "food-decision",
      "evening-work",
      "tired",
      "sleep",
      "new-session-b",
      "morning",
      "ask-history",
      "trap",
      "clarify",
      "food-recall",
      "shopping-plan",
      "shopping-list",
      "chicken-banter",
      "cooking",
      "game",
      "goodbye",
      "new-session-c",
      "c-leg-sore",
      "c-coworker-run",
      "summary",
      "close",
    ]);
    expect(
      entry.case.driver
        .filter((step) => step.kind === "host")
        .map((step) => [step.id, step.kind === "host" ? step.method : null]),
    ).toEqual([
      ["new-session-b", "chat_new_session"],
      ["new-session-c", "chat_new_session"],
    ]);

    const ask = entry.case.driver.find((step) => step.id === "ask-history");
    expect(ask?.kind).toBe("message");
    if (!ask || ask.kind !== "message") throw new Error("ask-history 必须是消息步骤");
    for (const leaked of ["一周", "经常", "骑车", "跑得老勤"]) {
      expect(ask.text).not.toContain(leaked);
    }

    const seeded = entry.fixture.initialMemory.map((memory) => memory.content).join("\n");
    const fixtureText = entry.fixture.initialSession.messages.map((message) => message.content).join("\n");
    for (const corrected of ["一周只跑一次", "经常骑车", "实习之前我跑得老勤了"]) {
      expect(seeded).not.toContain(corrected);
      expect(fixtureText).not.toContain(corrected);
    }
    expect(entry.fixture.initialMemory.map((memory) => memory.id)).toContain("fixture-memory-exercise-decline");
    expect(entry.case.checkpoints.map((checkpoint) => checkpoint.after)).toEqual([
      "correct-exercise",
      "correct-exercise",
      "new-session-b",
      "ask-history",
      "trap",
      "clarify",
      "food-recall",
      "new-session-c",
      "summary",
    ]);
    expect(entry.case.governance.unresolvedPoints.join("\n")).toMatch(/扩写|扩展/);
  });

  it("固定时钟要求每步时间戳递增，且首步不早于 fixture 时钟", () => {
    const entry = loadDataset().cases[0]!;
    expect(entry.case.precondition.time.mode).toBe("fixed");
    expect(entry.fixture.clock).toBe("2026-10-24T11:30:00+08:00");
    for (const step of entry.case.driver) expect(step.at).toMatch(/^2026-10-/);

    const missingAt = baseCase();
    delete missingAt.driver[0].at;
    expect(() => validateCaseSpec(missingAt)).toThrow(/必填/);

    const reversed = baseCase();
    reversed.driver[1].at = "2026-10-24T11:30:00+08:00";
    expect(() => validateCaseSpec(reversed)).toThrow(/升序/);

    const beforeFixture = baseCase();
    beforeFixture.driver[0].at = "2026-10-24T11:29:59+08:00";
    expect(() => validateCaseAgainstFixture(validateCaseSpec(beforeFixture), baseFixture())).toThrow(/早于/);

    const invalidAt = baseCase();
    invalidAt.driver[0].at = "2026-10-24 11:31";
    expect(() => validateCaseSpec(invalidAt)).toThrow(/时间/);
  });

  it("fixture 装载模式必须与预置动作一致，并由审阅包展示", () => {
    const fixture = baseFixture();
    expect(fixture.loading.mode).toBe("direct-seed");
    expect(fixture.allowedPreparation).toContain("seed_session");
    expect(() => validateFixtureSpec(fixture)).not.toThrow();

    const badLoading = baseFixture();
    badLoading.loading = "direct-seed";
    expect(() => validateFixtureSpec(badLoading)).toThrow(/loading 必须是对象/);

    const directWithoutSeed = baseFixture();
    directWithoutSeed.allowedPreparation = ["seed_memory"];
    expect(() => validateFixtureSpec(directWithoutSeed)).toThrow(/direct-seed/);

    const chainWithSeed = baseFixture();
    chainWithSeed.loading = { mode: "real-chain", note: "经真实导入链路装载。" };
    expect(() => validateFixtureSpec(chainWithSeed)).toThrow(/real-chain/);

    const review = buildReviewPackage(makeEntry());
    expect(review.fixture.loading).toEqual(fixture.loading);
    expect(review.trustBoundary.probeWindowScope).toBe("driver-only");
    expect(formatReviewPackage(review)).toContain("Fixture 装载：direct-seed");
  });

  it("探针难度必须是 1–5 的整数，并汇总到审阅包与数据集摘要", () => {
    const missing = baseCase();
    delete missing.probes[0].difficulty;
    expect(() => validateCaseSpec(missing)).toThrow(/缺少字段：difficulty/);

    for (const invalid of [0, 6, 1.5, "3"]) {
      const caseSpec = baseCase();
      caseSpec.probes[0].difficulty = invalid;
      expect(() => validateCaseSpec(caseSpec)).toThrow(/difficulty/);
    }

    const entry = loadDataset().cases[0]!;
    const review = buildReviewPackage(entry);
    expect(review.difficultyCounts).toEqual({ 1: 4, 2: 4, 3: 5, 4: 6, 5: 2 });
    expect(formatReviewPackage(review)).toContain("难度分布：L1 4 · L2 4 · L3 5 · L4 6 · L5 2");

    const summary = summarizeDataset(loadDataset());
    expect(summary.difficultyCounts).toEqual({ 1: 4, 2: 4, 3: 5, 4: 6, 5: 2 });
  });

  it("探针逐题绑定驱动步骤，21 条探针中 9 条关键，全局探针只扫全部助手回复", () => {
    const entry = loadDataset().cases[0]!;
    const driverIds = new Set(entry.case.driver.map((step) => step.id));
    expect(entry.case.probes).toHaveLength(21);
    expect(entry.case.probes.filter((probe) => probe.critical)).toHaveLength(9);
    expect(entry.case.probes.filter((probe) => probe.polarity === "required")).toHaveLength(13);
    expect(entry.case.probes.filter((probe) => probe.polarity === "forbidden")).toHaveLength(8);
    for (const probe of entry.case.probes) {
      expect(driverIds.has(probe.after)).toBe(true);
      expect(probe.description.trim()).not.toBe("");
    }
    expect(entry.case.probes.map((probe) => probe.id)).toEqual([
      "p-correction-ack",
      "p-memory-source",
      "p-memory-no-fixture-update",
      "p-tech-banter",
      "p-short-confirmation",
      "p-food-return",
      "p-tired-no-advice",
      "p-cross-session-answer",
      "p-current-frequency",
      "p-history-running",
      "p-history-cycling",
      "p-no-temporal-swap",
      "p-no-cycling-swap",
      "p-trap-resist",
      "p-clarify-ack",
      "p-food-choice-recall",
      "p-abstain-food",
      "p-durable-recall",
      "p-global-service-tone",
      "p-global-meta",
      "p-global-oracle-leak",
    ]);
    expect(entry.case.probes.filter((probe) => probe.window === "all-assistant").map((probe) => probe.id)).toEqual([
      "p-global-service-tone",
      "p-global-meta",
      "p-global-oracle-leak",
    ]);
    expect(entry.case.oracle.allowedAlternatives.length).toBeGreaterThan(0);
    expect(entry.case.oracle).not.toHaveProperty("required");
    expect(entry.case.oracle).not.toHaveProperty("forbidden");
  });

  it("题型分布与评审权威由探针推导，真实用例覆盖八个题型", () => {
    const entry = loadDataset().cases[0]!;
    const counts: Record<string, number> = {};
    const authorityCounts: Record<string, number> = { deterministic: 0, "api-judge": 0, human: 0 };
    for (const probe of entry.case.probes) {
      counts[probe.questionType] = (counts[probe.questionType] ?? 0) + 1;
      const checker = ORACLE_CHECKER_SPECS.find((spec) => spec.id === probe.checker)!;
      authorityCounts[checker.authority] += 1;
    }
    expect(counts).toEqual({
      temporal: 5,
      correction: 2,
      source: 2,
      "cross-session": 3,
      "multi-turn": 2,
      adversarial: 2,
      boundary: 1,
      style: 4,
    });
    expect(authorityCounts).toEqual({ deterministic: 11, "api-judge": 4, human: 6 });
    expect(new Set(entry.case.probes.map((probe) => probe.questionType))).toEqual(
      new Set(entry.case.questionTypes),
    );
  });

  it("拒绝未登记题型，questionTypes 必须等于探针题型集合", () => {
    const unknownProbeType = baseCase();
    unknownProbeType.probes[0].questionType = "not-a-type";
    expect(() => validateCaseSpec(unknownProbeType, { questionTypeIds })).toThrow(/未登记/);

    const unknownCaseType = baseCase();
    unknownCaseType.questionTypes[0] = "not-a-type";
    expect(() => validateCaseSpec(unknownCaseType, { questionTypeIds })).toThrow(/未登记题型/);

    const unused = baseCase();
    unused.questionTypes.push("open");
    expect(() => validateCaseSpec(unused, { questionTypeIds })).toThrow(/未使用/);

    const undeclared = baseCase();
    undeclared.questionTypes = undeclared.questionTypes.filter((id: string) => id !== "style");
    expect(() => validateCaseSpec(undeclared, { questionTypeIds })).toThrow(/未声明/);
  });

  it("humanizer 语义探针只由用户判定，coding agent 只提供建议", () => {
    const humanizerSpecs = ORACLE_CHECKER_SPECS.filter((spec) => spec.id.startsWith("humanizer."));
    expect(humanizerSpecs.length).toBeGreaterThan(0);
    for (const spec of humanizerSpecs) {
      expect(spec.authority).toBe("human");
      expect(spec.assistants).toEqual(["coding-agent"]);
    }
    for (const spec of ORACLE_CHECKER_SPECS) {
      if (spec.id.startsWith("humanizer.")) continue;
      expect(spec.authority).toBe(spec.kind === "semantic" ? "api-judge" : "deterministic");
      expect(spec.assistants).toEqual([]);
    }
  });

  it("拟人化评分必须声明 human 权威，并保留 coding-agent 建议位", () => {
    const missingAuthority = baseCase();
    delete missingAuthority.quality.authority;
    expect(() => validateCaseSpec(missingAuthority)).toThrow(/缺少字段：authority/);

    const wrongAuthority = baseCase();
    wrongAuthority.quality.authority = "api-judge";
    expect(() => validateCaseSpec(wrongAuthority)).toThrow(/human/);

    const missingAssistant = baseCase();
    missingAssistant.quality.assistants = [];
    expect(() => validateCaseSpec(missingAssistant)).toThrow(/coding-agent/);

    const unknownAssistant = baseCase();
    unknownAssistant.quality.assistants = ["chat-agent"];
    expect(() => validateCaseSpec(unknownAssistant)).toThrow(/未登记值/);
  });

  it("题型注册表必须覆盖全部分类，且只能引用已登记分类", () => {
    const registry = {
      schemaVersion: 1 as const,
      families: realDataset.questionTypeFamilies.map((family) => ({ ...family })),
      questionTypes: realDataset.questionTypes.map((questionType) => ({
        ...questionType,
        capabilities: [...questionType.capabilities],
      })),
    };
    const withoutInteraction = {
      ...registry,
      questionTypes: registry.questionTypes.filter((questionType) => questionType.id !== "interaction"),
    };
    const uncovered = loadDataset({ questionTypes: withoutInteraction });
    expect(uncovered.errors.some((problem) => problem.code === "dataset.question-type-capability-uncovered")).toBe(
      true,
    );

    const unknownCapability = structuredClone(registry);
    unknownCapability.questionTypes[0]!.capabilities = ["not-a-category"];
    const unknown = loadDataset({ questionTypes: unknownCapability });
    expect(unknown.errors.some((problem) => problem.code === "dataset.question-type-capability-unknown")).toBe(
      true,
    );
  });

  it("探针必须绑定驱动步骤、已登记 checker 与已登记证据", () => {
    const unknownStep = baseCase();
    unknownStep.probes[0].after = "not-a-step";
    expect(() => validateCaseSpec(unknownStep)).toThrow(/未指向驱动步骤/);

    const unknownChecker = baseCase();
    unknownChecker.probes[0].checker = "answer.not-registered";
    expect(() => validateCaseSpec(unknownChecker)).toThrow(/未登记/);

    const unknownWindow = baseCase();
    unknownWindow.probes[0].window = "later";
    expect(() => validateCaseSpec(unknownWindow)).toThrow(/window/);

    const unknownEvidence = baseCase();
    unknownEvidence.probes[0].evidence = ["missing-evidence"];
    expect(() => validateCaseSpec(unknownEvidence)).toThrow(/证据/);

    const nonBooleanCritical = baseCase();
    nonBooleanCritical.probes[0].critical = "yes";
    expect(() => validateCaseSpec(nonBooleanCritical)).toThrow(/critical/);
  });

  it("探针 id 唯一，关键 required 不能为空，同一 checker 不能既要求又禁止", () => {
    const duplicate = baseCase();
    duplicate.probes[1].id = duplicate.probes[0].id;
    expect(() => validateCaseSpec(duplicate)).toThrow(/重复 id/);

    const noCritical = baseCase();
    for (const probe of noCritical.probes) probe.critical = false;
    expect(() => validateCaseSpec(noCritical)).toThrow(/critical/);

    const contradiction = baseCase();
    contradiction.probes.push({
      ...structuredClone(contradiction.probes.find((probe: any) => probe.id === "p-current-frequency")),
      id: "p-current-frequency-forbidden",
      polarity: "forbidden",
    });
    expect(() => validateCaseSpec(contradiction)).toThrow(/同时/);
  });

  it("同一步骤可等待多个事件，但不能重复同一 after/wait", () => {
    const valid = baseCase();
    expect(
      valid.checkpoints
        .filter((checkpoint: any) => checkpoint.after === "correct-exercise")
        .map((checkpoint: any) => checkpoint.wait),
    ).toEqual(["assistant_message", "memory_extraction_end"]);
    expect(() => validateCaseSpec(valid)).not.toThrow();

    const duplicate = baseCase();
    duplicate.checkpoints.push({ ...structuredClone(duplicate.checkpoints[0]), id: "duplicate-wait" });
    expect(() => validateCaseSpec(duplicate)).toThrow(/重复声明等待事件/);
  });

  it("last-assistant 探针只能跟在用户消息步骤之后", () => {
    const caseSpec = baseCase();
    const probe = caseSpec.probes.find((item: any) => item.id === "p-memory-source");
    probe.window = "last-assistant";
    expect(() => validateCaseSpec(caseSpec)).not.toThrow();

    probe.after = "new-session-b";
    expect(() => validateCaseSpec(caseSpec)).toThrow(/last-assistant/);
  });

  it("当前 schema 的 oracle 只保留允许替代，不再接受旧 required/forbidden", () => {
    const caseSpec = baseCase();
    caseSpec.oracle.required = [];
    expect(() => validateCaseSpec(caseSpec)).toThrow(/未登记字段：required/);
  });

  it("拒绝未登记分类", () => {
    const caseSpec = baseCase();
    caseSpec.categories = ["not-a-category"];
    expect(() => validateCaseSpec(caseSpec, { categoryIds })).toThrow(/未登记分类/);
  });

  it("拒绝跨套件重复的 caseId", () => {
    const root = makeTempRoot();
    writeSuite(root, "suite-a", baseCase(), baseFixture());
    writeSuite(root, "suite-b", baseCase(), baseFixture());
    const dataset = loadDataset({ root, categories: realDataset.categories });
    expect(dataset.errors.some((problem) => problem.code === "dataset.duplicate-case-id")).toBe(true);
    expect(dataset.cases).toHaveLength(1);
  });

  it("拒绝越界的 fixture 路径", () => {
    const caseSpec = baseCase();
    caseSpec.precondition.fixtureId = "../../etc/passwd";
    expect(() => validateCaseSpec(caseSpec)).toThrow(/fixtureId 格式无效/);
  });

  it("拒绝在用例里内嵌审批或分级字段", () => {
    const topLevel = { ...baseCase(), label: "gold" };
    expect(() => validateCaseSpec(topLevel)).toThrow(/未登记字段：label/);
    const nested = baseCase();
    nested.governance.gold = true;
    expect(() => validateCaseSpec(nested)).toThrow(/内嵌审批或分级字段/);
  });

  it("拒绝把实际输出当作期望来源", () => {
    const caseSpec = baseCase();
    caseSpec.source.kind = "actual";
    expect(() => validateCaseSpec(caseSpec)).toThrow(/实际输出不是期望答案/);
  });

  it("当前内容获批后才是 gold，任一绑定内容改动都会让审批过期", () => {
    const entry = makeEntry();
    const approval = approve(entry);
    expect(resolveCaseLabel(entry.binding, [approval])).toMatchObject({
      tier: "gold",
      status: "approved",
    });

    const changedContent = baseCase();
    changedContent.title = "改过的标题";
    const changedFixture = baseFixture();
    changedFixture.initialMemory[0].content = "改过的旧记忆";
    const changedFixtureLoading = baseFixture();
    changedFixtureLoading.loading.note = "改过的装载说明";
    const changedDriver = baseCase();
    changedDriver.driver[0].text = "改过的驱动消息";
    const changedDriverAt = baseCase();
    changedDriverAt.driver[0].at = "2026-10-24T11:32:00+08:00";
    const changedProbe = baseCase();
    changedProbe.probes[0].description = "改过的探针判据";
    const changedProbeCritical = baseCase();
    changedProbeCritical.probes[0].critical = false;
    const changedProbeDifficulty = baseCase();
    changedProbeDifficulty.probes[0].difficulty = 5;
    const changedCheckpoint = baseCase();
    changedCheckpoint.checkpoints[1].note = "改过的检查点说明";
    const changedQuestionTypes = baseCase();
    changedQuestionTypes.questionTypes.push("open");
    const changedProbeQuestionType = baseCase();
    changedProbeQuestionType.probes[0].questionType = "multi-turn";

    const mutations = [
      ["contentHash", makeEntry(changedContent)],
      ["fixtureHash", makeEntry(baseCase(), changedFixture)],
      ["fixtureHash", makeEntry(baseCase(), changedFixtureLoading)],
      ["driverHash", makeEntry(changedDriver)],
      ["driverHash", makeEntry(changedDriverAt)],
      ["oracleHash", makeEntry(changedProbe)],
      ["oracleHash", makeEntry(changedProbeCritical)],
      ["oracleHash", makeEntry(changedProbeDifficulty)],
      ["oracleHash", makeEntry(changedCheckpoint)],
      ["contentHash", makeEntry(changedQuestionTypes)],
      ["oracleHash", makeEntry(changedProbeQuestionType)],
    ] as const;

    for (const [field, mutatedEntry] of mutations) {
      const label = resolveCaseLabel(mutatedEntry.binding, [approval]);
      expect(label.tier).toBe("silver");
      expect(label.status).toBe("stale");
      expect(label.mismatches.map((mismatch: any) => mismatch.field)).toContain(field);
    }
  });

  it("修订号与治理说明不改动内容哈希", () => {
    const entry = makeEntry();
    const approval = approve(entry);
    const nextCase = baseCase();
    nextCase.revision = 2;
    nextCase.governance.notes.push("补充说明");
    const nextEntry = makeEntry(nextCase);
    expect(nextEntry.binding.contentHash).toBe(entry.binding.contentHash);
    expect(resolveCaseLabel(nextEntry.binding, [approval])).toMatchObject({
      tier: "gold",
      status: "approved",
    });
  });

  it("批量审批只作用于显式列出的用例", () => {
    const first = makeEntry();
    const secondCase = baseCase();
    secondCase.caseId = "another-case";
    secondCase.title = "另一个用例";
    const second = makeEntry(secondCase, baseFixture(), "suite-b");

    const result = applyReviewDecisions({
      entries: [first, second],
      decisions: [{ caseId: first.caseId, decision: "approved" }],
      reviewer,
      feedbackSource,
      reviewedAt,
    });

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.caseId).toBe(first.caseId);
    expect(second.label.tier).toBe("silver");
  });

  it("空决定不会把任何框架通过转成用例审批", () => {
    const entry = makeEntry();
    const result = applyReviewDecisions({
      entries: [entry],
      decisions: [],
      reviewer,
      feedbackSource,
      reviewedAt,
    });
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([]);
    expect(entry.label.tier).toBe("silver");
    expect(entry.label.status).toBe("pending");
  });

  it("拒绝缺少真实用户反馈来源的审批", () => {
    const entry = makeEntry();
    const result = applyReviewDecisions({
      entries: [entry],
      decisions: [{ caseId: entry.caseId, decision: "approved" }],
      reviewer,
      feedbackSource: { ...feedbackSource, quote: "" },
      reviewedAt,
    });
    expect(result.records).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("feedbackSource.quote");
  });

  it("拒绝审阅人不是用户的审批", () => {
    const entry = makeEntry();
    const result = applyReviewDecisions({
      entries: [entry],
      decisions: [{ caseId: entry.caseId, decision: "approved" }],
      reviewer: { role: "maintainer" as any, name: "代理" },
      feedbackSource,
      reviewedAt,
    });
    expect(result.records).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("拒绝绑定哈希被篡改的审批", () => {
    const entry = makeEntry();
    const approval = approve(entry);
    const tampered = structuredClone(approval);
    tampered.binding.specHash = `sha256:${"0".repeat(64)}`;
    expect(() => validateApprovalRecord(tampered)).toThrow(/specHash 与四个分量哈希不一致/);
  });

  it("驱动包不含探针、检查点、证据与评分", () => {
    const entry = makeEntry();
    const driverPackage = buildDriverPackage(entry);
    expect(Object.keys(driverPackage).sort()).toEqual(
      ["caseId", "driver", "revision", "schemaVersion", "specHash", "userRole"].sort(),
    );
    expect(driverPackage.specHash).toBe(entry.binding.specHash);
    expect(driverPackage).not.toHaveProperty("probes");
    expect(driverPackage).not.toHaveProperty("oracle");
    expect(driverPackage).not.toHaveProperty("checkpoints");
    expect(driverPackage).not.toHaveProperty("evidence");
    expect(driverPackage).not.toHaveProperty("quality");
    expect(driverPackage).not.toHaveProperty("questionTypes");
    const driverJson = JSON.stringify(driverPackage);
    expect(driverJson).not.toContain("p-correction-ack");
    expect(driverJson).not.toContain("answer.current-frequency");
    expect(driverJson).not.toContain("questionType");
    expect(driverJson).not.toMatch(/probe|oracle|fixture|checkpoint|评测|评分/i);
  });

  it("审阅包展示探针、旧审批差异与信任边界", () => {
    const entry = makeEntry();
    const approval = approve(entry);
    const changedCase = baseCase();
    changedCase.title = "修改后的标题";
    const mutatedEntry = makeEntry(changedCase);

    const review = buildReviewPackage(mutatedEntry, [approval]);
    expect(review.label.status).toBe("stale");
    expect(review.approvalHistory).toHaveLength(1);
    expect(review.approvalHistory[0]!.matching).toBe(false);
    expect(review.approvalHistory[0]!.mismatches.map((mismatch) => mismatch.field)).toContain("contentHash");
    expect(review.trustBoundary.excludedFromDriver).toContain("probes");
    expect(review.trustBoundary.excludedFromDriver).toContain("oracle");
    expect(review.trustBoundary.excludedFromDriver).toContain("questionTypes");
    expect(review.questionTypes).toEqual(entry.case.questionTypes);
    expect(review.candidate.probes).toHaveLength(21);
    expect(review.candidate.oracle.allowedAlternatives.length).toBeGreaterThan(0);

    const markdown = formatReviewPackage(review);
    expect(markdown).toContain("信任边界");
    expect(markdown).toContain("题型与评审权威");
    expect(markdown).toContain("human 权威只由用户本人判定");
    expect(markdown).toContain("评审权威：human");
    expect(markdown).toContain("探针");
    expect(markdown).toContain("p-current-frequency");
    expect(markdown).toContain("critical");
    expect(markdown).toContain("contentHash：批准");
  });

  it("多标签用例在总数里只计一次，探针与分类分别计数", () => {
    const summary = summarizeDataset(loadDataset());
    expect(summary.caseCount).toBe(1);
    expect(summary.goldCount).toBe(0);
    expect(summary.silverCount).toBe(1);
    expect(summary.probeCount).toBe(21);
    expect(summary.criticalProbeCount).toBe(9);
    expect(summary.categoryCounts.memory).toBe(1);
    expect(summary.categoryCounts.session).toBe(1);
    expect(summary.categoryCounts.chat).toBe(1);
    expect(summary.categoryCounts.humanizer).toBe(1);
    expect(summary.questionTypeCounts).toMatchObject({
      temporal: 5,
      correction: 2,
      source: 2,
      "cross-session": 3,
      "multi-turn": 2,
      adversarial: 2,
      boundary: 1,
      style: 4,
    });
    expect(Object.keys(summary.questionTypeCounts)).toHaveLength(24);
    expect(summary.caseQuestionTypeCounts.temporal).toBe(1);
    expect(summary.caseQuestionTypeCounts.style).toBe(1);
    expect(summary.caseQuestionTypeCounts.open).toBe(0);
    expect(summary.authorityCounts).toEqual({ deterministic: 11, "api-judge": 4, human: 6 });
    expect(summary.suites[0]!.probeCount).toBe(21);
    expect(summary.suites[0]!.criticalProbeCount).toBe(9);
  });

  it("规范化哈希与对象键顺序无关", () => {
    expect(hashCanonical({ b: 2, a: { d: 4, c: 3 } })).toBe(hashCanonical({ a: { c: 3, d: 4 }, b: 2 }));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
    expect(hashCanonical({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
