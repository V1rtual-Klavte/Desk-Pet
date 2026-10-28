import type { ExternalTask } from "./index.mjs";

export interface ExternalSource {
  id: string;
  url: string;
  repository: string;
  revision: string;
  format: string[];
  split: string[];
  license: string;
  availability: string;
  downloadPolicy: string;
  readiness: string;
  [key: string]: unknown;
}

export interface PrepareExternalSourceOptions {
  dataset: string;
  inputPath: string;
  outputDir?: string;
  repoRoot?: string;
  split?: string;
  revision?: string;
  limit?: number;
}

export const EXTERNAL_SOURCE_CATALOG: readonly ExternalSource[];
export function listExternalSources(): ExternalSource[];
export function getExternalSource(dataset: string): ExternalSource;
export function prepareExternalSource(options: PrepareExternalSourceOptions): Promise<{
  tasks: ExternalTask[];
  manifest: { schemaVersion: 1; dataset: string; revision: string; split: string; inputSha256: string; rawSha256: string; recordCount: number; normalizedTaskCount: number; taskCount: number; executionTaskCount: number; [key: string]: unknown };
  outputDir?: string;
}>;
export function downloadPinnedExternalFile(options: {
  dataset: string;
  url: string;
  outputDir?: string;
  repoRoot?: string;
  maxBytes?: number;
  expectedSha256?: string;
}): Promise<{ path: string; bytes: number; sha256: string; revision: string; url: string; cached: boolean }>;
