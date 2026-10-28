import type { CaseSpec, FixtureSpec } from "../dataset.mjs";
export function buildEnvironmentCase(request: Record<string, any>, options?: {card: string; clock?: string}): {case: CaseSpec; fixture: FixtureSpec};
export function runEnvironmentTurn(request: Record<string, any>, options?: {repoRoot?: string}): Promise<Record<string, any>>;
