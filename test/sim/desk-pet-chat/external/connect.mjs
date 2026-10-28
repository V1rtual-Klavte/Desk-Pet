/** Compile installed public inputs one conversation at a time, sharing its historical fixture. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildExternalCase, EXTERNAL_DATASET_ROOT, resolveExternalOutput } from "./index.mjs";
import { hashCanonical, loadDataset, validateCaseSpec } from "../dataset.mjs";
import { normalizeGaia, normalizeMultiChallenge } from "./batch-one.mjs";
import { resolveGaiaAssets } from "./assets.mjs";
import { normalizeBeam } from "./batch-two.mjs";
import { iterateInstalledBeam, MULTICHALLENGE_REVISION, verifyPublicDatasetInstall } from "./beam-install.mjs";
import { verifyGaiaInstall } from "./gaia-install.mjs";
import { readParquetRecords } from "./parquet.mjs";

const DEFAULT_CLOCK = "2026-01-01T00:00:00.000Z";
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = value => `${JSON.stringify(value)}\n`;

async function* installedGroups(dataset, repoRoot, install) {
  if (dataset === "gaia") {
    const file = install.files.find(file => file.split === "validation" && file.path.endsWith("metadata.parquet"));
    const rows = await readParquetRecords(resolve(repoRoot, EXTERNAL_DATASET_ROOT, "gaia/raw", file.path));
    for (const row of rows) yield resolveGaiaAssets(normalizeGaia([row], { revision: install.revision, split: "validation" }), { repoRoot });
    return;
  }
  if (dataset === "multichallenge") {
    const rows = await readParquetRecords(resolve(repoRoot, install.files[0].path));
    for (const row of rows) yield normalizeMultiChallenge([row], { revision: MULTICHALLENGE_REVISION, split: "test" });
    return;
  }
  for await (const row of iterateInstalledBeam({ repoRoot })) {
    yield normalizeBeam([row], {
      revision: row.upstreamRevision, split: row.upstreamSplit,
      sourceUrl: row.sourceUrl, datasetUrl: `https://huggingface.co/datasets/${row.upstreamDataset}`,
    });
  }
}

function hasApprovals(root) {
  if (!existsSync(root)) return false;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const path = join(root, name.name);
    if (name.name === "approvals" && readdirSync(path).length) return true;
    if (hasApprovals(path)) return true;
  }
  return false;
}

export function assertDatasetReplaceable(root) {
  if (hasApprovals(root)) throw new Error("Existing dataset has approvals; refusing to replace it");
}

/** Verify a connected dataset using the emitted file checksums without retaining long histories. */
export function verifyConnectedDataset({ dataset, repoRoot = process.cwd() }) {
  const root = resolve(repoRoot, EXTERNAL_DATASET_ROOT, dataset, "dataset");
  const path = join(root, "import.json");
  if (!existsSync(path)) return { dataset, ready: false, reason: "not-connected", datasetRoot: root };
  resolveExternalOutput(repoRoot, path);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest.dataset !== dataset || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.cases) || manifest.imported !== manifest.cases.length
    || !Number.isSafeInteger(manifest.fixtures) || manifest.fixtures < 0 || !Array.isArray(manifest.blocked)) {
    return { dataset, ready: false, reason: "partial-import", datasetRoot: root };
  }
  const issues = [];
  const suitePath = `suites/${dataset}/suite.json`;
  const expectedFiles = new Set([suitePath, "tasks.json"]);
  const fixtureIds = new Set();
  const caseIds = new Set();
  const caseFiles = new Map();
  for (const item of manifest.cases) {
    if (typeof item?.caseId !== "string" || typeof item.fixtureId !== "string" || caseIds.has(item.caseId)) {
      issues.push("invalid or duplicate case identity");
      continue;
    }
    caseIds.add(item.caseId);
    fixtureIds.add(item.fixtureId);
    const casePath = `suites/${dataset}/cases/${item.caseId}.case.json`;
    caseFiles.set(casePath, item);
    expectedFiles.add(casePath);
    expectedFiles.add(`suites/${dataset}/fixtures/${item.fixtureId}.json`);
  }
  const actualFiles = new Set(manifest.files.map(item => item?.path));
  if (fixtureIds.size !== manifest.fixtures || actualFiles.size !== manifest.files.length
    || actualFiles.size !== expectedFiles.size || [...expectedFiles].some(file => !actualFiles.has(file))) {
    issues.push("incomplete compiled file set");
  }
  for (const item of manifest.files) {
    if (typeof item?.path !== "string" || typeof item.sha256 !== "string") { issues.push("invalid file receipt"); continue; }
    const file = resolve(root, item.path);
    if (relative(root, file).startsWith("..")) { issues.push(`invalid path: ${item.path}`); continue; }
    try {
      resolveExternalOutput(repoRoot, file);
      if (!existsSync(file)) { issues.push(`missing: ${item.path}`); continue; }
      const content = readFileSync(file);
      if (digest(content) !== item.sha256) { issues.push(`changed: ${item.path}`); continue; }
      if (item.path === suitePath) {
        const suite = JSON.parse(content.toString("utf8"));
        if (suite?.suiteId !== dataset || !Array.isArray(suite.caseIds)
          || suite.caseIds.length !== caseIds.size || new Set(suite.caseIds).size !== caseIds.size
          || suite.caseIds.some(id => !caseIds.has(id))) issues.push("suite case identities differ from import manifest");
      } else if (caseFiles.has(item.path)) {
        const expected = caseFiles.get(item.path);
        const spec = JSON.parse(content.toString("utf8"));
        if (spec?.caseId !== expected.caseId || spec.precondition?.fixtureId !== expected.fixtureId) issues.push(`case identity or fixture differs: ${item.path}`);
      }
    } catch { issues.push(`invalid file, path or symlink: ${item.path}`); }
  }
  return { dataset, ready: issues.length === 0, datasetRoot: root, imported: manifest.imported, fixtures: manifest.fixtures, blocked: manifest.blocked, issues, inputHash: manifest.inputHash };
}

/** No model calls. A complete installed source and explicit Card binding are required. */
export async function connectInstalledDataset({ dataset, repoRoot = process.cwd(), card, profile = "default", clock = DEFAULT_CLOCK, onProgress, groups } = {}) {
  if (!["beam", "multichallenge", "gaia"].includes(dataset)) throw new Error(`No static conversation compiler for ${dataset}`);
  if (typeof card !== "string" || !card.trim()) throw new Error("connect requires --card-name");
  const dataRoot = resolveExternalOutput(repoRoot, join(EXTERNAL_DATASET_ROOT, dataset));
  const installPath = join(dataRoot, "install-manifest.json");
  if (!existsSync(installPath)) throw new Error(`Install ${dataset} before connecting it`);
  const verification = dataset === "gaia" ? await verifyGaiaInstall({ repoRoot }) : await verifyPublicDatasetInstall(dataset, { repoRoot });
  if (!verification.ready) throw new Error(`Source installation verification failed: ${verification.error ?? verification.reason}`);
  const install = JSON.parse(readFileSync(installPath, "utf8"));
  const adapterFiles = ["connect.mjs", "index.mjs", "batch-one.mjs", "batch-two.mjs", "assets.mjs", "parquet.mjs", "beam-install.mjs", "../dataset.mjs"];
  const adapterHash = digest(adapterFiles.map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join(""));
  const inputHash = hashCanonical({ source: install.sourceManifest, card, profile, clock, adapterHash });
  const output = join(dataRoot, "dataset");
  if (existsSync(join(output, "import.json"))) {
    const current = verifyConnectedDataset({ dataset, repoRoot });
    if (current.ready && current.inputHash === inputHash) return { ...current, cached: true };
  }
  assertDatasetReplaceable(output);
  const registry = loadDataset({ repoRoot });
  if (registry.errors.length) throw new Error("Base dataset registry is invalid");
  const categoryIds = registry.categories.map(item => item.id);
  const questionTypeIds = registry.questionTypes.map(item => item.id);
  const temporary = `${output}.staging-${randomUUID()}`;
  const suiteDir = join(temporary, "suites", dataset);
  for (const subdir of ["cases", "fixtures", "approvals"]) mkdirSync(join(suiteDir, subdir), { recursive: true });
  const files = [];
  const cases = [];
  const blocked = [];
  const tasks = [];
  const seen = new Set();
  let fixtures = 0;
  const write = (path, value) => {
    const bytes = json(value);
    writeFileSync(path, bytes, { flag: "wx" });
    files.push({ path: relative(temporary, path).replaceAll("\\", "/"), sha256: digest(bytes) });
  };
  for await (const group of groups ?? installedGroups(dataset, repoRoot, install)) {
    if (!group.length) continue;
    const groupHash = hashCanonical({ sourceManifest: install.sourceManifest, history: group[0].history, tasks: group.map(({ history, ...task }) => task) });
    const fixtureKey = groupHash.slice(7, 31);
    const fixtureTitle = `${dataset} ${group[0].split} ${group[0].source.conversationId ?? group[0].id}`;
    let wroteFixture = false;
    for (const task of group) {
      if (!task.readiness?.runnable || task.readiness.blockers?.length) {
        blocked.push({ id: task.id, blockers: task.readiness?.blockers ?? [] });
        continue;
      }
      const entry = buildExternalCase(task, { card, profile, clock, fixtureKey, fixtureTitle, rawSha256: groupHash });
      validateCaseSpec(entry.case, { categoryIds, questionTypeIds });
      if (seen.has(entry.case.caseId)) throw new Error(`Duplicate upstream identity: ${task.id}`);
      seen.add(entry.case.caseId);
      if (!wroteFixture) {
        write(join(suiteDir, "fixtures", `${entry.fixture.fixtureId}.json`), entry.fixture);
        wroteFixture = true;
        fixtures += 1;
      }
      write(join(suiteDir, "cases", `${entry.case.caseId}.case.json`), entry.case);
      cases.push({ upstreamId: task.id, caseId: entry.case.caseId, split: task.split, fixtureId: entry.fixture.fixtureId });
      const { history, ...summary } = task;
      tasks.push({ ...summary, historyRef: entry.fixture.fixtureId, historyMessages: history.length });
    }
    onProgress?.({ dataset, imported: cases.length, fixtures });
  }
  const expectedProbes = dataset === "gaia" ? install.actual.questions.validation.rowsWithReferenceAnswer : install.expected.probes;
  if (cases.length + blocked.length !== expectedProbes) throw new Error(`Incomplete conversion: ${cases.length + blocked.length}/${expectedProbes}`);
  write(join(suiteDir, "suite.json"), { schemaVersion: 4, suiteId: dataset, revision: 1, purpose: "development", title: `${dataset} 公开集完整适配`, caseIds: cases.map(item => item.caseId) });
  write(join(temporary, "tasks.json"), tasks);
  const manifest = { schemaVersion: 1, dataset, protocol: "adapted", inputHash, sourceManifest: install.sourceManifest, imported: cases.length, fixtures, blocked, cases, files, card, profile, clock };
  writeFileSync(join(temporary, "import.json"), json(manifest), { flag: "wx" });
  if (existsSync(output)) {
    const archive = join(dataRoot, "archives", new Date().toISOString().replaceAll(":", "-"));
    mkdirSync(archive, { recursive: true });
    renameSync(output, join(archive, "dataset"));
  }
  renameSync(temporary, output);
  return { dataset, ready: true, datasetRoot: output, imported: cases.length, fixtures, blocked, inputHash, cached: false };
}
