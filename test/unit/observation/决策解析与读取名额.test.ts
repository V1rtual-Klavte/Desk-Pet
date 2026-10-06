import { describe, expect, it } from "vitest"
import {
  DECISION_CARD_DESCRIPTION_CHARS, DECISION_CARD_NAME_CHARS, DECISION_CARD_ROLE_CHARS,
  DECISION_SYSTEM_PROMPT,
  boundedCardBrief, isAbsoluteTargetPath, localTimeBrief, parseDecidedTargets, readSlotsAvailable,
} from "@/services/observation/decide"

describe("了解层决策输出解析", () => {
  it("接受合法目标并裁剪 why 与重复路径 [observation-decision-parse]", () => {
    const parsed = parseDecidedTargets(JSON.stringify({
      targets: [
        { path: "/Users/example/work/notes.md", kind: "file", why: "当前窗口是编辑器" },
        { path: "/Users/example/work/notes.md", kind: "file", why: "重复路径应被去掉" },
        { path: "/Users/example/work", kind: "dir" },
      ],
    }))
    expect(parsed).toEqual([
      { path: "/Users/example/work/notes.md", kind: "file", why: "当前窗口是编辑器" },
      { path: "/Users/example/work", kind: "dir", why: "" },
    ])
  })

  it("解析围栏 JSON 不再截断目标数（单批上限已删，读取量另受每小时名额约束）", () => {
    const targets = Array.from({ length: 5 }, (_, index) => ({ path: `/tmp/t${index}.md`, kind: "file", why: "x" }))
    const parsed = parseDecidedTargets("```json\n" + JSON.stringify({ targets }) + "\n```")
    expect(parsed.map(target => target.path)).toEqual(targets.map(target => target.path))
  })

  it("非法 JSON、非数组 targets 与非法字段一律退化为空清单", () => {
    expect(parseDecidedTargets("这不是 JSON")).toEqual([])
    expect(parseDecidedTargets(JSON.stringify({ targets: "notes.md" }))).toEqual([])
    expect(parseDecidedTargets(JSON.stringify({ targets: [
      { path: "notes.md", kind: "file" },
      { path: "/tmp/a.md", kind: "exe" },
      { kind: "file" },
      { path: 42, kind: "file" },
    ] }))).toEqual([])
  })

  it("路径判定区分绝对与相对形态", () => {
    expect(isAbsoluteTargetPath("/Users/example")).toBe(true)
    expect(isAbsoluteTargetPath("C:\\Users\\example")).toBe(true)
    expect(isAbsoluteTargetPath("\\\\server\\share")).toBe(true)
    expect(isAbsoluteTargetPath("notes.md")).toBe(false)
    expect(isAbsoluteTargetPath("./notes.md")).toBe(false)
  })
})

describe("决策提示词的范围口径（整机只读，2026-10-06 用户裁决）", () => {
  it("放开系统/应用配置目录，保留凭据与密钥禁令与只读语义 [observation-decision-whole-machine-scope]", () => {
    expect(DECISION_SYSTEM_PROMPT, "没有写明整机只读范围").toContain("整机只读")
    expect(DECISION_SYSTEM_PROMPT, "系统或应用配置目录禁令仍在，范围没有放开").not.toContain("系统或应用配置目录")
    expect(DECISION_SYSTEM_PROMPT, "凭据禁令被一并放开").toContain("凭据")
    expect(DECISION_SYSTEM_PROMPT, "密钥禁令被一并放开").toContain("密钥")
    expect(DECISION_SYSTEM_PROMPT, "只读语义没有写明").toContain("只读")
  })
})

describe("每小时读取名额", () => {
  const HOUR = 60 * 60_000
  const now = 1_800_000_000_000

  it("窗口内已用次数扣减剩余名额 [observation-read-quota]", () => {
    expect(readSlotsAvailable([], now, 6, HOUR)).toBe(6)
    expect(readSlotsAvailable([now - 1, now - 2, now - 3], now, 6, HOUR)).toBe(3)
    expect(readSlotsAvailable([now - 1, now - 2, now - 3, now - 4, now - 5, now - 6], now, 6, HOUR)).toBe(0)
    expect(readSlotsAvailable([now - 1, now - 2, now - 3, now - 4, now - 5, now - 6, now - 7], now, 6, HOUR)).toBe(0)
  })

  it("窗口外的旧记录不再占用名额，未来时间戳不凭空放行", () => {
    expect(readSlotsAvailable([now - HOUR - 1], now, 6, HOUR)).toBe(6)
    expect(readSlotsAvailable([now + 1], now, 6, HOUR)).toBe(6)
  })
})

describe("决策输入的有界摘要（W4-B 输入补齐）", () => {
  it("Card 人设只取名字/描述/角色设定的有界前缀，空白折叠为单行 [observation-decision-card-brief]", () => {
    const compacted = boundedCardBrief({ name: "  甲  ", description: "人设\n描述", sections: { roleSetting: "角色  设定" } })
    expect(compacted).toEqual({ name: "甲", description: "人设 描述", roleSetting: "角色 设定" })

    const brief = boundedCardBrief({
      name: "N".repeat(200),
      description: "D".repeat(400),
      sections: { roleSetting: "R".repeat(900) },
    })
    expect(brief.name.length, "Card 名没有按上限截断").toBe(DECISION_CARD_NAME_CHARS)
    expect(brief.description.length, "Card 描述没有按上限截断").toBe(DECISION_CARD_DESCRIPTION_CHARS)
    expect(brief.roleSetting.length, "角色设定没有按上限截断").toBe(DECISION_CARD_ROLE_CHARS)
    expect(brief.roleSetting, "截断前缀被改写").toBe("R".repeat(DECISION_CARD_ROLE_CHARS))
  })

  it("本地时间块给出可读时刻（含星期）与非空时区 [observation-decision-local-time]", () => {
    const brief = localTimeBrief(new Date(2024, 0, 1, 12, 5))
    expect(brief.localTime).toBe("2024-01-01 12:05 周一")
    expect(brief.timezone.length).toBeGreaterThan(0)
  })
})
