// ==========================================
// LongMemEval 导入器（纯函数）
// ==========================================
//
// 上游：xiaowu0162/longmemeval-cleaned（MIT，ICLR 2025）。实测字段（2026-10-03 核对）：
//   · question_id / question_type / question / answer / question_date /
//     answer_session_ids / haystack_sessions / haystack_dates / haystack_session_ids；
//   · haystack_sessions[i] 是与 haystack_dates[i]、haystack_session_ids[i] 对齐的轮次数组，
//     每轮 {role, content, has_answer}；_abs 弃权题以 question_id 后缀标记。
// 转换只做结构与字段归一，不改写正文；turnIndex 是会话内 0 基下标，作为来源/证据的稳定坐标。

export const LME_TRANSFORM_VERSION = "lme-clean/1"
export const LME_SUBSET_POLICY = "coverage-v1"

/** `2023/04/10 (Mon) 17:50` → epoch ms（UTC 解析，只用于排序与时间锚点）。 */
export function parseLmeDate(text) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(([A-Za-z]{3})\) (\d{2}):(\d{2})$/.exec(String(text ?? "").trim())
  if (!match) return null
  const [, year, month, day, , hour, minute] = match
  const value = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return Number.isFinite(value) ? value : null
}

/**
 * 题目基准日的「今天」锚点（LongMemEval 官方协议以 `question_date` 为当前日期）。
 *
 * 必须按**本地墙钟**构造：上游时间串（`2023/05/01 (Mon) 03:56`）是用户当地时间，
 * 尾随注记也用本机时区格式化；拿 `parseLmeDate` 的 UTC 毫秒直接 toLocal 会在非 UTC
 * 机器上整体平移（上海 +8h，可跨日）。形状不符时抛错而不是静默回退真实时钟 ——
 * 静默回退会让相对日期题再次被真实时钟系统性污染，且无任何痕迹。
 */
export function questionTimeAnchor(questionDate) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(String(questionDate ?? "").trim())
  if (!match) throw new Error(`LongMemEval question_date 无法解析为时间锚点: ${JSON.stringify(questionDate)}`)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
}

export function importLongMemEvalQuestion(raw) {
  const questionId = raw?.question_id
  if (typeof questionId !== "string" || !questionId) throw new Error("LongMemEval 条目缺少 question_id")
  const questionType = raw?.question_type
  if (typeof questionType !== "string" || !questionType) throw new Error(`${questionId}: 缺少 question_type`)
  if (typeof raw?.question !== "string" || !raw.question.trim()) throw new Error(`${questionId}: 缺少 question`)
  if (raw?.answer === undefined || raw.answer === null) throw new Error(`${questionId}: 缺少 answer`)
  const sessions = raw.haystack_sessions
  const dates = raw.haystack_dates
  const sessionIds = raw.haystack_session_ids
  if (!Array.isArray(sessions) || !Array.isArray(dates) || !Array.isArray(sessionIds)
    || sessions.length !== dates.length || sessions.length !== sessionIds.length)
    throw new Error(`${questionId}: haystack_sessions/dates/session_ids 长度不一致`)
  const normalizedSessions = sessions.map((turns, index) => {
    const sessionId = sessionIds[index]
    if (typeof sessionId !== "string" || !sessionId) throw new Error(`${questionId}: haystack_session_ids[${index}] 非法`)
    const observedAt = parseLmeDate(dates[index])
    if (observedAt === null) throw new Error(`${questionId}: haystack_dates[${index}] 无法解析: ${dates[index]}`)
    if (!Array.isArray(turns)) throw new Error(`${questionId}/${sessionId}: 轮次不是数组`)
    return {
      sessionId,
      date: dates[index],
      observedAt,
      turns: turns.map((turn, turnIndex) => {
        if (typeof turn?.content !== "string" || typeof turn?.role !== "string")
          throw new Error(`${questionId}/${sessionId}#${turnIndex}: 轮次缺 role/content`)
        return { role: turn.role, content: turn.content, hasAnswer: turn.has_answer === true, turnIndex }
      }),
    }
  })
  const sessionSet = new Set(normalizedSessions.map(session => session.sessionId))
  const answerSessionIds = Array.isArray(raw.answer_session_ids)
    ? raw.answer_session_ids.filter(id => typeof id === "string") : []
  for (const id of answerSessionIds) if (!sessionSet.has(id))
    throw new Error(`${questionId}: answer_session_ids 引用了不存在的会话 ${id}`)
  const evidenceTurns = []
  for (const session of normalizedSessions) for (const turn of session.turns)
    if (turn.hasAnswer) evidenceTurns.push({ sessionId: session.sessionId, turnIndex: turn.turnIndex })
  return {
    questionId,
    questionType,
    abstention: questionId.includes("_abs"),
    question: raw.question,
    questionDate: typeof raw.question_date === "string" ? raw.question_date : null,
    questionObservedAt: parseLmeDate(raw.question_date),
    answer: String(raw.answer),
    answerSessionIds,
    evidenceTurns,
    sessions: normalizedSessions,
  }
}

/**
 * 子集选择（确定性）：按题型分桶，在「弃权 / 非弃权」两组里等距抽题。
 * 目标见 LME_SUBSET_TARGETS：52 题，覆盖全部 6 类题型，其中 10 道 _abs（上游可用的弃权题分布）。
 */
export const LME_SUBSET_TARGETS = Object.freeze({
  "single-session-user": { total: 8, abstention: 2 },
  "single-session-assistant": { total: 8, abstention: 0 },
  "single-session-preference": { total: 4, abstention: 0 },
  "multi-session": { total: 12, abstention: 3 },
  "temporal-reasoning": { total: 12, abstention: 3 },
  "knowledge-update": { total: 8, abstention: 2 },
})

function pickEvenly(sortedIds, count) {
  if (count <= 0) return []
  if (count >= sortedIds.length) return [...sortedIds]
  const picked = []
  for (let index = 0; index < count; index += 1)
    picked.push(sortedIds[Math.floor((index + 0.5) * sortedIds.length / count)])
  return picked
}

export function selectLongMemEvalSubset(cases, targets = LME_SUBSET_TARGETS) {
  const byType = new Map()
  for (const item of cases) {
    const bucket = byType.get(item.questionType) ?? { abstention: [], regular: [] }
    ;(item.abstention ? bucket.abstention : bucket.regular).push(item.questionId)
    byType.set(item.questionType, bucket)
  }
  const selected = []
  for (const [questionType, target] of Object.entries(targets)) {
    const bucket = byType.get(questionType)
    if (!bucket) throw new Error(`子集选择：上游没有题型 ${questionType}`)
    if (bucket.abstention.length < target.abstention)
      throw new Error(`子集选择：${questionType} 弃权题不足（需要 ${target.abstention}，实际 ${bucket.abstention.length}），上游版本可能变化`)
    const regularCount = target.total - target.abstention
    if (bucket.regular.length < regularCount)
      throw new Error(`子集选择：${questionType} 常规题不足（需要 ${regularCount}，实际 ${bucket.regular.length}）`)
    const ids = [...pickEvenly([...bucket.regular].sort(), regularCount),
      ...pickEvenly([...bucket.abstention].sort(), target.abstention)]
    selected.push(...ids.sort())
  }
  return selected.sort()
}

/** 案例文件按题型轮转排列：`--bench-limit N` 截断时不会只命中单一题型。 */
function interleaveByType(cases) {
  const byType = new Map()
  for (const item of cases) {
    const bucket = byType.get(item.questionType) ?? []
    bucket.push(item)
    byType.set(item.questionType, bucket)
  }
  const queues = [...byType.keys()].sort().map(key => byType.get(key))
  const ordered = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const queue of queues) if (queue.length > 0) { ordered.push(queue.shift()); progressed = true }
  }
  return ordered
}

export function buildLongMemEvalFile(rawQuestions, { split, splitSlug, selectionPolicy = LME_SUBSET_POLICY,
  upstream, license, transformVersion = LME_TRANSFORM_VERSION, caseIds } = {}) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) throw new Error("LongMemEval 原始数据必须是非空数组")
  const all = rawQuestions.map(importLongMemEvalQuestion)
  const ids = caseIds ?? selectLongMemEvalSubset(all)
  const byId = new Map(all.map(item => [item.questionId, item]))
  const cases = interleaveByType(ids.map(questionId => {
    const item = byId.get(questionId)
    if (!item) throw new Error(`子集清单引用了不存在的 question_id: ${questionId}`)
    return { ...item, caseId: `lme-${splitSlug}-${questionId}` }
  }))
  const seen = new Set()
  for (const item of cases) {
    if (seen.has(item.caseId)) throw new Error(`caseId 重复: ${item.caseId}`)
    seen.add(item.caseId)
  }
  return {
    schemaVersion: "desk-pet-memory-bench-cases/v1",
    dataset: "longmemeval",
    split,
    importTransformVersion: transformVersion,
    upstream: upstream ?? null,
    license: license ?? null,
    selection: { policy: selectionPolicy, caseCount: cases.length,
      countsByType: cases.reduce((acc, item) => { acc[item.questionType] = (acc[item.questionType] ?? 0) + 1; return acc }, {}),
      abstentionCount: cases.filter(item => item.abstention).length, caseIds: cases.map(item => item.caseId) },
    cases,
  }
}

export function validateLongMemEvalFile(file) {
  const errors = []
  if (file?.dataset !== "longmemeval") { errors.push("dataset 必须是 longmemeval"); return errors }
  if (!Array.isArray(file.cases) || file.cases.length === 0) { errors.push("cases 必须是非空数组"); return errors }
  const seen = new Set()
  for (const item of file.cases) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(item.caseId ?? "")) errors.push(`${item.caseId}: caseId 字符集非法`)
    if (seen.has(item.caseId)) errors.push(`${item.caseId}: caseId 重复`)
    seen.add(item.caseId)
    if (!Array.isArray(item.sessions) || item.sessions.length === 0) errors.push(`${item.caseId}: 缺少会话`)
    if (item.abstention !== (String(item.questionId).includes("_abs"))) errors.push(`${item.caseId}: abstention 标记与 question_id 不一致`)
    const sessionIds = new Set((item.sessions ?? []).map(session => session.sessionId))
    for (const id of item.answerSessionIds ?? []) if (!sessionIds.has(id)) errors.push(`${item.caseId}: answer_session_ids 引用未知会话 ${id}`)
  }
  return errors
}
