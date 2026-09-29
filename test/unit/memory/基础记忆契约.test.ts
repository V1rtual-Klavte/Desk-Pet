// ==========================================
// 基础记忆契约 —— 从 test/e2e/scenes/memory/基础记忆契约.scene.ts 迁到 L2
// ==========================================
//
// 被测：MemoryService 的长期记忆 CRUD（append / search / important / update+remove /
// consolidate）与系统文件（CANDY / User）的可读性。全部是进程内行为：条目在模块内存里，
// 文件写盘只是附带（断言不走读盘回读），所以归 L2。
//
// 迁到 L2 后保留临时数据根：初始化要写 MEMORY.md 模板、写盘调度要落文件。
// 原场景是未声明 entry（L4 按 runtime 跑真实回合，setup 里装了 fake Provider）：
// 六条断言没有一条依赖那个回合，迁到 L2 后不再跑模型，也不再需要 Provider 替身。
//
// 审视结论（按 W3 契约登记执行，两条都已复核）：
//   ① `记忆搜索:21`（D6）：原 setup 只 append 一条，`search("searchable", 1)[0]` 用
//      「返回全部」的实现也返回同一条，不可区分 —— setup 再 append 一条不含关键词的条目，
//      并把断言从「第 1 条」改成「结果集恰好一条」：limit=1 会把「返回全部」的实现藏起来。
//   ② `记忆更新删除:36-38`（D3）：原场景真正验证 update 的 `search("after update")` 在条目
//      已被 remove **之后**执行，checks 只剩平凡条件 —— 迁过来时把读放在 remove **之前**
//      （`toHaveLength(1)`），再执行 remove 验证收尾。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { MemoryService } from "@/services/agent/memory"
import { initPaths } from "@/services/paths"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-basic-contract-"))
  setTestDataRoot(root)
  // 路径模块是单例缓存（initPaths 幂等）：一个文件内固定一个数据根，
  // 测试之间靠 `clear()` 隔离记忆条目，不再换根。
  await initPaths()
  await MemoryService.init()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // 与 L4 的 standardSetup 同口径：每个场景从「空记忆」开始（init 出的系统文件索引也一并清掉）。
  MemoryService.clear()
})

describe("基础记忆契约", () => {
  it("Memory append 创建条目 [memory-append]", () => {
    const before = MemoryService.count
    const entry = MemoryService.append("append smoke fact", "general", 5)

    expect(entry.id, "append 没有为条目生成 id").toBeTruthy()
    expect(MemoryService.count, "append 之后条目数没有增加").toBe(before + 1)
    expect(MemoryService.search("append smoke fact", 1).map(item => item.id), "append 未创建可检索条目")
      .toEqual([entry.id])
  })

  it("Memory search 按内容返回条目 [memory-search]", () => {
    const hit = MemoryService.append("searchable memory fact", "general", 5)
    // 「返回全部」的实现会把它一并返回：没有这条对照，断言断不出「按关键词过滤」。
    MemoryService.append("unrelated fixture fact", "general", 5)

    // 结果集恰好一条：limit 用默认值，别让 limit=1 把「返回全部」的实现藏起来。
    const found = MemoryService.search("searchable")
    expect(found.map(item => item.content), "search 未按关键词过滤（返回了不含关键词的条目）")
      .toEqual(["searchable memory fact"])
    expect(found[0]?.id, "search 返回的不是 append 创建的那条").toBe(hit.id)
  })

  it("Memory important 过滤阈值 [memory-important]", () => {
    MemoryService.append("low importance", "general", 3)
    MemoryService.append("high importance", "general", 9)

    const result = MemoryService.important(8)
    expect(result.map(item => item.content), "important 阈值过滤错误（>= 8 的条目集合不对）")
      .toEqual(["high importance"])
  })

  it("Memory update/remove 生命周期 [memory-update-remove]", () => {
    const entry = MemoryService.append("before update", "general", 5)
    expect(MemoryService.update(entry.id, { content: "after update" }), "update 返回失败").toBe(true)

    // D3 修正：真正验证 patch 的读必须在 remove 之前 —— 原场景在条目已被删除后才读，
    // 于是「update 是否生效」没有任何断言在观察。
    const updated = MemoryService.search("after update")
    expect(updated, "update 后按新正文应恰好检索到 1 条").toHaveLength(1)
    expect(updated[0]?.id, "update 后检索到的不是被更新的那条").toBe(entry.id)
    expect(MemoryService.search("before update"), "旧正文仍可检索到：update 没有替换正文").toHaveLength(0)

    expect(MemoryService.remove(entry.id), "remove 返回失败").toBe(true)
    expect(MemoryService.search("after update"), "remove 后仍能检索到已删除条目").toHaveLength(0)
    // 边界：对不存在的 id 必须如实返回 false，而不是假装成功。
    expect(MemoryService.remove("missing-memory-id"), "对不存在的 id remove 返回了成功").toBe(false)
  })

  it("本地 consolidate 去重 [memory-consolidate]", () => {
    MemoryService.append("duplicate fact", "general", 5)
    MemoryService.append("duplicate fact", "general", 4)

    const result = MemoryService.consolidate()
    expect(result.removed, "consolidate 未去重").toBeGreaterThanOrEqual(1)
    expect(MemoryService.search("duplicate fact", 10).map(item => item.content), "去重后仍有多条同正文条目")
      .toEqual(["duplicate fact"])
  })

  it("Candy/User 指令可读取 [memory-system-files]", async () => {
    expect(await MemoryService.updateCandy("保持简洁"), "updateCandy 写入失败").toBe(true)
    MemoryService.append("用户喜欢 TypeScript", "user", 9)
    await MemoryService.syncUserProfile()

    const candy = MemoryService.getCandyInstructionsSync()
    expect(candy, "Candy 指令不可读").toContain("保持简洁")
    // 取回的是「指令正文」而不是整个文件：文件标题与分节标记都不能进注入面。
    expect(candy, "Candy 注入的是整个文件而不是指令正文").not.toContain("## 指令")

    const user = MemoryService.getUserProfileSync()
    expect(user, "User 画像不可读").toContain("用户喜欢 TypeScript")
    expect(user, "User 注入的是整个文件而不是画像正文").not.toContain("# User.md — 用户画像")
  })
})
