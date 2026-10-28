/** Pinned, resumable installation and one-record-at-a-time reading for public BEAM data. */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";

export const BEAM_DATASET_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03";
export const BEAM_10M_REVISION = "b5c972d2132e4b291049c257ee42cb82929be9c0";
export const MULTICHALLENGE_REVISION = "670fd81f270314d0f8f82b34fcfe2187fd28f699";
export const EXTERNAL_DATA_ROOT = "test/sim/desk-pet-chat/external/.data";

const HF = "https://huggingface.co/datasets";
const BEAM_FILES = Object.freeze([
  { source: "beam", revision: BEAM_DATASET_REVISION, path: "data/100K-00000-of-00001.parquet", bytes: 5429768, sha256: "c0519be25907005ba873c927c50877471d550873039d96c041554d0075a78ace", split: "100K", license: "CC-BY-SA-4.0", expectedChats: 20, expectedProbes: 400 },
  { source: "beam", revision: BEAM_DATASET_REVISION, path: "data/500K-00000-of-00001.parquet", bytes: 33956263, sha256: "af05921c979355038e1761b7cde3d2dd713200dd3071b278de0200f6c7f30122", split: "500K", license: "CC-BY-SA-4.0", expectedChats: 35, expectedProbes: 700 },
  { source: "beam", revision: BEAM_DATASET_REVISION, path: "data/1M-00000-of-00001.parquet", bytes: 66156374, sha256: "41b5acbbb55a586b1305514ef9d9fb03365d9b3331b598a1c2dd7603d93ef533", split: "1M", license: "CC-BY-SA-4.0", expectedChats: 35, expectedProbes: 700 },
  { source: "beam-10m", revision: BEAM_10M_REVISION, path: "data/10M-00000-of-00002.parquet", bytes: 153844664, sha256: "31d96fd47ec56221d202e68792f26c00e49467dd4b36ee105c36ebd19ef78ad5", split: "10M", license: "CC-BY-SA-4.0", expectedChats: 5, expectedProbes: 100 },
  { source: "beam-10m", revision: BEAM_10M_REVISION, path: "data/10M-00001-of-00002.parquet", bytes: 189980875, sha256: "a4f13fe25af51d57405ae41008689c31d1421377f3efde56a024b441deb2ee65", split: "10M", license: "CC-BY-SA-4.0", expectedChats: 5, expectedProbes: 100 },
]);
const MULTICHALLENGE_FILES = Object.freeze([
  { source: "multichallenge", revision: MULTICHALLENGE_REVISION, path: "data/test-00000-of-00001.parquet", bytes: 975319, sha256: "2711646aba61f814823297714aaf757e3a1b71c66c501402231de48490650515", split: "test", license: "CC-BY-4.0" },
]);

function datasetRepository(source) {
  if (source === "beam-10m") return "Mohammadta/BEAM-10M";
  if (source === "beam") return "Mohammadta/BEAM";
  return "ScaleAI/MultiChallenge";
}

function pinnedUrl(item) {
  return `${HF}/${datasetRepository(item.source)}/resolve/${item.revision}/${item.path}`;
}

function pinnedSource(item) {
  return { source: item.source, revision: item.revision, split: item.split, upstreamPath: item.path, url: pinnedUrl(item), license: item.license, expectedBytes: item.bytes, expectedSha256: item.sha256 };
}

function rejectInstallSymlinks(repoRoot, path) {
  const root = resolve(repoRoot);
  // Include the leaf, raw root and installer-owned ancestors, including dangling links.
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Install path cannot pass through a symlink");
    if (current === root) break;
  }
}

function safeTarget(repoRoot, dataset, upstreamPath) {
  if (typeof upstreamPath !== "string" || !upstreamPath || upstreamPath.startsWith("/") || upstreamPath.split(/[\\/]/).includes("..")) throw new Error("Invalid upstream path");
  const base = resolve(repoRoot, EXTERNAL_DATA_ROOT, dataset, "raw");
  const target = resolve(base, upstreamPath);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Install target escaped raw data root");
  rejectInstallSymlinks(repoRoot, target);
  return { target };
}

function existingInstallFile(repoRoot, path) {
  rejectInstallSymlinks(repoRoot, path);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new Error(`Existing install path is not a regular file: ${path}`);
  return info;
}

function sourceReceiptComplete(repoRoot, path, expected) {
  if (!existingInstallFile(repoRoot, path)) return false;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Source receipt cannot be read; refusing overwrite: ${path}`, { cause: error });
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`Source receipt is malformed; refusing overwrite: ${path}`);
  for (const [key, value] of Object.entries(receipt)) {
    const claim = key === "sha256" && typeof value === "string" ? value.replace(/^sha256:/, "") : value;
    if (!Object.hasOwn(expected, key) || claim !== expected[key]) throw new Error(`Source receipt differs from the pinned source; refusing overwrite: ${path} (${key})`);
  }
  return Object.keys(expected).every(key => Object.hasOwn(receipt, key));
}

function writeSourceReceipt(repoRoot, path, receipt) {
  sourceReceiptComplete(repoRoot, path, receipt);
  const temp = `${path}.${randomUUID()}.tmp`;
  rejectInstallSymlinks(repoRoot, temp);
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // Recheck the destination before atomic replacement; never follow or remove unknown links/directories.
    sourceReceiptComplete(repoRoot, path, receipt);
    renameSync(temp, path);
  } finally {
    if (existingInstallFile(repoRoot, temp)) rmSync(temp);
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** Parse the Python-literal dict strings published in BEAM Parquet without executing source text. */
export function parseBeamPythonLiteral(source) {
  if (typeof source !== "string") throw new TypeError("BEAM literal must be a string");
  let index = 0;
  const fail = () => { throw new SyntaxError(`Invalid BEAM Python literal at offset ${index}`); };
  const space = () => { while (/\s/.test(source[index] ?? "")) index += 1; };
  const string = () => {
    const quote = source[index++];
    let result = "";
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) return result;
      if (char !== "\\") { result += char; continue; }
      if (index >= source.length) fail();
      const escaped = source[index++];
      const simple = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b" };
      if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; continue; }
      if (escaped === "\n") continue;
      const width = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
      if (!width) fail();
      const hex = source.slice(index, index + width);
      if (hex.length !== width || !/^[\da-f]+$/i.test(hex)) fail();
      result += String.fromCodePoint(Number.parseInt(hex, 16));
      index += width;
    }
    return fail();
  };
  const value = () => {
    space();
    const char = source[index];
    if (char === "'" || char === '"') return string();
    if (char === "[" || char === "(") {
      const close = char === "[" ? "]" : ")";
      index += 1;
      const items = [];
      space();
      while (source[index] !== close) {
        items.push(value());
        space();
        if (source[index] === close) break;
        if (source[index++] !== ",") fail();
        space();
      }
      index += 1;
      return items;
    }
    if (char === "{") {
      index += 1;
      const object = {};
      space();
      while (source[index] !== "}") {
        const key = value();
        if (typeof key !== "string" && typeof key !== "number") fail();
        space();
        if (source[index++] !== ":") fail();
        Object.defineProperty(object, key, { value: value(), enumerable: true, configurable: true, writable: true });
        space();
        if (source[index] === "}") break;
        if (source[index++] !== ",") fail();
        space();
      }
      index += 1;
      return object;
    }
    const rest = source.slice(index);
    for (const [word, literal] of [["True", true], ["False", false], ["None", null]]) {
      if (rest.startsWith(word) && !/[\w]/.test(rest[word.length] ?? "")) { index += word.length; return literal; }
    }
    const number = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (number) { index += number[0].length; return Number(number[0]); }
    return fail();
  };
  const parsed = value();
  space();
  if (index !== source.length) fail();
  return parsed;
}

function allowedDownloadHost(host) {
  return host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf.co" || host.endsWith(".hf.co");
}

async function openPinnedUrl(url, { fetchImpl = globalThis.fetch, signal, headers = {} } = {}) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== "https:" || !allowedDownloadHost(current.hostname)) throw new Error("Dataset URL or redirect is outside Hugging Face hosts");
    const response = await fetchImpl(current, { redirect: "manual", signal, headers: { "accept-encoding": "identity", ...headers } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Dataset redirect is missing Location");
    current = new URL(location, current);
  }
  throw new Error("Dataset download exceeded redirect limit");
}

/** Append a resumed response to an installer-owned partial file and enforce its pinned byte bound. */
export async function streamPinnedResponse(response, partialPath, { offset, totalBytes, dataset, upstreamPath, onProgress } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || offset > totalBytes) throw new RangeError("Invalid pinned response byte range");
  if (offset && response.status === 206) {
    const range = response.headers.get("content-range");
    if (!range || !new RegExp(`^bytes ${offset}-\\d+/${totalBytes}$`).test(range)) throw new Error("Resumed dataset response has an invalid Content-Range");
  } else if (response.status !== 200) {
    throw new Error(`Unexpected HTTP ${response.status} for pinned dataset download`);
  }
  partialPath = resolve(partialPath);
  existingInstallFile(process.cwd(), partialPath);
  const actualOffset = response.status === 206 ? offset : 0;
  if (actualOffset !== offset) rmSync(partialPath, { force: true });
  if (!response.body) throw new Error("Dataset response has no body");
  const stream = createWriteStream(partialPath, { flags: actualOffset ? "a" : "w", mode: 0o600 });
  let received = actualOffset;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > totalBytes) {
        stream.destroy();
        // Windows cannot unlink a file while the write handle is still open.
        await new Promise(resolve => stream.closed ? resolve() : stream.once("close", resolve));
        existingInstallFile(process.cwd(), partialPath);
        rmSync(partialPath, { force: true });
        throw new Error("Dataset response exceeds pinned byte size");
      }
      if (!stream.write(Buffer.from(chunk))) await once(stream, "drain");
      onProgress?.({ dataset, upstreamPath, receivedBytes: received, totalBytes });
    }
    stream.end();
    await once(stream, "close");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (received !== totalBytes) throw new Error(`Incomplete pinned dataset file (${received}/${totalBytes} bytes)`);
  return received;
}

async function downloadOne(repoRoot, dataset, item, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const { target } = safeTarget(repoRoot, dataset, item.path);
  const { target: partial } = safeTarget(repoRoot, dataset, `${item.path}.part`);
  const { target: receiptPath } = safeTarget(repoRoot, dataset, `${item.path}.source.json`);
  // Validate all three leaves before receipt reads, hashing, network access or writes (including mkdir).
  const info = existingInstallFile(repoRoot, target);
  const partialInfo = existingInstallFile(repoRoot, partial);
  const url = pinnedUrl(item);
  const receipt = { schemaVersion: 1, dataset, url, revision: item.revision, upstreamPath: item.path, bytes: item.bytes, sha256: item.sha256 };
  const completeReceipt = sourceReceiptComplete(repoRoot, receiptPath, receipt);
  if (info) {
    if (info.size !== item.bytes || await sha256File(target) !== item.sha256) {
      throw new Error(`Existing pinned dataset file failed integrity check; refusing overwrite: ${target}`);
    }
    if (!completeReceipt) writeSourceReceipt(repoRoot, receiptPath, receipt);
    return { dataset, path: target, upstreamPath: item.path, url, revision: item.revision, bytes: info.size, sha256: item.sha256, cached: true };
  }

  let offset = partialInfo?.size ?? 0;
  if (offset > item.bytes) throw new Error(`Partial download exceeds pinned size; refusing overwrite: ${partial}`);
  mkdirSync(dirname(target), { recursive: true });
  if (offset === item.bytes) {
    if (await sha256File(partial) === item.sha256) {
      existingInstallFile(repoRoot, partial);
      existingInstallFile(repoRoot, target);
      renameSync(partial, target);
      if (!completeReceipt) writeSourceReceipt(repoRoot, receiptPath, receipt);
      return { dataset, path: target, upstreamPath: item.path, url, revision: item.revision, bytes: item.bytes, sha256: item.sha256, cached: false };
    }
    existingInstallFile(repoRoot, partial);
    rmSync(partial, { force: true });
    offset = 0;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Pinned dataset download timed out")), 120_000);
  try {
    const headers = offset ? { range: `bytes=${offset}-` } : {};
    const response = await openPinnedUrl(url, { fetchImpl, signal: controller.signal, headers });
    await streamPinnedResponse(response, partial, { offset, totalBytes: item.bytes, dataset, upstreamPath: item.path, onProgress });
    const actualHash = await sha256File(partial);
    existingInstallFile(repoRoot, partial);
    if (actualHash !== item.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`Pinned dataset SHA-256 mismatch for ${item.path}`);
    }
    existingInstallFile(repoRoot, target);
    renameSync(partial, target);
    if (!completeReceipt) writeSourceReceipt(repoRoot, receiptPath, receipt);
    return { dataset, path: target, upstreamPath: item.path, url, revision: item.revision, bytes: item.bytes, sha256: item.sha256, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

function manifestPath(repoRoot, dataset) {
  return resolve(repoRoot, EXTERNAL_DATA_ROOT, dataset, "install-manifest.json");
}

function writeManifest(repoRoot, dataset, manifest) {
  const path = manifestPath(repoRoot, dataset);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

async function install(dataset, files, { repoRoot = process.cwd(), fetchImpl, onProgress } = {}) {
  const installed = [];
  for (const item of files) installed.push(await downloadOne(repoRoot, dataset, item, { fetchImpl, onProgress }));
  if (installed.every(file => file.cached) && (await verifyPublicDatasetInstall(dataset, { repoRoot })).ready) {
    // Reuse only a fully verified manifest; complete caches need neither rewrites nor Parquet decoding.
    const path = manifestPath(repoRoot, dataset);
    existingInstallFile(repoRoot, path);
    return { ...JSON.parse(readFileSync(path, "utf8")), files: installed, cached: true };
  }
  const result = {
    schemaVersion: 1,
    dataset,
    status: "complete",
    sourceManifest: files.map(pinnedSource),
    files: installed,
    totalBytes: installed.reduce((sum, file) => sum + file.bytes, 0),
    cached: installed.every(file => file.cached),
  };
  if (dataset === "beam") {
    result.expected = { chats: 100, probes: 2000, bySplit: Object.fromEntries(["100K", "500K", "1M", "10M"].map(split => [split, { chats: 0, probes: 0 }])) };
    for (const item of files) {
      result.expected.bySplit[item.split].chats += item.expectedChats;
      result.expected.bySplit[item.split].probes += item.expectedProbes;
    }
    const counts = await countBeam(repoRoot, installed);
    result.actual = counts;
    result.completeCounts = counts.chats === result.expected.chats && counts.probes === result.expected.probes && Object.entries(result.expected.bySplit).every(([split, expected]) => counts.bySplit[split]?.chats === expected.chats && counts.bySplit[split]?.probes === expected.probes);
    if (!result.completeCounts) throw new Error(`BEAM full dataset count mismatch: expected ${JSON.stringify(result.expected)}, got ${JSON.stringify(counts)}`);
  } else {
    const path = installed[0].path;
    const file = await asyncBufferFromFile(path);
    const metadata = await parquetMetadataAsync(file);
    result.expected = { chats: 266, probes: 266 };
    const actualRows = Number(metadata.num_rows);
    result.actual = { chats: actualRows, probes: actualRows };
    result.completeCounts = result.actual.chats === result.expected.chats && result.actual.probes === result.expected.probes;
    if (!result.completeCounts) throw new Error(`MultiChallenge row count mismatch (${result.actual.chats})`);
  }
  writeManifest(repoRoot, dataset, result);
  return result;
}

async function countBeam(repoRoot, installed) {
  const counts = { chats: 0, probes: 0, bySplit: {} };
  for await (const row of iterateInstalledBeam({ repoRoot, files: installed })) {
    const split = row.upstreamSplit;
    const probes = Object.values(row.probingQuestions).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
    counts.chats += 1;
    counts.probes += probes;
    counts.bySplit[split] ??= { chats: 0, probes: 0 };
    counts.bySplit[split].chats += 1;
    counts.bySplit[split].probes += probes;
  }
  return counts;
}

function rowsForBeamFile(file) {
  return BEAM_FILES.find(item => item.path === file.upstreamPath && item.revision === file.revision);
}

/** Yield one source conversation at a time; no full-shard decode or history×probe copying. */
export async function* iterateInstalledBeam({ repoRoot = process.cwd(), files } = {}) {
  const selected = files ?? BEAM_FILES.map(item => {
    const { target } = safeTarget(repoRoot, "beam", item.path);
    return { path: target, upstreamPath: item.path, revision: item.revision, sha256: item.sha256, bytes: item.bytes };
  });
  for (const installed of selected) {
    const item = rowsForBeamFile(installed);
    if (!item) throw new Error(`Unknown pinned BEAM shard: ${installed.upstreamPath}`);
    if (!existsSync(installed.path) || statSync(installed.path).size !== item.bytes || await sha256File(installed.path) !== item.sha256) throw new Error(`Installed BEAM shard failed integrity check: ${installed.path}`);
    const file = await asyncBufferFromFile(installed.path);
    const metadata = await parquetMetadataAsync(file);
    const rows = Number(metadata.num_rows);
    if (!Number.isSafeInteger(rows) || rows !== item.expectedChats) throw new Error(`Unexpected BEAM row count in ${item.path}`);
    let recordIndex = 0;
    for await (const record of iterateBeamRowsOneAtATime(file, rows)) {
      if (!record || typeof record !== "object") throw new Error(`Invalid BEAM record ${recordIndex} in ${item.path}`);
      const chat = record.chat;
      let probingQuestions = record.probing_questions;
      if (typeof probingQuestions === "string") probingQuestions = parseBeamPythonLiteral(probingQuestions);
      if (!Array.isArray(chat) || !probingQuestions || typeof probingQuestions !== "object" || Array.isArray(probingQuestions)) throw new Error(`BEAM row ${recordIndex} has unsupported chat/probe structure`);
      yield {
        chatId: String(record.conversation_id ?? `${item.split}-${recordIndex + 1}`),
        chat,
        probingQuestions,
        upstreamSplit: item.split,
        upstreamDataset: item.source === "beam-10m" ? "Mohammadta/BEAM-10M" : "Mohammadta/BEAM",
        upstreamRevision: item.revision,
        sourceUrl: `${HF}/${datasetRepository(item.source)}`,
      };
      recordIndex += 1;
    }
  }
}

/** Decode one Parquet row per call so long histories are never materialized as a whole shard. */
export async function* iterateBeamRowsOneAtATime(file, rowCount, { readRows = parquetReadObjects } = {}) {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new RangeError("rowCount must be a non-negative safe integer");
  for (let index = 0; index < rowCount; index += 1) {
    const rows = await readRows({ file, rowStart: index, rowEnd: index + 1 });
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`Parquet reader did not return exactly one row at index ${index}`);
    yield rows[0];
  }
}

export async function installBeam(options = {}) {
  return install("beam", BEAM_FILES, options);
}

export async function installMultiChallenge(options = {}) {
  return install("multichallenge", MULTICHALLENGE_FILES, options);
}

export async function installPublicDataset(dataset, options = {}) {
  if (dataset === "beam") return installBeam(options);
  if (dataset === "multichallenge") return installMultiChallenge(options);
  throw new Error(`Unsupported full public dataset install: ${dataset}`);
}

/** Offline, read-only verification against the full pinned set, never the manifest's claimed subset. */
export async function verifyPublicDatasetInstall(dataset, { repoRoot = process.cwd() } = {}) {
  if (!Object.hasOwn(PUBLIC_INSTALL_FILES, dataset)) throw new Error(`Unsupported full public dataset install: ${dataset}`);
  const pins = PUBLIC_INSTALL_FILES[dataset];
  const path = manifestPath(repoRoot, dataset);
  try {
    rejectInstallSymlinks(repoRoot, path);
    if (!existsSync(path)) return { ready: false, reason: "not-installed" };
    if (!lstatSync(path).isFile()) throw new Error("Install manifest is not a regular file");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest?.schemaVersion !== 1 || manifest.dataset !== dataset || manifest.status !== "complete" || manifest.completeCounts !== true
      || !Array.isArray(manifest.files) || manifest.files.length !== pins.length
      || !Array.isArray(manifest.sourceManifest) || manifest.sourceManifest.length !== pins.length) {
      throw new Error("Install manifest does not contain the complete pinned file set");
    }
    const filesByPath = new Map(manifest.files.map(item => [item.upstreamPath, item]));
    const sourcesByPath = new Map(manifest.sourceManifest.map(item => [item.upstreamPath, item]));
    if (filesByPath.size !== pins.length || sourcesByPath.size !== pins.length) throw new Error("Install manifest contains duplicate shards");
    let totalBytes = 0;
    for (const pin of pins) {
      const { target } = safeTarget(repoRoot, dataset, pin.path);
      const { target: receiptPath } = safeTarget(repoRoot, dataset, `${pin.path}.source.json`);
      const file = filesByPath.get(pin.path);
      const source = sourcesByPath.get(pin.path);
      const url = pinnedUrl(pin);
      if (!file || file.dataset !== dataset || file.path !== target || file.revision !== pin.revision
        || file.url !== url || file.bytes !== pin.bytes || file.sha256 !== pin.sha256
        || !source || Object.entries(pinnedSource(pin)).some(([key, value]) => source[key] !== value)) {
        throw new Error(`Install manifest differs from the pinned source: ${pin.path}`);
      }
      // Paths are derived only from pins; untrusted manifest paths are compared, never opened.
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== pin.bytes || await sha256File(target) !== pin.sha256) {
        throw new Error(`Pinned dataset file failed integrity check: ${pin.path}`);
      }
      if (!lstatSync(receiptPath).isFile()) throw new Error(`Source receipt is not a regular file: ${pin.path}`);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const receiptHash = typeof receipt?.sha256 === "string" ? receipt.sha256.replace(/^sha256:/, "") : null;
      if (receipt?.schemaVersion !== 1 || receipt.dataset !== dataset || receipt.upstreamPath !== pin.path
        || receipt.revision !== pin.revision || receipt.url !== url || receipt.bytes !== pin.bytes || receiptHash !== pin.sha256) {
        throw new Error(`Source receipt differs from the pinned source: ${pin.path}`);
      }
      totalBytes += info.size;
    }
    if (totalBytes !== manifest.totalBytes) throw new Error("Install manifest total bytes differ from the pinned set");
    // Pinned hashes establish dataset content without decoding large Parquet shards during status.
    return { ready: true, totalBytes, actual: manifest.actual };
  } catch (error) {
    // The inspection result is the diagnostic exit; verification never repairs or overwrites caches.
    return { ready: false, reason: "incomplete-install", error: error.message };
  }
}

export const PUBLIC_INSTALL_FILES = Object.freeze({ beam: BEAM_FILES, multichallenge: MULTICHALLENGE_FILES });
