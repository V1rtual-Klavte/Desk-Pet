// W5 集成冒烟：fake Provider + 真实 loop / JSONL / trace 采集 / 封存 / 判分包冻结 / 同源报告。
//
// 本文件只验证评测编排，不证明对话质量：合成用例没有独立判分、没有人工审阅，
// 判分包保持 pending，报告必须显示「尚无判分」与「未抽查」。fixture 只参与绑定与
// 前置条件校验，不装载 direct-seed（W2 装载器不在本测试范围内）。
//
// 固定时钟只覆盖 Node 域（Date/时间戳）；Rust 调度、文件系统与操作系统时间不推进，
// 因此本测试不产生 clock.json，也不冒充跨天或调度类证据。
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { initChat, resetAgentRuntimeForTest, sendMessage } from "@/services/agent/runner"
import { flushConfig, getAllOverrides, setOverrides } from "@/services/config"
import { usageGrandTotal } from "@/services/debug"
import { initPaths } from "@/services/paths"
import { getActiveCard } from "@/services/personality/registry"
import {
  createNewSession,
  getActiveSessionId,
  getSessions,
  readVisibleSessionTranscript,
  resetPiSessionLayerForTest,
} from "@/services/session"
import { installSimClock, resetSimClockForTest, setSimClockBase } from "@/services/sim/clock"
import { createSimTraceRecorder } from "@/services/sim/trace-recorder"
import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import {
  buildDriverPackage,
  computeCaseBinding,
  datasetInputHash,
  hashCanonical,
  resolveCaseLabel,
  validateCaseAgainstFixture,
  validateCaseSpec,
  validateFixtureSpec,
} from "../../sim/desk-pet-chat/dataset.mjs"
import type { CaseEntry, Dataset } from "../../sim/desk-pet-chat/dataset.mjs"
import {
  CHAT_GRADER_VERSION,
  beginChatAttempt,
  copyArtifact,
  createChatRun,
  createDialogueWriter,
  extendChatAttemptSessions,
  sealChatAttempt,
  setChatRunPhase,
  verifySealedAttempt,
  writeArtifact,
  writeStateSnapshot,
} from "../../sim/desk-pet-chat/evidence.mjs"
import {
  JUDGE_RUBRIC_VERSION,
  checkDriverNoOracleLeak,
  loadJudgingContext,
  prepareJudgePacket,
  resolveProbeWindow,
  summarizeAttemptStatus,
} from "../../sim/desk-pet-chat/judging.mjs"
import { writeChatReport } from "../../sim/desk-pet-chat/report.mjs"
import {
  assertResumable,
  authorizeRequestedModels,
  createDriverProgress,
  driverOutcome,
  executeDriver,
  readDriverProgress,
  validateAuthorization,
  validateDriverPackage,
  validateSyncPoints,
} from "../../sim/desk-pet-chat/workflow.mjs"
// @ts-expect-error TS7016：脚本没有类型声明，测试只借用同一实现的源码身份算法。
import { computeSourceHash } from "../../../scripts/sim-eval-run.mjs"

const CASE_ID = "w5-loop-smoke"
const SUITE_ID = "w5-loop"
const TRIAL_ID = "trial-w5-1"
const FIXTURE_ID = "w5-loop-fixture"
const RUN_ID = "w5-loop-run"
const CLOCK_BASE = "2026-10-24T10:00:00.000+08:00"
const M1_TEXT = "今天下班路上看到一只橘猫蹲在店门口"
const M2_TEXT = "刚才说的那只橘猫，你还记得它在哪吗"
const REPLY_M1 = "橘猫这事儿挺可爱的，蹲在店门口大概是等投喂吧"
const REPLY_M2 = "记得，就在那家店门口，橘猫蹲着没挪窝"
const FAKE_MODEL = {
  id: "deskpet-fake",
  name: "Desk-Pet Fake",
  contextWindow: 131_072,
  maxTokens: 16_384,
}
const DRIVER_TEXTS = [M1_TEXT, M2_TEXT]

/** 采集进程在消息步骤后中断：抛错发生在 it 的范围之外，满足测试纪律 4。 */
function simulatedCrash(): never {
  throw new Error("W5 集成测试：模拟采集进程在消息步骤后中断")
}

/** 宿主步骤只实现本用例声明的 chat_new_session；其余方法必须显式失败而不是静默跳过。 */
function unsupportedHostStep(method: string): never {
  throw new Error(`W5 集成测试未实现宿主步骤：${method}`)
}

function snapshotSession(sessionId: string, messageCount: number) {
  const meta = getSessions().find(session => session.id === sessionId)
  if (!meta) throw new Error(`W5 集成测试找不到会话元数据：${sessionId}`)
  return {
    sessionId,
    createdAt: meta.createdAt,
    seqTip: null,
    messageCount,
    complete: true,
  }
}

let dataRoot = ""

beforeAll(async () => {
  mkdirSync(join(process.cwd(), "test/.tmp"), { recursive: true })
  dataRoot = mkdtempSync(join(process.cwd(), "test/.tmp/chat-eval-loop-"))
  setTestDataRoot(dataRoot)
  await initPaths()
  installSimClock({
    schemaVersion: 1,
    base: CLOCK_BASE,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    reason: "W5 L3 集成测试只固定 Node 域时间；Rust 调度与操作系统时间不推进",
  })
})

afterAll(() => {
  resetSimClockForTest()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

describe("聊天评测闭环（L3 合成用例）", () => {
  it("fake Provider 驱动真实 loop 完成中断续跑、跨会话采集、封存与同源报告 [w5-loop-smoke]", async () => {
    await initChat()
    const card = getActiveCard()
    const cardLabel = card?.name ?? card?.id ?? "default"

    // 判分包与报告要保持确定性：关掉 humanizer 与记忆抽取/召回，只留两次主回合请求。
    // quality 规则仍按 humanizer-six-dimensions 冻结，它评的是最终回复，不由开关决定。
    setOverrides({ "ai.humanizer.enabled": false, "ai.memory.enabled": false })
    await flushConfig()

    const caseSpec = validateCaseSpec({
      schemaVersion: 4,
      caseId: CASE_ID,
      revision: 1,
      familyId: "eval-loop",
      title: "跨会话承接冒烟",
      categories: ["chat", "session"],
      questionTypes: ["tone", "new-session", "boundary"],
      source: {
        kind: "ideal",
        ref: "test/integration/evaluation/聊天评测闭环.test.ts",
        excerpt: "合成用例只验证评测编排，不构成对话质量或 gold 证据",
      },
      precondition: {
        card: cardLabel,
        profile: "default",
        fixtureId: FIXTURE_ID,
        time: { mode: "fixed" },
        hostCapabilities: ["chat", "session"],
      },
      userRole: {
        knownFacts: ["用户下班路上看到一只橘猫蹲在店门口"],
        goal: "先聊猫，再换新会话确认对方记得地点",
        tone: "日常口语",
        allowedActions: ["chat", "chat_new_session"],
        mustNotReveal: ["探针细节", "评分标准"],
      },
      driver: [
        { id: "m1", kind: "message", text: M1_TEXT, at: "2026-10-24T10:05:00.000+08:00" },
        { id: "h1", kind: "host", method: "chat_new_session", at: "2026-10-24T10:10:00.000+08:00" },
        { id: "m2", kind: "message", text: M2_TEXT, at: "2026-10-24T10:15:00.000+08:00" },
      ],
      probes: [
        {
          id: "p-tone",
          after: "m1",
          window: "last-assistant",
          rubric: "humanizer.casual-tone",
          questionType: "tone",
          polarity: "required",
          critical: true,
          difficulty: 2,
          description: "第一轮回复自然口语",
          evidence: ["tone-reply"],
        },
        {
          id: "p-new-session",
          after: "m2",
          window: "last-assistant",
          rubric: "session.answer-in-new-session",
          questionType: "new-session",
          polarity: "required",
          critical: true,
          difficulty: 3,
          description: "回答发生在新建会话，且能承接来源会话的事实",
          expectation: { sourceStep: "m1" },
          evidence: ["new-session-reply"],
        },
        {
          id: "p-no-leak",
          after: "m2",
          window: "all-assistant",
          rubric: "reply.no-oracle-leak",
          questionType: "boundary",
          polarity: "forbidden",
          critical: false,
          difficulty: 1,
          description: "助手回复不泄露评测内部信息",
          evidence: ["transcript"],
        },
      ],
      checkpoints: [
        { id: "after-m1", after: "m1", wait: "assistant_message" },
        { id: "after-new", after: "h1", wait: "session_created" },
        { id: "after-m2", after: "m2", wait: "assistant_message" },
      ],
      oracle: { allowedAlternatives: [] },
      pathConstraints: {
        requiredOrder: ["m1", "h1", "m2"],
        forbiddenSideEffects: [],
        allowedToolSubstitutions: [],
      },
      evidence: [
        { id: "tone-reply", kind: "session_entry", source: "S0 的第一轮助手回复", description: "核对语气" },
        { id: "new-session-reply", kind: "session_entry", source: "S1 的第二轮助手回复", description: "核对跨会话承接" },
        { id: "transcript", kind: "artifact", source: "artifacts/transcript.txt", description: "两层会话可见正文" },
      ],
      quality: { rubric: "humanizer-six-dimensions", rubricVersion: 1 },
      governance: {
        purpose: "regression",
        unresolvedPoints: ["合成用例尚无独立判分，不能当作质量结论"],
        notes: ["W5 编排冒烟：真实 loop/JSONL 加 fake Provider"],
      },
    }, {
      categoryIds: ["chat", "session"],
      questionTypeIds: ["tone", "new-session", "boundary"],
    })

    const fixtureSpec = validateFixtureSpec({
      schemaVersion: 4,
      fixtureId: FIXTURE_ID,
      card: cardLabel,
      profile: "default",
      clock: CLOCK_BASE,
      loading: { mode: "direct-seed", note: "集成测试不装载 direct-seed；夹具只用于绑定与前置条件核对" },
      initialSession: {
        id: "w5-loop-fixture-session",
        title: "夹具会话（未装载）",
        messages: [
          {
            id: "fixture-m1",
            role: "user",
            content: "夹具初始消息：今天路过一家店（本轮不落盘）",
            at: "2026-10-24T09:55:00.000+08:00",
          },
        ],
      },
      initialMemory: [],
      allowedPreparation: ["seed_session"],
    }, { expectedFixtureId: FIXTURE_ID })
    validateCaseAgainstFixture(caseSpec, fixtureSpec)

    const categories = [
      { id: "chat", name: "聊天", goal: "闭环冒烟" },
      { id: "session", name: "会话", goal: "跨会话承接" },
    ]
    const questionTypeFamilies = [{ id: "eval-loop", name: "闭环", goal: "评测闭环冒烟" }]
    const questionTypes = [
      { id: "tone", family: "eval-loop", name: "语气", goal: "口语自然", capabilities: ["chat"] },
      { id: "new-session", family: "eval-loop", name: "新会话", goal: "跨会话承接", capabilities: ["session"] },
      { id: "boundary", family: "eval-loop", name: "边界", goal: "不泄露内部信息", capabilities: ["chat"] },
    ]
    const binding = computeCaseBinding(caseSpec, fixtureSpec)
    const entry: CaseEntry = {
      caseId: CASE_ID,
      suiteId: SUITE_ID,
      casePath: "(test)",
      fixturePath: "(test)",
      case: caseSpec,
      fixture: fixtureSpec,
      binding,
      approvals: [],
      label: resolveCaseLabel(binding, []),
    }
    const dataset: Dataset = {
      schemaVersion: 4,
      repoRoot: "(test)",
      root: "(test)",
      categoriesPath: null,
      categories,
      questionTypesPath: null,
      questionTypeFamilies,
      questionTypes,
      suites: [{
        schemaVersion: 4,
        suiteId: SUITE_ID,
        revision: 1,
        purpose: "regression",
        title: "闭环冒烟",
        caseIds: [CASE_ID],
        path: "(test)",
      }],
      cases: [entry],
      approvals: [],
      errors: [],
      warnings: [],
    }
    const datasetHash = datasetInputHash(dataset, entry)

    const provider = installFakeProvider([() => fakeText(REPLY_M1), () => fakeText(REPLY_M2)], FAKE_MODEL)
    const recorder = createSimTraceRecorder()
    let captureStarted = false
    let trialStarted = false
    let trialEnded = false
    let captureFinished = false

    try {
      const sourceHash = computeSourceHash()
      const sessionBefore = getActiveSessionId()
      expect(sessionBefore).not.toBe("")

      const createdAt = new Date().toISOString()
      const budget = { messages: 10, tokens: 1_000_000, minutes: 30, trials: 1, repairs: 0 }
      const { runDir } = createChatRun({
        reportsDir: join(dataRoot, "reports", "chat"),
        evaluationRunId: RUN_ID,
        createdAt,
        scope: { caseIds: [CASE_ID], purpose: "regression", models: [FAKE_MODEL.id], data: "isolated" },
        budget,
      })
      setChatRunPhase(runDir, { phase: "running", updatedAt: createdAt })

      // 集成测试的授权由测试自身签发，只覆盖隔离数据根与 fake 模型；它不能替代真实运行的用户授权。
      const authorization = validateAuthorization({
        schemaVersion: 1,
        approvedBy: "integration-test",
        approvedAt: createdAt,
        scope: { caseIds: [CASE_ID], purpose: "regression", models: [FAKE_MODEL.id], data: "isolated" },
        budget,
        holdout: false,
      }, { caseIds: [CASE_ID], purpose: "regression" })
      expect(authorizeRequestedModels(authorization, [FAKE_MODEL.id])).toBe(true)

      const driverPackage = buildDriverPackage(entry)
      validateDriverPackage(driverPackage)
      validateSyncPoints(caseSpec.checkpoints)
      const progress = createDriverProgress({
        driverPackage,
        driverHash: binding.driverHash,
        budget: authorization.budget,
        clockBase: CLOCK_BASE,
        startedAt: new Date().toISOString(),
      })

      const inputs = {
        datasetHash,
        fixtureHash: binding.fixtureHash,
        cardHash: card ? `sha256:${card.hash}` : hashCanonical({ card: null }),
        configHash: hashCanonical(getAllOverrides()),
      }
      const started = beginChatAttempt({
        runDir,
        identity: {
          code: {
            commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            sourceHash,
            dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
          },
          inputs,
          tools: {
            driverVersion: binding.driverHash,
            rubricVersion: JUDGE_RUBRIC_VERSION,
            graderVersion: CHAT_GRADER_VERSION,
          },
          host: { mode: "l3-fake-provider", capabilities: ["chat", "session"] },
          platform: { os: process.platform, arch: process.arch },
          runtime: { version: process.versions.node },
          models: { requested: FAKE_MODEL.id },
          budget: { ...authorization.budget },
        },
        expectedTrials: [{ caseId: CASE_ID, trialId: TRIAL_ID }],
        expectedSessions: [sessionBefore],
        createdAt: new Date().toISOString(),
      })
      const attemptDir = started.attemptDir
      const attemptId = started.attempt.attemptId

      const beforeTranscript = await readVisibleSessionTranscript(sessionBefore)
      expect(beforeTranscript.error).toBeUndefined()
      writeStateSnapshot({
        attemptDir,
        name: "before",
        value: {
          schemaVersion: 1,
          kind: "before",
          evaluationRunId: RUN_ID,
          attemptId,
          capturedAt: new Date().toISOString(),
          activeSessionId: sessionBefore,
          sessions: [snapshotSession(sessionBefore, beforeTranscript.messages.length)],
          excludedSessions: [],
          memory: { items: [], complete: true },
          complete: true,
          issues: [],
        },
      })
      writeArtifact({
        attemptDir,
        name: "authorization.json",
        bytes: `${JSON.stringify(authorization, null, 2)}\n`,
      })

      await recorder.startCapture({
        attemptDir,
        tracePath: join(attemptDir, "trace.jsonl"),
        expectedTrials: [{ caseId: CASE_ID, trialId: TRIAL_ID }],
      })
      captureStarted = true
      await recorder.beginTrial(CASE_ID, TRIAL_ID)
      trialStarted = true

      const transport = {
        clock: async (at: string, reason?: string) => setSimClockBase(at, reason),
        message: async (text: string) => {
          const result = await sendMessage(text)
          return {
            sessionId: getActiveSessionId(),
            outcome: result.outcome,
            reply: result.reply,
            toolCalls: result.toolCalls,
          }
        },
        sessions: async () => ({
          active: getActiveSessionId(),
          sessions: getSessions().map(meta => ({ id: meta.id, name: meta.name })),
        }),
        host: async (method: string) => {
          if (method === "chat_new_session") {
            const created = await createNewSession()
            return { method, result: { sessionId: created.id } }
          }
          return unsupportedHostStep(method)
        },
        context: async () => ({ context: { usageTotal: usageGrandTotal() } }),
        memoryState: async () => ({ pendingSources: 0, activeJobs: [] }),
      }

      // 第一次执行在 m1 之后中断：进度已落盘、副作用不重放，续跑只做 h1 与 m2。
      const crashProgressPath = join(dataRoot, "driver-progress-crash.json")
      const finalProgressPath = join(dataRoot, "driver-progress-final.json")
      let crashed = false
      let crashError: unknown
      try {
        await executeDriver({
          progress,
          driverPackage,
          syncPoints: caseSpec.checkpoints,
          transport,
          onProgress: async (draft) => {
            writeFileSync(crashProgressPath, `${JSON.stringify(draft, null, 2)}\n`)
            if (!crashed && draft.status === "running" && draft.inFlight === null && draft.index === 1) {
              crashed = true
              simulatedCrash()
            }
          },
        })
      } catch (error) {
        crashError = error
      }
      expect(crashError).toBeInstanceOf(Error)
      expect(crashed).toBe(true)

      const crashDraft = readDriverProgress(JSON.parse(readFileSync(crashProgressPath, "utf8")))
      expect(driverOutcome(crashDraft).status).toBe("interrupted")
      expect(assertResumable(crashDraft).resumable).toBe(true)
      expect(crashDraft.index).toBe(1)
      expect(crashDraft.usage.messages).toBe(1)
      expect(crashDraft.steps.map(step => step.id)).toEqual(["m1"])

      const resumed = readDriverProgress(JSON.parse(readFileSync(crashProgressPath, "utf8")))
      const summary = await executeDriver({
        progress: resumed,
        driverPackage,
        syncPoints: caseSpec.checkpoints,
        transport,
        onProgress: async (draft) => {
          writeFileSync(finalProgressPath, `${JSON.stringify(draft, null, 2)}\n`)
        },
      })
      expect(summary.status).toBe("completed")
      expect(summary.index).toBe(3)
      expect(summary.completed).toBe(3)
      expect(summary.usage.messages).toBe(2)

      expect(provider.payloads).toHaveLength(2)
      expect(lastRequestText(provider.payloads[0]!)).toContain(M1_TEXT)
      expect(lastRequestText(provider.payloads[1]!)).toContain(M2_TEXT)
      expect(lastRequestText(provider.payloads[1]!)).not.toContain(M1_TEXT)

      const sessionAfter = getActiveSessionId()
      expect(sessionAfter).not.toBe(sessionBefore)

      await new Promise(resolve => setTimeout(resolve, 25))
      await recorder.endTrial(CASE_ID, TRIAL_ID)
      trialEnded = true
      const capture = await recorder.finishCapture()
      captureFinished = true
      expect(capture.status).toBe("completed")
      expect(capture.complete).toBe(true)
      expect(capture.orphanCount).toBe(0)
      expect(capture.issues).toEqual([])
      recorder.stop()

      const providerEnds = recorder.recentEvents().filter(event => event.kind === "provider_request_end")
      expect(providerEnds.length).toBeGreaterThan(0)
      const lastEnd = providerEnds[providerEnds.length - 1]!
      const actualModel = String(lastEnd.payload.responseModel ?? lastEnd.payload.model ?? "")
      expect(actualModel).toBe(FAKE_MODEL.id)

      const visibleCounts = new Map<string, number>()
      const transcriptRows: Array<{
        role: "user" | "assistant"
        text: string
        sessionId: string
        entryId: string
        at: number
        origin: "driver" | "assistant" | "fixture"
      }> = []
      const transcriptChunks: string[] = []
      let driverCursor = 0
      for (const sessionId of [sessionBefore, sessionAfter]) {
        const transcript = await readVisibleSessionTranscript(sessionId)
        expect(transcript.error).toBeUndefined()
        visibleCounts.set(sessionId, transcript.messages.length)
        transcriptChunks.push(`# ${sessionId}`)
        transcriptChunks.push(...transcript.messages.map(message => `${message.role}: ${message.text}`))
        transcriptChunks.push("")
        for (const message of transcript.messages) {
          if (message.role !== "user" && message.role !== "assistant") continue
          if (!message.text.trim()) continue
          if (message.role === "assistant") {
            transcriptRows.push({
              role: "assistant",
              text: message.text,
              sessionId,
              entryId: message.eventId ?? message.id,
              at: message.timestamp,
              origin: "assistant",
            })
            continue
          }
          const expected = DRIVER_TEXTS[driverCursor]
          const isDriver = expected !== undefined && message.text === expected
          if (isDriver) driverCursor += 1
          transcriptRows.push({
            role: "user",
            text: message.text,
            sessionId,
            entryId: message.eventId ?? message.id,
            at: message.timestamp,
            origin: isDriver ? "driver" : "fixture",
          })
        }
      }
      expect(driverCursor).toBe(DRIVER_TEXTS.length)
      transcriptRows.sort((left, right) => left.at - right.at)
      const dialogue = createDialogueWriter(attemptDir)
      for (const row of transcriptRows) dialogue.append(row)
      dialogue.close()

      extendChatAttemptSessions({ attemptDir, sessionIds: [sessionAfter] })
      const stateBase = {
        schemaVersion: 1,
        evaluationRunId: RUN_ID,
        attemptId,
        capturedAt: new Date().toISOString(),
        activeSessionId: sessionAfter,
        sessions: [
          snapshotSession(sessionBefore, visibleCounts.get(sessionBefore) ?? 0),
          snapshotSession(sessionAfter, visibleCounts.get(sessionAfter) ?? 0),
        ],
        excludedSessions: [],
        memory: { items: [], complete: true },
        complete: true,
        issues: [],
      }
      writeStateSnapshot({ attemptDir, name: "after", value: { ...stateBase, kind: "after" } })
      writeStateSnapshot({ attemptDir, name: "capture", value: { ...stateBase, kind: "capture" } })
      writeArtifact({
        attemptDir,
        name: "transcript.txt",
        bytes: `${transcriptChunks.join("\n")}\n`,
      })
      writeArtifact({
        attemptDir,
        name: "driver-package.json",
        bytes: `${JSON.stringify(driverPackage, null, 2)}\n`,
      })
      copyArtifact({ attemptDir, name: "driver-progress-crash.json", sourcePath: crashProgressPath })
      copyArtifact({ attemptDir, name: "driver-progress-final.json", sourcePath: finalProgressPath })

      const sealed = await sealChatAttempt({
        attemptDir,
        sealedAt: new Date().toISOString(),
        models: { actual: actualModel },
        sourceHash,
        inputs,
        outcome: "completed",
      })
      expect(sealed.status).toBe("complete")
      expect(sealed.issues).toEqual([])
      const verification = verifySealedAttempt(attemptDir)
      expect(verification.status).toBe("complete")
      expect(verification.issues).toEqual([])

      // 采集后改标题属于数据集变更：旧证据不能再按当前 oracle 冻结判分包。
      let staleCode = ""
      try {
        prepareJudgePacket({
          runDir,
          attemptDir,
          dataset,
          caseEntry: { ...entry, case: { ...entry.case, title: "采集后被改过的标题" } },
          now: new Date().toISOString(),
        })
      } catch (error) {
        staleCode = error instanceof Error && "code" in error ? String(error.code) : `unexpected:${String(error)}`
      }
      expect(staleCode).toBe("dataset.stale")

      const leak = checkDriverNoOracleLeak({ dataset, caseEntry: entry })
      expect(leak.ok).toBe(true)
      expect(leak.violations).toEqual([])

      const prepared = prepareJudgePacket({
        runDir,
        attemptDir,
        dataset,
        caseEntry: entry,
        now: new Date().toISOString(),
      })
      expect(prepared.skippedRules).toEqual([])
      expect(prepared.packet.trialId).toBe(TRIAL_ID)
      expect(prepared.packet.underTest).toEqual({ requested: FAKE_MODEL.id, actual: FAKE_MODEL.id })
      expect(prepared.packet.rules.map(rule => rule.ruleId)).toEqual([
        "p-tone",
        "p-new-session",
        "p-no-leak",
        "quality:humanizer-six-dimensions",
      ])
      expect(prepared.packet.rules[0]?.window.mode).toBe("last-assistant")
      expect(prepared.packet.rules[1]?.window.mode).toBe("last-assistant")
      expect(prepared.packet.rules[2]?.window.mode).toBe("all-assistant")
      expect(prepared.packet.rules[0]?.window.messageSeqs).toHaveLength(1)
      expect(prepared.packet.rules[1]?.window.messageSeqs).toHaveLength(1)
      expect(prepared.packet.rules[2]?.window.messageSeqs?.length ?? 0).toBeGreaterThanOrEqual(2)

      const context = loadJudgingContext({ attemptDir, caseEntry: entry })
      expect(context.evidenceStatus).toBe("complete")
      expect(context.executionStatus).toBe("completed")
      expect(context.attributionValid).toBe(true)
      expect(context.newSessions).toEqual([sessionAfter])
      expect(context.stepsById.get("m1")?.sessionId).toBe(sessionBefore)
      expect(context.stepsById.get("h1")?.sessionId).toBe(sessionAfter)
      expect(context.stepsById.get("m2")?.sessionId).toBe(sessionAfter)

      const toneWindow = resolveProbeWindow({ context, probe: caseSpec.probes[0]! })
      expect(toneWindow.ok).toBe(true)
      expect(toneWindow.replies).toHaveLength(1)
      const newSessionWindow = resolveProbeWindow({ context, probe: caseSpec.probes[1]! })
      expect(newSessionWindow.ok).toBe(true)
      expect(newSessionWindow.replies).toHaveLength(1)
      expect(newSessionWindow.replies[0]?.sessionId).toBe(sessionAfter)

      // 没有判分记录时只能保持 inconclusive：不能用聚合结果冒充质量通过。
      const status = summarizeAttemptStatus({ caseEntry: entry, context })
      expect(status.overall.status).toBe("inconclusive")
      expect(status.judge).toBeNull()
      expect(status.gradeId).toBeNull()
      expect(status.spotCheck.status).toBe("not_checked")
      expect(status.gold).toBe(false)
      expect(status.label).toEqual({
        tier: "silver",
        status: "pending",
        approvalId: null,
        reviewedAt: null,
        mismatches: [],
      })
      expect(status.check.status).toBe("inconclusive")
      expect(status.check.counts.required.total).toBe(3)
      expect(status.check.counts.forbidden.total).toBe(1)
      expect(status.check.counts.critical.total).toBe(3)

      setChatRunPhase(runDir, { phase: "awaiting_judge", updatedAt: new Date().toISOString() })
      const report = writeChatReport({
        runDir,
        generatedAt: new Date().toISOString(),
        dataset,
      })
      expect(report.markdown).toContain("- 标签：silver / pending")
      expect(report.markdown).toContain("- 判分者：尚无判分")
      expect(report.markdown).toContain("- 抽查：未抽查（可选，不阻塞）")
      expect(report.markdown).toContain("- 聚合规则：judge-all-rules；gold=false")
      expect(report.markdown).toContain("- 规则：inconclusive（必需 0/3 通过，禁止项 0/1 通过，关键 0/3 通过）")
      expect(readdirSync(join(attemptDir, "grades"))).toEqual([])
    } finally {
      if (trialStarted && !trialEnded) {
        await recorder.endTrial(CASE_ID, TRIAL_ID, { status: "failed", error: "测试清理" })
        trialEnded = true
      }
      if (captureStarted && !captureFinished) {
        await recorder.finishCapture({ status: "interrupted", reason: "测试清理" })
        captureFinished = true
      }
      if (!captureStarted || captureFinished) recorder.stop()
      provider.restore()
      setOverrides({})
      await flushConfig()
      await resetAgentRuntimeForTest()
      await resetPiSessionLayerForTest()
    }
  }, 60_000)
})
