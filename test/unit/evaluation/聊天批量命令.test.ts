// ==========================================
// 批量命令 — 拉起宿主前的入口校验
// ==========================================
//
// 只验证 batch 在写证据、拉宿主之前就拒绝错误参数；真实串行编排需要宿主，
// 由 runner 的手工/集成验收覆盖，不在这里伪造。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../../sim/desk-pet-chat/dataset.mjs";

const cli = resolve("scripts/sim-eval-run.mjs");

function runBatch(args: string[]) {
  return spawnSync(process.execPath, [cli, "batch", ...args], {
    encoding: "utf8",
    cwd: resolve("."),
  });
}

describe("批量命令入口", () => {
  it("在拉起宿主前拒绝缺失用例、单试次参数与缺 Card [chat-batch-command]", () => {
    const noCase = runBatch([]);
    expect(noCase.status).toBe(1);
    expect(noCase.stderr).toContain("batch 需要 --case");

    const runId = runBatch(["--run-id", "single-attempt", "--case", "any-case"]);
    expect(runId.status).toBe(1);
    expect(runId.stderr).toContain("batch 用 --evaluation-run-id");

    const unknown = runBatch(["--case", "case-does-not-exist"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("找不到用例：case-does-not-exist");

    const caseId = loadDataset().cases[0]?.caseId;
    expect(caseId).toBeTruthy();
    const noCard = runBatch(["--case", caseId!]);
    expect(noCard.status).toBe(1);
    expect(noCard.stderr).toContain("batch 缺少 --card");
  });
});
