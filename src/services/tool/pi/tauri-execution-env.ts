// ==========================================
// Pi ExecutionEnv 的 Tauri 实现 —— 文件/命令全部经 Rust 命令边界
//
// 本文件里成排的 `try/catch` 都是 `return err(...)`：`ExecutionEnv` 契约要求把失败作为
// Result 返回，调用方（Harness / 模型）看得到 —— 这是「显式向上抛」的等价形态，
// 不是静默吞异常。真正需要留痕的分支（拿不到类别的失败）另有日志。
// [保留已登记 §4.2]
// ==========================================

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
  ExecutionErrorCode,
  FileErrorCode,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-agent-core"
import type { Context } from "@earendil-works/pi-agent-core"
import { toolsConfig } from "@/services/config"
import type { ToolMode } from "../types"
import { errorCode, formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024

const log = createLogger("ToolEnv")

/** `file_list` / `file_info` 的载荷：与 FileSystem 契约的 FileInfo 逐字段一致。 */
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
  /** 截断且请求了 spill 时，Rust 侧保留的完整输出文件路径 */
  spillPath: string | null
  /** 本次实际生效的输出上限（Rust 的兜底值也在这里回传）：前端不复制第二份默认值。 */
  maxBytes: number
  maxLines: number
}

/** Rust 错误码 → FileErrorCode；未列出的码保持 unknown（不猜类别）。 */
const FILE_ERROR_BY_RUST_CODE: Record<string, FileErrorCode> = {
  PATH_ESCAPE: "permission_denied",
  SENSITIVE_PATH: "permission_denied",
  PATH_NOT_FOUND: "not_found",
  NOT_ABSOLUTE: "invalid",
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function fileFailure(error: unknown, path?: string): FileError {
  // 取消优先：AbortError 不得退化成 unknown。
  if (isAbortError(error)) return new FileError("aborted", formatError(error), path)
  const code = FILE_ERROR_BY_RUST_CODE[errorCode(error) ?? ""] ?? "unknown"
  return new FileError(code, formatError(error), path)
}

function executionFailure(error: unknown): ExecutionError {
  // 取消优先：AbortError 与 CANCELLED 都不得退化成 unknown；Other/Io 保持 unknown 是诚实的。
  if (isAbortError(error)) return new ExecutionError("aborted", formatError(error))
  const rustCode = errorCode(error)
  const code: ExecutionErrorCode = rustCode === "TIMEOUT" ? "timeout" : rustCode === "CANCELLED" ? "aborted" : "unknown"
  return new ExecutionError(code, formatError(error))
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

  /** Rust `file_list` 直接给 FileInfo 全字段（含绝对 path 与 mtimeMs），原样透传。 */
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    try {
      throwIfAborted(context)
      const result = await invoke<{ entries: FileInfoPayload[] }>("file_list", { path })
      throwIfAborted(context)
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
    // Rust 侧会如实区分三种结果：命中在跑的子进程（true）、在 spawn 前立案（true）、
    // 没有这个 id 的槽（false，子进程可能已结束）。第二种是取消与 spawn 的竞态，
    // 之前会被静默丢掉：取消先到、exec 随后 spawn，子进程一直跑到超时。
    const cancel = () => {
      invoke<boolean>("bash_cancel", { executionId })
        .then(cancelled => {
          if (!cancelled) log.debug("bash_cancel 未命中在跑的子进程（可能已结束）:", executionId)
        })
        .catch(e => log.warn("bash_cancel 调用失败，子进程可能仍在运行:", executionId, formatError(e)))
    }
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
        // 上限的真相源是 Rust：这里只在调用方给了 limits 时转发，缺省交给 Rust 的兜底值。
        maxBytes: limits?.maxBytes ?? null,
        maxLines: limits?.maxLines ?? null,
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
        // 生效值来自 Rust 的回传：前端不再复制一份 2000 / 50*1024 的默认值。
        maxLines: result.maxLines,
        maxBytes: result.maxBytes,
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
