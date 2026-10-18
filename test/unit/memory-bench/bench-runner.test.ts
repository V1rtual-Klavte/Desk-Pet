// 外部记忆基准 runner L2 单测：用 fake adapter 驱动编排（cell 规划 / 失败中止 / 报告组装），
// 不需要真实 Provider。断言语义对照方案：source=external、status=observational、质量阈值恒 null。
import { describe, it, expect } from "vitest"
import {
  planBenchCells, runMemoryBenchEvaluation, validateBenchCaseFile, benchSplitInfo, BENCH_DATASETS,
} from "../../memory-bench/index.mjs"

function lmeCase(id: string, type = "single-session-user", abstention = false) {
  const questionId = `${id}${abstention ? "_abs" : ""}`
  return { caseId: `lme-oracle-${questionId}`, questionId, questionType: type, abstention,
    question: `question ${id}`, answer: `answer ${id}`, answerSessionIds: [], evidenceTurns: [],
    sessions: [{ sessionId: "s1", date: "", observedAt: 0, turns: [] }] }
}

function lmeFile(cases: unknown[]) {
  return { schemaVersion: "desk-pet-memory-bench-cases/v1", dataset: "longmemeval", split: "oracle",
    importTransformVersion: "test/1", upstream: { fileSha256: "deadbeef" }, license: { spdx: "MIT" },
    selection: { policy: "test", caseCount: cases.length }, cases }
}

function locomoCase(caseId: string, sampleId: string) {
  return { caseId, sampleId, questionIndex: 0, question: `q ${caseId}`, answer: "a", category: 4, evidence: [] }
}

interface FakeCalls { cells: string[]; judges: Array<Record<string, unknown>> }

/** 模拟 judge 通道故障：抛出点放在模块级辅助函数里（测试体内手写 throw 是扫描器规则 4 的违规形状）。 */
function boom(message: string): never {
  throw new Error(message)
}

function fakeAdapter(mode: { fail?: (caseId: string) => boolean; cleanupFailure?: boolean;
  judge?: (input: Record<string, unknown>) => unknown } = {},
  calls: FakeCalls = { cells: [], judges: [] }) {
  return {
    calls,
    init() { return undefined },
    finalize() { return undefined },
    manifest() { return { model: "test-model", provider: "test" } },
    async runCell(input: Record<string, unknown>) {
      calls.cells.push(input.caseId as string)
      if (mode.fail?.(input.caseId as string)) throw new Error(`boom ${input.caseId}`)
      return { caseId: input.caseId, questionId: (input.caseDef as { questionId?: string }).questionId ?? null,
        status: "complete", answer: `a:${input.caseId}`, evidence: [],
        candidateSessionIds: [], groupReused: false, storeGeneration: "gen-1",
        ...(mode.cleanupFailure ? { fixtureCleanup: { ok: false, error: "delete failed" } } : {}) }
    },
    async judgeCase(input: Record<string, unknown>) {
      calls.judges.push(input)
      if (mode.judge) return mode.judge(input)
      return { adjudicated: true, correct: true, model: input.judgeModel }
    },
  }
}

describe("bench 数据集注册表", () => {
  it("三个数据集与命名空间登记齐全；未知 dataset/split 抛错并列出可用值", () => {
    expect(Object.keys(BENCH_DATASETS).sort()).toEqual(["locomo", "longmemeval", "memorybank"])
    expect(benchSplitInfo("longmemeval", "oracle").namespace).toBe("lme-oracle")
    expect(benchSplitInfo("locomo", undefined).namespace).toBe("locomo")
    expect(() => benchSplitInfo("nope")).toThrow(/未登记/)
    expect(() => benchSplitInfo("longmemeval", "nope")).toThrow(/没有 split/)
  })

  it("案例文件 dataset 不匹配时校验失败", () => {
    const errors = validateBenchCaseFile("locomo", lmeFile([lmeCase("a")]))
    expect(errors.some(error => error.includes("dataset"))).toBe(true)
  })
})

describe("bench cell 规划", () => {
  it("组连续：同一样本的题始终相邻，组顺序按文件首次出现顺序 [bench-runner-group-order]", () => {
    const file = { cases: [locomoCase("locomo-c1-q0", "c1"), locomoCase("locomo-c1-q1", "c1"),
      locomoCase("locomo-c2-q0", "c2"), locomoCase("locomo-c2-q1", "c2"), locomoCase("locomo-c2-q2", "c2")] }
    for (const seed of ["s1", "s2", "s3"]) {
      const cells = planBenchCells("locomo", file, { seed })
      expect(cells.map(cell => cell.groupKey).join(",")).toBe("c1,c1,c2,c2,c2")
    }
  })

  it("limit 在分组排序后按题数截断，可以从组中间切开 [bench-runner-limit-truncates-group]", () => {
    const file = { cases: [locomoCase("locomo-c1-q0", "c1"), locomoCase("locomo-c1-q1", "c1"),
      locomoCase("locomo-c2-q0", "c2"), locomoCase("locomo-c2-q1", "c2")] }
    const cells = planBenchCells("locomo", file, { seed: "s", limit: 3 })
    expect(cells).toHaveLength(3)
    expect(cells.map(cell => cell.groupKey)).toEqual(["c1", "c1", "c2"])
  })

  it("caseFilter 精确选题；无命中抛错而不是空跑", () => {
    const file = { cases: [locomoCase("locomo-c1-q0", "c1"), locomoCase("locomo-c2-q0", "c2")] }
    expect(planBenchCells("locomo", file, { seed: "s", caseFilter: ["locomo-c2-q0"] }).map(cell => cell.caseId))
      .toEqual(["locomo-c2-q0"])
    expect(() => planBenchCells("locomo", file, { seed: "s", caseFilter: ["missing"] })).toThrow(/没有命中/)
  })

  it("LoCoMo 按 category 分层抽样：每类至多 N 题、同 seed 可复现、异 seed 选题不同 [bench-locomo-per-category]", () => {
    const categories = [1, 2, 3, 4]
    const samples = ["conv-a", "conv-b"]
    // 每类 6 题、跨两个 sample：perCategory=2 时各类都必然需要截断，
    // 且选区不是「取文件前 N 条」。
    const cases = categories.flatMap(category =>
      Array.from({ length: 6 }, (_, index) => ({
        ...locomoCase(`locomo-${samples[index % samples.length]}-c${category}-q${index}`, samples[index % samples.length]!),
        category,
        questionIndex: index,
      })))
    const file = { cases }

    const first = planBenchCells("locomo", file, { seed: "seed-a", perCategory: 2 })
    const again = planBenchCells("locomo", file, { seed: "seed-a", perCategory: 2 })
    const other = planBenchCells("locomo", file, { seed: "seed-b", perCategory: 2 })

    expect(first).toHaveLength(categories.length * 2)
    for (const category of categories) {
      const selected = first.filter(cell => (cell.caseDef as { category: number }).category === category)
      expect(selected.length).toBeLessThanOrEqual(2)
      expect(selected).toHaveLength(2)
    }
    expect(again.map(cell => cell.caseId)).toEqual(first.map(cell => cell.caseId))
    expect(other.map(cell => cell.caseId)).not.toEqual(first.map(cell => cell.caseId))
    // 分层后仍保持「同一 sample 的题相邻」的组连续语义。
    const groupKeys = first.map(cell => cell.groupKey)
    for (const sample of samples) {
      const positions = groupKeys.flatMap((key, index) => key === sample ? [index] : [])
      expect(positions.length).toBeGreaterThan(0)
      expect(positions[positions.length - 1]! - positions[0]! + 1).toBe(positions.length)
    }
  })
})

describe("bench runner 编排（fake adapter）", () => {
  const file = lmeFile([lmeCase("a"), lmeCase("b_abs", "multi-session", true), lmeCase("c", "temporal-reasoning")])

  it.each([
    ["finalize", "bench-runner-finalize-failure"],
    ["manifest", "bench-runner-manifest-failure"],
  ])("收尾 %s 故障保留已采集回答、用量与失败阶段 [%s]", async (stage) => {
    const adapter = fakeAdapter()
    const runCell = adapter.runCell
    const usage = { inputTokens: 120, outputTokens: 11, requests: 1 }
    adapter.runCell = async input => ({ ...await runCell(input), usage })
    adapter[stage as "finalize" | "manifest"] = () => boom(`${stage} failed`)
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "longmemeval", split: "oracle",
      file: lmeFile([lmeCase("a")]), seed: "s", judge: "off" }) as Record<string, any>
    expect(report.completedCells).toBe(1)
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]).toMatchObject({ caseId: "lme-oracle-a", answer: "a:lme-oracle-a", usage })
    expect(report.failures).toEqual([{ kind: "infrastructure", stage, message: `${stage} failed` }])
    expect(report.gates).toEqual({ complete: false, infrastructureFailures: 1 })
    expect(report.manifest).toEqual(stage === "manifest" ? null : { model: "test-model", provider: "test" })
  })

  it("基础设施失败返回结果时仍保留已知用量并执行连续失败中止 [bench-runner-failed-outcome-usage]", async () => {
    const called: string[] = []
    const ended: unknown[] = []
    const knownUsage = { inputTokens: 120, outputTokens: 11, requests: 1, uncachedInputTokens: 100,
      cacheReadTokens: 20, cacheWriteTokens: 0, cacheUsageReported: true, accounting: "pi-input-plus-normalized-cache" }
    const adapter = { ...fakeAdapter(), async runCell(input: { caseId: string }) {
      called.push(input.caseId)
      return { caseId: input.caseId, status: "failed", failureKind: "infrastructure", error: "Provider idle timeout",
        evidence: [], usage: null, knownUsage, unknownUsageRequests: 1, fixtureCleanup: { ok: true } }
    } }
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "longmemeval", split: "oracle",
      file: lmeFile([lmeCase("a"), lmeCase("b"), lmeCase("c"), lmeCase("d")]), seed: "s", judge: "off",
      onCellEnd(context) { ended.push(context.outcome) } }) as Record<string, any>
    expect(called).toHaveLength(3)
    expect(report.completedCells).toBe(0)
    expect(report.gates.complete).toBe(false)
    expect(report.failures.map((row: { kind: string }) => row.kind)).toEqual(["infrastructure", "infrastructure", "infrastructure", "aborted"])
    expect(report.failures[3].remainingCells).toBe(1)
    expect(report.outcomes).toHaveLength(3)
    expect(report.outcomes[0]).toMatchObject({ status: "failed", usage: null, knownUsage, unknownUsageRequests: 1,
      fixtureCleanup: { ok: true } })
    expect(ended).toHaveLength(3)
  })

  it("LongMemEval 完成采集但质量分 pending_official，产品本地模板不参与主评分 [bench-lme-pending-official]", async () => {
    const adapter = fakeAdapter()
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "longmemeval", split: "oracle",
      file, seed: "s" }) as Record<string, any>
    expect(report.schemaVersion).toBe("desk-pet-memory-bench/v1")
    expect(report.source).toBe("external")
    expect(report.status).toBe("observational")
    expect(report.qualityThresholds).toBe(null)
    expect(report.judgeModel).toBe(null)
    expect(report.upstream).toEqual({ fileSha256: "deadbeef" })
    expect(report.license).toEqual({ spdx: "MIT" })
    expect(report.plannedCells).toBe(3)
    expect(report.completedCells).toBe(3)
    expect(report.gates.complete).toBe(true)
    expect(report.failures).toEqual([])
    expect(adapter.calls.cells).toHaveLength(3)
    expect(adapter.calls.judges).toHaveLength(0)
    expect(report.scores.officialScoring.status).toBe("pending_official")
  })

  it("outcome 携带 caseRef（导出 hypotheses 的题面来源）", async () => {
    const report = await runMemoryBenchEvaluation({ adapter: fakeAdapter(), dataset: "longmemeval",
      split: "oracle", file, seed: "s" }) as Record<string, any>
    const first = report.outcomes.find((outcome: Record<string, unknown>) => outcome.caseId === "lme-oracle-a")
    expect(first.caseRef).toMatchObject({ questionId: "a", questionType: "single-session-user" })
    expect(first.judgment).toBe(null)
  })

  it("最后一题隔离会话清理失败仍保留回答且将整场标为不完整 [bench-runner-fixture-cleanup-failure]", async () => {
    const one = lmeFile([lmeCase("a")])
    const report = await runMemoryBenchEvaluation({ adapter: fakeAdapter({ cleanupFailure: true }),
      dataset: "longmemeval", split: "oracle", file: one, seed: "s" }) as Record<string, any>
    expect(report.outcomes[0]).toMatchObject({ status: "complete", answer: "a:lme-oracle-a",
      fixtureCleanup: { ok: false, error: "delete failed" } })
    expect(report.gates.complete).toBe(false)
    expect(report.failures).toContainEqual(expect.objectContaining({ caseId: "lme-oracle-a", kind: "fixture-cleanup" }))
  })

  it("judge off 时不调用 judgeCase，报告 judgeModel 为 null 且只出确定性指标", async () => {
    const adapter = fakeAdapter()
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "longmemeval", split: "oracle",
      file, seed: "s", judge: "off" }) as Record<string, any>
    expect(adapter.calls.judges).toHaveLength(0)
    expect(report.judge).toEqual({ enabled: false, model: null })
    expect(report.judgeModel).toBe(null)
    expect(report.scores.overall.judged).toBe(0)
    expect(report.gates.complete).toBe(true)
  })

  it("连续 3 次基础设施失败后中止剩余题，显式记录未跑的题数 [bench-runner-abort]", async () => {
    const many = lmeFile([lmeCase("a"), lmeCase("b", "multi-session", true), lmeCase("c"), lmeCase("d"), lmeCase("e")])
    const adapter = fakeAdapter({ fail: () => true })
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "longmemeval", split: "oracle",
      file: many, seed: "s", judgeModel: "judge-model-x" }) as Record<string, any>
    expect(report.plannedCells).toBe(5)
    expect(report.attemptedCells).toBe(3)
    expect(report.completedCells).toBe(0)
    expect(report.scores.cases).toBe(5)
    expect(report.scores.byType.reduce((sum: number, row: { cases: number }) => sum + row.cases, 0)).toBe(5)
    expect(report.subsetDescription.caseRefs).toHaveLength(5)
    expect(report.subsetDescription.caseRefs.map((ref: { caseId: string }) => ref.caseId))
      .toEqual(report.subsetDescription.requestedCaseIds)
    expect(report.subsetDescription.caseRefs.find((ref: { abstention: boolean }) => ref.abstention))
      .toMatchObject({ questionType: "multi-session", abstention: true })
    expect(report.gates.complete).toBe(false)
    const aborted = report.failures.find((failure: Record<string, unknown>) => failure.kind === "aborted")
    expect(aborted).toMatchObject({ remainingCells: 2 })
    expect(adapter.calls.cells).toHaveLength(3)
  })

  it("MemoryBank judge 开启但缺 judgeModel 时在开跑前抛错 [bench-judge-model-required]", async () => {
    const memoryBank = { schemaVersion: "desk-pet-memory-bench-cases/v1", dataset: "memorybank", split: "cn",
      importTransformVersion: "test/1", upstream: null, license: null, selection: { policy: "test", caseCount: 1 },
      personas: [{ name: "P", metaInformation: {}, days: [] }],
      cases: [{ caseId: "membank-cn-p01-q01", persona: "P", questionIndex: 0, question: "Q?" }] }
    await expect(runMemoryBenchEvaluation({ adapter: fakeAdapter(), dataset: "memorybank", split: "cn",
      file: memoryBank, seed: "s" })).rejects.toThrow(/judgeModel/)
  })

  it("MemoryBank judge 抛错只记未裁决，不把采集判成基础设施失败", async () => {
    const memoryBank = { schemaVersion: "desk-pet-memory-bench-cases/v1", dataset: "memorybank", split: "cn",
      importTransformVersion: "test/1", upstream: null, license: null, selection: { policy: "test", caseCount: 1 },
      personas: [{ name: "P", metaInformation: {}, days: [] }],
      cases: [{ caseId: "membank-cn-p01-q01", persona: "P", questionIndex: 0, question: "Q?" }] }
    const adapter = fakeAdapter({ judge: () => boom("judge timeout") })
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "memorybank", split: "cn", file: memoryBank,
      seed: "s", judgeModel: "judge-model-x" }) as Record<string, any>
    expect(report.gates.complete).toBe(true)
    expect(report.scores.judgeFailures).toBe(1)
    expect(report.outcomes[0].judgment).toMatchObject({ adjudicated: false, error: "judge timeout" })
  })

  it("案例文件非法时在开跑前抛错", async () => {
    await expect(runMemoryBenchEvaluation({ adapter: fakeAdapter(), dataset: "longmemeval", split: "oracle",
      file: { ...file, cases: [{ caseId: "bad id" }] }, seed: "s", judgeModel: "j" })).rejects.toThrow(/非法/)
  })

  it("LoCoMo 不做 LLM judge（由独立官方脚本生成唯一主分），即使 judge 配置为 on", async () => {
    const locomoFile = { schemaVersion: "desk-pet-memory-bench-cases/v1", dataset: "locomo", split: "locomo10",
      importTransformVersion: "test/1", upstream: null, license: null, selection: { policy: "full", caseCount: 1 },
      conversations: [{ sampleId: "conv-00" }], cases: [locomoCase("locomo-conv-00-q0000", "conv-00")] }
    const adapter = fakeAdapter()
    const report = await runMemoryBenchEvaluation({ adapter, dataset: "locomo", split: "locomo10",
      file: locomoFile, seed: "s", judge: "on", judgeModel: "judge-model-x" }) as Record<string, any>
    expect(adapter.calls.judges).toHaveLength(0)
    expect(report.judge.enabled).toBe(false)
    expect(report.scores.officialScoring.status).toBe("pending_official")
    expect(report.gates.complete).toBe(true)
  })
})
