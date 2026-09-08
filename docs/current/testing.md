# 当前测试说明

项目使用 `src/services/__tests__/live/` 下的 Live Test 框架。它由覆盖契约、场景定义、运行器和报告组成，在真实 Tauri WebView 中执行，使用真实 Tauri IPC、真实文件系统、真实 Provider 和真实运行时状态。

## 命令

```bash
pnpm test
pnpm test -- --module variable-pool
pnpm test -- --module tool-execution
```

## 验证边界

- `pnpm test` 会启动独立的 Live Test Tauri 窗口，并把数据根放入临时目录；测试结束自动删除，不污染 `data/desk-pet`。
- 支持 `--module`、`--scene`、`--tag`、`--report` 筛选。Contract 的 `sourceHash` 在启动前由 Node 预检，过期会直接阻断测试。
- Live Test 覆盖真实 Provider、人格、工具、变量和记忆等跨模块链路时具有价值，但依赖模型、配置和外部环境。
- 静态检查与 `cargo check` 不能替代真实交互验证。
- 变更后应按影响范围更新 Contract 和 Scene；测试通过只能证明已覆盖的契约，不代表未覆盖功能已验证。
- Live Test 不再经过 Vitest/Node mock；`live-test-main.ts` 是唯一执行入口。

实现细节和历史测试改造过程见 `history/design/` 与 `history/implementation/`。
