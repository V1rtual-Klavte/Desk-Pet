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
skills/{name}/SKILL.md（内置，编译期经 import.meta.glob 注入）
CONFIG tools.skill.skills（用户上传）
  -> loadSkills() 落盘到 data_root/skills/{name}/SKILL.md
  -> formatSkillsForSystemPrompt() 只把 name / description / location 注入 system prompt
  -> 模型判定任务匹配后，用已有的 read 工具读取 location 加载正文
```

- 名称必须是 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`），且与目录名一致；`description` 必填。不合规的 Skill 会被丢弃并记 warn。
- `data_root/skills/` 是**派生目录**：每次启动按当前来源重写，真相源是内置资源与 CONFIG。内置 Skill 不可删除，用户 Skill 覆盖同名内置 Skill。
- 清单只在 `toolsConfig.skillEnabled` 为真、且本轮有工具可用时才注入 —— 模型要靠 `read` 才能加载正文。
- Skill 不再携带自己的安全级别。它调用的每个工具各自走 `checkSafety`，权限落在具体操作上。

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
| `toolExecution: "parallel"` | 批次里只要有一个工具标 `sequential` 就整批串行；只读类别（`fs.read` / `os.info` / `net.fetch` / `clip.read`）保持并发。`net.fetch` 目前没有对应工具，属于预留 |
| `beforeToolCall` | 工具次数上限、`checkSafety`、用户确认 |
| `steering` | 用户可在回合执行中插话，本轮工具跑完后注入下一轮 |
| `onUpdate` | 工具执行中的快照回传 |
| `isError` 往返 | tool 消息落盘保留失败标记，重开会话后模型仍能区分成功与失败 |

压缩相关（`transformContext`、`shouldStopAfterTurn`）暂未接入，留待记忆系统重构。

## 已知问题

以下问题已定位但**尚未修复**，需要连同权限、沙箱与安全体系一起重审：

- `checkSafety` 的会话信任短路发生在 `resolveSafetyLevel` **之前**，被信任的工具不再重新计算风险等级。
- 助手模式下 `bash_exec` 的 `restricted` 为假，Rust 侧只剩 7 个子串硬匹配，白名单与 Shell 组合符检查都不生效。
- `app_open` 没有路径校验，且 NORMAL 级别在确认一次后可会话内信任。

## 验证状态

`pnpm run test:types` 与 `pnpm run build` 通过。本轮的运行时行为变更（并行工具执行、steering 插话、Skill 渐进披露）尚未经过真实 Provider 的 Live Test 覆盖，不能视为运行时验证通过。
