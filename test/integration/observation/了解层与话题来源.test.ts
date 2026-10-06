import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { initPaths, runtimePath } from "@/services/paths"
import { getHostBridge } from "@/services/host"
import { silentAccessConfig } from "@/services/config"
import {
  clearSilentUnderstanding, getTopicWeights, getUnderstandingPromptBlock, getUnderstandingSnapshot,
  invalidateTopicSources, startSilentUnderstanding, stopSilentUnderstanding,
} from "@/services/observation"
import { drainTopicIntake, processTopicBatch, recordCommittedUserParticipation } from "@/services/observation/topics"
import { appendUnderstanding, appendTopicEvidence } from "@/services/observation/store"

const budget = vi.hoisted(() => ({
  reserve: vi.fn(async () => ({ reserved: true, reason: null })),
  settle: vi.fn(async (request: { status: "committed" | "failed" | "unresolved" }) => ({ status: request.status })),
}))

vi.mock("@/services/proactive/auxiliary-budget", () => ({
  reserveAuxiliaryBudget: budget.reserve,
  settleAuxiliaryBudget: budget.settle,
}))

// 清除静默了解现在会联动记忆侧的失效闭包（Rust 专属命令，Node 测试桥不持有）：
// 本文件的用例只考了解层存储与话题链，替身挂住闭包调用（语义在 memory_apply_change 的
// forget_understanding 动作、`clearSilentUnderstandingOwned` 的联动用例与 Rust 单测覆盖）。
const memoryDomain = vi.hoisted(() => ({ forgetUnderstandingDerivedMemory: vi.fn(async () => 0) }))
vi.mock("@/services/agent/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory")>()),
  forgetUnderstandingDerivedMemory: memoryDomain.forgetUnderstandingDerivedMemory,
}))

let root = ""
let restoreProvider: (() => void) | undefined

beforeAll(async () => {
  const testTempRoot = join(process.cwd(), "test", ".tmp")
  mkdirSync(testTempRoot, { recursive: true })
  root = mkdtempSync(join(testTempRoot, "observation-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => {
  vi.clearAllMocks()
  await clearSilentUnderstanding()
  startSilentUnderstanding()
})

afterEach(async () => {
  restoreProvider?.()
  restoreProvider = undefined
  await stopSilentUnderstanding()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function topicSourceId(sessionId: string, entryId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sessionId}\n${entryId}`))
  return `topic-${[...new Uint8Array(digest)].slice(0, 16).map(value => value.toString(16).padStart(2, "0")).join("")}`
}

function committedInput(entryId: string, text: string, options: Partial<{
  sessionId: string; committedAt: number; cardId: string; committed: boolean; origin: string; taint: string; eligibleForMemory: boolean;
}> = {}) {
  return {
    sessionId: options.sessionId ?? "session-observation-01",
    entryId,
    committedAt: options.committedAt ?? Date.now() + 5,
    text,
    committed: options.committed ?? true,
    origin: options.origin ?? "user",
    taint: options.taint ?? "trusted_user",
    eligibleForMemory: options.eligibleForMemory ?? true,
    cardId: options.cardId ?? "card-observation",
  }
}

describe("静默了解与话题来源", () => {
  it("只向请求暴露未过期摘要，关闭时隐藏，清除后旧来源不能回灌 [observation-understanding-ttl-clear]", async () => {
    const now = Date.now()
    await appendUnderstanding([
      { sourceId: "screen-source-01", kind: "screenshot", observedAt: now - 1_000, expiresAt: now + 60_000, summary: "当前画面有一个代码编辑器" },
      { sourceId: "file-source-01", kind: "file", observedAt: now - 2_000, expiresAt: now + 60_000, summary: "项目文档讨论模块边界" },
      { sourceId: "window-source-01", kind: "window", observedAt: now - 3_000, expiresAt: now + 60_000, summary: "正在查看项目源码" },
      { sourceId: "expired-source-01", kind: "file", observedAt: now - 10_000, expiresAt: now - 1, summary: "过期摘要不进入请求" },
    ])

    const snapshot = getUnderstandingSnapshot(now)
    expect(snapshot.quality, "三条有效来源应使了解层不再薄").toBe("ready")
    expect(snapshot.observations.map(row => row.sourceId), "过期来源仍被投影").toEqual([
      "screen-source-01", "file-source-01", "window-source-01",
    ])
    const block = getUnderstandingPromptBlock()
    expect(block?.text, "有效了解摘要没有进入只读请求块").toContain("项目文档讨论模块边界")
    expect(block?.sourceId, "请求块没有携带派生来源身份").toContain("file-source-01")

    const frequency = Object.getOwnPropertyDescriptor(silentAccessConfig, "frequency")
    Object.defineProperty(silentAccessConfig, "frequency", { configurable: true, get: () => "off" })
    try {
      expect(getUnderstandingPromptBlock(), "静默访问关闭后仍暴露观察摘要").toBeUndefined()
      expect(getUnderstandingSnapshot().observations, "静默访问关闭后仍保留当前读投影").toEqual([])
    } finally {
      if (frequency) Object.defineProperty(silentAccessConfig, "frequency", frequency)
    }

    const sourceBeforeClear = "clear-user-source"
    await appendTopicEvidence([{ topic: "软件架构", weight: 2, sourceId: sourceBeforeClear, observedAt: Date.now() - 1_000, cardId: "card-observation" }])
    await clearSilentUnderstanding()
    expect(getUnderstandingSnapshot().observations, "清除后仍可召回旧了解摘要").toEqual([])
    expect(await getTopicSourceRows(await runtimePath("data", "behavior", "understanding.json")), "清除后旧话题标签仍在派生存储").toEqual([])

    const oldInput = committedInput("old-entry-before-clear", "我之前读过关于软件架构的资料", { committedAt: Date.now() - 60_000 })
    recordCommittedUserParticipation(oldInput)
    await drainTopicIntake()
    expect(await processTopicBatch(new AbortController().signal), "清除前提交的历史输入被再次整理").toBe(false)
    expect(getUnderstandingPromptBlock(), "清除后旧输入重新生成了了解请求块").toBeUndefined()
  })

  it("话题标签只从可信已提交用户参与生成，第二个独立来源前不形成选材权重，来源失效与取消有效 [observation-topic-trust-cancel]", async () => {
    const sessionId = "session-topic-02"
    const first = committedInput("entry-topic-01", "最近我在研究如何给前端模块拆分依赖边界", { sessionId })
    const second = committedInput("entry-topic-02", "我又在看怎样保持模块依赖方向清晰", { sessionId, committedAt: Date.now() + 10 })
    const firstSource = await topicSourceId(sessionId, first.entryId)
    const secondSource = await topicSourceId(sessionId, second.entryId)
    const fake = installFakeProvider([
      fakeText(JSON.stringify({ entries: [{ sourceId: firstSource, topics: [{ topic: "软件架构", weight: 2 }] }] })),
      fakeText(JSON.stringify({ entries: [{ sourceId: secondSource, topics: [{ topic: "软件架构", weight: 2 }] }] })),
    ])
    restoreProvider = fake.restore

    recordCommittedUserParticipation({ ...first, origin: "tool" })
    recordCommittedUserParticipation({ ...first, taint: "untrusted_external", entryId: "entry-topic-untrusted" })
    recordCommittedUserParticipation({ ...first, eligibleForMemory: false, entryId: "entry-topic-ineligible" })
    recordCommittedUserParticipation({ ...first, committed: false, entryId: "entry-topic-uncommitted" })
    await drainTopicIntake()
    expect(await processTopicBatch(new AbortController().signal), "非可信来源意外创建话题画像").toBe(false)
    expect(fake.payloads.length, "模型收到了非可信来源或被拒绝来源").toBe(0)

    recordCommittedUserParticipation(first)
    await drainTopicIntake()
    expect(await processTopicBatch(new AbortController().signal), "可信提交的话题参与批次没有完成").toBe(true)
    expect(fake.payloads.length, "可信用户话题没有走辅助模型标签整理").toBe(1)
    expect(fake.payloads[0]?.tools?.length ?? 0, "话题整理子运行获得了工具").toBe(0)
    expect(fake.payloads[0]?.messages.some(message => JSON.stringify(message).includes(first.text)), "辅助请求没有收到这条可信用户输入").toBe(true)
    expect(getTopicWeights("card-observation"), "单个可信提及已直接成为话题偏好").toEqual([])

    recordCommittedUserParticipation(second)
    await drainTopicIntake()
    expect(await processTopicBatch(new AbortController().signal), "第二条独立参与来源没有整理").toBe(true)
    expect(fake.payloads.length, "第二个来源没有触发第二批辅助标签").toBe(2)

    const labels = getTopicWeights("card-observation")
    expect(labels.length, "两个独立参与来源没有形成话题权重").toBe(1)
    expect(labels[0]?.topic, "话题画像保存了非标签正文").toBe("软件架构")
    const path = await runtimePath("data", "behavior", "understanding.json")
    const { content } = await getHostBridge().request("file_read", { path, maxBytes: 256 * 1024 })
    expect(content, "派生存储写入了原始会话正文").not.toContain(first.text)
    expect(content, "派生存储写入了第二条原始会话正文").not.toContain(second.text)
    expect(content, "派生存储直接保留了用户entry ID").not.toContain(first.entryId)
    expect(content, "派生存储直接保留了第二个用户entry ID").not.toContain(second.entryId)

    await invalidateTopicSources(sessionId, [first.entryId, second.entryId])
    expect(getTopicWeights("card-observation"), "撤销全部源 entry 后标签仍影响选材").toEqual([])

    const cancelA = committedInput("entry-cancel-01", "取消前我也在读关于软件架构的内容", { sessionId, committedAt: Date.now() + 20 })
    const cancelB = committedInput("entry-cancel-02", "取消前继续看依赖关系和模块设计", { sessionId, committedAt: Date.now() + 21 })
    recordCommittedUserParticipation(cancelA)
    recordCommittedUserParticipation(cancelB)
    await drainTopicIntake()
    await clearSilentUnderstanding()
    expect(await processTopicBatch(new AbortController().signal), "清除后的话题队列仍在启动模型").toBe(false)
    expect(fake.payloads.length, "取消后仍有旧话题模型请求").toBe(2)
    expect(getTopicWeights("card-observation"), "清除后保留了标签权重").toEqual([])
  })
})

async function getTopicSourceRows(path: string): Promise<Array<{ topic: string; sourceId: string }>> {
  const { content } = await getHostBridge().request("file_read", { path, maxBytes: 256 * 1024 })
  return (JSON.parse(content) as { topics: Array<{ topic: string; sourceId: string }> }).topics
}

describe("话题来源失效的预算等待边界", () => {
  it("四条长讨论按可负担完整来源推进，不会永久阻塞队首 [observation-topic-large-batch-progress]", async () => {
    const fake = installFakeProvider([fakeText('{"entries":[]}')])
    restoreProvider = fake.restore
    for (let index = 0; index < 4; index++) {
      recordCommittedUserParticipation(committedInput(`large-entry-${index}`, "线程".repeat(3000), { sessionId: "large-topic-session" }))
    }
    await drainTopicIntake()
    expect(await processTopicBatch(new AbortController().signal)).toBe(true)
    const user = fake.payloads[0]?.messages.find(message => message.role === "user")
    const text = typeof user?.content === "string" ? user.content : ""
    const sent = JSON.parse(text) as { entries: Array<{ text: string }> }
    expect(sent.entries.length).toBe(3)
    expect(sent.entries.every(entry => entry.text === "线程".repeat(3000))).toBe(true)
    expect(fake.payloads.length).toBe(1)
  })
  it("预算在飞期间遗忘来源，返回额度后不能再把原话发给模型 [observation-topic-revoked-before-provider]", async () => {
    let release!: (value: { reserved: boolean; reason: null }) => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const reserved = new Promise<{ reserved: boolean; reason: null }>(resolve => { release = resolve })
    budget.reserve.mockImplementationOnce(async () => { started(); return reserved })
    const fake = installFakeProvider([fakeText('{"entries":[]}')])
    restoreProvider = fake.restore
    const input = committedInput("entry-budget-revoked", "我正在认真讨论Java线程和并发问题", { sessionId: "budget-revoked-session" })
    recordCommittedUserParticipation(input)
    await drainTopicIntake()
    const processing = processTopicBatch(new AbortController().signal)
    await waiting
    await invalidateTopicSources(input.sessionId, [input.entryId])
    release({ reserved: true, reason: null })
    expect(await processing).toBe(false)
    expect(fake.payloads).toEqual([])
    expect(budget.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", usage: { totalTokens: 0 } }))
    expect(getTopicWeights("card-observation")).toEqual([])
  })
})
