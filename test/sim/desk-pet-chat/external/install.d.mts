export const INSTALLABLE_EXTERNAL_DATASETS: readonly string[];
export function installExternalDatasets(options?: {dataset?: string; repoRoot?: string; card?: string; onProgress?: (event: any) => void}): Promise<{results: any[]; complete: boolean}>;
export function inspectExternalDatasets(options?: {dataset?: string; repoRoot?: string}): Promise<{results: any[]; complete: boolean}>;
