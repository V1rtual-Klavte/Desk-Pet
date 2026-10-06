import { getHostBridge } from "@/services/host"
import { err, FileError, ok } from "@earendil-works/pi-agent-core"
import type { Context, Result } from "@earendil-works/pi-agent-core"
import { formatError, errorCode } from "@/services/error"
import { relativeWithinRoot } from "@/services/paths"
import { NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

/**
 * 会话根内单次写入的字节上限（宿主 `session_write_text` 的 maxBytes），UTF-8 字节口径
 * 与 Rust 的 `content.len()` 一致。
 *
 * 为什么单开一条：折叠结果经会话写路径落地，可以超过工具面 `file_write` 的 5 MiB
 * （`MAX_TOOL_FILE_BYTES`）—— 折叠结果最大 = 被折文件大小，而 `FOLD_POLICY.maxFileBytes`
 * 允许读到 64 MiB。它**只放宽会话根内的路径**：`relativeWithinRoot` 判不中的路径仍走通用
 * `file_write`（5 MiB）；Rust 侧 `session_write_text` 也只接受会话根内的相对路径。
 * 与 `FOLD_POLICY.maxFileBytes` 同值（改一个必须核对另一个）：折叠只删不增 ⇒ 结果 ≤ 输入
 * ≤ 读守卫，读守卫与写上限同值才不会出现「能折、写不回去」的区间。
 * 载荷承载由 IPC 层负责：超过控制帧上限的字符串自动走 blob 通道（单句柄上限 256 MiB），
 * 应用层原值不缩水。
 */
export const SESSION_WRITE_MAX_BYTES = 64 * 1024 * 1024

/** 宿主会话的读写适配：会话根内的读写走宿主会话命令，边界外继续使用已有文件系统机制。 */
export class SessionFileSystem extends NativeExecutionEnv {
  constructor(cwd: string, private readonly sessionRoot: string) { super(cwd) }

  private async readSession(path: string, context: Context, maxLines?: number): Promise<Result<string, FileError> | undefined> {
    const absolute = await this.absolutePath(path, context)
    if (!absolute.ok) return absolute
    // 会话根边界判定与相对路径截取共用路径模块的纯函数，这里不再自建第二份分隔符归一。
    const relative = relativeWithinRoot(this.sessionRoot, absolute.value)
    // 注入自定义 sessionsRoot 的库测试仍可读自己的文件；真实会话根才走宿主域命令。
    if (relative === null) return undefined
    try {
      context.abortSignal?.throwIfAborted()
      const text = await getHostBridge().request("session_read_text", {
        path: relative, ...(maxLines === undefined ? {} : { maxLines }),
      })
      context.abortSignal?.throwIfAborted()
      return ok(text)
    } catch (error) {
      const code = context.abortSignal?.aborted ? "aborted"
        : errorCode(error) === "PATH_ESCAPE" ? "permission_denied" : "unknown"
      return err(new FileError(code, formatError(error), path))
    }
  }

  /**
   * 会话根内的整文件写入（`session_write_text`）：上限取 {@link SESSION_WRITE_MAX_BYTES}，
   * 路径经 `relativeWithinRoot` 截成会话根内相对路径后交给 Rust 做最终裁决（base 边界 +
   * canonical 校验，本函数只做分流，不复现路径策略）。
   *
   * 放宽只覆盖 `writeFile`（整文件覆盖写：折叠结果、存储发布）：会话的追加写（帧、提交事务）
   * 都是小载荷，继续走工具面 `file_append` 的 5 MiB —— 没有消费方就不放宽。
   */
  private async writeSession(path: string, content: string, context: Context): Promise<Result<void, FileError> | undefined> {
    const absolute = await this.absolutePath(path, context)
    if (!absolute.ok) return absolute
    const relative = relativeWithinRoot(this.sessionRoot, absolute.value)
    if (relative === null) return undefined
    try {
      context.abortSignal?.throwIfAborted()
      await getHostBridge().request("session_write_text", {
        path: relative, content, maxBytes: SESSION_WRITE_MAX_BYTES,
      })
      context.abortSignal?.throwIfAborted()
      return ok(undefined)
    } catch (error) {
      const code = context.abortSignal?.aborted ? "aborted"
        : errorCode(error) === "PATH_ESCAPE" ? "permission_denied" : "unknown"
      return err(new FileError(code, formatError(error), path))
    }
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return await this.readSession(path, context) ?? super.readTextFile(path, context)
  }

  override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const result = await this.readSession(path, context, options?.maxLines)
    if (!result) return super.readTextLines(path, options, context)
    if (!result.ok) return result
    const lines = result.value.split("\n")
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines))
  }

  /**
   * 覆盖写：会话根内走专用放宽路径，其余（含 `Uint8Array`，交回基类的 unsupported）逐字节
   * 走通用 `file_write`（`MAX_TOOL_FILE_BYTES`）—— 工具面的 5 MiB 上限不因会话需要而放宽。
   */
  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (typeof content === "string") {
      const result = await this.writeSession(path, content, context)
      if (result !== undefined) return result
    }
    return super.writeFile(path, content, context)
  }
}
