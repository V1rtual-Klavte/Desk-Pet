export type MemoryArenaConfig =
  | "bundled_shopping"
  | "formal_reasoning_math"
  | "formal_reasoning_phys"
  | "group_travel_planner"
  | "progressive_search";

export interface MemoryArenaBridgeOptions {
  repoRoot?: string;
  pythonExecutable?: string;
}

export interface MemoryArenaPersonPlan {
  person_idx: number;
  plan: Array<Record<string, unknown>>;
}

export interface MemoryArenaTravelSubmission {
  id: number;
  persons: MemoryArenaPersonPlan[];
}

export const MEMORYARENA_DATASET_REVISION: string;
export const MEMORYARENA_OFFICIAL_REVISION: string;
export const MEMORYARENA_CONFIGS: readonly MemoryArenaConfig[];

export function installMemoryArena(options?: MemoryArenaBridgeOptions): Record<string, unknown>;
export function installMemoryArenaRuntime(options?: MemoryArenaBridgeOptions): {
  pythonExecutable: string;
  pythonVersion: "3.10.20";
  venvPath: string;
  requirements: string;
  spaCyModel: Record<string, unknown>;
  cachePath: string;
  javaAvailable: boolean;
  readiness: Record<string, { ready: boolean; blockers: string[] }>;
  verified: boolean;
};
export function buildMemoryArenaSearchIndex(options?: MemoryArenaBridgeOptions): {
  path: string;
  revision: string;
  corpusIdentity: string;
  files: number;
  documents: number;
  bytes: number;
  sha256: string;
  receiptSha256: string;
  backend: string;
  tokenizer: string;
  topK: number;
};
export function verifyMemoryArenaInstall(options?: MemoryArenaBridgeOptions): {
  /** Source hashes only; not evidence that every environment can execute. */
  verified: boolean;
  sourceVerified: boolean;
  environment: {
    ready: boolean;
    blockers: string[];
    configs: Record<MemoryArenaConfig, { ready: boolean; blockers: string[]; prewarmRequired?: boolean }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export function runMemoryArenaShoppingEnvironment(
  request: Record<string, unknown>,
  options?: MemoryArenaBridgeOptions & { signal?: AbortSignal },
): Promise<{ executionComplete: boolean; error?: string; [key: string]: unknown }>;
export function loadMemoryArenaGroup<T = Record<string, unknown>>(options: MemoryArenaBridgeOptions & {
  config: MemoryArenaConfig;
  groupId: number;
}): T;

export interface MemoryArenaTravelTurn {
  sessionId: string;
  stage: "baseline" | "traveler";
  personIndex: number;
  personName?: string;
  userMessage: string;
  expectedMemoryScope: string;
  memoryCheckpoint: { allowed: true; trigger: "explicit-host-step-only"; automatic: false };
}

export interface MemoryArenaTravelSeries {
  dataset: "memoryarena";
  config: "group_travel_planner";
  datasetRevision: string;
  groupId: number;
  groupTitle: string;
  baselinePerson: { name: string };
  memoryScopeId: string;
  sessionBoundary: string;
  memoryPolicy: {
    shareAcrossSessions: true;
    checkpoint: string;
    automaticCheckpoint: false;
    idleWaterlineIsNotEvidenceOfExtraction: true;
  };
  turns: MemoryArenaTravelTurn[];
}

export function buildMemoryArenaTravelSeries(options: {
  group: {
    id: number;
    base_person: { name: string; query: string; daily_plans: Array<Record<string, unknown>> };
    questions: string[];
    answers: unknown[];
  };
  runId: string;
  datasetRevision?: string;
}): MemoryArenaTravelSeries;

export interface MemoryArenaSequence {
  driver: {
    dataset: "memoryarena";
    config: MemoryArenaConfig;
    datasetRevision: string;
    groupId: number;
    groupTitle: string;
    memoryScopeId: string;
    sessionBoundary: string;
    memoryPolicy: {
      shareAcrossSessions: true;
      checkpoint: string;
      automaticCheckpoint: false;
      idleWaterlineIsNotEvidenceOfExtraction: true;
    };
    turns: Array<Omit<MemoryArenaTravelTurn, "stage"> & { stage: string; environmentStep?: Record<string, unknown> }>;
    environment?: Record<string, unknown>;
    baselinePerson?: { name: string };
  };
  /** Judge-only. Never pass this packet to the model-facing driver. */
  oracle: Record<string, unknown>;
}
export function buildMemoryArenaSequence(options: {
  config: MemoryArenaConfig;
  group: {
    id: number;
    questions: string[];
    answers: unknown[];
    base_person?: { name: string; query: string; daily_plans: Array<Record<string, unknown>> };
    backgrounds?: string[];
    paper_name?: string;
    [key: string]: unknown;
  };
  runId: string;
  datasetRevision?: string;
}): MemoryArenaSequence;

export function runMemoryArenaTravelTool(name: string, arguments_: Record<string, unknown>, options?: MemoryArenaBridgeOptions): { content: string };
export function evaluateMemoryArenaTravel(submission: MemoryArenaTravelSubmission[], options?: MemoryArenaBridgeOptions): {
  ps: number;
  sps: number;
  sr: number;
  upstream: Record<string, string>;
  console: string;
};
export function evaluateMemoryArenaShoppingDiagnostic(options: MemoryArenaBridgeOptions & {
  groupId: number;
  subtaskIndex: number;
  purchasedAsin?: string | null;
  purchasedPrice?: number | null;
}): {
  diagnostic: "official-memoryarena-shopping-no-llm-string-match";
  primaryJudge: "independent-coding-agent";
  modelApiCalled: false;
  upstream: Record<string, string>;
  result: Record<string, unknown>;
};
export function memoryArenaMcpServer(options?: MemoryArenaBridgeOptions & { config?: MemoryArenaConfig }): {
  command: string;
  args: string[];
  cwd: string;
  transport: "stdio";
  environmentRequirements: string[];
  server: { name: string; upstream: string; revision: string; config: MemoryArenaConfig };
};
export function spawnMemoryArenaMcpServer(options?: MemoryArenaBridgeOptions): import("node:child_process").ChildProcessWithoutNullStreams;
