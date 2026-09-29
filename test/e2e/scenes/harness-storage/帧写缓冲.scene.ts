// ==========================================
// 帧写缓冲场景（T1.05）—— 把 T1.01–T1.04 的五种触发行为钉成可执行断言
//
// 被测实现的真实帧写入路径（执行方案 §0.2 已核实）：
//   `harness/runtime/progress.js` 每个流式 delta 一次 `lane.command`
//     → `{ kind: "commit", writes: [commitWrite(item)] }`
//     → `JsonlStorage.applyCommit`（`harness/session/jsonl/storage.js:172-182`）
//     → `fileSystem.appendFile`（`storage.js:178`，全仓唯一一处 appendFile）。
//   单写事务落成「单个 JSON 对象 + 换行」（`serializeTransaction` = `JSON.stringify(writes[0])`）；
//   帧 append 正是单写事务（`progress.js:45` 的
//   `appendList(pendingAssistantFrames(opId, respEntryId), frame)`）。
//
// 为什么由 `session.appendList(...)` 驱动真实 commit，而不是手拼 JSON 行：
//   ① 行里的 `seq` 由 `prepareStorageCommit` 在提交时分配、`validateCommittedWrites` 校验；
//      手拼会绕过 seq 分配与校验，落盘字节与真实帧不同形 —— 断言就退化成「测试自己写的
//      JSON 自己认」，判别的「单写事务」形态也无从验证；
//   ② `appendList` / `pendingAssistantFrames` 都是上游公开 API，样本因此与生产同源。
//   （直连装饰器的 check 6/7/8 用 `frameLine()` 造样：上游 write 构造器 + 上游序列化形态，
//   同样不是手写 JSON 字面量。）
//
// 判别依据（执行方案 §0.2 的口径收紧）：解析该行 → 展开成事务 → **恰好 1 条写**，且
//   `kind === "list" && op === "append" && namespace === "pi.pending.assistant_frame"`。
//   子串匹配会多算（同一文件里 `list/delete` 行也含该命名空间，参考会话实测 2065 vs 2056），
//   而且帧 delete 一旦进缓冲，就会把同一多写事务里的 entry 提交一起推迟，直接违反 T-3。
//   本场景一律用生产判别器 `isFrameAppendTransaction` 当「这一行是帧」的判据，不复制文案、
//   不复制字段清单。
//
// 触发条件没有时间维度：体积达阈值 / 遇到非帧 / 读同一路径 / 显式 flush（关闭前）。
//   本场景不使用任何定时器 API；缓冲里的字节只在上述四个时机落盘。
//
// `entry: "unit"`：只走真实 Rust IPC 与真实 commit 路径，不跑模型。
// ==========================================

import { BACKGROUND_CONTEXT, err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { appendList, pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import {
  createPiSessionRepo,
  FRAME_BUFFER_MAX_BYTES,
  FRAME_FLUSH_FAILURE_MARK,
  FrameBufferingFileSystem,
  flushSessionFrameWrites,
} from "@/services/engine/pi"
// 判别器是「这一行是帧」的唯一真相源，但没进 barrel（barrel 只导出四个名字）；
// 场景按需直连该模块，不去改动冻结中的实现目录。
import { isFrameAppendTransaction } from "@/services/engine/pi/session-frame-buffer"
import type { PiSessionRepo } from "@/services/engine/pi"
import { acquirePiSession, createPiSession, deletePiSession, releasePiSession } from "@/services/session"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import type { SceneDef } from "../../../host/types"

type JsonlSession = Session<JsonlSessionMetadata>

const textEncoder = new TextEncoder()

/** 字节口径与 Rust 侧 `content.len()`（`tool_exec.rs` 的单次写上限校验）一致，不用 `String.length`。 */
function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

// ── 仪器（只在场景内定义，不新增生产 API）──

type AppendOp = { method: "appendFile"; path: string; bytes: number; content: string | Uint8Array }
type ReadOp = { method: "readTextFile"; path: string }
type FsOp = AppendOp | ReadOp

/**
 * 记录底层 `appendFile` 调用的字节数（UTF-8 口径）与内容，并按调用顺序记下读操作
 * —— check 3 要用「读之前紧邻的一条是 appendFile」当「先 flush 后读」的顺序证据。
 * 它同时是「未包装」的读取入口：装饰器包的是它，直接调它的方法即绕过装饰器直读磁盘。
 */
class CountingEnv extends TauriExecutionEnv {
  readonly ops: FsOp[] = []

  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? byteLength(content) : content.byteLength
    this.ops.push({ method: "appendFile", path, bytes, content })
    return super.appendFile(path, content, context)
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    this.ops.push({ method: "readTextFile", path })
    return super.readTextFile(path, context)
  }
}

/** 每次 `appendFile` 都以一个 `FileError` 失败，并记下失败批的内容（check 5 判「丢弃不重放」）。 */
class FailingEnv extends TauriExecutionEnv {
  readonly attempts: { path: string; content: string }[] = []

  override async appendFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    this.attempts.push({ path, content: typeof content === "string" ? content : "" })
    return err(new FileError("unknown", "注入的落盘失败", path))
  }

  /** 取当前尝试数。不直接比较 `attempts.length`：控制流会在上一处断言后把它收窄成字面量。 */
  attemptCount(): number {
    return this.attempts.length
  }
}

function appendOps(env: CountingEnv): AppendOp[] {
  return env.ops.filter((op): op is AppendOp => op.method === "appendFile")
}

/** 底层实收字节流（按调用顺序拼接）；收到非字符串内容即判失败，不静默跳过。 */
function concatAppends(ops: readonly AppendOp[]): string {
  let text = ""
  for (const op of ops) {
    if (typeof op.content !== "string") throw new Error(`appendFile 收到非字符串内容: ${op.path}`)
    text += op.content
  }
  return text
}

/** 可区分的帧 delta：前缀 + 定长填充，保证「逐项相等」可判且行长落在预期区间。 */
function delta(prefix: string, index: number, pad: number): string {
  return `帧-${prefix}-${index}-${"x".repeat(pad)}`
}

/**
 * 一条帧 append 行：上游 write 构造器（`appendList(pendingAssistantFrames(...))`）+ 上游
 * 序列化形态（`JSON.stringify(writes[0]) + "\n"`）。`seq` 由提交时分配，这里没有 ——
 * 判别器不看 `seq`，check 6/7/8 的字节比对也只需要内容逐字节可控。
 */
function frameLine(operationId: string, responseEntryId: string, frameDelta: string): string {
  return `${JSON.stringify(appendList(pendingAssistantFrames(operationId, responseEntryId), { type: "thinking_delta", contentIndex: 0, delta: frameDelta }))}\n`
}

/** 走公开 Session API 推一条真实 thinking_delta 帧（真实 commit 路径）。 */
function pushFrame(session: JsonlSession, operationId: string, responseEntryId: string, frameDelta: string): Promise<void> {
  return session.appendList(pendingAssistantFrames(operationId, responseEntryId), { type: "thinking_delta", contentIndex: 0, delta: frameDelta }, BACKGROUND_CONTEXT)
}

/** 原始文件里的帧 append 行，按文件顺序取 delta；非帧行（header / value/set / 多写事务）跳过。 */
function frameDeltas(content: string): string[] {
  const deltas: string[] = []
  for (const line of content.split("\n")) {
    if (line === "" || !isFrameAppendTransaction(`${line}\n`)) continue
    const parsed = JSON.parse(line) as { value?: { delta?: unknown } }
    const value = parsed.value
    if (typeof value?.delta !== "string") throw new Error(`帧行缺少字符串 delta: ${line.slice(0, 80)}`)
    deltas.push(value.delta)
  }
  return deltas
}

/** 原始文件里是否存在值等于 `expected` 的 `value/set` 行（非帧写入立即落盘的证据）。 */
function hasValueSetLine(content: string, expected: string): boolean {
  for (const line of content.split("\n")) {
    if (line === "") continue
    const parsed = JSON.parse(line) as { kind?: unknown; op?: unknown; value?: unknown }
    if (parsed.kind === "value" && parsed.op === "set" && parsed.value === expected) return true
  }
  return false
}

/** 把字节流按行拆回原样（每行补回换行）；用于把旁路路径实收的字节重放进装饰器。 */
function linesOf(stream: string): string[] {
  return stream.split("\n").filter(line => line !== "").map(line => `${line}\n`)
}

// ── check 1/2 共用的突发夹具 ──

const BURST_FRAMES = 200
const BURST_PAD = 180
const BURST_OP = "op-throttle"
const BURST_RESP = "resp-throttle"

interface BurstFixture {
  /** 未包装的 env：直读磁盘，绕过装饰器（也就绕过读前 flush）。 */
  plain: TauriExecutionEnv
  counting: CountingEnv
  repo: PiSessionRepo
  session: JsonlSession
  root: string
  /** 已推入帧的 delta，按推入顺序。 */
  pushed: string[]
  /** 夹具所属 trial：模块级变量跨 trial 存活（同页复用），trial 变了必须重建。 */
  trial: number
}

let burst: BurstFixture | undefined

/**
 * 突发夹具：临时根 + 注入 CountingEnv 的仓库（装饰器默认开，生产默认值）。
 * check 1 推 200 条真实帧，check 2 接着用同一实例（断言缓冲未满时的非帧触发）。
 */
async function burstFixture(trial: number): Promise<BurstFixture> {
  if (burst && burst.trial === trial) return burst
  if (burst) {
    // 上一 trial 的夹具（例如上一轮在 check 1 中途超时被放弃）：先收尾再重建，
    // 否则计数与缓冲状态会跨 trial 串味。
    const stale = burst
    burst = undefined
    await disposeBurst(stale)
  }
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = fileOk(await plain.createTempDir("deskpet-live-framebuf-", BACKGROUND_CONTEXT))
  const counting = new CountingEnv(root)
  const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root, fileSystem: counting })
  const session = await repo.create({ id: "frame-throttle" }, BACKGROUND_CONTEXT)
  burst = { plain, counting, repo, session, root, pushed: [], trial }
  return burst
}

async function disposeBurst(fixture: BurstFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  await fixture.session.close(context)
  // 句柄关闭不碰文件（§0.3）；但装饰器可能仍持有字节，且实例留在模块级注册表里 ——
  // 冲一次把残留字节落到临时根、并让它出集合，不给后续检查留跨实例的意外 flush。
  await flushSessionFrameWrites(context)
  await fixture.repo.close(context)
  await fixture.plain.remove(fixture.root, { recursive: true, force: true }, context)
}

export const 帧写缓冲: SceneDef = {
  meta: {
    caseId: "harness-frame-write-buffer",
    module: "harness-storage",
    contractId: "hs-05",
    description: "帧缓冲合并、触发时机、读前/关闭前 flush、失败留痕与 O-9 旁路",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "frame-throttle", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "逐条钉住帧缓冲的合并、触发、读前/关闭前 flush、失败留痕与旁路开关",
    userText: "校验帧写入缓冲装饰器的五种触发行为。",
    checks: [
      {
        // T-1 机制口径 + T-2 replay 等价。
        type: "expectFrameBurstIsMergedAndReplayEquivalent",
        run: async (ctx) => {
          const fixture = await burstFixture(ctx.trial)
          const { counting, session } = fixture
          for (let index = 0; index < BURST_FRAMES; index++) {
            const frameDelta = delta("throttle", index, BURST_PAD)
            fixture.pushed.push(frameDelta)
            await pushFrame(session, BURST_OP, BURST_RESP, frameDelta)
          }

          // ① 机制口径：总字节按底层**实收**字节求和（未落盘的尾部不在其中）。
          //    这个不等式同时挡住两种错误：不合并 → 调用数 200 ≫ 上界；丢帧 → 上界收紧。
          const appends = appendOps(counting)
          const byteTotal = appends.reduce((sum, op) => sum + op.bytes, 0)
          const maxCalls = Math.ceil(byteTotal / FRAME_BUFFER_MAX_BYTES) + 1
          if (appends.length < 1) throw new Error("突发期间底层必须至少发生一次 appendFile")
          if (appends.length > maxCalls) {
            throw new Error(
              `帧写入未合并：${BURST_FRAMES} 帧产生 ${appends.length} 次 appendFile（实收 ${byteTotal} B，` +
              `上界 ${maxCalls} = ⌈字节/${FRAME_BUFFER_MAX_BYTES}⌉+1，合并率 ${(BURST_FRAMES / appends.length).toFixed(1)}×）`,
            )
          }

          // ② replay 等价：会话读路径按序读回全部帧，内容逐项与推入顺序一致。
          const elements = await session.readList(pendingAssistantFrames(BURST_OP, BURST_RESP), { order: "asc" }, BACKGROUND_CONTEXT)
          if (elements.length !== BURST_FRAMES) {
            throw new Error(`读回的帧数 ${elements.length} ≠ 推入的 ${BURST_FRAMES}`)
          }
          elements.forEach((element, index) => {
            const value = element.value
            if (value.type !== "thinking_delta") throw new Error(`第 ${index} 条帧类型应为 thinking_delta，实际 ${value.type}`)
            const expected = fixture.pushed[index]
            if (value.delta !== expected) {
              throw new Error(`第 ${index} 条帧内容与推入顺序不符：期望 ${expected.slice(0, 24)}…，实际 ${value.delta.slice(0, 24)}…`)
            }
          })
        },
      },
      {
        // T-3：非帧写入先冲干净缓冲，再自身立即落盘。
        type: "expectNonFrameWriteFlushesThenLandsImmediately",
        run: async (ctx) => {
          const fixture = await burstFixture(ctx.trial)
          const { plain, session } = fixture
          try {
            // 缓冲未满：再推一条帧（盘上还没有它），随后一次非帧写入必须先把缓冲冲干净。
            const trigger = delta("throttle-trigger", 0, BURST_PAD)
            await pushFrame(session, BURST_OP, BURST_RESP, trigger)
            const sessionName = "帧节流探针"
            await session.setName(sessionName, BACKGROUND_CONTEXT)

            // 未包装的 env 直读原始文件：读的是磁盘，绕过装饰器（因此也绕过了读前 flush）。
            const content = fileOk(await plain.readTextFile(session.metadata.path, BACKGROUND_CONTEXT))

            // ① 非帧写入（value/set）已经在盘上。
            if (!hasValueSetLine(content, sessionName)) {
              throw new Error(`非帧的 value/set 行未立即落盘: ${sessionName}`)
            }

            // ② 缓冲里的帧（含刚推入的那条）被先冲干净：盘上帧序列必须与推入顺序逐项一致、
            //    一条不少 —— 合并只改变分组，不改变顺序也不丢内容。
            const expected = [...fixture.pushed, trigger]
            const onDisk = frameDeltas(content)
            if (onDisk.length !== expected.length) {
              throw new Error(`非帧写入前应把缓冲全部冲落：盘上 ${onDisk.length} 条帧 ≠ 推入 ${expected.length} 条`)
            }
            onDisk.forEach((frameDelta, index) => {
              if (frameDelta !== expected[index]) throw new Error(`盘上第 ${index} 条帧与推入顺序不符`)
            })

            // ③ 顺序证据：最后一条帧行排在 value/set 行之前（先 flush 后落非帧）。
            const lastFrameAt = content.lastIndexOf(trigger)
            const nameAt = content.indexOf(`"${sessionName}"`)
            if (lastFrameAt < 0 || nameAt < 0 || lastFrameAt > nameAt) {
              throw new Error(`缓冲帧应排在非帧写入之前：最后一条帧 @${lastFrameAt}，value/set 行 @${nameAt}`)
            }
          } finally {
            burst = undefined
            await disposeBurst(fixture)
          }
        },
      },
      {
        // T-4：读同一路径前先 flush，且顺序证据（先 appendFile 后 readTextFile）。
        type: "expectReadFlushesBufferedFramesFirst",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await plain.createTempDir("deskpet-live-framebuf-read-", context))
          try {
            const counting = new CountingEnv(root)
            const decorated = new FrameBufferingFileSystem(counting)
            const path = `${root}/read-flush.jsonl`
            const header = `${JSON.stringify({ v: 4, kind: "header", probe: "读前 flush" })}\n`
            fileOk(await plain.writeFile(path, header, context))

            const pushed = [0, 1, 2].map(index => frameLine("op-read", "resp-read", delta("read", index, BURST_PAD)))
            for (const line of pushed) fileOk(await decorated.appendFile(path, line, context))

            // 子步骤①：未包装 env 直读——盘上只有 header，帧都还在缓冲里（远未到体积阈值）。
            const before = fileOk(await plain.readTextFile(path, context))
            if (before !== header) {
              throw new Error(`缓冲未满时盘上不应出现新帧：实际 ${before.length} B（期望 ${header.length} B）`)
            }

            // 子步骤②：装饰器读同一路径 → 返回内容必须包含全部缓冲帧（读前 flush），逐字节相等。
            const after = fileOk(await decorated.readTextFile(path, context))
            if (after !== header + pushed.join("")) {
              throw new Error(`装饰器读到的内容不完整：实际 ${byteLength(after)} B，期望 ${byteLength(header + pushed.join(""))} B`)
            }

            // 子步骤③ 顺序证据：底层 ops 末尾两条是 appendFile → readTextFile（先 flush 后读）。
            const tail = counting.ops.slice(-2)
            if (tail.length !== 2 || tail[0]?.method !== "appendFile" || tail[1]?.method !== "readTextFile") {
              throw new Error(`读前 flush 的顺序证据不成立：ops 末尾为 ${JSON.stringify(tail)}`)
            }
          } finally {
            await plain.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // T-6 接线：releasePiSession → flushSessionFrameWrites（应用单例会话层走一遍真实接线）。
        type: "expectCloseFlushesThroughSessionLayer",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const raw = new TauriExecutionEnv(await runtimePath("data"))
          const summary = await createPiSession("帧节流关闭探针")
          try {
            const session = await acquirePiSession(summary.id)
            const path = session.metadata.path
            const pushed = [0, 1, 2].map(index => delta("关闭", index, BURST_PAD))
            for (const frameDelta of pushed) await pushFrame(session, "op-close", "resp-close", frameDelta)

            // 缓冲未满（3 帧 ≈ 1 KiB ≪ 阈值）：盘上还没有这批帧。这里同时钉住一条假设：
            // 缓冲是**每装饰器实例**的，只有本仓库实例自己的 flush 会写它。
            const before = fileOk(await raw.readTextFile(path, context))
            for (const frameDelta of pushed) {
              if (before.includes(frameDelta)) throw new Error(`释放前盘上不应有缓冲帧: ${frameDelta.slice(0, 24)}…`)
            }

            await releasePiSession(summary.id)

            const after = fileOk(await raw.readTextFile(path, context))
            let cursor = -1
            for (const frameDelta of pushed) {
              const at = after.indexOf(frameDelta)
              if (at <= cursor) throw new Error(`释放后帧未按序落盘: ${frameDelta.slice(0, 24)}…`)
              cursor = at
            }

            // 更强的证据：文件最后一行就是最后一条帧 —— 关闭路径自己一次 FileSystem 调用都没有
            // （§0.3），这段字节只可能来自 releasePiSession 的 flush，且其后没有别的写入。
            const lines = after.split("\n").filter(line => line !== "")
            const lastLine = lines[lines.length - 1] ?? ""
            if (!isFrameAppendTransaction(`${lastLine}\n`) || !lastLine.includes(pushed[pushed.length - 1] ?? "")) {
              throw new Error(`文件末行应是最后一条帧（由释放时的 flush 写入）: ${lastLine.slice(0, 80)}`)
            }
          } finally {
            // 收尾删除：失败留在句柄缓存里的会话由下一个场景的 standardSetup 清掉，这里只做正常路径。
            await deletePiSession(summary.id)
          }
        },
      },
      {
        // T-5：失败留痕一次、不重试、不重放，且缓冲已排水。
        type: "expectFlushFailureIsTracedAndDrained",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await plain.createTempDir("deskpet-live-framebuf-fail-", context))
          try {
            const failing = new FailingEnv(root)
            // 512 B 的极小阈值：两条帧（≈ 740 B）就能触发体积 flush，不必等 16 KiB。
            const decorated = new FrameBufferingFileSystem(failing, { maxBufferBytes: 512 })
            const path = `${root}/fail.jsonl`
            const batch = [0, 1].map(index => delta("fail", index, 200))
            const follow = delta("fail-follow", 0, 200)

            // `logger.error` 无条件走 `console.error`（logger/index.ts 的 error 实现），
            // 所以捕获法成立；替换必须在 finally 里恢复。
            const captured: string[] = []
            const originalConsoleError = console.error
            console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }
            try {
              for (const frameDelta of batch) fileOk(await decorated.appendFile(path, frameLine("op-fail", "resp-fail", frameDelta), context))

              if (failing.attemptCount() !== 1) throw new Error(`跨阈值应产生 1 次落盘尝试，实际 ${failing.attemptCount()}`)
              if (!captured.some(line => line.includes(FRAME_FLUSH_FAILURE_MARK))) {
                throw new Error(`帧落盘失败必须留痕（应包含 ${FRAME_FLUSH_FAILURE_MARK}）：捕获 ${captured.length} 行`)
              }

              // 再推一条（未跨阈值）+ 显式 flush：不抛、只多一次尝试；失败批被丢弃、不重放。
              fileOk(await decorated.appendFile(path, frameLine("op-fail", "resp-fail", follow), context))
              await decorated.flush(context)

              if (failing.attemptCount() !== 2) {
                throw new Error(`flush 失败后不得重试：期望 2 次尝试，实际 ${failing.attemptCount()}`)
              }
              const second = failing.attempts[1]
              if (!second || !second.content.includes(follow)) throw new Error("第二次尝试应携带新推入的帧")
              for (const frameDelta of batch) {
                if (second.content.includes(frameDelta)) throw new Error(`失败的批次被重放（应已丢弃）: ${frameDelta.slice(0, 24)}…`)
              }
              const marks = captured.filter(line => line.includes(FRAME_FLUSH_FAILURE_MARK)).length
              if (marks !== 2) throw new Error(`两次失败应各留痕一次（不重试、不重复记）：实际 ${marks} 条`)
            } finally {
              console.error = originalConsoleError
            }

            // 丢弃即「seq 序列留洞」，重放安全（§0.2）：盘上不该出现任何帧字节。
            if (fileOk(await plain.exists(path, context))) throw new Error("失败的帧缓冲必须被丢弃，不应重放落盘")
          } finally {
            await plain.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // T-2 FIFO：合并后的字节流与推入内容逐字节等价。
        type: "expectFlushedContentPreservesFifoOrder",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await plain.createTempDir("deskpet-live-framebuf-fifo-", context))
          try {
            const counting = new CountingEnv(root)
            // 1024 B 阈值 + 单条 ≈ 410 B：第 3 条跨过阈值（体积触发），第 5 条由显式 flush 落地，
            // 一次检查里两类触发都走到。
            const decorated = new FrameBufferingFileSystem(counting, { maxBufferBytes: 1024 })
            const path = `${root}/fifo.jsonl`
            const pushed = [0, 1, 2, 3, 4].map(index => frameLine("op-fifo", "resp-fifo", delta("fifo", index, 240)))
            for (const line of pushed) fileOk(await decorated.appendFile(path, line, context))
            await decorated.flush(context)

            const received = appendOps(counting)
            if (received.length !== 2) {
              throw new Error(`期望 2 次底层 appendFile（体积触发 1 次 + 显式 flush 1 次），实际 ${received.length}`)
            }
            const got = concatAppends(received)
            const want = pushed.join("")
            if (got !== want) {
              throw new Error(`合并后的字节流与推入顺序不等价：实收 ${byteLength(got)} B，期望 ${byteLength(want)} B`)
            }
          } finally {
            await plain.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // 体积阈值：未达阈值不落盘；跨过阈值整批落盘且一条不少。
        type: "expectSizeThresholdTriggersFlush",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await plain.createTempDir("deskpet-live-framebuf-threshold-", context))
          try {
            const counting = new CountingEnv(root)
            const decorated = new FrameBufferingFileSystem(counting, { maxBufferBytes: 1024 })
            const path = `${root}/threshold.jsonl`
            const first = [0, 1].map(index => frameLine("op-threshold", "resp-threshold", delta("threshold", index, 240)))
            for (const line of first) fileOk(await decorated.appendFile(path, line, context))
            if (appendOps(counting).length !== 0) {
              throw new Error(`累计未达阈值时不应落盘，实际 ${appendOps(counting).length} 次 appendFile`)
            }

            const crossing = frameLine("op-threshold", "resp-threshold", delta("threshold", 2, 240))
            fileOk(await decorated.appendFile(path, crossing, context))
            const received = appendOps(counting)
            if (received.length !== 1) throw new Error(`跨过阈值应整批落盘一次，实际 ${received.length} 次 appendFile`)
            const got = concatAppends(received)
            const want = [...first, crossing].join("")
            if (got !== want) throw new Error(`跨阈值落盘的内容不完整：实收 ${byteLength(got)} B，期望 ${byteLength(want)} B`)
          } finally {
            await plain.remove(root, { recursive: true, force: true }, context)
          }
        },
      },
      {
        // O-9 旁路：关掉合并后逐条直写（开关的唯一验证点），
        // 并把同一批真实帧字节重放进开启合并的路径做逐字节等价对照。
        type: "expectBypassSwitchWritesThrough",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const bypassRoot = fileOk(await plain.createTempDir("deskpet-live-framebuf-bypass-", context))
          const mergeRoot = fileOk(await plain.createTempDir("deskpet-live-framebuf-merge-", context))
          try {
            const frames = [0, 1, 2, 3, 4, 5, 6, 7].map(index => delta("bypass", index, BURST_PAD))

            // ① 旁路：底层调用数 === 帧数（逐条直写，不合并），且每条都是单写事务形态。
            const bypassEnv = new CountingEnv(bypassRoot)
            const bypassRepo = await createPiSessionRepo({
              sessionsRoot: bypassRoot,
              cwd: bypassRoot,
              fileSystem: bypassEnv,
              frameThrottle: false,
            })
            const bypassSession = await bypassRepo.create({ id: "frame-bypass" }, context)
            for (const frameDelta of frames) await pushFrame(bypassSession, "op-bypass", "resp-bypass", frameDelta)
            try {
              const bypassAppends = appendOps(bypassEnv)
              if (bypassAppends.length !== frames.length) {
                throw new Error(`旁路应逐条直写：${frames.length} 帧 → 期望 ${frames.length} 次 appendFile，实际 ${bypassAppends.length}`)
              }
              for (const op of bypassAppends) {
                if (typeof op.content !== "string" || !isFrameAppendTransaction(op.content)) {
                  throw new Error(`旁路写入必须保持单写事务形态（不合并）: ${String(op.content).slice(0, 80)}`)
                }
              }
              const bypassStream = concatAppends(bypassAppends)
              const bypassDeltas = frameDeltas(bypassStream)
              if (JSON.stringify(bypassDeltas) !== JSON.stringify(frames)) {
                throw new Error("旁路写入的帧顺序与推入顺序不符")
              }

              // ② 同一批字节（真实 commit 路径产出的，不是测试手拼）重放进开启合并的路径：
              //    底层调用数变少，但收发的字节流逐字节相同 —— T-2「合并等价」的正面证据。
              const mergeEnv = new CountingEnv(mergeRoot)
              const decorated = new FrameBufferingFileSystem(mergeEnv)
              const mergePath = `${mergeRoot}/merged.jsonl`
              for (const line of linesOf(bypassStream)) fileOk(await decorated.appendFile(mergePath, line, context))
              await decorated.flush(context)

              const mergedAppends = appendOps(mergeEnv)
              if (mergedAppends.length >= bypassAppends.length) {
                throw new Error(`开启合并后底层调用数应更少：${mergedAppends.length} ≥ ${bypassAppends.length}`)
              }
              const mergedStream = concatAppends(mergedAppends)
              if (mergedStream !== bypassStream) {
                throw new Error(`合并后的字节流与逐条直写不等价：合并 ${byteLength(mergedStream)} B，直写 ${byteLength(bypassStream)} B`)
              }
            } finally {
              await bypassSession.close(context)
              await bypassRepo.close(context)
            }
          } finally {
            await plain.remove(bypassRoot, { recursive: true, force: true }, context)
            await plain.remove(mergeRoot, { recursive: true, force: true }, context)
          }
        },
      },
    ],
  }],
}

export default 帧写缓冲
