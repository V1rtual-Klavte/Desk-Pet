# memory-bench — 外部记忆基准（观测层）

把三个开源权威记忆评测集接进测试体系，与自建 80 题（`test/memory-quality/`）**物理隔离**：
数据、运行、判分、门禁四处全分开。外部集只回答「记忆通道放在公开基准上是什么位置」，
是**观测性证据**，不参与发布门禁。

- **不进 CI、不进 `test:release`、默认不跑**；常规 `pnpm test`（L2/L3）完全不受影响。
- 独立命令：`pnpm run test:memory-bench -- --bench-dataset <…> [--bench-split <…>]`。
- 报告 `schemaVersion = desk-pet-memory-bench/v1`，顶层 `source: "external"`、`status: "observational"`，
  `qualityThresholds: null`。宿主对本次运行的 `PASS` 只表示「完整跑完」，不表示质量达标。
- **不冒充官方榜单成绩**：判分是「基于官方脚本/模板的自适配结果」，口径差异逐项列在下面。

## 1. 数据集与许可

| 数据集 | 来源 | 许可 | 论文 |
|---|---|---|---|
| LongMemEval（cleaned） | HF `xiaowu0162/longmemeval-cleaned`，GitHub `xiaowu0162/LongMemEval` | MIT（Copyright (c) 2024 Di Wu） | ICLR 2025 |
| MemoryBank（cn） | GitHub `zhongwanjun/MemoryBank-SiliconFriend` `eval_data/cn` | MIT（Copyright (c) 2023 Wanjun Zhong） | AAAI 2024 |
| LoCoMo | GitHub `snap-research/locomo` `data/locomo10.json` | **CC BY-NC 4.0（Copyright (c) 2024 Snap Inc.）** | ACL 2024 |

- LoCoMo 为**非商用**数据：许可原文全文随仓库保存（`test/memory-bench/licenses/locomo-LICENSE.txt`，
  CC BY-NC 4.0 全文），并保留署名；使用者不得将相关数据或派生结果用于商业用途。
  报告 `license.nonCommercial = true`。
- 固定 revision 与 SHA-256 全部登记在 `upstream-lock.json`：下载/读取后逐字节校验，
  上游漂移会报错而不是静默改分。案例文件头部内嵌 `upstream{url,revision,fileSha256,bytes}` 与
  `license`，报告原样透出。

## 2. 数据落位：仓库只放「版本锁」，数据集一行命令装到指定目录

**仓库内不放任何数据集文件。** 版本锁定的载体是进 git 的小文件：

| 进 git 的锁定载体 | 内容 |
|---|---|
| `upstream-lock.json` | 上游 URL、固定 revision、SHA-256、字节数；下载与转换产物的目录映射；许可元数据 |
| `licenses/*.txt` | 上游许可原文副本（LoCoMo 的 CC BY-NC 4.0 全文在内；单测校验与锁定哈希逐字节一致） |
| `prepare.mjs` + importer/scorer | 安装与转换逻辑本身 |

数据（原始文件与转换后的案例文件）都落在 **data-dir**，属于可弃缓存：

| data-dir 子目录 | 内容 |
|---|---|
| `raw/` | 上游原始文件（LongMemEval oracle 15.4 MB、S 277 MB、LoCoMo 2.8 MB、MemoryBank 0.2 MB） |
| `cases/` | 转换后的案例文件（runner 实际读取的产物，含题号子集清单） |
| `reference/` | 官方判分脚本参考件与许可原文副本（审计用，按锁文件下载校验） |

data-dir 解析优先级：`--data-dir <目录>` > 环境变量 `DESKPET_BENCH_DATA_DIR` > 默认
`test/memory-bench/.data/`（已 gitignore，是仓库内唯一允许的缓存位置；自定义目录建议放仓库外）。

**版本锁定与校验失败**：所有下载固定 revision + SHA-256。校验失败说明上游内容与锁定版本不一致，
脚本会报错并拒绝使用（不静默改分）；处理方式只有两种：人工核对上游变更后更新
`upstream-lock.json`，或删除对应缓存重新安装。`--verify` 可随时核对缓存、案例文件与许可副本的完整性。

## 3. 一次性安装（一行命令）

```bash
pnpm run test:memory-bench:prepare                              # 装全部三集（oracle；默认 data-dir）
pnpm run test:memory-bench:prepare -- --data-dir /data/bench    # 装到指定目录（推荐）
# 或按需：
node test/memory-bench/prepare.mjs --dataset memorybank --data-dir ~/bench-data
node test/memory-bench/prepare.mjs --dataset longmemeval --split s   # 可选：S-cleaned（277MB），见 §7
node test/memory-bench/prepare.mjs --verify [--data-dir …] [--offline]
```

- 用 `--data-dir` / `DESKPET_BENCH_DATA_DIR` 装了自定义目录后，**跑测试时要用同一个目录**：
  `DESKPET_BENCH_DATA_DIR=/data/bench pnpm run test:memory-bench -- --bench-dataset longmemeval --report json`。
- prepare 只用 Node 内置模块（fetch + crypto），不引入新依赖。

## 4. 运行

```bash
pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split oracle \
  --bench-limit 10 --bench-judge-model deepseek-reasoner --report json
```

| 参数 | 说明 |
|---|---|
| `--bench` | 必需（脚本 `test:memory-bench` 已带） |
| `--bench-dataset` | `longmemeval` / `locomo` / `memorybank` |
| `--bench-split` | longmemeval：`oracle`（默认）/ `s`；locomo：`locomo10`；memorybank：`cn` |
| `--bench-limit N` | 本次最多跑几题（按分组顺序截断，不从组中间切开） |
| `--bench-case id1,id2` | 精确题号过滤（调试用） |
| `--bench-seed` | 组内洗牌种子，默认 `memory-bench-2026-10-03` |
| `--bench-judge on/off` | 默认 `on`；`off` 只出确定性检索指标 |
| `--bench-judge-model` | 默认取 [test/eval-models.json](../eval-models.json) 的 `judge.model`（当前 `deepseek-reasoner`）；**必须不同于被测模型** |
| `--report json` | 报告落 `test/reports/<stamp>.json`（建议始终带） |

报告与逐题 JSONL（`memory-bench-outcomes.jsonl`）随现有保留组机制留存：
主报告 `<stamp>.json`；逐题结果作为 bundle 成员 `<trace-bundle>-<stamp>.quality.jsonl`
（复用现有成员名后缀，未改 `scripts/trace-evidence.mjs`）。

**LongMemEval 的逐题 JSONL 行同时携带 `question_id` 与 `hypothesis`**，官方
`src/evaluation/evaluate_qa.py <metric_model> <hyp_file> <ref_file>` 可直接消费（多余字段被官方脚本忽略）；
`ref_file` 用官方原始 LongMemEval 数据。另一条导出路径：

```bash
node test/memory-bench/export-hypotheses.mjs test/reports/<stamp>.json --out /tmp/hypotheses.jsonl
```

## 5. 判分口径

### LongMemEval（judge + 确定性检索）

- 答案判分：**五套题型模板逐字移植自官方 `src/evaluation/evaluate_qa.py`**（通用 yes/no、
  temporal 免 off-by-one、knowledge-update 允新旧并述、preference rubric、abstention）。
  判定解析保持官方语义（`'yes' in response.lower()`），原始回答落盘可复判。
- judge 走仓库配置的 Provider 端点与 api_key（同 key 异构；默认 judge 模型由
  [test/eval-models.json](../eval-models.json) 提供——当前 `deepseek-reasoner`，可用
  `--bench-judge-model` 或 `DESKPET_EVAL_JUDGE_MODEL` 覆盖；被测模型以本机配置为准，也可在
  同一文件或 `DESKPET_EVAL_MODEL` 覆盖）。**唯一纪律：judge 模型必须不同于
  被测模型**（配置相同会在开跑前报错），报告顶层记录 `judgeModel`。judge 失败（超时/空响应）只记
  「未裁决」，不进正确率分母，另计 `judgeFailures`。
- 确定性检索指标（不依赖 judge）：`sessionRecall`（gold `answer_session_ids` 被渲染证据覆盖的比例）、
  `turnRecall`（gold `has_answer` 的 **user** 轮被覆盖的比例）、`candidateSessionRecall`（候选池会话级覆盖）。
  **本仓适配口径，不是官方 R@k**。
- `single-session-assistant`（56/500）**单列出桶、不计总正确率**：证据在 assistant 轮，
  而产品只吃 user-origin 来源，结构性不可答 —— 不为评测改产品。

### LoCoMo（确定性词面 F1，不用 judge）

- 移植官方 `task_eval/evaluation.py`：normalize（去逗号→小写→去 ASCII 标点→去 a/an/the/and→折叠空白）、
  Porter 词干化、词频交集 F1；多跳（category 1）逗号拆子句取最优；category 3 金标在 `;` 截断；
  category 5 对抗题二值（`no information available` / `not mentioned`）。
- 词干器是按 Porter 1980 论文算法本仓移植（与 NLTK `PorterStemmer` 默认模式同口径，实现独立），
  论文测试词表在 L2 单测逐一核对 —— 报告口径为「本仓适配移植」。
- 另报确定性 `evidenceRecallMean`（gold `evidence` dia_id 被渲染证据覆盖的比例）。

### MemoryBank cn（确定性检索 + judge 一致性）

- 上游**没有官方判分脚本、没有金标答案**（探测题只有问题）。确定性指标：
  `evidencePresentRate`（至少渲染一条记忆的题占比）、`dateHintHitRate`（题面点名「N月N日/号」时，
  该日期出现在渲染证据 `observedAt` 的比例）、`renderedEvidenceP50`。
- 正确率由同一 judge 适配器给出：以整段角色历史为参照判「回答是否与历史一致且答到问题」
  （**本仓自适配模板**，不代表官方指标）。

## 6. 采集管线（与自建集的差异）

- 历史注入 = **直登记 `MemorySource`**：每个 haystack user 轮（LoCoMo 为两个说话人全部轮次；
  MemoryBank 为 `query` 轮）登记一条来源，`sourceId` 即证据坐标（LME `会话id:轮下标`、
  LoCoMo `样本id:dia_id`、MemoryBank `日期#轮下标`），`evidence` 截 2000 字符（对齐产品
  `EVIDENCE_CHARS`），`sourceLength` 保留原文长度（产品 dreaming 对 >4800 字符的整条来源丢弃，
  次数如实计入报告）。不写会话 JSONL、不逐轮 `sendMessage` 重放。
- 提取走**真实 dreaming**（`manual` 模式，绕开每日预算；循环 sweep 直至无待处理来源）。
- **session-scope 候选归一为 user scope**：Rust 禁止跨范围改归属，用 `add`（同内容/来源）+ `forget`
  原条目实现；否则提问发生在新建会话会漏召回。次数记入 `ingest.scopeNormalized`。
- 提问：每题新建会话；cell = 题 × 1 trial（外部集是观测证据，不套自建集的 ≥3 trial 配对纪律）。
- 组复用：LoCoMo 一段对话灌一次库、组内多题提问；MemoryBank 一个角色同理；LongMemEval 每题一组。
- 工具全部撤下（与 memory-quality 相同的隔离）；存储为隔离 E2E 根内的真实 Rust SQLite。
- 模型工具/权限边界不变；**不为拉高分改产品**：recall 预算（CONFIG `ai.memory.core/recall`）、
  dreaming 截断（1200）/丢弃（4800）造成的压分照实记录（`ingest` + `manifest.memoryConfig`）。
- 已知偏差（报告口径如实标注）：官方 LongMemEval 以 `question_date` 为「当前日期」，
  本仓提问发生在真实时钟（2026+），相对日期类问题受此影响；题面不做改写。
- **被测模型为 reasoning 模型时的已知限制（实测 2026-10-03，deepseek-flash）**：产品 dreaming 的
  单次评审输出上限是 1200 tokens（`REVIEW_MAX_TOKENS`），reasoning 的 thinking 也计入该预算，
  因此提取会批量以「Provider 输出达到长度上限，拒绝使用不完整结果」失败——产品**拒绝采用不完整
  输出**是正确的保守行为，不是基准缺陷。此类题按 `status: "failed"` 记入报告（`error` 字段注明
  `model-output-length`），一次 run 会继续观测其余题目而不是连续中止；非 reasoning 模型
  （如 deepseek-chat）不受此限。要观测提取链路，先跑 `--bench-limit 3` 确认该限制是否出现。

## 7. LongMemEval S 子集（本轮不跑）

- S-cleaned（277 MB）由 prepare 按同一固定 revision + SHA-256 下载；转换复用同一 importer，
  默认按已安装 oracle 子集的同题号选题（保证两档可比），产物落在
  `<data-dir>/cases/longmemeval/s-subset.json`。
- 想跑 S：`node test/memory-bench/prepare.mjs --dataset longmemeval --split s`，然后
  `pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split s …`。成本量级见 §8。

## 8. 成本量级（供选择 limit 时参考，按 deepseek 系列计价）

- LongMemEval oracle：每题 ≈1 次提取 sweep（≈1–3 个 Provider 请求）+ 1 次提问 + 1 次 judge；
  52 题全量子集约 0.5–1M tokens。
- LongMemEval S：每题 haystack 约 122k tokens，100 题约 2.5–4.5M tokens。
- LoCoMo：10 段对话灌入（每段 19–32 会话）+ 1986 次提问；信息量最大，建议始终带 `--bench-limit` 分批跑。
- MemoryBank cn：15 个角色 × 100 题，规模最小。

## 9. 测试与验证

- 纯函数（importer / selector / scorer / porter / judge 模板 / runner 编排）配 L2 单测：
  `test/unit/memory-bench/*.test.ts`，合成小样本，不读真数据。
- 数据转换的完整性由 `prepare.mjs --verify` 与 `validate*File` 校验保证；不做 datasetHash/三重哈希链
  （外部集不进门禁，最简完整性守卫即 revision + fileSha256 + importTransformVersion）。
- smoke：`pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split oracle --bench-limit 3 --report json`
  （真实 Provider；`--bench-judge off` 可只验采集管线）。

## 10. 红线

- LoCoMo 保留完整许可原文与署名，标注非商用；MIT 数据保留版权与许可声明。
- 不冒充官方榜单成绩；报告写明「基于官方脚本/模板的自适配结果」及全部口径差异。
- 下载一律固定 revision + SHA-256，防上游漂移静默改分。
- judge 异构于被测模型，不允许被测模型自评。
