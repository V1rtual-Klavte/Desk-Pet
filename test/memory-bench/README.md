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
- LoCoMo 与 LongMemEval 质量分只来自各自锁定 revision 的官方评分脚本；原始 generation 报告在官方结果导入前显示
  `pending_official`，不提供本地近似主分。MemoryBank 正确性仍使用本仓自适配 judge 口径。

预算对比读取 manifest 的 `memoryConfig.budgetPolicy=request-headroom` 与逐题 `memory_recall_start`（总预算、core/recall 额度、实际窗口），并以 `memory_recall_rendered` 与 `memory_navigation_rendered` 核对首包及真正进入后续请求的原文页；搜索片段与目录只作定位，不冒充已读原文。bench 提问经正式 `sendMessage` 路径执行并设 `toolMode: "memory"`，仅开放 `memory_list/search/read`；Plan、MCP、Skill 和其他工具在该隔离测量模式下不可用，`provider_payload.toolNames` 留存真实请求工具名。产品普通回合仍使用默认完整工具集合。普通首包预算上限来自 ContextKernel 实际 headroom 与 `toolResultTokenBudget(window)` 安全限制；首包选择按受治理 sessions 目录完整性与 `indexedTextBytes` 保守规模上界决定小范围枚举、命中会话聚焦或跨会话候选导航，不再固定限制为一个核心条目加一个动态组。计量包含最终完整 JSON 的状态与引用 metadata；预算淘汰时 history 覆盖会降级。范围辅助枚举只增加本地 IPC/JSONL 读取，不增加模型 pass；符合条件的 R1′ reader 是单独计量的一次性模型请求。机制门禁不证明准确率或成本收益；答案质量、主模型工具轮、重复输入、缓存读写及灌库/整理成本都须经同题、同模型、同生成协议的配对对照验证，缓存收益仍未实测。

逐题 outcome 分开记录完整 `usage`、已知请求用量小计 `knownUsage` 与未知请求数 `unknownUsageRequests`；按 memoryStage 分账时，reading 单列且包含在读侧总计与逐题总量内，缓存输入按网关 usage 口径只计一次，dreaming 灌库/整理成本单列。计量从 `provider_request_start` 建立请求占位，并以同一 span 的结束事件回填，重复事件按 span 去重；只有 start、没有 end 的请求也计为未知，不能按零成本处理。只要该题有请求缺少可用 usage，完整 `usage` 就保持未知；失败题也保留此前采集到的已知小计和未知请求数。报告汇总只累加已知用量并单独保留未知请求数，不将部分小计标成整题或整场总成本。

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
  --bench-limit 10 --report json

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
| `--bench-limit N` | 本次最多跑几题；先保证同组题连续，再按题数截断，因此可能从组中间结束 |
| `--bench-deadline-minutes N` | 整个 memory-bench 原生 E2E runner 的墙钟截止时间；正整数分钟，默认 480，最大 35,791（Node timer 可表示的最大整分钟）。只影响 runner 总截止，不改变模型请求或产品超时；不得用于非 bench 运行 |
| `--bench-case id1,id2` | 精确题号过滤（调试用） |
| `--bench-seed` | 组内洗牌种子，默认 `memory-bench-2026-10-03` |
| `--bench-judge on/off` | 只用于 MemoryBank 的自适配 judge；LME 与 LoCoMo generation 默认不请求本地 judge，质量分等待官方结果 |
| `--bench-judge-model` | 仅 MemoryBank 使用；默认取 [test/eval-models.json](../eval-models.json)（或本地 `eval-models.local.json`）的 `judge.model`（当前 `deepseek-v4-pro`）；**必须不同于被测模型** |
| `--bench-reader-control direct|con` | **仅 LongMemEval oracle** 的 eval-only 上限控制；省略时运行正常产品 reader。`direct` 把 oracle case 中所有证据会话（完整角色/时间）直接交给被测模型；`con` 按官方 LongMemEval 方式逐会话提取 notes，再由同一被测模型回答。控制模式绕过产品记忆登记/召回，报告 manifest 标注 `privileged`、`productScore: false` 并使用独立 namespace；不得与正常产品分数混读，质量分仍须走锁定官方 judge runner。输入超出模型上下文预算会失败，不截断。note 与最终回答均使用已解析被测模型的完整 `maxTokens` 输出预算，为 reasoning 留空间；官方 CoN reference 的每条 note 固定上限是 500 tokens，所以这里是同方法结构、不同输出预算的 reader 上限对照。若模型返回非 stop `stopReason` 或空文本，该题记为失败，不当作普通答错。 |
| `--report json` | 报告落 `test/reports/bench/<stamp>.json`（建议始终带；同名 `.html` 由启动器自动生成质量摘要页） |

LongMemEval 官方 generation baseline 推荐在 full-history 下提高候选上限以纳入全部会话、保留 assistant 消息、使用 JSON 历史格式，并建议 `con` reading method。此控制模式复用其核心阅读对照：direct 全历史阅读 vs 每会话抽取 reading notes 后再回答；它是 privileged reader 上限实验，不代表产品检索能力或官方榜单分数。输出预算刻意采用被测模型生产配置的有效上限，而非 reference script 的固定 500-token CoN note 上限，避免 reasoning 输出被评测夹具截断。来源：[LongMemEval 官方仓库](https://github.com/xiaowu0162/LongMemEval) 的 Long-Context Generation 说明与 `src/generation/run_generation.py`。

报告与逐题 JSONL（`memory-bench-outcomes.jsonl`）随现有保留组机制留存。若 finalize 或 manifest 构造失败，已采集 outcomes 与失败信息仍写入可审阅的失败报告；该保留行为不覆盖后续评分计算失败：
主报告 `<stamp>.json` 与同名 `.html` 在 `test/reports/bench/`，按「最近 3 场」淘汰；
逐题结果作为 bundle 成员 `test/reports/bench/traces/trace-bundle-<stamp>.memory-bench.jsonl`
（复用现有成员名后缀，未改 `scripts/trace-evidence.mjs`）。

**LongMemEval 逐题 JSONL**同时携带 `question_id`、`hypothesis`、`case_id`、原报告字节 SHA-256
与该回答的 SHA-256；官方 `src/evaluation/evaluate_qa.py <metric_model> <hyp_file> <ref_file>`
可直接消费并在结果行保留这些绑定字段（`ref_file` 用官方原始 LongMemEval 数据）。
导出默认写到同组 `<stamp>.json.hypotheses-<report-sha12>.jsonl` 并打印路径；`--out` 也必须留在原报告目录，确保随组保留。
导出后必须导入 runner 生成的 `.eval-results-<alias>.official-longmemeval.jsonl` 审计派生，或带同样绑定字段的人工 yes/no 逐题文件：

```bash
node test/memory-bench/export-hypotheses.mjs test/reports/bench/STAMP.json
node test/memory-bench/run-official.mjs longmemeval test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl --data-dir test/memory-bench/.data --split oracle --metric-model JUDGE_MODEL
node test/memory-bench/import-verdicts.mjs test/reports/bench/STAMP.json test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl.eval-results-JUDGE_MODEL.official-longmemeval.jsonl \
  --scope "LongMemEval official evaluate_qa.py autoeval_label" --judged-at JUDGMENT_COMPLETION_ISO_TIME
```

将 `STAMP` 换成主报告时间戳，`REPORT_SHA` 换成导出脚本打印路径里的 12 位原报告哈希，`JUDGE_MODEL` 换成官方脚本支持的异构判分模型别名，将 `JUDGMENT_COMPLETION_ISO_TIME` 换成真实判分完成时刻；
若 prepare 使用了自定义 data-dir，reference 文件也要指向该目录的 `raw/longmemeval_oracle.json`。
`run-official.mjs` 会校验锁定数据与 evaluator SHA，再直接启动固定 revision 的官方 `evaluate_qa.py`，
不会在本仓重写官方模型 prompt 或判分函数；该官方脚本会请求 `JUDGE_MODEL` 对答案作 yes/no 判定。
只支持上游源码列出的三个**请求别名**：`gpt-4o-mini` → `gpt-4o-mini-2024-07-18`、`gpt-4o` → `gpt-4o-2024-08-06`、
`llama-3.1-70b-instruct` → `meta-llama/Meta-Llama-3.1-70B-Instruct`（后者要求 localhost OpenAI-compatible 服务）；DeepSeek 不支持且不会映射。
OpenAI 项需要调用者环境提供 `OPENAI_API_KEY`。上游 `requirements-lite.txt` 在该 revision 给出 Python 3.9、
`openai==1.35.1`、`tqdm==4.66.4`、`backoff==2.2.1`、`numpy==1.26.3`、`nltk==3.9.1`，另有未固定版本的 `packaging`。
runner 只接受上游 `model_zoo` 中的三个 alias；deepseek 等未列 alias 会明确拒绝，不会映射或被标为官方评分。
runner 保留上游原生 `.eval-results-<alias>` 文件不变，另以独占新建方式写入 `.eval-results-<alias>.official-longmemeval.jsonl`，逐行附加锁定脚本/数据 revision 与 SHA metadata；导入使用该审计派生，拒绝缺失或不匹配 metadata。上游 `autoeval_label.model` 只记录 API 请求名，不包含服务端返回的 raw model identity，因此 metadata 记录并供导入器核对 runner 声明的锁定脚本与请求别名；来源可信依赖受控 runner 的操作链，不能独立防伪造 sidecar，也不能证明服务端的实际部署身份；LoCoMo QA scoring 不涉及 judge 请求；LME 官方 judge 由使用者显式另行启动。

导出为每条 hypothesis 写入原报告 SHA-256 与 UTF-8 回答 SHA-256。导入会逐条验证原报告、唯一
`question_id`、`case_id`、回答文本与回答哈希；重复、未知、报告不匹配或回答被改动的判分行会整体拒绝。
官方原生行中的 `autoeval_label.model/label` 是请求模型字符串与 yes/no 标签，不是服务端返回模型的身份回执；runner 审计派生再绑定锁定脚本/数据和请求名。人工文件使用同一导出行并添加
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

### LongMemEval（官方脚本评分 + 确定性检索）

- 官方回填入口另提供真实 script runner：上游 `xiaowu0162/LongMemEval` revision
  `9e0b455f4ef0e2ab8f2e582289761153549043fc`，`src/evaluation/evaluate_qa.py` SHA-256
  `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`。`run-official.mjs longmemeval`
  直接启动锁定 evaluator，保留其原生 `.eval-results-<alias>` 文件，并生成带 runner audit metadata 的 `.eval-results-<alias>.official-longmemeval.jsonl` 派生文件供 import-verdicts 回填；
  官方脚本运行依赖/API credentials 由调用者 Python 环境提供，本仓未锁其 Python 环境版本。
- LME generation 主路径不运行本仓 judge，原始质量分保持 `pending_official`；官方回填由上一节的锁定脚本产生。
  本仓不再保留 LongMemEval 本地 judge prompt 或判分分支，避免模板近似结果混入主评分。
- MemoryBank 的自适配 judge 走测试侧网关端点与凭据；默认 judge 模型由
  [test/eval-models.json](../eval-models.json) 提供——当前 `deepseek-v4-pro`，仅作为 MemoryBank 自适配 judge，可用
  `--bench-judge-model` 或 `DESKPET_EVAL_JUDGE_MODEL` 覆盖；被测模型以本机配置为准，也可在
  同一文件或 `DESKPET_EVAL_MODEL` 覆盖）。judge 模型经网关按 id 解析（不借用被测模型的预算），
  单次输出预算 `judgeOutputBudget` 取已解析模型输出上限与扣除本次输入/协议开销后的窗口剩余量中的较小值，不另设 4096-token 硬顶；模型上限无效或没有输出空间按判分失败处理 ——
  reasoning judge 的 thinking 也计入 `maxTokens`，固定 512 曾把一次判分截断成「未裁决」
  实际计费仍按真实输出。**唯一纪律：judge 模型必须不同于
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
- `strictEmptyTool` 仅保留为旧报告与空工具控制组的附加口径；当前产品评测使用 `requestedMode=memory`，正常记忆工具调用不记协议违规，也不进入严格空工具基线。该旧基线单独列出严格空工具结果：只纳入完整回答且显式记录 `usedTools=false`、
  `protocolViolations=[]`、`requestedMode=none`、`observedCalls=0` 的题。工具调用/协议违规样本不从全题质量分数剔除，
  仍按 verdict 判分；它们只归为污染样本，不能混入严格空工具 baseline。旧报告或工具观测字段缺失的 run 会记为未知，
  不会被追认为严格空工具。

### LoCoMo（Snap 官方评分脚本）

- 官方入口固定为 `snap-research/locomo` revision `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`，
  [`task_eval/evaluation.py`](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py) SHA-256 `8e3be5d57ff2ff9ec5cd05939592f468c5f3f1fd95d13e431932bdf6bf0fd6fd`；
  主评分直接调用 `eval_question_answering(..., eval_key="prediction")`。官方 NLTK PorterStemmer、
  normalize/F1 与 category 1–5（含 category 5 adversarial）均由上游脚本执行。本仓不保留近似评分或 fallback。
- **官方评分器不等于官方生成协议。** 本仓产品主路径将原始 `question` 原样交给 `sendMessage`；
  在隔离评测 Card 的输出规则中统一要求简短英文、保留完整必要答案，信息不足固定回复 `No information available`。
  该规则对所有题相同，不读取 category、answer 或 gold evidence；不增加答案选项，不事后改写模型回答，
  不改变检索问题或产品检索流程。manifest 的 `answerFormat` 留存格式 ID、规则全文与 SHA-256、激活 Card ID/hash；
  保存与重载 hash 不一致即失败。短答只控制表达，不设导致多项答案被截断的字数硬顶。
  固定 revision 的 [`task_eval/gpt_utils.py`](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py) 则要求短语回答并尽量复用原文，category 2 追加日期提示，category 5
  将 “Not mentioned in the conversation” 与 `qa.answer` 随机排列成选项，并把模型的选项回答解码回选项文本。
  锁定 `locomo10.json` 的 446 道 category 5 题中，444 道只有 `adversarial_answer`、2 道同时含 `answer` 与
  `adversarial_answer`；该 revision 的生成 helper 直接读取 `qa.answer`，所以不能将它描述成对当前 raw 文件可直接运行的
  generation baseline。上游判分器对 category 5 的规则是检查 prediction 是否含 “not mentioned” 或
  “no information available”；本仓 runner 将 raw `answer` / `adversarial_answer` 规范到判分输入的 `answer` 字段，
  但不改模型回答。因 generation prompt 不同，官方 scorer 分数不能直接当作同协议官方生成基线或榜单横向结果。
- 运行基准时 LoCoMo judge 默认关闭，原始质量字段为 `pending_official`，不会把 pending 当作 0 分。评分链：
  ```bash
  node test/memory-bench/export-hypotheses.mjs test/reports/bench/STAMP.json
  node test/memory-bench/run-official.mjs locomo test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl --data-dir test/memory-bench/.data
  node test/memory-bench/import-verdicts.mjs test/reports/bench/STAMP.json test/reports/bench/STAMP.json.hypotheses-REPORT_SHA.jsonl.official-locomo.jsonl --scope "Snap LoCoMo official evaluation.py" --judged-at 2026-10-10T12:00:00Z
  ```
  `STAMP`、`REPORT_SHA` 与判分完成时间须换成真实值。官方脚本标注 Python 3.9；本仓以 Python 3.11
  隔离环境安装可用的最小依赖（锁在 [requirements-official-locomo.txt](requirements-official-locomo.txt)）：
  `regex==2022.10.31`、`numpy==1.26.0`、`nltk==3.8.1`、`bert-score==0.3.13`。用 `uv` 建立并安装：
  ```bash
  uv venv --python 3.11 test/memory-bench/.data/python-env
  uv pip install --python test/memory-bench/.data/python-env/bin/python -r test/memory-bench/requirements-official-locomo.txt
  ```
  执行 runner 时设置 `DESKPET_BENCH_PYTHON=test/memory-bench/.data/python-env/bin/python`。上游 reference
  requirements 还包含 CUDA/Linux 大环境；本 runner 只调用 QA 函数，但脚本顶层会 import bert-score，故这里锁定
  所需直接依赖，不声称复现训练/模型环境。`test/memory-bench/.data/python-env/requirements.lock.txt` 记录当前
  平台解析出的完整依赖版本。runner 不自动安装依赖，缺依赖即失败；官方 QA scoring 本身不发模型请求。
  官方 runner 从锁定 `raw/locomo10.json` 按 sample/question index 获取 gold，不把答案导入 generation hypotheses。
  它验证原数据与 evaluator SHA、逐题 question/category/hypothesis/source report 绑定，拒绝缺题、重复和篡改；
  导入必须覆盖报告全部已完成回答。派生报告独立保存，源报告保持原样。另报本仓确定性
  `evidenceRecallMean`（gold evidence dia_id 被渲染证据覆盖比例），不并入官方 QA 分。

### MemoryBank cn（确定性检索 + judge 一致性）

- 当前锁定的 `zhongwanjun/MemoryBank-SiliconFriend` revision
  `cf61c4196e4cfdb0f2b7a0316249fa40312dc3a9` 只提供中文记忆数据与 probing questions；锁文件没有官方 evaluator，
  探测题也没有金标答案。因此 MemoryBank 不声称官方判分。确定性指标：
  `evidencePresentRate`（至少渲染一条记忆的题占比）、`dateHintHitRate`（题面点名「N月N日/号」时，
  该日期出现在渲染证据 `observedAt` 的比例）、`renderedEvidenceP50`。
- 正确率由同一 judge 适配器给出：以整段角色历史为参照判「回答是否与历史一致且答到问题」
  （**本仓自适配模板**，不代表官方指标）。按历史的角色与日期判分；有答案却拒答、遗漏关键答案或编造记为错，
  历史确实缺失信息或前提错误时允许准确指出缺失或纠正前提。只接受 judge 单词 `yes/no`，其他输出记为未裁决。
- [原论文 §4.2](https://arxiv.org/html/2305.10250v3#S4.SS2) 使用人工评分，答案正确性为 `0/0.5/1`，另评检索、连贯性与排序；
  论文描述中英各 97 题，[公开仓库](https://github.com/zhongwanjun/MemoryBank-SiliconFriend#evaluation-data) 发布的中文版为 100 题。
  本仓跑公开中文版全量 100 题、每题一次二元 judge，结果不能与论文人工评分直接横比。

### 外部 harness 的做法与结果可比性

以下是 **2026-10-11 对公开源码的核对**；链接固定到核对时的 commit，仅作方法参考，
不表示相关项目的每篇论文或线上服务都使用同一配置，也不改变本仓 `upstream-lock.json`。
历史导入、任务专用 prompt 与评分适配都有公开先例；可信度取决于协议是否明确、对照是否公平、证据能否复跑。

| Harness | 历史与回答流程 | 题集、评分与复现边界 |
|---|---|---|
| LongMemEval 官方 | 允许把带时间戳的历史交给自己的系统，导出 `question_id` / `hypothesis` 后评分；另提供全历史直读与先提取 notes 再回答的基线 | 自有系统接入是官方支持的路径，不要求逐轮重放聊天；质量分由官方 LLM judge 产生。[官方说明](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md) |
| Mem0 公开 LoCoMo runner | 每段对话按时间逐 turn 调用记忆写入接口；构建完成后，检索记忆并用专用 prompt 回答 | 默认类别 1–4，共 1540 题，排除 446 道 category 5；使用自定义二元 LLM judge，列表答案至少命中一个正确项目即可判正确，日期容差为 14 天。该口径与 Snap 官方 F1 不同。[runner](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/run.py)、[prompt / judge](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/prompts.py) |
| Letta 已归档的 LoCoMo harness | 默认按 session 整理带日期的历史文件并建立索引；每题新建 agent，开放 `search_files` 与 `answer_question` 工具 | 跳过 category 5；通过独立 LLM rubric 判为 A/B/C，只把 A 计为正确。[数据与 agent 接线](https://github.com/letta-ai/letta-leaderboard/blob/802a794263279839f9384bfd518ca9da3d059d37/leaderboard/locomo/locomo_benchmark.py)、[评分实现](https://github.com/letta-ai/letta-leaderboard/blob/802a794263279839f9384bfd518ca9da3d059d37/leaderboard/utils.py) |
| OpenViking OpenClaw LoCoMo runner | 由 OpenClaw 会话调用产品记忆与回答；产品检索支持 L0 摘要、L1 概览、L2 正文按预算深化 | 公开 eval 排除 category 5，使用语义 LLM judge；回答 usage 与灌库 embedding/VLM、judge 成本分开，不可与本仓全部 1986 题官方 F1 直接排名。[eval](https://github.com/volcengine/OpenViking/blob/4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5/benchmark/locomo/openclaw/eval.py)、[judge](https://github.com/volcengine/OpenViking/blob/4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5/benchmark/locomo/openclaw/judge.py) |
| 通用 lm-evaluation-harness | 按任务配置组织输入，允许定制 prompt、答案提取与重复次数；不专门负责产品记忆灌库 | 公开任务 YAML 与代码 commit 以复现设置，支持固定随机种子、保存逐题输入输出；输出过滤也属于需披露的协议。[任务规范](https://github.com/EleutherAI/lm-evaluation-harness/blob/d6de81643928d653435c431bae19945d41d32520/docs/task_guide.md)、[运行与日志参数](https://github.com/EleutherAI/lm-evaluation-harness/blob/d6de81643928d653435c431bae19945d41d32520/docs/interface.md) |
| LongMemEval-V2 官方 harness（独立基准） | 记忆模块实现 `insert` / `query`，返回证据后由 harness 限制上下文 token，再交给 reader | 查询接口不提供 gold、题型或原始题目记录；同时评估回答质量与查询延迟。它是方法参考，不是本仓已接入的 LongMemEval V1 评分入口。[接口与评测说明](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/README.md) |

**同名数据集不足以保证可比。** 本仓 LoCoMo 全集为 1986 题、10 段对话，包含 category 5；
官方类别 1–4 主要测词干化后的词面 F1，类别 5 检查弃权短语，因此整体官方得分不是语义正确率。
与只测 1540 题或采用宽松 LLM judge 的结果比较前，必须对齐题集、生成 prompt、模型、
证据预算、工具权限、超时和评分规则；不能直接按不同口径的百分比排名。语义人工复核可作为独立补充，不能覆盖原始官方分。

**成本也须同口径。** 上述 Mem0 LoCoMo runner 未提供完整的输入 / 输出 token 账本；
Letta 结果虽有 `input_tokens` / `output_tokens` 字段，其公开实现不足以确认包含 judge 请求或缓存读写细分。
检索证据 token、在线模型请求 token 与含记忆构建的端到端消耗分别列示；构建成本按实际复用题数摊销，
回答与内部补查 / 阅读 / 改写、推理输出、重试及失败请求照实记账，judge 成本另列。
缓存命中影响计费，但仍属于输入量；比较时不能重复累加，也不能把缓存字段缺失当作零命中。
没有同题、同模型、同回答规则的直读配对对照，单次记忆管线结果不能证明比全量直读省 token 或提高正确性。

**OpenViking 机制参考与本仓变更。** 固定核对 revision 为 `4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5`。
其 [分层上下文](https://github.com/volcengine/OpenViking/blob/4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5/docs/en/concepts/03-context-layers.md)
先用摘要/概览定位，再在独立的 [装配预算](https://github.com/volcengine/OpenViking/blob/4c9a755bff4d31fd9bd9a3be1a19a6054ef3cea5/openviking/retrieve/context_assembler/budget.py) 内按需深化；模型容量不等于检索额度。
Desk-Pet 保留原有受治理 SQLite/JSONL，先用本地互补词与内容词排名选证据，限制每题证据与累计阅读成本，
补查只读新增正文和旧的可核对摘录，小型单事实证据由主模型直读，输出遵守用户要求。
这不是已经接入 OpenViking 的完整摘要树、向量检索或跨请求 Provider 缓存服务；Provider 命中仍需看实际返回的 cache 计数。
确定性回归通过只能证明机制和治理分支，不能证明质量提升或 token 节省；新旧产品结果须分开报告，
停下的旧 LoCoMo 批次不拼接新实现答案作为同一全量结果，官方评分器与导出/回填链路保持原口径。

**本仓 LoCoMo / LongMemEval 结果的引用边界：**「Desk-Pet 在 LoCoMo / LongMemEval 上的开发方自测，
采用锁定官方评分器，公开产品适配协议和运行条件。」MemoryBank 使用前述自适配口径，不能套用该表述。
LoCoMo 的统一英文短答规则见本节，历史导入与召回超时差异见 §6；
该结果不称官方完整复现或独立第三方认证。每题一次、同一对话内多题相关，不能把 1986 题视为
1986 份独立历史或用单次结果证明稳定性。开发调试接触过的案例须披露，不能将其称为盲测；
子代理审查属于内部复核。复现所需证据包括命令、代码与数据版本、配置差异、模型身份、
原始回答、官方判分输出、完整覆盖数、失败与未裁决记录，以及分阶段成本。

## 6. 采集管线（与自建集的差异）

- LongMemEval 每个原始会话、MemoryBank 每个历史日期、LoCoMo 每个原始 session 都建立隔离 JSONL 夹具，保留完整角色与原始时间；不逐轮调用
  `sendMessage` 重放。所有角色消息进入对话检索，只有 user 轮另登记为用户事实 `MemorySource`，assistant
  轮不会伪装成用户记忆；MemoryBank 的 `query/response` 对应 user/assistant，只有 `query` 登记事实来源。
  `sessionId/entryId/seq` 指向真实夹具条目；LoCoMo 来源保留 speaker header、session date 与 `dia_id`，并原样附加官方 `blip_caption`
  文本字段（不加载图片、不做额外视觉推理，也不把 QA query 当 caption）；MemoryBank 的 `日期#轮下标` 仅作来源标签。
  `evidence` 截 2000 字符（对齐产品 `EVIDENCE_CHARS`），`sourceLength` 保留原文长度（产品 dreaming
  对 >4800 字符的整条来源丢弃，次数如实计入报告）。
- 提取走**真实 dreaming**（`manual` 模式，绕开每日预算；循环 sweep 直至无待处理来源）。
- 三个外部基准均按真实 session 建立 JSONL 夹具并保留原角色、时间与来源坐标，不把 session 来源做 `add`+`forget` 转成 user scope。
  所有角色消息可通过真实 JSONL 会话通道检索，只有原始 user 发言另登记为用户事实；LoCoMo 保留官方提供的 `blip_caption`
  （只用文本字段，不读图片/跑视觉模型，也不把 QA query 当 caption）、两个 speaker header、session date 与每轮 `dia_id`，
  避免把 assistant 发言伪装成用户记忆或改变产品 scope 语义。
- 提问：每题新建会话；cell = 题 × 1 trial（外部集是观测证据，不套自建集的 ≥3 trial 配对纪律）。
- 组复用：LoCoMo 一段对话灌一次库、组内多题提问；MemoryBank 一个角色同理；LongMemEval 每题一组。
- 每个问题通过正式 `sendMessage` 入口提问，设置 `toolMode: "memory"` 只开放既有记忆导航工具，并记录实际调用数与协议违规；不改全局工具注册表。该限制属于 bench 隔离测量模式，产品普通回合仍使用默认完整工具集合。
  存储为隔离 E2E 根内的真实 Rust SQLite。
- 模型工具/权限边界不变；**不为拉高分改产品**：recall 预算（CONFIG `ai.memory.core/recall`）、
  dreaming 截断（1200）/丢弃（4800）造成的压分照实记录（`ingest` + `manifest.memoryConfig`）。
- **召回时限（2026-10-09 起）**：bench 把 `ai.memory.recallTimeoutMs` 覆盖为 120 秒（生产默认 4 秒）。
  这是观察冷索引完成后检索能力的**扩展测量条件**：每组新库需要建立会话索引，
  LongMemEval 每题一组，LoCoMo / MemoryBank 则按对话 / 角色复用组；不能把所有题都描述成重新灌库。
  延长等待时间会改变可用证据和完成率，因此结果不代表默认 4 秒条件下的问答质量或交互延迟，
  也不能据此断言生产 4 秒预算必然够用。默认条件的验证须单独标明配置、完成率、超时与耗时。
  token 预算与 dreaming 截断仍照实记录、不调整；时限覆盖记录在报告 `manifest.memoryConfig` 供审计。
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
| **常规回归**（默认） | 记忆核心（召回 / 提取 / 治理）改动后 | `pnpm run test:memory-bench:regression`（oracle 全量 52 题） | 约 0.5–1M（generation：每题提取 sweep + 提问；官方 judge 另行运行、另计模型费用） |
| **中文对照** | 中文卡 / 中文体验改动后 | `pnpm run test:memory-bench:zh`（MemoryBank cn 15 角色 × 100 题） | 最小（提取近零，主要是 judge） |
| **检索难度** | 里程碑 / 发版前 | `pnpm run test:memory-bench:difficulty`（LongMemEval S；需先 `node test/memory-bench/prepare.mjs --dataset longmemeval --split s` 装 277MB） | 2.5–4.5M（每题 haystack ≈122k） |
| **官方评分观测** | 需要引用官方 scorer 数字时（须声明生成协议差异） | `pnpm run test:memory-bench:external`（LoCoMo，默认分批 100 题；全量建议显式用 `pnpm run test:memory-bench -- --bench-dataset locomo --bench-split locomo10 --bench-limit 1986 --bench-judge off --bench-deadline-minutes 1440 --report json`，runner 总截止 24 小时） | 运行后须另跑 §5 锁定官方评分链；1986 题信息量最大 |

别名只是固定最常见口径；其它参数组合仍走 `pnpm run test:memory-bench -- <参数>`。

成本按读侧与灌库侧拆分：reading 请求单列且纳入读侧总计，dreaming 提取/整理单列；缓存读写不重复累计，judge 占比另列。推理模型先确认自动输出预算
（必要时用 `underTest.reviewMaxTokens` 覆盖）并用冒烟层验证提取链路。每轮报告都记录实际
usage，用来校准这里的量级。
**默认节奏 = 冒烟 → 常规**；中文 / 难度 / 对外只在对应触发条件下跑，不随每次改动全量执行。

## 9. 测试与验证

- 纯函数（importer / selector / scorer / MemoryBank judge / official runner 编排）配 L2 单测：
  `test/unit/memory-bench/*.test.ts`，合成小样本，不读真数据。
- 数据转换的完整性由 `prepare.mjs --verify` 与 `validate*File` 校验保证；不做 datasetHash/三重哈希链
  （外部集不进门禁，最简完整性守卫即 revision + fileSha256 + importTransformVersion）。
- smoke：`pnpm run test:memory-bench:smoke`（等价于 `--bench-dataset longmemeval --bench-split oracle --bench-limit 3`）
  （真实 Provider；验证 generation/采集管线，主质量分仍是 `pending_official`，不会在 smoke 中自动调用 judge）。

## 10. 红线

- LoCoMo 保留完整许可原文与署名，标注非商用；MIT 数据保留版权与许可声明。
- LoCoMo 只将锁定官方脚本结果标为官方评分；没有回填时保持 `pending_official`。
- 下载一律固定 revision + SHA-256，防上游漂移静默改分。
- judge 异构于被测模型，不允许被测模型自评。

## 当前产品记忆读取与版本比较

普通主回合首包依查询意图、治理 sessions 目录完整性及 `indexedTextBytes` 保守规模上界决定原文范围：完整且可容纳的小范围用空词分页枚举并逐条校验 JSONL；较大范围尝试完整展开命中的会话，整体超预算时保留跨会话候选供同一被测模型调用 `memory_list`、`memory_search`、`memory_read` 按需导航。无个人回忆意图时不枚举全范围。容量上限复用 ContextKernel 真实 headroom 与 `toolResultTokenBudget(window)`，最终完整 JSON 的 metadata 也计量；预算淘汰会降低 history 的结构覆盖声明。不宣称特定数值最优。目录是定位线索，原文仍由 SQLite 治理资格与 JSONL 内容核验。R1′ 独立 reader 在 recall 后、主回答前按条件触发：`recallIntent != none`、至少 4 个不同历史 entries，且非 proactive / 无 exact targets；它使用冻结 PiModel、low thinking、共享 signal 与 turnTimeout，按严格 JSON source ID + 连续原文 quote + 短 derived relevance 注释证据。无效输出整批丢弃，失败保留 raw；包预算不够时先丢 notes，不牺牲原文，同回合缓存按预算重裁。首包仍受 10% tool-budget ceiling 限制。深查产生的主模型工具轮、重复输入及缓存读写必须全部计费；Provider 缓存收益尚未实测。机制门禁不证明质量或 token 收益；需冻结协议后再做真实模型配对和大历史验证，并将灌库/整理摊销单列。

停止的 LoCoMo 部分批次保留旧版本标签，不与本次重构结果拼接。后续验收须冻结源码与生成协议，先做真实模型同模板复判和大历史场景验证，再开展同模型、同协议的配对完整历史直读对照；准确率、全请求 token、缓存命中与灌库/整理摊销分开报告。判分继续以本文锁定的官方脚本导出/回填链路为准，不以项目词面脚本或人工抽判替代官方得分。结果未完成前不宣称质量恢复或 token 节省。
