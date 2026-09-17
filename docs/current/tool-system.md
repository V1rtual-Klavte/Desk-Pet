# 当前工具系统

## 范围

模型可见的文件与命令工具全部来自 `@earendil-works/pi-agent-core`：

```text
Pi Harness Tool
  -> harness-adapter.ts
  -> ToolRouter + Safety
  -> TauriExecutionEnv
  -> Rust tool_exec commands
```

Pi 的 `read`、`write`、`edit`、`bash` 通过统一适配器暴露给 Desk-Pet。Rust 的 `file_read`、`file_write`、`bash_exec` 等命令仍保留为内部 IPC，MemoryService 与路径模块也在用。

## 工具清单

两种模式共享：

| 工具 | 来源 | 安全级别 | 说明 |
|---|---|---|---|
| `read` | Pi | SAFE | 文本与图片（jpg/png/gif/webp/bmp）；图片以附件形式发给模型 |
| `write` | Pi | DANGER | 配置关闭时硬拒绝 |
| `edit` | Pi | DANGER | 同上 |
| `bash` | Pi | 动态 | Rust 两层 token 策略：层 1 硬基线在两种模式下都执行；层 2 按 scope 叠加，pet 要求首词在白名单内且禁 Shell 组合符，assistant 放行扩展命令但仍拒绝操作系统路径。TS 侧再按风险分级决定确认 |
| `system_info` | 本地 | SAFE | OS / 架构 / CPU / 内存 |
| `read_session_event` | 回合内本地工具 | SAFE | 按 eventId 分页读取当前会话完整工具结果 |

仅助手模式额外加载：`app_open`、`clipboard_read`、`clipboard_write`、`agent_spawn`（fork / team），以及启用后的 MCP 工具。

目录列举不再单独提供工具，改由 `bash` 执行 `ls`（`ls` 在白名单内，两种模式都放行）。

不再保留的模型侧工具：

- `file_search` — 只列一层目录再按文件名过滤，不是递归搜索。
- `http_get` — 用 WebView 的 `window.fetch`，受 CORS 限制而经常失败；且 SSRF 防护是字面量黑名单，`fetch` 默认跟随重定向可被 302 绕过。联网能力改由 MCP 服务器提供。
- `ls` — 与 `bash ls` 冗余。

Pi 官方 CLI（`pi-coding-agent`）提供 `ls` / `grep` / `find`，但它们的模块顶层直接 `import` `node:fs/promises`、`child_process`、`node:readline`，运行时还要下载 ripgrep / fd 二进制，在 Tauri WebView 里不可用。`read` / `write` / `edit` / `bash` 能用，是因为它们走 `ExecutionEnv` 抽象而不直接依赖 Node。

## Skill

Skill catalog 仅缓存有界 frontmatter 元数据；Rust `skill_list_metadata` 不读取完整正文。目录按 TTL、上传、删除和模式退出失效，回合冻结 fingerprint 与清单。`invocationPolicy` 支持 pet/assistant/both（默认 assistant），`capabilityTags` 支持能力过滤。`tools.skill.enabled` 在两种模式均可开启，不提升具体工具权限。

Skill **不是工具**：不注册 `ToolDef`，不占工具声明槽。采用 Pi 原生的渐进披露模型：

```text
src-tauri/resources/defaults/skills/{name}/SKILL.md   ← 随包种子，只读
  └─ 首次启动复制一次 ──→ data_root/skills/{name}/SKILL.md   ← 唯一真相源，用户可改可删
       -> formatSkillsForSystemPrompt() 只把 name / description / location 注入 system prompt
       -> 模型判定任务匹配后，用已有的 read 工具读取 location 加载正文
```

- 名称必须是 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`），且与目录名一致；`description` 必填。不合规的 Skill 会被丢弃并记 warn。
- `data_root/skills/` 与其他运行时资源同一套所有权模型：种子只在首次启动复制一次，之后应用不再覆盖。误删或想同步种子更新，用设置页的「恢复默认资源」。
- 新增/覆盖 Skill 直接写 `data_root/skills/{name}/SKILL.md`；删除走 `skill_delete`。不再有内置 / 用户之分。
- 清单只在 `toolsConfig.skillEnabled` 为真、且本轮有工具可用时才注入 —— 模型要靠 `read` 才能加载正文。
- Skill 不携带自己的安全级别。它调用的每个工具各自走 `PermissionKernel`，权限落在具体操作上。

## 执行与资源边界

- 文件读写上限 5 MiB；Bash 输出默认 50 KiB / 2000 行。
- Bash 支持超时与取消，运行中的子进程由 Rust `BashPool` 管理。
- Router 为每次调用创建 `AbortController`，向 Pi Harness 传递取消信号和增量结果。
- 路径由 `AppPaths` 校验，仅允许用户 Home 或系统临时目录。

## Pi Runtime 能力接线

`src/services/engine/pi/runtime.ts` 使用到的 Pi 能力：

| 能力 | 用途 |
|---|---|
| `sessionId` | Provider 端 prompt cache |
| `toolExecution: "sequential"` | Agent 级无条件串行开关。Pi 的实现是 `config.toolExecution === "sequential"` 时整批串行，per-tool `executionMode` 只能强制串行、不能强制并行；因此 `PARALLEL_SAFE_CATEGORIES` 当前不产生效果，只读并行是后续独立优化，本分支保留串行 |
| `beforeToolCall` | 工具次数上限、`PermissionKernel`、用户确认 |
| `steering` | 用户可在回合执行中插话，本轮工具跑完后注入下一轮 |
| `onUpdate` | 工具执行中的快照回传 |
| `isError` 往返 | 工具 call/result 在下一次请求前持久化，保留实际 API round、错误标记与非可信来源；重开会话从磁盘恢复 |

Provider 网络请求固定到用户配置的 `http`/`https` origin，禁止 URL 内嵌凭据与任何重定向，显式 localhost/私网配置用于本地模型；WebView 不提供 DNS pinning，因此这不是任意 URL 的通用 SSRF 代理。请求有固定超时，响应体按 4 MiB 上限流式读取；超限、取消和超时均转为失败结果，不把异常正文继续交给模型。

Pi 0.85.1 已公开 `transformContext`、`shouldStopAfterTurn`、`prepareNextTurnWithContext`、`subscribe`、`onPayload` 和 `onResponse`；当前 runtime 已接入 `transformContext`、`onPayload`、`onResponse`、`subscribe` 、`beforeToolCall` 和 `afterToolCall`，用于 ContextKernel、三阶段 PromptSnapshot 和 trace。`prepareNextTurnWithContext` / `shouldStopAfterTurn` 仍未接入，队列 drain 由 `AgentSlot` 自行驱动。

## 工具门禁与审计

`PermissionKernel` 将风险等级与最终 `allow / ask / deny` 分开。工具可返回 `passthrough`，MCP 明确采用此值；它只能继续总策略，不能到达 executor。静态硬拒绝优先，来源 allow 不能吞掉总策略 ask。

`beforeToolCall` 先等待工具调用事实落盘，再检查次数和权限。确认包含 session、generation、call ID、参数 hash、策略 hash 和到期时间；UI 支持仅本次、会话内同参数和拒绝。确认后重新校验，策略或参数变化、取消、切换会话均失效。授权在回合结束释放。

`afterToolCall` 统一标注结果来源/taint/error；`subscribe` 将完整调用结果加入严格写队列；`transformContext` 构造请求视图，Provider wrapper 执行最终硬预算检查。禁止再引入无生产消费者的通用 HookBus。

Desk-Pet 曾自研 blocking / async 的 HookBus，因生产消费者为零（唯一使用者是测试里自建实例的自证循环）而整模块删除。**需要「阻断」语义的门禁不要放到观测总线上** —— `engine/runtime/trace.ts` 只做观测，listener 的返回值不参与决策，超时与异常都被隔离。

`tool/router.ts` 为每次调用生成 `operationId`（取 `toolCallId`）和 `policyHash`（由 `actionCategory` 与 `safetyLevel` 序列化而来），把 `{ operationId, toolName, outcome, policyHash }` 写入结果的 `details.audit`。同一组 hash 也会进入 PromptSnapshot 的 `toolSchemas`。

取消与超时：`executeTool` 在入口检查 `ctx.signal`，为 handler 创建独立 `AbortController` 并叠加超时；取消返回 `cancelled`，超时返回 `timeout`，未注册返回 `not_found`，其余失败返回 `failed`。

## Bash 最终基线

`src-tauri/src/commands/bash_policy.rs` 是不可关闭的最终门禁，`bash_exec` 的 `policy` 参数必填 `{ scope, whitelist }`（漏传即反序列化报错，不会静默退化为最弱策略），调用方只能**叠加**规则：

| 层 | 规则 | pet | assistant |
|---|---|---|---|
| 层 1 硬基线 | 递归删根/家目录、`mkfs*`、`dd` 直接读写设备、系统电源命令、fork bomb、下载管道直连 shell、`-delete`/`-exec` 类破坏性参数、递归 `chmod`/`chown` 777 或指向根/家目录、重定向写系统路径 | 执行 | 执行 |
| 层 2 按 scope | pet：首词必须在白名单内 + 禁 Shell 组合符；assistant：允许白名单外命令与组合符，但 `rm`/`mv`/`dd`/`chmod` 等写删类动词指向固定系统路径即拒绝 | 执行 | 执行 |

判定基于 Shell 级 token 分析（引号、控制运算符、`sudo` 等前缀包裹命令、嵌套 `sh -c`），不做子串 `contains` —— 旧实现既漏 `rm  -rf  /`、`find ~ -delete`，又误杀 `rm -rf /Users`。参数级禁项不与二进制绑定，所以 `find`、`fd`、`xargs`、`rsync` 一并覆盖，白名单里新增命令不需要重新审一遍参数。

## MCP 桥接

MCP server 由 Rust 以 stdio 子进程方式托管（`commands/mcp_bridge.rs`），前端只经 `src/services/tool/mcp/` 的 barrel 调用。

- **请求/响应配对**：`mcp_send` 每次用递增的 JSON-RPC `id` 发请求，只接受 id 匹配的响应。server 主动推送的 notification（有 `method` 无 `id`）与非 JSON 调试输出都被跳过 —— 早期实现把任何能解析的 JSON 都当响应返回，notification 因此变成「成功但 result 为空」。
- **读取不阻塞**：stdout 由常驻读线程按行投递到 channel，请求侧 `recv_timeout` 上限 60s。早期每请求新建 `BufReader` 还有丢数据的隐患：一次 `read_line` 会预读多行，`BufReader` 析构时缓冲里剩下的字节直接丢失。
- **进程回收**：`mcp_kill` 结束单个 server；应用退出时 `lib.rs` 的 `RunEvent::Exit` 调 `McpPool::kill_all()`，覆盖托盘退出这条不经过前端钩子的路径。Windows 上 `taskkill /T /F /PID` 递归结束进程树，避免 `npx` 派生的 `node` 变孤儿。
- **env（API Key 等）**：设置面板用 `KEY=VALUE` 每行一条的文本编辑，落盘前由 `parseEnvText` 还原成对象。env 只透传给子进程，日志里只记 command/args；导出 JSON 含 env 时会先弹确认框提示文件里有明文凭据。
- **测试连接**不会留下常驻连接：本来没连的测完立刻断开，本来连着的保持连接状态。

## 当前边界与取舍

- 有限授权绑定 session、run generation、工具、完整参数和策略 hash；同一文件不同写入正文是不同授权，运行结束失效。这是权限边界，不从摘要恢复授权。
- Bash spill 最近 10 份自动淘汰；会话中的工具结果事件与 `read_session_event` 则按会话保留。Bash 本身的超长输出以 spill 引用为准，不声称永不淘汰。
- Provider 请求固定配置 origin、禁止 redirect、限制超时和增量响应体；显式 localhost 模型合法。WebView 无 DNS pinning，MCP/shell 的网络行为不由 Provider fetch wrapper 控制。
- 工具仍串行执行；只读并行未在本分支开放。

已修复（2026-09-15 复核）：

- **bash 最终基线**：`restricted: bool` 换成必填的 `policy { scope, whitelist }`，助手模式不再能关闭 Rust 校验；`find -delete` / `-exec` 一类「首词合法、参数致命」的命令已由层 1 参数级禁项覆盖（提交 `eb9a312`）。
- `PermissionKernel` 的会话信任短路 —— 现在先计算 `resolveSafetyLevel` 再应用会话信任，且信任不能越过动态 NOWAY。
- **`bash_exec` 阻塞与内存**：命令体搬进 `spawn_blocking`；`timeout_ms` 缺省补 120s 兜底；输出改走尾部窗口读取 + 分块统计行数，不再整读入内存（提交 `c270680`）。
- **工具输出 spill**：Rust 在截断时保留完整输出并回传 `spillPath`，`exec()` 把它同时放进流式更新与最终结果，`router` 的内联预算改为同时作用于 `contentParts`（提交 `ff1f49e`）。
- **`app_open` 无校验**：Rust 命令注入 `State<AppPaths>` 并先走 `validate_file_path`；macOS 与 `xdg-open` 加 `--`；Windows 改走 `ShellExecuteW`，路径不再经过 cmd 解析；工具级别由 NORMAL 提为 DANGER（提交 `15a64d3`）。
- **文件路径分级未接通**：`resolveFilePathLevel` 已接到 `pi-read`/`pi-write`/`pi-edit`，私钥凭据 NOWAY、`.env` 与系统目录 DANGER（提交 `4aedfd1`）。
- **信任粒度**：`trustToolInSession(toolName, signature?)` 记的是「工具 + 本次参数」，DANGER 工具确认后按参数记住；`ToolContext.sessionTrusted` 这个从未被读取的死字段已删除（提交 `2998607`）。

## 验证状态

2026-09-17 本分支的当前集中验证以[执行手册 §6.1](../plans/active/记忆系统重构执行手册.md#61-当前检查点接力唯一依据)为准。以下命令与不稳定记录为 2026-09-15 历史基线，不代表当前工作树。

`pnpm run test:types` 与 `pnpm run build` 通过。safety 与 tool-execution 模块已建立 Live Contract 与场景（`safety-safe`/`safety-normal`/`safety-danger`/`safety-noway`/`safety-hook-errors`/`safety-trust-lifecycle`/`tool-cancelled`/`tool-provider-network-boundary` 等）；`safety-hook-errors` 现在断言 Pi 原生 `beforeToolCall` 在 block 与抛错两种情况下都不执行工具。bash 两层策略有 `bash_policy.rs` 内的 Rust 单元测试（`#[cfg(test)]`），`paths.rs` 与 `tool_exec.rs` 也各有 `#[cfg(test)]` 用例（符号链接叶子、尾部窗口截断与旧实现逐字段比对）；这些都不在 Live Test 里，`test:types` 与 CI 也只跑 `cargo check`、不执行 `cargo test`。

2026-09-15 采集：`pnpm test -- --module tool-execution --strict` 5/5 通过；`pnpm test -- --module safety --strict --repeat 2` **不稳定** —— 本轮改动后 7 次运行中 5 次 25/25 全绿，2 次各出现 1 个场景超时（137.1s / 139.7s，均为单个场景耗尽 120s 的 `DEFAULT_SCENE_TIMEOUT`）。改动前的基线 `380ab45` 连跑 5 次全部 25/25、耗时 14.8–24.6s；Fisher 精确检验 p≈0.47，样本量不足以判定两组有显著差异，改动中也没有能使 Provider 网络调用停滞的机制，因此**归因未定**，不能记为稳定通过。超时落在纯逻辑场景上——它们照样走一次真实 LLM 回合（计划 §3.5 的 L7），根治办法是 L2 的 `entry: "unit"`，而不是继续加采样。

MCP 不在应用启动时连接。助手回合按 owner 取得启用的 server；并发取得串行化，最后 owner 释放时关闭进程并注销工具。`includeTools`/`excludeTools` 过滤发现结果；当前回合执行已冻结的 ToolDef。设置修改不会无声杀掉被运行回合借用的连接。
