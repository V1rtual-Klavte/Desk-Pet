// 版本锁定清单与宿主注册表的一致性守卫：数据不进仓库后，锁文件是唯一的版本载体，
// 它和 runner 的 split 表漂移会让「装了却跑不了」或「跑了却不是锁定的那版」。
import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { BENCH_DATASETS } from "../../memory-bench/index.mjs"
import lock from "../../memory-bench/upstream-lock.json"

const MODULE_DIR = resolve(process.cwd(), "test", "memory-bench")

describe("upstream-lock 与宿主注册表一致性", () => {
  it("数据集与 split 键一一对应，defaultSplit 都指向已登记 split", () => {
    expect(Object.keys(lock.datasets).sort()).toEqual(Object.keys(BENCH_DATASETS).sort())
    for (const [dataset, entry] of Object.entries(BENCH_DATASETS) as Array<[string, { defaultSplit: string; splits: Record<string, unknown> }]>) {
      const locked = lock.datasets[dataset as keyof typeof lock.datasets]
      expect(Object.keys(entry.splits).sort()).toEqual(Object.keys(locked.splits).sort())
      expect(Object.keys(locked.splits)).toContain(locked.defaultSplit)
      expect(entry.defaultSplit).toBe(locked.defaultSplit)
    }
  })

  it("案例文件路径都在 cases/<dataset>/ 下，绝不指回仓库数据集目录 [bench-lock-no-vendored-data]", () => {
    for (const [dataset, entry] of Object.entries(lock.datasets)) {
      for (const [split, splitEntry] of Object.entries(entry.splits) as Array<[string, { caseFile: string; downloads: string[]; license: string; transformVersion: string }]>) {
        expect(splitEntry.caseFile.startsWith(`cases/${dataset}/`), `${dataset}/${split}`).toBe(true)
        expect(splitEntry.transformVersion.length).toBeGreaterThan(0)
        for (const name of splitEntry.downloads) expect(Object.keys(lock.downloads)).toContain(name)
        expect(Object.keys(lock.licenses)).toContain(splitEntry.license)
      }
    }
  })

  it("所有下载项都固定 revision 与 SHA-256，路径落在 raw/ 或 reference/ [bench-lock-pinned]", () => {
    for (const [name, entry] of Object.entries(lock.downloads)) {
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.url).toContain(entry.revision)
      expect(entry.path.startsWith("raw/") || entry.path.startsWith("reference/"), name).toBe(true)
    }
  })

  it("仓库内许可原文副本存在且与锁定的上游许可逐字节一致（CC BY-NC 合规红线） [bench-lock-license]", () => {
    for (const [name, license] of Object.entries(lock.licenses)) {
      const repoPath = join(MODULE_DIR, license.repoFile)
      expect(existsSync(repoPath), `${name}: ${license.repoFile}`).toBe(true)
      const digest = createHash("sha256").update(readFileSync(repoPath)).digest("hex")
      const downloadName = license.download as keyof typeof lock.downloads
      expect(digest, name).toBe(lock.downloads[downloadName].sha256)
    }
  })

  it("非商用数据在锁文件里显式标注（LoCoMo CC BY-NC-4.0）", () => {
    expect(lock.licenses.locomo.spdx).toBe("CC-BY-NC-4.0")
    expect(lock.licenses.locomo.nonCommercial).toBe(true)
    expect(lock.licenses.longmemeval.spdx).toBe("MIT")
    expect(lock.licenses.memorybank.spdx).toBe("MIT")
  })
})
