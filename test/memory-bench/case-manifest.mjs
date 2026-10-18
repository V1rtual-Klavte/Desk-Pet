// ==========================================
// 基准固定题单 manifest
// ==========================================
//
// 分层抽样本身已由 seed 确定；manifest 把「这一次到底跑了哪 30 题」固化成可复用文件，
// 让改动前后的 A/B 用同一批 caseId。manifest 只记录题目身份与上游绑定，不记录答案或证据，
// 不进入生成输入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const BENCH_CASE_MANIFEST_SCHEMA_VERSION = "desk-pet-memory-bench-manifest/v1"

function assertCaseIds(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0)
    throw new Error("bench case manifest 的 caseIds 必须是非空数组")
  if (new Set(caseIds).size !== caseIds.length)
    throw new Error("bench case manifest 的 caseIds 不能重复")
  if (caseIds.some(caseId => typeof caseId !== "string" || caseId.length === 0))
    throw new Error("bench case manifest 的 caseIds 必须是非空字符串")
}

/** 校验固定题单；dataset/split 必须与本次运行一致，否则拒绝复用错题单。 */
export function validateBenchCaseManifest(value, { dataset, split }) {
  if (!value || typeof value !== "object") throw new TypeError("bench case manifest 必须是对象")
  if (value.schemaVersion !== BENCH_CASE_MANIFEST_SCHEMA_VERSION)
    throw new Error(`bench case manifest schemaVersion 不匹配: ${value.schemaVersion ?? "<empty>"}`)
  if (value.dataset !== dataset || value.split !== split)
    throw new Error(`bench case manifest 绑定 ${value.dataset}/${value.split}，与本次 ${dataset}/${split} 不一致`)
  assertCaseIds(value.caseIds)
  return value
}

export function readBenchCaseManifest(path, expected) {
  return validateBenchCaseManifest(JSON.parse(readFileSync(path, "utf8")), expected)
}

export function writeBenchCaseManifest(path, manifest) {
  assertCaseIds(manifest?.caseIds)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
