// ==========================================
// Porter stemmer（Porter 1980）— LoCoMo 官方 F1 的移植组件
// ==========================================
//
// LoCoMo 官方判分 task_eval/evaluation.py 用 NLTK PorterStemmer 对 token 做词干化。
// 本仓不引入 Python/NLTK 依赖，按原始论文算法移植；口径为「经典 Porter（mode_original）」，
// 与 NLTK 默认模式一致，但实现独立 —— 报告口径记为「本仓适配」，不冒充官方实现。
// 论文测试词表（caresses/ponies/… 与 relational/conditional/… 等）在单测中逐条核对。

const VOWELS = new Set(["a", "e", "i", "o", "u"])

function isConsonant(word, index) {
  const ch = word[index]
  if (VOWELS.has(ch)) return false
  // y 在前一位是辅音时按元音处理（如 "sky" 的 y 是元音，词干长度条件成立）
  if (ch === "y") return index === 0 ? true : !isConsonant(word, index - 1)
  return true
}

/** 连续辅音-元音序列的度量 m：VC 序列的个数。 */
function measure(word) {
  let count = 0
  let index = 0
  while (index < word.length) {
    if (!isConsonant(word, index)) break
    index += 1
  }
  while (index < word.length) {
    while (index < word.length && isConsonant(word, index)) index += 1
    if (index >= word.length) break
    count += 1
    while (index < word.length && !isConsonant(word, index)) index += 1
  }
  return count
}

function containsVowel(word) {
  return [...word].some((_, index) => !isConsonant(word, index))
}

/** 词干以「辅音+元音+辅音」结尾，且最后一个辅音不是 w/x/y。 */
function endsCVC(word) {
  const length = word.length
  if (length < 3) return false
  if (!isConsonant(word, length - 1) || isConsonant(word, length - 2) || !isConsonant(word, length - 3)) return false
  return !["w", "x", "y"].includes(word[length - 1])
}

function cvcAdjust(word) {
  return measure(word) === 1 && endsCVC(word) ? `${word}e` : word
}

function step1a(word) {
  if (word.endsWith("sses")) return word.slice(0, -2)
  if (word.endsWith("ies")) return word.slice(0, -2)
  if (word.endsWith("ss")) return word
  if (word.endsWith("s")) return word.slice(0, -1)
  return word
}

function step1b(word) {
  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3)
    return measure(stem) > 0 ? `${stem}ee` : word
  }
  let stem = null
  if (word.endsWith("ed")) {
    stem = word.slice(0, -2)
    if (!containsVowel(stem)) stem = null
  } else if (word.endsWith("ing")) {
    stem = word.slice(0, -3)
    if (!containsVowel(stem)) stem = null
  }
  if (stem === null) return word
  if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) return `${stem}e`
  if (/(.)\1$/.test(stem) && !["l", "s", "z"].includes(stem[stem.length - 1])) return stem.slice(0, -1)
  return cvcAdjust(stem)
}

function step1c(word) {
  if (word.endsWith("y") && containsVowel(word.slice(0, -1))) return `${word.slice(0, -1)}i`
  return word
}

const STEP2_RULES = [
  { suffix: "ational", replacement: "ate", min: 0 }, { suffix: "tional", replacement: "tion", min: 0 },
  { suffix: "enci", replacement: "ence", min: 0 }, { suffix: "anci", replacement: "ance", min: 0 },
  { suffix: "izer", replacement: "ize", min: 0 }, { suffix: "bli", replacement: "ble", min: 0 },
  { suffix: "alli", replacement: "al", min: 0 }, { suffix: "entli", replacement: "ent", min: 0 },
  { suffix: "eli", replacement: "e", min: 0 }, { suffix: "ousli", replacement: "ous", min: 0 },
  { suffix: "ization", replacement: "ize", min: 0 }, { suffix: "ation", replacement: "ate", min: 0 },
  { suffix: "ator", replacement: "ate", min: 0 }, { suffix: "alism", replacement: "al", min: 0 },
  { suffix: "iveness", replacement: "ive", min: 0 }, { suffix: "fulness", replacement: "ful", min: 0 },
  { suffix: "ousness", replacement: "ous", min: 0 }, { suffix: "aliti", replacement: "al", min: 0 },
  { suffix: "iviti", replacement: "ive", min: 0 }, { suffix: "biliti", replacement: "ble", min: 0 },
  { suffix: "logi", replacement: "log", min: 0 },
]

function step2(word) {
  for (const rule of STEP2_RULES) {
    if (word.endsWith(rule.suffix)) {
      const stem = word.slice(0, word.length - rule.suffix.length)
      return measure(stem) > 0 ? `${stem}${rule.replacement}` : word
    }
  }
  return word
}

const STEP3_RULES = [
  { suffix: "icate", replacement: "ic" }, { suffix: "ative", replacement: "" },
  { suffix: "alize", replacement: "al" }, { suffix: "iciti", replacement: "ic" },
  { suffix: "ical", replacement: "ic" }, { suffix: "ful", replacement: "" },
  { suffix: "ness", replacement: "" },
]

function step3(word) {
  for (const rule of STEP3_RULES) {
    if (word.endsWith(rule.suffix)) {
      const stem = word.slice(0, word.length - rule.suffix.length)
      return measure(stem) > 0 ? `${stem}${rule.replacement}` : word
    }
  }
  return word
}

const STEP4_SUFFIXES = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent",
  "ou", "ism", "ate", "iti", "ous", "ive", "ize"]

function step4(word) {
  // "ion" 只在词干以 s/t 结尾时删除
  if (word.endsWith("ion")) {
    const stem = word.slice(0, -3)
    if (measure(stem) > 1 && (stem.endsWith("s") || stem.endsWith("t"))) return stem
    return word
  }
  for (const suffix of STEP4_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, word.length - suffix.length)
      return measure(stem) > 1 ? stem : word
    }
  }
  return word
}

function step5a(word) {
  if (word.endsWith("e")) {
    const stem = word.slice(0, -1)
    if (measure(stem) > 1 || (measure(stem) === 1 && !endsCVC(stem))) return stem
  }
  return word
}

function step5b(word) {
  if (word.endsWith("ll") && measure(word) > 1) return word.slice(0, -1)
  return word
}

/** 对单个英文 token 求词干；非字母输入原样返回。 */
export function porterStem(word) {
  if (word.length <= 2) return word
  let result = word.toLowerCase()
  result = step1a(result)
  result = step1b(result)
  result = step1c(result)
  result = step2(result)
  result = step3(result)
  result = step4(result)
  result = step5a(result)
  result = step5b(result)
  return result
}
