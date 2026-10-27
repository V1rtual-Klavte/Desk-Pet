import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QUESTION_TYPES_SCHEMA_VERSION,
  computeCaseBinding,
  loadDataset,
  writeApprovalRecords,
} from "../../sim/desk-pet-chat/dataset.mjs";

const realDataset = loadDataset();
const suiteId = "daily-companionship";
const reviewer = { role: "user" as const, name: "用户" };
const feedbackSource = {
  kind: "session_message" as const,
  sessionId: "review-session-1",
  messageId: "review-message-1",
  quote: "这个日常陪伴用例按当前内容可以冻结。",
};
const reviewedAt = "2026-10-26T21:00:00+08:00";

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-approval-"));
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

function writeSuite(root: string, caseSpec: any, fixture: any) {
  const suiteDir = join(root, suiteId);
  mkdirSync(join(suiteDir, "cases"), { recursive: true });
  mkdirSync(join(suiteDir, "fixtures"), { recursive: true });
  writeFileSync(
    join(suiteDir, "suite.json"),
    JSON.stringify({
      schemaVersion: 4,
      suiteId,
      revision: 1,
      purpose: "development",
      title: suiteId,
      caseIds: [caseSpec.caseId],
    }),
  );
  writeFileSync(join(suiteDir, "cases", `${caseSpec.caseId}.case.json`), JSON.stringify(caseSpec));
  writeFileSync(join(suiteDir, "fixtures", `${fixture.fixtureId}.json`), JSON.stringify(fixture));
}

function load(root: string) {
  return loadDataset({
    root,
    categories: realDataset.categories,
    questionTypes: {
      schemaVersion: QUESTION_TYPES_SCHEMA_VERSION,
      families: realDataset.questionTypeFamilies,
      questionTypes: realDataset.questionTypes,
    },
  });
}

function approve(root: string, entry: any, overrides: Record<string, any> = {}) {
  return writeApprovalRecords({
    datasetRoot: root,
    entries: [entry],
    decisions: [{ caseId: entry.caseId, decision: "approved", ...overrides.decision }],
    reviewer: overrides.reviewer ?? reviewer,
    feedbackSource: overrides.feedbackSource ?? feedbackSource,
    reviewedAt: overrides.reviewedAt ?? reviewedAt,
  });
}

describe("聊天审批写入", () => {
  it("写入当前内容的用户批准后才把用例标为 gold", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const entry = load(root).cases[0]!;

    const result = approve(root, entry);

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.written).toHaveLength(1);
    const record = result.records[0]!;
    const file = join(root, suiteId, "approvals", `${record.approvalId}.json`);
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored).toMatchObject({
      caseId: entry.caseId,
      suiteId,
      decision: "approved",
      reviewer,
      feedbackSource,
      reviewedAt,
    });
    expect(stored.binding).toEqual(entry.binding);
    expect(load(root).cases[0]!.label).toMatchObject({ tier: "gold", status: "approved" });
  });

  it("同一审批已存在时拒绝覆盖既有文件", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const entry = load(root).cases[0]!;
    const first = approve(root, entry);
    const file = join(root, suiteId, "approvals", `${first.records[0]!.approvalId}.json`);
    const original = readFileSync(file, "utf8").replace('"notes": ""', '"notes": "用户补充"');
    writeFileSync(file, original);

    const second = approve(root, entry);

    expect(second.records).toEqual([]);
    expect(second.written).toEqual([]);
    expect(second.errors[0]!.code).toBe("approval.exists");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("驳回必须写明原因，失败时不创建审批目录", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const entry = load(root).cases[0]!;

    const result = approve(root, entry, { decision: { decision: "rejected" } });

    expect(result.records).toEqual([]);
    expect(result.errors.some((problem: any) => problem.code === "approval.rejection-reason")).toBe(true);
    expect(existsSync(join(root, suiteId, "approvals"))).toBe(false);
  });

  it("未知用例不会写出任何审批", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const entry = { ...load(root).cases[0]!, caseId: "unknown-case" };

    const result = approve(root, entry);

    expect(result.records).toEqual([]);
    expect(result.errors[0]!.code).toBe("approval.unknown-case");
    expect(existsSync(join(root, suiteId, "approvals"))).toBe(false);
  });

  it("目标套件不在数据集目录时不写盘", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const loaded = load(root).cases[0]!;
    const caseSpec = baseCase();
    const entry = {
      ...loaded,
      suiteId: "missing-suite",
      binding: computeCaseBinding(caseSpec, baseFixture()),
    };

    const result = approve(root, entry);

    expect(result.records).toEqual([]);
    expect(result.errors[0]!.code).toBe("approval.suite-missing");
    expect(existsSync(join(root, "missing-suite", "approvals"))).toBe(false);
  });

  it("用例不属于目标套件时不写盘", () => {
    const root = makeTempRoot();
    writeSuite(root, baseCase(), baseFixture());
    const loaded = load(root).cases[0]!;
    const otherCase = baseCase();
    otherCase.caseId = "other-case";
    otherCase.title = "套件未声明的用例";
    const entry = {
      ...loaded,
      caseId: otherCase.caseId,
      case: otherCase,
      binding: computeCaseBinding(otherCase, baseFixture()),
    };

    const result = approve(root, entry);

    expect(result.records).toEqual([]);
    expect(result.errors[0]!.code).toBe("approval.case-missing");
    expect(existsSync(join(root, suiteId, "approvals"))).toBe(false);
  });

  it("批准写入后修改内容会让审批过期，不会被继承为 gold", () => {
    const root = makeTempRoot();
    const caseSpec = baseCase();
    writeSuite(root, caseSpec, baseFixture());
    const entry = load(root).cases[0]!;
    approve(root, entry);

    const changed = baseCase();
    changed.title = "修改后的标题";
    writeSuite(root, changed, baseFixture());

    expect(load(root).cases[0]!.label).toMatchObject({ tier: "silver", status: "stale" });
  });
});
