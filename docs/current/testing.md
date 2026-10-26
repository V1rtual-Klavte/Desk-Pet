# 当前测试边界

V1rtual-Desk-Pet 的运行时验证以 [Live Test 使用规范](../../test/README.md) 为权威入口；代码代理对 Contract 和 Scene 的分析、生成、审查流程以 [Live Test Skill](../../test/SKILL.md) 为准。本页只说明当前验证的边界，不记录历史通过次数、旧报告或完整命令清单。

## 验证层次

- **Live Test（L4）** 在真实**原生宿主**（`crates/native-host`，debug + `DESKPET_E2E=1` 隔离模式）上运行：真实 Node 业务代码、真实 Rust IPC、运行时状态和临时数据根；场景由宿主的唯一 Node 子进程（`test/e2e` Scene runner）驱动，不经 WebView。它按 Scene 的入口选择真实 Provider、fake Provider 或无模型的 unit 断言；这些入口的含义及命令见 Live README。
- **类型与编译检查**只证明 TypeScript/Rust 的静态可构建性，不能替代 Live Test 的状态、IPC、Provider 或工具链验证。
- **Rust 单测**（`pnpm run test:rust`，即 `cargo test --lib -p native-host`）覆盖 Bash 策略、路径校验、工具许可、Node 监督器（握手/崩溃代际/关停）、以及真实 SQLite 治理与 trace 文件追加、重试和恢复。它们不启动原生宿主 UI，不验证宿主 IPC 与 Provider 接线；release 存储基准需显式执行。
- **CI** 在 macOS 和 Windows 执行编译级检查（`tsc --noEmit` + `cargo check`）、Rust 单测与快层 L2 / L3（经重试入口 `scripts/run-vitest-with-retry.mjs`，附测试纪律扫描与 FLAKY 棘轮）；另有 `check:contract-hashes` 与 bundle-config 静态守卫（均为秒级、不编译；后者检查版本号与打包配置一致性）。L4 Live Test 不在 CI 中运行。Windows 的运行时交互仍须在支持的桌面环境中验证。

## Contract 门禁

每个当前模块 Contract 都以 `sourceFiles` 和 `sourceHash` 绑定源码版本。源码改变后必须重新分析受影响 Contract，补齐或调整关联 Scene；空 hash、过期 hash、无效 caseId 引用和严格覆盖缺口都不能作为通过证据。Scene runner 的启动预检会校验 `sourceHash`，并拒绝绕过启动脚本直接起宿主时缺失的契约证明（该 Contract 记为 stale）。

严格模式同时检查：

- `coverage.scenarios` 引用已发现的 **caseId**，并与模块和 `contractId` 匹配；
- Contract 声明的边界、错误要求由实际 Scene tag 满足；已经迁入 L2/L3 的判据由对应 caseId 与层级关联验证，不强制重复制造 L4 场景；
- 除显式且有理由的 `unitOnly` 外，每个 Contract 至少有一个非 unit 场景；
- 全量 L4 收尾时执行三层 caseId 对账（声明/实现/跨层唯一），过滤运行不做该对账。

通过结果只证明当次配置、Provider 与已覆盖 Scene 下的行为；真实模型下的记忆召回质量、记忆库的资源开销、未覆盖的平台路径与尚未接通的规划能力不能由已有场景推断为已验证（记忆模块已有 L4 `memory-store-lifecycle` 等确定性场景，它们证明协议与存储，不证明模型效果）。

线路、记忆质量与资源开销分别有独立评测入口，格式和命令见[测试 README](../../test/README.md#trace记忆质量与性能门禁)。线路完整性检查与用户理想稿的独立 AI 审阅分开；理想稿只由用户编写。记忆原始采集不能代替 gold 双人审计与校准 judge 盲审。性能分列 release 原生存储、debug 宿主 IPC 和进程树样本（须覆盖 native-host + 唯一 Node 及其子进程），不能冒充真实 UI 首显或完整产品 RSS。

外部记忆基准（memory-bench：LongMemEval / LoCoMo / MemoryBank cn）是**质量对照的主口径**（观测性证据，与自建 80 题物理隔离）；**门禁保持现状**——CI 与 `test:release` 不跑评测集（最多冒烟级自检），完整分层在本机跑通后再发布；自建 80 题只作兜底冒烟与治理语义回归。数据集文件不进仓库：版本锁（固定 revision + SHA-256、许可原文、判分移植代码）在 git，数据由 `pnpm run test:memory-bench:prepare [-- --data-dir <目录>]` 装进开发者指定的 data-dir（默认 `test/memory-bench/.data/`，可弃缓存），运行期不下载。判分为官方脚本/模板的自适配移植（LoCoMo 用异构 LLM judge 的语义正确率，不用官方词面 F1；LongMemEval judge 必须异构于被测模型，官方 `evaluate_qa.py` 链保留），报告口径为 `source: external` / `status: observational`、不设质量阈值；运行方法、口径差异与非商用许可约束见 [memory-bench/README](../../test/memory-bench/README.md)。

## 聊天评测数据集

`test/ideal-traces/suites/<suiteId>/` 的结构化聊天用例（`suite.json` / `cases/` / `fixtures/` / `approvals/`，schema v4）与旧格式 `.ideal.md` 线路稿分开治理：前者允许代理起草 silver，只有用户按当前哈希绑定真实会话消息审批的用例才是 gold；实际输出不能充当期望来源，驱动包不包含题型、探针、oracle、检查点、证据与评分。case 是可跨会话的场景容器，探针逐条绑定驱动步骤、题型、难度与已登记 rubric，带 `required` / `forbidden` 与 `critical` 标记，用户消息轮数不设上限；只有 rubric 声明需要时才写 `expectation`（内容词表、频率、时间关系、主语别名与跨会话来源），未知或多余字段直接失败。题型注册表固定 7 族 24 型，并要求每个产品分类至少被一个题型覆盖；case 的 `questionTypes` 必须恰好等于探针题型的并集。fixture 必须声明 `loading`：`direct-seed` 只预置初始状态、待测行为仍走真实消息链，`real-chain` 禁止同时 seed 会话或记忆；`fixed` 时钟要求每个驱动步骤带升序 `at`；W5 runner 已写入 `clock.json` 并在宿主 Node 引导早期推进 Node 域 `Date`，Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间。探针窗口限定 driver 步骤，`difficulty`（1–5）只用于报告分层。当前只有 `daily-companionship/saturday-companionship` 一条 silver/pending 候选（27 条用户消息 + 2 个 host 步骤、3 个会话、23 条探针其中 11 条关键、8 种题型；难度 L1 4／L2 5／L3 6／L4 6／L5 2；direct-seed、固定时钟），其他套件为空占位。

三个 Skill 分工：`desk-pet-chat` 负责真实聊天与自由定性评测，`desk-pet-eval-authoring` 负责起草用例并收集用户审批，`desk-pet-eval-runner` 负责结构化执行、独立 judge 判分与报告。结构化探针与 case 级质量 rubric 全部由独立 coding-agent judge 按冻结判分包判定，judge 与被测模型必须异构并记录平台／模型／prompt 版本；runner 只冻结判分包、校验裁决与聚合，不调用模型、不读取 judge 凭据。用户抽查可选、不阻塞，也不改变自动判分。W1–W1.7 实现格式、题型覆盖、时钟与装载校验、难度分层、哈希与金银标计算（结构／治理与只读 CLI 验收通过 2026-10-25，gold 审批仍只由用户执行）；W2 实现并验收 debug 隔离运行根、ready/所有权核验、direct-seed 装载器与 `prepare`／`start`／`status`／`stop` 运行器（2026-10-25）；W2 单测、类型检查与 Rust 单测已运行通过，真实隔离起停验证了 ready/装载、非法路径、跨进程单实例、E2E 互斥、停止后锁释放与真实数据根未变。W3 的测试侧证据封存／同源报告／五回保留、产品 trace 采集与跨会话取证、`finish` 封存接线已验收（2026-10-25）；验收范围为证据链与隔离封存，不含聊天驱动、固定时钟与评分。W4 已实现判分包冻结、独立 coding-agent judge 裁决校验、证据／执行前置、四维状态聚合、可选抽查与四层同源报告，CLI 接 `judge prepare|apply`／`review show|spotcheck`／`report`；快层 `聊天评分关口.test.ts` 已运行通过（2026-10-25），但仍未发起真实 judge 调用，也没有用户抽查记录。W5 已实现授权冻结（`--authorization`）、Node 域固定时钟、驱动进度与续跑、预算／授权复核、同条件 `compare`、`holdout` 使用记录与 `--repair-of` 修复 attempt，并于 2026-10-26 完成集中验收（L2／L3、严格 L4 ×3 与完整门禁；CE 映射见执行契约）；仍不能由测试通过推断聊天质量、真实日程间隔或自动修复已经验证。真实聊天 Skill／模型／judge 运行、用户审批与抽查、CE 的真实场景与 CI 门禁仍未收口。

## 未验证边界

- 恢复中断运行时「MCP 不可用 → 显式提示」的异常路径：无法由现有场景直接验证，缺的是**前提不可构造**——它要求中断运行里待重放的工具是 `mcp_*` 且其服务器本次借不到（`pendingInterruptedToolNames` 与本次能力准备的 `unavailableMcp` 取交集），而构造该前提需要「曾借用过 mcp_* 工具的中断运行 + 届时借不到的服务器」两个条件同时成立：现有场景只有前者（`MCP真IPC假server` 已连真 stdio 脚本服务器并完成借用→发现→调用），`MCP大结果回读` 仅在传输边界替换 `callTool`，未构造后者。这条失败不是「只存在于界面呈现」：运行入口先 `appendAssistantMessage` 落成普通助手条目（`stopReason: "stop"`，读模型可见），再把它作为 `reply` 返回，观测面存在。代理由 `runtime-resume-capability-prep` 覆盖：恢复路径确实重新执行能力准备（Skill 目录在恢复后可用），且会话里不落上游「Tool … is unavailable」通用文案。

仍存缺口记录在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md)。
