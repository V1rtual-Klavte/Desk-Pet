import { invoke } from "@tauri-apps/api/core"
import { err, FileError, ok } from "@earendil-works/pi-agent-core"
import type { Context, Result } from "@earendil-works/pi-agent-core"
import { formatError, errorCode } from "@/services/error"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

/** 宿主会话的只读适配；写入和非会话路径继续使用已有文件系统机制。 */
export class SessionFileSystem extends TauriExecutionEnv {
  constructor(cwd: string, private readonly sessionRoot: string) { super(cwd) }

  private async readSession(path: string, context: Context, maxLines?: number): Promise<Result<string, FileError> | undefined> {
    const absolute = await this.absolutePath(path, context)
    if (!absolute.ok) return absolute
    const normalized = absolute.value.replaceAll("\\", "/")
    const base = `${this.sessionRoot.replaceAll("\\", "/").replace(/\/$/, "")}/`
    // 注入自定义 sessionsRoot 的库测试仍可读自己的文件；真实会话根才走宿主域命令。
    if (!normalized.startsWith(base)) return undefined
    try {
      context.abortSignal?.throwIfAborted()
      const text = await invoke<string>("session_read_text", {
        path: normalized.slice(base.length), ...(maxLines === undefined ? {} : { maxLines }),
      })
      context.abortSignal?.throwIfAborted()
      return ok(text)
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
}
