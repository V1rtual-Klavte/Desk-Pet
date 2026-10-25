export const CHAT_EVIDENCE_SCHEMA_VERSION: 1;
export const CHAT_RUN_SCHEMA_VERSION: 1;
export const CHAT_ATTEMPT_SCHEMA_VERSION: 1;
export const CHAT_RETENTION_MAX_GROUPS: 5;
export const CHAT_RETENTION_MAX_BYTES: number;
export const CHAT_RUN_PHASES: readonly string[];
export const DIALOGUE_ORIGINS: readonly string[];
export const ATTEMPT_OUTCOMES: readonly string[];

export type ChatRunPhase =
  | "preparing" | "awaiting_gold_review" | "ready" | "running" | "collecting" | "grading"
  | "awaiting_result_review" | "repairing" | "completed" | "blocked" | "cancelled";
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
  tools: { driverVersion: string; rubricVersion: string; graderVersion: string };
  host: { mode: string; capabilities: string[] };
  platform: { os: string; arch: string };
  runtime: { version: string };
  models: { requested: string; actual?: string | null };
  budget: Record<string, unknown>;
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
  sessionId: string;
  entryId: string;
  at: number | string;
  origin: DialogueOrigin;
}

export interface DialogueRecord {
  seq: number;
  role: "user" | "assistant";
  text: string;
  sessionId: string;
  entryId: string;
  at: number;
  origin: DialogueOrigin;
}

export interface DialogueWriter {
  path: string;
  append(message: DialogueMessageInput): DialogueRecord;
  close(): void;
}

export interface ChatTraceChunkInput {
  chunkSeq: number;
  events: unknown[];
  eventCount: number;
  droppedCount: number;
  boundary: { kind: string; sceneId?: string; trialId?: string };
}

export interface ChatTraceAck {
  chunkId: string;
  chunkSeq: number;
  persisted: true;
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
  authority: "deterministic" | "api-judge" | "human";
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

export interface ReviewRecord {
  schemaVersion: 1;
  reviewId: string;
  attemptManifestSha256: string;
  createdAt: string;
  reviewer: { role: "user"; name: string };
  verdict: "pass" | "fail" | "inconclusive";
  notes: string;
  evidenceRefs: unknown[];
  decisions: unknown[];
}

export interface AppendReviewOptions {
  attemptDir: string;
  reviewId: string;
  createdAt: string;
  reviewer: { role: "user"; name: string };
  verdict: ReviewRecord["verdict"];
  notes?: string;
  evidenceRefs?: unknown[];
  decisions?: unknown[];
}

export interface ChatAttemptEvidence {
  attemptId: string;
  attemptDir: string;
  manifest: ChatAttemptManifest | null;
  verification: SealedVerification;
  grades: GradeRecord[];
  reviews: ReviewRecord[];
}

export interface ChatRunEvidence {
  run: ChatRun;
  workflow: ChatWorkflow;
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
export function sealChatAttempt(options: SealChatAttemptOptions): Promise<SealChatAttemptResult>;
export function readSealedAttempt(attemptDir: string): ChatAttemptManifest;
export function verifySealedAttempt(attemptDir: string): SealedVerification;
export function appendGrade(options: AppendGradeOptions): GradeRecord;
export function appendReview(options: AppendReviewOptions): ReviewRecord;
export function listAttemptIds(runDir: string): string[];
export function readChatRunEvidence(runDir: string): ChatRunEvidence;
