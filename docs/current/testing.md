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
- 支持 `--module`、`--scene`、`--case`、`--tag`、`--suite`、`--repeat`、`--strict`、`--report` 筛选。每个 Scene 必须声明稳定的 `caseId`、`suite` 和关联的 `contractId`；数据集校验会拒绝重复、无模块或不属于本模块 Contract 的 case。
- Contract 的 `sourceHash` 在启动前由 Node 预检，过期会直接阻断测试。`--strict` 会再将 coverage/rule 缺口作为运行门禁；coverage 引用必须指向实际发现、module 与 `contractId` 都匹配的 Scene，`boundary`/`error` 规则只统计同名 tag。
- Live Test 覆盖真实 Provider、人格、工具、变量和记忆等跨模块链路时具有价值，但依赖模型、配置和外部环境。
- 每个 trial 在执行前都会等待上次会话文件写入完成，并清理 session 文件、UI index、工作记忆、长期记忆、变量池、聊天状态、预处理去重状态和 AI 锁。`meta.repetitions` 是该场景最低 trial 数，CLI `--repeat` 只能提高它。超时、初始化失败和 Provider/网络/认证类错误以单独状态记录，不能记为 skip 或 pass。
- 报告使用 `desk-pet-live/v2` schema，记录数据集版本、commit、Card 种子 hash、每轮耗时/工具数/重试数/回复长度/可用的浏览器堆指标、错误分类和 `pass@k`、`pass^k`。`pass@k` 仅说明至少一个 trial 成功；发布门禁要求所有 trial 都成立。
- `entry: "production"` 场景经过 `sendMessage()`；`entry: "runtime"` 验证 Pi runtime 适配层。`production-chat-entry` 是当前严格双 trial smoke。
- 静态检查与 `cargo check` 不能替代真实交互验证。
- 变更后应按影响范围更新 Contract 和 Scene；测试通过只能证明已覆盖的契约，不代表未覆盖功能已验证。
- Live Test 不再经过 Vitest/Node mock；`live-test-main.ts` 是唯一执行入口。

## 当前验证基线

- `pnpm run test:types` 已通过。
- `pnpm run test:smoke` 的 `production-chat-entry` 严格双 trial 已通过，证明 `sendMessage()`、真实 Provider、Tauri IPC、临时数据根、专属浏览器 keyspace 和会话写入入口可用。
- `memory-multi-turn` 已通过，验证用户事实写入并跨轮保留在会话工作记忆；它不声称长期记忆自动检索已经接通。
- 最近一次完整非严格运行（dataset `2026-09-09.2`）执行 13 个 trial，2 个通过、11 个失败：生产入口与会话工作记忆通过；emotion 未产生 `RUNTIME_DATA emotion`，安全与工具场景均无真实工具调用，变量场景没有 `RUNTIME_DATA` 变量行。所有失败均为断言失败，没有 timeout、认证、网络或测试宿主错误。
- `safety-dangerous-delete` 三次试验均失败，原因是模型未发起 `bash_exec`，所以危险命令拒绝链路没有被实际覆盖。`tool-system-info` 三次试验同样没有真实 `system_info` 调用。`variable-affection-praise` 三次试验和 `variable-boundary-reject` 均没有请求变量写入，因此变量写入与越界拒绝闭环未成立。以上不得以非空回复判定通过。
- emotion、personality-card、planner、safety、tool-execution、variable-pool 等 Contract 仍有 coverage/rule 缺口，因此 `pnpm run test:release` 预期失败；不得将非严格完整运行作为发布依据。恢复 Provider 的工具调用与 RUNTIME_DATA 输出后，必须重新执行完整回归。

实现细节和历史测试改造过程见 `history/design/` 与 `history/implementation/`。
