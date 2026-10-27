// ==========================================
// Slash 命令表 —— 查找语义、忙碌准入、结果路由与 /help 分组
// ==========================================
//
// 这层没有模型、没有会话：注册表就是命令的唯一真相源，preProcess 是命令的唯一执行入口。
// 三个容易被「看起来还在工作」掩盖的偏差都在这里钉住：
//   · find 的整串精确匹配优先与「只对 acceptsArgs 做最长前缀」—— 弄反会让 /memory clean
//     被 /memory 抢走，用户看到的却是另一条命令的结果；
//   · busyPolicy 的准入分档 —— exclusive 在回合中途执行会改掉别人正在用的会话状态；
//   · 命令结果的两条非文本出口（null 不出回复、技能准入不算已处理）—— 把准入当文本会让
//     Harness 拿不到那次运行代际，正文永远不落盘。
//
// 命令注册在本文件内自造（探针名不与产品命令重名）；/help 与初始化幂等放在最后一条，
// 因为 initSlashCommands 会把真实命令表并进同一个注册表。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { find, listAll, register, search } from "@/services/engine/slash/registry"
import type { RegisteredSlashCommand, SlashSkillAdmission } from "@/services/engine/slash/types"
import { preProcess } from "@/services/engine/preprocessor"

function probe(name: string, overrides: Partial<RegisteredSlashCommand> = {}): RegisteredSlashCommand {
  return {
    name,
    description: `${name} 探针`,
    execute: async () => `${name} 已执行`,
    ...overrides,
  }
}

function commandNamed(invocation: ReturnType<typeof find>, name: string): void {
  expect(invocation?.command.name, `命中的不是 ${name}`).toBe(name)
}

let root = ""

beforeAll(() => {
  // 命令执行失败会走统一日志出口；日志要落进临时数据根，不能打到进程外。
  root = mkdtempSync(join(tmpdir(), "deskpet-slash-table-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Slash 注册表查找", () => {
  it("整串精确匹配优先，含空格的命令名不被可带参数命令的前缀抢走 [slash-find-exact-first]", () => {
    register(probe("probe plain"))
    register(probe("probe", { acceptsArgs: true }))

    const exact = find("probe plain")
    commandNamed(exact, "probe plain")
    expect(exact?.args, "整串命中的命令不应再拆出参数").toBeUndefined()

    // 精确未命中时只有 acceptsArgs 的 probe 参与前缀匹配：
    const prefixed = find("probe plain deep")
    commandNamed(prefixed, "probe")
    expect(prefixed?.args, "缺参数拆分或长度选择错都会让这里不是余下文本").toBe("plain deep")
  })

  it("前缀匹配只认命令名 + 分隔空白，并取最长的可带参数命令名 [slash-find-longest-prefix]", () => {
    register(probe("probe-args", { acceptsArgs: true }))
    register(probe("probe-args deep", { acceptsArgs: true }))

    const longest = find("probe-args deep x")
    commandNamed(longest, "probe-args deep")
    expect(longest?.args).toBe("x")

    const shorter = find("probe-args x")
    commandNamed(shorter, "probe-args")
    expect(shorter?.args).toBe("x")

    expect(find("probe-argsx"), "没有分隔空白不算带参调用").toBeUndefined()
    expect(find("probe-args   "), "只有尾部空白不算带参调用（也不该回落到精确匹配）").toBeUndefined()

    const tabbed = find("probe-args\tx")
    commandNamed(tabbed, "probe-args")
    expect(tabbed?.args, "制表符也是分隔空白").toBe("x")
  })
})

describe("Slash 下拉搜索", () => {
  it("按整串 / 前缀 / 包含三档计分并优先展示高分 [slash-search-scoring]", () => {
    register(probe("searchme"))
    register(probe("searchme args", { acceptsArgs: true, description: "带参探针" }))
    register(probe("contains-probe", { description: "描述里提到 searchme 的命令" }))

    const matches = search("searchme")
    expect(matches.map(match => [match.command.name, match.score])).toEqual([
      ["searchme", 3],
      ["searchme args", 2],
      ["contains-probe", 1],
    ])

    expect(search("SEARCHME").map(match => match.score), "输入大小写不应改变分档").toEqual([3, 2, 1])

    const contained = matches.find(match => match.command.name === "contains-probe")
    expect(contained?.score, "描述命中只能算最低档").toBe(1)
    expect(search("no-such-command-fragment")).toEqual([])
  })
})

describe("Slash 忙碌准入与结果路由", () => {
  it("忙碌期 exclusive 明确拒绝且不执行，immediate / coordinated 照常执行 [slash-preprocess-busy-policy]", async () => {
    const exclusive = vi.fn(async () => "EXCLUSIVE")
    const immediate = vi.fn(async () => "IMMEDIATE")
    const coordinated = vi.fn(async () => "COORDINATED")
    register(probe("probe-busy-exclusive", { execute: exclusive }))
    register(probe("probe-busy-immediate", { busyPolicy: "immediate", execute: immediate }))
    register(probe("probe-busy-coordinated", { busyPolicy: "coordinated", execute: coordinated }))

    const rejected = await preProcess("/probe-busy-exclusive", {}, { busy: true })
    expect(rejected.handled).toBe(true)
    expect(rejected.response, "exclusive 命令在忙碌期没有明确拒绝").toContain("需要等当前回合结束再执行")
    expect(exclusive, "被拒绝的命令仍然执行了").not.toHaveBeenCalled()

    expect((await preProcess("/probe-busy-immediate", {}, { busy: true })).response).toBe("IMMEDIATE")
    expect((await preProcess("/probe-busy-coordinated", {}, { busy: true })).response).toBe("COORDINATED")
    expect((await preProcess("/probe-busy-exclusive", {}, { busy: false })).response).toBe("EXCLUSIVE")
  })

  it("文本 / 静默 / 技能准入 / 执行失败 / 未注册五条出口各归各的形态 [slash-preprocess-result-routing]", async () => {
    register(probe("probe-text"))
    register(probe("probe-silent", { execute: async () => null }))
    const admission: SlashSkillAdmission = { name: "probe-skill", additionalInstructions: "额外指示" }
    register(probe("probe-admission", { acceptsArgs: true, execute: async () => admission }))
    register(probe("probe-throws", { execute: () => Promise.reject(new Error("探针内爆")) }))

    const text = await preProcess("/probe-text")
    expect(text).toMatchObject({ handled: true, response: "probe-text 已执行", text: "" })

    const silent = await preProcess("/probe-silent")
    expect(silent.handled).toBe(true)
    expect(silent.response, "null 结果不应合成一条回复").toBeUndefined()
    expect(silent.text).toBe("")

    const skill = await preProcess("/probe-admission 额外指示")
    expect(skill.handled, "技能准入不是已处理的文本").toBe(false)
    expect(skill.skillAdmission).toEqual(admission)
    expect(skill.text, "准入要保留完整输入供运行入口落盘").toBe("/probe-admission 额外指示")

    const failed = await preProcess("/probe-throws")
    expect(failed.handled).toBe(true)
    expect(failed.response, "命令异常没有收口成可展示的失败文案").toBe("命令执行出错…")

    const unknown = await preProcess("/probe-does-not-exist foo")
    expect(unknown.handled, "未注册的 slash 文本应透传给 AI").toBe(false)
    expect(unknown.text).toBe("/probe-does-not-exist foo")
    expect(unknown.skillAdmission).toBeUndefined()
  })
})

describe("Slash 初始化与 /help", () => {
  it("命令表初始化幂等，/help 按固定分类顺序列出全部命令 [slash-help-grouped-listing]", async () => {
    // 真实命令表（含主动陪伴等域）在装配时才加载：它们会在导入期触达宿主，必须晚于数据根。
    const { initSlashCommands } = await import("@/services/engine/slash/commands")
    const { helpCommand } = await import("@/services/engine/slash/commands/help")
    initSlashCommands()
    const registered = listAll()
    initSlashCommands()
    expect(listAll().length, "重复初始化把命令表又注册了一遍").toBe(registered.length)
    expect(new Set(listAll().map(command => command.name)).size, "命令表里出现了重名命令").toBe(registered.length)

    const help = await helpCommand.execute()
    expect(help, "/help 没有执行结果").not.toBeNull()
    const text = help ?? ""
    expect(text.startsWith(`可用命令 (共 ${registered.length} 个)`), "/help 的命令总数与实际注册表不一致").toBe(true)
    for (const line of [
      "/help",
      "/clear",
      "/memory clean",
      "/skill <技能名> [额外指示]",
      "/proactive status",
      "/behavior clear",
    ]) {
      expect(text.includes(line), `/help 缺少命令 ${line}`).toBe(true)
    }
    const order = ["会话:", "记忆:", "技能:", "通用:"].map(label => text.indexOf(label))
    expect(order.every(index => index >= 0), "/help 缺少分类标题").toBe(true)
    expect(order, "/help 的分类顺序被改换").toEqual([...order].sort((a, b) => a - b))
  })
})
