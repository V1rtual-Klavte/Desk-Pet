import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readParquetRecords } from "../../sim/desk-pet-chat/external/parquet.mjs";

// Apache parquet-testing/data/alltypes_plain.snappy.parquet at eedfad3f086678d282a00d8ff3cf8932d5d29af5.
// Source SHA-256: 9f8c5d74012498235eea4431035484dc61a76f8ad2b2b9cb5ac6972db43de591.
const PARQUET_FIXTURE_BASE64 = "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";

describe("本地公开评测 Parquet 读取 [external-parquet]", () => {
  it("读取 Parquet 数据并只解码显式请求的前缀行 [external-parquet-read-bounded-prefix]", async () => {
    const root = mkdtempSync(join(tmpdir(), "deskpet-parquet-"));
    try {
      const path = join(root, "sample.parquet");
      writeFileSync(path, Buffer.from(PARQUET_FIXTURE_BASE64, "base64"));
      const rows = await readParquetRecords(path, { limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 6, bool_col: true, string_col: "0" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("在读取行数据前执行文件大小和元数据行数上限 [external-parquet-preflight-bounds]", async () => {
    const root = mkdtempSync(join(tmpdir(), "deskpet-parquet-"));
    try {
      const path = join(root, "sample.parquet");
      writeFileSync(path, Buffer.from(PARQUET_FIXTURE_BASE64, "base64"));
      await expect(readParquetRecords(path, { maxBytes: 1024 })).rejects.toThrow(/maxBytes/);
      await expect(readParquetRecords(path, { maxRows: 1 })).rejects.toThrow(/exceeds maxRows/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("只接受调用方的本地文件路径，不尝试访问远程 URL [external-parquet-local-only]", async () => {
    await expect(readParquetRecords("https://huggingface.co/datasets/example/data.parquet")).rejects.toThrow(/local file path/);
  });
});
