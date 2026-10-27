import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDataset } from "../../sim/desk-pet-chat/dataset.mjs";

const cli = resolve("scripts/desk-pet-chat.mjs");
const realDataset = loadDataset();
const suiteId = "daily-companionship";
const reviewedAt = "2026-10-26T21:00:00+08:00";

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-approval-cli-"));
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

function writeSuite(root: string) {
  const caseSpec = baseCase();
  const fixture = baseFixture();
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
  return caseSpec.caseId;
}

function runApprove(root: string, caseId: string, overrides: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "dataset",
      "approve",
      caseId,
      "--dataset-root",
      root,
      "--reviewer-name",
      "用户",
      "--session-id",
      "review-session-1",
      "--message-id",
      "review-message-1",
      "--quote",
      "这个日常陪伴用例按当前内容可以冻结。",
      "--reviewed-at",
      reviewedAt,
      "--json",
      ...overrides,
    ],
    { encoding: "utf8" },
  );
}

describe("聊天审批命令", () => {
  it("写入批准并回读 gold 标签", () => {
    const root = makeTempRoot();
    const caseId = writeSuite(root);

    const result = runApprove(root, caseId);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.approval).toMatchObject({ caseId, decision: "approved" });
    expect(output.label).toMatchObject({ tier: "gold", status: "approved" });
    const files = readdirSync(join(root, suiteId, "approvals"));
    expect(files).toEqual([`${output.approval.approvalId}.json`]);
    const stored = JSON.parse(readFileSync(join(root, suiteId, "approvals", files[0]!), "utf8"));
    expect(stored.binding).toEqual(output.approval.binding);
  });

  it("重复写入同一审批时失败且不覆盖文件", () => {
    const root = makeTempRoot();
    const caseId = writeSuite(root);
    expect(runApprove(root, caseId).status).toBe(0);

    const second = runApprove(root, caseId);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("拒绝覆盖");
    expect(readdirSync(join(root, suiteId, "approvals"))).toHaveLength(1);
  });

  it("缺少反馈原文或驳回原因时拒绝写盘", () => {
    const root = makeTempRoot();
    const caseId = writeSuite(root);

    const missingQuote = spawnSync(
      process.execPath,
      [cli, "dataset", "approve", caseId, "--dataset-root", root, "--reviewer-name", "用户"],
      { encoding: "utf8" },
    );
    expect(missingQuote.status).toBe(1);
    expect(existsSync(join(root, suiteId, "approvals"))).toBe(false);

    const missingReason = runApprove(root, caseId, ["--decision", "rejected"]);
    expect(missingReason.status).toBe(1);
    expect(missingReason.stderr).toContain("拒绝时必须写明原因");
    expect(existsSync(join(root, suiteId, "approvals"))).toBe(false);
  });
});
