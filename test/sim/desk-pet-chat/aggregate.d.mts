import type { Dataset } from "./dataset.mjs";
import type { ChatTrialPlan } from "./evidence.mjs";

export const TRIAL_AGGREGATION_SCHEMA_VERSION: 1;
export const TRIAL_AGGREGATION_RULE: string;
export const TRIAL_CHECK_STATUSES: readonly string[];

export interface AttemptJudgingStatus {
  execution: string;
  evidence: string;
  judge: {
    platform: string | null;
    model: string | null;
    promptVersion: string | null;
  } | null;
  overall: { status: string; reason: string };
  checks: Array<{
    ruleId: string;
    status: string;
    reason?: string;
    evidence?: unknown[];
  }>;
}

export interface TrialAttemptView {
  attemptId: string | null;
  trialId: string | null;
  repair?: boolean;
  status?: AttemptJudgingStatus | null;
  evidence?: string;
  execution?: string;
  issues?: string[];
}

export interface TrialRuleCell {
  trialId: string;
  attemptId: string | null;
  status: string;
  reason: string;
  evidenceRefs: number;
}

export interface TrialRuleRow {
  ruleId: string;
  rubric: string;
  polarity: string;
  critical: boolean;
  cells: TrialRuleCell[];
  counts: Record<string, number>;
  passK: { status: string; reason: string };
}

export interface TrialAggregate {
  schemaVersion: 1;
  aggregation: string;
  plan: {
    source: "frozen" | "actual";
    plannedTrials: number;
    trialIds: string[];
    budgetTrials?: number;
    createdAt?: string;
  };
  actualTrials: number;
  repairAttempts: Array<{ attemptId: string | null; trialId: string | null }>;
  slots: Array<{
    trialId: string;
    attemptId: string | null;
    evidence: string;
    execution: string;
    judge: AttemptJudgingStatus["judge"];
    overall: { status: string; reason: string } | null;
    issues: string[];
  }>;
  missingTrials: string[];
  extraTrials: Array<{ attemptId: string | null; trialId: string | null }>;
  unattributed: Array<{ attemptId: string | null; trialId: null }>;
  duplicateTrials: string[];
  rules: TrialRuleRow[];
  criticalPassK: {
    k: number;
    status: string;
    reason: string;
    rules: Array<{ ruleId: string; status: string; reason: string }>;
  };
  judge: {
    consistent: boolean;
    identities: Array<{
      platform: string | null;
      model: string | null;
      promptVersion: string | null;
      trials: string[];
    }>;
  };
  evidenceRefs: { complete: boolean; missing: string[] };
  gates: string[];
  overall: { status: string; reason: string };
}

export function summarizeTrials(options: {
  caseEntry: Dataset["cases"][number] | null;
  plan?: ChatTrialPlan | null;
  attempts?: TrialAttemptView[];
}): TrialAggregate;
