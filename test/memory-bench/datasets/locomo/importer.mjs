// ==========================================
// LoCoMo 导入器（纯函数）
// ==========================================
//
// 上游：snap-research/locomo data/locomo10.json（CC BY-NC 4.0，非商用）。
// 数据实测口径（2026-10-03 核对）：
//   · 10 段对话，19–32 个会话；session 键按数字配对 _date_time；
//     conv-26 存在 16 个只有 _date_time 而没有正文的悬挂键（上游数据瑕疵），导入时忽略。
//   · QA 共 1986 条；category 5（对抗题）444 条只带 adversarial_answer 而没有 answer 字段。
//   · category：1 多跳 / 2 时序 / 3 开放域 / 4 单跳 / 5 对抗。
// 转换只做结构与字段归一，不改写正文。

export const LOCOMO_TRANSFORM_VERSION = "locomo10/1"

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 }

/** `1:56 pm on 8 May, 2023` → epoch ms（UTC 近似，只用于排序与日期命中）。 */
export function parseLocomoDate(text) {
  const match = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/.exec(String(text ?? "").trim())
  if (!match) return null
  const hour12 = Number(match[1])
  const minute = Number(match[2])
  const meridiem = match[3]
  const day = Number(match[4])
  const month = MONTHS[match[5].toLowerCase()]
  const year = Number(match[6])
  if (!month || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null
  const hour = meridiem === "pm" ? (hour12 % 12) + 12 : hour12 % 12
  return Date.UTC(year, month - 1, day, hour, minute)
}

export function locomoSessionNumbers(conversation) {
  return Object.keys(conversation)
    .map(key => /^session_(\d+)$/.exec(key)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter(value => Array.isArray(conversation[`session_${value}`]))
    .sort((left, right) => left - right)
}

/** 只保留有正文的 session，并核对每轮都带 dia_id / speaker / text。 */
export function importLocomoConversation(sample) {
  const sampleId = sample?.sample_id
  if (typeof sampleId !== "string" || !sampleId) throw new Error("LoCoMo 样本缺少 sample_id")
  const conversation = sample.conversation
  const sessions = locomoSessionNumbers(conversation).map(session => {
    const turns = conversation[`session_${session}`]
    const dateText = conversation[`session_${session}_date_time`]
    return {
      session,
      dateText: typeof dateText === "string" ? dateText : null,
      observedAt: parseLocomoDate(dateText),
      turns: turns.map(turn => {
        if (typeof turn?.dia_id !== "string" || typeof turn?.speaker !== "string" || typeof turn?.text !== "string")
          throw new Error(`${sampleId}/session_${session} 存在缺少 dia_id/speaker/text 的轮次`)
        return { speaker: turn.speaker, diaId: turn.dia_id, text: turn.text }
      }),
    }
  })
  return { sampleId, speakers: { a: conversation.speaker_a, b: conversation.speaker_b }, sessions }
}

export function importLocomoCase(sampleId, questionIndex, qa) {
  const category = Number(qa?.category)
  if (!Number.isInteger(category) || category < 1 || category > 5)
    throw new Error(`${sampleId}/qa[${questionIndex}] category 非法: ${qa?.category}`)
  if (typeof qa?.question !== "string" || !qa.question.trim())
    throw new Error(`${sampleId}/qa[${questionIndex}] 缺少 question`)
  const rawAnswer = qa.answer ?? qa.adversarial_answer
  if (rawAnswer === null || rawAnswer === undefined)
    throw new Error(`${sampleId}/qa[${questionIndex}] 缺少 answer/adversarial_answer（上游形状可能变化）`)
  const answer = String(rawAnswer)
  const evidence = Array.isArray(qa.evidence) ? qa.evidence.filter(item => typeof item === "string") : []
  return {
    caseId: `locomo-${sampleId}-q${String(questionIndex).padStart(4, "0")}`,
    sampleId,
    questionIndex,
    question: qa.question,
    answer,
    ...(qa.adversarial_answer !== undefined && qa.answer === undefined
      ? { adversarialAnswer: String(qa.adversarial_answer) } : {}),
    category,
    evidence,
  }
}

/** 校验并组装整份 LoCoMo 案例文件；errors 非空表示上游形状与预期不符。 */
export function buildLocomoFile(rawSamples, { upstream, license, transformVersion = LOCOMO_TRANSFORM_VERSION } = {}) {
  if (!Array.isArray(rawSamples) || rawSamples.length === 0) throw new Error("LoCoMo 原始数据必须是非空数组")
  const conversations = rawSamples.map(importLocomoConversation)
  const ids = new Set()
  for (const conversation of conversations) {
    if (ids.has(conversation.sampleId)) throw new Error(`LoCoMo sample_id 重复: ${conversation.sampleId}`)
    ids.add(conversation.sampleId)
  }
  const cases = []
  for (const sample of rawSamples) {
    const sampleId = sample.sample_id
    if (!Array.isArray(sample.qa) || sample.qa.length === 0) throw new Error(`${sampleId} 缺少 qa 列表`)
    sample.qa.forEach((qa, index) => { cases.push(importLocomoCase(sampleId, index, qa)) })
  }
  return {
    schemaVersion: "desk-pet-memory-bench-cases/v1",
    dataset: "locomo",
    split: "locomo10",
    importTransformVersion: transformVersion,
    upstream: upstream ?? null,
    license: license ?? null,
    selection: { policy: "full", caseCount: cases.length, note: "官方 locomo10.json 全量 10 段对话与 1986 条 QA" },
    conversations, cases,
  }
}

export function validateLocomoFile(file) {
  const errors = []
  if (file?.dataset !== "locomo") { errors.push("dataset 必须是 locomo"); return errors }
  if (!Array.isArray(file.conversations) || !Array.isArray(file.cases)) { errors.push("conversations/cases 必须是数组"); return errors }
  const samples = new Map(file.conversations.map(item => [item.sampleId, item]))
  const seen = new Set()
  for (const item of file.cases) {
    if (!samples.has(item.sampleId)) errors.push(`${item.caseId}: 引用了不存在的对话 ${item.sampleId}`)
    if (!Number.isInteger(item.category) || item.category < 1 || item.category > 5) errors.push(`${item.caseId}: category 非法`)
    if (typeof item.question !== "string" || !item.question) errors.push(`${item.caseId}: 缺少 question`)
    if (item.category !== 5 && typeof item.answer !== "string") errors.push(`${item.caseId}: 非对抗题必须有字符串 answer`)
    if (seen.has(item.caseId)) errors.push(`${item.caseId}: caseId 重复`)
    seen.add(item.caseId)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.caseId ?? "")) errors.push(`${item.caseId}: caseId 字符集非法`)
  }
  return errors
}
