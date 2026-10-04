import { describe, expect, it } from "vitest"
import { isAbsoluteTargetPath, parseDecidedTargets, readSlotsAvailable } from "@/services/observation/decide"

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

  it("解析围栏 JSON 并最多保留 3 个目标", () => {
    const targets = Array.from({ length: 5 }, (_, index) => ({ path: `/tmp/t${index}.md`, kind: "file", why: "x" }))
    const parsed = parseDecidedTargets("```json\n" + JSON.stringify({ targets }) + "\n```")
    expect(parsed.map(target => target.path)).toEqual(["/tmp/t0.md", "/tmp/t1.md", "/tmp/t2.md"])
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
