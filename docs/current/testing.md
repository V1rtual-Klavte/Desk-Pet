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

- `pnpm test` 会启动独立的 Live Test Tauri 窗口，并把数据根放入临时目录；测试结束自动删除，不污染 `data/desk-pet`。
- 支持 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report` 筛选。每个 Scene 必须声明稳定的 `caseId`、`suite` 和关联的 `contractId`；数据集校验会拒绝重复或失效的 case。
- Contract 的 `sourceHash` 在启动前由 Node 预检，过期会直接阻断测试。`--strict` 会再将 coverage/rule 缺口作为运行门禁。
- Live Test 覆盖真实 Provider、人格、工具、变量和记忆等跨模块链路时具有价值，但依赖模型、配置和外部环境。
- 每个 trial 在执行前都会等待上次会话文件写入完成，并清理 session 文件、浏览器 session cache、工作记忆、长期记忆、变量池、聊天状态、预处理去重状态和 AI 锁。超时、初始化失败和 Provider/网络/认证类错误以单独状态记录，不能记为 skip 或 pass。
- 报告使用 `desk-pet-live/v2` schema，记录数据集版本、commit、Card 种子 hash、每轮耗时/工具数/重试数/回复长度/可用的浏览器堆指标、错误分类和 `pass@k`、`pass^k`。`pass@k` 仅说明至少一个 trial 成功；发布门禁要求所有 trial 都成立。
- `entry: "production"` 场景经过 `sendMessage()`；`entry: "runtime"` 验证 Pi runtime 适配层。`production-chat-entry` 是当前严格双 trial smoke。
- 静态检查与 `cargo check` 不能替代真实交互验证。
- 变更后应按影响范围更新 Contract 和 Scene；测试通过只能证明已覆盖的契约，不代表未覆盖功能已验证。
- Live Test 不再经过 Vitest/Node mock；`live-test-main.ts` 是唯一执行入口。

## 当前验证基线

- `pnpm run test:types` 已通过。
- `pnpm run test:smoke` 的 `production-chat-entry` 严格双 trial 已通过，证明 `sendMessage()`、真实 Provider、Tauri IPC、临时数据根和会话写入入口可用。
- 最近一次完整非严格运行共 7 个 case，6 个通过、1 个失败：`tool-system-info` 的实际轨迹为 0 次工具调用。该 case 保持失败，直到当前 Provider/模型能在 Pi 工具声明下完成真实 `system_info` 调用。
- 旧的 emotion、memory、personality-card、planner、safety、tool-execution、variable-pool Contract 仍有 coverage/rule 缺口，因此 `pnpm run test:release` 预期失败；不得将非严格完整运行作为发布依据。

实现细节和历史测试改造过程见 `history/design/` 与 `history/implementation/`。
