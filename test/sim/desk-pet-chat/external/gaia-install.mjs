/** Authorized local installation of the pinned 2023 GAIA public task files. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readParquetRecords } from "./parquet.mjs";

export const GAIA_REVISION = "682dd723ee1e1697e00360edccf2366dc8418dd9";
export const GAIA_REPOSITORY = "gaia-benchmark/GAIA";
export const GAIA_DATA_ROOT = "test/sim/desk-pet-chat/external/.data/gaia";
export const GAIA_EXPECTED_QUESTIONS = Object.freeze({ validation: 165, test: 301 });

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function runPythonDownloader({ pythonExecutable, repoRoot, onProgress }) {
  const script = new URL("./gaia-download.py", import.meta.url);
  const child = spawn(pythonExecutable, [script.pathname, "--repo-root", repoRoot, "--revision", GAIA_REVISION], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  let stdout = "";
  let stderrTail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8");
  const lines = createInterface({ input: child.stderr });
  let failureType = null;
  lines.on("line", line => {
    try {
      const event = JSON.parse(line);
      if (event.event === "error") failureType = event.type;
      if (event.event === "file-start" || event.event === "file-progress" || event.event === "listing-start" || event.event === "install-files-complete") onProgress?.(event);
    } catch {
      stderrTail = `${stderrTail}\n${line}`.slice(-500);
    }
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", error => reject(new Error(`Could not start the Python GAIA downloader (${error.code ?? "spawn error"})`)));
    child.once("close", code => {
      if (code !== 0) {
        const detail = failureType ? ` (${failureType})` : stderrTail ? " (see Python environment diagnostics)" : "";
        reject(new Error(`Authorized GAIA downloader failed${detail}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new Error("Authorized GAIA downloader returned an invalid installation manifest"));
      }
    });
  });
}

async function countRecords(repoRoot, split, files) {
  const relativePath = `2023/${split}/metadata.parquet`;
  const installed = files.find(item => item.path === relativePath);
  if (!installed) throw new Error(`GAIA source manifest lacks ${relativePath}`);
  const file = resolve(repoRoot, GAIA_DATA_ROOT, "raw", relativePath);
  const rows = await readParquetRecords(file);
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  let answerRows = 0;
  let uniqueAnswerCount = 0;
  const uniqueAnswers = new Set();
  const knownPlaceholderCounts = {};
  let attachmentRows = 0;
  const referencedAssets = new Set();
  for (const row of rows) {
    if (typeof row["Final answer"] === "string") {
      const answer = row["Final answer"].trim();
      if (answer === "?") knownPlaceholderCounts["?"] = (knownPlaceholderCounts["?"] ?? 0) + 1;
      else if (answer) {
        answerRows += 1;
        uniqueAnswers.add(answer);
      }
    }
    const level = Number(row.Level);
    if (Object.hasOwn(byLevel, level)) byLevel[level] += 1;
    const asset = typeof row.file_path === "string" && row.file_path.trim()
      ? row.file_path.trim()
      : typeof row.file_name === "string" && row.file_name.trim()
        ? row.file_name.trim()
        : null;
    if (asset) {
      attachmentRows += 1;
      referencedAssets.add(asset.startsWith("2023/") ? asset : `2023/${split}/${asset}`);
    }
  }
  const installedPaths = new Set(files.map(item => item.path));
  return {
    records: rows.length,
    byLevel,
    rowsWithReferenceAnswer: answerRows,
    uniqueReferenceAnswerCount: uniqueAnswers.size,
    knownPlaceholderCounts,
    rowsWithAttachment: attachmentRows,
    uniqueReferencedAssets: referencedAssets.size,
    missingReferencedAssets: [...referencedAssets].filter(path => !installedPaths.has(path)),
  };
}

/**
 * Fetches only after explicit invocation. The HF token is read by the Python child process from
 * huggingface_hub.get_token(); it is neither passed on argv nor returned, logged, or persisted.
 */
export async function installGaia({ repoRoot = process.cwd(), pythonExecutable = "python3", onProgress } = {}) {
  const root = resolve(repoRoot);
  const dataRoot = resolve(root, GAIA_DATA_ROOT);
  mkdirSync(dataRoot, { recursive: true });
  const downloaded = await runPythonDownloader({ pythonExecutable, repoRoot: root, onProgress });
  if (downloaded.sourceManifest.revision !== GAIA_REVISION || downloaded.sourceManifest.repository !== GAIA_REPOSITORY) {
    throw new Error("GAIA downloader returned an unpinned source manifest");
  }
  const actualQuestions = {};
  for (const split of ["validation", "test"]) actualQuestions[split] = await countRecords(root, split, downloaded.files);
  const expected = {
    questions: GAIA_EXPECTED_QUESTIONS,
    files: { validation: 39, test: 72, total: 111 },
    validationUniqueReferenceAnswers: 143,
    testReferenceAnswerPlaceholders: { "?": 301 },
  };
  const actualFileCounts = {
    validation: downloaded.files.filter(item => item.split === "validation").length,
    test: downloaded.files.filter(item => item.split === "test").length,
    total: downloaded.files.length,
  };
  const completeCounts = actualFileCounts.total === expected.files.total
    && actualFileCounts.validation === expected.files.validation
    && actualFileCounts.test === expected.files.test
    && actualQuestions.validation.records === expected.questions.validation
    && actualQuestions.test.records === expected.questions.test
    && actualQuestions.validation.uniqueReferenceAnswerCount === expected.validationUniqueReferenceAnswers
    && actualQuestions.test.rowsWithReferenceAnswer === 0
    && JSON.stringify(actualQuestions.test.knownPlaceholderCounts) === JSON.stringify(expected.testReferenceAnswerPlaceholders)
    && Object.values(actualQuestions).every(summary => summary.missingReferencedAssets.length === 0);
  const sourceManifest = {
    ...downloaded.sourceManifest,
    counts: { ...downloaded.sourceManifest.counts, expectedQuestions: expected.questions, actualQuestions, expectedFiles: expected.files, actualFiles: actualFileCounts },
  };
  const result = {
    schemaVersion: 1,
    dataset: "gaia",
    status: completeCounts ? "complete" : "verification-failed",
    authorizedLocalAccess: true,
    personalIdentityRecorded: false,
    revision: GAIA_REVISION,
    devAlias: "validation",
    sourceManifest,
    files: downloaded.files,
    totalBytes: downloaded.files.reduce((sum, item) => sum + item.bytes, 0),
    cached: downloaded.files.every(item => item.cached),
    expected,
    actual: { files: actualFileCounts, questions: actualQuestions },
    completeCounts,
    adaptationBoundary: "validation questions include upstream answers; test tasks retain only actual upstream fields and never receive fabricated answers",
  };
  writeAtomic(join(dataRoot, "install-manifest.json"), result);
  writeAtomic(join(dataRoot, "source-manifest.json"), sourceManifest);
  if (!completeCounts) throw new Error(`GAIA installed data count or attachment check failed (${JSON.stringify({ actualFileCounts, actualQuestions })})`);
  return result;
}

export async function verifyGaiaInstall({ repoRoot = process.cwd() } = {}) {
  const dataRoot = resolve(repoRoot, GAIA_DATA_ROOT);
  const installPath = join(dataRoot, "install-manifest.json");
  if (!existsSync(installPath)) return { ready: false, reason: "not-installed" };
  try {
    const manifest = JSON.parse(readFileSync(installPath, "utf8"));
    const sourceManifestPath = join(dataRoot, "source-manifest.json");
    if (!existsSync(sourceManifestPath)) return { ready: false, reason: "incomplete-install" };
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    if (JSON.stringify(sourceManifest) !== JSON.stringify(manifest.sourceManifest)) return { ready: false, reason: "incomplete-install" };
    if (manifest.revision !== GAIA_REVISION || manifest.status !== "complete" || !manifest.completeCounts
      || sourceManifest.revision !== GAIA_REVISION || sourceManifest.repository !== GAIA_REPOSITORY
      || !Array.isArray(manifest.files) || !Array.isArray(sourceManifest.files)
      || manifest.files.length !== 111 || sourceManifest.files.length !== manifest.files.length) {
      return { ready: false, reason: "incomplete-install" };
    }
    const sourceByPath = new Map(sourceManifest.files.map(item => [item.path, item]));
    const seen = new Set();
    let totalBytes = 0;
    const rawRoot = resolve(dataRoot, "raw");
    const canonicalRawRoot = realpathSync(rawRoot);
    for (const item of manifest.files) {
      if (typeof item.path !== "string" || item.path.startsWith("/") || item.path.split(/[\\/]/).includes("..")
        || seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || !/^[a-f0-9]{64}$/.test(item.sha256)) return { ready: false, reason: "incomplete-install" };
      seen.add(item.path);
      const source = sourceByPath.get(item.path);
      if (!source || source.bytes !== item.bytes || source.split !== item.split || typeof source.sourceSha !== "string") {
        return { ready: false, reason: "incomplete-install" };
      }
      const filePath = resolve(dataRoot, "raw", item.path);
      if (!filePath.startsWith(`${rawRoot}/`)) return { ready: false, reason: "incomplete-install" };
      if (!realpathSync(filePath).startsWith(`${canonicalRawRoot}/`)) return { ready: false, reason: "incomplete-install" };
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) return { ready: false, reason: "incomplete-install" };
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== item.sha256) return { ready: false, reason: "incomplete-install" };
      totalBytes += stat.size;
    }
    if (totalBytes !== manifest.totalBytes || totalBytes !== 109_946_203
      || manifest.actual?.questions?.validation?.records !== GAIA_EXPECTED_QUESTIONS.validation
      || manifest.actual?.questions?.test?.records !== GAIA_EXPECTED_QUESTIONS.test
      || manifest.actual?.questions?.validation?.uniqueReferenceAnswerCount !== 143
      || manifest.actual?.questions?.test?.rowsWithReferenceAnswer !== 0
      || JSON.stringify(manifest.actual?.questions?.test?.knownPlaceholderCounts) !== JSON.stringify({ "?": 301 })) return { ready: false, reason: "incomplete-install" };
    return { ready: true, revision: GAIA_REVISION, totalBytes, actual: manifest.actual, authorizedLocalAccess: true, personalIdentityRecorded: false };
  } catch {
    return { ready: false, reason: "incomplete-install" };
  }
}
