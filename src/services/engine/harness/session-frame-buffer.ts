// ==========================================
// 会话帧写入缓冲装饰器（T1.01 判别骨架 + T1.02 缓冲状态机 + 同键 delta 合并）
//
// 帧 = `pi.pending.assistant_frame` 的 `list/append` **单写事务**，每个流式 delta 一行。
// 它是可丢的进度快照：`seq` 在 prepareCommit 时已写进 JSON 对象，`appendFile` 只负责把
// 已序列化的字节追加到文件末尾，所以「N 行合并成一次 appendFile」与「分 N 次写」逐字节
// 等价；崩溃时只丢最近一段进度，正文 entry 不受影响（T-2/T-3 的地基）。
//
// 本文件是「只合并帧」的缓冲层（源方案 §7.2 方案二）：
//   - 帧 append → 进该文件的缓冲，命中触发条件才落盘（体积达阈值 / 遇到非帧 / 读同一
//     文件 / 关闭前 flush）；
//   - 同键 delta 帧在缓冲内**合并成一条记录**（见下「同键 delta 合并」）；
//   - 其余一切读写逐字节转发，**永远立即落盘** —— entry 的持久性完全不受影响（T-3）。
//
// 同键 delta 合并（2026-10-05；用户实测「流式一个 token 一条 JSONL 记录」后的要求：
// 同类 delta 存成一条）：
//   · 合并键 = `(namespace, key, value.type, value.contentIndex)`（contentIndex 缺失时
//     按 undefined 视作同一槽位）。同槽位的 delta 帧只留下一行：`value.delta` 按到达
//     顺序字符串拼接，写对象与 `seq` 取**最后一条**帧（seq 因此是最后到达那条的 seq）。
//   · 为什么拼接与逐帧追加等价：重放侧（pi-ai 的 `reduceAssistantMessageFrames`，
//     `utils/assistant-message-frame.js`）对 text_delta / thinking_delta / toolcall_delta
//     都是「把 delta 追加进对应内容块的累积器」，同槽位拼接即同一条追加序列。
//   · 物化（把合并行落进待写行序列）的两条边界，保证绝不跨越语义边界合并：
//       ① 遇到**非 delta 帧**（同文件）时：先把当前全部合并项按最后 seq 升序物化，再放行
//          该帧 —— `*_end` 帧是全量覆盖语义（`block.text = frame.content`），绝不允许与它
//          前后的 delta 合进同一行，否则「覆盖」会被错拼成「追加」；
//       ② drain（体积阈值 / 读前 / 关闭前 flush）时：先物化再写。
//     物化后合并项清零；后续同键 delta 重新开一行（边界切分，可接受）。
//   · 顺序不变量：物化按最后 seq 升序排序，因此整文件写入行的 seq 严格递增（帧的 seq 由
//     上游提交时分配、只增）。跨槽位（不同 type/contentIndex）合并项之间的相对次序不影响
//     折叠结果 —— 不同槽位写不同内容块的累积器（text / thinking / toolCall 的 json），
//     两个槽位的 delta 谁先谁后都得到同一终态；同一槽位的 delta 始终按到达顺序承载在
//     自己的行里，次序不受这条排序影响。
//   · 字节计数：delta 进合并项时按 `value.delta` 新增的原始 UTF-8 字节累计（估算，不打包
//     一行 JSON 的行开销）；物化时按实际序列化行长度校准（`bytes += 实际行字节 - 估算`）。
//     阈值判定时机不变：仍是**入队后立刻判** `bytes >= maxBufferBytes`。
//
// 无定时器：源方案 §7.2 的触发条件都不需要时间维度，本文件不引入任何常驻定时器 API
// （这也是判据之一：出现 web 定时器的名字就算违规）。
//
// 触发语义与 scripts/session-frame-stats.mjs 的 `simulateBuffer()` 逐条一致（那是 O-5
// 阈值校准与离线校验器；本文件不反向依赖它；合并规则同步建模，改这里要同步改它）：
//   阈值判定时机 = **入队后立刻判** `bytes >= maxBufferBytes`；
//   非帧行只在缓冲非空时产生一次真实 flush（一次底层 `appendFile`）。
// ==========================================

import { ok } from "@earendil-works/pi-agent-core"
import type { Context, FileError, FileInfo, FileSystem, Result } from "@earendil-works/pi-agent-core"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("FrameBuffer")

/**
 * 帧写的命名空间，判别用的唯一锚点。
 * 真相源：`@earendil-works/pi-agent-core/harness/session/values.js` 的
 * `pendingAssistantFrames`：`list("pi.pending.assistant_frame", \`${operationId}:${responseEntryId}\`)`。
 */
const FRAME_NAMESPACE = "pi.pending.assistant_frame"

/**
 * 帧缓冲体积阈值（字节）。
 *
 * O-5 的裁定值 16 KiB。**同键 delta 合并（2026-10-05）落地后按新规则复算** —— 校准见
 * `node scripts/session-frame-stats.mjs --calibrate`（模拟与本文件的缓冲 + 合并规则一致）：
 *   · 参考会话（622 帧 append / 7.84 s / 基线 79.4 次/秒）：合并后 6 次落盘全部来自各回复
 *     收尾的非帧提交（体积触发 0 次），0.77 次/秒（104× 下降）、每次 6.5 行、全文件 39 行
 *     （合并帧/次 103.7）；8/16/32/64 KiB 在这条样本上无差别 —— 收尾提交总是先到。
 *   · 16 KiB 仍然保留，因为合并后的估算按 `value.delta` 的原始字节累计（物化时按实际行
 *     字节校准）：只有「一个槽位长时间连续流式、期间没有任何非帧写入」时体积触发才会先到。
 *   · 崩溃丢失上界 ≈ 阈值 + 每条已打开槽位的一行（载荷已计入估算，未计入的只有单行 JSON
 *     开销，百字节量级），仍是可丢的进度快照，正文 entry 不受影响（T-2/T-3）。
 */
export const FRAME_BUFFER_MAX_BYTES = 16 * 1024

/**
 * 帧缓冲落盘失败的留痕标记。
 * 场景按此常量断言文案，不复制字符串；唯一使用点是 {@link FrameBufferingFileSystem.drainPath}
 * （失败在那里被丢弃并留痕，绝不向外抛）。
 */
export const FRAME_FLUSH_FAILURE_MARK = "帧缓冲落盘失败"

export interface FrameBufferOptions {
  /** 覆盖 {@link FRAME_BUFFER_MAX_BYTES}（测试与校准用）。 */
  maxBufferBytes?: number
}

/** 阈值按**字节**计；口径与 scripts/session-frame-stats.mjs 的 `Buffer.byteLength(line, "utf8")` 一致。 */
const utf8Encoder = new TextEncoder()

function frameByteLength(content: string): number {
  return utf8Encoder.encode(content).byteLength
}

/**
 * 判别「这一行 append 的内容是不是帧」，是则返回解析出的写对象（判别与合并共用的唯一解析点）。
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
 * JSON 数组（多写事务）、同命名空间的 `list/delete`。判别只能往「更严」走，不许放宽。
 *
 * 返回整个解析对象而不是布尔：合并侧要拿 `seq` / `key` / `value` 做结构判断，
 * 同一行只解析一次（`isFrameAppendTransaction` 是它的布尔投影）。
 */
function parseFrameAppendTransaction(content: string | Uint8Array): Record<string, unknown> | null {
  if (typeof content !== "string") return null
  // appendFile 的 content 是「一行 JSON + 一个换行」；不满足这个形态的（含多行内容）都不是帧。
  if (!content.endsWith("\n")) return null
  const line = content.slice(0, -1)
  if (line.includes("\n")) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // 解析失败按「非帧」处理。这不是吞掉失败：内容随即原样走直写路径，一个字节都不会丢，
    // 失败（若下游真的失败）由 FileSystem 实现的 Result 上报。分类器没有需要留痕的错误源，
    // 真正的帧写入失败留痕在 drainPath（经 @/services/logger）。
    return null
  }

  if (Array.isArray(parsed)) return null
  if (parsed === null || typeof parsed !== "object") return null
  const write = parsed as { kind?: unknown; op?: unknown; namespace?: unknown }
  if (write.kind !== "list" || write.op !== "append" || write.namespace !== FRAME_NAMESPACE) return null
  return parsed as Record<string, unknown>
}

/**
 * 「这一行 append 的内容是不是帧」的公开判别器（缓冲分流的判据）。
 * 形状与判别口径见 {@link parseFrameAppendTransaction}；测试与场景以此函数为唯一判据，
 * 不复制字段清单。
 */
export function isFrameAppendTransaction(content: string | Uint8Array): boolean {
  return parseFrameAppendTransaction(content) !== null
}

/**
 * 一条可合并 delta 帧的字段（合并键 + 增量载荷）；形状不合的帧返回 null（按非 delta 帧走）。
 *
 * 只认 `value.type` 以 `_delta` 结尾且 `value.delta` 为字符串的帧 —— 上游的 delta 帧恰好是
 * text_delta / thinking_delta / toolcall_delta 三种（`pi-ai/utils/assistant-message-frame.d.ts`
 * 的帧联合类型），它们的重放语义都是「追加 `delta`」。带 `content` 的 `*_end`、带
 * `partial` 的 `start`、带 `json` 的 `toolcall_checkpoint` 都不在这里，绝不能合并。
 * `seq` 必须是安全整数：它要当物化排序键与新行的 seq（上游提交时分配，落盘必有）。
 */
interface DeltaFrameParts {
  seq: number
  namespace: string
  key: string
  /** 帧类型（text_delta / thinking_delta / toolcall_delta）——合并键的一半，不同槽位不互相合并。 */
  type: string
  /** 内容块下标；缺失按 undefined 视作同一槽位（合并键里归一为 null）。 */
  contentIndex: number | undefined
  /** 这一帧的增量（该槽位本次到达的增量）。 */
  delta: string
}

function deltaFrameParts(write: Record<string, unknown>): DeltaFrameParts | null {
  const seq = write.seq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null
  const namespace = write.namespace
  const key = write.key
  if (typeof namespace !== "string" || typeof key !== "string") return null
  const value = write.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { type, delta, contentIndex } = value as { type?: unknown; delta?: unknown; contentIndex?: unknown }
  if (typeof type !== "string" || !type.endsWith("_delta")) return null
  if (typeof delta !== "string") return null
  if (
    contentIndex !== undefined &&
    (typeof contentIndex !== "number" || !Number.isSafeInteger(contentIndex) || contentIndex < 0)
  ) {
    return null
  }
  return { seq, namespace, key, type, contentIndex, delta }
}

/**
 * 合并槽位键 = `(namespace, key, value.type, value.contentIndex)` 的 JSON 元组，四段用
 * JSON.stringify 整体编码（避免自己拼分隔符：namespace / key 里可能出现任意字符，
 * 元组编码天然无碰撞；contentIndex 缺失归一为 null，与数字下标不混）。
 */
function mergedDeltaSlotKey(parts: DeltaFrameParts): string {
  return JSON.stringify([parts.namespace, parts.key, parts.type, parts.contentIndex ?? null])
}

/**
 * 一个合并中的 delta 槽位。合并行 = **最后一条** delta 帧的写对象副本，只把 `value.delta`
 * 换成拼接结果（`seq` 已经是最后一条的 seq；写对象上的其余字段原样保留）。估算字节是
 * 已计入 `PathBuffer.bytes` 的 delta 原始 UTF-8 字节和，物化时校准为实际行字节。
 */
interface MergedDeltaEntry {
  lastWrite: Record<string, unknown>
  lastSeq: number
  delta: string
  estimatedBytes: number
}

/** 物化一条合并行：单写事务 JSON + 换行（与上游 `serializeTransaction` 的单写形态同形）。 */
function serializeMergedDelta(entry: MergedDeltaEntry): string {
  const value = entry.lastWrite.value as Record<string, unknown>
  return `${JSON.stringify({ ...entry.lastWrite, seq: entry.lastSeq, value: { ...value, delta: entry.delta } })}\n`
}

/**
 * 每实例、按文件路径分桶的缓冲。
 *
 * `chain` 把同一路径的**全部入队与 flush** 串成一条 FIFO 链：「先 flush 后落盘」的顺序性
 * 在并发下也成立（T-2 顺序等价、T-3 立即落盘的前提）。链上的任务不向外抛，因此（并由
 * `enqueue` 兜底）`chain` **永不 reject** —— 一次失败不能毒化后续 await。
 */
interface PathBuffer {
  chain: Promise<void>
  /** 已物化的待写行（合并行 + 非 delta 帧的原始字节）；drain 时拼成一次 `appendFile`。 */
  chunks: string[]
  /** 合并中的 delta 槽位（合并键 → 条目）；物化前不落进 `chunks`。 */
  merged: Map<string, MergedDeltaEntry>
  /**
   * 估算的待写字节：`chunks` 各行的实际 UTF-8 字节 + `merged` 各条目的 delta 估算字节。
   * 只服务阈值触发判定；合并项在物化时按实际行长度校准（见 `materializeMergedDeltas`）。
   */
  bytes: number
}

/**
 * 「当前有未落盘字节」的实例集合：模块级 {@link flushSessionFrameWrites} 只冲这些实例。
 * 排空后实例自行出集合（见 `drainPath` 尾部），集合不会长期持有已释放的实例。
 */
const pendingInstances = new Set<FrameBufferingFileSystem>()
let reportedFrameFlushFailures = 0

/**
 * `FileSystem` 装饰器：只把「帧 append」这一种输入分流出去（进缓冲，按触发条件合并落盘），
 * 其余一切逐字节透传。
 *
 * - 非帧写入（entry / usage / value / 多写事务）**永远立即落盘**，entry 的持久性完全不受
 *   影响（T-3）：先冲干净同路径缓冲，再原样转发。
 * - 读同一路径前先冲缓冲，读到的一定包含自己刚写的帧（T-4）；`remove` 走整实例 flush
 *   （路径可能是缓冲文件的父目录，只冲同级会在删目录后把文件复活）。
 * - 不做安全检查、不改写内容（路径与权限裁决在 Rust 层，这里不做第二份）。
 * - `cwd` 用 getter 转发，不复制成字段：inner 换 cwd（或换实现）后装饰器不会说谎。
 * - 操作方法的失败语义仍由 inner 的 `Result` 承载；只有「帧落盘失败」这一条按 T-5
 *   在装饰器内留痕并丢弃（上游 `progress.js:33` 的 `void write.catch(() => {})` 会吞掉它）。
 */
export class FrameBufferingFileSystem implements FileSystem {
  private readonly maxBufferBytes: number
  /**
   * 路径 → 缓冲。桶只在该路径**首次有帧入队**时同步建立（只读路径不建桶），此后不再删除：
   * 删桶会让后续任务挂到另一条链上，破坏同路径串行化，比留一个空桶危险得多。
   */
  private readonly buffers = new Map<string, PathBuffer>()

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
    // 读前 flush（触发条件 3）：读到的必须包含本实例缓冲里的帧。
    await this.flushPath(path, context)
    return this.inner.readTextFile(path, context)
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    await this.flushPath(path, context)
    return this.inner.readTextLines(path, options, context)
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    await this.flushPath(path, context)
    return this.inner.readBinaryFile(path, context)
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    // 覆盖写会作废缓冲里的帧：先落盘再覆盖，避免缓冲的字节被追加到新内容之后。
    await this.flushPath(path, context)
    return this.inner.writeFile(path, content, context)
  }

  /**
   * 帧 append → 进该路径缓冲（可合并的 delta 帧进合并槽位，其余帧物化后进待写行）；
   * 其余一切（含多写事务、`Uint8Array`、解析失败）→ 先 flush 同路径缓冲，再原样转发，
   * **自身立即落盘且不再进缓冲**（T-3）。
   */
  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const parsed = typeof content === "string" ? parseFrameAppendTransaction(content) : null
    if (parsed === null) {
      // 触发条件 2（遇到非帧）：这是天然的 flush 点 —— 每次流式都以一次 entry 提交收尾。
      // 转发前先在链上排队 flush：本次 drain 排在更早的帧入队之后，即使并发也先落帧、后落非帧。
      // drain 内部先物化合并项，因此非帧写入永远不会插到「比它早的 delta」前面。
      await this.flushPath(path, context)
      return this.inner.appendFile(path, content, context)
    }

    const frame = content as string
    const parts = deltaFrameParts(parsed)
    // 入队前先登记实例：即使这条链还没执行到，模块级 flush 也能看见它并把链等空（T-6 的
    // 「关闭前 flush」不漏在飞帧）。字节出缓冲后由 drainPath 移除登记。
    pendingInstances.add(this)
    await this.enqueue(path, async () => {
      const bucket = this.bufferFor(path)
      // 与上面的登记配对，保证不变量「字节还在内存里 ⇒ 实例在集合里」（出集合后又有新帧时
      // 重新登记，模块级 flush 不会漏掉这批字节）。
      pendingInstances.add(this)
      if (parts === null) {
        // 非 delta 帧（start / *_start / *_end / toolcall_checkpoint / 形状不合的帧）：
        // 合并的天然边界 —— 先物化再入队，合并行因此排在它前面（*_end 的覆盖语义不会被
        // 拼接吞掉；seq 顺序也因此保持严格递增：合并项的 seq 都小于本帧）。
        this.materializeMergedDeltas(bucket)
        bucket.chunks.push(frame)
        bucket.bytes += frameByteLength(frame)
      } else {
        // 同键 delta：并入槽位（delta 按到达顺序拼接，写对象与 seq 取最后一条）。
        // 估算字节按**新增的 delta 原始 UTF-8 字节**累计（行开销不计）；物化时校准。
        const addedBytes = frameByteLength(parts.delta)
        const slotKey = mergedDeltaSlotKey(parts)
        const entry = bucket.merged.get(slotKey)
        if (entry === undefined) {
          bucket.merged.set(slotKey, {
            lastWrite: parsed,
            lastSeq: parts.seq,
            delta: parts.delta,
            estimatedBytes: addedBytes,
          })
        } else {
          entry.lastWrite = parsed
          entry.lastSeq = parts.seq
          entry.delta += parts.delta
          entry.estimatedBytes += addedBytes
        }
        bucket.bytes += addedBytes
      }
      if (bucket.bytes >= this.maxBufferBytes) {
        // 触发条件 1（体积达阈值）：入队后立刻判，与 simulateBuffer() 的判定时机一致
        // （合并项按 delta 估算字节计；drain 内部先物化并校准为实际行字节）。
        // 这里直接写盘而不是再走 flushPath —— 已经在链任务里，再入队就是等自己（死锁）。
        await this.drainPath(path, context)
      }
    })
    // 字节已经进缓冲，对调用方就是成功：真正的落盘失败由 drainPath 留痕并按 T-2 丢弃，
    // 不经 Result 上报（上游 progress.js:33 的 `void write.catch(() => {})` 也不看它）。
    return ok(undefined)
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    // 源与目标都要冲：源上的缓冲若晚于 rename 落盘，字节会被追加到「已经不在了」的旧路径；
    // 目标上的缓冲若晚于 rename 落盘，字节会追加到刚搬进来的文件后面，把内容搞乱。
    await this.flushPath(sourcePath, context)
    await this.flushPath(destinationPath, context)
    return this.inner.renameFile(sourcePath, destinationPath, context)
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    await this.flushPath(path, context)
    return this.inner.fileInfo(path, context)
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.inner.listDir(path, context)
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    await this.flushPath(path, context)
    return this.inner.canonicalPath(path, context)
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    await this.flushPath(path, context)
    return this.inner.exists(path, context)
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.inner.createDir(path, options, context)
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    // 路径可能是缓冲文件的父目录：只冲同级路径会在删目录之后把文件复活。整实例排水后再删。
    await this.flushAll(context)
    return this.inner.remove(path, options, context)
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempDir(prefix, context)
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempFile(options, context)
  }

  /**
   * 关闭前先排水（T-6 的装饰器侧：上游没有统一关闭出口，flush 必须显式调用），随后转发
   * `inner.cleanup`。`FileSystem` 契约要求 cleanup best-effort、**不得 throw 或 reject**：
   * `try/finally` 保证排水出问题也不跳过 `inner.cleanup`，两处失败都降级为 warn 而不是
   * 让装饰器 reject（帧落盘失败的唯一留痕点是 drainPath）。
   */
  async cleanup(context: Context): Promise<void> {
    try {
      await this.flushAll(context)
    } catch (error) {
      // 防御分支：flushAll 不抛（链上任务不向外抛）。真抛了也不能因此跳过关闭。
      log.warn("帧缓冲关闭前排水异常（不应发生）:", formatError(error))
    } finally {
      try {
        await this.inner.cleanup(context)
      } catch (error) {
        log.warn("底层 FileSystem cleanup 失败（best-effort，不阻塞关闭）:", formatError(error))
      }
    }
  }

  /**
   * 冲该实例当前全部待写路径（T-6 的关闭前 flush 之一）。
   * 契约要求不抛：flushPath 已把失败留痕并丢弃，这里的 await 不会 reject。
   */
  async flush(context: Context): Promise<void> {
    await this.flushAll(context)
  }

  /**
   * 冲某个路径的缓冲：把一次 drain 排到该路径链尾再等待（返回的 Promise 永不 reject）。
   * 「先 flush 后落盘」靠的就是这个排队位置 —— drain 排在更早的帧入队之后，后到的非帧与
   * 读只有等它完成才会转发给 inner。
   */
  private flushPath(path: string, context: Context): Promise<void> {
    // 没有桶 = 该路径从未有过帧入队（桶在 appendFile 命中帧时同步建立），也就没有需要先
    // 落盘的字节：直接完成，不为只读路径建立空桶。
    if (!this.buffers.has(path)) return Promise.resolve()
    return this.enqueue(path, () => this.drainPath(path, context))
  }

  /**
   * 把任务挂到该路径链尾并等待。返回的 Promise **永不 reject**：任务自身不抛（失败只有
   * drainPath 一种，已在内部留痕并丢弃），`.catch` 是链完整性的兜底 —— 一次失败若污染
   * 链，之后所有 await 都会立刻 reject，同路径的 flush 与转发就全废了。
   */
  private enqueue(path: string, task: () => Promise<void>): Promise<void> {
    const bucket = this.bufferFor(path)
    const next = bucket.chain.then(task).catch(() => {})
    bucket.chain = next
    return next
  }

  /** 取（必要时建立）该路径的桶；见 `buffers` 的注释：桶只增不删。 */
  private bufferFor(path: string): PathBuffer {
    let bucket = this.buffers.get(path)
    if (bucket === undefined) {
      bucket = { chain: Promise.resolve(), chunks: [], merged: new Map(), bytes: 0 }
      this.buffers.set(path, bucket)
    }
    return bucket
  }

  /**
   * 该实例是否还有未落盘字节（决定它是否留在模块级 flush 集合里）。
   * 合并项里的 delta 同样是「还在内存里的字节」，必须一起算 —— 漏算会让集合提前释放实例，
   * 关闭前的模块级 flush 就会丢最后一段合并中的 delta。
   */
  private hasPendingBytes(): boolean {
    for (const bucket of this.buffers.values()) {
      if (bucket.chunks.length > 0 || bucket.merged.size > 0) return true
    }
    return false
  }

  /**
   * 把当前全部合并项按**最后 seq 升序**物化进待写行，并把它们的估算字节校准为实际行字节。
   *
   * 排序的理由与安全论证见文件头「顺序不变量」：整文件写入行的 seq 必须严格递增；
   * 跨槽位的相对次序不影响重放结果（不同槽位写不同内容块累积器）。
   * 只有链任务内可以调用（与 chunks / merged 的读写共享同一条串行化链）。
   */
  private materializeMergedDeltas(bucket: PathBuffer): void {
    if (bucket.merged.size === 0) return
    const entries = [...bucket.merged.values()].sort((left, right) => left.lastSeq - right.lastSeq)
    for (const entry of entries) {
      const line = serializeMergedDelta(entry)
      bucket.chunks.push(line)
      // 校准：该槽位累计时的估算字节换成这一行的实际字节（行开销、JSON 转义差都在这里补齐）。
      bucket.bytes += frameByteLength(line) - entry.estimatedBytes
    }
    bucket.merged.clear()
  }

  /**
   * 冲该实例的全部路径：快照后逐路径等待链排空（桶只在该路径有过帧入队时存在）。
   * 快照之后新发生的写入属于「flush 之后」的事件，不回头补 —— 否则 flush 无终止。
   */
  private async flushAll(context: Context): Promise<void> {
    for (const path of [...this.buffers.keys()]) {
      await this.flushPath(path, context)
    }
  }

  /**
   * 链任务内执行的一次真实落盘：先把合并项物化进待写行，再原子取出、拼成一个字符串、
   * **一次** `inner.appendFile`（FIFO 与合并等价性都由这里保证）。
   *
   * 失败处置（T-5）：留痕**一次**后丢弃这批字节、**不重试**、**绝不向外抛**。
   *   ① 为什么丢弃：帧是进度快照，正文 entry 不在缓冲里（非帧永远立即落盘，T-3），
   *      丢的只是最近一段流式进度，正文与 seq 都不受影响。
   *   ② 为什么不重试：重试会让失败批一直占着内存等下一次触发（缓冲无界增长），并且会
   *      打乱它与后续写入的先后顺序。丢弃只在 seq 序列上留一个洞 —— **洞是重放安全的**
   *      （执行方案 §0.2：`validateCommittedWrites` 只要求严格递增，重放侧
   *      `nextSeq = write.seq + 1`，见 `commit.js:33-40` / `in-memory-storage-state.js:105`）。
   *      合并没有改变这点：丢掉的是若干**行**，每行内部自洽（同一槽位的一段连续 delta），
   *      行与行之间仍然只丢「最近一段」，不产生乱序。
   *   ③ 根因留痕点就是本函数下方那条 error 级日志（本文件唯一一处）：上游 `progress.js:33` 的
   *      `void write.catch(() => {})` 会把帧写失败吞掉，调用方拿不到（`write()` 返回 void，
   *      `drain()` 只 await `latest`），返回的 `Result.err` 也没人看 —— 留痕只能在这里做。
   *
   * 只能在链任务里调用（调用方已在链上）；直接调用会绕过串行化，也会与正在排队的
   * 入队/flush 抢顺序。
   */
  private async drainPath(path: string, context: Context): Promise<void> {
    const bucket = this.buffers.get(path)
    if (bucket === undefined) return
    // 先物化（触发条件里的「drain 时先物化再写」）：合并中的 delta 属于这次落盘。
    this.materializeMergedDeltas(bucket)
    if (bucket.chunks.length === 0) return

    // 原子取出：先清空缓冲再写盘。取出后新到的帧进新的数组，不会被这次写重复带走；
    // 失败时被丢弃的也正好是这一批（写盘期间链上不会有别的任务碰到它们）。
    const chunks = bucket.chunks
    const bytes = bucket.bytes
    // 日志口径是**行数**：合并后行数 ≠ 原始帧数，字段因此从 frames 更名为 lines，
    // 避免读者把合并后的行数误当原始帧数（消费者只按 FRAME_FLUSH_FAILURE_MARK 判失败留痕）。
    const lines = chunks.length
    bucket.chunks = []
    bucket.bytes = 0
    const joined = chunks.join("")

    let failed = false
    let failure: unknown
    try {
      const written = await this.inner.appendFile(path, joined, context)
      if (!written.ok) {
        failed = true
        failure = written.error
      }
    } catch (error) {
      // inner 违约把失败抛出而不是返回 Result.err：两条通道同一条处置。
      failed = true
      failure = error
    }
    if (failed) {
      reportedFrameFlushFailures += 1
      log.error(FRAME_FLUSH_FAILURE_MARK, { path, lines, bytes }, formatError(failure))
    }

    // 缓冲已排空（写成功或按上文丢弃）：没有待写字节就退出模块级集合，避免集合持有实例。
    // 之后新到的帧会在入队时重新登记，不变量不受影响。
    if (!this.hasPendingBytes()) pendingInstances.delete(this)
  }
}

/**
 * 模块级 flush：把**当前**有未落盘字节的实例逐个排空。
 *
 * 存在的理由（执行方案 §0.3）：上游从 `HarnessSlot.close()` 到 `storage.close()` 全链路
 * 一次 `FileSystem` 调用都没有，**没有统一关闭出口** —— 会话句柄释放点（`releasePiSession`，
 * 接线见 T1.04）必须显式调用本函数；上游 `cleanup` 也无人调用。
 *
 * 只冲登记过的实例（快照；flush 期间新入队的写入属于之后的事件），永不抛出。
 */
export async function flushSessionFrameWrites(context: Context): Promise<number> {
  const failuresBefore = reportedFrameFlushFailures
  for (const fileSystem of [...pendingInstances]) {
    await fileSystem.flush(context)
  }
  return reportedFrameFlushFailures - failuresBefore
}
