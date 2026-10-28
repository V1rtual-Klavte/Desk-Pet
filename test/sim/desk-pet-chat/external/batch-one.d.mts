export type ExternalHistoryTurn = { role: "user" | "assistant"; content: string };
export type ExternalTask = {
  schemaVersion: 1;
  dataset: "gaia" | "multichallenge" | "memoryarena";
  id: string;
  revision: string;
  split: string;
  mode: "task" | "fixed-history" | "environment";
  title: string;
  categories: string[];
  questionTypes: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  history: ExternalHistoryTurn[];
  turns: { id: string; prompt: string }[];
  oracle: { referenceAnswers: string[]; criteria: string[]; raw?: unknown };
  assets: { path: string; fileName?: string; upstreamPath?: string }[];
  environment: { required: boolean; kind?: string; [key: string]: unknown };
  readiness: { runnable: boolean; blockers: string[] };
  adaptationNotes: string[];
  source: { url: string; revision: string; license: string; [key: string]: unknown };
};

export function normalizeGaia(records: unknown[], options: { revision: string; split?: string }): ExternalTask[];
export function normalizeMultiChallenge(records: unknown[], options: { revision: string; split?: string }): ExternalTask[];
export function normalizeMemoryArenaTravel(records: unknown[], options: { revision: string; split?: string }): ExternalTask[];
