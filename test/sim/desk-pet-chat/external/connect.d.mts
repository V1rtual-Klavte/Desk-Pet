export interface ConnectedDatasetStatus {
  dataset: string; ready: boolean; datasetRoot: string; imported?: number; fixtures?: number;
  blocked?: Array<{id: string; blockers: string[]}>; issues?: string[]; inputHash?: string; cached?: boolean; reason?: string;
}
export function verifyConnectedDataset(options: {dataset: string; repoRoot?: string}): ConnectedDatasetStatus;
export function assertDatasetReplaceable(root: string): void;
export function connectInstalledDataset(options: {
  dataset: "beam" | "multichallenge" | "gaia"; repoRoot?: string; card: string; profile?: string; clock?: string;
  onProgress?: (event: {dataset: string; imported: number; fixtures: number}) => void;
  groups?: AsyncIterable<import("./index.mjs").ExternalTask[]> | Iterable<import("./index.mjs").ExternalTask[]>;
}): Promise<ConnectedDatasetStatus>;
