// ==========================================
// MemoryBank cn 导入器（纯函数）
// ==========================================
//
// 上游：zhongwanjun/MemoryBank-SiliconFriend eval_data/cn（MIT，AAAI 2024）。实测字段（2026-10-03 核对）：
//   · memory_bank_cn.json：15 个角色，键为人名；每人 {history: {日期 → [{query, response}]},
//     meta_information{name, personality, hobbies, speaking_style}, ...}；
//   · probing_questions_cn.jsonl：15 行，每行 {人名: [问题…]}，合计 100 道探测题；
//     **没有官方金标答案**（仓库没有可判分的预期回答），因此正确率只能走独立 judge，
//     确定性指标只覆盖「检索到证据 / 命中题面日期线索」。
// personaIndex 按人名字典序编号，保证 caseId 与重生成顺序稳定；正文不改写。

export const MEMORYBANK_TRANSFORM_VERSION = "membank-cn/1"

export function parseMemoryBankDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim())
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function importMemoryBankPersona(name, raw) {
  const history = raw?.history
  if (!history || typeof history !== "object" || Array.isArray(history)) throw new Error(`${name}: 缺少 history`)
  const dates = Object.keys(history).sort((left, right) => {
    const leftValue = parseMemoryBankDate(left)
    const rightValue = parseMemoryBankDate(right)
    if (leftValue === null || rightValue === null) return left.localeCompare(right)
    return leftValue - rightValue
  })
  const days = dates.map(date => {
    const observedAt = parseMemoryBankDate(date)
    if (observedAt === null) throw new Error(`${name}: history 日期无法解析: ${date}`)
    const turns = history[date]
    if (!Array.isArray(turns)) throw new Error(`${name}/${date}: 轮次不是数组`)
    return {
      date, observedAt,
      turns: turns.map((turn, turnIndex) => {
        if (typeof turn?.query !== "string" || !turn.query.trim()) throw new Error(`${name}/${date}#${turnIndex}: query 非法`)
        if (typeof turn?.response !== "string") throw new Error(`${name}/${date}#${turnIndex}: response 非法`)
        return { query: turn.query, response: turn.response, turnIndex }
      }),
    }
  })
  const meta = raw?.meta_information ?? {}
  return {
    name,
    metaInformation: {
      personality: typeof meta.personality === "string" ? meta.personality : null,
      hobbies: typeof meta.hobbies === "string" ? meta.hobbies : null,
      speakingStyle: typeof meta.speaking_style === "string" ? meta.speaking_style : null,
    },
    days,
  }
}

export function importMemoryBankProbingQuestions(questionsByPersona) {
  const cases = []
  for (const persona of Object.keys(questionsByPersona)) {
    const questions = questionsByPersona[persona]
    if (!Array.isArray(questions)) throw new Error(`${persona}: 探测题不是数组`)
    questions.forEach((question, questionIndex) => {
      if (typeof question !== "string" || !question.trim()) throw new Error(`${persona}#${questionIndex}: 探测题非法`)
    })
    cases.push({ persona, questions })
  }
  return cases
}

export function buildMemoryBankFile(rawPersonas, rawProbingLines, { upstream, license, transformVersion = MEMORYBANK_TRANSFORM_VERSION } = {}) {
  if (!rawPersonas || typeof rawPersonas !== "object") throw new Error("MemoryBank 角色数据必须是对象")
  const names = Object.keys(rawPersonas).sort()
  if (names.length === 0) throw new Error("MemoryBank 角色数据为空")
  const probingByPersona = {}
  for (const line of rawProbingLines) {
    if (!line || typeof line !== "object") throw new Error("探测题行必须是对象")
    for (const [persona, questions] of Object.entries(line)) {
      if (probingByPersona[persona]) throw new Error(`探测题重复出现角色: ${persona}`)
      probingByPersona[persona] = questions
    }
  }
  const personas = names.map(name => importMemoryBankPersona(name, rawPersonas[name]))
  const indexByName = new Map(names.map((name, index) => [name, index]))
  const importedQuestions = importMemoryBankProbingQuestions(probingByPersona)
  for (const item of importedQuestions)
    if (!indexByName.has(item.persona)) throw new Error(`探测题引用了不存在的角色: ${item.persona}`)
  const cases = []
  for (const item of importedQuestions) {
    const index = indexByName.get(item.persona)
    item.questions.forEach((question, questionIndex) => {
      cases.push({ caseId: `membank-cn-p${String(index + 1).padStart(2, "0")}-q${String(questionIndex + 1).padStart(2, "0")}`,
        persona: item.persona, personaIndex: index + 1, questionIndex, question })
    })
  }
  return {
    schemaVersion: "desk-pet-memory-bench-cases/v1",
    dataset: "memorybank",
    split: "cn",
    importTransformVersion: transformVersion,
    upstream: upstream ?? null,
    license: license ?? null,
    selection: { policy: "full", caseCount: cases.length, personaCount: personas.length,
      note: "上游 eval_data/cn 全量：15 个角色、100 道人工探测题（无官方金标答案）" },
    personas, cases,
  }
}

export function validateMemoryBankFile(file) {
  const errors = []
  if (file?.dataset !== "memorybank") { errors.push("dataset 必须是 memorybank"); return errors }
  if (!Array.isArray(file.personas) || file.personas.length === 0) { errors.push("personas 必须是非空数组"); return errors }
  if (!Array.isArray(file.cases) || file.cases.length === 0) { errors.push("cases 必须是非空数组"); return errors }
  const names = new Set(file.personas.map(persona => persona.name))
  const seen = new Set()
  for (const item of file.cases) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(item.caseId ?? "")) errors.push(`${item.caseId}: caseId 字符集非法`)
    if (seen.has(item.caseId)) errors.push(`${item.caseId}: caseId 重复`)
    seen.add(item.caseId)
    if (!names.has(item.persona)) errors.push(`${item.caseId}: 引用了不存在的角色 ${item.persona}`)
    if (typeof item.question !== "string" || !item.question.trim()) errors.push(`${item.caseId}: 缺少探测题`)
  }
  return errors
}
