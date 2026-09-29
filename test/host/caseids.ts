// 跨层 caseId 收集：L2/L3 的 caseId 写在 vitest 测试名末尾的 [caseId] 标记里。
// 用测试名而不是注释，是因为测试名会进 vitest 报告 —— 契约校验和报告读的是同一份真相。
//
// 标记形状与 `test/e2e/dataset.ts` 的 caseId 校验（`/^[a-z0-9][a-z0-9-]*$/`）一致：
// 同一个 caseId 在 L2 与 L4 必须是同一个字母表，否则「跨层核对」核对的是两套 id。

/**
 * 末尾的 `[caseId]` 标记。
 *
 * 只接受「全小写 kebab-case、且真的在字符串末尾（其后仅允许空白）」这一种形态：
 * - 不在末尾的方括号可能是测试文案（`"[mock] 回复…"`），不是锚点；
 * - `\s*$` 是为了放行 vitest 全名里可能出现的尾随换行/空格，不是为了让标记漂在中间。
 */
const MARKER = /\[([a-z0-9][a-z0-9-]*)\]\s*$/

/**
 * 从 vitest 测试全名（`describe > it` 的拼接结果）里取出 caseId。
 *
 * 没有标记时返回 `undefined` —— 不从文件名、describe 名或任何别的字面量猜：
 * 猜出来的 caseId 会让契约校验拿一个并不存在的 id 去核对，产生假通过。
 */
export function extractCaseId(fullTestName: string): string | undefined {
  return MARKER.exec(fullTestName)?.[1]
}

/**
 * 重复 caseId 是硬错误：按 caseId 建索引时后来的条目会静默压掉先出现的，
 * 旧的那条不再跑而报告照样全绿。错误信息必须列出具体是哪些 id 重复。
 */
export function assertNoDuplicates(ids: readonly string[]): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  if (duplicates.size > 0) {
    throw new Error(`caseId 重复（后者会静默覆盖前者）：${[...duplicates].join(", ")}`)
  }
}
