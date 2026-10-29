import type { DeskpetReplyEvidence } from "../../../src/services/reply";

export const CHAT_EVIDENCE_SCHEMA_VERSION: 1;
export const CHAT_RUN_SCHEMA_VERSION: 1;
export const CHAT_ATTEMPT_SCHEMA_VERSION: 1;
export const CHAT_TRIAL_PLAN_SCHEMA_VERSION: 1;
export const DELIVERABLE_MAX_BYTES: number;
export const TRIAL_PLAN_FILE: string;
export const CHAT_GRADER_VERSION: string;
export const CHAT_RETENTION_MAX_GROUPS: 5;
export const CHAT_RETENTION_MAX_BYTES: number;
export const CHAT_RUN_PHASES: readonly string[];
export const DIALOGUE_ORIGINS: readonly string[];
export const ATTEMPT_OUTCOMES: readonly string[];

export type ChatRunPhase =
  | "preparing" | "awaiting_gold_review" | "ready" | "running" | "collecting" | "grading"
  | "awaiting_judge" | "repairing" | "completed" | "blocked" | "cancelled";
export type DialogueOrigin = "fixture" | "driver" | "assistant";
export type AttemptOutcome = "completed" | "failed" | "interrupted";
export type IntegrityStatus = "complete" | "inconclusive" | "unsealed";

export class ChatEvidenceError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export interface ChatRun {
  schemaVersion: 1;
  evaluationRunId: string;
  createdOrder: number;
  createdAt: string;
  scope: Record<string, unknown>;
  budget: Record<string, unknown>;
  baseline: unknown;
}

export interface ChatWorkflow {
  schemaVersion: 1;
  evaluationRunId: string;
  phase: ChatRunPhase;
  updatedAt: string;
  attempts: Array<{
    attemptId: string;
    sealedAt: string;
    status: string;
    outcome: string;
    manifestSha256: string;
  }>;
  pendingDecision: unknown;
  nextAction?: unknown;
}

export interface ChatRunEntry {
  evaluationRunId: string;
  runPath: string;
  run: ChatRun;
  workflow: ChatWorkflow | null;
}

export interface ChatAttemptIdentity {
  code: { commit: string; sourceHash: string; dirty: boolean };
  inputs: { datasetHash: string; fixtureHash: string; cardHash: string; configHash: string };
  tools: { driverVersion: string; rubricVersion: string; graderVersion: string; judgePromptVersion?: string };
  host: { mode: string; capabilities: string[] };
  platform: { os: string; arch: string };
  runtime: { version: string };
  models: { requested: string; actual?: string | null };
  budget: Record<string, unknown>;
  repair?: { ofRunId: string; index: number; evaluationRunId: string } | null;
}

export interface ExpectedTrial {
  caseId: string;
  trialId: string;
}

export interface StartedChatAttempt {
  attemptDir: string;
  attempt: {
    schemaVersion: 1;
    evaluationRunId: string;
    attemptId: string;
    createdAt: string;
    identity: ChatAttemptIdentity;
    expectedTrials: Array<{ caseId: string; sceneId: string; trialId: string }>;
    expectedSessions: string[];
    status: "collecting";
  };
}

export interface DialogueMessageInput {
  role: "user" | "assistant";
  text: string;
  textParts?: string[];
  toolCallCount?: number | null;
  replyEvidence?: CapturedReplyEvidence;
  sessionId: string;
  entryId: string;
  at: number | string;
  origin: DialogueOrigin;
}

export interface DialogueRecord {
  seq: number;
  role: "user" | "assistant";
  text: string;
  textParts?: string[];
  toolCallCount?: number | null;
  replyEvidence?: CapturedReplyEvidence;
  sessionId: string;
  entryId: string;
  at: number;
  origin: DialogueOrigin;
}

export type CapturedReplyEvidence =
  | { availability: "available"; evidence: DeskpetReplyEvidence }
  | { availability: "unavailable"; reason: "missing-persisted-evidence" | "invalid-persisted-evidence" };

export interface DialogueWriter {
  path: string;
  append(message: DialogueMessageInput): DialogueRecord;
  close(): void;
}

export interface ChatTraceChunkInput {
  chunkId?: string;
  chunkSeq: number;
  events: unknown[];
  eventCount: number;
  droppedCount: number;
  seqFrom?: number | null;
  seqTo?: number | null;
  boundary: { kind: string; sceneId?: string; trialId?: string };
}

export interface ChatTraceAck {
  chunkId: string;
  chunkSeq: number;
  persisted: true;
}

export interface TimelineTraceEvent {
  seq: number;
  sceneId?: string;
  trialId?: string;
  orphan?: boolean;
  event: {
    kind: string;
    createdAt: number;
    runId?: string;
    requestId?: string;
    turnId?: string;
    payload?: Record<string, unknown>;
  };
}

export interface AttemptTimeline {
  messages: DialogueRecord[];
  dialogueIssues: string[];
  events: TimelineTraceEvent[];
  trace: { chunkCount: number; complete: boolean; droppedCount: number };
}

export interface TraceWriter {
  path: string;
  appendChunk(chunk: ChatTraceChunkInput): ChatTraceAck;
  close(): void;
  readonly complete: boolean;
  readonly chunkCount: number;
}

export interface ChatArtifactEntry {
  path: string;
  role: string;
  bytes: number;
  sha256: string;
}

export interface DeliverableSpec {
  id: string;
  role: string;
  path: string;
  maxBytes?: number;
}

export interface DeliverableCapture {
  id: string;
  role: string;
  path: string;
  status: "delivered" | "missing" | "oversized" | "invalid";
  bytes?: number;
  sha256?: string;
  artifactPath?: string;
  reason?: string;
}

export interface ChatAttemptManifest {
  schemaVersion: 1;
  evaluationRunId: string;
  attemptId: string;
  createdAt: string;
  sealedAt: string;
  identity: ChatAttemptIdentity;
  inputHashes: ChatAttemptIdentity["inputs"] | null;
  models: { requested: string; actual: string | null };
  sourceHash: string;
  outcome: string;
  expectedTrials: Array<{ caseId: string; sceneId: string; trialId: string }>;
  expectedSessions: string[];
  evidence: {
    dialogue: { messageCount: number; sessions: string[] };
    trace: { chunkCount: number; droppedCount: number; orphanCount: number | null };
  };
  artifacts: ChatArtifactEntry[];
  deliverables: DeliverableCapture[];
  integrity: { status: IntegrityStatus; issues: string[] };
  manifestSha256: string;
}

export interface SealChatAttemptOptions {
  attemptDir: string;
  sealedAt: string;
  models: { actual?: string | null };
  sourceHash?: string;
  inputs?: ChatAttemptIdentity["inputs"];
  outcome?: AttemptOutcome;
  issues?: string[];
  deliverables?: DeliverableSpec[];
  dataRoot?: string;
}

export interface SealChatAttemptResult {
  manifest: ChatAttemptManifest;
  status: IntegrityStatus;
  issues: string[];
  manifestSha256: string;
}

export interface SealedVerification {
  status: IntegrityStatus | "unknown" | "unsealed";
  issues: string[];
  integrityIssues?: string[];
  manifest?: ChatAttemptManifest;
  manifestSha256?: string;
}

export interface GradeRecord {
  schemaVersion: 1;
  gradeId: string;
  attemptManifestSha256: string;
  createdAt: string;
  rubricVersion: string;
  graderVersion: string;
  authority: "coding-agent-judge";
  checks: unknown[];
  summary: Record<string, unknown>;
}

export interface AppendGradeOptions {
  attemptDir: string;
  gradeId: string;
  createdAt: string;
  rubricVersion: string;
  graderVersion: string;
  authority: GradeRecord["authority"];
  checks: unknown[];
  summary: Record<string, unknown>;
}

export interface ReviewRuleRecord {
  ruleId: string;
  verdict: "pass" | "fail" | "inconclusive" | "not_applicable";
  reason: string;
  evidenceRefs: string[];
  agreement?: "agree" | "disagree";
}

export interface ReviewEvidenceBinding {
  manifestSha256: string;
  datasetHash: string;
  specHash: string;
  oracleHash: string;
}

export interface ReviewRuleVersions {
  graderVersion: string;
  rubricVersions: string[];
}

export interface ReviewRecord {
  schemaVersion: 1;
  kind: "spot-check";
  reviewId: string;
  gradeId?: string;
  attemptManifestSha256: string;
  createdAt: string;
  reviewer: { role: "user"; name: string };
  verdict: "pass" | "fail" | "inconclusive";
  notes: string;
  evidenceRefs: string[];
  rules: ReviewRuleRecord[];
  binding?: ReviewEvidenceBinding;
  versions?: ReviewRuleVersions;
}

export interface AppendReviewOptions {
  attemptDir: string;
  reviewId: string;
  createdAt: string;
  reviewer: { role: "user"; name: string };
  verdict: ReviewRecord["verdict"];
  notes?: string;
  evidenceRefs?: string[];
  rules?: Array<Omit<ReviewRuleRecord, "reason" | "evidenceRefs"> & { reason?: string; evidenceRefs?: string[] }>;
  binding?: ReviewEvidenceBinding | null;
  versions?: ReviewRuleVersions | null;
  kind?: "spot-check";
  gradeId?: string;
}

export interface ChatTrialPlan {
  schemaVersion: 1;
  evaluationRunId: string;
  caseId: string;
  plannedTrials: number;
  trialIds: string[];
  budgetTrials: number;
  authorizationFingerprint: string;
  createdAt: string;
}

export interface ChatAttemptEvidence {
  attemptId: string;
  attemptDir: string;
  manifest: ChatAttemptManifest | null;
  pendingManifest: StartedChatAttempt["attempt"] | null;
  trialId: string | null;
  repair: boolean;
  verification: SealedVerification;
  grades: GradeRecord[];
  reviews: ReviewRecord[];
}

export interface ChatRunEvidence {
  run: ChatRun;
  workflow: ChatWorkflow;
  plan: ChatTrialPlan | null;
  attempts: ChatAttemptEvidence[];
}

export function hashBytes(bytes: Uint8Array | string): string;
export function hashFile(path: string): string;
export function readJsonFile(path: string): unknown;
export function createChatRun(options: {
  reportsDir: string;
  evaluationRunId: string;
  createdAt: string;
  scope: Record<string, unknown>;
  budget: Record<string, unknown>;
  baseline?: unknown;
}): { runDir: string; run: ChatRun };
export function ensureChatRun(options: {
  reportsDir: string;
  evaluationRunId: string;
  createdAt: string;
  scope: Record<string, unknown>;
  budget: Record<string, unknown>;
  baseline?: unknown;
}): { runDir: string; run: ChatRun; created: boolean };
export function listChatRuns(reportsDir: string): ChatRunEntry[];
export function readChatRun(runDir: string): ChatRun;
export function readChatWorkflow(runDir: string): ChatWorkflow;
export function readTrialPlan(runDir: string): ChatTrialPlan | null;
export function ensureTrialPlan(options: {
  runDir: string;
  evaluationRunId: string;
  caseId: string;
  trialIds: string[];
  budgetTrials: number;
  authorizationFingerprint: string;
  createdAt: string;
}): { plan: ChatTrialPlan; created: boolean };
export function setChatRunPhase(
  runDir: string,
  options: { phase: ChatRunPhase; updatedAt: string; pendingDecision?: unknown; nextAction?: unknown },
): ChatWorkflow;
export function beginChatAttempt(options: {
  runDir: string;
  attemptId?: string;
  identity: ChatAttemptIdentity;
  expectedTrials: ExpectedTrial[];
  expectedSessions: string[];
  createdAt: string;
}): StartedChatAttempt;
export function extendChatAttemptSessions(options: {
  attemptDir: string;
  sessionIds: string[];
}): StartedChatAttempt["attempt"];
export function createDialogueWriter(attemptDir: string): DialogueWriter;
export function createTraceWriter(attemptDir: string): TraceWriter;
export function writeStateSnapshot(options: { attemptDir: string; name: string; value: unknown }): string;
export function writeArtifact(options: { attemptDir: string; name: string; bytes: Uint8Array | string }): string;
export function copyArtifact(options: { attemptDir: string; name: string; sourcePath: string }): string;
export function captureDeliverables(options: {
  attemptDir: string;
  dataRoot?: string;
  deliverables?: DeliverableSpec[];
}): { deliverables: DeliverableCapture[] };
export function sealChatAttempt(options: SealChatAttemptOptions): Promise<SealChatAttemptResult>;
export function readSealedAttempt(attemptDir: string): ChatAttemptManifest;
export function verifySealedAttempt(attemptDir: string): SealedVerification;
export function appendGrade(options: AppendGradeOptions): GradeRecord;
export function appendReview(options: AppendReviewOptions): ReviewRecord;
export function listAttemptIds(runDir: string): string[];
export function readChatRunEvidence(runDir: string): ChatRunEvidence;
export function readAttemptTimeline(attemptDir: string): AttemptTimeline;
