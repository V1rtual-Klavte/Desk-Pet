import type { SceneDef } from "../../types"
import { importUserCard } from "@/services/personality/loader"
import { getActiveCard, getActivePersonalityId, getSystemPrompt, switchPersonality } from "@/services/personality/registry"
import { destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"
import type { CardVariableDef } from "@/services/personality/types"

/**
 * Card 的解析与注册表语义。
 *
 * `importUserCard(raw)` 是唯一不经过 Tauri 的 Card 解析入口（其余加载路径都要
 * `personality_file_list/read`），所以解析类断言全部走它，喂 inline markdown 即可。
 */
const unit = (
  caseId: string,
  contractId: string,
  description: string,
  run: () => Promise<void> | void,
  depth: "shallow" | "deep" = "shallow",
): SceneDef => ({
  meta: {
    caseId,
    module: "personality-card",
    contractId,
    description,
    depth,
    suite: "capability",
    entry: "unit",
    tags: ["personality-card", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查人格 Card。",
    checks: [{ type: "expectPersonalityCard", run: async () => run() }],
  }],
})

/** 一份最小但结构完整的 Card：frontmatter + 六个区块 + 两组变量定义 */
const CARD_MD = `---
id: live-test-card
name: 测试卡
description: 解析用
version: 3
---

# 角色设定
你是测试用的助手，说话简短。

# 语言风格
简短、直接。

# 输出规则
不要输出多余的解释。

# 行为进阶
- 用户着急时：先给结论
- 默认：保持简短

# 必须遵守
1. 不编造细节

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

## interaction

\`\`\`yaml
unansweredCount:
  type: number
  initial: 0
  min: 0
  updateBy: system
  reset: never
  description: 未回复数
\`\`\`
`

export const 卡片解析 = unit("card-parse", "pc-01", "importUserCard 解析 markdown 为 Card", async () => {
  const card = await importUserCard(CARD_MD)

  if (card.id !== "live-test-card") throw new Error(`id 未解析: ${card.id}`)
  if (card.name !== "测试卡") throw new Error(`name 未解析: ${card.name}`)
  if (card.version !== 3) throw new Error(`version 未解析: ${card.version}`)
  // 来源只有 runtime 一种：默认资源在首次启动就被复制成运行时可编辑文件
  if (card.source !== "runtime") throw new Error(`source 应为 runtime，实际 ${card.source}`)

  const { sections } = card
  if (!sections.roleSetting.includes("测试用的助手")) throw new Error("角色设定未解析")
  if (!sections.languageStyle.includes("简短")) throw new Error("语言风格未解析")
  if (!sections.outputRules.includes("多余的解释")) throw new Error("输出规则未解析")
  // hash 用来判断是否需要重新生成 stages，空值会让缓存永远失效
  if (!card.hash) throw new Error("hash 为空")
})

export const 卡片变量定义 = unit("card-variable-defs", "pc-03", "Card variableDefs 解析", async () => {
  const defs = (await importUserCard(CARD_MD)).sections.variableDefs

  const card = defs.find(d => d.name === "亲密")
  if (!card) throw new Error("card 段变量未解析")
  // scope 必须区分 card 与 interaction：只有 card 变量允许 LLM 写
  if (card.scope !== "card") throw new Error(`scope 不对: ${card.scope}`)
  if (card.type !== "number" || card.initial !== 0) throw new Error(`类型/初值不对: ${JSON.stringify(card)}`)
  if (card.min !== 0 || card.max !== 10) throw new Error(`范围未解析: ${card.min}..${card.max}`)
  if (card.updateBy !== "llm") throw new Error(`updateBy 不对: ${card.updateBy}`)

  const interaction = defs.find(d => d.name === "unansweredCount")
  if (interaction?.scope !== "interaction") throw new Error("interaction 段变量未解析")
  if (interaction.updateBy !== "system") throw new Error(`interaction 的 updateBy 不对: ${interaction.updateBy}`)
})

export const 卡片语气指引 = unit("card-when-text", "pc-04", "Card whenText 保留语气原文", async () => {
  const { whenText } = (await importUserCard(CARD_MD)).sections

  // whenText 是自然语言语气指引，**不是**可执行的条件 DSL，
  // 所以断言的是「原文被完整保留」，不是「被解析成规则数组」
  if (!whenText.includes("用户着急时")) throw new Error("行为进阶内容缺失")
  if (!whenText.includes("默认")) throw new Error("行为进阶未完整保留")
})

export const 注册表拒绝非法切换 = unit("card-registry-guard", "pc-02", "注册表拒绝非法人格切换", async () => {
  const before = getActivePersonalityId()

  // 关闭人格不被允许（系统始终要有 Card）
  const nullResult = await switchPersonality(null)
  if (nullResult.ok) throw new Error("switchPersonality(null) 被放行")
  if (!nullResult.error) throw new Error("拒绝时没有给出原因")

  // 不存在的人格不能改动 activeId —— 拒绝必须是原子的
  const missing = await switchPersonality("live-test-不存在的卡")
  if (missing.ok) throw new Error("切换到不存在的人格被放行")
  if (getActivePersonalityId() !== before) {
    throw new Error(`失败的切换改动了 activeId: ${before} -> ${getActivePersonalityId()}`)
  }
})

export const 激活卡驱动提示词 = unit("card-active-prompt", "pc-07", "激活 Card 驱动系统提示词", async () => {
  // 不断言「永不 null」：activeId 为空或 stages 不可用时 getActiveCard() 确实返回 null，
  // 那时系统降级运行。这里断言的是 bootstrap 之后的正常态接线。
  const card = getActiveCard()
  if (!card) throw new Error("bootstrap 之后没有激活的 Card")

  if (getActivePersonalityId() !== card.id) throw new Error("activeId 与激活 Card 不一致")

  const prompt = getSystemPrompt()
  const roleSetting = card.sections.roleSetting.trim()
  if (roleSetting && !prompt.includes(roleSetting.slice(0, 40))) {
    throw new Error(`系统提示词没有包含激活 Card 的角色设定（card=${card.id}）`)
  }

}, "deep")

export const 切卡重置变量池 = unit("card-switch-resets-pool", "pc-06", "换一套 defs 后旧变量消失", () => {
  const FIRST: CardVariableDef[] = [
    { scope: "card", name: "只属于A", type: "number", initial: 1, description: "", updateBy: "llm", min: 0, max: 9, reset: "never" },
  ]
  const SECOND: CardVariableDef[] = [
    { scope: "card", name: "只属于B", type: "string", initial: "x", description: "", updateBy: "llm", enum: ["x", "y"], reset: "never" },
  ]

  destroyPool()
  initVariablePool({ cardId: "card-a", variableDefs: FIRST })
  if (!("只属于A" in getPoolSnapshot().card)) throw new Error("第一张卡的变量未建立")

  // 再用第二套 defs 重建：旧变量自然消失，新变量按其 def 初始化
  initVariablePool({ cardId: "card-b", variableDefs: SECOND })
  const pool = getPoolSnapshot()
  if ("只属于A" in pool.card) throw new Error("切换后上一张卡的变量仍在池里")
  if (pool.card["只属于B"]?.value !== "x") throw new Error("新卡的变量未按 def 初始化")
  // 系统变量里的 activeCardId 必须跟着换，否则 prompt 会报错的人设
  if (pool.system.activeCardId !== "card-b") throw new Error(`activeCardId 未更新: ${pool.system.activeCardId}`)
}, "deep")
