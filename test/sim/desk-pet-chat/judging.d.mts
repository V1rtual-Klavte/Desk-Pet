import type { CaseEntry, Dataset, ProbeSpec } from "./dataset.mjs";
import type { ChatAttemptManifest, GradeRecord, ReviewRecord, SealedVerification } from "./evidence.mjs";

export const JUDGING_SCHEMA_VERSION: 1;
export const JUDGE_PACKET_SCHEMA_VERSION: 3;
export const DELIVERABLE_CONTENT_MAX_BYTES: number;
export const DELIVERABLE_CONTENT_TOTAL_MAX_BYTES: number;
export const VERDICTS_SCHEMA_VERSION: 1;
export const JUDGE_PROMPT_VERSION: string;
export const JUDGE_RUBRIC_VERSION: string;
export const JUDGE_AUTHORITY: "coding-agent-judge";
export const CODING_AGENT_PLATFORMS: readonly string[];
export const AGGREGATION_RULE: "judge-all-rules";

export function isCodingAgentPlatform(value: unknown): boolean;
export function isAuthoritativeGrade(grade: GradeRecord | null | undefined): boolean;

export type CheckStatus = "pass" | "fail" | "inconclusive" | "not_applicable";
export type ExecutionStatus = "completed" | "failed" | "cancelled" | "blocked";
export type EvidenceStatus = "complete" | "incomplete" | "invalid";
export type JudgeVerdict = "pass" | "fail" | "inconclusive";
export type SpotCheckAgreement = "agree" | "disagree";

export const CHECK_STATUSES: readonly CheckStatus[];
export const EXECUTION_STATUSES: readonly ExecutionStatus[];
export const EVIDENCE_STATUSES: readonly EvidenceStatus[];
export const JUDGE_VERDICTS: readonly JudgeVerdict[];
export const SPOT_CHECK_AGREEMENTS: readonly SpotCheckAgreement[];

export class JudgingError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export interface JudgingMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
  sessionId: string;
  entryId: string;
  at: number;
  origin: "fixture" | "driver" | "assistant";
}

export interface JudgingStep {
  stepId: string;
  kind: "message" | "host";
  step: unknown;
  message: JudgingMessage | null;
  sessionId: string | null;
  startSeq: number | null;
  endSeq: number | null;
}

export interface JudgingContext {
  attemptDir: string;
  manifest: ChatAttemptManifest | null;
  verification: SealedVerification;
  evidenceStatus: EvidenceStatus;
  executionStatus: ExecutionStatus;
  messages: JudgingMessage[];
  dialogueIssues: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  capture: Record<string, unknown> | null;
  beforeIssue: string | null;
  afterIssue: string | null;
  captureIssue: string | null;
  steps: JudgingStep[];
  stepsById: Map<string, JudgingStep>;
  mappingIssues: Array<{ code: string; stepId: string | null; message: string }>;
  attributionValid: boolean;
  newSessions: string[];
}

export interface ResolvedProbeWindow {
  ok: boolean;
  empty: boolean;
  replies: JudgingMessage[];
  step: JudgingStep | null;
  reason: string | null;
}

export interface DriverOracleLeakResult {
  ok: boolean;
  violations: Array<{ stepId: string; term: string }>;
}

export interface JudgePacketRule {
  ruleId: string;
  probeId: string | null;
  rubric: string;
  kind: string;
  description: string;
  expectation: string | null;
  deliverableId?: string;
  polarity: "required" | "forbidden";
  critical: boolean;
  questionType: string;
  difficulty: number | null;
  evidenceIds: string[];
  window: {
    mode: string;
    after: string | null;
    stepId: string | null;
    startSeq: number | null;
    endSeq: number | null;
    messageSeqs: number[];
  };
  instruction: string;
}

export interface SkippedJudgeRule {
  ruleId: string;
  probeId: string;
  rubric: string;
  reason: string;
  polarity: "required" | "forbidden";
  critical: boolean;
  questionType: string;
  difficulty: number;
  window: { mode: string; after: string };
}

export interface JudgePacketDeliverable {
  id: string;
  role: string;
  path: string;
  maxBytes?: number;
  status: "delivered" | "missing" | "oversized" | "invalid";
  bytes?: number;
  sha256?: string;
  artifactPath?: string;
  reason?: string;
  content: string | null;
  truncated: boolean;
  contentIssue?: string;
}

export interface JudgePacket {
  schemaVersion: 3;
  kind: "chat-judge-packet";
  packetId: string;
  packetSha256: string;
  createdAt: string;
  attemptId: string;
  caseId: string;
  suiteId: string;
  trialId: string | null;
  manifestSha256: string;
  datasetHash: string;
  bindings: {
    specHash: string;
    oracleHash: string;
    driverHash: string;
    fixtureHash: string;
  };
  versions: {
    graderVersion: string;
    judgePromptVersion: string;
    rubricVersion: string;
    datasetSchemaVersion: number;
  };
  underTest: { requested: string | null; actual: string | null };
  case: {
    title: string;
    goal: string;
    tone: string;
    knownFacts: string[];
    mustNotReveal: string[];
    allowedAlternatives: string[];
    pathConstraints: Record<string, unknown>;
    evidence: Array<{ id: string; kind: string; source: string; description: string }>;
    externalSource?: import("./dataset.mjs").ExternalSourceBinding;
  };
  fixtureContext: {
    origin: "fixture";
    fixtureHash: string;
    sessionId: string;
    messages: Array<{ id: string; role: "user" | "assistant"; content: string; at: string }>;
  } | null;
  rules: JudgePacketRule[];
  skippedRules: SkippedJudgeRule[];
  timeline: Array<{
    seq: number;
    role: string;
    origin: string;
    sessionId: string;
    entryId: string;
    at: number;
    text: string;
  }>;
  state: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    capture: Record<string, unknown> | null;
  };
  artifacts: Array<{ role: string; path: string; sha256: string }>;
  deliverables: JudgePacketDeliverable[];
  allowedEvidenceRefs: string[];
  instructions: string[];
  verdictFormat: Record<string, unknown>;
}

export interface JudgeVerdictInput {
  ruleId: string;
  verdict: JudgeVerdict;
  reason: string;
  evidenceRefs: string[];
}

export interface JudgeIdentity {
  platform: string;
  model: string;
  promptVersion: string;
}

export interface JudgeVerdictsInput {
  schemaVersion: 1;
  packetId: string;
  packetSha256: string;
  caseId: string;
  judgedAt: string;
  judge: JudgeIdentity;
  verdicts: JudgeVerdictInput[];
}

export interface NormalizedJudgeVerdicts {
  schemaVersion: 1;
  packetId: string;
  packetSha256: string;
  caseId: string;
  judgedAt: string;
  judge: JudgeIdentity;
  verdicts: JudgeVerdictInput[];
}

export interface CheckResult {
  ruleId: string;
  probeId: string | null;
  rubric: string;
  kind: string | null;
  status: CheckStatus;
  reason: string;
  evidence: Array<{ ref: string; excerpt: string }>;
  polarity: "required" | "forbidden";
  critical: boolean;
  questionType: string;
  difficulty: number | null;
  window: JudgePacketRule["window"] | null;
}

export interface CheckTally {
  total: number;
  pass: number;
  fail: number;
  inconclusive: number;
  not_applicable: number;
}

export interface CheckCounts {
  total: number;
  required: CheckTally;
  forbidden: CheckTally;
  critical: CheckTally;
}

export interface SpotCheckRuleSummary {
  ruleId: string;
  judgeStatus: CheckStatus;
  verdict: CheckStatus;
  agreement: SpotCheckAgreement;
  reason: string;
  reviewId: string;
}

export interface SpotCheckSummary {
  status: "checked" | "not_checked";
  checked: number;
  total: number;
  coverage: number;
  agreements: number;
  disagreements: number;
  rules: SpotCheckRuleSummary[];
}

export interface AttemptStatus {
  schemaVersion: 1;
  aggregation: "judge-all-rules";
  execution: ExecutionStatus;
  evidence: EvidenceStatus;
  judge: {
    gradeId: string;
    judgedAt: string;
    packetId: string | null;
    platform: string | null;
    model: string | null;
    promptVersion: string | null;
  } | null;
  check: {
    status: CheckStatus;
    counts: {
      required: CheckTally;
      forbidden: CheckTally;
      critical: CheckTally;
    };
  };
  spotCheck: SpotCheckSummary;
  overall: { status: "pass" | "fail" | "inconclusive"; reason: string };
  gold: boolean;
  label: CaseEntry["label"] | null;
  gradeId: string | null;
  checks: CheckResult[];
}

export interface SpotCheckCheckInput {
  ruleId: string;
  verdict: CheckStatus;
  agreement: SpotCheckAgreement;
  reason?: string;
  evidenceRefs?: string[];
}

export function loadJudgingContext(options: { attemptDir: string; caseEntry: CaseEntry }): JudgingContext;
export function resolveProbeWindow(options: { context: JudgingContext; probe: ProbeSpec }): ResolvedProbeWindow;
export function checkDriverNoOracleLeak(options: { dataset: Dataset; caseEntry: CaseEntry }): DriverOracleLeakResult;
export function readJudgePacket(options: { runDir: string; packetId: string }): {
  packet: JudgePacket;
  packetPath: string;
  packetSha256: string;
};
export function prepareJudgePacket(options: {
  runDir: string;
  attemptDir: string;
  dataset: Dataset;
  caseEntry: CaseEntry;
  now?: string;
}): {
  packet: JudgePacket;
  packetPath: string;
  packetSha256: string;
  skippedRules: string[];
};
export function validateJudgeVerdicts(options: {
  packet: JudgePacket;
  verdicts: JudgeVerdictsInput;
}): NormalizedJudgeVerdicts;
export function applyJudgeVerdicts(options: {
  runDir: string;
  attemptDir: string;
  dataset: Dataset;
  caseEntry: CaseEntry;
  packetId: string;
  verdicts: JudgeVerdictsInput;
  verdictsSha256?: string | null;
  now?: string;
}): {
  gradeId: string;
  grade: GradeRecord;
  packet: JudgePacket;
  checks: CheckResult[];
  counts: CheckCounts;
  judge: JudgeIdentity;
  judgedAt: string;
  skippedRules: string[];
};
export function readJudgingRecords(attemptDir: string): {
  grades: GradeRecord[];
  reviews: ReviewRecord[];
};
export function latestJudgeGrade(attemptDir: string): GradeRecord | null;
export function summarizeAttemptStatus(options: {
  caseEntry: CaseEntry;
  context: JudgingContext;
  grades?: GradeRecord[] | null;
  reviews?: ReviewRecord[];
}): AttemptStatus;
export function recordSpotCheck(options: {
  attemptDir: string;
  reviewer: { role: "user"; name: string };
  checks: SpotCheckCheckInput[];
  notes?: string;
  gradeId?: string | null;
  now?: string;
}): {
  record: ReviewRecord;
  reviewId: string;
  coverage: { checked: number; total: number; agreements: number; disagreements: number };
};
export function formatJudgePacket(options: { packet: JudgePacket }): string;
export const __testing: Readonly<Record<string, unknown>>;
