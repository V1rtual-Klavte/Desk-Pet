import type { SceneDef } from "../../types"
import { importUserCard } from "@/services/personality/loader"
import { COMMAND_KEYS, FALLBACK_STAGES, stageSourceHash, validateStagesForCard } from "@/services/personality/stages-cache"

/**
 * 阶段文案的失效判定。
 *
 * 判定键只有一个：`sourceHash` = SHA-256(角色设定 + "\n" + 语言风格)，
 * 即 buildStagesPrompt 真正消费的两段输入（定义点 `stageSourceHash`）。
 * `cardVersion` 只是落盘元数据，不参与 —— 它对「阶段文案是否还配得上这张卡」
 * 没有信息量，参与判定只会让无关改动触发一次多余的 LLM 生成。
 */

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

const BASE = cardMarkdown("live-test-staleness", ROLE, STYLE, "")
// 只改「行为进阶」与变量定义：生成输入没变，失效键就不该变
const OTHER_SECTIONS = cardMarkdown("live-test-staleness", ROLE, STYLE, `
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
const OTHER_ROLE = cardMarkdown("live-test-staleness", "你是另一张测试卡。", STYLE, "")
const OTHER_STYLE = cardMarkdown("live-test-staleness", ROLE, "热情、爱用语气词。", "")

const scene: SceneDef = {
  meta: {
    caseId: "card-stages-staleness",
    module: "personality-card",
    contractId: "pc-10",
    description: "阶段文案按 sourceHash 判过期，version 不参与；缺后加段/键的旧文件也判过期",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["personality-card", "boundary", "stages"],
  },
  turns: [{
    index: 1,
    description: "判定键只认 sourceHash 与 cardId 归属，且后加的段/键缺失判过期",
    userText: "检查阶段文案失效判定。",
    checks: [{ type: "expectStagesStaleness", run: async () => {
      const card = await importUserCard(BASE)
      const hash = await stageSourceHash(card)
      if (!hash) throw new Error("sourceHash 为空，缓存会永远判过期")

      const data = {
        cardId: card.id, cardVersion: card.version, sourceHash: hash,
        generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
      }
      if (!validateStagesForCard(data, card.id, hash)) throw new Error("匹配的缓存被判过期")

      // ① version 不参与判定：Card 升版不该让所有 Card 重生成阶段文案
      if (!validateStagesForCard({ ...data, cardVersion: card.version + 97 }, card.id, hash)) {
        throw new Error("cardVersion 变化被判过期")
      }

      // ② sourceHash 变化即过期：生成输入改了，旧文案必须重生成
      if (validateStagesForCard({ ...data, sourceHash: `${hash}-changed` }, card.id, hash)) {
        throw new Error("sourceHash 变化没有被判过期")
      }
      if (validateStagesForCard(data, card.id, `${hash}-changed`)) {
        throw new Error("当前输入算出的 hash 变化没有被判过期")
      }

      // ③ 归属：别的 Card 的缓存不能被当成自己的
      if (validateStagesForCard(data, "live-test-other-card", hash)) {
        throw new Error("换了 cardId 仍判有效")
      }

      // ④ 形态非法（如旧文件缺 greetings）判过期，触发按新模板重生成
      const brokenStages = { ...FALLBACK_STAGES, greetings: [] as string[] }
      if (validateStagesForCard({ ...data, stages: brokenStages }, card.id, hash)) {
        throw new Error("缺 greetings 的旧缓存被判有效")
      }

      // ④b 后加的段/键同样判过期 —— 这是新 key 唯一能被 Card 覆盖的机制：
      // 若旧文件被判有效，getCommandReply/getFallbackReply 会永远返回中性常量，界面看起来"正常"却没角色语气。
      const withoutCommands = { ...FALLBACK_STAGES } as Record<string, unknown>
      delete withoutCommands.commands
      if (validateStagesForCard({ ...data, stages: withoutCommands as unknown as typeof FALLBACK_STAGES }, card.id, hash)) {
        throw new Error("缺 commands 段的旧缓存被判有效")
      }
      // 旧模板产物：commands 整个键不存在（不是内容为空），同样必须判过期
      const emptyCommands = {
        ...FALLBACK_STAGES,
        commands: Object.fromEntries(COMMAND_KEYS.map(key => [key, ""])) as unknown as typeof FALLBACK_STAGES.commands,
      }
      if (validateStagesForCard({ ...data, stages: emptyCommands }, card.id, hash)) {
        throw new Error("commands 全为空串的旧缓存被判有效")
      }
      // fallbacks 缺后加的键（旧文件只有前 9 个）也必须判过期
      const legacyFallbacks = { ...FALLBACK_STAGES }
      const prunedFallbacks = Object.fromEntries(
        Object.entries(legacyFallbacks.fallbacks).filter(([key]) => key !== "runInterrupted"),
      ) as typeof FALLBACK_STAGES.fallbacks
      if (validateStagesForCard({ ...data, stages: { ...legacyFallbacks, fallbacks: prunedFallbacks } }, card.id, hash)) {
        throw new Error("fallbacks 缺新增键的旧缓存被判有效")
      }

      // ⑤ 失效键与生成输入严格同源：只改非生成输入（行为进阶、变量定义）不变，
      // 改角色设定或语言风格必变
      if (await stageSourceHash(await importUserCard(OTHER_SECTIONS)) !== hash) {
        throw new Error("无关改动（行为进阶/变量定义）改变了失效键")
      }
      if (await stageSourceHash(await importUserCard(OTHER_ROLE)) === hash) {
        throw new Error("角色设定变化没有改变失效键")
      }
      if (await stageSourceHash(await importUserCard(OTHER_STYLE)) === hash) {
        throw new Error("语言风格变化没有改变失效键")
      }
    } }],
  }],
}

export default scene
