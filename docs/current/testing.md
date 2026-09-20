# 当前测试边界

Desk-Pet 的运行时验证以 [Live Test 使用规范](../../src/services/__tests__/live/README.md) 为权威入口；代码代理对 Contract 和 Scene 的分析、生成、审查流程以 [Live Test Skill](../../src/services/__tests__/live/SKILL.md) 为准。本页只说明当前验证的边界，不记录历史通过次数、旧报告或完整命令清单。

## 验证层次

- **Live Test** 在独立 Tauri WebView 中运行真实前端服务、Rust IPC、运行时状态和临时数据根。它按 Scene 的入口选择真实 Provider、fake Provider 或无模型的 unit 断言；这些入口的含义及命令见 Live README。
- **类型与编译检查**只证明 TypeScript/Rust 的静态可构建性，不能替代 Live Test 的状态、IPC、Provider 或工具链验证。
- **Rust 单测**（`pnpm run test:rust`，即 `cargo test --lib`）覆盖 `src-tauri` 内不依赖运行时的纯逻辑：Bash 策略、路径校验、输出裁剪与工具许可额度。它们不启动 Tauri，也不验证 IPC、Provider 与持久化。
- **CI** 在 macOS 和 Windows 执行编译级检查与 Rust 单测；Live Test 不在 CI 中运行。Windows 的运行时交互仍须在支持的桌面环境中验证。

## Contract 门禁

每个当前模块 Contract 都以 `sourceFiles` 和 `sourceHash` 绑定源码版本。源码改变后必须重新分析受影响 Contract，补齐或调整关联 Scene；空 hash、过期 hash、无效 caseId 引用和严格覆盖缺口都不能作为通过证据。

严格模式同时检查：

- `coverage.scenarios` 引用已发现的 **caseId**，并与模块和 `contractId` 匹配；
- Contract 所需的 `boundary`、`error` 由实际 Scene tag 满足；
- 除显式且有理由的 `unitOnly` 外，每个 Contract 至少有一个非 unit 场景。

通过结果只证明当次配置、Provider 与已覆盖 Scene 下的行为；长期记忆自动检索、未覆盖平台路径或尚未接通的规划能力不能由已有场景推断为已验证。

最新集中验证证据与仍存缺口记录在[记忆系统重构执行手册](../plans/active/记忆系统重构执行手册.md)。
