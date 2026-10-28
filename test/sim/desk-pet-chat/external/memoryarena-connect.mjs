/** Preserve each MemoryArena group as one ordered case spanning real product sessions. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildEnvironmentCase, runEnvironmentTurn } from "./environment-turn.mjs";
import { EXTERNAL_DATASET_ROOT, resolveExternalOutput } from "./index.mjs";
import { buildMemoryArenaSequence, memoryArenaMcpServer, runMemoryArenaShoppingEnvironment, verifyMemoryArenaInstall, loadMemoryArenaGroup } from "./memoryarena.mjs";
import { hashCanonical } from "../dataset.mjs";
import { assertDatasetReplaceable, verifyConnectedDataset } from "./connect.mjs";

const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function memoryArenaRequest({ config, group, runId, cardPath, authorizationPath, extractMemory = true, repoRoot = process.cwd() }) {
  const sequence = buildMemoryArenaSequence({ config, group, runId });
  const expected = config === "group_travel_planner" ? [group.base_person.daily_plans, ...group.answers] : group.answers;
  return {
    dataset: "memoryarena", taskId: `${config}-${group.id}`, split: config,
    turns: sequence.driver.turns, extractMemory, runId, cardPath, authorizationPath,
    expectations: expected.map(answer => ({
      referenceAnswers: [typeof answer === "string" ? answer : JSON.stringify(answer)],
      criteria: ["Respect all constraints introduced by this subtask and the earlier ordered sessions; verify actual environment results where tools are required."],
    })),
  };
}

export function connectMemoryArena({ repoRoot = process.cwd(), card, extractMemory = true } = {}) {
  if (typeof card !== "string" || !card.trim()) throw new Error("MemoryArena connection requires --card-name");
  const installation = verifyMemoryArenaInstall({ repoRoot });
  if (!installation.verified) throw new Error("MemoryArena source verification failed");
  const root = resolveExternalOutput(repoRoot, join(EXTERNAL_DATASET_ROOT, "memoryarena"));
  const output = join(root, "dataset");
  const compiler = digest(["memoryarena-connect.mjs", "environment-turn.mjs", "memoryarena.mjs", "index.mjs", "../dataset.mjs"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join(""));
  const inputHash = hashCanonical({ source: installation.files, card, extractMemory, compiler });
  if (existsSync(join(output, "import.json"))) {
    const prior = verifyConnectedDataset({ dataset: "memoryarena", repoRoot });
    if (prior.ready && prior.inputHash === inputHash && prior.imported === 701) return { ...prior, subtasks: 4850, cached: true };
  }
  const verifiedConfigs = new Map((installation.configs ?? []).map(item => [item.config, item]));
  if (!Array.isArray(installation.files) || installation.files.length !== verifiedConfigs.size) {
    throw new Error("MemoryArena manifest does not list every verified configuration exactly once");
  }
  const contents = new Map();
  for (const file of installation.files) {
    const expected = verifiedConfigs.get(file.config);
    const sha256 = String(file.sha256 ?? "").replace(/^sha256:/, "");
    if (!expected || !Number.isSafeInteger(file.groups) || !Number.isSafeInteger(file.subtasks)
      || expected.groups !== file.groups || expected.subtasks !== file.subtasks || expected.sha256 !== sha256) {
      throw new Error(`MemoryArena manifest entry does not match its verified configuration: ${file.config}`);
    }
    const content = readFileSync(file.path);
    if (digest(content) !== `sha256:${sha256}`) throw new Error(`MemoryArena configuration bytes differ from the verified source: ${file.config}`);
    contents.set(file.path, content.toString("utf8"));
  }
  assertDatasetReplaceable(output);
  const temporary = `${output}.staging-${randomUUID()}`;
  const suites = join(temporary, "suites", "memoryarena");
  for (const path of ["cases", "fixtures", "approvals"]) mkdirSync(join(suites, path), { recursive: true });
  const files = [];
  const cases = [];
  let subtasks = 0;
  const write = (path, value) => {
    const text = `${JSON.stringify(value)}\n`;
    writeFileSync(path, text, { flag: "wx" });
    files.push({ path: relative(temporary, path).replaceAll("\\", "/"), sha256: digest(text) });
  };
  for (const file of installation.files) {
    const groups = contents.get(file.path).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    for (const group of groups) {
      const request = memoryArenaRequest({ config: file.config, group, runId: `memoryarena-${file.config.replaceAll("_", "-")}-${group.id}`, extractMemory, repoRoot });
      const entry = buildEnvironmentCase(request, { card });
      entry.case.categories = ["chat", "memory", "tools", "session", ...(file.config === "group_travel_planner" ? ["plan"] : ["tasks"])];
      entry.case.source.upstream.sha256 = file.sha256.startsWith("sha256:") ? file.sha256 : `sha256:${file.sha256}`;
      entry.case.source.upstream.adaptationNotes.push("Each ordered subtask opens a new product session in the same isolated data root; explicit dreaming checkpoints preserve the product memory mechanism. Independent coding-agent grading is an adaptation; official travel metrics are available separately.");
      write(join(suites, "cases", `${entry.case.caseId}.case.json`), entry.case);
      write(join(suites, "fixtures", `${entry.fixture.fixtureId}.json`), entry.fixture);
      cases.push({ caseId: entry.case.caseId, fixtureId: entry.fixture.fixtureId, config: file.config, groupId: group.id, sourceSubtasks: group.questions.length, driverMessages: request.turns.length });
      subtasks += group.questions.length;
    }
  }
  if (cases.length !== 701 || subtasks !== 4850) throw new Error(`Incomplete MemoryArena conversion: ${cases.length} groups/${subtasks} subtasks`);
  write(join(suites, "suite.json"), { schemaVersion: 4, suiteId: "memoryarena", revision: 1, purpose: "development", title: "MemoryArena ordered multi-session tasks", caseIds: cases.map(item => item.caseId) });
  write(join(temporary, "tasks.json"), cases);
  const manifest = { schemaVersion: 1, dataset: "memoryarena", protocol: "adapted", inputHash, imported: cases.length, subtasks, fixtures: cases.length, cases, files, environment: installation.environment, blocked: [], card, extractMemory };
  writeFileSync(join(temporary, "import.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  if (existsSync(output)) {
    const archive = join(root, "archives", new Date().toISOString().replaceAll(":", "-"));
    mkdirSync(archive, { recursive: true });
    renameSync(output, join(archive, "dataset"));
  }
  renameSync(temporary, output);
  return { dataset: "memoryarena", ready: true, datasetRoot: output, imported: cases.length, subtasks, cached: false };
}

export async function runMemoryArenaGroup({ config, groupId, cardPath, authorizationPath, modelSettingsPath, runId, repoRoot = process.cwd(), extractMemory = true } = {}) {
  const installation = verifyMemoryArenaInstall({ repoRoot });
  const readiness = installation.environment?.configs?.[config];
  if (readiness?.ready !== true) {
    throw new Error(`MemoryArena ${config} environment is not ready: ${(readiness?.blockers ?? ["verification did not report this configuration"]).join("; ")}`);
  }
  const group = loadMemoryArenaGroup({ config, groupId, repoRoot });
  const request = memoryArenaRequest({ config, group, runId: runId ?? `memoryarena-${randomUUID().replaceAll("-", "").slice(0, 12)}`, cardPath, authorizationPath, repoRoot, extractMemory });
  if (modelSettingsPath) request.modelSettingsPath = modelSettingsPath;
  const mcp = memoryArenaMcpServer({ repoRoot, config, groupId });
  request.mcpServer = { name: "memoryarena", transport: "stdio", enabled: true, command: mcp.command, args: mcp.args, env: {} };
  // Shopping prewarms its run-owned loopback service inside the wrapper; other configs
  // reach their MCP server directly through the native runner hook.
  if (config === "bundled_shopping") return runMemoryArenaShoppingEnvironment(request, { repoRoot });
  return runEnvironmentTurn(request, { repoRoot });
}
