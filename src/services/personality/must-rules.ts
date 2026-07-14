// ==========================================
// 必须遵守 — 解析/问候提取/Prompt 注入
// §6: 行为准则的多重消费
// ==========================================

export interface MustRules {
  /** 原始规则列表（全部条目） */
  all: string[]
  /** 激活问候语（可选） */
  greetings: string[] | null
  /** 工具相关条目 */
  toolRelated: string[]
}

/**
 * 解析 card.#必须遵守 section 的原始文本
 */
export function parseMustRules(raw: string): MustRules {
  const lines = raw
    .split("\n")
    .map(l => l.replace(/^\d+\.\s*/, "").replace(/^[-•*]\s*/, "").trim())
    .filter(l => l.length > 0)

  const greetings = parseGreetings(lines)

  const toolKeywords = ["完成", "报告", "工具", "结果", "执行", "操作"]
  const toolRelated = lines.filter(line =>
    toolKeywords.some(kw => line.includes(kw))
  )

  return { all: lines, greetings, toolRelated }
}

/** 解析激活问候：第一条含"激活"+"问候/打招呼"→引号内文本 */
function parseGreetings(rules: string[]): string[] | null {
  const rule = rules.find(r =>
    r.includes("激活") && (r.includes("问候") || r.includes("打招呼"))
  )
  if (!rule) return null
  const matches = rule.match(/[""]([^""]+?)[""]/g)
  if (!matches || matches.length === 0) return null
  return matches.map(m => m.replace(/^[""]|[""]$/g, ""))
}

/** 随机选一条激活问候 */
export function pickGreeting(greetings: string[] | null): string | null {
  if (!greetings || greetings.length === 0) return null
  return greetings[Math.floor(Math.random() * greetings.length)]
}

/** v5: 统一 Prompt 注入 — 行为准则全量 */
export function formatAllRules(rules: MustRules): string {
  if (rules.all.length === 0) return ""
  return "[行为准则]\n" + rules.all.map((r, i) => `${i + 1}. ${r}`).join("\n")
}
