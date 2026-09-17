# 当前工具系统

本文维护工具能力、权限和 Skill/MCP 生命周期。Pi hook 的整体接线、请求快照与会话代际见[运行时契约](runtime-contract.md)，历史修复记录见[加固基线](../history/analysis/运行时加固与清理计划-2026-09-17基线.md)。

## 执行链与模式

```text
Pi Harness Tool → harness-adapter → ToolRouter → TauriExecutionEnv → Rust tool_exec
                       ↑ beforeToolCall / PermissionKernel 先完成门禁
```

文件与命令工具来自 Pi 的 ExecutionEnv 抽象，通过 [harness-adapter](../../src/services/tool/pi/harness-adapter.ts) 和 [TauriExecutionEnv](../../src/services/tool/pi/tauri-execution-env.ts) 接入 WebView。内部 IPC 的 file_read/file_write/bash_exec 仍可被宿主服务使用；它们不是另一个模型工具集。

| 工具 | 模式 | 当前边界 |
|---|---|---|
| read | 两种 | 文本或图片读取；敏感路径仍会提高风险或被拒绝 |
| write / edit | 两种 | DANGER；配置关闭时硬拒绝 |
| bash | 两种 | 动态风险；陪伴模式白名单与禁组合符，助手模式仍保留 Rust 硬基线 |
| system_info | 两种 | 只读系统信息 |
| read_session_event | 回合内 | 按 eventId 分页读取当前会话保存的完整工具结果 |
| app_open / clipboard_read / clipboard_write / agent_spawn | 助手 | 按需注册，受各自策略约束 |
| MCP 工具 | 助手 | 仅启用且成功借用的 server，受工具发现过滤与权限终裁 |

实际清单由 [registry.ts](../../src/services/tool/registry.ts)、[pi-tools.ts](../../src/services/tool/local/pi-tools.ts) 和回合冻结快照决定。目录列举使用 bash ls；不再注册独立 ls/file_search/http_get。Pi CLI 的 Node 工具不能直接移入 WebView，需要现有 ExecutionEnv 边界。

## 权限终裁

[PermissionKernel](../../src/services/safety/permission.ts) 将风险等级与 `allow / ask / deny / passthrough` 分开：前三种表达工具侧意见，passthrough 继续总策略；内核最终只能给出 allow/ask/deny。MCP 明确走 passthrough，不绕过总策略。硬拒绝优先，工具 allow 不能吞掉总策略 ask。

`beforeToolCall` 等待调用事件落盘，再检查次数、权限和确认。确认绑定 session、generation、call ID、完整参数 hash、策略 hash、到期时间；支持仅本次、会话内同参数、拒绝。确认后重新校验，取消、参数/策略变化或旧代际不能继续执行，授权在运行结束释放，不从摘要恢复。

`afterToolCall` 标注来源、taint 和错误；订阅写队列将结果持久化。观测 trace 不承担阻断语义。Router 的结果 `details.audit` 含 operationId、outcome 和策略元数据；其风险分类 hash 与 PermissionKernel 的完整授权 policyHash 职责不同，不能互相替代。[router.ts](../../src/services/tool/router.ts)

## 文件、命令与取消

- 文件路径通过 AppPaths 校验，允许根为用户 Home、系统临时目录，开发构建还包含项目根；凭据等路径仍受上层风险判断。
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

设置页测试连接后恢复原连接状态。env 只透传给子进程，日志不打印 env；配置导出含 env 时需要确认明文凭据。当前工具执行保持串行，只读并行尚未开放。

验证规则见[测试边界](testing.md)，集中执行证据只在[执行手册](../plans/active/记忆系统重构执行手册.md)记录。
