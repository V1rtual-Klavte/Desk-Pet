import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Context, FauxResponseStep } from "@earendil-works/pi-ai"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { entryMessageText, sessionEntries } from "../../host/session-entries"
import { MemoryService } from "@/services/agent/memory"
import { flushConfig, humanizerConfig, memoryConfig, planConfig, setOverrides } from "@/services/config"
import { runPiAgentTurn } from "@/services/engine/harness"
import { resetAgentRuntimeForTest } from "@/services/agent/runner"
import { userInputMessage } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"
import { getCard, initCards } from "@/services/personality/loader"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { destroyPool, getPoolSnapshot } from "@/services/personality/variable-pool"
import { switchPersonality } from "@/services/personality/registry"
import { getActiveSessionId, initSessions, messagesFromEntries } from "@/services/session"

const CARD_ID = "humanizer-runtime-fixture"
const VARIABLE = "状态"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/NuoAAAAASUVORK5CYII=", "base64")

function cardMarkdown(): string {
  return [
    "---", `id: ${CARD_ID}`, `name: ${CARD_ID}`, "description: 拟人运行时夹具", "version: 1", "---", "",
    "# 角色设定", "你是一个测试角色。", "", "# 语言风格", "简短自然。", "", "# 输出规则", "直接回应。", "",
    "# 变量定义", "", "## card", "", "```yaml", `${VARIABLE}:`, "  type: string", "  initial: 初始", "  updateBy: llm",
    "  reset: never", "  description: 测试变量", "```", "",
  ].join("\n")
}

let root = ""
let originalConfig = { humanizer: true, plan: true, memory: true }
let restoreProvider: (() => void) | undefined

beforeAll(async () => {
  originalConfig = { humanizer: humanizerConfig.enabled, plan: planConfig.enabled, memory: memoryConfig.enabled }
  const testTempRoot = join(process.cwd(), "test", ".tmp")
  mkdirSync(testTempRoot, { recursive: true })
  root = mkdtempSync(join(testTempRoot, "humanizer-runtime-"))
  setTestDataRoot(root)
  await initPaths()
  mkdirSync(join(root, "personality", "cards"), { recursive: true })
  writeFileSync(join(root, "personality", "cards", `${CARD_ID}.md`), cardMarkdown(), "utf8")
  setOverrides({ "ai.humanizer.enabled": true, "ai.plan.enabled": false, "ai.memory.enabled": false })
  await flushConfig()
  await initCards()
  const card = getCard(CARD_ID)
  if (!card) throw new Error("拟人运行时夹具卡未加载")
  await updateStagesFile(card.id, { stages: {
    cardId: card.id, cardVersion: card.version, sourceHash: await stageSourceHash(card),
    generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
  } })
  const switched = await switchPersonality(CARD_ID)
  if (!switched.ok) throw new Error(`拟人运行时夹具卡激活失败: ${switched.error ?? "unknown"}`)
  await MemoryService.init()
  await initSessions()
})

afterAll(async () => {
  restoreProvider?.()
  destroyPool()
  setOverrides({ "ai.humanizer.enabled": originalConfig.humanizer, "ai.plan.enabled": originalConfig.plan,
    "ai.memory.enabled": originalConfig.memory })
  await flushConfig()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("拟人表达原生提交", () => {
  it("配对 RUNTIME_DATA、提交多泡与沉默，并只在请求投影加载图片 [humanizer-native-commit-projection]", async () => {
    const imagePath = join(root, "fixture.png")
    const taskPath = join(root, "task.txt")
    writeFileSync(imagePath, PNG)
    writeFileSync(taskPath, "task tool fixture\n", "utf8")
    let imageSeen = false
    let emptyAssistantSeen = false
    const imageReply: FauxResponseStep = (context: Context) => {
      emptyAssistantSeen = context.messages.some(message => message.role === "assistant"
        && !message.content.some(part => part.type === "toolCall" || (part.type === "text" && part.text.trim())))
      const image = context.messages.flatMap(message => message.role === "user" && Array.isArray(message.content) ? message.content : [])
        .find(part => part.type === "image")
      imageSeen = image?.type === "image" && Buffer.from(image.data, "base64").subarray(0, 8).equals(PNG.subarray(0, 8))
      return fakeText("图片请求完成")
    }
    const provider = installFakeProvider([
      fakeText(`第一泡\n<<SPLIT>>\n第二泡\n<RUNTIME_DATA>\n${VARIABLE}: 已写入\n</RUNTIME_DATA>`),
      fakeText("<<SILENT>>"), fakeText("<<SILENT>>"), imageReply,
      fakeToolCall("read", { path: taskPath }), fakeText("<<SILENT>>"),
    ])
    restoreProvider = provider.restore
    try {
      const sessionId = getActiveSessionId()
      const first = await runPiAgentTurn({ sessionId, userText: "请分两条回复并更新变量。",
        userPrompt: userInputMessage("请分两条回复并更新变量。", ""), unansweredCount: 0, isActiveMessage: false })
      expect(first.replyParts, "SPLIT 应拆成两个展示 part").toEqual(["第一泡", "第二泡"])
      expect(first.reply, "同条正文应来自最终 parts").toBe("第一泡\n第二泡")
      expect(first.runtimeData?.variables[VARIABLE], "原文留底应配对并解析变量").toBe("已写入")
      expect(getPoolSnapshot().card[VARIABLE]?.value, "RUNTIME_DATA 应写入当前 Card 变量池").toBe("已写入")

      const silence = await runPiAgentTurn({ sessionId, userText: "没有可回应内容。",
        userPrompt: userInputMessage("没有可回应内容。", ""), unansweredCount: 0, isActiveMessage: false })
      expect(silence.silent, "纯 SILENT 应提交合法空结果").toBe(true)
      expect(silence.committedAssistantEntryId, "空结果仍须绑定原生助手条目").toBeTruthy()

      // Rebuild the runtime from the same JSONL, losing process-local counters while keeping commits intact.
      await resetAgentRuntimeForTest()
      const repeatedSilence = await runPiAgentTurn({ sessionId, userText: "再次没有可回应内容。",
        userPrompt: userInputMessage("再次没有可回应内容。", ""), unansweredCount: 0, isActiveMessage: false })
      expect(repeatedSilence.silent, "从已提交助手元数据重建后，连续第二次沉默仍须被拒绝").not.toBe(true)
      expect(repeatedSilence.reply, "重启后的第二次沉默应改用 Card 短回复").toBe(FALLBACK_STAGES.fallbacks.silentRejected)

      const imageTurn = await runPiAgentTurn({ sessionId, userText: "请看这张图片。",
        userPrompt: userInputMessage("请看这张图片。", "image-event", undefined, [imagePath]),
        unansweredCount: 0, isActiveMessage: false })
      expect(imageTurn.failure, "图片请求回合不应失败").toBeUndefined()
      expect(imageSeen, "Provider 请求应收到临时加载的 PNG image part").toBe(true)
      expect(emptyAssistantSeen, "空沉默条目不应进入后续 Provider 上下文").toBe(false)

      const entries = await sessionEntries(sessionId)
      const assistantEntries = entries.filter((entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "assistant")
      const splitEntry = assistantEntries.find(entry => entry.id === first.committedAssistantEntryId)
      expect(splitEntry?.type === "message" && splitEntry.message.role === "assistant" ? splitEntry.message.content.filter(part => part.type === "text").map(part => part.text) : [],
        "JSONL 中的多泡必须与运行期 parts 同形").toEqual(["第一泡", "第二泡"])
      const silentEntry = assistantEntries.find(entry => entry.id === silence.committedAssistantEntryId)
      expect(silentEntry?.type === "message" && silentEntry.message.role === "assistant" ? silentEntry.message.content.filter(part => part.type === "text") : [],
        "沉默条目应保持空可见正文").toEqual([])
      const silentMetadata = silentEntry?.type === "message"
        ? silentEntry.message as unknown as { deskpetSilent?: boolean } : undefined
      expect(silentMetadata?.deskpetSilent,
        "空条目需保留可核验沉默语义").toBe(true)
      expect((await messagesFromEntries(entries, sessionId)).some(message => message.eventId === silence.committedAssistantEntryId),
        "会话重读不得显示空白沉默气泡").toBe(false)

      const userImageEntry = entries.find(entry => entry.type === "message" && entry.message.role === "user"
        && (entry.message as { deskpetImagePaths?: string[] }).deskpetImagePaths?.includes(imagePath))
      expect(userImageEntry?.type === "message" ? (userImageEntry.message as { deskpetImagePaths?: string[] }).deskpetImagePaths : undefined,
        "持久用户条目只应携带图片路径").toEqual([imagePath])
      expect(userImageEntry?.type === "message" ? JSON.stringify(userImageEntry.message).includes(PNG.toString("base64")) : false,
        "图片 base64 不得进入会话 JSONL").toBe(false)
      expect(entryMessageText(userImageEntry?.type === "message" && userImageEntry.message.role === "user" ? userImageEntry.message : { content: "" }),
        "图片路径元数据不应污染用户文本").toBe("请看这张图片。")

      const taskTurn = await runPiAgentTurn({ sessionId, userText: "读取 task.txt 并总结。",
        userPrompt: userInputMessage("读取 task.txt 并总结。", ""), unansweredCount: 0, isActiveMessage: false })
      expect(taskTurn.toolCallHistory.length, "task 分流应以真实工具执行记录为依据").toBeGreaterThan(0)
      expect(taskTurn.humanized, "有工具调用的 task 回合不应进入 casual 揭示调度").toBe(false)
      expect(taskTurn.silent, "task 回合不允许把 SILENT 当成合法沉默").not.toBe(true)
      expect(taskTurn.reply, "task SILENT 哨兵应退为当前 Card 的单泡短回复").toBe(FALLBACK_STAGES.fallbacks.silentRejected)
    } finally {
      provider.restore()
      restoreProvider = undefined
    }
  }, 60_000)
})
