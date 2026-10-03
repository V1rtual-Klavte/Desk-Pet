// ==========================================
// LongMemEval 计分器（纯函数）
// ==========================================
//
// 两层口径分开报告：
//   1. 结论正确率：由仓内 judge（官方 evaluate_qa.py 的 5 套模板）给出，judge 未裁决的 case 不计入分母；
//   2. 检索指标：与答案无关的确定性证据口径 ——
//      · sessionRecall：渲染进 Prompt 的记忆来源覆盖了多少 gold answer_session_ids；
//      · turnRecall：覆盖了多少 has_answer 轮次（assistant 证据轮不参与，产品只登记 user 来源）；
//      · candidateSessionRecall：候选池（memory_recall_candidates）的会话级覆盖。
//      「本仓适配口径」—— 与官方报告的检索指标不是同一公式（官方 run_retrieval 口径不同）。
//
// single-session-assistant 单列出桶：证据在 assistant 轮，而产品只吃 user-origin 来源，
// 结构性不可答（LME 全集中该题型 56 题）；该桶不计入总正确率。

export function scoreLongMemEval(cases, outcomes, judgments = {}) {
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const buckets = new Map()
  const typeBuckets = new Map()
  const rows = []
  const retrieval = { sessionRecalls: [], turnRecalls: [], candidateSessionRecalls: [], withEvidence: 0, withGoldTurns: 0 }
  const ingest = { registeredSources: 0, processedSources: 0, oversizedSources: 0, sweeps: 0 }
  let judgeFailures = 0
  for (const outcome of outcomes) {
    const item = byId.get(outcome.caseId)
    if (!item) continue
    const judgment = judgments[outcome.caseId]
    const judged = judgment?.adjudicated === true
    if (judgment && judgment.adjudicated === false && judgment.error) judgeFailures += 1
    const correct = judged && judgment.correct === true
    const assistantOnly = item.questionType === "single-session-assistant"
    const bucketName = assistantOnly ? "assistantOnly" : "overall"
    for (const [name, key] of [[bucketName, "all"], [bucketName, item.abstention ? "abstention" : "regular"]]) {
      const bucket = buckets.get(`${name}/${key}`) ?? { cases: 0, judged: 0, correct: 0 }
      bucket.cases += 1
      if (judged) { bucket.judged += 1; bucket.correct += correct ? 1 : 0 }
      buckets.set(`${name}/${key}`, bucket)
    }
    const typeBucket = typeBuckets.get(item.questionType) ?? { questionType: item.questionType, cases: 0, judged: 0, correct: 0 }
    typeBucket.cases += 1
    if (judged) { typeBucket.judged += 1; typeBucket.correct += correct ? 1 : 0 }
    typeBuckets.set(item.questionType, typeBucket)

    const renderedSessions = new Set((outcome.evidence ?? []).map(ref => ref.sessionId).filter(Boolean))
    const renderedTurns = new Set((outcome.evidence ?? []).filter(ref => ref.sessionId && Number.isInteger(ref.turnIndex))
      .map(ref => `${ref.sessionId}:${ref.turnIndex}`))
    if (renderedSessions.size > 0) retrieval.withEvidence += 1
    const goldSessions = item.answerSessionIds ?? []
    if (goldSessions.length > 0)
      retrieval.sessionRecalls.push(goldSessions.filter(id => renderedSessions.has(id)).length / goldSessions.length)
    const goldTurns = (item.evidenceTurns ?? []).filter(turn => {
      const session = item.sessions.find(candidate => candidate.sessionId === turn.sessionId)
      return session?.turns[turn.turnIndex]?.role === "user"
    })
    if (goldTurns.length > 0) {
      retrieval.withGoldTurns += 1
      retrieval.turnRecalls.push(goldTurns.filter(turn => renderedTurns.has(`${turn.sessionId}:${turn.turnIndex}`)).length / goldTurns.length)
    }
    const candidateSessions = new Set(outcome.candidateSessionIds ?? [])
    if (goldSessions.length > 0)
      retrieval.candidateSessionRecalls.push(goldSessions.filter(id => candidateSessions.has(id)).length / goldSessions.length)
    const stats = outcome.ingest ?? {}
    ingest.registeredSources += stats.registeredSources ?? 0
    ingest.processedSources += stats.processedSources ?? 0
    ingest.oversizedSources += stats.oversizedSources ?? 0
    ingest.sweeps += stats.sweeps ?? 0
    rows.push({ caseId: item.caseId, questionId: item.questionId, questionType: item.questionType,
      abstention: item.abstention, assistantOnly, status: outcome.status, judged, correct: judged ? correct : null,
      answer: outcome.answer ?? null, evidenceCount: renderedSessions.size,
      sessionRecall: goldSessions.length ? goldSessions.filter(id => renderedSessions.has(id)).length / goldSessions.length : null })
  }
  const ratio = bucket => bucket && bucket.judged > 0 ? bucket.correct / bucket.judged : null
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const bucketRow = name => {
    const bucket = buckets.get(name) ?? { cases: 0, judged: 0, correct: 0 }
    return { ...bucket, accuracy: ratio(bucket) }
  }
  return {
    cases: cases.length,
    completed: rows.filter(row => row.status === "complete").length,
    judgeFailures,
    overall: bucketRow("overall/all"),
    abstention: bucketRow("overall/abstention"),
    regular: bucketRow("overall/regular"),
    assistantOnly: { ...bucketRow("assistantOnly/all"), excludedFromTotal: true,
      note: "证据位于 assistant 轮；产品只登记 user-origin 来源，结构性不可答" },
    byType: [...typeBuckets.values()].sort((left, right) => left.questionType.localeCompare(right.questionType))
      .map(bucket => ({ ...bucket, accuracy: ratio(bucket) })),
    retrieval: {
      sessionRecallMean: mean(retrieval.sessionRecalls), caseCount: retrieval.sessionRecalls.length,
      turnRecallMean: mean(retrieval.turnRecalls), turnCaseCount: retrieval.withGoldTurns,
      candidateSessionRecallMean: mean(retrieval.candidateSessionRecalls),
      evidenceHitRate: rows.length ? retrieval.withEvidence / rows.length : null,
      note: "本仓适配口径，非官方 run_retrieval 的 R@k",
    },
    ingest, rows,
  }
}
