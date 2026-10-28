import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_DATASET_ROOT,
  buildExternalCase,
  importExternalTasks,
} from "../../sim/desk-pet-chat/external/index.mjs";
import {
  datasetInputHash,
  computeCaseBinding,
  hashCanonical,
  loadDataset,
} from "../../sim/desk-pet-chat/dataset.mjs";
import {
  beginChatAttempt,
  CHAT_GRADER_VERSION,
  createChatRun,
  createDialogueWriter,
  createTraceWriter,
  sealChatAttempt,
  setChatRunPhase,
  writeStateSnapshot,
} from "../../sim/desk-pet-chat/evidence.mjs";
import {
  JUDGE_PROMPT_VERSION,
  applyJudgeVerdicts,
  prepareJudgePacket,
  formatJudgePacket,
} from "../../sim/desk-pet-chat/judging.mjs";
import type { JudgeVerdictsInput } from "../../sim/desk-pet-chat/judging.mjs";
import { BoundedTraceBuffer } from "@/services/sim/trace-chunk";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REFERENCE = "The upstream reference answer must remain oracle-only.";
const ROOT = resolve(process.cwd());
const ownedRoots: string[] = [];

afterEach(() => {
  while (ownedRoots.length) rmSync(ownedRoots.pop()!, { recursive: true, force: true });
});

function scratchRoot() {
  const parent = join(ROOT, EXTERNAL_DATASET_ROOT);
  mkdirSync(parent, { recursive: true });
  const path = mkdtempSync(join(parent, "external-import-test-"));
  ownedRoots.push(path);
  return path;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    dataset: "multichallenge",
    id: "mc-fixture-1",
    revision: COMMIT,
    split: "test",
    mode: "fixed-history",
    title: "Fixed upstream history",
    categories: ["chat", "context"],
    questionTypes: ["multi-turn"],
    difficulty: 3,
    history: [
      { role: "user", content: "Please remember that the meeting starts at noon." },
      { role: "assistant", content: "Understood; I will keep the noon start in mind." },
      { role: "user", content: "Now answer the follow-up using that context." },
    ],
    turns: [{ id: "target", prompt: "What time does the meeting start?" }],
    oracle: { referenceAnswers: [REFERENCE], criteria: ["Answer must preserve the upstream time constraint."] },
    assets: [],
    environment: { required: false },
    readiness: { runnable: true, blockers: [] },
    adaptationNotes: ["Test adapter note."],
    source: {
      url: "https://huggingface.co/datasets/ScaleAI/MultiChallenge",
      revision: COMMIT,
      license: "CC-BY-4.0",
    },
    ...overrides,
  } as any;
}

function importOne(overrides: Record<string, unknown> = {}) {
  const base = scratchRoot();
  const output = join(base, "imported");
  const input = task(overrides);
  const result = importExternalTasks([input], {
    repoRoot: ROOT,
    root: output,
    card: "Test card",
    rawSha256: hashCanonical({ officialRowIdentity: input.id, revision: input.revision }),
  });
  return { base, output, input, result };
}

function externalCriteria(entry: any): string[] {
  const expectation = entry.case.probes[0]?.expectation;
  if (!expectation || !("criteria" in expectation)) throw new Error("expected an external-result expectation");
  return expectation.criteria;
}

async function freezePacket(base: string, dataset: any, entry: any) {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const sealedAt = "2026-01-01T00:10:00.000Z";
  const at = Date.parse(createdAt);
  const sessionId = entry.fixture.initialSession.id;
  const reportsDir = join(base, "reports");
  const { runDir, run } = createChatRun({
    reportsDir,
    evaluationRunId: `external-import-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    createdAt,
    scope: { suiteIds: [entry.suiteId], caseIds: [entry.caseId] },
    budget: { trials: 1, maxCostUsd: 1 },
  });
  setChatRunPhase(runDir, { phase: "completed", updatedAt: createdAt });
  const inputHashes = {
    datasetHash: datasetInputHash(dataset, entry),
    fixtureHash: entry.binding.fixtureHash,
    cardHash: hashCanonical("test-card"),
    configHash: hashCanonical("test-config"),
  };
  const identity = {
    code: { commit: "abc1234", sourceHash: hashCanonical("source"), dirty: false },
    inputs: inputHashes,
    tools: { driverVersion: "test-driver", rubricVersion: JUDGE_PROMPT_VERSION, graderVersion: CHAT_GRADER_VERSION },
    host: { mode: "full-desktop", capabilities: ["chat", "session"] },
    platform: { os: "darwin", arch: "arm64" },
    runtime: { version: "22.0.0" },
    models: { requested: "provider/test-model" },
    budget: { trials: 1, maxCostUsd: 1 },
  };
  const trialId = "external-import-trial";
  const { attemptDir } = beginChatAttempt({
    runDir,
    identity,
    expectedTrials: [{ caseId: entry.caseId, trialId }],
    expectedSessions: [sessionId],
    createdAt,
  });
  const dialogue = createDialogueWriter(attemptDir);
  const targetStep = entry.case.driver.find((step: any) => step.id === "target")!;
  dialogue.append({ role: "user", text: targetStep.text, sessionId, entryId: "target-user", at: at + 1, origin: "driver" });
  dialogue.append({ role: "assistant", text: "The meeting starts at noon.", sessionId, entryId: "target-assistant", at: at + 2, origin: "assistant" });
  dialogue.close();

  const trace = createTraceWriter(attemptDir);
  const buffer = new BoundedTraceBuffer({ maxEvents: 128, maxBytes: 65536, maxChunkBytes: 32768 });
  const traceContext = { sceneId: entry.caseId, trialId, runId: run.evaluationRunId, tokenId: "external-import-token" };
  const flush = (boundary: { kind: string; sceneId?: string; trialId?: string }) => {
    const chunk = buffer.drainChunk(boundary as never);
    trace.appendChunk(chunk);
    buffer.ackChunk({ chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true });
  };
  flush({ kind: "scene_start", sceneId: entry.caseId, trialId });
  flush({ kind: "trial_start", sceneId: entry.caseId, trialId });
  buffer.append({ schemaVersion: 1, kind: "turn_reply", createdAt: at + 2 }, traceContext);
  flush({ kind: "trial_end", sceneId: entry.caseId, trialId });
  flush({ kind: "scene_end", sceneId: entry.caseId, trialId });
  flush({ kind: "complete" });
  trace.close();

  const stateSnapshot = (messageCount: number, modifiedAt: number) => ({
    schemaVersion: 1,
    complete: true,
    activeSessionId: sessionId,
    sessions: [{ sessionId, createdAt: at, modifiedAt, messageCount }],
    memory: { complete: true, items: [] },
    issues: [],
  });
  writeStateSnapshot({ attemptDir, name: "before", value: stateSnapshot(entry.fixture.initialSession.messages.length, at) });
  writeStateSnapshot({ attemptDir, name: "after", value: stateSnapshot(entry.fixture.initialSession.messages.length + 2, at + 2) });
  await sealChatAttempt({
    attemptDir,
    sealedAt,
    models: { actual: "provider/other-model" },
    sourceHash: identity.code.sourceHash,
    inputs: inputHashes,
  });
  return { runDir, attemptDir, now: "2026-01-01T00:15:00.000Z" };
}

describe("公开评测接线", () => {
  it("固定历史保留原始 user/assistant 角色；目标请求才进入 live driver [external-import-fixed-history]", () => {
    const { output, input, result } = importOne();
    expect(result.imported).toBe(1);
    const loaded = loadDataset({ repoRoot: ROOT, root: output });
    expect(loaded.errors).toEqual([]);
    const entry = loaded.cases[0]!;
    expect(entry.fixture.initialSession.messages.map((message: any) => [message.role, message.content])).toEqual(
      input.history.map((message: any) => [message.role, message.content]),
    );
    expect(entry.case.driver).toEqual([{ id: "target", kind: "message", text: input.turns[0].prompt, at: expect.any(String) }]);
    expect(entry.case.driver.some((step: any) => step.text === REFERENCE)).toBe(false);
    expect(entry.fixture.initialSession.messages.some((message: any) => message.content === REFERENCE)).toBe(false);
    expect(entry.fixture.initialSession.messages.some((message: any) => message.role === "assistant" && message.content === REFERENCE)).toBe(false);
    expect(entry.case.source.upstream).toMatchObject({ dataset: input.dataset, id: input.id, revision: COMMIT, split: "test", protocol: "adapted" });
  });

  it("拒绝可变 revision 和未绑定 SHA-256 的外部来源 [external-import-provenance-pin]", () => {
    const mutable = task({ revision: "main" });
    expect(() => buildExternalCase(mutable, { card: "Test card", rawSha256: hashCanonical(mutable) })).toThrow(/40 位 commit/);
    expect(() => buildExternalCase(task(), { card: "Test card", rawSha256: "unverified" })).toThrow(/原始数据/);
    expect(() => importExternalTasks([task()], { repoRoot: ROOT, root: join(scratchRoot(), "imported"), card: "Test card", rawSha256: "bad" })).toThrow(/原始数据/);
  });

  it("已知分类与题型进入 schema-4，未知注册项被拒绝 [external-import-registered-vocabulary]", () => {
    expect(() => importOne()).not.toThrow();
    const badCategory = task({ categories: ["unregistered-domain"] });
    expect(() => importExternalTasks([badCategory], {
      repoRoot: ROOT, root: join(scratchRoot(), "bad-category"), card: "Test card", rawSha256: hashCanonical(badCategory),
    })).toThrow(/未登记分类/);
    const badType = task({ questionTypes: ["unregistered-type"] });
    expect(() => importExternalTasks([badType], {
      repoRoot: ROOT, root: join(scratchRoot(), "bad-type"), card: "Test card", rawSha256: hashCanonical(badType),
    })).toThrow(/未登记题型/);
  });

  it("重复 upstream identity 被拒绝；既有输出拒绝覆盖 [external-import-duplicate-output]", () => {
    const base = scratchRoot();
    const duplicate = task();
    expect(() => importExternalTasks([duplicate, { ...duplicate }], {
      repoRoot: ROOT, root: join(base, "duplicates"), card: "Test card", rawSha256: hashCanonical(duplicate),
    })).toThrow(/身份重复/);

    const imported = importOne();
    const before = readFileSync(join(imported.output, "import.json"), "utf8");
    expect(() => importExternalTasks([imported.input], {
      repoRoot: ROOT, root: imported.output, card: "Changed card", rawSha256: hashCanonical(imported.input),
    })).toThrow(/拒绝覆盖/);
    expect(readFileSync(join(imported.output, "import.json"), "utf8")).toBe(before);
  });

  it("不指定输出时生成套件长期保存在数据集自己的目录 [external-import-persistent-default]", () => {
    const dataset = `persistent-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const parent = join(ROOT, "test/sim/desk-pet-chat/external/.data", dataset);
    ownedRoots.push(parent);
    const result = importExternalTasks([task({ dataset })], { repoRoot: ROOT, card: "Test card" });
    expect(result.datasetRoot).toBe(join(parent, "dataset"));
    expect(result.imported).toBe(1);
    const loaded = loadDataset({ repoRoot: ROOT, root: result.datasetRoot });
    expect(loaded.errors).toEqual([]);
    expect(loaded.cases[0]?.case.source.upstream?.dataset).toBe(dataset);
  });

  it("仅接受固定本地缓存或测试临时根，并拒绝穿过符号链接的输出路径 [external-import-scratch-boundary]", () => {
    const outside = join(ROOT, "test/.tmp/external-import-outside");
    expect(() => importExternalTasks([task()], {
      repoRoot: ROOT, root: outside, card: "Test card", rawSha256: hashCanonical(task()),
    })).toThrow(/只写入/);

    const base = scratchRoot();
    const real = join(base, "real");
    mkdirSync(real);
    const linked = join(base, "linked");
    symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => importExternalTasks([task()], {
      repoRoot: ROOT, root: join(linked, "output"), card: "Test card", rawSha256: hashCanonical(task()),
    })).toThrow(/符号链接/);
    expect(existsSync(join(real, "output"))).toBe(false);
  });

  it("prepare CLI 从 --dataset-root 加载并把所用数据根写入运行状态 [external-import-runner-persistence]", () => {
    const { base, output } = importOne();
    const entry = loadDataset({ repoRoot: ROOT, root: output }).cases[0]!;
    const cardPath = join(base, "card.md");
    const authorizationPath = join(base, "authorization.json");
    writeFileSync(cardPath, "---\nid: external-import-card\nname: Test card\nversion: 1\n---\nA test-only card.\n");
    writeFileSync(authorizationPath, JSON.stringify({
      schemaVersion: 1,
      approvedBy: "unit-test",
      approvedAt: "2026-01-01T00:00:00.000Z",
      scope: { caseIds: [entry.caseId], purpose: "development", models: ["provider/model-under-test"], data: "isolated" },
      budget: { messages: 5, tokens: 1000, minutes: 10, trials: 1, repairs: 0 },
      holdout: false,
    }));
    const runId = `external-import-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const runRoot = join(ROOT, "test/.tmp", `sim-eval-${runId}`);
    ownedRoots.push(runRoot);
    const result = spawnSync(process.execPath, [
      resolve(ROOT, "scripts/sim-eval-run.mjs"), "prepare",
      "--dataset-root", output,
      "--case", entry.caseId,
      "--card", cardPath,
      "--authorization", authorizationPath,
      "--run-id", runId,
    ], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(runRoot, "runner.json"), "utf8"));
    expect(state.datasetRoot).toBe(relative(ROOT, output));
    expect(state.caseId).toBe(entry.caseId);
  });

  it("环境型任务与附件即使把 readiness 改成 runnable 也只能留在 blocked 清单 [external-import-readiness-gate]", () => {
    for (const blockedTask of [
      task({ mode: "environment", environment: { required: true }, readiness: { runnable: true, blockers: [] } }),
      task({ assets: [{ path: "source.pdf" }], readiness: { runnable: true, blockers: [] } }),
    ]) {
      const base = scratchRoot();
      const output = join(base, "blocked");
      const manifest = importExternalTasks([blockedTask], {
        repoRoot: ROOT, root: output, card: "Test card", rawSha256: hashCanonical(blockedTask),
      });
      expect(manifest.imported).toBe(0);
      expect(manifest.blocked).toHaveLength(1);
      const blockedDataset = loadDataset({ repoRoot: ROOT, root: output });
      expect(blockedDataset.cases).toEqual([]);
      expect(blockedDataset.errors.map(error => error.code)).toEqual(["dataset.no-suites"]);
      expect(JSON.parse(readFileSync(join(output, "import.json"), "utf8")).blocked).toHaveLength(1);
    }
  });

  it("oracle binding 对参考答案与判据漂移敏感 [external-import-oracle-binding]", () => {
    const { output } = importOne();
    const loaded = loadDataset({ repoRoot: ROOT, root: output });
    const entry = loaded.cases[0]!;
    const before = computeCaseBinding(entry.case, entry.fixture);
    externalCriteria(entry)[0] = "A materially different upstream criterion.";
    const after = computeCaseBinding(entry.case, entry.fixture);
    expect(after.oracleHash).not.toBe(before.oracleHash);
    expect(after.specHash).not.toBe(before.specHash);
  });

  it("冻结判分包显示上游答案与判据，oracle 漂移会使已采集证据失效 [external-import-judge-packet]", async () => {
    const { base, output, input } = importOne();
    const dataset = loadDataset({ repoRoot: ROOT, root: output });
    const entry = dataset.cases[0]!;
    const attempt = await freezePacket(base, dataset, entry);
    const prepared = prepareJudgePacket({
      runDir: attempt.runDir,
      attemptDir: attempt.attemptDir,
      dataset,
      caseEntry: entry,
      now: attempt.now,
    });
    const rule = prepared.packet.rules.find((item: any) => item.ruleId === "upstream-result")!;
    expect(rule.expectation).toContain(REFERENCE);
    expect(rule.expectation).toContain("Answer must preserve the upstream time constraint.");
    expect(prepared.packet.fixtureContext).toMatchObject({
      origin: "fixture",
      fixtureHash: entry.binding.fixtureHash,
      sessionId: entry.fixture.initialSession.id,
      messages: entry.fixture.initialSession.messages,
    });
    expect(prepared.packet.fixtureContext!.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(prepared.packet.timeline.map((message: any) => message.text)).toEqual([
      input.turns[0].prompt,
      "The meeting starts at noon.",
    ]);
    expect(prepared.packet.timeline.some((message: any) => message.text === input.history[1].content)).toBe(false);
    expect(prepared.packet.allowedEvidenceRefs).toContain("fixture:history-2");
    const formatted = formatJudgePacket({ packet: prepared.packet });
    expect(formatted).toContain(REFERENCE);
    expect(formatted).toContain("Answer must preserve the upstream time constraint.");

    const verdicts: JudgeVerdictsInput = {
      schemaVersion: 1,
      packetId: prepared.packet.packetId,
      packetSha256: prepared.packet.packetSha256,
      caseId: entry.caseId,
      judgedAt: "2026-01-01T00:16:00.000Z",
      judge: { platform: "qoder", model: "judge/different-evaluator", promptVersion: JUDGE_PROMPT_VERSION },
      verdicts: prepared.packet.rules.map((packetRule: any) => ({
        ruleId: packetRule.ruleId,
        verdict: "pass",
        reason: "The target response was checked against the fixed historical context.",
        evidenceRefs: ["fixture:history-2", "dialogue:" + entry.fixture.initialSession.id + ":target-assistant"],
      })),
    };
    const applied = applyJudgeVerdicts({
      runDir: attempt.runDir,
      attemptDir: attempt.attemptDir,
      dataset,
      caseEntry: entry,
      packetId: prepared.packet.packetId,
      verdicts,
      now: "2026-01-01T00:17:00.000Z",
    });
    expect(applied.checks[0]!.evidence[0]!.excerpt).toContain("预置历史 assistant：Understood; I will keep the noon start in mind.");

    externalCriteria(entry)[0] = "Changed after this evidence was sealed.";
    expect(() => prepareJudgePacket({
      runDir: attempt.runDir,
      attemptDir: attempt.attemptDir,
      dataset,
      caseEntry: entry,
      now: "2026-01-01T00:20:00.000Z",
    })).toThrow(/采集后已变更/);
  });
});
