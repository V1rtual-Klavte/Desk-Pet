import type { ExternalTask } from "./index.mjs";
export interface ExternalAsset {sourcePath: string; targetPath: string; sha256: string; bytes: number}
export const MAX_EXTERNAL_ASSET_BYTES: number;
export function validateExternalAsset(asset: unknown): ExternalAsset;
export function resolveGaiaAssets(tasks: ExternalTask[], options?: {repoRoot?: string}): ExternalTask[];
export function stageExternalAssets(assets: ExternalAsset[] | undefined, options: {repoRoot?: string; dataRoot: string}): Array<Pick<ExternalAsset,"targetPath"|"sha256"|"bytes">>;
