#!/usr/bin/env node
/** Official environment adapters delegate execution to the existing isolated native product runner. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExternalCase, EXTERNAL_DATASET_ROOT, resolveExternalOutput } from "./index.mjs";
import { getExternalSource } from "./prepare.mjs";
import { escapeDriverText, hashCanonical, validateCaseSpec, validateCaseAgainstFixture } from "../dataset.mjs";
import { parseCardMeta, validateRunId } from "../../../../scripts/sim-eval-run.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const BROKER_ENV_KEYS = new Set(["DESKPET_LHTB_BROKER_SOCKET", "DESKPET_LHTB_BROKER_TOKEN"]);

/** Build one ordered, multi-session case. Oracle fields never enter the driver package. */
export function buildEnvironmentCase(request, { card, clock = "2026-01-01T00:00:00.000Z" } = {}) {
  if (!["lhtb", "memoryarena"].includes(request.dataset)) throw new Error("Unknown external environment");
  const source = getExternalSource(request.dataset);
  const turns = request.turns ?? [{ sessionId: "task", userMessage: request.instruction }];
  if (!Array.isArray(turns) || !turns.length || turns.some(turn => typeof turn.userMessage !== "string" || !turn.userMessage.trim())) throw new Error("Environment requires non-empty ordered turns");
  const task = {
    schemaVersion: 1, dataset: request.dataset, id: String(request.taskId), revision: source.revision,
    split: request.split ?? "environment", mode: "task", title: `${request.dataset} ${request.taskId}`,
    categories: ["chat", "tools"], questionTypes: ["execution"], difficulty: 5,
    history: [], turns: [{ id: "task", prompt: turns[0].userMessage }],
    oracle: { referenceAnswers: [], criteria: ["Actual environment results must satisfy its frozen task evaluator; an assistant completion claim is insufficient."] },
    assets: [], environment: { required: false }, readiness: { runnable: true, blockers: [] },
    adaptationNotes: ["Executed against the installed official environment through its MCP bridge; environment grading remains external to the chat driver."],
    source: { url: source.url, license: source.license },
  };
  const entry = buildExternalCase(task, { card, clock });
  const spec = entry.case;
  spec.precondition.toolApproval = "allow-once";
  spec.driver = [];
  spec.checkpoints = [];
  spec.evidence = [];
  spec.probes = [];
  const base = Date.parse(clock);
  let ordinal = 1;
  const at = () => new Date(base + ordinal++).toISOString();
  turns.forEach((turn, index) => {
    if (index && request.extractMemory === true) {
      const id = `memory-${index}`;
      spec.driver.push({ id, kind: "host", method: "memory_dreaming_sweep", args: {}, at: at() });
      spec.checkpoints.push({ id: `${id}-done`, after: id, wait: "memory_extraction_end" });
    }
    if (index || turn.environmentStep) {
      const id = `session-${index + 1}`;
      spec.driver.push({ id, kind: "host", method: "chat_new_session", args: { title: String(turn.sessionId ?? id), ...(turn.environmentStep ? { externalEnvironmentStep: turn.environmentStep } : {}) }, at: at() });
      spec.checkpoints.push({ id: `${id}-created`, after: id, wait: "session_created" });
    }
    const id = `target-${index + 1}`;
    const evidenceId = `answer-${index + 1}`;
    spec.driver.push({ id, kind: "message", text: escapeDriverText(turn.userMessage), at: at() });
    spec.checkpoints.push({ id: `${id}-done`, after: id, wait: "assistant_message" });
    spec.evidence.push({ id: evidenceId, kind: "session_entry", source: id, description: "Actual product response in this subtask session" });
    const expectation = request.expectations?.[index] ?? { referenceAnswers: [], criteria: ["Results are evaluated against the corresponding installed environment and its frozen task specification."] };
    spec.probes.push({ id: `result-${index + 1}`, after: id, window: "last-assistant", rubric: "external.expected-result", questionType: "execution", polarity: "required", critical: true, difficulty: 5, description: "Complete this ordered subtask using evidence from its actual environment.", expectation, evidence: [evidenceId] });
  });
  spec.pathConstraints.requiredOrder = spec.driver.map(step => step.id);
  spec.pathConstraints.allowedToolSubstitutions = ["Installed environment tools exposed through the configured MCP server"];
  validateCaseSpec(spec);
  validateCaseAgainstFixture(spec, entry.fixture);
  return entry;
}

function write(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

function command(args, { repoRoot, env, logPath }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts/sim-eval-run.mjs"), ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { if (bytes < 2 * 1024 * 1024) { chunks.push(chunk); bytes += chunk.length; } });
    child.once("error", reject);
    child.once("exit", code => {
      writeFileSync(logPath, Buffer.concat(chunks));
      resolveResult({ code, logPath });
    });
  });
}

/** JSONL subprocess hook. It launches no provider client and never generates judge verdicts. */
export async function runEnvironmentTurn(request, { repoRoot = REPO_ROOT } = {}) {
  if (typeof request.cardPath !== "string" || !existsSync(request.cardPath)) throw new Error("An explicit existing Card file is required");
  const meta = parseCardMeta(readFileSync(request.cardPath, "utf8"));
  if (!meta.name) throw new Error("Card name is missing");
  if (!request.taskId) throw new Error("taskId is required");
  const runId = validateRunId(request.runId ?? `env-${request.dataset}-${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const root = resolveExternalOutput(repoRoot, join(EXTERNAL_DATASET_ROOT, request.dataset, "runs", runId));
  if (existsSync(root)) throw new Error("Environment request already has a run directory; refusing to replay it");
  const entry = buildEnvironmentCase(request, { card: meta.name, ...(request.clock ? { clock: request.clock } : {}) });
  const suite = join(root, "dataset", "suites", request.dataset);
  for (const dir of ["cases", "fixtures", "approvals"]) mkdirSync(join(suite, dir), { recursive: true });
  write(join(suite, "cases", `${entry.case.caseId}.case.json`), entry.case);
  write(join(suite, "fixtures", `${entry.fixture.fixtureId}.json`), entry.fixture);
  write(join(suite, "suite.json"), { schemaVersion: 4, suiteId: request.dataset, revision: 1, purpose: "development", title: "Installed external environment", caseIds: [entry.case.caseId] });
  const plan = { runId, caseId: entry.case.caseId, datasetRoot: join(root, "dataset"), sourceHash: hashCanonical({ case: entry.case, fixture: entry.fixture }) };
  write(join(root, "plan.json"), plan);
  if (request.planOnly === true) return { ...plan, executionComplete: false, prepared: true };
  if (typeof request.authorizationPath !== "string" || !existsSync(request.authorizationPath)) throw new Error("An explicit run authorization file is required");
  const env = { ...process.env };
  for (const [key, value] of Object.entries(request.brokerEnv ?? {})) {
    if (!BROKER_ENV_KEYS.has(key) || typeof value !== "string" || !value) throw new Error("Unsupported broker environment field");
    env[key] = value;
  }
  let mcpPath;
  if (request.mcpServer) {
    if (Object.keys(request.mcpServer.env ?? {}).some(key => BROKER_ENV_KEYS.has(key))) throw new Error("Transient broker values must not appear in the frozen MCP declaration");
    mcpPath = join(root, "mcp-server.json");
    write(mcpPath, request.mcpServer);
  }
  const prepareArgs = ["prepare", "--case", plan.caseId, "--dataset-root", plan.datasetRoot, "--card", request.cardPath, "--authorization", request.authorizationPath, "--run-id", runId];
  if (mcpPath) prepareArgs.push("--mcp-server", mcpPath);
  if (request.modelSettingsPath) prepareArgs.push("--model-settings", request.modelSettingsPath);
  const invoke = (action, args = []) => command([action, ...args], { repoRoot, env, logPath: join(root, `${action}.log`) });
  const prepared = await command(prepareArgs, { repoRoot, env, logPath: join(root, "prepare.log") });
  if (prepared.code !== 0) throw new Error(`Isolated prepare failed; see ${prepared.logPath}`);
  let started = false;
  let driven = false;
  const issues = [];
  let interrupted = false;
  const requestStop = () => {
    interrupted = true;
    const stopPath = join(repoRoot, "test/.tmp", `sim-eval-${runId}`, "stop.request");
    if (!existsSync(stopPath)) writeFileSync(stopPath, `${JSON.stringify({ at: new Date().toISOString(), reason: "External environment parent requested cancellation" })}\n`, { flag: "wx" });
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  try {
    const start = await invoke("start", ["--run-id", runId]);
    if (start.code !== 0) throw new Error(`Native host start failed; see ${start.logPath}`);
    started = true;
    if (interrupted) throw new Error("Environment run cancelled during startup");
    const drive = await invoke("drive", ["--run-id", runId]);
    driven = drive.code === 0;
    const finish = await invoke("finish", ["--run-id", runId, ...(driven ? [] : ["--interrupted", "--reason", "Environment drive did not complete"])]);
    if (finish.code !== 0) issues.push(`finish failed: ${finish.logPath}`);
  } finally {
    if (started) {
      const stopped = await invoke("stop", ["--run-id", runId]);
      if (stopped.code !== 0) issues.push(`stop failed: ${stopped.logPath}`);
    }
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
  }
  const state = JSON.parse(readFileSync(join(repoRoot, "test/.tmp", `sim-eval-${runId}`, "runner.json"), "utf8"));
  const evidenceRoot = state.chat?.attemptDir ? resolve(repoRoot, state.chat.attemptDir) : null;
  const dialoguePath = evidenceRoot && join(evidenceRoot, "dialogue.jsonl");
  const messages = dialoguePath && existsSync(dialoguePath) ? readFileSync(dialoguePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  const answers = messages.filter(message => message.role === "assistant").map(message => ({ sessionId: message.sessionId, text: message.text }));
  const result = { ...plan, executionComplete: driven && !interrupted && issues.length === 0, answer: answers.at(-1)?.text ?? "", answers, evidenceRoot, issues, grader: "external-environment; no verdict generated by this hook" };
  write(join(root, "execution.json"), result);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 20 * 1024 * 1024) throw new Error("Environment request exceeds its byte limit"); }
    const result = await runEnvironmentTurn(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ executionComplete: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
