# 当前工具系统

## 范围

当前分支已将模型可见的文件与命令工具迁移到 `@earendil-works/pi-agent-core`：

```text
Pi Harness Tool
  -> harness-adapter.ts
  -> ToolRouter + Safety
  -> TauriExecutionEnv
  -> Rust tool_exec commands
```

Pi 的 `read`、`write`、`edit`、`bash` 通过统一适配器暴露给 Desk-Pet；原来的 `file_read`、`file_write`、`bash_exec_full` 和模型侧 `bash_exec` ToolDef 已删除。Rust 命令仍保留为内部 IPC 和 MemoryService 的实现接口。

## 双模式

轻量模式和助手模式共享四个 Pi 基础工具，以及 `file_list`、`file_search`、`system_info`、`http_get`。轻量模式不再因为缺少写入或编辑能力而残缺：

- `pi-read`：SAFE，直接放行。
- `pi-write` / `pi-edit`：DANGER，执行前确认；配置关闭时硬拒绝。
- `pi-bash`：白名单单命令为 NORMAL；扩展命令进入确认；命中 NOWAY 模式硬拒绝。

助手模式仍额外加载应用、剪贴板、Skill、MCP 和子代理工具。删除工具没有模型侧入口，Rust 的历史删除命令不属于本轮迁移范围。

## 执行与资源边界

- 文件读写上限为 5 MiB；Bash 输出默认限制为 50 KiB / 2000 行。
- Bash 支持超时和取消，运行中的子进程由 Rust `BashPool` 管理。
- Router 为每次调用创建 `AbortController`，向 Pi Harness 传递取消信号和增量结果。
- 路径由 `AppPaths` 校验，仅允许用户 Home 或系统临时目录；新文件会校验最近存在的父目录。

## 验证状态

`pnpm run test:types`、`pnpm run build` 和所有 Live Contract hash 已通过。Live Test 能启动真实 Tauri 窗口并完成初始化；当前配置的 Provider 返回 HTTP 503，导致真实工具场景没有产生模型 tool call，因此不能把本次 Live 场景结果视为工具运行时通过。

