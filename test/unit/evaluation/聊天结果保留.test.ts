import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChatRun, setChatRunPhase } from "../../sim/desk-pet-chat/evidence.mjs";
import { planChatRetention, pruneChatRuns, writeChatReport } from "../../sim/desk-pet-chat/report.mjs";

const START = "2026-10-25T10:00:00.000+08:00";
const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-chat-retention-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRun(reportsDir: string, name: string, phase = "completed", baseline: unknown = null) {
  const { runDir } = createChatRun({
    reportsDir,
    evaluationRunId: name,
    createdAt: START,
    scope: { suiteIds: ["daily-companionship"] },
    budget: { trials: 1 },
    baseline,
  });
  setChatRunPhase(runDir, { phase, updatedAt: START } as any);
  return runDir;
}

function writeBaseline(runDir: string, bytes = 32) {
  const dir = join(runDir, "baseline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), Buffer.alloc(bytes, 1));
}

describe("聊天结果保留", () => {
  it("按创建顺序只保留五回：第六组淘汰第一组", () => {
    const reportsDir = makeRoot();
    for (let index = 1; index <= 6; index += 1) makeRun(reportsDir, `run-${index}`);

    const plan = planChatRetention({ reportsDir });
    expect(plan.blocked).toBe(false);
    expect(plan.evicted).toEqual(["run-1"]);
    expect(plan.kept).toEqual(["run-6", "run-5", "run-4", "run-3", "run-2"]);

    pruneChatRuns({ reportsDir });
    expect(existsSync(join(reportsDir, "run-1"))).toBe(false);
    for (let index = 2; index <= 6; index += 1) {
      expect(existsSync(join(reportsDir, `run-${index}`, "run.json"))).toBe(true);
    }
  });

  it("待审和活跃组受保护，保护优先于五回上限", () => {
    const reportsDir = makeRoot();
    makeRun(reportsDir, "run-1", "awaiting_judge");
    makeRun(reportsDir, "run-2");
    makeRun(reportsDir, "run-3");

    const plan = planChatRetention({ reportsDir, maxGroups: 1 });
    expect(plan.kept).toEqual(["run-3", "run-1"]);
    expect(plan.evicted).toEqual(["run-2"]);
    expect(plan.reasons.join("\n")).toContain("受保护运行超出五回上限");

    pruneChatRuns({ reportsDir, maxGroups: 1 });
    expect(existsSync(join(reportsDir, "run-1", "run.json"))).toBe(true);
    expect(existsSync(join(reportsDir, "run-3", "run.json"))).toBe(true);
    expect(existsSync(join(reportsDir, "run-2"))).toBe(false);
  });

  it("显式保护的完成组同样不被淘汰", () => {
    const reportsDir = makeRoot();
    for (let index = 1; index <= 3; index += 1) makeRun(reportsDir, `run-${index}`);

    const plan = planChatRetention({ reportsDir, maxGroups: 1, protect: ["run-1"] });
    expect(plan.kept).toEqual(["run-3", "run-1"]);
    expect(plan.evicted).toEqual(["run-2"]);
  });

  it("空间不足时整轮阻塞，不删除任何证据", () => {
    const reportsDir = makeRoot();
    makeRun(reportsDir, "run-1");
    makeRun(reportsDir, "run-2");
    writeBaseline(join(reportsDir, "run-1"), 256);
    writeBaseline(join(reportsDir, "run-2"), 256);

    const plan = planChatRetention({ reportsDir, maxGroups: 5, maxBytes: 32 });
    expect(plan.blocked).toBe(true);
    expect(plan.evicted).toEqual([]);
    expect(plan.reasons.join("\n")).toContain("超过上限");

    const pruned = pruneChatRuns({ reportsDir, maxGroups: 5, maxBytes: 32 });
    expect(pruned.blocked).toBe(true);
    expect(existsSync(join(reportsDir, "run-1", "run.json"))).toBe(true);
    expect(existsSync(join(reportsDir, "run-2", "run.json"))).toBe(true);
  });

  it("补评审或重写报告只改 mtime，不改变创建顺序与淘汰结果", () => {
    const reportsDir = makeRoot();
    for (let index = 1; index <= 6; index += 1) makeRun(reportsDir, `run-${index}`);
    const oldest = join(reportsDir, "run-1");
    mkdirSync(join(oldest, "reviews"), { recursive: true });
    writeFileSync(join(oldest, "reviews", "review-1.json"), "{}");
    writeChatReport({ runDir: oldest, generatedAt: START });
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(oldest, future, future);

    const plan = planChatRetention({ reportsDir });
    expect(plan.evicted).toEqual(["run-1"]);
  });

  it("基线证据随运行组一起淘汰", () => {
    const reportsDir = makeRoot();
    makeRun(reportsDir, "run-1", "completed", { fixture: "fixture-a" });
    writeBaseline(join(reportsDir, "run-1"));
    for (let index = 2; index <= 6; index += 1) makeRun(reportsDir, `run-${index}`);

    expect(existsSync(join(reportsDir, "run-1", "baseline", "baseline.json"))).toBe(true);
    pruneChatRuns({ reportsDir });
    expect(existsSync(join(reportsDir, "run-1"))).toBe(false);
  });

  it("淘汰只作用于聊天运行组，其他池文件与目录不受影响", () => {
    const reportsDir = makeRoot();
    for (let index = 1; index <= 3; index += 1) makeRun(reportsDir, `run-${index}`);
    writeFileSync(join(reportsDir, "trace-bundle-keep.trace.jsonl"), "{}\n");
    mkdirSync(join(reportsDir, "not-a-run"));
    writeFileSync(join(reportsDir, "not-a-run", "note.txt"), "keep");

    pruneChatRuns({ reportsDir, maxGroups: 1 });
    expect(existsSync(join(reportsDir, "run-3", "run.json"))).toBe(true);
    expect(existsSync(join(reportsDir, "run-1"))).toBe(false);
    expect(existsSync(join(reportsDir, "run-2"))).toBe(false);
    expect(existsSync(join(reportsDir, "trace-bundle-keep.trace.jsonl"))).toBe(true);
    expect(existsSync(join(reportsDir, "not-a-run", "note.txt"))).toBe(true);
  });
});
