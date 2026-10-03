import type { ModuleContract } from "../host/types"

export const memoryBenchContract: ModuleContract = {
  module: "memory-bench",
  sourceFiles: ["test/memory-bench/upstream-lock.json", "test/memory-bench/prepare.mjs", "test/memory-bench/index.mjs", "test/memory-bench/judge.mjs", "test/memory-bench/export-hypotheses.mjs", "test/memory-bench/report.mjs", "test/memory-bench/scope-normalize.mjs", "test/memory-bench/bench-adapter.ts", "test/memory-bench/datasets/longmemeval/importer.mjs", "test/memory-bench/datasets/longmemeval/scorer.mjs", "test/memory-bench/datasets/locomo/importer.mjs", "test/memory-bench/datasets/locomo/porter.mjs", "test/memory-bench/datasets/locomo/scorer.mjs", "test/memory-bench/datasets/memorybank/importer.mjs", "test/memory-bench/datasets/memorybank/scorer.mjs"],
  sourceHash: "5fb287e67681204a5f8a118038e62f382d3dddba388e6bd196332c9eabef9bee",
  coverage: [
    {"id": "mb-01", "feature": "版本锁定与安装器", "description": "上游 revision 与 SHA-256 全部固定且校验失败拒绝使用；仓库许可原文副本与锁定哈希逐字节一致（NC 合规红线）；数据一律不进仓库目录、按锁下载到 data-dir（可指定）", "why": "外部基准的权威性依赖「同一 revision + 同一校验和 = 同一份数据」；锁定失效或数据回流仓库会让复现性无声破裂", "layer": "unit", "depth": "deep", "scenarios": ["bench-lock-pinned", "bench-lock-license", "bench-lock-no-vendored-data"]},
    {"id": "mb-02", "feature": "数据形态与导入校验", "description": "上游形状漂移显式暴露（悬挂行容错、缺答案抛错、重复角色行抛错）；证据轮坐标与弃权标记可追溯；question_date 时间锚点按本地墙钟还原（不拿 UTC 毫秒冒充当地日期）；子集选择确定性且覆盖题型", "why": "静默容忍上游瑕疵会让评测在错的坐标上跑出看似正常的结果", "layer": "unit", "depth": "deep", "scenarios": ["bench-lme-subset", "bench-lme-source-coords", "bench-lme-question-anchor", "bench-locomo-tolerance", "bench-membank-dup-guard"]},
    {"id": "mb-03", "feature": "判分模板与解析", "description": "LongMemEval 官方五套模板逐字移植与按题型分流（弃权优先级最高）；yes 解析与官方一致；槽位替换防串位；judge 输出预算给 reasoning 留思考空间且不回退到截断的固定值", "why": "判分模板一旦偏离官方口径，分数就不再可比，「权威」标签失效；判分被输出上限截断会变成静默未裁决", "layer": "unit", "depth": "deep", "scenarios": ["bench-judge-routing", "bench-judge-abstention", "bench-judge-verbatim", "bench-judge-parse", "bench-judge-budget"]},
    {"id": "mb-04", "feature": "LoCoMo 确定性判分", "description": "Porter 词干 + 多集词频交集 F1；多跳按子句取最优；对抗题官方措辞二值；未登记 category 抛错不静默计 0", "why": "免 judge 的确定性判分是第二数据集的可信来源，口径漂移与静默兜底都会伪造分数", "layer": "unit", "depth": "deep", "scenarios": ["bench-locomo-multihop-f1", "bench-locomo-adversarial"]},
    {"id": "mb-05", "feature": "runner 与观测隔离", "description": "报告顶层 external/observational/阈值 null（passed 仅表示完整跑完）；judge 异构纪律在开跑前强制（缺 judgeModel 抛错、不许被测模型自评）；连续基础设施失败中止并如实记录；分组连续与 limit 截断语义", "why": "外部基准是观测性证据：它不得冒充质量门禁，也不得在自评或静默中止下产出看起来完成的结论", "layer": "unit", "depth": "deep", "scenarios": ["bench-report-observational", "bench-judge-model-required", "bench-runner-abort", "bench-runner-group-order"]},
    {"id": "mb-06", "feature": "夹具 session→user 归一", "description": "session-scope 候选归一为 user scope 时先全部 add、再全部 forget：Rust 的遗忘墓碑会拒绝之后任何引用同一来源的新增，逐条交错会在共享来源的候选上把整题打成「来源未登记」的基础设施失败；规划只挑 active/session 条目，副本改 user 范围且不携带 scopeId", "why": "外部基准的失败必须归因到被测能力，而不是夹具自己撞产品治理规则的假故障；顺序错了会让个别整题静默变成基础设施失败、分布失真", "layer": "unit", "depth": "deep", "scenarios": ["bench-scope-normalize-order"]},
  ],
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
