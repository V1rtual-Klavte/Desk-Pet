import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const LHTB_REVISION = "7ca0cacea9bf6a0694eaad7306bed794eaaaabce";
export const LHTB_SOURCE_URL = "https://github.com/zli12321/LHTB";
export const LHTB_ARCHIVE_SHA256 = "sha256:5280debd26c88f60c324603bf963605e89458980d0cb7177dfd023b91be0c0f3";
// Harbor appends "-phase-<n>" before calling the standard runner, which caps run ids at 48.
const LHTB_RUN_ID = /^[a-z0-9][a-z0-9-]{2,38}$/;
const LHTB_RUN_ID_MESSAGE = "runId must be a safe 3-39 character lowercase identifier so Harbor phase suffixes stay within the 48-character runtime limit";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_ROOT = resolve(MODULE_DIR, ".data/lhtb");

function directory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function filesBelow(path) {
  if (!directory(path)) return [];
  const result = [];
  const visit = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, name.name);
      if (name.isSymbolicLink()) continue;
      if (name.isDirectory()) visit(full);
      else if (name.isFile()) result.push(full);
    }
  };
  visit(path);
  return result;
}

function taskTimeout(toml, section, key) {
  const body = toml.match(new RegExp(`(?:^|\\n)\\s*\\[${section}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\[|$)`))?.[1] ?? "";
  const found = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+(?:\\.\\d+)?)`, "m"));
  return found ? Number(found[1]) : null;
}

function readTask(taskPath, family) {
  const tomlPath = join(taskPath, "task.toml");
  const instructionPath = join(taskPath, "instruction.md");
  if (!existsSync(tomlPath) || !existsSync(instructionPath)) return null;
  const toml = readFileSync(tomlPath, "utf8");
  const dockerImage = toml.match(/^\s*docker_image\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  const id = taskPath.split(/[\\/]/).at(-1);
  const verifierFiles = filesBelow(join(taskPath, "tests"));
  const privateVerifierFiles = verifierFiles.filter((path) => path.includes(`${join(taskPath, "tests")}/private/`) || path.includes(`${join(taskPath, "tests")}/private\\`));
  const verifierEntry = verifierFiles.some((path) => /(?:^|[\\/])test\.(?:sh|bat|ps1|cmd)$/.test(path));
  return {
    id,
    family,
    path: taskPath,
    instructionPath,
    taskTomlPath: tomlPath,
    taskToml: toml,
    taskName: toml.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? id,
    dockerImage,
    agentTimeoutSec: taskTimeout(toml, "agent", "timeout_sec"),
    verifierTimeoutSec: taskTimeout(toml, "verifier", "timeout_sec"),
    continueUntilTimeout: /^\s*continue_until_timeout\s*=\s*true\s*$/m.test(toml),
    verifierAvailable: verifierEntry,
    privateVerifierAvailable: privateVerifierFiles.length > 0,
    verifierFileCount: verifierFiles.length,
    solutionAvailable: filesBelow(join(taskPath, "solution")).some((path) => /(?:^|[\\/])solve\.(?:sh|bat|ps1|cmd)$/.test(path)),
  };
}

function requireLhtbPlatform() {
  if (process.platform === "win32") throw new Error("LHTB is unsupported on Windows: the terminal bridge requires Unix sockets");
}

function lhtbPython(root) {
  const isolated = join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return existsSync(isolated) ? isolated : process.env.PYTHON ?? "python3";
}

export function inspectLhtbInstall({ dataRoot = DEFAULT_DATA_ROOT, pythonPath } = {}) {
  const root = resolve(dataRoot);
  const upstream = join(root, "upstream");
  const harborRoot = join(upstream, "harbor");
  const tasks = listLhtbTasks({ dataRoot: root });
  const blockers = [];
  let verification = null;
  try {
    requireLhtbPlatform();
    // Offline worker re-hashes the fixed archive/tree and resolves the isolated Harbor runner.
    // No dependency installation, network, container calls or cache writes in this action.
    const checked = spawnSync(pythonPath ?? lhtbPython(root), ["-B", join(MODULE_DIR, "lhtb_install.py"), "--action", "verify", "--data-root", root], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true,
    });
    if (checked.error || checked.status !== 0) throw new Error(checked.error?.message ?? checked.stderr?.trim() ?? "Python verification failed");
    verification = JSON.parse(checked.stdout);
    if (verification.ready !== true || verification.revision !== LHTB_REVISION || verification.archiveSha256 !== LHTB_ARCHIVE_SHA256 || verification.runtimeVerified !== true) {
      throw new Error("Offline LHTB verification returned an invalid identity");
    }
  } catch (error) {
    blockers.push(`LHTB installation verification failed: ${error.message}`);
  }
  return {
    ready: blockers.length === 0,
    revision: verification?.revision ?? null,
    expectedRevision: LHTB_REVISION,
    upstream,
    harborRoot,
    taskCount: tasks.length,
    verifierTaskCount: tasks.filter((task) => task.verifierAvailable).length,
    privateVerifierTaskCount: tasks.filter((task) => task.privateVerifierAvailable).length,
    containerImages: {
      prePulledByInstaller: false,
      checked: false,
      taskImageCount: tasks.filter((task) => task.dockerImage).length,
      note: "LHTB source and Harbor readiness does not imply Docker task images are available; images are acquired on demand.",
    },
    harborContinueUntilTimeout: blockers.length === 0 && verification?.harborContinueUntilTimeout === true,
    sourceTreeSha256: blockers.length === 0 ? verification?.sourceTreeSha256 ?? null : null,
    runtimeVerified: blockers.length === 0 && verification?.runtimeVerified === true,
    blockers,
  };
}

function requireTestFile(path, label, repoRoot) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError(label + " is required");
  const absolute = resolve(path);
  const testRoot = resolve(repoRoot, "test");
  const rel = relative(testRoot, absolute);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error(label + " must be inside the repository test tree");
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(label + " must be a regular file");
  return absolute;
}

export function buildLhtbTrialCommand({ taskId, cardPath, authorizationPath, runId, dataRoot = DEFAULT_DATA_ROOT, repoRoot = resolve(MODULE_DIR, "../../../../") } = {}) {
  requireLhtbPlatform();
  if (typeof runId !== "string" || !LHTB_RUN_ID.test(runId)) throw new TypeError(LHTB_RUN_ID_MESSAGE);
  const task = listLhtbTasks({ dataRoot }).find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown LHTB task: " + taskId);
  if (!task.verifierAvailable) throw new Error(taskId + ": official Harbor verifier entrypoint is unavailable");
  const card = requireTestFile(cardPath, "cardPath", repoRoot);
  const authorization = requireTestFile(authorizationPath, "authorizationPath", repoRoot);
  const root = resolve(dataRoot);
  const venvPython = join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const venvHarbor = join(root, "venv", process.platform === "win32" ? "Scripts/harbor.exe" : "bin/harbor");
  if (!existsSync(venvPython) || !existsSync(venvHarbor)) throw new Error("Harbor runtime is not installed in the isolated LHTB venv");
  const outputRoot = join(root, "runs", runId);
  if (existsSync(outputRoot)) throw new Error("LHTB run already exists: " + runId);
  const externalDir = MODULE_DIR;
  const args = ["trial", "start", "--path", task.path, "--agent-import-path", "lhtb_harbor_agent:DeskPetHarborAgent", "--trials-dir", join(outputRoot, "trials"), "--trial-name", runId,
    "--agent-kwarg", "task_id=" + JSON.stringify(taskId), "--agent-kwarg", "card_path=" + JSON.stringify(card), "--agent-kwarg", "authorization_path=" + JSON.stringify(authorization), "--agent-kwarg", "run_id=" + JSON.stringify(runId),
    "--agent-kwarg", "timeout_seconds=" + Math.max(1, Math.floor(task.agentTimeoutSec ?? 5400))];
  const env = { PYTHONPATH: [externalDir, process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"), DESKPET_LHTB_EXPECTED_REVISION: LHTB_REVISION };
  return { task, runId, outputRoot, command: venvHarbor, args, env, repoRoot: resolve(repoRoot), python: venvPython };
}

export async function startLhtbRun(options = {}) {
  if (options.modelCallsAuthorized !== true) throw new Error("Desk-Pet LHTB runs call the configured product model; explicit model-call authorization is required");
  const plan = buildLhtbTrialCommand(options);
  const dataRoot = resolve(options.dataRoot ?? DEFAULT_DATA_ROOT);
  const installation = inspectLhtbInstall({ dataRoot, pythonPath: options.pythonPath });
  if (!installation.ready) throw new Error(installation.blockers.join("; "));
  const image = await ensureLhtbTaskImage({ taskId: plan.task.id, dataRoot, dockerPath: options.dockerPath, pythonPath: options.pythonPath, timeoutMs: options.imagePreflightTimeoutMs });
  if (!image.ready) throw new Error("LHTB image preflight failed before starting a model run: " + image.reason);
  const dockerSetup = ensureLhtbDockerPlugins({ dataRoot });
  mkdirSync(join(dataRoot, "runs"), { recursive: true });
  mkdirSync(plan.outputRoot, { recursive: false });
  const requestPath = join(plan.outputRoot, "request.json");
  const statusPath = join(plan.outputRoot, "status.json");
  const request = { schemaVersion: 1, runId: plan.runId, taskId: plan.task.id, taskPath: plan.task.path, taskName: plan.task.taskName, revision: LHTB_REVISION, command: plan.command, args: plan.args, cwd: plan.repoRoot, env: plan.env, logPath: join(plan.outputRoot, "harbor.log") };
  writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(requestPath, 0o600);
  writeFileSync(statusPath, JSON.stringify({ schemaVersion: 1, runId: plan.runId, taskId: plan.task.id, revision: LHTB_REVISION, status: "starting", startedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  const runner = join(MODULE_DIR, "lhtb_run.py");
  const isolatedHome = join(dataRoot, "home");
  const child = spawn(plan.python, [runner, requestPath], { cwd: plan.repoRoot, detached: true, stdio: "ignore", env: {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    DOCKER_CONFIG: dockerSetup.dockerConfig,
    PYTHONPYCACHEPREFIX: join(dataRoot, "pycache"),
    UV_CACHE_DIR: join(dataRoot, "uv-cache"),
    HARBOR_CACHE_DIR: join(dataRoot, "harbor-cache"),
  }, windowsHide: true });
  child.unref();
  return { runId: plan.runId, statusPath, logPath: join(plan.outputRoot, "harbor.log"), pid: child.pid, taskId: plan.task.id, revision: LHTB_REVISION, image };
}

export function getLhtbRunStatus({ runId, dataRoot = DEFAULT_DATA_ROOT, pythonPath } = {}) {
  if (typeof runId !== "string" || !LHTB_RUN_ID.test(runId)) throw new TypeError(LHTB_RUN_ID_MESSAGE);
  const root = resolve(dataRoot);
  const runRoot = join(root, "runs", runId);
  const statusPath = join(runRoot, "status.json");
  const requestPath = join(runRoot, "request.json");
  if (!existsSync(statusPath)) throw new Error("Unknown LHTB run: " + runId);
  for (const path of [join(root, "runs"), runRoot, statusPath, requestPath]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("LHTB run identity mismatch: symlinked path");
  }
  if (statSync(statusPath).size > 1024 * 1024 || statSync(requestPath).size > 1024 * 1024) throw new Error("LHTB run metadata exceeds its byte limit");
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  let status = JSON.parse(readFileSync(statusPath, "utf8"));
  const checkIdentity = (value) => {
    if (request.runId !== runId || request.revision !== LHTB_REVISION || typeof request.taskId !== "string" || !request.taskId
      || value.runId !== runId || value.revision !== LHTB_REVISION || value.taskId !== request.taskId) throw new Error("LHTB run status identity mismatch");
  };
  checkIdentity(status);
  if (status.status === "completed" || status.status === "failed") {
    // The Python launcher owns the single Harbor result definition, also used for offline status.
    const checked = spawnSync(pythonPath ?? lhtbPython(root), ["-B", join(MODULE_DIR, "lhtb_run.py"), "--status", requestPath], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true,
    });
    if (checked.error || checked.status !== 0) {
      status = { ...status, status: "failed", passed: null, reward: null, rewards: null, trialResults: [], error: "Harbor result verification failed: " + (checked.error?.message ?? checked.stderr?.slice(-2000) ?? "Python worker failed") };
    } else {
      status = JSON.parse(checked.stdout);
      checkIdentity(status);
    }
  }
  const trialResults = status.trialResults ?? [];
  if (!Array.isArray(trialResults) || trialResults.some((result) => result.runId !== runId || result.taskId !== request.taskId || result.taskPath !== request.taskPath
    || result.trialName !== runId || result.resultPath !== join(runRoot, "trials", runId, "result.json"))) throw new Error("LHTB result identity mismatch");
  return { ...status, trialResults, logPath: join(runRoot, "harbor.log"), taskResultCount: trialResults.length };
}

export function listLhtbTasks({ dataRoot = DEFAULT_DATA_ROOT, family = "all" } = {}) {
  const upstream = join(resolve(dataRoot), "upstream");
  const roots = family === "1.0" ? [["1.0", join(upstream, "tasks")]]
    : family === "2.0" ? [["2.0", join(upstream, "tasks-2.0")]]
      : [["1.0", join(upstream, "tasks")], ["2.0", join(upstream, "tasks-2.0")]];
  if (!new Set(["all", "1.0", "2.0"]).has(family)) throw new TypeError("family must be all, 1.0, or 2.0");
  return roots.flatMap(([version, root]) => directory(root)
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readTask(join(root, entry.name), version)).filter(Boolean)
    : []).sort((a, b) => a.id.localeCompare(b.id));
}

export function planLhtbRun({ taskIds, dataRoot = DEFAULT_DATA_ROOT, trials = 1, parallelism = 1, maxWallSeconds = null, checkImages = true, dockerPath = "docker" } = {}) {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new TypeError("taskIds must explicitly name at least one LHTB task");
  }
  if (!Number.isInteger(trials) || trials < 1 || trials > 3) throw new RangeError("trials must be an integer from 1 through 3");
  if (parallelism !== 1) throw new RangeError("LHTB run planning is serialized; parallelism must be 1");
  const known = listLhtbTasks({ dataRoot });
  const byId = new Map(known.map((task) => [task.id, task]));
  const selected = taskIds.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown LHTB task: ${id}`);
    if (!task.verifierAvailable) throw new Error(`${id}: official Harbor verifier entrypoint is unavailable`);
    return task;
  });
  if (new Set(taskIds).size !== taskIds.length) throw new Error("taskIds contains duplicates");
  const imageStates = new Map(selected.map((task) => {
    if (!checkImages) return [task.id, { available: false, checked: false }];
    const status = inspectLhtbTaskImage({ taskId: task.id, dataRoot, dockerPath });
    return [task.id, { ...status, checked: true }];
  }));
  const estimatedTaskSeconds = selected.reduce((sum, task) => sum + (task.agentTimeoutSec ?? 0) + (task.verifierTimeoutSec ?? 0), 0);
  const totalMaxSeconds = estimatedTaskSeconds * trials;
  if (maxWallSeconds !== null && (!Number.isFinite(maxWallSeconds) || maxWallSeconds <= 0 || totalMaxSeconds > maxWallSeconds)) {
    throw new RangeError(`planned worst-case ${totalMaxSeconds}s exceeds maxWallSeconds ${maxWallSeconds}`);
  }
  return {
    dataset: "lhtb",
    revision: LHTB_REVISION,
    taskIds: selected.map((task) => task.id),
    trials,
    parallelism,
    estimatedTaskSeconds,
    totalMaxSeconds,
    productAgent: "Desk-Pet runtime via Harbor BaseAgent import path",
    scoreSource: "pinned LHTB task verifier executed by pinned modified Harbor; no model judge",
    containerImageReadiness: checkImages
      ? `checked selected local images: ${[...imageStates.values()].filter((state) => state.available).length}/${selected.length} available; missing images are fetched only when an explicit run starts`
      : "not checked by planner; selected task images are fetched only when an explicit run starts",
    tasks: selected.map(({ id, family, dockerImage, agentTimeoutSec, verifierTimeoutSec, continueUntilTimeout, verifierAvailable, privateVerifierAvailable }) => {
      const state = imageStates.get(id);
      const dockerfiles = dockerImage ? [] : filesBelow(selected.find((task) => task.id === id).path).filter((path) => /(?:^|[\\/])Dockerfile(?:\.[^\\/]*)?$/.test(path));
      const imageReadiness = !dockerImage ? "build-on-demand" : !checkImages ? "not-checked" : state.available ? "available-locally" : "needs-fetch";
      const imageReason = !dockerImage
        ? dockerfiles.length ? "Harbor must build the task Dockerfile on demand; Docker daemon and build-time network dependencies may be required" : "No pinned docker_image or discoverable Dockerfile"
        : !checkImages ? "Local image was not inspected" : state.available ? null : "Image must be fetched for this task before model execution";
      return { id, family, dockerImage, imageReadiness, imageReason, imageId: state.imageId ?? null, agentTimeoutSec, verifierTimeoutSec, continueUntilTimeout, verifierAvailable, privateVerifierAvailable };
    }),
    requiresExplicitRun: true,
  };
}

export function inspectLhtbTaskImage({ taskId, dataRoot = DEFAULT_DATA_ROOT, dockerPath = "docker" } = {}) {
  const task = listLhtbTasks({ dataRoot }).find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown LHTB task: " + taskId);
  if (!task.dockerImage) return { taskId, image: null, available: false, reason: "task does not declare a Docker image" };
  const dockerConfig = join(resolve(dataRoot), "docker-config");
  mkdirSync(dockerConfig, { recursive: true });
  const inspected = spawnSync(dockerPath, ["image", "inspect", "--format", "{{.Id}}", task.dockerImage], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, DOCKER_CONFIG: dockerConfig },
  });
  const imageId = inspected.status === 0 ? inspected.stdout.trim() : null;
  return {
    taskId,
    image: task.dockerImage,
    available: Boolean(imageId),
    imageId,
    checkedAt: new Date().toISOString(),
    reason: imageId ? null : (inspected.error?.message ?? inspected.stderr?.trim() ?? "image is not present in the active Docker image store"),
  };
}

export async function ensureLhtbTaskImage({ taskId, dataRoot = DEFAULT_DATA_ROOT, dockerPath = "docker", pythonPath = process.env.PYTHON ?? "python3", timeoutMs = 7_200_000 } = {}) {
  const root = resolve(dataRoot);
  const dataBase = resolve(MODULE_DIR, ".data");
  const dataRelative = relative(dataBase, root);
  if (dataRelative === ".." || dataRelative.startsWith("../") || dataRelative.startsWith("..\\") || isAbsolute(dataRelative)) {
    throw new Error("LHTB image cache must remain inside the external module .data directory");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 7_200_000) throw new RangeError("imagePreflightTimeoutMs must be from 10000 through 7200000");
  const task = listLhtbTasks({ dataRoot: root }).find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown LHTB task: " + taskId);
  if (!task.dockerImage) {
    const dockerfiles = filesBelow(task.path).filter((path) => /(?:^|[\\/])Dockerfile(?:\.[^\\/]*)?$/.test(path));
    return {
      ready: false,
      taskId,
      image: null,
      buildRequired: dockerfiles.length > 0,
      reason: dockerfiles.length > 0
        ? "task has no pinned docker_image; Harbor must build its Dockerfile on demand, which requires a working Docker daemon and any build-time network dependencies"
        : "task declares neither a docker_image nor a discoverable Dockerfile",
      dockerfiles,
    };
  }
  const dockerSetup = ensureLhtbDockerPlugins({ dataRoot: root });
  const script = join(MODULE_DIR, "lhtb_image.py");
  const args = [script, "--data-root", root, "--docker-config", dockerSetup.dockerConfig, "--docker", dockerPath, "--task-id", task.id, "--image", task.dockerImage];
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonPath, args, { cwd: resolve(MODULE_DIR, "../../../../"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? rejectPromise(error) : resolvePromise(value); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("LHTB task image preflight exceeded its bounded timeout; inspect .data/lhtb/cache/<image>/crane-pull.log")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill("SIGTERM"); finish(new Error("LHTB image preflight response exceeded 1 MiB")); } });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("LHTB image preflight failed: " + (stderr.trim() || "inspect the selected image cache and crane-pull log")));
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
        if (result.ready !== true || result.taskId !== task.id || result.image !== task.dockerImage) throw new Error("image worker returned an invalid readiness result");
        finish(null, result);
      } catch (error) { finish(error); }
    });
  });
}

export function ensureLhtbDockerPlugins({ dataRoot = DEFAULT_DATA_ROOT, sourceDir = process.env.HOME ? join(process.env.HOME, ".docker/cli-plugins") : null } = {}) {
  if (!sourceDir) throw new Error("Cannot locate the existing Docker CLI plugin directory");
  const dataConfig = join(resolve(dataRoot), "docker-config");
  const pluginDir = join(dataConfig, "cli-plugins");
  mkdirSync(pluginDir, { recursive: true });
  const installed = [];
  for (const plugin of ["docker-compose", "docker-buildx"]) {
    const source = join(sourceDir, plugin);
    if (!existsSync(source)) {
      if (plugin === "docker-compose") throw new Error("Docker Compose plugin is missing from the existing Docker installation");
      continue;
    }
    const target = join(pluginDir, plugin);
    const realSource = realpathSync(source);
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() && realpathSync(target) === realSource) { installed.push(plugin); continue; }
      throw new Error("Refusing to replace an existing isolated Docker plugin path: " + target);
    }
    symlinkSync(realSource, target);
    installed.push(plugin);
  }
  return { dockerConfig: dataConfig, plugins: installed };
}

export async function installLhtb({ dataRoot = DEFAULT_DATA_ROOT, pythonPath = process.env.PYTHON ?? "python3", uvPath, timeoutMs = 1_800_000 } = {}) {
  requireLhtbPlatform();
  const root = resolve(dataRoot);
  const dataBase = resolve(MODULE_DIR, ".data");
  const dataRelative = relative(dataBase, root);
  if (dataRelative === ".." || dataRelative.startsWith("../") || dataRelative.startsWith("..\\") || isAbsolute(dataRelative)) {
    throw new Error("LHTB install path must remain inside the external module .data directory");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 3_600_000) throw new RangeError("timeoutMs must be from 60000 through 3600000");
  const script = join(MODULE_DIR, "lhtb_install.py");
  const args = [script, "--data-root", root, "--revision", LHTB_REVISION, "--source-url", LHTB_SOURCE_URL, "--archive-sha256", LHTB_ARCHIVE_SHA256.slice("sha256:".length), "--archive-bytes", "111233074"];
  if (uvPath) args.push("--uv-path", resolve(uvPath));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  return await new Promise((resolveResult, reject) => {
    const child = spawn(pythonPath, args, { cwd: resolve(MODULE_DIR, "../../../../"), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveResult(value); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("LHTB installation exceeded its bounded timeout; inspect .data/lhtb/install.log")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill("SIGTERM"); finish(new Error("LHTB installer response exceeded 1 MiB")); } });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("LHTB installer exited " + code + (stderr ? ": " + stderr.slice(-2000) : "; inspect .data/lhtb/install.log")));
      try {
        const manifest = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
        if (manifest.revision !== LHTB_REVISION || manifest.archiveSha256 !== LHTB_ARCHIVE_SHA256) throw new Error("installer provenance does not match the pinned LHTB source");
        const docker = ensureLhtbDockerPlugins({ dataRoot: root });
        finish(null, { ...manifest, docker });
      } catch (error) { finish(error); }
    });
  });
}

export function buildLhtbRunRequest({ taskId, instruction, cardPath, authorizationPath, timeoutSeconds, runId = randomUUID(), mcpServer }) {
  for (const [key, value] of Object.entries({ taskId, instruction, cardPath, authorizationPath })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} is required`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new RangeError("timeoutSeconds must be positive");
  if (!mcpServer || mcpServer.transport !== "stdio" || mcpServer.enabled !== true) throw new TypeError("an enabled stdio MCP terminal bridge is required");
  return {
    schemaVersion: 1,
    dataset: "lhtb",
    taskId,
    instruction,
    cardPath: resolve(cardPath),
    authorizationPath: resolve(authorizationPath),
    timeoutSeconds,
    runId,
    mcpServer,
  };
}

export async function invokeDeskPetRuntime({ request, brokerEnv, repoRoot = resolve(MODULE_DIR, "../../../../"), timeoutSeconds = request?.timeoutSeconds } = {}) {
  if (!request || request.schemaVersion !== 1 || request.dataset !== "lhtb") throw new TypeError("invalid LHTB runtime request");
  if (typeof brokerEnv?.DESKPET_LHTB_BROKER_SOCKET !== "string" || typeof brokerEnv?.DESKPET_LHTB_BROKER_TOKEN !== "string") {
    throw new TypeError("a per-call Harbor execution broker is required");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new RangeError("timeoutSeconds must be positive");
  const runtime = join(MODULE_DIR, "environment-turn.mjs");
  if (!existsSync(runtime)) throw new Error("Desk-Pet environment-turn.mjs integration hook is unavailable");
  const node = process.execPath;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(node, [runtime], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...brokerEnv }, windowsHide: true });
    let stdout = ""; let stderr = ""; let settled = false; let stopReason = null; let forceKillTimer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceKillTimer); error ? rejectPromise(error) : resolvePromise(value); };
    const requestStop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 65_000);
    };
    const timer = setTimeout(() => requestStop(`Desk-Pet environment turn exceeded ${timeoutSeconds}s; requesting runner stop`), timeoutSeconds * 1000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (stdout.length + chunk.length > 1024 * 1024) return requestStop("Desk-Pet runtime response exceeded 1 MiB; requesting runner stop");
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (stopReason) return finish(new Error(`${stopReason}; shutdown completed with exit ${code ?? signal}`));
      if (code !== 0) return finish(new Error(`Desk-Pet environment turn failed (${code ?? signal}): ${stderr.slice(-2000)}`));
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1);
        const result = JSON.parse(line);
        if (result.executionComplete !== true) return finish(new Error("Desk-Pet runtime did not complete the LHTB task"));
        finish(null, result);
      } catch (error) { finish(new Error(`Desk-Pet runtime returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function recordLhtbInstallation({ dataRoot = DEFAULT_DATA_ROOT, archiveBytes, sourceTreeSha256, installedAt = new Date().toISOString() } = {}) {
  const root = resolve(dataRoot);
  if (!directory(join(root, "upstream/harbor"))) throw new Error("pinned checkout is not installed");
  const tasks = listLhtbTasks({ dataRoot: root });
  const manifest = {
    schemaVersion: 1,
    sourceUrl: LHTB_SOURCE_URL,
    revision: LHTB_REVISION,
    installedAt,
    archiveBytes: Number.isSafeInteger(archiveBytes) ? archiveBytes : null,
    archiveSha256: LHTB_ARCHIVE_SHA256,
    sourceTreeSha256: typeof sourceTreeSha256 === "string" ? sourceTreeSha256 : null,
    taskCount: tasks.length,
    taskCounts: { "1.0": tasks.filter((task) => task.family === "1.0").length, "2.0": tasks.filter((task) => task.family === "2.0").length },
    verifierTaskCount: tasks.filter((task) => task.verifierAvailable).length,
    privateVerifierTaskCount: tasks.filter((task) => task.privateVerifierAvailable).length,
    harborRevision: LHTB_REVISION,
    installScope: "test/sim/desk-pet-chat/external/.data/lhtb only",
    modelCalls: 0,
  };
  writeFileSync(join(root, "installation.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

