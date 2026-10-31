// ==========================================
// 聊天交付基础设施 — 交付声明、产物捕获、判分包内容与驱动确认
// ==========================================
//
// 交付类用例把「产物」纳入可判分证据：数据集声明产物路径，运行器把它封存进 attempt，
// 判分包携带受限内容。这里按层验证：声明与绑定（dataset）、捕获与封存（evidence）、
// 驱动占位符与确认记录（workflow）、判分包（judging）。
// 驱动包仍只含 userRole 与 driver，交付路径属于 oracle 侧，不能进入驱动。
import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CaseEntry, Dataset, DriverPackage } from "../../sim/desk-pet-chat/dataset.mjs"
import {
  HOST_CAPABILITY_VALUES,
  PROBE_EXPECTATION_KIND_VALUES,
  PROBE_WINDOW_VALUES,
  RUBRIC_SPECS,
  buildDriverPackage,
  computeCaseBinding,
  datasetInputHash,
  formatExpectation,
  loadDataset,
  resolveCaseLabel,
  validateCaseSpec,
} from "../../sim/desk-pet-chat/dataset.mjs"
import {
  beginChatAttempt,
  captureDeliverables,
  createDialogueWriter,
  createTraceWriter,
  ensureChatRun,
  sealChatAttempt,
  verifySealedAttempt,
} from "../../sim/desk-pet-chat/evidence.mjs"
import {
  DRIVER_DENIAL_LIMIT,
  DRIVER_PROGRESS_SCHEMA_VERSION,
  DRIVER_QUESTION_CANCEL_LIMIT,
  WorkflowError,
  createDriverProgress,
  executeDriver,
  readDriverProgress,
  readPendingQuestion,
  renderDriverText,
} from "../../sim/desk-pet-chat/workflow.mjs"
import {
  DELIVERABLE_CONTENT_MAX_BYTES,
  DELIVERABLE_CONTENT_TOTAL_MAX_BYTES,
  JUDGE_PROMPT_VERSION,
  VERDICTS_SCHEMA_VERSION,
  applyJudgeVerdicts,
  formatJudgePacket,
  prepareJudgePacket,
} from "../../sim/desk-pet-chat/judging.mjs"
import { renderChatReport } from "../../sim/desk-pet-chat/report.mjs"

const realDataset = loadDataset()
const categoryIds = realDataset.categories.map(category => category.id)
const questionTypeIds = realDataset.questionTypes.map(questionType => questionType.id)

function baseCase(): any {
  return structuredClone(realDataset.cases[0]!.case)
}

function baseFixture(): any {
  return structuredClone(realDataset.cases[0]!.fixture)
}

function artifactExistsProbe(overrides: Record<string, any> = {}) {
  return {
    id: "p-shopping-list-exists",
    after: "shopping-list",
    window: "artifact",
    rubric: "delivery.artifact-exists",
    questionType: "boundary",
    polarity: "required",
    critical: false,
    difficulty: 2,
    description: "购物清单写入声明路径且内容完整",
    expectation: { deliverableId: "shopping-list" },
    ...overrides,
  }
}

function deliverableCase(): any {
  const spec = baseCase()
  spec.precondition.hostCapabilities = [...spec.precondition.hostCapabilities, "tools"]
  spec.deliverables = [
    { id: "shopping-list", role: "购物清单", path: "deliverables/shopping-list.md", maxBytes: 4096 },
  ]
  spec.probes.push(artifactExistsProbe())
  return spec
}

function validate(spec: any) {
  return validateCaseSpec(spec, { categoryIds, questionTypeIds })
}

function caseEntry(spec: any, binding = computeCaseBinding(spec, baseFixture())): CaseEntry {
  return {
    caseId: spec.caseId,
    suiteId: "daily-companionship",
    casePath: "",
    fixturePath: "",
    case: spec,
    fixture: baseFixture(),
    binding,
    approvals: [],
    label: resolveCaseLabel(binding, []),
  }
}

function assertDatasetError(run: () => unknown, code: string) {
  let caught: any = null
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught, `期望 DatasetError ${code}`).toBeTruthy()
  expect(caught.code).toBe(code)
}

describe("聊天交付声明", () => {
  it("登记 tools 能力、artifact 窗口与交付 rubric [chat-deliverables-schema]", () => {
    expect(HOST_CAPABILITY_VALUES).toContain("tools")
    expect(PROBE_WINDOW_VALUES).toContain("artifact")
    expect(PROBE_EXPECTATION_KIND_VALUES).toContain("deliverable")
    const byId = new Map(RUBRIC_SPECS.map(rubric => [rubric.id, rubric]))
    expect(byId.get("delivery.artifact-exists")).toMatchObject({ kind: "delivery", expectation: "deliverable" })
    expect(byId.get("delivery.artifact-content")).toMatchObject({ kind: "delivery", expectation: "deliverable" })
    expect(byId.get("chat.delivery-acknowledged")).toMatchObject({ kind: "delivery", expectation: "none" })
    expect(byId.get("reply.no-oracle-leak")).toMatchObject({ kind: "delivery", expectation: "none" })

    const spec = deliverableCase()
    expect(validate(spec)).toBe(spec)
    expect(validate(baseCase())).toBeInstanceOf(Object)
  })

  it("交付产物进入 oracle 绑定，不进入驱动包 [chat-deliverables-binding]", () => {
    const left = deliverableCase()
    const right = deliverableCase()
    right.deliverables[0].maxBytes = 8192
    right.deliverables[0].path = "deliverables/plan.md"
    const fixture = baseFixture()
    const leftBinding = computeCaseBinding(left, fixture)
    const rightBinding = computeCaseBinding(right, fixture)
    expect(leftBinding.driverHash).toBe(rightBinding.driverHash)
    expect(leftBinding.oracleHash).not.toBe(rightBinding.oracleHash)
    expect(leftBinding.specHash).not.toBe(rightBinding.specHash)

    const entry = caseEntry(left, leftBinding)
    const driverPackage = buildDriverPackage(entry)
    expect(Object.keys(driverPackage).sort()).toEqual(
      ["caseId", "driver", "revision", "schemaVersion", "specHash", "userRole"],
    )
  })

  it("未声明产物、缺 tools 能力与非法交付路径都被拒绝 [chat-deliverables-validation]", () => {
    const unknown = deliverableCase()
    unknown.probes[unknown.probes.length - 1].expectation.deliverableId = "weekly-plan"
    assertDatasetError(() => validate(unknown), "case.deliverable-unknown")

    const noTools = deliverableCase()
    noTools.precondition.hostCapabilities = ["chat", "memory", "session"]
    assertDatasetError(() => validate(noTools), "case.deliverables-capability")

    for (const path of ["../outside.md", "/tmp/plan.md", "deliverables\\plan.md", "deliverables//plan.md", "deliverables/./plan.md", "deliverables/"]) {
      const spec = deliverableCase()
      spec.deliverables[0].path = path
      assertDatasetError(() => validate(spec), "case.deliverable-path")
    }

    const duplicate = deliverableCase()
    duplicate.deliverables.push({ id: "shopping-list", role: "重复", path: "deliverables/other.md" })
    assertDatasetError(() => validate(duplicate), "schema.invalid")

    const samePath = deliverableCase()
    samePath.deliverables.push({ id: "weekly-plan", role: "周计划", path: "deliverables/shopping-list.md" })
    assertDatasetError(() => validate(samePath), "case.deliverable-path")
  })

  it("交付窗口与期望形状按 rubric 约束 [chat-deliverables-window]", () => {
    const wrongWindow = deliverableCase()
    wrongWindow.probes[wrongWindow.probes.length - 1].window = "last-assistant"
    assertDatasetError(() => validate(wrongWindow), "case.rubric-window")

    const wrongRubric = deliverableCase()
    Object.assign(wrongRubric.probes[wrongRubric.probes.length - 1], {
      rubric: "chat.delivery-acknowledged",
      expectation: undefined,
    })
    assertDatasetError(() => validate(wrongRubric), "case.artifact-window")

    const undeclared = baseCase()
    undeclared.probes.push(artifactExistsProbe())
    assertDatasetError(() => validate(undeclared), "case.deliverable-undeclared")

    const existsWithContains = deliverableCase()
    existsWithContains.probes[existsWithContains.probes.length - 1].expectation.contains = ["鸡胸肉"]
    assertDatasetError(() => validate(existsWithContains), "schema.expectation-unexpected")

    const contentWithoutTerms = deliverableCase()
    contentWithoutTerms.probes.push(artifactExistsProbe({
      id: "p-shopping-list-content",
      rubric: "delivery.artifact-content",
    }))
    assertDatasetError(() => validate(contentWithoutTerms), "schema.expectation-missing")

    const contentWithTerms = deliverableCase()
    contentWithTerms.probes.push(artifactExistsProbe({
      id: "p-shopping-list-content",
      rubric: "delivery.artifact-content",
      expectation: { deliverableId: "shopping-list", contains: ["鸡胸肉", "酸奶"], notContains: ["鸡腿"] },
    }))
    expect(validate(contentWithTerms)).toBe(contentWithTerms)
  })

  it("工具确认声明只接受 allow-once 且需要 tools 能力 [chat-tool-approval]", () => {
    const withApproval = deliverableCase()
    withApproval.precondition.toolApproval = "allow-once"
    expect(validate(withApproval)).toBe(withApproval)

    const unknownValue = deliverableCase()
    unknownValue.precondition.toolApproval = "always"
    assertDatasetError(() => validate(unknownValue), "schema.invalid")

    const noTools = deliverableCase()
    noTools.precondition.hostCapabilities = ["chat", "memory", "session"]
    noTools.precondition.toolApproval = "allow-once"
    assertDatasetError(() => validate(noTools), "case.tool-approval")
  })

  it("消息步骤只接受 dataRoot 占位符，驱动包保留占位符原样 [chat-driver-placeholder]", () => {
    const spec = deliverableCase()
    const step = spec.driver.find((candidate: any) => candidate.id === "shopping-list")
    step.text = "把清单写到 {{dataRoot}}/deliverables/shopping-list.md，别太长"
    expect(validate(spec)).toBe(spec)

    const entry = caseEntry(spec)
    const driverPackage = buildDriverPackage(entry)
    const packaged = driverPackage.driver.find((candidate: any) => candidate.id === "shopping-list") as any
    expect(packaged.text).toContain("{{dataRoot}}")

    const unknown = deliverableCase()
    unknown.driver.find((candidate: any) => candidate.id === "shopping-list").text = "写到 {{home}}/plan.md"
    assertDatasetError(() => validate(unknown), "case.placeholder-unknown")
  })

  it("交付期望渲染为审阅可读文本 [chat-deliverables-format]", () => {
    expect(formatExpectation({ deliverableId: "shopping-list" })).toBe("产物：shopping-list")
    expect(formatExpectation({ deliverableId: "shopping-list", contains: ["鸡胸肉"], notContains: ["鸡腿"] }))
      .toBe("产物：shopping-list；包含：鸡胸肉；不包含：鸡腿")
  })
})

const HASH = `sha256:${"a".repeat(64)}`
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "desk-pet-deliverables-"))
  tempRoots.push(root)
  return root
}

function identity(datasetHash: string = HASH) {
  return {
    code: { commit: "abc123", sourceHash: HASH, dirty: false },
    inputs: { datasetHash, fixtureHash: HASH, cardHash: HASH, configHash: HASH },
    tools: { driverVersion: "driver@test", rubricVersion: "rubric@test", graderVersion: "grader@test" },
    host: { mode: "evaluation", capabilities: ["chat", "tools"] },
    platform: { os: "darwin", arch: "arm64" },
    runtime: { version: "v24.18.0" },
    models: { requested: "model-under-test" },
    budget: { messages: 10, tokens: 1000, minutes: 5, trials: 1, repairs: 0 },
  }
}

function makeAttempt(root: string, datasetHash: string = HASH) {
  const { runDir } = ensureChatRun({
    reportsDir: join(root, "reports"),
    evaluationRunId: "chat-deliverables",
    createdAt: "2026-10-27T10:00:00.000Z",
    scope: { caseIds: ["saturday-companionship"] },
    budget: { messages: 10 },
  })
  const { attemptDir } = beginChatAttempt({
    runDir,
    identity: identity(datasetHash),
    expectedTrials: [{ caseId: "saturday-companionship", trialId: "trial-1" }],
    expectedSessions: ["session-seed"],
    createdAt: "2026-10-27T10:00:01.000Z",
  })
  const dialogue = createDialogueWriter(attemptDir)
  dialogue.append({ role: "user", text: "帮我列个清单", sessionId: "session-seed", entryId: "entry-1", at: 1000, origin: "fixture" })
  dialogue.append({ role: "assistant", text: "写好了", sessionId: "session-seed", entryId: "entry-2", at: 1001, origin: "assistant" })
  dialogue.close()
  const trace = createTraceWriter(attemptDir)
  const sceneId = "saturday-companionship"
  const trialId = "trial-1"
  const boundaries = ["trial_start", "scene_start", "scene_end", "trial_end", "complete"]
  boundaries.forEach((kind, index) => {
    trace.appendChunk({
      chunkId: `chunk-${index + 1}`,
      chunkSeq: index + 1,
      events: [],
      eventCount: 0,
      droppedCount: 0,
      seqFrom: null,
      seqTo: null,
      boundary: kind === "complete" ? { kind } : { kind, sceneId, trialId },
    })
  })
  trace.close()
  const dataRoot = join(runDir, "data")
  mkdirSync(dataRoot, { recursive: true })
  return { runDir, attemptDir, dataRoot }
}

const shoppingList = { id: "shopping-list", role: "购物清单", path: "deliverables/shopping-list.md", maxBytes: 4096 }

function sealOptions(attempt: { attemptDir: string; dataRoot: string }, extra: Record<string, any> = {}) {
  return {
    attemptDir: attempt.attemptDir,
    sealedAt: "2026-10-27T10:05:00.000Z",
    models: { actual: "model-actual" },
    sourceHash: HASH,
    inputs: identity().inputs,
    outcome: "completed" as const,
    dataRoot: attempt.dataRoot,
    ...extra,
  }
}

describe("聊天交付证据捕获", () => {
  it("封存时把交付产物复制成只读证据并记录状态 [chat-deliverables-capture]", async () => {
    const attempt = makeAttempt(makeRoot())
    mkdirSync(join(attempt.dataRoot, "deliverables"), { recursive: true })
    writeFileSync(join(attempt.dataRoot, "deliverables/shopping-list.md"), "鸡胸肉、酸奶\n")

    const sealed = await sealChatAttempt(sealOptions(attempt, { deliverables: [shoppingList] }))

    expect(sealed.status).toBe("complete")
    expect(sealed.manifest.deliverables).toEqual([
      expect.objectContaining({
        id: "shopping-list",
        role: "购物清单",
        path: "deliverables/shopping-list.md",
        status: "delivered",
        bytes: Buffer.byteLength("鸡胸肉、酸奶\n"),
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        artifactPath: "artifacts/deliverable-shopping-list.md",
      }),
    ])
    expect(readFileSync(join(attempt.attemptDir, "artifacts/deliverable-shopping-list.md"), "utf8")).toBe("鸡胸肉、酸奶\n")
    expect(sealed.manifest.artifacts.map((artifact: any) => artifact.path))
      .toContain("artifacts/deliverable-shopping-list.md")
    expect(verifySealedAttempt(attempt.attemptDir).status).toBe("complete")
  })

  it("缺失与超限产物记录原因，但证据完整性仍按采集口径结论 [chat-deliverables-missing]", async () => {
    const missingAttempt = makeAttempt(makeRoot())
    const missing = await sealChatAttempt(sealOptions(missingAttempt, { deliverables: [shoppingList] }))
    expect(missing.status).toBe("complete")
    expect(missing.manifest.deliverables).toEqual([
      expect.objectContaining({ id: "shopping-list", status: "missing" }),
    ])
    expect(missing.manifest.deliverables[0].reason).toContain("不存在")

    const oversizedAttempt = makeAttempt(makeRoot())
    mkdirSync(join(oversizedAttempt.dataRoot, "deliverables"), { recursive: true })
    writeFileSync(join(oversizedAttempt.dataRoot, "deliverables/shopping-list.md"), "0123456789")
    const oversized = await sealChatAttempt(sealOptions(oversizedAttempt, {
      deliverables: [{ ...shoppingList, maxBytes: 4 }],
    }))
    expect(oversized.status).toBe("complete")
    expect(oversized.manifest.deliverables[0]).toMatchObject({ status: "oversized", bytes: 10 })
    expect(oversized.manifest.artifacts.map((artifact: any) => artifact.path))
      .not.toContain("artifacts/deliverable-shopping-list.md")
  })

  it("符号链接与越过数据根的产物被判为无效 [chat-deliverables-symlink]", () => {
    const root = makeRoot()
    const attempt = makeAttempt(root)
    const outside = join(root, "outside.md")
    writeFileSync(outside, "外部文件")
    mkdirSync(join(attempt.dataRoot, "deliverables"), { recursive: true })
    symlinkSync(outside, join(attempt.dataRoot, "deliverables/escape.md"))
    writeFileSync(join(attempt.dataRoot, "deliverables/real.md"), "正常内容")
    symlinkSync(
      join(attempt.dataRoot, "deliverables/real.md"),
      join(attempt.dataRoot, "deliverables/inside-link.md"),
    )

    const captured = captureDeliverables({
      attemptDir: attempt.attemptDir,
      dataRoot: attempt.dataRoot,
      deliverables: [
        { id: "escape", role: "越界", path: "deliverables/escape.md" },
        { id: "inside-link", role: "内部链接", path: "deliverables/inside-link.md" },
        { id: "traversal", role: "穿越", path: "../outside.md" },
        { id: "absolute", role: "绝对路径", path: outside },
      ],
    })

    expect(captured.deliverables.map((deliverable: any) => deliverable.status))
      .toEqual(["invalid", "invalid", "invalid", "invalid"])
    expect(captured.deliverables[0].reason).toContain("符号链接")
    expect(captured.deliverables[2].reason).toContain("数据根")
    expect(captured.deliverables[3].reason).toContain("数据根")
  })

  it("未声明产物的 attempt 仍按旧口径封存 [chat-deliverables-none]", async () => {
    const attempt = makeAttempt(makeRoot())
    const sealed = await sealChatAttempt(sealOptions(attempt))
    expect(sealed.status).toBe("complete")
    expect(sealed.manifest.deliverables).toEqual([])
    expect(verifySealedAttempt(attempt.attemptDir).status).toBe("complete")
  })
})

const AT = "2026-10-27T10:00:00.000+08:00"
const TRIAL_ID = "trial-1"

function expectWorkflowError(run: () => unknown, code: string) {
  let caught: any = null
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught, `期望 WorkflowError ${code}`).toBeInstanceOf(WorkflowError)
  expect(caught.code).toBe(code)
}

function workflowPackage(steps: any[]): DriverPackage {
  return {
    schemaVersion: 4,
    caseId: "saturday-companionship",
    revision: 1,
    specHash: HASH,
    userRole: {
      knownFacts: ["用户需要一份购物清单"],
      goal: "自然陪伴",
      tone: "口语",
      allowedActions: ["chat"],
      mustNotReveal: ["探针"],
    },
    driver: steps,
  }
}

function workflowProgress(steps: any[]) {
  return createDriverProgress({
    driverPackage: workflowPackage(steps),
    driverHash: HASH,
    budget: { messages: 5, tokens: 5000, minutes: 30, trials: 1, repairs: 0 },
    clockBase: AT,
    startedAt: "2026-10-27T09:59:00.000+08:00",
  })
}

function messageReply(operation: any) {
  return {
    sessionId: "session-seed",
    reply: "写好了",
    outcome: "succeeded",
    toolCalls: [],
    operation: {
      operationId: operation.operationId,
      caseId: operation.caseId,
      trialId: TRIAL_ID,
      sessionId: "session-seed",
      generation: "gen-1",
      stepId: operation.stepId,
    },
    requestId: operation.operationId,
    assistantEntryId: `assistant-${operation.operationId}`,
    replyBinding: "request-response",
  }
}

function baseTransport(overrides: Record<string, any> = {}): any {
  return {
    clock: async (at: string) => ({ base: at, now: at, timezone: "Etc/GMT-8" }),
    sessions: async () => ({ active: "session-seed", sessions: [{ id: "session-seed" }] }),
    host: async (method: string) => ({ method, result: {} }),
    context: async () => ({ context: { usageTotal: { calls: 0, reported: 0, total: 0 } } }),
    memoryState: async () => ({ pendingSources: 0, activeJobs: 0, jobs: [] }),
    ...overrides,
  }
}

describe("聊天驱动交付确认", () => {
  it("消息占位符发送前渲染为数据根，未知占位符被拒绝 [chat-driver-render]", () => {
    expect(renderDriverText("把清单写到 {{dataRoot}}/deliverables/shopping-list.md", { dataRoot: "/tmp/run/data" }))
      .toBe("把清单写到 /tmp/run/data/deliverables/shopping-list.md")
    expect(renderDriverText("普通消息", { dataRoot: "/tmp/run/data" })).toBe("普通消息")
    expectWorkflowError(() => renderDriverText("写到 {{dataRoot}}/x", {}), "driver.data-root")
    expectWorkflowError(() => renderDriverText("写到 {{home}}/x", { dataRoot: "/tmp" }), "driver.placeholder")
    expectWorkflowError(() => renderDriverText("写到 {{dataRoot}/x", { dataRoot: "/tmp" }), "driver.placeholder")
  })

  it("allow-once 在消息在飞期间确认一次并写入进度 [chat-driver-confirm]", async () => {
    const pkg = workflowPackage([{ id: "shopping-list", kind: "message", text: "写清单", at: AT }])
    const progress = workflowProgress([{ id: "shopping-list", kind: "message", text: "写清单", at: AT }])
    const events: string[] = []
    const confirmCalls: any[] = []
    let resolved = false
    let capturedOperation: any = null
    let releaseMessage: (value: any) => void = () => {}
    const messageGate = new Promise(resolve => { releaseMessage = resolve })
    const transport = baseTransport({
      message: async (text: string, operation: any) => {
        events.push("message:sent")
        capturedOperation = operation
        const response = await messageGate
        events.push("message:returned")
        return response
      },
      confirm: async (action: any) => {
        confirmCalls.push(structuredClone(action))
        if (action.action === "query") return resolved
          ? { pending: null }
          : { pending: { requestId: "req-1", toolName: "file_write", effectClass: "write" } }
        resolved = true
        events.push(`confirm:${action.decision}`)
        releaseMessage(messageReply(capturedOperation))
        return { resolved: true }
      },
    })
    const snapshots: any[] = []
    const summary = await executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      toolApproval: "allow-once",
      now: () => Date.parse(AT),
      sleep: async () => {},
      onProgress: (draft: any) => { snapshots.push(structuredClone(draft)) },
    })

    expect(summary.status).toBe("completed")
    expect(events.indexOf("confirm:allow_once")).toBeLessThan(events.indexOf("message:returned"))
    expect(progress.confirmations).toEqual([
      {
        stepId: "shopping-list",
        requestId: "req-1",
        toolName: "file_write",
        effectClass: "write",
        decision: "allow_once",
        at: expect.stringMatching(/^2026-10-27T\d{2}:00:00\.000Z$/),
      },
    ])
    expect(confirmCalls.filter(call => call.action === "resolve")).toHaveLength(1)
    // 确认记录必须在 inFlight 阶段就持久化，崩溃后能看到当时发生过确认。
    expect(snapshots.some(snapshot => snapshot.inFlight?.stepId === "shopping-list"
      && snapshot.confirmations?.length === 1)).toBe(true)
  })

  it("未声明工具确认时驱动拒绝确认并写入进度 [chat-driver-confirm-deny]", async () => {
    const pkg = workflowPackage([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const progress = workflowProgress([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const events: string[] = []
    const confirmCalls: any[] = []
    let resolved = false
    let capturedOperation: any = null
    let releaseMessage: (value: any) => void = () => {}
    const messageGate = new Promise(resolve => { releaseMessage = resolve })
    const transport = baseTransport({
      message: async (_text: string, operation: any) => {
        capturedOperation = operation
        const response = await messageGate
        events.push("message:returned")
        return response
      },
      confirm: async (action: any) => {
        confirmCalls.push(structuredClone(action))
        if (action.action === "query") return resolved
          ? { pending: null }
          : { pending: { requestId: "req-9", toolName: "bash", effectClass: "exclusive_effect" } }
        resolved = true
        events.push(`confirm:${action.decision}`)
        releaseMessage(messageReply(capturedOperation))
        return { resolved: true }
      },
    })
    const summary = await executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: () => Date.parse(AT),
      sleep: async () => {},
    })
    expect(summary.status).toBe("completed")
    expect(events.indexOf("confirm:deny")).toBeLessThan(events.indexOf("message:returned"))
    expect(progress.confirmations).toEqual([
      {
        stepId: "hello",
        requestId: "req-9",
        toolName: "bash",
        effectClass: "exclusive_effect",
        decision: "deny",
        at: expect.stringMatching(/^2026-10-27T\d{2}:00:00\.000Z$/),
      },
    ])
    expect(confirmCalls.filter(call => call.action === "resolve")).toHaveLength(1)
  })

  it("同一回合被拒超过上限时中止驱动，不硬等消息超时 [chat-driver-confirm-loop]", async () => {
    const pkg = workflowPackage([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const progress = workflowProgress([{ id: "hello", kind: "message", text: "你好", at: AT }])
    let round = 0
    const transport = baseTransport({
      // 消息永不结算：每次查询都抛出一个新的确认请求，模拟被拒后反复重试同一工具。
      message: () => new Promise(() => {}),
      confirm: async (action: any) => (action.action === "query"
        ? { pending: { requestId: `req-${round += 1}`, toolName: "bash", effectClass: "exclusive_effect" } }
        : { resolved: true }),
    })
    let caught: any = null
    try {
      await executeDriver({
        progress,
        driverPackage: pkg,
        transport,
        now: () => Date.parse(AT),
        sleep: async () => {},
      })
    } catch (error) {
      caught = error
    }
    expect(caught, "期望 WorkflowError driver.confirm-loop").toBeInstanceOf(WorkflowError)
    expect(caught.code).toBe("driver.confirm-loop")
    expect(progress.confirmations).toHaveLength(DRIVER_DENIAL_LIMIT)
    expect(progress.status).toBe("blocked")
  })

  it("被测模型反问时驱动取消提问并在消息结算前写入进度 [chat-driver-question-cancel]", async () => {
    const pkg = workflowPackage([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const progress = workflowProgress([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const events: string[] = []
    const choiceCalls: any[] = []
    let asked = false
    let capturedOperation: any = null
    let releaseMessage: (value: any) => void = () => {}
    const messageGate = new Promise(resolve => { releaseMessage = resolve })
    const transport = baseTransport({
      confirm: async () => ({ pending: null }),
      message: async (_text: string, operation: any) => {
        capturedOperation = operation
        const response = await messageGate
        events.push("message:returned")
        return response
      },
      choice: async (action: any) => {
        choiceCalls.push(structuredClone(action))
        if (action.action === "query") return asked ? { pending: [] } : { pending: [{ requestId: "q-1", options: ["a", "b"] }] }
        asked = true
        events.push("choice:cancel")
        releaseMessage(messageReply(capturedOperation))
        return { requestId: action.requestId, action: "cancel" }
      },
    })
    const snapshots: any[] = []
    const summary = await executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: () => Date.parse(AT),
      sleep: async () => {},
      onProgress: (draft: any) => { snapshots.push(structuredClone(draft)) },
    })

    expect(summary.status).toBe("completed")
    expect(events.indexOf("choice:cancel")).toBeLessThan(events.indexOf("message:returned"))
    expect(progress.questions).toEqual([
      {
        stepId: "hello",
        requestId: "q-1",
        optionCount: 2,
        action: "cancel",
        at: expect.stringMatching(/^2026-10-27T\d{2}:00:00\.000Z$/),
      },
    ])
    expect(choiceCalls.filter(call => call.action === "cancel")).toHaveLength(1)
    // 取消记录同样要在 inFlight 阶段落盘，崩溃后能看出回合是被反问卡住的。
    expect(snapshots.some(snapshot => snapshot.inFlight?.stepId === "hello"
      && snapshot.questions?.length === 1)).toBe(true)
  })

  it("提问在查询与取消之间被收回时下一次重试成功 [chat-driver-question-race]", async () => {
    const pkg = workflowPackage([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const progress = workflowProgress([{ id: "hello", kind: "message", text: "你好", at: AT }])
    let capturedOperation: any = null
    let releaseMessage: (value: any) => void = () => {}
    const messageGate = new Promise(resolve => { releaseMessage = resolve })
    let cancelAttempts = 0
    let queries = 0
    const transport = baseTransport({
      confirm: async () => ({ pending: null }),
      message: async (_text: string, operation: any) => {
        capturedOperation = operation
        return messageGate
      },
      choice: async (action: any) => {
        if (action.action === "query") {
          queries += 1
          return queries <= 2 ? { pending: [{ requestId: "q-2", options: [] }] } : { pending: [] }
        }
        cancelAttempts += 1
        if (cancelAttempts === 1) return Promise.reject(new Error("当前没有待答提问"))
        releaseMessage(messageReply(capturedOperation))
        return { requestId: action.requestId, action: "cancel" }
      },
    })
    const summary = await executeDriver({
      progress,
      driverPackage: pkg,
      transport,
      now: () => Date.parse(AT),
      sleep: async () => {},
    })
    expect(summary.status).toBe("completed")
    expect(progress.questions).toHaveLength(1)
    expect(progress.questions[0]?.requestId).toBe("q-2")
  })

  it("同一回合反问取消超过上限时中止驱动 [chat-driver-question-loop]", async () => {
    const pkg = workflowPackage([{ id: "hello", kind: "message", text: "你好", at: AT }])
    const progress = workflowProgress([{ id: "hello", kind: "message", text: "你好", at: AT }])
    let round = 0
    const transport = baseTransport({
      confirm: async () => ({ pending: null }),
      // 消息永不结算：模型被取消后继续反问，每次都抛出新的提问请求。
      message: () => new Promise(() => {}),
      choice: async (action: any) => (action.action === "query"
        ? { pending: [{ requestId: `q-${round += 1}`, options: ["a"] }] }
        : { requestId: action.requestId, action: "cancel" }),
    })
    let caught: any = null
    try {
      await executeDriver({
        progress,
        driverPackage: pkg,
        transport,
        now: () => Date.parse(AT),
        sleep: async () => {},
      })
    } catch (error) {
      caught = error
    }
    expect(caught, "期望 WorkflowError driver.question-loop").toBeInstanceOf(WorkflowError)
    expect(caught.code).toBe("driver.question-loop")
    expect(progress.questions).toHaveLength(DRIVER_QUESTION_CANCEL_LIMIT)
    expect(progress.status).toBe("blocked")
  })

  it("提问查询回执只取队首，空队列读成无提问 [chat-question-readback]", () => {
    expect(readPendingQuestion({ pending: [{ requestId: "q-1", options: ["a", "b", "c"] }] }))
      .toEqual({ requestId: "q-1", optionCount: 3 })
    expect(readPendingQuestion({ pending: [{ requestId: "q-2" }] })).toEqual({ requestId: "q-2", optionCount: 0 })
    expect(readPendingQuestion({ pending: [] })).toBeNull()
    expect(readPendingQuestion({ pending: null })).toBeNull()
    expect(readPendingQuestion({})).toBeNull()
    expectWorkflowError(() => readPendingQuestion(null), "schema.invalid")
    expectWorkflowError(() => readPendingQuestion({ pending: [{ options: [] }] }), "schema.invalid")
  })

  it("进度按新 schema 往返读取确认记录并校验字段 [chat-confirm-progress]", () => {
    const steps = [{ id: "hello", kind: "message", text: "你好", at: AT }]
    const progress = workflowProgress(steps)
    expect(DRIVER_PROGRESS_SCHEMA_VERSION).toBe(3)
    expect(progress.confirmations).toEqual([])
    expect(progress.questions).toEqual([])
    progress.confirmations.push({
      stepId: "hello",
      requestId: "req-1",
      toolName: "file_write",
      effectClass: "write",
      decision: "allow_once",
      at: AT,
    })
    progress.questions.push({ stepId: "hello", requestId: "q-1", optionCount: 2, action: "cancel", at: AT })
    const restored = readDriverProgress(JSON.parse(JSON.stringify(progress)))
    expect(restored.confirmations).toEqual(progress.confirmations)
    expect(restored.questions).toEqual(progress.questions)

    const broken = JSON.parse(JSON.stringify(progress))
    broken.confirmations[0].decision = "allow_always"
    expectWorkflowError(() => readDriverProgress(broken), "driver.confirm-record")

    const picked = JSON.parse(JSON.stringify(progress))
    picked.questions[0].action = "answer"
    expectWorkflowError(() => readDriverProgress(picked), "driver.question-record")
    const repeated = JSON.parse(JSON.stringify(progress))
    repeated.questions.push({ ...repeated.questions[0] })
    expectWorkflowError(() => readDriverProgress(repeated), "driver.question-record")
    delete repeated.questions
    expectWorkflowError(() => readDriverProgress(repeated), "driver.question-record")
  })
})

const JUDGE_AT = "2026-10-27T10:06:00.000Z"

function judgingCase(extraDeliverables: any[] = []) {
  const spec = deliverableCase()
  spec.deliverables = [{ ...shoppingList, maxBytes: 8192 }, ...extraDeliverables]
  spec.probes.push(artifactExistsProbe({
    id: "p-shopping-list-content",
    rubric: "delivery.artifact-content",
    expectation: { deliverableId: "shopping-list", contains: ["鸡胸肉"], notContains: ["鸡腿"] },
  }))
  const entry = caseEntry(spec)
  const dataset: Dataset = {
    schemaVersion: realDataset.schemaVersion,
    repoRoot: realDataset.repoRoot,
    root: realDataset.root,
    categoriesPath: null,
    categories: realDataset.categories,
    questionTypesPath: null,
    questionTypeFamilies: realDataset.questionTypeFamilies,
    questionTypes: realDataset.questionTypes,
    suites: [{
      schemaVersion: realDataset.schemaVersion,
      suiteId: "daily-companionship",
      revision: 1,
      purpose: "regression",
      title: "交付基础设施",
      caseIds: [entry.caseId],
      path: "",
    }],
    cases: [entry],
    approvals: [],
    errors: [],
    warnings: [],
  }
  return { spec, entry, dataset, datasetHash: datasetInputHash(dataset, entry) }
}

async function sealedForJudging(files: Record<string, string | Buffer>, extraDeliverables: any[] = []) {
  const { entry, dataset, datasetHash } = judgingCase(extraDeliverables)
  const attempt = makeAttempt(makeRoot(), datasetHash)
  mkdirSync(join(attempt.dataRoot, "deliverables"), { recursive: true })
  for (const [path, content] of Object.entries(files)) writeFileSync(join(attempt.dataRoot, path), content)
  const sealed = await sealChatAttempt(sealOptions(attempt, {
    deliverables: [{ ...shoppingList, maxBytes: 8192 }, ...extraDeliverables],
    inputs: identity(datasetHash).inputs,
  }))
  expect(sealed.status).toBe("complete")
  return { attempt, entry, dataset }
}

function preparedPacket(world: { attempt: any; entry: any; dataset: any }) {
  return prepareJudgePacket({
    runDir: world.attempt.runDir,
    attemptDir: world.attempt.attemptDir,
    dataset: world.dataset,
    caseEntry: world.entry,
    now: JUDGE_AT,
  }).packet
}

function verdictsFor(packet: any, overrides: Record<string, any> = {}) {
  const ref = packet.allowedEvidenceRefs.find((item: string) => item.startsWith("dialogue:")) ?? "trace:trace.jsonl"
  return {
    schemaVersion: VERDICTS_SCHEMA_VERSION,
    packetId: packet.packetId,
    packetSha256: packet.packetSha256,
    caseId: packet.caseId,
    judgedAt: JUDGE_AT,
    judge: { platform: "qoder", model: "judge-model-test", promptVersion: JUDGE_PROMPT_VERSION },
    verdicts: packet.rules.map((rule: any) => ({
      ruleId: rule.ruleId,
      verdict: "pass",
      reason: "依据包内证据判定",
      evidenceRefs: [ref],
      ...(overrides[rule.ruleId] ?? {}),
    })),
  }
}

describe("聊天判分包交付产物", () => {
  it("判分包携带封存产物内容与可引用标识 [chat-judge-deliverable-content]", async () => {
    const content = "鸡胸肉、酸奶、苹果\n"
    const world = await sealedForJudging({ "deliverables/shopping-list.md": content })
    const packet = preparedPacket(world)

    expect(JUDGE_PROMPT_VERSION).toBe("chat-judge@6")
    expect(packet.deliverables).toEqual([
      expect.objectContaining({
        id: "shopping-list",
        role: "购物清单",
        path: "deliverables/shopping-list.md",
        status: "delivered",
        content,
        truncated: false,
      }),
    ])
    expect(packet.allowedEvidenceRefs).toContain("deliverable:shopping-list")
    const rule = packet.rules.find((candidate: any) => candidate.ruleId === "p-shopping-list-exists")!
    expect(rule).toMatchObject({ kind: "delivery", deliverableId: "shopping-list", window: { mode: "artifact" } })
    expect(rule.expectation).toContain("产物：shopping-list")
    expect(rule.instruction).toContain("shopping-list")

    const text = formatJudgePacket({ packet })
    expect(text).toContain("交付产物")
    expect(text).toContain("鸡胸肉、酸奶、苹果")
  })

  it("内容按单文件与总预算截断，二进制产物不进入判分包 [chat-judge-deliverable-bounds]", async () => {
    const extras = Array.from({ length: 4 }, (_, index) => ({
      id: `extra-${index + 1}`,
      role: `附加产物 ${index + 1}`,
      path: `deliverables/extra-${index + 1}.md`,
    }))
    const files: Record<string, string | Buffer> = {
      "deliverables/shopping-list.md": "a".repeat(DELIVERABLE_CONTENT_MAX_BYTES + 100),
    }
    for (const extra of extras) files[extra.path] = "b".repeat(5000)
    const packet = preparedPacket(await sealedForJudging(files, extras))

    const first = packet.deliverables[0]
    expect(Buffer.byteLength(first.content ?? "")).toBe(DELIVERABLE_CONTENT_MAX_BYTES)
    expect(first.truncated).toBe(true)
    const total = packet.deliverables.reduce(
      (bytes: number, item: any) => bytes + Buffer.byteLength(item.content ?? ""), 0,
    )
    expect(total).toBeLessThanOrEqual(DELIVERABLE_CONTENT_TOTAL_MAX_BYTES)
    const exhausted = packet.deliverables[packet.deliverables.length - 1]
    expect(exhausted.content).toBeNull()
    expect(exhausted.contentIssue).toContain("预算")

    const binary = preparedPacket(await sealedForJudging({
      "deliverables/shopping-list.md": Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47]),
    }))
    expect(binary.deliverables[0]).toMatchObject({ status: "delivered", content: null })
    expect(binary.deliverables[0].contentIssue).toContain("二进制")
  })

  it("缺失产物仍可冻结判分包，并用产物引用判定失败 [chat-judge-deliverable-missing]", async () => {
    const world = await sealedForJudging({})
    const packet = preparedPacket(world)
    expect(packet.deliverables).toEqual([
      expect.objectContaining({ id: "shopping-list", status: "missing", content: null }),
    ])
    expect(packet.allowedEvidenceRefs).toContain("deliverable:shopping-list")
    expect(formatJudgePacket({ packet })).toContain("missing")

    const applied = applyJudgeVerdicts({
      runDir: world.attempt.runDir,
      attemptDir: world.attempt.attemptDir,
      dataset: world.dataset,
      caseEntry: world.entry,
      packetId: packet.packetId,
      verdicts: verdictsFor(packet, {
        "p-shopping-list-exists": {
          verdict: "fail",
          reason: "声明的产物没有落盘",
          evidenceRefs: ["deliverable:shopping-list"],
        },
      }),
      now: JUDGE_AT,
    })
    const check = applied.checks.find((candidate: any) => candidate.ruleId === "p-shopping-list-exists")
    expect(check?.status).toBe("fail")
    expect(check?.evidence[0].ref).toBe("deliverable:shopping-list")
    expect(check?.evidence[0].excerpt).toContain("missing")
  })
})

describe("聊天交付报告", () => {
  it("产物窗口按封存产物取证，原始证据列出交付状态 [chat-report-deliverables]", async () => {
    const worlds = [
      await sealedForJudging({ "deliverables/shopping-list.md": "鸡胸肉、酸奶\n" }),
      await sealedForJudging({}),
    ]

    const deliveredReport = renderChatReport({
      runDir: worlds[0].attempt.runDir,
      generatedAt: JUDGE_AT,
      dataset: worlds[0].dataset,
    })
    expect(deliveredReport).toContain("交付产物：shopping-list=delivered")
    const artifactBlock = deliveredReport.split("- **p-shopping-list-exists**")[1] ?? ""
    expect(artifactBlock.split("\n").slice(0, 5).some(line => line.includes("该规则使用封存产物证据，见原始证据")))
      .toBe(true)

    const missingReport = renderChatReport({
      runDir: worlds[1].attempt.runDir,
      generatedAt: JUDGE_AT,
      dataset: worlds[1].dataset,
    })
    expect(missingReport).toContain("交付产物：shopping-list=missing")
  })
})
