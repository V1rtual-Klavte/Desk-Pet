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

## 未验证边界

- 恢复中断运行时「MCP 不可用 → 显式提示」的异常路径（FIX-61）：无法由现有场景直接验证，缺的是**前提不可构造**——它要求中断运行里待重放的工具是 `mcp_*` 且其服务器本次借不到（`pendingInterruptedToolNames` 与本次能力准备的 `unavailableMcp` 取交集），而 Live 场景没有连接真实 stdio MCP 服务器（`MCP大结果回读` 只在传输边界替换 `callTool`）。这条失败不是「只存在于界面呈现」：运行入口先 `appendAssistantMessage` 落成普通助手条目（`stopReason: "stop"`，读模型可见），再把它作为 `reply` 返回，观测面存在。代理由 `runtime-resume-capability-prep` 覆盖：恢复路径确实重新执行能力准备（Skill 目录在恢复后可用），且会话里不落上游「Tool … is unavailable」通用文案。

最新集中验证证据与仍存缺口记录在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md#6-当前验证证据)。
