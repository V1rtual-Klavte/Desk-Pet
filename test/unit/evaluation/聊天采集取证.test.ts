// ==========================================
// 聊天采集取证 — 产品侧会话/记忆快照与 trace 归属单元测试
// ==========================================
//
// 采集链路跑在宿主进程里：会话与记忆读取走真实服务，trace 走真实 recorder。
// 这里只把「数据从哪来」换成可控夹具，不替换采集逻辑本身：
//   - 分页必须按 seq 游标走到尾部，读失败/越权/截断都显式不完整；
//   - 驱动新建会话的消息归 driver/assistant，fixture 既有消息不改写；
//   - 迟到事件保留原试次归属，未归属事件记为 orphan 并让封口不完整。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const CASE_ID = "saturday-companionship"
const TRIAL_ID = "trial-1"
const EVALUATION_RUN_ID = "chat-collect"
const OTHER_TRIAL_ID = "trial-2"

const fixture = vi.hoisted(() => ({
  runDir: "",
  dataRoot: "",
  controlDir: "",
  activeSessionId: null as string | null,
  metadata: [] as Array<{ id: string; cwd: string; path: string; createdAt: number; modifiedAt: number }>,
  entries: new Map<string, any[]>(),
  failSessions: new Set<string>(),
  stuckSessions: new Set<string>(),
  memoryItems: [] as any[],
  memoryStatus: { revision: 1, forgetEpoch: 0, itemCount: 0, candidateCount: 0, jobCount: 0 },
  readCalls: [] as Array<{ sessionId: string; query: any }>,
  listener: undefined as undefined | ((event: any) => void),
}))

vi.mock("@/services/session", () => ({
  getActiveSessionId: () => fixture.activeSessionId,
  listPiSessionMetadata: async () => fixture.metadata,
  readPiSessionEntriesOnce: async (sessionId: string, query: any) => {
    fixture.readCalls.push({ sessionId, query })
    if (fixture.failSessions.has(sessionId)) throw new Error(`磁盘损坏：${sessionId}`)
    const entries = fixture.entries.get(sessionId) ?? []
    if (query.order === "desc") {
      return [...entries].sort((a, b) => b.seq - a.seq).slice(0, query.limit)
    }
    if (fixture.stuckSessions.has(sessionId)) return entries.slice(0, query.limit)
    const after = query.cursor ? entries.filter(entry => entry.seq > query.cursor.seq) : entries
    return after.slice(0, query.limit)
  },
}))

vi.mock("@/services/agent/memory", () => ({
  memoryList: async () => fixture.memoryItems,
  memoryStatus: async () => fixture.memoryStatus,
}))

vi.mock("@/services/engine/runtime", () => ({
  laneMessageText: (message: { text?: string }) => message.text ?? "",
  subscribeRuntimeTrace: (listener: (event: any) => void) => {
    fixture.listener = listener
    return () => { fixture.listener = undefined }
  },
}))

vi.mock("@/services/sim/run-context", () => ({
  getSimEvalRunContext: async () => ({
    runDir: fixture.runDir,
    dataRoot: fixture.dataRoot,
    controlDir: fixture.controlDir,
    seedPath: join(fixture.runDir, "seed.json"),
    seedReportPath: join(fixture.runDir, "seed-report.json"),
    generation: "gen-test",
    hostPid: process.pid,
    ready: {
      schemaVersion: 1,
      generation: "gen-test",
      pid: process.pid,
      runDir: fixture.runDir,
      dataRoot: fixture.dataRoot,
      controlDir: fixture.controlDir,
      runtimeMode: "development",
      startedAt: new Date(0).toISOString(),
    },
  }),
}))

import { createSimCaptureManager } from "@/services/sim/capture"
import type { SimCaptureManager } from "@/services/sim/capture"
import { createSimTraceRecorder } from "@/services/sim/trace-recorder"
import type { SimTraceRecorder } from "@/services/sim/trace-recorder"

const roots: string[] = []
let sequence = 0

afterEach(() => {
  fixture.listener = undefined
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-capture-"))
  roots.push(root)
  return root
}

function messageEntry(id: string, seq: number, role: "user" | "assistant", text: string, at: number) {
  return { id, seq, type: "message", timestamp: at, message: { role, text } }
}

function memoryItem(id: string, version = 1) {
  return {
    id,
    version,
    status: "active",
    origin: "user",
    draft: {
      kind: "fact", scope: "user", scopeId: null, content: `记忆 ${id}`, summary: "",
      sourceIds: [], pinned: false, importance: 1, confidence: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function emit(kind: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  sequence += 1
  fixture.listener?.({
    schemaVersion: 1,
    traceId: "trace-test",
    runId: "run-default",
    sequence,
    monotonicMs: sequence,
    clockDomain: "webview",
    kind,
    createdAt: Date.now(),
    payload,
    ...extra,
  })
}

interface Harness {
  root: string
  runDir: string
  dataRoot: string
  attemptDir: string
  recorder: SimTraceRecorder
  manager: SimCaptureManager
}

async function createHarness(options: {
  sessions: Array<{ id: string; cwd?: string }>
  entries: Record<string, any[]>
  memoryItems?: any[]
  memoryStatus?: typeof fixture.memoryStatus
}): Promise<Harness> {
  const root = makeRoot()
  const runDir = join(root, "test", ".tmp", "sim-eval-collect")
  const dataRoot = join(runDir, "data")
  const attemptDir = join(root, "test", "reports", "chat", EVALUATION_RUN_ID, "attempts", "0001")
  mkdirSync(attemptDir, { recursive: true })
  fixture.runDir = runDir
  fixture.dataRoot = dataRoot
  fixture.controlDir = join(dataRoot, "logs", "sim", "control")
  fixture.metadata = options.sessions.map(session => ({
    id: session.id,
    cwd: session.cwd ?? dataRoot,
    path: "",
    createdAt: 1,
    modifiedAt: 2,
  }))
  fixture.entries = new Map(Object.entries(options.entries))
  fixture.failSessions = new Set()
  fixture.stuckSessions = new Set()
  fixture.memoryItems = options.memoryItems ?? []
  fixture.memoryStatus = options.memoryStatus ?? {
    revision: 1, forgetEpoch: 0, itemCount: fixture.memoryItems.length, candidateCount: 0, jobCount: 0,
  }
  fixture.activeSessionId = options.sessions[0]?.id ?? null
  fixture.readCalls = []
  const recorder = createSimTraceRecorder({ collectEvents: false })
  const manager = createSimCaptureManager(recorder)
  return { root, runDir, dataRoot, attemptDir, recorder, manager }
}

function startOptions(trials = [{ caseId: CASE_ID, trialId: TRIAL_ID }]) {
  return { attemptDir: "", evaluationRunId: EVALUATION_RUN_ID, expectedTrials: trials }
}

function stopRecorder(recorder: SimTraceRecorder) {
  recorder.stop()
}

describe("聊天采集取证", () => {
  it("跨会话按 seq 游标读到尾部，并把驱动新消息归为 driver/assistant", async () => {
    const seed = [
      messageEntry("seed-user", 1, "user", "早上好", 1000),
      messageEntry("seed-assistant", 2, "assistant", "早呀，今天想聊点什么？", 1001),
    ]
    const driverEntries = Array.from({ length: 201 }, (_, index) =>
      messageEntry(`driver-${index + 1}`, index + 1, index % 2 === 0 ? "user" : "assistant", `第 ${index + 1} 句`, 2000 + index))
    const harness = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": seed },
      memoryItems: [memoryItem("m1")],
    })

    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    expect(started.complete).toBe(true)
    expect(started.before.sessions).toEqual([
      { sessionId: "session-seed", seqTip: 2, messageCount: 2, complete: true },
    ])

    fixture.metadata = [
      ...fixture.metadata,
      { id: "session-driver", cwd: fixture.dataRoot, path: "", createdAt: 3, modifiedAt: 4 },
    ]
    fixture.entries.set("session-driver", driverEntries)
    fixture.memoryItems = [memoryItem("m1"), memoryItem("m2")]
    fixture.memoryStatus = { ...fixture.memoryStatus, itemCount: 2 }

    await harness.manager.beginTrial(CASE_ID, TRIAL_ID)
    emit("input_accepted", { requestId: "req-1" }, { runId: "run-chat-1" })
    emit("turn_reply", {}, { runId: "run-chat-1" })
    await harness.manager.endTrial(CASE_ID, TRIAL_ID)
    const finished = await harness.manager.finish({ status: "completed" })
    stopRecorder(harness.recorder)

    expect(finished.complete).toBe(true)
    expect(finished.status).toBe("completed")
    expect(finished.trace).toMatchObject({ status: "completed", complete: true, orphanCount: 0, droppedCount: 0 })
    expect(finished.dialogue.messageCount).toBe(203)
    expect(finished.dialogue.sessions).toEqual(["session-driver", "session-seed"])
    expect(finished.dialogue.origins).toEqual({ fixture: 2, driver: 101, assistant: 100 })
    expect(finished.sessions.added).toEqual(["session-driver"])
    expect(finished.memory.added).toEqual(["m2"])
    expect(finished.issues).toEqual([])

    const pages = fixture.readCalls.filter(call => call.sessionId === "session-driver" && call.query.order === "asc")
    expect(pages).toHaveLength(2)
    expect(pages[0].query.cursor).toBeUndefined()
    expect(pages[1].query.cursor).toEqual({ seq: 200 })
    expect(fixture.readCalls.find(call => call.sessionId === "session-driver" && call.query.order === "desc")?.query)
      .toMatchObject({ type: "message", order: "desc", limit: 1 })
  })

  it("分页游标不前进时显式登记问题，不把重复页当成完整会话", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-stuck" }],
      entries: { "session-stuck": Array.from({ length: 200 }, (_, index) =>
        messageEntry(`stuck-${index + 1}`, index + 1, "user", `第 ${index + 1} 句`, 1000 + index)) },
    })
    fixture.stuckSessions.add("session-stuck")

    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    await harness.manager.finish({ status: "interrupted", reason: "测试收口" })
    stopRecorder(harness.recorder)

    expect(started.complete).toBe(false)
    expect(started.before.sessions[0]).toMatchObject({ complete: false })
    expect(started.issues.join("\n")).toContain("会话 session-stuck 分页游标未前进（seq=1 <= 200）")
  })

  it("会话读取失败时显式登记问题，不伪装成空会话", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-broken" }],
      entries: { "session-broken": [messageEntry("broken-1", 1, "user", "还能读到吗", 1000)] },
    })
    fixture.failSessions.add("session-broken")

    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    await harness.manager.finish({ status: "interrupted", reason: "测试收口" })
    stopRecorder(harness.recorder)

    expect(started.complete).toBe(false)
    expect(started.before.sessions[0]).toMatchObject({ sessionId: "session-broken", messageCount: 0, complete: false })
    expect(started.issues.join("\n")).toContain("会话 session-broken 读取失败：磁盘损坏：session-broken")
  })

  it("记忆状态计数多于实际列出时判为未完采", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)] },
      memoryItems: [memoryItem("m1"), memoryItem("m2")],
      memoryStatus: { revision: 3, forgetEpoch: 0, itemCount: 3, candidateCount: 0, jobCount: 0 },
    })

    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    await harness.manager.finish({ status: "interrupted", reason: "测试收口" })
    stopRecorder(harness.recorder)

    expect(started.complete).toBe(false)
    expect(started.before.memory).toMatchObject({ itemCount: 3, collected: 2, complete: false })
    expect(started.issues.join("\n")).toContain("记忆条目未完采：状态 3 条，实际列出 2 条")
  })

  it("跨数据根会话被排除，并让采集显式不完整", async () => {
    const harness = await createHarness({
      sessions: [
        { id: "session-seed" },
        { id: "session-foreign", cwd: join(tmpdir(), "sim-eval-other-root", "data") },
      ],
      entries: {
        "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)],
        "session-foreign": [messageEntry("foreign-1", 1, "user", "别人的会话", 1001)],
      },
    })

    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    await harness.manager.finish({ status: "interrupted", reason: "测试收口" })
    stopRecorder(harness.recorder)

    expect(started.complete).toBe(false)
    expect(started.before.excludedSessions).toEqual([
      expect.objectContaining({ sessionId: "session-foreign", reason: "会话 cwd 不属于本次隔离数据根" }),
    ])
    expect(started.issues.join("\n")).toContain("排除跨数据根会话 session-foreign")
    expect(started.before.sessions.map(session => session.sessionId)).toEqual(["session-seed"])
  })

  it("既有消息被改写或消失时登记问题，不给出完整结论", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: {
        "session-seed": [
          messageEntry("msg-1", 1, "user", "第一条", 1000),
          messageEntry("msg-2", 2, "assistant", "第二条", 1001),
        ],
      },
    })
    const started = await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    expect(started.complete).toBe(true)

    fixture.entries.set("session-seed", [
      messageEntry("msg-1", 1, "user", "第一条（被改写）", 1000),
    ])
    const finished = await harness.manager.finish({ status: "completed" })
    stopRecorder(harness.recorder)

    expect(finished.complete).toBe(false)
    expect(finished.status).toBe("interrupted")
    expect(finished.issues.join("\n")).toContain("既有消息在采集中被改写：session-seed/msg-1")
    expect(finished.issues.join("\n")).toContain("既有消息在采集中消失：session-seed/msg-2")
  })

  it("声明的试次从未开始或未收到 trial_end 时封口不完整", async () => {
    const missing = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)] },
    })
    await missing.manager.start({ ...startOptions(), attemptDir: missing.attemptDir })
    const missingResult = await missing.manager.finish({ status: "completed" })
    stopRecorder(missing.recorder)

    expect(missingResult.complete).toBe(false)
    expect(missingResult.trace.status).toBe("interrupted")
    expect(missingResult.issues.join("\n")).toContain(`声明的试次 ${CASE_ID}/${TRIAL_ID} 从未开始`)

    const unclosed = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)] },
    })
    await unclosed.manager.start({ ...startOptions(), attemptDir: unclosed.attemptDir })
    await unclosed.manager.beginTrial(CASE_ID, TRIAL_ID)
    const unclosedResult = await unclosed.manager.finish({ status: "completed" })
    stopRecorder(unclosed.recorder)

    expect(unclosedResult.complete).toBe(false)
    expect(unclosedResult.trace.trials).toEqual([
      expect.objectContaining({ caseId: CASE_ID, trialId: TRIAL_ID, status: "interrupted" }),
    ])
    expect(unclosedResult.issues.join("\n")).toContain(`试次 ${CASE_ID}/${TRIAL_ID} 结束时仍未收到 trial_end`)
  })

  it("未归属的 orphan 事件留痕，并让封口判为不完整", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)] },
    })
    await harness.manager.start({ ...startOptions(), attemptDir: harness.attemptDir })
    await harness.manager.beginTrial(CASE_ID, TRIAL_ID)
    emit("turn_reply", { note: "后台事件没有 runId" }, { runId: undefined })
    await harness.manager.endTrial(CASE_ID, TRIAL_ID)
    const finished = await harness.manager.finish({ status: "interrupted", reason: "宿主停止时采集仍未封口" })
    stopRecorder(harness.recorder)

    expect(finished.complete).toBe(false)
    expect(finished.trace.orphanCount).toBe(1)
    expect(finished.issues.join("\n")).toContain("存在 1 个未归属 orphan 事件，需复核")
    expect(finished.issues.join("\n")).toContain("宿主停止时采集仍未封口")
  })

  it("迟到事件保留原试次归属，不改写到当前试次", async () => {
    const harness = await createHarness({
      sessions: [{ id: "session-seed" }],
      entries: { "session-seed": [messageEntry("seed-1", 1, "user", "你好", 1000)] },
    })
    await harness.manager.start({
      ...startOptions([
        { caseId: CASE_ID, trialId: TRIAL_ID },
        { caseId: CASE_ID, trialId: OTHER_TRIAL_ID },
      ]),
      attemptDir: harness.attemptDir,
    })

    await harness.manager.beginTrial(CASE_ID, TRIAL_ID)
    emit("input_accepted", { requestId: "req-late" }, { runId: "run-late" })
    await harness.manager.endTrial(CASE_ID, TRIAL_ID)
    await harness.manager.beginTrial(CASE_ID, OTHER_TRIAL_ID)
    emit("turn_reply", { marker: "late" }, { runId: "run-late" })
    await harness.manager.endTrial(CASE_ID, OTHER_TRIAL_ID)
    const finished = await harness.manager.finish({ status: "completed" })
    stopRecorder(harness.recorder)

    expect(finished.complete).toBe(true)
    const records = readFileSync(join(harness.attemptDir, "trace.jsonl"), "utf8")
      .trimEnd().split("\n").filter(Boolean)
      .flatMap(line => JSON.parse(line).chunk.events as any[])
    const late = records.find(record => record.event?.payload?.marker === "late")
    expect(late).toMatchObject({ sceneId: CASE_ID, trialId: TRIAL_ID, orphan: false })
  })
})
