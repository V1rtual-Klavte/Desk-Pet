// ==========================================
// Pi ExecutionEnv 的 Native 宿主实现 —— 文件/命令全部经 HostBridge 边界
//
// 本文件里成排的 `try/catch` 都是 `return err(...)`：`ExecutionEnv` 契约要求把失败作为
// Result 返回，调用方（Harness / 模型）看得到 —— 这是「显式向上抛」的等价形态，
// 不是静默吞异常。真正需要留痕的分支（拿不到类别的失败）另有日志。
// [保留已登记 §4.2]
//
// 迁移状态（W3b + 解除包）：
// - 13 处命令全部经 `getHostBridge().request(...)`（HostBridge 是唯一桥接入口，
//   实现由 Node 引导在 connectHostBridge() 装配）。
// - 路径运算（homeDir/tempDir/join/resolve/isAbsolute）经 `ExecutionPathKit` 端口取用：
//   Node 实现走 node:path/node:os —— 本文件不 import `@tauri-apps`，也不自造用户目录
//   推算（AGENTS.md 禁止 dirs_next() 一类替代）。
//   home/temp 是否改由宿主 `get_runtime_paths` 告知，待协调者裁定（见交付报告）。
// - `bash_exec` 取消链保持原样：本文件自己监听 abort → `bash_cancel`，不搬进桥
//   （桥里再发一遍会成为第二份取消定义）。
// ==========================================

import { getExecutionPathKit, getHostBridge } from "@/services/host"
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
import { errorCode, formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

/**
 * 单次 `file_read` / `file_write` / `file_append` 的字节上限（Rust 侧 `content.len()` 同口径）。
 * 唯一真相源：会话存储的折叠守卫（`engine/harness/session-fold.ts`）也读它，不再各存一份。
 */
export const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024

const log = createLogger("ToolEnv")

/**
 * `file_list` / `file_info` 的载荷：与 FileSystem 契约的 FileInfo 逐字段一致。
 * 也是 `@/services/host` HostCommandMap 里 `file_list` / `file_info` 结果类型的
 * import 来源（W3b 清 TODO(W0)：类型只在这里定义一份，矩阵 import 复用）。
 */
export type FileInfoPayload = {
  name: string
  path: string
  kind: "file" | "directory" | "symlink"
  size: number
  mtimeMs: number
}

/**
 * `bash_exec` 的载荷。也是 HostCommandMap 里 `bash_exec` 结果类型的 import 来源
 * （W3b 清 TODO(W0)：类型只在这里定义一份，矩阵 import 复用）。
 */
export type BashPayload = {
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
  return err(new FileError("not_supported", `NativeExecutionEnv 不支持 ${operation}`, path))
}

function throwIfAborted(context: Context): void {
  context.abortSignal?.throwIfAborted()
}

export class NativeExecutionEnv implements ExecutionEnv {
  constructor(public cwd: string) {}

  static async defaultCwd(): Promise<string> {
    return getExecutionPathKit().homeDir()
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const kit = getExecutionPathKit()
      return ok(await (await kit.isAbsolute(path) ? kit.resolve(path) : kit.resolve(this.cwd, path)))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await getExecutionPathKit().join(...parts))
    } catch (error) {
      return err(fileFailure(error))
    }
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const result = await getHostBridge().request("file_read", { path, maxBytes: MAX_TOOL_FILE_BYTES })
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
      // 桥对 `file_read_binary` 的结果统一做 number[] → Uint8Array 物化（BYTE_RESULT_METHODS），
      // 调用点不再重复转换（物化结果与手写 `new Uint8Array(number[])` 逐字节一致）。
      const bytes = await getHostBridge().request("file_read_binary", { path, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(bytes)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (content instanceof Uint8Array) return unsupported("二进制写入", path)
    try {
      throwIfAborted(context)
      await getHostBridge().request("file_write", { path, content, maxBytes: MAX_TOOL_FILE_BYTES })
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
      await getHostBridge().request("file_append", { path, content, maxBytes: MAX_TOOL_FILE_BYTES })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    try {
      throwIfAborted(context)
      await getHostBridge().request("file_rename", { sourcePath, destinationPath })
      throwIfAborted(context)
      return ok(undefined)
    } catch (error) {
      return err(fileFailure(error, sourcePath))
    }
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await getHostBridge().request("file_info", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  /** Rust `file_list` 直接给 FileInfo 全字段（含绝对 path 与 mtimeMs），原样透传。 */
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    try {
      throwIfAborted(context)
      const result = await getHostBridge().request("file_list", { path })
      throwIfAborted(context)
      return ok(result.entries)
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await getHostBridge().request("file_canonical_path", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    try {
      throwIfAborted(context)
      return ok(await getHostBridge().request("file_exists", { path }))
    } catch (error) {
      return err(fileFailure(error, path))
    }
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    try {
      throwIfAborted(context)
      // FileSystem 契约：recursive 默认 true
      await getHostBridge().request("dir_create", { path, recursive: options?.recursive ?? true })
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
      await getHostBridge().request("file_remove", {
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
      const kit = getExecutionPathKit()
      const path = await kit.join(await kit.tempDir(), `${prefix ?? "deskpet-"}${crypto.randomUUID()}`)
      const result = await this.createDir(path, undefined, context)
      return result.ok ? ok(path) : result
    } catch (error) {
      return err(fileFailure(error))
    }
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    try {
      throwIfAborted(context)
      const kit = getExecutionPathKit()
      const path = await kit.join(await kit.tempDir(), `${options?.prefix ?? "deskpet-"}${crypto.randomUUID()}${options?.suffix ?? ""}`)
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
      getHostBridge().request("bash_cancel", { executionId })
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
      const result = await getHostBridge().request("bash_exec", {
        executionId,
        command,
        cwd: options?.cwd ?? this.cwd,
        timeoutMs: options?.timeout === undefined ? null : Math.round(options.timeout * 1000),
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
