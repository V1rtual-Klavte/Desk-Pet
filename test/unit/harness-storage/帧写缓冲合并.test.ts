// ==========================================
// 帧写缓冲的同键 delta 合并（L2：纯逻辑；装饰器 + 内存 FileSystem，不碰 IPC / 真落盘）
//
// 被测实现：`src/services/engine/harness/session-frame-buffer.ts` 的
// `FrameBufferingFileSystem`。合并规则：同一 `(namespace, key, value.type, value.contentIndex)`
// 槽位的 delta 帧合并成一条 append 记录（`value.delta` 按到达顺序拼接，`seq` 取最后一条），
// 物化边界 = 非 delta 帧（同一文件的帧）与 drain（体积阈值 / 读前 / 关闭前 flush）。
//
// 为什么这个用例在 L2 成立：装饰器对 FileSystem 的接口是窄的（appendFile / flush 等），
// 用内存实现即可完整观察「实收字节」与「调用次数」；帧行由上游 write 构造器生成
// （`appendList(pendingAssistantFrames(...))`），`seq` 是提交时才分配的输入，这里按到达
// 顺序手赋。真 JSONL 落盘与真 commit 链路由 L3（`test/integration/harness-storage/
// 帧写缓冲.test.ts`）证明，本文件不重复那条口径。
//
// 等价性判据用**真实重放函数**，不用测试自造的「折叠」：
//   · `session-fold.ts` 的 `replayLogState` —— 本仓对 JSONL 日志的真实重放（读取端口径）；
//   · pi-ai 的 `reduceAssistantMessageFrames` —— 上游把帧序列折成助手消息的真实函数
//     （`harness/runtime/lane.js` 的 `readStreamingMessage` 就调它）。
// `logStateDigest` 刻意不参与比对：合并改变的是列表**元素边界**（2 帧 → 1 帧），
// 摘要按元素列表算，天然不等；语义等价的口径是「重放后折出的助手消息逐字段相同」。
// ==========================================

import { BACKGROUND_CONTEXT, err, FileError, ok } from "@earendil-works/pi-agent-core"
import type { Context, FileInfo, FileSystem, Result } from "@earendil-works/pi-agent-core"
import { appendList, pendingAssistantFrames, setValue, value } from "@earendil-works/pi-agent-core/harness/session"
import { reduceAssistantMessageFrames } from "@earendil-works/pi-ai"
import type { AssistantMessageFrame } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"

import { FrameBufferingFileSystem, isFrameAppendTransaction } from "@/services/engine/harness/session-frame-buffer"
import { readFoldLog, replayLogState } from "@/services/engine/harness/session-fold"

const CONTEXT: Context = BACKGROUND_CONTEXT
const SESSION_PATH = "/mem/session.jsonl"
const FRAME_ADDRESS = pendingAssistantFrames("op-merge", "resp-merge")
const HEADER_LINE = JSON.stringify({ v: 4, kind: "header", id: "frame-merge-unit", storageVersion: 1, createdAt: 0, cwd: "/mem" })

// ── 内存 FileSystem（只在测试内定义）──

/**
 * 只实现装饰器实际走到的路径（appendFile / readTextFile / writeFile / remove / cleanup、
 * 以及 flush 用不到的转发方法如实返回 not_supported —— 不静默成功，被误用时立刻暴露）。
 * `appends` 记录每次底层调用的实收字节，`files` 是当前盘上内容；断言只读这两个。
 */
class MemoryFileSystem implements FileSystem {
  readonly cwd = "/mem"
  readonly files = new Map<string, string>()
  readonly appends: Array<{ path: string; content: string }> = []

  private unsupported(path: string): Result<never, FileError> {
    return err(new FileError("not_supported", "内存 FileSystem 未实现该方法", path))
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(path)
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(parts.join("/"))
  }

  async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
    const text = this.files.get(path)
    return text === undefined ? err(new FileError("not_found", "文件不存在", path)) : ok(text)
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, _context: Context): Promise<Result<string[], FileError>> {
    const text = this.files.get(path)
    if (text === undefined) return err(new FileError("not_found", "文件不存在", path))
    const lines = text.split("\n")
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines))
  }

  async readBinaryFile(path: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.unsupported(path)
  }

  async writeFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content))
    return ok(undefined)
  }

  async appendFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content)
    this.appends.push({ path, content: text })
    this.files.set(path, (this.files.get(path) ?? "") + text)
    return ok(undefined)
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const text = this.files.get(sourcePath)
    if (text === undefined) return err(new FileError("not_found", "文件不存在", sourcePath))
    this.files.delete(sourcePath)
    this.files.set(destinationPath, text)
    return ok(undefined)
  }

  async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    const text = this.files.get(path)
    if (text === undefined) return err(new FileError("not_found", "文件不存在", path))
    return ok({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size: new TextEncoder().encode(text).byteLength, mtimeMs: 0 })
  }

  async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.unsupported(path)
  }

  async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(path)
  }

  async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    return ok(this.files.has(path))
  }

  async createDir(_path: string, _options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return ok(undefined)
  }

  async remove(path: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    this.files.delete(path)
    return ok(undefined)
  }

  async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported("/mem/tmp")
  }

  async createTempFile(_options: { prefix?: string; suffix?: string } | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported("/mem/tmp")
  }

  async cleanup(_context: Context): Promise<void> {}
}

// ── 帧行构造（上游 write 构造器 + 手赋 seq）──

/** 一条帧 append 行：`appendList(pendingAssistantFrames(...))` 的写对象 + 提交时才分配的 seq。 */
function frameLine(seq: number, frame: AssistantMessageFrame): string {
  return `${JSON.stringify({ ...appendList(FRAME_ADDRESS, frame), seq })}\n`
}

function textDelta(seq: number, delta: string, contentIndex = 0): string {
  return frameLine(seq, { type: "text_delta", contentIndex, delta })
}

function thinkingDelta(seq: number, delta: string, contentIndex = 0): string {
  return frameLine(seq, { type: "thinking_delta", contentIndex, delta })
}

/** 装饰器实收的全部字节（按调用顺序拼接）。 */
function receivedText(fileSystem: MemoryFileSystem): string {
  return fileSystem.appends.map(call => call.content).join("")
}

/** 实收字节里的帧行，按文件顺序解析（每行必须是生产判别器认得的单写帧事务）。 */
function receivedFrames(fileSystem: MemoryFileSystem): Array<{ seq: number; value: AssistantMessageFrame }> {
  const rows: Array<{ seq: number; value: AssistantMessageFrame }> = []
  for (const line of receivedText(fileSystem).split("\n")) {
    if (line === "") continue
    expect(isFrameAppendTransaction(`${line}\n`), `实收字节里出现非帧行: ${line.slice(0, 100)}`).toBe(true)
    rows.push(JSON.parse(line) as { seq: number; value: AssistantMessageFrame })
  }
  return rows
}

/** 断言一串行里的 seq 严格递增（整文件写入行序 = 重放顺序的不变量）。 */
function expectStrictlyIncreasing(seqs: number[]): void {
  for (let index = 1; index < seqs.length; index++) {
    expect(seqs[index], `第 ${index} 行的 seq 未严格递增: ${seqs.join(" → ")}`).toBeGreaterThan(seqs[index - 1])
  }
}

/**
 * 从会话日志文本取回帧序列 —— 走本仓 `session-fold.ts` 的真实重放（`replayLogState`），
 * 与 Pi `readAssistantFrames` 的列表视图同构。日志只有一个帧 key：多于/少于一个直接判失败，
 * 避免「取错 key」静默变成空序列。
 */
function framesFromLog(logText: string): AssistantMessageFrame[] {
  const state = replayLogState(readFoldLog(logText))
  expect(state.listValues.length, "帧日志应恰好有一个 list key").toBe(1)
  return state.listValues[0][1].map(element => element.value as AssistantMessageFrame)
}

// ── 用例 ──

describe("帧写缓冲合并", () => {
  it("同一槽位的连续 delta 合并成一行：delta 按到达顺序拼接、seq 取最后一条 [harness-frame-delta-merge-same-slot]", async () => {
    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })
    const deltas = ["你", "好", "，世界"]

    for (let index = 0; index < deltas.length; index++) {
      const appended = await buffer.appendFile(SESSION_PATH, textDelta(10 + index, deltas[index]), CONTEXT)
      expect(appended.ok, `appendFile(${index}) 应成功`).toBe(true)
    }
    expect(fileSystem.appends.length, "未 drain 前不应有任何落盘调用").toBe(0)

    await buffer.flush(CONTEXT)

    expect(fileSystem.appends.length, "N 条同槽位 delta 应只产生一次落盘调用").toBe(1)
    const rows = receivedFrames(fileSystem)
    expect(rows.length, `实收应为 1 行，实际 ${rows.length} 行`).toBe(1)
    expect(rows[0].value).toEqual({ type: "text_delta", contentIndex: 0, delta: "你好，世界" })
    expect(rows[0].seq, "合并行的 seq 应取最后一条 delta 帧的 seq").toBe(12)
  })

  it("delta 不得跨非 delta 帧（text_end）合并：物化行在 end 行之前，end 之后的 delta 另起一行 [harness-frame-delta-merge-boundary]", async () => {
    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })

    await buffer.appendFile(SESSION_PATH, textDelta(1, "甲"), CONTEXT)
    await buffer.appendFile(SESSION_PATH, textDelta(2, "乙"), CONTEXT)
    await buffer.appendFile(SESSION_PATH, frameLine(3, { type: "text_end", contentIndex: 0, content: "甲乙" }), CONTEXT)
    await buffer.appendFile(SESSION_PATH, textDelta(4, "丙"), CONTEXT)
    await buffer.flush(CONTEXT)

    const rows = receivedFrames(fileSystem)
    expect(rows.length, `实收应为 3 行（合并 / end / 合并），实际 ${rows.length} 行`).toBe(3)
    expect(rows[0].value, "end 之前的 delta 合成一行，排在 end 行之前").toEqual({
      type: "text_delta",
      contentIndex: 0,
      delta: "甲乙",
    })
    expect(rows[0].seq).toBe(2)
    expect(rows[1].value, "第二条必须是非 delta 帧本身").toEqual({
      type: "text_end",
      contentIndex: 0,
      content: "甲乙",
    })
    expect(rows[1].seq).toBe(3)
    expect(rows[2].value, "end 之后的 delta 不得与前一段拼接").toEqual({
      type: "text_delta",
      contentIndex: 0,
      delta: "丙",
    })
    expect(rows[2].seq).toBe(4)
    expectStrictlyIncreasing(rows.map(row => row.seq))
  })

  it("不同 contentIndex / type / 缺失 contentIndex 各自成槽，不互相合并 [harness-frame-delta-merge-slots]", async () => {
    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })

    await buffer.appendFile(SESSION_PATH, textDelta(1, "甲", 0), CONTEXT)
    await buffer.appendFile(SESSION_PATH, textDelta(2, "乙", 1), CONTEXT)
    await buffer.appendFile(SESSION_PATH, thinkingDelta(3, "丙", 0), CONTEXT)
    await buffer.appendFile(SESSION_PATH, textDelta(4, "丁", 0), CONTEXT)
    // contentIndex 缺失的帧不在上游帧联合类型的产出面上（识别为边界探针）：合并键把
    // undefined 归一为一个槽位，两条这样的帧必须互相合并、且不与任何数字下标混槽。
    const noIndex = (seq: number, delta: string): string =>
      frameLine(seq, { type: "text_delta", delta } as unknown as AssistantMessageFrame)
    await buffer.appendFile(SESSION_PATH, noIndex(5, "戊"), CONTEXT)
    await buffer.appendFile(SESSION_PATH, noIndex(6, "己"), CONTEXT)
    await buffer.flush(CONTEXT)

    const rows = receivedFrames(fileSystem)
    // 槽位 → 末条 seq：text(0)=4、text(1)=2、thinking(0)=3、text(undefined)=6；
    // 物化按末条 seq 升序 ⇒ [text(1), thinking(0), text(0), text(undefined)]。
    expect(rows.map(row => row.seq), "四个槽位各一行，seq 升序").toEqual([2, 3, 4, 6])
    expect(rows.map(row => (row.value as { delta?: string }).delta)).toEqual(["乙", "丙", "甲丁", "戊己"])
  })

  it("跨类型交错（text→thinking→text）时输出行按最后 seq 升序，整文件 seq 严格递增 [harness-frame-delta-merge-seq-order]", async () => {
    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })

    await buffer.appendFile(SESSION_PATH, textDelta(1, "先"), CONTEXT)
    await buffer.appendFile(SESSION_PATH, thinkingDelta(2, "想"), CONTEXT)
    await buffer.appendFile(SESSION_PATH, textDelta(3, "后"), CONTEXT)
    await buffer.flush(CONTEXT)

    const rows = receivedFrames(fileSystem)
    expect(rows.length, "两个槽位各一行").toBe(2)
    // 排序后：thinking 的最后 seq=2 在前，text 的最后 seq=3 在后（插入序会是 text(3) 在前）。
    expect(rows[0].value).toEqual({ type: "thinking_delta", contentIndex: 0, delta: "想" })
    expect(rows[1].value).toEqual({ type: "text_delta", contentIndex: 0, delta: "先后" })
    expectStrictlyIncreasing(rows.map(row => row.seq))
  })

  it("重放等价：真实重放（session-fold）+ 真实帧折叠（reduceAssistantMessageFrames）对原始逐帧与合并结果给出同一助手消息 [harness-frame-delta-merge-replay-equivalence]", async () => {
    const partial = {
      role: "assistant" as const,
      content: [],
      api: "openai-completions" as const,
      provider: "desk-pet",
      model: "unit-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending" as const,
      timestamp: 1,
    }
    // 覆盖：文本块→工具调用块；相邻 delta 真的合并（甲+乙、'{"pa'+'th"'）；文本块与工具调用块
    // 之间的 delta 交错（同一中间态的两个槽位交替推进）；text_end 的覆盖语义；toolcall_delta
    // 的累积 JSON。
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
      { type: "text_delta", contentIndex: 0, delta: "甲" },
      { type: "text_delta", contentIndex: 0, delta: "乙" },
      { type: "toolcall_start", contentIndex: 1, toolCall: { type: "toolCall", id: "call-merge", name: "read_file", arguments: {} } },
      { type: "text_delta", contentIndex: 0, delta: "丙" },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"pa' },
      { type: "toolcall_delta", contentIndex: 1, delta: 'th"' },
      { type: "text_end", contentIndex: 0, content: "甲乙丙" },
      { type: "toolcall_delta", contentIndex: 1, delta: ':"a.txt"}' },
      { type: "toolcall_end", contentIndex: 1, id: "call-merge", name: "read_file", arguments: { path: "a.txt" } },
    ]
    const originalLines = frames.map((frame, index) => frameLine(index + 1, frame))

    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })
    for (const line of originalLines) {
      const appended = await buffer.appendFile(SESSION_PATH, line, CONTEXT)
      expect(appended.ok, "帧 appendFile 应成功").toBe(true)
    }
    await buffer.flush(CONTEXT)

    // 两侧都经本仓 session-fold 的真实重放取回帧序列；「合并后」再经上游真实的帧折叠函数。
    const originalFrames = framesFromLog(`${HEADER_LINE}\n${originalLines.join("")}`)
    const mergedFrames = framesFromLog(`${HEADER_LINE}\n${receivedText(fileSystem)}`)
    expect(originalFrames.length, "原始帧一条不少").toBe(frames.length)
    expect(mergedFrames.length, `合并后帧数应减少：原始 ${originalFrames.length} 条，合并 ${mergedFrames.length} 条`).toBeLessThan(
      originalFrames.length,
    )

    const originalMessage = reduceAssistantMessageFrames(originalFrames)
    const mergedMessage = reduceAssistantMessageFrames(mergedFrames)
    expect(originalMessage, "原始序列必须能折出助手消息（前置：夹具本身合法）").toBeDefined()
    expect(mergedMessage, "合并后的序列必须能折出助手消息").toEqual(originalMessage)

    // 顺序不变量：合并后的整文件写入行 seq 严格递增（上游 open 的 validateCommittedWrites 口径）。
    expectStrictlyIncreasing(receivedFrames(fileSystem).map(row => row.seq))
  })

  it("非帧写入仍先冲干净缓冲、自身立即落盘（T-3 不因合并改变）[harness-frame-delta-merge-nonframe-immediate]", async () => {
    const fileSystem = new MemoryFileSystem()
    const buffer = new FrameBufferingFileSystem(fileSystem, { maxBufferBytes: 1024 * 1024 })

    await buffer.appendFile(SESSION_PATH, textDelta(1, "流"), CONTEXT)
    expect(fileSystem.files.get(SESSION_PATH), "帧未 drain 时不应出现在盘上").toBe(undefined)

    const nameLine = `${JSON.stringify({ ...setValue(value<string>("pi.session.name"), "合并探针"), seq: 2 })}\n`
    const appended = await buffer.appendFile(SESSION_PATH, nameLine, CONTEXT)
    expect(appended.ok, "非帧 appendFile 应成功").toBe(true)

    // 不调 flush：非帧写入自己就先把缓冲冲干净（一次底层调用落合并帧行），再立即落自己
    // （第二次底层调用）—— 两次调用都是这次 appendFile 触发的，缓冲没有残留到测试结束。
    expect(fileSystem.appends.length, "非帧写入应触发两次底层落盘：先冲帧、再落非帧").toBe(2)
    expect(fileSystem.appends[0].content.includes(`"delta":"流"`), "第一次调用应是被冲出的合并帧行").toBe(true)
    expect(fileSystem.appends[1].content, "第二次调用应是非帧行本身").toBe(nameLine)
    const onDisk = fileSystem.files.get(SESSION_PATH) ?? ""
    const frameAt = onDisk.indexOf(`"delta":"流"`)
    const nameAt = onDisk.indexOf(nameLine)
    expect(frameAt >= 0, `盘上应包含被冲出的合并帧行: ${onDisk.slice(0, 120)}`).toBe(true)
    expect(nameAt >= 0, "盘上应包含非帧行本身").toBe(true)
    expect(frameAt, "缓冲帧必须排在非帧行之前").toBeLessThan(nameAt)
    expect(onDisk.indexOf(nameLine), "非帧行是最后一行").toBe(onDisk.length - nameLine.length)
  })
})
