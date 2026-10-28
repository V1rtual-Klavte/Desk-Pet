/** MemoryArena pinned-source installer and travel-environment bridge.
 *
 * Install once with the pinned upstream source and environment assets. MCP tools
 * are called through the host permission router; no model API is called.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEMORYARENA_DATASET_REVISION = "da1a37c8b19280e18627ca01cf368195a5e1d92e";
export const MEMORYARENA_OFFICIAL_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab";
export const MEMORYARENA_CONFIGS = Object.freeze([
  "bundled_shopping",
  "formal_reasoning_math",
  "formal_reasoning_phys",
  "group_travel_planner",
  "progressive_search",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "memoryarena_bridge.py");
const REPO_ROOT = resolve(HERE, "../../../..");
const MANAGED_PYTHON = join(REPO_ROOT, "test/sim/desk-pet-chat/external/.data/memoryarena/runtime/venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const DEFAULT_PYTHON = process.env.DESK_PET_MEMORYARENA_PYTHON || (existsSync(MANAGED_PYTHON) ? MANAGED_PYTHON : "python3");
const MAX_BRIDGE_OUTPUT = 32 * 1024 * 1024;

function rootPath(repoRoot) {
  const result = resolve(repoRoot ?? process.cwd());
  if (!existsSync(join(result, "test", "AGENTS.md"))) throw new Error(`Not a Desk-Pet repository root: ${result}`);
  return result;
}

function invoke(action, payload = {}, { repoRoot, pythonExecutable = DEFAULT_PYTHON, maxBuffer = MAX_BRIDGE_OUTPUT } = {}) {
  const cwd = rootPath(repoRoot);
  const result = spawnSync(pythonExecutable, [BRIDGE, "--action", action, "--repo-root", cwd], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`MemoryArena bridge (${action}) failed: ${(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`MemoryArena bridge (${action}) returned invalid JSON`); }
}

/** Install and verify every pinned configuration plus the official local travel environment. */
export function installMemoryArena(options = {}) {
  const runtime = invoke("install-runtime", {}, options);
  return invoke("install", {}, { ...options, pythonExecutable: runtime.pythonExecutable });
}

/** Create the pinned Python 3.10 runtime, dependencies, and spaCy model under .data. */
export function installMemoryArenaRuntime(options = {}) {
  return invoke("install-runtime", {}, options);
}

/** Build or resume the lexical index over the fully pinned BrowseComp corpus. */
export function buildMemoryArenaSearchIndex(options = {}) {
  return invoke("build-search-index", {}, options);
}

/** Return the installer receipt only after checking each raw configuration's hash and counts. */
export function verifyMemoryArenaInstall(options = {}) {
  const repo = rootPath(options.repoRoot);
  const manifestPath = join(repo, "test/sim/desk-pet-chat/external/.data/memoryarena/install-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.datasetRevision !== MEMORYARENA_DATASET_REVISION || manifest.officialRevision !== MEMORYARENA_OFFICIAL_REVISION) {
    throw new Error("MemoryArena installation receipt has an unexpected upstream revision");
  }
  const checked = invoke("verify", {}, options);
  return { ...manifest, verified: checked.verified, sourceVerified: checked.sourceVerified, configs: checked.configs, totals: checked.totals, environment: checked.environment };
}

/** Prewarm a run-owned loopback shopping service before the existing native-runner hook.
 * Only runtime environment variables carry the service lease; the request is unchanged.
 */
export async function runMemoryArenaShoppingEnvironment(request, options = {}) {
  const cwd = rootPath(options.repoRoot);
  const python = options.pythonExecutable ?? process.env.DESK_PET_MEMORYARENA_PYTHON
    ?? join(cwd, "test/sim/desk-pet-chat/external/.data/memoryarena/runtime/venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 20 * 1024 * 1024) throw new Error("Environment request exceeds its byte limit");
  if (options.signal?.aborted) return { executionComplete: false, error: "Shopping environment cancelled before startup" };
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [BRIDGE, "--action", "run-shopping-environment", "--repo-root", cwd, "--node-executable", process.execPath], {
      cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    let bytes = 0;
    let overflow = false;
    let cancelling = false;
    let escalation;
    const cancel = () => {
      if (cancelling) return;
      cancelling = true;
      child.kill("SIGTERM");
      // Python allows the Node runner 30s to stop its owned native host, then
      // releases its service; escalation is only for a nonresponsive wrapper.
      escalation = setTimeout(() => child.kill("SIGKILL"), 45_000);
      escalation.unref();
    };
    const cleanup = () => {
      clearTimeout(escalation);
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
      options.signal?.removeEventListener("abort", cancel);
    };
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_BRIDGE_OUTPUT) stdout.push(chunk);
      else { overflow = true; cancel(); }
    });
    // Diagnostic output is drained, not accumulated or copied into frozen files.
    child.stderr.resume();
    child.stdin.on("error", error => { if (error.code !== "EPIPE") { cancel(); reject(error); } });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (overflow) { reject(new Error("Shopping wrapper exceeded its output bound")); return; }
      try {
        const lines = Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/);
        if (lines.length !== 1) throw new Error("invalid JSONL");
        const result = JSON.parse(lines[0]);
        if (!result || typeof result.executionComplete !== "boolean" || (code !== 0 && result.executionComplete)) throw new Error("invalid execution result");
        resolveResult(result);
      } catch {
        reject(new Error(cancelling ? "Shopping wrapper cancelled without a complete response" : "Shopping wrapper returned invalid JSONL"));
      }
    });
    child.stdin.end(`${input}\n`);
  });
}

/** Load one raw, SHA-locked group from any of the five official configurations. */
export function loadMemoryArenaGroup({ config, groupId, ...options } = {}) {
  if (!MEMORYARENA_CONFIGS.includes(config)) throw new Error(`Unknown MemoryArena config: ${config}`);
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw new TypeError("groupId must be a non-negative integer");
  return invoke("load-group", { config, groupId }, options);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

/**
 * Build a MemoryArena-compatible sequential series for one travel group.
 * The baseline and each traveler are distinct product sessions sharing one
 * memory scope. Oracle plans/answers are intentionally absent from driver turns.
 */
export function buildMemoryArenaTravelSeries({ group, runId, datasetRevision = MEMORYARENA_DATASET_REVISION } = {}) {
  if (!group || !Number.isSafeInteger(group.id) || !group.base_person || !Array.isArray(group.questions) || !Array.isArray(group.answers)) {
    throw new TypeError("group must be a complete group_travel_planner record");
  }
  if (group.questions.length === 0 || group.questions.length !== group.answers.length) throw new Error("MemoryArena traveler questions and answers must align");
  requireText(runId, "runId");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(runId)) throw new TypeError("runId contains unsupported characters");
  const baseName = requireText(group.base_person.name, "base_person.name");
  const basePrompt = requireText(group.base_person.query, "base_person.query");
  const scopeId = `memoryarena-${runId}-group-${group.id}`;
  const turns = [{
    sessionId: `${scopeId}-baseline`,
    stage: "baseline",
    personIndex: 0,
    userMessage: basePrompt,
    expectedMemoryScope: scopeId,
    memoryCheckpoint: { allowed: true, trigger: "explicit-host-step-only", automatic: false },
    environmentStep: { config: "group_travel_planner", groupId: group.id, subtaskIndex: -1 },
  }, ...group.questions.map((prompt, index) => ({
    sessionId: `${scopeId}-traveler-${index + 1}`,
    stage: "traveler",
    personIndex: index + 1,
    personName: (String(prompt).match(/^I am ([^.]*)\./)?.[1] || `Traveler ${index + 1}`).trim(),
    userMessage: requireText(prompt, `questions[${index}]`),
    expectedMemoryScope: scopeId,
    memoryCheckpoint: { allowed: true, trigger: "explicit-host-step-only", automatic: false },
    environmentStep: { config: "group_travel_planner", groupId: group.id, subtaskIndex: index },
  }))];
  return {
    dataset: "memoryarena",
    config: "group_travel_planner",
    datasetRevision,
    groupId: group.id,
    groupTitle: `MemoryArena group travel ${group.id}`,
    baselinePerson: { name: baseName },
    memoryScopeId: scopeId,
    sessionBoundary: "new-session-per-turn; preserve the same product memory scope for the complete ordered group",
    memoryPolicy: {
      shareAcrossSessions: true,
      checkpoint: "memory_dreaming_sweep may run only when the evaluation driver explicitly requests a checkpoint after a completed turn",
      automaticCheckpoint: false,
      idleWaterlineIsNotEvidenceOfExtraction: true,
    },
    turns,
  };
}

/**
 * Build driver and oracle packets for any installed MemoryArena configuration.
 * The driver is safe to send through real product sessions; the oracle remains
 * a separate object for the isolated judge/evaluator path.
 */
export function buildMemoryArenaSequence({ config, group, runId, datasetRevision = MEMORYARENA_DATASET_REVISION } = {}) {
  if (!MEMORYARENA_CONFIGS.includes(config)) throw new Error(`Unknown MemoryArena config: ${config}`);
  if (config === "group_travel_planner") {
    const driver = buildMemoryArenaTravelSeries({ group, runId, datasetRevision });
    return {
      driver,
      oracle: {
        source: { dataset: "ZexueHe/memoryarena", revision: datasetRevision, config, groupId: group.id },
        answers: group.answers,
        baselineDailyPlans: group.base_person.daily_plans,
        evaluator: "official-memoryarena-travel-evaluator",
      },
    };
  }
  if (!group || !Number.isSafeInteger(group.id) || !Array.isArray(group.questions) || !Array.isArray(group.answers) || group.questions.length === 0 || group.questions.length !== group.answers.length) {
    throw new TypeError(`${config} group must contain aligned non-empty questions and answers`);
  }
  requireText(runId, "runId");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(runId)) throw new TypeError("runId contains unsupported characters");
  const scopeId = `memoryarena-${config}-${runId}-group-${group.id}`;
  const backgroundFor = index => Array.isArray(group.backgrounds) ? group.backgrounds[index] : undefined;
  const turns = group.questions.map((question, index) => {
    const prompt = requireText(question, `questions[${index}]`);
    const background = backgroundFor(index);
    const context = typeof background === "string" && background.trim()
      ? `${group.paper_name ? `Paper: ${group.paper_name}\n\n` : ""}Provided background:\n${background}\n\nQuestion:\n${prompt}`
      : prompt;
    const turn = {
      sessionId: `${scopeId}-subtask-${index + 1}`,
      stage: "subtask",
      personIndex: index + 1,
      userMessage: context,
      expectedMemoryScope: scopeId,
      memoryCheckpoint: { allowed: true, trigger: "explicit-host-step-only", automatic: false },
      environmentStep: { config, groupId: group.id, subtaskIndex: index },
    };
    if (config === "bundled_shopping") turn.environmentStep.newEnvironmentTask = true;
    return turn;
  });
  const environmentByConfig = {
    bundled_shopping: {
      kind: "memoryarena-webshop-plus",
      required: true,
      tools: ["begin_task", "observe", "search", "click"],
      stateful: true,
      scoring: "official-no-llm-score-is-diagnostic; final judgement via independent coding-agent judge",
    },
    formal_reasoning_math: {
      kind: "memoryarena-formal-reasoning",
      required: true,
      tools: ["coding"],
      codingIsolation: "docker-no-network-read-only-root-nonroot-resource-limits",
      scoring: "reference-answer package + independent coding-agent judge; official run uses model judge",
    },
    formal_reasoning_phys: {
      kind: "memoryarena-formal-reasoning",
      required: true,
      tools: ["coding"],
      codingIsolation: "docker-no-network-read-only-root-nonroot-resource-limits",
      scoring: "reference-answer package + independent coding-agent judge; official run uses model judge",
    },
    progressive_search: {
      kind: "memoryarena-progressive-search",
      required: true,
      tools: ["search", "get_document"],
      stateful: true,
      scoring: "reference-answer package + independent coding-agent judge; adapted to installed local search environment",
    },
  };
  const title = config === "formal_reasoning_math" || config === "formal_reasoning_phys"
    ? `${config} ${group.paper_name ?? group.id}`
    : `${config} group ${group.id}`;
  return {
    driver: {
      dataset: "memoryarena",
      config,
      datasetRevision,
      groupId: group.id,
      groupTitle: title,
      memoryScopeId: scopeId,
      sessionBoundary: "new-session-per-subtask; preserve one product memory scope for the complete ordered group",
      environment: environmentByConfig[config],
      memoryPolicy: {
        shareAcrossSessions: true,
        checkpoint: "memory_dreaming_sweep may run only when the evaluation driver explicitly requests a checkpoint after a completed turn",
        automaticCheckpoint: false,
        idleWaterlineIsNotEvidenceOfExtraction: true,
      },
      turns,
    },
    oracle: {
      source: { dataset: "ZexueHe/memoryarena", revision: datasetRevision, config, groupId: group.id },
      questions: [...group.questions],
      answers: group.answers,
      ...(Array.isArray(group.backgrounds) ? { backgrounds: group.backgrounds } : {}),
      ...(group.paper_name ? { paperName: group.paper_name } : {}),
      evaluator: config === "bundled_shopping" ? "adapted-shopping-criteria" : "independent-coding-agent-judge",
    },
  };
}

/** Invoke one official local Travel Planner tool. Prefer the MCP server for a persistent process. */
export function runMemoryArenaTravelTool(name, arguments_, options = {}) {
  if (!/^([A-Z][A-Za-z]+)$/.test(name)) throw new TypeError("Invalid MemoryArena tool name");
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new TypeError("tool arguments must be an object");
  return invoke("tool", { name, arguments: arguments_ }, { ...options, maxBuffer: 64 * 1024 * 1024 });
}

/** Run the pinned upstream travel evaluator on official submission-format rows. */
export function evaluateMemoryArenaTravel(submission, options = {}) {
  if (!Array.isArray(submission) || submission.length === 0) throw new TypeError("submission must contain at least one official-format group row");
  const ids = new Set();
  for (const group of submission) {
    if (!Number.isSafeInteger(group?.id) || ids.has(group.id) || !Array.isArray(group.persons)) throw new TypeError("submission groups require unique integer ids and persons arrays");
    ids.add(group.id);
    const people = new Set();
    for (const person of group.persons) {
      if (!Number.isSafeInteger(person?.person_idx) || person.person_idx < 1 || people.has(person.person_idx) || !Array.isArray(person.plan)) {
        throw new TypeError(`group ${group.id} persons need unique 1-based person_idx and array plan`);
      }
      people.add(person.person_idx);
    }
    const sourceGroup = loadMemoryArenaGroup({ config: "group_travel_planner", groupId: group.id, ...options });
    const expected = sourceGroup.questions.length;
    if (people.size !== expected || Array.from({ length: expected }, (_, index) => index + 1).some(index => !people.has(index))) {
      throw new Error(`group ${group.id} must include all ${expected} ordered traveler plans; partial submissions distort the upstream metric denominator`);
    }
  }
  return invoke("evaluate-travel", { submission }, { ...options, maxBuffer: 4 * 1024 * 1024 });
}

/** Run upstream shopping's deterministic no-LLM reward path as a tagged diagnostic. */
export function evaluateMemoryArenaShoppingDiagnostic({ groupId, subtaskIndex, purchasedAsin = null, purchasedPrice = null, ...options } = {}) {
  if (!Number.isSafeInteger(groupId) || groupId < 0 || !Number.isSafeInteger(subtaskIndex) || subtaskIndex < 0) {
    throw new TypeError("groupId and subtaskIndex must be non-negative integers");
  }
  if (purchasedAsin !== null && typeof purchasedAsin !== "string") throw new TypeError("purchasedAsin must be a string or null");
  if (purchasedPrice !== null && typeof purchasedPrice !== "number") throw new TypeError("purchasedPrice must be a number or null");
  return invoke("evaluate-shopping-diagnostic", { groupId, subtaskIndex, purchasedAsin, purchasedPrice }, { ...options, maxBuffer: 4 * 1024 * 1024 });
}

/** MCP stdio launch descriptor; the host's MCP permission flow authorizes actual calls. */
export function memoryArenaMcpServer({ repoRoot, pythonExecutable = DEFAULT_PYTHON, config = "group_travel_planner" } = {}) {
  const root = rootPath(repoRoot);
  if (!MEMORYARENA_CONFIGS.includes(config)) throw new Error(`Unknown MemoryArena config: ${config}`);
  const bridge = realpathSync(BRIDGE);
  const names = {
    group_travel_planner: "memoryarena-travel-environment",
    bundled_shopping: "memoryarena-shopping-environment",
    formal_reasoning_math: "memoryarena-math-coding-sandbox",
    formal_reasoning_phys: "memoryarena-physics-coding-sandbox",
    progressive_search: "memoryarena-local-search-environment",
  };
  const environmentRequirements = ["verified pinned MemoryArena dataset and code revisions"];
  if (config === "group_travel_planner") environmentRequirements.push("Python >= 3.10", "pandas", "numpy", "requests", "verified travel database");
  if (config === "bundled_shopping") environmentRequirements.push("DESKPET_MEMORYARENA_STEP_FILE", "complete pinned WebShop product database", "local WebShopPlus service");
  if (config === "progressive_search") environmentRequirements.push("DESKPET_MEMORYARENA_STEP_FILE", "complete BrowseComp-Plus corpus", "SQLite FTS5 adapted index");
  if (config === "formal_reasoning_math" || config === "formal_reasoning_phys") environmentRequirements.push("Docker daemon", "desk-pet-memoryarena-code:1 sandbox image");
  return {
    command: pythonExecutable,
    args: [bridge, "--action", "mcp-server", "--repo-root", root, "--config", config],
    cwd: root,
    transport: "stdio",
    environmentRequirements,
    server: { name: names[config], upstream: "ZexueHe/MemoryArena", revision: MEMORYARENA_OFFICIAL_REVISION, config },
  };
}

/** Spawn the MCP stdio process for an existing product MCP client. */
export function spawnMemoryArenaMcpServer(options = {}) {
  const config = memoryArenaMcpServer(options);
  const { transport, environmentRequirements, server, ...spawnOptions } = config;
  return spawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
