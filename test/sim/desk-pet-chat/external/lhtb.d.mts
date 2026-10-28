export const LHTB_REVISION: string;
export const LHTB_SOURCE_URL: string;
export const LHTB_ARCHIVE_SHA256: string;

export interface LhtbTaskInfo {
  id: string;
  family: "1.0" | "2.0";
  path: string;
  instructionPath: string;
  taskTomlPath: string;
  taskToml: string;
  taskName: string;
  dockerImage: string | null;
  agentTimeoutSec: number | null;
  verifierTimeoutSec: number | null;
  continueUntilTimeout: boolean;
  verifierAvailable: boolean;
  privateVerifierAvailable: boolean;
  verifierFileCount: number;
  solutionAvailable: boolean;
}

export function inspectLhtbInstall(options?: { dataRoot?: string; pythonPath?: string }): {
  ready: boolean;
  revision: string | null;
  expectedRevision: string;
  upstream: string;
  harborRoot: string;
  taskCount: number;
  verifierTaskCount: number;
  privateVerifierTaskCount: number;
  containerImages: { prePulledByInstaller: false; checked: false; taskImageCount: number; note: string };
  harborContinueUntilTimeout: boolean;
  sourceTreeSha256: string | null;
  runtimeVerified: boolean;
  blockers: string[];
};
export function installLhtb(options?: { dataRoot?: string; pythonPath?: string; uvPath?: string; timeoutMs?: number }): Promise<Record<string, unknown> & { revision: string; archiveSha256: string; taskCount: number; verifierTaskCount: number; harborVersion: string }>;
export function listLhtbTasks(options?: { dataRoot?: string; family?: "all" | "1.0" | "2.0" }): LhtbTaskInfo[];
export function planLhtbRun(options: { taskIds: string[]; dataRoot?: string; trials?: number; parallelism?: 1; maxWallSeconds?: number | null; checkImages?: boolean; dockerPath?: string }): {
  dataset: "lhtb";
  revision: string;
  taskIds: string[];
  trials: number;
  parallelism: 1;
  estimatedTaskSeconds: number;
  totalMaxSeconds: number;
  productAgent: string;
  scoreSource: string;
  containerImageReadiness: string;
  tasks: Array<Pick<LhtbTaskInfo, "id" | "family" | "dockerImage" | "agentTimeoutSec" | "verifierTimeoutSec" | "continueUntilTimeout" | "verifierAvailable" | "privateVerifierAvailable"> & { imageReadiness: "not-checked" | "available-locally" | "needs-fetch" | "build-on-demand"; imageReason: string | null; imageId: string | null }>;
  requiresExplicitRun: true;
};
export function inspectLhtbTaskImage(options: { taskId: string; dataRoot?: string; dockerPath?: string }): {
  taskId: string; image: string | null; available: boolean; imageId?: string | null; checkedAt?: string; reason: string | null;
};
export function ensureLhtbDockerPlugins(options?: { dataRoot?: string; sourceDir?: string }): { dockerConfig: string; plugins: string[] };
export function buildLhtbTrialCommand(options: { taskId: string; cardPath: string; authorizationPath: string; runId: string; dataRoot?: string; repoRoot?: string }): {
  task: LhtbTaskInfo;
  runId: string;
  outputRoot: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  repoRoot: string;
  python: string;
};
export function startLhtbRun(options: { taskId: string; cardPath: string; authorizationPath: string; runId: string; modelCallsAuthorized: true; dataRoot?: string; repoRoot?: string; pythonPath?: string; dockerPath?: string; imagePreflightTimeoutMs?: number }): Promise<{
  runId: string;
  statusPath: string;
  logPath: string;
  pid: number | undefined;
  taskId: string;
  revision: string;
  image: Record<string, unknown>;
}>;
export function ensureLhtbTaskImage(options: { taskId: string; dataRoot?: string; dockerPath?: string; pythonPath?: string; timeoutMs?: number }): Promise<Record<string, unknown> & { ready: boolean; taskId: string; image: string | null; reason?: string }>;
export function getLhtbRunStatus(options: { runId: string; dataRoot?: string; pythonPath?: string }): Record<string, unknown> & {
  status: "starting" | "running" | "completed" | "failed";
  reward?: number | null;
  rewards?: Record<string, number> | null;
  /** Derived only for the conventional normalized scalar reward; not an official benchmark pass. */
  passed?: boolean | null;
  taskResultCount: number;
};
export function buildLhtbRunRequest(options: { taskId: string; instruction: string; cardPath: string; authorizationPath: string; timeoutSeconds: number; runId?: string; mcpServer: Record<string, unknown> }): Record<string, unknown>;
export function invokeDeskPetRuntime(options: { request: Record<string, unknown>; brokerEnv: Record<string, string>; repoRoot?: string; timeoutSeconds?: number }): Promise<Record<string, unknown>>;
export function recordLhtbInstallation(options?: { dataRoot?: string; archiveBytes?: number; sourceTreeSha256?: string; installedAt?: string }): Record<string, unknown>;
