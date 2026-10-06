// ==========================================
// 用户给角色起的名字 —— frontmatter nameVar 与说话人标签跟随
// ==========================================
//
// 设计（本体卡理想 trace 第 2 条）：名字由用户指定，进 Card 身份、不进用户记忆。
// 链路：Card 以 frontmatter nameVar 声明承载名字的变量 → registry.activeCardName
// 优先显示该变量值（起名 / 改名后跟随）；未起名（空串）返回空串交界面兜底
// （ChatPanel 显示「桌宠」），不回落到卡标签；未声明 nameVar 的 Card 行为不变。
//
// 层选 L2：本用例不触发 agent loop 与真实 Provider —— 两张探针卡的阶段文案按合法形态
// 与匹配 sourceHash 预先写入 stages/{cardId}.json，switchPersonality 走磁盘命中路径；
// 文件读写经 node-ipc 的 personality 域（与生产同一路径映射）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { loadCard } from "@/services/personality/loader"
import { activeCardName, switchPersonality } from "@/services/personality/registry"
import { FALLBACK_STAGES, clearStagesCache, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { batchWriteVars, destroyPool, savePoolToDiskStrict } from "@/services/personality/variable-pool"

/** 声明 nameVar 的探针卡：名字变量初始为空，由用户起名写入 */
const NAMED_CARD = `---
id: probe-named
name: 探针卡
nameVar: 名字
description: 起名用例
version: 1
---

# 角色设定
你是探针角色，还没有名字。

# 语言风格
简短。

# 输出规则
只输出对话。

# 行为进阶
- 默认：简短

# 必须遵守
1. 不编造

# 变量定义

## card

\`\`\`yaml
名字:
  type: string
  initial: ""
  updateBy: llm
  reset: never
  description: 用户给角色起的名字
\`\`\`
`

/** 未声明 nameVar 的探针卡：说话人标签必须仍是卡标签 */
const PLAIN_CARD = `---
id: probe-plain
name: 普通卡
description: 无 nameVar 对照
version: 1
---

# 角色设定
你是普通角色。

# 语言风格
简短。

# 输出规则
只输出对话。

# 行为进阶
- 默认：简短

# 必须遵守
1. 不编造
`

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-"))
  setTestDataRoot(root)
  destroyPool()
  mkdirSync(join(root, "personality", "cards"), { recursive: true })
  writeFileSync(join(root, "personality", "cards", "probe-named.md"), NAMED_CARD)
  writeFileSync(join(root, "personality", "cards", "probe-plain.md"), PLAIN_CARD)
  // 阶段文案预先落盘：sourceHash 由卡正文现算，命中后 switchPersonality 不触发生成调用
  for (const id of ["probe-named", "probe-plain"]) {
    const card = await loadCard(id)
    if (!card) throw new Error(`夹具卡 ${id} 未从临时数据根读取`)
    await updateStagesFile(id, {
      stages: {
        cardId: id, cardVersion: 1, sourceHash: await stageSourceHash(card),
        generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
      },
    })
  }
})

afterEach(() => {
  destroyPool()
  clearStagesCache()
  rmSync(root, { recursive: true, force: true })
})

describe("用户给角色起的名字", () => {
  it("说话人标签跟随起名 / 改名，未起名与未声明各回各的兜底 [card-name-display]", async () => {
    expect((await switchPersonality("probe-named")).ok).toBe(true)
    // 声明了 nameVar 但用户还没起名：空串交界面兜底，绝不回落到卡标签「探针卡」
    expect(activeCardName.value).toBe("")

    // 起名（生产同路径：回复的 RUNTIME_DATA → batchWriteVars → 严格落盘）
    expect(batchWriteVars({ 名字: "小雪" }).written).toEqual(["名字"])
    expect(activeCardName.value).toBe("小雪")
    await savePoolToDiskStrict()

    // 改名跟随
    expect(batchWriteVars({ 名字: "小雪酱" }).written).toEqual(["名字"])
    expect(activeCardName.value).toBe("小雪酱")
    await savePoolToDiskStrict()

    // 未声明 nameVar 的 Card 仍显示卡标签 —— 新分支不改旧语义
    expect((await switchPersonality("probe-plain")).ok).toBe(true)
    expect(activeCardName.value).toBe("普通卡")

    // 起名是 Card 身份：切走再切回，名字随卡恢复（不是会话态，也不经用户记忆）
    expect((await switchPersonality("probe-named")).ok).toBe(true)
    expect(activeCardName.value).toBe("小雪酱")
  })
})
