export interface ReadParquetOptions {
  /** Maximum local file size in bytes; hard maximum is 128 MiB. */
  maxBytes?: number;
  /** Maximum rows to decode; hard maximum is 10,000. */
  maxRows?: number;
  /** Optional initial row count, bounded by maxRows. */
  limit?: number;
}

export function readParquetRecords(inputPath: string, options?: ReadParquetOptions): Promise<Record<string, unknown>[]>;
export const PARQUET_READER_LIMITS: Readonly<{ maxBytes: number; maxRows: number }>;
