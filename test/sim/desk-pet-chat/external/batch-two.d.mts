import type { ExternalTask } from "./index.mjs";

export function normalizeBeam(records: unknown[], options: { revision: string; split?: string; sourceUrl?: string; datasetUrl?: string }): ExternalTask[];
export function normalizeLhtb(records: unknown[], options: { revision: string; split?: string }): ExternalTask[];
export const BATCH_TWO_UPSTREAM: Readonly<{ BEAM_URL: string; LHTB_URL: string }>;
