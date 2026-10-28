/** Bounded reader for caller-supplied local Parquet dataset shards. */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 10_000;
const ABSOLUTE_MAX_ROWS = 10_000;

function positiveBound(value, name, fallback, maximum) {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return bound;
}

/**
 * Read bounded records from one local Parquet shard. This function never opens a URL or fetches
 * data. It validates file size and footer row count before decoding row data, then asks hyparquet
 * to decode only the requested initial row range.
 */
export async function readParquetRecords(inputPath, { maxBytes, maxRows, limit } = {}) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new TypeError("inputPath must be a non-empty local path");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) throw new Error("Parquet input must be a local file path; remote URLs are not supported");
  const byteLimit = positiveBound(maxBytes, "maxBytes", DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const rowLimit = positiveBound(maxRows, "maxRows", DEFAULT_MAX_ROWS, ABSOLUTE_MAX_ROWS);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > rowLimit)) {
    throw new RangeError(`limit must be an integer from 1 to maxRows (${rowLimit})`);
  }

  const path = resolve(inputPath);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Parquet input must be a regular local file; symlinks and special files are rejected");
  if (before.size > byteLimit) throw new Error(`Parquet file exceeds maxBytes (${byteLimit})`);

  const file = await asyncBufferFromFile(path);
  if (file.byteLength !== before.size) throw new Error("Parquet file changed while it was being opened");
  if (file.byteLength > byteLimit) throw new Error(`Parquet file exceeds maxBytes (${byteLimit})`);

  const metadata = await parquetMetadataAsync(file);
  const rowCount = metadata.num_rows;
  if (typeof rowCount !== "bigint" || rowCount < 0n || rowCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Parquet metadata has an invalid or unsupported row count");
  }
  if (rowCount > BigInt(rowLimit) && limit === undefined) {
    throw new Error(`Parquet row count ${rowCount} exceeds maxRows (${rowLimit}); provide an explicit smaller limit`);
  }
  const end = Math.min(Number(rowCount), limit ?? rowLimit);
  if (end === 0) return [];
  return parquetReadObjects({ file, rowStart: 0, rowEnd: end });
}

export const PARQUET_READER_LIMITS = Object.freeze({ maxBytes: ABSOLUTE_MAX_BYTES, maxRows: ABSOLUTE_MAX_ROWS });
