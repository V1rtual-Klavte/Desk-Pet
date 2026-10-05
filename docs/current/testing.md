# 当前测试边界

V1rtual-Desk-Pet 的运行时验证以 [Live Test 使用规范](../../test/README.md) 为权威入口；代码代理对 Contract 和 Scene 的分析、生成、审查流程以 [Live Test Skill](../../test/SKILL.md) 为准。本页只说明当前验证的边界，不记录历史通过次数、旧报告或完整命令清单。

## 验证层次

- **Live Test（L4）** 在真实**原生宿主**（`crates/native-host`，debug + `DESKPET_E2E=1` 隔离模式）上运行：真实 Node 业务代码、真实 Rust IPC、运行时状态和临时数据根；场景由宿主的唯一 Node 子进程（`test/e2e` Scene runner）驱动，不经 WebView。它按 Scene 的入口选择真实 Provider、fake Provider 或无模型的 unit 断言；这些入口的含义及命令见 Live README。
- **类型与编译检查**只证明 TypeScript/Rust 的静态可构建性，不能替代 Live Test 的状态、IPC、Provider 或工具链验证。
- **Rust 单测**（`pnpm run test:rust`，即 `cargo test --lib -p native-host`）覆盖 Bash 策略、路径校验、工具许可、Node 监督器（握手/崩溃代际/关停）、以及真实 SQLite 治理与 trace 文件追加、重试和恢复。它们不启动原生宿主 UI，不验证宿主 IPC 与 Provider 接线；release 存储基准需显式执行。
- **CI** 在 macOS 和 Windows 执行编译级检查（`tsc --noEmit` + `cargo check`）、Rust 单测与快层 L2 / L3（经重试入口 `scripts/run-vitest-with-retry.mjs`，附测试纪律扫描与 FLAKY 棘轮）；另有 bundle-config 静态守卫（版本号/打包配置一致性，秒级、不编译）。L4 Live Test 不在 CI 中运行。Windows 的运行时交互仍须在支持的桌面环境中验证。

## Contract 门禁

每个当前模块 Contract 都以 `sourceFiles` 和 `sourceHash` 绑定源码版本。源码改变后必须重新分析受影响 Contract，补齐或调整关联 Scene；空 hash、过期 hash、无效 caseId 引用和严格覆盖缺口都不能作为通过证据。Scene runner 的启动预检会校验 `sourceHash`，并拒绝绕过启动脚本直接起宿主时缺失的契约证明（该 Contract 记为 stale）。

严格模式同时检查：

- `coverage.scenarios` 引用已发现的 **caseId**，并与模块和 `contractId` 匹配；
- Contract 声明的边界、错误要求由实际 Scene tag 满足；已经迁入 L2/L3 的判据由对应 caseId 与层级关联验证，不强制重复制造 L4 场景；
- 除显式且有理由的 `unitOnly` 外，每个 Contract 至少有一个非 unit 场景；
- 全量 L4 收尾时执行三层 caseId 对账（声明/实现/跨层唯一），过滤运行不做该对账。

通过结果只证明当次配置、Provider 与已覆盖 Scene 下的行为；真实模型下的记忆召回质量、记忆库的资源开销、未覆盖的平台路径与尚未接通的规划能力不能由已有场景推断为已验证（记忆模块已有 L4 `memory-store-lifecycle` 等确定性场景，它们证明协议与存储，不证明模型效果）。

线路、记忆质量与资源开销分别有独立评测入口，格式和命令见[测试 README](../../test/README.md#trace记忆质量与性能门禁)。线路完整性检查与用户理想稿的独立 AI 审阅分开；理想稿只由用户编写。记忆原始采集不能代替 gold 双人审计与校准 judge 盲审。性能分列 release 原生存储、debug 宿主 IPC 和进程树样本（须覆盖 native-host + 唯一 Node 及其子进程），不能冒充真实 UI 首显或完整产品 RSS。

外部记忆基准（memory-bench：LongMemEval / LoCoMo / MemoryBank cn）是**质量对照的主口径**（观测性证据，与自建 80 题物理隔离）；**门禁保持现状**——CI 与 `test:release` 不跑评测集（最多冒烟级自检），完整分层在本机跑通后再发布；自建 80 题只作兜底冒烟与治理语义回归。数据集文件不进仓库：版本锁（固定 revision + SHA-256、许可原文、判分移植代码）在 git，数据由 `pnpm run test:memory-bench:prepare [-- --data-dir <目录>]` 装进开发者指定的 data-dir（默认 `test/memory-bench/.data/`，可弃缓存），运行期不下载。判分为官方脚本/模板的自适配移植（LoCoMo 词面 F1 无 judge；LME judge 必须异构于被测模型），报告口径为 `source: external` / `status: observational`、不设质量阈值；运行方法、口径差异与非商用许可约束见 [memory-bench/README](../../test/memory-bench/README.md)。

## 未验证边界

- 恢复中断运行时「MCP 不可用 → 显式提示」的异常路径：无法由现有场景直接验证，缺的是**前提不可构造**——它要求中断运行里待重放的工具是 `mcp_*` 且其服务器本次借不到（`pendingInterruptedToolNames` 与本次能力准备的 `unavailableMcp` 取交集），而构造该前提需要「曾借用过 mcp_* 工具的中断运行 + 届时借不到的服务器」两个条件同时成立：现有场景只有前者（`MCP真IPC假server` 已连真 stdio 脚本服务器并完成借用→发现→调用），`MCP大结果回读` 仅在传输边界替换 `callTool`，未构造后者。这条失败不是「只存在于界面呈现」：运行入口先 `appendAssistantMessage` 落成普通助手条目（`stopReason: "stop"`，读模型可见），再把它作为 `reply` 返回，观测面存在。代理由 `runtime-resume-capability-prep` 覆盖：恢复路径确实重新执行能力准备（Skill 目录在恢复后可用），且会话里不落上游「Tool … is unavailable」通用文案。

仍存缺口记录在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md)。
