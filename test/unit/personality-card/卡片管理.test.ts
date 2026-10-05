// ==========================================
// Card 管理 —— 新建 / 重命名 / 编辑保存 / 删除 / 导入导出（L2）
// ==========================================
//
// 选层 L2：全部行为只经宿主文件命令（node-ipc 的 personality 域）与内存注册表，
// 不触 agent loop / Provider / 原生宿主。落盘断言直接读临时数据根里的真实文件，
// 能抓住「回执报成功但磁盘没变」这类假通过。
//
// 删除走 L2 适配层的 `personality_file_delete`（node-ipc 已登记该命令，与其它人格文件命令同口径）；
// Rust 侧的叶子符号链接拒绝与路径边界裁决属于安全策略，只在 L4 验证。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { installNodeHostBridge } from "../../host/install-node-bridge"
import { getCard, getCards, importUserCard, initCards } from "@/services/personality/loader"
import { getActivePersonalityId, initRegistry, switchPersonality } from "@/services/personality/registry"
import { FALLBACK_STAGES, clearStagesCache, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { destroyPool } from "@/services/personality/variable-pool"
import {
  createCard, deleteCard, exportCardText, importCardText, readCardTemplate, renameCard, saveCardText,
} from "@/services/personality/card-manage"

/** 新建用的真实骨架 = 随仓资源里的模板原文；运行时副本由夹具写进临时数据根 */
const REPO_TEMPLATE = readFileSync(
  join(process.cwd(), "resources/defaults/personality/cards/_template.md"),
  "utf8",
)

/**
 * 结构完整的探针卡。doomed 的正文故意混入一条以 `name:` 开头的行：
 * 重命名/保存只许动 frontmatter 内的 name，正文里的同名行被改到就应判红。
 */
function cardMarkdown(id: string, name: string, marker: string): string {
  return `---
id: ${id}
name: ${name}
description: 管理用例
version: 1
---

# 角色设定
你是${marker}。

# 语言风格
简短。

# 输出规则
name: 正文里的同名行不许被改
只输出对话。

# 行为进阶
- 默认：简短

# 必须遵守
1. 不编造
`
}

let root = ""

function cardsDir(): string { return join(root, "personality", "cards") }
function cardFilePath(fileName: string): string { return join(cardsDir(), fileName) }
function stagesFilePath(fileName: string): string { return join(root, "personality", "stages", fileName) }
/** 读回磁盘上的卡文件原文（断言落盘事实，不读内存注册表） */
function readCardFile(fileName: string): string { return readFileSync(cardFilePath(fileName), "utf8") }
function currentIds(): string[] { return getCards().map(card => card.id) }
/** frontmatter 之后的正文；用于断言「除 frontmatter 外一字未动」 */
function cardBody(raw: string): string { return raw.slice(raw.indexOf("\n---\n") + 5) }

/** 真的激活一张卡（走产品同路：先落阶段文案，再 switchPersonality）；失败即测试前置失败 */
async function activate(cardId: string): Promise<void> {
  const card = getCard(cardId)!
  await updateStagesFile(cardId, {
    stages: {
      cardId, cardVersion: card.version, sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(), isFallback: false, stages: FALLBACK_STAGES,
    },
  })
  const result = await switchPersonality(cardId)
  expect(result.ok, `激活 ${cardId} 的前置失败：${result.error ?? ""}`).toBe(true)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-manage-"))
  setTestDataRoot(root)
  destroyPool()
  installNodeHostBridge()

  // 注册表的 activeId 是模块级状态，会在同一文件的用例之间残留。空 cards 目录下
  // initCards + initRegistry 会把 activeId 归 null，让每个用例都从「没有激活卡」
  // 的确定状态出发（无激活时的拒绝分支才可断言，不依赖用例声明顺序）。
  await initCards()
  await initRegistry()

  mkdirSync(cardsDir(), { recursive: true })
  mkdirSync(join(root, "personality", "stages"), { recursive: true })
  writeFileSync(cardFilePath("_template.md"), REPO_TEMPLATE)
  writeFileSync(cardFilePath("existing.md"), cardMarkdown("existing", "现有卡", "现有角色"))
  writeFileSync(cardFilePath("重名.md"), cardMarkdown("重名", "重名卡", "重名角色"))
  writeFileSync(cardFilePath("doomed.md"), cardMarkdown("doomed", "待删卡", "待删角色"))
  writeFileSync(stagesFilePath("doomed.json"), "{}")
  await initCards()
})

afterEach(() => {
  destroyPool()
  clearStagesCache()
  rmSync(root, { recursive: true, force: true })
})

describe("Card 管理", () => {
  it("新建：骨架取运行时模板，只改 frontmatter 的 id/name [card-manage-create]", async () => {
    const result = await createCard("新伙伴", currentIds())

    expect(result.ok).toBe(true)
    expect(result.newId).toBe("新伙伴")

    const raw = readCardFile("新伙伴.md")
    // 骨架必须来自运行时 cards/_template.md，而不是任何硬编码/内嵌副本
    expect(cardBody(raw)).toBe(cardBody(REPO_TEMPLATE))
    // 解析出的身份用输入值断言（产品解析器只负责把落盘内容还原出来）
    const created = await importUserCard(raw)
    expect(created.id).toBe("新伙伴")
    expect(created.name).toBe("新伙伴")
    expect(getCard("新伙伴")?.name).toBe("新伙伴")
    expect(getCard("新伙伴")?.id).toBe("新伙伴")
  })

  it("新建：名字清洗成空回落 card，撞名加后缀且不覆盖已有卡 [card-manage-create-collision]", async () => {
    const fallback = await createCard("!!!", currentIds())
    expect(fallback.ok).toBe(true)
    expect(fallback.newId).toBe("card")

    const takenBefore = readCardFile("重名.md")

    const second = await createCard("重名", currentIds())
    expect(second.ok).toBe(true)
    expect(second.newId).toBe("重名-2")

    const third = await createCard("重名", currentIds())
    expect(third.ok).toBe(true)
    expect(third.newId).toBe("重名-3")

    // 已有卡一个字节没动：撞名只许加后缀，不许覆盖
    expect(readCardFile("重名.md")).toBe(takenBefore)
    expect(getCard("重名")?.name).toBe("重名卡")
    expect(getCard("重名-2")?.name).toBe("重名")
    expect(getCard("重名-3")?.name).toBe("重名")
  })

  it("新建：模板缺失时如实失败并指向恢复默认资源 [card-manage-create-no-template]", async () => {
    rmSync(cardFilePath("_template.md"))

    const result = await createCard("无模板卡", currentIds())

    expect(result.ok).toBe(false)
    expect(result.message).toContain("恢复默认资源")
    // 不落硬编码兜底骨架：模板缺失时磁盘上不得凭空出现新卡
    expect(existsSync(cardFilePath("无模板卡.md"))).toBe(false)
  })

  it("重命名：只改 frontmatter name，id/文件名/正文一字不动 [card-manage-rename]", async () => {
    const before = readCardFile("doomed.md")

    const result = await renameCard("doomed", "  改过名的卡  ")

    expect(result.ok).toBe(true)
    const after = readCardFile("doomed.md")
    // 正文（含正文里以 name: 开头的行）一字不动
    expect(cardBody(after)).toBe(cardBody(before))
    // id 与文件名不跟随显示名
    expect(existsSync(cardFilePath("改过名的卡.md"))).toBe(false)
    expect(getCard("doomed")?.id).toBe("doomed")
    expect(getCard("doomed")?.name).toBe("改过名的卡")
  })

  it("重命名：空白名拒绝且文件不动 [card-manage-rename-blank]", async () => {
    const before = readCardFile("doomed.md")

    const result = await renameCard("doomed", "   ")

    expect(result.ok).toBe(false)
    expect(readCardFile("doomed.md")).toBe(before)
  })

  it("删除：卡文件与 stages 文件一起删，注册表同步移除 [card-manage-delete]", async () => {
    await activate("existing")

    const result = await deleteCard("doomed")

    expect(result.ok).toBe(true)
    expect(existsSync(cardFilePath("doomed.md"))).toBe(false)
    expect(existsSync(stagesFilePath("doomed.json"))).toBe(false)
    expect(getCard("doomed")).toBeUndefined()
    expect(currentIds()).not.toContain("doomed")
    // 删的不是激活卡，激活状态不受影响
    expect(getActivePersonalityId()).toBe("existing")
  })

  it("删除：激活卡拒删，文件与注册表原封不动 [card-manage-delete-active]", async () => {
    await activate("existing")
    const cardBefore = readCardFile("existing.md")

    const result = await deleteCard("existing")

    expect(result.ok).toBe(false)
    expect(result.message).toContain("先切换")
    expect(readCardFile("existing.md")).toBe(cardBefore)
    expect(existsSync(stagesFilePath("existing.json"))).toBe(true)
    expect(getActivePersonalityId()).toBe("existing")
    expect(getCard("existing")?.id).toBe("existing")
  })

  it("删除：stages 缺失视为已清理；卡文件缺失如实失败 [card-manage-delete-missing]", async () => {
    // 从未激活过的卡没有 stages 文件：删除目标不存在 = 已清理，不算失败
    rmSync(stagesFilePath("doomed.json"))
    const normal = await deleteCard("doomed")
    expect(normal.ok).toBe(true)
    expect(existsSync(cardFilePath("doomed.md"))).toBe(false)

    // 卡文件不存在：不能把「什么都没删」伪装成成功，错误要浮出来
    const ghost = await deleteCard("ghost")
    expect(ghost.ok).toBe(false)
    expect(ghost.message).toBeTruthy()
  })

  it("导出：返回磁盘原文；未知 id 返回 null [card-manage-export]", async () => {
    expect(await exportCardText("doomed")).toBe(readCardFile("doomed.md"))
    expect(await exportCardText("no-such-card")).toBeNull()
  })

  it("导入：合法内容落盘，同名覆盖在回执里说清 [card-manage-import]", async () => {
    const raw = cardMarkdown("imported", "导入卡", "导入角色")

    const created = await importCardText(raw, currentIds())
    expect(created.ok).toBe(true)
    expect(created.newId).toBe("imported")
    expect(created.message).not.toContain("覆盖")
    expect(readCardFile("imported.md")).toBe(raw)
    expect(getCard("imported")?.name).toBe("导入卡")

    // 同名再导入 = 以这份内容为准（允许覆盖），但回执必须说清是覆盖
    const updated = cardMarkdown("imported", "导入卡改", "导入角色改")
    const overwritten = await importCardText(updated, currentIds())
    expect(overwritten.ok).toBe(true)
    expect(overwritten.message).toContain("覆盖")
    expect(readCardFile("imported.md")).toBe(updated)
    expect(getCard("imported")?.name).toBe("导入卡改")
  })

  it("导入：解析不出有效 id 的内容被拒且不落盘 [card-manage-import-invalid]", async () => {
    const filesBefore = readdirSync(cardsDir())
    const idsBefore = currentIds()

    const noFrontmatter = "# 只是一段 markdown，没有 frontmatter"
    const emptyId = `---\nid: \nname: 空 id 卡\nversion: 1\n---\n\n# 角色设定\nx\n`
    for (const raw of [noFrontmatter, emptyId]) {
      const result = await importCardText(raw, currentIds())
      expect(result.ok).toBe(false)
      expect(result.message).toContain("id")
    }

    expect(readdirSync(cardsDir())).toEqual(filesBefore)
    expect(currentIds()).toEqual(idsBefore)
  })

  it("导入：id 含空格按落盘命名规则清洗，正文原样保存 [card-manage-import-safe-name]", async () => {
    const raw = cardMarkdown("a b", "空格 id", "空格")

    const result = await importCardText(raw, [])

    expect(result.ok).toBe(true)
    expect(existsSync(cardFilePath("a_b.md"))).toBe(true)
    expect(existsSync(cardFilePath("a b.md"))).toBe(false)
    expect(getCard("a b")?.rawContent).toBe(raw)
  })

  it("读取模板：返回运行时模板全文，而不是随仓副本 [card-manage-template-read]", async () => {
    // 运行时模板被用户改过：必须读到改动后的那份
    const runtimeTemplate = REPO_TEMPLATE.replace("Card 作者完整开发指引", "运行时模板标记")
    writeFileSync(cardFilePath("_template.md"), runtimeTemplate)

    expect(await readCardTemplate()).toBe(runtimeTemplate)
  })

  it("读取模板：模板缺失时如实抛错并指向恢复默认资源 [card-manage-template-missing]", async () => {
    rmSync(cardFilePath("_template.md"))

    await expect(readCardTemplate()).rejects.toThrow("恢复默认资源")
  })

  it("保存 Card：正文写回原文件并重载注册表 [card-manage-save]", async () => {
    const edited = readCardFile("doomed.md").replace("你是待删角色。", "你是改过正文的待删角色。")

    const result = await saveCardText("doomed", edited)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("下一个回合生效")
    expect(readCardFile("doomed.md")).toBe(edited)
    expect(getCard("doomed")?.sections.roleSetting).toBe("你是改过正文的待删角色。")
  })

  it("保存 Card：id 被改或内容解析失败时拒绝，文件一个字节没动 [card-manage-save-reject]", async () => {
    const before = readCardFile("doomed.md")

    const changedId = before.replace("id: doomed", "id: other-card")
    const mismatch = await saveCardText("doomed", changedId)
    expect(mismatch.ok).toBe(false)
    expect(mismatch.message).toContain("id")
    expect(readCardFile("doomed.md")).toBe(before)
    expect(existsSync(cardFilePath("other-card.md"))).toBe(false)

    const noId = await saveCardText("doomed", "# 没有 frontmatter 的正文")
    expect(noId.ok).toBe(false)
    expect(readCardFile("doomed.md")).toBe(before)
  })

  it("保存 Card：cardId 为 null 走激活卡，无激活卡时拒绝 [card-manage-save-active]", async () => {
    // 还没有激活卡：null 不许猜一张卡来写
    const noActive = await saveCardText(null, readCardFile("existing.md"))
    expect(noActive.ok).toBe(false)

    await activate("existing")
    const filesBefore = readdirSync(cardsDir())
    const edited = readCardFile("existing.md").replace("你是现有角色。", "你是被编辑过的现有角色。")

    const result = await saveCardText(null, edited)

    expect(result.ok).toBe(true)
    expect(readCardFile("existing.md")).toBe(edited)
    expect(getCard("existing")?.sections.roleSetting).toBe("你是被编辑过的现有角色。")
    // 写回的是原文件，没有因编辑凭空多出/改名出别的卡文件
    expect(readdirSync(cardsDir())).toEqual(filesBefore)
  })
})
