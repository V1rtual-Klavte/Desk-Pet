/** Bounded preparation of caller-supplied public benchmark data. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import catalog from "./catalog.json" with { type: "json" };
import { normalizeBeam, normalizeLhtb } from "./batch-two.mjs";
import { normalizeGaia, normalizeMemoryArenaTravel, normalizeMultiChallenge } from "./batch-one.mjs";
import { EXTERNAL_DATASET_ROOT, resolveExternalOutput } from "./index.mjs";
import { resolveGaiaAssets } from "./assets.mjs";

export const EXTERNAL_SOURCE_CATALOG = Object.freeze(catalog.sources.map((source) => Object.freeze(source)));
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

function sourceId(dataset) {
  const id = String(dataset ?? "").toLowerCase();
  if (!EXTERNAL_SOURCE_CATALOG.some((source) => source.id === id)) throw new Error(`未知外部数据集：${dataset}`);
  return id;
}

export function listExternalSources() {
  return EXTERNAL_SOURCE_CATALOG.map((source) => ({ ...source }));
}

export function getExternalSource(dataset) {
  const id = sourceId(dataset);
  return { ...EXTERNAL_SOURCE_CATALOG.find((source) => source.id === id) };
}

/** Download one explicitly selected public file from a pinned upstream revision. */
export async function downloadPinnedExternalFile({ dataset, url, outputDir, repoRoot = process.cwd(), maxBytes = MAX_FILE_BYTES, expectedSha256 } = {}) {
  const id = sourceId(dataset);
  const source = getExternalSource(id);
  if (id === "gaia" || id === "lhtb") throw new Error(`${id} data cannot be downloaded by this helper (gated or potentially large/private verifier data)`);
  outputDir ??= `${EXTERNAL_DATASET_ROOT}/${id}/raw`;
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("outputDir must be a non-empty directory");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) throw new Error(`maxBytes must be 1..${MAX_FILE_BYTES}`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS upstream files are allowed");
  if (parsed.username || parsed.password) throw new Error("Upstream URLs must not contain credentials");
  const lockedFile = source.files?.find(file => file.url === parsed.href);
  const pinnedRevision = id === "beam" && parsed.hostname === "huggingface.co" ? lockedFile?.revision : source.revision;
  const allowed = id === "beam"
    ? (parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.startsWith(`/mohammadtavakoli78/BEAM/${source.revision}/`)) || (parsed.hostname === "huggingface.co" && Boolean(lockedFile) && Boolean(pinnedRevision))
    : parsed.hostname === "huggingface.co" && parsed.pathname.startsWith(`/datasets/${source.repository}/resolve/${pinnedRevision}/`);
  if (!allowed) throw new Error("Download URL must belong to the catalog repository and its pinned revision");
  const output = validateOutput(repoRoot, outputDir, { allowExisting: true });
  const pinnedSuffix = id === "beam" && parsed.hostname === "raw.githubusercontent.com"
    ? `/${pinnedRevision}/`
    : `/resolve/${pinnedRevision}/`;
  const pinnedIndex = parsed.pathname.indexOf(pinnedSuffix);
  const suffix = decodeURIComponent(parsed.pathname.slice(pinnedIndex + pinnedSuffix.length));
  const segments = suffix.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) throw new Error("Upstream file path contains an unsafe component");
  const filePath = resolveExternalOutput(repoRoot, join(output, ...segments));
  const receiptPath = `${filePath}.source.json`;
  const normalizeHash = value => {
    const hash = String(value).replace(/^sha256:/i, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid expected SHA-256");
    return `sha256:${hash}`;
  };
  const lockedHash = source.files?.find(file => file.url === parsed.href)?.sha256;
  const expected = lockedHash ? normalizeHash(lockedHash) : expectedSha256 ? normalizeHash(expectedSha256) : undefined;
  if (lockedHash && expectedSha256 && expected !== normalizeHash(expectedSha256)) throw new Error("Expected SHA-256 conflicts with the catalog lock");
  if (existsSync(filePath)) {
    assertRegularFile(filePath, maxBytes);
    let receipt;
    if (existsSync(receiptPath)) {
      assertRegularFile(receiptPath, 16 * 1024);
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (receipt.dataset !== id || receipt.url !== parsed.href || receipt.revision !== pinnedRevision) throw new Error("Cached file provenance does not match the pinned source");
    }
    if (!expected && !receipt) throw new Error("Cached file has no SHA-256 lock or source receipt; refusing to trust or overwrite it");
    const bytes = readFileSync(filePath);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (sha256 !== (expected ?? normalizeHash(receipt.sha256)) || (receipt && sha256 !== normalizeHash(receipt.sha256))) throw new Error("Cached file SHA-256 mismatch; refusing to overwrite it");
    return { path: filePath, bytes: bytes.length, sha256, revision: pinnedRevision, url: parsed.href, cached: true };
  }
  if (existsSync(receiptPath)) throw new Error("Cached source receipt exists without its file; refusing to overwrite it");
  let requestUrl = parsed;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(requestUrl, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new Error("Upstream returned an invalid or excessive redirect chain");
    const next = new URL(location, requestUrl);
    await response.body?.cancel();
    const redirectHosts = ["huggingface.co", "cdn-lfs.huggingface.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "raw.githubusercontent.com"];
    if (next.protocol !== "https:" || !redirectHosts.includes(next.hostname)) throw new Error("Upstream redirected outside the trusted dataset download hosts");
    requestUrl = next;
  }
  if (!response.ok) throw new Error(`Upstream download failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`Download exceeds ${maxBytes} byte limit`);
  const chunks = [];
  let received = 0;
  if (!response.body) throw new Error("Upstream response has no body");
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Download exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, received);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (expected && expected !== sha256) throw new Error("Downloaded file SHA-256 does not match expectedSha256");
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  for (let current = parent; current !== dirname(current); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Download output path cannot pass through symlinks");
    if (current === output) break;
  }
  writeFileSync(filePath, bytes, { flag: "wx" });
  writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, dataset: id, url: parsed.href, revision: pinnedRevision, sha256, bytes: bytes.length }, null, 2)}\n`, { flag: "wx" });
  return { path: filePath, bytes: bytes.length, sha256, revision: pinnedRevision, url: parsed.href, cached: false };
}

function assertRegularFile(path, maxBytes = MAX_FILE_BYTES) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`输入必须是常规文件，拒绝符号链接或特殊文件：${path}`);
  if (stat.size > maxBytes) throw new Error(`输入文件超过 ${maxBytes} 字节上限：${path}`);
  return stat;
}

function assertDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`输入必须是常规目录，拒绝符号链接：${path}`);
}

function readBytes(path, budget) {
  const stat = assertRegularFile(path);
  budget.bytes += stat.size;
  if (budget.bytes > MAX_INPUT_BYTES) throw new Error(`输入包超过 ${MAX_INPUT_BYTES} 字节总上限`);
  const bytes = readFileSync(path);
  budget.hash.update(`${relative(budget.root, path).split(sep).join("/")}\0`);
  budget.hash.update(bytes);
  budget.hash.update("\0");
  return bytes;
}

function readText(path, budget) {
  return readBytes(path, budget).toString("utf8");
}

function parseDataFile(path, budget) {
  const raw = readText(path, budget);
  if (path.endsWith(".jsonl")) return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });
  const value = JSON.parse(raw);
  return Array.isArray(value) ? value : [value];
}

function walkDirectories(path, maxDepth = 8) {
  const entries = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    assertDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error(`输入目录不能包含符号链接：${child}`);
      if (stat.isDirectory()) visit(child, depth + 1);
      else if (stat.isFile()) entries.push(child);
      else throw new Error(`输入目录包含特殊文件：${child}`);
    }
  };
  visit(path, 0);
  return entries;
}

function loadBeamDirectory(root, split, budget) {
  const paths = split === "128K" ? ["128K", "100K"] : [split];
  const candidates = paths.flatMap((path) => [join(root, "chats", path), join(root, path)]).concat(root);
  const containsChatPairs = (candidate) => existsSync(candidate)
    && lstatSync(candidate).isDirectory()
    && readdirSync(candidate).some((name) => {
      const chatDir = join(candidate, name);
      return lstatSync(chatDir).isDirectory()
        && existsSync(join(chatDir, "chat.json"))
        && existsSync(join(chatDir, "probing_questions", "probing_questions.json"));
    });
  const splitRoot = candidates.find(containsChatPairs);
  if (!splitRoot) throw new Error(`BEAM 输入目录缺少 chats/${split} 结构`);
  assertDirectory(splitRoot);
  const records = [];
  const upstreamSplit = splitRoot.split(sep).at(-1);
  for (const childName of readdirSync(splitRoot).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
    const chatDir = join(splitRoot, childName);
    if (!lstatSync(chatDir).isDirectory()) continue;
    assertDirectory(chatDir);
    const chatPath = join(chatDir, "chat.json");
    const probingPath = join(chatDir, "probing_questions", "probing_questions.json");
    if (!existsSync(chatPath) || !existsSync(probingPath)) continue;
    const chat = JSON.parse(readText(chatPath, budget));
    const probingQuestions = JSON.parse(readText(probingPath, budget));
    records.push({ id: childName, chat, probingQuestions, upstreamSplit });
  }
  if (!records.length) throw new Error(`BEAM ${splitRoot} 中未找到 chat.json 与 probing_questions.json 配对`);
  return records;
}

function simpleTomlValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.replace(/\s+#.*$/, "").trim().replace(/^"|"$/g, "");
}

function loadLhtbDirectory(root, split, budget) {
  const taskDirs = [];
  const splitRoots = split === "2.0-additions" ? [join(root, "tasks-2.0")] : split === "1.0" ? [join(root, "tasks")] : [join(root, "tasks-2.0"), join(root, "tasks")];
  for (const tasksRoot of splitRoots) {
    if (!existsSync(tasksRoot)) continue;
    assertDirectory(tasksRoot);
    for (const name of readdirSync(tasksRoot).sort()) {
      const directory = join(tasksRoot, name);
      if (lstatSync(directory).isDirectory()) taskDirs.push(directory);
    }
  }
  const records = [];
  for (const directory of taskDirs) {
    const taskTomlPath = join(directory, "task.toml");
    const instructionPath = join(directory, "instruction.md");
    if (!existsSync(taskTomlPath) || !existsSync(instructionPath)) continue;
    const taskToml = readText(taskTomlPath, budget);
    const instruction = readText(instructionPath, budget);
    const files = walkDirectories(directory);
    const verifierPaths = files.filter((path) => /(^|[\\/])tests[\\/]private([\\/]|$)/i.test(relative(directory, path)));
    const solutionPaths = files.filter((path) => /(^|[\\/])solution([\\/]|$)/i.test(relative(directory, path)));
    records.push({
      taskId: directory.split(sep).at(-1),
      upstreamSplit: directory.includes(`${sep}tasks-2.0${sep}`) ? "2.0-additions" : "1.0",
      instruction,
      taskToml,
      category: simpleTomlValue(taskToml, "category") ?? "unknown",
      assets: files.filter((path) => relative(directory, path).split(sep).join("/").startsWith("environment/")).map((path) => relative(directory, path).split(sep).join("/")),
      hiddenVerifierAvailable: verifierPaths.length > 0,
      officialHarnessAvailable: false,
      verifierPaths: verifierPaths.map((path) => relative(directory, path).split(sep).join("/")),
      solutionAvailable: solutionPaths.length > 0,
    });
  }
  if (!records.length) throw new Error(`LHTB 输入目录未找到 task.toml + instruction.md 任务`);
  return records;
}

async function loadRecords(dataset, inputPath, split, budget, limit) {
  const input = resolve(inputPath);
  const stat = lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error("输入路径不能是符号链接");
  if (stat.isDirectory()) {
    if (dataset === "beam") return loadBeamDirectory(input, split, budget);
    if (dataset === "lhtb") return loadLhtbDirectory(input, split, budget);
    throw new Error(`${dataset} 需要 JSON 或 JSONL 本地文件输入`);
  }
  assertRegularFile(input);
  if (input.toLowerCase().endsWith(".parquet")) {
    readBytes(input, budget);
    const { readParquetRecords } = await import("./parquet.mjs");
    return readParquetRecords(input, { maxBytes: MAX_FILE_BYTES, maxRows: 10000, limit });
  }
  return parseDataFile(input, budget);
}

function validateOutput(repoRoot, outputDir, { allowExisting = false } = {}) {
  const output = resolveExternalOutput(repoRoot, outputDir);
  if (existsSync(output)) {
    if (!allowExisting) throw new Error(`输出目录已存在，拒绝覆盖：${output}`);
    assertDirectory(output);
  }
  return output;
}

/**
 * Prepare one dataset from a caller-authorized local JSON/JSONL file or upstream checkout.
 * No network access is performed here. Passing outputDir writes normalized tasks + a manifest
 * beneath the persistent .data directory or explicit test scratch; without it this function is read-only.
 */
export async function prepareExternalSource({ dataset, inputPath, outputDir, repoRoot = process.cwd(), split, revision, limit } = {}) {
  const id = sourceId(dataset);
  if (!inputPath) throw new Error("inputPath is required; gated or large upstream datasets are never fetched implicitly");
  const sourceInfo = getExternalSource(id);
  const resolvedRevision = revision ?? sourceInfo.revision;
  if (!/^[a-f0-9]{40}$/i.test(resolvedRevision)) throw new Error("revision must be a full pinned 40-character commit SHA");
  const selectedSplit = split ?? (id === "beam" ? sourceInfo.defaultAdaptationSplit ?? "100K" : id === "lhtb" ? "2.0" : id === "gaia" ? "validation" : "test");
  const budget = { bytes: 0, root: resolve(inputPath), hash: createHash("sha256") };
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer");
  const records = await loadRecords(id, inputPath, selectedSplit, budget, limit);
  const options = { revision: resolvedRevision, split: selectedSplit };
  let tasks;
  if (id === "beam") tasks = normalizeBeam(records, options);
  else if (id === "lhtb") tasks = normalizeLhtb(records, options);
  else if (id === "gaia") tasks = resolveGaiaAssets(normalizeGaia(records, options), { repoRoot });
  else if (id === "multichallenge") tasks = normalizeMultiChallenge(records, options);
  else if (id === "memoryarena") tasks = normalizeMemoryArenaTravel(records, options);
  const normalizedTaskCount = tasks.length;
  if (limit !== undefined) tasks = tasks.slice(0, limit);
  if (tasks.length > 10000) throw new Error("prepared task count exceeds 10,000 task safety limit");
  const rawSha256 = `sha256:${budget.hash.digest("hex")}`;
  const manifest = {
    schemaVersion: 1,
    dataset: id,
    revision: resolvedRevision,
    repositoryRevision: sourceInfo.revision,
    datasetRevision: sourceInfo.datasetRevision ?? sourceInfo.revision,
    split: selectedSplit,
    upstreamUrl: sourceInfo.url,
    license: sourceInfo.license,
    inputPath: resolve(inputPath),
    inputBytesRead: budget.bytes,
    inputSha256: rawSha256,
    rawSha256,
    revisionVerification: "declared pinned reference; local input bytes hashed but not compared with the upstream revision",
    inputHashScope: "source files read for normalization (metadata and text); referenced binary task assets are path-listed but not read or hashed",
    taskCount: tasks.length,
    recordCount: records.length,
    normalizedTaskCount,
    executionTaskCount: tasks.filter(task => task.readiness.runnable && !task.readiness.blockers.length
      && task.mode !== "environment" && !task.environment.required && !task.assets.length).length,
    sourceSplits: [...new Set(tasks.map((task) => task.source.taskSplit ?? task.source.upstreamSplit ?? selectedSplit))].sort(),
    preparedAt: new Date().toISOString(),
    download: "none",
  };
  let preparedDir;
  if (outputDir) {
    preparedDir = validateOutput(repoRoot, outputDir);
    mkdirSync(preparedDir, { recursive: true });
    writeFileSync(join(preparedDir, "tasks.json"), `${JSON.stringify(tasks)}\n`, { flag: "wx" });
    writeFileSync(join(preparedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  }
  return { tasks, manifest, ...(preparedDir ? { outputDir: preparedDir } : {}) };
}
