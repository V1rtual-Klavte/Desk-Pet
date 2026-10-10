# memory-bench — 外部记忆基准（质量对照主口径）

把三个开源权威记忆评测集接进测试体系，与自建 80 题（`test/memory-quality/`）**物理隔离**：
数据、运行、判分、门禁四处全分开。外部集是**质量对照的主口径**：回答「记忆通道放在公开
基准上是什么位置」，报告与 hypotheses 作为质量证据；它仍是**观测性证据**，不参与发布门禁。

- **不进 CI、不进 `test:release`（门禁保持现状）**：按 §8 的分层节奏在本机运行（冒烟 → 常规，
  中文／难度／对外按触发条件），默认不为每次改动全量跑；冒烟层（`test:memory-bench:smoke`）可作
  接入自检，完整分层在本机跑通后再发布。常规 `pnpm test`（L2/L3）完全不受影响。
- 独立命令：`pnpm run test:memory-bench -- --bench-dataset <…> [--bench-split <…>]`。
- 报告 `schemaVersion = desk-pet-memory-bench/v1`，顶层 `source: "external"`、`status: "observational"`，
  `qualityThresholds: null`。宿主对本次运行的 `PASS` 只表示「完整跑完」，不表示质量达标。
- **不冒充官方榜单成绩**：判分是「基于官方脚本/模板的自适配结果」，口径差异逐项列在下面。

预算对比读取 manifest 的 `memoryConfig.budgetPolicy=request-headroom` 与逐题 `memory_recall_start`（总预算、core/recall 额度、实际窗口），并以 `memory_recall_rendered` 核对真正进入请求的证据。记忆额度统一按请求剩余输入空间自动派生，不提供手动分层配置；额度提升本身不代表质量或费用收益，须保持题集、模型与判分口径一致对比。

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

# privileged same-model upper-bound controls; run separately from the production reader score
pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split oracle \
  --bench-reader-control direct --report json
pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split oracle \
  --bench-reader-control con --report json
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
| `--bench-judge-model` | 默认取 [test/eval-models.json](../eval-models.json)（或本地 `eval-models.local.json`）的 `judge.model`（当前 `deepseek-reasoner`）；**必须不同于被测模型** |
| `--bench-reader-control direct|con` | **仅 LongMemEval oracle** 的 eval-only 上限控制；省略时运行正常产品 reader。`direct` 把 oracle case 中所有证据会话（完整角色/时间）直接交给被测模型；`con` 按官方 LongMemEval 方式逐会话提取 notes，再由同一被测模型回答。控制模式绕过产品记忆登记/召回，使用同一 scorer/judge，报告 manifest 标注 `privileged`、`productScore: false` 并使用独立 namespace；不得与正常产品分数混读。输入超出模型上下文预算会失败，不截断。note 与最终回答均使用已解析被测模型的完整 `maxTokens` 输出预算，为 reasoning 留空间；官方 CoN reference 的每条 note 固定上限是 500 tokens，所以这里是同方法结构、不同输出预算的 reader 上限对照。若模型返回非 stop `stopReason` 或空文本，该题记为失败，不当作普通答错。 |
| `--report json` | 报告落 `test/reports/bench/<stamp>.json`（建议始终带；同名 `.html` 由启动器自动生成质量摘要页） |

LongMemEval 官方 generation baseline 推荐在 full-history 下提高候选上限以纳入全部会话、保留 assistant 消息、使用 JSON 历史格式，并建议 `con` reading method。此控制模式复用其核心阅读对照：direct 全历史阅读 vs 每会话抽取 reading notes 后再回答；它是 privileged reader 上限实验，不代表产品检索能力或官方榜单分数。输出预算刻意采用被测模型生产配置的有效上限，而非 reference script 的固定 500-token CoN note 上限，避免 reasoning 输出被评测夹具截断。来源：[LongMemEval 官方仓库](https://github.com/xiaowu0162/LongMemEval) 的 Long-Context Generation 说明与 `src/generation/run_generation.py`。

报告与逐题 JSONL（`memory-bench-outcomes.jsonl`）随现有保留组机制留存：
主报告 `<stamp>.json` 与同名 `.html` 在 `test/reports/bench/`，按「最近 3 场」淘汰；
逐题结果作为 bundle 成员 `test/reports/bench/traces/trace-bundle-<stamp>.memory-bench.jsonl`
（复用现有成员名后缀，未改 `scripts/trace-evidence.mjs`）。

**LongMemEval 逐题 JSONL**同时携带 `question_id`、`hypothesis`、`case_id`、原报告字节 SHA-256
与该回答的 SHA-256；官方 `src/evaluation/evaluate_qa.py <metric_model> <hyp_file> <ref_file>`
可直接消费并在结果行保留这些绑定字段（`ref_file` 用官方原始 LongMemEval 数据）。
导出默认写到同组 `<stamp>.json.hypotheses-<report-sha12>.jsonl` 并打印路径；`--out` 也必须留在原报告目录，确保随组保留。
导出后必须导入官方脚本生成的 `.eval-results-<model>` JSONL，或带同样绑定字段的人工 yes/no 逐题文件：

```bash
node test/memory-bench/export-hypotheses.mjs test/reports/bench/STAMP.json
python test/memory-bench/.data/reference/longmemeval-evaluate_qa.py JUDGE_MODEL test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl test/memory-bench/.data/raw/longmemeval_oracle.json
node test/memory-bench/import-verdicts.mjs test/reports/bench/STAMP.json test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl.eval-results-JUDGE_MODEL \
  --scope "LongMemEval official evaluate_qa.py autoeval_label" --judged-at JUDGMENT_COMPLETION_ISO_TIME
```

将 `STAMP` 换成主报告时间戳，`REPORT_SHA` 换成导出脚本打印路径里的 12 位原报告哈希，`JUDGE_MODEL` 换成官方脚本支持的异构判分模型别名，将 `JUDGMENT_COMPLETION_ISO_TIME` 换成真实判分完成时刻；
若 prepare 使用了自定义 data-dir，reference 文件也要指向该目录的 `raw/longmemeval_oracle.json`。

导出为每条 hypothesis 写入原报告 SHA-256 与 UTF-8 回答 SHA-256。导入会逐条验证原报告、唯一
`question_id`、`case_id`、回答文本与回答哈希；重复、未知、报告不匹配或回答被改动的判分行会整体拒绝。
官方日志中的 `autoeval_label.model/label` 是判分者与 yes/no；人工文件使用同一导出行并添加
`"verdict":"yes"` 或 `"verdict":"no"`，同时必须传 `--judge` 身份。两种来源均须明确写出
`--scope` 与 `--judged-at`。导入只生成新的
`<stamp>.json.scored-judge-<judge-hash>-<verdict-log-hash>.json/.html`，使用独占创建模式，
保留源 run 报告；每个判分身份与判分日志内容拥有独立文件名，重复导入不会覆写既有版本。
这些派生文件按报告卫星纳入原 run 的同一保留组，原报告滚出最近三场时一并淘汰。派生报告记录
判分日志 SHA-256、身份、判分口径/范围/时间，以及所选题、已导出回答、
已回填 verdict、未导出回答和缺失 verdict 覆盖数。只有题级数据可以导入；像「17/45」这类没有题号与回答绑定
信息的汇总比例不会被拆成或推造成逐题 verdict。
导出的 hypotheses 与导入时复制留档的 verdict log 也会作为 `.hypotheses-*.jsonl` / `.verdicts-*.jsonl`
卫星跟随原 run 保留，报告记录它们的文件名与 SHA-256。
新 run 在 `subsetDescription.caseRefs` 保存每个 planned case 的 ID、题型和 abstention（包括失败/未执行题）。
回填旧报告时，只从已记录 outcome 的 `caseRef` 读取题级分类；缺失分类的 ID 保持未知，不按 ID 顺序或 `_abs` 后缀猜题型/abstention。
若旧报告自带的 `countsByType` / `abstentionCount` 与 planned 总数一致，报告会用它们作为 aggregate cases 分母，并明确标出未映射 ID 数；否则只报告可映射题型，其他题留在未知桶。

## 5. 判分口径

### LongMemEval（judge + 确定性检索）

- 答案判分：**五套题型模板逐字移植自官方 `src/evaluation/evaluate_qa.py`**（通用 yes/no、
  temporal 免 off-by-one、knowledge-update 允新旧并述、preference rubric、abstention）。
  判定解析保持官方语义（`'yes' in response.lower()`），原始回答落盘可复判。
- judge 走测试侧网关的端点与 api_key（同 key 异构；本地 `eval-models.local.json` 可覆盖网关端点与凭据；默认 judge 模型由
  [test/eval-models.json](../eval-models.json) 提供——当前 `deepseek-reasoner`，可用
  `--bench-judge-model` 或 `DESKPET_EVAL_JUDGE_MODEL` 覆盖；被测模型以本机配置为准，也可在
  同一文件或 `DESKPET_EVAL_MODEL` 覆盖）。judge 模型经网关按 id 解析（不借用被测模型的预算），
  单次输出预算 `judgeOutputBudget`：下限 1024、上限 4096 token，绝不越过模型自身上限 ——
  reasoning judge 的 thinking 也计入 `maxTokens`，固定 512 曾把一次判分截断成「未裁决」
  （2026-10-03 LME oracle `852ce960`），实际计费仍按真实输出。**唯一纪律：judge 模型必须不同于
  被测模型**（配置相同会在开跑前报错），报告顶层记录 `judgeModel`。judge 失败（超时/空响应）只记
  「未裁决」，不进正确率分母，另计 `judgeFailures`。
- 确定性检索指标（不依赖 judge）：`sessionRecall`（gold `answer_session_ids` 被渲染证据覆盖的比例）、
  `turnRecall`（gold `has_answer` 的 **user 事实轮**被覆盖的比例）、`assistantTurnRecall`
  （gold `has_answer` 的 assistant 对话轮被覆盖的比例）、`candidateSessionRecall`（候选池会话级覆盖）。
  **本仓适配口径，不是官方 R@k**。
- 每个题型的 `cases` 都按本次完整 selected subset 计数；未执行、失败与 judge 未裁决均留在题数分母，
  但只有有逐题 verdict 的题进入正确率分母。`attemptedCells` 记录实际进入执行的 cell 数，
  不从已产出 outcome 数反推。
- `single-session-assistant` 按题型单列且**计入全部所选题集的总正确率**。另报产品用户事实子集，
  按题型排除 `single-session-assistant`，作为用户来源事实的附加比较口径；完整对话检索仍以全选中题集为主口径。
  当前采集夹具会保留 assistant 对话轮供检索，单列类型不表示当前产品结构性不可回答。
- `strictEmptyTool` 单独列出严格空工具结果：只纳入完整回答且显式记录 `usedTools=false`、
  `protocolViolations=[]`、`requestedMode=none`、`observedCalls=0` 的题。工具调用/协议违规样本不从全题质量分数剔除，
  仍按 verdict 判分；它们只归为污染样本，不能混入严格空工具 baseline。旧报告或工具观测字段缺失的 run 会记为未知，
  不会被追认为严格空工具。

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

- LongMemEval 每个原始会话建立隔离 JSONL 夹具，按顺序保留 user/assistant 角色与题目时间；不逐轮调用
  `sendMessage` 重放。所有角色消息进入对话检索，只有 user 轮另登记为用户事实 `MemorySource`，assistant
  轮不会伪装成用户记忆。LoCoMo 仍为两个说话人的全部轮次直登记来源，MemoryBank 为 `query` 轮登记来源；
  其来源坐标分别是 LME `会话id:轮下标`、LoCoMo `样本id:dia_id`、MemoryBank `日期#轮下标`。
  `evidence` 截 2000 字符（对齐产品 `EVIDENCE_CHARS`），`sourceLength` 保留原文长度（产品 dreaming
  对 >4800 字符的整条来源丢弃，次数如实计入报告）。
- 提取走**真实 dreaming**（`manual` 模式，绕开每日预算；循环 sweep 直至无待处理来源）。
- LoCoMo 与 MemoryBank 的 **session-scope 候选归一为 user scope**：Rust 禁止跨范围改归属，用 `add`（同内容/来源）+ `forget`
  原条目实现；否则提问发生在新建会话会漏召回。次数记入 `ingest.scopeNormalized`。
  **必须两段式**（先全部 `add`、再全部 `forget`，规划在 `scope-normalize.mjs`）：Rust 的遗忘
  按来源事件写 `block_extraction` 墓碑，之后任何引用该来源的 `add` 都会判「来源未登记」；
  逐条 `add→forget` 在共享来源的候选上会把整题打成基础设施失败（2026-10-03 LME oracle
  `lme-oracle-e01b8e2f` 的故障），而不是被测能力问题。LongMemEval 保持生产 scope 规则，不做 add+forget
  归一；完整对话由会话检索读取，user-origin 事实仍按产品的来源与 scope 语义治理。
- 提问：每题新建会话；cell = 题 × 1 trial（外部集是观测证据，不套自建集的 ≥3 trial 配对纪律）。
- 组复用：LoCoMo 一段对话灌一次库、组内多题提问；MemoryBank 一个角色同理；LongMemEval 每题一组。
- 每个提问回合通过 `toolMode: "none"` 请求禁用模型工具，并记录实际调用数与协议违规；不改全局工具注册表。
  存储为隔离 E2E 根内的真实 Rust SQLite。
- 模型工具/权限边界不变；**不为拉高分改产品**：recall 预算（CONFIG `ai.memory.core/recall`）、
  dreaming 截断（1200）/丢弃（4800）造成的压分照实记录（`ingest` + `manifest.memoryConfig`）。
- **召回时限（2026-10-09 起）**：bench 把 `ai.memory.recallTimeoutMs` 覆盖为 120 秒（生产默认 4 秒）。
  这是**测量口径**而非给产品放水：生产进程长期在线、会话索引随召回增量建立，4 秒交互延迟预算
  够用；而基准每题一组全新库 = 每题都付一次整组冷索引，4 秒内原文通道必然退化为空
  （2026-10-09 oracle 实测：索引 0 会话、assistant 题 8/8 零候选），测得的是冷启动伪影而不是
  检索能力。token 预算与 dreaming 截断仍按上一条照实记录、不调整；时限覆盖记录在报告
  `manifest.memoryConfig` 供审计。
- 题目基准日（2026-10-03 修正）：官方 LongMemEval 以 `question_date` 为「当前日期」，
  适配器把提问回合的尾随注记 `[当前时间]` 锚到题目基准日（**本地墙钟**，`questionTimeAnchor`），
  相对日期题（「多少天前」「上周二」）从此在官方口径下测量；锚点只活在该提问回合内、
  finally 复位，生产路径仍用真实时钟。**题面一个字不改**，报告 manifest 记
  `questionTimeAnchoring` 供审计。其余数据集没有基准日，保持真实时钟。
- **reasoning 模型的评审输出上限（2026-10-03 实测与处理）**：产品 dreaming 的单次评审输出
  预算按模型窗口自动推导（窗口 × 1/8、32k 封顶；reasoning 的 thinking 也计入）。若显式压低
  `ai.memory.dreaming.reviewMaxTokens` 后仍超限，提取会如实以「Provider 输出达到长度上限，
  拒绝使用不完整结果」失败（拒绝采用不完整输出是产品的保守行为，不是基准缺陷），按
  `status: "failed"`（`error` 注明 `model-output-length`）记入报告且一次 run 继续观测其余题目。
  **解法**：先看自动预算是否被显式值压低；需要临时放大时在
  `test/eval-models.local.json` 写 `underTest.reviewMaxTokens`，或改用非 reasoning 模型
  （如 deepseek-chat）。接新模型先按 §8 的冒烟层验证提取链路。

## 7. LongMemEval S 子集（本轮不跑）

- S-cleaned（277 MB）由 prepare 按同一固定 revision + SHA-256 下载；转换复用同一 importer，
  默认按已安装 oracle 子集的同题号选题（保证两档可比），产物落在
  `<data-dir>/cases/longmemeval/s-subset.json`。
- 想跑 S：`node test/memory-bench/prepare.mjs --dataset longmemeval --split s`，然后
  `pnpm run test:memory-bench -- --bench-dataset longmemeval --bench-split s …`。成本量级见 §8。

## 8. 分层节奏：按目的挑层，不每次全跑

| 梯队 | 何时跑 | 命令（即梯队别名，覆盖全部数据集） | 量级（deepseek 系列计价） |
|---|---|---|---|
| **冒烟自检** | 接新模型 / 改采集或判分后先跑 | `pnpm run test:memory-bench:smoke`（LongMemEval oracle ×3 题） | 几分钟、几千 tokens |
| **常规回归**（默认） | 记忆核心（召回 / 提取 / 治理）改动后 | `pnpm run test:memory-bench:regression`（oracle 全量 52 题） | 0.5–1M（每题 ≈1 次提取 sweep + 1 次提问 + 1 次 judge） |
| **中文对照** | 中文卡 / 中文体验改动后 | `pnpm run test:memory-bench:zh`（MemoryBank cn 15 角色 × 100 题） | 最小（提取近零，主要是 judge） |
| **检索难度** | 里程碑 / 发版前 | `pnpm run test:memory-bench:difficulty`（LongMemEval S；需先 `node test/memory-bench/prepare.mjs --dataset longmemeval --split s` 装 277MB） | 2.5–4.5M（每题 haystack ≈122k） |
| **对外可比** | 需要对外引用数字时 | `pnpm run test:memory-bench:external`（LoCoMo，默认分批 100 题；换批量用 `test:memory-bench -- --bench-dataset locomo --bench-limit N`） | 免 judge（词面 F1）；1986 题信息量最大 |

别名只是固定最常见口径；其它参数组合仍走 `pnpm run test:memory-bench -- <参数>`。

成本大头在 dreaming 提取（每题 1~5 次 sweep），judge 占比小；推理模型先确认自动输出预算
（必要时用 `underTest.reviewMaxTokens` 覆盖）并用冒烟层验证提取链路。每轮报告都记录实际
usage，用来校准这里的量级。
**默认节奏 = 冒烟 → 常规**；中文 / 难度 / 对外只在对应触发条件下跑，不随每次改动全量执行。

## 9. 测试与验证

- 纯函数（importer / selector / scorer / porter / judge 模板 / runner 编排）配 L2 单测：
  `test/unit/memory-bench/*.test.ts`，合成小样本，不读真数据。
- 数据转换的完整性由 `prepare.mjs --verify` 与 `validate*File` 校验保证；不做 datasetHash/三重哈希链
  （外部集不进门禁，最简完整性守卫即 revision + fileSha256 + importTransformVersion）。
- smoke：`pnpm run test:memory-bench:smoke`（等价于 `--bench-dataset longmemeval --bench-split oracle --bench-limit 3`）
  （真实 Provider；`--bench-judge off` 可只验采集管线）。

## 10. 红线

- LoCoMo 保留完整许可原文与署名，标注非商用；MIT 数据保留版权与许可声明。
- 不冒充官方榜单成绩；报告写明「基于官方脚本/模板的自适配结果」及全部口径差异。
- 下载一律固定 revision + SHA-256，防上游漂移静默改分。
- judge 异构于被测模型，不允许被测模型自评。
