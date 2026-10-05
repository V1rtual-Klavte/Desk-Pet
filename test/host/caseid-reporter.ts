// ==========================================
// caseId reporter —— L2/L3 的跨层 caseId 收集器
// ==========================================
//
// 契约「契约门禁跨层」：L2/L3 的 caseId 锚在 vitest 测试全名**末尾**的 `[caseId]`
// 标记上，由本 reporter 在测试结束时收集、查重、落盘。
//
// 为什么用 reporter 而不是 setup 文件：vitest 没有「拿到全部测试名」的全局钩子，
// setup 文件只能在每个 it 里手动登记；reporter 的 `onTestCaseResult` 拿到的就是
// 每个测试的全名本身 —— 契约校验与报告读的是同一份真相。
//
// 为什么用一个根级 reporter 而不是按 project 配：`reporters` 是 vitest 的
// **运行级**选项（vitest 5 的 `NonProjectOptions`，project 配置不接受它）。
// 所以按 `testCase.project.name` 分桶，分别写 `caseids-unit.json` /
// `caseids-integration.json`。
//
// 校验分工（契约原文）：「`test:unit` / `test:integration` 各校验自己那层」，
// 即每次运行只把**本次真正收集到的层**交给 `checkLayerCoverage`（缺的层不判定，
// 不看磁盘上的旧报告 —— 陈旧文件会让「刚搬走的 caseId」产生假的跨层告警）；
// 三层的全量校验由拿到全部层集合的调用方（L4 收口后）做。
//
// 本文件是基础设施，不带 `[caseId]` 标记（标记只给承担覆盖点的测试用）。

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Reporter, TestCase, TestSpecification, Vitest } from "vitest/node"
import { extractCaseId, assertNoDuplicates } from "./caseids"
import { checkLayerCoverage, formatLayerIssues } from "./contract-checker"
import type { CaseIdsByLayer } from "./contract-checker"
import type { ModuleContract, TestLayer } from "./types"

/** 只走 vitest 的两层；`e2e` 的 caseId 来自 L4 场景集的 `meta.caseId`，不经这里。 */
const LAYER_BY_PROJECT: Readonly<Record<string, TestLayer | undefined>> = {
  unit: "unit",
  integration: "integration",
}

/** 报告目录与其余报告产物一致，落在 `test/reports/`（已在 .gitignore 排除）。 */
const REPORT_DIR = resolve(process.cwd(), "test/reports")

export default class CaseIdReporter implements Reporter {
  private readonly idsByProject = new Map<string, string[]>()
  /** 本次运行是否覆盖了整层（非过滤、非分片、非 watch 增量）。 */
  private fullLayerRun = false

  onInit(vitest: Vitest): void {
    // 只有「整层一次跑完」的运行才做覆盖面判定：watch 的增量重跑、`--shard`、
    // 位置参数文件过滤与 `-t` 名字过滤都只覆盖子集，收集到的 caseId 天然不完整 ——
    // 对着子集判 MISSING/ORPHAN 会成片误伤，而误伤会让下一个人放宽整条规则
    //（`scripts/check-test-rules.mjs` 头部的同一条原则）。
    const config = vitest.config
    this.fullLayerRun = config.watch === false
      && config.shard === undefined
      && config.testNamePattern === undefined
      && (config.filters?.length ?? 0) === 0
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    // 按测试 id / 行号 / tag 的子集运行走的是 per-spec 过滤（API 入口），config 上看不到。
    const filtered = specifications.some(spec =>
      spec.testIds !== undefined
      || spec.testLines !== undefined
      || spec.testTagsFilter !== undefined)
    if (filtered) this.fullLayerRun = false
  }

  onTestCaseResult(testCase: TestCase): void {
    // 跳过不算覆盖（纪律 8）：skip / todo 的测试没有真的跑，不携带覆盖点。
    // 若把它们的 caseId 收进来，一个 `.skip` 掉的测试就能让覆盖点「看起来有人管」。
    if (testCase.result().state === "skipped") return
    const caseId = extractCaseId(testCase.fullName)
    if (caseId === undefined) return
    const bucket = this.idsByProject.get(testCase.project.name)
    if (bucket) bucket.push(caseId)
    else this.idsByProject.set(testCase.project.name, [caseId])
  }

  onTestRunEnd(): void {
    const caseIdsByLayer: CaseIdsByLayer = {}
    for (const [project, ids] of this.idsByProject) {
      assertNoDuplicates(ids) // 子集运行同样判重：一层内重复在任何运行里都是错误
      if (!this.fullLayerRun) continue
      mkdirSync(REPORT_DIR, { recursive: true })
      writeFileSync(
        join(REPORT_DIR, `caseids-${project}.json`),
        `${JSON.stringify(ids, null, 2)}\n`,
      )
      const layer = LAYER_BY_PROJECT[project]
      if (layer) caseIdsByLayer[layer] = ids
    }
    if (!this.fullLayerRun) return // 子集运行不落盘、不判定：落盘集合的语义是「整层」

    const issues = checkLayerCoverage(collectContracts(), caseIdsByLayer)
    if (issues.length > 0) {
      throw new Error(`契约 layer 校验失败：\n${formatLayerIssues(issues)}`)
    }
  }
}

/**
 * 契约经 Vite 的 glob 注入（快层的收集方式；L4 的 `native-main.ts` 拿到的是构建时
 * 生成的显式 import 清单，两侧只在「按 module 收敛、形状不对不认」的口径上同源）；
 * 形状不对的模块条目直接排除，不把「glob 读到了配置文件」演成契约。
 */
function collectContracts(): ModuleContract[] {
  const modules = import.meta.glob<Record<string, ModuleContract>>(
    "../contracts/*.contract.ts",
    { eager: true },
  )
  const contracts = Object.values(modules)
    .flatMap(mod => Object.values(mod))
    .filter((contract): contract is ModuleContract => Boolean(contract?.module && contract?.coverage))
  return [...new Map(contracts.map(contract => [contract.module, contract])).values()]
}
