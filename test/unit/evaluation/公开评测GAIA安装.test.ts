import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GAIA_DATA_ROOT,
  GAIA_EXPECTED_QUESTIONS,
  GAIA_REPOSITORY,
  GAIA_REVISION,
  verifyGaiaInstall,
} from "../../sim/desk-pet-chat/external/gaia-install.mjs";
import { normalizeGaia } from "../../sim/desk-pet-chat/external/batch-one.mjs";

const repoRoot = resolve(process.cwd());
const owned: string[] = [];

function scratchRoot() {
  const parent = join(repoRoot, "test/.tmp/external-eval");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "gaia-install-test-"));
  owned.push(root);
  return root;
}

afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GAIA pinned local installation metadata", () => {
  it("locks the gated snapshot, public split counts, and repository-local raw destination [gaia-install-pinned-source]", () => {
    expect(GAIA_REPOSITORY).toBe("gaia-benchmark/GAIA");
    expect(GAIA_REVISION).toBe("682dd723ee1e1697e00360edccf2366dc8418dd9");
    expect(GAIA_EXPECTED_QUESTIONS).toEqual({ validation: 165, test: 301 });
    expect(GAIA_DATA_ROOT).toBe("test/sim/desk-pet-chat/external/.data/gaia");
  });

  it("never promotes the public test split or its question-mark placeholders to scored dev tasks [gaia-install-hidden-test-gate]", () => {
    const row = { task_id: "public-test-1", Question: "A public task", Level: 1, "Final answer": "?" };
    expect(() => normalizeGaia([row], { revision: GAIA_REVISION, split: "test" })).toThrow(/only an authorized local dev\/validation split/);
  });

  it("does not trust a complete-looking manifest without the pinned raw files and source manifest [gaia-install-readiness-gate]", async () => {
    const root = scratchRoot();
    expect(await verifyGaiaInstall({ repoRoot: root })).toEqual({ ready: false, reason: "not-installed" });
    const directory = join(root, GAIA_DATA_ROOT);
    mkdirSync(directory, { recursive: true });
    const manifestPath = join(directory, "install-manifest.json");
    const base = {
      schemaVersion: 1,
      dataset: "gaia",
      status: "complete",
      completeCounts: true,
      revision: GAIA_REVISION,
      totalBytes: 109_946_203,
      actual: { files: { validation: 39, test: 72, total: 111 }, questions: { validation: { records: 165 }, test: { records: 301 } } },
      authorizedLocalAccess: true,
      personalIdentityRecorded: false,
    };
    writeFileSync(manifestPath, JSON.stringify({ ...base, status: "verification-failed" }));
    expect(await verifyGaiaInstall({ repoRoot: root })).toEqual({ ready: false, reason: "incomplete-install" });
    writeFileSync(manifestPath, JSON.stringify({ ...base, revision: "a".repeat(40) }));
    expect(await verifyGaiaInstall({ repoRoot: root })).toEqual({ ready: false, reason: "incomplete-install" });
    writeFileSync(manifestPath, JSON.stringify({ ...base, completeCounts: false }));
    expect(await verifyGaiaInstall({ repoRoot: root })).toEqual({ ready: false, reason: "incomplete-install" });
    writeFileSync(manifestPath, JSON.stringify(base));
    await expect(verifyGaiaInstall({ repoRoot: root })).resolves.toEqual({ ready: false, reason: "incomplete-install" });
  });
});
