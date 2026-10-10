# 终态测评结果（final）

本目录保存**认定后的终态测评结果**，用于对外引用与跨轮比较；它与 `test/reports/bench/` 根下的
滚动报告分开：滚动报告受「最近三场 + 字节上限」淘汰（`scripts/report-retention.mjs`），
本目录的子目录不被该淘汰扫描（`pruneRetainedGroups` 只处理文件条目），因此条目会长期留存。

## 结构

按数据集分目录，与 memory-bench 的 `--bench-dataset` 取值一一对应：

| 目录 | 数据集 | 说明 |
|---|---|---|
| `longmemeval/` | LongMemEval oracle / s | 质量对照主口径；含官方题型判分 |
| `locomo/` | LoCoMo locomo10 | 确定性词面 F1，不依赖 judge |
| `memorybank/` | MemoryBank cn | 确定性检索指标 + 一致性 judge |

每条归档以**报告时间戳**（UTC，形如 `2026-10-10T07-02-22-201Z`）为同一组，含：

- `<stamp>.json` / `<stamp>.html`：主报告与质量摘要页
- `trace-bundle-<stamp>.memory-bench.jsonl`：逐题 hypothesis（可导出走官方判分）
- `trace-bundle-<stamp>.trace.jsonl` / `.manifest.json` / `.integrity.json`：完整运行线路证据

## 条目与溯源

### longmemeval/2026-10-10T07-02-22-201Z

| 项 | 值 |
|---|---|
| 正确率 | **96.2%（50/52）**；regular 95.2% · abstention 10/10 · 未裁决 0 · 执行失败 0 |
| 被测 | `deepseek` / `deepseek-flash`，`entry: production`，`providerMode: real` |
| judge | 请求名 `deepseek-reasoner`；实测被网关静默映射为 `deepseek-flash`＝被测同模型（见下方「判分口径提醒」），已按 `deepseek-v4-pro` 逐题复判：52/52 verdict 一致、0 翻转（证据 `longmemeval/rejudge-deepseek-v4-pro.json`） |
| 参数 | `--bench-split oracle --bench-seed memory-bench-2026-10-03`，52 题 |
| 代码状态 | `runEvidence.commit = 41918325…`，`sourceHashes.memory = 100152d85773db23cd31a2be2018c6c8603276557c8799d037a8df7685a22826` |
| 记忆配置 | `budgetPolicy=request-headroom` · `contextMaxTokens=262144` · `queryRewrite=adaptive` · `rerank=off` · `recallTimeoutMs=120000`（bench 测量口径覆盖） |
| 用时 / 成本 | 40.1 分钟 · 输入 1,145,783（未缓存 1,001,406） · 输出 507,277 · 186 请求 · judge 52 次 |
| 已含改动 | 阅读口径补修：冲突按时间序消解取更新值、相对时间窗换算成日期区间、missing 项先声明不得用相似事实充当答案主体、supported 个人证据必须落实 |
| 已知错题 | `lme-oracle-6d550036`（数项目，计划/进行中判别过严，第三批已收口）、`lme-oracle-gpt4_e414231f`（金标把"当天定了换锁踏"算修车/保养，属口径灰区） |

### memorybank/2026-10-10T13-35-49-589Z

| 项 | 值 |
|---|---|
| 正确率 | **97/100（97.0%）** · 换模型复判（`deepseek-v4-pro`）口径：与原判分 verdict 一致 99/100，1 题翻转（`membank-cn-p02-q05` 存储 yes → 复判 no）；judge 未裁决 0 · 执行失败 0 |
| 被测 | `deepseek` / `deepseek-flash`，`entry: production`，`providerMode: real` |
| judge | 请求名 `deepseek-reasoner`；实测被网关静默映射为 `deepseek-flash`＝被测同模型（回包 `model` 字段），故以同目录 `rejudge-deepseek-v4-pro.json` 为判分稳健性证据 |
| 参数 | `--bench-split cn`，15 角色 / 100 题全量，单 trial，seed `memory-bench-2026-10-03` |
| 代码状态 | `runEvidence.commit = 2961ee4e…`（含未提交工作区；`sourceHashes.memory = 6a73982c…`） |
| 记忆配置 | `budgetPolicy=request-headroom` · `contextMaxTokens=262144` · `queryRewrite=adaptive` · `rerank=off` · `recallTimeoutMs=120000`（bench 测量口径覆盖） |
| 检索 | `evidencePresentRate = 1.0` · 日期点名命中 34/35 · 渲染证据 P50 49 |
| 用时 / 成本 | 51.6 分钟 · 输入 3,158,669（未缓存 2,829,709） · 输出 629,715 · 缓存读 328,960 · 333 请求 · judge 100 次 |
| 灌库 | 登记 3,758 ＝ 处理 3,758 · sweeps 100（收敛） |
| 已含改动 | 采集改为按天 JSONL 会话夹具（user 轮登记事实、assistant 轮只进对话）＋生产 scope 规则；记忆 P0/P1 修复（个人证据落实、误触发个人回忆与日期概览过滤、英文日期误判） |
| 已知错题 | `membank-cn-p02-q06`（答对海滩/山脉/湖泊但补造「海边日落」）、`membank-cn-p03-q04`（用世界知识补足书的内容）、`membank-cn-p02-q05`（存储判分 yes、独立复判 no，同为加料类） |

## 阅读注意

- **不是门禁**：报告顶层 `source: "external"`、`status: "observational"`、`qualityThresholds: null`，
  `PASS` 只表示「完整跑完」，不代表质量达标；不冒充官方榜单成绩。
- **单 trial 噪声**：本仓 oracle 全量为每题 1 trial，相邻两轮逐题 verdict 翻转率实测 14–28%，
  题型层面 ±3 题属噪声级；引用数字时须同报噪声，不用单次差分断言因果。
- **判分口径提醒（2026-10-10 实测）**：测试侧网关只接受 `deepseek-flash` 与 `deepseek-v4-pro`
  两个模型名；请求 `deepseek-chat` / `deepseek-reasoner` **不报错但会被静默映射为 `deepseek-flash`**
  （回包 `model` 字段可见），即 `judgeModel` 记录的名字不等于实际服务的模型。同日用 `deepseek-v4-pro`
  按官方模板逐题复判，52/52 verdict 与本报告一致（含 `852ce960` 等边界题），复判证据归档在
  `longmemeval/rejudge-deepseek-v4-pro.json`。两份终态报告（`longmemeval/`、`memorybank/`）均按复判结果
  修订：`judgeModel` 记为实际判分模型、原请求名存 `judgeRequestedModel`、修订原因与翻转题记在顶层
  `judgmentRevision`，逐题原始判分保留在 `outcomes[].judgment` 可逐条审计；引用数字时以修订后的统计为准。
- **数据许可**：LoCoMo 为非商用（CC BY-NC 4.0），其归档不得用于商业用途；许可原文与署名见
  `test/memory-bench/licenses/`。
- **本目录受 `.gitignore` 约束**（`test/reports/` 被排除），属**本地留存**；若需随仓库分发，
  须先与维护者确认许可与体积。

## 维护约定

- 新增终态条目时：先清空滚动池或确认旧条目已不再引用，再把该轮四件套整体复制进对应数据集目录，
  并在上面的「条目与溯源」表补一行（分数、代码状态、判分、已知错题）。
- 只有通过复核（多 trial 或逐题对账）的轮次才进入本目录；未复核的中间轮留在滚动的 `bench/` 根下。
- 条目只增不改：重新跑出的结果作为**新条目**新增，旧条目保留以便对照。
