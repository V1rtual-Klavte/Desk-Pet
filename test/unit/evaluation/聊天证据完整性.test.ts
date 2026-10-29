import {
  appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedTraceBuffer } from "@/services/sim/trace-chunk";
import {
  appendGrade,
  appendReview,
  beginChatAttempt,
  createChatRun,
  createDialogueWriter,
  createTraceWriter,
  ensureChatRun,
  extendChatAttemptSessions,
  readChatRun,
  readChatWorkflow,
  readSealedAttempt,
  sealChatAttempt,
  setChatRunPhase,
  verifySealedAttempt,
  writeArtifact,
} from "../../sim/desk-pet-chat/evidence.mjs";
import { renderChatReport, writeChatReport } from "../../sim/desk-pet-chat/report.mjs";

const START = "2026-10-25T10:00:00.000+08:00";
const SEALED = "2026-10-25T10:05:00.000+08:00";
const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const CASE_ID = "saturday-companionship";
const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-chat-evidence-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function identity(): any {
  return {
    code: { commit: "abc1234", sourceHash: HASH, dirty: false },
    inputs: { datasetHash: HASH, fixtureHash: HASH, cardHash: HASH, configHash: HASH },
    tools: { driverVersion: "driver-1", rubricVersion: "rubric-1", graderVersion: "grader-1" },
    host: { mode: "full-desktop", capabilities: ["chat", "memory", "session"] },
    platform: { os: "darwin", arch: "arm64" },
    runtime: { version: "22.22.3" },
    models: { requested: "provider/model-a" },
    budget: { trials: 1, maxCostUsd: 1 },
  };
}

function makeRun(reportsDir: string, name: string, phase = "completed") {
  const { runDir } = createChatRun({
    reportsDir,
    evaluationRunId: name,
    createdAt: START,
    scope: { suiteIds: ["daily-companionship"], caseIds: [CASE_ID] },
    budget: { trials: 1, maxCostUsd: 1 },
  });
  if (phase !== "preparing") setChatRunPhase(runDir, { phase, updatedAt: START } as any);
  return runDir;
}

function defaultMessages(sessions: string[]) {
  return sessions.flatMap((sessionId, index) => [
    {
      role: "user" as const, text: `问题 ${sessionId}`, sessionId, entryId: `${sessionId}-user`,
      at: Date.parse(START) + index * 2, origin: "driver" as const,
    },
    {
      role: "assistant" as const, text: `回答 ${sessionId}`, sessionId, entryId: `${sessionId}-assistant`,
      at: Date.parse(START) + index * 2 + 1, origin: "assistant" as const,
    },
  ]);
}

async function makeCompleteAttempt(runDir: string, options: any = {}) {
  const trialId = options.trialId ?? "trial-1";
  const sessions = options.sessions ?? ["session-1"];
  const started = beginChatAttempt({
    runDir,
    identity: identity(),
    expectedTrials: [{ caseId: CASE_ID, trialId }],
    expectedSessions: options.declaredSessions ?? sessions,
    createdAt: START,
  });
  if (options.extendSessions) {
    extendChatAttemptSessions({ attemptDir: started.attemptDir, sessionIds: options.extendSessions });
  }
  const dialogue = createDialogueWriter(started.attemptDir);
  for (const message of options.messages ?? defaultMessages(sessions)) dialogue.append(message);
  dialogue.close();

  const trace = createTraceWriter(started.attemptDir);
  const buffer = options.traceOverflow
    ? new BoundedTraceBuffer({ maxEvents: 1, maxBytes: 4096, maxChunkBytes: 4096 })
    : new BoundedTraceBuffer({ maxEvents: 128, maxBytes: 65536, maxChunkBytes: 32768 });
  const context = { sceneId: CASE_ID, trialId, runId: "run-1", tokenId: "token-1" };
  const omitted = new Set(options.omit ?? []);
  const boundaryTrialId = options.boundaryTrialId ?? trialId;
  const flush = (boundary: { kind: string; sceneId?: string; trialId?: string }) => {
    const chunk = buffer.drainChunk(boundary as any);
    trace.appendChunk(chunk);
    buffer.ackChunk({ chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true });
  };
  if (!omitted.has("scene_start")) flush({ kind: "scene_start", sceneId: CASE_ID, trialId: boundaryTrialId });
  if (!omitted.has("trial_start")) flush({ kind: "trial_start", sceneId: CASE_ID, trialId: boundaryTrialId });
  buffer.append({ schemaVersion: 1, kind: "turn_reply", createdAt: Date.parse(START) }, context);
  if (options.orphan) buffer.append({ schemaVersion: 1, kind: "background_event", createdAt: Date.parse(START) + 1 });
  if (options.traceOverflow) buffer.append({ schemaVersion: 1, kind: "overflow_event", createdAt: Date.parse(START) + 2 }, context);
  if (!omitted.has("trial_end")) flush({ kind: "trial_end", sceneId: CASE_ID, trialId: boundaryTrialId });
  if (!omitted.has("scene_end")) flush({ kind: "scene_end", sceneId: CASE_ID, trialId: boundaryTrialId });
  if (!omitted.has("complete")) flush({ kind: "complete" });
  trace.close();

  if (options.beforeSeal) options.beforeSeal(started.attemptDir);
  const sealed = await sealChatAttempt({
    attemptDir: started.attemptDir,
    sealedAt: SEALED,
    models: { actual: "provider/model-b" },
    sourceHash: options.sealSourceHash ?? HASH,
    inputs: options.sealInputs ?? identity().inputs,
    outcome: options.outcome ?? "completed",
  });
  return { ...sealed, attemptDir: started.attemptDir, attemptId: started.attempt.attemptId };
}

describe("聊天证据完整性", () => {
  it("完整采集封存后可核验，判分与人工裁决只追加", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-complete");
    const attempt = await makeCompleteAttempt(runDir);

    expect(attempt.status).toBe("complete");
    expect(verifySealedAttempt(attempt.attemptDir).status).toBe("complete");
    expect(verifySealedAttempt(attempt.attemptDir).issues).toEqual([]);

    const dialoguePath = join(attempt.attemptDir, "dialogue.jsonl");
    const before = statSync(dialoguePath).mtimeMs;
    appendGrade({
      attemptDir: attempt.attemptDir, gradeId: "grade-1", createdAt: SEALED,
      rubricVersion: "rubric-1", graderVersion: "grader-1", authority: "coding-agent-judge",
      checks: [], summary: { note: "format check only" },
    });
    appendReview({
      attemptDir: attempt.attemptDir, reviewId: "review-1", createdAt: SEALED,
      reviewer: { role: "user", name: "用户" }, verdict: "pass", notes: "已核对证据",
    });
    expect(statSync(dialoguePath).mtimeMs).toBe(before);
    expect(readChatWorkflow(runDir).attempts).toHaveLength(1);
    expect(() => appendGrade({
      attemptDir: attempt.attemptDir, gradeId: "grade-1", createdAt: SEALED,
      rubricVersion: "rubric-1", graderVersion: "grader-1", authority: "coding-agent-judge",
      checks: [], summary: {},
    })).toThrow(/不覆盖/);
  });

  it("声明的跨会话未被收集时封存不完整，不能生成正式判分或通过裁决", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-missed-session");
    const attempt = await makeCompleteAttempt(runDir, {
      sessions: ["session-1", "session-2"],
      messages: defaultMessages(["session-1"]),
    });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.issues.join("\n")).toContain("声明的会话未被收集：session-2");
    expect(() => appendGrade({
      attemptDir: attempt.attemptDir, gradeId: "grade-1", createdAt: SEALED,
      rubricVersion: "rubric-1", graderVersion: "grader-1", authority: "coding-agent-judge",
      checks: [], summary: {},
    })).toThrow(/证据不完整/);
    expect(() => appendReview({
      attemptDir: attempt.attemptDir, reviewId: "review-1", createdAt: SEALED,
      reviewer: { role: "user", name: "用户" }, verdict: "pass",
    })).toThrow(/证据不完整/);
    const failed = appendReview({
      attemptDir: attempt.attemptDir, reviewId: "review-fail", createdAt: SEALED,
      reviewer: { role: "user", name: "用户" }, verdict: "fail", notes: "采集缺失",
    });
    expect(failed.verdict).toBe("fail");
  });

  it("对话截断不会被当成完整证据", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-truncated-dialogue");
    const attempt = await makeCompleteAttempt(runDir, {
      beforeSeal: (attemptDir: string) => {
        const path = join(attemptDir, "dialogue.jsonl");
        const raw = readFileSync(path, "utf8");
        writeFileSync(path, raw.slice(0, -8));
      },
    });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.issues.join("\n")).toMatch(/最后一行未完整换行|不是合法 JSON/);
  });

  it("缺失边界、错绑 trial 与内容哈希不符分别被识别", async () => {
    const reportsDir = makeRoot();
    const missing = await makeCompleteAttempt(makeRun(reportsDir, "run-missing-boundary"), { omit: ["scene_end"] });
    expect(missing.issues.join("\n")).toContain("missing scene_end boundary");

    const misbound = await makeCompleteAttempt(makeRun(reportsDir, "run-misbound"), { boundaryTrialId: "trial-other" });
    expect(misbound.issues.join("\n")).toContain("missing trial_start boundary");

    const mismatched = await makeCompleteAttempt(makeRun(reportsDir, "run-hash-mismatch"), {
      beforeSeal: (attemptDir: string) => {
        const path = join(attemptDir, "trace.jsonl");
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        const envelope = JSON.parse(lines[0]!);
        envelope.chunk.injected = true;
        lines[0] = JSON.stringify(envelope);
        writeFileSync(path, `${lines.join("\n")}\n`);
      },
    });
    expect(mismatched.issues.join("\n")).toContain("content hash mismatch");
  });

  it("采集后源码或输入配置漂移会阻止完整封存", async () => {
    const reportsDir = makeRoot();
    const source = await makeCompleteAttempt(makeRun(reportsDir, "run-source-drift"), { sealSourceHash: HASH_B });
    expect(source.issues.join("\n")).toContain("源码哈希与采集开始不一致");

    const config = await makeCompleteAttempt(makeRun(reportsDir, "run-config-drift"), {
      sealInputs: { ...identity().inputs, configHash: HASH_B },
    });
    expect(config.status).toBe("inconclusive");
    expect(config.issues.join("\n")).toContain("输入哈希与采集开始不一致：configHash");
  });

  it("trace 超预算丢事件记录为不完整，不伪装成空数组成功", async () => {
    const reportsDir = makeRoot();
    const attempt = await makeCompleteAttempt(makeRun(reportsDir, "run-trace-overflow"), { traceOverflow: true });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.manifest.evidence.trace.droppedCount).toBe(1);
    expect(attempt.issues.join("\n")).toContain("dropped events reported");
  });

  it("重复 chunk 与 complete 之后的追加块被识别", async () => {
    const reportsDir = makeRoot();
    const attempt = await makeCompleteAttempt(makeRun(reportsDir, "run-duplicate-chunk"), {
      beforeSeal: (attemptDir: string) => {
        const path = join(attemptDir, "trace.jsonl");
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        appendFileSync(path, `${lines[lines.length - 1]}\n`);
      },
    });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.issues.join("\n")).toMatch(/duplicate chunk id|chunk appears after complete boundary/);
  });

  it("未归属 orphan 事件不会被静默丢弃或当作完整证据", async () => {
    const reportsDir = makeRoot();
    const attempt = await makeCompleteAttempt(makeRun(reportsDir, "run-orphan"), { orphan: true });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.manifest.evidence.trace.orphanCount).toBe(1);
    expect(attempt.issues.join("\n")).toContain("orphan");
  });

  it("对话只允许白名单正文，隐藏思维链与旧 raw 字段被拒绝且 parts 必须同源 [chat-evidence-reply-evidence-whitelist]", () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-hidden-cot");
    const started = beginChatAttempt({
      runDir,
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "trial-1" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    const writer = createDialogueWriter(started.attemptDir);
    expect(() => writer.append({
      role: "user", text: "你好", sessionId: "session-1", entryId: "entry-1",
      at: Date.parse(START), origin: "driver", reasoning: "hidden chain",
    } as any)).toThrow(/白名单/);
    expect(() => writer.append({
      role: "assistant", text: "最终正文", sessionId: "session-1", entryId: "entry-2",
      at: Date.parse(START) + 1, origin: "assistant", deskpetRawVisibleText: "不可信旧字段",
    } as any)).toThrow(/白名单/);
    expect(() => writer.append({
      role: "assistant", text: "最终正文", textParts: ["另一段"],
      sessionId: "session-1", entryId: "entry-3", at: Date.parse(START) + 2, origin: "assistant",
    } as any)).toThrow(/textParts 与最终正文不一致/);
    expect(() => writer.append({
      role: "assistant", text: "最终正文", sessionId: "session-1", entryId: "entry-4",
      at: Date.parse(START) + 3, origin: "assistant",
      replyEvidence: { availability: "available", evidence: {
        schemaVersion: 1, generatedText: "生成文本", outcome: "delivered",
        humanizerEnabled: false, transformation: "none", privateThought: "hidden",
      } },
    } as any)).toThrow(/replyEvidence 结构非法/);
    expect(() => writer.append({
      role: "assistant", text: "最终正文", sessionId: "session-1", entryId: "entry-null-evidence",
      at: Date.parse(START) + 3, origin: "assistant", replyEvidence: null,
    } as any)).toThrow(/replyEvidence 结构非法/);
    expect(() => writer.append({
      role: "assistant", text: "最终正文", sessionId: "session-1", entryId: "entry-5",
      at: Date.parse(START) + 4, origin: "assistant", toolCallCount: -1,
    } as any)).toThrow(/toolCallCount 必须是非负整数或 null/);
    const unknownToolCount = writer.append({
      role: "assistant", text: "最终正文", sessionId: "session-1", entryId: "entry-6",
      at: Date.parse(START) + 5, origin: "assistant", toolCallCount: null,
    } as any);
    expect(unknownToolCount.toolCallCount).toBeNull();
    writer.close();
  });

  it("封存后篡改证据或新增文件会被核验发现并阻止判分", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-tampered");
    const attempt = await makeCompleteAttempt(runDir);
    const dialoguePath = join(attempt.attemptDir, "dialogue.jsonl");
    chmodSync(dialoguePath, 0o644);
    appendFileSync(dialoguePath, `{"seq":99}\n`);

    const verification = verifySealedAttempt(attempt.attemptDir);
    expect(verification.status).toBe("inconclusive");
    expect(verification.issues.join("\n")).toContain("哈希不匹配");
    expect(() => appendGrade({
      attemptDir: attempt.attemptDir, gradeId: "grade-1", createdAt: SEALED,
      rubricVersion: "rubric-1", graderVersion: "grader-1", authority: "coding-agent-judge",
      checks: [], summary: {},
    })).toThrow(/封存证据不可信/);
    expect(() => appendReview({
      attemptDir: attempt.attemptDir, reviewId: "review-1", createdAt: SEALED,
      reviewer: { role: "user", name: "用户" }, verdict: "pass",
    })).toThrow(/封存证据不可信/);

    const extra = await makeCompleteAttempt(makeRun(reportsDir, "run-extra-file"), { trialId: "trial-2" });
    writeFileSync(join(extra.attemptDir, "unexpected.txt"), "tamper");
    expect(verifySealedAttempt(extra.attemptDir).status).toBe("inconclusive");
    expect(verifySealedAttempt(extra.attemptDir).issues.join("\n")).toContain("未声明文件");
  });

  it("封存后的 generatedText 改动被哈希核验发现 [chat-evidence-reply-evidence-tamper]", async () => {
    const reportsDir = makeRoot();
    const messages = defaultMessages(["session-1"]).map(message => message.role === "assistant" ? {
      ...message,
      replyEvidence: {
        availability: "available" as const,
        evidence: {
          schemaVersion: 1 as const,
          generatedText: "冻结生成原文",
          outcome: "delivered" as const,
          humanizerEnabled: true,
          transformation: "formatting" as const,
        },
      },
    } : message);
    const attempt = await makeCompleteAttempt(makeRun(reportsDir, "run-raw-tampered"), { messages });
    const dialoguePath = join(attempt.attemptDir, "dialogue.jsonl");
    chmodSync(dialoguePath, 0o644);
    const rows = readFileSync(dialoguePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const assistant = rows.find(row => row.role === "assistant");
    assistant.replyEvidence.evidence.generatedText = "封存后被改写";
    writeFileSync(dialoguePath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

    const verification = verifySealedAttempt(attempt.attemptDir);
    expect(verification.status).toBe("inconclusive");
    expect(verification.issues.join("\n")).toContain("哈希不匹配");
  });

  it("失败重跑创建新 attempt，旧证据与 manifest 哈希保持不变", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-retry");
    const first = await makeCompleteAttempt(runDir);
    const firstHash = readSealedAttempt(first.attemptDir).manifestSha256;
    const second = await makeCompleteAttempt(runDir, { trialId: "trial-2", outcome: "failed" });

    expect(second.attemptId).toBe("0002");
    expect(second.status).toBe("inconclusive");
    expect(second.issues.join("\n")).toContain("outcome=failed");
    expect(readSealedAttempt(first.attemptDir).manifestSha256).toBe(firstHash);
    expect(readChatWorkflow(runDir).attempts.map((item) => item.attemptId)).toEqual(["0001", "0002"]);
    expect(() => beginChatAttempt({
      runDir,
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "trial-1" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    })).toThrow(/已在同运行组使用/);
  });

  it("报告只重建视图：完整证据可展示判分与裁决，未封存/不完整证据不得显示为通过", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-report");
    const attempt = await makeCompleteAttempt(runDir);
    appendGrade({
      attemptDir: attempt.attemptDir, gradeId: "grade-1", createdAt: SEALED,
      rubricVersion: "rubric-1", graderVersion: "grader-1", authority: "coding-agent-judge",
      checks: [], summary: {},
    });
    appendReview({
      attemptDir: attempt.attemptDir, reviewId: "review-1", createdAt: SEALED,
      reviewer: { role: "user", name: "用户" }, verdict: "pass",
    });
    const dialoguePath = join(attempt.attemptDir, "dialogue.jsonl");
    const before = statSync(dialoguePath).mtimeMs;

    const markdown = renderChatReport({ runDir, generatedAt: SEALED });
    expect(markdown).toContain("证据完整性通过");
    expect(markdown).toContain("grade-1");
    expect(markdown).toContain("review-1");
    expect(markdown).toContain("provider/model-b");
    const written = writeChatReport({ runDir, generatedAt: SEALED });
    expect(existsSync(written.path)).toBe(true);
    expect(statSync(dialoguePath).mtimeMs).toBe(before);

    beginChatAttempt({
      runDir,
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "trial-2" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    expect(renderChatReport({ runDir, generatedAt: SEALED })).toContain("尚未封存");

    chmodSync(dialoguePath, 0o644);
    appendFileSync(dialoguePath, `{"seq":100}\n`);
    expect(renderChatReport({ runDir, generatedAt: SEALED })).toContain("不能判为通过");
  });

  it("报告在驱动包含手工触发时注明组件路径，不冒充自然受理或 UI 显示 [chat-report-manual-trigger]", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-report-manual");
    const attempt = await makeCompleteAttempt(runDir, {
      beforeSeal: (attemptDir: string) => {
        writeArtifact({
          attemptDir,
          name: "driver-package.json",
          bytes: JSON.stringify({
            schemaVersion: 4,
            caseId: CASE_ID,
            revision: 1,
            specHash: HASH,
            userRole: { knownFacts: [], goal: "自然陪伴", tone: "口语", allowedActions: ["chat"], mustNotReveal: [] },
            driver: [
              { id: "open", kind: "host", method: "chat_new_session", at: START },
              { id: "proactive", kind: "host", method: "sim_proactive_tick", at: SEALED },
            ],
          }),
        });
      },
    });

    const markdown = renderChatReport({ runDir, generatedAt: SEALED });
    expect(markdown).toContain("手工触发");
    expect(markdown).toContain("sim_proactive_tick");
    expect(markdown).toContain("不代表自然受理、调度或实际 UI 显示");
    expect(attempt.status).toBe("complete");

    const plainRun = makeRun(reportsDir, "run-report-plain");
    await makeCompleteAttempt(plainRun);
    expect(renderChatReport({ runDir: plainRun, generatedAt: SEALED })).not.toContain("手工触发");
  });
});

describe("运行组复用与采集后补声明", () => {
  it("同一 evaluationRunId 只建一次运行组，复用不重置阶段与范围", () => {
    const reportsDir = makeRoot();
    const args = {
      reportsDir,
      evaluationRunId: "run-ensure",
      createdAt: START,
      scope: { suiteIds: ["daily-companionship"], caseIds: [CASE_ID] },
      budget: { trials: 1, maxCostUsd: 1 },
    };
    const first = ensureChatRun(args);
    expect(first.created).toBe(true);
    setChatRunPhase(first.runDir, { phase: "running", updatedAt: START });

    const second = ensureChatRun(args);
    expect(second.created).toBe(false);
    expect(second.runDir).toBe(first.runDir);
    expect(readChatRun(first.runDir)).toMatchObject({
      evaluationRunId: "run-ensure",
      scope: { suiteIds: ["daily-companionship"], caseIds: [CASE_ID] },
    });
    expect(readChatWorkflow(first.runDir).phase).toBe("running");
  });

  it("驱动新建的会话在封存前补声明后才算完整", async () => {
    const reportsDir = makeRoot();
    const runDir = makeRun(reportsDir, "run-extend");
    const attempt = await makeCompleteAttempt(runDir, {
      sessions: ["session-1", "session-2"],
      declaredSessions: ["session-1"],
      extendSessions: ["session-2", "session-1"],
    });

    expect(attempt.status).toBe("complete");
    expect(readSealedAttempt(attempt.attemptDir).expectedSessions).toEqual(["session-1", "session-2"]);
    expect(readSealedAttempt(attempt.attemptDir).evidence.dialogue.sessions).toEqual(["session-1", "session-2"]);
  });

  it("收集到未声明的会话时封存不完整", async () => {
    const reportsDir = makeRoot();
    const attempt = await makeCompleteAttempt(makeRun(reportsDir, "run-undeclared"), {
      sessions: ["session-1", "session-2"],
      declaredSessions: ["session-1"],
    });

    expect(attempt.status).toBe("inconclusive");
    expect(attempt.issues.join("\n")).toContain("收集到未声明会话：session-2");
  });

  it("封存后不再接受追加声明，草稿阶段只去重不引入空会话", async () => {
    const reportsDir = makeRoot();
    const started = beginChatAttempt({
      runDir: makeRun(reportsDir, "run-extend-guard"),
      identity: identity(),
      expectedTrials: [{ caseId: CASE_ID, trialId: "trial-1" }],
      expectedSessions: ["session-1"],
      createdAt: START,
    });
    expect(extendChatAttemptSessions({
      attemptDir: started.attemptDir,
      sessionIds: ["session-2", "session-1"],
    }).expectedSessions).toEqual(["session-1", "session-2"]);
    expect(() => extendChatAttemptSessions({ attemptDir: started.attemptDir, sessionIds: [] }))
      .toThrow(/不能为空/);

    const sealed = await makeCompleteAttempt(makeRun(reportsDir, "run-extend-sealed"));
    expect(() => extendChatAttemptSessions({ attemptDir: sealed.attemptDir, sessionIds: ["session-3"] }))
      .toThrow(/已封存/);
  });
});
