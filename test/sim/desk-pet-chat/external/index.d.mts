import type { CaseSpec, FixtureSpec } from "../dataset.mjs";

export interface ExternalTask {
  schemaVersion: 1;
  dataset: string;
  id: string;
  revision: string;
  split: string;
  mode: "task" | "fixed-history" | "environment";
  title: string;
  categories: string[];
  questionTypes: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  turns: Array<{ id: string; prompt: string }>;
  oracle: { referenceAnswers: string[]; criteria: string[]; raw?: unknown };
  assets: Array<{ path?: string; sourcePath?: string; targetPath?: string; sha256?: string; bytes?: number; [key: string]: unknown }>;
  environment: { required: boolean; kind?: string; [key: string]: unknown };
  readiness: { runnable: boolean; blockers: string[] };
  adaptationNotes: string[];
  source: { url: string; license: string; [key: string]: unknown };
}

export interface ExternalImportOptions {
  fixtureKey?: string;
  fixtureTitle?: string;
  repoRoot?: string;
  root?: string;
  card: string;
  profile?: string;
  clock?: string;
  rawSha256?: string;
}

export const EXTERNAL_DATASET_ROOT: string;
export function externalCaseId(task: {dataset: string; id: string; split: string}): string;
export function resolveExternalOutput(repoRoot: string, root: string): string;
export function buildExternalCase(task: ExternalTask, options: ExternalImportOptions): { case: CaseSpec; fixture: FixtureSpec };
export function importExternalTasks(tasks: ExternalTask[], options: ExternalImportOptions): {
  schemaVersion: number;
  dataset: string;
  protocol: string;
  inputHash: string;
  rawSha256: string | null;
  imported: number;
  blocked: Array<{ id: string; mode: string; blockers: string[] }>;
  cases: Array<{ upstreamId: string; caseId: string }>;
  datasetRoot: string;
};
