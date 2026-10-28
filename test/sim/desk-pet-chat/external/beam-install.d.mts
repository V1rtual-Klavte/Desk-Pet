export const BEAM_DATASET_REVISION: string;
export const BEAM_10M_REVISION: string;
export const MULTICHALLENGE_REVISION: string;
export const EXTERNAL_DATA_ROOT: string;

export interface InstalledExternalFile {
  dataset: "beam" | "multichallenge";
  path: string;
  upstreamPath: string;
  url: string;
  revision: string;
  bytes: number;
  sha256: string;
  cached: boolean;
}

export interface PinnedInstallDescriptor {
  source: "beam" | "beam-10m" | "multichallenge";
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
  split: string;
  license: string;
  expectedChats?: number;
  expectedProbes?: number;
}

export interface PublicInstallResult {
  schemaVersion: 1;
  dataset: "beam" | "multichallenge";
  status: "complete";
  sourceManifest: Array<{ source: string; revision: string; split: string; upstreamPath: string; url: string; license: string; expectedBytes: number; expectedSha256: string }>;
  files: InstalledExternalFile[];
  totalBytes: number;
  cached: boolean;
  expected: { chats: number; probes: number; bySplit?: Record<string, { chats: number; probes: number }> };
  actual: { chats: number; probes: number; bySplit?: Record<string, { chats: number; probes: number }> };
  completeCounts: boolean;
}

export function installBeam(options?: { repoRoot?: string; fetchImpl?: typeof fetch; onProgress?: (event: { dataset: string; upstreamPath: string; receivedBytes: number; totalBytes: number }) => void }): Promise<PublicInstallResult>;
export function installMultiChallenge(options?: { repoRoot?: string; fetchImpl?: typeof fetch; onProgress?: (event: { dataset: string; upstreamPath: string; receivedBytes: number; totalBytes: number }) => void }): Promise<PublicInstallResult>;
export function installPublicDataset(dataset: "beam" | "multichallenge", options?: { repoRoot?: string; fetchImpl?: typeof fetch; onProgress?: (event: { dataset: string; upstreamPath: string; receivedBytes: number; totalBytes: number }) => void }): Promise<PublicInstallResult>;
export function verifyPublicDatasetInstall(dataset: "beam" | "multichallenge", options?: { repoRoot?: string }): Promise<{
  ready: boolean;
  reason?: "not-installed" | "incomplete-install";
  error?: string;
  totalBytes?: number;
  actual?: PublicInstallResult["actual"];
}>;
export function iterateInstalledBeam(options?: { repoRoot?: string; files?: InstalledExternalFile[] }): AsyncGenerator<{ chatId: string; chat: unknown[]; probingQuestions: Record<string, unknown[]>; upstreamSplit: string; upstreamDataset: string; upstreamRevision: string; sourceUrl: string }>;
export function iterateBeamRowsOneAtATime<T>(file: unknown, rowCount: number, options?: { readRows?: (options: { file: unknown; rowStart: number; rowEnd: number }) => Promise<T[]> }): AsyncGenerator<T>;
export function parseBeamPythonLiteral(source: string): unknown;
export function streamPinnedResponse(response: Response, partialPath: string, options: { offset: number; totalBytes: number; dataset?: string; upstreamPath?: string; onProgress?: (event: { dataset?: string; upstreamPath?: string; receivedBytes: number; totalBytes: number }) => void }): Promise<number>;
export const PUBLIC_INSTALL_FILES: Readonly<Record<"beam" | "multichallenge", readonly PinnedInstallDescriptor[]>>;
