import { invoke } from "@tauri-apps/api/core"
import { homeDir, isAbsolute, join, resolve, tempDir } from "@tauri-apps/api/path"
import {
  err,
  ExecutionError,
  FileError,
  ok,
} from "@earendil-works/pi-agent-core"
import type {
  ExecutionEnv,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-agent-core"
import type { Context } from "@earendil-works/pi-agent-core"
import { toolsConfig } from "@/services/config"
import type { ToolMode } from "../types"

const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024

type FileInfoPayload = {
  name: string
  path: string
  kind: "file" | "directory" | "symlink"
  size: number
  mtimeMs: number
}

type BashPayload = {
  output: string
  exitCode: number
  totalBytes: number
  totalLines: number
  outputBytes: number
  outputLines: number
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  lastLinePartial: boolean
}

function fileFailure(error: unknown, path?: string): FileError {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const code = /不存在|not found|no such/.test(lower)
    ? "not_found"
    : /越权|不在允许范围|permission|denied/.test(lower)
      ? "permission_denied"
      : /目录|directory/.test(lower)
        ? "not_directory"
        : "unknown"
  return new FileError(code, message, path)
}

function executionFailure(error: unknown): ExecutionError {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const code = /取消|abort/.test(lower) ? "aborted" : /超时|timeout/.test(lower) ? "timeout" : "unknown"
  return new ExecutionError(code, message)
}

function unsupported(operation: string, path?: string): Result<never, FileError> {
  return err(new FileError("not_supported", `TauriExecutionEnv 不支持 ${operation}`, path))
}

function throwIfAborted(context: Context): void {
  context.abortSignal?.throwIfAborted()
}

export class TauriExecutionEnv implements ExecutionEnv {
  constructor(public cwd: string, private readonly mode: ToolMode) {}

  static async defaultCwd(): Promise<string> {
    return homeDir()
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await (await isAbsolute(path) ? resolve(path) : resolve(this.cwd, path)))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await join(...parts))
    } catch (error) {
      return err(fileFailure(error))
    }
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const result = await invoke<{ content: string }>("file_read", { path, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(result.content)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path, context)
    if (!result.ok) return result
    const lines = result.value.split("\n")
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines))
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    try {
      throwIfAborted(context)
      const result = await invoke<number[]>("file_read_binary", { path, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(new Uint8Array(result))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (content instanceof Uint8Array) return unsupported("二进制写入", path)
    try {
      throwIfAborted(context)
      await invoke("file_write", { path, content, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async appendFile(_path: string, _content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    return unsupported("追加写入", _path)
  }

  async renameFile(_sourcePath: string, _destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
    return unsupported("重命名", _sourcePath)
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await invoke<FileInfoPayload>("file_info", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    try {
      throwIfAborted(context)
      const result = await invoke<{ entries: FileInfoPayload[] }>("file_list", { path })
      return ok(result.entries)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await invoke<string>("file_canonical_path", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await invoke<boolean>("file_exists", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async createDir(_path: string, _options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return unsupported("显式创建目录", _path)
  }

  async remove(_path: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return unsupported("删除", _path)
  }

  async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    return unsupported("临时目录")
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const path = await join(await tempDir(), `${options?.prefix ?? "deskpet-"}${crypto.randomUUID()}${options?.suffix ?? ""}`)
      const result = await this.writeFile(path, "", context)
      return result.ok ? ok(path) : result
    } catch (error) {
      return err(fileFailure(error))
    }
  }

  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const executionId = crypto.randomUUID()
    const signal = context.abortSignal
    const cancel = () => { invoke("bash_cancel", { executionId }).catch(() => {}) }
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      throwIfAborted(context)
      const limits = options?.capture?.limits
      const result = await invoke<BashPayload>("bash_exec", {
        executionId,
        command,
        cwd: options?.cwd ?? this.cwd,
        timeoutMs: options?.timeout === undefined ? null : Math.round(options.timeout * 1000),
        restricted: this.mode === "pet",
        whitelist: toolsConfig.bashWhitelist,
        maxBytes: limits?.maxBytes ?? 50 * 1024,
        maxLines: limits?.maxLines ?? 2000,
      })
      throwIfAborted(context)
      const truncation = {
        truncated: result.truncated,
        truncatedBy: result.truncatedBy,
        totalLines: result.totalLines,
        totalBytes: result.totalBytes,
        outputLines: result.outputLines,
        outputBytes: result.outputBytes,
        lastLinePartial: result.lastLinePartial,
        firstLineExceedsLimit: false,
        maxLines: limits?.maxLines ?? 2000,
        maxBytes: limits?.maxBytes ?? 50 * 1024,
      }
      options?.onUpdate?.({ kind: "replace", output: { text: result.output, truncation } }, context)
      return ok({ exitCode: result.exitCode, truncation })
    } catch (error) {
      return err(executionFailure(error))
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
  }

  async cleanup(_context: Context): Promise<void> {}
}
