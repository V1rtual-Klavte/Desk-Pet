import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { contentText } from "@earendil-works/pi-ai"
import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { ensureSession, runRuntimeTurn } from "../memory/回合夹具"
import { initPaths } from "@/services/paths"
import { flushConfig, setOverrides } from "@/services/config"
import { readPiSessionEntries } from "@/services/session/repo"
import { FALLBACK_STAGES, getActiveCard, initRegistry, loadCard, stageSourceHash, updateStagesFile } from "@/services/personality"
import { buildLocomoHistory, installLocomoAnswerPolicy } from "../../memory-bench/datasets/locomo/live-fixture"
import { formatLocomoQuestion, LOCOMO_ANSWER_FORMAT } from "../../memory-bench/datasets/locomo/fixture.mjs"

let root = ""

beforeAll(async () => {
  const artifacts = join(process.cwd(), "test/.tmp")
  mkdirSync(artifacts, { recursive: true })
  root = mkdtempSync(join(artifacts, "deskpet-locomo-wiring-"))
  setTestDataRoot(root)
  await initPaths()
  const cards = join(root, "personality/cards")
  mkdirSync(cards, { recursive: true })
  writeFileSync(join(cards, "default.md"), readFileSync("resources/defaults/personality/cards/default.md", "utf8"))
  const card = await loadCard("default")
  if (!card) throw new Error("fixture Card failed to load")
  await updateStagesFile(card.id, { stages: { cardId: card.id, cardVersion: card.version,
    sourceHash: await stageSourceHash(card), generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES } })
  setOverrides({ "ai.personality.active": "default", "ai.memory.enabled": false, "ai.plan.enabled": false })
  await flushConfig()
  await initRegistry()
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe("LoCoMo 真实 JSONL 与输出规则接线", () => {
  it("保存双方原话及图片说明，仅 A 侧登记事实来源，坐标可回读 [bench-locomo-live-jsonl]", async () => {
    const built = await buildLocomoHistory({ sampleId: "fixture", speakers: { a: "Nora", b: "Eli" }, sessions: [
      { session: 1, dateText: "1 May 2023", observedAt: 1682946000000, turns: [
        { speaker: "Nora", diaId: "D1:1", text: "Try this book." },
        { speaker: "Eli", diaId: "D1:2", text: "We painted this.", blipCaption: "A sunset and a palm tree" },
      ] },
      { session: 2, dateText: "2 May 2023", observedAt: 1683032400000, turns: [
        { speaker: "Nora", diaId: "D2:1", text: "It was a recommendation, not my own experience." },
      ] },
    ] }, 2000)
    expect(built.sources.map(source => source.sourceId)).toEqual(["fixture:D1:1", "fixture:D2:1"])
    expect(new Set(built.sources.map(source => source.sessionId)).size).toBe(2)
    const first = await readPiSessionEntries(built.sources[0].sessionId)
    const messages = first.filter(entry => entry.type === "message")
    expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant"])
    expect(messages.map(entry => contentText((entry.message as { content: Parameters<typeof contentText>[0] }).content))).toEqual([
      "speaker: Nora\nsession_date: 1 May 2023\nTry this book.",
      "speaker: Eli\nsession_date: 1 May 2023\nWe painted this.\n[shared image caption] A sunset and a palm tree",
    ])
    expect(messages.map(entry => entry.message.timestamp)).toEqual([1682946000000, 1682946001000])
    expect(messages[0].id).toBe(built.sources[0].entryId)
    expect(messages[0].seq).toBe(built.sources[0].seq)
    expect(built.sources[0].evidence).toBe("speaker: Nora\nsession_date: 1 May 2023\nTry this book.")
    expect(built.meta.get(`conversation:${built.sources[0].sessionId}:${messages[1].id}`))
      .toMatchObject({ diaId: "D1:2", role: "assistant", observedAt: 1682946001000 })
    await expect(buildLocomoHistory({ sampleId: "invalid", speakers: { a: "Nora", b: "Nora" }, sessions: [] }, 2000))
      .rejects.toThrow("invalid participant metadata")
  })

  it("短答规则进入真实主请求，收尾恢复活动卡和磁盘原文 [bench-locomo-live-answer-policy]", async () => {
    const original = getActiveCard()!
    expect(original, "fixture Card must be active").not.toBeNull()
    const provider = installFakeProvider([fakeText("No information available.")])
    const restore = await installLocomoAnswerPolicy()
    try {
      const sessionId = await ensureSession()
      const output = await runRuntimeTurn(formatLocomoQuestion("Which book did Nora recommend?"))
      expect(provider.payloads).toHaveLength(1)
      expect(provider.payloads[0].systemPrompt).toContain(LOCOMO_ANSWER_FORMAT.prompt)
      expect(lastRequestText(provider.payloads[0])).toBe("Answer using our conversation history:\nWhich book did Nora recommend?")
      expect(output.reply).toBe("No information available.")
      const entries = await readPiSessionEntries(sessionId)
      const messageEntries = entries.filter(entry => entry.type === "message")
      const last = messageEntries[messageEntries.length - 1]
      expect(last?.message.role).toBe("assistant")
      expect(last && contentText((last.message as { content: Parameters<typeof contentText>[0] }).content)).toBe("No information available.")
    } finally {
      await restore()
      provider.restore()
    }
    expect(getActiveCard()?.rawContent).toBe(original.rawContent)
    expect(readFileSync(join(root, "personality/cards/default.md"), "utf8")).toBe(original.rawContent)
  })
})
