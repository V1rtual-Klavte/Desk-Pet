/** One public-dataset entrypoint for installation, integrity checks and native-runner connection. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXTERNAL_DATASET_ROOT } from "./index.mjs";
import { installPublicDataset, verifyPublicDatasetInstall } from "./beam-install.mjs";
import { installGaia, verifyGaiaInstall } from "./gaia-install.mjs";
import { connectInstalledDataset, verifyConnectedDataset } from "./connect.mjs";

export const INSTALLABLE_EXTERNAL_DATASETS = Object.freeze(["multichallenge", "beam", "gaia", "memoryarena", "lhtb"]);

function selected(dataset) {
  if (dataset === "all") return [...INSTALLABLE_EXTERNAL_DATASETS];
  if (!INSTALLABLE_EXTERNAL_DATASETS.includes(dataset)) throw new Error(`Unknown dataset: ${dataset}`);
  return [dataset];
}

export async function installExternalDatasets({ dataset = "all", repoRoot = process.cwd(), card, onProgress } = {}) {
  const results = [];
  for (const id of selected(dataset)) {
    try {
      let installation;
      if (id === "gaia") installation = await installGaia({ repoRoot, onProgress });
      else if (id === "beam" || id === "multichallenge") installation = await installPublicDataset(id, { repoRoot, onProgress });
      else if (id === "memoryarena") {
        const { installMemoryArena } = await import("./memoryarena.mjs");
        installation = await installMemoryArena({ repoRoot });
      } else {
        const { installLhtb } = await import("./lhtb.mjs");
        installation = await installLhtb({ repoRoot });
      }
      let connection = card && ["gaia", "beam", "multichallenge"].includes(id)
        ? await connectInstalledDataset({ dataset: id, repoRoot, card, onProgress }) : null;
      if (card && id === "memoryarena") {
        const { connectMemoryArena } = await import("./memoryarena-connect.mjs");
        connection = connectMemoryArena({ repoRoot, card });
      }
      results.push({ dataset: id, installation, connection });
    } catch (error) {
      results.push({ dataset: id, error: error.message, complete: false });
    }
  }
  return { results, complete: results.every(result => !result.error) };
}

export async function inspectExternalDatasets({ dataset = "all", repoRoot = process.cwd() } = {}) {
  const results = [];
  for (const id of selected(dataset)) {
    let installed = false;
    try {
      if (["gaia", "beam", "multichallenge"].includes(id)) {
        const verification = id === "gaia" ? await verifyGaiaInstall({ repoRoot }) : await verifyPublicDatasetInstall(id, { repoRoot });
        installed = verification.ready === true;
        results.push({ dataset: id, installed, revision: verification.revision, counts: verification.actual, totalBytes: verification.totalBytes, verification, connection: verifyConnectedDataset({ dataset: id, repoRoot }) });
        continue;
      }
      const root = resolve(repoRoot, EXTERNAL_DATASET_ROOT, id);
      const manifestPath = join(root, id === "lhtb" ? "installation.json" : "install-manifest.json");
      if (!existsSync(manifestPath)) { results.push({ dataset: id, installed: false }); continue; }
      if (id === "memoryarena") {
        const { verifyMemoryArenaInstall } = await import("./memoryarena.mjs");
        const verification = verifyMemoryArenaInstall({ repoRoot });
        installed = verification.verified === true;
        results.push({ dataset: id, installed, verification, connection: verifyConnectedDataset({ dataset: id, repoRoot }) });
      } else {
        const { inspectLhtbInstall } = await import("./lhtb.mjs");
        const verification = inspectLhtbInstall({ dataRoot: root });
        installed = verification.ready === true;
        results.push({ dataset: id, installed, verification });
      }
    } catch (error) {
      // Connection diagnostics must not overwrite an already established installation verdict.
      results.push({ dataset: id, installed, error: error.message });
    }
  }
  return { results, complete: results.every(result => result.installed === true && !result.error) };
}
