// ==========================================
// 设置页 Card 管理面（AI 页）—— 四条请求臂的管理往返与请求面（L2）
// ==========================================
//
// 归属 L2 的依据：请求臂本身只做「入参校验 → 人格域既有入口 → 回执」，人格文件命令
// 由 Node 测试宿主按 Rust 分派逐条等价执行，落盘断言直接读临时数据根里的真实文件。
// 原生文件对话框（pick_file_open / pick_file_save）在 Node 宿主没有通道，由本文件
// 注入选择结果并记录调用形状 —— 对话框自身的系统交互属于原生 UI 驱动，不在这里冒充。
//
// 被测行为：
//   · card_manage 的 create / rename / delete 管理往返：回执带最新卡列表，列表与磁盘
//     同源（撞名判定与下拉看到的是同一份现读列表）；
//   · card_manage 的 export / import：按对话框返回的路径经既有 file_write / file_read
//     读写，取消是正常结果而不是失败；
//   · card_manage 的未知 op、缺字段与未知卡导出如实拒绝；
//   · card_markdown_read / card_markdown_write 的本体读写往返：读到的就是磁盘原文，
//     写入按原文件名落盘，改 id / 解析失败拒绝且文件不动；无激活卡时 null 不猜卡；
//   · card_template 返回运行时 cards/_template.md，缺失时如实报错并指向恢复默认资源。

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"
import { initRegistry } from "@/services/personality/registry"
import { destroyPool } from "@/services/personality/variable-pool"
import { clearStagesCache } from "@/services/personality/stages-cache"
import { installNodeHostBridge } from "../../host/install-node-bridge"
import { setTestDataRoot } from "../../host/node-ipc"

/** 运行时模板：新建必须取这一份，且只改 frontmatter 的 id/name。 */
const TEMPLATE = `---
id: template
name: 模板
description: 运行时模板
version: 1
---

# 角色设定
你是运行时模板里的占位角色。

# 语言风格
简短。
`

function cardMarkdown(id: string, name: string, role: string): string {
  return `---
id: ${id}
name: ${name}
description: 管理用例
version: 1
---

# 角色设定
你是${role}。

# 语言风格
简短。
`
}

let root = ""
let dialogOpen: string | null = null
let dialogSave: string | null = null
const dialogCalls: Array<{ method: string; args: Record<string, unknown> }> = []

function cardsDir(): string { return join(root, "personality", "cards") }
function cardFile(name: string): string { return join(cardsDir(), name) }

/** readdir 的枚举顺序随文件系统而异，集合断言统一按文件名排序。 */
function cardFileNames(): string[] { return readdirSync(cardsDir()).sort() }

interface CardList { cards: Array<{ id: string; name: string }> }

/** 断言当前卡列表（回执里的 list）只投影 id/name 两字段。 */
function listIds(list: CardList): string[] {
  return list.cards.map(row => row.id).sort()
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-card-request-"))
  setTestDataRoot(root)
  installNodeHostBridge()
  // 原生对话框不属于 Node 宿主：按用例注入选择结果，其余命令一律透传给真实适配层。
  const bridge = getHostBridge()
  const original = bridge.request
  bridge.request = (async (method: string, args?: unknown) => {
    if (method === "pick_file_open" || method === "pick_file_save") {
      dialogCalls.push({ method, args: (args ?? {}) as Record<string, unknown> })
      return method === "pick_file_open" ? dialogOpen : dialogSave
    }
    return (original as unknown as (m: string, a?: unknown) => Promise<unknown>).call(bridge, method, args)
  }) as HostBridge["request"]

  mkdirSync(cardsDir(), { recursive: true })
  mkdirSync(join(root, "personality", "stages"), { recursive: true })
  // 注册表的 activeId 是模块级状态：空目录下初始化让每个用例从「没有激活卡」出发。
  await initRegistry()

  writeFileSync(cardFile("_template.md"), TEMPLATE)
  writeFileSync(cardFile("existing.md"), cardMarkdown("existing", "现有卡", "现有角色"))
  writeFileSync(cardFile("doomed.md"), cardMarkdown("doomed", "待删卡", "待删角色"))

  dialogOpen = null
  dialogSave = null
  dialogCalls.length = 0
})

afterEach(() => {
  destroyPool()
  clearStagesCache()
  rmSync(root, { recursive: true, force: true })
})

describe("card_manage（管理往返）", () => {
  it("新建 → 列表 → 重命名 → 删除：回执列表与磁盘同源 [native-ui-card-manage-roundtrip]", async () => {
    const created = (await dispatchHostRequest("card_manage", { op: "create", name: "新伙伴" })) as {
      message: string
      list: CardList
    }
    expect(created.message).toBe("已新建「新伙伴」")
    expect(listIds(created.list)).toEqual(["doomed", "existing", "新伙伴"])
    expect(created.list.cards.find(row => row.id === "新伙伴")?.name).toBe("新伙伴")
    // 落盘事实：骨架取运行时模板，只改 frontmatter 的 id/name。
    const createdRaw = readFileSync(cardFile("新伙伴.md"), "utf8")
    expect(createdRaw).toContain("id: 新伙伴")
    expect(createdRaw).toContain("name: 新伙伴")
    expect(createdRaw).toContain("你是运行时模板里的占位角色。")

    const renamed = (await dispatchHostRequest("card_manage", {
      op: "rename", cardId: "新伙伴", name: "改名伙伴",
    })) as { message: string; list: CardList }
    expect(renamed.message).toBe("已重命名为「改名伙伴」")
    expect(renamed.list.cards.find(row => row.id === "新伙伴")?.name).toBe("改名伙伴")
    // 改名不换身份：文件名与 id 不跟随显示名。
    expect(existsSync(cardFile("改名伙伴.md"))).toBe(false)
    expect(readFileSync(cardFile("新伙伴.md"), "utf8")).toContain("id: 新伙伴")

    const deleted = (await dispatchHostRequest("card_manage", { op: "delete", cardId: "新伙伴" })) as {
      message: string
      list: CardList
    }
    expect(deleted.message).toBe("已删除「改名伙伴」")
    expect(listIds(deleted.list)).toEqual(["doomed", "existing"])
    expect(existsSync(cardFile("新伙伴.md"))).toBe(false)
    expect(cardFileNames()).toEqual(["_template.md", "doomed.md", "existing.md"])
  })

  it("导出 → 导入：按对话框返回的路径读写，取消不是失败 [native-ui-card-manage-transfer]", async () => {
    const exportPath = join(root, "exports", "existing.md")
    dialogSave = exportPath
    const exported = (await dispatchHostRequest("card_manage", { op: "export", cardId: "existing" })) as {
      message: string
      list: CardList
    }
    expect(exported.message).toBe(`已导出人格卡：${exportPath}`)
    // 请求面：建议文件名与筛选条件按 Card 口径发出。
    expect(dialogCalls).toEqual([{
      method: "pick_file_save",
      args: { suggestedName: "existing.md", filterLabel: "人格卡", extension: "md" },
    }])
    // 导出的是磁盘原文（可再导入）。
    expect(readFileSync(exportPath, "utf8")).toBe(readFileSync(cardFile("existing.md"), "utf8"))

    const importSource = join(root, "imports", "imported.md")
    mkdirSync(join(root, "imports"), { recursive: true })
    const importedRaw = cardMarkdown("imported", "导入卡", "导入角色")
    writeFileSync(importSource, importedRaw)
    dialogOpen = importSource
    const imported = (await dispatchHostRequest("card_manage", { op: "import" })) as {
      message: string
      list: CardList
    }
    expect(imported.message).toBe("已导入「导入卡」")
    expect(dialogCalls[1]).toEqual({
      method: "pick_file_open",
      args: { extensions: ["md"], label: "人格卡" },
    })
    expect(readFileSync(cardFile("imported.md"), "utf8")).toBe(importedRaw)
    expect(imported.list.cards.find(row => row.id === "imported")?.name).toBe("导入卡")

    // 取消（对话框返回 null）是正常结果：不写文件、列表不变。
    const filesBefore = cardFileNames()
    dialogOpen = null
    dialogSave = null
    const cancelledImport = (await dispatchHostRequest("card_manage", { op: "import" })) as { message: string }
    expect(cancelledImport.message).toBe("已取消导入")
    const cancelledExport = (await dispatchHostRequest("card_manage", { op: "export", cardId: "existing" })) as {
      message: string
    }
    expect(cancelledExport.message).toBe("已取消导出")
    expect(cardFileNames()).toEqual(filesBefore)
  })

  it("未知 op / 缺字段 / 未知卡导出如实拒绝，且不产生落盘或对话框副作用 [native-ui-card-manage-errors]", async () => {
    await expect(dispatchHostRequest("card_manage", { op: "explode" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("card_manage", { op: "create" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("card_manage", { op: "rename", name: "只有名字" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(dispatchHostRequest("card_manage", { op: "delete" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("card_manage", { name: "没有 op" })).rejects.toMatchObject({ code: "CONFIG" })

    // 未知卡：先判存在性，再谈导出路径 —— 对话框一次都不该弹。
    await expect(
      dispatchHostRequest("card_manage", { op: "export", cardId: "ghost" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    expect(dialogCalls).toHaveLength(0)
    expect(cardFileNames()).toEqual(["_template.md", "doomed.md", "existing.md"])

    // 导入内容不合准入条件：整份拒绝，磁盘与列表逐项不变。
    const invalidSource = join(root, "imports", "invalid.md")
    mkdirSync(join(root, "imports"), { recursive: true })
    writeFileSync(invalidSource, "# 没有 frontmatter")
    dialogOpen = invalidSource
    await expect(dispatchHostRequest("card_manage", { op: "import" })).rejects.toThrow("有效的 Card")
    expect(cardFileNames()).toEqual(["_template.md", "doomed.md", "existing.md"])
  })
})

describe("card_markdown_read / card_markdown_write（本体读写往返）", () => {
  it("读到的就是磁盘原文；写入按原文件名落盘并可读回 [native-ui-card-markdown-roundtrip]", async () => {
    const before = readFileSync(cardFile("doomed.md"), "utf8")
    const read = (await dispatchHostRequest("card_markdown_read", { cardId: "doomed" })) as {
      cardId: string
      text: string
    }
    expect(read).toEqual({ cardId: "doomed", text: before })

    const edited = before.replace("你是待删角色。", "你是改过正文的待删角色。")
    const written = await dispatchHostRequest("card_markdown_write", { cardId: "doomed", text: edited })
    expect(written).toBeUndefined()
    expect(readFileSync(cardFile("doomed.md"), "utf8")).toBe(edited)
    // 读回同源：下一次打开编辑器看到的就是刚保存的字。
    const readBack = (await dispatchHostRequest("card_markdown_read", { cardId: "doomed" })) as { text: string }
    expect(readBack.text).toBe(edited)
  })

  it("改 id / 解析失败拒绝且文件不动；未知卡与无激活卡如实拒绝 [native-ui-card-markdown-reject]", async () => {
    const before = readFileSync(cardFile("doomed.md"), "utf8")
    await expect(dispatchHostRequest("card_markdown_write", {
      cardId: "doomed",
      text: before.replace("id: doomed", "id: other-card"),
    })).rejects.toThrow("不能把 Card 的 id")
    await expect(dispatchHostRequest("card_markdown_write", {
      cardId: "doomed",
      text: "# 没有 frontmatter",
    })).rejects.toThrow("缺少有效 id")
    expect(readFileSync(cardFile("doomed.md"), "utf8")).toBe(before)
    expect(existsSync(cardFile("other-card.md"))).toBe(false)

    await expect(dispatchHostRequest("card_markdown_write", { cardId: "doomed" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(dispatchHostRequest("card_markdown_read", { cardId: "ghost" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    // 没有激活卡时 null 不猜一张卡来读写。
    await expect(dispatchHostRequest("card_markdown_read", {})).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    await expect(dispatchHostRequest("card_markdown_write", {
      text: before,
    })).rejects.toThrow("没有激活的 Card")
  })
})

describe("card_template（作者模板）", () => {
  it("返回运行时 cards/_template.md 的全文；缺失时如实报错并指向恢复默认资源 [native-ui-card-template]", async () => {
    const payload = (await dispatchHostRequest("card_template", {})) as { text: string }
    expect(payload.text).toBe(TEMPLATE)

    // 用户改过运行时模板：面板展示的必须就是新建真正会用的那份。
    const runtimeEdited = TEMPLATE.replace("占位角色", "被用户改过的模板角色")
    writeFileSync(cardFile("_template.md"), runtimeEdited)
    const edited = (await dispatchHostRequest("card_template", {})) as { text: string }
    expect(edited.text).toBe(runtimeEdited)

    rmSync(cardFile("_template.md"))
    await expect(dispatchHostRequest("card_template", {})).rejects.toThrow("恢复默认资源")
  })
})
