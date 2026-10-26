import type { CheckpointSpec, DatasetPurpose, DriverPackage } from "./dataset.mjs";

export type DriverStatus = "pending" | "running" | "completed" | "blocked";
export type DriverStepStatus = "completed" | "failed";
export type CheckpointWait = "assistant_message" | "memory_extraction_end" | "session_created" | "host_readback";

export interface AuthorizationBudget {
  messages: number;
  tokens: number;
  minutes: number;
  trials: number;
  repairs: number;
}

export interface AuthorizationScope {
  caseIds: string[];
  purpose: DatasetPurpose;
  models: string[];
  data: "isolated";
}

export interface Authorization {
  schemaVersion: 1;
  approvedBy: string;
  approvedAt: string;
  scope: AuthorizationScope;
  budget: AuthorizationBudget;
  holdout: boolean;
  notes?: string;
}

export interface ClockFile {
  schemaVersion: 1;
  base: string;
  timezone: string;
  reason: string;
}

export interface DriverClock {
  base: string;
  now: string;
  timezone: string;
}

export interface DriverProgressCheckpoint {
  id: string;
  wait: CheckpointWait;
  status: "satisfied" | "timeout";
  observedAt: string;
  detail?: string;
}

export interface DriverStepRecord {
  index: number;
  id: string;
  kind: "message" | "host";
  at: string;
  status: DriverStepStatus;
  startedAt: string;
  completedAt: string;
  clock: DriverClock;
  result: Record<string, unknown>;
  error?: string;
  checkpoints?: DriverProgressCheckpoint[];
}

export interface DriverProgress {
  schemaVersion: 1;
  caseId: string;
  revision: number;
  specHash: string;
  driverHash: string;
  clockBase: string;
  index: number;
  status: DriverStatus;
  inFlight: { index: number; stepId: string; kind: "message" | "host"; at: string; startedAt: string } | null;
  blocked: { code: string; message: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
  budget: AuthorizationBudget;
  usage: {
    messages: number;
    tokens: number;
    tokensCalls: number;
    tokensReportedCalls: number;
    tokensUnknown: boolean;
    startedAt: string | null;
    elapsedMinutes: number;
    contextErrors: Array<{ at: string; stepId: string; error: string }>;
  };
  steps: DriverStepRecord[];
  totalSteps?: number;
  lastUsageStepId?: string;
}

export interface DriverSummary {
  status: DriverStatus;
  index: number;
  total: number | null;
  completed: number;
  failed: number;
  inFlight: string | null;
  blocked: { code: string; message: string; at: string } | null;
  clockBase: string;
  lastClock: string;
  usage: {
    messages: number;
    tokens: number;
    tokensCalls: number;
    tokensReportedCalls: number;
    tokensUnknown: boolean;
    elapsedMinutes: number;
    contextErrors: number;
  };
}

export interface MessageOperationRef {
  operationId: string;
  caseId: string;
  stepId: string;
}

export interface MessageOperationReceipt extends MessageOperationRef {
  trialId: string;
  sessionId: string;
  generation: string;
}

export interface DriverTransport {
  clock(at: string, reason?: string): Promise<DriverClock>;
  message(text: string, operation: MessageOperationRef): Promise<Record<string, unknown>>;
  sessions(): Promise<Record<string, unknown>>;
  host(method: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  context(): Promise<Record<string, unknown>>;
  memoryState(): Promise<Record<string, unknown>>;
}

export interface ExecuteDriverOptions {
  progress: DriverProgress;
  driverPackage: DriverPackage;
  syncPoints?: CheckpointSpec[];
  transport: DriverTransport;
  onProgress?: (progress: DriverProgress) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  memoryWait?: { deadlineMs: number; pollMs: number; stableMs: number };
}

export interface DriverOutcome {
  status: "completed" | "interrupted";
  reason: string | null;
}

export interface RunConditions {
  caseIds: string[];
  suiteIds: string[];
  specHash: string | null;
  contentHash: string | null;
  fixtureHash: string | null;
  driverHash: string | null;
  oracleHash: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  hostMode: string | null;
  hostCapabilities: string[];
  platform: string | null;
  runtime: string | null;
  driverVersion: string | null;
  rubricVersion: string | null;
  graderVersion: string | null;
  judgePromptVersion: string | null;
  commit: string | null;
  sourceHash: string | null;
  cardHash: string | null;
  configHash: string | null;
}

export interface ConditionSide {
  evaluationRunId: string;
  conditions: RunConditions;
}

export interface ConditionCheck {
  field: string;
  baseline: unknown;
  candidate: unknown;
  same: boolean;
  status: "same" | "different" | "unknown";
}

export interface ConditionComparison {
  comparable: boolean;
  issues: string[];
  unknown: string[];
  checks: ConditionCheck[];
  targetChanges: Array<{ field: string; baseline: unknown; candidate: unknown }>;
  baselineRunId: string;
  candidateRunId: string;
}

export interface HoldoutUse {
  evaluationRunId: string;
  createdAt: string | null;
  phase: string | null;
  holdout: boolean;
  purpose: string | null;
}

export class WorkflowError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export const WORKFLOW_SCHEMA_VERSION: 1;
export const DRIVER_PROGRESS_SCHEMA_VERSION: 1;
export const AUTHORIZATION_SCHEMA_VERSION: 1;
export const AUTHORIZATION_DATA_SCOPE: "isolated";
export const DRIVER_PROGRESS_FILE: string;
export const DRIVER_PACKAGE_FILE: string;
export const AUTHORIZATION_FILE: string;
export const CLOCK_FILE: string;
export const DRIVER_STATUSES: readonly DriverStatus[];
export const DRIVER_STEP_STATUSES: readonly DriverStepStatus[];
export const CHECKPOINT_WAITS: readonly CheckpointWait[];
export const FIXED_CONDITION_FIELDS: readonly string[];
export const TARGET_CONDITION_FIELDS: readonly string[];

export function validateAuthorization(
  raw: unknown,
  context: { caseIds: string[]; purpose: DatasetPurpose },
): Authorization;
export function authorizationFingerprint(authorization: Authorization): string;
export function authorizeRequestedModels(authorization: Authorization, requestedModels: readonly string[] | string): true;
export function assertRepairAllowed(input: { authorization: Authorization; repairIndex: number }): true;
export function timezoneForInstant(instant: string): { offsetMinutes: number; timezone: string };
export function buildClockFile(input: { base: string; reason: string }): ClockFile;
export function validateClockFile(raw: unknown): ClockFile;
export function validateDriverPackage(raw: unknown): DriverPackage;
export function validateSyncPoints(raw: unknown): CheckpointSpec[];
export function createDriverProgress(input: {
  driverPackage: DriverPackage;
  driverHash: string;
  budget: AuthorizationBudget;
  clockBase: string;
  startedAt: string;
}): DriverProgress;
export function readDriverProgress(raw: unknown): DriverProgress;
export function assertResumable(progress: DriverProgress): { resumable: boolean; reason?: string };
export function checkDriverBudget(input: { progress: DriverProgress; now?: number }):
  | { ok: true; warnings: string[] }
  | { ok: false; code: string; message: string };
export function recordContextUsage(
  progress: DriverProgress,
  usage: unknown,
  context: { at?: string; stepId?: string },
): void;
export function driverSummary(progress: DriverProgress): DriverSummary;
export function executeDriver(options: ExecuteDriverOptions): Promise<DriverSummary>;
export function driverOutcome(progress: DriverProgress): DriverOutcome;
export function conditionsFromRun(input: {
  run: Record<string, unknown>;
  manifest: Record<string, unknown> | null;
  judgePromptVersion?: string | null;
}): RunConditions;
export function compareRunConditions(input: { candidate: ConditionSide; baseline: ConditionSide }): ConditionComparison;
export function holdoutUsage(input: {
  runs: Array<{ evaluationRunId: string; run?: Record<string, unknown>; workflow?: Record<string, unknown> | null }>;
  caseId: string;
}): { caseId: string; used: boolean; uses: HoldoutUse[] };
