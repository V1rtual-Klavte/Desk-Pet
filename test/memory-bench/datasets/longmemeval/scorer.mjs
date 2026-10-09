// ==========================================
// LongMemEval 计分器（纯函数）
// ==========================================
//
// 结论分母来自计划执行的 selected cases，而不是恰好产出 outcome 的题数。
// assistant-only 仍计入所有题型总计；另提供产品用户事实子集与严格空工具子集。
// 检索指标是本仓适配口径，不等同官方 run_retrieval。

function emptyBucket() {
  return { cases: 0, judged: 0, correct: 0 }
}

function ratio(bucket) {
  return bucket && bucket.judged > 0 ? bucket.correct / bucket.judged : null
}

function addVerdict(bucket, judged, correct, countCase = true) {
  if (countCase) bucket.cases += 1
  if (judged) {
    bucket.judged += 1
    bucket.correct += correct ? 1 : 0
  }
}

function toolingClass(outcome) {
  if (!outcome) return "incomplete"
  const violations = outcome.protocolViolations
  const observedCalls = outcome.tooling?.observedCalls
  if (outcome.usedTools === true || violations?.length > 0 || observedCalls > 0) return "contaminated"
  if (outcome.status !== "complete") return "incomplete"
  if (outcome.usedTools !== false || !Array.isArray(violations) || violations.length !== 0
    || !Number.isInteger(observedCalls) || observedCalls !== 0 || outcome.tooling?.requestedMode !== "none") return "unknown"
  return "strict-empty"
}

/**
 * `cases` 是本次计划选择的题集；缺失 outcome 也计入题型/总题数，但不计入判分分母。
 * judgments 可由本地 judge 或外部逐题回填提供，内容只接受 adjudicated/correct。
 */
export function scoreLongMemEval(cases, outcomes, judgments = {}, plan = {}) {
  const plannedCountsByType = plan.plannedCountsByType ?? null
  const hasPlannedTypeCounts = plannedCountsByType !== null
  const abstentionCount = Number.isInteger(plan.abstentionCount) ? plan.abstentionCount : null
  const outcomesById = new Map(outcomes.map(outcome => [outcome.caseId, outcome]))
  const overall = emptyBucket()
  const regular = emptyBucket()
  const abstention = emptyBucket()
  const assistantOnly = emptyBucket()
  const productUserFactSubset = emptyBucket()
  const byType = new Map()
  if (hasPlannedTypeCounts) {
    for (const [questionType, count] of Object.entries(plannedCountsByType))
      byType.set(questionType, { questionType, cases: count, judged: 0, correct: 0 })
  }
  const unmappedType = emptyBucket()
  const unmappedAbstention = emptyBucket()
  const strict = { cases: cases.length, eligible: 0, judged: 0, correct: 0, contaminated: 0, unknown: 0,
    incomplete: 0, notCompleted: 0, unmappedTypeCases: 0 }
  const strictByType = new Map([...byType.entries()].map(([questionType, bucket]) => [questionType,
    { questionType, cases: bucket.cases, eligible: 0, judged: 0, correct: 0, contaminated: 0, unknown: 0, incomplete: 0, notCompleted: 0 }]))
  const rows = []
  const retrieval = { sessionRecalls: [], turnRecalls: [], assistantTurnRecalls: [], candidateSessionRecalls: [],
    withEvidence: 0, withGoldTurns: 0, withGoldAssistantTurns: 0 }
  const ingest = { registeredSources: 0, processedSources: 0, oversizedSources: 0, sweeps: 0 }
  let judgeFailures = 0

  for (const item of cases) {
    const outcome = outcomesById.get(item.caseId) ?? null
    const judgment = judgments[item.caseId] ?? outcome?.externalJudgment ?? outcome?.judgment ?? null
    const judged = judgment?.adjudicated === true && typeof judgment.correct === "boolean"
    const correct = judged && judgment.correct === true
    const questionType = typeof item.questionType === "string" ? item.questionType : null
    const assistant = questionType === "single-session-assistant"
    const productEligible = item.productUserFactEligible ?? (questionType === null ? null : !assistant)
    addVerdict(overall, judged, correct)
    if (item.abstention === true || item.abstention === false) {
      const abstentionBucket = item.abstention ? abstention : regular
      addVerdict(abstentionBucket, judged, correct, abstentionCount === null)
    } else {
      addVerdict(unmappedAbstention, judged, correct)
    }
    let typeBucket = questionType === null ? null : byType.get(questionType) ?? null
    if (questionType !== null && !typeBucket && !hasPlannedTypeCounts) {
      typeBucket = { questionType, ...emptyBucket() }
      byType.set(questionType, typeBucket)
    }
    if (typeBucket) addVerdict(typeBucket, judged, correct, !hasPlannedTypeCounts)
    else addVerdict(unmappedType, judged, correct)
    if (assistant) addVerdict(assistantOnly, judged, correct, !hasPlannedTypeCounts)
    if (productEligible === true) addVerdict(productUserFactSubset, judged, correct, !hasPlannedTypeCounts)

    const toolClass = toolingClass(outcome)
    let typeStrict = questionType === null ? null : strictByType.get(questionType) ?? null
    if (questionType !== null && !typeStrict && !hasPlannedTypeCounts) {
      typeStrict = { questionType, cases: 0, eligible: 0, judged: 0, correct: 0,
        contaminated: 0, unknown: 0, incomplete: 0, notCompleted: 0 }
      strictByType.set(questionType, typeStrict)
    }
    if (!typeStrict) strict.unmappedTypeCases += 1
    if (typeStrict && !hasPlannedTypeCounts) typeStrict.cases += 1
    if (!outcome || outcome.status !== "complete") {
      strict.notCompleted += 1
      if (typeStrict) typeStrict.notCompleted += 1
    }
    if (toolClass === "strict-empty") {
      strict.eligible += 1
      if (typeStrict) typeStrict.eligible += 1
      if (judged) {
        strict.judged += 1
        strict.correct += correct ? 1 : 0
        if (typeStrict) {
          typeStrict.judged += 1
          typeStrict.correct += correct ? 1 : 0
        }
      }
    } else {
      strict[toolClass] += 1
      if (typeStrict) typeStrict[toolClass] += 1
    }
    if (judgment && judgment.adjudicated === false && judgment.error) judgeFailures += 1

    const evidence = outcome?.evidence ?? []
    const renderedSessions = new Set(evidence.map(ref => ref.sessionId).filter(Boolean))
    const renderedTurns = new Set(evidence.filter(ref => ref.sessionId && Number.isInteger(ref.turnIndex))
      .map(ref => `${ref.sessionId}:${ref.turnIndex}`))
    if (renderedSessions.size > 0) retrieval.withEvidence += 1
    const goldSessions = item.answerSessionIds ?? []
    if (goldSessions.length > 0)
      retrieval.sessionRecalls.push(goldSessions.filter(id => renderedSessions.has(id)).length / goldSessions.length)
    const evidenceRole = turn => {
      const session = (item.sessions ?? []).find(candidate => candidate.sessionId === turn.sessionId)
      return session?.turns[turn.turnIndex]?.role === "user"
    }
    const goldTurns = (item.evidenceTurns ?? []).filter(evidenceRole)
    if (goldTurns.length > 0) {
      retrieval.withGoldTurns += 1
      retrieval.turnRecalls.push(goldTurns.filter(turn => renderedTurns.has(`${turn.sessionId}:${turn.turnIndex}`)).length / goldTurns.length)
    }
    const goldAssistantTurns = (item.evidenceTurns ?? []).filter(turn => {
      const session = (item.sessions ?? []).find(candidate => candidate.sessionId === turn.sessionId)
      return session?.turns[turn.turnIndex]?.role === "assistant"
    })
    if (goldAssistantTurns.length > 0) {
      retrieval.withGoldAssistantTurns += 1
      retrieval.assistantTurnRecalls.push(goldAssistantTurns.filter(turn => renderedTurns.has(`${turn.sessionId}:${turn.turnIndex}`)).length / goldAssistantTurns.length)
    }
    const candidateSessions = new Set(outcome?.candidateSessionIds ?? [])
    if (goldSessions.length > 0)
      retrieval.candidateSessionRecalls.push(goldSessions.filter(id => candidateSessions.has(id)).length / goldSessions.length)
    const stats = outcome?.ingest ?? {}
    ingest.registeredSources += stats.registeredSources ?? 0
    ingest.processedSources += stats.processedSources ?? 0
    ingest.oversizedSources += stats.oversizedSources ?? 0
    ingest.sweeps += stats.sweeps ?? 0
    const sessionRecall = goldSessions.length ? goldSessions.filter(id => renderedSessions.has(id)).length / goldSessions.length : null
    rows.push({ caseId: item.caseId, questionId: item.questionId, questionType,
      abstention: typeof item.abstention === "boolean" ? item.abstention : null,
      assistantOnly: questionType === null ? null : assistant, productUserFactEligible: productEligible,
      status: outcome?.status ?? "not-attempted", attempted: outcome !== null, judged,
      correct: judged ? correct : null, answer: outcome?.answer ?? null, evidenceCount: renderedSessions.size,
      sessionRecall, toolStatus: toolClass })
  }

  if (hasPlannedTypeCounts) {
    const assistantCases = plannedCountsByType["single-session-assistant"] ?? 0
    assistantOnly.cases = assistantCases
    productUserFactSubset.cases = Math.max(0, cases.length - assistantCases)
  }
  if (abstentionCount !== null) {
    abstention.cases = abstentionCount
    regular.cases = cases.length - abstentionCount
  }

  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const withAccuracy = bucket => ({ ...bucket, accuracy: ratio(bucket) })
  const strictByTypeRows = [...strictByType.values()].map(bucket => ({ ...bucket,
    accuracy: bucket.judged > 0 ? bucket.correct / bucket.judged : null }))

  return {
    cases: cases.length,
    completed: rows.filter(row => row.status === "complete").length,
    judgeFailures,
    overall: withAccuracy(overall),
    abstention: withAccuracy(abstention),
    regular: withAccuracy(regular),
    assistantOnly: { ...withAccuracy(assistantOnly), includedInOverall: true,
      note: "该题型计入全选中题集总计；只从附加的产品用户事实比较子集排除，不据此推断当前产品不可回答" },
    productUserFactSubset: { ...withAccuracy(productUserFactSubset),
      note: `按 LongMemEval 的 single-session-assistant 题型排除；这是用户来源事实的附加比较口径，不代表完整对话检索能力${unmappedType.cases ? `；${unmappedType.cases} 道题缺少逐题类型映射` : ""}` },
    byType: [...byType.values()].sort((left, right) => left.questionType.localeCompare(right.questionType))
      .map(withAccuracy),
    unmappedType: { ...unmappedType, note: "所选题集中的题型映射未知；不会按 requestedCaseIds 顺序或题号后缀猜测" },
    unmappedAbstention: { ...unmappedAbstention, note: "所选题集中的逐题 abstention 映射未知；cases 的总体分母可由报告 aggregate 计数提供" },
    strictEmptyTool: { ...strict, accuracy: strict.judged > 0 ? strict.correct / strict.judged : null,
      byType: strictByTypeRows,
      note: "仅 complete 且显式 usedTools=false、protocolViolations=[]、requestedMode=none、observedCalls=0 的题进入严格空工具基线；污染、未知与未完成题分别计数，notCompleted 是全选中题集里的未完成数" },
    retrieval: {
      sessionRecallMean: mean(retrieval.sessionRecalls), caseCount: retrieval.sessionRecalls.length,
      turnRecallMean: mean(retrieval.turnRecalls), turnCaseCount: retrieval.withGoldTurns,
      assistantTurnRecallMean: mean(retrieval.assistantTurnRecalls), assistantTurnCaseCount: retrieval.withGoldAssistantTurns,
      candidateSessionRecallMean: mean(retrieval.candidateSessionRecalls),
      evidenceHitRate: cases.length ? retrieval.withEvidence / cases.length : null,
      note: "本仓适配口径，非官方 run_retrieval 的 R@k；turnRecall 只统计 user 事实轮，assistantTurnRecall 统计 assistant 对话轮",
    },
    ingest, rows,
  }
}
