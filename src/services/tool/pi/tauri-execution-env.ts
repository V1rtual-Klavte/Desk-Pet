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
import { formatError } from "@/services/error"

const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024

type FileInfoPayload = {
  name: string
  path: string
  kind: "file" | "directory" | "symlink"
  size: number
  mtimeMs: number
}

/**
 * `file_list` 的原始条目：Rust 目前只返回 name/kind/size 的短形态（kind 为 "dir"/"file"），
 * 而 FileSystem 契约要求 FileInfo 带绝对 path、mtimeMs，目录种类为 "directory"。
 */
type RawFileListEntry = {
  name: string
  kind: string
  size?: number
  path?: string
  mtimeMs?: number
}

function asFileKind(kind: string): FileInfo["kind"] {
  if (kind === "dir" || kind === "directory") return "directory"
  return kind === "symlink" ? "symlink" : "file"
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
  /** 截断且请求了 spill 时，Rust 侧保留的完整输出文件路径 */
  spillPath: string | null
}

function fileFailure(error: unknown, path?: string): FileError {
  const message = formatError(error)
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
  const message = formatError(error)
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

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (content instanceof Uint8Array) return unsupported("二进制追加", path)
    try {
      throwIfAborted(context)
      await invoke("file_append", { path, content, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    try {
      throwIfAborted(context)
      await invoke("file_rename", { sourcePath, destinationPath })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, sourcePath))
    }
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await invoke<FileInfoPayload>("file_info", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  /**
   * `file_list` 的短条目缺 path/mtimeMs，JsonlSessionRepo 会按 `kind === "directory"` 与
   * 会话文件的 path 组装目录，缺字段会让 list/open 直接失效，所以这里缺什么补什么：
   * 字段齐全的条目直接透传，短条目用 file_info 回填（回填顺带纠正 symlink 的 kind）。
   */
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    try {
      throwIfAborted(context)
      const result = await invoke<{ entries: RawFileListEntry[] }>("file_list", { path })
      const entries: FileInfo[] = []
      for (const entry of result.entries) {
        if (entry.path !== undefined && entry.mtimeMs !== undefined && entry.size !== undefined) {
          entries.push({
            name: entry.name,
            path: entry.path,
            kind: asFileKind(entry.kind),
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })
          continue
        }
        const info = await this.fileInfo(entry.path ?? await join(path, entry.name), context)
        if (!info.ok) return info
        entries.push(info.value)
      }
      throwIfAborted(context)
      return ok(entries)
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

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    try {
      throwIfAborted(context)
      // FileSystem 契约：recursive 默认 true
      await invoke("dir_create", { path, recursive: options?.recursive ?? true })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    try {
      throwIfAborted(context)
      // FileSystem 契约：recursive/force 默认 false；force 时缺失路径由 Rust 侧视为成功
      await invoke("file_remove", {
        path,
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const path = await join(await tempDir(), `${prefix ?? "deskpet-"}${crypto.randomUUID()}`)
      const result = await this.createDir(path, undefined, context)
      return result.ok ? ok(path) : result
    } catch (error) {
      return err(fileFailure(error))
    }
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
      const spill = options?.capture?.spill === true
      const result = await invoke<BashPayload>("bash_exec", {
        executionId,
        command,
        cwd: options?.cwd ?? this.cwd,
        timeoutMs: options?.timeout === undefined ? null : Math.round(options.timeout * 1000),
        policy: { scope: this.mode, whitelist: toolsConfig.bashWhitelist },
        maxBytes: limits?.maxBytes ?? 50 * 1024,
        maxLines: limits?.maxLines ?? 2000,
        spill,
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
      // bash 工具会把 spillPath 拼进给模型的文本（「Full output: <path>」），
      // 所以它必须同时出现在流式更新和最终结果里，缺一个模型都会看到字面量 undefined。
      const spillPath = spill ? result.spillPath ?? undefined : undefined
      options?.onUpdate?.({ kind: "replace", output: { text: result.output, truncation, spillPath } }, context)
      return ok({ exitCode: result.exitCode, truncation, spillPath })
    } catch (error) {
      return err(executionFailure(error))
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
  }

  async cleanup(_context: Context): Promise<void> {}
}
