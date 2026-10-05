# 测试模块规则（test/）

`test/` 是仓库唯一的测试根：三层测试、契约、宿主设施、场景、报告与评测都在这一棵树下。
本文件是测试域的**规则入口与维护义务表**；根 [AGENTS.md](../AGENTS.md) 只保留全局约束，不重复这里的规则。

**三份文档分工**（改动前先确认改哪份）：

| 文档 | 持有什么 |
|---|---|
| 本文件 | 规则入口：全功能索引、信息获取入口、必守规则、维护义务 |
| [README.md](README.md) | 权威详页：分层判定、完整纪律表、命令与过滤、报告与保留、Contract/Scene 规范、评测机制 |
| [SKILL.md](SKILL.md) | 代码代理工作流：`/analyze` → `/generate` → `/audit`（Contract 分析、测试生成、覆盖审查） |

## 全功能索引（每个体系：是什么 → 入口 → 产物）

| 体系 | 是什么 | 入口（文档 / 命令） | 产物 / 去向 |
|---|---|---|---|
| L2 单元 / L3 集成 | 不启原生宿主的快层：纯逻辑 / 真 agent loop + 真 JSONL 落盘（fake Provider） | README「该写在哪一层」；`pnpm test` | `test/reports/vitest-*.json`（固定名覆写） |
| L4 场景 | 真原生宿主（`crates/native-host`）+ 唯一 Node Scene runner + 真 Rust IPC 的端到端 | README「Scene 规范」；`pnpm run test:e2e` | `test/reports/<stamp>.*` + `traces/` bundle |
| 契约 | 模块行为覆盖门禁（sourceHash + caseId 三层记账） | README「Contract 与 sourceHash」；`test/contracts/` | 预检 attestation；caseids-*.json |
| trace 证据 | 运行线路完整落盘、完整性核对、理想稿审阅 | README「Trace、记忆质量与性能门禁」；`test:trace-review` | `test/reports/traces/trace-bundle-*`（bench / quality 在各自子目录的 `traces/`） |
| 理想稿 | 用户手写的"期望线路"，审阅对照基准（只由用户写） | [ideal-traces/README.md](ideal-traces/README.md) | 审阅 JSON（与报告配对、连带淘汰） |
| 外部记忆基准（权威对照） | 质量主口径：LongMemEval / MemoryBank cn / LoCoMo（基于官方判分移植；按消耗分层跑，不进 CI／发布门禁） | [memory-bench/README.md](memory-bench/README.md)；`test:memory-bench` | memory-bench 报告 + hypotheses |
| 记忆质量（自建兜底） | 兜底冒烟与治理语义回归：外部集未覆盖的来源/scope 反例、纠正、遗忘、称呼/偏好（真实 Provider，烧 token） | README 记忆质量段；`test:memory-quality` | 报告 + review/scored 包（组保留） |
| 记忆性能 | release 存储 + debug IPC 的资源账（1k/10k 库、P95） | README 性能段；`test:memory-performance` | `test/reports/performance/`（3 份滚动） |
| 缺陷注入 | 快层的区分力观测（植入缺陷看抓不抓得到） | README「缺陷注入」；`test:mutation` | 控制台（不设阈值） |
| 波动棘轮 | FLAKY 清单只缩不放 | README「波动与假绿」；`check-flaky-ratchet.mjs` | `test/reports/flaky.json`（豁免淘汰） |

## 信息获取入口（要查 X → 去哪）

| 你要查 | 去哪 |
|---|---|
| 测试跑哪个被测模型 | 默认继承隔离副本的**合成 CONFIG**（随仓 `CONFIG.yaml` 模板 + `test/host/native/fixtures/config-overrides.yaml` 覆盖；不复制真实 `CONFIG-DEV.yaml`，不含凭据）；可在 [eval-models.json](eval-models.json)、本地 `test/eval-models.local.json`（凭据/临时覆盖；已 gitignore）或环境变量 `DESKPET_EVAL_MODEL` / `DESKPET_EVAL_PROVIDER` 覆盖（凭据只经后两者写进隔离副本） |
| judge 模型与异构纪律 | `--bench-judge-model` > `DESKPET_EVAL_JUDGE_MODEL` > 两层模型配置文件（[eval-models.json](eval-models.json) 与本地 `eval-models.local.json`）的 `judge.model`（当前 deepseek-reasoner）；judge 继承测试侧网关的 endpoint/apiKey；**必须不同于被测模型**，同模型在开跑前报错 |
| 上游评测数据怎么装、装到哪 | [memory-bench/README.md](memory-bench/README.md)：prepare 命令、`--data-dir` / `DESKPET_BENCH_DATA_DIR`、revision + SHA-256 锁定清单（`upstream-lock.json`） |
| 报告与证据在哪、怎么淘汰 | README「报告在哪、怎么看」（组保留：最近 3 场 + 200 MiB；bench / quality 分目录各自淘汰） |
| 评分口径与门槛 | README「Trace、记忆质量与性能门禁」+ [memory-bench/README.md](memory-bench/README.md)（judge 模板、F1 口径）；记忆质量门槛见[未完成总表 §3.2](../docs/plans/active/未完成工作与已知缺口.md#32-尚未完成的验收口径) |
| sourceHash 怎么算、什么时候要刷 | README「Contract 与 sourceHash」+ [SKILL.md](SKILL.md)（analyze → generate，不能只刷 hash） |
| 环境前提（睡眠、挂起与 L4 宿主形态） | README「环境注意」与「隔离、超时与失败」 |
| 产物保留/清理机制 | README「报告在哪」+ [scripts/report-retention.mjs](../scripts/report-retention.mjs)（组淘汰核心） |

## 必守规则（摘要；细节以 README / SKILL 为准）

- **先选层再动手**：需要真 Rust 边界 → L4；真 JSONL 落盘与 agent loop → L3；否则 L2。
  判错层由扫描器判违规：L2 不得 import `engine/harness`、`session`、`tool`；L3 不得用真实 Provider（规则 6 / 7）。
- **写断言的唯一判据**：把产品实现改坏（条件反转 / 常数替换 / 分支删除），这条断言还会红吗？
  不会红就不合格；恒真子句、拿被测函数的输出当期望值、断言测试自己构造的值都算不合格。
  写前对照 SKILL 的自查清单（D1–D10）；扫描器只判形状，判不了区分力——那一层必须人工过。
- **扫描器**：`node scripts/check-test-rules.mjs` 扫描 `test/`，命中即失败；新测试须零命中；守卫自身要有测试。
- **Contract 同步**：源码或行为契约变化后按 SKILL 重新 analyze → generate，不能只改 `sourceHash` 过门禁；
  coverage 的 `scenarios` 写稳定 caseId，不写文件名 / 描述 / 导出名。
- **验证纪律**：类型 / 编译不能代替运行验证；非 unit 场景需实际或 fake Provider 响应，
  `entry: production` 须经过 `sendMessage()`（fake 只替换 Provider，工具与 IPC 行为仍要断言）；
  L2 / L3 进 CI 双端门禁，**L4 不进 CI——改完必须手工跑一次**；跨模块改动运行完整 E2E；
  发布门禁为严格 Contract 与至少三次 trial，跳过 / 超时不得报通过；文档改动只查链接、事实、引用与格式，不重跑 E2E。
- **场景自证**：新增 / 修改 L4 场景后，交付前必须全量严格 ×3 全绿
  （`pnpm run test:e2e -- --strict --repeat 3 --report json`）；过滤运行只用于迭代、不算自证。
  写场景遵守 repeat 隔离（持久化身份每 setup 全新、消耗型配额用独立记账域）与宿主能力对等
  （E2E 宿主是产品子集：不建原生 UI、不启动监控线程；产品侧由领域引导与原生 UI 完成的
  初始化不存在，缺的由 `standard-setup.ts` 补齐）——判据与模式见 README「Scene 规范」。
- **Rust 单测**内联在 `crates/native-host/src/**`，由 `pnpm run test:rust`
  （`cargo test --lib -p native-host`）执行；CI 在 macOS 与 Windows 双端运行，缺少执行的测试不算门禁。
- **质量口径与门禁分离**：**质量主口径是外部权威基准**（LongMemEval / MemoryBank cn / LoCoMo，
  按 memory-bench 的分层节奏在本机运行，报告与 hypotheses 是质量证据）；自建 80 题只作**兜底
  冒烟与外部集未覆盖的治理语义回归**，不能拿它替代权威对照结论。**门禁保持现状**：CI /
  `test:release` 不跑评测集（重成本不进流水线），最多冒烟级自检；完整评测集在本机跑通后再发布。
  judge 必须异构于被测模型，不许被测模型自评；上游数据不进仓库（`upstream-lock.json` 锁定
  revision + SHA-256，数据装到 data-dir）。
- **产物边界**：测试产物一律在 `test/` 下，不落仓库外；保留单元是「组」（报告与审阅/评分卫星连带淘汰、临时根按已知前缀 + 年龄回收），查看方式与口径见 README「报告在哪、怎么看」；L4 的 Node runner bundle 在 `test/.tmp/native-host-e2e/`（每次运行重建，不进保留链）；
  理想稿只由用户编写、不被清理，见 [ideal-traces/README.md](ideal-traces/README.md)。

## 维护义务（改了什么 → 必须同步什么）

| 你改动了 | 必须同步 |
|---|---|
| 分层规则、选层判定、L2 / L3 禁令清单 | 本文件摘要 + README「该写在哪一层」+ `scripts/check-test-rules.mjs` 的 `IPC_MODULES` |
| 测试纪律条目 | README「测试纪律」规则表 + SKILL 自查清单（D1–D10）+ 扫描器实现 |
| 测试命令、过滤参数、门禁组合（test:release / test:smoke） | README「运行命令与过滤」+ 根 `package.json` scripts |
| 报告 / 产物路径、保留策略、清理行为，或新增任何落盘产物 | README「报告在哪、怎么看」+ 本文件「产物边界」+ 实施脚本（`e2e-test.mjs` / `trace-evidence.mjs` / `memory-performance.mjs` 等） |
| Contract / Scene 协议、caseId 字母表、sourceHash 流程 | README「Contract 与 sourceHash」「Scene 规范」+ SKILL |
| trace / 理想稿 / 记忆质量 / 外部记忆基准（memory-bench）/ 性能评测机制 | README 对应章节 + 各子目录 README（如 `ideal-traces/README.md`、`memory-bench/README.md`）+ 本文件「全功能索引」 |
| 评测模型 / judge 模型 / 数据目录等测试侧配置 | 本文件「信息获取入口」+ 对应 README 与解析实现 |
| L4 环境约束（宿主形态、睡眠/挂起判据） | README「环境注意」 |
| 宿主设施行为（standard-setup、确认 / 计划通道、隔离与超时） | README 对应章节 |
| E2E 宿主能力差异（原生宿主 e2e 分支、不建原生 UI/不启动监控、领域引导与 UI 侧初始化的缺失与补齐、UI 组件证据的服务级替换与原生 UI 驱动缺口） | README「Scene 规范」的宿主能力对等段 + `crates/native-host/src/main.rs`（`run_e2e` / `E2eDispatcher`）、`test/e2e/native-main.ts`、`test/host/native/build.mjs` 与 `standard-setup.ts` 实现 |

**总则：任何改动只要触及本文件陈述的规则或上表对象，必须在同一改动里更新本文件与表中对应文档——文档不允许落后于实现。**

## 边界

- 工作范围、跨层同步、文档与提交约束在[根 AGENTS](../AGENTS.md)；被测 TS 的业务边界见[services AGENTS](../src/services/AGENTS.md)，Rust 宿主边界见[native-host AGENTS](../crates/native-host/AGENTS.md)。测试域内的问题查本模块三份文档。
- 新增测试前先按 README 的判定顺序选层；判定不了时让 Node 适配层「跑起来的结果」决定
  （撞 `UnsupportedInNodeError` 留在 L4），不靠猜。
- 本文件只持规则与导航；机制描述（契约校验、CI 门禁、启动器行为）在 `test/contracts/`、`scripts/` 与 `.github/workflows/`。
