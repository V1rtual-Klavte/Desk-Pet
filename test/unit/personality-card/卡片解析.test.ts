// ==========================================
// 卡片解析 —— 从 test/e2e/scenes/personality-card/卡片解析.scene.ts 迁到 L2
// ==========================================
//
// `importUserCard(raw)` 是唯一不经过 Tauri 的 Card 解析入口（其余加载路径都要
// `personality_file_list/read`），所以解析类断言全部走它，喂 inline markdown 即可。
//
// 审视结论（契约「审计线索」personality-card 行）：
//   · 原 `source !== "runtime"` 子句**删除**（D1）：parseCard 写死 `source: "runtime"`，
//     类型上也只有这一个取值，任何输入都为真；
//   · 原 `languageStyle.includes("简短")` 改为整段相等（D6）：CARD_MD 的「角色设定」段
//     同样含「简短」，把语言风格段错解析成角色设定段的实现照样通过；
//   · 原 `card-active-prompt`（pc-07）**删除**：`getSystemPrompt()` 是 window 调试入口
//     （无生产消费者），实现即 `return card?.sections.roleSetting`，断言拿同一字段与自己比。
//     生产 system prompt 由 context/builder 从 sections 组装角色设定，不经过它。
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { importUserCard } from "@/services/personality/loader"
import { getActiveCard, getActivePersonalityId, switchPersonality } from "@/services/personality/registry"
import { destroyPool, getPoolSnapshot, initVariablePool } from "@/services/personality/variable-pool"
import type { CardVariableDef } from "@/services/personality/types"

/** 一份最小但结构完整的 Card：frontmatter + 六个区块 + 两组变量定义 */
const CARD_MD = `---
id: e2e-card
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
  proactiveBands: [0, 5]
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

let root = ""

beforeEach(() => {
  // 数据根只给 logger 的批量转发用；
  // 解析类断言本身不落盘（importUserCard 是纯解析入口）
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-"))
  setTestDataRoot(root)
  destroyPool()
})

afterEach(() => {
  destroyPool()
  rmSync(root, { recursive: true, force: true })
})

describe("卡片解析", () => {
  it("importUserCard 解析 markdown 为 Card [card-parse]", async () => {
    const card = await importUserCard(CARD_MD)

    expect(card.id).toBe("e2e-card")
    expect(card.name).toBe("测试卡")
    expect(card.version).toBe(3)

    // 三个区块整段比对：子串匹配会把「把某一区块错解析成另一区块」的实现放行
    expect(card.sections.roleSetting).toBe("你是测试用的助手，说话简短。")
    expect(card.sections.languageStyle).toBe("简短、直接。")
    expect(card.sections.outputRules).toBe("不要输出多余的解释。")

    // hash 是运行时的卡身份键（判断冻结的 Card 是否已换）：只判非空时「返回常量」的实现
    // 照样绿，所以补内容相关性 —— 同正文必须同 hash，换正文必须换 hash
    expect(card.hash).toBeTruthy()
    expect((await importUserCard(CARD_MD)).hash).toBe(card.hash)
    expect((await importUserCard(CARD_MD.replace("id: e2e-card", "id: e2e-card-2"))).hash)
      .not.toBe(card.hash)
  })

  it("Card nameVar 声明解析 [card-name-var]", async () => {
    // 名字由用户起的 Card 用 frontmatter nameVar 声明承载名字的变量；
    // 解析落字段是显示链路（名字跟随.test.ts）的前提
    const card = await importUserCard(CARD_MD.replace("version: 3", "version: 3\nnameVar: 名字"))
    expect(card.nameVar).toBe("名字")
  })

  it("Card variableDefs 解析 [card-variable-defs]", async () => {
    const defs = (await importUserCard(CARD_MD)).sections.variableDefs

    // 段序与名字集合：漏掉一个段落就少一个变量
    expect(defs.map(def => def.name)).toEqual(["亲密", "unansweredCount"])

    const card = defs.find(def => def.name === "亲密")
    // scope 必须区分 card 与 interaction：只有 card 变量允许 LLM 写
    expect(card).toMatchObject({
      scope: "card", type: "number", initial: 0, min: 0, max: 10,
      updateBy: "llm", reset: "never", description: "亲密度",
    })
    // 行内数组必须按元素类型解析：档位以字符串数组（["0","5"]）进来时，buildVarDef 的
    // `typeof value === "number"` 守卫会丢掉整个声明，proactive/scanner 的跨档链路随之不可达
    expect(card?.proactiveBands).toEqual([0, 5])

    const interaction = defs.find(def => def.name === "unansweredCount")
    expect(interaction).toMatchObject({
      scope: "interaction", type: "number", initial: 0, min: 0,
      updateBy: "system", reset: "never", description: "未回复数",
    })

    // 守卫仍必须拒绝非法档位（是解析元素类型，不是把守卫放宽成「字符串也认」）：
    // 显式引号在 YAML 语义里是字符串，收回它等于让类型错误静默通过
    const rejected: Array<[string, string]> = [
      ["元素不是数字", "proactiveBands: [0, 低]"],
      ["显式引号是字符串", 'proactiveBands: ["0", 5]'],
      ["档位必须严格递增", "proactiveBands: [0, 5, 3]"],
      ["首档必须等于 min", "proactiveBands: [1, 5]"],
    ]
    for (const [label, declaration] of rejected) {
      const invalid = await importUserCard(CARD_MD.replace("proactiveBands: [0, 5]", declaration))
      const invalidDef = invalid.sections.variableDefs.find(def => def.name === "亲密")
      expect(invalidDef, `非法声明不得丢掉变量本身：${label}`).toBeDefined()
      expect(invalidDef?.proactiveBands, `非法档位未被拒绝：${label}`).toBeUndefined()
    }
  })

  it("默认卡的数值档位活着进入 defs", async () => {
    // 真卡回归：默认卡的 proactiveBands 必须以数字数组落在 defs 上，
    // 字符串数组会被守卫丢掉（「已提交变量跨档 → 主动回应」链路整体不可达）
    const raw = readFileSync(join(process.cwd(), "resources/defaults/personality/cards/default.md"), "utf8")
    const def = (await importUserCard(raw)).sections.variableDefs.find(item => item.name === "好感度")
    expect(def?.proactiveBands).toEqual([0, 10, 30, 60, 85])
  })

  it("Card whenText 保留语气原文 [card-when-text]", async () => {
    const { whenText } = (await importUserCard(CARD_MD)).sections

    // whenText 是自然语言语气指引，**不是**可执行的条件 DSL，所以断言的是「原文被完整保留」，
    // 不是「被解析成规则数组」—— 整段相等才能把「解析成结构 / 截断」的实现判红
    expect(whenText).toBe("- 用户着急时：先给结论\n- 默认：保持简短")
  })

  it("注册表拒绝非法人格切换 [card-registry-guard]", async () => {
    const before = getActivePersonalityId()
    const cardBefore = getActiveCard()?.id ?? null

    // 关闭人格不被允许（系统始终要有 Card）
    const nullResult = await switchPersonality(null)
    expect(nullResult.ok).toBe(false)
    expect(nullResult.error).toBeTruthy()

    // 不存在的人格不能改动 activeId —— 拒绝必须是原子的。
    // L2 没有 bootstrap，before 恒为 null，所以这条能抓的是「失败的切换把 activeId 写成了目标」
    // 这类部分应用；「切换失败后保住原有激活卡」的形态由 L3 的 card-switch-failure-rollback 覆盖
    const missing = await switchPersonality("e2e-不存在的卡")
    expect(missing.ok).toBe(false)
    expect(missing.error).toBeTruthy()
    expect(getActivePersonalityId()).toBe(before)
    // 失败不得留下部分应用：原来没有激活卡，失败后也不能有
    expect(getActiveCard()?.id ?? null).toBe(cardBefore)
  })

  it("换一套 defs 后旧变量消失 [card-switch-resets-pool]", () => {
    const FIRST: CardVariableDef[] = [
      { scope: "card", name: "只属于A", type: "number", initial: 1, description: "", updateBy: "llm", min: 0, max: 9, reset: "never" },
    ]
    const SECOND: CardVariableDef[] = [
      { scope: "card", name: "只属于B", type: "string", initial: "x", description: "", updateBy: "llm", enum: ["x", "y"], reset: "never" },
    ]

    destroyPool()
    initVariablePool({ cardId: "card-a", variableDefs: FIRST })
    expect("只属于A" in getPoolSnapshot().card).toBe(true)

    // 再用第二套 defs 重建：旧变量自然消失，新变量按其 def 初始化
    initVariablePool({ cardId: "card-b", variableDefs: SECOND })
    const pool = getPoolSnapshot()
    expect("只属于A" in pool.card).toBe(false)
    expect(pool.card["只属于B"]?.value).toBe("x")
    // 系统变量里的 activeCardId 必须跟着换，否则 prompt 会报错的人设
    expect(pool.system.activeCardId).toBe("card-b")
  })
})
