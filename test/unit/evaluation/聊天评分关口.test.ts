// ==========================================
// 聊天判分关口 — 判分包冻结、异构 coding-agent judge、可选抽查与同源报告
// ==========================================
//
// 反例用独立构造的 case／fixture／对话与状态快照；运行器不调用模型，也不读取凭据。
// judge 裁决全部由测试直接构造，验证的是「包是否冻结正确、裁决是否被严格校验、
// 记录是否只追加」这一层，不验证任何判分脚本或内容词表。
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedTraceBuffer } from "@/services/sim/trace-chunk";
import type {
  CaseBinding,
  CaseEntry,
  CaseSpec,
  Dataset,
  DriverStep,
  FixtureSpec,
  ProbeSpec,
  SubjectSpec,
} from "../../sim/desk-pet-chat/dataset.mjs";
import { datasetInputHash, hashCanonical } from "../../sim/desk-pet-chat/dataset.mjs";
import {
  CHAT_GRADER_VERSION,
  beginChatAttempt,
  createChatRun,
  createDialogueWriter,
  createTraceWriter,
  sealChatAttempt,
  setChatRunPhase,
  writeStateSnapshot,
} from "../../sim/desk-pet-chat/evidence.mjs";
import type {
  JudgeIdentity,
  JudgePacket,
  JudgeVerdict,
  JudgeVerdictInput,
  JudgeVerdictsInput,
} from "../../sim/desk-pet-chat/judging.mjs";
import {
  JUDGE_AUTHORITY,
  JUDGE_PROMPT_VERSION,
  JUDGE_RUBRIC_VERSION,
  JudgingError,
  applyJudgeVerdicts,
  checkDriverNoOracleLeak,
  formatJudgePacket,
  latestJudgeGrade,
  loadJudgingContext,
  prepareJudgePacket,
  readJudgePacket,
  readJudgingRecords,
  recordSpotCheck,
  summarizeAttemptStatus,
  validateJudgeVerdicts,
} from "../../sim/desk-pet-chat/judging.mjs";
import { renderChatReport } from "../../sim/desk-pet-chat/report.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const HASH_E = `sha256:${"e".repeat(64)}`;
const START = "2026-10-24T09:00:00.000+08:00";
const SEALED = "2026-10-24T12:00:00.000+08:00";
const PREPARED = "2026-10-24T12:05:00.000+08:00";
const JUDGED = "2026-10-24T12:10:00.000+08:00";
const REVIEWED = "2026-10-24T12:20:00.000+08:00";
const LATER = "2026-10-24T12:30:00.000+08:00";
const REPORTED = "2026-10-24T12:40:00.000+08:00";
const UNDER_TEST = "provider/model-under-test";
const ACTUAL_MODEL = "provider/model-b";
const JUDGE: JudgeIdentity = {
  platform: "qoder",
  model: "judge/model-x",
  promptVersion: JUDGE_PROMPT_VERSION,
};
const QUALITY_RULE = "quality:humanizer-six-dimensions";
const FIXTURE_SESSION = "fixture-session";
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const USER = { role: "user" as const, name: "测试用户" };
const RUNNING: SubjectSpec = { label: "跑步", aliases: ["跑", "晨跑"] };
const SOURCE_TEXT = "更正一下：我现在一周只跑一次，以前跑得可勤了";
const ASK_HISTORY_TEXT = "你还记得我现在一周跑几次吗？";
const ASK_TRAP_TEXT = "你之前是不是说我每天跑十公里？";

// 每一轮先开新会话（SKILL 约定）：纠正发生在 session-a，跨会话提问发生在 session-b。
const DEFAULT_DRIVER: DriverStep[] = [
  { id: "open-a", kind: "host", method: "chat_new_session", at: "2026-10-24T09:05:00.000+08:00" },
  {
    id: "source-correction",
    kind: "message",
    text: SOURCE_TEXT,
    at: "2026-10-24T09:10:00.000+08:00",
  },
  { id: "open-b", kind: "host", method: "chat_new_session", at: "2026-10-24T09:20:00.000+08:00" },
  {
    id: "ask-history",
    kind: "message",
    text: ASK_HISTORY_TEXT,
    at: "2026-10-24T09:30:00.000+08:00",
  },
  {
    id: "ask-trap",
    kind: "message",
    text: ASK_TRAP_TEXT,
    at: "2026-10-24T09:40:00.000+08:00",
  },
];

const DEFAULT_REPLIES: Record<string, string[]> = {
  "source-correction": ["好，记下了：你现在一周只跑一次。"],
  "ask-history": ["你现在一周跑一次，以前跑得勤。"],
  "ask-trap": ["不是每天十公里，你现在一周只跑一次。"],
};

const roots: string[] = [];
let worldCounter = 0;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface World {
  root: string;
  reportsDir: string;
  dataset: Dataset;
  entry: CaseEntry;
  driver: DriverStep[];
  attemptCount: number;
}

interface WorldOptions {
  driver?: DriverStep[];
  probes?: ProbeSpec[];
  title?: string;
}

function defaultProbes(): ProbeSpec[] {
  return [
    {
      id: "p-source",
      after: "source-correction",
      window: "state",
      rubric: "memory-source.correction-entry",
      questionType: "source",
      polarity: "required",
      critical: true,
      difficulty: 2,
      description: "纠正事实必须来自本轮用户消息",
      expectation: { subjects: [RUNNING] },
    },
    {
      id: "p-no-fixture",
      after: "source-correction",
      window: "state",
      rubric: "memory-source.no-fixture-as-update",
      questionType: "source",
      polarity: "forbidden",
      critical: true,
      difficulty: 3,
      description: "不得把 fixture 初始记忆当成本轮用户更新",
      expectation: { subjects: [RUNNING] },
    },
    {
      id: "p-provenance",
      after: "ask-history",
      window: "last-assistant",
      rubric: "session.answer-in-new-session",
      questionType: "cross-session",
      polarity: "required",
      critical: true,
      difficulty: 3,
      description: "回答必须发生在驱动新建的会话",
      expectation: { sourceStep: "source-correction" },
    },
    {
      id: "p-current",
      after: "ask-history",
      window: "last-assistant",
      rubric: "answer.fact-recall",
      questionType: "temporal",
      polarity: "required",
      critical: true,
      difficulty: 3,
      description: "回答当前频率",
      expectation: {
        fact: { kind: "frequency", subject: RUNNING, frequency: "once-weekly", temporal: "current" },
      },
    },
    {
      id: "p-cross",
      after: "ask-history",
      window: "last-assistant",
      rubric: "answer.cross-session-recall",
      questionType: "cross-session",
      polarity: "required",
      critical: true,
      difficulty: 4,
      description: "跨会话回忆当前频率与历史",
      expectation: {
        sourceStep: "source-correction",
        requiredFacts: [
          { kind: "frequency", subject: RUNNING, frequency: "once-weekly", temporal: "current" },
        ],
      },
    },
    {
      id: "p-no-swap",
      after: "ask-history",
      window: "last-assistant",
      rubric: "answer.temporal-scope",
      questionType: "temporal",
      polarity: "forbidden",
      critical: true,
      difficulty: 4,
      description: "不得把当前频率说成过去",
      expectation: {
        forbidden: [{ subject: RUNNING, frequency: "once-weekly", temporal: "past" }],
      },
    },
    {
      id: "p-trap",
      after: "ask-trap",
      window: "last-assistant",
      rubric: "answer.corrects-false-premise",
      questionType: "adversarial",
      polarity: "required",
      critical: true,
      difficulty: 4,
      description: "纠正错误前提",
    },
    {
      id: "p-leak",
      after: "ask-trap",
      window: "all-assistant",
      rubric: "reply.no-oracle-leak",
      questionType: "boundary",
      polarity: "forbidden",
      critical: true,
      difficulty: 1,
      description: "回复不得泄露探针或评分内部信息",
    },
    {
      id: "p-style",
      after: "ask-trap",
      window: "last-assistant",
      rubric: "humanizer.short-confirmation",
      questionType: "style",
      polarity: "required",
      critical: false,
      difficulty: 2,
      description: "口吻自然，仍由 judge 按 rubric 判断",
    },
  ];
}

function skippedProbe(): ProbeSpec {
  return {
    id: "p-skip",
    after: "open-a",
    window: "last-assistant",
    rubric: "answer.no-fabrication",
    questionType: "adversarial",
    polarity: "required",
    critical: true,
    difficulty: 2,
    description: "宿主步骤没有可判定的回复窗口",
  };
}

function makeWorld(options: WorldOptions = {}): World {
  worldCounter += 1;
  const root = mkdtempSync(join(tmpdir(), "desk-pet-w4-judge-"));
  roots.push(root);
  const suiteId = "w4-gate-suite";
  const caseId = `w4-gate-case-${worldCounter}`;
  const driver = options.driver ?? DEFAULT_DRIVER;
  const probes = options.probes ?? defaultProbes();
  const fixtureId = "w4-gate-fixture";
  const questionTypes = [...new Set(probes.map((probe) => probe.questionType))];
  const caseSpec: CaseSpec = {
    schemaVersion: 4,
    caseId,
    revision: 1,
    familyId: "w4-gate",
    title: options.title ?? "W4 判分关口反例",
    categories: ["chat"],
    questionTypes,
    source: { kind: "ideal", ref: "本地反例构造", excerpt: "测试对话", note: "不进入真实数据集" },
    precondition: {
      card: "测试卡",
      profile: "default",
      fixtureId,
      time: { mode: "fixed" },
      hostCapabilities: ["chat", "memory", "session"],
    },
    userRole: {
      knownFacts: ["现在一周只跑一次", "实习以前跑得很勤"],
      goal: "验证跨会话回忆与来源",
      tone: "自然口语",
      allowedActions: [],
      mustNotReveal: ["探针", "评分", "数据集"],
    },
    driver,
    probes,
    checkpoints: [],
    oracle: { allowedAlternatives: ["口语同义改写"] },
    pathConstraints: { requiredOrder: [], forbiddenSideEffects: [], allowedToolSubstitutions: [] },
    evidence: [],
    quality: { rubric: "humanizer-six-dimensions", rubricVersion: 1 },
    governance: { purpose: "regression", unresolvedPoints: [], notes: [] },
  };
  const fixture: FixtureSpec = {
    schemaVersion: 4,
    fixtureId,
    card: "测试卡",
    profile: "default",
    clock: "2026-10-24T09:00:00.000+08:00",
    loading: { mode: "direct-seed", note: "只重建纠正前上下文" },
    initialSession: {
      id: FIXTURE_SESSION,
      title: "旧会话",
      messages: [
        {
          id: "f1",
          role: "user",
          content: "我实习前跑得可勤了",
          at: "2026-10-23T20:00:00.000+08:00",
        },
        {
          id: "f2",
          role: "assistant",
          content: "那会儿你确实常跑",
          at: "2026-10-23T20:00:01.000+08:00",
        },
      ],
    },
    initialMemory: [],
    allowedPreparation: [],
  };
  const binding: CaseBinding = {
    contentHash: HASH_A,
    fixtureHash: HASH_B,
    driverHash: HASH_C,
    oracleHash: HASH_D,
    specHash: HASH_E,
  };
  const entry: CaseEntry = {
    caseId,
    suiteId,
    casePath: `${caseId}.case.json`,
    fixturePath: `${fixtureId}.json`,
    case: caseSpec,
    fixture,
    binding,
    approvals: [],
    label: { tier: "silver", status: "pending", approvalId: null, reviewedAt: null, mismatches: [] },
  };
  const dataset: Dataset = {
    schemaVersion: 4,
    repoRoot: root,
    root,
    categoriesPath: null,
    categories: [{ id: "chat" }],
    questionTypesPath: null,
    questionTypeFamilies: [{ id: "w4-gate", name: "W4", goal: "关口反例" }],
    questionTypes: questionTypes.map((id) => ({
      id,
      family: "w4-gate",
      name: id,
      goal: "关口反例",
      capabilities: [],
    })),
    suites: [
      {
        schemaVersion: 4,
        suiteId,
        revision: 1,
        purpose: "regression",
        title: "W4 关口",
        caseIds: [caseId],
        path: join(root, "suite.json"),
      },
    ],
    cases: [entry],
    approvals: [],
    errors: [],
    warnings: [],
  };
  return { root, reportsDir: join(root, "reports"), dataset, entry, driver, attemptCount: 0 };
}

interface AttemptOptions {
  name?: string;
  seal?: boolean;
  requestedModel?: string;
  actualModel?: string;
  omitTrace?: string[];
}

interface SealedAttempt {
  runDir: string;
  attemptDir: string;
  attemptId: string;
  sealed: Awaited<ReturnType<typeof sealChatAttempt>> | null;
}

function sessionFor(stepId: string): string {
  return stepId === "source-correction" ? SESSION_A : SESSION_B;
}

async function sealAttempt(world: World, options: AttemptOptions = {}): Promise<SealedAttempt> {
  world.attemptCount += 1;
  const name = options.name ?? "main";
  const { runDir } = createChatRun({
    reportsDir: world.reportsDir,
    evaluationRunId: `run-${world.attemptCount}-${name}`,
    createdAt: START,
    scope: { suiteIds: [world.entry.suiteId], caseIds: [world.entry.caseId] },
    budget: { trials: 1, maxCostUsd: 1 },
  });
  setChatRunPhase(runDir, { phase: "completed", updatedAt: START });

  const messageSessions: string[] = [];
  for (const step of world.driver) {
    if (step.kind !== "message") continue;
    const session = sessionFor(step.id);
    if (!messageSessions.includes(session)) messageSessions.push(session);
  }

  const identity = {
    code: { commit: "abc1234", sourceHash: HASH_A, dirty: false },
    inputs: {
      datasetHash: datasetInputHash(world.dataset, world.entry),
      fixtureHash: world.entry.binding.fixtureHash,
      cardHash: HASH_C,
      configHash: HASH_D,
    },
    tools: {
      driverVersion: "driver-w4",
      rubricVersion: JUDGE_RUBRIC_VERSION,
      graderVersion: CHAT_GRADER_VERSION,
    },
    host: { mode: "full-desktop", capabilities: ["chat", "memory", "session"] },
    platform: { os: "darwin", arch: "arm64" },
    runtime: { version: "22.22.3" },
    models: { requested: options.requestedModel ?? UNDER_TEST },
    budget: { trials: 1, maxCostUsd: 1 },
  };
  const trialId = `trial-${world.attemptCount}-${name}`;
  const started = beginChatAttempt({
    runDir,
    identity,
    expectedTrials: [{ caseId: world.entry.caseId, trialId }],
    expectedSessions: messageSessions,
    createdAt: START,
  });

  const base = Date.parse(START);
  let tick = 0;
  const nextAt = () => base + (tick += 1) * 1000;
  const dialogue = createDialogueWriter(started.attemptDir);
  for (const step of world.driver) {
    if (step.kind !== "message") continue;
    const session = sessionFor(step.id);
    dialogue.append({
      role: "user",
      text: step.text,
      sessionId: session,
      entryId: `${step.id}-u`,
      at: nextAt(),
      origin: "driver",
    });
    for (const [index, text] of (DEFAULT_REPLIES[step.id] ?? []).entries()) {
      dialogue.append({
        role: "assistant",
        text,
        sessionId: session,
        entryId: `${step.id}-a${index + 1}`,
        at: nextAt(),
        origin: "assistant",
      });
    }
  }
  dialogue.close();

  const trace = createTraceWriter(started.attemptDir);
  const buffer = new BoundedTraceBuffer({ maxEvents: 128, maxBytes: 65536, maxChunkBytes: 32768 });
  const context = { sceneId: world.entry.caseId, trialId, runId: "run-1", tokenId: "token-1" };
  const omitted = new Set(options.omitTrace ?? []);
  const flush = (boundary: { kind: string; sceneId?: string; trialId?: string }) => {
    const chunk = buffer.drainChunk(boundary as never);
    trace.appendChunk(chunk);
    buffer.ackChunk({ chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true });
  };
  if (!omitted.has("scene_start")) {
    flush({ kind: "scene_start", sceneId: world.entry.caseId, trialId });
  }
  if (!omitted.has("trial_start")) {
    flush({ kind: "trial_start", sceneId: world.entry.caseId, trialId });
  }
  buffer.append({ schemaVersion: 1, kind: "turn_reply", createdAt: base + 1 }, context);
  if (!omitted.has("trial_end")) {
    flush({ kind: "trial_end", sceneId: world.entry.caseId, trialId });
  }
  if (!omitted.has("scene_end")) {
    flush({ kind: "scene_end", sceneId: world.entry.caseId, trialId });
  }
  if (!omitted.has("complete")) flush({ kind: "complete" });
  trace.close();

  writeStateSnapshot({
    attemptDir: started.attemptDir,
    name: "before",
    value: {
      schemaVersion: 1,
      complete: true,
      activeSessionId: FIXTURE_SESSION,
      sessions: [
        { sessionId: FIXTURE_SESSION, createdAt: base, modifiedAt: base, messageCount: 1 },
      ],
      memory: { complete: true, items: [] },
      issues: [],
    },
  });
  writeStateSnapshot({
    attemptDir: started.attemptDir,
    name: "after",
    value: {
      schemaVersion: 1,
      complete: true,
      activeSessionId: messageSessions[messageSessions.length - 1] ?? null,
      sessions: [FIXTURE_SESSION, ...messageSessions].map((sessionId, index) => ({
        sessionId,
        createdAt: base + index * 100000,
        modifiedAt: base + index * 100000,
        messageCount: 1,
      })),
      memory: {
        complete: true,
        items: [
          {
            id: "m1",
            version: 1,
            status: "active",
            kind: "fact",
            content: "用户现在一周只跑一次",
            sourceIds: [`${SESSION_A}:source-correction-u`],
            updatedAt: base + 5000,
          },
        ],
      },
      issues: [],
    },
  });

  if (options.seal === false) {
    return { runDir, attemptDir: started.attemptDir, attemptId: started.attempt.attemptId, sealed: null };
  }
  const sealed = await sealChatAttempt({
    attemptDir: started.attemptDir,
    sealedAt: SEALED,
    models: { actual: options.actualModel ?? ACTUAL_MODEL },
    sourceHash: HASH_A,
    inputs: identity.inputs,
  });
  return { runDir, attemptDir: started.attemptDir, attemptId: started.attempt.attemptId, sealed };
}

async function prepare(world: World, options: AttemptOptions = {}, now = PREPARED) {
  const attempt = await sealAttempt(world, options);
  const packet = prepareJudgePacket({
    runDir: attempt.runDir,
    attemptDir: attempt.attemptDir,
    dataset: world.dataset,
    caseEntry: world.entry,
    now,
  });
  return { ...attempt, packet };
}

type PreparedAttempt = Awaited<ReturnType<typeof prepare>>;

function apply(
  world: World,
  prepared: PreparedAttempt,
  verdicts: JudgeVerdictsInput,
  options: { now?: string; verdictsSha256?: string | null } = {},
) {
  return applyJudgeVerdicts({
    runDir: prepared.runDir,
    attemptDir: prepared.attemptDir,
    dataset: world.dataset,
    caseEntry: world.entry,
    packetId: prepared.packet.packet.packetId,
    verdicts,
    verdictsSha256: options.verdictsSha256 ?? null,
    now: options.now ?? JUDGED,
  });
}

function statusFor(world: World, attempt: { attemptDir: string }) {
  const context = loadJudgingContext({ attemptDir: attempt.attemptDir, caseEntry: world.entry });
  const { grades, reviews } = readJudgingRecords(attempt.attemptDir);
  return summarizeAttemptStatus({ caseEntry: world.entry, context, grades, reviews });
}

interface VerdictOptions {
  perRule?: Record<string, JudgeVerdict | Partial<JudgeVerdictInput>>;
  judge?: Partial<JudgeIdentity>;
  judgedAt?: string;
  packetId?: string;
  packetSha256?: string;
  caseId?: string;
}

function verdictsFor(packet: JudgePacket, options: VerdictOptions = {}): JudgeVerdictsInput {
  const ref = packet.allowedEvidenceRefs.find((item) => item.startsWith("dialogue:"))
    ?? "trace:trace.jsonl";
  const verdicts: JudgeVerdictInput[] = packet.rules.map((rule) => {
    const override = options.perRule?.[rule.ruleId];
    const base: JudgeVerdictInput = {
      ruleId: rule.ruleId,
      verdict: "pass",
      reason: "依据包内证据判定",
      evidenceRefs: [ref],
    };
    if (override === undefined) return base;
    if (typeof override === "string") {
      return {
        ...base,
        verdict: override,
        evidenceRefs: override === "inconclusive" ? [] : base.evidenceRefs,
      };
    }
    return { ...base, ...override };
  });
  return {
    schemaVersion: 1,
    packetId: options.packetId ?? packet.packetId,
    packetSha256: options.packetSha256 ?? packet.packetSha256,
    caseId: options.caseId ?? packet.caseId,
    judgedAt: options.judgedAt ?? JUDGED,
    judge: { ...JUDGE, ...options.judge },
    verdicts,
  };
}

function mutated(
  verdicts: JudgeVerdictsInput,
  change: (draft: JudgeVerdictsInput) => void,
): JudgeVerdictsInput {
  const draft = structuredClone(verdicts);
  change(draft);
  return draft;
}

function assertJudgingError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JudgingError);
    expect((error as JudgingError).code).toBe(code);
    return;
  }
  expect.unreachable(`应抛出 ${code}`);
}

function rewriteManifest(attemptDir: string, change: (manifest: Record<string, unknown>) => void) {
  const path = join(attemptDir, "manifest.json");
  chmodSync(path, 0o644);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(manifest);
  delete manifest.manifestSha256;
  manifest.manifestSha256 = hashCanonical(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function rewritePacket(path: string, change: (packet: Record<string, unknown>) => void) {
  const packet = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(packet);
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
}

function driftWorld(world: World) {
  world.entry.case.title = `${world.entry.case.title}（已漂移）`;
}

async function preparedWorld(options: WorldOptions = {}) {
  const world = makeWorld(options);
  const prepared = await prepare(world);
  return { world, prepared };
}

async function judgedWorld(options: WorldOptions = {}, verdictOptions: VerdictOptions = {}) {
  const world = makeWorld(options);
  const prepared = await prepare(world);
  const verdicts = verdictsFor(prepared.packet.packet, verdictOptions);
  const applied = apply(world, prepared, verdicts);
  return { world, prepared, verdicts, applied };
}

function reportFor(world: World, attempt: { runDir: string }) {
  return renderChatReport({ runDir: attempt.runDir, generatedAt: REPORTED, dataset: world.dataset });
}

describe("判分包冻结与隐私", () => {
  it("冻结全量规则、时间线与允许引用，不携带标签或历史判分 [chat-judge-packet-freeze]", async () => {
    const world = makeWorld();
    const prepared = await prepare(world);
    const { packet } = prepared.packet;

    expect(packet.kind).toBe("chat-judge-packet");
    expect(packet.rules.map((rule) => rule.ruleId)).toEqual([
      ...defaultProbes().map((probe) => probe.id),
      QUALITY_RULE,
    ]);
    expect(packet.rules).toHaveLength(10);
    expect(packet.skippedRules).toEqual([]);
    expect(packet.timeline.map((message) => message.text)).toContain(SOURCE_TEXT);
    expect(packet.timeline.some((message) => message.origin === "assistant")).toBe(true);
    expect(packet.allowedEvidenceRefs).toContain(`dialogue:${SESSION_A}:source-correction-u`);
    expect(packet.allowedEvidenceRefs).toContain("state:before");
    expect(packet.allowedEvidenceRefs).toContain("state:after");
    expect(packet.allowedEvidenceRefs).toContain("trace:trace.jsonl");
    expect(packet.allowedEvidenceRefs).not.toContain("state:capture");
    expect(packet.versions).toMatchObject({
      graderVersion: CHAT_GRADER_VERSION,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      rubricVersion: JUDGE_RUBRIC_VERSION,
      datasetSchemaVersion: 4,
    });
    expect(packet.underTest).toEqual({ requested: UNDER_TEST, actual: ACTUAL_MODEL });
    expect(packet).not.toHaveProperty("label");
    expect(packet).not.toHaveProperty("tier");
    expect(packet.case).not.toHaveProperty("tier");
    expect(JSON.stringify(packet)).not.toContain("silver");
    expect(packet.verdictFormat).toMatchObject({
      schemaVersion: 1,
      packetId: packet.packetId,
      caseId: world.entry.caseId,
    });
    expect(packet.rules.find((rule) => rule.ruleId === QUALITY_RULE)?.window.mode).toBe(
      "all-assistant",
    );
  });

  it("未封存、trace 不完整与执行失败都不能冻结判分包", async () => {
    const unsealedWorld = makeWorld();
    const unsealed = await sealAttempt(unsealedWorld, { name: "unsealed", seal: false });
    assertJudgingError(
      () => prepareJudgePacket({
        runDir: unsealed.runDir,
        attemptDir: unsealed.attemptDir,
        dataset: unsealedWorld.dataset,
        caseEntry: unsealedWorld.entry,
        now: PREPARED,
      }),
      "packet.evidence",
    );

    const traceWorld = makeWorld();
    const traceAttempt = await sealAttempt(traceWorld, { name: "trace", omitTrace: ["complete"] });
    assertJudgingError(
      () => prepareJudgePacket({
        runDir: traceAttempt.runDir,
        attemptDir: traceAttempt.attemptDir,
        dataset: traceWorld.dataset,
        caseEntry: traceWorld.entry,
        now: PREPARED,
      }),
      "packet.evidence",
    );

    const failedWorld = makeWorld();
    const failed = await prepare(failedWorld, { name: "failed" });
    expect(failed.sealed?.status).toBe("complete");
    rewriteManifest(failed.attemptDir, (manifest) => {
      manifest.outcome = "failed";
    });
    assertJudgingError(
      () => prepareJudgePacket({
        runDir: failed.runDir,
        attemptDir: failed.attemptDir,
        dataset: failedWorld.dataset,
        caseEntry: failedWorld.entry,
        now: LATER,
      }),
      "packet.execution",
    );
    assertJudgingError(
      () => apply(failedWorld, failed, verdictsFor(failed.packet.packet)),
      "judge.execution",
    );
  });

  it("驱动文本泄露评测内部信息时拒绝冻结", async () => {
    const world = makeWorld();
    world.entry.case.driver = [
      ...DEFAULT_DRIVER,
      { id: "leak", kind: "host", method: "chat_stop", note: "（评分）" },
    ];
    const leak = checkDriverNoOracleLeak({ dataset: world.dataset, caseEntry: world.entry });
    expect(leak.ok).toBe(false);
    expect(
      leak.violations.some((item) => item.stepId === "leak" && item.term === "评分"),
    ).toBe(true);

    const attempt = await sealAttempt(world, { name: "leak" });
    assertJudgingError(
      () => prepareJudgePacket({
        runDir: attempt.runDir,
        attemptDir: attempt.attemptDir,
        dataset: world.dataset,
        caseEntry: world.entry,
        now: PREPARED,
      }),
      "driver.oracle-leak",
    );
  });

  it("读取判分包时拒绝哈希篡改、路径穿越与缺失文件", async () => {
    const { prepared } = await preparedWorld();
    rewritePacket(prepared.packet.packetPath, (packet) => {
      packet.createdAt = LATER;
    });
    assertJudgingError(
      () => readJudgePacket({ runDir: prepared.runDir, packetId: prepared.packet.packet.packetId }),
      "packet.hash",
    );
    assertJudgingError(
      () => readJudgePacket({ runDir: prepared.runDir, packetId: "../evil" }),
      "packet.id",
    );
    assertJudgingError(
      () => readJudgePacket({ runDir: prepared.runDir, packetId: "packet-absent" }),
      "packet.missing",
    );
  });

  it("formatJudgePacket 呈现规则、对话与证据引用", async () => {
    const { prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    const text = formatJudgePacket({ packet });
    expect(text).toContain(`# 判分包 ${packet.packetId}`);
    expect(text).toContain("## 规则");
    expect(text).toContain("p-source");
    expect(text).toContain(QUALITY_RULE);
    expect(text).toContain("## 对话");
    expect(text).toContain("source-correction-u");
    expect(text).toContain("## 证据引用");
    expect(text).not.toContain("silver");
  });
});

describe("judge 裁决校验", () => {
  it("接受覆盖全部规则且绑定正确的裁决，并归一化理由与引用", async () => {
    const { prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    const verdicts = verdictsFor(packet);
    verdicts.verdicts[0] = {
      ...verdicts.verdicts[0]!,
      reason: "  实际回复引用了本轮纠正  ",
      evidenceRefs: ["trace:trace.jsonl"],
    };
    const normalized = validateJudgeVerdicts({ packet, verdicts });
    expect(normalized.verdicts).toHaveLength(10);
    expect(normalized.verdicts[0]?.reason).toBe("实际回复引用了本轮纠正");
    expect(normalized.verdicts[0]?.evidenceRefs).toEqual(["trace:trace.jsonl"]);
    expect(normalized.judge).toEqual(JUDGE);
    expect(normalized.packetSha256).toBe(packet.packetSha256);
    expect(normalized.caseId).toBe(packet.caseId);
  });

  it("拒绝缺失、重复、未知规则与非法外层结构 [chat-judge-verdict-validation]", async () => {
    const { prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    const base = verdictsFor(packet);

    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts = draft.verdicts.slice(0, -1);
        }),
      }),
      "verdict.missing",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts.push({ ...draft.verdicts[0]! });
        }),
      }),
      "verdict.rule-duplicate",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts[0]!.ruleId = "p-nope";
        }),
      }),
      "verdict.rule-unknown",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: { ...structuredClone(base), extra: true } as unknown as JudgeVerdictsInput,
      }),
      "verdict.shape",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          (draft as unknown as { schemaVersion: number }).schemaVersion = 2;
        }),
      }),
      "verdict.schema",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({ packet, verdicts: { ...structuredClone(base), verdicts: [] } }),
      "verdict.empty",
    );
    expect(base.verdicts).toHaveLength(10);
  });

  it("拒绝非异构或身份不完整的 judge", async () => {
    const { prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: verdictsFor(packet, { judge: { model: "model-under-test" } }),
      }),
      "judge.model-self",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: verdictsFor(packet, { judge: { model: "MODEL-B:latest" } }),
      }),
      "judge.model-self",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: verdictsFor(packet, { judge: { platform: "  " } }),
      }),
      "judge.identity",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: verdictsFor(packet, { judge: { promptVersion: "chat-judge@0" } }),
      }),
      "judge.prompt",
    );
  });

  it("拒绝未知被测模型，避免无法核对异构性", async () => {
    const world = makeWorld();
    const prepared = await prepare(world, {
      name: "unknown",
      requestedModel: "/",
      actualModel: "/",
    });
    expect(prepared.packet.packet.underTest).toEqual({ requested: "/", actual: "/" });
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet: prepared.packet.packet,
        verdicts: verdictsFor(prepared.packet.packet),
      }),
      "judge.model-unknown",
    );
  });

  it("拒绝非法裁决值、空理由与无效证据引用", async () => {
    const { prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    const base = verdictsFor(packet);

    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          (draft.verdicts[0] as unknown as { verdict: string }).verdict = "maybe";
        }),
      }),
      "verdict.value",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts[0]!.reason = "   ";
        }),
      }),
      "verdict.reason",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts[0]!.evidenceRefs = ["dialogue:nope:nope"];
        }),
      }),
      "verdict.evidence-ref",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts[0]!.evidenceRefs = ["trace:trace.jsonl", "trace:trace.jsonl"];
        }),
      }),
      "verdict.evidence-duplicate",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          draft.verdicts[0]!.evidenceRefs = [];
        }),
      }),
      "verdict.evidence-required",
    );
    assertJudgingError(
      () => validateJudgeVerdicts({
        packet,
        verdicts: mutated(base, (draft) => {
          (draft.verdicts[0] as unknown as { evidenceRefs: unknown[] }).evidenceRefs = [123];
        }),
      }),
      "verdict.evidence",
    );

    const inconclusive = mutated(base, (draft) => {
      draft.verdicts[0]!.verdict = "inconclusive";
      draft.verdicts[0]!.evidenceRefs = [];
    });
    const normalized = validateJudgeVerdicts({ packet, verdicts: inconclusive });
    expect(normalized.verdicts[0]).toMatchObject({ verdict: "inconclusive", evidenceRefs: [] });
  });
});

describe("判分记录与聚合", () => {
  it("记录 judge 身份、packet 绑定与计数，并聚合为通过", async () => {
    const { world, prepared } = await preparedWorld();
    const { packet } = prepared.packet;
    const applied = apply(world, prepared, verdictsFor(packet), { verdictsSha256: HASH_A });

    expect(applied.grade.authority).toBe(JUDGE_AUTHORITY);
    expect(applied.grade.rubricVersion).toBe(JUDGE_RUBRIC_VERSION);
    expect(applied.grade.graderVersion).toBe(CHAT_GRADER_VERSION);
    expect(applied.grade.attemptManifestSha256).toBe(prepared.sealed?.manifestSha256);
    expect(applied.grade.summary).toMatchObject({
      packetId: packet.packetId,
      packetSha256: packet.packetSha256,
      verdictsSha256: HASH_A,
      aggregation: "judge-all-rules",
      judge: JUDGE,
      execution: "completed",
      evidence: "complete",
    });
    expect(applied.grade.summary.datasetHash).toBe(
      datasetInputHash(world.dataset, world.entry),
    );
    expect(applied.grade.summary.label).toMatchObject({ tier: "silver", status: "pending" });
    expect(applied.grade.checks).toHaveLength(10);
    expect(applied.checks.find((check) => check.ruleId === QUALITY_RULE)?.status).toBe("pass");
    expect(applied.counts.required).toMatchObject({ total: 7, pass: 7, fail: 0 });
    expect(applied.counts.forbidden).toMatchObject({ total: 3, pass: 3, fail: 0 });
    expect(applied.counts.critical).toMatchObject({ total: 9, pass: 9, fail: 0 });

    const status = statusFor(world, prepared);
    expect(status.execution).toBe("completed");
    expect(status.evidence).toBe("complete");
    expect(status.judge).toMatchObject({
      gradeId: applied.gradeId,
      platform: JUDGE.platform,
      model: JUDGE.model,
      promptVersion: JUDGE_PROMPT_VERSION,
      packetId: packet.packetId,
    });
    expect(status.check.status).toBe("pass");
    expect(status.overall.status).toBe("pass");
    expect(status.overall.reason).toBe("全部适用规则通过");
    expect(status.gold).toBe(false);
    expect(status.spotCheck).toMatchObject({ status: "not_checked", checked: 0, total: 10 });
  });

  it("任一规则 fail 时总判定 fail，按必需项与禁止项分别计数 [chat-judge-aggregation]", async () => {
    const { world, prepared } = await preparedWorld();
    const applied = apply(
      world,
      prepared,
      verdictsFor(prepared.packet.packet, {
        perRule: { "p-source": "fail", "p-cross": "fail", "p-no-swap": "fail" },
      }),
    );
    expect(applied.counts.required).toMatchObject({ total: 7, pass: 5, fail: 2 });
    expect(applied.counts.forbidden).toMatchObject({ total: 3, pass: 2, fail: 1 });
    expect(applied.counts.critical).toMatchObject({ total: 9, pass: 6, fail: 3 });

    const status = statusFor(world, prepared);
    expect(status.check.status).toBe("fail");
    expect(status.overall.status).toBe("fail");
    expect(status.overall.reason).toContain("p-source");
    expect(status.overall.reason).toContain("p-cross");
    expect(status.overall.reason).toContain("p-no-swap");
  });

  it("inconclusive 规则使总判定保持 inconclusive", async () => {
    const { world, prepared } = await preparedWorld();
    const applied = apply(
      world,
      prepared,
      verdictsFor(prepared.packet.packet, { perRule: { "p-style": "inconclusive" } }),
    );
    expect(applied.counts.required).toMatchObject({ total: 7, pass: 6, inconclusive: 1 });
    expect(applied.counts.critical).toMatchObject({ total: 9, pass: 9, inconclusive: 0 });

    const status = statusFor(world, prepared);
    expect(status.check.status).toBe("inconclusive");
    expect(status.overall.status).toBe("inconclusive");
    expect(status.overall.reason).toContain("p-style=inconclusive");
  });

  it("没有判分记录时不产生通过结论", async () => {
    const { world, prepared } = await preparedWorld();
    const status = statusFor(world, prepared);
    expect(status.judge).toBeNull();
    expect(status.check.status).toBe("inconclusive");
    expect(status.check.counts.required).toMatchObject({ total: 7, pass: 0 });
    expect(status.overall.status).toBe("inconclusive");
    expect(status.overall.reason).toContain("存在未通过的规则");
    expect(status.spotCheck.status).toBe("not_checked");
  });

  it("窗口不可用的规则由运行器记为 inconclusive", async () => {
    const world = makeWorld({ probes: [...defaultProbes(), skippedProbe()] });
    const prepared = await prepare(world);
    expect(prepared.packet.skippedRules).toEqual(["p-skip"]);
    expect(prepared.packet.packet.rules).toHaveLength(10);

    const applied = apply(world, prepared, verdictsFor(prepared.packet.packet));
    expect(applied.skippedRules).toEqual(["p-skip"]);
    expect(applied.checks.find((check) => check.ruleId === "p-skip")?.status).toBe("inconclusive");
    expect(applied.counts.required).toMatchObject({ total: 8, pass: 7, inconclusive: 1 });
    expect(applied.counts.critical).toMatchObject({ total: 10, pass: 9, inconclusive: 1 });

    const status = statusFor(world, prepared);
    expect(status.overall.status).toBe("inconclusive");
    expect(status.checks.find((check) => check.ruleId === "p-skip")?.status).toBe("inconclusive");
  });

  it("数据集漂移后拒绝冻结与落判", async () => {
    const { world, prepared } = await preparedWorld();
    const before = datasetInputHash(world.dataset, world.entry);
    driftWorld(world);
    const after = datasetInputHash(world.dataset, world.entry);
    expect(after).not.toBe(before);

    assertJudgingError(
      () => prepareJudgePacket({
        runDir: prepared.runDir,
        attemptDir: prepared.attemptDir,
        dataset: world.dataset,
        caseEntry: world.entry,
        now: LATER,
      }),
      "dataset.stale",
    );
    assertJudgingError(
      () => apply(world, prepared, verdictsFor(prepared.packet.packet)),
      "dataset.stale",
    );
  });

  it("重复判分追加新记录，最新记录生效", async () => {
    const { world, prepared } = await preparedWorld();
    const first = apply(world, prepared, verdictsFor(prepared.packet.packet), { now: JUDGED });
    const second = apply(
      world,
      prepared,
      verdictsFor(prepared.packet.packet, { perRule: { "p-trap": "fail" } }),
      { now: LATER },
    );
    expect(second.gradeId).not.toBe(first.gradeId);
    expect(readJudgingRecords(prepared.attemptDir).grades).toHaveLength(2);
    expect(latestJudgeGrade(prepared.attemptDir)?.gradeId).toBe(second.gradeId);

    const status = statusFor(world, prepared);
    expect(status.gradeId).toBe(second.gradeId);
    expect(status.judge?.gradeId).toBe(second.gradeId);
    expect(status.check.status).toBe("fail");
    expect(status.overall.status).toBe("fail");
  });

  it("判分包与 attempt 绑定不一致时拒绝落判", async () => {
    const { world, prepared } = await preparedWorld();
    rewriteManifest(prepared.attemptDir, (manifest) => {
      manifest.sealedAt = LATER;
    });
    assertJudgingError(
      () => apply(world, prepared, verdictsFor(prepared.packet.packet)),
      "judge.packet-attempt",
    );
  });

  it("封存证据被篡改后拒绝落判", async () => {
    const { world, prepared } = await preparedWorld();
    const dialogue = join(prepared.attemptDir, "dialogue.jsonl");
    chmodSync(dialogue, 0o644);
    appendFileSync(dialogue, "{}\n");
    assertJudgingError(
      () => apply(world, prepared, verdictsFor(prepared.packet.packet)),
      "judge.evidence",
    );
  });
});

describe("用户抽查不阻塞", () => {
  it("没有 judge 判分时不能抽查", async () => {
    const { world, prepared } = await preparedWorld();
    expect(world.entry.caseId).toContain("w4-gate-case");
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-source", verdict: "pass", agreement: "agree" }],
        now: REVIEWED,
      }),
      "spot.grade",
    );
  });

  it("拒绝非用户、错误 gradeId、空抽查与未知规则", async () => {
    const { prepared, applied } = await judgedWorld();
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: { role: "assistant", name: "x" } as unknown as typeof USER,
        checks: [{ ruleId: "p-source", verdict: "pass", agreement: "agree" }],
        now: REVIEWED,
      }),
      "spot.reviewer",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: { role: "user", name: "  " },
        checks: [{ ruleId: "p-source", verdict: "pass", agreement: "agree" }],
        now: REVIEWED,
      }),
      "spot.reviewer",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-source", verdict: "pass", agreement: "agree" }],
        gradeId: "judge-other",
        now: REVIEWED,
      }),
      "spot.grade",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [],
        now: REVIEWED,
      }),
      "spot.empty",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-nope", verdict: "pass", agreement: "agree" }],
        now: REVIEWED,
      }),
      "spot.rule-unknown",
    );
    expect(applied.gradeId).toContain("judge-");
  });

  it("拒绝一致性与裁决不匹配、缺少理由及重复规则", async () => {
    const { prepared } = await judgedWorld();
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-source", verdict: "fail", agreement: "agree" }],
        now: REVIEWED,
      }),
      "spot.agreement-mismatch",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-source", verdict: "pass", agreement: "disagree" }],
        now: REVIEWED,
      }),
      "spot.agreement-mismatch",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [{ ruleId: "p-source", verdict: "fail", agreement: "disagree", reason: " " }],
        now: REVIEWED,
      }),
      "spot.reason",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [
          { ruleId: "p-source", verdict: "pass", agreement: "agree" },
          { ruleId: "p-source", verdict: "pass", agreement: "agree" },
        ],
        now: REVIEWED,
      }),
      "spot.rule-duplicate",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [
          { ruleId: "p-source", verdict: "pass", agreement: "agree", extra: true },
        ] as never,
        now: REVIEWED,
      }),
      "verdict.shape",
    );
    assertJudgingError(
      () => recordSpotCheck({
        attemptDir: prepared.attemptDir,
        reviewer: USER,
        checks: [
          { ruleId: "p-source", verdict: "pass", agreement: "agree", evidenceRefs: [123] },
        ] as never,
        now: REVIEWED,
      }),
      "spot.evidence",
    );
    expect(readJudgingRecords(prepared.attemptDir).reviews).toHaveLength(0);
  });

  it("抽查不一致不改变判分结论与记录 [chat-spotcheck-nonblocking]", async () => {
    const { world, prepared, applied } = await judgedWorld();
    const spot = recordSpotCheck({
      attemptDir: prepared.attemptDir,
      reviewer: USER,
      checks: [
        {
          ruleId: "p-source",
          verdict: "fail",
          agreement: "disagree",
          reason: "复核认为应判通过",
        },
      ],
      now: REVIEWED,
    });
    expect(spot.coverage).toEqual({ checked: 1, total: 10, agreements: 0, disagreements: 1 });

    const status = statusFor(world, prepared);
    expect(status.check.status).toBe("pass");
    expect(status.overall.status).toBe("pass");
    expect(status.spotCheck).toMatchObject({
      status: "checked",
      checked: 1,
      total: 10,
      coverage: 0.1,
      agreements: 0,
      disagreements: 1,
    });
    expect(status.spotCheck.rules).toEqual([
      {
        ruleId: "p-source",
        judgeStatus: "pass",
        verdict: "fail",
        agreement: "disagree",
        reason: "复核认为应判通过",
        reviewId: spot.reviewId,
      },
    ]);

    const records = readJudgingRecords(prepared.attemptDir);
    expect(records.grades).toHaveLength(1);
    expect(records.reviews).toHaveLength(1);
    expect(records.reviews[0]).toMatchObject({
      kind: "spot-check",
      gradeId: applied.gradeId,
      verdict: "inconclusive",
    });
  });

  it("多次抽查按规则取最新记录并统计覆盖", async () => {
    const { world, prepared } = await judgedWorld();
    const first = recordSpotCheck({
      attemptDir: prepared.attemptDir,
      reviewer: USER,
      checks: [
        {
          ruleId: "p-source",
          verdict: "fail",
          agreement: "disagree",
          reason: "先判不一致",
        },
      ],
      now: REVIEWED,
    });
    const second = recordSpotCheck({
      attemptDir: prepared.attemptDir,
      reviewer: USER,
      checks: [
        { ruleId: "p-source", verdict: "pass", agreement: "agree" },
        { ruleId: "p-provenance", verdict: "pass", agreement: "agree" },
      ],
      now: LATER,
    });
    expect(second.reviewId).not.toBe(first.reviewId);

    const status = statusFor(world, prepared);
    expect(status.spotCheck).toMatchObject({
      status: "checked",
      checked: 2,
      total: 10,
      agreements: 2,
      disagreements: 0,
    });
    expect(status.spotCheck.coverage).toBeCloseTo(0.2);
    const byRule = new Map(status.spotCheck.rules.map((rule) => [rule.ruleId, rule]));
    expect(byRule.get("p-source")).toMatchObject({
      agreement: "agree",
      verdict: "pass",
      reviewId: second.reviewId,
    });
    expect(byRule.get("p-provenance")?.reviewId).toBe(second.reviewId);
    expect(readJudgingRecords(prepared.attemptDir).reviews).toHaveLength(2);
  });

  it("重新判分后旧抽查不并入新判分 [chat-spotcheck-regrade]", async () => {
    const { world, prepared, applied } = await judgedWorld();
    recordSpotCheck({
      attemptDir: prepared.attemptDir,
      reviewer: USER,
      checks: [
        { ruleId: "p-source", verdict: "fail", agreement: "disagree", reason: "旧判分的抽查" },
      ],
      now: REVIEWED,
    });
    expect(statusFor(world, prepared).spotCheck.status).toBe("checked");

    const regraded = apply(world, prepared, verdictsFor(prepared.packet.packet), { now: LATER });
    expect(regraded.gradeId).not.toBe(applied.gradeId);

    const status = statusFor(world, prepared);
    expect(status.spotCheck).toMatchObject({
      status: "not_checked",
      checked: 0,
      total: 10,
      agreements: 0,
      disagreements: 0,
    });
    // 旧抽查仍是历史证据，只是不再算到最新判分头上。
    expect(readJudgingRecords(prepared.attemptDir).reviews).toHaveLength(1);
  });
});

describe("同源报告四层", () => {
  it("按结论卡、检查对照、时间线、原始证据重建 judge 结论 [chat-report-same-source]", async () => {
    const { world, prepared, applied } = await judgedWorld();
    const markdown = reportFor(world, prepared);
    const conclusion = markdown.indexOf("### 结论卡");
    const checks = markdown.indexOf("### 检查对照");
    const timeline = markdown.indexOf("### 时间线");
    const raw = markdown.indexOf("### 原始证据");

    expect(conclusion).toBeGreaterThanOrEqual(0);
    expect(checks).toBeGreaterThan(conclusion);
    expect(timeline).toBeGreaterThan(checks);
    expect(raw).toBeGreaterThan(timeline);
    expect(markdown).toContain(
      `- 判分者：${JUDGE.platform} / ${JUDGE.model} / ${JUDGE_PROMPT_VERSION}（${applied.gradeId}）`,
    );
    expect(markdown).toContain("- 抽查：未抽查（可选，不阻塞）");
    expect(markdown).toContain("- 规则：pass（必需 7/7 通过，禁止项 3/3 通过，关键 9/9 通过）");
    expect(markdown).toContain("- 总判定：pass — 全部适用规则通过");
    expect(markdown).toContain("- 聚合规则：judge-all-rules；gold=false");
    expect(markdown).toContain("  - 判分理由：依据包内证据判定");
    expect(markdown).toContain("  - 证据：dialogue:");
    expect(markdown).toContain(`packet ${prepared.packet.packet.packetId}`);
    expect(markdown).toContain("source-correction-u");
    expect(markdown).toContain("trace #");
    expect(markdown).toContain("判分记录:");
    expect(markdown).toContain(`- ${applied.gradeId} · coding-agent-judge`);
    expect(markdown).toContain("用户抽查:");
    expect(markdown).toContain("- 未抽查（可选）");
  });

  it("未抽查时标注可选，抽查后展示覆盖与不一致", async () => {
    const { world, prepared } = await judgedWorld();
    const before = reportFor(world, prepared);
    expect(before).toContain("- 抽查：未抽查（可选，不阻塞）");
    expect(before).toContain("用户抽查:");

    const spot = recordSpotCheck({
      attemptDir: prepared.attemptDir,
      reviewer: USER,
      checks: [
        {
          ruleId: "p-source",
          verdict: "fail",
          agreement: "disagree",
          reason: "复核认为应判通过",
        },
      ],
      now: REVIEWED,
    });
    const after = reportFor(world, prepared);
    expect(after).toContain("- 抽查：已抽查 1/10（一致 0，不一致 1）");
    expect(after).toContain("用户抽查：fail · disagree（复核认为应判通过）");
    expect(after).toContain(`- ${spot.reviewId} · spot-check · inconclusive`);
    expect(after).toContain(`- 总判定：pass — 全部适用规则通过`);
  });

  it("证据不完整、未封存与数据集漂移都不显示通过结论", async () => {
    const incompleteWorld = makeWorld();
    const incomplete = await sealAttempt(incompleteWorld, {
      name: "incomplete",
      omitTrace: ["complete"],
    });
    const incompleteMarkdown = reportFor(incompleteWorld, incomplete);
    expect(incompleteMarkdown).toContain("证据未达到完整可评分状态，不能判为通过");
    expect(incompleteMarkdown).toContain("证据不完整或存在未归属事件：不能判为通过");
    expect(incompleteMarkdown).not.toContain("### 检查对照");
    expect(incompleteMarkdown).not.toContain("- 总判定：pass");

    const unsealedWorld = makeWorld();
    const unsealed = await sealAttempt(unsealedWorld, { name: "unsealed", seal: false });
    const unsealedMarkdown = reportFor(unsealedWorld, unsealed);
    expect(unsealedMarkdown).toContain("— 证据 unsealed");
    expect(unsealedMarkdown).toContain("尚未封存：不构成可评分证据，也不能据此报告通过");
    expect(unsealedMarkdown).not.toContain("### 检查对照");

    const { world, prepared } = await judgedWorld();
    const before = datasetInputHash(world.dataset, world.entry);
    driftWorld(world);
    const after = datasetInputHash(world.dataset, world.entry);
    const driftMarkdown = reportFor(world, prepared);
    expect(driftMarkdown).toContain(`数据集自采集后已变更（${before} → ${after}）`);
    expect(driftMarkdown).toContain("- 结论：数据集自采集后已变更");
    expect(driftMarkdown).not.toContain("### 检查对照");
    expect(driftMarkdown).not.toContain("- 判分者：");
  });
});
