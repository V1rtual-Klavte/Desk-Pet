# 当前系统设计

本文记录已在当前代码中存在的运行链路和模块边界。项目概览与玩法见 [DES.md](../DES.md)。内容以代码为准，改动时间以 git 历史为准。

2026-09-17 已新增[下一阶段建设方案](../plans/active/轻量陪伴运行时与统一内核建设方案.md)与[会话压缩专项方案](../history/implementation/会话压缩建设方案.md)。运行时前置建设已写入代码：冻结回合快照、统一预算、可靠压缩、PermissionKernel 和 Skill 元数据加载。SQLite 长期记忆仍属后续目标；集中验证状态见执行手册。

## 分层

| 层 | 职责 |
|---|---|
| Vue 界面 | 角色展示、聊天、会话、设置与确认交互。 |
| 核心引擎 | 输入预处理、Plan 编排、Pi Agent Core 运行时适配、工具循环和压缩工具。 |
| 人格与回复 | Card、阶段文案、变量状态、情绪映射与回复后处理。 |
| 记忆与会话 | 当前会话、会话文件、摘要、长期记忆注册表。 |
| 工具与安全 | ToolRegistry、路由、安全检查、确认交互、Skill 与 MCP。 |
| Rust 平台桥接 | 窗口、监控、文件、路径、安全校验和系统能力。 |

## 用户消息主链路

```text
用户输入
  -> runner / preprocessor（去重状态由入口按会话持有）
  -> session 状态更新 + 变量状态刷新
  -> buildPrompt / ContextKernel（六层 block、预算裁剪、兼容 systemPrompt）
  -> 可选 Plan 编排
  -> Pi Agent Core + pi-ai OpenAI-compatible 流 + 顺序工具循环（Pi 原生 beforeToolCall 门禁）+ 安全检查
  -> reply/generator 解析 RUNTIME_DATA
  -> 表情与音效事件、Card 状态持久化、会话事件写入；下一次请求前按需压缩
  -> ChatPanel / StreamView 展示
```

## 人格状态与回复元数据

Card 的变量状态与用户长期记忆是两套数据，不能混写。

```text
LLM 可见回复文本 + <RUNTIME_DATA>
  -> reply/generator.ts 移除元数据块
  -> emotion 映射为表情和音效
  -> batchWriteVars() 只接受已注册、允许 LLM 更新的 card 变量
  -> savePoolToDisk() 写入当前 Card 的运行时状态
```

`system`、`interaction` 和 `session` 状态由系统维护；LLM 不能借由 RUNTIME_DATA 创建任意变量。Card 的 `whenText` 是注入 Prompt 的语气指引，不是可执行条件 DSL。

`src/services/engine/pi/runtime.ts` 是唯一的多轮 Agent Runtime。它在调用 Pi 前刷新变量池、构建 Prompt，并把 Pi 的工具调用接回既有 Safety 和 ToolRouter；Pi 返回最终文本后才调用 `reply/generator.ts`。因此流式增量、工具中间消息都不会直接写入 Card 变量。

当前主 Agent Runtime、Planner 和 Live Test 契约都以 RUNTIME_DATA 为准；旧变量工具只在历史归档中出现，不代表当前接口仍有效。ContextKernel 已固定 `static → dynamic → profile → memory → transcript → ephemeral` 层级，并共享输出/schema/压缩余量预算；画像与召回按完整块选择，未覆盖的 transcript 不得静默删除，核心超限显式报错。`User.md` 只通过带来源、版本和 taint 的 profile projection 注入；长期记忆已建立 `MemoryProvider` 边界，但默认 provider 返回空集合，尚未自动召回。Runtime 在 `transformContext`、`provider_payload` 和 `provider_usage` 阶段发布脱敏 Prompt 快照，并用请求、回合和运行代际关联，输入规范化只记录 hash 改写链。

运行时基础重构的目标协议见[记忆系统运行时契约](../plans/active/记忆系统运行时契约.md)，阶段进度见[执行手册](../plans/active/记忆系统重构执行手册.md)。`sendMessage()` 先写 queued，再通过版本/CAS 记录 turn 状态；Agent、运行阶段和上下文读取绑定 sessionId。AgentSlot 投递 steer/followUp 后，只有 Agent 消费结束才写 accepted/done；结构化失败保持 failed。测试超时会取消并等待在飞 Agent 收尾。压缩捕获目标 sessionId 和文件版本，过期结果不会覆盖新会话状态。长期召回仍未实现。

主 Agent 的运行身份是 `sessionId + generation + requestId + turnId`：AgentSlot 保存进程内所有权和投递阶段，SessionTurnStore 保存可恢复的 queued/dispatching/running/done/failed 事实。主回合类型强制要求 sessionId；Prompt 历史、会话摘要、主动消息和异步压缩都按该 ID 读取或写回。长期召回只依赖 `MemoryProvider` 端口，默认空实现，provider 失败或超时会降级为空召回。

## 配置与运行时数据

所有功能配置由运行时 `CONFIG.yaml` 经 `src/services/config.ts` 暴露。开发构建使用工作区 `CONFIG-DEV.yaml`（不存在时回退 `CONFIG.yaml`）；生产构建首次将默认配置初始化到 `data_root/settings/CONFIG.yaml`，设置页直接回写它。业务模块不得自行复制配置常量或以 localStorage 覆盖配置。

运行时文件统一由 Rust `AppPaths` 和前端 `BaseDirs`/`runtimePath()` 定位：开发数据根为 `{project}/data/desk-pet`，生产数据根为 Tauri 应用专属本地目录。默认 Card/Profile 只作为首次启动种子复制到运行时目录，之后不再区分默认与用户资源，均可编辑和删除。会话正文由 `sessions/*.md` 持久化，`sessions/index.json` 只保存 UI 状态。路径命令必须使用 `validate_path()` 校验写入边界。

## 平台原则

任何窗口、系统能力、文件或快捷键变更都必须同时评估 Windows 与 macOS。平台专有 Rust 实现使用条件编译；前端不得假设某个平台独有能力在另一端可用。

### 打包与 CSP

- 打包目标按平台分文件管理：`tauri.conf.json` 保留 Windows 的 `nsis`，`tauri.macos.conf.json` 提供 `app` + `dmg`。不用 `"all"` —— 它会连带 MSI，而 MSI 依赖 WiX 工具链。
- `tauri.conf.json` 的 `csp` 不是 `null`：`script-src 'self'` 与 `object-src 'none'` 是主防线；`style-src` 放开 `'unsafe-inline'` 供 Vue 的 `:style` 绑定，`img`/`media`/`font-src` 放开 `asset:` 与 `http://asset.localhost`（`convertFileSrc` 在两端的不同形态），`connect-src` 放开 `ipc:`/`http://ipc.localhost` 与 `http:`/`https:`（Provider 端点由用户自填，无法收敛成白名单）。
- ⚠️ CSP 只在生产构建生效，dev 拿不到。改动后必须在 `pnpm tauri build` 的产物上人工确认，`cargo check` 只能证明配置能被解析。
- 文件工具的允许根是 home + 系统临时目录，**debug 构建下额外包含项目根**：dev 数据根是 `{project}/data/desk-pet`，仓库不在 `$HOME` 内时否则所有会话写入都会撞 `PATH_ESCAPE`。
- 光标追踪线程按 ~16ms 轮询，但**只在坐标变化时**派发事件、且不再逐帧写日志（逐帧日志在 dev 下约 23MB/小时，远超日志轮转上限）。

## 运行时前置的所有权

持久层是 session 事件与版本；应用层持有配置/Card/工具目录；会话层是队列与 AgentSlot；每次 run 持有冻结模型、Card、Prompt 来源、工具定义、取消信号与写队列；Vue 只投影活动会话。generation 与 drainGeneration 在删除重建后也不复用。旧 Card 回复可以保存文本，但不能改写新 Card 的变量。

启动不连接 MCP、不加载 Skill 正文、不启动记忆 LLM 定时器。第一次对话准备元数据；助手回合取得已启用 MCP 的 owner 引用，结束后释放。模式退出等待正在运行的回合收尾，再清理助手工具与缓存。
