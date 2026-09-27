// ==========================================
// 会话帧写入缓冲装饰器（W1 / T1.01 骨架）
//
// 帧 = `pi.pending.assistant_frame` 的 `list/append` **单写事务**，每个流式 delta 一行。
// 它是可丢的进度快照：`seq` 在 prepareCommit 时已写进 JSON 对象，`appendFile` 只负责把
// 已序列化的字节追加到文件末尾，所以「N 行合并成一次 appendFile」与「分 N 次写」逐字节
// 等价；崩溃时只丢最近一段进度，正文 entry 不受影响（T-2/T-3 的地基）。
//
// 本任务（T1.01）只落「判别 + 完整转发」的骨架：装饰器还没有缓冲，`appendFile` 与其余
// 16 个方法一律逐字节直通 inner。缓冲状态机与三个触发条件（体积达阈值 / 遇到非帧 / 读同
// 一文件）由 T1.02 在本文件填充，flush 的消费点（会话句柄释放）由 T1.03 接线。
//
// 无定时器：源方案 §7.2 的三个触发条件都不需要时间维度，本文件不引入任何常驻定时器 API
// （这也是判据之一：出现 web 定时器的名字就算违规）。
// ==========================================

import type { Context, FileError, FileInfo, FileSystem, Result } from "@earendil-works/pi-agent-core"

/**
 * 帧写的命名空间，判别用的唯一锚点。
 * 真相源：`@earendil-works/pi-agent-core/harness/session/values.js` 的
 * `pendingAssistantFrames`：`list("pi.pending.assistant_frame", \`${operationId}:${responseEntryId}\`)`。
 */
const FRAME_NAMESPACE = "pi.pending.assistant_frame"

/**
 * 帧缓冲体积阈值（字节）。
 *
 * O-5 的裁定值 16 KiB：用参考会话（2056 帧 append / 16.5 s / 基线 124.8 次/秒）按本装饰器
 * 规则复算，落到 1.94 次/秒（64× 下降）；崩溃丢失上界 = 阈值 + 单帧最大行长 ≈ 18 KB 的
 * 进度快照，正文 entry 不受影响。
 * 校准见 scripts/session-frame-stats.mjs --calibrate（模拟规则与本文件 T1.02 的实现一致）。
 */
export const FRAME_BUFFER_MAX_BYTES = 16 * 1024

export interface FrameBufferOptions {
  /** 覆盖 {@link FRAME_BUFFER_MAX_BYTES}（测试与校准用）。 */
  maxBufferBytes?: number
}

/**
 * 判别「这一行 append 的内容是不是帧」。
 *
 * 上游 `appendFile` 只有一处（`harness/session/jsonl/storage.js`）：传入
 * `${serializeTransaction(writes)}\n` —— 单写事务落成单个 JSON 对象，多写事务落成 JSON 数组。
 * 帧 append 是单写事务：`{kind:"list", op:"append", namespace:"pi.pending.assistant_frame", …}`。
 *
 * **为什么不用子串匹配**（源方案 §7.2 的「含命名空间」按字面照做会错）：
 * ① 同一个会话文件里 `list/delete` 行也含该命名空间，子串判会多算 —— 参考会话实测
 *    2065 vs 2056 行，多出的 9 行正是 delete；
 * ② 帧 delete 一旦被当成「帧」进缓冲，就会把同一个多写事务（`[entry, list/delete, usage,
 *    value/set]`）里的 `entry` 提交一起推迟，直接违反 T-3「非帧写入永远立即落盘」。
 * 所以必须解析后做**结构性**判别：恰好单写（非数组）+ kind/op/namespace 三字段全中。
 *
 * 其余一切一律按「非帧」处理：`Uint8Array`、不以换行结尾、内容里还有换行、解析失败、
 * JSON 数组（多写事务）、同命名空间的 `list/delete`。
 */
export function isFrameAppendTransaction(content: string | Uint8Array): boolean {
  if (typeof content !== "string") return false
  // appendFile 的 content 是「一行 JSON + 一个换行」；不满足这个形态的（含多行内容）都不是帧。
  if (!content.endsWith("\n")) return false
  const line = content.slice(0, -1)
  if (line.includes("\n")) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // 解析失败按「非帧」处理。这不是吞掉失败：内容随即原样走直写路径，一个字节都不会丢，
    // 失败（若下游真的失败）由 FileSystem 实现的 Result 上报。分类器没有需要留痕的错误源，
    // 真正的帧写入失败留痕在 T1.02 的 flush（经 @/services/logger）。
    return false
  }

  if (Array.isArray(parsed)) return false
  if (parsed === null || typeof parsed !== "object") return false
  const write = parsed as { kind?: unknown; op?: unknown; namespace?: unknown }
  return write.kind === "list" && write.op === "append" && write.namespace === FRAME_NAMESPACE
}

/**
 * `FileSystem` 装饰器：只把「帧 append」这一种输入分流出去（T1.02 起进缓冲），
 * 其余一切逐字节透传。
 *
 * - 非帧写入（entry / usage / value / 多写事务）**永远立即落盘**，entry 的持久性完全不受
 *   影响（T-3）—— 因此 16 个非 appendFile 方法与 appendFile 本任务全部是纯转发：
 *   不缓存、不改写、不做安全检查（路径与权限裁决在 Rust 层，这里不做第二份）。
 * - `cwd` 用 getter 转发，不复制成字段：inner 换 cwd（或换实现）后装饰器不会说谎。
 * - 操作方法的失败语义仍由 inner 的 `Result` 承载，装饰器不吞不造新的错误形态。
 */
export class FrameBufferingFileSystem implements FileSystem {
  /** 体积阈值；T1.02 的触发条件 1 消费，本任务只解析并保存。 */
  private readonly maxBufferBytes: number

  constructor(private readonly inner: FileSystem, options: FrameBufferOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? FRAME_BUFFER_MAX_BYTES
  }

  get cwd(): string {
    return this.inner.cwd
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.inner.absolutePath(path, context)
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.inner.joinPath(parts, context)
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.inner.readTextFile(path, context)
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.inner.readTextLines(path, options, context)
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.inner.readBinaryFile(path, context)
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.inner.writeFile(path, content, context)
  }

  /** T1.02 在这里接 `isFrameAppendTransaction`：命中进缓冲，未命中先 flush 再直写。 */
  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.inner.appendFile(path, content, context)
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.inner.renameFile(sourcePath, destinationPath, context)
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.inner.fileInfo(path, context)
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.inner.listDir(path, context)
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.inner.canonicalPath(path, context)
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.inner.exists(path, context)
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.inner.createDir(path, options, context)
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.inner.remove(path, options, context)
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempDir(prefix, context)
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempFile(options, context)
  }

  /** T1.02 在这里加 flush 包裹（释放资源前先清缓冲），本任务纯转发。 */
  async cleanup(context: Context): Promise<void> {
    return this.inner.cleanup(context)
  }

  /**
   * 冲该实例的全部待写路径；契约要求不抛（对应 `FileSystem.cleanup` 的 best-effort 口径）。
   * 本任务装饰器还没有任何缓冲，所以这里本来就是空操作 —— T1.02 填充缓冲与真实 flush，
   * 届时本方法要能等到「缓冲清空或按 T-2 丢弃」为止。
   */
  async flush(context: Context): Promise<void> {}
}
