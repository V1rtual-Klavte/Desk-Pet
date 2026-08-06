# 当前测试说明

项目使用 `src/services/__tests__/live/` 下的 Live Test 框架。它由覆盖契约、场景定义、运行器和报告组成，并可调用真实模型验证交互链路。

## 命令

```bash
pnpm test
pnpm test -- --module variable-pool
```

## 验证边界

- Live Test 覆盖真实 Provider、人格、工具、变量和记忆等跨模块链路时具有价值，但依赖模型、配置和外部环境。
- 静态检查与 `cargo check` 不能替代真实交互验证。
- 当前仓库部分 Contract 的 `sourceHash` 为空，检查器会跳过源码变更过期保护；不能把现有 hash 机制当作完整保障。
- 变更后应按影响范围更新 Contract 和 Scene；测试通过只能证明已覆盖的契约，不代表未覆盖功能已验证。

实现细节和历史测试改造过程见 `history/design/` 与 `history/implementation/`。
