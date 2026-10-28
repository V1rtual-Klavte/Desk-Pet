export function memoryArenaRequest(options: {config: string; group: any; runId: string; cardPath?: string; authorizationPath?: string; extractMemory?: boolean; repoRoot?: string}): Record<string, any>;
export function connectMemoryArena(options: {repoRoot?: string; card: string; extractMemory?: boolean}): Record<string, any>;
export function runMemoryArenaGroup(options: {config: string; groupId: number; cardPath: string; authorizationPath: string; modelSettingsPath?: string; runId?: string; repoRoot?: string; extractMemory?: boolean}): Promise<Record<string, any>>;
