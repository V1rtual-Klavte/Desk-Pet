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
| `bash` | Pi | 动态 | 白名单单命令为 NORMAL；扩展命令进入确认；命中硬禁止模式为 NOWAY |
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

## Hook 与审计

`engine/runtime/hook-bus.ts` 提供 Desk-Pet 的 HookBus：blocking handler 串行等待并可以返回 `block`，async handler 脱离主链路；每个 handler 有 deadline（钳制在 1–2000ms）、重入保护和 `hook_timeout` / `hook_failed` / `hook_reentrancy` 稳定错误码。

`pi/runtime.ts` 在 `beforeToolCall` 发 `before_tool_call`（blocking，可阻断执行），在工具结束后发 `after_tool_call`（async）。**当前没有任何生产代码调用 `hookBus.register`**，所以 block 分支不会触发；HookBus 是已接线但尚无消费者的扩展点。

`tool/router.ts` 为每次调用生成 `operationId`（取 `toolCallId`）和 `policyHash`（由 `actionCategory` 与 `safetyLevel` 序列化而来），把 `{ operationId, toolName, outcome, policyHash }` 写入结果的 `details.audit`。同一组 hash 也会进入 PromptSnapshot 的 `toolSchemas`。

取消与超时：`executeTool` 在入口检查 `ctx.signal`，为 handler 创建独立 `AbortController` 并叠加超时；取消返回 `cancelled`，超时返回 `timeout`，未注册返回 `not_found`，其余失败返回 `failed`。

## 已知问题

以下问题已定位但**尚未修复**，属 P5 遗留项，需要连同权限、沙箱与安全体系一起重审：

- 助手模式下 `bash_exec` 的 `restricted` 为假（`tauri-execution-env.ts` 传 `this.mode === "pet"`），Rust 侧只剩 7 个子串硬匹配，白名单与 Shell 组合符检查都不生效。前端模式不应关闭 Rust 最终基线。
- `app_open` 没有路径校验，Rust 命令未注入 `State<AppPaths>`；且 NORMAL 级别在确认一次后可会话内信任。
- 工具输出没有 spill：`tool/router.ts` 只做 50000 字符内联截断，超长输出仍会进入上下文。
- Provider 网络只校验协议、超时和响应体上限，没有重定向次数与私网/环回 IP 防护。

已修复（2026-09-15 复核）：`checkSafety` 的会话信任短路 —— 现在先计算 `resolveSafetyLevel` 再应用会话信任，且信任不能越过动态 NOWAY。

## 验证状态

`pnpm run test:types` 与 `pnpm run build` 通过。safety 与 tool-execution 模块已建立 Live Contract 与场景（`safety-safe`/`safety-normal`/`safety-danger`/`safety-noway`/`safety-hook-errors`/`safety-trust-lifecycle`/`tool-cancelled`/`tool-provider-network-boundary` 等）。P5 阶段的 `pnpm test -- --module safety|tool-execution --strict` 结果尚未采集，不能视为运行时验证通过；见[执行手册](../plans/active/记忆系统重构执行手册.md)「当前检查点」。
