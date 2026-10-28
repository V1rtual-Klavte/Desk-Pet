import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parquetMetadataAsync } from "hyparquet";
import {
  BEAM_10M_REVISION,
  BEAM_DATASET_REVISION,
  EXTERNAL_DATA_ROOT,
  MULTICHALLENGE_REVISION,
  PUBLIC_INSTALL_FILES,
  installPublicDataset,
  iterateBeamRowsOneAtATime,
  parseBeamPythonLiteral,
  streamPinnedResponse,
  verifyPublicDatasetInstall,
} from "../../sim/desk-pet-chat/external/beam-install.mjs";
import type { PinnedInstallDescriptor, PublicInstallResult } from "../../sim/desk-pet-chat/external/beam-install.mjs";
import { inspectExternalDatasets } from "../../sim/desk-pet-chat/external/install.mjs";
import { MEMORYARENA_DATASET_REVISION, MEMORYARENA_OFFICIAL_REVISION } from "../../sim/desk-pet-chat/external/memoryarena.mjs";
import { LHTB_ARCHIVE_SHA256, LHTB_REVISION } from "../../sim/desk-pet-chat/external/lhtb.mjs";

// Only I/O is wrapped: verification, path checks, pin comparisons and hashing all run unchanged.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: vi.fn(fs.lstatSync), readFileSync: vi.fn(fs.readFileSync), createReadStream: vi.fn(fs.createReadStream),
    writeFileSync: vi.fn(fs.writeFileSync), mkdirSync: vi.fn(fs.mkdirSync), renameSync: vi.fn(fs.renameSync),
    rmSync: vi.fn(fs.rmSync), createWriteStream: vi.fn(fs.createWriteStream),
  };
});
vi.mock("hyparquet", async importOriginal => {
  const parquet = await importOriginal<typeof import("hyparquet")>();
  // Small pinned fixtures replace only the metadata decode, never hashing or installer decisions.
  return { ...parquet, parquetMetadataAsync: vi.fn(parquet.parquetMetadataAsync) };
});
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Unexpected child process in offline inspection"); }),
  spawnSync: vi.fn(() => { throw new Error("Unexpected child process in offline inspection"); }),
}));

const ROOT = resolve(process.cwd());
const owned: string[] = [];
function denyRenameTo(target: string, rename: typeof renameSync) {
  return (from: Parameters<typeof renameSync>[0], to: Parameters<typeof renameSync>[1]) => {
    if (String(to) === target) throw new Error("Fixture receipt rename denied");
    rename(from, to);
  };
}
function refuseNetwork(): never {
  throw new Error("Unexpected network access");
}
function bridgeUnavailable(): never {
  throw new Error("fixture bridge unavailable");
}
const originalPins = [...PUBLIC_INSTALL_FILES.beam, ...PUBLIC_INSTALL_FILES.multichallenge].map(pin => ({ pin, original: { ...pin } }));
function scratchDir() {
  const base = join(ROOT, "test/.tmp/external-eval");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "beam-install-test-"));
  owned.push(directory);
  return directory;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const { pin, original } of originalPins) Object.assign(pin, original);
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type PublicDataset = "beam" | "multichallenge";
function publicInstallFixture(dataset: PublicDataset, repoRoot = scratchDir()) {
  // Replace only payload pins, retaining every real shard path/revision/split. No verifier seam or local .data reads.
  const files = PUBLIC_INSTALL_FILES[dataset].map((pin, index) => {
    const payload = Buffer.from(`shard-${index}`);
    Object.assign(pin, { bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
    const path = resolve(repoRoot, EXTERNAL_DATA_ROOT, dataset, "raw", pin.path);
    const repository = pin.source === "beam" ? "Mohammadta/BEAM" : pin.source === "beam-10m" ? "Mohammadta/BEAM-10M" : "ScaleAI/MultiChallenge";
    const url = `https://huggingface.co/datasets/${repository}/resolve/${pin.revision}/${pin.path}`;
    const receipt = { schemaVersion: 1, dataset, url, revision: pin.revision, upstreamPath: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload);
    writeFileSync(`${path}.source.json`, JSON.stringify(receipt));
    return { dataset, path, upstreamPath: pin.path, url, revision: pin.revision, bytes: pin.bytes, sha256: pin.sha256, cached: true };
  });
  const manifest: PublicInstallResult = {
    schemaVersion: 1, dataset, status: "complete", completeCounts: true, cached: true,
    files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sourceManifest: PUBLIC_INSTALL_FILES[dataset].map((pin, index) => ({
      source: pin.source, revision: pin.revision, split: pin.split, upstreamPath: pin.path, url: files[index]!.url,
      license: pin.license, expectedBytes: pin.bytes, expectedSha256: pin.sha256,
    })),
    expected: { chats: dataset === "beam" ? 100 : 266, probes: dataset === "beam" ? 2000 : 266 },
    actual: { chats: dataset === "beam" ? 100 : 266, probes: dataset === "beam" ? 2000 : 266 },
  };
  const manifestPath = resolve(repoRoot, EXTERNAL_DATA_ROOT, dataset, "install-manifest.json");
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  return { repoRoot, manifest, manifestPath, save };
}

function lhtbFixture(repoRoot: string) {
  const root = resolve(repoRoot, EXTERNAL_DATA_ROOT, "lhtb");
  mkdirSync(join(root, "upstream/harbor"), { recursive: true });
  const cli = join(root, "venv", process.platform === "win32" ? "Scripts/harbor.exe" : "bin/harbor");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "fixture; never executed");
  writeFileSync(join(root, "installation.json"), JSON.stringify({ revision: LHTB_REVISION, harborVersion: "fixture" }));
  for (let index = 0; index < 77; index += 1) {
    const task = join(root, "upstream/tasks", `task-${index}`);
    mkdirSync(join(task, "tests"), { recursive: true });
    writeFileSync(join(task, "task.toml"), `name = "task-${index}"\n`);
    writeFileSync(join(task, "instruction.md"), "Fixture task");
    writeFileSync(join(task, "tests/test.sh"), "fixture; never executed");
  }
  return root;
}

describe("公开评测全量安装清单", () => {
  it("固定完整 BEAM 分片集合、字节数与 LFS SHA-256 [beam-install-pinned-full-manifest]", () => {
    const files = PUBLIC_INSTALL_FILES.beam;
    expect(files.map((file: PinnedInstallDescriptor) => file.path)).toEqual([
      "data/100K-00000-of-00001.parquet",
      "data/500K-00000-of-00001.parquet",
      "data/1M-00000-of-00001.parquet",
      "data/10M-00000-of-00002.parquet",
      "data/10M-00001-of-00002.parquet",
    ]);
    expect(files.map((file: PinnedInstallDescriptor) => file.revision)).toEqual([
      BEAM_DATASET_REVISION, BEAM_DATASET_REVISION, BEAM_DATASET_REVISION,
      BEAM_10M_REVISION, BEAM_10M_REVISION,
    ]);
    expect(files.reduce((sum: number, file: PinnedInstallDescriptor) => sum + file.bytes, 0)).toBe(449_367_944);
    expect(files.reduce((sum: number, file: PinnedInstallDescriptor) => sum + (file.expectedChats ?? 0), 0)).toBe(100);
    expect(files.reduce((sum: number, file: PinnedInstallDescriptor) => sum + (file.expectedProbes ?? 0), 0)).toBe(2_000);
    expect(files.every((file: PinnedInstallDescriptor) => file.license === "CC-BY-SA-4.0")).toBe(true);
    for (const file of files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("锁定 MultiChallenge 唯一 Parquet 文件并拒绝未知数据集 [beam-install-multichallenge-pin]", async () => {
    expect(PUBLIC_INSTALL_FILES.multichallenge).toHaveLength(1);
    expect(PUBLIC_INSTALL_FILES.multichallenge[0]).toMatchObject({
      revision: MULTICHALLENGE_REVISION,
      path: "data/test-00000-of-00001.parquet",
      bytes: 975_319,
      sha256: "2711646aba61f814823297714aaf757e3a1b71c66c501402231de48490650515",
    });
    await expect(installPublicDataset("gaia" as never)).rejects.toThrow(/Unsupported full public dataset install/);
  });

  it("BEAM Parquet iterator decodes exactly one row per read and preserves source order [beam-install-stream-one-row-at-a-time]", async () => {
    const calls: Array<[number, number]> = [];
    const source = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const rows: unknown[] = [];
    for await (const row of iterateBeamRowsOneAtATime({}, source.length, {
      readRows: async ({ rowStart, rowEnd }) => {
        calls.push([rowStart, rowEnd]);
        return source.slice(rowStart, rowEnd);
      },
    })) rows.push(row);
    expect(calls).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(rows).toEqual(source);
  });

  it("安全还原官方 Parquet 中的 Python literal rubric 而不执行表达式 [beam-install-python-literal]", () => {
    expect(parseBeamPythonLiteral("{'quote': \"user's note\", 'items': [True, None, 3], 'text': 'line\\nnext'}")).toEqual({
      quote: "user's note", items: [true, null, 3], text: "line\nnext",
    });
    expect(() => parseBeamPythonLiteral("__import__('node:fs')")).toThrow(/Invalid BEAM Python literal/);
  });

  it("按 Range 从本地 partial 续传并拒绝错误的 Content-Range [beam-install-resume-range]", async () => {
    const partial = join(scratchDir(), "sample.parquet.part");
    writeFileSync(partial, "abc");
    const progress: number[] = [];
    const response = new Response("def", { status: 206, headers: { "content-range": "bytes 3-5/6" } });
    await expect(streamPinnedResponse(response, partial, {
      offset: 3, totalBytes: 6, dataset: "beam", upstreamPath: "data/sample.parquet",
      onProgress: event => progress.push(event.receivedBytes),
    })).resolves.toBe(6);
    expect(readFileSync(partial, "utf8")).toBe("abcdef");
    expect(progress).toEqual([6]);
    const invalid = join(scratchDir(), "invalid.part");
    writeFileSync(invalid, "abc");
    await expect(streamPinnedResponse(new Response("xyz", { status: 206, headers: { "content-range": "bytes 0-2/6" } }), invalid, { offset: 3, totalBytes: 6 })).rejects.toThrow(/Content-Range/);
    expect(readFileSync(invalid, "utf8")).toBe("abc");
  });

  it("下载响应超出 pinned 字节上限时删除不完整缓存 [beam-install-response-byte-bound]", async () => {
    const partial = join(scratchDir(), "too-large.part");
    await expect(streamPinnedResponse(new Response("oversize"), partial, { offset: 0, totalBytes: 3 })).rejects.toThrow(/exceeds pinned byte size/);
    expect(existsSync(partial)).toBe(false);
  });

  it("拒绝 Parquet 分片计数或解码结果不完整 [beam-install-stream-integrity]", async () => {
    await expect((async () => {
      for await (const _row of iterateBeamRowsOneAtATime({}, -1, { readRows: async () => [] })) { /* exhaust */ }
    })()).rejects.toThrow(/rowCount/);
    await expect((async () => {
      for await (const _row of iterateBeamRowsOneAtATime({}, 1, { readRows: async () => [] })) { /* exhaust */ }
    })()).rejects.toThrow(/exactly one row/);
  });
});

describe("公开评测安装文件边界与缓存恢复", () => {
  it("缓存与下载均在任何读写和联网前拒绝目标及旁路符号链接 [public-install-sidecar-symlink-boundary]", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    for (const cached of [false, true]) {
      const fixture = publicInstallFixture("multichallenge");
      const target = fixture.manifest.files[0]!.path;
      const partial = `${target}.part`;
      const receipt = `${target}.source.json`;
      writeFileSync(partial, "sha");
      if (!cached) rmSync(target);
      const outside = join(fixture.repoRoot, "outside-payload");
      writeFileSync(outside, "external payload must survive");
      const receiptBefore = readFileSync(receipt);
      const fetch = vi.fn(async () => new Response("shard-0"));
      // Includes a dangling target when uncached; only lstat is substituted, no OS symlink privileges.
      for (const blocked of [target, partial, receipt, dirname(target)]) {
        vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
          if (String(args[0]) !== blocked) return realFs.lstatSync(...args);
          const info = realFs.lstatSync(outside);
          info.isSymbolicLink = () => true;
          return info;
        }) as typeof lstatSync);
        vi.clearAllMocks();
        await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow("Install path cannot pass through a symlink");
        expect(fetch).not.toHaveBeenCalled();
        expect(readFileSync).not.toHaveBeenCalled();
        expect(createReadStream).not.toHaveBeenCalled();
        for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
        expect(readFileSync(outside, "utf8")).toBe("external payload must survive");
        expect(readFileSync(partial, "utf8")).toBe("sha");
        expect(readFileSync(receipt)).toEqual(receiptBefore);
        expect(existsSync(target)).toBe(cached);
      }
      vi.mocked(lstatSync).mockImplementation(realFs.lstatSync);
    }
  });

  it("旁路目录与非普通文件不得读取、删除或覆盖 [public-install-sidecar-regular-files]", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    for (const suffix of ["", ".part", ".source.json"]) {
      for (const directory of [false, true]) {
        const fixture = publicInstallFixture("multichallenge");
        const target = fixture.manifest.files[0]!.path;
        const blocked = `${target}${suffix}`;
        if (existsSync(blocked)) rmSync(blocked);
        if (directory) {
          mkdirSync(blocked);
          writeFileSync(join(blocked, "keep"), "unknown directory content");
        } else {
          writeFileSync(blocked, "unknown special file payload");
          vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
            const info = realFs.lstatSync(...args);
            if (String(args[0]) === blocked && info) info.isFile = () => false;
            return info;
          }) as typeof lstatSync);
        }
        const fetch = vi.fn(async () => new Response("shard-0"));
        vi.clearAllMocks();
        await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow(/not a regular file/);
        expect(fetch).not.toHaveBeenCalled();
        expect(readFileSync).not.toHaveBeenCalled();
        expect(createReadStream).not.toHaveBeenCalled();
        for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
        expect(readFileSync(directory ? join(blocked, "keep") : blocked, "utf8")).toBe(directory ? "unknown directory content" : "unknown special file payload");
        vi.mocked(lstatSync).mockImplementation(realFs.lstatSync);
      }
    }
  });

  it("直接流写入口拒绝符号链接，不因从头下载或忽略 Range 删除未知文件 [beam-install-stream-symlink-boundary]", async () => {
    const root = scratchDir();
    const partial = join(root, "sample.part");
    const outside = join(root, "outside-payload");
    writeFileSync(partial, "abc");
    writeFileSync(outside, "external payload must survive");
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    for (const blocked of [partial, root]) {
      vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
        const info = realFs.lstatSync(...args);
        if (String(args[0]) === blocked && info) info.isSymbolicLink = () => true;
        return info;
      }) as typeof lstatSync);
      for (const offset of [0, 3]) {
        vi.clearAllMocks();
        await expect(streamPinnedResponse(new Response("abcdef"), partial, { offset, totalBytes: 6 })).rejects.toThrow("Install path cannot pass through a symlink");
        for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
        expect(readFileSync(partial, "utf8")).toBe("abc");
        expect(readFileSync(outside, "utf8")).toBe("external payload must survive");
      }
    }
  });

  it("完整缓存离线只读复用，包括带 sha256 前缀的完整收据 [public-install-cache-readonly]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    for (const sha256 of [receipt.sha256, `sha256:${receipt.sha256}`]) {
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, sha256 }));
      const paths = [target, receiptPath, fixture.manifestPath];
      for (const path of paths) utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
      const before = paths.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
      const fetch = vi.fn(async () => new Response("shard-0"));
      vi.clearAllMocks();
      await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).resolves.toMatchObject({ status: "complete", cached: true, completeCounts: true, totalBytes: 7 });
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: true, totalBytes: 7 });
      expect(fetch).not.toHaveBeenCalled();
      for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
      expect(paths.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }))).toEqual(before);
    }
  });

  it("缺失或不完整收据在真实字节与 SHA 验证后原子补全并通过 verify [public-install-cache-receipt-convergence]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    const canonical = JSON.parse(readFileSync(receiptPath, "utf8"));
    const partialReceipts = [
      undefined, {},
      ...Object.keys(canonical).map(key => Object.fromEntries(Object.entries(canonical).filter(([field]) => field !== key))),
      // Shape of the interrupted real install, with the test payload's pinned SHA and bytes.
      { schemaVersion: 1, dataset: "multichallenge", url: canonical.url, revision: MULTICHALLENGE_REVISION, sha256: `sha256:${canonical.sha256}`, bytes: 7 },
    ];
    vi.mocked(parquetMetadataAsync).mockResolvedValue({ num_rows: 266n } as Awaited<ReturnType<typeof parquetMetadataAsync>>);
    for (const receipt of partialReceipts) {
      if (receipt === undefined) rmSync(receiptPath);
      else writeFileSync(receiptPath, JSON.stringify(receipt));
      const original = existsSync(receiptPath) ? readFileSync(receiptPath) : undefined;
      vi.clearAllMocks();
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
      for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
      expect(existsSync(receiptPath) ? readFileSync(receiptPath) : undefined).toEqual(original);
      rmSync(fixture.manifestPath);
      const fetch = vi.fn(async () => new Response("shard-0"));
      vi.clearAllMocks();
      await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).resolves.toMatchObject({ status: "complete", cached: true, completeCounts: true, actual: { chats: 266, probes: 266 } });
      expect(fetch).not.toHaveBeenCalled();
      expect(createWriteStream).not.toHaveBeenCalled();
      expect(readFileSync(target, "utf8")).toBe("shard-0");
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(canonical);
      const receiptRenames = vi.mocked(renameSync).mock.calls.filter(([, destination]) => String(destination) === receiptPath);
      expect(receiptRenames).toHaveLength(1);
      const tempPath = String(receiptRenames[0]![0]);
      expect(dirname(tempPath)).toBe(dirname(receiptPath));
      expect(tempPath).not.toBe(receiptPath);
      expect(writeFileSync).toHaveBeenCalledWith(tempPath, `${JSON.stringify(canonical, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => String(path) === receiptPath)).toBe(false);
      expect(existsSync(tempPath)).toBe(false);
      expect(readdirSync(dirname(target)).sort()).toEqual(["test-00000-of-00001.parquet", "test-00000-of-00001.parquet.source.json"]);
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: true, totalBytes: 7 });
    }
  });

  it("收据临时路径被符号链接占用时不写入或删除外部载荷 [public-install-receipt-temp-symlink-boundary]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    writeFileSync(receiptPath, "{}");
    writeFileSync(`${target}.part`, "sha");
    const outside = join(fixture.repoRoot, "outside-receipt");
    writeFileSync(outside, "external receipt must survive");
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
      const path = String(args[0]);
      if (!path.startsWith(`${receiptPath}.`) || !path.endsWith(".tmp")) return realFs.lstatSync(...args);
      const info = realFs.lstatSync(outside);
      info.isSymbolicLink = () => true;
      return info;
    }) as typeof lstatSync);
    const fetch = vi.fn(async () => new Response("shard-0"));
    vi.clearAllMocks();
    await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow("Install path cannot pass through a symlink");
    expect(fetch).not.toHaveBeenCalled();
    for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
    expect(readFileSync(outside, "utf8")).toBe("external receipt must survive");
    expect(readFileSync(receiptPath, "utf8")).toBe("{}");
    expect(readFileSync(target, "utf8")).toBe("shard-0");
    expect(readFileSync(`${target}.part`, "utf8")).toBe("sha");
  });

  it("收据原子发布失败保留旧内容并清理本次临时文件 [public-install-receipt-atomic-failure]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    writeFileSync(receiptPath, "{}");
    const manifestBefore = readFileSync(fixture.manifestPath);
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation(denyRenameTo(receiptPath, realFs.renameSync));
    const fetch = vi.fn(async () => new Response("shard-0"));
    vi.clearAllMocks();
    await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow("Fixture receipt rename denied");
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(target, "utf8")).toBe("shard-0");
    expect(readFileSync(receiptPath, "utf8")).toBe("{}");
    expect(readFileSync(fixture.manifestPath)).toEqual(manifestBefore);
    expect(readdirSync(dirname(target)).sort()).toEqual(["test-00000-of-00001.parquet", "test-00000-of-00001.parquet.source.json"]);
    await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
  });

  it("完整 partial、Range 续传和新响应均生成可验证的规范收据 [public-install-download-receipt-convergence]", async () => {
    vi.mocked(parquetMetadataAsync).mockResolvedValue({ num_rows: 266n } as Awaited<ReturnType<typeof parquetMetadataAsync>>);
    for (const prefix of ["shard-0", "sha", ""]) {
      const fixture = publicInstallFixture("multichallenge");
      const file = fixture.manifest.files[0]!;
      const receiptPath = `${file.path}.source.json`;
      const canonical = JSON.parse(readFileSync(receiptPath, "utf8"));
      rmSync(file.path);
      rmSync(fixture.manifestPath);
      if (prefix) {
        writeFileSync(`${file.path}.part`, prefix);
        writeFileSync(receiptPath, "{}");
      } else rmSync(receiptPath);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => prefix
        ? new Response("rd-0", { status: 206, headers: { "content-range": "bytes 3-6/7" } })
        : new Response("shard-0"));
      vi.clearAllMocks();
      await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).resolves.toMatchObject({ status: "complete", cached: false, completeCounts: true, totalBytes: 7 });
      if (prefix === "shard-0") expect(fetch).not.toHaveBeenCalled();
      else {
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0]!;
        expect(String(url)).toBe(file.url);
        expect(options?.headers).toEqual(prefix ? { "accept-encoding": "identity", range: "bytes=3-" } : { "accept-encoding": "identity" });
      }
      expect(readFileSync(file.path, "utf8")).toBe("shard-0");
      expect(existsSync(`${file.path}.part`)).toBe(false);
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(canonical);
      expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => String(path) === receiptPath)).toBe(false);
      expect(vi.mocked(renameSync).mock.calls.filter(([, to]) => String(to) === receiptPath)).toHaveLength(1);
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: true, totalBytes: 7 });
    }
  });

  it("冲突或畸形来源声明拒绝修复且保留缓存、partial 与收据 [public-install-cache-receipt-conflict]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const partial = `${target}.part`;
    writeFileSync(partial, "sha");
    const invalid = [
      ...[{ schemaVersion: 2 }, { dataset: "beam" }, { revision: "main" }, { upstreamPath: "data/wrong.parquet" },
        { url: "https://example.invalid/payload" }, { bytes: 8 }, { sha256: "0".repeat(64) },
        { bytes: "7" }, { revision: null }, { sha256: {} }, { upstreamPath: "" }].map(patch => JSON.stringify({ ...receipt, ...patch })),
      "{", "null", "[]", "false", '"receipt"', JSON.stringify({ unexpectedProvenance: "unknown" }),
    ];
    for (const cached of [true, false]) {
      if (!cached) rmSync(target);
      for (const content of invalid) {
        writeFileSync(receiptPath, content);
        const fetch = vi.fn(async () => new Response("rd-0", { status: 206, headers: { "content-range": "bytes 3-6/7" } }));
        vi.clearAllMocks();
        await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow(/Source receipt/);
        expect(fetch).not.toHaveBeenCalled();
        for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
        expect(readFileSync(receiptPath, "utf8")).toBe(content);
        expect(readFileSync(partial, "utf8")).toBe("sha");
        expect(existsSync(target)).toBe(cached);
        if (cached) expect(readFileSync(target, "utf8")).toBe("shard-0");
      }
    }
  });

  it("回执补全不能掩盖大小变化或同长度 SHA 损坏 [public-install-cache-repair-requires-integrity]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const target = fixture.manifest.files[0]!.path;
    const receiptPath = `${target}.source.json`;
    for (const incomplete of [false, true]) {
      if (incomplete) writeFileSync(receiptPath, "{}");
      else rmSync(receiptPath);
      for (const content of ["short", "changed"]) {
        writeFileSync(target, content);
        const fetch = vi.fn(async () => new Response("shard-0"));
        vi.clearAllMocks();
        await expect(installPublicDataset("multichallenge", { repoRoot: fixture.repoRoot, fetchImpl: fetch })).rejects.toThrow(/failed integrity check; refusing overwrite/);
        expect(fetch).not.toHaveBeenCalled();
        for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf8")).toBe(content);
        expect(existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : undefined).toBe(incomplete ? "{}" : undefined);
      }
    }
  });
});

describe("公开评测离线安装验证", () => {
  it("完整 pinned 缓存只读验证，不联网、不读凭据、不创建或覆盖缓存 [public-install-verify-readonly-cache]", async () => {
    const repoRoot = scratchDir();
    const fixtures = [publicInstallFixture("beam", repoRoot), publicInstallFixture("multichallenge", repoRoot)];
    const paths = fixtures.flatMap(({ manifestPath, manifest }) => [manifestPath, ...manifest.files.flatMap(file => [file.path, `${file.path}.source.json`])]);
    for (const path of paths) utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const before = paths.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const fetch = vi.fn(refuseNetwork);
    vi.stubGlobal("fetch", fetch);
    vi.clearAllMocks();
    for (const { manifest } of fixtures) {
      await expect(verifyPublicDatasetInstall(manifest.dataset, { repoRoot })).resolves.toMatchObject({ ready: true, totalBytes: manifest.dataset === "beam" ? 35 : 7 });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    // Exact I/O allowlist also excludes HF credential files and any paths supplied by an untrusted manifest.
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path)).sort()).toEqual(paths.filter(path => path.endsWith(".json")).sort());
    expect(vi.mocked(createReadStream).mock.calls.map(([path]) => String(path)).sort()).toEqual(paths.filter(path => path.endsWith(".parquet")).sort());
    for (const write of [writeFileSync, mkdirSync, renameSync, rmSync, createWriteStream]) expect(write).not.toHaveBeenCalled();
    expect(paths.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }))).toEqual(before);
  });

  it("未安装返回 false，不创建目录，未知集仍拒绝 [public-install-verify-not-installed]", async () => {
    const repoRoot = scratchDir();
    for (const dataset of ["beam", "multichallenge"] as const) {
      await expect(verifyPublicDatasetInstall(dataset, { repoRoot })).resolves.toEqual({ ready: false, reason: "not-installed" });
    }
    expect(readdirSync(repoRoot)).toEqual([]);
    await expect(verifyPublicDatasetInstall("gaia" as never, { repoRoot })).rejects.toThrow("Unsupported full public dataset install: gaia");
  });

  it("缺少任一 BEAM 分片或来源收据都不能由完整 manifest 或 partial 顶替 [public-install-verify-missing-shards]", async () => {
    const fixture = publicInstallFixture("beam");
    for (const file of fixture.manifest.files) {
      renameSync(file.path, `${file.path}.part`);
      await expect(verifyPublicDatasetInstall("beam", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
      expect(existsSync(file.path)).toBe(false);
      expect(readFileSync(`${file.path}.part`, "utf8")).toMatch(/^shard-[0-4]$/);
      renameSync(`${file.path}.part`, file.path);
      const receipt = readFileSync(`${file.path}.source.json`);
      rmSync(`${file.path}.source.json`);
      await expect(verifyPublicDatasetInstall("beam", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
      expect(existsSync(`${file.path}.source.json`)).toBe(false);
      writeFileSync(`${file.path}.source.json`, receipt);
    }
  });

  it("大小变化或同字节长度篡改均失效且不修复现有文件 [public-install-verify-content-tampering]", async () => {
    for (const dataset of ["beam", "multichallenge"] as const) {
      const fixture = publicInstallFixture(dataset);
      const file = fixture.manifest.files[fixture.manifest.files.length - 1]!;
      for (const content of ["short", "changed"]) {
        writeFileSync(file.path, content);
        await expect(verifyPublicDatasetInstall(dataset, fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
        expect(readFileSync(file.path, "utf8")).toBe(content);
      }
      // A matching forged manifest + receipt cannot replace the trusted pin.
      file.sha256 = createHash("sha256").update("changed").digest("hex");
      fixture.manifest.sourceManifest[fixture.manifest.sourceManifest.length - 1]!.expectedSha256 = file.sha256;
      fixture.save();
      const receipt = JSON.parse(readFileSync(`${file.path}.source.json`, "utf8"));
      writeFileSync(`${file.path}.source.json`, JSON.stringify({ ...receipt, sha256: file.sha256 }));
      await expect(verifyPublicDatasetInstall(dataset, fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
    }
  });

  it("拒绝完整标记下的空集合、缺片、重复片与额外片 [public-install-verify-full-set-not-self-reported]", async () => {
    const fixture = publicInstallFixture("beam");
    const { manifest } = fixture;
    const invalid = [
      { ...manifest, files: [] },
      { ...manifest, sourceManifest: [] },
      { ...manifest, files: manifest.files.slice(0, -1) },
      { ...manifest, sourceManifest: manifest.sourceManifest.slice(0, -1) },
      { ...manifest, files: [manifest.files[0], ...manifest.files.slice(0, -1)] },
      { ...manifest, sourceManifest: [manifest.sourceManifest[0], ...manifest.sourceManifest.slice(0, -1)] },
      { ...manifest, files: [...manifest.files, manifest.files[0]] },
      { ...manifest, sourceManifest: [...manifest.sourceManifest, manifest.sourceManifest[0]] },
    ];
    for (const forged of invalid) {
      writeFileSync(fixture.manifestPath, JSON.stringify(forged));
      await expect(verifyPublicDatasetInstall("beam", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
    }
  });

  it("安装元数据与双清单必须匹配固定 revision、URL、字节和 SHA [public-install-verify-manifest-pins]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const mutations = [
      { schemaVersion: 2 }, { dataset: "beam" }, { status: "pending" }, { completeCounts: false }, { totalBytes: 8 },
      ...[{ revision: "main" }, { url: "https://example.invalid/payload" }, { bytes: 8 }, { sha256: "0".repeat(64) }, { dataset: "beam" }, { upstreamPath: "data/unknown.parquet" }]
        .map(patch => ({ files: [{ ...fixture.manifest.files[0], ...patch }] })),
      ...[{ revision: "main" }, { url: "https://example.invalid/payload" }, { expectedBytes: 8 }, { expectedSha256: "0".repeat(64) }, { source: "beam" }, { split: "train" }, { license: "unknown" }, { upstreamPath: "data/unknown.parquet" }]
        .map(patch => ({ sourceManifest: [{ ...fixture.manifest.sourceManifest[0], ...patch }] })),
    ];
    for (const patch of mutations) {
      writeFileSync(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, ...patch }));
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
    }
    for (const malformed of ["{", "null", JSON.stringify({ ...fixture.manifest, files: [null] })]) {
      writeFileSync(fixture.manifestPath, malformed);
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
    }
  });

  it("来源收据缺失字段、损坏 JSON 或伪造 pin 一律失效 [public-install-verify-source-receipts]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const receiptPath = `${fixture.manifest.files[0]!.path}.source.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const invalid = [
      ...Object.keys(receipt).map(key => Object.fromEntries(Object.entries(receipt).filter(([field]) => field !== key))),
      ...[{ schemaVersion: 2 }, { dataset: "beam" }, { revision: "main" }, { upstreamPath: "../elsewhere.parquet" },
        { url: "https://example.invalid/payload" }, { bytes: 8 }, { sha256: "0".repeat(64) }].map(patch => ({ ...receipt, ...patch })),
    ];
    for (const forged of invalid) {
      writeFileSync(receiptPath, JSON.stringify(forged));
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
    }
    writeFileSync(receiptPath, "{");
    await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
  });

  it("分片、来源收据与安装清单都必须是普通文件 [public-install-verify-regular-files]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const file = fixture.manifest.files[0]!;
    for (const path of [file.path, `${file.path}.source.json`, fixture.manifestPath]) {
      const content = readFileSync(path);
      rmSync(path);
      mkdirSync(path);
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
      expect(statSync(path).isDirectory()).toBe(true);
      rmSync(path, { recursive: true });
      writeFileSync(path, content);
    }
  });

  it("只打开规范 raw 路径，拒绝清单中的外部路径和等价路径别名 [public-install-verify-canonical-paths]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const file = fixture.manifest.files[0]!;
    const originalPath = file.path;
    const outside = join(fixture.repoRoot, "outside.parquet");
    writeFileSync(outside, "shard-0");
    for (const path of [outside, "../outside.parquet", `${dirname(originalPath)}/./test-00000-of-00001.parquet`]) {
      file.path = path;
      fixture.save();
      vi.clearAllMocks();
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install" });
      expect(createReadStream).not.toHaveBeenCalled();
      expect(vi.mocked(readFileSync).mock.calls.map(([target]) => String(target))).toEqual([fixture.manifestPath]);
    }
  });

  it("拒绝分片、收据、manifest 以及 raw 祖先的符号链接 [public-install-verify-symlink-boundary]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const file = fixture.manifest.files[0]!;
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = resolve(fixture.repoRoot, EXTERNAL_DATA_ROOT, "multichallenge");
    // lstat-only substitution is portable on Windows without symlink privileges; reads and hashes remain real.
    for (const blocked of [file.path, `${file.path}.source.json`, fixture.manifestPath, dirname(file.path), join(root, "raw"), root, dirname(root)]) {
      vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
        const info = realFs.lstatSync(...args);
        if (String(args[0]) === blocked && info) info.isSymbolicLink = () => true;
        return info;
      }) as typeof lstatSync);
      await expect(verifyPublicDatasetInstall("multichallenge", fixture)).resolves.toMatchObject({ ready: false, reason: "incomplete-install", error: "Install path cannot pass through a symlink" });
    }
  });
});

describe("公开评测安装状态汇总", () => {
  it("BEAM 与 MultiChallenge 真验证，未 connected 不影响安装完成 [external-inspect-static-verification]", async () => {
    const repoRoot = scratchDir();
    for (const dataset of ["beam", "multichallenge"] as const) {
      const fixture = publicInstallFixture(dataset, repoRoot);
      const result = await inspectExternalDatasets({ dataset, repoRoot });
      expect(result.complete).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ dataset, installed: true, verification: { ready: true }, connection: { ready: false, reason: "not-connected" } });
      writeFileSync(fixture.manifest.files[fixture.manifest.files.length - 1]!.path, "changed");
      const broken = await inspectExternalDatasets({ dataset, repoRoot });
      expect(broken.complete).toBe(false);
      expect(broken.results[0]).toMatchObject({ dataset, installed: false, verification: { ready: false, reason: "incomplete-install" } });
    }
  });

  it("连接元数据错误保留已验证 installed，但汇总 complete 必须 false [external-inspect-error-incomplete]", async () => {
    const fixture = publicInstallFixture("multichallenge");
    const datasetRoot = resolve(fixture.repoRoot, EXTERNAL_DATA_ROOT, "multichallenge/dataset");
    mkdirSync(datasetRoot, { recursive: true });
    writeFileSync(join(datasetRoot, "import.json"), "{");
    const result = await inspectExternalDatasets({ dataset: "multichallenge", repoRoot: fixture.repoRoot });
    expect(result.complete).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ dataset: "multichallenge", installed: true, error: expect.any(String) });
  });

  it("all 缺任一安装即 false，GAIA 完整标记不能绕过自身 verifier [external-inspect-all-requires-every-install]", async () => {
    const repoRoot = scratchDir();
    const missing = await inspectExternalDatasets({ repoRoot });
    expect(missing.complete).toBe(false);
    expect(missing.results.map(result => [result.dataset, result.installed])).toEqual([
      ["multichallenge", false], ["beam", false], ["gaia", false], ["memoryarena", false], ["lhtb", false],
    ]);
    publicInstallFixture("beam", repoRoot);
    publicInstallFixture("multichallenge", repoRoot);
    const gaia = resolve(repoRoot, EXTERNAL_DATA_ROOT, "gaia");
    mkdirSync(gaia, { recursive: true });
    writeFileSync(join(gaia, "install-manifest.json"), JSON.stringify({ status: "complete", completeCounts: true }));
    const mixed = await inspectExternalDatasets({ repoRoot });
    expect(mixed.complete).toBe(false);
    expect(mixed.results.map(result => [result.dataset, result.installed])).toEqual([
      ["multichallenge", true], ["beam", true], ["gaia", false], ["memoryarena", false], ["lhtb", false],
    ]);
    expect(mixed.results[2]).toMatchObject({ verification: { ready: false, reason: "incomplete-install" } });
    expect((await inspectExternalDatasets({ dataset: "gaia", repoRoot })).complete).toBe(false);
  });

  it("MemoryArena 取 bridge 的 verified 而非收据或 environment.ready，并保留错误 [external-inspect-memoryarena-verified-field]", async () => {
    const repoRoot = scratchDir();
    mkdirSync(join(repoRoot, "test"), { recursive: true });
    writeFileSync(join(repoRoot, "test/AGENTS.md"), "Fixture repository marker");
    const root = resolve(repoRoot, EXTERNAL_DATA_ROOT, "memoryarena");
    mkdirSync(root, { recursive: true });
    const manifestPath = join(root, "install-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ datasetRevision: MEMORYARENA_DATASET_REVISION, officialRevision: MEMORYARENA_OFFICIAL_REVISION, verified: true }));
    for (const verified of [true, false]) {
      vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], status: 0, signal: null, stderr: "", stdout: JSON.stringify({ verified, environment: { ready: !verified } }) });
      const result = await inspectExternalDatasets({ dataset: "memoryarena", repoRoot });
      expect(result.complete).toBe(verified);
      expect(result.results[0]).toMatchObject({ installed: verified, verification: { verified }, connection: { ready: false } });
    }
    expect(vi.mocked(spawnSync).mock.calls.map(([, args]) => (args as string[]).slice(1))).toEqual([
      ["--action", "verify", "--repo-root", repoRoot], ["--action", "verify", "--repo-root", repoRoot],
    ]);
    vi.mocked(spawnSync).mockImplementationOnce(bridgeUnavailable);
    const failed = await inspectExternalDatasets({ dataset: "memoryarena", repoRoot });
    expect(failed).toEqual({ complete: false, results: [{ dataset: "memoryarena", installed: false, error: "fixture bridge unavailable" }] });
  });

  it("LHTB 取离线校验的 ready 而非安装文件存在，不把镜像未检查当安装失败 [external-inspect-lhtb-ready-field]", async () => {
    const repoRoot = scratchDir();
    const root = lhtbFixture(repoRoot);
    const sourceTreeSha256 = `sha256:${"1".repeat(64)}`;
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], status: 0, signal: null, stderr: "", stdout: JSON.stringify({
      ready: true, revision: LHTB_REVISION, archiveSha256: LHTB_ARCHIVE_SHA256,
      runtimeVerified: true, harborContinueUntilTimeout: true, sourceTreeSha256,
    }) });
    const ready = await inspectExternalDatasets({ dataset: "lhtb", repoRoot });
    expect(ready.complete).toBe(true);
    expect(ready.results[0]).toMatchObject({
      installed: true,
      verification: {
        ready: true, taskCount: 77, verifierTaskCount: 77, runtimeVerified: true,
        harborContinueUntilTimeout: true, sourceTreeSha256, containerImages: { checked: false },
      },
    });
    rmSync(join(root, "upstream/tasks/task-0/tests/test.sh"));
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], status: 1, signal: null, stderr: "source tree digest differs", stdout: "" });
    const incomplete = await inspectExternalDatasets({ dataset: "lhtb", repoRoot });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.results[0]).toMatchObject({ installed: false, verification: { ready: false, verifierTaskCount: 76 } });
    expect(incomplete.results[0].verification.blockers[0]).toMatch(/source tree digest differs/);
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], status: 0, signal: null, stderr: "", stdout: "{" });
    const malformed = await inspectExternalDatasets({ dataset: "lhtb", repoRoot });
    expect(malformed.complete).toBe(false);
    expect(malformed.results[0].installed).toBe(false);
    expect(malformed.results[0].verification.blockers[0]).toMatch(/LHTB installation verification failed/);
  });
});
