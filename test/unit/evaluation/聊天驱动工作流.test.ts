// ==========================================
// 聊天驱动工作流 — 授权、固定时钟、驱动进度、预算与同条件对照
// ==========================================
//
// 这些断言只钉编排层：授权范围与预算、整小时时区、驱动包白名单、可续跑边界、
// 预算到界前停止、未知用量不记零、固定条件对照与留出使用记录。
// 不读探针／oracle，不判分，不构造任何聊天质量结论。
import { describe, expect, it } from "vitest"
import type {
  CaseEntry,
  CheckpointSpec,
  DriverPackage,
  DriverStep,
} from "../../sim/desk-pet-chat/dataset.mjs"
import { buildDriverPackage, loadDataset } from "../../sim/desk-pet-chat/dataset.mjs"
import type {
  Authorization,
  DriverProgress,
  DriverTransport,
  MessageOperationRef,
} from "../../sim/desk-pet-chat/workflow.mjs"
import {
  AUTHORIZATION_SCHEMA_VERSION,
  DRIVER_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
  assertRepairAllowed,
  assertResumable,
  authorizationFingerprint,
  authorizeRequestedModels,
  buildClockFile,
  checkDriverBudget,
  compareRunConditions,
  conditionsFromRun,
  createDriverProgress,
  driverOutcome,
  driverSummary,
  executeDriver,
  holdoutUsage,
  readDriverProgress,
  timezoneForInstant,
  validateAuthorization,
  validateClockFile,
  validateDriverPackage,
  validateSyncPoints,
} from "../../sim/desk-pet-chat/workflow.mjs"

const CASE_ID = "saturday-companionship"
const PURPOSE = "regression"
const HASH = `sha256:${"a".repeat(64)}`
const HASH_B = `sha256:${"b".repeat(64)}`
const AT_1 = "2026-10-24T09:05:00.000+08:00"
const AT_2 = "2026-10-24T09:10:00.000+08:00"
const AT_3 = "2026-10-24T09:15:00.000+08:00"

function authorization(overrides: Record<string, unknown> = {}): Authorization {
  return validateAuthorization({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    approvedBy: "测试用户",
    approvedAt: "2026-10-25T10:00:00.000+08:00",
    scope: {
      caseIds: [CASE_ID],
      purpose: PURPOSE,
      models: ["provider/model-under-test"],
      data: "isolated",
    },
    budget: { messages: 5, tokens: 5_000, minutes: 30, trials: 2, repairs: 1 },
    holdout: false,
    ...overrides,
  }, { caseIds: [CASE_ID], purpose: PURPOSE })
}

function baseSteps(): DriverStep[] {
  return [
    { id: "open", kind: "host", method: "chat_new_session", at: AT_1 },
    { id: "say", kind: "message", text: "你好", at: AT_2 },
    { id: "read", kind: "host", method: "memory_dreaming_sweep", at: AT_3 },
  ]
}

function driverPackage(steps: DriverStep[] = baseSteps()): DriverPackage {
  return {
    schemaVersion: 4,
    caseId: CASE_ID,
    revision: 1,
    specHash: HASH,
    userRole: {
      knownFacts: ["用户周末想轻松聊天"],
      goal: "自然陪伴",
      tone: "口语",
      allowedActions: ["chat"],
      mustNotReveal: ["探针"],
    },
    driver: steps,
  }
}

function progressFor(
  pkg: DriverPackage,
  budget = { messages: 5, tokens: 5_000, minutes: 30, trials: 2, repairs: 1 },
): DriverProgress {
  return createDriverProgress({
    driverPackage: pkg,
    driverHash: HASH_B,
    budget,
    clockBase: AT_1,
    startedAt: "2026-10-24T09:00:00.000+08:00",
  })
}

/** 确定性时间：sleep 只推进测试时钟，不真的等待。 */
function manualTime(start = Date.parse("2026-10-24T09:00:00.000+08:00")) {
  let current = start
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms },
    advance: (ms: number) => { current += ms },
  }
}

const TRIAL_ID = "trial-test"
const GENERATION = "generation-test"

interface FakeTransportState {
  active: string
  sessions: string[]
  messages: string[]
  hostCalls: string[]
  clockTimes: string[]
  operations: MessageOperationRef[]
}

function fakeTransport(overrides: Partial<DriverTransport> & { state?: FakeTransportState } = {}) {
  const state: FakeTransportState = overrides.state ?? {
    active: "fixture-session",
    sessions: ["fixture-session"],
    messages: [],
    hostCalls: [],
    clockTimes: [],
    operations: [],
  }
  const transport: DriverTransport & { state: FakeTransportState } = {
    clock: async (at) => {
      state.clockTimes.push(at)
      return { base: at, now: at, timezone: "Etc/GMT-8" }
    },
    message: async (text, operation) => {
      state.messages.push(text)
      state.operations.push(operation)
      return {
        sessionId: state.active,
        reply: `回复：${text}`,
        outcome: "succeeded",
        toolCalls: [],
        operation: { ...operation, trialId: TRIAL_ID, sessionId: state.active, generation: GENERATION },
        requestId: operation.operationId,
      }
    },
    sessions: async () => ({
      active: state.active,
      sessions: state.sessions.map(id => ({ id })),
    }),
    host: async (method) => {
      state.hostCalls.push(method)
      if (method === "chat_new_session") {
        const id = `session-${state.sessions.length}`
        state.sessions.push(id)
        state.active = id
        return { method, result: { sessionId: id } }
      }
      return { method, result: { ok: true } }
    },
    context: async () => ({ context: { usageTotal: { calls: 2, reported: 2, total: 120 } } }),
    memoryState: async () => ({ pendingSources: 0, activeJobs: [], jobs: [] }),
    ...overrides,
    state,
  }
  return transport
}

function roundtrip(progress: DriverProgress): DriverProgress {
  return readDriverProgress(JSON.parse(JSON.stringify(progress)))
}

function assertWorkflowError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError)
    expect((error as WorkflowError).code).toBe(code)
    return
  }
  expect.unreachable(`应抛出 ${code}`)
}

describe("授权与预算", () => {
  it("接受完整授权并生成稳定指纹；范围变化会改变指纹 [chat-run-authorization]", () => {
    const first = authorization()
    expect(first.scope).toEqual({
      caseIds: [CASE_ID],
      purpose: PURPOSE,
      models: ["provider/model-under-test"],
      data: "isolated",
    })
    expect(first.budget).toEqual({ messages: 5, tokens: 5_000, minutes: 30, trials: 2, repairs: 1 })
    const second = authorization()
    expect(authorizationFingerprint(first)).toBe(authorizationFingerprint(second))
    const wider = authorization({
      scope: { caseIds: [CASE_ID], purpose: PURPOSE, models: ["provider/other"], data: "isolated" },
    })
    expect(authorizationFingerprint(wider)).not.toBe(authorizationFingerprint(first))
  })

  it("拒绝缺用例、错用途、留出错配与非隔离数据范围", () => {
    assertWorkflowError(() => validateAuthorization({
      schemaVersion: 1, approvedBy: "用户", approvedAt: "2026-10-25T10:00:00+08:00",
      scope: { caseIds: ["other-case"], purpose: PURPOSE, models: ["m"], data: "isolated" },
      budget: { messages: 1, tokens: 1, minutes: 1, trials: 1, repairs: 0 }, holdout: false,
    }, { caseIds: [CASE_ID], purpose: PURPOSE }), "authorization.scope")

    assertWorkflowError(() => authorization({
      scope: { caseIds: [CASE_ID], purpose: "development", models: ["m"], data: "isolated" },
    }), "authorization.purpose")

    assertWorkflowError(() => authorization({ holdout: true }), "authorization.holdout")

    assertWorkflowError(() => authorization({
      scope: { caseIds: [CASE_ID], purpose: PURPOSE, models: ["m"], data: "shared" },
    }), "authorization.data")
  })

  it("拒绝重复模型/用例、零预算、负修复次数与任何凭据字段", () => {
    assertWorkflowError(() => authorization({
      scope: { caseIds: [CASE_ID], purpose: PURPOSE, models: ["m", "m"], data: "isolated" },
    }), "authorization.scope")
    assertWorkflowError(() => authorization({
      scope: { caseIds: [CASE_ID, CASE_ID], purpose: PURPOSE, models: ["m"], data: "isolated" },
    }), "authorization.scope")
    assertWorkflowError(() => authorization({
      budget: { messages: 0, tokens: 1, minutes: 1, trials: 1, repairs: 0 },
    }), "schema.invalid")
    assertWorkflowError(() => authorization({
      budget: { messages: 1, tokens: 1, minutes: 1, trials: 1, repairs: -1 },
    }), "schema.invalid")
    assertWorkflowError(() => authorization({
      scope: { caseIds: [CASE_ID], purpose: PURPOSE, models: ["m"], data: "isolated", apiKey: "sk-test" },
    }), "authorization.secret")
  })

  it("请求模型必须在授权范围内，空模型身份直接拒绝", () => {
    const auth = authorization({
      scope: { caseIds: [CASE_ID], purpose: PURPOSE, models: ["provider/a", "provider/b"], data: "isolated" },
    })
    expect(authorizeRequestedModels(auth, "provider/a")).toBe(true)
    expect(authorizeRequestedModels(auth, ["provider/a", "provider/b"])).toBe(true)
    assertWorkflowError(() => authorizeRequestedModels(auth, "provider/c"), "authorization.models")
    assertWorkflowError(() => authorizeRequestedModels(auth, "  "), "authorization.models")
  })

  it("修复序号从 1 开始且不超过授权修复次数", () => {
    const auth = authorization()
    expect(assertRepairAllowed({ authorization: auth, repairIndex: 1 })).toBe(true)
    assertWorkflowError(() => assertRepairAllowed({ authorization: auth, repairIndex: 0 }), "schema.invalid")
    assertWorkflowError(() => assertRepairAllowed({ authorization: auth, repairIndex: 2 }), "authorization.repairs")
  })
})

describe("固定时钟", () => {
  it("整小时偏移映射为 Etc/GMT∓N，半小时时区拒绝", () => {
    expect(timezoneForInstant("2026-10-24T09:00:00+08:00")).toEqual({
      offsetMinutes: 480,
      timezone: "Etc/GMT-8",
    })
    expect(timezoneForInstant("2026-10-24T09:00:00Z")).toEqual({ offsetMinutes: 0, timezone: "UTC" })
    expect(timezoneForInstant("2026-10-24T09:00:00-05:00").timezone).toBe("Etc/GMT+5")
    assertWorkflowError(() => timezoneForInstant("2026-10-24T09:00:00+05:30"), "clock.offset")
    assertWorkflowError(() => timezoneForInstant("2026-10-24 09:00"), "clock.format")
  })

  it("clock.json 的时区必须与 base 偏移一致，未知字段拒绝", () => {
    const clock = buildClockFile({ base: AT_1, reason: "fixture:test" })
    expect(clock).toMatchObject({ schemaVersion: 1, base: AT_1, timezone: "Etc/GMT-8", reason: "fixture:test" })
    expect(validateClockFile(clock)).toEqual(clock)
    assertWorkflowError(() => validateClockFile({ ...clock, timezone: "Etc/GMT+8" }), "clock.timezone")
    assertWorkflowError(() => validateClockFile({ ...clock, extra: true }), "schema.invalid")
  })
})

describe("驱动包与检查点", () => {
  it("接受真实用例构造的驱动包，不携带探针或 oracle", () => {
    const dataset = loadDataset()
    const entry = dataset.cases.find((candidate: CaseEntry) => candidate.caseId === CASE_ID)
    expect(entry).toBeDefined()
    const pkg = buildDriverPackage(entry!)
    expect(Object.keys(pkg).sort()).toEqual(["caseId", "driver", "revision", "schemaVersion", "specHash", "userRole"])
    expect(validateDriverPackage(pkg)).toEqual(pkg)
  })

  it("拒绝探针字段、未知宿主方法、重复 id 与倒退时间", () => {
    const pkg = driverPackage()
    assertWorkflowError(() => validateDriverPackage({ ...pkg, probes: [] }), "schema.invalid")
    assertWorkflowError(() => validateDriverPackage(driverPackage([
      { id: "open", kind: "host", method: "read_probes" as never, at: AT_1 },
    ])), "driver.method")
    assertWorkflowError(() => validateDriverPackage(driverPackage([
      { id: "say", kind: "message", text: "一", at: AT_1 },
      { id: "say", kind: "message", text: "二", at: AT_2 },
    ])), "driver.steps")
    assertWorkflowError(() => validateDriverPackage(driverPackage([
      { id: "later", kind: "message", text: "一", at: AT_3 },
      { id: "earlier", kind: "message", text: "二", at: AT_1 },
    ])), "driver.clock-order")
  })

  it("检查点只接受登记等待类型且 id 不重复", () => {
    const points = validateSyncPoints([
      { id: "c1", after: "say", wait: "assistant_message" },
      { id: "c2", after: "say", wait: "memory_extraction_end" },
    ])
    expect(points.map(point => point.wait)).toEqual(["assistant_message", "memory_extraction_end"])
    assertWorkflowError(() => validateSyncPoints([
      { id: "c1", after: "say", wait: "unknown_wait" },
    ]), "syncPoints.wait")
    assertWorkflowError(() => validateSyncPoints([
      { id: "c1", after: "say", wait: "assistant_message" },
      { id: "c1", after: "open", wait: "host_readback" },
    ]), "syncPoints.invalid")
  })
})

describe("驱动进度、预算与续跑", () => {
  it("新进度可往返读取，状态与用量字段完整", () => {
    const progress = roundtrip(progressFor(driverPackage()))
    expect(progress.schemaVersion).toBe(DRIVER_PROGRESS_SCHEMA_VERSION)
    expect(progress.status).toBe("pending")
    expect(progress.index).toBe(0)
    expect(progress.usage).toMatchObject({
      messages: 0,
      tokens: 0,
      tokensUnknown: false,
      contextErrors: [],
    })
    expect(progress.budget.minutes).toBe(30)
  })

  it("已完成、已阻塞与有 in-flight 的进度分别拒绝续跑 [chat-driver-progress-resume]", () => {
    const progress = progressFor(driverPackage())
    expect(assertResumable(progress)).toEqual({ resumable: true })

    progress.status = "completed"
    expect(assertResumable(progress)).toEqual({ resumable: false, reason: "驱动已完成" })

    progress.status = "blocked"
    progress.blocked = { code: "budget.messages", message: "预算用尽", at: AT_1 }
    assertWorkflowError(() => roundtrip(progress) && assertResumable(progress), "driver.blocked")

    const inFlight = progressFor(driverPackage())
    inFlight.inFlight = { index: 0, stepId: "open", kind: "host", at: AT_1, startedAt: AT_1 }
    assertWorkflowError(() => assertResumable(roundtrip(inFlight)), "driver.inflight")
  })

  it("预算按消息、分钟与已知 token 分别到界；未知用量只警告不记零", () => {
    const progress = progressFor(driverPackage())
    progress.usage.messages = 5
    expect(checkDriverBudget({ progress })).toMatchObject({ ok: false, code: "budget.messages" })

    const timed = progressFor(driverPackage())
    timed.usage.startedAt = "2026-10-24T09:00:00.000+08:00"
    expect(checkDriverBudget({
      progress: timed,
      now: Date.parse("2026-10-24T09:30:00.000+08:00"),
    })).toMatchObject({ ok: false, code: "budget.minutes" })

    const tokens = progressFor(driverPackage())
    tokens.usage.tokens = 5_000
    expect(checkDriverBudget({ progress: tokens })).toMatchObject({ ok: false, code: "budget.tokens" })

    const unknown = progressFor(driverPackage())
    unknown.usage.tokensUnknown = true
    expect(checkDriverBudget({ progress: unknown })).toEqual({ ok: true, warnings: ["tokens.unknown"] })
  })
})

describe("驱动执行", () => {
  it("按步骤推进时钟、建立会话、发送消息并满足检查点 [chat-driver-steps]", async () => {
    const pkg = driverPackage()
    const progress = progressFor(pkg)
    const time = manualTime()
    // 第一次 memoryState 是消息前的基线；之后才出现本次抽取作业。
    let memoryReads = 0
    const transport = fakeTransport({
      memoryState: async () => {
        memoryReads += 1
        return {
          pendingSources: 0,
          activeJobs: [],
          jobs: memoryReads === 1
            ? []
            : [{ id: "job-extract", phase: "review", status: "completed", updatedAt: 1 }],
        }
      },
    })
    const syncPoints: CheckpointSpec[] = [
      { id: "new-session", after: "open", wait: "session_created" },
      { id: "reply", after: "say", wait: "assistant_message" },
      { id: "readback", after: "read", wait: "host_readback" },
      { id: "extraction", after: "say", wait: "memory_extraction_end" },
    ]

    const summary = await executeDriver({
      progress,
      driverPackage: pkg,
      syncPoints,
      transport,
      now: time.now,
      sleep: time.sleep,
      onProgress: (draft) => { roundtrip(draft) },
    })

    expect(summary.status).toBe("completed")
    expect(summary.index).toBe(3)
    expect(summary.completed).toBe(3)
    expect(summary.failed).toBe(0)
    expect(transport.state.clockTimes).toEqual([AT_1, AT_2, AT_3])
    expect(transport.state.hostCalls).toEqual(["chat_new_session", "memory_dreaming_sweep"])
    expect(transport.state.messages).toEqual(["你好"])
    expect(progress.steps.map(step => step.status)).toEqual(["completed", "completed", "completed"])
    expect(progress.steps[0]?.result).toMatchObject({ result: { createdSessionId: "session-1" } })
    expect(progress.steps[1]?.checkpoints?.map(check => [check.id, check.status])).toEqual([
      ["reply", "satisfied"],
      ["extraction", "satisfied"],
    ])
    expect(progress.steps[2]?.checkpoints?.map(check => check.status)).toEqual(["satisfied"])
    expect(progress.steps[0]?.checkpoints?.map(check => check.status)).toEqual(["satisfied"])
    expect(progress.usage.messages).toBe(1)
    expect(progress.usage.tokens).toBe(120)
    expect(progress.usage.tokensUnknown).toBe(false)
  })

  it("消息步骤携带唯一操作身份，回执回存会话与代际 [chat-driver-operation]", async () => {
    const pkg = driverPackage([
      { id: "say-1", kind: "message", text: "一", at: AT_1 },
      { id: "say-2", kind: "message", text: "二", at: AT_2 },
    ])
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport()

    await executeDriver({ progress, driverPackage: pkg, transport, now: time.now, sleep: time.sleep })

    expect(transport.state.operations.map(operation => [operation.caseId, operation.stepId])).toEqual([
      [CASE_ID, "say-1"],
      [CASE_ID, "say-2"],
    ])
    expect(transport.state.operations[0]?.operationId).toMatch(/^op-/)
    expect(transport.state.operations[0]?.operationId)
      .not.toBe(transport.state.operations[1]?.operationId)
    expect(progress.steps[0]?.result).toMatchObject({
      kind: "message",
      sessionId: "fixture-session",
      requestId: transport.state.operations[0]?.operationId,
      operation: {
        operationId: transport.state.operations[0]?.operationId,
        caseId: CASE_ID,
        stepId: "say-1",
        trialId: TRIAL_ID,
        sessionId: "fixture-session",
        generation: GENERATION,
      },
    })
    expect(progress.steps[1]?.result).toMatchObject({
      requestId: transport.state.operations[1]?.operationId,
      operation: { stepId: "say-2", sessionId: "fixture-session" },
    })
  })

  it("回执的 operation 与本步不一致时阻塞，不把回复记到本步", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport({
      message: async (text, operation) => ({
        sessionId: "fixture-session",
        reply: `回复：${text}`,
        outcome: "succeeded",
        toolCalls: [],
        operation: {
          ...operation,
          operationId: "op-other",
          trialId: TRIAL_ID,
          sessionId: "fixture-session",
          generation: GENERATION,
        },
        requestId: operation.operationId,
      }),
    })

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: time.now,
      sleep: time.sleep,
    })).rejects.toThrow(/回执的 operation 与本步不一致/)

    expect(progress.status).toBe("blocked")
    expect(progress.steps[0]).toMatchObject({ id: "say", status: "failed" })
    expect(progress.steps[0]?.result?.reply).toBeUndefined()
    expect(progress.usage.messages).toBe(1)
  })

  it("缺少请求身份的回执不被当作请求结果", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport({
      message: async () => ({
        sessionId: "fixture-session",
        reply: "最后一条助手消息",
        outcome: "succeeded",
        toolCalls: [],
      }),
    })

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: time.now,
      sleep: time.sleep,
    })).rejects.toThrow(/缺少请求身份/)

    expect(progress.status).toBe("blocked")
    expect(progress.steps[0]?.status).toBe("failed")
    expect(progress.steps[0]?.result?.reply).toBeUndefined()
  })

  it("消息预算到界时在下一步副作用前阻塞 [chat-driver-budget]", async () => {
    const pkg = driverPackage([
      { id: "say-1", kind: "message", text: "一", at: AT_1 },
      { id: "say-2", kind: "message", text: "二", at: AT_2 },
    ])
    const progress = progressFor(pkg, { messages: 1, tokens: 5_000, minutes: 30, trials: 1, repairs: 0 })
    const time = manualTime()
    const transport = fakeTransport()

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: time.now,
      sleep: time.sleep,
    })).rejects.toThrow(/消息预算已用尽/)

    expect(transport.state.messages).toEqual(["一"])
    expect(progress.status).toBe("blocked")
    expect(progress.blocked?.code).toBe("budget.messages")
    expect(progress.index).toBe(1)
    expect(driverOutcome(progress)).toMatchObject({ status: "interrupted" })
    assertWorkflowError(() => assertResumable(progress), "driver.blocked")
  })

  it("步骤失败记录失败原因并阻塞，不继续执行后续步骤", async () => {
    const pkg = driverPackage()
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport({
      message: async (text, operation) => ({
        sessionId: "fixture-session",
        reply: "",
        outcome: "failed",
        toolCalls: [],
        operation: { ...operation, trialId: TRIAL_ID, sessionId: "fixture-session", generation: GENERATION },
        requestId: operation.operationId,
        failure: { kind: "provider", message: "连接失败" },
      }),
    })

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: time.now,
      sleep: time.sleep,
    })).rejects.toThrow(/回合失败/)

    expect(progress.status).toBe("blocked")
    expect(progress.steps).toHaveLength(2)
    expect(progress.steps[1]).toMatchObject({ id: "say", status: "failed" })
    expect(progress.steps[1]?.error).toContain("provider")
    expect(progress.index).toBe(1)
    expect(progress.inFlight).toBeNull()
    expect(transport.state.hostCalls).toEqual(["chat_new_session"])
  })

  it("有 in-flight 的进度不重放副作用", async () => {
    const pkg = driverPackage()
    const progress = progressFor(pkg)
    progress.status = "running"
    progress.inFlight = { index: 1, stepId: "say", kind: "message", at: AT_2, startedAt: AT_2 }
    const persisted = roundtrip(progress)
    const transport = fakeTransport()

    await expect(executeDriver({
      progress: persisted,
      driverPackage: pkg,
      transport,
      now: manualTime().now,
      sleep: manualTime().sleep,
    })).rejects.toThrow(/副作用不得重放/)

    expect(transport.state.messages).toEqual([])
    expect(persisted.index).toBe(0)
  })

  it("上下文用量缺失时记未知，不把未知当零", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport({
      context: () => Promise.reject(new Error("context 不可用")),
    })

    await executeDriver({ progress, driverPackage: pkg, transport, now: time.now, sleep: time.sleep })

    expect(progress.status).toBe("completed")
    expect(progress.usage.tokens).toBe(0)
    expect(progress.usage.tokensUnknown).toBe(true)
    expect(progress.usage.contextErrors).toEqual([
      expect.objectContaining({ stepId: "say", error: "context 不可用" }),
    ])
    expect(driverSummary(progress).usage.tokensUnknown).toBe(true)
  })

  it("没有新抽取作业时不得用空水位判定结束 [chat-driver-memory-baseline]", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    // 基线前后都是同一批已结束作业：0/0 只说明此刻空闲，不证明本轮抽取发生过。
    const transport = fakeTransport({
      memoryState: async () => ({
        pendingSources: 0,
        activeJobs: [],
        jobs: [{ id: "job-existing", phase: "review", status: "completed", updatedAt: 0 }],
      }),
    })

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      syncPoints: [{ id: "extraction", after: "say", wait: "memory_extraction_end" }],
      transport,
      now: time.now,
      sleep: time.sleep,
      memoryWait: { deadlineMs: 60, pollMs: 10, stableMs: 10 },
    })).rejects.toThrow(/没有发现新抽取作业/)

    expect(progress.status).toBe("blocked")
    expect(progress.blocked?.code).toBe("checkpoint.timeout")
    expect(progress.steps[0]?.checkpoints?.[0]?.status).toBe("timeout")
  })

  it("基线之后的新抽取作业结束后检查点才满足 [chat-driver-memory-new-job]", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    const states = [
      { pendingSources: 0, activeJobs: [], jobs: [] },
      { pendingSources: 0, activeJobs: [{ id: "job-new" }], jobs: [{ id: "job-new", phase: "review", status: "running", updatedAt: 1 }] },
      { pendingSources: 0, activeJobs: [], jobs: [{ id: "job-new", phase: "review", status: "completed", updatedAt: 2 }] },
      { pendingSources: 0, activeJobs: [], jobs: [{ id: "job-new", phase: "review", status: "completed", updatedAt: 2 }] },
    ]
    let memoryReads = 0
    const transport = fakeTransport({
      memoryState: async () => states[Math.min(memoryReads++, states.length - 1)]!,
    })

    await executeDriver({
      progress,
      driverPackage: pkg,
      syncPoints: [{ id: "extraction", after: "say", wait: "memory_extraction_end" }],
      transport,
      now: time.now,
      sleep: time.sleep,
      memoryWait: { deadlineMs: 1_000, pollMs: 10, stableMs: 10 },
    })

    const check = progress.steps[0]?.checkpoints?.[0]
    expect(check?.status).toBe("satisfied")
    expect(check?.detail).toContain("job-new")
    expect(check?.detail).toContain("completed")
  })

  it("新抽取作业以取消收口时仍视为抽取结束 [chat-driver-memory-cancelled]", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    let memoryReads = 0
    const transport = fakeTransport({
      memoryState: async () => {
        memoryReads += 1
        return {
          pendingSources: 0,
          activeJobs: [],
          jobs: memoryReads === 1
            ? []
            : [{ id: "job-cancelled", phase: "review", status: "cancelled", updatedAt: 1 }],
        }
      },
    })

    await executeDriver({
      progress,
      driverPackage: pkg,
      syncPoints: [{ id: "extraction", after: "say", wait: "memory_extraction_end" }],
      transport,
      now: time.now,
      sleep: time.sleep,
      memoryWait: { deadlineMs: 1_000, pollMs: 10, stableMs: 10 },
    })

    const check = progress.steps[0]?.checkpoints?.[0]
    expect(check?.status).toBe("satisfied")
    expect(check?.detail).toContain("job-cancelled")
    expect(check?.detail).toContain("cancelled")
  })

  it("记忆抽取水位一直不归零时检查点超时阻塞", async () => {
    const pkg = driverPackage([{ id: "say", kind: "message", text: "你好", at: AT_1 }])
    const progress = progressFor(pkg)
    const time = manualTime()
    const transport = fakeTransport({
      memoryState: async () => ({ pendingSources: 1, activeJobs: [], jobs: [] }),
    })

    await expect(executeDriver({
      progress,
      driverPackage: pkg,
      syncPoints: [{ id: "extraction", after: "say", wait: "memory_extraction_end" }],
      transport,
      now: time.now,
      sleep: time.sleep,
      memoryWait: { deadlineMs: 60, pollMs: 10, stableMs: 10 },
    })).rejects.toThrow(/等待自动记忆抽取结束超时/)

    expect(progress.status).toBe("blocked")
    expect(progress.blocked?.code).toBe("checkpoint.timeout")
    expect(progress.steps[0]?.checkpoints?.[0]?.status).toBe("timeout")
  })
})

describe("驱动结果与同条件对照", () => {
  it("只有驱动完成才是 completed，其余都显式 interrupted", () => {
    const progress = progressFor(driverPackage())
    expect(driverOutcome(progress)).toEqual({
      status: "interrupted",
      reason: "驱动未完成（status=pending）",
    })
    progress.status = "completed"
    expect(driverOutcome(progress)).toEqual({ status: "completed", reason: null })
    progress.status = "blocked"
    progress.blocked = { code: "x", message: "阻塞原因", at: AT_1 }
    expect(driverOutcome(progress)).toEqual({ status: "interrupted", reason: "阻塞原因" })
    progress.status = "running"
    progress.blocked = null
    progress.inFlight = { index: 0, stepId: "open", kind: "host", at: AT_1, startedAt: AT_1 }
    expect(driverOutcome(progress).reason).toContain("open")
  })

  it("对照条件优先取 attempt 实际覆盖的用例，实际模型只信封存顶层 models", () => {
    const conditions = conditionsFromRun({
      run: { scope: { caseIds: ["run-case"], suiteIds: ["suite-a"] } },
      manifest: {
        expectedTrials: [{ caseId: "b-case" }, { caseId: "a-case" }],
        models: { requested: "provider/model-a", actual: "provider/model-a-actual" },
        identity: {
          inputs: { specHash: HASH, contentHash: HASH_B, fixtureHash: HASH, driverHash: HASH_B, oracleHash: HASH },
          models: { requested: "provider/model-a" },
          host: { mode: "full-desktop", capabilities: ["session", "chat"] },
          platform: { os: "darwin", arch: "arm64" },
          runtime: { version: "22.22.3" },
          tools: { driverVersion: HASH_B, rubricVersion: "rubric@1", graderVersion: "grader@1", judgePromptVersion: "judge@1" },
          code: { commit: "abc1234", sourceHash: HASH },
        },
      },
    })
    expect(conditions.caseIds).toEqual(["a-case", "b-case"])
    expect(conditions.suiteIds).toEqual(["suite-a"])
    expect(conditions.requestedModel).toBe("provider/model-a")
    expect(conditions.actualModel).toBe("provider/model-a-actual")
    expect(conditions.hostCapabilities).toEqual(["chat", "session"])
    expect(conditions.platform).toBe("darwin/arm64")
    expect(conditions.judgePromptVersion).toBe("judge@1")

    const empty = conditionsFromRun({ run: {}, manifest: null })
    expect(empty.specHash).toBeNull()
    expect(empty.actualModel).toBeNull()
    expect(empty.caseIds).toEqual([])

    // 只有封存时写下的顶层 models 才算实际模型；identity 里的同名键不是证据。
    const unsealed = conditionsFromRun({
      run: { scope: { caseIds: [CASE_ID] } },
      manifest: { identity: { models: { requested: "provider/model-a", actual: "provider/echo" } } },
    })
    expect(unsealed.requestedModel).toBeNull()
    expect(unsealed.actualModel).toBeNull()
  })

  it("固定条件不一致或缺失即不可比；代码/Card/配置变化只记录 [chat-run-conditions]", () => {
    const base = {
      caseIds: [CASE_ID],
      suiteIds: ["suite"],
      specHash: HASH,
      contentHash: HASH,
      fixtureHash: HASH,
      driverHash: HASH,
      oracleHash: HASH,
      requestedModel: "provider/model",
      actualModel: "provider/model",
      hostMode: "full-desktop",
      hostCapabilities: ["chat"],
      platform: "darwin/arm64",
      runtime: "22.22.3",
      driverVersion: HASH,
      rubricVersion: "rubric@1",
      graderVersion: "grader@1",
      judgePromptVersion: "judge@1",
      commit: "abc1234",
      sourceHash: HASH_B,
      cardHash: HASH,
      configHash: HASH,
    }
    const same = compareRunConditions({
      candidate: { evaluationRunId: "candidate", conditions: { ...base, commit: "def5678", cardHash: HASH_B } },
      baseline: { evaluationRunId: "baseline", conditions: { ...base, commit: "abc1234" } },
    })
    expect(same.comparable).toBe(true)
    expect(same.issues).toEqual([])
    expect(same.targetChanges.map(change => change.field).sort()).toEqual(["cardHash", "commit"])

    const different = compareRunConditions({
      candidate: { evaluationRunId: "candidate", conditions: { ...base, actualModel: "provider/other" } },
      baseline: { evaluationRunId: "baseline", conditions: base },
    })
    expect(different.comparable).toBe(false)
    expect(different.issues).toContain("固定条件不一致：actualModel")

    const unknown = compareRunConditions({
      candidate: { evaluationRunId: "candidate", conditions: { ...base, runtime: null } },
      baseline: { evaluationRunId: "baseline", conditions: base },
    })
    expect(unknown.comparable).toBe(false)
    expect(unknown.unknown).toContain("runtime")
    expect(unknown.issues).toContain("缺少对照所需字段：runtime")
  })

  it("留出使用记录区分是否被运行组引用，包含在途与待审 [chat-run-holdout]", () => {
    const runs = [
      { evaluationRunId: "older", run: { scope: { caseIds: ["other"], holdout: false, purpose: "regression" } }, workflow: { phase: "completed" } },
      { evaluationRunId: "holdout-run", run: { createdAt: AT_1, scope: { caseIds: [CASE_ID], holdout: true, purpose: "holdout" } }, workflow: { phase: "running" } },
    ]
    expect(holdoutUsage({ runs, caseId: CASE_ID })).toMatchObject({
      used: true,
      uses: [{ evaluationRunId: "holdout-run", phase: "running", holdout: true, purpose: "holdout" }],
    })
    expect(holdoutUsage({ runs: runs.slice(0, 1), caseId: CASE_ID })).toEqual({
      caseId: CASE_ID,
      used: false,
      uses: [],
    })
  })

  it("工作流版本号是当前契约", () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBe(1)
    expect(AUTHORIZATION_SCHEMA_VERSION).toBe(1)
  })
})
