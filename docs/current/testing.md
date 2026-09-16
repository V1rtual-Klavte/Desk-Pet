# 当前测试说明

项目使用 `src/services/__tests__/live/` 下的 Live Test 框架。它由覆盖契约、场景定义、运行器和报告组成，在真实 Tauri WebView 中执行，使用真实 Tauri IPC、真实文件系统、真实 Provider 和真实运行时状态。

## 命令

```bash
pnpm test
pnpm test -- --module variable-pool
pnpm test -- --module tool-execution
pnpm run test:types
pnpm run test:smoke
pnpm run test:release
```

## 验证边界

- `pnpm test` 会启动独立的 Live Test Tauri 窗口，并把数据根放入临时目录；测试结束自动删除，不污染 `data/desk-pet`。测试重置会清理该临时根中的 Markdown 会话与 `sessions/index.json`，正常运行不依赖浏览器会话缓存。
- 支持 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report`、`--contracts` 筛选。每个 Scene 必须声明稳定的 `caseId`、`suite` 和关联的 `contractId`；数据集校验会拒绝重复、无模块或不属于本模块 Contract 的 case。
- Contract 的 `sourceHash` 在启动前由 Node 预检，过期会直接阻断测试；默认校验全部 Contract，`--contracts=selected` 可只校验 `--module` 选中的那一份（单模块调试用，不作为默认）。
- `--strict` 会再将 coverage/rule 缺口作为运行门禁；coverage 引用必须指向实际发现、module 与 `contractId` 都匹配的 Scene，`boundary`/`error` 规则只统计同名 tag。
- 两条防退化门禁：每个 Contract 至少有一个非 `unit` 场景（做不到的必须显式声明 `unitOnly` 并写明原因）；`unit` 场景的 timeout 不得超过 10s。没有前者，全部场景都能退化成「不跑模型」而报告依旧全绿。
- Live Test 覆盖真实 Provider、人格、工具、变量和记忆等跨模块链路时具有价值，但依赖模型、配置和外部环境。
- 每个 trial 在执行前都会取消并等待上次 Agent 收尾，再清理 session 文件、UI index、工作记忆、长期记忆、变量池、聊天状态、预处理去重状态和 AI 锁。超时、初始化失败和 Provider/网络/认证类错误以单独状态记录；兜底回复不改变失败结论。
- 报告使用 `desk-pet-live/v2` schema，记录数据集版本、commit、Card 种子 hash、每轮耗时/工具数/重试数/回复长度/可用的浏览器堆指标、错误分类和 `pass@k`、`pass^k`。`pass@k` 仅说明至少一个 trial 成功；发布门禁要求所有 trial 都成立。
- `entry: "production"` 场景经过 `sendMessage()`；`entry: "runtime"` 验证 Pi runtime 适配层；`entry: "unit"` **不进入模型**，直接执行断言，默认超时 10s。断言只依赖进程内状态（纯函数、注册表、变量池）时用 unit —— 让它去跑真实 LLM 既不增加信息量，又把场景成败绑到 Provider 抖动上。`production-chat-entry` 是当前严格双 trial smoke。
- 重试耗尽时 runtime 会在 `PiAgentTurnOutput.failure` 上带结构化原因（`timeout`/`auth`/`rate_limit`/`network`/`provider`/`unknown`），报告据此分类；只有兜底文案的话，Provider 故障会被记成 assertion 失败，观测直接失效。
- CI（`.github/workflows/ci.yml`）在 push / PR / 手动触发时，于 `macos-latest` 与 `windows-latest` 各跑一次 `pnpm run test:types`（`vue-tsc --noEmit && cargo check`）。Live Test 需要真实 Provider，不在 CI 内执行。
- **Windows 分支只能靠 CI 做编译级验证**：本机交叉 `cargo check --target x86_64-pc-windows-msvc` 会卡在 `tauri-build` 的 `embed-resource`（需要 `llvm-rc`），且在此之前不会编译到项目自身代码。
- 静态检查与 `cargo check` 不能替代真实交互验证。
- 变更后应按影响范围更新 Contract 和 Scene；测试通过只能证明已覆盖的契约，不代表未覆盖功能已验证。
- Live Test 不再经过 Vitest/Node mock；`live-test-main.ts` 是唯一执行入口。

## 当前验证基线（2026-09-16）

- `pnpm run test:types` 已通过。
- `pnpm run test:smoke` 的 `production-chat-entry` 严格双 trial 已通过，证明 `sendMessage()`、真实 Provider、Tauri IPC、临时数据根、专属浏览器 keyspace 和会话写入入口可用。
- 本轮 session 严格绑定改造后，`pnpm test -- --module memory --contracts selected --strict` 18/18 场景通过，`pnpm test -- --module agent-runtime --contracts selected --strict` 6/6 场景通过。两者覆盖 queued 恢复、AgentSlot generation、steer/followUp 持久化、Plan 恢复、PromptSnapshot、画像投影、上下文预算和异步压缩写回。
- `memory-multi-turn` 验证用户事实写入并跨轮保留在会话工作记忆；它不声称长期记忆自动检索已经接通。
- safety 与 tool-execution 已建立 Contract 与场景（`safety-hook-errors`、`safety-trust-lifecycle`、`tool-cancelled`、`tool-provider-network-boundary` 等）。
- **2026-09-16 采集**：`pnpm test -- --strict --repeat 2` = **161/161**（零 fail / 零 timeout / 零 skip，约 30s），8 份 Contract 全部有效且无 GAP。这是第一次跑通的严格全量。报告会在清理临时数据根前复制到 `~/.deskpet-live-test-reports/`（保留最近 20 份）。
- 最近一次完整非严格运行（2026-09-15）为部分通过：agent-runtime 与 memory 模块全部通过；emotion 未产生 `RUNTIME_DATA emotion`、safety 与工具场景未触发真实工具调用、variable 场景没有 `RUNTIME_DATA` 变量行等既有真实模型断言失败。所有失败均为断言失败，没有 timeout、认证、网络或测试宿主错误。
- coverage 缺口已补齐（8 份 Contract 0 空点），`pnpm run test:release` 不再因门禁早退。
- **planner 的运行时接线仍未覆盖**：Plan 入口由 `generalConfig.assistantMode && planConfig.enabled` 双重把守，而 Live Test 恒以 pet 模式运行，触达不到。该 Contract 已显式声明 `unitOnly` 并写明原因。
- **模型是否愿意按格式输出仍是变量**：实测模型并不稳定地在 RUNTIME_DATA 里写 `emotion` 行（约 9 次成功 1 次），`variables` 行则正常。相关断言的失败属模型侧，不是引擎问题；需要断言「模型自发产出某格式」的场景都要小心，那测的是模型当天的表现而不是产品契约。

实现细节和历史测试改造过程见 `history/design/` 与 `history/implementation/`。
