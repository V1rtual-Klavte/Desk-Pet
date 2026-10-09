// ==========================================
// 报告保留核心（scripts/report-retention.mjs）——组淘汰、卫星连带、孤儿清除
// ==========================================
//
// 被测判据：保留单元必须是「组」（父报告 + 派生卫星），不是单个文件。
// 把实现改坏（按文件淘汰、卫星不连带、孤儿不清、最新不恒留）时这些断言必须变红。
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与运行期契约照常生效。
import { pruneRetainedGroups, pruneReportArtifacts, reportRetentionGroupKey } from "../../../scripts/report-retention.mjs"

const BASE = Date.parse("2026-10-02T10:00:00Z")

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "report-retention-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

/** 显式 mtime：连续写入常落在同一毫秒，并列的 mtime 会让淘汰顺序断言不稳定。 */
function write(dir: string, name: string, bytes: number, mtimeMs: number): void {
  writeFileSync(join(dir, name), "x".repeat(bytes))
  const seconds = mtimeMs / 1000
  utimesSync(join(dir, name), seconds, seconds)
}

function stamp(i: number): string {
  return `2026-10-02T10-00-${String(i).padStart(2, "0")}-000Z`
}

function listing(dir: string): string[] {
  return readdirSync(dir).sort()
}

describe("reportRetentionGroupKey", () => {
  it("报告本体取自身、两类卫星归父报告、非日期戳产物不参与 [report-retention-group-key]", () => {
    // 同一场报告的 json / html / 卫星共用一个组键（只留 stamp），不能把报告拆成两组各自淘汰。
    expect(reportRetentionGroupKey(`${stamp(1)}.json`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.html`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.json.review.json`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.txt.scored.json`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.json.scored-judge-a-abc123.json`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.json.scored-judge-a-abc123.html`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.json.hypotheses-abc123.jsonl`)).toBe(stamp(1))
    expect(reportRetentionGroupKey(`${stamp(1)}.json.verdicts-judge-a-abc123.jsonl`)).toBe(stamp(1))
    expect(reportRetentionGroupKey("caseids-unit.json")).toBeNull()
    expect(reportRetentionGroupKey("flaky.json")).toBeNull()
    // 基名不是日期戳的人工文件（如 notes.review.json）不属于保留体系
    expect(reportRetentionGroupKey("notes.review.json")).toBeNull()
  })
})

describe("pruneRetainedGroups", () => {
  it("保留最新三场、最老的组整组淘汰 [report-retention-newest-three]", () => {
    const dir = fixture()
    for (let i = 1; i <= 6; i++) write(dir, `${stamp(i)}.json`, 10, BASE + i * 1000)
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey })
    expect({ kept: result.kept, evicted: result.evicted }).toEqual({ kept: 3, evicted: [stamp(3), stamp(2), stamp(1)] })
    expect(listing(dir)).toEqual([4, 5, 6].map(i => `${stamp(i)}.json`))
  })

  it("同一场的 json 与 html 作为一个组一起保留或一起淘汰 [report-retention-json-html-pair]", () => {
    const dir = fixture()
    for (let i = 1; i <= 4; i++) {
      write(dir, `${stamp(i)}.json`, 10, BASE + i * 1000)
      write(dir, `${stamp(i)}.html`, 20, BASE + i * 1000 + 1)
    }
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey })
    expect(result.kept).toBe(3)
    expect(listing(dir)).toEqual([2, 3, 4].flatMap(i => [`${stamp(i)}.html`, `${stamp(i)}.json`]).sort())
  })

  it("外部判分的 JSON/HTML 卫星跟随原报告作为同一保留组 [report-retention-scored-satellite-pair]", () => {
    const dir = fixture()
    const scored = `${stamp(1)}.json.scored-judge-a-abc123`
    write(dir, `${stamp(1)}.json`, 10, BASE + 1000)
    write(dir, `${stamp(1)}.html`, 10, BASE + 1000)
    write(dir, `${scored}.json`, 10, BASE + 1001)
    write(dir, `${scored}.html`, 10, BASE + 1002)
    write(dir, `${stamp(1)}.json.verdicts-judge-a-abc123.jsonl`, 10, BASE + 1003)
    write(dir, `${stamp(1)}.json.hypotheses-abc123.jsonl`, 10, BASE + 1004)
    for (let i = 2; i <= 4; i++) write(dir, `${stamp(i)}.json`, 10, BASE + i * 1000)
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey })
    expect(result.evicted).toContain(stamp(1))
    expect(listing(dir).some(name => name.startsWith(`${stamp(1)}.`))).toBe(false)
    expect(result.kept).toBe(3)
  })

  it("最新一组即使单独超字节上限也恒留，其余组按上限淘汰 [report-retention-newest-kept-over-budget]", () => {
    const dir = fixture()
    write(dir, `${stamp(1)}.json`, 10, BASE + 1000)
    write(dir, `${stamp(2)}.json`, 10, BASE + 2000)
    write(dir, `${stamp(3)}.json`, 2000, BASE + 3000)
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey, maxBytes: 1000 })
    expect({ kept: result.kept, files: listing(dir) }).toEqual({ kept: 1, files: [`${stamp(3)}.json`] })
  })

  it("卫星计入组字节并与父报告同生共死 [report-retention-satellite-share-fate]", () => {
    const dir = fixture()
    write(dir, `${stamp(1)}.json`, 10, BASE + 1000)
    write(dir, `${stamp(1)}.json.review.json`, 90, BASE + 1500)
    write(dir, `${stamp(2)}.json`, 10, BASE + 2000)
    // 都在 3 场线内不淘汰，但字节必须含卫星：10 + 90 + 10 = 110
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey })
    expect(result.keptBytes).toBe(110)
    // 收紧到 1 组：父与卫星整组消失，不能留下无父的孤儿卫星
    pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey, maxGroups: 1 })
    expect(listing(dir)).toEqual([`${stamp(2)}.json`])
  })

  it("不参与淘汰的固定名产物原样保留 [report-retention-unmanaged-kept]", () => {
    const dir = fixture()
    write(dir, "caseids-unit.json", 10, BASE)
    write(dir, "flaky.json", 10, BASE)
    write(dir, "vitest-unit-attempt1.json", 10, BASE)
    for (let i = 1; i <= 6; i++) write(dir, `${stamp(i)}.json`, 10, BASE + i * 1000)
    const result = pruneRetainedGroups(dir, { groupKey: reportRetentionGroupKey })
    expect(result.evicted).toEqual([stamp(3), stamp(2), stamp(1)])
    expect(listing(dir)).toEqual([
      "caseids-unit.json", "flaky.json", "vitest-unit-attempt1.json",
      ...[4, 5, 6].map(i => `${stamp(i)}.json`),
    ].sort())
  })
})

describe("pruneReportArtifacts", () => {
  it("父报告缺失的孤儿审阅包被清除，有父的卫星保留 [report-retention-orphan-sweep]", () => {
    const dir = fixture()
    write(dir, `${stamp(1)}.json`, 10, BASE + 1000)
    write(dir, `${stamp(1)}.json.review.json`, 10, BASE + 1500)
    write(dir, `${stamp(9)}.json.review.json`, 10, BASE + 2000)
    write(dir, `${stamp(9)}.json.scored-judge-a-abc123.html`, 10, BASE + 2100)
    write(dir, `${stamp(9)}.json.verdicts-judge-a-abc123.jsonl`, 10, BASE + 2200)
    write(dir, `${stamp(9)}.json.hypotheses-abc123.jsonl`, 10, BASE + 2300)
    pruneReportArtifacts(dir)
    expect(listing(dir)).toEqual([`${stamp(1)}.json`, `${stamp(1)}.json.review.json`].sort())
  })
})
