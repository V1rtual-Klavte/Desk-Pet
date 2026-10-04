// ==========================================
// 重排结果校验（零依赖叶子）
// ==========================================
//
// 从 provider 拆出来单独放：它是不依赖 pi runtime / 会话存储的纯函数，
// 所以能在最便宜的层单独验证 —— 而这条校验正是「模型说了算」与「宿主说了算」的边界。

/**
 * 只认输入里出现过的 id，去重、保序。
 *
 * 模型可能返回未知 id、重复 id、被截断的 JSON 或一段解释文字 —— 一律按无效结果处理，
 * 由调用方回退本地顺序。空数组是合法结果（表示「这次没有值得用的记忆」）。
 */
export function parseRerankSelection(text: string, allowed: Iterable<string>): { valid: boolean; ids: string[] } {
  const known = allowed instanceof Set ? allowed : new Set(allowed)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { valid: false, ids: [] }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ids?: unknown })?.ids) ? (parsed as { ids: unknown[] }).ids : undefined
  if (!list) return { valid: false, ids: [] }
  const out: string[] = []
  for (const value of list) {
    if (typeof value !== "string" || !known.has(value) || out.includes(value)) continue
    out.push(value)
  }
  return { valid: true, ids: out }
}

export function parseRerankIds(text: string, allowed: Iterable<string>): string[] {
  return parseRerankSelection(text, allowed).ids
}
