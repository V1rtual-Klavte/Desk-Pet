// ==========================================
// 静默了解「读什么」决策的输入补齐（W4-B）
// ==========================================
//
// 决策调用曾经只拿到当前窗口 + 截图 + 最近 8 条了解摘要；本文件固定补齐后的五个输入块：
// 本地时间 / Card 人设 / 行为画像 / 话题权重 / 长期记忆（全部只读、有界、运行时绑定），
// 以及各自的降级路径（画像不可靠、话题为空、无 Card、无记忆、无活跃会话）。
//
// 归属 L3：调度器链经 engine/harness 的 completePiText 与真 store 落盘。
// 窗口、Card、画像用替身注入（各自领域不在本链的验证范围；对应领域有各自测试）；
// Provider 用 fake；长期记忆走召回端口的注入接缝 installMemoryProvider（测试探针的既定入口），
// 探针同时捕获召回请求，断言身份来自运行时而不是模型参数。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryProvider, MemoryRecallRequest } from "@/services/agent/memory"

const budget = vi.hoisted(() => ({
  reserve: vi.fn(async (_request: { kind: string; dailyLimit: number; reservedTokens: number }) => ({ reserved: true, reason: null })),
  settle: vi.fn(async (request: { status: string }) => ({ status: request.status })),
}))
vi.mock("@/services/proactive/auxiliary-budget", () => ({
  reserveAuxiliaryBudget: budget.reserve,
  settleAuxiliaryBudget: budget.settle,
}))

/** 窗口观察与运行活动的替身状态：各用例在启动调度器前填好。 */
const windowState = vi.hoisted(() => ({
  idleForMs: null as number | null,
  observation: null as Record<string, unknown> | null,
}))
vi.mock("@/services/window", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window")>()
  return {
    ...actual,
    getLatestWindowObservation: () => windowState.observation,
    getRuntimeActivity: async () => ({
      isPetVisible: true, isPetForeground: false, screenState: "observed" as const,
      idleForMs: windowState.idleForMs, observedAt: Date.now(),
    }),
  }
})

interface CardStub { id: string; name: string; description: string; sections: { roleSetting: string } }
const cardState = vi.hoisted(() => ({ card: null as CardStub | null }))
vi.mock("@/services/personality", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/personality")>()
  return {
    ...actual,
    getActiveCard: () => cardState.card as unknown as import("@/services/personality").PersonalityCard | null,
  }
})

/** 画像快照替身：byHour[i] = i 分钟/周，断言不依赖当前钟点。 */
const behaviorState = vi.hoisted(() => ({
  quality: "reliable" as "reliable" | "insufficient" | "unavailable",
  byHour: Array.from({ length: 24 }, (_, hour) => hour * 60_000),
}))
vi.mock("@/services/behavior", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/behavior")>()
  return {
    ...actual,
    getBehaviorSnapshot: () => {
      const activity = { byHour: behaviorState.byHour, activeMs: 0, idleMs: 0, unobservedMs: 0, petForegroundMs: 0 }
      return {
        revision: 1, generatedAt: Date.now(),
        quality: { status: behaviorState.quality, sampleDays: 3, coverageRatio: 0.8, eligibleCollectionMs: 1, reasons: [] },
        rhythm: { weekdays: Array(24).fill(0) as number[], weekends: Array(24).fill(0) as number[], days7: 3, days30: 3 },
        apps: { categoryShare: {} as never, commonAppIds: [] as string[], unknownRatio: 0 },
        focus: { segments: 0, totalMs: 0, longestMs: 0, meanMs: 0, switchesPerHour: 0, currentContinuousMs: 0, currentCategory: null },
        activity,
        weekly: { days: 3, focus: { segments: 0, totalMs: 0, longestMs: 0, meanMs: 0, switchesPerHour: 0, coveredMs: 0 }, activity },
      } as unknown as import("@/services/behavior").BehaviorSnapshot
    },
  }
})

let root = ""
beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "observation-decision-inputs-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await sleep(10)
  }
}

function observedWindow(): Record<string, unknown> {
  return {
    appId: "com.apple.Safari", app: "Safari", title: "决策输入测试窗口", observedAt: Date.now(), sampleMonoMs: 1,
    monitorGeneration: 1, sequence: 1, observationState: "observed", idleForMs: 0,
    isPetVisible: true, isPetForeground: false,
  }
}

beforeEach(() => {
  budget.reserve.mockClear()
  budget.settle.mockClear()
  windowState.idleForMs = null
  windowState.observation = null
  cardState.card = null
  behaviorState.quality = "reliable"
})

/** 干净的模块世界 + 测试宿主；预置空 store，各用例再往里追加来源。 */
async function bootObservation() {
  vi.resetModules()
  const { installNodeHostBridge } = await import("../../host/install-node-bridge")
  installNodeHostBridge()
  const nodeIpc = await import("../../host/node-ipc")
  nodeIpc.setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
  const config = await import("@/services/config")
  config.setOverride("ai.silentAccess.frequency", "medium")
  const { getHostBridge } = await import("@/services/host")
  const dir = await paths.runtimePath("data", "behavior")
  const path = await paths.runtimePath("data", "behavior", "understanding.json")
  await getHostBridge().request("dir_create", { path: dir, recursive: true })
  await getHostBridge().request("file_write", { path, maxBytes: 256 * 1024, content: JSON.stringify({
    schemaVersion: 1, observations: [], topics: [], invalidatedTopicSources: [], topicClearedAt: 0,
    lastAuxiliaryAttemptAt: 0, targetReadAttempts: [],
  }) })
  const observation = await import("@/services/observation")
  windowState.observation = observedWindow()
  return observation
}

function memoryProbe(items: readonly string[], requests: MemoryRecallRequest[]): MemoryProvider {
  return {
    recall: async request => {
      requests.push(request)
      return items.map((text, index) => ({
        sourceId: `mem-${index}@1`, memoryVersion: `mem-${index}:1`, provenance: "memory:user",
        taint: "derived" as const, text, tokenBudget: 1_000, tier: "core" as const,
      }))
    },
  }
}

interface FakePayload { messages: Array<{ role: string; content: unknown }> }

/** 决策调用的 user 文本（去表头）解析回 JSON：表头是给人读的、JSON 才是输入面。 */
function payloadUserText(payload: FakePayload | undefined): string {
  const message = payload?.messages.find(item => item.role === "user")
  return typeof message?.content === "string" ? message.content : ""
}
function decisionOf(payload: FakePayload | undefined): Record<string, unknown> {
  const text = payloadUserText(payload)
  const start = text.indexOf("{")
  expect(start, "决策调用没有携带 JSON 输入面").toBeGreaterThanOrEqual(0)
  return JSON.parse(text.slice(start)) as Record<string, unknown>
}

describe("静默了解决策输入补齐", () => {
  it("决策输入包含本地时间/Card 人设/画像/话题/长期记忆，且各有界 [observation-decision-inputs]", async () => {
    const observation = await bootObservation()
    const { appendUnderstanding, appendTopicEvidence } = await import("@/services/observation/store")
    const now = Date.now()
    await appendUnderstanding([
      { sourceId: "under-1", kind: "file", observedAt: now - 1_000, expiresAt: now + 600_000, summary: "摘要一：项目结构已了解" },
      { sourceId: "under-2", kind: "window", observedAt: now - 2_000, expiresAt: now + 600_000, summary: "摘要二：正在读文档" },
    ])
    await appendTopicEvidence([
      { topic: "软件架构", weight: 2, sourceId: "topic-src-a", observedAt: now - 1_000, cardId: "card-decide-01" },
      { topic: "软件架构", weight: 2, sourceId: "topic-src-b", observedAt: now - 1_000, cardId: "card-decide-01" },
      { topic: "桌面宠物", weight: 1, sourceId: "topic-src-c", observedAt: now - 1_000, cardId: "card-decide-01" },
      { topic: "桌面宠物", weight: 1, sourceId: "topic-src-d", observedAt: now - 1_000, cardId: "card-decide-01" },
    ])
    const session = await import("@/services/session")
    session.activeSessionId.value = "session-decide-01"
    cardState.card = { id: "card-decide-01", name: "小桌宠", description: "陪伴型桌宠", sections: { roleSetting: "你是" + "温".repeat(500) } }

    const memoryRequests: MemoryRecallRequest[] = []
    const memory = await import("@/services/agent/memory")
    const restoreMemory = memory.installMemoryProvider(memoryProbe([
      "长期记忆甲：用户在做一个桌宠项目",
      "长期记忆乙：用户偏好浅色主题",
      "丙：" + "x".repeat(600),
      "长期记忆丁：本条超出条数上限不应出现",
    ], memoryRequests))
    const { fakeText, installFakeProvider } = await import("../../host/fake-provider")
    const fake = installFakeProvider([fakeText('{"targets":[]}'), fakeText('{"observations":[]}')])

    try {
      windowState.idleForMs = 3_600_000
      observation.startSilentUnderstanding()
      await waitFor(() => fake.payloads.length >= 2)
      await waitFor(() => budget.settle.mock.calls.length > 0)
      const decisionText = payloadUserText(fake.payloads[0] as unknown as FakePayload)
      const decision = decisionOf(fake.payloads[0] as unknown as FakePayload)

      // 既有输入形状不回归
      expect(decision.screenState, "决策没有声明当前屏幕状态").toBe("observed")
      expect(decision.title, "决策没有带上当前窗口标题").toBe("决策输入测试窗口")
      expect(decision.knownUnderstanding, "最近了解摘要没有保留").toEqual(["摘要一：项目结构已了解", "摘要二：正在读文档"])

      // 本地时间：可读时刻（含星期）+ 时区
      const localTime = decision.localTime as { localTime: string; timezone: string }
      expect(localTime.localTime, "本地时间不是可读时刻").toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]$/)
      expect(localTime.timezone.length, "本地时间缺少时区").toBeGreaterThan(0)

      // Card 人设：有界摘要（500 字角色设定被截到上限）
      const card = decision.card as { name: string; description: string; roleSetting: string }
      expect(card.name).toBe("小桌宠")
      expect(card.roleSetting.length, "角色设定没有按上限截断").toBe(240)
      expect(decisionText.includes("温".repeat(241)), "整份角色设定进入了决策提示").toBe(false)

      // 行为画像：质量状态 + 就近 6 个钟点的活跃分钟（byHour[i] = i 分钟/周）
      const behavior = decision.behavior as { quality: string; sampleDays: number; hours: Array<{ hour: number; activeMinutes: number }> }
      expect(behavior.quality, "画像质量状态没有进入决策").toBe("reliable")
      expect(behavior.hours.length, "画像小时块没有界").toBe(6)
      expect(behavior.hours.map(item => item.activeMinutes), "画像活跃分钟没有按钟点映射").toEqual(behavior.hours.map(item => item.hour))

      // 话题权重：top-N 与占比；只有 ≥2 个独立来源的话题入榜
      const topics = decision.topics as Array<{ topic: string; share: number }>
      expect(topics.map(item => item.topic), "话题块没有带上权重最高的标签").toEqual(["软件架构", "桌面宠物"])
      expect(topics[0]?.share, "话题占比不是 0-1 的小数").toBeCloseTo(2 / 3, 2)

      // 长期记忆：条数与单条字符都有界
      const memoryBrief = decision.memory as string[]
      expect(memoryBrief.length, "记忆块没有按条数上限截断").toBe(3)
      expect(memoryBrief[0]).toBe("长期记忆甲：用户在做一个桌宠项目")
      expect(memoryBrief[2]?.length, "单条记忆没有按字符上限截断").toBe(400)
      expect(decisionText.includes("长期记忆丁"), "超出条数上限的记忆进入了提示").toBe(false)
      expect(decisionText.includes("x".repeat(401)), "单条记忆超过了字符上限").toBe(false)

      // 运行时绑定：召回身份来自活跃会话与激活 Card，空 query 且不重排
      expect(memoryRequests.length, "决策没有走召回端口取长期记忆").toBe(1)
      const request = memoryRequests[0]!
      expect(request.requestId).toMatch(/^observation-decision-/)
      expect(request).toMatchObject({ sessionId: "session-decide-01", cardId: "card-decide-01", query: "", tokenBudget: 256, skipRerank: true })

      // 预算不越界：预留是有限的正数（上界由各块截断共同保证）
      const reservation = budget.reserve.mock.calls.find(([value]) => value.kind === "observation")?.[0]
      expect(reservation?.dailyLimit, "每日批数没有取中档的 8").toBe(8)
      expect(Number.isFinite(reservation?.reservedTokens) && (reservation?.reservedTokens ?? 0) > 0, "预留 token 不合法").toBe(true)
    } finally {
      await observation.stopSilentUnderstanding()
      fake.restore()
      restoreMemory()
    }
  })

  it("画像不可靠、话题为空、无 Card、记忆为空时决策照跑，各块如实降级 [observation-decision-inputs-degrade]", async () => {
    const observation = await bootObservation()
    const session = await import("@/services/session")
    session.activeSessionId.value = "session-decide-02"
    behaviorState.quality = "unavailable"
    const { fakeText, installFakeProvider } = await import("../../host/fake-provider")
    const fake = installFakeProvider([fakeText('{"targets":[]}'), fakeText('{"observations":[]}')])

    try {
      windowState.idleForMs = 3_600_000
      observation.startSilentUnderstanding()
      await waitFor(() => fake.payloads.length >= 2)
      await waitFor(() => budget.settle.mock.calls.some(([value]) => value.status === "committed"))
      const decision = decisionOf(fake.payloads[0] as unknown as FakePayload)

      expect(decision.card, "没有激活 Card 时没有降级为 null").toBeNull()
      expect(decision.topics, "话题为空时没有降级为空数组").toEqual([])
      expect(decision.memory, "记忆为空时没有降级为空数组").toEqual([])
      expect((decision.behavior as { quality: string }).quality, "画像不可靠时没有如实带状态").toBe("unavailable")
      expect((decision.behavior as { hours: unknown[] }).hours.length, "画像降级时小时块没有界").toBe(6)
      expect((decision.localTime as { timezone: string }).timezone.length).toBeGreaterThan(0)
    } finally {
      await observation.stopSilentUnderstanding()
      fake.restore()
    }
  })

  it("没有活跃会话时不发起记忆召回，身份不被自造 [observation-decision-memory-identity]", async () => {
    const observation = await bootObservation()
    const session = await import("@/services/session")
    session.activeSessionId.value = ""
    const memoryRequests: MemoryRecallRequest[] = []
    const memory = await import("@/services/agent/memory")
    const restoreMemory = memory.installMemoryProvider(memoryProbe(["不应被取到"], memoryRequests))
    const { fakeText, installFakeProvider } = await import("../../host/fake-provider")
    const fake = installFakeProvider([fakeText('{"targets":[]}'), fakeText('{"observations":[]}')])

    try {
      windowState.idleForMs = 3_600_000
      observation.startSilentUnderstanding()
      await waitFor(() => fake.payloads.length >= 2)
      await waitFor(() => budget.settle.mock.calls.some(([value]) => value.status === "committed"))
      const decision = decisionOf(fake.payloads[0] as unknown as FakePayload)

      expect(memoryRequests, "没有活跃会话时仍向召回端口发起了请求").toEqual([])
      expect(decision.memory, "没有会话身份时记忆块不为空").toEqual([])
    } finally {
      await observation.stopSilentUnderstanding()
      fake.restore()
      restoreMemory()
    }
  })
})
