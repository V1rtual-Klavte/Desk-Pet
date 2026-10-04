// ==========================================
// 主动消息来源与提交 —— 主动表达经生产 Harness 生成，只有可核实的 native assistant tip 与已确认回执可见。
// ==========================================
//
// 被测：主动表达落成 `deskpet.active_message` 意图条目与 native assistant commit；来源不可提升为用户事实。
//
// 归属 L3（不是 L2）的理由：断言读的是真实回合落盘的会话条目 —— 主动消息的投递路径
// （`sendActiveMessage`）驱动完整 agent loop，fake Provider 只替换 Provider。
//
// caseId 归 proactive/pr-05；fake 只替 Provider，JSONL operation/tip 仍由真实 Harness 生成。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { runTestActiveExpression } from "../../host/active-expression"
import { sessionEntries, sessionMessages } from "../../host/session-entries"
import { readActiveAttemptEvidence } from "@/services/engine/harness"
import { getActiveSessionId, unansweredCount } from "@/services/session/store"
import { initChat, captureProactiveOwner } from "@/services/agent/runner"
import { registerActiveReceiptReader } from "@/services/session/read-model"
import { runActiveTurn } from "../memory/回合夹具"
import { initPaths } from "@/services/paths"
import { standardSetup } from "../../host/standard-setup"
import { getCard, initCards } from "@/services/personality/loader"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"

/** 主动意图正文：作为模型上下文，不是预生成的用户台词或可信用户输入。 */
const ACTIVE_TEXT = "基于此刻的窗口线索，给出一条简短陪伴表达。"

let root = ""
let restoreFakeProvider: (() => void) | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-active-origin-"))
  setTestDataRoot(root)
  await initPaths()

  // Node IPC 不负责复制桌面安装包里的默认资源；给这个真实 Harness 场景准备一张与生产同形
  // 的 Card，并预写 stages，避免初始化阶段消耗 fake Provider 或依赖外部模型。
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(
    join(cardsDir, "angelkawaii.md"),
    readFileSync(join(process.cwd(), "src-tauri/resources/defaults/personality/cards/angelkawaii.md"), "utf8"),
    "utf8",
  )
  await initCards()
  const card = getCard("angelkawaii")
  if (!card) throw new Error("主动表达夹具 Card 未从临时数据根加载")
  await updateStagesFile(card.id, {
    stages: {
      cardId: card.id,
      cardVersion: card.version,
      sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(),
      isFallback: false,
      stages: FALLBACK_STAGES,
    },
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  // 与其他真实 Harness L3 场景保持同一条宿主启动与隔离路径：Card/registry、会话与运行槽
  // 必须在临时数据根就绪后初始化，否则 captureProactiveOwner 无法取得有效 owner。
  await standardSetup()
})

afterEach(() => {
  restoreFakeProvider?.()
  restoreFakeProvider = undefined
})

describe("主动消息来源", () => {
  it("主动意图经无工具单次生成提交，原生助手 tip 可核实且输入不成为用户事实 [proactive-expression-commit]", async () => {
    const provider = installFakeProvider([fakeText("主动消息已处理")])
    restoreFakeProvider = provider.restore
    const result = await runActiveTurn(ACTIVE_TEXT)

    expect(result.status, "主动表达未返回已提交回执").toBe("committed")
    if (result.status !== "committed") return
    const entries = await sessionEntries()
    const active = entries.find(entry => entry.type === "message" && entry.message.role === "custom"
      && entry.message.customType === "deskpet.active_message")
    expect(active, "主动消息没有落成 deskpet.active_message 条目").toBeDefined()
    const details = (active as { message: { details?: Record<string, unknown> } }).message.details ?? {}
    expect(
      { querySource: details.querySource, eligibleForMemory: details.eligibleForMemory, taint: details.taint, visibleToUser: details.visibleToUser },
      `主动消息缺少 active 来源元数据: ${JSON.stringify(details)}`,
    ).toEqual({ querySource: "proactive", eligibleForMemory: false, taint: "derived", visibleToUser: false })

    const assistant = entries.find(entry => entry.type === "message" && entry.id === result.assistantEntryId)
    expect(assistant?.type === "message" && assistant.message.role === "assistant" && assistant.message.stopReason !== "error",
      "receipt 指向的 entry 不是已完成的 native assistant tip").toBe(true)
    const proof = await readActiveAttemptEvidence(getActiveSessionId(), result.attemptId, result.requestId)
    expect(proof && { operationId: proof.operationId, triggerEntryId: proof.triggerEntryId, assistantEntryId: proof.assistantEntryId },
      "原生 operation/result 没有证明这条主动请求提交到同一个 assistant tip").toEqual(result.evidence)
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult").length,
      "主动表达不应运行工具").toBe(0)

    // 未安装 receipt reader 时即使 JSONL 已有助手条目，也不向会话读模型显示未确认主动结果。
    const messages = await sessionMessages()
    expect(messages.some(message => message.id === result.assistantEntryId || message.text === result.text),
      "没有注册回执 reader 时，这个已提交的主动 assistant entry/body 不应进入会话读模型").toBe(false)

    const unregisterReader = registerActiveReceiptReader(async (sessionId, attemptId, entryId) =>
      sessionId === getActiveSessionId() && attemptId === result.attemptId && entryId === result.assistantEntryId)
    try {
      const qualified = await sessionMessages()
      expect(qualified.some(message => message.id === result.assistantEntryId && message.text === result.text),
        "明确确认的同 attempt/entry 回执没有投影到会话读模型").toBe(true)
    } finally {
      unregisterReader()
    }
  })

  it("准入守卫拒绝时不调用 Provider，也不产生 assistant 提交 [proactive-admission-guard]", async () => {
    const provider = installFakeProvider([fakeText("这段正文不应被生成")])
    restoreFakeProvider = provider.restore
    await initChat()
    const before = await sessionEntries()
    const owner = await captureProactiveOwner()
    expect(owner, "守卫场景没有真实会话/Card owner").toBeDefined()
    const result = await runTestActiveExpression("被拒绝的主动表达意图", {
      beforeGenerate: async () => false,
    })
    expect(result.status, "准入拒绝不能报告为提交成功").not.toBe("committed")
    expect(provider.payloads.length, "准入守卫后仍调用了 Provider").toBe(0)
    const after = await sessionEntries()
    const newAssistants = after.filter(entry => !before.some(prior => prior.id === entry.id)
      && entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error")
    expect(newAssistants.length,
      `准入拒绝后存在 assistant 输出条目: ${newAssistants.map(entry => entry.id).join(",")}`,
    ).toBe(0)
  })

  it("合法静默保留空native tip证据，但作为skipped不进入UI或未回复计数 [proactive-silent-skip]", async () => {
    const provider = installFakeProvider([fakeText("<<SILENT>>")])
    restoreFakeProvider = provider.restore
    const unansweredBefore = unansweredCount.value
    const result = await runActiveTurn("纯符号，无需回应")

    expect(result.status, "合法沉默不能伪装成已送达表达").toBe("skipped")
    if (result.status !== "skipped") return
    expect(result.reason).toBe("silent")
    expect(result.evidence?.assistantEntryId, "silent skip要保留空tip地址以阻止重放").toBeTruthy()
    const entries = await sessionEntries()
    const active = entries.find(entry => entry.type === "message" && entry.message.role === "custom"
      && entry.message.customType === "deskpet.active_message")
    expect(active, "静默主动回合仍应保留来源审计条目").toBeDefined()
    const tip = entries.find(entry => entry.type === "message" && entry.id === result.evidence?.assistantEntryId)
    expect(tip?.type === "message" && tip.message.role === "assistant"
      && tip.message.content.filter(part => part.type === "text").every(part => part.text.trim() === ""),
    "receipt应精确指向原生空assistant tip").toBe(true)
    const projected = await sessionMessages()
    expect(projected.some(message => message.id === result.evidence?.assistantEntryId),
      "静默tip不得投影成空UI气泡").toBe(false)
    expect(unansweredCount.value, "静默skip不应增加主动未回复计数").toBe(unansweredBefore)
  })
})
