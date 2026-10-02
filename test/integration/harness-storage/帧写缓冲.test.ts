// ==========================================
// 帧写缓冲场景（T1.05）—— 从 test/e2e/scenes/harness-storage/帧写缓冲.scene.ts 迁到 L3（W2）
//
// 把 T1.01–T1.04 的五种触发行为钉成可执行断言：合并 / 非帧触发 / 读前 flush / 关闭前 flush /
// 失败留痕与旁路开关。
//
// 被测实现的真实帧写入路径（执行方案 §0.2 已核实）：
//   `harness/runtime/progress.js` 每个流式 delta 一次 `lane.command`
//     → `{ kind: "commit", writes: [commitWrite(item)] }`
//     → `JsonlStorage.applyCommit` → `fileSystem.appendFile`（全仓唯一一处 appendFile）
//     → 本仓 `FrameBufferingFileSystem` 按「帧 append / 非帧」分流（`engine/harness/session-frame-buffer.ts`）。
//   单写事务落成「单个 JSON 对象 + 换行」，多写事务落成 JSON 数组（一条多写事务 = 一行）。
//
// 为什么由 `session.appendList(...)` 驱动真实 commit，而不是手拼 JSON 行：行里的 `seq` 由
//   提交时分配、open 时校验，手拼会绕过分配与校验，落盘字节与真实帧不同形 —— 断言就退化成
//   「测试自己写的 JSON 自己认」。（直连装饰器的 check 用 `frameLine()` 造样：上游 write 构造器
//   + 上游序列化形态，同样不是手写 JSON 字面量。）
//
// 本用例一律用生产判别器 `isFrameAppendTransaction` 当「这一行是帧」的判据，不复制文案、不复制字段清单。
//   触发条件没有时间维度：体积达阈值 / 遇到非帧 / 读同一路径 / 显式 flush（关闭前）；全用例不使用定时器 API。
//
// 迁移时的审视修正（对应契约「审计线索」的复核结论）：
//   · :452（D9）原 check 5 末尾断言「FailingEnv 下盘上不该出现任何帧字节」—— FailingEnv 的
//     appendFile 恒失败且从不写盘，`plain.exists(path)` 在任何实现下都是 false，这条断言与
//     「失败批是否被丢弃」无关、不可能独立失败。已删除；真正的判别证据是同一条 check 里对
//     `attempts` 内容的断言（失败批不进下一次尝试）。
//
// L3：IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现）；缓冲装饰器与仓库同一份产品代码。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT, err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { appendList, pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import {
  createPiSessionRepo,
  FRAME_BUFFER_MAX_BYTES,
  FRAME_FLUSH_FAILURE_MARK,
  FrameBufferingFileSystem,
  flushSessionFrameWrites,
} from "@/services/engine/harness"
// 判别器是「这一行是帧」的唯一真相源，但没进 barrel（barrel 只导出四个名字）；
// 测试按需直连该模块，不去改动冻结中的实现目录。
import { isFrameAppendTransaction } from "@/services/engine/harness/session-frame-buffer"
import type { PiSessionRepo } from "@/services/engine/harness"
import { acquirePiSession, createPiSession, deletePiSession, releasePiSession } from "@/services/session"
import { initPaths, runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

type JsonlSession = Session<JsonlSessionMetadata>

const textEncoder = new TextEncoder()

/** 字节口径与 Rust 侧 `content.len()`（`tool_exec/mod.rs` 的单次写上限校验）一致，不用 `String.length`。 */
function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-framebuf-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 解包 Result（夹具解码器，不是断言）：失败时先经 expect 记一条带错误码的失败，再中止本用例。 */
function expectOk<T>(result: Result<T, FileError>, label: string): T {
  expect(result.ok, `${label}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`).toBe(true)
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`)
  return result.value
}

// ── 仪器（只在测试内定义，不新增生产 API）──

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
    expect(typeof op.content, `appendFile 收到非字符串内容: ${op.path}`).toBe("string")
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
 * 序列化形态（`JSON.stringify(writes[0]) + "\n"`）。`seq` 由提交时分配，这里没有。
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
    expect(typeof value?.delta, `帧行缺少字符串 delta: ${line.slice(0, 80)}`).toBe("string")
    deltas.push(value!.delta as string)
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

/** 帧值的 thinking/reasoning 增量；其它帧类型返回 undefined（断言里同时看得见实际类型）。 */
function thinkingDeltaOf(value: { type: string; delta?: unknown }): string | undefined {
  return value.type === "thinking_delta" && typeof value.delta === "string" ? value.delta : undefined
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
}

/**
 * 突发夹具：临时根 + 注入 CountingEnv 的仓库（装饰器默认开，生产默认值）。
 * check 1 推 200 条真实帧，check 2 接着用同一实例（断言缓冲未满时的非帧触发）。
 */
async function buildBurstFixture(): Promise<BurstFixture> {
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = expectOk(await plain.createTempDir("deskpet-live-framebuf-", BACKGROUND_CONTEXT), "createTempDir")
  const counting = new CountingEnv(root)
  const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root, fileSystem: counting })
  const session = await repo.create({ id: "frame-throttle" }, BACKGROUND_CONTEXT)
  return { plain, counting, repo, session, root, pushed: [] }
}

async function disposeBurst(fixture: BurstFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  await fixture.session.close(context)
  // 句柄关闭不碰文件；但装饰器可能仍持有字节 —— 冲一次把残留字节落到临时根，再删根。
  await flushSessionFrameWrites(context)
  await fixture.repo.close(context)
  await fixture.plain.remove(fixture.root, { recursive: true, force: true }, context)
}

describe("帧写缓冲", () => {
  it("帧缓冲合并、触发时机、读前/关闭前 flush、失败留痕与 O-9 旁路 [harness-frame-write-buffer]", async () => {
    const context = BACKGROUND_CONTEXT

    // ── ① T-1 机制口径 + T-2 replay 等价；② T-3 非帧写入先冲缓冲再立即落盘 ──
    const burst = await buildBurstFixture()
    try {
      const { counting, session } = burst
      for (let index = 0; index < BURST_FRAMES; index++) {
        const frameDelta = delta("throttle", index, BURST_PAD)
        burst.pushed.push(frameDelta)
        await pushFrame(session, BURST_OP, BURST_RESP, frameDelta)
      }

      // ① 机制口径：总字节按底层**实收**字节求和（未落盘的尾部不在其中）。
      //    这个不等式同时挡住两种错误：不合并 → 调用数 200 ≫ 上界；丢帧 → 上界收紧。
      const appends = appendOps(counting)
      const byteTotal = appends.reduce((sum, op) => sum + op.bytes, 0)
      const maxCalls = Math.ceil(byteTotal / FRAME_BUFFER_MAX_BYTES) + 1
      expect(appends.length, "突发期间底层必须至少发生一次 appendFile").toBeGreaterThanOrEqual(1)
      expect(
        appends.length,
        `帧写入未合并：${BURST_FRAMES} 帧产生 ${appends.length} 次 appendFile（实收 ${byteTotal} B，上界 ${maxCalls} = ⌈字节/${FRAME_BUFFER_MAX_BYTES}⌉+1）`,
      ).toBeLessThanOrEqual(maxCalls)

      // ① replay 等价：会话读路径按序读回全部帧，内容逐项与推入顺序一致。
      const elements = await session.readList(pendingAssistantFrames(BURST_OP, BURST_RESP), { order: "asc" }, context)
      expect(elements.length, `读回的帧数 ≠ 推入的 ${BURST_FRAMES}`).toBe(BURST_FRAMES)
      elements.forEach((element, index) => {
        const value = element.value
        expect(value.type, `第 ${index} 条帧类型应为 thinking_delta`).toBe("thinking_delta")
        expect(thinkingDeltaOf(value), `第 ${index} 条帧内容与推入顺序不符（类型 ${value.type}）`).toBe(burst.pushed[index])
      })

      // ② T-3：非帧写入先冲干净缓冲，再自身立即落盘。
      //    缓冲未满：再推一条帧（盘上还没有它），随后一次非帧写入必须先把缓冲冲干净。
      const trigger = delta("throttle-trigger", 0, BURST_PAD)
      await pushFrame(session, BURST_OP, BURST_RESP, trigger)
      const sessionName = "帧节流探针"
      await session.setName(sessionName, context)

      // 未包装的 env 直读原始文件：读的是磁盘，绕过装饰器（因此也绕过了读前 flush）。
      const content = expectOk(await burst.plain.readTextFile(session.metadata.path, context), "readTextFile(原始文件)")

      // ②a 非帧写入（value/set）已经在盘上。
      expect(hasValueSetLine(content, sessionName), `非帧的 value/set 行未立即落盘: ${sessionName}`).toBe(true)

      // ②b 缓冲里的帧（含刚推入的那条）被先冲干净：盘上帧序列必须与推入顺序逐项一致、一条不少。
      const expected = [...burst.pushed, trigger]
      const onDisk = frameDeltas(content)
      expect(onDisk.length, `非帧写入前应把缓冲全部冲落：盘上 ${onDisk.length} 条帧 ≠ 推入 ${expected.length} 条`).toBe(expected.length)
      onDisk.forEach((frameDelta, index) => {
        expect(frameDelta, `盘上第 ${index} 条帧与推入顺序不符`).toBe(expected[index])
      })

      // ②c 顺序证据：最后一条帧行排在 value/set 行之前（先 flush 后落非帧）。
      const lastFrameAt = content.lastIndexOf(trigger)
      const nameAt = content.indexOf(`"${sessionName}"`)
      expect(
        lastFrameAt >= 0 && nameAt >= 0 && lastFrameAt < nameAt,
        `缓冲帧应排在非帧写入之前：最后一条帧 @${lastFrameAt}，value/set 行 @${nameAt}`,
      ).toBe(true)
    } finally {
      await disposeBurst(burst)
    }

    // ── ③ T-4：读同一路径前先 flush，且顺序证据（先 appendFile 后 readTextFile）──
    {
      const plain = new TauriExecutionEnv(await runtimePath("data"))
      const root = expectOk(await plain.createTempDir("deskpet-live-framebuf-read-", context), "createTempDir")
      try {
        const counting = new CountingEnv(root)
        const decorated = new FrameBufferingFileSystem(counting)
        const path = `${root}/read-flush.jsonl`
        const header = `${JSON.stringify({ v: 4, kind: "header", probe: "读前 flush" })}\n`
        expectOk(await plain.writeFile(path, header, context), "writeFile(header)")

        const pushed = [0, 1, 2].map(index => frameLine("op-read", "resp-read", delta("read", index, BURST_PAD)))
        for (const line of pushed) expectOk(await decorated.appendFile(path, line, context), "decorated.appendFile")

        // 子步骤①：未包装 env 直读 —— 盘上只有 header，帧都还在缓冲里（远未到体积阈值）。
        const before = expectOk(await plain.readTextFile(path, context), "readTextFile(未包装)")
        expect(before, `缓冲未满时盘上不应出现新帧：实际 ${before.length} B（期望 ${header.length} B）`).toBe(header)

        // 子步骤②：装饰器读同一路径 → 返回内容必须包含全部缓冲帧（读前 flush），逐字节相等。
        const after = expectOk(await decorated.readTextFile(path, context), "decorated.readTextFile")
        expect(after, `装饰器读到的内容不完整：实际 ${byteLength(after)} B，期望 ${byteLength(header + pushed.join(""))} B`).toBe(
          header + pushed.join(""),
        )

        // 子步骤③ 顺序证据：底层 ops 末尾两条是 appendFile → readTextFile（先 flush 后读）。
        const tail = counting.ops.slice(-2)
        expect(
          tail.map(op => op.method),
          `读前 flush 的顺序证据不成立：ops 末尾为 ${JSON.stringify(tail)}`,
        ).toEqual(["appendFile", "readTextFile"])
      } finally {
        expectOk(await plain.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── ④ T-6 接线：releasePiSession → flushSessionFrameWrites（会话层走一遍真实接线）──
    {
      const raw = new TauriExecutionEnv(await runtimePath("data"))
      const summary = await createPiSession("帧节流关闭探针")
      try {
        const session = await acquirePiSession(summary.id)
        const path = session.metadata.path
        const pushed = [0, 1, 2].map(index => delta("关闭", index, BURST_PAD))
        for (const frameDelta of pushed) await pushFrame(session, "op-close", "resp-close", frameDelta)

        // 缓冲未满（3 帧 ≈ 1 KiB ≪ 阈值）：盘上还没有这批帧。这里同时钉住一条假设：
        // 缓冲是**每装饰器实例**的，只有本仓库实例自己的 flush 会写它。
        const before = expectOk(await raw.readTextFile(path, context), "readTextFile(释放前)")
        for (const frameDelta of pushed) {
          expect(before.includes(frameDelta), `释放前盘上不应有缓冲帧: ${frameDelta.slice(0, 24)}…`).toBe(false)
        }

        await releasePiSession(summary.id)

        const after = expectOk(await raw.readTextFile(path, context), "readTextFile(释放后)")
        let cursor = -1
        for (const frameDelta of pushed) {
          const at = after.indexOf(frameDelta)
          expect(at > cursor, `释放后帧未按序落盘: ${frameDelta.slice(0, 24)}…`).toBe(true)
          cursor = at
        }

        // 更强的证据：文件最后一行就是最后一条帧 —— 关闭路径自己一次 FileSystem 调用都没有，
        // 这段字节只可能来自 releasePiSession 的 flush，且其后没有别的写入。
        const lines = after.split("\n").filter(line => line !== "")
        const lastLine = lines[lines.length - 1] ?? ""
        expect(
          isFrameAppendTransaction(`${lastLine}\n`) && lastLine.includes(pushed[pushed.length - 1] ?? ""),
          `文件末行应是最后一条帧（由释放时的 flush 写入）: ${lastLine.slice(0, 80)}`,
        ).toBe(true)
      } finally {
        // 收尾删除：失败留在句柄缓存里的会话由下一个场景的 standardSetup 清掉，这里只做正常路径。
        await deletePiSession(summary.id)
      }
    }

    // ── ⑤ T-5：失败留痕一次、不重试、不重放，且缓冲已排水 ──
    {
      const plain = new TauriExecutionEnv(await runtimePath("data"))
      const root = expectOk(await plain.createTempDir("deskpet-live-framebuf-fail-", context), "createTempDir")
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
          for (const frameDelta of batch) expectOk(await decorated.appendFile(path, frameLine("op-fail", "resp-fail", frameDelta), context), "decorated.appendFile")

          expect(failing.attemptCount(), "跨阈值应产生 1 次落盘尝试").toBe(1)
          expect(
            captured.some(line => line.includes(FRAME_FLUSH_FAILURE_MARK)),
            `帧落盘失败必须留痕（应包含 ${FRAME_FLUSH_FAILURE_MARK}）：捕获 ${captured.length} 行`,
          ).toBe(true)

          // 再推一条（未跨阈值）+ 显式 flush：不抛、只多一次尝试；失败批被丢弃、不重放。
          expectOk(await decorated.appendFile(path, frameLine("op-fail", "resp-fail", follow), context), "decorated.appendFile(follow)")
          await decorated.flush(context)

          expect(failing.attemptCount(), "flush 失败后不得重试：期望 2 次尝试").toBe(2)
          const second = failing.attempts[1]
          expect(second, "第二次尝试缺失").toBeDefined()
          expect(second!.content.includes(follow), "第二次尝试应携带新推入的帧").toBe(true)
          for (const frameDelta of batch) {
            expect(second!.content.includes(frameDelta), `失败的批次被重放（应已丢弃）: ${frameDelta.slice(0, 24)}…`).toBe(false)
          }
          // 失败批被丢弃的唯一真实证据就是上面两条 attempts 内容断言：
          // FailingEnv 的 appendFile 恒失败且从不落盘，任何「盘上有没有文件」的断言都不可能独立失败
          // （原场景 :452 的 D9 因此被删除）。
          const marks = captured.filter(line => line.includes(FRAME_FLUSH_FAILURE_MARK)).length
          expect(marks, `两次失败应各留痕一次（不重试、不重复记）`).toBe(2)
        } finally {
          console.error = originalConsoleError
        }
      } finally {
        expectOk(await plain.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── ⑥ T-2 FIFO：合并后的字节流与推入内容逐字节等价 ──
    {
      const plain = new TauriExecutionEnv(await runtimePath("data"))
      const root = expectOk(await plain.createTempDir("deskpet-live-framebuf-fifo-", context), "createTempDir")
      try {
        const counting = new CountingEnv(root)
        // 1024 B 阈值 + 单条 ≈ 410 B：第 3 条跨过阈值（体积触发），第 5 条由显式 flush 落地，
        // 一次检查里两类触发都走到。
        const decorated = new FrameBufferingFileSystem(counting, { maxBufferBytes: 1024 })
        const path = `${root}/fifo.jsonl`
        const pushed = [0, 1, 2, 3, 4].map(index => frameLine("op-fifo", "resp-fifo", delta("fifo", index, 240)))
        for (const line of pushed) expectOk(await decorated.appendFile(path, line, context), "decorated.appendFile")
        await decorated.flush(context)

        const received = appendOps(counting)
        expect(received.length, "期望 2 次底层 appendFile（体积触发 1 次 + 显式 flush 1 次）").toBe(2)
        const got = concatAppends(received)
        expect(got, `合并后的字节流与推入顺序不等价：实收 ${byteLength(got)} B，期望 ${byteLength(pushed.join(""))} B`).toBe(pushed.join(""))
      } finally {
        expectOk(await plain.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── ⑦ 体积阈值：未达阈值不落盘；跨过阈值整批落盘且一条不少 ──
    {
      const plain = new TauriExecutionEnv(await runtimePath("data"))
      const root = expectOk(await plain.createTempDir("deskpet-live-framebuf-threshold-", context), "createTempDir")
      try {
        const counting = new CountingEnv(root)
        const decorated = new FrameBufferingFileSystem(counting, { maxBufferBytes: 1024 })
        const path = `${root}/threshold.jsonl`
        const first = [0, 1].map(index => frameLine("op-threshold", "resp-threshold", delta("threshold", index, 240)))
        for (const line of first) expectOk(await decorated.appendFile(path, line, context), "decorated.appendFile")
        expect(appendOps(counting).length, "累计未达阈值时不应落盘").toBe(0)

        const crossing = frameLine("op-threshold", "resp-threshold", delta("threshold", 2, 240))
        expectOk(await decorated.appendFile(path, crossing, context), "decorated.appendFile(crossing)")
        const received = appendOps(counting)
        expect(received.length, "跨过阈值应整批落盘一次").toBe(1)
        const got = concatAppends(received)
        const want = [...first, crossing].join("")
        expect(got, `跨阈值落盘的内容不完整：实收 ${byteLength(got)} B，期望 ${byteLength(want)} B`).toBe(want)
      } finally {
        expectOk(await plain.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── ⑧ O-9 旁路：关掉合并后逐条直写（开关的唯一验证点），同批字节重放进开启合并的路径做逐字节等价对照 ──
    {
      const plain = new TauriExecutionEnv(await runtimePath("data"))
      const bypassRoot = expectOk(await plain.createTempDir("deskpet-live-framebuf-bypass-", context), "createTempDir(bypass)")
      const mergeRoot = expectOk(await plain.createTempDir("deskpet-live-framebuf-merge-", context), "createTempDir(merge)")
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
          expect(bypassAppends.length, `旁路应逐条直写：${frames.length} 帧 → 期望 ${frames.length} 次 appendFile`).toBe(frames.length)
          for (const op of bypassAppends) {
            expect(
              typeof op.content === "string" && isFrameAppendTransaction(op.content),
              `旁路写入必须保持单写事务形态（不合并）: ${String(op.content).slice(0, 80)}`,
            ).toBe(true)
          }
          const bypassStream = concatAppends(bypassAppends)
          expect(frameDeltas(bypassStream), "旁路写入的帧顺序与推入顺序不符").toEqual(frames)

          // ② 同一批字节（真实 commit 路径产出的，不是测试手拼）重放进开启合并的路径：
          //    底层调用数变少，但收发的字节流逐字节相同 —— T-2「合并等价」的正面证据。
          const mergeEnv = new CountingEnv(mergeRoot)
          const decorated = new FrameBufferingFileSystem(mergeEnv)
          const mergePath = `${mergeRoot}/merged.jsonl`
          for (const line of linesOf(bypassStream)) expectOk(await decorated.appendFile(mergePath, line, context), "decorated.appendFile(merge)")
          await decorated.flush(context)

          const mergedAppends = appendOps(mergeEnv)
          expect(mergedAppends.length, `开启合并后底层调用数应更少：${mergedAppends.length} ≥ ${bypassAppends.length}`).toBeLessThan(bypassAppends.length)
          const mergedStream = concatAppends(mergedAppends)
          expect(mergedStream, `合并后的字节流与逐条直写不等价：合并 ${byteLength(mergedStream)} B，直写 ${byteLength(bypassStream)} B`).toBe(bypassStream)
        } finally {
          await bypassSession.close(context)
          await bypassRepo.close(context)
        }
      } finally {
        expectOk(await plain.remove(bypassRoot, { recursive: true, force: true }, context), "remove(bypassRoot)")
        expectOk(await plain.remove(mergeRoot, { recursive: true, force: true }, context), "remove(mergeRoot)")
      }
    }
  })
})
