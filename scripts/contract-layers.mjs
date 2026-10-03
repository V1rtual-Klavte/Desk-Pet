// 跨层 caseId 门禁的纯函数核心（无文件 I/O）：
//   契约声明（test/contracts/*.contract.ts 的 coverage.scenarios）
//   × 三层实现（unit / integration 的 caseids-*.json，e2e 的本次报告场景集）
//   → missing（声明了没人实现）/ orphan（实现了没声明）/ duplicates（两层重复携带）。
//
// 读文件、打印明细与退出码留给调用方（scripts/e2e-test.mjs 的全量运行收尾路径）；
// 纯函数让 test/unit/contract-layers 可以直接构造输入。
//
// 为什么在 Node 侧收口：L4 的 caseId 只存在于运行期报告（浏览器把结果写盘后的文件），
// 快层 reporter（test/host/caseid-reporter.ts）只拿得到当层集合，其 checkLayerCoverage
// 的 CROSS-LAYER 分支因此没有「同时拿到两层」的调用方；caseids-*.json 也只是落盘没人读。

/** 三层的固定顺序：快层 → L4。 */
export const TEST_LAYERS = ["unit", "integration", "e2e"]

/**
 * 从一份 Contract 源码提取 coverage 声明的全部 caseId。
 *
 * 与 scripts/e2e-test.mjs 的 checkContractHashes 同一读法：正则读文本，不 import TS、
 * 不起解析器。键名兼容 `scenarios:` 与 `"scenarios":` 两种写法（现有契约两种都在用）；
 * 值只取双引号字面量 —— caseId 是小写 kebab-case，字母表里没有引号，数组里也不会出现 `]`。
 */
export function extractContractCaseIds(source) {
  const ids = []
  for (const match of source.matchAll(/["']?scenarios["']?\s*:\s*\[([^\]]*)\]/g)) {
    for (const id of match[1].matchAll(/"([^"]+)"/g)) ids.push(id[1])
  }
  return ids
}

/**
 * 声明集合与三层实现集合的对账。
 *
 * 输入：
 * - `declared`：全部 Contract coverage 声明的 caseId（可重复，内部去重）
 * - `implemented`：`{ unit?, integration?, e2e? }`，各层**本次真实收集到**的 caseId；
 *   未提供的层不参与判定（与 checkLayerCoverage 的「缺的层不判定」同一约定）。
 *
 * 输出（明细已排序）：
 * - `missing`：声明了、但没有任何被提供的层携带
 * - `orphan`：`{ caseId, layers }` —— 某层携带了、却没有任何 coverage 声明
 * - `duplicates`：`{ caseId, layers }` —— 同一个 caseId 被两层同时携带，违反跨层唯一性
 *   （对应 checkLayerCoverage 的 CROSS-LAYER 规则；快层逐层运行时它没有订阅者）
 */
export function compareCaseIdLayers({ declared = [], implemented = {} } = {}) {
  const declaredSet = new Set(declared)
  const ownersById = new Map()
  for (const layer of TEST_LAYERS) {
    const ids = implemented?.[layer]
    if (!ids) continue
    // 层内重复按一个算：跨层唯一性判的是「两层」，不是同一个 id 在数组里出现两次。
    for (const caseId of new Set(ids)) ownersById.set(caseId, [...(ownersById.get(caseId) ?? []), layer])
  }
  const missing = [...declaredSet].filter(caseId => !ownersById.has(caseId)).sort()
  const orphan = []
  const duplicates = []
  for (const [caseId, layers] of ownersById) {
    if (!declaredSet.has(caseId)) orphan.push({ caseId, layers })
    if (layers.length > 1) duplicates.push({ caseId, layers })
  }
  const byCaseId = (a, b) => a.caseId.localeCompare(b.caseId)
  orphan.sort(byCaseId)
  duplicates.sort(byCaseId)
  return { missing, orphan, duplicates }
}

/** 明细 → stderr 行；无问题时返回空数组（空数组代表无问题，不打印）。 */
export function formatCaseIdLayerIssues({ missing = [], orphan = [], duplicates = [] } = {}) {
  return [
    ...missing.map(caseId => `[MISSING] ${caseId}：契约声明了它，但三层都没有测试携带`),
    ...orphan.map(({ caseId, layers }) => `[ORPHAN] ${caseId}：由 ${layers.join("/")} 层携带，但没有任何 coverage point 声明`),
    ...duplicates.map(({ caseId, layers }) => `[CROSS-LAYER] ${caseId}：被 ${layers.join(" 与 ")} 层同时携带（跨层唯一性）`),
  ]
}
