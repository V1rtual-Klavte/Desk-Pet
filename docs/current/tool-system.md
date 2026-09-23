# 当前工具系统

本文维护工具能力、权限和 Skill/MCP 生命周期。Pi hook 的整体接线、请求快照与会话代际见[运行时契约](runtime-contract.md)，历史修复记录见[加固基线](../history/analysis/运行时加固与清理计划-2026-09-17基线.md)。

## 执行链与模式

```text
Pi Harness Tool → harness-tool-adapter → ToolRouter → 执行许可借用 → TauriExecutionEnv → Rust tool_exec
                        ↑ beforeToolCall / PermissionKernel 先完成门禁
```

文件与命令工具来自 Pi 的 ExecutionEnv 抽象，通过 [harness-adapter](../../src/services/tool/pi/harness-adapter.ts) 和 [TauriExecutionEnv](../../src/services/tool/pi/tauri-execution-env.ts) 接入 WebView。内部 IPC 的 file_read/file_write/bash_exec 仍可被宿主服务使用；它们不是另一个模型工具集。

| 工具 | 模式 | 当前边界 |
|---|---|---|
| read | 两种 | 文本或图片读取；敏感路径仍会提高风险或被拒绝；私钥/凭据路径（含相对形式与 `~`/`$HOME`/`${HOME}`/反斜杠/`..` 归一）在两种模式下都硬拒绝 |
| write / edit | 两种 | DANGER；配置关闭时硬拒绝 |
| bash | 两种 | 动态风险；陪伴模式白名单与禁组合符，助手模式仍保留 Rust 硬基线 |
| system_info | 两种 | 只读系统信息 |
| read_session_event | 回合内 | 按 eventId 分页读取当前会话保存的完整工具结果 |
| app_open / clipboard_read / clipboard_write / agent_spawn | 助手 | 按需注册，受各自策略约束 |
| MCP 工具 | 助手 | 仅启用且成功借用的 server，受工具发现过滤与权限终裁 |

实际清单由 [registry.ts](../../src/services/tool/registry.ts)、[pi-tools.ts](../../src/services/tool/local/pi-tools.ts) 和回合冻结快照决定。目录列举使用 bash ls；不再注册独立 ls/file_search/http_get。Pi CLI 的 Node 工具不能直接移入 WebView，需要现有 ExecutionEnv 边界。

## 工具策略

`ToolDef` 仍携带身份、schema、风险等级与 handler，策略集中在 `policy`（[types.ts](../../src/services/tool/types.ts)）：

- `permission.defaultDecision` / `permission.check` 是工具侧权限意见，`passthrough` 不是执行许可。
- `execution.effect / mode / isolation / replay / timeoutMs`：效果分类、调度声明、隔离级别、恢复重放资格与超时；未声明超时时统一取 `loop.toolTimeoutMs`。
- `context.resultProjection`：`preserve` 的原样进入请求，`reference` 的可被 L0 缩短并标注 eventId 回读地址；两者都只改请求视图，会话条目存档始终保留全文。
- `context.historyCompaction`：`retain` 的调用配对必须保留原文，压缩覆盖边界不得越过（连续完整轮下命中即 decline，由预算守卫报告上下文不足）。

[defineTool](../../src/services/tool/policy.ts) 是唯一构造入口（手写、Pi 适配、MCP 都经它产出 ToolDef），注册入口再次校验：缺策略、`parallel` 搭配非只读效果、`exclusive_effect`/`delegate` 非串行都是注册错误，不做缺省猜测。`actionCategory` 只用于人格阶段文案，不再决定并行、权限或压缩。`replay` 由 Harness 恢复路径消费：只有持久化调用与当前工具都声明 `safe` 才会重放效果，当前全部工具为 `never`。

Pi 适配器按策略设置 `executionMode`；当前 Harness 的批次调度只看 run 级 `toolExecution`（现为 `parallel`），逐工具 `executionMode` 在 Harness 路径上没有消费者，实际互斥由下面的执行许可保证。

## 执行许可（纯读并行与效果互斥）

Harness 以 `toolExecution: parallel` 派发批次，效果之间的并发由 Rust 应用级许可所有者裁定：[tool_permit.rs](../../src-tauri/src/commands/tool_permit.rs) 持有额度，前端在 [router.ts](../../src/services/tool/router.ts) 执行入口借用、真实结算后释放（[execution-permit.ts](../../src/services/tool/execution-permit.ts)）。

- `shared_read` 走有界共享额度（默认 4，由 [`ai.loop.maxParallelTools`](runtime-data.md#工具并行上限字段的语义与生效时机) 配置，范围 1–8），两个只读可真正重叠；`exclusive_effect`（write/edit/bash/app_open/clipboard_write/MCP）与进行中的读写互斥，效果按借用顺序串行。
- `delegate`（agent_spawn）不占父批次额度，子运行的工具各自取许可；编排入口不自行执行文件写入。
- 等待可取消（取消会移出排队项），没有超时自动释放；拿到额度后重新核对取消与代际，排队不能成为绕过检查的通道。
- `tool_permit_release` 与 `tool_permit_cancel` 同样绑定借用者：其它窗口/页面即使拿到 requestId 也不能释放在飞额度或取消他人的排队项，被拒绝的调用不改变额度状态。
- 借用者身份 = Rust 提供的窗口标签 + 前端页面实例 id（[execution-permit.ts](../../src/services/tool/execution-permit.ts) 在模块加载时声明上线）。同一窗口同一时刻只有一个活着的页面实例：新实例上线（Vite 全量热重载、WebView 重建）时一次性回收同窗口其它实例的在飞额度与排队项，并以回收数量作为证据。回收只由「借用者已经不存在」触发，不看时间：同一实例重复上线是空操作，其它窗口的借用者与在飞的 `exclusive_effect` 都不受影响；窗口关闭且不再重新加载时，它留下的额度仍要等下一次同窗口上线或进程退出才回收。
- 上限由前端在每个 run 开始前下发给所有者并按运行生效（与队列批量策略同一模式）：降低上限不撤销在飞许可，只是暂停新获准执行；提高会唤醒有序等待项。越界值三处处理不同（见[运行时数据](runtime-data.md#工具并行上限字段的语义与生效时机)）：getter 收拢到最近边界，设置页保存拒绝，Rust 下发直接报错。
- 许可域按数据根区分，Live Test 的临时根自带隔离域；多个 WebView 共用同一所有者。许可只约束 Desk-Pet 托管的调用，不承诺阻止外部进程改文件。

薄 `BaseTool` 仍未实施（当前零消费者）；设置页「工具策略（声明）」区从同一 ToolDef 展示权限意见、隔离级别、结果投影与历史摘要，不复制第二份策略定义。

## 权限终裁

[PermissionKernel](../../src/services/safety/permission.ts) 将风险等级与 `allow / ask / deny / passthrough` 分开：前三种表达工具侧意见，passthrough 继续总策略；内核最终只能给出 allow/ask/deny。MCP 明确走 passthrough，不绕过总策略。硬拒绝优先，工具 allow 不能吞掉总策略 ask。

`beforeToolCall` 等待调用事件落盘，再检查次数、权限和确认。确认绑定 session、generation、call ID、完整参数 hash、策略 hash、到期时间；支持仅本次、会话内同参数、拒绝。确认后重新校验，取消、参数/策略变化或旧代际不能继续执行，授权在运行结束释放，不从摘要恢复。

`afterToolCall` 标注来源、taint 和错误；订阅写队列将结果持久化。观测 trace 不承担阻断语义。Router 的结果 `details.audit` 含 operationId、outcome 和策略元数据；其风险分类 hash 与 PermissionKernel 的完整授权 policyHash 职责不同，不能互相替代。[router.ts](../../src/services/tool/router.ts)

## 文件、命令与取消

- 文件路径通过 AppPaths 校验，允许根为用户 Home、系统临时目录，开发构建还包含项目根；凭据等路径（`.ssh` 目录组件、`*.pem`/`*.key` 后缀）由 Rust 做不可关闭的最终判定，TS 侧的 [resolveFilePathLevel](../../src/services/safety/checker.ts) 是同一规则族的分级副本（相对形式与 `~`/`$HOME`/`${HOME}`/反斜杠/`..` 经词法归一后同判），在进入 ToolRouter 前就提为 NOWAY。
- 这套路径与命令策略是**同一规则族的两层副本**，不是完备的 OS 沙箱：间接形式（如 `python -c "open('~/.ssh/id_rsa')"`）与「拦实际打开的文件」都不在覆盖内；`.env`、系统目录等可确认路径保持不变，助手模式仍走「用户确认后放行」。
- Bash 超时、取消和进程回收由 Rust 管理；Router 为调用叠加取消/超时，区分 cancelled、timeout、not_found、failed。
- 输出上限与 spill 保留数由 [tool_exec.rs](../../src-tauri/src/commands/tool_exec.rs) 管理。Bash 截断会返回 spill 引用，最近文件会淘汰；不能声称任意长的 shell 输出永久存于会话。
- 会话保存的是**工具实际返回内容**；Context L0 再做请求投影时，原工具结果仍可用 read_session_event 读取。两层截断的范围不能混同。

[bash_policy.rs](../../src-tauri/src/commands/bash_policy.rs) 是不可关闭的最终门禁。`bash_exec` 必须接收 `{scope, whitelist}`，两种模式均拒绝删根/家目录、设备破坏、系统电源命令、危险 shell 链及受限参数；陪伴模式再限制首词和组合符，助手模式的系统路径保护也继续生效。策略基于 Shell token，不以简单子串代替；这是一套命令策略，不是完备的 OS 沙箱。

Provider 网络边界独立于 MCP/shell：配置 origin、禁止 redirect、超时和响应上限见[运行时契约](runtime-contract.md#pi权限与网络)。不能把 Provider fetch guard 当作所有联网工具的控制层。

## Skill 渐进披露

Skill 不注册 ToolDef，不占工具声明槽，也不授予权限。[skill/loader.ts](../../src/services/skill/loader.ts) 通过 Rust [skill_list_metadata](../../src-tauri/src/commands/skill_cmd.rs) 读取有界 frontmatter；`getSkillsPromptBlock()` 只注入 name/description/location，正文由模型用 read 按需加载。

- name 为与目录一致的 kebab-case，description 必填；无效条目跳过并记录。
- invocationPolicy 支持 pet/assistant/both，默认 assistant；capabilityTags 供过滤使用。skill 开关可在两种模式启用，但清单需要可用的 read 工具。
- catalog 由 TTL、保存/删除、配置/模式变化等失效；generation 防止旧读取复活缓存，同代际并发合并。回合冻结清单与 fingerprint。
- `data_root/skills/{name}/SKILL.md` 是运行时资源；随包种子及恢复覆盖语义见[运行时数据](runtime-data.md#默认资源与-profile)。

## MCP 生命周期

[manager.ts](../../src/services/tool/mcp/manager.ts) 按助手运行 owner 借用连接；应用启动不连接 MCP。并发 acquire 串行化，最后 owner 释放时关闭进程并注销工具。includeTools/excludeTools 过滤发现结果；工具定义在回合内冻结，设置变化不无声杀掉在飞回合的借用。

Rust [mcp_bridge.rs](../../src-tauri/src/commands/mcp_bridge.rs) 托管 stdio 进程：按 JSON-RPC id 配对响应，跳过 notification 和非 JSON 输出，常驻 stdout 读取线程与有界等待避免请求无限阻塞。应用退出回收 server；Windows 结束进程树，避免派生进程遗留。

设置页测试连接后恢复原连接状态。env 只透传给子进程，日志不打印 env；配置导出含 env 时需要确认明文凭据。MCP 工具一律声明 `passthrough` + `external_side_effect` + `exclusive_effect`，既不能凭发现结果自动获得执行许可，也不能与其它执行并发。

验证规则见[测试边界](testing.md)，集中执行证据只在[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md#6-当前验证证据)记录。
