# 当前系统设计

本文记录已在当前代码中存在的运行链路和模块边界。项目概览与玩法见 [DES.md](../DES.md)。

## 分层

| 层 | 职责 |
|---|---|
| Vue 界面 | 角色展示、聊天、会话、设置与确认交互。 |
| 核心引擎 | 输入预处理、Agent Loop、Plan 编排、工具循环、上下文压缩。 |
| 人格与回复 | Card、阶段文案、变量状态、情绪映射与回复后处理。 |
| 记忆与会话 | 当前会话、会话文件、摘要、长期记忆注册表。 |
| 工具与安全 | ToolRegistry、路由、安全检查、确认交互、Skill 与 MCP。 |
| Rust 平台桥接 | 窗口、监控、文件、路径、安全校验和系统能力。 |

## 用户消息主链路

```text
用户输入
  -> runner / preprocessor
  -> session 状态更新 + 变量状态刷新
  -> buildPrompt（Card、语气指引、规则、变量、当前可用记忆、工具）
  -> 可选 Plan 编排
  -> Provider + 工具循环 + 安全检查
  -> reply/generator 解析 RUNTIME_DATA
  -> 表情与音效事件、Card 状态持久化、会话写入与上下文压缩
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

当前主 Agent Loop 已走 RUNTIME_DATA；Planner 提示和个别旧测试契约仍残留 `var_*` 文本，属于迁移后的技术债，不代表旧工具链仍是有效接口。

## 配置与运行时数据

所有功能配置由 `CONFIG.yaml` 经 `src/services/config.ts` 暴露；本地调参使用 `CONFIG-DEV.yaml`，用户设置使用 localStorage 覆盖。业务模块不得自行复制配置常量。

运行时文件统一由 Rust `AppPaths` 和前端 `BaseDirs` 定位：内置 Card/Profile 为只读资源，用户与运行时数据写入 `data_root` 下的 `memory/`、`sessions/`、`personality/` 和 `profiles/`。路径命令必须使用 `validate_path()` 校验写入边界。

## 平台原则

任何窗口、系统能力、文件或快捷键变更都必须同时评估 Windows 与 macOS。平台专有 Rust 实现使用条件编译；前端不得假设某个平台独有能力在另一端可用。
