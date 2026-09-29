// ==========================================
// 阶段文案失效判定 —— 从 test/e2e/scenes/personality-card/阶段文案失效.scene.ts 迁到 L2
// ==========================================
//
// 判定键只有一个：`sourceHash` = SHA-256(角色设定 + "\n" + 语言风格)，
// 即 buildStagesPrompt 真正消费的两段输入（定义点 `stageSourceHash`）。
// `cardVersion` 只是落盘元数据，不参与 —— 它对「阶段文案是否还配得上这张卡」
// 没有信息量，参与判定只会让无关改动触发一次多余的 LLM 生成。
//
// 审视结论：照搬（`validateStagesForCard` 是纯函数，断言逐条读过产品实现，
// 都能被条件反转 / 常数替换 / 分支删除改红；夹具形态非法（缺段/键/空串）的断言
// 另有真实的产品分支对应）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { importUserCard } from "@/services/personality/loader"
import { COMMAND_KEYS, FALLBACK_STAGES, stageSourceHash, validateStagesForCard } from "@/services/personality/stages-cache"

/** 最小可解析 Card：只有角色设定与语言风格是阶段文案的生成输入 */
function cardMarkdown(id: string, role: string, style: string, extraSection: string): string {
  return `---
id: ${id}
name: 失效判定用
description: 阶段文案失效判定
version: 3
---

# 角色设定
${role}

# 语言风格
${style}
${extraSection}`
}

const ROLE = "你是测试用的助手，说话简短。"
const STYLE = "简短、直接。"

const BASE = cardMarkdown("e2e-staleness", ROLE, STYLE, "")
// 只改「行为进阶」与变量定义：生成输入没变，失效键就不该变
const OTHER_SECTIONS = cardMarkdown("e2e-staleness", ROLE, STYLE, `
# 行为进阶
- 用户着急时：先给结论

# 变量定义

## card

\`\`\`yaml
亲密:
  type: number
  initial: 0
  min: 0
  max: 10
  updateBy: llm
  reset: never
  description: 亲密度
\`\`\`
`)
const OTHER_ROLE = cardMarkdown("e2e-staleness", "你是另一张测试卡。", STYLE, "")
const OTHER_STYLE = cardMarkdown("e2e-staleness", ROLE, "热情、爱用语气词。", "")

let root = ""

beforeEach(() => {
  // 数据根只给 logger 的批量转发与 loader 的模块级 initCards 用；本用例的断言全在纯函数上
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-"))
  setTestDataRoot(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("阶段文案失效判定", () => {
  it("阶段文案按 sourceHash 判过期，version 不参与；缺后加段/键的旧文件也判过期 [card-stages-staleness]", async () => {
    const card = await importUserCard(BASE)
    const hash = await stageSourceHash(card)
    // 空 hash 会让缓存永远判过期，必须单独钉住
    expect(hash).toBeTruthy()

    const data = {
      cardId: card.id, cardVersion: card.version, sourceHash: hash,
      generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
    }
    expect(validateStagesForCard(data, card.id, hash)).toBe(true)

    // ① version 不参与判定：Card 升版不该让所有 Card 重生成阶段文案
    expect(validateStagesForCard({ ...data, cardVersion: card.version + 97 }, card.id, hash)).toBe(true)

    // ② sourceHash 变化即过期：生成输入改了，旧文案必须重生成
    expect(validateStagesForCard({ ...data, sourceHash: `${hash}-changed` }, card.id, hash)).toBe(false)
    expect(validateStagesForCard(data, card.id, `${hash}-changed`)).toBe(false)

    // ③ 归属：别的 Card 的缓存不能被当成自己的
    expect(validateStagesForCard(data, "e2e-other-card", hash)).toBe(false)

    // ④ 形态非法（如旧文件缺 greetings）判过期，触发按新模板重生成
    const brokenStages = { ...FALLBACK_STAGES, greetings: [] as string[] }
    expect(validateStagesForCard({ ...data, stages: brokenStages }, card.id, hash)).toBe(false)

    // ④b 后加的段/键同样判过期 —— 这是新 key 唯一能被 Card 覆盖的机制：
    // 若旧文件被判有效，getCommandReply/getFallbackReply 会永远返回中性常量，界面看起来"正常"却没角色语气。
    const withoutCommands = { ...FALLBACK_STAGES } as Record<string, unknown>
    delete withoutCommands.commands
    expect(validateStagesForCard(
      { ...data, stages: withoutCommands as unknown as typeof FALLBACK_STAGES }, card.id, hash,
    )).toBe(false)
    // 旧模板产物：commands 整个键不存在（不是内容为空），同样必须判过期
    const emptyCommands = {
      ...FALLBACK_STAGES,
      commands: Object.fromEntries(COMMAND_KEYS.map(key => [key, ""])) as unknown as typeof FALLBACK_STAGES.commands,
    }
    expect(validateStagesForCard({ ...data, stages: emptyCommands }, card.id, hash)).toBe(false)
    // commands 缺后加的那个键（不是全空）也必须判过期
    const prunedCommands = {
      ...FALLBACK_STAGES,
      commands: Object.fromEntries(
        COMMAND_KEYS.filter(key => key !== "skillStarted").map(key => [key, FALLBACK_STAGES.commands[key]]),
      ) as unknown as typeof FALLBACK_STAGES.commands,
    }
    expect(validateStagesForCard({ ...data, stages: prunedCommands }, card.id, hash)).toBe(false)
    // fallbacks 缺后加的键（旧文件只有前 9 个）也必须判过期
    const legacyFallbacks = { ...FALLBACK_STAGES }
    const prunedFallbacks = Object.fromEntries(
      Object.entries(legacyFallbacks.fallbacks).filter(([key]) => key !== "runInterrupted"),
    ) as typeof FALLBACK_STAGES.fallbacks
    expect(validateStagesForCard({ ...data, stages: { ...legacyFallbacks, fallbacks: prunedFallbacks } }, card.id, hash)).toBe(false)

    // ⑤ 失效键与生成输入严格同源：只改非生成输入（行为进阶、变量定义）不变，
    // 改角色设定或语言风格必变
    expect(await stageSourceHash(await importUserCard(OTHER_SECTIONS))).toBe(hash)
    expect(await stageSourceHash(await importUserCard(OTHER_ROLE))).not.toBe(hash)
    expect(await stageSourceHash(await importUserCard(OTHER_STYLE))).not.toBe(hash)
  })
})
