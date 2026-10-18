/**
 * 列项答案的确定性补全。
 *
 * 阅读器/列项抽取已经产出逐字校验过的直接项目，但主答仍可能只写其中一部分。
 * 这里只判断「最终可见正文是否已经包含该项目」，并把缺失项以最小后缀补到回答末尾：
 * 不重写主答、不推断、不引入抽取结果之外的项目。
 */

export interface EnumerationAnswerContext {
  /** 宿主逐字校验过的直接项目，按来源顺序。 */
  items: readonly string[]
  /** 原始用户问题，仅用于让补全后缀与回答语言一致。 */
  question?: string
}

const CJK = /[㐀-鿿぀-ヿ가-힯]/u

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** 空格、标点与符号不参与比较；用于兼容 "ice cream" / "icecream" 一类写法。 */
function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
}

function containsContiguous(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/** 最终回答是否已经直接写出该项目（不要求逐字相同，但要求语义片段真的出现）。 */
export function answerIncludesEnumerationItem(answer: string, item: string): boolean {
  const needle = item.trim()
  if (!needle) return true
  const itemCompact = compact(needle)
  if (!itemCompact) return true
  const answerCompact = compact(answer)
  // 中文没有词边界，直接比较去标点后的短语；项目本身来自原文，不会因去空格而误配。
  if (CJK.test(needle)) return answerCompact.includes(itemCompact)
  const itemTokens = tokens(needle)
  if (containsContiguous(tokens(answer), itemTokens)) return true
  // 模型常把 "icecream" 写成 "ice cream"（或相反）。只对足够长的短语启用
  // 去空格回退，避免短词 "cake" 命中 "cheesecake" 这类不同复合词。
  return itemCompact.length >= 5 && answerCompact.includes(itemCompact)
}

/** 最终回答尚未写出的项目，按来源顺序去重。 */
export function missingEnumerationItems(answer: string, items: readonly string[]): string[] {
  const seen = new Set<string>()
  const missing: string[] = []
  for (const raw of items) {
    const item = raw.trim()
    if (!item || answerIncludesEnumerationItem(answer, item)) continue
    const key = compact(item)
    if (seen.has(key)) continue
    seen.add(key)
    missing.push(item)
  }
  return missing
}

/** 最小补全后缀；保留主答原文，只补缺失项，并沿用问题/项目的语言。 */
export function enumerationAnswerSuffix(missing: readonly string[], question = ""): string {
  const items = missing.map(item => item.trim()).filter(Boolean)
  if (!items.length) return ""
  const cjk = CJK.test(question) || items.some(item => CJK.test(item))
  const separator = cjk ? "、" : ", "
  const prefix = cjk ? "补充：" : "Also: "
  const period = cjk ? "。" : "."
  return `\n\n${prefix}${items.join(separator)}${period}`
}
