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

仅助手模式额外加载：`app_open`、`clipboard_read`、`clipboard_write`、`agent_spawn`（fork / team），以及启用后的 MCP 工具。

目录列举不再单独提供工具，改由 `bash` 执行 `ls`（`ls` 在白名单内，两种模式都放行）。

不再保留的模型侧工具：

- `file_search` — 只列一层目录再按文件名过滤，不是递归搜索。
- `http_get` — 用 WebView 的 `window.fetch`，受 CORS 限制而经常失败；且 SSRF 防护是字面量黑名单，`fetch` 默认跟随重定向可被 302 绕过。联网能力改由 MCP 服务器提供。
- `ls` — 与 `bash ls` 冗余。

Pi 官方 CLI（`pi-coding-agent`）提供 `ls` / `grep` / `find`，但它们的模块顶层直接 `import` `node:fs/promises`、`child_process`、`node:readline`，运行时还要下载 ripgrep / fd 二进制，在 Tauri WebView 里不可用。`read` / `write` / `edit` / `bash` 能用，是因为它们走 `ExecutionEnv` 抽象而不直接依赖 Node。

## Skill

Skill **不是工具**：不注册 `ToolDef`，不占工具声明槽。采用 Pi 原生的渐进披露模型：

```text
src-tauri/resources/defaults/skills/{name}/SKILL.md   ← 随包种子，只读
  └─ 首次启动复制一次 ──→ data_root/skills/{name}/SKILL.md   ← 唯一真相源，用户可改可删
       -> formatSkillsForSystemPrompt() 只把 name / description / location 注入 system prompt
       -> 模型判定任务匹配后，用已有的 read 工具读取 location 加载正文
```

- 名称必须是 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`），且与目录名一致；`description` 必填。不合规的 Skill 会被丢弃并记 warn。
- `data_root/skills/` 与其他运行时资源同一套所有权模型：种子只在首次启动复制一次，之后应用不再覆盖。误删或想同步种子更新，用设置页的「恢复默认资源」。
- 新增/覆盖 Skill 直接写 `data_root/skills/{name}/SKILL.md`；删除走 `skill_delete`（通用 `file_delete` 只允许 memory/ 与 sessions/）。不再有内置 / 用户之分。
- 清单只在 `toolsConfig.skillEnabled` 为真、且本轮有工具可用时才注入 —— 模型要靠 `read` 才能加载正文。
- Skill 不携带自己的安全级别。它调用的每个工具各自走 `checkSafety`，权限落在具体操作上。

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
| `toolExecution: "sequential"` | Agent 级无条件串行开关。Pi 的实现是 `config.toolExecution === "sequential"` 时整批串行，per-tool `executionMode` 只能强制串行、不能强制并行；因此 `PARALLEL_SAFE_CATEGORIES` 当前不产生效果，只读并行需等 P5 遗留门禁关闭后再逐类开放 |
| `beforeToolCall` | 工具次数上限、`checkSafety`、用户确认 |
| `steering` | 用户可在回合执行中插话，本轮工具跑完后注入下一轮 |
| `onUpdate` | 工具执行中的快照回传 |
| `isError` 往返 | tool 消息落盘保留失败标记，重开会话后模型仍能区分成功与失败 |

Provider 网络请求只允许 `http`/`https`，请求有固定超时，响应体按 4 MiB 上限流式读取；超限、取消和超时均转为失败结果，不把异常正文继续交给模型。

Pi 0.85.1 已公开 `transformContext`、`shouldStopAfterTurn`、`prepareNextTurnWithContext`、`subscribe`、`onPayload` 和 `onResponse`；当前 runtime 已接入 `transformContext`、`onPayload`、`onResponse`、`subscribe` 和 `beforeToolCall`，用于 ContextKernel、双阶段 PromptSnapshot 和 trace。`prepareNextTurnWithContext` / `shouldStopAfterTurn` 仍未接入，队列 drain 由 `AgentSlot` 自行驱动。

## 工具门禁与审计

工具前后置门禁走 **Pi 原生语义**：`pi/runtime.ts` 在 `beforeToolCall` 内联执行工具次数上限、`checkSafety` 和用户确认，返回 `{ block: true }` 或回调抛错时工具都不会执行（fail-closed，场景 `safety-hook-errors` 断言该行为）；工具结束后由 Pi 的 `afterToolCall` 与 trace 记录结果。

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

## 已知问题

以下问题已定位但**尚未修复**，属 P5 遗留项，需要连同权限、沙箱与安全体系一起重审：

- 会话信任的粒度是「工具 + 本次参数」（`trustSignature`），但 `pi-write` 的签名包含完整正文，所以同一文件的不同内容每次都算新调用，需要各自确认。
- `bash_exec` 的 spill 文件保留最近 10 份后自动淘汰，没有跨会话的持久保留策略。
- Provider 网络只校验协议、超时和响应体上限，没有重定向次数与私网/环回 IP 防护。
- `tools.bash.enabled` 与 `tools.file.enabled` 是死配置：`config.ts` 的 `bashEnabled` / `fileEnabled` getter 没有任何消费者，设置页的开关不改变行为。

已修复（2026-09-15 复核）：

- **bash 最终基线**：`restricted: bool` 换成必填的 `policy { scope, whitelist }`，助手模式不再能关闭 Rust 校验；`find -delete` / `-exec` 一类「首词合法、参数致命」的命令已由层 1 参数级禁项覆盖（提交 `eb9a312`）。
- `checkSafety` 的会话信任短路 —— 现在先计算 `resolveSafetyLevel` 再应用会话信任，且信任不能越过动态 NOWAY。
- **`bash_exec` 阻塞与内存**：命令体搬进 `spawn_blocking`；`timeout_ms` 缺省补 120s 兜底；输出改走尾部窗口读取 + 分块统计行数，不再整读入内存（提交 `c270680`）。
- **工具输出 spill**：Rust 在截断时保留完整输出并回传 `spillPath`，`exec()` 把它同时放进流式更新与最终结果，`router` 的内联预算改为同时作用于 `contentParts`（提交 `ff1f49e`）。
- **`app_open` 无校验**：Rust 命令注入 `State<AppPaths>` 并先走 `validate_file_path`；macOS 与 `xdg-open` 加 `--`；Windows 改走 `ShellExecuteW`，路径不再经过 cmd 解析；工具级别由 NORMAL 提为 DANGER（提交 `15a64d3`）。
- **文件路径分级未接通**：`resolveFilePathLevel` 已接到 `pi-read`/`pi-write`/`pi-edit`，私钥凭据 NOWAY、`.env` 与系统目录 DANGER（提交 `4aedfd1`）。
- **信任粒度**：`trustToolInSession(toolName, signature?)` 记的是「工具 + 本次参数」，DANGER 工具确认后按参数记住；`ToolContext.sessionTrusted` 这个从未被读取的死字段已删除（提交 `2998607`）。

## 验证状态

`pnpm run test:types` 与 `pnpm run build` 通过。safety 与 tool-execution 模块已建立 Live Contract 与场景（`safety-safe`/`safety-normal`/`safety-danger`/`safety-noway`/`safety-hook-errors`/`safety-trust-lifecycle`/`tool-cancelled`/`tool-provider-network-boundary` 等）；`safety-hook-errors` 现在断言 Pi 原生 `beforeToolCall` 在 block 与抛错两种情况下都不执行工具。bash 两层策略有 `bash_policy.rs` 内的 Rust 单元测试（`#[cfg(test)]`），`paths.rs` 与 `tool_exec.rs` 也各有 `#[cfg(test)]` 用例（符号链接叶子、尾部窗口截断与旧实现逐字段比对）；这些都不在 Live Test 里，`test:types` 与 CI 也只跑 `cargo check`、不执行 `cargo test`。

2026-09-15 采集：`pnpm test -- --module tool-execution --strict` 5/5 通过；`pnpm test -- --module safety --strict --repeat 2` 在 5 次运行中 3 次 25/25 通过、2 次各出现 1 个场景超时（总时长 137–140s，即恰好一个场景耗尽 120s 的 `DEFAULT_SCENE_TIMEOUT`）。超时发生在纯逻辑场景上——它们仍会走一次真实 LLM 回合（本文件此前记录的 L7 问题），因此判定为 Provider 侧调用停滞，不是本轮改动的确定性回归，但**尚未做「改动前基线对照」**，不能记为稳定通过。
