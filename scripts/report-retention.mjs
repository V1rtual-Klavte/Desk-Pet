// 报告与 trace 的「组」保留核心：最近 N 组 + 累计字节上限 + 最新一组恒留。
// 保留单元是组（父报告 + 派生卫星 / bundle 的多个成员），不是单个文件 ——
// 父文件被淘汰时卫星必须同生共死，否则审阅/评分包会变成永远无法 apply 的孤儿
// （apply 必须重读父报告核验 dataset/collection hash —— outcome 变化经 collectionHash=digest(report) 拦截）。
// 命名知识留在调用方：报告与 bundle 各自的文件名形态由各自脚本给出 groupKey。

import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

export const RETENTION_MAX_GROUPS = 5
export const RETENTION_MAX_BYTES = 200 * 1024 * 1024

/** 日期戳报告本体：<stamp>.(json|txt|html) */
const REPORT_NAME = /^\d{4}-\d{2}-\d{2}T[\dTZ.-]+\.(?:json|txt|html)$/
/** 日期戳报告的派生卫星：<报告名>.review.json / <报告名>.scored.json */
const REPORT_SATELLITE = /^(\d{4}-\d{2}-\d{2}T[\dTZ.-]+\.(?:json|txt|html))\.(?:review|scored)\.json$/

/**
 * 报告保留体系的组键：本体取自身；两类卫星归到父报告名下；其余（caseids / flaky /
 * vitest-* 等固定名产物与人工文件）返回 null —— 不参与淘汰，也不计入字节。
 */
export function reportRetentionGroupKey(name) {
  if (REPORT_NAME.test(name)) return name
  const satellite = name.match(REPORT_SATELLITE)
  return satellite ? satellite[1] : null
}

/**
 * 按「组」淘汰：组 mtime 取成员最大值、组字节取成员总和；按 mtime 从新到旧，
 * 最新一组恒留（哪怕它单独超过上限，也不能删掉刚写出的证据），其余组需同时满足
 * 份数与字节上限才保留，落选组整组删除。组内先删长名的派生文件、父文件最后 ——
 * 这是体验优化，正确性不依赖删除顺序（中断残留的成员下次淘汰仍归同组）。
 * 返回 { kept, evicted, keptBytes }。
 */
export function pruneRetainedGroups(dir, { groupKey, maxGroups = RETENTION_MAX_GROUPS, maxBytes = RETENTION_MAX_BYTES }) {
  const groups = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const key = groupKey(entry.name)
    if (key === null || key === undefined) continue
    const stats = statSync(join(dir, entry.name))
    const group = groups.get(key) ?? { files: [], bytes: 0, mtimeMs: 0 }
    group.files.push(entry.name)
    group.bytes += stats.size
    if (stats.mtimeMs > group.mtimeMs) group.mtimeMs = stats.mtimeMs
    groups.set(key, group)
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
  let kept = 0
  let keptBytes = 0
  const evicted = []
  for (const [key, group] of ordered) {
    if (kept === 0 || (kept < maxGroups && keptBytes + group.bytes <= maxBytes)) {
      kept += 1
      keptBytes += group.bytes
      continue
    }
    for (const file of [...group.files].sort((a, b) => b.length - a.length)) {
      rmSync(join(dir, file), { force: true })
    }
    evicted.push(key)
  }
  return { kept, evicted, keptBytes }
}

/**
 * 报告池的完整淘汰：先清孤儿卫星，再按组淘汰。
 * 孤儿（父报告已不在的审阅/评分包）在下一次任何淘汰时无条件清除，不以上限触发为条件 ——
 * 它已经永远无法 apply，留着只会被误当作可续用的证据。
 */
export function pruneReportArtifacts(reportsDir) {
  const present = new Set(readdirSync(reportsDir))
  for (const name of present) {
    const satellite = name.match(REPORT_SATELLITE)
    if (satellite && !present.has(satellite[1])) rmSync(join(reportsDir, name), { force: true })
  }
  return pruneRetainedGroups(reportsDir, { groupKey: reportRetentionGroupKey })
}
