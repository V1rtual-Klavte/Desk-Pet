// ==========================================
// 评测运行器 — 纯校验与磁盘形状单元测试
// ==========================================
//
// runner.js 是开发脚本（scripts/），导出纯函数供这里钉住：Card 文件名/解析与产品
// loader 不漂移、CONFIG 覆盖落在正确层级、ready/控制通道/seed-report 的所有权校验
// 会拒绝错配。真正拉起宿主的 start/stop 由隔离根验收覆盖，不在 L2 里跑。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { load as parseYaml } from "js-yaml"
import { describe, expect, it } from "vitest"
import { datasetInputHash, loadDataset } from "../../sim/desk-pet-chat/dataset.mjs"
import { beginChatAttempt, createChatRun, readChatWorkflow, setChatRunPhase } from "../../sim/desk-pet-chat/evidence.mjs"
// @ts-expect-error TS7016 —— Node 侧 ESM 工具没有声明文件，运行期形状由断言钉住。
import { buildSyntheticConfig } from "../../host/native/synthetic-config.mjs"
import { importUserCard, safeCardFileName as productSafeCardFileName } from "@/services/personality/loader"
// @ts-expect-error TS7016 —— 开发脚本没有声明文件，运行期形状由本文件的断言钉住。
import * as runner from "../../../scripts/sim-eval-run.mjs"

const dataset = loadDataset()
const entry = dataset.cases.find(candidate => candidate.caseId === "saturday-companionship")
if (!entry) throw new Error("缺少 anchor 用例 saturday-companionship")
const fixture = entry.fixture
const fixtureId = fixture.fixtureId
const fixtureHash = entry.binding.fixtureHash
const sessionId = fixture.initialSession.id
const messageCount = fixture.initialSession.messages.length
const userMessageCount = fixture.initialSession.messages.filter(message => message.role === "user").length
const memoryItemCount = fixture.initialMemory.length
const cardId = "xiaoxue"
const cardName = fixture.card

const expectedSeedFixture = {
  sessionId,
  messageCount,
  userMessageCount,
  memoryItemCount,
}

describe("Card 文件名与解析与产品 loader 保持一致", () => {
  const cardSamples = [
    `---\nid: 本体卡-小雪\nname: 本体卡-小雪\ndescription: 桌宠本体卡\nversion: 3\n---\n\n正文`,
    `---\nid: xue/xue\nname: "小雪 2"\nversion: not-a-number\n---\nbody`,
    `---\nid: no-name\ndescription: 没有 name 时回落到 id\n---\nbody`,
    `not a card`,
  ]

  it("safeCardFileName 对同一 id 得到同一文件名", () => {
    for (const id of ["本体卡-小雪", "a b/c:d*e", "abc_123-中文", ""]) {
      expect(runner.safeCardFileName(id)).toBe(productSafeCardFileName(id))
    }
  })

  it("parseCardMeta 与 importUserCard 得到同一 id/name/description/version", async () => {
    for (const raw of cardSamples) {
      const product = await importUserCard(raw)
      const meta = runner.parseCardMeta(raw)
      expect(meta).toMatchObject({
        id: product.id,
        name: product.name,
        description: product.description,
        version: product.version,
      })
      expect(meta.nameVar).toBe(product.nameVar)
    }
  })
})

describe("run-id 与运行根", () => {
  it("只接受小写字母/数字/短横线，最长 48 且不以短横线开头", () => {
    expect(runner.validateRunId("20261025-deadbeef")).toBe("20261025-deadbeef")
    expect(runner.validateRunId("a")).toBe("a")
    for (const invalid of ["", "A", "-a", "a b", "a/b", "a".repeat(49), undefined, 3]) {
      expect(() => runner.validateRunId(invalid)).toThrow(/run-id 不合法/)
    }
  })

  it("makeRunId 使用本地日期 + 随机后缀，运行根固定在 test/.tmp/sim-eval-<id>", () => {
    expect(runner.makeRunId(new Date(2026, 9, 25, 12), "deadbeef")).toBe("20261025-deadbeef")
    const repoRoot = join(tmpdir(), "desk-pet-repo")
    expect(runner.runDirFor("r1", repoRoot)).toBe(join(repoRoot, "test", ".tmp", "sim-eval-r1"))
    expect(() => runner.runDirFor("Bad Id", repoRoot)).toThrow(/run-id 不合法/)
  })
})

describe("运行期 CONFIG 覆盖", () => {
  it("Card/主动/静默了解/拟人化落在 ai 下，Profile 落在顶层 appearance [chat-run-humanizer-default]", () => {
    const overrides = runner.buildRunOverrides({ cardId: cardId, profileId: null })
    expect(overrides).toEqual({
      ai: {
        personality: { active: cardId },
        proactive: { frequency: "off" },
        silentAccess: { frequency: "off" },
        humanizer: { enabled: false },
      },
    })
    expect(overrides).not.toHaveProperty("appearance")
    expect(overrides.ai).not.toHaveProperty("appearance")

    // 用户显式要求测拟人化时才打开（2026-10-28 口径：测试默认关闭，分泡不干扰句数/长度观察）。
    expect(runner.buildRunOverrides({ cardId: cardId, profileId: null, humanizerEnabled: true }).ai)
      .toHaveProperty("humanizer", { enabled: true })

    const withProfile = runner.buildRunOverrides({ cardId: cardId, profileId: "profile2" })
    expect(withProfile.appearance).toEqual({ activeProfile: "profile2" })
  })

  it("缺少 Card id 直接失败", () => {
    expect(() => runner.buildRunOverrides({ cardId: "", profileId: null })).toThrow(/Card id/)
    expect(() => runner.buildRunOverrides({ cardId: "  ", profileId: null })).toThrow(/Card id/)
  })

  it("合并进合成 CONFIG 后层级正确，其余字段继承模板", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const text = buildSyntheticConfig({
      repoRoot,
      overrides: runner.buildRunOverrides({ cardId: cardId, profileId: "profile2" }),
    })
    const config = parseYaml(text) as any
    expect(config.ai.personality.active).toBe(cardId)
    expect(config.ai.proactive.frequency).toBe("off")
    expect(config.ai.silentAccess.frequency).toBe("off")
    expect(config.ai.humanizer.enabled).toBe(false)
    expect(config.appearance.activeProfile).toBe("profile2")
    expect(config.ai.model).toBeTruthy()
  })
})

describe("宿主 ready.json 所有权", () => {
  const runDir = join(tmpdir(), "desk-pet-sim-eval-ready")
  const dataRoot = join(runDir, "data")
  const pid = 4321
  const ready = {
    schemaVersion: 1,
    generation: "gen-1",
    pid,
    runDir,
    dataRoot,
    controlDir: join(dataRoot, "logs", "sim", "control"),
    runtimeMode: "development",
    startedAt: "2026-10-25T10:00:00.000Z",
  }

  it("同一进程、同一运行根、development 模式才通过", () => {
    expect(runner.validateHostReady(ready, { runDir, pid })).toBe(ready)
  })

  it("pid、运行根、数据根、控制目录、模式与 schema 任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...ready, schemaVersion: 2 }, /schemaVersion/],
      ["missing field", { ...ready, controlDir: "" }, /缺少字段 controlDir/],
      ["pid", { ...ready, pid: 1 }, /pid=1 与本次子进程/],
      ["pid shape", { ...ready, pid: 0 }, /pid 非法/],
      ["runDir", { ...ready, runDir: join(tmpdir(), "other") }, /runDir 与本次运行根不一致/],
      ["dataRoot", { ...ready, dataRoot: join(runDir, "elsewhere") }, /dataRoot 不在运行根下/],
      ["controlDir", { ...ready, controlDir: join(dataRoot, "logs", "sim", "other") }, /controlDir 与数据根不同源/],
      ["runtimeMode", { ...ready, runtimeMode: "production" }, /runtimeMode=production/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateHostReady(value, { runDir, pid }), label).toThrow(pattern)
    }
  })
})

describe("控制通道 ready 装载摘要", () => {
  const runDir = join(tmpdir(), "desk-pet-sim-eval-ready")
  const expected = {
    generation: "gen-1",
    hostPid: 4321,
    runDir,
    cardId,
    fixtureId,
    fixtureHash,
    ...expectedSeedFixture,
  }
  const event = {
    type: "ready",
    sessionId,
    cardId,
    generation: expected.generation,
    hostPid: expected.hostPid,
    runDir,
    seed: {
      fixtureId,
      fixtureHash,
      sessionId,
      messageCount,
      memoryItemIds: ["m1", "m2", "m3", "m4"],
      status: "seeded",
    },
  }

  it("同一宿主、同一运行根、同一 fixture 与装载结果才通过", () => {
    expect(runner.assertBridgeReady(event, expected)).toBe(event.seed)
    expect(() => runner.assertBridgeReady({ ...event, seed: { ...event.seed, status: "reused" } }, expected)).not.toThrow()
  })

  it("generation/hostPid/runDir/Card/fixture/会话/计数/状态任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["type", { ...event, type: "message" }, /不是对象/],
      ["generation", { ...event, generation: "gen-2" }, /generation/],
      ["hostPid", { ...event, hostPid: 1 }, /hostPid/],
      ["runDir", { ...event, runDir: join(tmpdir(), "other") }, /runDir/],
      ["cardId", { ...event, cardId: "other" }, /cardId/],
      ["seed missing", { ...event, seed: null }, /缺少装载摘要/],
      ["fixtureId", { ...event, seed: { ...event.seed, fixtureId: "other" } }, /fixtureId/],
      ["fixtureHash", { ...event, seed: { ...event.seed, fixtureHash: "sha256:other" } }, /fixtureHash/],
      ["sessionId", { ...event, seed: { ...event.seed, sessionId: "other" } }, /不是 fixture 会话/],
      ["messageCount", { ...event, seed: { ...event.seed, messageCount: messageCount - 1 } }, /消息数/],
      ["memoryItemIds", { ...event, seed: { ...event.seed, memoryItemIds: ["m1"] } }, /初始记忆条数/],
      ["status", { ...event, seed: { ...event.seed, status: "pending" } }, /装载状态/],
      ["active session", { ...event, sessionId: "other" }, /活跃会话不是 fixture 会话/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.assertBridgeReady(value, expected), label).toThrow(pattern)
    }
  })
})

describe("seed.json 与 runner 状态同源", () => {
  const expected = {
    fixtureId,
    fixtureHash,
    cardName,
    cardId,
    profileId: null,
    ...expectedSeedFixture,
  }
  const seed = {
    schemaVersion: 1,
    fixtureId,
    fixtureHash,
    card: { name: cardName, activeId: cardId },
    profile: { activeId: null },
    fixture,
  }

  it("prepare 写下的 fixture/Card/Profile/会话/计数一致才通过", () => {
    expect(runner.validateSeedFile(seed, expected)).toBe(seed)
  })

  it("fixture/Card/Profile/会话/计数任一被改写都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...seed, schemaVersion: 2 }, /schemaVersion/],
      ["fixtureId", { ...seed, fixtureId: "other" }, /fixtureId 与 runner\.json/],
      ["fixtureHash", { ...seed, fixtureHash: "sha256:other" }, /fixtureHash 与 runner\.json/],
      ["card name", { ...seed, card: { ...seed.card, name: "other" } }, /Card 名称/],
      ["card id", { ...seed, card: { ...seed.card, activeId: "other" } }, /Card id/],
      ["profile missing", { ...seed, profile: {} }, /profile\.activeId/],
      ["profile", { ...seed, profile: { activeId: "profile2" } }, /Profile 与 runner\.json/],
      ["fixture missing", { ...seed, fixture: null }, /缺少 fixture/],
      ["inner fixtureId", { ...seed, fixture: { ...fixture, fixtureId: "other" } }, /fixture\.fixtureId 不一致/],
      [
        "fixture content",
        {
          ...seed,
          fixture: {
            ...fixture,
            initialSession: {
              ...fixture.initialSession,
              messages: fixture.initialSession.messages.map((message, index) =>
                index === 0 ? { ...message, content: `${message.content}（被改写）` } : message,
              ),
            },
          },
        },
        /fixture 内容与 runner\.json/,
      ],
      ["session", { ...seed, fixture: { ...fixture, initialSession: { ...fixture.initialSession, id: "other" } } }, /初始会话/],
      [
        "messages",
        { ...seed, fixture: { ...fixture, initialSession: { ...fixture.initialSession, messages: fixture.initialSession.messages.slice(1) } } },
        /消息数/,
      ],
      ["memory", { ...seed, fixture: { ...fixture, initialMemory: [] } }, /初始记忆数/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateSeedFile(value, expected), label).toThrow(pattern)
    }
  })
})

describe("seed-report.json 所有权", () => {
  const expected = {
    fixtureId,
    fixtureHash,
    generation: "gen-1",
    hostPid: 4321,
    ...expectedSeedFixture,
  }
  const report = {
    schemaVersion: 1,
    status: "seeded",
    fixtureId,
    fixtureHash,
    sessionId,
    sessionTitle: fixture.initialSession.title,
    messageCount,
    userMessageCount,
    memoryKeys: fixture.initialMemory.map(item => item.id),
    memoryItemIds: ["m1", "m2", "m3", "m4"],
    sourceCount: userMessageCount,
    revision: 2,
    generation: "gen-1",
    hostPid: 4321,
    seededAt: "2026-10-25T10:00:01.000Z",
  }

  it("同一宿主、同一 fixture、完整装载才通过", () => {
    expect(runner.validateSeedReport(report, expected)).toBe(report)
  })

  it("状态、计数、记忆清单与宿主归属任一错配都失败", () => {
    const cases: Array<[string, any, RegExp]> = [
      ["schema", { ...report, schemaVersion: 2 }, /schemaVersion/],
      ["status", { ...report, status: "reused" }, /期望 seeded/],
      ["fixtureId", { ...report, fixtureId: "other" }, /fixtureId/],
      ["fixtureHash", { ...report, fixtureHash: "sha256:other" }, /fixtureHash/],
      ["sessionId", { ...report, sessionId: "other" }, /会话与 fixture/],
      ["generation", { ...report, generation: "gen-2" }, /generation/],
      ["hostPid", { ...report, hostPid: 1 }, /hostPid/],
      ["messageCount", { ...report, messageCount: messageCount - 1 }, /消息数/],
      ["userMessageCount", { ...report, userMessageCount: userMessageCount - 1 }, /用户消息数/],
      ["sourceCount", { ...report, sourceCount: userMessageCount - 1 }, /来源数/],
      ["revision", { ...report, revision: -1 }, /revision/],
      ["memoryKeys", { ...report, memoryKeys: ["only-one"] }, /记忆键数/],
      ["memoryItemIds", { ...report, memoryItemIds: [] }, /记忆条数/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateSeedReport(value, expected), label).toThrow(pattern)
    }
  })
})

describe("控制通道日志读取", () => {
  it("忽略半行/坏行，取最后一条 ready", () => {
    const events = runner.readJsonl(
      '{"type":"ready","n":1}\nnot-json\n{"type":"message"}\n{"type":"ready","n":2}\n',
    )
    expect(events).toHaveLength(3)
    expect(runner.latestBridgeReady(events)).toMatchObject({ type: "ready", n: 2 })
    expect(runner.latestBridgeReady([{ type: "message" }])).toBeUndefined()
  })
})

describe("驱动消息回执身份", () => {
  const operation = {
    operationId: "op-1",
    caseId: "case-a",
    stepId: "say",
    trialId: "trial-1",
    sessionId: "session-1",
    generation: "gen-1",
  }
  const receipt = {
    type: "message",
    operation,
    requestId: "op-1",
    sessionId: "session-1",
    reply: "你好",
    outcome: "succeeded",
    toolCalls: [],
    assistantEntryId: "assistant-entry-1",
    replyBinding: "request-response",
  }

  it("回执原样绑定本次 operation、trial、会话与代际", () => {
    expect(runner.validateMessageReceipt(receipt, operation)).toMatchObject({
      sessionId: "session-1",
      reply: "你好",
      outcome: "succeeded",
      requestId: "op-1",
      operation,
      assistantEntryId: "assistant-entry-1",
      replyBinding: "request-response",
    })
  })

  it("错组回执、缺身份或会话不一致直接失败", () => {
    expect(() => runner.validateMessageReceipt(
      { ...receipt, operation: { ...operation, generation: "gen-old" } }, operation,
    )).toThrow(/generation/)
    expect(() => runner.validateMessageReceipt(
      { ...receipt, operation: { ...operation, operationId: "op-other" } }, operation,
    )).toThrow(/operationId/)
    expect(() => runner.validateMessageReceipt(
      { ...receipt, requestId: "op-other" }, operation,
    )).toThrow(/requestId/)
    expect(() => runner.validateMessageReceipt(
      { ...receipt, sessionId: "session-2" }, operation,
    )).toThrow(/sessionId/)
    expect(() => runner.validateMessageReceipt(
      { ...receipt, operation: undefined }, operation,
    )).toThrow(/请求身份/)
  })
})

describe("证据 id 与采集生命周期回执", () => {
  const attemptDir = join(tmpdir(), "desk-pet-repo", "test", "reports", "chat", "chat-w3b", "attempts", "0001")
  const expected = { evaluationRunId: "chat-w3b", attemptId: "0001", attemptDir }
  const target = { ...expected }
  const caseId = "saturday-companionship"
  const trialId = "trial-w3b"

  it("evaluation-run-id 与 trial-id 只接受小写安全字符，且不超长", () => {
    expect(runner.validateEvaluationRunId("chat-20261025.1")).toBe("chat-20261025.1")
    expect(runner.validateEvaluationRunId("a".repeat(64))).toBe("a".repeat(64))
    expect(runner.validateTrialId("trial-1_repair.2")).toBe("trial-1_repair.2")
    expect(runner.validateTrialId("a".repeat(96))).toBe("a".repeat(96))
    for (const invalid of ["", "Chat", "-a", ".a", "a b", "a/b", "a".repeat(65), undefined]) {
      expect(() => runner.validateEvaluationRunId(invalid), String(invalid)).toThrow(/evaluation-run-id 不合法/)
    }
    for (const invalid of ["", "Trial", ".a", "-a", "a b", "a/b", "a".repeat(97), undefined]) {
      expect(() => runner.validateTrialId(invalid), String(invalid)).toThrow(/trial-id 不合法/)
    }
  })

  it("capture_started 必须指向本次 attempt，before 快照不完整时拒绝继续", () => {
    const complete = { type: "capture_started", result: { ...target, complete: true, issues: [] } }
    expect(runner.validateCaptureStarted(complete, expected).complete).toBe(true)

    expect(() => runner.validateCaptureStarted({
      type: "capture_started",
      result: { ...target, complete: false, issues: ["会话 session-broken 读取失败", "记忆条目未完采"] },
    }, expected)).toThrow(/会话 session-broken 读取失败；记忆条目未完采/)

    const cases: Array<[string, any, RegExp]> = [
      ["type", { ...complete, type: "capture_trial" }, /没有返回 capture_started/],
      ["run", { ...complete, result: { ...target, evaluationRunId: "other", complete: true } }, /evaluationRunId/],
      ["attempt", { ...complete, result: { ...target, attemptId: "0002", complete: true } }, /attemptId/],
      ["dir", { ...complete, result: { ...target, attemptDir: join(tmpdir(), "elsewhere"), complete: true } }, /attemptDir/],
      ["missing result", { type: "capture_started" }, /缺少 result/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateCaptureStarted(value, expected), label).toThrow(pattern)
    }
  })

  it("capture_trial 的开始与结束都必须绑定本次用例与试次", () => {
    const begin = { type: "capture_trial", phase: "begin", caseId, trialId }
    const end = { type: "capture_trial", phase: "end", caseId, trialId, status: "completed" }
    expect(runner.validateCaptureTrial(begin, { phase: "begin", caseId, trialId })).toBe(begin)
    expect(runner.validateCaptureTrial(end, { phase: "end", caseId, trialId })).toBe(end)

    const expectedEnd = { phase: "end", caseId, trialId }
    const cases: Array<[string, any, RegExp]> = [
      ["type", { ...begin, type: "capture_started" }, /没有返回 capture_trial/],
      ["phase", begin, /期望 end/],
      ["case", { ...end, caseId: "other" }, /caseId/],
      ["trial", { ...end, trialId: "other" }, /trialId/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateCaptureTrial(value, expectedEnd), label).toThrow(pattern)
    }
  })

  it("capture_finished 允许不完整，但必须同一 attempt 且带完整对话数组与 issues", () => {
    const incomplete = {
      type: "capture_finished",
      result: {
        ...target,
        complete: false,
        issues: ["trace 封口失败"],
        dialogue: { messages: [{ role: "user", text: "问题" }] },
      },
    }
    const accepted = runner.validateCaptureFinished(incomplete, expected)
    expect(accepted.complete).toBe(false)
    expect(accepted.dialogue.messages).toHaveLength(1)

    const cases: Array<[string, any, RegExp]> = [
      ["type", { ...incomplete, type: "capture_status" }, /没有返回 capture_finished/],
      ["run", { ...incomplete, result: { ...incomplete.result, evaluationRunId: "other" } }, /evaluationRunId/],
      ["attempt", { ...incomplete, result: { ...incomplete.result, attemptId: "0002" } }, /attemptId/],
      ["dir", { ...incomplete, result: { ...incomplete.result, attemptDir: join(tmpdir(), "elsewhere") } }, /attemptDir/],
      ["messages", { ...incomplete, result: { ...incomplete.result, dialogue: {} } }, /完整对话数组/],
      ["issues", { ...incomplete, result: { ...incomplete.result, issues: undefined } }, /issues 数组/],
      ["complete", { ...incomplete, result: { ...incomplete.result, complete: "yes" } }, /complete 标记/],
    ]
    for (const [label, value, pattern] of cases) {
      expect(() => runner.validateCaptureFinished(value, expected), label).toThrow(pattern)
    }
  })
})

describe("数据集输入哈希与请求模型身份", () => {
  it("哈希覆盖用例、fixture 与套件，忽略读取路径等运行期字段", () => {
    const base = datasetInputHash(dataset, entry)
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(datasetInputHash({
      ...dataset,
      repoRoot: join(tmpdir(), "elsewhere"),
      categoriesPath: "elsewhere.json",
      questionTypesPath: "elsewhere.json",
      errors: [{ code: "noise", message: "运行期噪声" }],
      warnings: [{ code: "noise", message: "运行期噪声" }],
    }, entry)).toBe(base)

    const caseCopy = JSON.parse(JSON.stringify(dataset))
    const caseEntry = caseCopy.cases.find((candidate: any) => candidate.caseId === entry.caseId)
    caseEntry.case.driver[0].text = `${caseEntry.case.driver[0].text}（被改写）`
    expect(datasetInputHash(caseCopy, caseEntry)).not.toBe(base)

    const fixtureCopy = JSON.parse(JSON.stringify(dataset))
    const fixtureEntry = fixtureCopy.cases.find((candidate: any) => candidate.caseId === entry.caseId)
    fixtureEntry.fixture.initialMemory[0].content = `${fixtureEntry.fixture.initialMemory[0].content}（被改写）`
    expect(datasetInputHash(fixtureCopy, fixtureEntry)).not.toBe(base)

    const suiteCopy = JSON.parse(JSON.stringify(dataset))
    const suite = suiteCopy.suites.find((candidate: any) => candidate.suiteId === entry.suiteId)
    suite.purpose = `${suite.purpose}（被改写）`
    expect(datasetInputHash(suiteCopy, suiteCopy.cases.find((candidate: any) => candidate.caseId === entry.caseId))).not.toBe(base)
  })

  it("实际响应模型只认主聊天请求，忽略后台链路与失败请求", () => {
    const event = (kind: string, payload: Record<string, unknown>) => ({
      chunk: { events: [{ seq: 1, orphan: false, event: { kind, payload } }] },
    })
    const trace = [
      event("provider_request_end", { purpose: "main", responseModel: "provider/model-b" }),
      event("provider_request_end", { purpose: "main", responseModel: "provider/model-a" }),
      event("provider_request_end", { purpose: "main", responseModel: "provider/model-b" }),
      event("provider_request_end", { purpose: "memory", responseModel: "provider/memory-model" }),
      event("provider_request_end", { purpose: "main", status: "stream_failed" }),
      event("provider_request_end", { purpose: "main", responseModel: "  " }),
      event("provider_request_start", { purpose: "main", model: "provider/model-a" }),
    ].map(record => JSON.stringify(record)).join("\n")

    expect(runner.extractActualModels(`${trace}\n`)).toEqual(["provider/model-a", "provider/model-b"])
    expect(runner.extractActualModels("")).toEqual([])
    expect(runner.extractActualModels('{"chunk":{"events":[{"event":{"kind":"turn_end"}}]}}\n')).toEqual([])
  })
})

describe("关停证据与故障救援", () => {
  const AT = "2026-10-27T09:00:00.000+08:00"
  const LATER = "2026-10-27T10:00:00.000+08:00"
  const HASH = `sha256:${"a".repeat(64)}`
  const cleanExit = {
    schemaVersion: 1,
    pid: 4321,
    exitedAt: LATER,
    flush: { flushed: true, pending: 0, detail: "关停完成" },
    interrupted: false,
    forcedKill: false,
    detail: "关停完成",
  }

  it("exit.json 绑定本次宿主 pid 并校验 flush 形状 [chat-run-exit-record]", () => {
    expect(runner.validateHostExit(cleanExit, { hostPid: 4321 })).toEqual(cleanExit)
    expect(() => runner.validateHostExit(cleanExit, { hostPid: 999 })).toThrow(/pid/)
    expect(() => runner.validateHostExit({ ...cleanExit, schemaVersion: 2 }, { hostPid: 4321 })).toThrow(/schema/)
    expect(() => runner.validateHostExit({ ...cleanExit, exitedAt: "not-a-time" }, { hostPid: 4321 })).toThrow(/exitedAt/)
    expect(() => runner.validateHostExit({ ...cleanExit, flush: { flushed: "yes", pending: 0 } }, { hostPid: 4321 })).toThrow(/flush/)
    expect(() => runner.validateHostExit({ ...cleanExit, interrupted: "no" }, { hostPid: 4321 })).toThrow(/interrupted/)
  })

  it("缺少 exit.json、flush 未完成、中断或强杀都算不干净退出 [chat-run-exit-flush]", () => {
    expect(runner.hostExitProblems(cleanExit)).toEqual([])
    expect(runner.hostExitProblems(null).join("；")).toMatch(/exit\.json/)
    expect(runner.hostExitProblems({ ...cleanExit, flush: null }).join("；")).toMatch(/flush/)
    expect(runner.hostExitProblems({ ...cleanExit, flush: { flushed: false, pending: 3, detail: "作业未收敛" } }).join("；"))
      .toMatch(/pending=3.*作业未收敛/)
    expect(runner.hostExitProblems({ ...cleanExit, interrupted: true }).join("；")).toMatch(/中断/)
    expect(runner.hostExitProblems({ ...cleanExit, forcedKill: true }).join("；")).toMatch(/强杀/)
  })

  it("宿主退出后可从同一证据封存中断 attempt，并保留可修复的封存记录 [chat-run-rescue]", async () => {
    const root = mkdtempSync(join(tmpdir(), "desk-pet-runner-rescue-"))
    try {
      const { runDir } = createChatRun({
        reportsDir: root,
        evaluationRunId: "rescue-run",
        createdAt: AT,
        scope: { suiteIds: ["daily-companionship"], caseIds: [entry.caseId], purpose: "regression", holdout: false },
        budget: { trials: 1, messages: 10, tokens: 1000, minutes: 10, repairs: 1 },
      })
      setChatRunPhase(runDir, { phase: "running", updatedAt: AT })
      const { attemptDir, attempt } = beginChatAttempt({
        runDir,
        identity: {
          code: { commit: "abc1234", sourceHash: HASH, dirty: false },
          inputs: { datasetHash: HASH, fixtureHash: HASH, cardHash: HASH, configHash: HASH },
          tools: { driverVersion: "driver-1", rubricVersion: "rubric-1", graderVersion: "grader-1" },
          host: { mode: "full-desktop", capabilities: ["chat", "memory", "session"] },
          platform: { os: "darwin", arch: "arm64" },
          runtime: { version: "22.22.3" },
          models: { requested: "provider/model-a" },
          budget: { trials: 1, messages: 10, tokens: 1000, minutes: 10, repairs: 1 },
        },
        expectedTrials: [{ caseId: entry.caseId, trialId: "trial-1" }],
        expectedSessions: [sessionId],
        createdAt: AT,
      })
      writeFileSync(join(runDir, "ready.json"), "{}\n")
      const state = {
        schemaVersion: 1,
        runId: "rescue-run",
        caseId: entry.caseId,
        suiteId: entry.suiteId,
        status: "running",
        hostPid: null,
        chat: {
          evaluationRunId: "rescue-run",
          runDir,
          attemptId: attempt.attemptId,
          attemptDir,
          trialId: "trial-1",
        },
      }

      const rescued = await runner.rescueRun({ runDir, state, reason: "宿主崩溃", now: LATER })
      expect(rescued.status).toBe("inconclusive")
      const manifest = JSON.parse(readFileSync(join(attemptDir, "manifest.json"), "utf8"))
      expect(manifest.outcome).toBe("interrupted")
      expect(manifest.integrity.status).toBe("inconclusive")
      expect(manifest.integrity.issues.join("；")).toMatch(/宿主崩溃/)
      expect(manifest.integrity.issues.join("；")).toMatch(/dialogue\.jsonl 缺失/)
      expect(manifest.integrity.issues.join("；")).toMatch(/exit\.json/)
      expect(readChatWorkflow(runDir).phase).toBe("blocked")
      expect(existsSync(join(runDir, "report.md"))).toBe(true)
      const saved = JSON.parse(readFileSync(join(runDir, "runner.json"), "utf8"))
      expect(saved.status).toBe("rescued")
      expect(saved.chat.sealedAt).toBe(LATER)
      expect(saved.chat.integrity.status).toBe("inconclusive")

      await expect(runner.rescueRun({ runDir, state: saved, now: LATER })).rejects.toThrow(/已封存/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("宿主仍在运行或没有 attempt 时拒绝救援 [chat-run-rescue-guard]", async () => {
    await expect(runner.rescueRun({
      runDir: join(tmpdir(), "desk-pet-runner-rescue-missing"),
      state: { runId: "missing", hostPid: process.pid, chat: { attemptDir: join(tmpdir(), "missing-attempt") } },
    })).rejects.toThrow(/先 stop/)
    await expect(runner.rescueRun({
      runDir: join(tmpdir(), "desk-pet-runner-rescue-missing"),
      state: { runId: "missing", hostPid: null, chat: null },
    })).rejects.toThrow(/attempt/)
  })
})
