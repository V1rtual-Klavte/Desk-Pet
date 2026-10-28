/** Verified public benchmark inputs are copied into each isolated run, never referenced in place. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXTERNAL_DATASET_ROOT, resolveExternalOutput } from "./index.mjs";
import { EXTERNAL_ASSET_MAX_BYTES, validateExternalAsset } from "../dataset.mjs";

export const MAX_EXTERNAL_ASSET_BYTES = EXTERNAL_ASSET_MAX_BYTES;
export { validateExternalAsset };
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function resolveGaiaAssets(tasks, { repoRoot = process.cwd() } = {}) {
  const rawRoot = resolve(repoRoot, EXTERNAL_DATASET_ROOT, "gaia/raw");
  return tasks.map(task => {
    if (!task.assets?.length) return task;
    const assets = [];
    for (const input of task.assets) {
      const upstreamPath = String(input.upstreamPath ?? input.path ?? "").replaceAll("\\", "/");
      if (!upstreamPath || isAbsolute(upstreamPath) || upstreamPath.split("/").includes("..")) return task;
      const path = resolve(rawRoot, upstreamPath.startsWith("2023/") ? upstreamPath : `2023/${task.split}/${upstreamPath}`);
      if (!existsSync(path)) return task;
      resolveExternalOutput(repoRoot, path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXTERNAL_ASSET_BYTES) return task;
      const bytes = readFileSync(path);
      assets.push(validateExternalAsset({ sourcePath: relative(repoRoot, path).split(sep).join("/"), targetPath: `inputs/${basename(path)}`, sha256: hash(bytes), bytes: bytes.length }));
    }
    return { ...task, assets, readiness: { runnable: true, blockers: [] }, adaptationNotes: [...task.adaptationNotes, "Authorized upstream attachments are SHA-256-bound and copied into each isolated run before execution."] };
  });
}

export function stageExternalAssets(assets = [], { repoRoot = process.cwd(), dataRoot } = {}) {
  if (typeof dataRoot !== "string" || !dataRoot) throw new Error("Asset staging requires an isolated data root");
  const seen = new Set();
  return assets.map(value => {
    const asset = validateExternalAsset(value);
    if (seen.has(asset.targetPath)) throw new Error("Duplicate external asset target");
    seen.add(asset.targetPath);
    const source = resolveExternalOutput(repoRoot, asset.sourcePath);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes || hash(readFileSync(source)) !== asset.sha256) throw new Error(`External asset has changed: ${asset.sourcePath}`);
    const target = resolve(dataRoot, asset.targetPath);
    if (relative(resolve(dataRoot), target).startsWith("..")) throw new Error("External asset escaped isolated root");
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) throw new Error("Refusing to overwrite staged external input");
    copyFileSync(source, target);
    if (hash(readFileSync(target)) !== asset.sha256) throw new Error("Staged external asset hash mismatch");
    return { targetPath: asset.targetPath, sha256: asset.sha256, bytes: asset.bytes };
  });
}
